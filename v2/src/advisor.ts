/**
 * Best-practice advisor — alpha.6 Phase 1.
 *
 * Inspects an IR + the selected profile + compile diagnostics and emits a
 * list of `BestPracticeAdvisory` entries describing detected gaps. Runs
 * after `lower()` in the compile pipeline; the result lands on
 * `CompileResult.advisories` for the consumer to log, surface, or filter.
 *
 * Driven by interfaces/kgauto.md `best-practice-advisories` (IC, 2026-05-07).
 * Phase 1 ships 4 starter rules sourced from the s14 kgauto comment +
 * s15 empirical seed of brain anti-patterns:
 *
 *   1. `caching-off-on-claude`        system >2000 chars on Anthropic, no cacheable=true
 *   2. `single-chunk-system`          Anthropic, only one PromptSection >1000 chars
 *   3. `tool-bloat`                   >10 tools on a short-output archetype
 *   4. `history-uncached-on-claude`   Anthropic, ≥2 history messages, no historyCachePolicy
 *
 * Each rule is a pure function: (ir, result, profile) → BestPracticeAdvisory[].
 * No side effects. No randomness. Deterministic for a given IR.
 *
 * The thresholds (2000 chars, 1000 chars, 10 tools, 2 history) are chosen
 * to balance noise vs. signal — too low fires on innocuous calls, too high
 * misses real waste. They may tune with brain evidence over time; for now
 * they're literals in the rule bodies. Make them configurable when the
 * cost-watcher's R-rules graduate to here.
 */

import type {
  BestPracticeAdvisory,
  CompilePolicy,
  CompileResult,
  PromptIR,
  SectionRewrite,
} from './ir.js';
import type { ModelProfile } from './profiles.js';
import { resolveModelAlias, priceAtInput } from './profiles.js';
import { canonicalPolicySet, policySetHas } from './policy-match.js';
import type { IntentArchetypeName } from './dialect.js';
import { getArchetypePerfScore } from './archetype-perf-brain.js';
import { getEffectivePrice, type EffectivePriceRow } from './effective-price-brain.js';
import { isBrainQueryActiveFor } from './brain-query.js';
import { getModelCompatibility } from './compatibility.js';
import {
  getDefaultFallbackChain,
  getStarterChain,
  estimateChainCostUsd,
} from './fallback.js';
import { getMeasuredFailureVerdict } from './measured-failure-brain.js';
import { getRecentRollback } from './promotions-brain.js';
import { effectiveConventions, blendedCostUsd, estimatedOutputTokensFor } from './passes.js';
import {
  getStaleExclusionFindings,
  isExclusionFindingsBrainActive,
} from './exclusion-findings-brain.js';
import {
  advisorRulePromoteReady,
  advisorRuleConsumerOnStaleModel,
  advisorRuleCrossFamilyFit,
  advisorRuleBlockedModelDrift,
  advisorRulePreferredBlockedOverlap,
} from './advisor-rules/index.js';

/** Subset of CompileResult fields the advisor needs. */
type AdvisorContext = Pick<
  CompileResult,
  'target' | 'provider' | 'tokensIn' | 'diagnostics'
>;

/**
 * Optional Phase 2 (alpha.22) context — fallback chain + a profile resolver
 * for cross-model comparison. Three new rules
 * (`cost-mismatched-archetype`, `model-stale-evidence`, `tier-down`) consume
 * this to surface measurement-substrate signals (alpha.20 clean-attribution +
 * alpha.21 grounding labels) as actionable consumer guidance.
 *
 * When `fallbackChain` is empty, rules 1 + 3 stay silent (nothing to
 * compare against). When `profileResolver` is omitted, the rules degrade
 * gracefully — they can still inspect the chosen profile but not chain
 * alternatives. Rule 2 (`model-stale-evidence`) is independent of chain
 * shape and works on the chosen model alone.
 */
export interface RunAdvisorPhase2Context {
  fallbackChain: string[];
  profileResolver?: (id: string) => ModelProfile | undefined;
  /**
   * alpha.29 — translator rewrites that fired this compile. When a rewrite
   * cleared the cliff (e.g. `tool_call_contract` → sequential-tool preamble
   * + `parallelToolCalls: false`), the matching cliff advisor
   * (`archetype-perf-floor-breach`) MUST suppress for the same call. Without
   * suppression both fire — the advisory contradicts the rewrite ("cliff is
   * unaddressed" vs "we just addressed it").
   *
   * Empty array / undefined → no suppression (alpha.28 behavior preserved).
   */
  sectionRewritesApplied?: SectionRewrite[];
  /**
   * alpha.110 — the call's estimated input tokens, so "cheaper" is priced at the call's
   * real blended shape with the SAME function the scorer uses (`blendedCostUsd`). Through
   * alpha.109 this file compared input rates per 1M while the scorer priced input-only at
   * the call's size — two definitions of cheaper. Absent → a 4K reference shape.
   */
  estimatedInputTokens?: number;
  /**
   * alpha.128 — the compile's route. A measured row keyed `model@openrouter` is read for a
   * gateway call (routeScopedModel), the bare id otherwise. Absent → direct.
   */
  route?: 'direct' | 'openrouter';
  /** alpha.132 (R4) — the fold numbers in force, for `currentturn-duplicated-in-history`'s sentence. */
  fold?: FoldNumbers;
}

/** alpha.110 — one cost function for the advisor: blended cost at the call's shape. */
function blendedAt(ir: PromptIR, phase2: RunAdvisorPhase2Context | undefined, p: ModelProfile): number {
  const shapeIn = phase2?.estimatedInputTokens ?? 4000;
  const shapeOut = estimatedOutputTokensFor(ir.intent.archetype, ir.constraints?.maxOutputTokens);
  return blendedCostUsd(p, shapeIn, shapeOut);
}

/**
 * alpha.128 — one archetype score, said with where it came from (the tier-down
 * sentence of 2026-11-05 compared a measured 7 anchored on its own incumbent with
 * a curated 5 and claimed the cheaper model matched or beat the target; tt-intelligence read
 * both numbers off run #47). The forms:
 *   `<id> 7 measured on <app> against <incumbent> (<score>), run golden-eval:47, n=30`
 *   `<id> 8 measured across apps (golden-eval:12, n=50)`   — a roster row a measurement wrote
 *   `<id> 5 curated`                                      — the cross-app judgment roster / bundle
 *   `<id> 5 default (no row)`                             — the neutral 5
 */
function perfPhrase(id: string, s: ReturnType<typeof getArchetypePerfScore>): string {
  if (s.source === 'measured') {
    const against =
      s.incumbentModel !== undefined
        ? ` against ${s.incumbentModel}${s.incumbentScore !== undefined ? ` (${s.incumbentScore})` : ''}`
        : ' against an incumbent the row does not name';
    return `${id} ${s.score} measured on ${s.appId ?? 'this app'}${against}, run ${s.evidenceSource ?? 'unknown'}, n=${s.n}`;
  }
  if (s.source === 'curated') {
    return s.grounding === 'measured'
      ? `${id} ${s.score} measured across apps (${s.evidenceSource ?? 'no evidence source'}, n=${s.n})`
      : `${id} ${s.score} curated`;
  }
  return `${id} ${s.score} default (no row)`;
}

/**
 * alpha.128 — when a measured score's ruler is not the model it is being compared
 * with, the sentence says so in those words.
 */
function rulerClause(id: string, s: ReturnType<typeof getArchetypePerfScore>, comparedWith: string): string {
  return s.source === 'measured' && s.incumbentModel !== undefined && s.incumbentModel !== comparedWith
    ? ` ${id} was measured against ${s.incumbentModel}, not against ${comparedWith}.`
    : '';
}

/**
 * alpha.128 — the per-1M prices the advisor PRINTS, at the same input the cost
 * comparison used: the tier the call's input falls in (`costTiers`), else the base.
 * A sentence that compared tier prices and printed base prices would say two things.
 */
function pricePer1mAt(phase2: RunAdvisorPhase2Context | undefined, p: ModelProfile): string {
  const price = priceAtInput(p, phase2?.estimatedInputTokens ?? 4000);
  return `$${price.costInputPer1m}/$${price.costOutputPer1m}`;
}

/**
 * alpha.129 — the fewest priced calls an app's own figure for a model needs
 * before the tier-down sentence prints it (R5).
 */
const EFFECTIVE_PRICE_MIN_N = 10;

/**
 * alpha.129 — a per-call dollar figure: 6 decimals, cut to the first non-zero
 * digit + 1 more (at least 2 decimals), trailing zeros trimmed
 * ($0.002450 → $0.0025, $0.14). Rounded on integer micro-dollars so a
 * binary-float 0.00245 never rounds down.
 */
export function formatPerCallUsd(usd: number): string {
  const micro = Math.round(usd * 1_000_000);
  if (micro <= 0) return '$0';
  const firstNonZeroDecimal = 6 - String(micro).length + 1;
  const decimals = Math.min(6, Math.max(2, firstNonZeroDecimal + 1));
  const step = 10 ** (6 - decimals);
  const rounded = Math.round(micro / step) * step;
  return `$${(rounded / 1_000_000).toFixed(decimals).replace(/\.?0+$/, '')}`;
}

function cacheShareClause(row: EffectivePriceRow): string {
  if (row.cacheReadShare === undefined) return '';
  return ` (cache reads ${Math.round(row.cacheReadShare * 1000) / 10} % of the prompt)`;
}

/**
 * alpha.129 (R5) — what the app's own calls on each model cost over the last
 * 30 days (migration 095), appended to the tier-down sentence. Prose only: the
 * rule's gates, its `suggestion` and every chain are untouched. Both models
 * with n >= 10 → both figures; one → that one and the other named as short of
 * ten; neither → nothing (the alpha.128 sentence stands).
 */
function effectivePriceClause(
  appId: string | undefined,
  archetype: string,
  alt: { id: string; profile: ModelProfile },
  chosen: ModelProfile,
): string {
  if (!appId) return '';
  const priced = (model: string) => {
    const row = getEffectivePrice(appId, archetype, model);
    return row && row.n >= EFFECTIVE_PRICE_MIN_N ? row : undefined;
  };
  const altRow = priced(alt.profile.id);
  const chosenRow = priced(chosen.id);
  if (altRow && chosenRow) {
    return ` On ${appId} over the last 30 days: ${alt.id} ${formatPerCallUsd(altRow.avgCostUsd)} per call on n=${altRow.n}${cacheShareClause(altRow)}, ${chosen.id} ${formatPerCallUsd(chosenRow.avgCostUsd)} per call on n=${chosenRow.n}.`;
  }
  const one = altRow
    ? { id: alt.id, row: altRow, other: chosen.id }
    : chosenRow
      ? { id: chosen.id, row: chosenRow, other: alt.id }
      : undefined;
  if (!one) return '';
  return ` On ${appId} over the last 30 days ${one.id} cost ${formatPerCallUsd(one.row.avgCostUsd)} per call on n=${one.row.n}; ${one.other} has fewer than ${EFFECTIVE_PRICE_MIN_N} priced calls here.`;
}

/**
 * Quality-floor for cross-model swap recommendations. An alternative
 * model's archetypePerf score must be >= this value before the advisor will
 * surface it as a recommendation. Set above the neutral default (5) so the
 * library never recommends a swap to a model with no measured backing AND
 * no hand-curated score better than baseline.
 *
 * Driven by `feedback_quality_as_floor` — quality is the binary floor;
 * cost is what we optimize ABOVE it. Cheaper-and-worse is never a swap
 * recommendation, regardless of cost savings.
 */
const QUALITY_FLOOR_FOR_RECOMMENDATION = 6;

/**
 * Minimum cost-savings ratio for the `tier-down` rule. The alternative
 * must cost at most this fraction of the chosen model's per-1M input
 * cost. Set at 0.5 (alt is 2x cheaper or more) to keep the rule from
 * firing on marginal $1.20 → $1.00 deltas.
 */
const TIER_DOWN_COST_RATIO = 0.5;

/**
 * Score threshold below which the chosen model counts as "room to grow"
 * for `cost-mismatched-archetype`. When the chosen model's archetype perf
 * is below this AND a chain alternative has a data-backed score not below it
 * at lower cost, surface the swap.
 */
const COST_MISMATCHED_CHOSEN_SCORE_CEILING = 7;

/**
 * alpha.42 — rule codes whose advisories are positioned for kgauto (not
 * the consumer) to act on. Used by `compile()` to default the `ownership`
 * stamp on each advisory when the rule didn't self-declare. Consumer-side
 * rules don't need to be listed — they default to `'consumer-actionable'`
 * via fall-through.
 *
 *   - `model-stale-evidence`: kgauto's profile data is out of date; the
 *     consumer can't fix that, kgauto needs to update profiles or refresh
 *     archetypePerf scores.
 *   - `promote-ready`: kgauto's promotion-probe-watcher detected a
 *     candidate model worth promoting; consumer-side adoption is downstream
 *     of kgauto adding it to the chain / family taxonomy.
 *
 * Frozen so consumers and tests can't mutate the global ownership map.
 */
export const PRODUCER_OWNED_RULE_CODES: ReadonlySet<string> = Object.freeze(
  new Set<string>(['model-stale-evidence', 'promote-ready']),
) as ReadonlySet<string>;

/**
 * alpha.42 — pure function used by `compile()` to decide ownership for an
 * advisory. Rule-self-declared wins; falls back to the static map; defaults
 * `consumer-actionable`. Exported so consumer-side code (or a Glass-Box
 * renderer) can derive the same classification from a rule code alone
 * without needing the advisory object.
 */
export function deriveOwnership(
  code: string,
  selfDeclared?: 'consumer-actionable' | 'producer-owned',
): 'consumer-actionable' | 'producer-owned' {
  if (selfDeclared) return selfDeclared;
  return PRODUCER_OWNED_RULE_CODES.has(code) ? 'producer-owned' : 'consumer-actionable';
}

/**
 * Run all phased rules and return collected advisories. Order is fixed so
 * output is stable across runs. The `policy` argument is alpha.9 — the
 * `single-model-array` rule needs to know whether the consumer explicitly
 * declared `posture: 'locked'` (in which case single-model is intentional
 * and shouldn't warn).
 *
 * `phase2` is alpha.22 — gives the advisor access to the fallback chain +
 * a profile resolver so the three new compile-time recommendation rules
 * (`cost-mismatched-archetype`, `model-stale-evidence`, `tier-down`) can
 * compare the chosen model against in-chain alternatives. Optional for
 * backward compatibility with consumers calling `runAdvisor()` directly.
 */
export function runAdvisor(
  ir: PromptIR,
  result: AdvisorContext,
  profile: ModelProfile,
  policy?: CompilePolicy,
  phase2?: RunAdvisorPhase2Context,
): BestPracticeAdvisory[] {
  const out: BestPracticeAdvisory[] = [];
  out.push(...detectCachingOff(ir, profile));
  out.push(...detectSingleChunkSystem(ir, profile));
  out.push(...detectToolBloat(ir, result));
  out.push(...detectHistoryUncached(ir, profile));
  // alpha.130 (R7) — a structural fact about the consumer's own IR, like the
  // history rule above: posture-independent, no IR rewrite.
  out.push(...detectCurrentTurnDuplicatedInHistory(ir, phase2?.fold));
  out.push(...detectSingleModelArray(ir, policy));
  // blocked-model drift. Posture-independent, like the alpha.28 cliff
  // advisor: this reports that the consumer's OWN declared constraint is
  // not covering what its author expects, which is not a recommendation.
  // `posture: 'locked'` opts out of kgauto picking models — it does not opt
  // out of being told a block-list entry is inert.
  out.push(
    ...advisorRuleBlockedModelDrift({
      policy,
      selectedModelId: profile.id,
    }),
  );
  // preferred∩blocked overlap — same posture-independent reasoning: a
  // self-contradictory policy is a structural fact, not a recommendation.
  out.push(
    ...advisorRulePreferredBlockedOverlap({
      policy,
      selectedModelId: profile.id,
    }),
  );
  // alpha.22 — Phase 2 recommendation rules. All three silent under
  // posture='locked' (consumer opted into "no recommendations").
  if (policy?.posture !== 'locked') {
    out.push(...detectCostMismatchedArchetype(ir, profile, phase2));
    out.push(...detectModelStaleEvidence(ir, profile));
    out.push(...detectTierDown(ir, profile, phase2));
  }
  // alpha.28 — archetype-cliff advisor. Capability-fact-grounded; fires
  // regardless of posture (the cliff is a structural quality floor, not a
  // recommendation). Driven by `getModelCompatibility()` in
  // `compatibility.ts` per the tt-intel-Cairn ratified consultation doc.
  //
  // alpha.29 suppression: when the translator already rewrote a
  // `tool_call_contract` section to clear the same cliff, do NOT also emit
  // the cliff advisory. The rewrite + advisory together contradict each
  // other ("cliff cleared structurally" vs "cliff unaddressed").
  if (!translatorClearedToolCallCliff(phase2)) {
    out.push(...detectArchetypePerfFloorBreach(ir, profile));
  }
  // alpha.38 — stale-exclusion compile-time advisor. Reads the per-tenant
  // exclusion_findings cache (alpha.37 substrate) and surfaces an `info`-
  // level advisory when the consumer's traffic for this archetype has been
  // skipping a current+active model. Silent under posture='locked' (the
  // consumer has explicitly opted into "no recommendations").
  if (policy?.posture !== 'locked') {
    out.push(...detectStaleExclusionCandidate(ir));
  }
  // alpha.41 — promote-ready + consumer-on-stale-model advisors (s47
  // Phase 2 activation). Both silent under posture='locked'. Promote-ready
  // needs the resolved primary model id (post-family + chain-walk) to
  // match against the finding's current_model; consumer-on-stale-model
  // reads (appId, archetype) directly off the IR. Both gated on appId
  // because findings are scoped per-tenant via RLS.
  if (policy?.posture !== 'locked' && ir.appId) {
    out.push(
      ...advisorRulePromoteReady({
        appId: ir.appId,
        archetype: ir.intent.archetype,
        resolvedPrimary: profile.id,
      }),
    );
  }
  // alpha.126 — consumer-on-stale-model also reads the SELECTED model's own
  // profile (the provider's lifecycle word, or kgauto's `status`), which needs
  // no appId and no brain; its cron-findings path keeps its own appId gate
  // inside. Still silent under posture='locked'.
  if (policy?.posture !== 'locked') {
    out.push(...advisorRuleConsumerOnStaleModel(ir, { selectedModelId: profile.id }));
  }
  // alpha.43 — cross-family-fit positive advisor. NO appId gate (the
  // archetype-fit table is family-architectural, not consumer-scoped) and
  // NO brain dependency (reads static ARCHETYPE_FAMILY_FITS). Silent under
  // posture='locked' per the same "consumer opted out of recommendations"
  // semantic as promote-ready.
  if (policy?.posture !== 'locked') {
    out.push(
      ...advisorRuleCrossFamilyFit({
        archetype: ir.intent.archetype,
        resolvedPrimary: profile.id,
      }),
    );
  }
  return out;
}

/**
 * alpha.29 — does the translator-rewrite list cover the tool-call cliff for
 * this call? True when ANY rewrite has `kind === 'tool_call_contract'` —
 * today the only translator rule, and the only adapter that addresses the
 * sequential-tool cliff family. alpha.30+ will generalize to per-kind +
 * per-rule suppression maps as more adapters land.
 */
function translatorClearedToolCallCliff(
  phase2: RunAdvisorPhase2Context | undefined,
): boolean {
  const rewrites = phase2?.sectionRewritesApplied;
  if (!rewrites || rewrites.length === 0) return false;
  for (const rw of rewrites) {
    if (rw.kind === 'tool_call_contract') return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 1 — caching-off-on-claude
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: target is Anthropic AND the rendered system has >2000 chars
 * AND no PromptSection has `cacheable: true`.
 *
 * Why: Anthropic prompt caching cuts the cached-prefix input cost ~90% on
 * subsequent calls. Leaving caching off when the system is large enough to
 * benefit (>2000 chars ≈ ~500 tokens, well above Anthropic's minTokens
 * threshold for the system_prompt cache breakpoint after a turn or two)
 * is a flat overpay every call.
 *
 * Why 2000 chars (not 1024 tokens): the threshold is a pre-tokenization heuristic
 * — counting tokens here would force a tokenizer call before the advisory layer
 * runs, and the false-positive cost (advising on a 1500-char prompt that
 * tokenizes to 800 tokens) is low. The actual marker placement still gates
 * on profile.lowering.cache.minTokens at lower-time.
 */
function detectCachingOff(
  ir: PromptIR,
  profile: ModelProfile,
): BestPracticeAdvisory[] {
  if (profile.provider !== 'anthropic') return [];

  const totalChars = ir.sections.reduce((s, sec) => s + sec.text.length, 0);
  if (totalChars < 2000) return [];

  const anyCacheable = ir.sections.some((s) => s.cacheable === true);
  if (anyCacheable) return [];

  return [
    {
      level: 'warn',
      code: 'caching-off-on-claude',
      message: `System prompt is ${totalChars} chars on Anthropic but no PromptSection has cacheable=true. Anthropic prompt caching cuts cached-prefix input cost by ~90% on subsequent calls; without it, every turn re-pays full price for the static system context.`,
      suggestion:
        'Mark stable system sections (role, persona, tool policy) with `cacheable: true`. The lowering pass concatenates cacheable sections into a single cache-controlled block before the dynamic ones.',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 2 — single-chunk-system
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: target is Anthropic AND `ir.sections.length === 1` AND that
 * section's text is >1000 chars.
 *
 * Why: a flat-string system prompt forces the cache marker (when present)
 * onto a single block whose entire content must be byte-stable for the
 * cache to hit. NamedChunks let the static role/persona stay byte-stable
 * while dynamic context (current creator, fresh queries) lives in separate
 * uncached chunks. Same total tokens, much higher cache-hit rate.
 *
 * Strictly informational: a flat 1500-char string isn't broken, just
 * leaving cache-hit-rate on the table. Doesn't fire when sections.length
 * is already >1.
 */
function detectSingleChunkSystem(
  ir: PromptIR,
  profile: ModelProfile,
): BestPracticeAdvisory[] {
  if (profile.provider !== 'anthropic') return [];
  if (ir.sections.length !== 1) return [];
  const only = ir.sections[0];
  if (!only || only.text.length <= 1000) return [];

  return [
    {
      level: 'info',
      code: 'single-chunk-system',
      message: `System prompt is a single ${only.text.length}-char chunk. Splitting into NamedChunks (static role/persona vs dynamic context) gives the lowering pass a finer cache-marker boundary — only the static portion needs to be byte-stable for the cache to hit.`,
      suggestion:
        'Refactor the system builder to return an array of `PromptSection` shaped { id, text, cacheable?: boolean }. Static chunks (role, persona, tool policy) get `cacheable: true`; dynamic ones (current context, today\'s date) don\'t. ' +
        // alpha.78 (PB 2026-07-25): consumers with a protected section ORDER
        // must know this before acting — the omission is what forced PB to
        // ask instead of decide.
        'NOTE: the lowering pass HOISTS cacheable sections ahead of dynamic ones on the Anthropic wire (prefix caching requires it) — if your prompt has a protected ordering (e.g. a voice/persona block that must precede boilerplate), splitting will reorder the compiled output; declining this advisory is then correct. Also: a cacheable block under ~1024 tokens gets NO cache_control marker (provider minimum), so marking small sections is inert, not harmful.',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 3 — tool-bloat
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: post-relevance-pass `diagnostics.toolsKept > 10` AND archetype
 * is one where >10 tools is almost always wasted budget (`classify`,
 * `extract`, `summarize`, `transform`, `critique` — short-output, not
 * multi-step).
 *
 * Why: tool definitions eat context budget (~350 tokens each per L-051);
 * 10 tools = ~3500 tokens of context tax. For archetypes that don't
 * iteratively call tools (classify decides once; extract pulls fields;
 * summarize compresses), the surplus is dead weight on every call.
 *
 * alpha.6.1 (ADV-001 fix): gate on `diagnostics.toolsKept` (the post-relevance
 * count), not raw `ir.tools.length`. Without this fix, the rule fires
 * noise on consumers who already correctly wired `relevanceByIntent` — the
 * tool-relevance pass dropped 8 of 12 to a final 4, but the rule saw the
 * input 12 and warned. False-positive erodes trust in the warn-level signal.
 *
 * Skips: `hunt`, `plan`, `generate`, `ask` — these may legitimately need
 * many tools (multi-step search, agentic loops, open-ended generation).
 */
function detectToolBloat(
  ir: PromptIR,
  result: AdvisorContext,
): BestPracticeAdvisory[] {
  const SHORT_OUTPUT = new Set([
    'classify',
    'extract',
    'summarize',
    'transform',
    'critique',
  ]);
  if (!ir.tools || ir.tools.length === 0) return [];
  const toolsKept = result.diagnostics.toolsKept;
  if (toolsKept <= 10) return [];
  if (!SHORT_OUTPUT.has(ir.intent.archetype)) return [];

  return [
    {
      level: 'warn',
      code: 'tool-bloat',
      message: `${toolsKept} tools kept after the relevance pass for archetype="${ir.intent.archetype}" (consumer declared ${ir.tools.length}). This archetype is short-output and rarely needs more than 3 tools; each tool definition eats ~350 tokens of context budget.`,
      suggestion:
        "Tighten `relevanceByIntent: { [archetype]: 0..1 }` per ToolDefinition. Tools below `toolRelevanceThreshold` (default 0.2) get dropped. Without `relevanceByIntent`, every tool defaults to neutral (0.5) and stays.",
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#tools',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 4 — history-uncached-on-claude
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: target is Anthropic AND `ir.history.length >= 2` AND
 * `ir.historyCachePolicy` is unset OR `{ strategy: 'none' }`.
 *
 * Why: alpha.5 ships `historyCachePolicy: 'all-but-latest'` which marks
 * the message preceding currentTurn for caching — every subsequent turn
 * inherits the cached prefix at ~10% input cost. Without it, multi-turn
 * conversations re-pay the entire history every turn.
 *
 * Sharper after alpha.5: the suggestion now points at a one-line fix that
 * exists. Pre-alpha.5, "you're not caching history" had no actionable
 * primitive in kgauto, which is why this rule waited until now to ship.
 */
function detectHistoryUncached(
  ir: PromptIR,
  profile: ModelProfile,
): BestPracticeAdvisory[] {
  if (profile.provider !== 'anthropic') return [];
  if (!ir.history || ir.history.length < 2) return [];
  if (
    ir.historyCachePolicy &&
    ir.historyCachePolicy.strategy !== 'none'
  ) {
    return [];
  }

  return [
    {
      level: 'warn',
      code: 'history-uncached-on-claude',
      message: `${ir.history.length} history messages on Anthropic with no historyCachePolicy. Every turn re-pays for the full conversation context; with caching, subsequent turns hit the cache at ~10% the input cost.`,
      suggestion:
        "Set `historyCachePolicy: { strategy: 'all-but-latest' }` on this IR. The lowering pass marks the message immediately preceding currentTurn with cache_control; subsequent turns whose history prefix matches byte-for-byte hit the cache.",
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

/**
 * alpha.130 (R7) — `currentturn-duplicated-in-history` (inspire-central,
 * 2026-08-29, option (b): one advisory, no IR rewrite).
 *
 * Fires when: `ir.history.length > 0` AND the last history message has the
 * same `role` and the same `content` as `ir.currentTurn`.
 *
 * Why: an AI-SDK consumer holds the full `messages` array AND "the latest user
 * message"; passing them as `history` + `currentTurn` sends the turn twice, and
 * `historyCachePolicy: 'all-but-latest'` then marks the DUPLICATE (the message
 * preceding currentTurn) — the very message that must sit outside the cacheable
 * prefix. Silent, and in the direction of money: the answer is right and the
 * prefix never warms. The advisory names the index and says where the cache
 * mark sits; kgauto does not reinterpret the IR (a consumer may mean it).
 */
export const CURRENT_TURN_DUPLICATED_IN_HISTORY_CODE = 'currentturn-duplicated-in-history';

/**
 * alpha.132 — the rule's one test, shared with compile()'s
 * `diagnostics.conversationWindow` (which counts the duplicate once): the last
 * `history` message has `currentTurn`'s role and content.
 */
export function currentTurnDuplicatedInHistory(ir: Pick<PromptIR, 'history' | 'currentTurn'>): boolean {
  const history = ir.history ?? [];
  const turn = ir.currentTurn;
  if (history.length === 0 || !turn) return false;
  const last = history[history.length - 1]!;
  return last.role === turn.role && last.content === turn.content;
}

/** alpha.132 (R4) — the fold numbers in force on this compile (compile.ts passes them; defaults otherwise). */
export interface FoldNumbers {
  compressHistoryAfter?: number;
  compressHistoryKeepRecent?: number;
  compressHistoryAboveTokens?: number;
}

function detectCurrentTurnDuplicatedInHistory(ir: PromptIR, fold: FoldNumbers = {}): BestPracticeAdvisory[] {
  const history = ir.history ?? [];
  const turn = ir.currentTurn;
  if (!currentTurnDuplicatedInHistory(ir) || !turn) return [];
  const i = history.length - 1;

  // Where the history cache mark lands — the compiler's own rule
  // (computeHistoryCacheMarkIndex in compile.ts), read off the same policy.
  const policy = ir.historyCachePolicy;
  let markClause: string;
  if (policy?.strategy === 'all-but-latest') {
    markClause = `historyCachePolicy 'all-but-latest' puts the cache mark on history[${i}] — the duplicate — so the cacheable prefix ends on the turn that changes every call and never warms.`;
  } else if (policy?.strategy === 'fixed-suffix') {
    const at = i - policy.suffix;
    markClause =
      at === i
        ? `historyCachePolicy 'fixed-suffix' (suffix 0) puts the cache mark on history[${i}] — the duplicate — so the cacheable prefix never warms.`
        : `historyCachePolicy 'fixed-suffix' puts the cache mark on history[${at}], not on the duplicate; the turn is still sent and billed twice.`;
  } else {
    markClause = `No history cache mark is set today; with historyCachePolicy 'all-but-latest' the mark would sit on history[${i}] — the duplicate.`;
  }

  return [
    {
      level: 'warn',
      code: CURRENT_TURN_DUPLICATED_IN_HISTORY_CODE,
      message: `history[${i}] repeats currentTurn (role "${turn.role}", the same content): the model reads the turn twice. ${markClause}`,
      suggestion:
        'Pass the conversation WITHOUT its last message as `history` when that message is the `currentTurn` (e.g. `history: messages.slice(0, -1)`). kgauto does not drop it for you: the IR is sent as written. ' +
        foldSentence(history.length, fold),
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

/**
 * alpha.132 (R4) — the fold counts `history` only, so removing the duplicate
 * moves it: one sentence with the numbers in force on this compile.
 */
function foldSentence(historyLength: number, fold: FoldNumbers): string {
  const after = fold.compressHistoryAfter ?? 8;
  const keep = fold.compressHistoryKeepRecent ?? 4;
  const tokens =
    fold.compressHistoryAboveTokens !== undefined
      ? `, and a long current turn no longer counts toward the ${fold.compressHistoryAboveTokens}-token threshold (\`compressHistoryAboveTokens\`)`
      : ', and a long current turn no longer counts toward a token threshold if you set one (`compressHistoryAboveTokens`)';
  return (
    `Removing the duplicate shortens \`history\` by one (${historyLength} → ${historyLength - 1}), so this conversation folds one message later: the fold counts \`history\` only, fires when it holds more than ${after} messages (\`compressHistoryAfter\`) and keeps the last ${keep} (\`compressHistoryKeepRecent\`)` +
    tokens +
    '. To keep today\'s window on purpose, lower `compressHistoryAfter` and `compressHistoryKeepRecent` by one each; `diagnostics.conversationWindow` says how many messages the request carries.'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 5 — single-model-array  (alpha.9)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: `ir.models.length === 1` AND `policy.posture !== 'locked'`.
 *
 * Why: a single-model array means there's no safety net. The first 429 / 5xx
 * / contract violation hits the user as a 502. Master plan §1.2 makes this
 * explicit — for `preferred`/`open` postures, a 2-step minimum closes the
 * reliability gap with one extra string in the array.
 *
 * Skipped when posture is `'locked'`: the consumer has explicitly opted
 * into "no fallback" (compliance, brand-promise). The advisor respects
 * the choice and stays silent.
 *
 * Sharper after alpha.9 ships `getDefaultFallbackChain`: the suggestion now
 * points at a one-line fix that exists.
 *
 * Activation criteria (master plan §3.4 worked examples):
 *   - PB `/api/chat` default-user route: was [Flash, Sonnet] — passes
 *   - PB `analyze.js` post-PB-01:        was [Flash] — fires
 *   - tt-intel Hunter default path:      was [Sonnet] single — fires
 *   - IC `/api/chat`, `dyad.ts`, etc.:   all single — fires
 *
 * Surfaces the consumers who have unguarded single points of failure today.
 */
function detectSingleModelArray(
  ir: PromptIR,
  policy?: CompilePolicy,
): BestPracticeAdvisory[] {
  if (ir.models.length !== 1) return [];
  if (policy?.posture === 'locked') return [];

  const entry = ir.models[0]!;
  // Family entries are pre-resolved to literal ids by compile() (alpha.41)
  // before the advisor runs; a raw family object here means the caller
  // invoked the detector directly on an unresolved IR — keep the id-shaped
  // path and let the display name carry the family.
  const only = typeof entry === 'string' ? entry : `family:${entry.family}`;

  // alpha.85 — severity is graded on whether a known-good alternative
  // EXISTS. tt-intel/classify (2026-07-29): 23 failures in a 52s burst,
  // zero fallovers, while this rule sat open at `warn` on all 23 calls,
  // describing the mechanism verbatim. A warning that accurately predicts
  // an incident and changes nothing is a log line; where the roster holds
  // a compatible, non-blocked alternative the missing safety net is
  // adoptable today and the finding is `critical`. Where no alternative
  // exists (exotic archetype, everything else blocked), `warn` stands —
  // there is nothing actionable to escalate to.
  const blocked = canonicalPolicySet(policy?.blockedModels);
  let alternatives: string[] = [];
  try {
    alternatives = getDefaultFallbackChain({
      archetype: ir.intent.archetype,
      primary: only,
      posture: 'preferred',
      policy,
    })
      .filter((id) => resolveModelAlias(id) !== resolveModelAlias(only))
      .filter((id) => !policySetHas(blocked, id))
      .filter((id) => getModelCompatibility(id, { archetype: ir.intent.archetype }).status !== 'reject');
  } catch {
    // roster/chain lookup failure ⇒ no claim about alternatives; stay warn
  }
  const hasAlternative = alternatives.length > 0;

  // alpha.85 — the remedy must emit `policy.preferredModels` alongside the
  // chain. compile() SCORES the candidate set and does not honour chain
  // order, so a chain alone can retarget the primary (tt-intel measured it:
  // classify/summarize moved to deepseek-v4-flash, hunt to gemini-2.5-pro).
  // The previous text claimed `posture: 'preferred'` keeps the primary and
  // is cost-neutral — false without the pin, and `posture` is inert once
  // `primary` is passed. A reliability fix must not silently reprice.
  const remedy =
    'Widen the chain AND pin your primary: `compile({ ...ir, models: getDefaultFallbackChain({ archetype: ir.intent.archetype, primary: \'' +
    only +
    "', posture: 'preferred' }) }, { policy: { preferredModels: ['" +
    only +
    "'] } })`. The chain is a CANDIDATE SET — compile() scores it and does not honour its order, so without the `preferredModels` pin the extra entries can retarget your primary (and with it your cost profile). With the pin, `" +
    only +
    '` stays primary and the added entries serve only as the safety net. Note `posture` has no effect once `primary` is passed. If you gate models by spend, re-verify `policy.blockedModels` against the widened set before shipping. If single-model is intentional (compliance/brand promise), set `policy.posture = \'locked\'` to silence this rule.';

  return [
    {
      level: hasAlternative ? 'critical' : 'warn',
      code: 'single-model-array',
      message: hasAlternative
        ? `\`ir.models\` has length 1 (only "${only}") for archetype "${ir.intent.archetype}" and posture is not 'locked'. A single-model chain has no safety net — the first 429 / 5xx / cliff hits the user as a failure — and a compatible, non-blocked alternative exists in the roster today (${alternatives[0]}), so this is critical: the missing safety net is adoptable now.`
        : `\`ir.models\` has length 1 (only "${only}") for archetype "${ir.intent.archetype}" and posture is not 'locked'. A single-model chain has no safety net — the first 429 / 5xx / cliff hits the user as a failure. No compatible non-blocked alternative is visible in the roster for this archetype, so this stays a warning.`,
      suggestion: remedy,
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Shared recommendation suppression — alpha.82
// ─────────────────────────────────────────────────────────────────────────

/**
 * **May this rule recommend `altProfile` on this surface at all?**
 *
 * alpha.78 added three cross-subsystem checks so a cost rule could not
 * recommend a model that another subsystem had already convicted. They were
 * added to `cost-mismatched-archetype` **and to nothing else**, while the
 * release note said "the cost advisor reads gates + rollbacks before
 * recommending" — which reads as covering the cost advisories generally.
 *
 * PB falsified that one day later with a live counter-example (s85,
 * 2026-07-29): a `tier-down` advisory recommending `deepseek-v4-flash` for
 * playbacksam/summarize, opened **five days after** the promotion guard rolled
 * back that exact model on that exact surface — inside a 28-day suppression
 * window that `tier-down` had never consulted.
 *
 * So the guards now live in ONE function that every recommending rule calls.
 * A per-rule copy is how this happened: the fix was real, partial, and
 * described as general. If you add a rule that names an alternative model,
 * call this — and if you find yourself re-implementing one of these checks
 * inline, that is the bug reproducing.
 *
 * @returns a reason string when the recommendation must be suppressed, or
 *   `undefined` when it may proceed. Returning the REASON rather than a
 *   boolean is deliberate: a suppressed recommendation is a decision, and a
 *   caller (or a future Glass-Box surface) should be able to say which
 *   subsystem made it rather than watching a candidate silently vanish.
 */
function suppressedRecommendationReason(
  ir: PromptIR,
  archetype: IntentArchetypeName,
  altProfile: ModelProfile,
): string | undefined {
  // (a) The consumer's own measured evidence gates this model here.
  // alpha.98 — the two axes get distinct reason codes. Recommending a model
  // is bad advice on either (unusable answers, or answers we cannot get),
  // but the remedy differs — distrust the model vs. look at the account or
  // the route — and a single label would send the reader the wrong way half
  // the time.
  const measured = getMeasuredFailureVerdict({
    appId: ir.appId,
    archetype,
    model: altProfile.id,
  });
  if (measured?.quality.gated === true) return 'measured-failure-gate';
  if (measured?.availability.gated === true) return 'measured-unavailable-gate';

  // (b) Declared schema weakness under a structured-output contract — pass 5
  // will penalize it, so recommending it argues with kgauto's own gate.
  if (
    ir.constraints?.structuredOutput &&
    effectiveConventions(altProfile).some(
      (c) => c.archetype === archetype && c.structuredOutputHint === 'avoid',
    )
  ) {
    return 'schema-weakness-convention';
  }

  // (c) The promotion guard rolled this model back on this exact surface
  // inside the suppression window. Recommending it re-litigates a decision
  // the guard made on measured evidence.
  if (getRecentRollback({ appId: ir.appId, archetype, model: altProfile.id }) !== undefined) {
    return 'recent-rollback';
  }

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// posture:'open' remedy guard — alpha.80
// ─────────────────────────────────────────────────────────────────────────

/**
 * Answers, for a cost-motivated advisory: **may I offer `posture: 'open'` as
 * a remedy here, and if so what is its consequence?**
 *
 * Why this exists: `cost-mismatched-archetype` offered `posture: 'open'` and
 * "declare <cheap model> as primary" in one `suggestion` field as if they
 * were interchangeable. They are opposite. On tt-intel's `ask` surface the
 * two remedies differ by 8.6x, and the `posture: 'open'` branch costs 3x the
 * status quo the advisory opened by complaining about — while *resolving the
 * advisory*, because posture is no longer `'preferred'`. A consumer that read
 * the sentence to its end and took the easier-sounding option would have
 * tripled their hottest path's spend, closed two advisories doing it, and
 * seen a green build with no signal anywhere.
 *
 * The rule this encodes: **an advisory may not recommend a mechanism whose
 * outcome it has not computed.** The chain builder is right there; call it.
 *
 * @returns `undefined` when open posture must NOT be offered (it would pick
 *   something at least as expensive as the model we are recommending), or a
 *   ready-to-append clause naming what open posture actually selects.
 */
function openPostureRemedyClause(
  archetype: IntentArchetypeName,
  recommended: ModelProfile,
  resolveProfile: (id: string) => ModelProfile | undefined,
): string | undefined {
  const openChain = getDefaultFallbackChain({ archetype, posture: 'open' });
  const openPrimaryId = openChain[0];
  if (!openPrimaryId) return undefined;

  const openPrimary = resolveProfile(openPrimaryId);
  if (!openPrimary) return undefined;

  const openCost = estimateChainCostUsd(openPrimary);
  const recommendedCost = estimateChainCostUsd(recommended);

  // Open posture would land on something no cheaper than what we are already
  // recommending — offering it as a cost remedy would be advice against the
  // advisory's own purpose. Say nothing about posture at all.
  if (openCost >= recommendedCost) return undefined;

  // State the cost consequence even when the answer is favourable. An earlier
  // draft named the model but not its price, which is the same defect one
  // notch smaller — the consumer still could not compare the two remedies
  // without running the chain themselves, which is exactly what the filing
  // said they should not have to do. (Caught by the real-sweep smoke, not the
  // fixture test: L-117 again.)
  const ratio = recommendedCost / openCost;
  return ` Relaxing to \`policy.posture = 'open'\` is also viable here — it selects \`${openPrimaryId}\`, which is ${ratio >= 1.1 ? `about ${ratio.toFixed(1)}x cheaper than` : 'priced comparably to'} \`${recommended.id}\` at a reference call shape. Note the library chain is ordered by archetype performance, not cost; it happens to agree with the cost recommendation for this archetype.`;
}

/**
 * The counterpart clause for the case above: open posture is NOT a cost
 * remedy, and the consumer deserves to know that before they reach for it,
 * because it is the more discoverable of the two options.
 */
function openPostureCostWarningClause(
  archetype: IntentArchetypeName,
  recommended: ModelProfile,
  resolveProfile: (id: string) => ModelProfile | undefined,
): string {
  const openChain = getDefaultFallbackChain({ archetype, posture: 'open' });
  const openPrimaryId = openChain[0];
  const openPrimary = openPrimaryId ? resolveProfile(openPrimaryId) : undefined;
  if (!openPrimary || !openPrimaryId) return '';

  // alpha.104 — resolve BOTH sides before printing a ratio. When open posture
  // would select the very model being recommended, there is no warning to
  // give: the two remedies are the same remedy. Through alpha.103 this
  // printed "would select `gemini-2.5-flash` — roughly 1.0x the cost of
  // `gemini-2.5-flash`" on tt-intelligence's summarize advisory (row
  // 02477122…, 16 observations) — a remedy paragraph arguing against itself.
  // The finding above it was right; the prescription is the part a consumer
  // acts on (s116 family), so it must not be self-cancelling.
  if (openPrimaryId === recommended.id) return '';

  const ratio = estimateChainCostUsd(openPrimary) / estimateChainCostUsd(recommended);
  // Below 1.1x the two are priced comparably — the mirror of the favourable
  // clause's own band — and "roughly 1.0x the cost" is not a warning.
  if (ratio < 1.1) return '';

  return ` Do NOT reach for \`posture = 'open'\` as a cost fix here: the library chain is ordered by archetype performance, not cost, and would select \`${openPrimaryId}\` — roughly ${ratio.toFixed(1)}x the cost of \`${recommended.id}\`. Pass \`getDefaultFallbackChain({ archetype: '${archetype}', posture: 'open', optimizeFor: 'cost' })\` if you want a library-picked chain that is actually cost-ordered.`;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 6 — cost-mismatched-archetype  (alpha.22 Phase 2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: the chosen model's archetype perf is `judgment` grounded
 * (no measured backing) OR its score is below
 * COST_MISMATCHED_CHOSEN_SCORE_CEILING (room to grow), AND a chain
 * alternative has archetype perf not below the chosen one's at strictly lower cost.
 *
 * Why: when chain placement was a hand-curated guess, the data sometimes
 * shows a cheaper alternative is actually as good. This rule surfaces those
 * placements so consumers can graduate routing decisions from judgment to
 * data. The "judgment OR < 7" trigger is intentionally permissive — a 10/10
 * frontier model needs no second-guessing, but anything below frontier on
 * a hand-curated score has room to graduate.
 *
 * Distinct from `tier-down`: this fires on judgment vs. ANY alt (judgment
 * or measured); `tier-down` requires the alt to be measured AND >=2x cheaper.
 *
 * Quality-floor (feedback_quality_as_floor): the alternative's score must
 * be >= QUALITY_FLOOR_FOR_RECOMMENDATION. We never recommend a swap that
 * could drop quality below the floor, regardless of cost savings.
 */
function detectCostMismatchedArchetype(
  ir: PromptIR,
  profile: ModelProfile,
  phase2?: RunAdvisorPhase2Context,
): BestPracticeAdvisory[] {
  if (!phase2 || phase2.fallbackChain.length === 0) return [];
  if (!phase2.profileResolver) return [];

  const archetype = ir.intent.archetype;
  const chosenScore = getArchetypePerfScore(profile.id, archetype, ir.appId, phase2?.route);

  // alpha.110 — kgauto's own chain for this archetype (brain-aware when warm, bundled
  // starter when cold). Used below to keep the advisor from arguing with the chain head
  // over a judgment tie under the blended cost function.
  const ownChain: string[] = (() => {
    const out: string[] = [];
    try { out.push(...getDefaultFallbackChain({ archetype })); } catch { /* cold / unknown archetype */ }
    try { out.push(...getStarterChain(archetype)); } catch { /* unknown archetype */ }
    return out;
  })();
  const ownChainHead = ownChain.length > 0 && (
    (() => { try { return getDefaultFallbackChain({ archetype })[0] === profile.id; } catch { return false; } })() ||
    (() => { try { return getStarterChain(archetype)[0] === profile.id; } catch { return false; } })()
  );

  // Trigger gate: chosen is judgment-grounded OR has room to grow (< 7).
  const chosenHasRoomToGrow =
    chosenScore.grounding === 'judgment' ||
    chosenScore.score < COST_MISMATCHED_CHOSEN_SCORE_CEILING;
  if (!chosenHasRoomToGrow) return [];

  // Scan the chain for a cheaper alternative whose score is not below the
  // chosen one's and that ALSO clears the quality floor.
  let bestAlt: {
    id: string;
    profile: ModelProfile;
    score: ReturnType<typeof getArchetypePerfScore>;
  } | null = null;

  for (const altId of phase2.fallbackChain) {
    const altProfile = phase2.profileResolver(altId);
    if (!altProfile) continue;
    if (altProfile.id === profile.id) continue;

    const altScore = getArchetypePerfScore(altProfile.id, archetype, ir.appId, phase2?.route);

    // Quality floor — never recommend below the floor.
    if (altScore.score < QUALITY_FLOOR_FOR_RECOMMENDATION) continue;
    // A score not below the chosen one's is required.
    if (altScore.score < chosenScore.score) continue;
    // alpha.110 — the chain is kgauto's own opinion. When the consumer handed us our own
    // chain for this archetype and the pick IS its head, an alternative that sits later
    // in that same chain at EQUAL judgment score is not a cost mismatch — the chain's
    // tier order already decided that tie, and pricing it blended (output included) must
    // not make kgauto argue with itself on the consumer's Glass-Box (the alpha.106 "one
    // opinion" rule, kept under the new cost function). A strictly better-scored or a
    // MEASURED alternative still fires: that is new information, not a re-litigated tie.
    if (
      ownChainHead &&
      altScore.grounding !== 'measured' &&
      altScore.score === chosenScore.score &&
      ownChain.includes(altProfile.id)
    ) continue;
    // Strictly cheaper required.
    if (blendedAt(ir, phase2, altProfile) >= blendedAt(ir, phase2, profile)) continue;

    // alpha.82 — one shared predicate for every recommending rule. See
    // `suppressedRecommendationReason`; a per-rule copy is exactly how
    // `tier-down` shipped without these for four days.
    if (suppressedRecommendationReason(ir, archetype, altProfile)) continue;

    // Pick the alternative with the highest score (best quality among the
    // cheaper options). Tie-break on cheaper.
    if (
      !bestAlt ||
      altScore.score > bestAlt.score.score ||
      (altScore.score === bestAlt.score.score &&
        blendedAt(ir, phase2, altProfile) < blendedAt(ir, phase2, bestAlt.profile))
    ) {
      bestAlt = { id: altId, profile: altProfile, score: altScore };
    }
  }

  if (!bestAlt) return [];

  // Skip emission if the alternative would be more accurately surfaced by
  // `tier-down` — that rule fires when alt is measured AND meaningfully
  // cheaper. Avoids double-emission for the strongest signal.
  const tierDownWouldFire =
    bestAlt.score.grounding === 'measured' &&
    blendedAt(ir, phase2, bestAlt.profile) <=
      blendedAt(ir, phase2, profile) * TIER_DOWN_COST_RATIO;
  if (tierDownWouldFire) return [];

  const chosenGrounding =
    chosenScore.grounding === 'judgment'
      ? `archetypePerf.${archetype}=judgment`
      : `archetypePerf.${archetype}=${chosenScore.score}`;
  const altGrounding =
    bestAlt.score.grounding === 'measured'
      ? `archetypePerf.${archetype}=${bestAlt.score.score}, measured, n=${bestAlt.score.n}`
      : `archetypePerf.${archetype}=${bestAlt.score.score}, judgment`;

  return [
    {
      level: 'warn',
      code: 'cost-mismatched-archetype',
      message: `Cost-mismatched-archetype: target=${profile.id} (${chosenGrounding}) selected for ${archetype}. Alternative ${bestAlt.id} (${altGrounding}) is cheaper ($${blendedAt(ir, phase2, bestAlt.profile).toFixed(4)} vs $${blendedAt(ir, phase2, profile).toFixed(4)} at this call's blended shape; ${pricePer1mAt(phase2, bestAlt.profile)} vs ${pricePer1mAt(phase2, profile)} per 1M), at a score not below the target's (archetypePerf.${archetype}: ${perfPhrase(bestAlt.id, bestAlt.score)}; ${perfPhrase(profile.id, chosenScore)}).${rulerClause(bestAlt.id, bestAlt.score, profile.id)}`,
      // alpha.80 (tt-intel's `chain-builder-and-cost-advisories-give-opposite-answers`):
      // this field used to offer `posture='open'` unconditionally, alongside
      // the cheap-model swap, as if the two were equivalent remedies. They
      // point in opposite directions. Both branches are now computed from
      // the chain builder rather than assumed.
      suggestion:
        `Consider declaring \`${bestAlt.id}\` as the primary model for this archetype.` +
        (openPostureRemedyClause(archetype, bestAlt.profile, phase2.profileResolver) ??
          openPostureCostWarningClause(archetype, bestAlt.profile, phase2.profileResolver)) +
        ` If the chosen model is required for compliance/brand reasons, set \`policy.posture = 'locked'\` to silence this rule.`,
      recommendationType:
        profile.provider === bestAlt.profile.provider ? 'tier-down' : 'model-swap',
      recommendedModels: [bestAlt.id],
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 7 — model-stale-evidence  (alpha.22 Phase 2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: the chosen model's archetype perf is `judgment`-grounded
 * AND brain-query mode is active for the `kgauto_archetype_perf` table.
 *
 * Why: if the consumer has wired brain-query (so measurements WOULD
 * accumulate) but the chosen (model, archetype) tuple still resolves to a
 * judgment-only score, it means either (a) the consumer's traffic hasn't
 * reached the n>=10 floor for this tuple yet, or (b) the brain isn't
 * actually persisting outcomes from this consumer. Either way, surfaces
 * the gap so the consumer can verify their brain wiring.
 *
 * Informational-only. Doesn't propose a swap. recommendationType:
 * 'prompt-fix' (the fix is consumer-side — verify brain query + outcome
 * persistence, or wait for evidence to accumulate).
 *
 * Stays silent when:
 *   - brain-query is OFF (consumer hasn't opted in; no measurement gap
 *     to surface — nothing to graduate to)
 *   - the chosen model's score is already 'measured' (n>=10)
 */
function detectModelStaleEvidence(
  ir: PromptIR,
  profile: ModelProfile,
): BestPracticeAdvisory[] {
  // Brain-query for archetype_perf must be active — otherwise there's no
  // measurement substrate to call stale.
  if (!isBrainQueryActiveFor('kgauto_archetype_perf')) return [];

  const archetype = ir.intent.archetype;
  const chosen = getArchetypePerfScore(profile.id, archetype, ir.appId);

  if (chosen.grounding !== 'judgment') return [];

  return [
    {
      level: 'info',
      code: 'model-stale-evidence',
      message: `Model-stale-evidence: target=${profile.id} archetype=${archetype} is judgment-grounded (n=${chosen.n}, cross-app 90d window) despite brain-query mode being active. Fewer than 10 outcomes back this (model, archetype) tuple across ALL consumers — routing decisions remain pre-measured for this slot.`,
      suggestion:
        'Verify that `record()` is being called on every call() outcome. Counts are cross-app (migration 050 view): once ANY consumers accumulate n>=10 rows on this tuple, the score promotes from judgment to measured automatically within the 5-min SWR window. (Before alpha.78 this promotion was advertised but had no implementing mechanism — n was never populated; if this advisory has been firing for weeks at n=0 despite real traffic, bump to >=alpha.78 and it will clear on its own.)',
      recommendationType: 'prompt-fix',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 8 — tier-down  (alpha.22 Phase 2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: brain shows a same-or-better quality outcome on a cheaper
 * model tier for the same (archetype, shape). Specifically:
 *   - chain alternative has `archetypePerf[archetype].grounding === 'measured'`
 *     with n >= 10
 *   - alt score >= chosen score AND alt score >= QUALITY_FLOOR_FOR_RECOMMENDATION
 *   - alt cost <= TIER_DOWN_COST_RATIO * chosen cost (meaningful savings)
 *
 * Distinct from `cost-mismatched-archetype`: that rule fires on judgment
 * placements; this one fires when there's actual DATA showing the swap is
 * safe. The cost-delta floor (50%) keeps it from firing on marginal price
 * differences.
 *
 * Quality-floor (feedback_quality_as_floor) is enforced both ways: the
 * alternative must clear QUALITY_FLOOR_FOR_RECOMMENDATION AND be at-least
 * the chosen score. Cheaper-and-worse is never recommended.
 *
 * Names the brain row count (`n`) in the message so consumers can see HOW
 * MUCH measurement backs the recommendation.
 */
function detectTierDown(
  ir: PromptIR,
  profile: ModelProfile,
  phase2?: RunAdvisorPhase2Context,
): BestPracticeAdvisory[] {
  if (!phase2 || phase2.fallbackChain.length === 0) return [];
  if (!phase2.profileResolver) return [];

  const archetype = ir.intent.archetype;
  const chosenScore = getArchetypePerfScore(profile.id, archetype, ir.appId, phase2?.route);
  const chosenCost = blendedAt(ir, phase2, profile);

  // Pick the cheapest measured alternative whose score clears both the
  // quality floor and the chosen score.
  let bestAlt: {
    id: string;
    profile: ModelProfile;
    score: ReturnType<typeof getArchetypePerfScore>;
  } | null = null;

  for (const altId of phase2.fallbackChain) {
    const altProfile = phase2.profileResolver(altId);
    if (!altProfile) continue;
    if (altProfile.id === profile.id) continue;

    const altScore = getArchetypePerfScore(altProfile.id, archetype, ir.appId, phase2?.route);

    // Must be measured backing (the whole point of this rule).
    if (altScore.grounding !== 'measured') continue;
    // Quality floor.
    if (altScore.score < QUALITY_FLOOR_FOR_RECOMMENDATION) continue;
    // A score not below the chosen one's (the numbers only — the sentence says what each was measured against).
    if (altScore.score < chosenScore.score) continue;
    // Cost-delta floor — alt must be meaningfully cheaper (>= 2x).
    if (blendedAt(ir, phase2, altProfile) > chosenCost * TIER_DOWN_COST_RATIO) continue;

    // alpha.82 (PB s85): tier-down never consulted the alpha.78 guards. It
    // recommended a model the promotion guard had rolled back on this exact
    // surface five days earlier — "this is data, not opinion", about a
    // decision the guard already made on measured data. `tier-down` is the
    // rule with the STRONGEST wording in the whole advisor, which makes an
    // unguarded recommendation from it the most likely to be acted on.
    if (suppressedRecommendationReason(ir, archetype, altProfile)) continue;

    // Prefer cheapest among qualifying alternatives. Tie-break on higher score.
    if (
      !bestAlt ||
      blendedAt(ir, phase2, altProfile) < blendedAt(ir, phase2, bestAlt.profile) ||
      (blendedAt(ir, phase2, altProfile) === blendedAt(ir, phase2, bestAlt.profile) &&
        altScore.score > bestAlt.score.score)
    ) {
      bestAlt = { id: altId, profile: altProfile, score: altScore };
    }
  }

  if (!bestAlt) return [];

  return [
    {
      level: 'warn',
      code: 'tier-down',
      // alpha.128 — each score is printed with its grounding; the sentence no longer
      // claims a quality relation the two numbers were never measured to support.
      message: `Tier-down: target=${profile.id} selected for ${archetype}. archetypePerf.${archetype}: ${perfPhrase(bestAlt.id, bestAlt.score)}; ${perfPhrase(profile.id, chosenScore)}.${rulerClause(bestAlt.id, bestAlt.score, profile.id)} ${bestAlt.id} is at ${pricePer1mAt(phase2, bestAlt.profile)} per 1M vs ${pricePer1mAt(phase2, profile)} at this call's input — a tier-down opportunity on a measured score.${effectivePriceClause(ir.appId, archetype, bestAlt, profile)}`,
      suggestion: `Move \`${bestAlt.id}\` to primary for this archetype. The brain has n=${bestAlt.score.n} measured outcomes backing the recommendation; this is data, not opinion. If posture='locked' is required (compliance/brand promise), set it explicitly to silence this rule.`,
      recommendationType: 'tier-down',
      recommendedModels: [bestAlt.id],
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 9 — archetype-perf-floor-breach  (alpha.28)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when the chosen model's archetypePerf for the requested archetype
 * sits below the floor (`ARCHETYPE_FLOOR_DEFAULT = 6`) AND the consumer
 * hasn't supplied an adapter that would lift it.
 *
 * Two emission modes:
 *   - `requires-adapter` (a known adapter exists, consumer didn't pass it)
 *     → `warn` advisory with `suggestedAdaptation` field populated. The
 *     consumer can apply the adapter at the next call site and the model
 *     becomes viable.
 *   - `reject` (no adapter would help)
 *     → `critical` advisory. No `suggestedAdaptation` — there is no known
 *     structural fix; the consumer should swap models.
 *
 * Why this rule exists: the V4-Pro/hunt incident (2026-05-21). The cliff
 * data was there in profiles.ts (`archetypePerf.hunt = 4` for V4-Pro). The
 * compiler stayed silent because no rule was checking the chosen model
 * against its own archetype perf score. This rule closes that gap — the
 * substrate now TELLS the consumer when it knows the chosen model is below
 * the structural floor for the requested intent.
 *
 * Driven by `getModelCompatibility()` so the data shape is the single
 * source of truth for both the picker-UX API and the compile-time advisor.
 * Same function, same answer.
 *
 * Runs regardless of posture. The cliff is a capability-fact (not a
 * recommendation about a cheaper alternative); even posture='locked'
 * consumers want to see "the model you locked to is structurally wrong
 * for this archetype." That said: warn-level for `requires-adapter`
 * (the model can be made to work) and critical-level for `reject` (no
 * known fix at the kgauto layer).
 *
 * Pairs with the picker-UX consumer pattern documented in the consultation
 * doc: tt-intel queries `getModelCompatibility()` at picker render time
 * to grey out incompatible models; this advisor surfaces the same fact at
 * compile() time so production calls that slipped past the picker still
 * get the warning in `result.advisories[]`.
 */
function detectArchetypePerfFloorBreach(
  ir: PromptIR,
  profile: ModelProfile,
): BestPracticeAdvisory[] {
  const compat = getModelCompatibility(profile.id, {
    archetype: ir.intent.archetype,
    toolOrchestration: ir.constraints?.toolOrchestration,
  });

  if (compat.status === 'compatible') return [];

  if (compat.status === 'requires-adapter') {
    return [
      {
        level: 'warn',
        code: 'archetype-perf-floor-breach',
        message: `${profile.id} sits below the archetype floor for ${ir.intent.archetype} (score ${compat.archetypePerf}/10, floor ${6}). A known adapter would lift it: ${compat.adapter.parameter}=${compat.adapter.value}. ${compat.adapter.consequence}`,
        suggestion: `Pass \`ir.constraints.${compat.adapter.parameter} = '${compat.adapter.value}'\` for this call, OR pick a model whose archetypePerf for ${ir.intent.archetype} already clears the floor (call \`getModelCompatibility(modelId, { archetype: '${ir.intent.archetype}' })\` to check). Estimated post-adapter score: ${compat.archetypePerfWithAdapter}/10.`,
        recommendationType: 'prompt-fix',
        suggestedAdaptation: compat.adapter,
        docsUrl:
          'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
      },
    ];
  }

  // status === 'reject'
  return [
    {
      level: 'critical',
      code: 'archetype-perf-floor-breach',
      message: `${profile.id} sits below the archetype floor for ${ir.intent.archetype} (score ${compat.archetypePerf}/10, floor ${6}) and no known adapter would lift it. ${compat.reason}`,
      // alpha.80: this rule's advice is correct on the QUALITY axis and was
      // silent on cost, so a consumer reading it as a general "let the
      // library pick" endorsement could land on a materially pricier
      // primary. The floor recommendation stands; the axis is now named,
      // and the cost-ordered variant is offered alongside it.
      //
      // alpha.82 (cc-Cairn 2026-07-29, follow-on 1): the suggestion read as
      // advice about the ARCHETYPE when it is a fact about ONE CALL. Model
      // selection is input-size dependent, so a rule that fires on the
      // small-payload tail of a path whose typical case clears the floor
      // reads as "your primary is wrong" when the accurate statement is
      // "this call landed here." Ground truth for the wording: tt-intel's
      // open critical is `gemini-2.5-flash-lite` (ask, 5/10) selected at
      // ~2.1K tokens_in, while `claude-opus-5` served the same archetype at
      // ~22K the same day — cc read the evidence set as self-contradictory
      // precisely because the text did not say which call it described.
      suggestion: `This fired for \`${profile.id}\`, the model selected for THIS call — selection is input-size dependent, so other calls on \`${ir.intent.archetype}\` may pick a different model that clears the floor. Swap to a model whose archetypePerf for ${ir.intent.archetype} clears the floor. Use \`getModelCompatibility(candidateId, { archetype: '${ir.intent.archetype}' })\` to vet candidates, or \`getDefaultFallbackChain({ archetype: '${ir.intent.archetype}', posture: 'open' })\` for a library-picked chain that respects the floor by construction — note that chain is ordered by archetype performance, NOT cost, so it may select a pricier primary than you run today. Add \`optimizeFor: 'cost'\` for a chain that clears the same floor cheapest-first. To stop this model being selected at all, pass \`policy.blockedModels: ['${profile.id}']\`.`,
      recommendationType: 'model-swap',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Rule 10 — stale-exclusion-candidate  (alpha.38)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fires when: the per-tenant exclusion-findings cache has one or more
 * `recommend-probe` findings for the current `(app_id, archetype)` tuple.
 *
 * Why: every consumer-side exclusion (`policy.blockedModels`, chains that
 * never include a model, archetype-specific gating) produces zero brain
 * rows for `(consumer, archetype, excluded-model)`. The measured-routing
 * engine never sees evidence the model is worse OR better, so the exclusion
 * freezes into a permanent decision based on whatever evidence existed at
 * exclusion time. The alpha.37 `kgauto-exclusion-re-evaluation-watch` cron
 * surfaces these in `exclusion_findings`; this rule reads them at compile()
 * time so consumers see the recommendation in `result.advisories[]` without
 * having to inspect the operator-side coordination digest.
 *
 * Picks the top finding by `estimatedSavingsUsd30d` desc; mentions count
 * when more than one finding exists for the archetype. Silent when:
 *   - the findings-brain runtime isn't active (consumer opted out via
 *     `brainQuery.findingsExclusions = false`)
 *   - no findings exist for the (appId, archetype) tuple
 *   - posture='locked' (handled by the caller — see `runAdvisor`)
 *
 * Level: `info`. The advisory is a recommendation to investigate, not a
 * "fix this now" warn. The probe verdict is what graduates a recommendation
 * to actionable; alpha.37 ships `recommend-probe` only.
 *
 * Skips when the chosen model IS the excluded one (impossible by
 * construction — excluded means zero traffic — but defensive).
 */
function detectStaleExclusionCandidate(
  ir: PromptIR,
): BestPracticeAdvisory[] {
  if (!isExclusionFindingsBrainActive()) return [];
  if (!ir.appId) return [];

  const findings = getStaleExclusionFindings({
    appId: ir.appId,
    archetype: ir.intent.archetype,
  });
  if (findings.length === 0) return [];

  // Pick top-1 by savings desc; null savings sort last. Tie-break on
  // confidence (high > medium > low) so the strongest signal wins.
  const ranked = [...findings].sort((a, b) => {
    const sa = a.estimatedSavingsUsd30d ?? -Infinity;
    const sb = b.estimatedSavingsUsd30d ?? -Infinity;
    if (sa !== sb) return sb - sa;
    return confidenceRank(b.confidence) - confidenceRank(a.confidence);
  });
  const top = ranked[0]!;

  const extraCount = findings.length - 1;
  const extraNote =
    extraCount > 0
      ? ` (+ ${extraCount} more excluded model${extraCount === 1 ? '' : 's'} for this archetype)`
      : '';

  return [
    {
      level: 'info',
      code: 'stale-exclusion-candidate',
      message: `${top.message}${extraNote}`,
      suggestion: top.suggestion,
      recommendationType: 'tier-down',
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

function confidenceRank(c: 'high' | 'medium' | 'low'): number {
  if (c === 'high') return 3;
  if (c === 'medium') return 2;
  return 1;
}
