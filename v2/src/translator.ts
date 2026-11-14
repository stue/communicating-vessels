/**
 * Translator primitive — alpha.31.
 *
 * Pure function. Walks `IR.sections`, matches each section's `kind` against
 * a per-rule dispatch table keyed on (kind, profile, archetype), and applies
 * a model-aware rewrite when a rule fires. Returns the rewritten IR + the
 * list of rewrites for `CompileResult.sectionRewritesApplied` and brain
 * persistence.
 *
 * This is the s37 translator-framing eureka in code: kgauto graduates from
 * "gate" (alpha.28's cliff advisor: "consumer must accept adapter") to
 * "translator" (alpha.29: "consumer declared the section kind, kgauto
 * applies the adapter at compile time without consumer-side branching").
 *
 * Rules shipped:
 *
 *   alpha.29 — tool_call_contract + archetypePerf[archetype] < TRANSLATOR_FLOOR
 *     → prepend sequential-tool-pattern guidance
 *     → emit wireOverrides: { parallelToolCalls: false }
 *     → rule_id: 'sequential-tool-cliff-below-floor'
 *
 *   alpha.31 — narration_contract + profile.provider === 'anthropic'
 *     → prepend terse-log narration guidance
 *     → no wireOverrides
 *     → rule_id: 'narration-drift-anthropic'
 *
 *   alpha.31 — narration_contract + profile.provider === 'deepseek'
 *     → prepend <thinking>-suppression guidance
 *     → no wireOverrides
 *     → rule_id: 'narration-thinking-leak-deepseek'
 *
 * Per-rule walk (alpha.31 refactor): the alpha.30 short-circuit
 * `if (!cliffFires) return passthrough` was correct when only the
 * cliff-gated tool_call_contract rule existed; alpha.31's narration rules
 * fire on every call regardless of cliff (narration drift is steady-state,
 * not a cliff condition). Each section now consults the dispatch table
 * independently — first-match wins per (section.kind, profile, archetype).
 *
 * **Interaction with the cliff advisor (alpha.28):** when this translator
 * fires for a `tool_call_contract` section, the advisor's
 * `archetype-perf-floor-breach` rule MUST suppress for the same call — the
 * cliff was structurally cleared by the rewrite, not unaddressed. The
 * suppression check lives in `advisor.ts` and consults the
 * `CompileResult.sectionRewritesApplied` list.
 *
 * Design contracts:
 *   command-center/advisory/kgauto/2026-05-21_alpha-29-translator-and-advisories-api.md
 *   command-center/advisory/kgauto/2026-05-22_alpha-31-narration-contract.md
 */

import { ARCHETYPE_FLOOR_DEFAULT } from './compatibility.js';
import { resolveOutputMode, type IntentArchetypeName, type OutputMode } from './dialect.js';
import type { PromptIR, SectionKind, SectionRewrite } from './ir.js';
import type { ModelProfile } from './profiles.js';

/**
 * Re-export of `ARCHETYPE_FLOOR_DEFAULT` as the canonical "translator fires
 * below this score" threshold. Same constant as the cliff advisor — the
 * single threshold is shared (alpha.28's "below this, advisor warns"; alpha.29's
 * "below this, translator AUTO-APPLIES the adapter").
 */
export const TRANSLATOR_FLOOR = ARCHETYPE_FLOOR_DEFAULT;

/**
 * Stable identifier of the alpha.29 sequential-tool rule. Surfaces on
 * `SectionRewrite.rule` and in brain aggregates. The brain treats this
 * identifier together with the preamble string as the rule's wire
 * fingerprint — both stay byte-stable across releases.
 */
export const RULE_SEQUENTIAL_TOOL_CLIFF = 'sequential-tool-cliff-below-floor';

/**
 * alpha.31 — stable identifier of the Anthropic narration-drift rule. Fires
 * on `narration_contract` sections when the active profile is Anthropic.
 * tt-intel's empirical observation: Claude Sonnet drifts into stream-of-
 * consciousness on hunt/generate archetypes; the prepend tells it to stay
 * terse.
 */
export const RULE_NARRATION_DRIFT_ANTHROPIC = 'narration-drift-anthropic';

/**
 * alpha.31 — stable identifier of the DeepSeek <thinking>-leak rule. Fires
 * on `narration_contract` sections when the active profile is DeepSeek.
 * V4-family models leak `<thinking>` content as user-facing output unless
 * explicitly suppressed.
 */
export const RULE_NARRATION_THINKING_LEAK_DEEPSEEK =
  'narration-thinking-leak-deepseek';

/**
 * Prepended guidance when the sequential-tool-cliff rule fires. Kept literal
 * for byte-stability — the brain treats this string as the rule's wire
 * fingerprint, not just `rule = sequential-tool-cliff-below-floor`.
 *
 * Three short sentences chosen to bind a `tool_call_contract` block without
 * crowding the consumer's content. The trailing newlines separate it from
 * whatever section text follows.
 */
const SEQUENTIAL_TOOL_PREAMBLE =
  'IMPORTANT: Use one tool call per response. Wait for the tool result before deciding the next tool. Do NOT batch tool calls in parallel.';

/**
 * alpha.31 — narration tightening guidance for Anthropic models. The brand-
 * defining "translator owns the dialect" framing: consumer declares
 * `kind: 'narration_contract'`; kgauto auto-prepends this when the active
 * model belongs to a family that empirically drifts into stream-of-
 * consciousness narration.
 */
const NARRATION_DRIFT_ANTHROPIC_PREAMBLE =
  'Output ONLY the requested content. Do not narrate your thought process. Each line ≤ 12 words.';

/**
 * alpha.31 — <thinking>-leak suppression guidance for DeepSeek V4-family
 * models. Critical for V4-Pro's 2026-05-31 promo viability: without
 * suppression, V4-Pro leaks internal monologue as user-facing text.
 */
const NARRATION_THINKING_LEAK_DEEPSEEK_PREAMBLE =
  'Reasoning is internal. Output ONLY the requested content; do not emit <thinking> blocks or internal monologue as user-facing text.';

/**
 * alpha.68 / Release A — stable identifier of the discipline-gates rule.
 * Fires on `discipline_contract` sections that pass the two-factor eligibility
 * screen (Factor A archetype + Factor C output-shape). Surfaces on
 * `SectionRewrite.rule` and in brain aggregates.
 *
 * Versioned (`v1`) deliberately: Factor B evidence (Release B) is only valid
 * against the EXACT bytes that produced it, so a silent gate edit would
 * invalidate every standing verdict. A real gate change bumps this to `v2` and
 * resets Factor B to unmeasured for every tuple.
 */
export const RULE_DISCIPLINE_GATES_V1 = 'discipline-gates-v1';

/**
 * FROZEN — the byte string is the rule's wire fingerprint (exactly as
 * `SEQUENTIAL_TOOL_PREAMBLE` is). A silent edit invalidates every standing
 * Factor-B verdict; a real change bumps the version to `v2`. Six gates ported
 * from `scheduled-tasks/_opus-runner-preamble.md` (design contract §5.D).
 *
 * `WITH_TOOLS` variant: gate 3 (expand-don't-guess) present — used when the IR
 * carries tools.
 */
const DISCIPLINE_GATES_V1_WITH_TOOLS =
  `Work through these gates at every judgment point, explicitly:
1. Evidence before reasoning: cite what you observed before concluding from it.
2. One extra signal: when a finding feels conclusive, check one more adjacent signal before stating it.
3. Expand, don't guess: resolve a compressed or referenced item by looking it up rather than inferring its contents.
4. Innocent explanation first: state the most plausible benign reading before alleging the alarming one.
5. Label each claim: mark it observed, inferred, or assumed.
6. A surfaced gap beats a guessed answer: flag what you cannot determine rather than fabricating past it.`;

/**
 * FROZEN — see `DISCIPLINE_GATES_V1_WITH_TOOLS`. `NO_TOOLS` variant: gate 3
 * (expand-don't-guess) dropped + gates renumbered — per §5.D, without tools it
 * collapses into gate 6. Used when the IR carries no tools.
 */
const DISCIPLINE_GATES_V1_NO_TOOLS =
  `Work through these gates at every judgment point, explicitly:
1. Evidence before reasoning: cite what you observed before concluding from it.
2. One extra signal: when a finding feels conclusive, check one more adjacent signal before stating it.
3. Innocent explanation first: state the most plausible benign reading before alleging the alarming one.
4. Label each claim: mark it observed, inferred, or assumed.
5. A surfaced gap beats a guessed answer: flag what you cannot determine rather than fabricating past it.`;

/**
 * Release B — stable identifier of the STRUCTURED-SAFE discipline-gates
 * variant (design contract §5.D second clause, discharged via §4.0's merge:
 * "the judge must run gates 1–4 only — which IS Path 1's structured-safe
 * variant, arrived at as a subset-drop of frozen bytes rather than new
 * prose"). Fires where the full block is Factor-C-forbidden: `json` and
 * `tool_call` surfaces, where gates 5+6 are shape-altering and would
 * manufacture the structured-output violations alpha.66 retries.
 *
 * Versioned with the SAME v1 stamp as its parent: its bytes are a strict
 * subset of `discipline-gates-v1`'s, so a v1 wording change is a variant
 * wording change by construction, and both bump together.
 */
export const RULE_DISCIPLINE_GATES_V1_STRUCTURED =
  'discipline-gates-v1-structured';

/**
 * FROZEN — strict subset of `DISCIPLINE_GATES_V1_WITH_TOOLS`: gates 1–4
 * verbatim, shape-altering gates 5 (label each claim) + 6 (surfaced gap)
 * dropped. No new prose — the s74 design guard permits a subset-drop where
 * it forbids authoring fresh wording on n=0 judgment. Gates 1–4 shape
 * REASONING only, so this block is safe on a structured surface by
 * construction; no output-envelope exemption sentence is needed (writing
 * one would be new prose).
 */
const DISCIPLINE_GATES_V1_STRUCTURED_WITH_TOOLS =
  `Work through these gates at every judgment point, explicitly:
1. Evidence before reasoning: cite what you observed before concluding from it.
2. One extra signal: when a finding feels conclusive, check one more adjacent signal before stating it.
3. Expand, don't guess: resolve a compressed or referenced item by looking it up rather than inferring its contents.
4. Innocent explanation first: state the most plausible benign reading before alleging the alarming one.`;

/**
 * FROZEN — see `DISCIPLINE_GATES_V1_STRUCTURED_WITH_TOOLS`. NO_TOOLS
 * variant: gate 3 (expand-don't-guess) dropped + renumbered, mirroring the
 * full block's NO_TOOLS treatment.
 */
const DISCIPLINE_GATES_V1_STRUCTURED_NO_TOOLS =
  `Work through these gates at every judgment point, explicitly:
1. Evidence before reasoning: cite what you observed before concluding from it.
2. One extra signal: when a finding feels conclusive, check one more adjacent signal before stating it.
3. Innocent explanation first: state the most plausible benign reading before alleging the alarming one.`;

/**
 * Factor A — eligibility (design contract §4): archetypes that exercise
 * judgment without scaffolding, so the discipline gate fires on declaration.
 * Model-independent, largely static. The fire set IS exactly this set:
 * `classify`/`extract`/`transform` are not eligible (declaration is a no-op);
 * `ask`/`generate` are off-by-default in v1 (also a no-op). This is the L-095
 * scope guard — it stops us paying the token tax on a mechanical `classify`.
 */
export const DISCIPLINE_ELIGIBLE_ARCHETYPES = new Set<IntentArchetypeName>([
  'hunt',
  'summarize',
  'plan',
  'critique',
  'judge',
]);

export interface ApplySectionRewritesArgs {
  ir: PromptIR;
  profile: ModelProfile;
  archetype: IntentArchetypeName;
  /**
   * alpha.68 / Release A — resolved output shape for Factor C (§5.D). `'json'`
   * ⇒ structured surface (the discipline gate MUST NOT fire — gates 5+6 are
   * shape-altering and would break the consumer's parser). `'text'` ⇒ free-form
   * surface (the gate may fire). Optional: when omitted, derived from
   * `ir.constraints?.structuredOutput` (true ⇒ 'json', else 'text') so callers
   * / tests need not pass it. compile() passes it explicitly.
   */
  outputMode?: OutputMode;
}

export interface ApplySectionRewritesResult {
  /**
   * IR with section.text fields possibly rewritten. When no rewrites fired,
   * this is identical to the input IR (referentially distinct array but
   * same section payloads).
   */
  rewrittenIR: PromptIR;
  /**
   * One entry per section the translator rewrote. Empty array when no
   * rules fired. Order matches the corresponding section in
   * `rewrittenIR.sections`.
   */
  rewrites: SectionRewrite[];
}

/**
 * Internal shape: the resolved rule for a (section.kind, profile, archetype)
 * tuple. Returned by `matchRule()`; consumed by the per-section walk.
 */
interface ResolvedRule {
  id: string;
  preamble: string;
  wireOverrides?: { parallelToolCalls?: boolean };
}

/**
 * Per-rule dispatch. Returns the ResolvedRule for a (section.kind, profile,
 * archetype) tuple, or `null` when no rule applies.
 *
 * Dispatch table — CLOSED:
 *   - `discipline_contract` + archetype ∈ {hunt,summarize,plan,critique,judge}
 *                                        + outputMode === 'text' → discipline-gates-v1
 *   - `tool_call_contract` + archetypePerf below floor → sequential-tool
 *   - `narration_contract` + provider === 'anthropic'  → narration-drift
 *   - `narration_contract` + provider === 'deepseek'   → thinking-leak
 *   - `narration_contract` + provider ∈ {google, openai, mistral, xai} → null (pass-through)
 *   - all other kinds (`role_intro`, `user_turn`, `reference`, `arbitrary`) → null
 *
 * The dispatch is provider-level (not model.id-level) by design — same
 * narration drift applies to every Anthropic model (Opus / Sonnet / Haiku);
 * same <thinking> leak applies to every DeepSeek V4-family model. alpha.32+
 * may refine per-model.id once brain data shows model-level divergence.
 *
 * alpha.68 / Release A adds the `discipline_contract` rule — model-independent
 * (fires on archetype + output-shape, not provider). See the branch below.
 */
function matchRule(
  kind: SectionKind,
  profile: ModelProfile,
  archetype: IntentArchetypeName,
  ctx: { outputMode: OutputMode; hasTools: boolean },
): ResolvedRule | null {
  if (kind === 'discipline_contract') {
    // alpha.68 / Release A — surface-scaffolding gate block (§5.D). Fires when
    // BOTH screens pass:
    //   Factor A (archetype eligibility): hunt/summarize/plan/critique/judge.
    //   Factor C (output-shape hard screen): text only. On a json/tool_call
    //     surface the gate MUST NOT fire — gates 5+6 are shape-altering and
    //     would manufacture exactly the structured-output contract violations
    //     alpha.66 ships a retry for. This is a HARD screen ANDed with Factor
    //     A, not a Factor B (measured-lift) question: the failure is a broken
    //     contract, not a weak lift, so no measured quality justifies it.
    // Factor B (measured per-tuple disable) does not exist yet — Release B; in
    // Release A the gate always fires when A+C pass.
    if (!DISCIPLINE_ELIGIBLE_ARCHETYPES.has(archetype)) return null;
    // Release B — Factor C becomes a VARIANT SELECTOR, not only a screen
    // (§5.D second clause). On `text` the full six-gate block fires; on
    // `json`/`tool_call` the structured-safe subset (gates 1–4, reasoning-
    // scoped only) fires instead of nothing. The consumer's declared
    // `discipline_contract` section is the opt-in either way — Release A
    // dropped it on structured surfaces only because the full block was
    // unsafe there, not because the consumer didn't ask.
    // Gate 3 (expand-don't-guess) is tool-conditional (§5.D): present only when
    // the IR carries tools, else it collapses into gate 6 and the NO_TOOLS
    // variant renumbers around it. `hasTools` is computed with the `?? 0` guard
    // in applySectionRewrites — `ir.tools` is OPTIONAL.
    if (ctx.outputMode !== 'text') {
      return {
        id: RULE_DISCIPLINE_GATES_V1_STRUCTURED,
        preamble: ctx.hasTools
          ? DISCIPLINE_GATES_V1_STRUCTURED_WITH_TOOLS
          : DISCIPLINE_GATES_V1_STRUCTURED_NO_TOOLS,
      };
    }
    return {
      id: RULE_DISCIPLINE_GATES_V1,
      preamble: ctx.hasTools
        ? DISCIPLINE_GATES_V1_WITH_TOOLS
        : DISCIPLINE_GATES_V1_NO_TOOLS,
    };
  }

  if (kind === 'tool_call_contract') {
    // alpha.29 cliff-gated rule — only fires when the active archetype is
    // below the translator floor. Defensive: profiles missing
    // `archetypePerf` are treated as un-classified (no rewrite). Real
    // profiles all carry the table; this guards tests + future shape
    // evolution.
    if (!profile.archetypePerf) return null;
    const archetypeScore = profile.archetypePerf[archetype];
    if (typeof archetypeScore !== 'number' || archetypeScore >= TRANSLATOR_FLOOR) {
      return null;
    }
    return {
      id: RULE_SEQUENTIAL_TOOL_CLIFF,
      preamble: SEQUENTIAL_TOOL_PREAMBLE,
      wireOverrides: { parallelToolCalls: false },
    };
  }

  if (kind === 'narration_contract') {
    // alpha.31 — provider-level dispatch. Closed set; unknown providers
    // (mistral, xai, future) pass through. Narration rewrites don't read
    // archetypePerf — narration drift is steady-state, not a cliff
    // condition.
    if (profile.provider === 'anthropic') {
      return {
        id: RULE_NARRATION_DRIFT_ANTHROPIC,
        preamble: NARRATION_DRIFT_ANTHROPIC_PREAMBLE,
      };
    }
    if (profile.provider === 'deepseek') {
      return {
        id: RULE_NARRATION_THINKING_LEAK_DEEPSEEK,
        preamble: NARRATION_THINKING_LEAK_DEEPSEEK_PREAMBLE,
      };
    }
    // Gemini narration is well-shaped empirically; OpenAI deferred to
    // alpha.32+; mistral/xai have no profile data yet. All pass through.
    return null;
  }

  // role_intro / user_turn / reference / arbitrary — pass-through today.
  return null;
}

/**
 * Pure function. Apply model-aware section rewrites to the IR at compile time.
 *
 * Discipline:
 *   - Never mutates the input IR; returns a new IR with new sections array
 *     when at least one rewrite fired; otherwise returns the input IR by
 *     reference (referential identity preserved on no-op).
 *   - Sections without a `kind` (or `kind === 'arbitrary'`) pass through
 *     unchanged.
 *   - Empty `sections` array → returns `{ rewrittenIR: ir, rewrites: [] }`.
 *   - Sections of the same `kind` are processed in array order; first-match
 *     wins per section. (Today every rule is a single-match rule.)
 *
 * @example
 * ```ts
 * import { applySectionRewrites } from '@warmdrift/kgauto-compiler';
 * import { getProfile } from '@warmdrift/kgauto-compiler';
 *
 * const { rewrittenIR, rewrites } = applySectionRewrites({
 *   ir,
 *   profile: getProfile('deepseek-v4-pro'),
 *   archetype: 'hunt',
 * });
 * if (rewrites.length > 0) console.log('translator fired:', rewrites);
 * ```
 */
export function applySectionRewrites(
  args: ApplySectionRewritesArgs,
): ApplySectionRewritesResult {
  const { ir, profile, archetype } = args;

  // Defensive: empty / missing sections → no work.
  if (!Array.isArray(ir.sections) || ir.sections.length === 0) {
    return { rewrittenIR: ir, rewrites: [] };
  }

  // alpha.68 / Release A — resolve the two extra inputs the discipline-gates
  // rule reads, ONCE per call. Factor C output-shape: explicit arg wins, else
  // the shared `resolveOutputMode` inference.
  //
  // alpha.69 corrects this fallback. It previously derived only json|text, so a
  // tool-carrying surface with no `structuredOutput` resolved to 'text' and the
  // shape-altering gates fired on it — the `tool_call` case the contract names
  // as forbidden. The old rationale ("an agentic hunt uses tools yet emits text
  // and must still get the gate") is a REAL case, but it is a claim only the
  // consumer can make: it is now served by declaring `constraints.outputMode:
  // 'text'`, not by inferring it. Inference stays conservative because wrongly
  // firing breaks a parser while wrongly withholding only forgoes a lift.
  //
  // `hasTools` keeps the `?? 0` guard (`ir.tools` is OPTIONAL) and still drives
  // ONLY gate-3 selection, never the Factor-C screen.
  const outputMode: OutputMode =
    args.outputMode ??
    resolveOutputMode({
      declared: ir.constraints?.outputMode,
      structuredOutput: ir.constraints?.structuredOutput,
      toolCount: ir.tools?.length ?? 0,
    });
  const hasTools = (ir.tools?.length ?? 0) > 0;
  const ctx = { outputMode, hasTools };

  const rewrites: SectionRewrite[] = [];
  const newSections = ir.sections.map((section) => {
    // Sections without a kind tag, or explicitly tagged 'arbitrary',
    // pass through. (Pre-alpha.29 callers carried no `kind` field.)
    if (!section.kind || section.kind === 'arbitrary') return section;

    const rule = matchRule(section.kind, profile, archetype, ctx);
    if (!rule) return section;

    const originalText = section.text;
    const transformedText = `${rule.preamble}\n\n${originalText}`;
    rewrites.push({
      sectionId: section.id,
      kind: section.kind,
      rule: rule.id,
      originalText,
      transformedText,
      ...(rule.wireOverrides ? { wireOverrides: rule.wireOverrides } : {}),
    });
    return { ...section, text: transformedText };
  });

  if (rewrites.length === 0) {
    // No rule fired across any section — preserve referential identity of
    // the input IR. Lets callers cheaply check `rewrittenIR === ir`.
    return { rewrittenIR: ir, rewrites: [] };
  }

  const rewrittenIR: PromptIR = { ...ir, sections: newSections };
  return { rewrittenIR, rewrites };
}
