/**
 * compile() — the main orchestrator.
 *
 * Runs all passes in order, picks a target, lowers to wire format, returns
 * a CompileResult the caller uses to make the actual provider call.
 *
 * Pure function in v2.0.0-alpha.1: no network, no I/O, no mutation cache yet.
 * Mutation cache will be added in v2.1 when the brain has data to push.
 */

import type {
  ChainModelEntry,
  CompilePolicy,
  CompileResult,
  PromptIR,
  Provider,
  SectionRewrite,
  SystemModelMessage,
  SavingsReceipt,
  BestPracticeAdvisory,
  InputModalityDrop,
  RequiredInputModality,
} from './ir.js';
import { InputModalityError } from './ir.js';
import {
  passSlice,
  passDedupe,
  passToolRelevance,
  passCompressHistory,
  passApplyCliffs,
  passApplyConventions,
  passScoreTargets,
  compareByRankThenCallerOrder,
  estimateInputTokens,
  computeShape,
  type TargetScore,
} from './passes.js';
import { lower } from './lower.js';
import { rejectedShapeAdvisory, shapeDropMutations } from './request-shapes.js';
import {
  getProfile,
  tryGetProfile,
  bestEffortProfile,
  inferProviderFromId,
  type ModelProfile,
  canonicalId,
  allProfiles,
  inputModalityMiss,
  requiredInputModalities,
  priceAtInput,
} from './profiles.js';
import { learningKey, resolveOutputMode, routeScopedModel } from './dialect.js';
import { countTokens } from './tokenizer.js';
import { runAdvisor, deriveOwnership, currentTurnDuplicatedInHistory } from './advisor.js';
import { applySectionRewrites } from './translator.js';
import { resolveFamilyEntryDetailed, type FamilyResolution } from './family-resolution.js';
import { getArchetypePerfScore } from './archetype-perf-brain.js';
import { getApplicablePromotion, promotionsFreshness } from './promotions-brain.js';
import { getMeasuredFailureVerdict, measuredFailureFreshness } from './measured-failure-brain.js';
import { exclusionFindingsFreshness } from './exclusion-findings-brain.js';
import { promoteReadyFreshness } from './promote-ready-brain.js';
import { configFreshness } from './brain-query.js';
import type { SurfacePromotion, MeasuredFailureGate } from './passes.js';

let counter = 0;
function makeHandle(): string {
  counter = (counter + 1) % 1_000_000;
  return `c${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface CompileOptions {
  /** Custom profile resolver — for tests or custom profile sets. */
  profileResolver?: (id: string) => ModelProfile;
  /** Tool relevance threshold (default 0.2). */
  toolRelevanceThreshold?: number;
  /** History compression — turns count threshold (default 8). */
  compressHistoryAfter?: number;
  /**
   * History compression — token threshold (alpha.7). When total history
   * tokens exceed this AND there are more recent turns to keep, compress
   * even when count threshold is below `compressHistoryAfter`. Catches
   * fat-message bloat (tool-using agents pack many tool-call/result pairs
   * into single assistant messages — count stays low, tokens explode).
   * Default undefined (disabled — backward-compatible).
   */
  compressHistoryAboveTokens?: number;
  /**
   * alpha.132 (R4) — how many of the most recent `history` messages a fold
   * keeps verbatim (passed to the history pass as `keepRecent`). Default 4,
   * unchanged. The fold counts `history` only: it fires when `history` holds
   * more than `compressHistoryAfter` messages (default 8), or above
   * `compressHistoryAboveTokens`. `diagnostics.conversationWindow` says what
   * the compiled request carries.
   */
  compressHistoryKeepRecent?: number;
  /**
   * Consumer-declared policy. Filters blocked models, enforces cost
   * ceiling, boosts preferred. See CompilePolicy in ir.ts.
   */
  policy?: CompilePolicy;
  /**
   * alpha.68 / Release A (delegation-fanout-accelerator §5.0, R0 linkage) —
   * transport for the fan-out parent handle. Threaded from
   * `CallOptions.parentHandle` on the call() path (and settable directly on the
   * public compile() path). Release A does NOT route on it — it only labels the
   * outcome row (fanout_role / trace_id / parent_handle) at record-registration
   * time. `registerCompile` reads it to derive the linkage. Absent ⇒ root call.
   */
  parentHandle?: string;
  /**
   * alpha.92 — lower for a gateway route (execute-leg contract). Threaded
   * from `CallOptions.route`. The canonical profile drives every pass
   * (cliffs, scoring, budgets) unchanged; only the wire destination and the
   * learning-key encoding change. Absent ⇒ direct vendor wire.
   */
  route?: 'direct' | 'openrouter';
}

/**
 * alpha.132 (R4) — `diagnostics.conversationWindow`. The conversation is
 * `history` plus `currentTurn`, the last history message counted once when it
 * duplicates `currentTurn` (the `currentturn-duplicated-in-history` test).
 * `kept` = the conversation minus the messages the fold removed into its
 * summary; the fold removes the OLDEST, so `kept` is the trailing window.
 */
export function conversationWindowOf(ir: Pick<PromptIR, 'history' | 'currentTurn'>, folded: number): { kept: number; of: number } {
  const of =
    (ir.history?.length ?? 0) + (ir.currentTurn ? 1 : 0) - (currentTurnDuplicatedInHistory(ir) ? 1 : 0);
  return { kept: Math.max(0, of - folded), of };
}

export function compile(ir: PromptIR, opts: CompileOptions = {}): CompileResult {
  const baseResolver = opts.profileResolver ?? getProfile;
  // alpha.87 — opt-in best-effort for unprofiled ids (gateway review §6).
  // The wrapper catches the resolver's refusal and synthesizes a
  // conservative profile (registered into the consumer index, so every
  // later lookup in the process sees the same object). When the provider
  // can't be inferred, the original refusal propagates — best-effort
  // cannot lower a wire format it cannot name.
  const resolver =
    opts.policy?.onUnprofiledModel === 'best-effort'
      ? (id: string): ModelProfile => {
          try {
            return baseResolver(id);
          } catch (err) {
            const synth = bestEffortProfile(id);
            if (!synth) throw err;
            return synth;
          }
        }
      : baseResolver;

  // Validate up front — appId, intent, and ≥1 model are required.
  validateIR(ir);

  // alpha.41 — resolve family entries to literal model ids BEFORE passes.
  // `ir.models` accepts `string | { family: string }` entries; the passes
  // downstream operate on `string[]`. resolveFamilyEntry throws
  // FamilyResolutionError when a family entry can't resolve, propagating
  // cleanly to the consumer. String entries pass through untouched.
  const familyResolutions: FamilyResolution[] = [];
  const aliasResolutions: Array<{ alias: string; canonical: string }> = [];
  ir = resolveModelEntries(ir, familyResolutions, aliasResolutions);

  // ── Pass 1-4: shape the IR ──
  // alpha.132 (R3d) — `constraints.stablePrefix: true` is an append-only
  // compile: the four passes that can change `system`, `tools` or earlier turns
  // between two calls of one conversation are withheld, and that is SAID as one
  // mutation. The history pass still runs with thresholds it cannot reach, so
  // `historyTokensTotal` and the orphan-tool-result check are computed as before.
  const stablePrefix = ir.constraints?.stablePrefix === true;
  const sliced = stablePrefix ? { value: ir, mutations: [] } : passSlice(ir);
  const deduped = stablePrefix ? { value: sliced.value, mutations: [] } : passDedupe(sliced.value);
  const toolFiltered = stablePrefix
    ? { value: deduped.value, mutations: [] }
    : passToolRelevance(deduped.value, {
        threshold: opts.toolRelevanceThreshold,
      });
  const compressed = passCompressHistory(
    toolFiltered.value,
    stablePrefix
      ? { summarizeOlderThan: Number.POSITIVE_INFINITY, summarizeAboveTokens: undefined }
      : {
          summarizeOlderThan: opts.compressHistoryAfter,
          summarizeAboveTokens: opts.compressHistoryAboveTokens,
          // alpha.132 (R4) — the consumer's window: how many recent turns a fold keeps (default 4).
          keepRecent: opts.compressHistoryKeepRecent,
        },
  );

  let workingIR = compressed.value;

  const accumulatedMutations = [
    ...sliced.mutations,
    ...deduped.mutations,
    ...toolFiltered.mutations,
    ...compressed.mutations,
  ];
  if (stablePrefix) {
    accumulatedMutations.push({
      id: 'stable-prefix-passes-withheld',
      source: 'static_pass',
      passName: 'stable_prefix',
      description:
        'constraints.stablePrefix: the slice, dedupe, tool-relevance and history-compression passes were withheld; the sections, tools and history reach the wire as given (an append-only compile, so a thinking block sent back keeps the prefix it was produced against).',
    });
  }
  // alpha.107 — every `{ family }` entry SAYS which kind of opinion resolved it
  // (tt-intelligence 2026-09-04: "the family head says 3.7, the chain and the
  // cost rule say 2.5 — you should say which"). A lifecycle resolution is not
  // a measured one, and the mutation says so in words.
  // alpha.109 — an alias in `ir.models` is resolved to its canonical id and
  // SAID. Origin: DeepSeek retired `deepseek-v4-flash` on 2026-09-10 and kept
  // the id answering 200 from V4.1-Flash; every consumer naming it now sends
  // `deepseek-flash` on the wire, and a wire change nobody can read is the
  // [L-073] shape one layer up.
  for (const a of aliasResolutions) {
    accumulatedMutations.push({
      id: `alias-resolved-${a.alias}-${a.canonical}`,
      source: 'alias_resolution',
      passName: 'resolve_model_entries',
      description: `'${a.alias}' is an alias of '${a.canonical}' (provider alias or a retired id the provider still serves); the wire carries '${a.canonical}'.`,
    });
  }
  for (const r of familyResolutions) {
    const why =
      r.basis === 'only-candidate'
        ? `the only current, active, above-floor model in the family`
        : r.basis === 'archetype-perf'
          ? `archetype performance ${r.perf} vs ${r.runnerUp!.perf} for ${r.archetype} over ${r.runnerUp!.id} — a performance opinion`
          : `archetype performance ties ${r.runnerUp!.id} at ${r.perf}${r.archetype ? ` for ${r.archetype}` : ''}; the newest versionAdded wins — a LIFECYCLE opinion, not a measured one (the archetype chain may rank the tie differently)`;
    accumulatedMutations.push({
      id: `family-resolved-${r.family}-${r.id}`,
      source: 'family_resolution',
      passName: 'resolve_model_entries',
      description: `{ family: '${r.family}' } → ${r.id} (${r.candidateCount} candidate${r.candidateCount === 1 ? '' : 's'}): ${why}.`,
    });
  }


  // ── Pass 5: target selection ──
  // alpha.64 — resolve the active surface promotion (Stage 2). The
  // promotions-brain cache is only live when the consumer opted in
  // (BrainConfig.autoPromote / KGAUTO_AUTO_PROMOTE); otherwise this is a
  // guaranteed undefined with zero I/O. Sync SWR read — cold start returns
  // undefined and warms in the background, same posture as every other
  // brain-driven lever in compile().
  // Release B: the resolver is mode-filtered — pass 5 reads ONLY the
  // downswap channel. A strategy promotion changes which IR runs (pass
  // 6.5), never which model, and must be invisible here (§7 read-path bug).
  const activePromotion = getApplicablePromotion({
    appId: ir.appId,
    archetype: ir.intent.archetype,
    mode: 'downswap',
  });
  const promotion: SurfacePromotion | undefined = activePromotion
    ? {
        id: activePromotion.id,
        mode: activePromotion.mode,
        promotedModel: activePromotion.promotedModel,
        evalRunId: activePromotion.evalRunId,
        suppressQualityGate: activePromotion.suppressQualityGate,
      }
    : undefined;

  // alpha.70 — measured-failure gates, resolved per candidate model. Same
  // sync-SWR posture as the promotion above: cold start returns nothing and
  // warms in the background, so a cold process never blocks and never gates.
  // Resolved only for models the consumer actually declared — this reads
  // evidence about candidates, it never introduces one.
  const measuredFailureGates = new Map<string, MeasuredFailureGate>();
  for (const entry of workingIR.models ?? []) {
    const modelId = typeof entry === 'string' ? entry : undefined;
    if (!modelId) continue;
    const verdict = getMeasuredFailureVerdict({
      appId: ir.appId,
      archetype: ir.intent.archetype,
      model: modelId,
    });
    if (verdict?.gated) {
      measuredFailureGates.set(modelId, {
        rate: verdict.rate,
        lowerBound: verdict.lowerBound,
        n: verdict.n,
        nFail: verdict.nFail,
        axis: verdict.axis ?? 'quality',
      });
    }
  }

  // alpha.124 — input-modality requirement + the consumer's pin. A pin is
  // `forceModel`, or an `ir.models` list naming exactly one model (nothing to
  // choose among): the consumer's own knowledge, never filtered.
  const requiredModalities = requiredInputModalities(workingIR.constraints?.inputModalities);
  const declaredIds = workingIR.models.filter((m): m is string => typeof m === 'string');
  const modalityPin: string | undefined = requiredModalities
    ? (workingIR.constraints?.forceModel ?? (declaredIds.length === 1 ? declaredIds[0] : undefined))
    : undefined;

  const inputTokens = estimateInputTokens(workingIR);
  const scores = passScoreTargets(workingIR, {
    estimatedInputTokens: inputTokens,
    profilesById: resolver,
    inputModalityPin: modalityPin,
    policy: opts.policy,
    promotion,
    measuredFailureGates,
    // alpha.106 — a MEASURED brain score outranks the profile's judgment
    // score; anything unmeasured falls back inside the pass (profile → floor).
    archetypePerfOf: (id) => {
      const r = getArchetypePerfScore(id, workingIR.intent.archetype, workingIR.appId, opts.route);
      return r.grounding === 'measured' ? r.score : undefined;
    },
    // alpha.110 — the row count behind a measured score, for the floor mutation's text.
    archetypePerfNOf: (id) => {
      const r = getArchetypePerfScore(id, workingIR.intent.archetype, workingIR.appId, opts.route);
      return r.grounding === 'measured' ? r.n : undefined;
    },
  });
  // Surface policy mutations into the result so consumers can see what kgauto
  // filtered/boosted (e.g. "Sonnet was blocked by your policy → fell to Flash").
  accumulatedMutations.push(...scores.mutations);

  const target = pickTarget(workingIR, scores.value);
  if (target) {
    // alpha.106 — SAY when the ranking did not take the caller's first
    // candidate (the s119 fact "compile() scores the set and does not honour
    // its order", now stated per call with the reason), and when every
    // `preferredModels` entry was blocked or unfit and a substitute served
    // (tt-intelligence 2026-09-05 ask 1: `substituted_for`, on the row via
    // mutations_applied).
    const firstId = workingIR.models.find((m): m is string => typeof m === 'string');
    const first = firstId ? scores.value.find((s) => s.modelId === firstId) : undefined;
    if (firstId && firstId !== target.modelId) {
      const gate = first?.measuredGate;
      const why = first && !first.fits
        ? `${firstId} did not fit (${first.rejectReasons.join('; ')})`
        : gate
          ? `${firstId} carries a measured ${gate.axis} gate on this surface (${gate.nFail} of ${gate.n}, lower bound ${(gate.lowerBound * 100).toFixed(0)}%) — rank ${target.rank.toFixed(2)} vs ${first.rank.toFixed(2)}`
          : `rank ${target.rank.toFixed(2)} vs ${first?.rank.toFixed(2) ?? '?'} — archetypePerf ${target.archetypePerf ?? '?'} vs ${first?.archetypePerf ?? '?'} for ${workingIR.intent.archetype}`;
      accumulatedMutations.push({
        id: `scorer-took-${target.modelId}-over-${firstId}`,
        source: 'static_pass',
        passName: 'score_targets',
        description: `Ranking picked ${target.modelId} over the caller's first candidate ${firstId}: ${why}.`,
      });
    }
    const preferred = (opts.policy?.preferredModels ?? []).filter((m): m is string => typeof m === 'string');
    if (preferred.length > 0 && !preferred.includes(target.modelId)) {
      accumulatedMutations.push({
        id: `preferred-blocked-substituted-${target.modelId}`,
        source: 'policy',
        passName: 'score_targets',
        description: `Every CompilePolicy.preferredModels entry (${preferred.join(', ')}) was blocked, unfit or absent from the candidate set; ${target.modelId} substituted — the best remaining by archetype performance for ${workingIR.intent.archetype}, then caller order.`,
      });
    }
  }
  if (!target && requiredModalities) {
    // alpha.124 — no candidate declares the required modality and no pin was
    // set. A typed refusal BEFORE anything is lowered: call() turns it into a
    // CallError, never a provider 400 after billing.
    const dropped = collectModalityDrops(declaredIds, requiredModalities, modalityPin, resolver);
    if (dropped.length > 0) {
      throw new InputModalityError(
        `compile(): no candidate declares input modality ${requiredModalities.join(', ')} ` +
          `(constraints.inputModalities) and no model is pinned. Dropped: ` +
          dropped.map((d) => `${d.model} (${d.why})`).join(', ') +
          `. Add a model whose profile declares it to ir.models, or pin one (forceModel) if you know it accepts the modality.`,
        requiredModalities,
        dropped,
      );
    }
  }
  if (!target) {
    // alpha.87 — when the no-fit was (even partly) an unprofiled id, say so
    // and name the two escape hatches. Before this, the refusal surfaced as
    // a generic scores dump and the consumer's only route was reading kgauto
    // source (both gateway-review cold readers hit exactly this wall).
    const unknownIds = scores.value
      .filter((s) => s.rejectReasons?.includes('unknown_model_id'))
      .map((s) => s.modelId);
    const uninferable = unknownIds.filter((id) => !inferProviderFromId(id));
    const unknownHint =
      unknownIds.length > 0
        ? ` Unprofiled model id(s): ${unknownIds.join(', ')}. registerProfiles([...]) supplies a ` +
          `full profile; policy.onUnprofiledModel:'best-effort' compiles with guards skipped.` +
          (uninferable.length > 0
            ? ` Note: provider is not inferable from ${uninferable.join(', ')}, so best-effort ` +
              `cannot lower it — registerProfiles is the only path for those.`
            : '')
        : '';
    throw new Error(
      `compile(): no allowed model fits the request.${unknownHint} Scores: ${JSON.stringify(scores.value, null, 2)}`,
    );
  }
  const profile = resolver(target.modelId);
  // alpha.87 — the loud half of best-effort mode: if the SELECTED profile
  // is synthesized, every compile that uses it says so (not only the one
  // that triggered synthesis), naming each guard that is skipped.
  const bestEffortWarnings: string[] = [];
  if (profile.bestEffort) {
    bestEffortWarnings.push(
      `best-effort profile in use for "${profile.id}" (provider ${profile.provider} inferred from ` +
        `the id; wire mechanics borrowed). SKIPPED for this model: cliff guards, recovery rules, ` +
        `measured archetype knowledge, structured-output capability (treated as 'none'), parallel ` +
        `tools (treated as sequential). Cost is UNKNOWN and recorded as $0 — cost gates and cost ` +
        `attribution are meaningless for this model. registerProfiles() restores real guards.`,
    );
    accumulatedMutations.push({
      id: `best_effort_profile_${profile.id}`,
      source: 'best_effort',
      passName: 'resolve-profile',
      description:
        `Unprofiled model "${profile.id}" compiled under onUnprofiledModel:'best-effort' — ` +
        `guards skipped, cost unknown. See diagnostics.cliffWarnings for the full list.`,
    });
  }
  // alpha.135 (B3) — one order for the pick, the fallback chain and targetScores: rank, and on a
  // tie (within RANK_TIE_EPSILON) the earlier position in the caller's list.
  const byRank = compareByRankThenCallerOrder(workingIR.models);
  const fallbackChain = scores.value
    .filter((s) => s.modelId !== target.modelId && s.fits)
    .sort(byRank)
    .map((s) => s.modelId);

  // alpha.124 — what the modality requirement left, for diagnostics + advisory.
  const inputModalityDiagnostics = requiredModalities
    ? buildInputModalityDiagnostics(
        requiredModalities,
        [target.modelId, ...fallbackChain],
        declaredIds,
        modalityPin,
        resolver,
      )
    : undefined;

  // ── Pass 6: cliffs ── (re-estimate tokens because tools may have been trimmed)
  const cliffs = passApplyCliffs(workingIR, profile, inputTokens);
  workingIR = cliffs.value.ir;
  accumulatedMutations.push(...cliffs.mutations);

  // ── Pass 6.25: conventions (alpha.43) ──
  // Per-family-per-archetype prompt-shape rewrites — the "compile-time
  // forcing-function" substrate. Cliffs are runtime warnings; conventions
  // are prompt rewrites that head off the failure mode BEFORE the call
  // leaves kgauto. See passes.ts > passApplyConventions for the contract.
  //
  // Trigger that justified this pass: 2026-05-28 V4-Pro probe on
  // tt-intel/classify (exclusion-finding ID 20) showed 8/10 judge
  // rationales citing "candidate hedges and fails to commit." Without a
  // forcing-function suffix, every reasoner probe on a decisive archetype
  // verdicts stay-excluded for reasoner-behavior reasons, not quality.
  const conventions = passApplyConventions(workingIR, profile);
  workingIR = conventions.value.ir;
  accumulatedMutations.push(...conventions.mutations);

  // ── Pass 6.5: translator (alpha.29) ──
  // Model-aware per-section rewrites — the "translator primitive." Operates
  // on section.kind hints declared by the consumer. alpha.29 ships ONE rule:
  // `tool_call_contract` + archetype below ARCHETYPE_FLOOR_DEFAULT →
  // sequential-tool preamble + wireOverrides.parallelToolCalls = false.
  // Pre-alpha.29 callers (no `kind` on sections) pass through unchanged.
  //
  // See translator.ts; pairs with the alpha.28 advisor `archetype-perf-floor-
  // breach` which suppresses when the translator fired for the same cliff.
  // alpha.68 / Release A — Factor C output-shape for the discipline-gates rule
  // (§5.D). The contract names BOTH 'json' and 'tool_call' as surfaces where the
  // shape-altering gates must not fire; alpha.68 screened only 'json', so a
  // tool-call surface (tools present, structuredOutput unset) derived 'text' and
  // the gates fired on it. alpha.69 routes both this screen and computeShape
  // through the one `resolveOutputMode` — two derivations of one concept is what
  // let them drift (L-073 family). Derived from the ORIGINAL ir (passes never
  // touch constraints or tools, so ir === workingIR on this axis).
  const outputMode = resolveOutputMode({
    declared: ir.constraints?.outputMode,
    structuredOutput: ir.constraints?.structuredOutput,
    toolCount: ir.tools?.length ?? 0,
  });

  // ── Release B: the STRATEGY promotion channel (pass 6.5's reader) ──
  // A measured gates-on verdict for this (app, archetype) — written by the
  // strategy eval behind the same 7-day guard as a downswap — turns the
  // discipline gates ON here even when the consumer never declared a
  // `discipline_contract` section. Same consent posture as downswaps: the
  // promotions brain is only live when the consumer opted in
  // (BrainConfig.autoPromote), and the guard's rollback (rollback_class
  // 'strategy' — a conviction of KGAUTO'S PROMPT, never the model) drops
  // the row within one cache window. Factor A + C still screen: on an
  // ineligible archetype nothing fires, on a structured surface the
  // reasoning-scoped subset fires — a promotion widens WHERE the section is
  // declared, never what safety applies to it.
  const strategyPromotion = getApplicablePromotion({
    appId: ir.appId,
    archetype: ir.intent.archetype,
    mode: 'strategy',
  });
  if (
    strategyPromotion?.strategy === 'discipline-gates-v1' &&
    !(workingIR.sections ?? []).some((s) => s.kind === 'discipline_contract')
  ) {
    workingIR = {
      ...workingIR,
      sections: [
        ...(workingIR.sections ?? []),
        {
          id: `__kgauto_strategy_promotion_${strategyPromotion.id}__`,
          kind: 'discipline_contract',
          text: '',
        },
      ],
    };
  }

  const translated = applySectionRewrites({
    ir: workingIR,
    profile,
    archetype: ir.intent.archetype,
    outputMode,
  });
  workingIR = translated.rewrittenIR;
  const sectionRewritesApplied: SectionRewrite[] = translated.rewrites;

  // The strategy-promotion mutation is recorded ONLY when the gate actually
  // landed — a promotion whose section was screened off (ineligible
  // archetype) must not claim it changed the IR.
  if (
    strategyPromotion &&
    translated.rewrites.some(
      (rw) =>
        rw.kind === 'discipline_contract' &&
        rw.sectionId === `__kgauto_strategy_promotion_${strategyPromotion.id}__`,
    )
  ) {
    accumulatedMutations.push({
      id: `strategy-promotion-applied-${strategyPromotion.id}`,
      source: 'strategy_promotion',
      passName: 'translator',
      description:
        `Strategy promotion #${strategyPromotion.id} (${strategyPromotion.strategy}) ` +
        `enabled the discipline gates on ${ir.appId}/${ir.intent.archetype} — ` +
        `measured gates-on verdict behind the 7-day rollback guard.`,
    });
  }
  // alpha.68 / Release A — measure the discipline gate's token tax (§5.D), never
  // assume it. The prepended portion of a fired rewrite is exactly
  // `${chosenPreamble}\n\n` (transformedText = preamble + '\n\n' + originalText),
  // so counting that slice measures the exact bytes the gate added. 0 when no
  // discipline rewrite fired.
  const disciplineRewrite = sectionRewritesApplied.find(
    (rw) => rw.kind === 'discipline_contract',
  );
  const disciplineGateTokens = disciplineRewrite
    ? countTokens(
        disciplineRewrite.transformedText.slice(
          0,
          disciplineRewrite.transformedText.length -
            disciplineRewrite.originalText.length,
        ),
      )
    : 0;
  // Merge wire-overrides from all rewrites. alpha.29 ships one knob
  // (parallelToolCalls); future overrides extend the union and the merge
  // strategy may need to evolve (last-write-wins is fine for a single knob).
  let wireOverrides: { parallelToolCalls?: boolean } | undefined;
  for (const rw of sectionRewritesApplied) {
    if (!rw.wireOverrides) continue;
    if (!wireOverrides) wireOverrides = {};
    if (rw.wireOverrides.parallelToolCalls !== undefined) {
      wireOverrides.parallelToolCalls = rw.wireOverrides.parallelToolCalls;
    }
  }
  // Surface translator activity as mutations so consumers see it in
  // `mutationsApplied` alongside cliff/policy mutations. One entry per
  // rewrite — keeps the brain's mutation-effectiveness aggregates clean.
  for (const rw of sectionRewritesApplied) {
    accumulatedMutations.push({
      id: `translator:${rw.rule}:${rw.sectionId}`,
      source: 'translator',
      passName: 'translator',
      description: `Rewrote section "${rw.sectionId}" (kind=${rw.kind}) via rule "${rw.rule}".`,
    });
  }

  // ── Pass 7: lower to wire format ──
  const lowered = lower(workingIR, profile, {
    forceThinkingZero: cliffs.value.loweringHints.forceThinkingZero,
    forceTerseOutput: cliffs.value.loweringHints.forceTerseOutput,
    wireOverrides,
    route: opts.route,
    estimatedInputTokens: inputTokens,
  });

  // alpha.134 (R2) — the model's own thinking off-switch, said either way: the
  // switch on the wire (`thinking-off-sent-<type>`), or why it is not there
  // (`thinking-off-withheld-<reason>`, a decision that leaves the wire as it was).
  const offOutcome = lowered.diagnostics.thinkingOff;
  if (offOutcome) {
    if ('sent' in offOutcome) {
      accumulatedMutations.push({
        id: `thinking-off-sent-${offOutcome.sent}`,
        source: 'cliff_guard',
        passName: 'lower',
        description:
          `${profile.id}: sent thinking { type: '${offOutcome.sent}' } — the model's own off-switch` +
          (offOutcome.sent === 'between_tools' ? ' for up-front thinking' : '') +
          ` (lowering.thinkingOff), because the short-output rule fired.`,
      });
    } else if (offOutcome.withheld === 'effort') {
      accumulatedMutations.push({
        id: 'thinking-off-withheld-effort',
        source: 'cliff_guard',
        passName: 'lower',
        description:
          `${profile.id}: thinking { type: '${offOutcome.type}' } NOT sent — the effort in force is ${offOutcome.effort}, ` +
          `and the provider's thinking page accepts the switch only at effort ${offOutcome.effortAtMost} or below (a 400 above it). Thinking stays on.`,
      });
    } else {
      accumulatedMutations.push({
        id: 'thinking-off-withheld-thinking-blocks',
        source: 'cliff_guard',
        passName: 'lower',
        description:
          `${profile.id}: thinking { type: '${offOutcome.type}' } NOT sent — the conversation carries thinking blocks, and ` +
          `the request keeps thinking { type: 'adaptive', block_binding } so a block whose prefix changed is dropped, not a 400 ` +
          `(block_binding is accepted only with adaptive). Thinking stays on.`,
      });
    }
  }

  // ── Pass 8: validate fits ──
  // (Already done in scoring; re-check after cliffs may have trimmed tools.)
  validateFinalFit(workingIR, profile, inputTokens);

  // ── Diagnostics ──
  const handle = makeHandle();
  const finalShape = computeShape(workingIR, inputTokens);
  // alpha.92 — the learning key is route-scoped for non-direct routes
  // (`model@openrouter`): gateway evidence must never pollute direct-vendor
  // evidence, because the serving stack behind the same model id differs.
  const _learningKey = learningKey(ir.intent.archetype, routeScopedModel(profile.id, opts.route), finalShape);

  // ── Pass 9: best-practice advisor ── (alpha.6, non-fatal)
  // Inspects the ORIGINAL IR — not workingIR — because advisories are
  // about consumer-side patterns. workingIR has had sections/tools dropped
  // by upstream passes; advising against it would surface the wrong gaps
  // (e.g. "you have 0 tools" after tool-relevance trimmed them).
  // alpha.33 — AI-SDK cache-marker propagation.
  // Compute (a) the history index at which the consumer should attach
  // `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` after
  // their own `convertToModelMessages()` call, and (b) the structured
  // `systemMessages: SystemModelMessage[]` form of the system parameter
  // that preserves cacheable-section markers across the wire. The compiler
  // computes these for every provider — only Anthropic actually consumes
  // the `cacheControl` block at the wire level, but the diagnostic itself
  // is informational for all providers and feeds the cost-watcher rule
  // for caching-silently-dropped detection.
  const historyCacheMarkIndex = computeHistoryCacheMarkIndex(workingIR);
  const systemMessages = buildSystemMessages(workingIR, profile.provider as Provider);
  const systemCacheMarkIndex = lastCacheableSystemIndex(systemMessages);

  // alpha.87 — per-section cost attribution. Pure arithmetic on IDs the
  // consumer already supplied; see the ir.ts field doc for the two-column
  // cacheable design. Dropped sections keep their token count (what the
  // pass removed and what it was worth) at zero cost.
  const keptSectionIds = new Set(workingIR.sections.map((s) => s.id));
  const cachePrefixActive = lowered.diagnostics.cacheableTokens > 0;
  const cacheReadFraction = profile.lowering.cache.discount ?? 0.25;
  // alpha.128 — the input price of the tier this compile's input falls in.
  const inputPricePer1m = priceAtInput(profile, inputTokens).costInputPer1m;
  const sectionAttribution = ir.sections.map((s) => {
    const tokens = countTokens(s.text);
    const kept = keptSectionIds.has(s.id);
    const estCostUsdFirstCall = kept ? (tokens / 1_000_000) * inputPricePer1m : 0;
    const inActiveCachePrefix = kept && s.cacheable === true && cachePrefixActive;
    return {
      id: s.id,
      tokens,
      kept,
      cacheable: s.cacheable === true,
      estCostUsdFirstCall,
      estCostUsdWarm: inActiveCachePrefix
        ? estCostUsdFirstCall * cacheReadFraction
        : estCostUsdFirstCall,
    };
  });

  // alpha.105 — the receipt. Same tokenizer estimate the passes use; the
  // as-given figure is the consumer's IR untouched, so a call kgauto did
  // nothing to reads 0 removed / $0 — never a flattering number.
  const inputTokensAsGiven = estimateInputTokens(ir);
  const inputTokensRemoved = Math.max(0, inputTokensAsGiven - inputTokens);
  const savings: SavingsReceipt = {
    passes: [...new Set(accumulatedMutations.map((m) => m.id))],
    inputTokensAsGiven,
    inputTokensSent: inputTokens,
    inputTokensRemoved,
    estimatedUsdSavedFirstCall: (inputTokensRemoved / 1_000_000) * inputPricePer1m,
    estimatedCacheSavingsUsdWarm: lowered.diagnostics.estimatedCacheSavingsUsd,
    dropped: {
      sections: ir.sections.length - workingIR.sections.length,
      tools: (ir.tools?.length ?? 0) - (workingIR.tools?.length ?? 0),
      historyTurns: (ir.history?.length ?? 0) - (workingIR.history?.length ?? 0),
    },
    basis: {
      model: profile.id,
      costInputPer1m: inputPricePer1m,
      pricingVerifiedAgainstDocs: profile.verifiedAgainstDocs ?? null,
      tokenizer: 'kgauto-estimate',
    },
  };

  const diagnostics = {
    savings,
    sectionsKept: workingIR.sections.length,
    sectionsDropped: ir.sections.length - workingIR.sections.length,
    toolsKept: workingIR.tools?.length ?? 0,
    toolsDropped: (ir.tools?.length ?? 0) - (workingIR.tools?.length ?? 0),
    historyKept: workingIR.history?.length ?? 0,
    historyDropped: (ir.history?.length ?? 0) - (workingIR.history?.length ?? 0),
    cacheableTokens: lowered.diagnostics.cacheableTokens,
    estimatedCacheSavingsUsd: lowered.diagnostics.estimatedCacheSavingsUsd,
    historyCacheableTokens: lowered.diagnostics.historyCacheableTokens,
    historyTokensTotal: compressed.historyTokensTotal,
    // alpha.132 (R4) — the window the request carries: trailing messages of the
    // conversation (history + currentTurn, the duplicate counted once) against
    // all of them.
    conversationWindow: conversationWindowOf(ir, compressed.folded),
    // alpha.20 E3: mirror the consumer's declared mode for Glass-Box +
    // brain observability. Undefined when not declared (pre-alpha.20).
    toolOrchestration: ir.constraints?.toolOrchestration,
    // alpha.33 — see top-of-block comment.
    historyCacheMarkIndex,
    systemCacheMarkIndex,
    // alpha.110 — the ranking table, legible per call (see the type's doc).
    targetScores: [...scores.value]
      .sort(byRank)
      .map((s) => ({
        modelId: s.modelId,
        rank: s.rank,
        fits: s.fits,
        ...(s.grounding ? { grounding: s.grounding } : {}),
        ...(s.archetypePerf !== undefined ? { archetypePerf: s.archetypePerf } : {}),
        ...(s.blendedCostUsd !== undefined ? { blendedCostUsd: s.blendedCostUsd } : {}),
        ...(s.measuredFit !== undefined ? { measuredFit: s.measuredFit } : {}),
        // alpha.135 (filing 2026-12-06, A3) — why a candidate lost, from the scorer's own
        // record: each hard reject it carried, and the measured-failure gate that docked it.
        ...(s.rejectReasons.length > 0 ? { rejectReasons: [...s.rejectReasons] } : {}),
        ...(s.measuredGate ? { measuredGate: { ...s.measuredGate } } : {}),
      })),
    // alpha.135 (A4) — the caller's per-call cost ceiling, present only when one was set, so
    // the row's `selection` can say which ceiling the candidates were judged against.
    ...(opts.policy?.maxCostPerCallUsd !== undefined ? { ceilingUsd: opts.policy.maxCostPerCallUsd } : {}),
    // alpha.43 — cliff-style warnings emitted by passApplyConventions.
    // Merge convention-pass cliffWarnings with any cliff-guard quality
    // warnings the cliff pass surfaced (the same shape — informational
    // text the consumer can route on without changing behavior).
    cliffWarnings: [
      ...(cliffs.value.loweringHints.qualityWarning ?? []),
      ...conventions.value.cliffWarnings,
      // alpha.87 — best-effort profile in use (loud on EVERY compile).
      ...bestEffortWarnings,
    ],
    // alpha.68 / Release A — measured discipline gate-token tax (§5.D). 0 when
    // the gate didn't fire.
    disciplineGateTokens,
    // alpha.87 — per-source freshness stamped at the moment the compile's
    // reads have all happened, from state each source already tracks (the
    // "one-line stamp at the point where the source is already known and
    // discarded" this filing reduced to once alpha.73/.86 warmed the caches).
    freshness: {
      config: configFreshness(),
      measuredFailure: measuredFailureFreshness(ir.appId),
      promotions: promotionsFreshness(ir.appId),
      exclusions: exclusionFindingsFreshness(ir.appId),
      promoteReady: promoteReadyFreshness(ir.appId),
    },
    sections: sectionAttribution,
    // alpha.124 — present only when the IR requires an input modality.
    ...(inputModalityDiagnostics ? { inputModality: inputModalityDiagnostics } : {}),
  };

  // alpha.20 E3: emit a mutation tag when the IR's tool_orchestration
  // setting selected a non-default chain shape. Today this fires only for
  // `archetype === 'hunt'` + `toolOrchestration === 'sequential'` — the
  // single mode/archetype combo where `STARTER_CHAINS_BY_MODE.hunt.sequential`
  // overlays the parallel default. Telemetry-only; the chain change happens
  // inside getDefaultFallbackChain() at the consumer-call site.
  if (
    ir.intent.archetype === 'hunt' &&
    ir.constraints?.toolOrchestration === 'sequential'
  ) {
    accumulatedMutations.push({
      id: 'sequential-mode-chain-selected',
      source: 'tool_orchestration',
      passName: 'compile',
      description:
        "ir.constraints.toolOrchestration='sequential' selected the DeepSeek-tier-0 hunt chain overlay (L-040 parallel-tool cliff doesn't apply at single-step granularity).",
    });
  }
  // alpha.22 Phase 2: the recommendation rules
  // (cost-mismatched-archetype, model-stale-evidence, tier-down) need
  // chain-aware visibility. Pass the fallback chain + a profile resolver
  // that prefers the same resolver compile() used (custom resolver wins;
  // otherwise tryGetProfile so unknown alt-ids return undefined silently).
  const phase2ProfileResolver: (id: string) => ModelProfile | undefined =
    opts.profileResolver
      ? (id) => {
          try {
            return opts.profileResolver!(id);
          } catch {
            return undefined;
          }
        }
      : tryGetProfile;
  const rawAdvisories = runAdvisor(
    ir,
    {
      target: profile.id,
      provider: profile.provider as Provider,
      tokensIn: inputTokens,
      diagnostics,
    },
    profile,
    opts.policy,
    {
      fallbackChain,
      profileResolver: phase2ProfileResolver,
      // alpha.110 — "cheaper" is priced at this call's blended shape, one function with the scorer.
      estimatedInputTokens: inputTokens,
      // alpha.128 — the call's route, so the advisor reads a gateway-measured row for a gateway call.
      route: opts.route,
      // alpha.132 (R4) — the fold numbers in force, said in the duplicated-turn suggestion.
      fold: {
        compressHistoryAfter: opts.compressHistoryAfter,
        compressHistoryKeepRecent: opts.compressHistoryKeepRecent,
        compressHistoryAboveTokens: opts.compressHistoryAboveTokens,
      },
      // alpha.29 — feed translator rewrites to the advisor so the
      // `archetype-perf-floor-breach` rule can suppress when the translator
      // already cleared the cliff for the same archetype. Without this,
      // both the rewrite AND the advisory fire — noisy, and the advisory
      // would mislead consumers into thinking the cliff is unaddressed.
      sectionRewritesApplied,
    },
  );

  // alpha.85 — a `policy` key INSIDE the IR is an unknown field the type
  // system erases and this function never reads; the consumer believes a
  // spend gate is configured and it is decorative. tt-intel s119 copied
  // exactly this shape from a stale doc example and was minutes from
  // reporting their (correct) production gate as broken. Say it, loudly,
  // where the misplaced policy actually names models.
  if (
    (ir as unknown as Record<string, unknown>)['policy'] !== undefined &&
    opts.policy === undefined
  ) {
    rawAdvisories.push({
      level: 'critical',
      code: 'policy-in-ir-ignored',
      message:
        'The IR passed to compile() carries a `policy` field. `policy` belongs in the SECOND argument — `compile(ir, { policy })` — and inside the IR it is an unknown field that is completely ignored. If that policy names blockedModels, no block is being enforced on this call.',
      suggestion:
        'Move it: `compile(ir, { policy: { ... } })`. If you also configure policy correctly elsewhere on this path, remove the IR copy so the next reader is not misled.',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#quickstart',
    });
  }

  // alpha.124 — fewer than two providers can serve the required modality.
  // Never widened to an undeclared model; the advisory names whose page would
  // need reading (or which declaring model to add) to get a second provider.
  if (inputModalityDiagnostics && inputModalityDiagnostics.survivingProviders < 2) {
    rawAdvisories.push(inputModalityAdvisory(inputModalityDiagnostics, resolver));
  }

  // alpha.120 — a tool result that answers no call in the conversation. Every
  // provider keys a result to its call; this one will be rejected (OpenAI
  // family: a `tool` message must follow an assistant `tool_calls` entry;
  // Anthropic: a `tool_result` must answer a `tool_use` in the previous turn)
  // or read without its question. Kept verbatim by compression — never dropped
  // silently — and said here.
  if (compressed.orphanToolResults.length > 0) {
    const where = compressed.orphanToolResults
      .map((o) => `${o.at === 'currentTurn' ? 'currentTurn' : `history[${o.at}]`} (toolCallId '${o.toolCallId}')`)
      .join(', ');
    rawAdvisories.push({
      level: 'warn',
      code: 'orphan-tool-result',
      message: `${compressed.orphanToolResults.length} role:'tool' message(s) answer no tool call in the conversation: ${where}. No assistant message carries a toolCalls entry (or native parts) with that id, so the provider cannot match the result to a call.`,
      suggestion:
        "Write the assistant turn back into history with its calls — `{ role: 'assistant', content: response.text, toolCalls: response.toolCalls }` — before the tool results, and set each result's toolCallId to `response.toolCalls[n].id`.",
      recommendationType: 'prompt-fix',
    });
  }

  // alpha.121 — a request shape the target documents as a 400 was dropped by
  // the lowering (today: a trailing assistant turn on Opus 5.5 / Sonnet 5.5).
  // Said, never silent: the consumer's prefill did not reach the model.
  if (lowered.diagnostics.rejectedShapesDropped?.length) {
    rawAdvisories.push(rejectedShapeAdvisory(profile.id, lowered.diagnostics.rejectedShapesDropped));
    // alpha.134 (R8) — the dropped setting is a mutation on bare compile() too, under the id
    // call() gives it (`request-shape-dropped-<setting>`): a change to the request is listed in
    // `mutationsApplied` beside the advisory that quotes the provider. (was: call() only, until
    // alpha.134 — the alpha.133 report's objection 1.)
    accumulatedMutations.push(...shapeDropMutations(profile.id, lowered.diagnostics.rejectedShapesDropped));
  }

  // alpha.121 (item G) — reasoning turned off because the call offers tools on
  // a model that rejects tools-with-reasoning on Chat Completions. Read from
  // the LOWERED request (declares ⇒ emits), not from the mutation list.
  {
    const req = lowered.request as { provider: string; reasoning_effort?: unknown; tools?: unknown[] };
    if (req.provider === 'openai' && req.reasoning_effort === 'none' && (req.tools?.length ?? 0) > 0) {
      rawAdvisories.push({
        level: 'info',
        code: 'reasoning-off-for-tools',
        message:
          `${profile.id} rejects function tools with reasoning on /v1/chat/completions (HTTP 400: "Function tools with reasoning_effort are not supported for ${profile.id} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), so this call carries reasoning_effort: 'none' — the model answers without reasoning.`,
        suggestion:
          'If the call needs reasoning more than tools, drop the tools for this model or route it to a model that reasons with tools; kgauto speaks Chat Completions, not /v1/responses.',
        recommendationType: 'model-swap',
      });
    }
  }

  // alpha.42 — stamp request-link + ownership onto each advisory.
  // `kgautoRequestId` lets a consumer's admin UI pivot from advisory row →
  // original trace; `ownership` discriminates Class A (consumer-actionable)
  // vs Class B (producer-owned) so the UI can render the right CTA.
  // Rule-self-declared ownership wins; otherwise `deriveOwnership` consults
  // the static `PRODUCER_OWNED_RULE_CODES` set in advisor.ts.
  const advisories = rawAdvisories.map((a) => ({
    ...a,
    kgautoRequestId: handle,
    ownership: deriveOwnership(a.code, a.ownership),
  }));

  return {
    handle,
    target: profile.id,
    provider: profile.provider as Provider,
    request: lowered.request,
    tokensIn: inputTokens,
    estimatedCostUsd: target.estimatedCostUsd,
    mutationsApplied: accumulatedMutations,
    fallbackChain,
    advisories,
    diagnostics,
    sectionRewritesApplied,
    wireOverrides,
    systemMessages,
  };
}

/**
 * alpha.33 — compute the history-cache-mark index per the resolved
 * historyCachePolicy. Returns undefined when no policy is active, when
 * history is empty, or when the policy's offset exceeds history length.
 *
 * This is the position consumers using AI-SDK's
 * `streamText({ messages: convertToModelMessages(...) })` use to attach
 * `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` to the
 * matching converted message — `convertToModelMessages` reads raw input,
 * so the per-message markers the compiler emits on `result.request.messages`
 * never reach the wire. This index lets consumers re-attach the marker
 * deterministically after conversion.
 */
function computeHistoryCacheMarkIndex(ir: PromptIR): number | undefined {
  const policy = ir.historyCachePolicy;
  if (!policy || policy.strategy === 'none') return undefined;
  const historyLen = ir.history?.length ?? 0;
  if (historyLen === 0) return undefined;
  if (policy.strategy === 'all-but-latest') {
    return historyLen - 1;
  }
  if (policy.strategy === 'fixed-suffix') {
    const idx = historyLen - 1 - policy.suffix;
    if (idx < 0) return undefined;
    return idx;
  }
  return undefined;
}

/**
 * alpha.33 — build the structured `systemMessages: SystemModelMessage[]`
 * form of the system parameter from the resolved sections. Each cacheable
 * section becomes a separate entry; the lowering layer already concatenates
 * for the flat-string form on `result.request`. The structured form lets
 * AI-SDK consumers preserve per-section providerOptions across
 * `streamText({ system })`, which silently strips providerOptions on the
 * string form.
 *
 * Cache markers (anthropic.cacheControl) are emitted ONLY when the chosen
 * provider is anthropic — other providers receive the same shape but no
 * markers (matching their implicit-caching semantics). Empty result when
 * the IR carried zero sections (the compiler dropped everything for the
 * chosen intent).
 */
function buildSystemMessages(
  ir: PromptIR,
  provider: Provider,
): SystemModelMessage[] {
  const sections = ir.sections;
  if (!sections || sections.length === 0) return [];
  return sections.map<SystemModelMessage>((s) => {
    const base: SystemModelMessage = { role: 'system', content: s.text };
    if (provider === 'anthropic' && s.cacheable) {
      base.providerOptions = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    }
    return base;
  });
}

/**
 * alpha.33 — find the index of the last entry in `systemMessages` that
 * carries a cacheControl marker. Useful for consumers that want a single
 * deterministic position for `streamText({ system: result.systemMessages
 * })` AND need to know where the cacheable prefix ends. Returns undefined
 * when no entry carries cacheControl.
 */
function lastCacheableSystemIndex(
  systemMessages: SystemModelMessage[],
): number | undefined {
  for (let i = systemMessages.length - 1; i >= 0; i--) {
    const entry = systemMessages[i];
    if (entry && entry.providerOptions?.anthropic?.cacheControl) {
      return i;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function validateIR(ir: PromptIR): void {
  if (!ir.appId) throw new Error('compile(): ir.appId is required');
  if (!ir.intent || !ir.intent.archetype) {
    throw new Error('compile(): ir.intent.archetype is required (use a dialect-v1 archetype)');
  }
  if (!Array.isArray(ir.models) || ir.models.length === 0) {
    throw new Error('compile(): ir.models must be a non-empty array');
  }
  if (!Array.isArray(ir.sections)) {
    throw new Error('compile(): ir.sections must be an array');
  }
  // alpha.119 — `{ id, content }` (the chat-message habit) used to die in the dedupe pass as a
  // TypeError on `.trim()`; name the section and the likely slip instead.
  for (const s of ir.sections) {
    if (typeof s?.text !== 'string') {
      throw new Error(`compile(): section "${s?.id}" has no text (did you write content?)`);
    }
  }
  // alpha.120 — a neutral tool result must name the call it answers; every
  // provider's wire keys the result to the call by that id (Anthropic
  // `tool_use_id`, OpenAI-family `tool_call_id`, Google `functionResponse.id`).
  // A message carrying `parts` is native and passes through unread, as before.
  const turns = [...(ir.history ?? []), ...(ir.currentTurn ? [ir.currentTurn] : [])];
  turns.forEach((m, i) => {
    if (m.role === 'tool' && m.parts == null && (typeof m.toolCallId !== 'string' || m.toolCallId === '')) {
      const where = ir.history && i < ir.history.length ? `history[${i}]` : 'currentTurn';
      throw new Error(
        `compile(): ${where} is a role:'tool' message without toolCallId. A tool result must name the call it answers ` +
          `(the \`id\` of the matching entry in the assistant message's \`toolCalls\`, i.e. \`response.toolCalls[n].id\`). ` +
          `To send a provider-native block instead, put it in \`parts\`.`,
      );
    }
  });
}

/**
 * alpha.41 — collapse `ir.models: ChainModelEntry[]` to a literal
 * `string[]`. String entries pass through; `{ family: string }` entries
 * resolve via `resolveFamilyEntry` which throws `FamilyResolutionError`
 * when no current+active candidate matches. Resolved-id dedupe inside the
 * same array silently drops the later occurrence so callers can mix
 * `[{ family: 'claude-opus' }, 'claude-opus-4-6']` without crashing the
 * scorer on duplicate ids.
 */
function resolveModelEntries(
  ir: PromptIR,
  resolutions: FamilyResolution[] = [],
  aliasResolutions: Array<{ alias: string; canonical: string }> = [],
): PromptIR {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of ir.models as ChainModelEntry[]) {
    let id: string;
    if (typeof entry === 'string') {
      // alpha.109 — a string entry may be an ALIAS (provider aliases such as
      // `deepseek-chat`; a retired id kept live by the provider such as
      // `deepseek-v4-flash` → `deepseek-flash`). The wire carries the
      // canonical id, so the resolution is a mutation the consumer can read —
      // what is changed is SAID. Dedupe below runs on the canonical id, so an
      // alias next to its canonical is one candidate, not two.
      id = canonicalId(entry);
      if (id !== entry) {
        aliasResolutions.push({ alias: entry, canonical: id });
      }
    } else if (entry && typeof entry === 'object' && 'family' in entry) {
      // alpha.107 — keep the WHY: lifecycle vs archetype-perf vs only-candidate.
      const res = resolveFamilyEntryDetailed(entry.family, {
        archetype: ir.intent.archetype,
        appId: ir.appId,
      });
      resolutions.push(res);
      id = res.id;
    } else {
      throw new Error(
        `compile(): ir.models entry must be a string or { family: string }; got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return { ...ir, models: out };
}

/**
 * alpha.124 — every candidate the modality requirement excluded, with why.
 * Same derivation (`inputModalityMiss`) the scoring pass used; the pin is
 * exempt there and here.
 */
function collectModalityDrops(
  candidates: string[],
  required: RequiredInputModality[],
  pin: string | undefined,
  resolver: (id: string) => ModelProfile,
): InputModalityDrop[] {
  const out: InputModalityDrop[] = [];
  for (const id of candidates) {
    if (id === pin) continue;
    let profile: ModelProfile | undefined;
    try {
      profile = resolver(id);
    } catch {
      profile = undefined;
    }
    const why = inputModalityMiss(profile, required);
    if (why !== undefined) out.push({ model: id, why });
  }
  return out;
}

function buildInputModalityDiagnostics(
  required: RequiredInputModality[],
  served: string[],
  candidates: string[],
  pin: string | undefined,
  resolver: (id: string) => ModelProfile,
): NonNullable<CompileResult['diagnostics']['inputModality']> {
  const providerOf = new Map<string, string>();
  const surviving: string[] = [];
  let pinnedUndeclared: string | undefined;
  for (const id of served) {
    const profile = resolver(id);
    if (inputModalityMiss(profile, required) === undefined) {
      surviving.push(id);
      providerOf.set(id, profile.provider);
    } else if (id === pin) {
      pinnedUndeclared = id;
    }
  }
  return {
    required: [...required],
    survivingModels: surviving,
    survivingProviders: new Set(providerOf.values()).size,
    dropped: collectModalityDrops(candidates, required, pin, resolver),
    ...(pinnedUndeclared ? { pinnedUndeclared } : {}),
  };
}

function inputModalityAdvisory(
  d: NonNullable<CompileResult['diagnostics']['inputModality']>,
  resolver: (id: string) => ModelProfile,
): BestPracticeAdvisory {
  const req = d.required.join(', ');
  const survivingProviders = new Set(
    d.survivingModels.map((id) => resolver(id).provider),
  );
  // A dropped model from a provider not yet covered, whose profile simply
  // does not declare: reading that provider's page is what would add it.
  const toRead = d.dropped.filter((x) => {
    if (x.why !== 'not declared') return false;
    try {
      return !survivingProviders.has(resolver(x.model).provider);
    } catch {
      return false;
    }
  });
  // Otherwise: bundled current models from an uncovered provider that DO declare.
  const declaringElsewhere = allProfiles()
    .filter(
      (p) =>
        p.status === 'current' &&
        !survivingProviders.has(p.provider) &&
        inputModalityMiss(p, d.required) === undefined,
    )
    .map((p) => p.id);
  const head =
    d.survivingProviders === 0
      ? d.pinnedUndeclared
        ? `No candidate's profile declares input modality ${req}; the pinned ${d.pinnedUndeclared} is served untouched because a pin is your knowledge — kgauto's profile for it does not declare ${req}, so if the provider rejects the input the call fails at the provider.`
        : `No candidate's profile declares input modality ${req}.`
      : `Only ${d.survivingProviders} provider (${[...survivingProviders].join(', ')}) can serve input modality ${req} in this candidate set: ${d.survivingModels.join(', ')}. A provider outage or a missing key leaves the call nowhere to fall over to.`;
  const suggestion =
    toRead.length > 0
      ? `kgauto has not read ${req} on the provider's page for ${toRead.map((x) => x.model).join(', ')} — it stays excluded until that page is read and the profile declares it (never widened to an undeclared model). Meanwhile add a declaring model from another provider${declaringElsewhere.length ? `: ${declaringElsewhere.slice(0, 6).join(', ')}` : ''}.`
      : declaringElsewhere.length > 0
        ? `Add a model from another provider whose profile declares ${req} to ir.models: ${declaringElsewhere.slice(0, 6).join(', ')}.`
        : `No bundled current profile from another provider declares ${req}; a second provider needs its model page read and the profile's inputModalities filled.`;
  return {
    level: 'warn',
    code: 'input-modality-fewer-than-two-providers',
    message: head,
    suggestion,
    recommendationType: 'model-swap',
  };
}

function pickTarget(ir: PromptIR, scores: TargetScore[]): TargetScore | undefined {
  // forceModel override, if set
  if (ir.constraints?.forceModel) {
    const forced = scores.find((s) => s.modelId === ir.constraints!.forceModel);
    if (forced && forced.fits) return forced;
    if (forced) {
      throw new Error(
        `compile(): forceModel="${ir.constraints.forceModel}" does not fit: ${forced.rejectReasons.join('; ')}`,
      );
    }
  }
  // Otherwise: highest rank that fits
  // alpha.135 (B3) — a tie in rank goes to the earlier candidate in the caller's list.
  const fitting = scores.filter((s) => s.fits).sort(compareByRankThenCallerOrder(ir.models));
  return fitting[0];
}

function validateFinalFit(ir: PromptIR, profile: ModelProfile, tokens: number): void {
  if (tokens > profile.maxContextTokens) {
    throw new Error(
      `compile(): final IR is ${tokens} tokens, exceeds ${profile.id} context (${profile.maxContextTokens})`,
    );
  }
  if ((ir.tools?.length ?? 0) > profile.maxTools) {
    throw new Error(
      `compile(): final IR has ${ir.tools?.length} tools, exceeds ${profile.id} maxTools (${profile.maxTools})`,
    );
  }
}
