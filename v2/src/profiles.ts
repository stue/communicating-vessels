/**
 * Model profiles — executable knowledge about each provider/model.
 *
 * Unlike v1 which carried `known_failures` as prose strings, v2 makes them
 * executable: cliffs trigger guards, lowering describes the wire format,
 * recovery handlers describe what to do after specific failures.
 *
 * Each profile is the answer to "if I want to call THIS model with THIS
 * shape of work, what does it need from me, and what should I do when it
 * fails?"
 */

import type { Provider, InputModality, RequiredInputModality } from './ir.js';
import type { IntentArchetypeName } from './dialect.js';

export type StructuredOutputCapability = 'native' | 'grammar' | 'none';
export type SystemPromptMode = 'inline' | 'separate' | 'as_developer' | 'unsupported';
export type CacheStrategy = 'cache_control' | 'cachedContent' | 'unsupported';

export interface CliffRule {
  /** What metric triggers this cliff. */
  metric:
    | 'input_tokens'
    | 'tool_count'
    | 'history_turns'
    | 'thinking_with_short_output';
  /**
   * Threshold — meaning depends on metric.
   *
   * `thinking_with_short_output` (alpha.101): `1` = boolean, fires on the
   * consumer's `expectedShortOutput` hint only. `> 1` = ALSO fires when the
   * consumer's declared `constraints.maxOutputTokens` is BELOW this number,
   * which must be the smallest cap the model was MEASURED to hold under
   * (a `probedLimits` entry with `outcome: 'held'` at that cap). An
   * unmeasured number here is exactly the shape P4 forbids.
   */
  threshold: number;
  /** What action to take when triggered. */
  action:
    | 'downgrade_quality_warning'
    | 'drop_to_top_relevant'
    | 'force_thinking_budget_zero'
    | 'force_terse_output'
    | 'escalate_target'
    | 'strip_tools'
    /**
     * alpha.78 — apply the band-dominating QUALITY_GATE_PENALTY (same lever
     * as the alpha.49 schema-weak gate) when the IR declares
     * structuredOutput and the metric crosses threshold. For models whose
     * declared structured-output support is MEASURED not to hold above an
     * input size on an archetype — evidence-shaped, unlike the archetype-
     * wide `structuredOutputHint: 'avoid'`. Only meaningful with
     * `metric: 'input_tokens'` (+ usually `whenIntent`).
     */
    | 'quality_gate_structured';
  /**
   * Optional: only fire this cliff when the IR's intent.archetype matches.
   * Used for archetype-specific failure modes (e.g. Gemini Flash returns
   * empty when summarize is offered tools).
   */
  whenIntent?: IntentArchetypeName;
  /** Human-readable reason for digest reporting. */
  reason: string;
  /**
   * alpha.93 (guard-probe-suite Phase 1) — the evidence trail behind this
   * guard. Provenance classes: 'observed' (a measured incident), 'assumed'
   * (inherited from a sibling model), 'asserted' (stated without evidence),
   * 'probed' (the probe suite exercised the bad shape deliberately).
   * ABSENT renders as 'asserted' — absence is the worst class, deliberately
   * (see deriveCliffEvidenceClass, which also reads legacy reason prose).
   * Rides the cliffs JSONB verbatim through every transport layer.
   */
  evidence?: CliffEvidence;
}

/** See {@link CliffRule.evidence}. */
export interface CliffEvidence {
  class: 'observed' | 'assumed' | 'asserted' | 'probed';
  /** ISO date of the newest probe run touching this guard. */
  lastProbed?: string;
  verdict?: 'confirmed' | 'flagged' | 'knee-moved';
  /** FK into kgauto_guard_probe_runs. */
  probeRunId?: number;
}

/**
 * alpha.95 — a MEASURED NEGATIVE: a limit we deliberately probed and which
 * held. It has no home in `CliffRule`, because a CliffRule requires an action
 * and there is nothing to do when nothing broke — which is exactly why the
 * fact was invisible until now. Of 15 `current` bundled models, 5 declared
 * zero cliffs (claude-opus-5, claude-sonnet-5, claude-fable-5, gpt-5.4-mini,
 * gpt-5.4-nano — the models a stranger hardcodes), so the offline check had
 * nothing measured to say about precisely them.
 *
 * `claim` is written to be quotable verbatim and MUST state its own
 * denominator: "served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials"
 * is a fact; "handles 20 tools" is an overclaim of the same run.
 */
export interface ProbedLimit {
  metric: CliffRule['metric'];
  /** The point actually exercised (e.g. tool-ladder size). */
  testedAt: number;
  /** What the fixture demanded at that point — the denominator. */
  demanded?: number;
  /** Distinct tools served, per trial. */
  served?: number[];
  /** `held` = probed and did not break. `broke` = a cliff we shipped blind. */
  outcome: 'held' | 'broke';
  trials: number;
  /** ISO date of the run. */
  lastProbed: string;
  /** FK into kgauto_guard_probe_runs. */
  probeRunId?: number;
  /** `direct`, or a gateway route — a verdict is a per-route fact. */
  route?: string;
  /** One sentence, quotable, denominator included. */
  claim: string;
}

/**
 * alpha.93 — evidence class for a guard, derived when the rule predates the
 * explicit field. Explicit `evidence.class` always wins; the legacy
 * derivation reads the reason prose the rules have carried since birth
 * (mechanical keyword classes, pinned by a sweep test over every bundled
 * cliff — that sweep IS the Phase-1 backfill audit, executable). Anything
 * unmatched is 'asserted': the worst class, deliberately.
 */
export function deriveCliffEvidenceClass(rule: CliffRule): CliffEvidence['class'] {
  if (rule.evidence?.class) return rule.evidence.class;
  const r = rule.reason.toLowerCase();
  if (/inherited|conservative|assume|likely degrades|preemptive|starter hypothesis|same drain risk/.test(r)) {
    return 'assumed';
  }
  if (/observed|measured|\d+\/\d+ empty|replayed into/.test(r)) return 'observed';
  return 'asserted';
}

/**
 * alpha.43 — per-family-per-archetype prompt-shape convention.
 *
 * Cliffs are runtime warnings about model failure modes; conventions are
 * compile-time prompt rewrites that head off those failure modes BEFORE the
 * call leaves kgauto. The split: "this model hedges on classify" is a fact
 * about the model (a convention); "this prompt is 80k tokens on a Flash
 * profile" is a fact about the call (a cliff).
 *
 * Conventions live as data on profiles (NOT hardcoded in passes). The
 * `passApplyConventions` pass walks each matching convention and applies
 * its prefix/suffix/structured-output hint at compile time. Idempotent: if
 * the prefix/suffix is already at the head/tail, the pass no-ops.
 *
 * Defaulting rule: set conventions on the FAMILY REPRESENTATIVE profile
 * (e.g. deepseek-v4-pro is the family rep for the `deepseek-reasoner`
 * family). Other family members inherit at compile time via the
 * `family-resolution.deriveFamilyFromModelId` lookup. Model-specific
 * overrides are rare; use them only when one model in a family genuinely
 * diverges from the family default.
 *
 * Trigger that justified the substrate (2026-05-28): V4-Pro probe on
 * tt-intel/classify showed 8/10 judge rationales
 * ⚠️ alpha.96: THAT PROBE WAS PURGED 2026-05-29 (s51, prompt_preview
 * truncation). Zero probe rows survive before 2026-06-01. The substrate is
 * kept; the evidence claim below is retracted — treat as hypothesis.
 * citing "candidate hedges and fails to commit to a single classification."
 * Without a forcing-function suffix, every reasoner probe on a decisive
 * archetype verdicts stay-excluded for reasoner-behavior reasons, not
 * quality reasons. The convention substrate is the kgauto-side fix.
 */
export interface ArchetypeConvention {
  /** Intent archetype this convention applies to. */
  archetype: IntentArchetypeName;
  /**
   * String prepended to the system prompt (after any existing system
   * content). Use for forcing-functions, output-shape directives,
   * anti-hedge framing. Omit if no prefix needed.
   */
  promptPrefix?: string;
  /**
   * String appended to the LAST user message in history (or to
   * `currentTurn` when history is empty). Use for tail-anchored
   * forcing-functions ("Output exactly one of: [...]"). Omit if no suffix
   * needed.
   */
  promptSuffix?: string;
  /**
   * If 'enforce', kgauto warns (but does not block) when structuredOutput
   * is NOT set and the model wants it. If 'avoid', kgauto warns when
   * structuredOutput IS set and the model struggles with schema
   * compliance. If omitted, no structured-output guidance.
   */
  structuredOutputHint?: 'enforce' | 'avoid';
  /**
   * Free-form cliff-style warning surfaced in
   * `CompileResult.diagnostics.cliffWarnings` when the convention's
   * preconditions are met but the consumer opted out of the convention
   * (e.g. provided their own conflicting prompt-shape) — or when the
   * convention can't be applied automatically (cliffWarning-only entries
   * are pure diagnostics).
   */
  cliffWarning?: string;
  /**
   * Optional: only fire this convention's cliffWarning when the tool count
   * is at least this threshold. Used for parallel-tool advisories on
   * archetypes that don't otherwise carry a hard tool cap.
   */
  whenToolCountAtLeast?: number;
  /**
   * Brain-evidence-linked justification. Appears in mutations_applied
   * trail + advisor rule messages. Same format as existing cliff.reason
   * strings.
   */
  reason: string;
}

export interface RecoveryRule {
  /** What signal triggers recovery. */
  signal:
    | 'empty_response_after_tool'
    | 'empty_response'
    | 'malformed_function_call'
    | 'rate_limit'
    | 'model_not_found'
    | 'context_overflow';
  /** Action: retry with adjusted params, or escalate to next fallback. */
  action: 'retry_with_params' | 'escalate' | 'log_only';
  /** When action=retry_with_params, the param adjustments to apply. */
  retryParams?: Record<string, unknown>;
  /** Max retries with this rule. */
  maxRetries?: number;
  /** Human-readable reason for digest reporting. */
  reason: string;
}

export interface LoweringSpec {
  /** Where the system prompt goes. */
  system: { mode: SystemPromptMode; field?: string };
  /** Cache strategy + parameters. */
  cache: {
    strategy: CacheStrategy;
    /** Min tokens before caching is worth it (provider rules). */
    minTokens?: number;
    /** Discount factor on cached input (0.1 = 10% of normal price). */
    discount?: number;
    /** TTL hint in seconds. */
    ttlSeconds?: number;
  };
  /** Tool format identifier — see lower.ts for supported formats. */
  tools?: { format: 'anthropic' | 'google' | 'openai' | 'deepseek' };
  /** Thinking config — present iff this model has a thinking knob. */
  thinking?: {
    /** Field path on the request. */
    field: string;
    /** Default value when caller hasn't specified. */
    default?: number | 'auto' | 'off';
  };
  /**
   * alpha.121 — request shapes the provider documents as a hard 400 for THIS
   * model. A shape listed here never reaches the wire: the Anthropic lowering
   * drops a trailing assistant turn, and `call()` drops the matching keys from
   * `providerOverrides.anthropic` before execute — each drop SAID as a
   * `request-shape-rejected-by-model` advisory (see `request-shapes.ts`).
   * Lives inside `lowering` (a lowering fact, and the `lowering` jsonb column
   * already rides every transport layer verbatim — the Fable 5.1 cache
   * discount precedent), so no migration column is needed for it.
   */
  rejects?: RejectedRequestShape[];
  /**
   * alpha.134 — the request this model accepts to run WITHOUT up-front
   * thinking, and the highest effort at which it accepts it. Written from the
   * per-model table on https://platform.claude.com/docs/en/build-with-claude/thinking
   * (each profile cites its read). Absent when the page lists no accepted
   * off-switch ("Thinking can't be turned off on these models"). Sent only
   * when a `thinking_with_short_output` cliff fires (lowering `thinking:
   * { type }` on the plain-fetch wire; `providerOptions.anthropic` on the AI
   * SDK adapter), and withheld — said as a mutation — when the effort in force
   * is above `effortAtMost` (the page: a 400). Lives in `lowering` (the jsonb
   * column rides every transport verbatim, as `rejects` does).
   */
  thinkingOff?: { type: 'disabled' | 'between_tools'; effortAtMost?: 'low' | 'medium' | 'high' };
  /**
   * alpha.134 — the model's effort knob, from
   * https://platform.claude.com/docs/en/build-with-claude/effort (each profile
   * cites its read): the request field, the level that applies when the
   * request sends none, and the highest level the model takes. kgauto sends no
   * effort on the plain-fetch wire; the adapter's short-output path sends
   * `low` (R2).
   */
  effort?: { field: 'output_config.effort'; default: 'low' | 'medium' | 'high'; max: 'high' | 'xhigh' | 'max' };
}

/** alpha.134 — effort levels in the effort page's order ("low", "medium", "high", "xhigh", "max"). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * alpha.121 — the documented-400 request shapes (Claude Opus 5.5 / Sonnet 5.5
 * migration guides, read 2026-10-06):
 *   - `thinking_control`   `thinking: {type:'disabled'}` or `{type:'enabled', budget_tokens}`
 *                          — listed (alpha.134, R1) only where the page rejects BOTH;
 *                          a model that accepts `disabled` (Haiku 5.5, Opus 5,
 *                          Sonnet 5) or `between_tools` names it in
 *                          `lowering.thinkingOff`, and the per-model types the gate
 *                          drops live in THINKING_TYPES_REJECTED (request-shapes.ts)
 *   - `forced_tool_choice` `tool_choice` of type `any` or `tool`
 *   - `sampling_params`    `temperature` / `top_p` / `top_k`
 *   - `assistant_prefill`  `messages` ending with an assistant turn
 */
export type RejectedRequestShape =
  | 'thinking_control'
  | 'forced_tool_choice'
  | 'sampling_params'
  | 'assistant_prefill';

/**
 * Coarse latency bucket for a model. alpha.47 — the third swap axis
 * (cost / quality / SPEED). We bucket rather than store per-model ms because
 * served latency varies with token count; honest precision is the tier, not a
 * false-precise number. See {@link LATENCY_TIER_MS} for the representative ms
 * each tier maps to when compared against `constraints.maxLatencyMs`.
 */
export type LatencyTier = 'fast' | 'medium' | 'slow';

export type { InputModality, RequiredInputModality } from './ir.js';

/**
 * alpha.126 — the provider's OWN lifecycle vocabulary. Anthropic's deprecations
 * page (…/about-claude/model-deprecations) defines exactly these four:
 * Active / Legacy / Deprecated / Retired. Other providers' words are mapped onto
 * them only when a page is read.
 */
export type ProviderLifecycleStatus = 'active' | 'legacy' | 'deprecated' | 'retired';

/**
 * alpha.126 — what the provider's page says about the model's life, with the
 * date it was read. A FACT to carry, never a routing input (see
 * {@link ModelProfile.providerLifecycle} and `status` for the division).
 */
export interface ProviderLifecycle {
  /** The page's word. */
  status: ProviderLifecycleStatus;
  /** ISO date the page was read (the build day of the release that wrote it). */
  readOn: string;
  /** The page the word was read on. */
  url: string;
  /** ISO date, or `'tba'` when the page says a date is to be announced. Absent when the page names none. */
  retirementFloor?: string;
  /** The page's recommended replacement id, when it names one (Deprecated models only on Anthropic's page). */
  replacement?: string;
}

/**
 * alpha.128 — a cache-WRITE price as the provider's pricing page states it,
 * absolute $/MTok (what a consumer bills with). `fiveMinute` is the 5-minute
 * write, `oneHour` the 1-hour write. Written only where a page states the
 * figure for THIS model; a page whose write durations differ (OpenAI's 30 m /
 * 12 h) is not written into these keys.
 */
export interface CacheWritePrice {
  fiveMinute: number;
  oneHour?: number;
}

/** alpha.128 — the provider's Batch API price for the model, $/MTok, read off the page's batch table (never computed). */
export interface BatchPrice {
  input: number;
  output: number;
}

/**
 * alpha.128 — a price step by prompt length, as the provider states it: a
 * request whose input is OVER `overInputTokens` pays these prices instead of
 * the base ones (Haiku 5.5 over 100,000; Gemini Pro over 200,000; OpenAI long
 * context over 272,000). Each request is priced on its own.
 */
export interface PriceTier {
  /** The step: the tier applies when the request's input tokens exceed this number. */
  overInputTokens: number;
  costInputPer1m: number;
  costOutputPer1m: number;
  costCacheWritePer1m?: CacheWritePrice;
  costBatchPer1m?: BatchPrice;
  /** Cache-read (hit) price in this tier, $/MTok, where the page states it. */
  cacheReadPer1m?: number;
}

/** alpha.128 — the input/output price that applies to a request of `inputTokens`, and the step it came from. */
export interface PriceAtInput {
  costInputPer1m: number;
  costOutputPer1m: number;
  /** The tier's step when a tier applies; absent = the base price. */
  overInputTokens?: number;
}

/**
 * alpha.128 — the one answer to "what does this model charge per 1M for a
 * request this long": the tier with the highest `overInputTokens` that the
 * input exceeds, else the base price. A request of exactly the step is the
 * base tier ("over 100,000 tokens" on Anthropic's page).
 */
export function priceAtInput(
  profile: Pick<ModelProfile, 'costInputPer1m' | 'costOutputPer1m' | 'costTiers'>,
  inputTokens: number,
): PriceAtInput {
  let best: PriceTier | undefined;
  for (const t of profile.costTiers ?? []) {
    if (inputTokens > t.overInputTokens && (!best || t.overInputTokens > best.overInputTokens)) best = t;
  }
  return best
    ? { costInputPer1m: best.costInputPer1m, costOutputPer1m: best.costOutputPer1m, overInputTokens: best.overInputTokens }
    : { costInputPer1m: profile.costInputPer1m, costOutputPer1m: profile.costOutputPer1m };
}

/** alpha.126 — the provider words that mean "on its way out". */
export const PROVIDER_LIFECYCLE_ON_THE_WAY_OUT: ReadonlySet<ProviderLifecycleStatus> = new Set<ProviderLifecycleStatus>([
  'legacy',
  'deprecated',
  'retired',
]);

/** alpha.126 — the one answer to "is this model on its way out?", with its source. */
export interface OnTheWayOut {
  /** The word: the provider's when `by: 'provider'`, kgauto's `status` when `by: 'status'`. */
  word: 'legacy' | 'deprecated' | 'retired';
  by: 'provider' | 'status';
  readOn?: string;
  url?: string;
  retirementFloor?: string;
}

/** alpha.126 — the provider's name as its own pages write it, for advisory prose. */
export function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic';
    case 'google': return 'Google';
    case 'openai': return 'OpenAI';
    case 'deepseek': return 'DeepSeek';
    case 'zai': return 'Z.ai';
    case 'moonshot': return 'Moonshot';
    default: return provider;
  }
}

/**
 * alpha.126 — the retirement-floor clause both advisors print after the provider's
 * word, ONE derivation (s75): `''` when the page names no floor; "; retirement date
 * to be announced" for `'tba'`; "; retirement floor <date> has passed" when the
 * floor is on or before the day the page was read (claude-haiku-4-5: floor
 * 2026-10-15, read 2026-11-02 — "not sooner than" would misread a date already
 * behind us); else "; retirement not sooner than <date>". ISO dates compare as
 * strings.
 */
export function retirementFloorClause(w: Pick<OnTheWayOut, 'retirementFloor' | 'readOn'>): string {
  const floor = w.retirementFloor;
  if (floor === undefined) return '';
  if (floor === 'tba') return '; retirement date to be announced';
  if (w.readOn !== undefined && floor <= w.readOn) return `; retirement floor ${floor} has passed`;
  return `; retirement not sooner than ${floor}`;
}

/**
 * alpha.126 — ONE derivation of "on the way out" for every advisor that reports it
 * (the s75 trap: two derivations of one concept drift). The provider's word wins
 * when it says legacy / deprecated / retired; otherwise kgauto's own `status`
 * (`legacy`, or the brain's `deprecated`) is the old path, kept. `null` when
 * neither says so — `active`, `current`, `preview`, or no page read. NOT read by
 * head resolution, the judge guard or the pins watcher's "current": those are
 * eligibility and read `status` alone.
 */
export function lifecycleOnTheWayOut(profile: ModelProfile | undefined): OnTheWayOut | null {
  if (!profile) return null;
  const lc = profile.providerLifecycle;
  if (lc && PROVIDER_LIFECYCLE_ON_THE_WAY_OUT.has(lc.status)) {
    const out: OnTheWayOut = { word: lc.status as OnTheWayOut['word'], by: 'provider', readOn: lc.readOn, url: lc.url };
    if (lc.retirementFloor !== undefined) out.retirementFloor = lc.retirementFloor;
    return out;
  }
  // `ModelProfile.status` is typed 'current' | 'preview' | 'legacy', but a brain
  // row can carry 'deprecated' (kgauto_models.status is text). Compare as a string.
  const s = profile.status as string;
  if (s === 'legacy' || s === 'deprecated') return { word: s, by: 'status' };
  return null;
}

export interface ModelProfile {
  id: string;
  provider: Provider;
  /**
   * kgauto's word for whether the model may lead a family and sit at a chain
   * head (`family-resolution.ts` admits only `'current'`). It moves ONLY on a
   * measurement (a golden-eval run), on the provider's `retired`, or when the
   * seat records why. It is NOT the provider's lifecycle word — that is
   * {@link providerLifecycle} (alpha.126): the two disagreed on 2026-10-25
   * (Anthropic listed claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 as
   * legacy while golden run #42 kept the claude-sonnet head on sonnet-5), and
   * they will again at every provider release.
   */
  status: 'current' | 'preview' | 'legacy';

  /**
   * alpha.126 — what the provider's page says about the model's life, with the
   * date it was read and the page it was read on; `status` above is kgauto's
   * word for whether the model may lead a family, and it moves only on a
   * measurement (golden eval), on `retired`, or when the seat records why.
   * ABSENT = no lifecycle page was read for this model on the build day (the
   * comment beside `status` names the page tried). Read by the advisors
   * (`consumer-on-stale-model`, `blocked-model-drift`) through
   * {@link lifecycleOnTheWayOut}; never by head resolution. Rides the brain
   * as `kgauto_models.provider_lifecycle` jsonb (migration 090).
   */
  providerLifecycle?: ProviderLifecycle;

  // Hard capabilities
  maxContextTokens: number;
  maxOutputTokens: number;
  maxTools: number;
  parallelToolCalls: boolean;
  structuredOutput: StructuredOutputCapability;
  systemPromptMode: SystemPromptMode;
  streaming: boolean;

  // Soft cliffs (executable knowledge)
  cliffs: CliffRule[];

  // Cost & cache
  costInputPer1m: number;
  costOutputPer1m: number;

  /**
   * alpha.128 — the prices the provider's pricing page states beyond input and
   * output, read on the build day (the URL and readOn sit in the comment beside
   * the profile). ABSENT = the page states no such figure for this model (or no
   * page was readable that day — the comment says which); never derived from a
   * multiplier kgauto remembers. Ride the brain as `kgauto_models`
   * `cost_cache_write_per_1m` / `cost_batch_per_1m` / `cost_tiers` jsonb
   * (migration 093). `costTiers` is priced by {@link priceAtInput} wherever a
   * compile prices or orders a chain; the base fields above are the tier
   * below the first step.
   */
  costCacheWritePer1m?: CacheWritePrice;
  costBatchPer1m?: BatchPrice;
  costTiers?: PriceTier[];

  // How to lower IR → wire request for this provider/model
  lowering: LoweringSpec;

  // Recovery handlers for known failure modes
  recovery: RecoveryRule[];

  // Tagged hints used by routing/scoring
  strengths: string[];
  weaknesses: string[];

  /**
   * alpha.47 — explicit latency bucket. OPTIONAL: when unset, `latencyTierOf`
   * derives it from the tags above (`weaknesses` includes `'latency'` → slow,
   * `strengths` includes `'speed'` → fast, else medium). Set this explicitly
   * ONLY when measured evidence contradicts the tag derivation — e.g.
   * `deepseek-v4-flash` carries no `'latency'` weakness yet measures ~20s
   * (alpha.46 shadow-probe). Carry provenance in an inline comment when you
   * override, same discipline as capability data (step zero / L-081).
   */
  latencyTier?: LatencyTier;

  /**
   * alpha.124 — the input modalities the provider's OWN model page declares
   * for this model, read on the date in `verifiedAgainstDocs` (the URL sits
   * beside the field). ABSENT = not declared: kgauto did not read it on the
   * provider's page, so it says nothing — never defaulted to `['text']` here;
   * the reader decides. A call whose IR carries
   * `constraints.inputModalities` keeps only profiles that declare every
   * required modality, and an absent field is excluded for such a call
   * (said out loud as the `chain-filtered-by-input-modality` mutation).
   * Room rule 5: a modality not read on the page that day is not written.
   */
  inputModalities?: ReadonlyArray<InputModality>;

  // Free-form note
  notes?: string;

  // Last manual verification of capability data against provider docs.
  // The watcher (`scripts/check-model-releases.mjs --audit-fields`) flags
  // profiles older than 90 days as stale and worth re-auditing. ISO date.
  // (L-081: retroactive audits beat forward-only enforcement.)
  verifiedAgainstDocs?: string;

  /**
   * Hand-curated per-archetype performance score on a 0-10 scale.
   *
   *   10 = frontier on this archetype (e.g. Opus 4.7 on critique)
   *    8 = strong second tier (Sonnet on plan, Pro on extract)
   *    7 = competent (Haiku on classify, Flash on hunt)
   *    5 = acceptable for tolerant archetypes (Flash-Lite on classify)
   *    3 = degraded (Flash on critique, DeepSeek on hunt)
   *
   * Missing archetypes default to `5` (no data, neutral). Each non-default
   * value should carry a one-line rationale in the profile's note or inline
   * comment citing brain evidence, family prior, or "starter hypothesis —
   * verify with telemetry."
   *
   * Source today: hand-curated from master plan §3.3 + §6.2 starter tables.
   * Source tomorrow (alpha.10+): brain `archetype_model_evidence` view.
   *
   * Anti-hallucination guardrail (master plan §2.5): when the watcher's
   * `--audit-fields` flag flags a profile stale (>90 days since
   * verifiedAgainstDocs), the archetypePerf values get re-audited
   * alongside capability fields. AI-trained intuition is NOT a valid
   * source — only docs or brain evidence.
   *
   * alpha.9.
   */
  archetypePerf?: Partial<Record<IntentArchetypeName, number>>;

  /**
   * alpha.41 — model-family identifier (e.g. `'claude-opus'`,
   * `'gemini-flash'`). Reads through from `kgauto_models.family` (migration
   * 024). When unset on a brain row, runtime falls back to
   * `deriveFamilyFromModelId(model.id)` (see `family-resolution.ts`).
   *
   * Used by `getRecommendedPrimary({ family, ... })` and the IR-level
   * `{ family: string }` chain entry resolution at compile time.
   */
  family?: string;

  /**
   * alpha.41 — version string of the kgauto release that first introduced
   * this profile (e.g. `'2.0.0-alpha.36'`). Threaded through from the brain
   * row's `version_added` column. Family-resolution sorts candidates by
   * `version_added DESC` (lexicographic) as the secondary tiebreaker after
   * `archetypePerf[archetype]`. Undefined on bundled profiles (no brain
   * row).
   */
  versionAdded?: string;

  /**
   * alpha.41 — whether the brain row is `active = TRUE`. False or undefined
   * means the model is retired / not actively served (kgauto_models row
   * exists but won't be selected by family resolution). Bundled profiles
   * default to `true` when not threaded through (every PROFILES_RAW entry
   * is by definition the active source of truth at bundle time).
   */
  active?: boolean;

  /**
   * alpha.43 — per-archetype prompt-shape conventions. Applied at compile
   * time by `passApplyConventions` (after model selection, before lower).
   * When a convention's archetype matches the request's intent_archetype,
   * the prefix + suffix are applied (idempotent if already present) and
   * the structured-output / cliff-warning diagnostics surface.
   *
   * Conventions are FAMILY-LEVEL by default — set them on the family
   * representative profile (e.g. `deepseek-v4-pro` for the
   * `deepseek-reasoner` family) and other members inherit at compile time
   * via the `family-resolution.deriveFamilyFromModelId` lookup. Model-
   * specific overrides on a member profile take precedence over the
   * family default for the same archetype.
   *
   * See `ArchetypeConvention` for field semantics.
   */
  archetypeConventions?: ArchetypeConvention[];

  /**
   * alpha.95 — measured negatives from the guard-probe suite's `--discover`
   * mode. Lives in the BUNDLE deliberately: `kgauto-check` runs offline and
   * never reads the brain, so evidence that lands brain-only is invisible to
   * the artifact first contact leads with.
   */
  probedLimits?: ProbedLimit[];
  /**
   * alpha.87 — true ONLY on profiles synthesized by
   * `onUnprofiledModel: 'best-effort'`. Lets compile() (and any consumer)
   * distinguish "kgauto knows this model" from "kgauto is winging it with
   * borrowed wire mechanics" on every call, not just the one that
   * triggered synthesis. Never set on bundled, brain, or
   * `registerProfiles()` entries.
   */
  bestEffort?: true;
}

/**
 * Representative p50 latency (ms) per tier. Coarse on purpose — used only to
 * compare a model against `constraints.maxLatencyMs`, never reported as a
 * per-model number. Grounded: alpha.46 shadow-probe measured
 * `deepseek-v4-flash` at 20485ms and `deepseek-v4-pro` at 47722ms (2026-06-03),
 * both bucket `slow`; gemini-2.5-flash / haiku-4-5 serve in single-digit
 * seconds → `fast`; mid-tier (sonnet, gemini-pro) → `medium`. Phase 2 can swap
 * these buckets for measured per-(archetype,model) p50 from
 * `compile_outcomes.latency_ms` once enough served rows accumulate.
 */
export const LATENCY_TIER_MS: Record<LatencyTier, number> = {
  fast: 4000,
  medium: 11000,
  slow: 24000,
};

/**
 * Resolve a model's latency tier. Explicit `profile.latencyTier` wins;
 * otherwise derive from the tags already on the profile so we don't maintain a
 * second source of truth that can silently disagree (L-073 family):
 *   - `weaknesses` includes `'latency'` → `'slow'`
 *   - `strengths` includes `'speed'`    → `'fast'`
 *   - else                              → `'medium'`
 */
/**
 * alpha.124 — the required modalities of a call, normalised: `undefined` when
 * the IR carries no requirement (absent or empty), else the de-duplicated list
 * with `'text'` removed (text is implied). The single place every chain source
 * reads the constraint from, so "no requirement" means the same thing at
 * compile(), at the chain helpers and at call()'s tail (the s75 trap: two
 * derivations of one concept drift).
 */
export function requiredInputModalities(
  required: ReadonlyArray<RequiredInputModality | InputModality> | undefined,
): RequiredInputModality[] | undefined {
  if (!required || required.length === 0) return undefined;
  const out: RequiredInputModality[] = [];
  for (const m of required) {
    if (m === 'text') continue;
    if (!out.includes(m)) out.push(m);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * alpha.124 — why `profile` cannot serve a call that requires `required`, or
 * `undefined` when it can. The reasons are the words the mutation prints:
 *   - `no profile`            — kgauto has no profile for the id;
 *   - `not declared`          — the profile carries no `inputModalities`
 *                               (nobody read it on the provider's page);
 *   - `declares text only` /
 *     `declares text, image only` — the page was read and lacks a modality.
 * Requirement absent → always `undefined` (the filter never fires unasked).
 */
export function inputModalityMiss(
  profile: ModelProfile | undefined,
  required: ReadonlyArray<RequiredInputModality> | undefined,
): string | undefined {
  if (!required || required.length === 0) return undefined;
  if (!profile) return 'no profile';
  const declared = profile.inputModalities;
  if (!declared) return 'not declared';
  const lacks = required.filter((m) => !declared.includes(m));
  if (lacks.length === 0) return undefined;
  return `declares ${declared.join(', ')} only`;
}

export function latencyTierOf(profile: ModelProfile): LatencyTier {
  if (profile.latencyTier) return profile.latencyTier;
  if (profile.weaknesses.includes('latency')) return 'slow';
  if (profile.strengths.includes('speed')) return 'fast';
  return 'medium';
}

// ─────────────────────────────────────────────────────────────────────────
// PROFILES — CURRENT MODELS (verified against provider docs as of 2026-05-08)
//
// Capability data is sourced ONLY from each provider's own docs (CLAUDE.md
// "step zero" / L-049). When the watcher (`scripts/check-model-releases.mjs`)
// flags new model IDs, do NOT add a profile from AI training data — fetch
// the provider's pricing/models page first. The 2026-05-08 audit caught
// `claude-opus-4-6` carrying Opus-4.1 numbers ($15/$75, 200k ctx) and
// `deepseek-chat` claiming 64k context for what is actually a 1M-ctx alias
// (L-073). Both fixed in alpha.2.
// ─────────────────────────────────────────────────────────────────────────

const ANTHROPIC_LOWERING_BASE = {
  system: { mode: 'inline' as const },
  cache: {
    strategy: 'cache_control' as const,
    minTokens: 1024,
    discount: 0.1,
    ttlSeconds: 300,
  },
  tools: { format: 'anthropic' as const },
};

const GOOGLE_LOWERING_BASE = {
  system: { mode: 'separate' as const, field: 'systemInstruction' },
  cache: {
    strategy: 'cachedContent' as const,
    minTokens: 4096,
    discount: 0.25,
    ttlSeconds: 3600,
  },
  tools: { format: 'google' as const },
};

const PROFILES_RAW: ModelProfile[] = [
  // ── Anthropic ──
  {
    // VERIFIED 2026-06-21 against the claude-api reference. Claude Fable 5 is
    // Anthropic's most capable model — a NEW tier ABOVE the opus/sonnet/haiku
    // line (the id has no MAJOR-MINOR version, just `-5`) at 2× Opus pricing
    // ($10/$50 vs $5/$25). Hand-authored, not cloned: the onboarder regex can't
    // match this shape (new family + single-segment version), AND a clone would
    // carry the wrong (opus) pricing. status:'preview' — no brain evidence yet;
    // it earns per-archetype placement through the machinery like any model, and
    // at 2× Opus the quality-floor + cost gates do real work before it leads.
    // API quirk (claude-api ref): an explicit `thinking:{type:"disabled"}` 400s
    // on Fable 5 (omit instead) — MOOT here: ANTHROPIC_LOWERING_BASE carries no
    // `thinking` field, so kgauto never sends the param. (L-049/L-081.)
    id: 'claude-fable-5',
    // alpha.95 — MEASURED, 2026-08-28, guard-probe-suite --discover run 32.
    // This model declared no cliffs, which is why the offline check had
    // nothing measured to say about it. The claim states its denominator:
    // the fixture demands 3 specific tools from a 20-tool menu, so this is
    // evidence of correct selection + 3-way parallel emission at that menu
    // size — NOT evidence of 20 concurrent calls.
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 20,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-28',
        probeRunId: 32,
        route: 'direct',
        claim:
          'Measured 2026-08-28: served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials, direct route.',
      },
    ],
    verifiedAgainstDocs: '2026-06-21',
    provider: 'anthropic',
    status: 'legacy', // 2026-09-13 (alpha.111): the models overview lists Fable 5 under "Legacy models (still available)" since Fable 5.1 (2026-09-01); successor claude-fable-5-1. Was current s76 2026-07-25.
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than June 9, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-fable-5` as Current state Active with the same floor.
    // `status` 'legacy' above is older than this field (written when the page said so and no
    // consumer measurement protected the head); that history stays as it is.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/fable-5/overview', retirementFloor: '2027-06-09' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/fable-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    // alpha.124 (2026-10-24) — same line as claude-fable-5-1 (`family: 'claude-fable'`); without it familyOf() was null for Fable 5 and the resolver could not see 5 → 5.1 as one line (found by the pins builder).
    family: 'claude-fable',
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 10.0,
    costOutputPer1m: 50.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Fable 5": 5m writes $12.50, 1h writes $20 / MTok;
    //   "Batch processing" row "Claude Fable 5": $5 / $25 / MTok).
    costCacheWritePer1m: { fiveMinute: 12.5, oneHour: 20 },
    costBatchPer1m: { input: 5, output: 25 },
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Fable 5 (overview: "Model ID: `claude-fable-5`", "**Legacy.** Released June 9, 2026.").
    // (was: `lowering: ANTHROPIC_LOWERING_BASE`, no rejects, until alpha.133.)
    // alpha.134 (Amendment A 12) — thinking_control, read 2026-11-15T06:45:59Z on https://platform.claude.com/docs/en/build-with-claude/thinking.md,
    // per-model table row "Claude Fable 5": `"enabled"` with `budget_tokens` → "400 error",
    // `"between_tools"` → "400 error", `"disabled"` → "400 error"; prose: "Claude Fable 5.2, …, Claude
    // Fable 5, … reject `thinking: {type: "disabled"}`. Thinking can't be turned off on these models."
    // Both halves of the shape are 400s, so it is listed; the three rejected types are
    // THINKING_TYPES_REJECTED's row. No thinkingOff. (was: rejects ['assistant_prefill'], until alpha.134.)
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      rejects: ['thinking_control', 'assistant_prefill'],
      // alpha.134 (Amendment C 3) — https://platform.claude.com/docs/en/build-with-claude/effort.md (read
      // 2026-11-15T06:46:00Z), section "Claude Fable 5 & Claude Mythos 5": "**Start with `high`, the default, for
      // most tasks**, use `xhigh` for the most capability-sensitive workloads"; the `max` and `xhigh` rows of the
      // levels table each list "Claude Fable 5". No thinkingOff (Amendment A 12).
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      {
        signal: 'rate_limit',
        action: 'escalate',
        reason: '429 from Anthropic — escalate to fallback chain',
      },
      {
        signal: 'model_not_found',
        action: 'escalate',
        reason: 'Model deprecated/renamed — escalate (L-061)',
      },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes: 'Most capable Anthropic model (2026-06); a new tier ABOVE Opus at 2× pricing ($10/$50). 1M ctx, 128k out. Verified 2026-06-21 against the claude-api reference. status:preview — no brain evidence yet; earns placement via the machinery (cost + quality-floor gates govern). latencyTier derives `slow` (weaknesses includes latency — minutes-long turns on hard tasks). The thinking-disabled-400 API quirk is moot for kgauto (Anthropic lowering emits no thinking param).',
    // archetypePerf cloned from claude-opus-4-8 as a conservative estimate
    // (Fable >= Opus in capability, but unmeasured — no fabricated superiority).
    // Re-rank once brain rows exist.
    archetypePerf: {
      critique: 10,
      plan: 10,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,
      summarize: 8,
      classify: 8,
    },
  },
  {
    // alpha.111 — onboarded 2026-09-13 (kgauto s101, Sacha: "onboard fable 5.1 too") from
    // platform.claude.com/docs/en/models/fable-5-1/overview, read that day. Released 2026-09-01,
    // "Latest": 1M ctx, 128K out, $10/$50 (same as Fable 5), cache READ $0.25 (2.5% — a quarter
    // of Fable 5's), 5m cache write $12.50, 1h $20; adaptive thinking ALWAYS ON, default effort
    // high; reliable cutoff Jun 2026; retirement not sooner than 2027-09-01. Three breaking
    // changes from Fable 5, none of which kgauto's Anthropic lowering exercises: forced
    // tool_choice (type any/tool) returns 400 — kgauto emits only auto (+ disable_parallel);
    // thinking blocks are model-bound and prefix-bound — kgauto replays no thinking blocks;
    // prefill unsupported since 4.6 — not emitted. Capability fields beyond the page are
    // inherited from Fable 5 and labelled so; the 2026-08-28 tool-count probe on Fable 5 does
    // NOT transfer (no probedLimits until 5.1 is probed itself).
    id: 'claude-fable-5-1',
    verifiedAgainstDocs: '2026-09-13',
    versionAdded: '2.0.0-alpha.111',
    provider: 'anthropic',
    status: 'current',
    // alpha.132 — the provider's word, re-read 2026-11-11T23:32Z on this model's page: "**Legacy.**
    // Released September 1, 2026."; Status row "Active (legacy)", Retirement "Not sooner than
    // September 1, 2027" (written `legacy`, as claude-fable-5's "Active (legacy)" is). The deprecations
    // table (23:34Z) lists `claude-fable-5-1` as Current state Active with the same floor. `status`
    // stays 'current' (the alpha.126 rule: a page's word moves the head only after it moves `status`).
    // (was: { status: 'active', readOn: '2026-11-02' } from "Active (latest)", until 2026-11-11 —
    // Fable 5.2 shipped 2026-11-09.)
    providerLifecycle: { status: 'legacy', readOn: '2026-11-11', url: 'https://platform.claude.com/docs/en/models/fable-5-1/overview', retirementFloor: '2027-09-01' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/fable-5-1/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 10.0,
    costOutputPer1m: 50.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Fable 5.1": 5m writes $12.50, 1h writes $20 / MTok;
    //   "Batch processing" row "Claude Fable 5.1": $5 / $25 / MTok).
    costCacheWritePer1m: { fiveMinute: 12.5, oneHour: 20 },
    costBatchPer1m: { input: 5, output: 25 },
    // cache read is 2.5% of input on Fable 5.1 (the page's one price difference from Fable 5)
    // alpha.132 (Amendment A, closure item 2) — forced tool choice is a 400 on this model, read
    // 2026-11-12T00:16:33Z on https://platform.claude.com/docs/en/build-with-claude/thinking
    // ("Response prefill and forced tool use"): "The exceptions are Claude Opus 5.5, Claude Sonnet
    // 5.5, Claude Fable 5.2, Claude Mythos 5.2, Claude Fable 5.1, and Claude Mythos 5.1, which
    // reject forced tool use on every request with a 400 error." Carried in `lowering.rejects` the
    // way Fable 5.2 / Opus 5.5 carry it: a consumer's forced `tool_choice` is rewritten before the
    // wire and SAID.
    // Amendment B 3 — the same page and read names Fable 5.1 for two more shapes:
    //   thinking_control — per-model table, row "Claude Fable 5.1": `"enabled"` with
    //     `budget_tokens` → 400 error, `"between_tools"` → 400 error, `"disabled"` → 400 error; and
    //     "Claude Fable 5.2, Claude Mythos 5.2, Claude Fable 5.1, … reject `thinking: {type:
    //     "disabled"}`. Thinking can't be turned off on these models." (THINKING_TYPES_REJECTED row)
    //   sampling_params — "On Claude Fable 5.2, Claude Mythos 5.2, Claude Fable 5.1, … non-default
    //     `temperature`, `top_p`, or `top_k` values return a 400 error on every request, regardless
    //     of whether thinking is used."
    //   assistant_prefill — "Claude 4.6 and later models and Claude Mythos Preview reject a prefilled
    //     final assistant turn with a 400 error" (the same page, line 1239): a class sentence that
    //     includes a model is a statement about that model (Amendment C 2, the seat's ruling; Fable
    //     5.2 carries it on the same sentence).
    // (was: no `rejects` until 2026-11-12; ['forced_tool_choice'] alone until Amendment B; without
    // assistant_prefill until Amendment C.)
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      cache: { ...ANTHROPIC_LOWERING_BASE.cache, discount: 0.025 },
      rejects: ['thinking_control', 'forced_tool_choice', 'sampling_params', 'assistant_prefill'],
      // alpha.134 (R1) — no `thinkingOff`: https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row
      // "Claude Fable 5.1": `"enabled"`, `"between_tools"` and `"disabled"` each → "400 error" ("Thinking can't be
      // turned off on these models"), so `thinking_control` stays listed and no off-switch is written.
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Fable 5.1 supports all five effort levels. **Start with `high`, the default.**"; `max` is "Available on … Claude Fable 5.1".
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 from Anthropic — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes: 'Claude Fable 5.1 (released 2026-09-01; "Latest"). Extends Fable 5 at the same $10/$50 with cache reads at 2.5% ($0.25/M); adaptive thinking always on, default effort high; 1M ctx, 128K out; cutoff Jun 2026. Forced tool_choice returns 400 (kgauto never emits it). Positioning: demanding reasoning and long-horizon agentic work, "when your evals on Opus 5 at higher effort still fall short". archetypePerf is JUDGMENT (carried from Fable 5, which the page calls it an extension of); 0 brain rows as of 2026-09-13; unmeasured.',
    family: 'claude-fable',
    archetypePerf: {
      critique: 10,
      plan: 10,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,
      summarize: 8,
      classify: 8,
    },
  },
  {
    // ── Claude Fable 5.2 — onboarded alpha.132 (2026-11-11) ──────────────
    // PROVENANCE — read 2026-11-11T23:32Z (curl -sL, each HTTP 200) from
    // https://platform.claude.com/docs/en/models/fable-5-2/overview.md (OV),
    // https://platform.claude.com/docs/en/models/fable-5-2/migration-guide.md (MG),
    // https://platform.claude.com/docs/en/about-claude/pricing.md (PR),
    // https://platform.claude.com/docs/en/build-with-claude/thinking.md (TH, 23:34Z),
    // https://platform.claude.com/docs/en/build-with-claude/preserved-thinking.md (PT),
    // https://platform.claude.com/docs/en/about-claude/model-deprecations.md (DP, 23:34Z):
    //   id `claude-fable-5-2` (OV Model IDs, Claude API) · "Latest." released
    //   2026-11-09 · Status "Active (latest)", Retirement "Not sooner than
    //   November 9, 2027" (OV Availability; DP row `claude-fable-5-2 | Active`)
    //   · 1M ctx · 128K max out · "Text and images → text" (OV Capabilities)
    //   · $8 / $40 per MTok; 5m cache write $10, 1h $16, cache read $0.20
    //   (OV Pricing; PR "Model pricing" row "Claude Fable 5.2") = 0.025×
    //   input (PR footnote 1) · Batch $4 / $20 (PR "Batch processing" row)
    //   · adaptive thinking always on, default effort `high` (OV).
    // REJECTED SHAPES — each a 400 on the page, carried in `lowering.rejects`
    //   the way Opus 5.5 carries them (request-shapes.ts drops them before the
    //   wire and SAYS so): forced tool use, `tool_choice` `any` / `tool` (OV
    //   Good to know: "returns a 400 error") · `temperature`, `top_p`, `top_k`
    //   (OV: "Omit …") · thinking `disabled` / `enabled` / `between_tools`
    //   (TH per-model table, row "Claude Fable 5.2": 400 error on all three;
    //   THINKING_TYPES_REJECTED carries the row) · a prefilled final assistant
    //   turn (TH: "Claude 4.6 and later models … reject a prefilled final
    //   assistant turn with a 400 error").
    // THINKING BLOCKS — PT: each block is bound to the system, tools and
    //   messages before it, enforced on every account (MG breaking change 1);
    //   read by Fable 5.2 / Mythos 5.2 only, and Fable 5.2 reads Fable 5.1,
    //   Fable 5, Opus 5, Opus 5.5, Sonnet 5.5, Haiku 5.5 and earlier blocks
    //   (THINKING_BLOCK_MATRIX). kgauto sends `drop_block` when the history
    //   carries blocks (BLOCK_BINDING_MODELS).
    // FAMILY-INHERITED from claude-fable-5-1 (not doc-read): maxTools,
    //   parallelToolCalls, structuredOutput, systemPromptMode, streaming,
    //   strengths/weaknesses tags. probedLimits: none.
    // versionAdded deliberately UNSET, the gpt-6.1-sol / opus-5-5 convention
    // (an unstamped profile never outranks a stamped one in the archetype-less
    // family head); registered at 2.0.0-alpha.132. (No closing brace may sit
    // between `id` and `provider` in this block: scripts/check-model-releases.mjs.)
    id: 'claude-fable-5-2',
    verifiedAgainstDocs: '2026-11-11',
    provider: 'anthropic',
    // alpha.132 — 'preview', not 'current': `buildCostOrderedChain` (fallback.ts) admits every
    // `current` profile above the archetype floor, so 'current' would add this row to every
    // cost-mode chain and move four cost-mode heads (R1: no tier added, no head moved; the
    // builder's objection 1). 'preview' keeps it out of every chain, cost mode, family
    // resolution and the advisor's candidate lists; an explicit `ir.models` entry reaches it.
    // Promotion to 'current' is an explicit call once it has rows (the Fable 5 / Sonnet 5 /
    // gemini-3.8-flash precedent).
    status: 'preview',
    // alpha.132 — the provider's word, read 2026-11-11T23:32Z on this model's page (Status row
    // "Active (latest)", Retirement "Not sooner than November 9, 2027"); the deprecations table
    // (23:34Z) lists `claude-fable-5-2` as Current state Active with the same floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-11', url: 'https://platform.claude.com/docs/en/models/fable-5-2/overview', retirementFloor: '2027-11-09' },
    // alpha.132 — read 2026-11-11 on https://platform.claude.com/docs/en/models/fable-5-2/overview (23:32Z) — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000, // OV Capabilities: "Context window 1M tokens"
    maxOutputTokens: 128_000, // OV Capabilities: "Max output 128K tokens"
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 8.0, // OV / PR: "$8 / MTok"
    costOutputPer1m: 40.0, // OV / PR: "$40 / MTok"
    // alpha.132 — prices read 2026-11-11 on https://platform.claude.com/docs/en/about-claude/pricing (23:32Z)
    //   ("Model pricing" row "Claude Fable 5.2": 5m writes $10, 1h writes $16 / MTok;
    //   "Batch processing" row "Claude Fable 5.2": $4 / $20 / MTok).
    costCacheWritePer1m: { fiveMinute: 10, oneHour: 16 },
    costBatchPer1m: { input: 4, output: 20 },
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // cache read $0.20 = 0.025 × $8 (PR footnote 1: "0.025x the base input price")
      cache: { ...ANTHROPIC_LOWERING_BASE.cache, discount: 0.025 },
      rejects: ['thinking_control', 'forced_tool_choice', 'sampling_params', 'assistant_prefill'],
      // alpha.134 (R1) — no `thinkingOff`: https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row
      // "Claude Fable 5.2": `"enabled"`, `"between_tools"` and `"disabled"` each → "400 error" ("Thinking can't be
      // turned off on these models"), so `thinking_control` stays listed and no off-switch is written.
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Fable 5.2 supports all five effort levels. The API default is `high`."; `max` is "Available on … Claude Fable 5.2".
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 from Anthropic — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes:
      'Claude Fable 5.2 (doc-read 2026-11-11; released 2026-11-09, "Latest"). For demanding reasoning and long-horizon agentic work. $8/$40 (cache read $0.20 = 2.5%, writes $10 5m / $16 1h, batch $4/$20), 1M ctx, 128K out, adaptive thinking always on, default effort high, cutoff Jun 2026, retirement not sooner than 2027-11-09. Rejects (400) forced tool_choice, thinking disabled/enabled/between_tools, temperature/top_p/top_k, assistant prefill — kgauto drops them and says so. The prefix check runs on every account: kgauto sends prefix_mismatch_behavior "drop_block" when the history carries thinking blocks and says what was dropped. Only Fable 5.2 / Mythos 5.2 read its blocks (a fallover elsewhere strips them and says so); it reads Fable 5.1, Fable 5, Opus 5, Opus 5.5, Sonnet 5.5, Haiku 5.5 and earlier blocks. Requires 30-day data retention (not under ZDR unless authorized). Registry-only, status preview (no chain, cost-mode or family route until promoted). archetypePerf is JUDGMENT, cold start: claude-fable-5-1 minus one on every archetype; 0 brain rows.',
    family: 'claude-fable',
    // COLD-START PRIOR = claude-fable-5-1's prior MINUS ONE on every archetype
    // (the gpt-6.1-sol / opus-5-5 convention): judgment, so the `claude-fable`
    // head stays on 5.1 until a measurement moves it.
    archetypePerf: {
      critique: 9,
      plan: 9,
      generate: 8,
      ask: 8,
      extract: 8,
      transform: 8,
      hunt: 7,
      summarize: 7,
      classify: 7,
    },
  },
  {
    // Auto-onboarded 2026-06-04 from `claude-opus-4-7`; VERIFIED 2026-06-21
    // against the claude-api reference. Opus 4.8 shares 4.7's surface exactly —
    // 1M ctx, 128k out, $5/$25, no new breaking changes — so the clone's
    // capability data was accurate (confirmed field-by-field). archetypePerf is
    // still cloned from 4.7 (a sound estimate: 4.8 >= 4.7) — re-rank once brain
    // rows exist. Promoted to status:'current' 2026-06-21 (Sacha: "include Claude
    // Opus 4.8") — now live-selectable. Ties with the still-current claude-opus-4-7
    // (identical $5/$25 + cloned perf) resolve to 4-8 by array order. (L-049/L-081.)
    id: 'claude-opus-4-8',
    verifiedAgainstDocs: '2026-06-21',
    provider: 'anthropic',
    status: 'legacy', // s76 2026-07-25: docs list as LEGACY (Opus 5 generation is current).
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than May 28, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-opus-4-8` as Current state Active with the same floor.
    // `status` 'legacy' above is older than this field (written when the page said so and no
    // consumer measurement protected the head); that history stays as it is.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/opus-4-8/overview', retirementFloor: '2027-05-28' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/opus-4-8/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 5.0,
    costOutputPer1m: 25.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Opus 4.8": 5m writes $6.25, 1h writes $10 / MTok;
    //   "Batch processing" row "Claude Opus 4.8": $2.50 / $12.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 6.25, oneHour: 10 },
    costBatchPer1m: { input: 2.5, output: 12.5 },
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Opus 4.8 (overview: "Model ID: `claude-opus-4-8`", "**Legacy.** Released May 28, 2026.").
    // (was: `lowering: ANTHROPIC_LOWERING_BASE`, no rejects, until alpha.133.)
    lowering: { ...ANTHROPIC_LOWERING_BASE, rejects: ['assistant_prefill'] },
    recovery: [
      {
        signal: 'rate_limit',
        action: 'escalate',
        reason: '429 from Anthropic — escalate to fallback chain',
      },
      {
        signal: 'model_not_found',
        action: 'escalate',
        reason: 'Model deprecated/renamed — escalate (L-061)',
      },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes: 'Frontier Opus (2026-06), the current recommended Opus-tier default. Verified 2026-06-21 against the claude-api reference: 1M ctx, 128k out, $5/$25 — identical surface to 4.7, no new breaking changes. Promoted to status:current 2026-06-21 (live-selectable); coexists with claude-opus-4-7 (still current).',
    // Cloned archetypePerf from claude-opus-4-7 — re-evaluate once brain rows exist.
    archetypePerf: {
      critique: 10,
      plan: 10,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,
      summarize: 8,
      classify: 8,
    },
  },
  {
    // ── Claude Opus 5 — added s76 (2026-07-25, alpha.72) ──────────────────
    // The model every seat in the portfolio actually runs, absent from the
    // roster until now. Found by a catalog QA, not by the release watcher:
    // the watcher detects unknown IDs on a provider's /models endpoint, but
    // detection was never wired to ingestion, so the gap sat open. (That is
    // what `scripts/catalog-sync.mjs` exists to close.)
    //
    // PROVENANCE — doc-verified 2026-07-25 against
    // platform.claude.com/docs/en/docs/about-claude/models/overview:
    //   1M context · 128k max output · $5/$25 per MTok · adaptive thinking YES
    //   · extended thinking NO · `effort` defaults to 'high' on the Claude API
    //   · reliable knowledge cutoff May 2026.
    //
    // FAMILY-INHERITED (not doc-read): maxTools, parallelToolCalls,
    // structuredOutput, systemPromptMode, streaming. These are identical
    // across opus-4-6 / 4-7 / 4-8 / sonnet-5 / fable-5 — five consecutive
    // models — so they are a structural provider constant rather than a
    // per-model value. Deliberately distinguished from the gemini-3.1-flash-lite
    // failure, where a template-clone of PRICE (the field that actually varies,
    // there by 2.5-3.75x) went unverified for 65 days.
    id: 'claude-opus-5',
    // alpha.95 — MEASURED, 2026-08-28, guard-probe-suite --discover run 33.
    // This model declared no cliffs, which is why the offline check had
    // nothing measured to say about it. The claim states its denominator:
    // the fixture demands 3 specific tools from a 20-tool menu, so this is
    // evidence of correct selection + 3-way parallel emission at that menu
    // size — NOT evidence of 20 concurrent calls.
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 20,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-28',
        probeRunId: 33,
        route: 'direct',
        claim:
          'Measured 2026-08-28: served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials, direct route.',
      },
    ],
    verifiedAgainstDocs: '2026-07-25',
    provider: 'anthropic',
    status: 'current',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than July 24, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-opus-5` as Current state Active with the same floor.
    // `status` above stays 'current' — THE HEAD DOES NOT MOVE on a page's word: golden runs
    // #41 (ask, claude-sonnet-5 → claude-sonnet-5-5: 90 % win-or-tie, promote-ready) and #42
    // (extract: 10W/10T/10L = 67 %, BELOW the 80 % bar), both 2026-10-25, say the measured
    // head stays (the filing). `status` moves on a measurement (golden eval),
    // on the provider's `retired`, or when the seat records why — never on this field.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/opus-5/overview', retirementFloor: '2027-07-24' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/opus-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // alpha.134 (R2) — the model's own off-switch, sent when the caller says the answer is short.
        // Threshold 1: the caller's `expectedShortOutput` hint only — no cap has been measured for this
        // model (R3; the measurement needs a provider key). Source: https://platform.claude.com/docs/en/build-with-claude/thinking.md, read 2026-11-15T06:45:59Z:
        // "Thinking tokens count toward `max_tokens`".
        metric: 'thinking_with_short_output',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          'Claude Opus 5 thinks by default and its thinking tokens count toward max_tokens, so under a small cap the answer can be cut or empty (https://platform.claude.com/docs/en/build-with-claude/thinking, read 2026-11-15). When the caller says the answer is short, the request carries thinking: {"type": "disabled"}, the model\'s own off-switch. Fires on the caller\'s short-output hint; no cap has been measured for this model.',
      },
    ],
    costInputPer1m: 5.0,
    costOutputPer1m: 25.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Opus 5": 5m writes $6.25, 1h writes $10 / MTok;
    //   "Batch processing" row "Claude Opus 5": $2.50 / $12.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 6.25, oneHour: 10 },
    costBatchPer1m: { input: 2.5, output: 12.5 },
    // alpha.125 (amendment 4a) — sampling_params, read 2026-10-25 on
    // https://platform.claude.com/docs/en/build-with-claude/thinking: "On Claude
    // Fable 5.1, …, Claude Opus 5, …, Claude Sonnet 5, and Claude Haiku 5.5,
    // non-default `temperature`, `top_p`, or `top_k` values return a 400 error on
    // every request, regardless of whether thinking is used." (was: not listed,
    // until 2026-10-25.)
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Opus 5 (overview: "Model ID: `claude-opus-5`", "**Legacy.** Released July 24, 2026.").
    // (was: rejects ['thinking_control', 'sampling_params'], until alpha.133.)
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // alpha.134 (R1) — https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row "Claude Opus 5": `"enabled"`
      // with `budget_tokens` → "400 error", `"between_tools"` → "400 error", `"disabled"` → "Thinking off at `high` effort or below".
      // `disabled` is accepted, so `thinking_control` (which means BOTH disabled and enabled are 400s)
      // is not listed; the two rejected types are gated by THINKING_TYPES_REJECTED. (was: rejects
      // ['thinking_control', 'sampling_params', 'assistant_prefill'] with a comment redefining the shape
      // for this model, until alpha.134.) The off-switch: "Claude Opus 5 also has thinking on by default and accepts `thinking: {type: \"disabled\"}` at effort `high` or below. At `xhigh` or `max` effort, thinking cannot be turned off".
      rejects: ['sampling_params', 'assistant_prefill'],
      thinkingOff: { type: 'disabled', effortAtMost: 'high' },
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Opus 5 supports all five effort levels. **Start with `high`, the default**"; `max` "Available on … Claude Opus 5".
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      {
        signal: 'rate_limit',
        action: 'escalate',
        reason: '429 from Anthropic — escalate to fallback chain',
      },
      {
        signal: 'model_not_found',
        action: 'escalate',
        reason: 'Model deprecated/renamed — escalate (L-061)',
      },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes:
      'Anthropic frontier for complex agentic coding + enterprise work; the Opus-tier current default as of 2026-07-25, superseding 4.8/4.7/4.6 (all now legacy). Doc-verified 2026-07-25: 1M ctx, 128k out, $5/$25, adaptive thinking (extended thinking NOT supported — that is Haiku 4.5 only in this generation), `effort` defaults to high on the Claude API. Price is unchanged from 4.5 through 5 — the tier moved without a cost change.',
    // COLD-START PRIOR cloned from claude-opus-4-8. Self-labelling: below
    // MEASURED_GROUNDING_MIN_N (10) brain rows these resolve as
    // grounding:'judgment', so nothing reads them as measured until they are.
    archetypePerf: {
      critique: 10,
      plan: 10,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,
      summarize: 8,
      classify: 8,
    },
  },
  {
    // ── Claude Opus 5.5 — onboarded alpha.121 (2026-10-06) ───────────────
    // PROVENANCE — read 2026-10-06 (the build day) from
    // platform.claude.com/docs/en/about-claude/pricing, …/models/overview and
    // …/models/opus-5-5/migration-guide:
    //   id = alias `claude-opus-5-5` (dateless ids are their own pinned
    //   snapshot) · 1M ctx · 128K max out (300K on Batches with
    //   output-300k-2026-03-24) · $4 in / $20 out · 5m write $5, 1h write $8 ·
    //   cache hits $0.20 = 0.05× base (footnote 2: "Cache hits and refreshes
    //   on Claude Opus 5.5 are priced at 0.05x the base input price") · batch
    //   $2/$10 · fast mode $8/$40 (research preview, Claude API only — not
    //   supported by kgauto) · adaptive thinking ALWAYS ON, default effort
    //   `medium` · reliable cutoff Jun 2026 · retirement not sooner than
    //   2027-09-22 · tool-use system prompt 286 tokens (auto/none); the
    //   any/tool column is blank — forced tool choice is not offered.
    // REJECTED SHAPES (migration guide, each a 400): thinking disabled /
    // enabled+budget_tokens, tool_choice any|tool, non-default
    // temperature/top_p/top_k, a prefilled assistant turn, `computer_20251124`
    // (kgauto's IR cannot emit a computer-use tool — not listed). Carried in
    // `lowering.rejects`; dropped before the wire and SAID (request-shapes.ts).
    // FAMILY-INHERITED from claude-opus-5 (not doc-read): maxTools,
    // parallelToolCalls, structuredOutput, systemPromptMode, streaming,
    // strengths/weaknesses tags. probedLimits: none — Opus 5's run-33 tool
    // probe does not transfer to a model it never touched.
    id: 'claude-opus-5-5',
    verifiedAgainstDocs: '2026-10-06',
    // versionAdded deliberately UNSET (brain row: version_added NULL). Family
    // resolution with no archetype ties at perf 0 and the newest versionAdded
    // wins; tt-intelligence resolves `claude-opus`/`claude-sonnet` with no
    // archetype (lib/kgauto.ts calls getRecommendedPrimary with family, appId
    // and fallback only), so a stamp here would move its head to 5.5 on
    // judgment — the move this release exists not to make. Registered at
    // 2.0.0-alpha.121. (No closing brace may sit between `id` and `provider`
    // in this block: scripts/check-model-releases.mjs pairs the two with a
    // regex that stops at one, and an unpaired id reads as unregistered.)
    provider: 'anthropic',
    status: 'current',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (latest)", Retirement "Not sooner than September 22, 2027").
    // The deprecations table (…/about-claude/model-deprecations, same day) lists
    // `claude-opus-5-5` as Current state Active with the same floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/opus-5-5/overview', retirementFloor: '2027-09-22' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/opus-5-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 4.0,
    costOutputPer1m: 20.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Opus 5.5": 5m writes $5, 1h writes $8 / MTok;
    //   "Batch processing" row "Claude Opus 5.5": $2 / $10 / MTok).
    costCacheWritePer1m: { fiveMinute: 5, oneHour: 8 },
    costBatchPer1m: { input: 2, output: 10 },
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // cache read is 5% of input on Opus 5.5 (pricing footnote 2)
      cache: { ...ANTHROPIC_LOWERING_BASE.cache, discount: 0.05 },
      rejects: ['thinking_control', 'forced_tool_choice', 'sampling_params', 'assistant_prefill'],
      // alpha.134 (R1) — no `thinkingOff`: https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row
      // "Claude Opus 5.5": `"enabled"`, `"between_tools"` and `"disabled"` each → "400 error" ("Thinking can't be
      // turned off on these models"), so `thinking_control` stays listed and no off-switch is written.
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Opus 5.5 supports all five effort levels, and `medium` is the default."; `max` is "Available on … Claude Opus 5.5".
      effort: { field: 'output_config.effort', default: 'medium', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 from Anthropic — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes:
      'Claude Opus 5.5 (doc-read 2026-10-06). $4/$20, cache reads $0.20 (0.05× base), 1M ctx, 128K out, adaptive thinking always on, default effort medium, cutoff Jun 2026, retirement not sooner than 2027-09-22. Rejects (400) thinking disabled/enabled, tool_choice any|tool, non-default temperature/top_p/top_k, assistant prefill — kgauto drops them and says so. Thinking blocks are read on the Claude API only by Fable 5.1 / Mythos 5.1: a fallover elsewhere runs without them (call() strips them and says so). The vendor\'s own routing line, 2026-10-06: "start with Claude Opus 5.5 for most workloads. Use Claude Fable 5.1 for demanding reasoning and long-horizon agentic work". Comparative latency on the overview: "Moderate" (tier kept from Opus 5, unmeasured). archetypePerf is JUDGMENT, 0 brain rows.',
    family: 'claude-opus',
    // COLD-START PRIOR = claude-opus-5's prior MINUS ONE on every archetype.
    // Judgment, deliberately: the `claude-opus` head stays on the measured
    // incumbent until the Tuesday delta report measures 5.5 as a candidate
    // (price trigger: $4/$20 under Opus 5's $5/$25). Equal perf would move the
    // head on the versionAdded tiebreak — a routing change nobody opted into.
    archetypePerf: {
      critique: 9,
      plan: 9,
      generate: 8,
      ask: 8,
      extract: 8,
      transform: 8,
      hunt: 7,
      summarize: 7,
      classify: 7,
    },
  },
  {
    id: 'claude-opus-4-7',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'anthropic',
    status: 'legacy', // s76 2026-07-25: docs list as LEGACY (Opus 5 is current). Bundle said current while the brain already said legacy — the two disagreed.
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than April 16, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-opus-4-7` as Current state Active with the same floor.
    // `status` 'legacy' above is older than this field (written when the page said so and no
    // consumer measurement protected the head); that history stays as it is.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/opus-4-7/overview', retirementFloor: '2027-04-16' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/opus-4-7/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 5.0,
    costOutputPer1m: 25.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Opus 4.7": 5m writes $6.25, 1h writes $10 / MTok;
    //   "Batch processing" row "Claude Opus 4.7": $2.50 / $12.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 6.25, oneHour: 10 },
    costBatchPer1m: { input: 2.5, output: 12.5 },
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Opus 4.7 (overview: "Model ID: `claude-opus-4-7`", "**Legacy.** Released April 16, 2026.").
    // (was: `lowering: ANTHROPIC_LOWERING_BASE`, no rejects, until alpha.133.)
    lowering: { ...ANTHROPIC_LOWERING_BASE, rejects: ['assistant_prefill'] },
    recovery: [
      {
        signal: 'rate_limit',
        action: 'escalate',
        reason: '429 from Anthropic — escalate to fallback chain',
      },
      {
        signal: 'model_not_found',
        action: 'escalate',
        reason: 'Model deprecated/renamed — escalate (L-061)',
      },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'reliable_tool_use', 'structured_output'],
    weaknesses: ['cost', 'latency'],
    notes: 'Frontier (2026-05). Step-change improvement over 4.6 in agentic coding. Adaptive thinking only — no extended-thinking toggle. 1M context, 128k max output.',
    // Frontier perf. Drops on archetypes where parallel-tool throughput
    // (hunt) or low-budget cost-sensitivity (classify/summarize) matters
    // more than reasoning depth.
    archetypePerf: {
      critique: 10,
      plan: 10,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,        // strong but Flash dominates parallel tool throughput
      summarize: 8,   // overkill for tolerant archetype; cost-out of frontier
      classify: 8,    // overkill; brain-validated cheaper models cover this
    },
  },
  {
    id: 'claude-opus-4-6',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'anthropic',
    status: 'legacy',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than February 5, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-opus-4-6` as Current state Active with the same floor.
    // `status` 'legacy' above is older than this field (written when the page said so and no
    // consumer measurement protected the head); that history stays as it is.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/opus-4-6/overview', retirementFloor: '2027-02-05' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/opus-4-6/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 5.0,
    costOutputPer1m: 25.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Opus 4.6": 5m writes $6.25, 1h writes $10 / MTok;
    //   "Batch processing" row "Claude Opus 4.6": $2.50 / $12.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 6.25, oneHour: 10 },
    costBatchPer1m: { input: 2.5, output: 12.5 },
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Opus 4.6 (overview: "Model ID: `claude-opus-4-6`", "**Legacy.** Released February 5, 2026.").
    // (was: `lowering: ANTHROPIC_LOWERING_BASE`, no rejects, until alpha.133.)
    lowering: { ...ANTHROPIC_LOWERING_BASE, rejects: ['assistant_prefill'] },
    recovery: [
      {
        signal: 'rate_limit',
        action: 'escalate',
        reason: '429 from Anthropic — escalate to fallback chain',
      },
      {
        signal: 'model_not_found',
        action: 'escalate',
        reason: 'Model deprecated/renamed — escalate (L-061)',
      },
    ],
    strengths: ['reasoning', 'long_context', 'reliable_tool_use', 'structured_output', 'extended_thinking'],
    weaknesses: ['cost', 'latency'],
    notes: 'Predecessor to 4.7. Still current in Anthropic legacy table. Same pricing as 4.7 — choose 4.7 unless you need extended-thinking budget control (4.7 is adaptive-only).',
    // One notch below 4.7 across the board — extended-thinking edge does
    // not flip any archetype ranking. Legacy: chains should prefer 4.7.
    archetypePerf: {
      critique: 9,
      plan: 9,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 7,
      summarize: 8,
      classify: 8,
    },
  },
  {
    id: 'claude-sonnet-4-6',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'anthropic',
    status: 'legacy', // s76 2026-07-25: docs list as LEGACY (Sonnet 5 is current).
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than February 17, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-sonnet-4-6` as Current state Active with the same floor.
    // `status` 'legacy' above is older than this field (written when the page said so and no
    // consumer measurement protected the head); that history stays as it is.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/sonnet-4-6/overview', retirementFloor: '2027-02-17' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/sonnet-4-6/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 3.0,
    costOutputPer1m: 15.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Sonnet 4.6": 5m writes $3.75, 1h writes $6 / MTok;
    //   "Batch processing" row "Claude Sonnet 4.6": $1.50 / $7.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 3.75, oneHour: 6 },
    costBatchPer1m: { input: 1.5, output: 7.5 },
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Sonnet 4.6 (overview: "Model ID: `claude-sonnet-4-6`", "**Legacy.** Released February 17, 2026.").
    // (was: `lowering: ANTHROPIC_LOWERING_BASE`, no rejects, until alpha.133.)
    lowering: { ...ANTHROPIC_LOWERING_BASE, rejects: ['assistant_prefill'] },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Deprecated — escalate (L-061)' },
    ],
    strengths: ['quality', 'tool_use', 'long_context', 'cache_friendly', 'extended_thinking'],
    weaknesses: [],
    notes: 'Workhorse. Best price/quality for most multi-turn agentic work. 1M context, 64k max output.',
    // Master plan §6.2 anchor. Tier 0 for plan/generate/ask/extract/transform
    // in starter chains; tier 1 cross-provider for hunt/summarize/classify.
    archetypePerf: {
      ask: 9,
      generate: 9,
      plan: 9,
      critique: 9,
      extract: 9,
      transform: 9,
      hunt: 7,        // strong but Flash beats on parallel tool throughput
      summarize: 8,   // overkill for tolerant archetype
      classify: 8,    // overkill
    },
  },
  {
    id: 'claude-haiku-4-5',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'anthropic',
    status: 'current',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than October 15, 2026"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-haiku-4-5-20251001` as Current state Active with the same floor.
    // `status` above stays 'current' — THE HEAD DOES NOT MOVE on a page's word: golden runs
    // #41 (ask, claude-sonnet-5 → claude-sonnet-5-5: 90 % win-or-tie, promote-ready) and #42
    // (extract: 10W/10T/10L = 67 %, BELOW the 80 % bar), both 2026-10-25, say the measured
    // head stays (the filing); on this line runs #44–#47 placed claude-haiku-5-5 at equal perf
    // and the tie falls to versionAdded, so haiku-4-5 holds. `status` moves on a measurement,
    // on the provider's `retired`, or when the seat records why — never on this field.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/haiku-4-5/overview', retirementFloor: '2026-10-15' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/haiku-4-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
    maxTools: 32,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // alpha.78 — the declared `structuredOutput: 'grammar'` does NOT
        // hold on long-input summarize. MEASURED (brain, playbacksam):
        // 21 disambiguated `structured_output_parse_failed` fallover rows
        // 2026-07-22..27, tokens_in 12,280–31,450; PB's gate counted 20/20
        // in-window failures. Clean traffic p50 sits at ~9K tokens_in, so
        // 12K gates the failing band without touching the working one.
        // Short-input summarize carries no failure evidence and stays
        // ungated — this is why it's a cliff, not an archetype-wide
        // `structuredOutputHint: 'avoid'`.
        metric: 'input_tokens',
        threshold: 12_000,
        action: 'quality_gate_structured',
        whenIntent: 'summarize',
        reason:
          'On summarize with more than 12,000 input tokens, every structured-output reply in the measurement window failed to parse (measured on production summarize traffic, 2026-07-25 to 2026-07-27); the model led those calls only when input size made its price dominate.',
      },
    ],
    costInputPer1m: 1.0,
    costOutputPer1m: 5.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Haiku 4.5": 5m writes $1.25, 1h writes $2 / MTok;
    //   "Batch processing" row "Claude Haiku 4.5": $0.50 / $2.50 / MTok).
    costCacheWritePer1m: { fiveMinute: 1.25, oneHour: 2 },
    costBatchPer1m: { input: 0.5, output: 2.5 },
    lowering: ANTHROPIC_LOWERING_BASE,
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to Sonnet' },
    ],
    strengths: ['speed', 'cost', 'classification', 'cache_friendly', 'extended_thinking'],
    weaknesses: ['complex_reasoning', 'large_tool_sets'],
    notes: 'Cheapest Anthropic. Great for classify, summarize, ask shapes. 200k context, 64k max output. API alias `claude-haiku-4-5` resolves to dated snapshot `claude-haiku-4-5-20251001`.',
    // Tier 1 cross-provider anchor for short-output chains (classify/
    // summarize/extract/transform). Falls off on plan/critique where
    // reasoning depth matters; competes with Pro on cost+latency.
    archetypePerf: {
      classify: 8,
      summarize: 8,
      ask: 7,
      transform: 7,
      extract: 7,
      hunt: 6,        // tool reliability drops at 16 — cliff guard fires
      generate: 6,
      plan: 5,
      critique: 4,    // reasoning depth gap vs Sonnet/Opus
    },
  },
  {
    // ── Claude Haiku 5.5 — onboarded alpha.125 (2026-10-25) ──────────────
    // PROVENANCE — read 2026-10-25 (the build day) from
    // https://platform.claude.com/docs/en/models/haiku-5-5/overview (OV),
    // https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide (MG),
    // https://platform.claude.com/docs/en/about-claude/pricing (PR),
    // https://platform.claude.com/docs/en/build-with-claude/thinking (TH),
    // https://platform.claude.com/docs/en/about-claude/model-deprecations (DP):
    //   id `claude-haiku-5-5` — MG: "a fixed model ID with no date suffix and
    //   no separate alias" · released 2026-10-07, "Active (latest)", retirement
    //   not sooner than 2027-10-07 (OV Availability; DP table) · 1M ctx · 128K
    //   max out (300K on Batches with output-300k-2026-03-24) (OV Capabilities)
    //   · PRICED BY PROMPT LENGTH (PR rows "Claude Haiku 5.5 (for prompts up
    //   to / over 100,000 tokens)" + PR "Long context pricing"): ≤ 100K
    //   $0.10 in / $0.50 out, 5m write $0.125, 1h write $0.20, cache read
    //   $0.01 · > 100K $0.50 / $2.50, $0.625 / $1, $0.05 · batch 50% off both
    //   · cache read 10% of base (OV "Price / MTok" note) · min cacheable
    //   prompt 512 tokens (OV Good to know) · tool-use system prompt 286
    //   (auto/none) / 406 (any/tool) tokens (PR tool-use table).
    // REJECTED SHAPES — each a 400 on the page, carried in `lowering.rejects`:
    //   thinking `enabled`+budget_tokens (MG Configure thinking; TH table row
    //   "Claude Haiku 5.5": enabled → 400, between_tools → 400, disabled →
    //   "Thinking off at `high` effort or below" — ACCEPTED, so the
    //   thinking_control gate keeps `disabled` for this model, see
    //   THINKING_TYPES_REJECTED in request-shapes.ts) · temperature / top_p /
    //   top_k (OV "Omit `temperature`, `top_p`, and `top_k`"; DP: removed in
    //   API version 2026-10-21) · assistant prefill (MG: "rejects it with a
    //   400 error, even with thinking turned off") · `computer_20250124` (MG;
    //   kgauto's IR cannot emit a computer-use tool — not listed).
    // NOT REJECTED — forced tool_choice. MG: "Claude Haiku 5.5 accepts a
    //   forced `tool_choice` (`any` or a named tool), but the response starts
    //   with the tool call and has no `thinking` block." Opus 5.5 / Sonnet 5.5
    //   reject it; their `rejects` list is NOT copied (a copied reject is an
    //   amputation with evidence attached — alpha.103).
    // CLONED from claude-haiku-4-5 (the page does not contradict them; not
    //   doc-read): maxTools, parallelToolCalls, structuredOutput,
    //   systemPromptMode, streaming, the strengths/weaknesses tags minus
    //   `extended_thinking` (MG: budget_tokens thinking is a 400 here).
    //   probedLimits: none — nothing measured on this model.
    id: 'claude-haiku-5-5',
    verifiedAgainstDocs: '2026-10-25',
    // versionAdded deliberately UNSET (brain row: version_added NULL), by
    // migration 085's reasoning: archetype-less family resolution ties at perf
    // 0 and the newest versionAdded wins, so a stamp would move every
    // `{ family: 'claude-haiku' }` resolution without an archetype onto 5.5 on
    // judgment. Unstamped, the tie falls to id ASC → claude-haiku-4-5.
    // Registered at 2.0.0-alpha.125. (No closing brace may sit between `id`
    // and `provider` in this block: scripts/check-model-releases.mjs pairs the
    // two with a regex that stops at one.)
    provider: 'anthropic',
    status: 'current',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (latest)", Retirement "Not sooner than October 7, 2027").
    // The deprecations table (…/about-claude/model-deprecations, same day) lists
    // `claude-haiku-5-5` as Current state Active with the same floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/haiku-5-5/overview', retirementFloor: '2027-10-07' },
    // alpha.125 — read 2026-10-25 on https://platform.claude.com/docs/en/models/haiku-5-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000, // OV Capabilities: "Context window 1M tokens"
    maxOutputTokens: 128_000, // OV Capabilities: "Max output 128K tokens"
    maxTools: 32,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    // haiku-4-5's alpha.78 cliff (structured output on long-input summarize)
    // is NOT inherited: it was MEASURED on haiku-4-5, and a measured rule does
    // not transfer to a model with a different tokenizer (+30% tokens for the
    // same text, MG Recount tokens) and context (1M vs 200K). Capability-
    // reducing rules default OFF without evidence (P2, alpha.103).
    cliffs: [
      {
        // The >100K price tier, carried the way gemini-2.5-pro / 3.1-pro carry
        // theirs: `downgrade_quality_warning`, no evidence field. passApplyCliffs
        // fires it as a diagnostic (not capability-reducing, passes.ts
        // isCapabilityReducing); passScoreTargets docks no quality for it
        // (passes.ts `if (!qualityPenaltyEvidenced(cliff)) continue;` — a price
        // fact is not a quality fact). Threshold 100_001: both passes compare
        // `estimatedInputTokens >= threshold`, and PR prices "prompts over
        // 100,000 tokens" higher — a 100,000-token prompt is still the base tier.
        // Source: https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing
        metric: 'input_tokens',
        threshold: 100_001,
        action: 'downgrade_quality_warning',
        reason:
          'Priced by prompt length (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-15): over 100,000 prompt tokens (all input, cache reads and writes included) input $0.10→$0.50/M, output $0.50→$2.50/M, ×5; each request priced on its own.',
      },
      {
        // alpha.134 (R2) — the model's own off-switch, sent when the caller says the answer is short.
        // Threshold 1: the caller's `expectedShortOutput` hint only — no cap has been measured for this
        // model (R3; the measurement needs a provider key). Source: https://platform.claude.com/docs/en/build-with-claude/thinking.md, read 2026-11-15T06:45:59Z:
        // "Thinking tokens count toward `max_tokens`".
        metric: 'thinking_with_short_output',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          'Claude Haiku 5.5 thinks by default and its thinking tokens count toward max_tokens, so under a small cap the answer can be cut or empty (https://platform.claude.com/docs/en/build-with-claude/thinking, read 2026-11-15). When the caller says the answer is short, the request carries thinking: {"type": "disabled"}, the model\'s own off-switch. Fires on the caller\'s short-output hint; no cap has been measured for this model.',
      },
    ],
    costInputPer1m: 0.1, // PR: "$0.10 / MTok" (prompts up to 100,000 tokens — the base tier)
    costOutputPer1m: 0.5, // PR: "$0.50 / MTok" (prompts up to 100,000 tokens)
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Haiku 5.5": 5m writes $0.125, 1h writes $0.20 / MTok;
    //   "Batch processing" row "Claude Haiku 5.5": $0.05 / $0.25 / MTok, prompts up to 100,000 tokens).
    costCacheWritePer1m: { fiveMinute: 0.125, oneHour: 0.2 },
    costBatchPer1m: { input: 0.05, output: 0.25 },
    // The over-100K step, the same page and read ("Long context pricing": "a request whose
    // prompt is over 100,000 tokens pays higher prices … Each request is priced on its own"):
    // $0.50 / $2.50, 5m writes $0.625, 1h writes $1, hits $0.05; batch $0.25 / $1.25.
    costTiers: [
      {
        overInputTokens: 100_000,
        costInputPer1m: 0.5,
        costOutputPer1m: 2.5,
        costCacheWritePer1m: { fiveMinute: 0.625, oneHour: 1 },
        costBatchPer1m: { input: 0.25, output: 1.25 },
        cacheReadPer1m: 0.05,
      },
    ],
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // OV Good to know: "The minimum cacheable prompt length is 512 tokens."
      // Cache read stays the standard 0.1× (OV: "prompt caching reads cost 10%
      // of the base input price"; $0.01 / $0.10).
      cache: { ...ANTHROPIC_LOWERING_BASE.cache, minTokens: 512 },
      // alpha.134 (R1) — `thinking_control` is NOT listed: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking.md,
      // read 2026-11-15T06:45:59Z), per-model table row "Claude Haiku 5.5": `"enabled"` with
      // `budget_tokens` → "400 error", `"between_tools"` → "400 error", `"disabled"` → "Thinking off
      // at `high` effort or below" — accepted, so the model does not reject both halves of the
      // shape's definition. The two rejected types are gated by THINKING_TYPES_REJECTED.
      // (was: rejects ['thinking_control', 'sampling_params', 'assistant_prefill'], until alpha.134 —
      // a correction from the page: a consumer reading `rejects` concluded `disabled` could not be sent.)
      rejects: ['sampling_params', 'assistant_prefill'],
      // The same page: "Claude Haiku 5.5 also has thinking on by default and accepts `thinking:
      // {type: "disabled"}` at effort `high` or below. At `xhigh` or `max` effort, that combination
      // returns a 400 error."
      thinkingOff: { type: 'disabled', effortAtMost: 'high' },
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Haiku 5.5 supports all five effort levels, and
      // `medium` is the default"; `max` "Available on … Claude Haiku 5.5"; "Set `output_config.effort`
      // on the request".
      effort: { field: 'output_config.effort', default: 'medium', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 from Anthropic — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['speed', 'cost', 'classification', 'cache_friendly'],
    weaknesses: ['complex_reasoning', 'large_tool_sets'],
    notes:
      'Claude Haiku 5.5 (doc-read 2026-10-25). The page: "built for high-volume, latency-sensitive work such as classification, routing, extraction, and subagent tasks." PRICED BY PROMPT LENGTH: ≤100K prompt tokens $0.10/$0.50 (cache read $0.01), >100K $0.50/$2.50 (cache read $0.05) — every request on its own, cache reads and writes counted; the cost scorer prices the >100K tier from costTiers (alpha.128, priceAtInput) and the cliff still warns about the step. 1M ctx, 128K out, adaptive thinking on by default, default effort medium, cutoff Jun 2026, retirement not sooner than 2027-10-07. Tokenizer: the 4.7+ tokenizer — the same text is ≈30% more tokens than on Haiku 4.5; large images cost more (high-resolution tier). Rejects (400) thinking enabled/between_tools, temperature/top_p/top_k, assistant prefill — kgauto drops them and says so; thinking disabled is ACCEPTED at effort high or below; forced tool_choice is ACCEPTED (the response starts with the tool call, no thinking block). Thinking blocks are account-bound (another account\'s replay: dropped silently) and append-only-bound (a block sent back after a change to system/tools/earlier messages → 400 on accounts created after 2026-08-31); it reads blocks from Sonnet 5, Opus 4.8, Haiku 4.5 and earlier, not from Opus 5, Opus 5.5, Sonnet 5.5, Fable or Mythos; only Opus 5.5 and Sonnet 5.5 read its blocks (call() strips them on any other fallover and says so). stop_reason "refusal" possible (safety classifiers, no server-side fallback). Priority Tier not supported. Comparative latency on the overview: "Fastest". archetypePerf is JUDGMENT, 0 brain rows.',
    family: 'claude-haiku',
    // alpha.125 (amendment 4b) — four golden runs, candidate claude-haiku-5-5
    // vs incumbent claude-haiku-4-5, judge claude-opus-5, bar 80% win-or-tie
    // (kgauto_golden_eval_runs, read 2026-10-25). MEASURED NON-INFERIOR on
    // ask / summarize / extract. On ask and extract → EQUAL to haiku-4-5's prior;
    // the `claude-haiku` family head still stays on haiku-4-5, by the versionAdded
    // tiebreak (5.5 unstamped sorts oldest; bundled ties fall to id ASC). On
    // summarize → 7, NOT haiku-4-5's 8: #46 measured against haiku-4-5, not
    // against gemini-2.5-flash, so 8 would be haiku-4-5's prior arguing with the
    // summarize head (the alpha.106 one-opinion rule went red at 8); the
    // haiku-5-5 vs gemini-2.5-flash run on playbacksam summarize is the next
    // thread's. 7 ties the head, so the head's tie rule holds.
    // BELOW-BAR on classify → held at 5, under ARCHETYPE_FLOOR_DEFAULT (6,
    // compatibility.ts): neither a family-head candidate nor a cost-mode pick
    // on classify. Everything else: haiku-4-5 minus one, unmeasured.
    // (was: haiku-4-5 minus one on every archetype, until the runs landed 2026-10-25.)
    archetypePerf: {
      classify: 5,    // #47 tt-intelligence/classify 1W/21T/8L = 73% < 80% BELOW-BAR → below the floor (6)
      // alpha.130 — 7 → 8, on #46 (playbacksam/summarize, 23W/1T/2L of 26 = 92 % not worse vs
      // claude-haiku-4-5, the 8-scored model → the incumbent's score, the writer's R2 anchor). alpha.125
      // held it at 7 only so it would not argue with the then-head gemini-2.5-flash (7). This release
      // makes it the summarize HEAD with haiku-4-5 (8) directly behind it: at 7 the scorer served
      // haiku-4-5 over the head on the starter chain itself (scorer-took-claude-haiku-4-5-over-claude-haiku-5-5;
      // tests/one-opinion.test.ts, "plain compile on EVERY starter chain picks the chain head"). At 8 the
      // two tie and caller order keeps the head. #56 (vs gemini-2.5-flash, 58 %, below-bar) does not
      // lower it: it measured against a different, retiring ruler. (was: 7, until 2026-11-09)
      summarize: 8,
      ask: 7,         // #45 playbacksam/ask 6W/22T/2L = 93% PROMOTE-READY → = haiku-4-5
      transform: 6,   // unmeasured — haiku-4-5 minus one
      extract: 7,     // #44 playbacksam/extract 23W/4T/3L = 90% PROMOTE-READY → = haiku-4-5
      hunt: 5,        // unmeasured — haiku-4-5 minus one
      generate: 5,    // unmeasured — haiku-4-5 minus one
      plan: 4,        // unmeasured — haiku-4-5 minus one
      critique: 3,    // unmeasured — haiku-4-5 minus one
    },
  },

  // ── Google ──
  {
    id: 'gemini-2.5-flash',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'google',
    // alpha.130 — `legacy` on the provider's DATED retirement (alpha.126's second trigger), written
    // once it heads nothing (amendment B3): Google's page (read 2026-11-03, below) deprecates it with
    // shutdown 2026-12-01, routed to gemini-3.5-flash-lite. It left every starter chain this release —
    // classify → gemini-3.5-flash-lite (golden run #55), hunt → gemini-3.8-flash (the retirement),
    // summarize → claude-haiku-5-5 (amendment C, runs #56–#59), transform's cost floor removed. The
    // model row stays active: consumers pin it by name until 12-01, and the stale-model advisory names
    // each archetype's new head. Its archetypePerf stays as the legacy record (amendment C3).
    // (was: 'current', until 2026-11-09)
    status: 'legacy',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-2.5-flash;
    // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash 301s there): Versions row "Deprecated:
    // `gemini-2.5-flash` (effective December 1, 2026, automatically routed to `gemini-3.5-flash-lite`)",
    // and the caution box "is deprecated and is no longer available to select in Google AI Studio (API
    // access is limited to existing users until December 1, 2026)". The deprecations page
    // (https://aistudio.google.com/docs/deprecations, same day; ai.google.dev/gemini-api/docs/deprecations
    // 301s there) lists it with Shutdown date "December 1, 2026" (the page: "the *earliest possible
    // dates*") and Recommended replacement `gemini-3.5-flash-lite`. Google's own words are Stable / Preview
    // / Deprecated (/ Shut down); Stable and Preview — served, not deprecated — are written `active`.
    // `status` above is unchanged: it moves on a measurement (golden eval), on the provider's `retired`, or
    // when the seat records why — never on this field.
    // HEAD OF THREE STARTER CHAINS (hunt / summarize / classify) on the alpha.127 build day: the page's
    // `deprecated` was a routing question for the seat, answered by alpha.130 (the heads moved; status above).
    providerLifecycle: { status: 'deprecated', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-2.5-flash', retirementFloor: '2026-12-01', replacement: 'gemini-3.5-flash-lite' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash — the page says 'Inputs: Text, images, video, audio' (no PDF on the page).
    inputModalities: ['text', 'image', 'audio', 'video'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_535,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        // alpha.103 — MEASURED 2026-09-03 (direct, thinking default, 1.5K-token
        // classify fixture): cap 300 → MAX_TOKENS 2/2 with 284/287 thought
        // tokens and 9–11 output tokens; thinkingBudget 0 → STOP, 84 tokens.
        // alpha.104 — the threshold is 513: one above the LARGEST cap
        // measured to BREAK, not a guessed hold. 2.5-flash thinks up to the
        // cap it is given (thoughts 284–285 at 300, 487–488 at 512 — the
        // budget scales with the ceiling), so every cap ≤ 512 is a measured
        // break (6/6, 2026-09-03 + 09-04); 1024 is unmeasured (the key's
        // quota, both days). The rule therefore fires on caps ≤ 512 and on
        // nothing kgauto has not measured (P4). tt-intelligence (09-04): a
        // rule at threshold 1 was "a guard that cannot fire" — correct.
        metric: 'thinking_with_short_output',
        threshold: 513,
        action: 'force_thinking_budget_zero',
        reason:
          'Thinking tokens consume maxOutputTokens and the budget scales with the cap: at 300 the call stopped at MAX_TOKENS after ~285 thoughts (5/5), at 512 after ~488 thoughts (3/3); with thinkingBudget 0 the same prompt finished at 300 with valid JSON (measured 2026-09-04). The smallest cap above 512 that holds has not been measured.',
        evidence: { class: 'probed', lastProbed: '2026-09-04', verdict: 'confirmed' },
      },
    ],
    probedLimits: [
      {
        metric: 'thinking_with_short_output',
        testedAt: 512,
        outcome: 'broke',
        trials: 3,
        lastProbed: '2026-09-04',
        route: 'direct',
        claim:
          'Measured 2026-09-04 (scripts/probe-thinking-held-point.mjs, direct): 1.5K-token classify prompt, thinking default, cap 300 → MAX_TOKENS 3/3 (thoughts 284–285, 11–12 output tokens); cap 512 → MAX_TOKENS 3/3 (thoughts 487–488, 20–21 output tokens); cap 1024 → 429 quota, unmeasured.',
      },
    ],
    costInputPer1m: 0.3,
    costOutputPer1m: 2.5,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-2.5-flash`:
    //   Batch tab: $0.15 (text / image / video; audio $0.50) / $1.25; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.15, output: 1.25 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // alpha.128 (seat ruling R-B) — cache discount 0.25 → 0.10, read 2026-11-06 on
      // https://aistudio.google.com/docs/pricing, section `gemini-2.5-flash`, Standard tab:
      // "Context caching price" $0.03 (text / image / video) of the $0.30 input = 0.1×.
      // (was: 0.25, inherited from GOOGLE_LOWERING_BASE, until 2026-11-06)
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Known: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['speed', 'volume', 'classification', '1m_context', 'cost'],
    weaknesses: ['complex_schemas', 'large_tool_sets', 'high_context_quality'],
    notes:
      'Fast and cheap with 1M context. Quality cliffs at 8K context and 20 tools — guard with cliffs.',
    // Master plan §6.2 anchor. Tier 0 for hunt (parallel tool throughput
    // 15-75 calls/step beats Sonnet — L-040), summarize, classify.
    archetypePerf: {
      hunt: 9,        // L-040: parallel tool throughput 15-75/step
      classify: 7,    // brain-validated, 218 rows
      summarize: 7,   // brain-validated; cliff strips tools when present
      transform: 7,
      ask: 7,
      generate: 6,
      plan: 5,
      extract: 6,     // alpha.8 MAX_TOKENS history on structured output
      critique: 4,    // reasoning shallower than Sonnet/Opus
    },
  },
  {
    // ── Gemini 2.5 Flash-Lite ──
    // Onboarded 2026-05-13 (s22) after the model-release watcher surfaced
    // it as a UNREGISTERED + NEW candidate. Released by Google July 2025,
    // stable. Positioned BELOW Flash on the cost/perf frontier:
    //   input  $0.10/M (Flash $0.30/M)   — 3× cheaper
    //   output $0.40/M (Flash $2.50/M)   — 6× cheaper
    //   cache  $0.01/M                    — 1/10 of input (vs Flash 0.25 discount)
    // Cliffs are HYPOTHESIZED from Flash's known failure modes — Flash-Lite
    // is a smaller sibling, so we inherit Flash's cliffs at equal-or-tighter
    // thresholds. The brain will validate/relax these as evidence accumulates
    // per (archetype, model) tuple. Currently ZERO brain rows for this model.
    id: 'gemini-2.5-flash-lite',
    verifiedAgainstDocs: '2026-08-27',
    provider: 'google',
    // alpha.91 — AVAILABILITY demotion, same class as gemini-2.5-pro below.
    // Google refuses the model for newer account cohorts: "This model is no
    // longer available to new users. Please update your code to use
    // models/gemini-3.5-flash-lite" (tt-intel TT-49 runtime evidence,
    // 2026-08-26, interfaces/kgauto.md ## Requested). It ranked FIRST in
    // getFallbackChain('gemini-2.5-pro') — a dead-for-new-accounts model as
    // the cheapest fallback pick. `legacy` removes it from chains and new
    // selection; explicit-id consumers still resolve it. Successor is the
    // one Google's own error names: gemini-3.5-flash-lite (onboarded this
    // release, same price point).
    status: 'legacy',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-2.5-flash-lite;
    // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite 301s there): Versions row "Stable:
    // `gemini-2.5-flash-lite`", and the box "`gemini-2.5-flash-lite` is not deprecated and will continue to
    // be served until further notice through the API". The deprecations page
    // (https://aistudio.google.com/docs/deprecations, same day; ai.google.dev/gemini-api/docs/deprecations
    // 301s there) lists it with Shutdown date "No shutdown date announced", no replacement. Google's own
    // words are Stable / Preview / Deprecated (/ Shut down); Stable and Preview — served, not deprecated —
    // are written `active`. `status` above is unchanged: it moves on a measurement (golden eval), on the
    // provider's `retired`, or when the seat records why — never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-2.5-flash-lite' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite — the page says 'Inputs: Text, image, video, audio, PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
    ],
    costInputPer1m: 0.1,
    costOutputPer1m: 0.4,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-2.5-flash-lite`:
    //   Batch tab: $0.05 (text / image / video; audio $0.15) / $0.20; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.05, output: 0.2 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // Cache discount 10× (vs Flash 4×) — Google's spec is $0.01/M cache vs
      // $0.10/M input. Material for repeat-prompt workloads (classify shape).
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Known on Flash family: empty after tool result — retry with thinking off.',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off.',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target.',
      },
    ],
    strengths: ['lowest_cost', 'speed', 'volume', 'classification', 'summarize', '1m_context', 'cache_friendly'],
    weaknesses: ['complex_reasoning', 'large_tool_sets', 'complex_schemas', 'structured_output_unproven', 'long_context_quality'],
    notes:
      'Bottom-frontier anchor on cost: $0.10/$0.40 per 1M tokens, 1M context, 65K max output. Released July 2025 (stable). Positioned for classify / summarize / transform archetypes where quality bar is forgiving. Cliffs inherited from Flash at equal-or-tighter thresholds — re-tune per (archetype) once brain has n≥20 rows. Alpha.8 contract layer handles MAX_TOKENS-on-structured-output via fallback chain, so structuredOutput=native is safe to declare even though Flash had alpha.8 history. Cache discount in spec: $0.01/M = 1/10 of input (richer than Flash 25%) — meaningful for repeat-prompt workloads.',
    // Tier 3 emergency floor for summarize/classify chains. ZERO brain
    // rows — all values are starter hypotheses anchored to "smaller
    // sibling of Flash, at-or-below Flash perf on every archetype." The
    // first 50 brain rows per archetype will validate or relax these.
    archetypePerf: {
      classify: 6,    // starter hypothesis — verify (Flash is 7, lite likely ≤)
      summarize: 6,   // starter hypothesis — verify; cliff strips tools
      transform: 6,   // starter hypothesis — verify
      ask: 5,
      hunt: 5,
      generate: 4,
      extract: 4,
      plan: 3,
      critique: 3,
    },
  },
  {
    id: 'gemini-2.5-pro',
    verifiedAgainstDocs: '2026-08-08',
    provider: 'google',
    // alpha.86 — AVAILABILITY demotion, not a provider-lifecycle mirror.
    // Google's docs still list 2.5-pro as Stable, but the serving layer
    // disagrees per account cohort: tt-intel measured 4/4 refusals
    // ("no longer available to new users", 2026-08-02, their bench), and
    // kgauto's own key 429s on a FreeTier per-day quota (probed
    // 2026-08-08). A chain anchor that hard-fails for whole account
    // cohorts is not an anchor; `legacy` removes it from cost-ordered
    // chains and new selection while keeping the profile resolvable for
    // consumers who pass it explicitly. Re-promotion is one status flip
    // if Google restores availability. The registry cannot yet express
    // account-cohort availability as data — see interfaces/kgauto.md
    // ## Requested 2026-08-02.
    status: 'legacy',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-2.5-pro;
    // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro 301s there): Versions row "Deprecated:
    // `gemini-2.5-pro` (effective December 1, 2026, automatically routed to `gemini-3.8-flash`)", and the
    // caution box "is deprecated and is no longer available to select in Google AI Studio". The
    // deprecations page (https://aistudio.google.com/docs/deprecations, same day;
    // ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "December 1, 2026"
    // and Recommended replacement `gemini-3.8-flash`. Google's own words are Stable / Preview / Deprecated
    // (/ Shut down); Stable and Preview — served, not deprecated — are written `active`. `status` above is
    // unchanged: it moves on a measurement (golden eval), on the provider's `retired`, or when the seat
    // records why — never on this field.
    providerLifecycle: { status: 'deprecated', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-2.5-pro', retirementFloor: '2026-12-01', replacement: 'gemini-3.8-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro — the page says 'Inputs: Audio, images, video, text, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_535,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 200_000,
        action: 'downgrade_quality_warning',
        reason: 'Pricing doubles above 200K prompt tokens: input $1.25→$2.50/M, output $10→$15/M (https://aistudio.google.com/docs/pricing, read 2026-11-15).',
      },
    ],
    costInputPer1m: 1.25,
    costOutputPer1m: 10.0,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-2.5-pro`:
    //   Batch tab: $0.625 / $5.00 for "prompts <= 200k tokens"; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    //   The over-200K step, same page and read: Standard tab "prompts > 200k": $2.50 / $15.00, context caching $0.25; Batch tab "prompts > 200k": $1.25 / $7.50.
    costBatchPer1m: { input: 0.625, output: 5 },
    costTiers: [
      {
        overInputTokens: 200_000,
        costInputPer1m: 2.5,
        costOutputPer1m: 15,
        costBatchPer1m: { input: 1.25, output: 7.5 },
        cacheReadPer1m: 0.25,
      },
    ],
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // alpha.128 (seat ruling R-B) — cache discount 0.25 → 0.10, read 2026-11-06 on
      // https://aistudio.google.com/docs/pricing, section `gemini-2.5-pro`, Standard tab:
      // "Context caching price" $0.125 of the $1.25 input for prompts <= 200k = 0.1×
      // (> 200k: $0.25 of $2.50, also 0.1×; carried as the tier's cacheReadPer1m above).
      // (was: 0.25, inherited from GOOGLE_LOWERING_BASE, until 2026-11-06)
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL — escalate',
      },
    ],
    strengths: ['reasoning', '1m_context', 'structured_output', 'tool_use'],
    weaknesses: ['pricing_above_200k', 'availability_restricted_by_account_cohort'],
    // Master plan §3.3 anchor: tier-2 cross-provider in almost every chain.
    // Sits on the frontier at perf-9 — close to Sonnet but cheaper input.
    archetypePerf: {
      critique: 9,
      plan: 9,
      ask: 8,
      generate: 8,
      extract: 8,
      transform: 8,
      hunt: 8,        // tier 1 cross-provider for hunt chain
      summarize: 7,
      classify: 7,
    },
  },
  {
    id: 'gemini-3.1-pro-preview',
    verifiedAgainstDocs: '2026-08-14',
    provider: 'google',
    status: 'preview',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.1-pro-preview;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview 301s there): Versions row
    // "Preview: `gemini-3.1-pro-preview`". The deprecations page
    // (https://aistudio.google.com/docs/deprecations, same day; ai.google.dev/gemini-api/docs/deprecations
    // 301s there) lists it under Gemini 3 "Preview models" with Shutdown date "No shutdown date announced",
    // no replacement. Google's own words are Stable / Preview / Deprecated (/ Shut down); Stable and
    // Preview — served, not deprecated — are written `active`. `status` above is unchanged: it moves on a
    // measurement (golden eval), on the provider's `retired`, or when the seat records why — never on this
    // field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.1-pro-preview' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_535,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 200_000,
        action: 'downgrade_quality_warning',
        reason: 'Pricing doubles above 200K prompt tokens: input $2→$4/M, output $12→$18/M (https://aistudio.google.com/docs/pricing, read 2026-11-15).',
      },
    ],
    costInputPer1m: 2.0,
    costOutputPer1m: 12.0,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3.1-pro-preview`:
    //   Batch tab: $1.00 / $6.00 for "prompts <= 200k tokens"; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    //   The over-200K step, same page and read: Standard tab "prompts > 200k": $4.00 / $18.00, context caching $0.40; Batch tab "prompts > 200k": $2.00 / $9.00.
    costBatchPer1m: { input: 1, output: 6 },
    costTiers: [
      {
        overInputTokens: 200_000,
        costInputPer1m: 4,
        costOutputPer1m: 18,
        costBatchPer1m: { input: 2, output: 9 },
        cacheReadPer1m: 0.4,
      },
    ],
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL — escalate',
      },
    ],
    strengths: ['reasoning', '1m_context', 'agentic_coding', 'structured_output', 'tool_use'],
    weaknesses: ['cost', 'preview_status', 'pricing_above_200k'],
    notes: 'Frontier Gemini (preview, 2026-Q2). Step-change agentic coding per Google. Cache discount 10× (vs 4× for 2.5 Pro). Use status=preview to flag rollback path until GA.',
    // Frontier-Gemini preview — bumped one notch over 2.5 Pro on agentic
    // coding / reasoning per Google's release notes. Preview status:
    // chains should stay on 2.5 Pro until GA. Starter hypothesis.
    archetypePerf: {
      critique: 10,   // Google claims step-change on reasoning
      plan: 10,
      ask: 9,
      generate: 9,
      extract: 9,
      transform: 8,
      hunt: 9,        // step-change agentic per Google
      summarize: 8,
      classify: 7,
    },
  },

  // ── DeepSeek ──
  // 2026-05-08 audit (L-073): DeepSeek's `deepseek-chat` was silently aliased
  // to `deepseek-v4-flash` non-thinking mode. Old kgauto profile claimed 64k
  // context + $0.27/$1.10 — actual is 1M context + $0.14/$0.28. Modeled since
  // as canonical profiles + provider aliases (see ALIASES below).
  // 2026-09-10 (alpha.109): the same shape again, one generation on —
  // DeepSeek retired V4-Flash, kept `deepseek-v4-flash` answering 200, and
  // serves it from V4.1-Flash (`deepseek-flash`). The retired id is an alias
  // now; `deepseek-flash` is the canonical Flash profile.
  {
    // alpha.109 — DeepSeek-V4.1-Flash, released 2026-09-10 (news260910). Step
    // zero done 2026-09-11 against api-docs.deepseek.com/quick_start/pricing:
    // "1M" context, "384K" max output, "Supports both non-thinking and
    // thinking (default) modes" (thinking default effort `high`, guides/
    // thinking_mode), prices PEAK $0.30 in / $1.20 out / cache-hit $0.006
    // (off-peak = 50% of peak; peak = 01:00-04:00 + 06:00-10:00 UTC Mon-Fri).
    // The provider's own aliases `deepseek-chat` / `deepseek-reasoner` and the
    // retired `deepseek-v4-flash` all serve this model (ALIASES below; the
    // retired id keeps its own legacy profile). Capability fields other than
    // the docs numbers are INHERITED from V4-Flash's measurements and labelled
    // so: V4.1 has not been probed by this seat (no DeepSeek key here).
    id: 'deepseek-flash',
    verifiedAgainstDocs: '2026-09-11',
    versionAdded: '2.0.0-alpha.109',
    provider: 'deepseek',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://api-docs.deepseek.com/quick_start/pricing (HTTP 200),
    // https://api-docs.deepseek.com/updates (the change log; https://api-docs.deepseek.com/news/ answered
    // 200 with the first-call page, no news list) and https://api-docs.deepseek.com/news/news261017. The
    // only lifecycle word names OTHER ids (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`: "the
    // corresponding models have been retired"); of V4 Pro the change log says only "continue providing API
    // services for DeepSeek V4 Pro after September 14, 2026 … We will provide further notice should there
    // be any changes" — a continuation, not a lifecycle word. No page states a lifecycle word for `deepseek-flash`, so none is written.
    maxContextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    maxTools: 16,
    // Inherited: measured on V4-Flash 2026-08-28 (3 parallel calls 3/3, 6 tools
    // offered). Unknown must not reduce (alpha.97): carried as-is.
    parallelToolCalls: true,
    // Inherited: V4 rejected `json_schema` outright and honoured `json_object`
    // only with the literal word "json" in the prompt (measured 2026-08-29);
    // the lowering emits that instruction for every DeepSeek profile.
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // The V4-Flash cliff (alpha.101, probed 2026-09-03: at max_tokens 300
        // the reasoning burn emptied the text channel 3/3; 512 held 3/3) —
        // and the bad shape REPRODUCED on V4.1-Flash itself: the release
        // watcher's direct probes of 2026-09-10 (`advisory/kgauto/from-
        // command-center/2026-09-10_deepseek-v4-flash-is-now-a-thinking-
        // alias.md`) got EMPTY text with finish=length at max_tokens 16 (2/2)
        // and intact text at 100/300 (6/6), reasoning 65-82% of billed
        // completion tokens. So `probed`/`confirmed` is the honest class: the
        // guard's mechanism is confirmed on this model; the KNEE (512) is the
        // V4 measurement, conservative for a one-sentence prompt, unmeasured
        // for the 1.5K-token classify shape on V4.1. Disabling thinking under
        // a cap that cannot hold the burn is strictly not-worse-than-raw.
        metric: 'thinking_with_short_output',
        threshold: 512,
        action: 'force_thinking_budget_zero',
        reason:
          'Reasoning-default model under a tight output cap: V4-Flash emptied the text channel at max_tokens 300 (3/3, probed 2026-09-03; 512 held); V4.1-Flash reproduced the shape at max_tokens 16 (2/2 empty, 2026-09-10) and reasoning took 65-82% of billed completion tokens at 100/300. Knee (512) carried from V4.',
        evidence: { class: 'probed', lastProbed: '2026-09-10', verdict: 'confirmed' },
      },
    ],
    probedLimits: [
      {
        // V4-Flash, 2026-09-03 (alpha.101) — the knee this cliff carries.
        metric: 'thinking_with_short_output',
        testedAt: 512,
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-09-03',
        route: 'direct',
        claim:
          'Measured 2026-09-03 on V4-Flash (retired 2026-09-10): thinking on, max_tokens 512, 1.5K-token classify prompt → finish=stop 3/3 (completion 250–369). At 300 the same prompt broke 3/3.',
      },
      {
        // V4.1-Flash, 2026-09-10 — the release watcher's direct probe, not
        // the probe suite: one-sentence summarize, max_tokens 16.
        metric: 'thinking_with_short_output',
        testedAt: 16,
        outcome: 'broke',
        trials: 2,
        lastProbed: '2026-09-10',
        route: 'direct',
        claim:
          'Measured 2026-09-10 on V4.1-Flash (release watcher, direct): thinking on, max_tokens 16 → reasoning consumed the budget, content empty, finish=length 2/2; at 100 and 300 the text was intact 6/6 with reasoning 65-82% of billed completion tokens.',
      },
      {
        // Inherited from V4-Flash (2026-09-04, probe-tool-as-text.mjs).
        metric: 'tool_count',
        testedAt: 12,
        demanded: 1,
        served: [2, 1, 2],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-09-04',
        route: 'direct',
        claim:
          'Measured 2026-09-04 on V4-Flash: ask-shaped prompt, 12 tools, tool_choice auto, thinking on → tool_calls 3/3 (query_creators every trial, 1–2 calls). Carried to V4.1 unre-probed.',
      },
    ],
    costInputPer1m: 0.3,
    costOutputPer1m: 1.2,
    // alpha.128 — prices read 2026-11-06 on https://api-docs.deepseek.com/quick_start/pricing (its .md form; the HTML at that URL served
    //   "Your First API Call" that day): input cache hit / miss and output, PEAK and OFF-PEAK (half) —
    //   no cache-write, batch or prompt-length price, so none is written.
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported' },
      tools: { format: 'deepseek' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
    ],
    strengths: ['cost', '1m_context', 'json_output', 'code', 'reasoning'],
    // Inherited from V4-Flash (explicitly unverified there too: the 08-28
    // probe offered 6 of a declared maxTools 16).
    weaknesses: ['large_tool_sets'],
    // Inherited: V4-Flash measured 20485 ms served (2026-06-03). V4.1's
    // architecture note (8B active for input, 16B for output) suggests faster;
    // unmeasured, so the conservative tier stays until a probe says otherwise.
    latencyTier: 'slow',
    notes: 'DeepSeek-V4.1-Flash (2026-09-10). 1M context, 384K max output, thinking ON by default at effort high (docs: guides/thinking_mode) — reasoning tokens bill as output and count against max_tokens; the release watcher measured 65-82% of billed completion tokens as reasoning on a one-sentence summarize at max_tokens 100/300 (6 probes, identical text). Prices are the PEAK rate ($0.30/$1.20, cache-hit $0.006); off-peak (all hours outside 01:00-04:00 + 06:00-10:00 UTC Mon-Fri) is half. Serves `deepseek-chat`, `deepseek-reasoner` and the retired `deepseek-v4-flash` ids. archetypePerf inherited from V4-Flash (classify brain-validated on V4, n=169) — V4.1 unmeasured until the delta report replays it.',
    archetypePerf: {
      classify: 7,    // inherited — brain-validated on V4-Flash (169 rows)
      summarize: 7,   // inherited
      ask: 6,
      transform: 6,
      generate: 5,
      plan: 5,
      extract: 5,
      critique: 4,
      hunt: 6,        // inherited — L-040 correction (alpha.96): the only hunt-shaped evidence was parallel tool calls 3/3
    },
    // alpha.43 — family-level conventions for the `deepseek-chat` family
    // (carried from the V4-Flash profile; the evidence is family evidence).
    archetypeConventions: [
      {
        archetype: 'summarize',
        structuredOutputHint: 'avoid',
        cliffWarning:
          'deepseek-chat family schema compliance on summarize is weak (3 of 4 schema-attempted PB calls hit structured_output_parse_failed). Consider routing summarize+structured-output to a different family (claude-sonnet, gemini-pro, openai-gpt-5.4) or dropping the schema for free-text summaries.',
        reason:
          'Brain evidence: PB compile_outcomes 2026-05-18 + 2026-05-22, error_type=structured_output_parse_failed on deepseek-v4-flash + summarize archetype (V4-Flash; V4.1 unmeasured).',
      },
    ],
  },
  {
    id: 'deepseek-v4-pro',
    // alpha.109 — re-verified 2026-09-11 on the pricing page: PEAK $1.32/$3.96
    // unchanged. The 2026-09-10 release note said V4 Pro requests would route
    // to V4.1-Flash at Flash rates from 2026-09-14 04:00Z; the pricing page
    // now says "we have decided to continue providing API services for
    // DeepSeek V4 Pro after September 14, 2026, with the billing method
    // remaining unchanged." Stays `current`; `servedModel` on every response
    // is the tripwire if that reverses.
    verifiedAgainstDocs: '2026-09-11',
    provider: 'deepseek',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://api-docs.deepseek.com/quick_start/pricing (HTTP 200),
    // https://api-docs.deepseek.com/updates (the change log; https://api-docs.deepseek.com/news/ answered
    // 200 with the first-call page, no news list) and https://api-docs.deepseek.com/news/news261017. The
    // only lifecycle word names OTHER ids (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`: "the
    // corresponding models have been retired"); of V4 Pro the change log says only "continue providing API
    // services for DeepSeek V4 Pro after September 14, 2026 … We will provide further notice should there
    // be any changes" — a continuation, not a lifecycle word. No page states a lifecycle word for `deepseek-v4-pro`, so none is written.
    maxContextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    maxTools: 16,
    // alpha.96 — CORRECTED from `false`, which was AI-generated at greenfield
    // (2026-04-25) and never re-checked. Measured 2026-08-28 direct to
    // api.deepseek.com, no kgauto in the path, 6 tools offered, 3 trials:
    // 3 parallel tool calls returned, 3/3. L-040's original evidence said
    // "7-8 calls per step" — which was never a claim that only one tool may be
    // offered. See the note in lower.ts:lowerDeepSeek.
    parallelToolCalls: true,
    structuredOutput: 'grammar', // alpha.99 — MEASURED 2026-08-29: DeepSeek rejects
    // `response_format: {type:'json_schema'}` outright ("This response_format type is
    // unavailable now"), so there is no schema-enforced mode for `'native'` to name.
    // It supports `json_object` only, and only when the prompt contains the literal
    // word "json" — the lowering emits the instruction that guarantees it.
    systemPromptMode: 'inline',
    streaming: true,
    // alpha.96 — the `tool_count@1 -> drop_to_top_relevant` cliff was DELETED.
    // It restated `parallelToolCalls: false` as a threshold and was falsified by
    // the same measurement. It is not kept-and-flagged (the usual lifecycle)
    // because it was never a real failure mode: it was a second enforcement of a
    // wrong belief, and keeping it active would keep amputating tools.
    cliffs: [
      {
        // alpha.101 — MEASURED 2026-09-03, same protocol as v4-flash (direct
        // to api.deepseek.com, 1.5K-token classify prompt, thinking on):
        //   max_tokens 300  → finish=length, reasoning=300, EMPTY text, 3/3
        //   max_tokens 512  → 1 of 3 broke (reasoning=512, empty text)
        //   max_tokens 1024 → finish=stop, 3/3 (completion 456–641)
        // Thinking off at 300 → finish=stop, 113 tokens, valid JSON. Pro
        // reasons longer than Flash, so its held point is one step higher.
        metric: 'thinking_with_short_output',
        threshold: 1024,
        action: 'force_thinking_budget_zero',
        reason:
          'Reasoning-default model under a tight output cap: at max_tokens 300 the text channel was empty 3/3 and at 512 1/3 (probed 2026-09-03). 1024 held 3/3.',
        evidence: { class: 'probed', lastProbed: '2026-09-03', verdict: 'confirmed' },
      },
    ],
    probedLimits: [
      {
        metric: 'thinking_with_short_output',
        testedAt: 1024,
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-09-03',
        route: 'direct',
        claim:
          'Measured 2026-09-03: thinking on, max_tokens 1024, 1.5K-token classify prompt → finish=stop 3/3 (completion 456–641). At 512 the same prompt broke 1/3; at 300, 3/3.',
      },
    ],
    // Verified against the live DeepSeek pricing page 2026-06-22: the 75%-off
    // launch "promo" ($0.435/$0.87) did NOT revert on 2026-05-31 — it became the
    // standing price (docs show $0.435 in / $0.87 out cache-miss, $0.003625
    // cache-hit in; no promo caveat). The old $1.74/$3.48 "regular post-promo"
    // was a projected revert that never happened (L-073/L-081) — it 4×-overstated
    // cost and suppressed V4-Pro in cost-aware ranking.
    costInputPer1m: 1.32,
    costOutputPer1m: 3.96,
    // alpha.128 — prices read 2026-11-06 on https://api-docs.deepseek.com/quick_start/pricing (its .md form; the HTML at that URL served
    //   "Your First API Call" that day): input cache hit / miss and output, PEAK and OFF-PEAK (half) —
    //   no cache-write, batch or prompt-length price, so none is written.
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported' },
      tools: { format: 'deepseek' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
    ],
    strengths: ['quality', 'reasoning', '1m_context', 'json_output', 'code', 'extended_thinking'],
    // alpha.96 — 'parallel_tools' REMOVED: measurably false (2026-08-28, direct
    // to api.deepseek.com, 6 tools, 3 trials, 3 parallel calls, both models).
    // 'large_tool_sets' KEPT and explicitly unverified — the probe offered 6 of
    // a declared maxTools 16, so it says nothing about behaviour at 16. Not
    // falsified is not the same as confirmed.
    weaknesses: ['large_tool_sets'],
    // alpha.47 — explicit slow override. Measured 47722ms on the alpha.46
    // shadow probe (2026-06-03) — it's an extended-thinking reasoner, slowest
    // of the served set. Tag derivation would say 'medium'; the measurement says
    // otherwise.
    latencyTier: 'slow',
    notes: 'Pro tier. 1M context, 384k max output. $0.435/$0.87 per 1M (cache-hit in $0.003625) — verified live 2026-06-22; the launch promo became the standing price (no revert). Default mode = thinking. PEAK/OFF-PEAK since 2026-08-16 (page fetched 2026-08-24): peak = weekdays 01:00-04:00 + 06:00-10:00 UTC, off-peak = all other hours at HALF peak. Encoded prices ARE the peak rate (conservative: never understate cost); off-peak traffic costs half what the estimate says. alpha.87 was built + verified 2026-08-14 (prices then live), held at the publish gate 10 days, and published 2026-08-24 — by which time the 08-16 transition had killed them ($0.14/$0.28 flash, $0.435/$0.87 pro); corrected here (alpha.88). Build-then-hold is the mechanism: re-verify prices at publish when publish is not same-session as build. A single price field cannot represent a two-rate schedule; catalog-sync extractions oscillate between the rates day-to-day (peak read 08-21, off-peak read 08-22) — time-of-day pricing remains unmodeled, roadmap.',
    // Master plan §3.3: tier 3 cross-provider for plan chain. Reasoning
    // bumped one notch over V4-Flash; same parallel-tool ceiling.
    archetypePerf: {
      plan: 7,        // §3.3 tier 3 for plan
      critique: 6,
      ask: 7,
      generate: 6,
      classify: 7,
      summarize: 7,
      extract: 6,
      transform: 6,
      // alpha.96 — was 4. Its ONLY written justification was "sequential tool
      // calls only — L-040", which is falsified. A score derived from a false
      // premise cannot be kept, and re-guessing a penalty would just relaunder
      // the same belief. Set to the floor (6) = "no evidence of deficiency",
      // NOT an endorsement. This is a JUDGMENT, not a measurement, and it is
      // the honest direction of the two: the only hunt-shaped evidence we have
      // is positive (a research-agent fixture, 3 of 3 demanded tools correctly
      // selected from a 6-tool menu, 3/3 trials, both models). Replace with a
      // real number from the golden-eval hunt corpus — that is what it is for.
      hunt: 6,
    },
    // alpha.43 — family-level conventions for the `deepseek-reasoner` family
    // (V4-Pro is the family rep; future thinking-mode members inherit).
    //
    // The decisive-archetype suffix is the load-bearing piece. ⚠️ alpha.96:
    // its evidence was purged as poison on 2026-05-29 (s51) — retained as a
    // hypothesis, not a finding. Original claim, for the record: 2026-05-28
    // first real V4-Pro probe on tt-intel/classify
    // showed 8/10 judge rationales citing "candidate hedges and fails to
    // commit to a single classification" or "candidate refuses to pick
    // among the labels." Without the forcing-function suffix, every
    // reasoner probe on classify/extract/ask verdicts stay-excluded for
    // model-behavior reasons (epistemic humility is reasoner-shaped),
    // NOT quality reasons. The suffix re-shapes the contract so the model
    // is asked for what it's actually being measured on.
    //
    // The hunt-archetype cliffWarning is the L-040 architectural reading
    // surfaced at compile time. Reasoners produce sequential reasoning
    // chains by design; hunt archetypes with 3+ parallel tools lose
    // substantial throughput (L-040 + L-041). The L-040 cliff in the
    // `cliffs` array already trims to top-relevant tools; this warning
    // tells the consumer the family is wrong for the shape so they can
    // route to gemini-flash (parallel-strong) instead of accepting trimmed
    // throughput silently.
    archetypeConventions: [
      {
        archetype: 'classify',
        promptSuffix:
          '\n\nOutput exactly one classification label. Do not hedge, do not add preamble, do not explain your reasoning. If uncertain, pick the most likely label and commit to it.',
        reason:
          'Reasoners (deepseek-reasoner family) hedge on decisive-output archetypes by design. UNEVIDENCED HYPOTHESIS as of alpha.96 — this reason used to cite a 2026-05-28 V4-Pro probe on tt-intel/classify ("8 of 10 judge rationales cited hedging") and named `brain probe_outcomes` as its source. That source is EMPTY: probed 2026-08-28, zero probe_outcomes rows exist before 2026-06-01 and zero `classify` rows have ever existed. The probe was deleted on 2026-05-29 by the s51 poison purge — it replayed against truncated `prompt_preview`, which s51 established yields meaningless verdicts. The conclusion outlived the purge of its own evidence and kept shaping prompts for three months. The pointer was wrong too: exclusion-finding ID 20 is a zero-calls `recommend-probe` on classify, confidence low, later declined — the probe TRIGGER, never its result. KEPT because a promptSuffix is capability-PRESERVING (adds an instruction, removes nothing a raw call had) and is visible in mutations_applied. Re-evidence from the golden-eval corpus or drop it.',
      },
      {
        archetype: 'extract',
        promptSuffix:
          '\n\nOutput exactly the requested structured fields. Do not hedge, do not add preamble, do not explain your reasoning. If a field is unknown, emit the field with a null/empty value and commit to that — do not refuse to extract.',
        reason:
          'Reasoners (deepseek-reasoner family) hedge on decisive-output archetypes by design. UNEVIDENCED HYPOTHESIS as of alpha.96 — the supporting evidence NO LONGER EXISTS. The cited 2026-05-28 V4-Pro classify probe ("8/10 judge rationales") was deleted on 2026-05-29 by the s51 poison purge, because it replayed against truncated `prompt_preview` and s51 established such verdicts are meaningless. Probed: zero probe_outcomes rows exist before 2026-06-01 and zero `classify` rows have EVER existed. The pointer was also wrong — exclusion-finding ID 20 is a zero-calls `recommend-probe` on classify, confidence low, later declined; it was the trigger for the probe, never its result. KEPT anyway because a promptSuffix is capability-PRESERVING (it adds an instruction and removes nothing a raw call had), so the cost of being wrong is bounded and a consumer can see it in mutations_applied. Re-evidence it from the golden-eval corpus or drop it.',
      },
      {
        archetype: 'ask',
        promptSuffix:
          '\n\nAnswer the question directly. Do not hedge, do not add preamble, do not explain your reasoning unless explicitly asked. If uncertain, give your best answer and commit to it.',
        reason:
          'Reasoners (deepseek-reasoner family) hedge on decisive-output archetypes by design. UNEVIDENCED HYPOTHESIS as of alpha.96 — the supporting evidence NO LONGER EXISTS. The cited 2026-05-28 V4-Pro classify probe ("8/10 judge rationales") was deleted on 2026-05-29 by the s51 poison purge, because it replayed against truncated `prompt_preview` and s51 established such verdicts are meaningless. Probed: zero probe_outcomes rows exist before 2026-06-01 and zero `classify` rows have EVER existed. The pointer was also wrong — exclusion-finding ID 20 is a zero-calls `recommend-probe` on classify, confidence low, later declined; it was the trigger for the probe, never its result. KEPT anyway because a promptSuffix is capability-PRESERVING (it adds an instruction and removes nothing a raw call had), so the cost of being wrong is bounded and a consumer can see it in mutations_applied. Re-evidence it from the golden-eval corpus or drop it.',
      },
      // alpha.96 — the `hunt` convention was DELETED, not corrected.
      // It warned that "hunt archetypes with 3+ parallel tools lose substantial
      // throughput" and steered callers to gemini-flash. Measured false
      // 2026-08-28: 6 tools offered, 3 of 3 demanded served in parallel, 3/3
      // trials, both V4 models, direct to the provider.
      //
      // Its cited evidence did not say what it claimed. exclusion-finding ID 20
      // is `intent_archetype: 'classify'` (not hunt), `verdict:
      // 'recommend-probe'` (i.e. NOBODY PROBED), `confidence: 'low'`, its
      // message reads "deepseek-v4-pro has zero calls", it was later
      // `declined`, and its own `parallel_tool_hint: false` was this profile's
      // own belief round-tripped back as input. A no-data finding on the wrong
      // archetype was paraphrased into "probe evidence confirms".
      //
      // Deleted rather than re-scoped because a cliffWarning is
      // capability-REDUCING (it steers traffic away from a model) and nothing
      // evidenced remains. Re-add only from a measured hunt eval.
    ],
  },

  // ── OpenAI ──
  // alpha.16 (2026-05-17): close the half-supported provider gap. env.ts
  // already registered OPENAI_API_KEY + executeOpenAI + normalizeOpenAILike
  // + lowerOpenAI all existed; profile entries were missing, so the
  // alpha.10 auto-filter would mark openai-keyed models reachable but
  // there were no profiles to filter IN. Half-supported is now fully
  // supported. PB request `openai-provider-profiles` (2026-05-16).
  //
  // Profile data verified against developers.openai.com/api/docs/pricing
  // + per-model pages 2026-05-17. L-049/L-081 step-zero: no AI-trained
  // numbers — fetched live from OpenAI's docs. As of 2026-05, OpenAI's
  // current flagship is gpt-5.5 (2025-12 cutoff); gpt-5.4-{base,mini,nano}
  // are the workhorse family. gpt-4.1 + gpt-4o are legacy.
  //
  // Both 5.5 and 5.4 carry a 272K input-token pricing cliff (2x input,
  // 1.5x output beyond that). Modeled as a `downgrade_quality_warning`
  // cliff because it ranks the model down at large-context shapes — the
  // semantics of "this model is now 2x more expensive" map onto the
  // existing penalty mechanism. Cost-watcher will catch high-context
  // spikes empirically; the cliff prevents naive routing into the doubled
  // pricing zone.
  {
    id: 'gpt-5.5',
    verifiedAgainstDocs: '2026-05-17',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-5.5 (HTTP 200; the .md
    // twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-5.5`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-5.5 — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 272_000,
        action: 'downgrade_quality_warning',
        reason: 'Over 272K input tokens the request is billed at 2x input and 1.5x output rates (https://developers.openai.com/api/docs/models/gpt-5.5, read 2026-11-15).',
      },
    ],
    costInputPer1m: 5.0,
    costOutputPer1m: 30.0,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-5.5`:
    //   Standard "gpt-5.5 (<272K context length)" $5 / $30, long $10 / $45, long cached $1.00; Batch short $2.50 / $15, long $5 / $22.50.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, same page and read: "Short context: ≤272K input tokens. Long context: >272K input tokens."
    costBatchPer1m: { input: 2.5, output: 15 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 10,
        costOutputPer1m: 45,
        costBatchPer1m: { input: 5, output: 22.5 },
        cacheReadPer1m: 1,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      // OpenAI caching is implicit (auto-applied to repeated prefixes
      // ≥1024 tokens for prompt_tokens_details.cached_tokens). No
      // wire-format marker. Discount: 10x for cached input ($0.50/$5.00).
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'structured_output', 'reliable_tool_use', 'reasoning_effort_knob'],
    weaknesses: ['cost', 'pricing_cliff_at_272k'],
    notes: 'OpenAI frontier (2026-05). 1M context (1.05M total), 128K max output, 2025-12 cutoff. Reasoning effort knob (none/low/medium/high/xhigh). Pricing cliff at 272K input.',
    // Frontier-tier perf hypothesis. Anchored to Opus 4.7 row (similar
    // price/positioning). Brain evidence will refine; no telemetry yet.
    archetypePerf: {
      critique: 9,
      plan: 9,
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,        // parallel tool support good but cliff at 272K hurts deep multi-step
      summarize: 7,   // overkill for tolerant archetype
      classify: 7,    // overkill; cheaper models cover this
    },
  },
  {
    // alpha.111 — onboarded 2026-09-13 (kgauto s101) from developers.openai.com/api/docs/models/gpt-6-astra,
    // read that day: "Our most capable model, built for the hardest end-to-end work". 1,050,000 ctx,
    // 128,000 max output, cutoff 2026-04-30, $10 / $50 per 1M, cached input $1 (10%); reasoning
    // effort low·medium·high·xhigh·max (default not stated); structured outputs, function calling and
    // streaming stated as supported; parallel tool calls NOT stated — carried true per the alpha.97
    // rule (unknown must not reduce; zero profiles declare false). The release watcher had
    // re-reported it as FORWARD-STEP daily since ~2026-09-10 and catalog-sync withheld the INSERT by
    // design (a pricing page cannot state capability fields) — onboarding is this seat's job.
    id: 'gpt-6-astra',
    verifiedAgainstDocs: '2026-09-13',
    versionAdded: '2.0.0-alpha.111',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-6-astra (HTTP 200; the
    // .md twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-6-astra`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-6-astra — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 272_000,
        action: 'downgrade_quality_warning',
        reason: 'Over 272K input tokens the request is billed at $20/$75 per 1M, 2x input and 1.5x output (https://developers.openai.com/api/docs/models/gpt-6-astra, read 2026-11-15).',
      },
    ],
    costInputPer1m: 10.0,
    costOutputPer1m: 50.0,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-6-astra`:
    //   Standard short $10 / $50, long $20 / $75, long cached $2.00; Batch short $5 / $25, long $10 / $37.50.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, same page and read: "Short context: ≤272K input tokens. Long context: >272K input tokens."
    costBatchPer1m: { input: 5, output: 25 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 20,
        costOutputPer1m: 75,
        costBatchPer1m: { input: 10, output: 37.5 },
        cacheReadPer1m: 2,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'structured_output', 'reliable_tool_use', 'reasoning_effort_knob'],
    weaknesses: ['cost', 'pricing_cliff_at_272k'],
    notes: 'GPT-6 Astra (2026-09). OpenAI frontier flagship: 1.05M context, 128K max output, 2026-04-30 cutoff, $10/$50 ($1 cached). Effort low…max. Pricing cliff at 272K ($20/$75). archetypePerf is JUDGMENT — mirrors gpt-5.5 with critique/plan at the frontier-flagship value; 0 brain rows as of 2026-09-13; unmeasured until the eval spine writes a score.',
    family: 'openai-gpt',
    archetypePerf: {
      critique: 10,   // judgment — "most capable", same as claude-opus-5; unmeasured
      plan: 10,       // judgment — unmeasured
      generate: 9,
      ask: 9,
      extract: 9,
      transform: 9,
      hunt: 8,        // parallel tool calls not stated on the page; cliff at 272K
      summarize: 7,   // overkill at $50/M output
      classify: 7,    // overkill; cheaper models cover this
    },
  },
  {
    // alpha.122 — onboarded 2026-10-06 (kgauto s104 filing) from
    // developers.openai.com/api/docs/models/gpt-6.1-sol (+ its .md twin), read
    // that day: "Near-Astra performance for complex work at a lower cost."
    // 1,050,000 ctx, max input 922,000, 128,000 max output, cutoff 2026-04-30,
    // $2 / $10 per 1M, cached input $0.10 ("5% of the uncached input token
    // rate"), cache writes $2.50; >272K input → "2x input and cache rates and
    // 1.5x output for the full request". reasoning.effort low · medium
    // (default) · high · xhigh · max — "The none and minimal reasoning efforts
    // are not supported." Streaming, structured outputs, function calling
    // listed as supported features, BUT: "Use the Responses API for tool
    // calling. Chat Completions is supported without tool calling." kgauto
    // lowers OpenAI to /v1/chat/completions, so on kgauto's wire this model
    // takes no tools — maxTools 0 (a request with tools does not fit it and
    // routes elsewhere). Parallel tool calls: not stated (moot at maxTools 0;
    // carried true per the alpha.97 rule, unknown must not reduce).
    // REGISTRY-ONLY (decision of record 2026-07-29): no chain row, no
    // versionAdded (an unstamped profile never outranks a stamped one in the
    // archetype-less family head; with an archetype, Astra − 1 keeps the head
    // on Astra).
    id: 'gpt-6.1-sol',
    verifiedAgainstDocs: '2026-10-06',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-6.1-sol (HTTP 200; the
    // .md twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-6.1-sol`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-6.1-sol — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 0,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 2.0,
    costOutputPer1m: 10.0,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-6.1-sol`:
    //   Standard short $2 / $10, long $4 / $15, long cached $0.20; Batch short $1 / $5, long $2 / $7.50.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, same page and read: "Short context: ≤272K input tokens. Long context: >272K input tokens."
    costBatchPer1m: { input: 1, output: 5 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 4,
        costOutputPer1m: 15,
        costBatchPer1m: { input: 2, output: 7.5 },
        cacheReadPer1m: 0.2,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      // Cached input $0.10 = 0.05 × $2 (page: "5% of the uncached input token rate").
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.05 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'agentic_coding', 'long_context', 'structured_output', 'reasoning_effort_knob'],
    weaknesses: ['no_tools_on_chat_completions', 'pricing_cliff_at_272k'],
    notes: 'GPT-6.1 Sol (doc-read 2026-10-06). GPT-6 family, positioned by OpenAI below Astra: "near-Astra performance at a lower cost for complex coding, computer use, and professional work". 1.05M context, max input 922,000, 128K max output, 2026-04-30 cutoff, $2/$10 ($0.10 cached = 5%, cache writes $2.50). Price tier: prompts over 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request (not modelled as a cliff — registry-only filing). Reasoning effort low/medium/high/xhigh/max, default medium; none and minimal NOT supported (so a no-reasoning remedy cannot exist for it). Tool calling is Responses-API-only per the page — kgauto speaks Chat Completions, so maxTools 0. Registry-only (no chain row) until a consumer asks for family routing. archetypePerf is JUDGMENT, cold start: gpt-6-astra minus one on every archetype; 0 brain rows.',
    family: 'openai-gpt',
    archetypePerf: {
      critique: 9,    // judgment — Astra 10 − 1; unmeasured
      plan: 9,        // judgment — Astra 10 − 1; unmeasured
      generate: 8,
      ask: 8,
      extract: 8,
      transform: 8,
      hunt: 7,        // moot on kgauto's wire: no tools on Chat Completions (maxTools 0)
      summarize: 6,
      classify: 6,
    },
  },
  {
    // ── GPT-6.1 Terra — onboarded alpha.132 (2026-11-11) ────────────────────
    // PROVENANCE — read 2026-11-11T23:32Z (curl -sL, HTTP 200) from
    // https://developers.openai.com/api/docs/models/gpt-6.1-terra.md (MP) and
    // https://developers.openai.com/api/docs/pricing.md (PR, 23:36Z):
    //   "A fast, efficient model for visual reasoning, precise computer use, and
    //   clear, natural writing." · Input modalities: text, image · 1,050,000
    //   context window · Maximum input tokens 922,000 · 128,000 max output ·
    //   Jun 01, 2026 knowledge cutoff · reasoning.effort none, low, medium
    //   (default), high, xhigh, max · Chat Completions Supported · "Tool calling
    //   requires the Responses API." — kgauto lowers OpenAI to
    //   /v1/chat/completions, so on kgauto's wire this model takes no tools:
    //   maxTools 0 (the gpt-6.1-sol precedent) · $1 in / $0.05 cached (5%) /
    //   $5 out, cache writes $1.25 (30-minute) · ">272K input tokens … 2x input
    //   and cache rates and 1.5x output for the full request" (MP) · PR Standard
    //   row `gpt-6.1-terra`: short $1.00 / $5.00 / cached $0.05, long $2.00 /
    //   $7.50 / cached $0.10; Batch row: short $0.50 / $2.50, long $1.00 / $3.75.
    //   No costCacheWritePer1m: the page's writes are 30m / 12h, not the 5m / 1h
    //   this field holds. No Status line on MP and the deprecations page names
    //   no lifecycle for it (read 23:36Z): no providerLifecycle is written.
    // versionAdded deliberately UNSET (the gpt-6.1-sol convention: the
    // archetype-less `openai-gpt` head stays on a stamped profile). Registry-only:
    // no chain row. (No closing brace may sit between `id` and `provider`.)
    id: 'gpt-6.1-terra',
    verifiedAgainstDocs: '2026-11-11',
    provider: 'openai',
    // alpha.132 — 'preview', not 'current': `buildCostOrderedChain` (fallback.ts) admits every
    // `current` profile above the archetype floor, so 'current' would add this row to every
    // cost-mode chain and move four cost-mode heads (R1: no tier added, no head moved; the
    // builder's objection 1). 'preview' keeps it out of every chain, cost mode, family
    // resolution and the advisor's candidate lists; an explicit `ir.models` entry reaches it.
    // Promotion to 'current' is an explicit call once it has rows (the Fable 5 / Sonnet 5 /
    // gemini-3.8-flash precedent).
    status: 'preview',
    // alpha.132 — no providerLifecycle is written: a lifecycle word not read on a page is not written.
    // Read 2026-11-11: https://developers.openai.com/api/docs/models/gpt-6.1-terra (HTTP 200, the .md twin, 23:32Z) carries no Status line and no lifecycle
    // badge; https://developers.openai.com/api/docs/deprecations (.md, 23:36Z) gives no lifecycle word for it.
    // alpha.132 — read 2026-11-11 on https://developers.openai.com/api/docs/models/gpt-6.1-terra (23:32Z) — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 0,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 1.0,
    costOutputPer1m: 5.0,
    // alpha.132 — prices read 2026-11-11 on https://developers.openai.com/api/docs/pricing (its .md form, 23:36Z), row `gpt-6.1-terra`:
    //   Standard short $1.00 / $5.00, long $2.00 / $7.50, long cached $0.10; Batch short $0.50 / $2.50, long $1.00 / $3.75.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, model page: "Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request."
    costBatchPer1m: { input: 0.5, output: 2.5 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 2,
        costOutputPer1m: 7.5,
        costBatchPer1m: { input: 1, output: 3.75 },
        cacheReadPer1m: 0.1,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      // Cached input $0.05 = 0.05 × $1 (MP: "priced at 5% of the uncached input token rate").
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.05 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['long_context', 'structured_output', 'reasoning_effort_knob', 'cost'],
    weaknesses: ['no_tools_on_chat_completions', 'pricing_cliff_at_272k'],
    notes:
      'GPT-6.1 Terra (doc-read 2026-11-11). "A fast, efficient model for visual reasoning, precise computer use, and clear, natural writing." 1.05M context, max input 922,000, 128K max output, 2026-06-01 cutoff, $1/$5 ($0.05 cached = 5%, cache writes $1.25 30m), batch $0.50/$2.50; >272K input: $2/$7.50 (costTiers). Reasoning effort none/low/medium (default)/high/xhigh/max. Tool calling is Responses-API-only per the page — kgauto speaks Chat Completions, so maxTools 0. Registry-only, status preview (no chain, cost-mode or family route until promoted). archetypePerf is JUDGMENT, cold start: gpt-6.1-sol minus one on every archetype; 0 brain rows.',
    family: 'openai-gpt',
    archetypePerf: {
      critique: 8,    // judgment — gpt-6.1-sol 9 − 1; unmeasured
      plan: 8,
      generate: 7,
      ask: 7,
      extract: 7,
      transform: 7,
      hunt: 6,        // moot on kgauto's wire: no tools on Chat Completions (maxTools 0)
      summarize: 5,
      classify: 5,
    },
  },
  {
    // ── GPT-6 Luna — onboarded alpha.132 (2026-11-11) ───────────────────────
    // PROVENANCE — read 2026-11-11T23:32Z (curl -sL, HTTP 200) from
    // https://developers.openai.com/api/docs/models/gpt-6-luna.md (MP) and
    // https://developers.openai.com/api/docs/pricing.md (PR, 23:36Z):
    //   "Our most efficient model for focused, high-volume tasks." · Input
    //   modalities: text, image · 1,050,000 context window · Maximum input tokens
    //   922,000 · 128,000 max output · May 18, 2026 knowledge cutoff ·
    //   reasoning.effort none … max, medium default · "Chat Completions supports
    //   function calling only with `reasoning_effort` set to `none`." · $0.1 in /
    //   $0.01 cached (10%) / $0.5 out, cache writes $0.125 · ">272K input tokens
    //   … 2x input and cache rates and 1.5x output for the full request" · PR
    //   Standard row `gpt-6-luna`: short $0.10 / $0.50 / cached $0.01, long $0.20
    //   / $0.75 / cached $0.02; Batch row: short $0.05 / $0.25, long $0.10 / $0.375.
    //   No costCacheWritePer1m (30m / 12h writes). No Status line on MP; the
    //   deprecations page names `gpt-6-luna` only as the recommended REPLACEMENT
    //   for gpt-4o / gpt-4.1 / gpt-5.4-nano snapshots (read 23:36Z), not a
    //   lifecycle word for it: no providerLifecycle is written.
    // THE TOOL RULE — the page states the remedy gpt-5.6-luna's probe found on
    //   the wire (alpha.121): reasoning off whenever tools are offered. Carried
    //   as a cliff since alpha.133, probed and confirmed on this model (see `cliffs`).
    //   (was: "NOT carried as a cliff: nothing has probed it on this model", until alpha.133.)
    // versionAdded deliberately UNSET; registry-only (no chain row).
    // (No closing brace may sit between `id` and `provider`.)
    id: 'gpt-6-luna',
    verifiedAgainstDocs: '2026-11-11',
    provider: 'openai',
    // alpha.132 — 'preview', not 'current': `buildCostOrderedChain` (fallback.ts) admits every
    // `current` profile above the archetype floor, so 'current' would add this row to every
    // cost-mode chain and move four cost-mode heads (R1: no tier added, no head moved; the
    // builder's objection 1). 'preview' keeps it out of every chain, cost mode, family
    // resolution and the advisor's candidate lists; an explicit `ir.models` entry reaches it.
    // Promotion to 'current' is an explicit call once it has rows (the Fable 5 / Sonnet 5 /
    // gemini-3.8-flash precedent).
    status: 'preview',
    // alpha.132 — no providerLifecycle is written: a lifecycle word not read on a page is not written.
    // Read 2026-11-11: https://developers.openai.com/api/docs/models/gpt-6-luna (HTTP 200, the .md twin, 23:32Z) carries no Status line and no lifecycle
    // badge; https://developers.openai.com/api/docs/deprecations (.md, 23:36Z) gives no lifecycle word for it.
    // alpha.132 — read 2026-11-11 on https://developers.openai.com/api/docs/models/gpt-6-luna (23:32Z) — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // alpha.133 (R6) — PROBED on the wire, 2026-11-12, n = 1 each way
        // (v2/scripts/probe-gpt-6-luna-tools.mjs; receipt
        // v2/docs/receipts/probe-gpt-6-luna-tools-2026-11-12.json): one function tool on
        // /v1/chat/completions with no reasoning_effort (the model default, `medium`) → HTTP 400
        // invalid_request_error, param reasoning_effort: "Function tools with reasoning_effort are
        // not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use
        // /v1/responses or set reasoning_effort to 'none'." (06:13:39Z); the same body with
        // reasoning_effort 'none' → HTTP 200, finish_reason tool_calls, get_weather({"city":"Paris"})
        // (06:13:40Z). The model page (read 2026-11-12T06:12:04Z) says it: "Chat Completions supports
        // function calling only with `reasoning_effort` set to `none`." Lowered by lowerOpenAI as
        // `reasoning_effort: 'none'` (forceThinkingZero); compile() says so with the
        // `reasoning-off-for-tools` advisory. The gpt-5.6-luna rule's shape.
        // (was: `cliffs: []` — "a tool-using call at the default effort is a 400" — until alpha.133.)
        metric: 'tool_count',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          "gpt-6-luna rejects function tools with reasoning_effort on /v1/chat/completions (HTTP 400, probed 2026-11-12, n=1; reasoning_effort 'none' → 200 with the tool call): the provider's remedy is reasoning_effort 'none', sent whenever the call offers tools.",
        evidence: { class: 'probed', lastProbed: '2026-11-12', verdict: 'confirmed' },
      },
    ],
    costInputPer1m: 0.1,
    costOutputPer1m: 0.5,
    // alpha.132 — prices read 2026-11-11 on https://developers.openai.com/api/docs/pricing (its .md form, 23:36Z), row `gpt-6-luna`:
    //   Standard short $0.10 / $0.50, long $0.20 / $0.75, long cached $0.02; Batch short $0.05 / $0.25, long $0.10 / $0.375.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, model page: "Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request."
    costBatchPer1m: { input: 0.05, output: 0.25 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 0.2,
        costOutputPer1m: 0.75,
        costBatchPer1m: { input: 0.1, output: 0.375 },
        cacheReadPer1m: 0.02,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      // Cached input $0.01 = 0.1 × $0.10 (MP: "priced at 10% of the uncached input token rate").
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['cost', 'speed', 'structured_output'],
    weaknesses: ['reasoning_depth', 'pricing_cliff_at_272k'],
    notes:
      'GPT-6 Luna (doc-read 2026-11-11). "Our most efficient model for focused, high-volume tasks." 1.05M context, max input 922,000, 128K max output, 2026-05-18 cutoff, $0.10/$0.50 ($0.01 cached = 10%, cache writes $0.125 30m), batch $0.05/$0.25; >272K input: $0.20/$0.75 (costTiers). Reasoning effort none…max, default medium; Chat Completions function calling only with reasoning_effort none — probed 2026-11-12 (400 at the default, 200 at none), so a tool-using call carries reasoning_effort none and says so. Registry-only, status preview (no chain, cost-mode or family route until promoted). archetypePerf is JUDGMENT, cold start: gpt-5.6-luna minus one on every archetype; 0 brain rows.',
    family: 'openai-gpt',
    archetypePerf: {
      ask: 6,         // judgment — gpt-5.6-luna 7 − 1; unmeasured
      hunt: 6,
      plan: 5,
      extract: 6,
      classify: 6,
      critique: 4,
      generate: 6,
      summarize: 6,
      transform: 6,
    },
  },
  {
    id: 'gpt-5.4',
    verifiedAgainstDocs: '2026-05-17',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-5.4 (HTTP 200; the .md
    // twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-5.4`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-5.4 — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 272_000,
        action: 'downgrade_quality_warning',
        reason: 'Over 272K input tokens the request is billed at 2x input and 1.5x output rates (https://developers.openai.com/api/docs/models/gpt-5.4, read 2026-11-15).',
      },
    ],
    costInputPer1m: 2.5,
    costOutputPer1m: 15.0,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-5.4`:
    //   Standard "gpt-5.4 (<272K context length)" $2.50 / $15, long $5 / $22.50, long cached $0.50; Batch short $1.25 / $7.50, long $2.50 / $11.25.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, same page and read: "Short context: ≤272K input tokens. Long context: >272K input tokens."
    costBatchPer1m: { input: 1.25, output: 7.5 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 5,
        costOutputPer1m: 22.5,
        costBatchPer1m: { input: 2.5, output: 11.25 },
        cacheReadPer1m: 0.5,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['reasoning', 'long_context', 'structured_output', 'reliable_tool_use'],
    weaknesses: ['pricing_cliff_at_272k'],
    notes: 'OpenAI workhorse (2026-05). 1M context (1.05M total), 128K max output, 2025-08 cutoff. Pricing cliff at 272K input. Pairs cleanly with Sonnet 4.6 on cost ($2.50/$15.00 vs $3.00/$15.00).',
    // Anchored to Sonnet 4.6 row (similar price/positioning). Slight
    // anthropic-side edge on agentic coding per master plan vibe.
    archetypePerf: {
      critique: 8,
      plan: 8,
      generate: 8,
      ask: 8,
      extract: 8,
      transform: 8,
      hunt: 7,
      summarize: 7,
      classify: 7,
    },
  },
  {
    id: 'gpt-5.4-mini',
    // alpha.95 — MEASURED, 2026-08-28, guard-probe-suite --discover run 34.
    // This model declared no cliffs, which is why the offline check had
    // nothing measured to say about it. The claim states its denominator:
    // the fixture demands 3 specific tools from a 20-tool menu, so this is
    // evidence of correct selection + 3-way parallel emission at that menu
    // size — NOT evidence of 20 concurrent calls.
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 20,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-28',
        probeRunId: 34,
        route: 'direct',
        claim:
          'Measured 2026-08-28: served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials, direct route.',
      },
    ],
    verifiedAgainstDocs: '2026-05-17',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-5.4-mini (HTTP 200;
    // the .md twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-5.4-mini`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-5.4-mini — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 400_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 0.75,
    costOutputPer1m: 4.5,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-5.4-mini`:
    //   Standard $0.75 / $4.50; Batch $0.375 / $2.25.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    costBatchPer1m: { input: 0.375, output: 2.25 },
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['cost', 'speed', 'agentic_coding', 'structured_output', 'reliable_tool_use'],
    weaknesses: ['reasoning_depth'],
    notes: "OpenAI mini-tier (2026-05). 400K context, 128K max output, 2025-08 cutoff. OpenAI describes as 'strongest mini model for coding, computer use, subagents.' Cache discount 10x ($0.075 input).",
    // Mini-tier hypothesis. Anchored to Haiku 4.5 + Flash row pricing.
    // Cost is slightly higher than Haiku ($0.75 vs $0.50 input) but
    // OpenAI claims strong coding/subagent perf.
    archetypePerf: {
      ask: 7,
      generate: 7,
      extract: 7,
      transform: 7,
      classify: 7,
      summarize: 7,
      hunt: 7,
      plan: 6,
      critique: 5,    // reasoning depth gap — frontier models handle this
    },
  },
  {
    id: 'gpt-5.4-nano',
    // alpha.95 — MEASURED, 2026-08-28, guard-probe-suite --discover run 35.
    // This model declared no cliffs, which is why the offline check had
    // nothing measured to say about it. The claim states its denominator:
    // the fixture demands 3 specific tools from a 20-tool menu, so this is
    // evidence of correct selection + 3-way parallel emission at that menu
    // size — NOT evidence of 20 concurrent calls.
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 20,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-28',
        probeRunId: 35,
        route: 'direct',
        claim:
          'Measured 2026-08-28: served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials, direct route.',
      },
    ],
    verifiedAgainstDocs: '2026-05-17',
    provider: 'openai',
    status: 'current',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://developers.openai.com/api/docs/models/gpt-5.4-nano, HTTP 200; its .md twin says "Status:
    // Deprecated") — the title badge "Deprecated". The deprecations page
    // (https://developers.openai.com/api/docs/deprecations, same day; platform.openai.com/docs/deprecations
    // 301s there), entry 2026-10-01: "The following models are deprecated and will be removed from the API
    // on April 1, 2027" — `gpt-5.4-nano | gpt-5.4-nano-2026-03-17`, Recommended replacement `gpt-6-luna`
    // (not a bundled id). Not a chain head (6th of the summarize / classify starters). `status` above is
    // unchanged: it moves on a measurement (golden eval), on the provider's `retired`, or when the seat
    // records why — never on this field.
    providerLifecycle: { status: 'deprecated', readOn: '2026-11-03', url: 'https://developers.openai.com/api/docs/models/gpt-5.4-nano', retirementFloor: '2027-04-01', replacement: 'gpt-6-luna' },
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-5.4-nano — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 400_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 0.2,
    costOutputPer1m: 1.25,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-5.4-nano`:
    //   Standard $0.20 / $1.25; Batch $0.10 / $0.625.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    costBatchPer1m: { input: 0.1, output: 0.625 },
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['cost', 'speed', 'volume', 'structured_output'],
    weaknesses: ['reasoning_depth', 'no_computer_use'],
    notes: "OpenAI nano-tier (2026-05). 400K context, 128K max output, 2025-08 cutoff. 'Cheapest GPT-5.4-class for simple high-volume tasks.' No fine-tuning, no computer-use tools. Cache discount 10x.",
    // Nano-tier. Anchored to Flash-Lite row ($0.10/$0.40 vs nano's
    // $0.20/$1.25). Slightly more expensive than Flash-Lite but with
    // OpenAI brand reliability. Good fit for classify/summarize floor.
    archetypePerf: {
      classify: 7,
      summarize: 6,
      ask: 6,
      transform: 6,
      extract: 6,
      generate: 5,
      hunt: 5,
      plan: 4,
      critique: 3,    // not for reasoning archetypes
    },
  },
  {
    // alpha.109 — bundled from OpenAI's model page, read 2026-09-11
    // (developers.openai.com/api/docs/models/gpt-5.6-luna): "1,050,000 context
    // window", "128,000 max output tokens", "Feb 16, 2026 knowledge cutoff",
    // $0.2 in / $0.02 cached / $1.2 out per 1M; function_calling,
    // structured_outputs, streaming; "Reasoning.effort supports: none, low,
    // medium (default), high, xhigh, and max"; positioning: "designed for
    // cost-sensitive, high-volume workloads … roughly corresponds to the nano
    // model tier". Why now: catalog-sync flipped the brain row to `current`
    // 2026-09-09 and, being the newest current openai profile by
    // versionAdded, it became the brain-side `openai-gpt` head while the bundle
    // still said gpt-5.4 (parity 2026-09-11: FAMILY HEAD MOVED). With an
    // archetype in hand gpt-5.4 (perf 8) still out-ranks it (perf 7) on every
    // archetype, so the head only decides archetype-less family resolution.
    // 0 rows in the brain as of 2026-09-11 — archetypePerf is the brain row's
    // own judgment values, unmeasured.
    id: 'gpt-5.6-luna',
    verifiedAgainstDocs: '2026-09-11',
    // Matches the brain stamp (catalog-sync onboarded it at .66); bundled .109.
    versionAdded: '2.0.0-alpha.66',
    provider: 'openai',
    status: 'current',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://developers.openai.com/api/docs/models/gpt-5.6-luna (HTTP 200;
    // the .md twin too) carries no Status line and no lifecycle badge; the deprecations page
    // (https://developers.openai.com/api/docs/deprecations, HTTP 200 via platform.openai.com's 301) does
    // not name `gpt-5.6-luna`. No page states a lifecycle word for this model, so none is written.
    // alpha.124 — read 2026-10-24 on https://developers.openai.com/api/docs/models/gpt-5.6-luna — the page says 'Input modalities: text, image'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 272_000,
        action: 'downgrade_quality_warning',
        reason: 'Over 272K input tokens the request is billed at 2x input and 1.5x output rates (https://developers.openai.com/api/docs/models/gpt-5.6-luna, read 2026-11-15).',
        evidence: { class: 'assumed' },
      },
      {
        // alpha.121 (item G) — OBSERVED on the wire, n = 1: alpha.120's wire
        // smoke (2026-10-06) offered function tools on /v1/chat/completions with
        // no reasoning_effort (the model default, `medium`) and OpenAI answered
        // HTTP 400 invalid_request: "Function tools with reasoning_effort are not
        // supported for gpt-5.6-luna in /v1/chat/completions. To use function
        // tools, use /v1/responses or set reasoning_effort to 'none'." The model
        // page (read 2026-10-06) lists Chat Completions as supported and
        // function calling as supported, and says nothing about the
        // restriction — so the rule is the provider's own remedy on the endpoint
        // kgauto speaks: reasoning off whenever tools are offered. Lowered by
        // lowerOpenAI as `reasoning_effort: 'none'` (forceThinkingZero);
        // compile() says so with a `reasoning-off-for-tools` advisory.
        metric: 'tool_count',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          "gpt-5.6-luna rejects function tools with reasoning_effort on /v1/chat/completions (HTTP 400, probed 2026-10-06, n=1): the provider's remedy is reasoning_effort 'none', sent whenever the call offers tools.",
        evidence: { class: 'probed', lastProbed: '2026-10-06', verdict: 'confirmed' },
      },
    ],
    costInputPer1m: 0.2,
    costOutputPer1m: 1.2,
    // alpha.128 — prices read 2026-11-06 on https://developers.openai.com/api/docs/pricing (its .md form), row `gpt-5.6-luna`:
    //   Standard short $0.20 / $1.20, long $0.40 / $1.80, long cached $0.04; Batch short $0.10 / $0.60, long $0.20 / $0.90.
    //   No costCacheWritePer1m: the page's cache writes are 30m / 12h, not the 5m / 1h this field holds.
    //   The step, same page and read: "Short context: ≤272K input tokens. Long context: >272K input tokens."
    costBatchPer1m: { input: 0.1, output: 0.6 },
    costTiers: [
      {
        overInputTokens: 272_000,
        costInputPer1m: 0.4,
        costOutputPer1m: 1.8,
        costBatchPer1m: { input: 0.2, output: 0.9 },
        cacheReadPer1m: 0.04,
      },
    ],
    lowering: {
      system: { mode: 'inline' },
      cache: { strategy: 'unsupported', minTokens: 1024, discount: 0.1 },
      tools: { format: 'openai' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate to fallback chain' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Model deprecated/renamed — escalate (L-061)' },
    ],
    strengths: ['cost', 'speed', 'structured_output', 'reliable_tool_use'],
    weaknesses: ['reasoning_depth', 'pricing_cliff_at_272k'],
    notes: 'GPT-5.6 Luna (2026-09). Nano-tier positioning per OpenAI: cost-sensitive, high-volume. 1.05M context, 128K max output, 2026-02-16 cutoff, $0.20/$1.20 ($0.02 cached). Reasoning effort none…max, default medium. Bundled alpha.109 so the `openai-gpt` family head reads the same on the bundle and in the brain. archetypePerf = the brain row\'s judgment values (catalog-sync onboarding), unmeasured: 0 brain rows as of 2026-09-11.',
    archetypePerf: {
      ask: 7,
      hunt: 7,
      plan: 6,
      extract: 7,
      classify: 7,
      critique: 5,
      generate: 7,
      summarize: 7,
      transform: 7,
    },
  },

  // ── Auto-onboarded (UNVERIFIED) ──
  // Cloned by scripts/auto-onboard-models.mjs from a same-family template.
  // Each entry's pricing/context/cliffs/lowering reflects the template, NOT
  // provider docs. Verify before promoting status to 'current' (L-049/L-081).
  {
    // s37 (2026-05-21): UNVERIFIED-AUTO-ONBOARD → verified against
    // ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview +
    // ai.google.dev/gemini-api/docs/pricing. L-081 catches:
    //   maxOutputTokens 65_535 → 65_536 (off-by-one)
    //   costInputPer1m  0.30 → 0.50  (template-cloned from 2.5-flash; actual is 1.67× more expensive)
    //   costOutputPer1m 2.50 → 3.00  (template-cloned; actual 1.2× more expensive)
    //   cache discount  default 0.25 → 0.10 (10× discount, $0.05/$0.50 per docs)
    // Cliffs inherited from 2.5-flash conservatively. The 8K-context-quality
    // cliff was a 2.5-Flash observation — Google positions Gemini 3 as
    // sustained-frontier-on-long-context; brain evidence will validate/relax.
    // Kept as guard for now.
    id: 'gemini-3-flash-preview',
    verifiedAgainstDocs: '2026-05-21',
    provider: 'google',
    status: 'legacy', // alpha.101 — superseded preview; brain flipped 2026-09-03 (catalog-sync), bundle follows
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3-flash-preview;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview 301s there): Versions row
    // "Preview: gemini-3-flash-preview". The deprecations page
    // (https://aistudio.google.com/docs/deprecations, same day; ai.google.dev/gemini-api/docs/deprecations
    // 301s there) lists it under Gemini 3 "Preview models" with Shutdown date "No shutdown date announced"
    // and Recommended replacement `gemini-3.6-flash`. Google's own words are Stable / Preview / Deprecated
    // (/ Shut down); Stable and Preview — served, not deprecated — are written `active`. `status` above is
    // unchanged: it moves on a measurement (golden eval), on the provider's `retired`, or when the seat
    // records why — never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3-flash-preview', replacement: 'gemini-3.6-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        metric: 'thinking_with_short_output',
        // threshold 1 = HINT-ONLY BY CONSTRUCTION (alpha.101 P4 / alpha.103):
        // it fires on the consumer's own `expectedShortOutput` hint and never
        // on kgauto's cap trigger, because no measurement of THIS model exists
        // and an unmeasured knee is not a gate (a reducer fires only on
        // probed+confirmed evidence — s96). tt-intelligence read it as "a guard
        // that cannot fire" (2026-09-13); the reason now says what it is. The
        // measurement that turns it into a gate: scripts/probe-thinking-held-point.mjs
        // --model <id> (Google key; alpha.104 did this for 2.5-flash → 513).
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason: "Thinking tokens count toward the output cap, so a small cap can return an empty answer. Google's thinking page (https://aistudio.google.com/docs/thinking, read 2026-11-15): max_output_tokens counts thought tokens, and a model that hits it while reasoning returns truncated or empty output. Fires on the caller's short-output hint; no cap has been measured for this model. Until one is, the empty-response recovery rule is what catches a drained cap.",
      },
    ],
    costInputPer1m: 0.5,
    costOutputPer1m: 3.0,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3-flash-preview`:
    //   Batch tab: $0.25 (text / image / video; audio $0.50) / $1.50; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.25, output: 1.5 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // 10× cache discount per Google pricing: $0.05/M cached vs $0.50/M input.
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Known: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['speed', 'volume', 'classification', '1m_context', 'cost'],
    weaknesses: ['complex_schemas', 'large_tool_sets', 'high_context_quality'],
    notes: "Verified s37 (2026-05-21) against Google docs. Step-change positioning vs 2.5-flash on agentic loops per Google's release notes (Dec 2025). Pricing 1.67×/1.2× higher than 2.5-flash; cache discount 10× (vs 4× for 2.5). Status=preview until brain evidence accumulates.",
    // Anchored to 2.5-flash archetypePerf as starter, with judgment adjustments
    // for Google's "step-change on agentic" positioning. Brain evidence (zero
    // rows today) will replace these starter values.
    archetypePerf: {
      hunt: 9,        // Inherits 2.5-flash L-040 parallel-tool tier; Google positions 3 as agentic-loop upgrade
      classify: 7,    // Inherits 2.5-flash brain-validated tier (218 rows on 2.5)
      summarize: 7,   // Inherits 2.5-flash; cliff strips tools when present
      transform: 7,
      ask: 8,         // +1 vs 2.5-flash — sustained-frontier positioning
      generate: 7,    // +1 vs 2.5-flash — agentic coding upgrade per Google
      plan: 6,        // +1 vs 2.5-flash — complex iterations per positioning
      extract: 6,
      critique: 5,    // +1 vs 2.5-flash — but still below Sonnet/Opus reasoning floor
    },
  },
  {
    // ── Gemini 3.1 Flash-Lite ──
    // Onboarded 2026-05-16 by auto-onboarder; s37 (2026-05-21) verified
    // against ai.google.dev/gemini-api/docs/pricing.
    //
    // L-081 CATCHES (template clone from 2.5-flash-lite was 2.5-3.75× too cheap):
    //   costInputPer1m  0.10 → 0.25 (template clone undervalued by 2.5×)
    //   costOutputPer1m 0.40 → 1.50 (template clone undervalued by 3.75×)
    //
    // Real 3.1-flash-lite is NOT a cost-equivalent successor to 2.5-flash-lite —
    // it sits between 2.5-flash-lite ($0.10/$0.40) and 2.5-flash ($0.30/$2.50).
    // Cache discount 10× verified ($0.025/M cached vs $0.25/M input).
    //
    // Cliffs are HYPOTHESIZED from 2.5-flash family; brain evidence pending.
    id: 'gemini-3.1-flash-lite',
    verifiedAgainstDocs: '2026-08-27',
    provider: 'google',
    // alpha.91 — docs page now labels it "Stable" and the brain row has been
    // `current` since catalog-sync moved it; the bundle lagged (the L-073
    // layer-parity shape, caught during the TT-49 delisting release).
    status: 'current',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.1-flash-lite;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite 301s there): Versions row "Stable:
    // gemini-3.1-flash-lite". The deprecations page (https://aistudio.google.com/docs/deprecations, same
    // day; ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "May 7, 2027"
    // and Recommended replacement `gemini-3.5-flash-lite`. Google's own words are Stable / Preview /
    // Deprecated (/ Shut down); Stable and Preview — served, not deprecated — are written `active`.
    // `status` above is unchanged: it moves on a measurement (golden eval), on the provider's `retired`, or
    // when the seat records why — never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.1-flash-lite', retirementFloor: '2027-05-07', replacement: 'gemini-3.5-flash-lite' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
    ],
    costInputPer1m: 0.25,
    costOutputPer1m: 1.5,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3.1-flash-lite`:
    //   Batch tab: $0.125 (text / image / video; audio $0.25) / $0.75; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.125, output: 0.75 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // Cache discount 10× (vs Flash 4×) — Google docs s37: $0.025/M cached vs
      // $0.25/M input. Material for repeat-prompt workloads (classify shape).
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Known on Flash family: empty after tool result — retry with thinking off.',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off.',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target.',
      },
    ],
    strengths: ['low_cost', 'speed', 'volume', 'classification', 'summarize', '1m_context', 'cache_friendly'],
    weaknesses: ['complex_reasoning', 'large_tool_sets', 'complex_schemas', 'structured_output_unproven', 'long_context_quality'],
    notes: "Verified s37 (2026-05-21) against Google docs. Sits between 2.5-flash-lite (cheaper) and 2.5-flash (more expensive) on cost frontier; 2.5× more expensive than initial template-clone. Cliffs hypothesized from Flash family — brain evidence pending.",
    // Tier 2-3 floor for summarize/classify chains at the new (verified) price
    // point. ZERO brain rows — values are starter hypotheses anchored to
    // "smaller sibling of Flash at higher cost than 2.5-flash-lite." The first
    // 50 brain rows per archetype will validate or relax these.
    archetypePerf: {
      classify: 6,    // starter hypothesis — verify (Flash is 7, lite likely ≤)
      summarize: 6,   // starter hypothesis — verify; cliff strips tools
      transform: 6,   // starter hypothesis — verify
      ask: 5,
      hunt: 5,
      generate: 4,
      extract: 4,
      plan: 3,
      critique: 3,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Gemini 3.5 Flash-Lite — onboarded s91 (2026-08-27)
  //
  // The successor Google's own delisting error names: "This model
  // [gemini-2.5-flash-lite] is no longer available to new users. Please
  // update your code to use models/gemini-3.5-flash-lite" (tt-intel TT-49,
  // 2026-08-26). Same price point as the 2.5 Lite rung it replaces in the
  // summarize/classify starter chains ($0.30/$2.50 vs the old $0.10/$0.40
  // era pricing), same 1M/65K limits, same 10× cache discount ($0.03 vs
  // $0.30 input). Positioning: "fastest, most cost-effective 3.5 model for
  // high-throughput execution … high-volume agentic tasks, translation, and
  // simple data processing."
  //
  // Cliffs + archetypePerf inherited from the Flash-Lite family as starter
  // hypotheses — ZERO brain rows on this id yet; first 50 rows per archetype
  // validate or relax.
  //
  // Specs verified 2026-08-27 against:
  //   ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
  //     (Stable; input limit 1,048,576; output limit 65,536; function
  //     calling / structured outputs / thinking / caching all Supported)
  //   ai.google.dev/gemini-api/docs/pricing ($0.30 in / $2.50 out incl.
  //     thinking tokens; context caching $0.03)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'gemini-3.5-flash-lite',
    versionAdded: '2.0.0-alpha.86', // alpha.101 — matches the brain stamp (auto-onboarded 2026-08-14); without it the unstamped bundle picked gemini-3.1-flash-lite as the flash-lite head (id ASC) while the brain picked this — surfaced by the parity watcher's family-head axis
    verifiedAgainstDocs: '2026-08-27',
    provider: 'google',
    status: 'current',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.5-flash-lite;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite 301s there): Versions row "Stable:
    // `gemini-3.5-flash-lite`". The deprecations page (https://aistudio.google.com/docs/deprecations, same
    // day; ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "No shutdown
    // date announced", no replacement. Google's own words are Stable / Preview / Deprecated (/ Shut down);
    // Stable and Preview — served, not deprecated — are written `active`. `status` above is unchanged: it
    // moves on a measurement (golden eval), on the provider's `retired`, or when the seat records why —
    // never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.5-flash-lite' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
    ],
    costInputPer1m: 0.3,
    costOutputPer1m: 2.5,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3.5-flash-lite`:
    //   Batch tab: $0.15 (text / image / video / audio) / $1.25; the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.15, output: 1.25 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // Cache discount 10× — pricing page: $0.03/M cached vs $0.30/M input.
      // Material for repeat-prompt workloads (classify shape).
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Known on Flash family: empty after tool result — retry with thinking off.',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off.',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target.',
      },
    ],
    strengths: ['low_cost', 'speed', 'volume', 'classification', 'summarize', '1m_context', 'cache_friendly'],
    weaknesses: ['complex_reasoning', 'large_tool_sets', 'complex_schemas', 'structured_output_unproven', 'long_context_quality'],
    notes:
      'Onboarded s91 (2026-08-27) as the Google-named successor to availability-restricted gemini-2.5-flash-lite. $0.30/$2.50 per 1M, 1M context, 65K max output, cache $0.03/M (10× discount). "Fastest, most cost-effective 3.5 model for high-throughput execution." Cliffs hypothesized from the Flash family — brain evidence pending.',
    // Lite-tier floor for summarize chains; the classify HEAD since alpha.130. Every value
    // but classify is a starter hypothesis anchored to the Flash-Lite family shape.
    archetypePerf: {
      // alpha.130 — grounding MEASURED: golden run #55 (tt-intelligence/classify, against the
      // 7-scored head gemini-2.5-flash, 5W/37T/8L of 50 = 84% not worse, bar 80%, PROMOTE-READY)
      // → the incumbent's score (the measured-perf writer's R2 anchor). (was: 6, starter
      // hypothesis — "Flash is 7, lite likely ≤" — until 2026-11-09)
      classify: 7,
      summarize: 6,   // starter hypothesis — verify; cliff strips tools
      transform: 6,   // starter hypothesis — verify
      ask: 5,
      hunt: 5,
      generate: 4,
      extract: 4,
      plan: 3,
      critique: 3,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Gemini 3.5 Flash — hand-onboarded s37 (2026-05-21)
  //
  // Google positioning ("Most intelligent for sustained frontier performance
  // on agentic and coding tasks" / "particularly effective for rapid agentic
  // loops involving complex coding cycles and iterations") suggests this is
  // the Flash-family upgrade specifically aimed at hunt-shape workloads.
  // Pricing 5× input / 3.6× output vs 2.5-flash — material cost premium.
  // archetypePerf adjusted +1 vs 2.5-flash on ask/generate/plan/critique
  // (sustained-frontier positioning); hunt held at 9 inherited from L-040
  // family parallel-tool tier; brain evidence will validate within 50 rows.
  //
  // Cliffs inherited conservatively from 2.5-flash. Google's "sustained
  // frontier on long-context" positioning suggests the 8K cliff may not
  // apply to 3.5 — keep as guard until brain evidence shows otherwise.
  //
  // Specs verified against:
  //   ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
  //   ai.google.dev/gemini-api/docs/pricing (Standard tier)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'gemini-3.5-flash',
    verifiedAgainstDocs: '2026-05-21',
    provider: 'google',
    status: 'legacy', // alpha.101 — Google lists it two generations behind (3.7 Stable, 3.8 New Stable); brain flipped 2026-09-03 (catalog-sync), bundle follows so both surfaces agree
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.5-flash;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash 301s there): Versions row "Deprecated:
    // `gemini-3.5-flash` (automatically routed to `gemini-3.6-flash`)", and the box "is deprecated and has
    // been replaced by Gemini 3.6 Flash … API requests to `gemini-3.5-flash` are automatically routed to
    // `gemini-3.6-flash`". The deprecations page (https://aistudio.google.com/docs/deprecations, same day;
    // ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "N/A" ("the
    // endpoint is not shutting down and automatically routes API requests to `gemini-3.6-flash`") and
    // Recommended replacement `gemini-3.6-flash`; no floor is written because the page names no date.
    // Google's own words are Stable / Preview / Deprecated (/ Shut down); Stable and Preview — served, not
    // deprecated — are written `active`. `status` above is unchanged: it moves on a measurement (golden
    // eval), on the provider's `retired`, or when the seat records why — never on this field.
    providerLifecycle: { status: 'deprecated', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.5-flash', replacement: 'gemini-3.6-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        metric: 'thinking_with_short_output',
        // threshold 1 = HINT-ONLY BY CONSTRUCTION (alpha.101 P4 / alpha.103):
        // it fires on the consumer's own `expectedShortOutput` hint and never
        // on kgauto's cap trigger, because no measurement of THIS model exists
        // and an unmeasured knee is not a gate (a reducer fires only on
        // probed+confirmed evidence — s96). tt-intelligence read it as "a guard
        // that cannot fire" (2026-09-13); the reason now says what it is. The
        // measurement that turns it into a gate: scripts/probe-thinking-held-point.mjs
        // --model <id> (Google key; alpha.104 did this for 2.5-flash → 513).
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason: "Thinking is on, with the same drain as gemini-2.5-flash: thinking tokens count toward the output cap. Google's thinking page (https://aistudio.google.com/docs/thinking, read 2026-11-15): max_output_tokens counts thought tokens, and a model that hits it while reasoning returns truncated or empty output. Fires on the caller's short-output hint; no cap has been measured for this model. Until one is, the empty-response recovery rule is what catches a drained cap.",
      },
    ],
    costInputPer1m: 1.5,
    costOutputPer1m: 9.0,
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing: the page has no `gemini-3.5-flash` section,
    //   so no cache-write, batch or tier price is written (a price not read is not written).
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // 10× cache discount per Google pricing: $0.15/M cached vs $1.50/M input.
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Inherited Flash-family pattern: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['agentic_loops', 'coding', '1m_context', 'parallel_tools', 'thinking_mode', 'sustained_frontier'],
    weaknesses: ['cost_vs_2_5_flash', 'no_brain_evidence_yet'],
    notes: "Hand-onboarded s37 (2026-05-21) verified against Google docs. Stable status; positioned as Flash-family upgrade for agentic loops and coding. 5×/3.6× more expensive than 2.5-flash but Google claims step-change on sustained frontier work. archetypePerf adjustments are judgment-grounded starter hypotheses — brain evidence will validate within ~50 rows per archetype.",
    // Starter hypothesis: anchored to 2.5-flash archetypePerf with +1
    // adjustments where Google's positioning explicitly supports
    // (agentic/coding/sustained). Hunt held at 9 inherited from L-040 family
    // parallel-tool tier. Brain evidence will replace.
    archetypePerf: {
      hunt: 9,        // Inherited from 2.5-flash L-040 parallel-tool tier; Google positions 3.5 as agentic-loop champion
      classify: 7,    // Inherited from 2.5-flash brain-validated tier (218 rows on 2.5)
      summarize: 7,   // Inherited from 2.5-flash; cliff strips tools when present
      transform: 7,
      ask: 8,         // +1 vs 2.5-flash — sustained-frontier positioning
      generate: 8,    // +1 vs 2.5-flash (6→8) — Google: "complex coding cycles and iterations"
      plan: 7,        // +1 vs 2.5-flash (5→7) — "complex iterations" positioning
      extract: 7,     // +1 vs 2.5-flash — sustained-frontier on structured tasks
      critique: 5,    // +1 vs 2.5-flash — but still below Sonnet/Opus reasoning floor
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // gemini-3.6-flash — hand-onboarded s86 (2026-08-14), step-zero against
  // Google docs (models/gemini-3.6-flash page + pricing via catalog-sync's
  // two-agreeing-extraction the same day). Docs list it as Stable and call
  // it "previous-generation Flash" (3.5-flash is now "legacy" in Google's
  // wording) — but kgauto status is 'preview' per the standing entry rule:
  // a new model enters on capability data verified only at the docs level,
  // preview is unreachable by starter chains, and promotion to routing
  // happens through brain evidence, not through Google's marketing tier.
  // This also means NO family-primary retarget rides this release.
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'gemini-3.6-flash',
    verifiedAgainstDocs: '2026-08-27',
    versionAdded: '2.0.0-alpha.87',
    provider: 'google',
    status: 'legacy', // alpha.101 — Google lists it "previous-generation" behind 3.7 and 3.8; catalog-sync flipped the brain 2026-09-03, the bundle follows so both surfaces agree,
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.6-flash;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash 301s there): Versions row "Stable:
    // `gemini-3.6-flash`", and the box "a previous-generation Flash model that remains available for
    // production use". The deprecations page (https://aistudio.google.com/docs/deprecations, same day;
    // ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "No shutdown date
    // announced", no replacement. Google's own words are Stable / Preview / Deprecated (/ Shut down);
    // Stable and Preview — served, not deprecated — are written `active`. `status` above is unchanged: it
    // moves on a measurement (golden eval), on the provider's `retired`, or when the seat records why —
    // never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.6-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        metric: 'thinking_with_short_output',
        // threshold 1 = HINT-ONLY BY CONSTRUCTION (alpha.101 P4 / alpha.103):
        // it fires on the consumer's own `expectedShortOutput` hint and never
        // on kgauto's cap trigger, because no measurement of THIS model exists
        // and an unmeasured knee is not a gate (a reducer fires only on
        // probed+confirmed evidence — s96). tt-intelligence read it as "a guard
        // that cannot fire" (2026-09-13); the reason now says what it is. The
        // measurement that turns it into a gate: scripts/probe-thinking-held-point.mjs
        // --model <id> (Google key; alpha.104 did this for 2.5-flash → 513).
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason: "Thinking is on, with the same drain as gemini-2.5-flash and gemini-3.5-flash: thinking tokens count toward the output cap. Google's thinking page (https://aistudio.google.com/docs/thinking, read 2026-11-15): max_output_tokens counts thought tokens, and a model that hits it while reasoning returns truncated or empty output. Fires on the caller's short-output hint; no cap has been measured for this model. Until one is, the empty-response recovery rule is what catches a drained cap.",
      },
    ],
    costInputPer1m: 0.75,   // promo through 2026-12-31; $1.50 from 2027-01-01 (TIME_BOUNDED_PRICING_ROWS carries the transition)
    costOutputPer1m: 3.75,  // promo through 2026-12-31; $7.50 from 2027-01-01
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3.6-flash`:
    //   Batch tab: $0.375 / $1.875 "through December 31, 2026" ($0.75 / $3.75 "starting January 1, 2027" — not written: the shape carries no date); the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.375, output: 1.875 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Inherited Flash-family pattern: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['agentic_loops', 'coding', '1m_context', 'parallel_tools', 'thinking_mode'],
    weaknesses: ['no_brain_evidence_yet'],
    notes: 'LEGACY since alpha.101 (2026-09-03): superseded by gemini-3.7-flash as the gemini-flash family head; still served by Google, no shutdown date. Hand-onboarded s86 (2026-08-14), step-zero verified: 1,048,576 ctx / 65,536 out (Google model page). PRICING re-verified 2026-08-24 at publish: $0.75/$3.75 promo through 2026-12-31, $1.50/$7.50 from 2027-01-01 — the alpha.87 profile carried the post-promo rate as if current; corrected alpha.88. Docs status Stable; enters kgauto as preview per standing rule (availability != lifecycle, promotion via brain evidence). Function calling + structured outputs + thinking per docs; parallel tools assumed per Flash family (docs silent). First flagged by the release watcher s73 (2026-07-24); ~21 days in the onboarding queue (onboarded 2026-08-14).',
    archetypePerf: {
      hunt: 9,        // Flash-family parallel-tool tier (L-040); inherited from 3.5-flash
      classify: 7,
      summarize: 7,
      transform: 7,
      ask: 8,
      generate: 8,
      plan: 7,
      extract: 7,
      critique: 5,
    },
  },

  {
    id: 'gemini-3.7-flash',
    verifiedAgainstDocs: '2026-09-03',
    // alpha.109 — matches the BRAIN stamp (auto-onboarded 2026-08-14 at .86;
    // bundled at .101). With both 3.7 and 3.8 stamped .101 the bundle tied on
    // versionAdded and fell to id ASC → 3.7 as the gemini-flash head, while
    // the brain (.86 vs .101) said 3.8 — the exact split the parity watcher
    // named on 2026-09-11. Same fix-shape as gemini-3.5-flash-lite below.
    versionAdded: '2.0.0-alpha.86',
    provider: 'google',
    status: 'current',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.7-flash;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash 301s there): Versions row "Deprecated:
    // `gemini-3.7-flash` (automatically routed to `gemini-3.8-flash`)", and the box "is deprecated and has
    // been replaced by Gemini 3.8 Flash … API requests to `gemini-3.7-flash` are automatically routed to
    // `gemini-3.8-flash`". The deprecations page (https://aistudio.google.com/docs/deprecations, same day;
    // ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "N/A" ("the
    // endpoint is not shutting down and automatically routes API requests to `gemini-3.8-flash`") and
    // Recommended replacement `gemini-3.8-flash`; no floor is written because the page names no date.
    // Google's own words are Stable / Preview / Deprecated (/ Shut down); Stable and Preview — served, not
    // deprecated — are written `active`. `status` above is unchanged: it moves on a measurement (golden
    // eval), on the provider's `retired`, or when the seat records why — never on this field.
    // Not a chain head on the build day (4th of plan, 5th of generate/ask/extract/transform, 2nd of hunt in
    // the starter chains); the routing to gemini-3.8-flash means calls here are served by 3.8 — a measurement
    // question for the seat, named in the alpha.127 PR.
    providerLifecycle: { status: 'deprecated', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.7-flash', replacement: 'gemini-3.8-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        // alpha.103 — MEASURED 2026-09-03, direct to generativelanguage.googleapis.com,
        // the 1.5K-token classify fixture, thinking default: cap 300 →
        // finishReason MAX_TOKENS with 286 thought tokens and 10 output
        // tokens (a truncated answer; 1 of 2 served trials, the other
        // stopped with 173 thoughts); cap 512 → STOP 3/3 (thoughts 124–403);
        // cap 1024 → STOP 3/3. thinkingBudget 0 at 300 → STOP, 93 tokens.
        // Threshold = the smallest cap measured to hold.
        metric: 'thinking_with_short_output',
        threshold: 512,
        action: 'force_thinking_budget_zero',
        reason:
          'Thinking tokens consume maxOutputTokens: at cap 300 the answer was cut at 10 tokens after 286 thoughts (probed 2026-09-03); 512 held 3/3.',
        evidence: { class: 'probed', lastProbed: '2026-09-03', verdict: 'confirmed' },
      },
    ],
    probedLimits: [
      {
        metric: 'thinking_with_short_output',
        testedAt: 512,
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-09-03',
        route: 'direct',
        claim:
          'Measured 2026-09-03: thinking default, maxOutputTokens 512, 1.5K-token classify fixture → STOP 3/3 (thoughts 124–403). At 300 the same prompt hit MAX_TOKENS with 286 thoughts and 10 output tokens.',
      },
    ],
    costInputPer1m: 0.75,   // promo through 2026-12-31; $1.50 from 2027-01-01 (TIME_BOUNDED_PRICING_ROWS carries the transition)
    costOutputPer1m: 3.75,  // promo through 2026-12-31; $7.50 from 2027-01-01
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing: the page has no `gemini-3.7-flash` section,
    //   so no cache-write, batch or tier price is written (a price not read is not written).
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Inherited Flash-family pattern: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['agentic_loops', 'coding', '1m_context', 'parallel_tools', 'thinking_mode'],
    weaknesses: ['no_brain_evidence_yet'],
    notes:
      'Bundled alpha.101 (2026-09-03), step-zero verified on Google\'s per-model page: 1,048,576 ctx / 65,536 out; thinking low/medium/high (minimal returns an error); function calling, structured outputs, caching, batch. PRICING verified 2026-09-03 on the pricing page: $0.75/$3.75 through 2026-12-31, $1.50/$7.50 from 2027-01-01 — the price that was ABSENT when alpha.94 held this model back is now published. Docs status Stable ("previous-generation" behind 3.8). Enters as current, not preview, because the brain already carried it current (auto-onboarded 2026-08-14) and on 2026-09-03 catalog-sync moved gemini-3.6-flash to legacy, which made this the live gemini-flash family head for every brain-connected consumer with ZERO observed rows — bundling it as current keeps bundled and brain consumers on the same head instead of splitting them. Cliffs + archetypePerf family-inherited from 3.6-flash and labelled unmeasured. Zero brain evidence at bundling; the promotion-cold-start design (s95) is the structural answer, not this profile.',
    archetypePerf: {
      hunt: 9,        // Flash-family parallel-tool tier (L-040); inherited from 3.6-flash (family-labelled, unmeasured)
      classify: 7,
      summarize: 7,
      transform: 7,
      ask: 8,
      generate: 8,
      plan: 7,
      extract: 7,
      critique: 5,
    },
  },

  {
    id: 'gemini-3.8-flash',
    verifiedAgainstDocs: '2026-09-03',
    versionAdded: '2.0.0-alpha.101',
    provider: 'google',
    // alpha.109 — `current`: catalog-sync read Google's page 2026-09-09 (two
    // independent extractions agreed) and flipped the brain row; the bundle
    // carried `preview` until this release (cross-surface parity 2026-09-11:
    // "bundle stale"). Being current makes it the `gemini-flash` head on both
    // surfaces (versionAdded .101 > 3.7-flash's .86) — the routing change the
    // brain side has been serving since 09-09.
    status: 'current',
    // alpha.127 — the provider's word, read 2026-11-03 on this model's page
    // (https://aistudio.google.com/docs/models/gemini-3.8-flash;
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash 301s there): Versions row "Stable:
    // `gemini-3.8-flash`". The deprecations page (https://aistudio.google.com/docs/deprecations, same day;
    // ai.google.dev/gemini-api/docs/deprecations 301s there) lists it with Shutdown date "No shutdown date
    // announced", no replacement. Google's own words are Stable / Preview / Deprecated (/ Shut down);
    // Stable and Preview — served, not deprecated — are written `active`. `status` above is unchanged: it
    // moves on a measurement (golden eval), on the provider's `retired`, or when the seat records why —
    // never on this field.
    providerLifecycle: { status: 'active', readOn: '2026-11-03', url: 'https://aistudio.google.com/docs/models/gemini-3.8-flash' },
    // alpha.124 — read 2026-10-24 on https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [
      {
        // alpha.122 — MEASURED 2026-10-06 (scripts/probe-thinking-held-point.mjs
        // --model gemini-3.8-flash --caps 300,512,1024,2048 --trials 3, direct to
        // generativelanguage.googleapis.com, the 1.5K-token classify fixture,
        // thinking default): cap 300 → 0/3, the cap eaten by thinking (thoughts
        // 285–289), no answer; caps 512 / 1024 / 2048 → finishReason STOP 3/3
        // each (9/9; thoughts 305–359, 128–306, 289–371). Threshold = the
        // smallest cap measured to finish — the same figure 3.7-flash measured
        // (512, alpha.103). Until this release the rule sat at threshold 1,
        // hint-only by construction (alpha.101 P4 / alpha.103: an unmeasured
        // knee is not a gate); tt-intelligence 2026-09-13 ("a guard that cannot
        // fire") and Drift's 2026-09-15 advisory close on this measurement.
        // The probe's own `held` column read 2/3 at 512, 1024 and 2048: one
        // answer per cap was not valid JSON — a structured-output miss, not a
        // drain (every trial finished STOP); recorded in `notes`, not a rule.
        metric: 'thinking_with_short_output',
        threshold: 512,
        action: 'force_thinking_budget_zero',
        reason:
          'Thinking tokens consume maxOutputTokens: measured 2026-10-06, cap 300 drained 3/3 (thoughts 285–289, no answer), cap ≥ 512 finished 9/9 (STOP at 512, 1024, 2048); threshold 512 = the smallest cap that held.',
        evidence: { class: 'probed', lastProbed: '2026-10-06', verdict: 'confirmed' },
      },
    ],
    probedLimits: [
      {
        metric: 'thinking_with_short_output',
        testedAt: 300,
        outcome: 'broke',
        trials: 3,
        lastProbed: '2026-10-06',
        route: 'direct',
        claim:
          'Measured 2026-10-06 (scripts/probe-thinking-held-point.mjs, direct): 1.5K-token classify prompt, thinking default, cap 300 → 0/3 answered; thinking ate the cap (thoughts 285–289).',
      },
      {
        metric: 'thinking_with_short_output',
        testedAt: 512,
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-10-06',
        route: 'direct',
        claim:
          'Measured 2026-10-06: thinking default, maxOutputTokens 512, 1.5K-token classify fixture → STOP 3/3 (thoughts 305–359); 2 of 3 answers valid JSON (the third finished but was not JSON — a structured-output miss, not a drain). 1024 and 2048 also STOP 3/3 each.',
      },
    ],
    costInputPer1m: 0.75,   // promo through 2026-12-31; $1.50 from 2027-01-01 (TIME_BOUNDED_PRICING_ROWS carries the transition)
    costOutputPer1m: 3.75,  // promo through 2026-12-31; $7.50 from 2027-01-01
    // alpha.128 — prices read 2026-11-06 on https://aistudio.google.com/docs/pricing (curl of
    //   https://ai.google.dev/gemini-api/docs/pricing, 301 → that page), section `gemini-3.8-flash`:
    //   Batch tab: $0.375 / $1.875 "through December 31, 2026" ($0.75 / $3.75 "starting January 1, 2027" — not written: the shape carries no date); the page states a context-caching (hit) price and an hourly storage price, no cache-write price — no costCacheWritePer1m.
    costBatchPer1m: { input: 0.375, output: 1.875 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      cache: { ...GOOGLE_LOWERING_BASE.cache, discount: 0.1 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Inherited Flash-family pattern: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['agentic_loops', 'coding', '1m_context', 'parallel_tools', 'thinking_mode'],
    weaknesses: ['no_brain_evidence_yet'],
    notes:
      'Bundled alpha.101 (2026-09-03), step-zero verified on Google\'s per-model page: 1,048,576 ctx / 65,536 out; thinking low/medium/high (minimal returns an error); function calling, structured outputs, caching, batch. PRICING verified 2026-09-03: $0.75/$3.75 through 2026-12-31, $1.50/$7.50 from 2027-01-01 (identical to 3.6/3.7). Docs status "New Stable", latest update September 2026. Enters as PREVIEW per the standing rule (availability != lifecycle): zero evidence anywhere, not in the brain yet, and family resolution never selects preview — promotion to current is an explicit call once it has rows. First sighted by the release watcher 2026-09-03. HINT, 2026-10-06 (not a rule): on the thinking-knee probe 3 of 9 answers at caps 512/1024/2048 were not valid JSON on a ~1.5K-token classify prompt that asks for JSON (every one finished STOP) — one prompt, n = 9, a hint for whoever measures structured output next, not evidence for a rule.',
    archetypePerf: {
      hunt: 9,        // Flash-family parallel-tool tier (L-040); inherited from 3.6-flash (family-labelled, unmeasured)
      classify: 7,
      summarize: 7,
      transform: 7,
      ask: 8,
      generate: 8,
      plan: 7,
      extract: 7,
      critique: 5,
    },
  },
  {
    // ── Gemini 4 Carbon — onboarded alpha.132 (2026-11-11) ──────────────────
    // PROVENANCE — read 2026-11-11T23:32Z (curl -sL, HTTP 200) from
    // https://aistudio.google.com/docs/models/gemini-4-carbon (MP),
    // https://aistudio.google.com/docs/pricing (PR, section `gemini-4-carbon`) and
    // https://aistudio.google.com/docs/deprecations (DP, 23:36Z):
    //   "our most capable reasoning model, built for complex software engineering,
    //   mathematical and scientific problem solving, high factual accuracy,
    //   autonomous multi-step agents" · Inputs Text, Image, Video, Audio, and PDF;
    //   Output Text · Context window (unified input and output token limit)
    //   1,048,576 · Max output 65,536 (default synchronous) / up to 1,048,576 with
    //   long decode · Function calling, Structured outputs supported · Thinking
    //   "Supported (low, medium, high)" · Context caching "Supported (Implicit
    //   only) … Explicit caching is not supported." · Versions "Stable:
    //   `gemini-4-carbon`" · Latest update November 2026 · DP: released 2026-11-10,
    //   "No shutdown date announced", no replacement.
    // PRICE — TIME-BOUND ON THE PAGE: Standard input "$2.00 through November 30,
    //   2026. $4.00 starting December 1, 2026."; output "$10.00 … $20.00";
    //   context caching "$0.10 … $0.20"; Batch "$1.00 / $5.00 through November 30,
    //   2026" ($2.00 / $10.00 from December 1). The profile carries the price in
    //   force on the read day; the December step is written in `notes` and must be
    //   re-read on 2026-12-01 (TIME_BOUNDED_PRICING_ROWS, which would carry it, is
    //   in build-seed-migrations.mjs, outside this release's scope). "Not available
    //   on the Free tier."
    // FAMILY: none written — the page names no tier that maps to an existing
    //   family tag (flash / flash-lite / pro), and deriveFamilyFromModelId returns
    //   null for this id; reachable by an explicit `ir.models` entry.
    // INHERITED from gemini-3.1-pro-preview (not doc-read): maxTools,
    //   parallelToolCalls (alpha.97 rule), systemPromptMode, streaming, the
    //   thinking field, recovery, minTokens.
    // versionAdded UNSET; registry-only (no chain row).
    // (No closing brace may sit between `id` and `provider`.)
    id: 'gemini-4-carbon',
    verifiedAgainstDocs: '2026-11-11',
    provider: 'google',
    // alpha.132 — 'preview', not 'current': `buildCostOrderedChain` (fallback.ts) admits every
    // `current` profile above the archetype floor, so 'current' would add this row to every
    // cost-mode chain and move four cost-mode heads (R1: no tier added, no head moved; the
    // builder's objection 1). 'preview' keeps it out of every chain, cost mode, family
    // resolution and the advisor's candidate lists; an explicit `ir.models` entry reaches it.
    // Promotion to 'current' is an explicit call once it has rows (the Fable 5 / Sonnet 5 /
    // gemini-3.8-flash precedent).
    status: 'preview',
    // alpha.132 — the provider's word, read 2026-11-11T23:32Z on this model's page: Versions row
    // "Stable: `gemini-4-carbon`"; Stable is written `active` (the alpha.127 convention). The
    // deprecations page (23:36Z) gives "No shutdown date announced" — no retirement floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-11', url: 'https://aistudio.google.com/docs/models/gemini-4-carbon' },
    // alpha.132 — read 2026-11-11 on https://aistudio.google.com/docs/models/gemini-4-carbon (23:32Z) — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [],
    costInputPer1m: 2.0,   // PR: "$2.00 through November 30, 2026. $4.00 starting December 1, 2026."
    costOutputPer1m: 10.0, // PR: "$10.00 through November 30, 2026. $20.00 starting December 1, 2026."
    // alpha.132 — prices read 2026-11-11 on https://aistudio.google.com/docs/pricing (23:32Z), section `gemini-4-carbon`:
    //   Batch tab "$1.00 / $5.00 through November 30, 2026" — the December step ($2 / $10) is not written (the shape carries no date).
    //   No cache-WRITE price on the page (implicit caching only), so none is written.
    costBatchPer1m: { input: 1, output: 5 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // PR context caching $0.10 = 0.05 × $2 (read 2026-11-11). MP: "Explicit caching is not
      // supported" (implicit only). `strategy` stays the Google base ('cachedContent'): nothing in
      // src reads it (git grep, 2026-11-11), and tests/profiles.test.ts pins it for every Google
      // profile — the builder's objection, not overridden (R7).
      // alpha.134 (Amendment C 2) — re-read 2026-11-15T07:47:38Z on https://aistudio.google.com/docs/models/gemini-4-carbon: Context caching "Supported
      // (Implicit only)", "Explicit caching is not supported." So no `cachedContent` strategy: the type's shape for
      // implicit, marker-free caching is OpenAI's (`strategy: 'unsupported'` with the discount; lowerGoogle reads
      // only minTokens and discount, so no wire or cost estimate moves). minTokens stays the Google base (INHERITED,
      // not on the page). (was: strategy 'cachedContent' from GOOGLE_LOWERING_BASE, until alpha.134.)
      cache: { ...GOOGLE_LOWERING_BASE.cache, strategy: 'unsupported', discount: 0.05 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL — escalate',
      },
    ],
    strengths: ['reasoning', '1m_context', 'agentic_coding', 'structured_output', 'tool_use'],
    weaknesses: ['cost', 'no_brain_evidence_yet'],
    notes:
      'Gemini 4 Carbon (doc-read 2026-11-11; released 2026-11-10, Stable). "Our most capable reasoning model." 1,048,576 ctx (unified), 65,536 max output (long decode up to 1,048,576 not modelled), text/image/video/audio/PDF in. PRICE IS TIME-BOUND ON THE PAGE: $2/$10 (cache $0.10, batch $1/$5) through 2026-11-30, $4/$20 (cache $0.20, batch $2/$10) from 2026-12-01 — the profile carries the price in force on 2026-11-11; RE-READ THE PRICE ON 2026-12-01. Implicit caching only. Not on the Free tier. No family tag (the page maps to no existing tier). Registry-only, status preview (no chain or cost-mode route until promoted). archetypePerf is JUDGMENT, cold start: gemini-3.1-pro-preview minus one on every archetype; 0 brain rows.',
    archetypePerf: {
      critique: 9,    // judgment — gemini-3.1-pro-preview 10 − 1; unmeasured
      plan: 9,
      ask: 8,
      generate: 8,
      extract: 8,
      transform: 7,
      hunt: 8,
      summarize: 7,
      classify: 6,
    },
  },
  {
    // ── Gemini 4 Argon — onboarded alpha.132 (2026-11-11) ───────────────────
    // PROVENANCE — read 2026-11-11T23:32Z (curl -sL, HTTP 200) from
    // https://aistudio.google.com/docs/models/gemini-4-argon (MP),
    // https://aistudio.google.com/docs/pricing (PR, section `gemini-4-argon`) and
    // https://aistudio.google.com/docs/deprecations (DP, 23:36Z):
    //   "our efficient Gemini 4 frontier reasoning model. It delivers Gemini 4
    //   intelligence with faster responses and lower token spend per turn
    //   compared to Gemini 4 Carbon" · Inputs Text, Image, Video, Audio, and PDF;
    //   Output Text · Context window 1,048,576 · Max output 65,536 (default
    //   synchronous) / up to 1,048,576 with long decode · Function calling,
    //   Structured outputs supported · Thinking "Supported (low, medium, high)" ·
    //   Context caching "Supported (Implicit only) … Explicit caching is not
    //   supported." · Versions "Stable: `gemini-4-argon`" · Latest update October
    //   2026 · DP: released 2026-10-13, "No shutdown date announced".
    // PRICE — TIME-BOUND ON THE PAGE, the same figures as Carbon: Standard $2.00 /
    //   $10.00 (context caching $0.10) through November 30, 2026; $4.00 / $20.00
    //   ($0.20) starting December 1, 2026; Batch $1.00 / $5.00 through November 30
    //   ($2.00 / $10.00 from December 1). "Not available on the Free tier."
    // FAMILY: none written (as Carbon). INHERITED from gemini-3.1-pro-preview
    //   (not doc-read): maxTools, parallelToolCalls, systemPromptMode, streaming,
    //   the thinking field, recovery, minTokens.
    // versionAdded UNSET; registry-only (no chain row).
    // (No closing brace may sit between `id` and `provider`.)
    id: 'gemini-4-argon',
    verifiedAgainstDocs: '2026-11-11',
    provider: 'google',
    // alpha.132 — 'preview', not 'current': `buildCostOrderedChain` (fallback.ts) admits every
    // `current` profile above the archetype floor, so 'current' would add this row to every
    // cost-mode chain and move four cost-mode heads (R1: no tier added, no head moved; the
    // builder's objection 1). 'preview' keeps it out of every chain, cost mode, family
    // resolution and the advisor's candidate lists; an explicit `ir.models` entry reaches it.
    // Promotion to 'current' is an explicit call once it has rows (the Fable 5 / Sonnet 5 /
    // gemini-3.8-flash precedent).
    status: 'preview',
    // alpha.132 — the provider's word, read 2026-11-11T23:32Z on this model's page: Versions row
    // "Stable: `gemini-4-argon`" → `active`; deprecations page: "No shutdown date announced".
    providerLifecycle: { status: 'active', readOn: '2026-11-11', url: 'https://aistudio.google.com/docs/models/gemini-4-argon' },
    // alpha.132 — read 2026-11-11 on https://aistudio.google.com/docs/models/gemini-4-argon (23:32Z) — the page says 'Inputs: Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [],
    costInputPer1m: 2.0,   // PR: "$2.00 through November 30, 2026. $4.00 starting December 1, 2026."
    costOutputPer1m: 10.0, // PR: "$10.00 through November 30, 2026. $20.00 starting December 1, 2026."
    // alpha.132 — prices read 2026-11-11 on https://aistudio.google.com/docs/pricing (23:32Z), section `gemini-4-argon`:
    //   Batch tab "$1.00 / $5.00 through November 30, 2026" — the December step ($2 / $10) is not written (the shape carries no date).
    //   No cache-WRITE price on the page (implicit caching only), so none is written.
    costBatchPer1m: { input: 1, output: 5 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // PR context caching $0.10 = 0.05 × $2 (read 2026-11-11). MP: "Explicit caching is not
      // supported" (implicit only). `strategy` stays the Google base ('cachedContent'): nothing in
      // src reads it (git grep, 2026-11-11), and tests/profiles.test.ts pins it for every Google
      // profile — the builder's objection, not overridden (R7).
      // alpha.134 (Amendment C 2) — re-read 2026-11-15T07:47:39Z on https://aistudio.google.com/docs/models/gemini-4-argon: Context caching "Supported
      // (Implicit only)", "Explicit caching is not supported." So no `cachedContent` strategy: the type's shape for
      // implicit, marker-free caching is OpenAI's (`strategy: 'unsupported'` with the discount; lowerGoogle reads
      // only minTokens and discount, so no wire or cost estimate moves). minTokens stays the Google base (INHERITED,
      // not on the page). (was: strategy 'cachedContent' from GOOGLE_LOWERING_BASE, until alpha.134.)
      cache: { ...GOOGLE_LOWERING_BASE.cache, strategy: 'unsupported', discount: 0.05 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL — escalate',
      },
    ],
    strengths: ['reasoning', '1m_context', 'agentic_coding', 'structured_output', 'tool_use'],
    weaknesses: ['no_brain_evidence_yet'],
    notes:
      'Gemini 4 Argon (doc-read 2026-11-11; released 2026-10-13, Stable). "Our efficient Gemini 4 frontier reasoning model … faster responses and lower token spend per turn compared to Gemini 4 Carbon." 1,048,576 ctx (unified), 65,536 max output (long decode not modelled), text/image/video/audio/PDF in. PRICE IS TIME-BOUND ON THE PAGE and equal to Carbon\'s: $2/$10 (cache $0.10, batch $1/$5) through 2026-11-30, $4/$20 (cache $0.20, batch $2/$10) from 2026-12-01 — the profile carries the price in force on 2026-11-11; RE-READ THE PRICE ON 2026-12-01. Implicit caching only. Not on the Free tier. No family tag. Registry-only, status preview (no chain or cost-mode route until promoted). archetypePerf is JUDGMENT, cold start: gemini-4-carbon minus one on every archetype; 0 brain rows.',
    archetypePerf: {
      critique: 8,    // judgment — gemini-4-carbon 9 − 1; unmeasured
      plan: 8,
      ask: 7,
      generate: 7,
      extract: 7,
      transform: 6,
      hunt: 7,
      summarize: 6,
      classify: 5,
    },
  },
  {
    // ── Gemini 4 Hydrogen — onboarded alpha.134 (2026-11-15) ────────────────
    // PROVENANCE — read 2026-11-15T06:46:00Z (curl -sL, HTTP 200) from
    // https://aistudio.google.com/docs/models/gemini-4-hydrogen (MP),
    // https://aistudio.google.com/docs/pricing (PR, section `gemini-4-hydrogen`, 06:46:01Z) and
    // https://aistudio.google.com/docs/deprecations (DP, 06:46:01Z):
    //   MP: "Gemini 4 Hydrogen (`gemini-4-hydrogen`) brings cutting-edge intelligence to
    //   everyone, with speed and efficiency for everyday coding and agentic workflows,
    //   featuring a unified 1M-token context window and long decode up to 1M tokens." ·
    //   "Inputs Text, Image, Video, Audio, and PDF" · "Output Text" · "Context window
    //   (unified input and output token limit) 1,048,576" · "Max output 65,536 (default
    //   synchronous) / up to 1,048,576 (with long decode)" · Function calling, Structured
    //   outputs: supported · Thinking "Supported (low, medium, high, xhigh)" · Context
    //   caching "Supported (Implicit only)" / "Explicit caching is not supported." ·
    //   Versions "Stable: `gemini-4-hydrogen`" · Latest update "November 2026" · the page
    //   links "API changes from Gemini 3.8 Flash" (the incumbent named below).
    //   PR Standard, paid tier, per 1M: Input "$1.50"; Output (including thinking tokens)
    //   "$7.50"; Context caching "$0.075 … Implicit caching only". Batch: "$0.75" / "$3.75"
    //   / "$0.0375". Free tier "Free of charge". No date bound on the price.
    //   DP: `gemini-4-hydrogen` released "November 12, 2026", "No shutdown date announced".
    // FAMILY: none written — the page names no tier that maps to an existing family tag
    //   (flash / flash-lite / pro), and deriveFamilyFromModelId returns null for this id
    //   (the Carbon / Argon convention); reachable by an explicit `ir.models` entry.
    // INHERITED from gemini-3.8-flash (not doc-read): maxTools, parallelToolCalls,
    //   systemPromptMode, streaming, the thinking field, recovery. No cliff: nothing is
    //   measured on this model, and a capability-reducing rule defaults off without
    //   evidence (the Carbon / Argon convention).
    // versionAdded UNSET; registry-only (no chain row).
    // (No closing brace may sit between `id` and `provider`.)
    id: 'gemini-4-hydrogen',
    verifiedAgainstDocs: '2026-11-15',
    provider: 'google',
    // 'preview', not 'current' (the alpha.132 R1 reasoning, Carbon's comment): 'current' would
    // enter every cost-mode chain above the floor; 'preview' keeps it out of every chain, cost
    // mode, family resolution and the advisor's candidate lists. No tier added, no head moved.
    status: 'preview',
    // The provider's word, read 2026-11-15T06:46:00Z on this model's page: Versions row "Stable:
    // `gemini-4-hydrogen`"; Stable is written `active` (the alpha.127 convention). DP (06:46:01Z):
    // "No shutdown date announced" — no retirement floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-15', url: 'https://aistudio.google.com/docs/models/gemini-4-hydrogen' },
    // alpha.134 — read 2026-11-15 on https://aistudio.google.com/docs/models/gemini-4-hydrogen — the page says 'Inputs Text, Image, Video, Audio, and PDF'.
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    maxContextTokens: 1_048_576, // MP: "Context window (unified input and output token limit) 1,048,576"
    maxOutputTokens: 65_536, // MP: "Max output 65,536 (default synchronous)"; long decode not modelled
    maxTools: 128,
    parallelToolCalls: true,
    structuredOutput: 'native', // MP: Structured outputs supported
    systemPromptMode: 'separate',
    streaming: true,
    cliffs: [],
    costInputPer1m: 1.5,   // PR Standard: Input price "$1.50"
    costOutputPer1m: 7.5,  // PR Standard: Output price (including thinking tokens) "$7.50"
    // alpha.134 — prices read 2026-11-15 on https://aistudio.google.com/docs/pricing (06:46:01Z), section `gemini-4-hydrogen`:
    //   Batch tab: Input "$0.75", Output "$3.75". No cache-WRITE price on the page (implicit
    //   caching only), so none is written.
    costBatchPer1m: { input: 0.75, output: 3.75 },
    lowering: {
      ...GOOGLE_LOWERING_BASE,
      // PR context caching $0.075 = 0.05 × $1.50 (read 2026-11-15). MP: "Explicit caching is not
      // supported" (implicit only). `strategy` stays the Google base, as on Carbon.
      // alpha.134 (Amendment C 2) — re-read 2026-11-15T07:47:39Z on https://aistudio.google.com/docs/models/gemini-4-hydrogen: Context caching "Supported
      // (Implicit only)", "Explicit caching is not supported." So no `cachedContent` strategy: the type's shape for
      // implicit, marker-free caching is OpenAI's (`strategy: 'unsupported'` with the discount; lowerGoogle reads
      // only minTokens and discount, so no wire or cost estimate moves). minTokens stays the Google base (INHERITED,
      // not on the page). (was: strategy 'cachedContent' from GOOGLE_LOWERING_BASE, until alpha.134.)
      cache: { ...GOOGLE_LOWERING_BASE.cache, strategy: 'unsupported', discount: 0.05 },
      thinking: { field: 'generationConfig.thinkingConfig.thinkingBudget', default: 'auto' },
    },
    recovery: [
      {
        signal: 'empty_response_after_tool',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Inherited Flash-family pattern: empty after tool result — retry with thinking off',
      },
      {
        signal: 'empty_response',
        action: 'retry_with_params',
        retryParams: { 'generationConfig.thinkingConfig.thinkingBudget': 0 },
        maxRetries: 1,
        reason: 'Empty response — try with thinking off',
      },
      {
        signal: 'malformed_function_call',
        action: 'escalate',
        reason: 'MALFORMED_FUNCTION_CALL maps to stop — escalate to next target',
      },
    ],
    strengths: ['speed', 'cost', '1m_context', 'agentic_coding', 'tool_use', 'structured_output'],
    weaknesses: ['no_brain_evidence_yet'],
    notes:
      'Gemini 4 Hydrogen (doc-read 2026-11-15; released 2026-11-12, Stable). "speed and efficiency for everyday coding and agentic workflows." 1,048,576 ctx (unified), 65,536 max output (long decode up to 1,048,576 not modelled), text/image/video/audio/PDF in, thinking low/medium/high/xhigh. $1.50/$7.50 (implicit cache $0.075, batch $0.75/$3.75), no date bound on the page. Implicit caching only. No family tag (the page maps to no existing tier). Registry-only, status preview (no chain or cost-mode route until promoted). archetypePerf is JUDGMENT, cold start: gemini-3.8-flash minus one on every archetype; 0 brain rows.',
    archetypePerf: {
      hunt: 8,        // judgment — gemini-3.8-flash 9 − 1; unmeasured
      classify: 6,
      summarize: 6,
      transform: 6,
      ask: 7,
      generate: 7,
      plan: 6,
      extract: 6,
      critique: 4,
    },
  },

  {
    // Auto-onboarded 2026-07-01 from `claude-sonnet-4-6`; VERIFIED 2026-07-02
    // against the claude-api reference (cc-portfolio ratification pass). The
    // clone got context right (1M). PRICING RE-BASED 2026-08-14 (s86): the
    // introductory $2/$10 was made PERMANENT — Anthropic's pricing page now
    // states the scheduled Sept-1 increase to $3/$15 "will not occur", so
    // $2/$10 IS the sticker. (The $3/$15 encoded 07-02 was correct under the
    // time-bounded-pricing convention at the time; the bound was cancelled.) The clone got max output WRONG:
    // Sonnet 5 is 128k, not 4-6's 64k — corrected. New tokenizer (~30% more
    // tokens for the same text vs 4-6): byte-budget consumers should re-baseline.
    // API quirks (claude-api ref): (a) NON-DEFAULT temperature/top_p/top_k
    // return 400 — moot for kgauto's own call() path (ANTHROPIC_LOWERING_BASE
    // emits no sampling params) but a REAL hazard for compileForAISDKv6
    // consumers that pass temperature themselves (tt-intel scoring uses temp:0
    // for determinism — that 400s on this model; noted to consumers via the
    // contract). (b) Omitting `thinking` runs ADAPTIVE by default (4-6 ran
    // thinking-off) — output spend shifts. (c) Supports effort xhigh. status:
    // 'preview' per the Fable precedent — no brain evidence yet; promotion to
    // 'current' is an explicit call. (L-049/L-081.)
    id: 'claude-sonnet-5',
    // alpha.95 — MEASURED, 2026-08-28, guard-probe-suite --discover run 36.
    // This model declared no cliffs, which is why the offline check had
    // nothing measured to say about it. The claim states its denominator:
    // the fixture demands 3 specific tools from a 20-tool menu, so this is
    // evidence of correct selection + 3-way parallel emission at that menu
    // size — NOT evidence of 20 concurrent calls.
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 20,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-28',
        probeRunId: 36,
        route: 'direct',
        claim:
          'Measured 2026-08-28: served 3 of 3 demanded tools from a 20-tool menu, 3/3 trials, direct route.',
      },
    ],
    verifiedAgainstDocs: '2026-08-14',
    provider: 'anthropic',
    status: 'current', // s76 2026-07-25: GA per docs; was preview.
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (legacy)", Retirement "Not sooner than June 30, 2027"; the sidebar files it
    // under "Legacy models"). The deprecations table (…/about-claude/model-deprecations,
    // same day) lists `claude-sonnet-5` as Current state Active with the same floor.
    // `status` above stays 'current' — THE HEAD DOES NOT MOVE on a page's word: golden runs
    // #41 (ask, claude-sonnet-5 → claude-sonnet-5-5: 90 % win-or-tie, promote-ready) and #42
    // (extract: 10W/10T/10L = 67 %, BELOW the 80 % bar), both 2026-10-25, say the measured
    // head stays (the filing). `status` moves on a measurement (golden eval),
    // on the provider's `retired`, or when the seat records why — never on this field.
    providerLifecycle: { status: 'legacy', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/sonnet-5/overview', retirementFloor: '2027-06-30' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/sonnet-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // alpha.134 (R2) — the model's own off-switch, sent when the caller says the answer is short.
        // Threshold 1: the caller's `expectedShortOutput` hint only — no cap has been measured for this
        // model (R3; the measurement needs a provider key). Source: https://platform.claude.com/docs/en/build-with-claude/thinking.md, read 2026-11-15T06:45:59Z:
        // "Thinking tokens count toward `max_tokens`".
        metric: 'thinking_with_short_output',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          'Claude Sonnet 5 thinks by default and its thinking tokens count toward max_tokens, so under a small cap the answer can be cut or empty (https://platform.claude.com/docs/en/build-with-claude/thinking, read 2026-11-15). When the caller says the answer is short, the request carries thinking: {"type": "disabled"}, the model\'s own off-switch. Fires on the caller\'s short-output hint; no cap has been measured for this model.',
      },
    ],
    costInputPer1m: 2.0,  // 2026-08-24: intro price made PERMANENT (docs: "the previously scheduled increase to $3/$15 on September 1, 2026 will not occur")
    costOutputPer1m: 10.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Sonnet 5": 5m writes $2.50, 1h writes $4 / MTok;
    //   "Batch processing" row "Claude Sonnet 5": $1 / $5 / MTok).
    costCacheWritePer1m: { fiveMinute: 2.5, oneHour: 4 },
    costBatchPer1m: { input: 1, output: 5 },
    // alpha.125 (amendment 4a) — sampling_params, read 2026-10-25 on
    // https://platform.claude.com/docs/en/build-with-claude/thinking: "On Claude
    // Fable 5.1, …, Claude Opus 5, …, Claude Sonnet 5, and Claude Haiku 5.5,
    // non-default `temperature`, `top_p`, or `top_k` values return a 400 error on
    // every request, regardless of whether thinking is used." (was: not listed,
    // until 2026-10-25.)
    // alpha.133 (R5) — assistant_prefill: the thinking page (https://platform.claude.com/docs/en/build-with-claude/thinking,
    // read 2026-11-12T06:12:04Z), "Response prefill and forced tool use": "Claude 4.6 and later models and Claude Mythos
    // Preview reject a prefilled final assistant turn with a 400 error, whether or not thinking is on"; the errors page
    // (https://platform.claude.com/docs/en/api/errors, 06:12:18Z), "Prefill not supported", says the same of "Claude 4.6
    // and later models". The model's own page (read 06:12:04Z) places it in that class:
    // Claude Sonnet 5 (overview: "Model ID: `claude-sonnet-5`", "**Legacy.** Released June 30, 2026.").
    // (was: rejects ['thinking_control', 'sampling_params'], until alpha.133.)
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // alpha.134 (R1) — https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row "Claude Sonnet 5": `"enabled"`
      // with `budget_tokens` → "400 error", `"between_tools"` → "400 error", `"disabled"` → "Thinking off" (no effort condition in the cell).
      // `disabled` is accepted, so `thinking_control` (which means BOTH disabled and enabled are 400s)
      // is not listed; the two rejected types are gated by THINKING_TYPES_REJECTED. (was: rejects
      // ['thinking_control', 'sampling_params', 'assistant_prefill'] with a comment redefining the shape
      // for this model, until alpha.134.) The off-switch: the table cell is the whole statement; neither page names an effort condition for Sonnet 5.
      rejects: ['sampling_params', 'assistant_prefill'],
      thinkingOff: { type: 'disabled' },
      // https://platform.claude.com/docs/en/build-with-claude/effort.md (read 2026-11-15T06:46:00Z): "Claude Sonnet 5 defaults to `high` effort on the Claude API and Claude Code."; `max` "Available on … Claude Sonnet 5".
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Deprecated — escalate (L-061)' },
    ],
    strengths: ['quality', 'tool_use', 'long_context', 'cache_friendly', 'extended_thinking'],
    weaknesses: [],
    notes: "Sonnet 5 (2026-06): near-Opus quality on coding/agentic work at Sonnet cost. Verified 2026-07-02 against the claude-api reference: 1M ctx, 128k out (clone's 64k corrected), $3/$15 sticker (intro $2/$10 through 2026-08-31). New tokenizer ~30% more tokens vs sonnet-4-6. Consumer hazards: non-default temperature/top_p/top_k 400 (temp:0 rejected — deterministic-scoring consumers must omit); thinking defaults to adaptive when omitted. status:preview — no brain evidence yet; earns placement via the machinery.",
    // Master plan §6.2 anchor. Tier 0 for plan/generate/ask/extract/transform
    // in starter chains; tier 1 cross-provider for hunt/summarize/classify.
    archetypePerf: {
      ask: 9,
      generate: 9,
      plan: 9,
      critique: 9,
      extract: 9,
      transform: 9,
      hunt: 7,        // strong but Flash beats on parallel tool throughput
      summarize: 8,   // overkill for tolerant archetype
      classify: 8,    // overkill
    },
  },
  {
    // ── Claude Sonnet 5.5 — onboarded alpha.121 (2026-10-06) ─────────────
    // PROVENANCE — read 2026-10-06 from platform.claude.com/docs/en/about-claude/pricing,
    // …/models/overview and …/models/sonnet-5-5/migration-guide:
    //   id = alias `claude-sonnet-5-5` · 1M ctx · 128K max out (300K on
    //   Batches with output-300k-2026-03-24) · $2 in / $10 out (the guide:
    //   "the same prices as Claude Sonnet 5") · 5m write $2.50, 1h write $4 ·
    //   cache hits $0.20 = 0.1× (standard) · batch $1/$5 · fast mode not
    //   listed · adaptive thinking (NOT always on: `thinking: {type:
    //   'between_tools'}` turns up-front thinking off), default effort `high`
    //   · reliable cutoff Jun 2026 · retirement not sooner than 2027-09-28 ·
    //   tool-use system prompt 286 tokens (auto/none); any/tool blank.
    // REJECTED SHAPES (migration guide, each a 400): thinking disabled
    // ("To turn thinking off on this model, send \"thinking\": {\"type\":
    // \"between_tools\"} instead") and enabled+budget_tokens, tool_choice
    // any|tool, non-default sampling params, assistant prefill ("This model
    // does not support assistant message prefill. The conversation must end
    // with a user message."), `computer_20251124` on the Claude API / Google
    // Cloud and `computer_20250124` everywhere (not emittable by kgauto).
    // FAMILY-INHERITED from claude-sonnet-5 (not doc-read): maxTools,
    // parallelToolCalls, structuredOutput, systemPromptMode, streaming.
    // probedLimits: none — Sonnet 5's run-36 probe does not transfer.
    id: 'claude-sonnet-5-5',
    verifiedAgainstDocs: '2026-10-06',
    // versionAdded deliberately UNSET — see claude-opus-5-5 (archetype-less
    // family resolution must not move to 5.5 on a registration stamp).
    provider: 'anthropic',
    status: 'current',
    // alpha.126 — the provider's word, read 2026-11-02 on this model's page (Status row
    // "Active (latest)", Retirement "Not sooner than September 28, 2027").
    // The deprecations table (…/about-claude/model-deprecations, same day) lists
    // `claude-sonnet-5-5` as Current state Active with the same floor.
    providerLifecycle: { status: 'active', readOn: '2026-11-02', url: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview', retirementFloor: '2027-09-28' },
    // alpha.124 — read 2026-10-24 on https://platform.claude.com/docs/en/models/sonnet-5-5/overview — the page says 'Input → output: Text and images → text'.
    inputModalities: ['text', 'image'],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'grammar',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [
      {
        // alpha.134 (R2) — the model's own off-switch, sent when the caller says the answer is short.
        // Threshold 1: the caller's `expectedShortOutput` hint only — no cap has been measured for this
        // model (R3; the measurement needs a provider key). Source: https://platform.claude.com/docs/en/build-with-claude/thinking.md, read 2026-11-15T06:45:59Z:
        // "Thinking tokens count toward `max_tokens`".
        metric: 'thinking_with_short_output',
        threshold: 1,
        action: 'force_thinking_budget_zero',
        reason:
          'Claude Sonnet 5.5 thinks by default and its thinking tokens count toward max_tokens, so under a small cap the answer can be cut or empty (https://platform.claude.com/docs/en/build-with-claude/thinking, read 2026-11-15). When the caller says the answer is short, the request carries thinking: {"type": "between_tools"}, the model\'s own off-switch. Fires on the caller\'s short-output hint; no cap has been measured for this model.',
      },
    ],
    costInputPer1m: 2.0,
    costOutputPer1m: 10.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.claude.com/docs/en/about-claude/pricing
    //   ("Model pricing" row "Claude Sonnet 5.5": 5m writes $2.50, 1h writes $4 / MTok;
    //   "Batch processing" row "Claude Sonnet 5.5": $1 / $5 / MTok).
    costCacheWritePer1m: { fiveMinute: 2.5, oneHour: 4 },
    costBatchPer1m: { input: 1, output: 5 },
    lowering: {
      ...ANTHROPIC_LOWERING_BASE,
      // alpha.125 — read 2026-10-25 on https://platform.claude.com/docs/en/about-claude/pricing:
      // row "Claude Sonnet 5.5" cache hits "$0.10 / MTok", footnote 2: "Cache hits
      // and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x
      // the base input price." (was: the base 0.1 — $0.20 — from the 2026-10-06
      // read, until 2026-10-25.)
      cache: { ...ANTHROPIC_LOWERING_BASE.cache, discount: 0.05 },
      rejects: ['thinking_control', 'forced_tool_choice', 'sampling_params', 'assistant_prefill'],
      // alpha.134 (R1) — https://platform.claude.com/docs/en/build-with-claude/thinking.md (read 2026-11-15T06:45:59Z), per-model table row "Claude Sonnet 5.5":
      // `"enabled"` → "400 error", `"disabled"` → "400 error" (so `thinking_control` stays listed),
      // `"between_tools"` → "Up-front thinking off at `high` effort or below"; prose: "it rejects
      // `thinking: {type: "disabled"}` with a 400 error. To turn off up-front thinking, send `thinking:
      // {type: "between_tools"}` instead. It's the lowest thinking setting on Claude Sonnet 5.5, and it's
      // accepted at effort `high` or below." https://platform.claude.com/docs/en/build-with-claude/effort.md (06:46:00Z): "It works at `low`, `medium`, and
      // `high` effort. At `xhigh` or `max` it returns a 400 error".
      thinkingOff: { type: 'between_tools', effortAtMost: 'high' },
      // https://platform.claude.com/docs/en/build-with-claude/effort.md: "Claude Sonnet 5.5 supports all five effort levels, and `high` is the default on the
      // Claude API"; `max` "Available on … Claude Sonnet 5.5".
      effort: { field: 'output_config.effort', default: 'high', max: 'max' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Deprecated — escalate (L-061)' },
    ],
    strengths: ['quality', 'tool_use', 'long_context', 'cache_friendly'],
    weaknesses: [],
    notes:
      'Claude Sonnet 5.5 (doc-read 2026-10-06; cache read re-read 2026-10-25). $2/$10 (same as Sonnet 5), cache reads $0.10 (0.05×; was $0.20 / 0.1× until 2026-10-25), 1M ctx, 128K out, adaptive thinking (between_tools turns up-front thinking off; disabled is a 400), default effort high, cutoff Jun 2026, retirement not sooner than 2027-09-28. Rejects (400) thinking disabled/enabled, tool_choice any|tool, non-default temperature/top_p/top_k, assistant prefill — kgauto drops them and says so. Its thinking blocks are read by Claude Opus 5.5 on the Claude API and Google Cloud (Opus 5.5 migration guide); any other fallover runs without them (call() strips them and says so). The vendor\'s line, 2026-10-06: "The best combination of speed and intelligence"; comparative latency "Fast" (tier kept from Sonnet 5, unmeasured). archetypePerf is JUDGMENT, 0 brain rows.',
    family: 'claude-sonnet',
    // COLD-START PRIOR = claude-sonnet-5's prior MINUS ONE on every archetype
    // (judgment): the `claude-sonnet` head stays on the incumbent until the
    // Tuesday delta report measures 5.5 as a candidate. Same price as Sonnet 5,
    // so the trigger is the chain fallback, not a price delta.
    archetypePerf: {
      ask: 8,
      generate: 8,
      plan: 8,
      critique: 8,
      extract: 8,
      transform: 8,
      hunt: 6,
      summarize: 7,
      classify: 7,
    },
  },

  // ── Z.ai (GLM) ──
  // alpha.65 (2026-07-18): first Z.ai profile, provider `zai` added same
  // release. Step-zero sources (L-049/L-081, all fetched 2026-07-18):
  // docs.z.ai/guides/llm/glm-5.2 (capabilities), docs.z.ai api-reference
  // chat-completion (wire params: thinking.type enabled|disabled default
  // enabled, reasoning_effort max..none, tool_stream, max output 131072),
  // docs.z.ai/guides/overview/pricing ($1.4 in / $4.4 out, cached input
  // $0.26, cache storage limited-time free), vLLM recipe (native ctx
  // 1,048,576). NO AI-trained numbers.
  {
    id: 'glm-5.2',
    verifiedAgainstDocs: '2026-07-18',
    provider: 'zai',
    probedLimits: [
      {
        metric: 'tool_count',
        testedAt: 6,
        demanded: 3,
        served: [3, 3, 3],
        outcome: 'held',
        trials: 3,
        lastProbed: '2026-08-29',
        route: 'openrouter:baidu',
        claim:
          'Measured 2026-08-29 via OpenRouter (served-by Baidu): 6 tools offered, 3 of 3 demanded served in parallel, 3/3 trials. Route-scoped — direct z.ai is unmeasured (no key held).',
      },
    ],
    status: 'preview',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://docs.z.ai/guides/llm/glm-5.2,
    // https://docs.z.ai/guides/overview/overview and https://docs.z.ai/guides/overview/pricing (each HTTP
    // 200): GLM-5.2 is listed among the models, no deprecated / legacy / retirement word beside it (the nav
    // now leads with GLM-5.3 and "Migrate to GLM-5.3"). No page states a lifecycle word for this model, so
    // none is written.
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    // No documented tool-count cap — conservative default pending measured
    // evidence; matches the deepseek posture, not a doc number.
    maxTools: 16,
    // Hosted-API docs document tools + tool_choice + tool_stream but say
    // NOTHING about multiple tool_calls per response. Conservative false so
    // hunt-shaped ranking doesn't over-promise; flip on doc or probe
    // evidence (L-081: undocumented ≠ true).
    parallelToolCalls: true, // alpha.96 — see weaknesses note; was an unevidenced blanket false
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 1.4,
    costOutputPer1m: 4.4,
    // alpha.128 — prices read 2026-11-06 on https://docs.z.ai/guides/overview/pricing: GLM-5.2 $1.4 in / $0.26 cached / $4.4 out,
    //   cached storage "Limited-time Free" — no cache-write, batch or prompt-length price, so none is written.
    lowering: {
      system: { mode: 'inline' },
      // Automatic prefix caching ("intelligent caching mechanism") — no wire
      // marker to emit, DeepSeek-style. Cache-hit input $0.26/M (~0.19× of
      // miss) tracked in notes; storage limited-time free as of 2026-07-18.
      cache: { strategy: 'unsupported' },
      tools: { format: 'openai' },
      // thinking.type: 'enabled' (server default) | 'disabled'. lowerZai
      // emits an explicit disable only on forceThinkingZero cliffs.
      thinking: { field: 'thinking.type', default: 'auto' },
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Deprecated — escalate (L-061)' },
    ],
    strengths: ['cost', '1m_context', 'code', 'tool_use', 'json_output', 'reasoning'],
    // alpha.96 — 'parallel_tools' REMOVED. Measured 2026-08-29 via OpenRouter
    // (served-by Baidu), 6 tools offered, 3 of 3 demanded served in PARALLEL,
    // 3/3 trials. ROUTE-SCOPED: per the alpha.92 execute-leg contract there is
    // no cross-route verdict transfer, and direct z.ai is UNMEASURED (we hold
    // no zai key). But `parallelToolCalls: false` was a blanket claim with no
    // route qualification and no evidence at all, and it is capability-
    // REDUCING — it drives requires-adapter/reject. An unsubstantiated reducer
    // must not reduce. Contradicted on the one route we can reach is enough to
    // stop enforcing it; it is not enough to claim the opposite, which is why
    // probedLimits below carries the route.
    weaknesses: [],
    notes:
      'GLM-5.2 (Z.ai, 2026-06): agentic-coding flagship. 1,048,576 ctx / 131,072 max out. $1.40/$4.40 per 1M; cached input $0.26/M (automatic caching, no marker; storage limited-time free as of 2026-07-18). Thinking on by default (`thinking.type`), `reasoning_effort` max..none. Parallel tool calls UNDOCUMENTED on the hosted API — profile says false until doc or probe evidence. status:preview — no brain evidence yet; earns placement via the machinery.',
    // Starter hypotheses — verify with telemetry/probes; NO brain evidence
    // yet. Anchored on the vendor's agentic-coding positioning at a
    // mid-cost tier, discounted for the unproven parallel-tool story.
    archetypePerf: {
      generate: 7,    // agentic-coding positioning — starter hypothesis
      transform: 7,   // starter hypothesis
      plan: 7,        // starter hypothesis
      summarize: 7,   // tolerant archetype — starter hypothesis
      ask: 6,
      extract: 6,
      critique: 6,
      classify: 6,
      // alpha.96 — was 5, discounted for "parallel unproven". Parallel is no
      // longer unproven on the reachable route (3/3, 2026-08-29). The discount
      // had no other stated basis, so it is withdrawn to the neutral floor.
      // Judgment, not measurement — same standard as the DeepSeek correction.
      hunt: 6,
    },
  },

  // ── Moonshot (Kimi) ──
  // alpha.65 (2026-07-18): first Moonshot profile, provider `moonshot` added
  // same release. Step-zero sources (all fetched 2026-07-18):
  // platform.kimi.ai/docs/pricing/chat-k3 ($3.00 cache-miss in / $0.30
  // cache-hit in / $15.00 out; 1,048,576 ctx; ToolCalls + JSON Mode +
  // Partial Mode), kimi-k3-quickstart (max_completion_tokens default
  // 131072, up to 1,048,576; base https://api.moonshot.ai/v1; vision via
  // base64 or ms://file-id, NO public image URLs), models-overview
  // (temperature FIXED 1.0, top_p FIXED 0.95, n FIXED 1, always reasons,
  // reasoning_effort 'max' only), tool-calls guide ("can choose to call
  // multiple tools at once … will tend to call them in parallel").
  {
    id: 'kimi-k3',
    verifiedAgainstDocs: '2026-07-18',
    provider: 'moonshot',
    status: 'preview',
    // alpha.127 — providerLifecycle NOT written: a lifecycle word not read on a page is not written. Read
    // on the build day 2026-11-03: https://platform.kimi.ai/docs/models (HTTP 200) and
    // https://platform.kimi.ai/docs/pricing/chat-k3 (308 → …/docs/pricing/chat, 200): `kimi-k3` is listed
    // among the available models as "Kimi's previous-generation flagship", not in the page's "Deprecated
    // Models" list; no lifecycle word beside it. None is written.
    maxContextTokens: 1_048_576,
    // Documented ceiling; default is 131,072 when unset.
    maxOutputTokens: 1_048_576,
    // No hard doc cap; docs recommend dynamic tool loading at "dozens or
    // hundreds" — 64 matches the frontier-agentic posture (sonnet-5 tier).
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'inline',
    streaming: true,
    cliffs: [],
    costInputPer1m: 3.0,
    costOutputPer1m: 15.0,
    // alpha.128 — prices read 2026-11-06 on https://platform.kimi.ai/docs/pricing/chat-k3 (→ /docs/pricing/chat): the K3 price table is
    //   empty in the served HTML and in its .md form (client-rendered); the page states batch only as
    //   "60% of the standard price" and cache writes "billed separately by TTL (5min / 1h)" with no
    //   figure — a price is read, never derived, so none is written.
    lowering: {
      system: { mode: 'inline' },
      // Automatic context caching — no wire marker. Cache-hit input $0.30/M
      // (0.1× of miss) tracked in notes.
      cache: { strategy: 'unsupported' },
      tools: { format: 'openai' },
      // No thinking knob: reasoning is always-on and reasoning_effort
      // accepts only 'max' (= the server default). Nothing to lower.
    },
    recovery: [
      { signal: 'rate_limit', action: 'escalate', reason: '429 — escalate' },
      { signal: 'model_not_found', action: 'escalate', reason: 'Deprecated — escalate (L-061)' },
    ],
    strengths: ['quality', 'reasoning', '1m_context', 'parallel_tools', 'tool_use', 'code', 'vision'],
    // 'latency' → latencyTierOf derives 'slow': always-on max-effort
    // reasoner with no off switch; no measured p50 yet, the tag is the
    // honest prior (reasoner family precedent: deepseek-v4-pro ~48s).
    weaknesses: ['cost', 'latency'],
    notes:
      'Kimi K3 (Moonshot, API live 2026-07-16): 2.8T-param open-weight flagship, native vision. 1,048,576 ctx; max_completion_tokens default 131,072, ceiling 1,048,576. $3.00/$15.00 per 1M, cache-hit input $0.30/M (automatic caching). Reasoning ALWAYS ON (reasoning_effort max only, cannot disable; responses may carry reasoning_content). Wire quirks: temperature fixed 1.0 / top_p 0.95 / n 1 (kgauto never emits those); vision input must be base64 or ms://file-id — public image URLs rejected. status:preview — earns placement via the machinery.',
    // Starter hypotheses — verify with telemetry/probes; NO brain evidence
    // yet. Anchored on documented long-horizon-agentic + parallel-tool
    // strengths; discounted on terse archetypes where always-on reasoning
    // bills $15/M output for thinking the archetype doesn't need.
    archetypePerf: {
      hunt: 8,        // parallel tools + long-horizon agentic — starter hypothesis
      plan: 8,        // starter hypothesis
      generate: 8,    // starter hypothesis
      critique: 7,
      ask: 7,
      extract: 7,
      transform: 7,
      summarize: 6,   // works, but $15/M output reasoning tax on a tolerant archetype
      classify: 5,    // always-on reasoning cost + reasoner hedge risk
    },
    // Diagnostics-only (no prompt rewrite): reasoner-family hedge risk on
    // decisive archetypes, carried as a warning until K3-specific probe
    // evidence exists. The deepseek-reasoner family showed 8/10 judge
    // rationales citing hedging on classify (exclusion-finding ID 20,
    // 2026-05-28); K3 is an always-on reasoner and inherits the risk class,
    // not the conviction.
    archetypeConventions: [
      {
        archetype: 'classify',
        cliffWarning:
          'kimi-k3 is an always-on reasoner: decisive archetypes (classify) may hedge, and reasoning tokens bill at $15/M output. Family-prior risk (deepseek-reasoner precedent), not K3-measured — probe before relying on it for classify.',
        reason:
          'Reasoner-family prior (exclusion-finding ID 20, 2026-05-28, deepseek-v4-pro on tt-intel/classify). No K3-specific evidence yet — warning only, no prompt rewrite.',
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// ALIASES — provider-side or legacy-kgauto IDs that resolve to a canonical
// profile. Resolved transparently by getProfile / tryGetProfile so callers
// can pass either form.
//
// Add an alias when:
//   - The provider itself ships an alias (DeepSeek `deepseek-chat` →
//     `deepseek-v4-flash`; Anthropic dated → undated alias of same model).
//   - kgauto ships a renamed canonical and needs a back-compat path during
//     consumer migration (`claude-haiku-4.5` → `claude-haiku-4-5`).
//
// Drop an alias only on a major version bump — they're a wire-format
// contract for consumers passing old IDs.
// ─────────────────────────────────────────────────────────────────────────

export const ALIASES: Record<string, string> = {
  // DeepSeek's own model routing — both names served by V4.1-Flash since
  // 2026-09-10 (alpha.109; before that by V4-Flash).
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  // Retired by DeepSeek 2026-09-10; still accepted on the wire and served by
  // V4.1-Flash at the Flash price (pricing page, read 2026-09-11). An alias so
  // a consumer's `deepseek-v4-flash` pin, block or chain entry keeps meaning
  // the model it serves — and so blocking either name blocks the model.
  'deepseek-v4-flash': 'deepseek-flash',
  // Legacy kgauto typo — actual API alias is dash-form (alpha.1 had dot).
  'claude-haiku-4.5': 'claude-haiku-4-5',
  // 2026-09-13 — Anthropic's own dated snapshot id for Haiku 4.5 (the models page lists it as the API id, `claude-haiku-4-5` as the alias). catalog-sync had reported it needs-onboarding daily; it is the same model.
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

// ─────────────────────────────────────────────────────────────────────────
// alpha.11 — brain-first lookup hook (KG-14).
//
// `getProfile` / `tryGetProfile` / `canonicalId` consult the brain first
// when models-brain.ts has registered a hook (which happens at the
// package's module-load time once index.ts re-exports it). On cold cache,
// brain-down, or brain-disabled, the hook returns undefined and these
// functions fall through to the bundled PROFILE_INDEX + ALIASES.
//
// The hook pattern avoids a circular import (profiles.ts ↔ models-brain.ts).
// ─────────────────────────────────────────────────────────────────────────

interface ProfileBrainHook {
  getProfile?: (canonicalId: string) => ModelProfile | undefined;
  resolveAlias?: (id: string) => string | undefined;
}

let brainHook: ProfileBrainHook = {};

/** @internal — called by models-brain.ts at module load. */
export function _setProfileBrainHook(hook: ProfileBrainHook): void {
  brainHook = hook;
}

/**
 * The canonical id an alias resolves to (brain aliases first, then the
 * bundled ALIASES), or the id itself. alpha.11 D5: alias resolution is
 * stable regardless of the canonical's active state — the brain hook returns
 * the canonical even when the canonical model row is `active=false`.
 * Exported since alpha.109 so `compile()` can SAY when a consumer's model id
 * was an alias (DeepSeek retired `deepseek-v4-flash` under a live id).
 */
export function canonicalId(id: string): string {
  return brainHook.resolveAlias?.(id) ?? ALIASES[id] ?? id;
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.87 — consumer-registered profiles (gateway review §6, both cold
// readers' finding: `getProfile` threw on unknown ids and no consumer
// registration API existed, so a model kgauto hadn't onboarded meant
// "wait for the maintainer" however informed the consumer was).
//
// Resolution order becomes: consumer > brain > bundled. Explicit beats
// learned beats shipped — a consumer that registers a profile is making an
// informed local choice, and it wins even for an id the registry knows.
// The tradeoff is stated rather than hidden: registering an id that the
// brain also carries forfeits curated updates (price fixes, learned
// cliffs) for that id in this process. Register only what you need.
// ─────────────────────────────────────────────────────────────────────────

const CONSUMER_INDEX = new Map<string, ModelProfile>();

/**
 * Register consumer-supplied profiles. They take precedence over both
 * brain-curated and bundled profiles for the same id (explicit > learned >
 * shipped — see block comment above for the tradeoff). Re-registering an
 * id overwrites the previous consumer entry, including any best-effort
 * synthesized profile.
 */
export function registerProfiles(profiles: readonly ModelProfile[]): void {
  for (const p of profiles) CONSUMER_INDEX.set(p.id, p);
}

/** @internal — test hook. */
export function _testClearConsumerProfiles(): void {
  CONSUMER_INDEX.clear();
}

/** Provider inference for best-effort mode — id prefix conventions only. */
export function inferProviderFromId(id: string): Provider | undefined {
  const lower = id.toLowerCase();
  if (lower.startsWith('claude')) return 'anthropic';
  if (lower.startsWith('gemini') || lower.startsWith('palm')) return 'google';
  if (lower.startsWith('gpt') || /^o[0-9]/.test(lower) || lower.startsWith('chatgpt')) return 'openai';
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('glm')) return 'zai';
  if (lower.startsWith('kimi') || lower.startsWith('moonshot')) return 'moonshot';
  return undefined;
}

/**
 * alpha.87 — best-effort profile synthesis for unprofiled ids (opt-in via
 * `CompilePolicy.onUnprofiledModel: 'best-effort'`; the default posture
 * stays refuse). Returns undefined when the provider cannot be inferred
 * from the id or kgauto ships no donor profile for that provider — in
 * both cases the caller falls back to the standard refusal, which names
 * `registerProfiles()` as the informed path.
 *
 * What a synthesized profile is: the inferred provider's wire mechanics
 * (LoweringSpec / systemPromptMode / streaming are provider-wide, borrowed
 * from a current bundled profile of that provider) around deliberately
 * conservative capability claims — no cliffs, no recovery, no measured
 * knowledge, `structuredOutput: 'none'`, sequential tools, modest output
 * budget, and **cost 0 because cost is UNKNOWN** (cost gates and cost
 * attribution are meaningless for this model; the compile carries a loud
 * warning saying exactly that). It is registered into the consumer index
 * on first synthesis so every later lookup in the process (fallback walk,
 * passes, telemetry) sees one consistent object.
 */
export function bestEffortProfile(id: string): ModelProfile | undefined {
  const canonical = canonicalId(id);
  const existing = tryGetProfile(canonical);
  if (existing) return existing;
  const provider = inferProviderFromId(canonical);
  if (!provider) return undefined;
  const donor =
    PROFILES_RAW.find((p) => p.provider === provider && p.status === 'current') ??
    PROFILES_RAW.find((p) => p.provider === provider);
  if (!donor) return undefined;
  const synth: ModelProfile = {
    id: canonical,
    provider,
    bestEffort: true,
    status: 'preview',
    maxContextTokens: 128_000,
    maxOutputTokens: 4096,
    maxTools: donor.maxTools,
    // alpha.97 — was `false`. That was the SAME MISTAKE as the three profiles
    // corrected in alpha.96, in the one place it does the most damage: applied
    // to models nobody has measured at all.
    //
    // `false` here is capability-REDUCING and unsubstantiated by construction —
    // a synthesized profile exists precisely because we know nothing. It made
    // `getModelCompatibility(<any unprofiled model>, {archetype:'hunt'})`
    // return `requires-adapter` (verified: raw score 5 vs floor 6, adapter
    // offered), so every consumer on `onUnprofiledModel:'best-effort'` was told
    // to serialize tool calls on a model we had never touched.
    //
    // The never-worse-than-raw rule decides it: for an unknown model kgauto
    // must behave exactly as a direct call would, and a direct call passes
    // every tool and lets the provider default apply. `true` is not a claim
    // that the model parallelises — it is the absence of a claim, expressed as
    // non-interference. The honest long-term fix is a third state (unknown)
    // rather than a boolean; that is P4 in the rebuild contract.
    parallelToolCalls: true,
    structuredOutput: 'none',
    systemPromptMode: donor.systemPromptMode,
    streaming: donor.streaming,
    cliffs: [],
    costInputPer1m: 0,
    costOutputPer1m: 0,
    lowering: donor.lowering,
    recovery: [],
    strengths: [],
    weaknesses: ['best-effort synthesized profile — no verified capability data; kgauto does not reduce capability for a model it has never measured (alpha.97)'],
    notes:
      `Synthesized by onUnprofiledModel:'best-effort' (provider ${provider} inferred from id; ` +
      `wire mechanics borrowed from ${donor.id}). No cliffs, no measured knowledge, cost UNKNOWN ` +
      `(recorded as 0). Replace via registerProfiles() for real guards.`,
  };
  CONSUMER_INDEX.set(canonical, synth);
  return synth;
}

/**
 * Resolve a model id to its canonical form (alias → canonical, unknown ids
 * returned unchanged). This is the same resolution `getProfile` applies, so
 * any code comparing model ids against a policy list (blockedModels,
 * preferredModels) must compare canonical forms on BOTH sides — an alias and
 * its canonical are the same model, and a raw-string comparison lets one
 * evade a policy naming the other (alpha.85, tt-intel s119 spend-gate leak).
 */
export function resolveModelAlias(id: string): string {
  return canonicalId(id);
}

const PROFILE_INDEX: ReadonlyMap<string, ModelProfile> = new Map(
  PROFILES_RAW.map((p) => [p.id, p]),
);

export function getProfile(id: string): ModelProfile {
  const canonical = canonicalId(id);
  const fromConsumer = CONSUMER_INDEX.get(canonical);
  if (fromConsumer) return fromConsumer;
  const fromBrain = brainHook.getProfile?.(canonical);
  if (fromBrain) return fromBrain;
  const p = PROFILE_INDEX.get(canonical);
  if (!p) {
    const known = [...PROFILE_INDEX.keys(), ...Object.keys(ALIASES)].join(', ');
    throw new Error(
      `Unknown model id: "${id}". Known: ${known}. ` +
        `For a model kgauto has not onboarded: registerProfiles([...]) supplies a full profile, ` +
        `or policy.onUnprofiledModel:'best-effort' compiles with guards skipped (alpha.87).`,
    );
  }
  return p;
}

export function tryGetProfile(id: string): ModelProfile | undefined {
  const canonical = canonicalId(id);
  return (
    CONSUMER_INDEX.get(canonical) ??
    brainHook.getProfile?.(canonical) ??
    PROFILE_INDEX.get(canonical)
  );
}

export function allProfiles(): readonly ModelProfile[] {
  return PROFILES_RAW;
}

/** @internal — bundled-only access for adapters that need a non-brain
 *  fallback baseline (avoids a brain → profiles → brain re-entry). */
export function allProfilesRaw(): readonly ModelProfile[] {
  return PROFILES_RAW;
}

export function profilesByProvider(provider: Provider): readonly ModelProfile[] {
  return PROFILES_RAW.filter((p) => p.provider === provider);
}
