/**
 * getDefaultFallbackChain — the alpha.9 cascading ship.
 *
 * Returns a per-archetype fallback chain that walks the cost/performance
 * Pareto frontier (master plan §1.3 + §3). Three customer postures:
 *
 *   locked    — caller passes [theOneModel]; never call this function
 *   preferred — caller passes `primary`; chain returned is [primary, ...fallbacks]
 *   open      — caller passes no `primary`; chain returned is [best, ...fallbacks]
 *
 * ## What the default chain optimizes for — READ THIS BEFORE CITING IT
 *
 * The default (`optimizeFor: 'quality'`) chain is ordered by **archetype
 * performance with provider diversity**, NOT by cost. It is a reliability
 * ladder: "if tier 0 fails, who else can do this job well."
 *
 * This docstring previously claimed each step "costs strictly less than the
 * previous." **That claim was false for all ten archetypes** (verified
 * 2026-07-29, alpha.80) and it was load-bearing — kgauto's own cost
 * advisories cited `posture: 'open'` as a cost remedy on the strength of it.
 * At the time, `ask` open posture led with `claude-sonnet-4-6` (retargeted
 * to `claude-sonnet-5` in alpha.90) at ~8.6x the cost
 * of the model the cost advisories recommend. tt-intel came within one
 * un-run function call of tripling their hottest path's spend by following
 * kgauto's own documented advice. See
 * `advisory/kgauto/from-tt-intelligence/2026-07-28_chain-builder-and-cost-advisories-give-opposite-answers.md`.
 *
 * Some non-monotone steps are deliberate and correct: `plan` walks UP to
 * Opus on 429, `critique`/`judge` never degrade below a reasoning floor,
 * and cross-provider anchors are chosen for outage-independence rather
 * than price. The defect was the unconditional claim, not the chains.
 *
 * The default chain at each step:
 *   1. Comes from a different provider than the previous step where possible
 *      (correlated outages don't kill consecutive attempts)
 *   2. Stays above the archetype's perf floor (skip models scored <baseline
 *      for archetypes where degradation would be unacceptable)
 *   3. Makes NO cost guarantee. Pass `optimizeFor: 'cost'` when cost order
 *      is what you want — that mode DOES guarantee monotone-cheaper, and
 *      `assertChainCostMonotonicity` pins it.
 *
 * In alpha.9 the chain is **hand-curated** per archetype (§3.3 starter
 * table). Brain-query mode lands in alpha.10. Policy.blockedModels filters
 * the result; policy.maxCostPerCallUsd is NOT applied here because the
 * function doesn't see the IR's token counts — that filtering happens at
 * `passScoreTargets()` time inside compile().
 *
 * The function is **pure** — no brain query, no I/O, no randomness. Same
 * inputs always produce the same chain.
 */

import type { IntentArchetypeName } from './dialect.js';
import type { ApiKeys, ChainEntry, CompilePolicy, RequiredInputModality } from './ir.js';
import { isModelReachable, type ReachabilityOpts } from './env.js';
import { loadChainsFromBrain } from './chains-brain.js';
import {
  allProfiles,
  inputModalityMiss,
  requiredInputModalities,
  tryGetProfile,
  priceAtInput,
  type ModelProfile,
} from './profiles.js';
import { canonicalPolicySet, isProviderBlocked, policySetHas } from './policy-match.js';
import { getArchetypePerfScore } from './archetype-perf-brain.js';
import { ARCHETYPE_FLOOR_DEFAULT } from './compatibility.js';

/**
 * Posture passed into `getDefaultFallbackChain`. The chain function only
 * sees `'open'` and `'preferred'` — callers in `'locked'` posture should
 * pass `models: [theOneModel]` directly and skip this function entirely.
 *
 * Equivalent to `CompilePolicy.posture` minus `'locked'`. Kept distinct so
 * the type system enforces "don't ask for a chain when you don't want one."
 */
export type FallbackPosture = 'open' | 'preferred';

export interface GetDefaultFallbackChainOpts {
  /** The archetype the call is performing. Drives chain shape. */
  archetype: IntentArchetypeName;
  /**
   * The user-selected or caller-anchored primary model. When provided, it
   * appears at position 0 of the returned chain and fallbacks follow.
   * When omitted, the function picks the best-perf model for the archetype
   * as position 0 (open posture).
   */
  primary?: string;
  /**
   * Informational. `'preferred'` and `'open'` produce the same chain shape
   * given the same `primary`/no-primary input — posture is a tag the brain
   * uses to distinguish "user-anchored" from "library-anchored" telemetry.
   */
  posture?: FallbackPosture;
  /**
   * Cap on chain length. Default 3. Min 1. Useful when the consumer wants
   * to keep the worst-case latency low (each fallback adds a round-trip).
   */
  maxDepth?: number;
  /**
   * Consumer-side gating. `blockedModels` are filtered from the chain.
   * `preferredModels` is informational (no boost applied at this layer —
   * compile()'s `passScoreTargets` handles preference ranking).
   * `maxCostPerCallUsd` is NOT applied here — needs IR-level token
   * estimation. Use compile()'s policy plumbing instead.
   */
  policy?: CompilePolicy;
  /**
   * alpha.10. When provided, the chain is filtered to models whose provider
   * has a reachable API key (via `apiKeys` or one of `PROVIDER_ENV_KEYS[provider]`).
   * Models whose provider can't be reached are silently dropped. If filtering
   * leaves the chain empty, returns `[]` — caller decides what to do (call()
   * throws CallError; this function stays pure).
   *
   * Pass `{}` to opt in with `process.env` as the env source. Pass `{ apiKeys, envSource }`
   * for explicit control (tests, non-Node runtimes). Omit entirely for the
   * legacy unfiltered behavior — preserves alpha.9 callers byte-for-byte.
   *
   * alpha.104: add `servableProviders: ['anthropic', 'google', …]` to state
   * which providers this runtime has an SDK for. A key alone is not
   * reachability — tt-intelligence's chains ended in an OpenAI model their
   * runtime could not construct, with `OPENAI_API_KEY` set the whole time.
   */
  reachability?: ReachabilityOpts;
  /**
   * alpha.20 E3: consumer-declared tool-orchestration shape. Currently
   * only affects `archetype: 'hunt'`, where 'sequential' swaps the
   * parallel-tool-tier-0 chain (Flash → Pro → Sonnet → Haiku) for a
   * DeepSeek-tier-0 chain (V4-Pro → Flash → Sonnet) — DeepSeek's L-040
   * parallel-tool cliff doesn't apply when the consumer commits to
   * single-step orchestration.
   *
   * Other archetypes are NOT mode-aware in this release — they ship the
   * same chain regardless of toolOrchestration. Future versions may
   * extend mode-awareness to ask/generate/etc. when brain evidence
   * supports it.
   *
   * Default (omitted or 'either'): parallel chain. Back-compat with all
   * pre-alpha.20 callers.
   */
  toolOrchestration?: 'parallel' | 'sequential' | 'either';
  /**
   * alpha.80 — what the chain ORDER optimizes for.
   *
   *   'quality' (default) — status quo, byte-for-byte. Hand-curated /
   *      brain-loaded archetype ladder: best perf first, provider diversity
   *      down the chain. Makes NO cost guarantee (see module docstring).
   *
   *   'cost' — cheapest-first among every `status: 'current'` model whose
   *      `archetypePerf[archetype]` clears {@link ARCHETYPE_FLOOR_DEFAULT}.
   *      Guarantees monotone-cheaper. Considers the WHOLE roster, not just
   *      the curated chain — which is the point: `gemini-2.5-flash` ties
   *      `claude-haiku-4-5` on `ask` perf at a third of the price and is
   *      absent from the curated `ask` ladder entirely.
   *
   * The quality floor is what keeps 'cost' honest: a model with no evidence
   * scores the neutral 5 and is therefore excluded, so cost mode can never
   * bottom-feed into unmeasured models. Quality stays a binary floor; cost
   * optimizes only above it.
   *
   * Default 'quality' — existing consumers see zero change on bump.
   */
  optimizeFor?: 'quality' | 'cost';
  /**
   * alpha.119 — the calling app; when given, cost mode scores each candidate
   * with the app's own measured row first, exactly as `compile()` does —
   * alpha.112 R3; without it, judgment and the fleet's measured rows as before.
   *
   * Read by `optimizeFor: 'cost'` only. Quality mode does not read it here:
   * `compile()` already applies the app's measured row when it ranks.
   */
  appId?: string;
  /**
   * alpha.124 — input modalities the call will carry (text implied). When
   * present and non-empty, the chain keeps only models whose
   * `ModelProfile.inputModalities` declares every one — a model whose profile
   * does not declare the field is dropped too (not declared ≠ accepts). Applied
   * after dedupe and BEFORE reachability and the `maxDepth` cap, so a dropped
   * model never spends a slot. The primary is filtered like any other entry.
   * Absent → the chain is byte-identical to before alpha.124.
   */
  inputModalities?: ReadonlyArray<RequiredInputModality>;
}

/**
 * alpha.124 — keep only ids whose profile declares every required modality.
 * Identity (same array) when nothing is required, so a call without the
 * constraint is untouched by construction.
 */
function filterByInputModality<T>(
  entries: T[],
  idOf: (e: T) => string,
  inputModalities: ReadonlyArray<RequiredInputModality> | undefined,
): T[] {
  const required = requiredInputModalities(inputModalities);
  if (!required) return entries;
  return entries.filter((e) => inputModalityMiss(tryGetProfile(idOf(e)), required) === undefined);
}

// ─────────────────────────────────────────────────────────────────────────
// COST ORDERING — alpha.80
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reference call shape used to RANK models by cost. Deliberately a blend
 * rather than input-only: ranking by `costInputPer1m` alone (which the
 * advisor's `cost-mismatched-archetype` rule does) mis-orders any pair
 * whose output multiple differs, and real traffic runs input-heavy
 * (L-050: >85% input is the universal efficiency signal).
 *
 * This ranks; it does not bill. `estimateChainCostUsd` is exported so
 * callers who know their real shape can compute against it instead.
 */
export const COST_RANKING_REFERENCE_SHAPE = {
  inputTokens: 4_000,
  outputTokens: 250,
} as const;

/**
 * Estimated USD for one call at a given shape. Exported so the advisor and
 * consumer-side code share ONE derivation of "what does this model cost
 * here" — two independent derivations of one concept will drift (s75).
 */
export function estimateModelCostUsd(
  profile: ModelProfile,
  shape: { inputTokens: number; outputTokens: number } = COST_RANKING_REFERENCE_SHAPE,
): number {
  // alpha.81 (tt-intel s118, Finding 3): this used to be named
  // `estimateChainCostUsd` despite taking a single MODEL, and returned NaN
  // rather than throwing when handed a chain — two of their probes died
  // silently on it before they read the `.d.ts`. Silent wrong-shape is the
  // same "nothing happened, no error" signature both projects keep filing
  // about, and it is worse here because this is the shared derivation that
  // keeps the advisor and the chain builder from drifting.
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    typeof profile.costInputPer1m !== 'number' ||
    typeof profile.costOutputPer1m !== 'number'
  ) {
    throw new TypeError(
      `estimateModelCostUsd: expected a single ModelProfile, got ${
        Array.isArray(profile) ? 'an array (a chain? map over it)' : typeof profile
      }. For a chain: chain.map((id) => estimateModelCostUsd(getProfile(id))).`,
    );
  }
  // alpha.128 — priced at the tier the shape's input falls in (the provider's
  // prompt-length steps, `costTiers`); the base price below the first step.
  const price = priceAtInput(profile, shape.inputTokens);
  return (
    (shape.inputTokens / 1_000_000) * price.costInputPer1m +
    (shape.outputTokens / 1_000_000) * price.costOutputPer1m
  );
}

/**
 * @deprecated alpha.81 — renamed to {@link estimateModelCostUsd}; it takes a
 * single MODEL, not a chain. Preserved because alpha.80 shipped this name and
 * a consumer adopted it within hours. Identical behavior.
 */
export const estimateChainCostUsd = estimateModelCostUsd;

/**
 * Builds the cost-ordered candidate list for an archetype: every
 * `status: 'current'` profile clearing the archetype perf floor, strictly
 * cheapest-first.
 *
 * **Cost mode does NOT guarantee provider diversity.** Strict cost order is
 * the whole contract, so the returned chain can be provider-uniform — which
 * is a real outage exposure, because the chain exists in the first place
 * because providers fail. That trade is stated rather than smuggled: an
 * earlier draft of this function interleaved a diversity pass and would have
 * broken the monotone-cheaper guarantee one commit after documenting it,
 * which is the exact defect this release exists to fix. Consumers who want
 * both should read `chainProviderSpread()` and decide knowingly; quality
 * mode is the provider-diverse one.
 */
function buildCostOrderedChain(archetype: IntentArchetypeName, appId?: string): string[] {
  return allProfiles()
    .filter((p) => p.status === 'current')
    .filter(
      (p) => getArchetypePerfScore(p.id, archetype, appId).score >= ARCHETYPE_FLOOR_DEFAULT,
    )
    .map((p) => ({ p, cost: estimateChainCostUsd(p) }))
    .sort((a, b) => a.cost - b.cost || a.p.id.localeCompare(b.p.id))
    .map((e) => e.p.id);
}

/**
 * How many distinct providers a chain spans. `1` means every fallback shares
 * one provider's fate — the chain buys you retries, not outage independence.
 * Exported so a cost-mode consumer can check what they traded away.
 */
export function chainProviderSpread(chain: readonly string[]): number {
  const providers = new Set<string>();
  for (const id of chain) {
    const p = tryGetProfile(id);
    if (p) providers.add(p.provider);
  }
  return providers.size;
}

// ─────────────────────────────────────────────────────────────────────────
// STARTER CHAINS — per-archetype hand-curated frontier walks
// ─────────────────────────────────────────────────────────────────────────

/**
 * Master plan §3.3 starter table — grounded shape (alpha.21 / s78 Entry 1).
 * Each chain is read top-to-bottom as tier 0 → tier 1 → tier 2 → (tier 3).
 * Construction principles:
 *
 *   - Tier 0: best perf for the archetype (or cost/perf balance)
 *   - Tier 1: same provider when reasoning depth matters (plan/critique
 *             walk UP to Opus on 429); cross-provider when cost-sensitive
 *   - Tier 2: cross-provider anchor in similar quality bracket
 *   - Tier 3: emergency floor for tolerant archetypes; omitted where
 *             degradation would be unacceptable (extract/critique)
 *
 * Every entry carries a `grounding` label declaring its provenance. The
 * inline comments that historically lived next to chain entries now live
 * as `reason` strings. Defaults are HONEST:
 *
 *   - 'measured'         only when brain rows back the placement (currently:
 *                        classify tier 1, summarize tier 1, and — alpha.108 —
 *                        the generate/extract tier 0 kept on golden runs
 *                        #23/#22).
 *
 * alpha.108 invariant (PB filing 2026-09-05, "cold isolates rank generate onto
 * the model your eval declined"): a bundled chain HEAD says what the brain's
 * tier 0 says. The bundle is what a cold isolate ranks on; the brain chain is
 * the routing policy every warm consumer gets; when they disagree the same
 * consumer is served two different models by temperature. A legacy model may
 * sit at a bundled position ONLY with its current same-family successor
 * directly behind it (deprecation cover — the chain walks on if it is
 * retired), which is the invariant the brain's parity chains axis enforces.
 * `tests/roster-status-drift.test.ts` guards it in the bundle;
 * `scripts/cross-surface-parity.mjs` compares bundle heads to brain tier 0
 * daily.
 *   - 'capability-fact'  L-040 cliff exclusions, structured-output rejects,
 *                        and the parallel-tool tier-0 placements in `hunt`.
 *   - 'judgment'         everything else. Cold-start prior, awaiting
 *                        evidence to graduate to 'measured'.
 *
 * Beyond 4 fallback levels usually masks a real problem; chains stop at 4.
 */
const STARTER_CHAINS_GROUNDED: Record<IntentArchetypeName, ChainEntry[]> = {
  // Reasoning floor — never degrade. Walk UP on 429 to Opus → cross-provider.
  critique: [
    { id: 'claude-opus-5', grounding: 'judgment', reason: 'Highest reasoning bar, no degradation tier — engineer pick, awaiting measured backing. alpha.90: retargeted from legacy claude-opus-4-7 (Opus 5 generation current since 2026-07-25; same drift class as the b3d919b judge default)' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'Same-provider walk-down from Opus on 429. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    // alpha.86: gemini-2.5-pro dropped — availability-restricted (tt-intel
    // measured 4/4 cohort refusal 2026-08-02; kgauto key free-tier-quota
    // 429 2026-08-08). No current Google model clears the critique floor
    // (3.5-flash critique=5; 3.1-pro-preview scores 10 but is preview —
    // default chains carry promoted models only). deepseek-v4-pro takes the
    // third-provider tail instead.
    { id: 'gpt-5.5', grounding: 'judgment', reason: 'alpha.16: third-provider frontier-tier floor (archetypePerf=9)' },
    { id: 'deepseek-v4-pro', grounding: 'judgment', reason: 'alpha.86: third-provider tail replacing availability-restricted gemini-2.5-pro — critique=6 clears the floor exactly; last-resort when Anthropic AND OpenAI are down, not a quality peer of the tiers above' },
  ],
  // alpha.62 (eval spine) — pairwise output comparison. Same reasoning-floor
  // posture as critique (a verdict from a weak judge is worse than no
  // verdict); tier 0 anchored on the CURRENT opus (4-8, s64 roster). Strict
  // JSON output, so every tier declares native structured output.
  judge: [
    { id: 'claude-opus-5', grounding: 'judgment', reason: 'Highest reasoning bar for pairwise verdicts — current opus. alpha.90: retargeted from legacy claude-opus-4-8, matching DEFAULT_JUDGE_MODEL (moved in b3d919b); verdict comparability preserved by judge_model on every run/case row' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'Same-provider walk-down on 429. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    // alpha.86: gemini-2.5-pro dropped (availability-restricted; see critique
    // note). gpt-5.5 remains the cross-provider frontier floor for verdicts.
    { id: 'gpt-5.5', grounding: 'judgment', reason: 'Third-provider frontier-tier floor' },
    { id: 'deepseek-v4-pro', grounding: 'judgment', reason: 'alpha.86: third-provider tail replacing availability-restricted gemini-2.5-pro — native structured output per the judge contract; last-resort tier' },
  ],
  // Reasoning matters — Sonnet primary; walk UP to Opus on 429.
  plan: [
    { id: 'claude-sonnet-4-6', grounding: 'judgment', reason: 'alpha.108: the brain chain\'s tier 0 — kept through the 2026-09-05 additive re-anchor; nothing has measured sonnet-5 better on plan. Bundle follows the brain so cold == warm. sonnet-5 sits directly behind it (deprecation cover, not replacement): if 4-6 is retired the chain walks on without a gap.' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'alpha.108: tier 1 — the current successor behind the measured/kept 4-6 head (deprecation cover). Previously head from alpha.90 by judgment. Reasoning + cost balance — engineer pick. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    { id: 'claude-opus-5', grounding: 'judgment', reason: 'Same-provider walk-UP on 429 (rare exception to "always cheaper"). alpha.90: retargeted from legacy claude-opus-4-7' },
    { id: 'gemini-3.7-flash', grounding: 'judgment', reason: 'alpha.101: cross-provider anchor = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; docs-verified, zero observed rows — a chain TAIL, served only when the tiers above fail). alpha.86 history: replaced availability-restricted gemini-2.5-pro' },
    { id: 'deepseek-v4-pro', grounding: 'judgment', reason: 'Tier 3 cost floor — no brain evidence yet' },
    { id: 'gpt-5.4', grounding: 'judgment', reason: 'alpha.33: third-provider tail (archetypePerf=7) — closes openai-in-default-fallback-chains' },
  ],
  // Quality + cost match.
  generate: [
    { id: 'claude-sonnet-4-6', grounding: 'measured', reason: 'alpha.108: the brain chain\'s tier 0, kept on a MEASUREMENT — golden run #23 (playbacksam generate, 24 cases, Opus-5 judge, 2026-09-05): sonnet-5 won-or-tied 79% (bar 80%), 2.19× slower, 2.0× cost, so the successor was NOT promoted. The bundle now says what the brain says, so a cold isolate ranks as a warm one does (PB filing 2026-09-05: cold ranked onto the declined candidate at 1.8–2.6× latency). sonnet-5 sits directly behind it (deprecation cover, not replacement): if 4-6 is retired the chain walks on without a gap.', n: 24 },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'alpha.108: tier 1 — the current successor behind the measured/kept 4-6 head (deprecation cover). Previously head from alpha.90 by judgment. Quality + cost match — engineer pick. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Same-provider step-down' },
    { id: 'claude-haiku-5-5', grounding: 'judgment', reason: 'alpha.125: Anthropic lists haiku-4-5 under Legacy (2026-10-25 read; retirement floor 2026-10-15 passed) — 5.5 enters directly behind it as deprecation cover, unmeasured; moves ahead only on a golden measurement' },
    { id: 'gemini-3.7-flash', grounding: 'judgment', reason: 'alpha.101: cross-provider anchor = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; docs-verified, zero observed rows — a chain TAIL, served only when the tiers above fail). alpha.86 history: replaced availability-restricted gemini-2.5-pro' },
    { id: 'gpt-5.4-mini', grounding: 'judgment', reason: 'alpha.16: third-provider tail (archetypePerf=7) — closes mono-Anthropic gap' },
  ],
  // ask::sonnet — STARTER_CHAINS calls this "Quality + cost match" but
  // tt-intel s78 prod data showed 27% empty rate. Labeled 'judgment' until
  // evidence either validates or refutes the placement.
  ask: [
    { id: 'claude-sonnet-4-6', grounding: 'judgment', reason: 'alpha.108: the brain chain\'s tier 0 — kept through the 2026-09-05 additive re-anchor because nothing has measured sonnet-5 better on ask (on generate, run #23 declined it). The bundle follows the brain so a cold isolate ranks as a warm one does. sonnet-5 sits directly behind it (deprecation cover, not replacement): if 4-6 is retired the chain walks on without a gap.' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'alpha.108: tier 1 — the current successor behind the measured/kept 4-6 head (deprecation cover). Previously head from alpha.90 by judgment. Quality + cost match — engineer pick. alpha.90: retargeted from legacy claude-sonnet-4-6 (whose tt-intel s78 27% empty rate was never validated; the empty-rate NOTE does not transfer to sonnet-5 — fresh model, fresh measurement)' },
    { id: 'claude-haiku-5-5', grounding: 'measured', reason: 'alpha.125: moved directly AHEAD of haiku-4-5 on a MEASUREMENT — golden run #45 (playbacksam/ask, 6W/22T/2L of 30 = 93%, judge claude-opus-5, bar 80%) PROMOTE-READY. haiku-4-5 (Legacy on Anthropic\'s page, read 2026-10-25) stays directly behind it. (was: directly behind haiku-4-5, unmeasured, until the run landed 2026-10-25)', n: 30 },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Same-provider step-down' },
    { id: 'gemini-3.7-flash', grounding: 'judgment', reason: 'alpha.101: cross-provider anchor = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; docs-verified, zero observed rows — a chain TAIL, served only when the tiers above fail). alpha.86 history: replaced availability-restricted gemini-2.5-pro' },
    { id: 'gpt-5.4-mini', grounding: 'judgment', reason: 'alpha.16: third-provider tail (archetypePerf=7)' },
  ],
  // Structured-output archetype — Flash skipped (alpha.8 MAX_TOKENS cliff,
  // capability-fact); DeepSeek skipped (no brain evidence).
  extract: [
    { id: 'claude-sonnet-4-6', grounding: 'measured', reason: 'alpha.108: the brain chain\'s tier 0, kept on a MEASUREMENT — golden run #22 (playbacksam extract, 10 cases, Opus-5 judge, 2026-09-05): sonnet-5 won-or-tied 50% (3W/2T/5L) against 4-6, bar 80%. Bundle follows the brain so cold == warm. sonnet-5 sits directly behind it (deprecation cover, not replacement): if 4-6 is retired the chain walks on without a gap.', n: 10 },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'alpha.108: tier 1 — the current successor behind the measured/kept 4-6 head (deprecation cover). Previously head from alpha.90 by judgment. Reliable structured-output anchor — engineer pick. alpha.90: retargeted from legacy claude-sonnet-4-6 (which served the believe-card endpoint\'s first real call 2026-08-26 while daily-ops had been advising consumers OFF it for weeks)' },
    { id: 'claude-haiku-5-5', grounding: 'measured', reason: 'alpha.125: moved directly AHEAD of haiku-4-5 on a MEASUREMENT — golden run #44 (playbacksam/extract, 23W/4T/3L of 30 = 90%, judge claude-opus-5, bar 80%) PROMOTE-READY. haiku-4-5 (Legacy on Anthropic\'s page, read 2026-10-25) stays directly behind it. (was: directly behind haiku-4-5, unmeasured, until the run landed 2026-10-25)', n: 30 },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Same-provider step-down with native structured output' },
    { id: 'gemini-3.7-flash', grounding: 'judgment', reason: 'alpha.101: cross-provider anchor with native structured output = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; zero observed rows — a chain tail)' },
    { id: 'gpt-5.4', grounding: 'capability-fact', reason: 'alpha.16: third-provider floor — native structured-output capability (archetypePerf=8)' },
  ],
  // Forgiving archetype — Sonnet primary but Flash safely floors it.
  transform: [
    { id: 'claude-sonnet-4-6', grounding: 'judgment', reason: 'alpha.108: the brain chain\'s tier 0 — kept through the 2026-09-05 additive re-anchor; nothing has measured sonnet-5 better on transform. Bundle follows the brain so cold == warm. sonnet-5 sits directly behind it (deprecation cover, not replacement): if 4-6 is retired the chain walks on without a gap.' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'alpha.108: tier 1 — the current successor behind the measured/kept 4-6 head (deprecation cover). Previously head from alpha.90 by judgment. Quality anchor — engineer pick. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Same-provider step-down' },
    { id: 'claude-haiku-5-5', grounding: 'judgment', reason: 'alpha.125: Anthropic lists haiku-4-5 under Legacy (2026-10-25 read; retirement floor 2026-10-15 passed) — 5.5 enters directly behind it as deprecation cover, unmeasured; moves ahead only on a golden measurement' },
    { id: 'gemini-3.7-flash', grounding: 'judgment', reason: 'alpha.101: cross-provider anchor = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; docs-verified, zero observed rows — a chain TAIL, served only when the tiers above fail). alpha.86 history: replaced availability-restricted gemini-2.5-pro' },
    { id: 'gpt-5.4-mini', grounding: 'judgment', reason: 'alpha.108: moved ahead of the Google cost floor so the default chain (depth 5) keeps three providers. alpha.33: third-provider tail (archetypePerf=7) — closes openai-in-default-fallback-chains' },
    // alpha.130: the gemini-2.5-flash cost floor left the chain (Google: deprecated, shutdown
    // 2026-12-01). (was: { id: 'gemini-2.5-flash', reason: 'Cost floor — forgiving archetype tolerates Flash' }, until 2026-11-09)
  ],
  // Parallel-tool throughput champion — Flash leads on the L-040 cliff
  // (capability-fact: Flash 15-75 parallel calls/step vs DeepSeek 7-8).
  // alpha.130 — gemini-2.5-flash (the L-040 measurement's model) left the chain on Google's
  // dated retirement (2026-12-01); no hunt golden set exists, so the new head is placed, not measured.
  hunt: [
    { id: 'gemini-3.8-flash', grounding: 'judgment', reason: 'alpha.130: head UNMEASURED — placed by Google\'s 2026-12-01 retirement of gemini-2.5-flash (no hunt golden set exists on any app) and the curated hunt 9 (Flash-family parallel-tool tier, L-040, family-labelled): the best-scored Google flash whose provider lifecycle is active and whose kgauto status is current. List price $0.75 / $3.75 per 1M (through 2026-12-31; $1.50 / $7.50 from 2027-01-01) against the retired head\'s $0.30 / $2.50 — 2.5× on input, 1.5× on output. 3 hunt calls in 30 d on the brain, all already naming this model (tt-intelligence). gemini-3.5-flash-lite (hunt 5, under the floor 6) is NOT placed here: Google routing the retired id to it is Google\'s choice, not a measurement.' },
    { id: 'gemini-3.7-flash', grounding: 'capability-fact', reason: 'alpha.101: parallel-tool agentic tier (hunt archetypePerf 9 family-inherited, L-040 family) = the gemini-flash family head; 3.5-flash legacy per Google 2026-09-03' },
    { id: 'claude-sonnet-5', grounding: 'judgment', reason: 'Quality safety net for blocked-Flash case. alpha.90: retargeted from legacy claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Reduced tool budget — cliff at 16 fires' },
    { id: 'claude-haiku-5-5', grounding: 'judgment', reason: 'alpha.125: Anthropic lists haiku-4-5 under Legacy (2026-10-25 read; retirement floor 2026-10-15 passed) — 5.5 enters directly behind it as deprecation cover, unmeasured; moves ahead only on a golden measurement' },
    { id: 'gpt-5.4-mini', grounding: 'judgment', reason: 'alpha.33: third-provider tail — OpenAI parallel-tool capable archetype' },
  ],
  // Cost-sensitive + tolerant.
  // alpha.130 (amendment C) — gemini-2.5-flash left the head on Google's 2026-12-01 retirement
  // (after it a call naming it is served by gemini-3.5-flash-lite, 32 % on #57). No candidate
  // cleared the bar against it (#56–#59); the floor-then-price order picks claude-haiku-5-5.
  // (was: [gemini-2.5-flash, deepseek-flash, claude-haiku-5-5, claude-haiku-4-5,
  // gemini-3.5-flash-lite, gpt-5.4-nano], until 2026-11-09)
  summarize: [
    { id: 'claude-haiku-5-5', grounding: 'measured', reason: 'alpha.130: heads summarize on the retirement of gemini-2.5-flash (2026-12-01); golden run #56 (playbacksam/summarize, 19W/7T/19L of 45 = 58 %, judge claude-opus-5) is BELOW the 80 % bar — so are #57 flash-lite 32 %, #58 deepseek-flash 62 % with 18 schema violations, #59 gemini-3.8-flash 61 % at 2× the cost; chosen as the best floor-holding record at the lowest price; #46 (92 % vs haiku-4-5) stands behind it. (alpha.125 history: moved directly AHEAD of haiku-4-5 on golden run #46, playbacksam/summarize, 23W/1T/2L of 26 = 92 %, PROMOTE-READY)', n: 45 },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Quality safety net' },
    { id: 'deepseek-flash', grounding: 'judgment', reason: 'alpha.109: V4.1-Flash in the tier-1 cost slot — the n=169 measurement was V4-Flash (retired 2026-09-10; that id is now served by this model anyway). Same slot, same wire model; V4.1 itself unmeasured until the delta report replays it. alpha.130: #58: 18 of 47 schema violations on playbacksam/summarize, 2026-11-09 — behind the safety net until a run holds the floor. (was: tier 1, until 2026-11-09)' },
    { id: 'gemini-3.5-flash-lite', grounding: 'judgment', reason: 'Emergency floor. alpha.91: retargeted from availability-restricted gemini-2.5-flash-lite (Google refuses it for new accounts, TT-49 2026-08-26); 3.5-flash-lite is the successor Google’s own error names. alpha.130: #57: 32 % vs the retired head (gemini-2.5-flash) on playbacksam/summarize' },
    { id: 'gpt-5.4-nano', grounding: 'judgment', reason: 'alpha.33: third-provider tail (archetypePerf=6) — cheapest OpenAI, matches summarize cost-band' },
  ],
  // Brain-validated DeepSeek tier 1 (169 rows, 0% empty rate).
  // alpha.130 — the head moved by a MEASUREMENT against the head itself (golden run #55);
  // gemini-2.5-flash left the chain (Google: deprecated, shutdown 2026-12-01, routed to
  // gemini-3.5-flash-lite — a fallover from flash-lite to it would retry the same served model).
  classify: [
    { id: 'gemini-3.5-flash-lite', grounding: 'measured', reason: 'alpha.130: head on a MEASUREMENT against the head itself — golden run #55 (tt-intelligence/classify, incumbent gemini-2.5-flash, 5W/37T/8L of 50 = 84% not worse, 0 floor violations, p50 latency ratio 1.07, cost over the set $0.0034 vs $0.0034, judge claude-opus-5 order-swapped, bar 80%) PROMOTE-READY. gemini-2.5-flash (Google: deprecated, shutdown 2026-12-01, routed to this model) left the chain the same release. (was: the chain floor at tier 4, by judgment — cache-discount 10× for repeat-prompt workloads; alpha.91 retargeted from availability-restricted gemini-2.5-flash-lite — until 2026-11-09)', n: 50 },
    { id: 'deepseek-flash', grounding: 'judgment', reason: 'alpha.109: V4.1-Flash in the tier-1 slot — the 169-row 0%-empty measurement was V4-Flash (retired 2026-09-10; that id now serves this model). Same slot, same wire model; V4.1 unmeasured until replayed.' },
    { id: 'claude-haiku-4-5', grounding: 'judgment', reason: 'Quality safety net' },
    { id: 'claude-haiku-5-5', grounding: 'measured', reason: 'alpha.125: kept directly BEHIND haiku-4-5 as the record of intent (deprecation cover). Golden run #47 (tt-intelligence/classify, 1W/21T/8L of 30 = 73%, judge claude-opus-5, bar 80%) was BELOW-BAR, so its classify perf is held at 5, under ARCHETYPE_FLOOR_DEFAULT (6): cost mode and family resolution exclude it until a run clears the bar. The quality-mode chain walk does not filter on the floor — the entry is served here only if every tier ahead of it fails.', n: 30 },
    { id: 'gpt-5.4-nano', grounding: 'judgment', reason: 'alpha.33: third-provider tail (archetypePerf=6) — cheapest OpenAI for classify' },
  ],
};

/**
 * String-only view of STARTER_CHAINS_GROUNDED. Preserved for back-compat
 * with `chains-brain.ts` (the brain table only stores model ids per tier;
 * grounding metadata is code-only), `getStarterChain`, `getAllStarterChains`,
 * and the legacy `getDefaultFallbackChain` return shape.
 *
 * Derived once at module load — STARTER_CHAINS_GROUNDED is the source of truth.
 */
/**
 * alpha.130 (amendment B4) — the word a sentence uses for an archetype's chain head: the head
 * entry's OWN grounding, never more. *measured* appears only where the entry's grounding is
 * `measured` AND a run is named. The three heads alpha.130 moved carry the filing's words
 * (B4, C5) and the model they replaced; a fixed word applies only while its model is still that
 * archetype's head entry.
 */
const CHAIN_HEAD_WORDS: Partial<Record<IntentArchetypeName, { id: string; replaces: string; word: string }>> = {
  classify: { id: 'gemini-3.5-flash-lite', replaces: 'gemini-2.5-flash', word: 'measured (golden run #55)' },
  hunt: { id: 'gemini-3.8-flash', replaces: 'gemini-2.5-flash', word: 'curated, unmeasured; placed by the 2026-12-01 retirement' },
  summarize: {
    id: 'claude-haiku-5-5',
    replaces: 'gemini-2.5-flash',
    word: "measured — golden run #56, not worse on 26 of 45, below the 80 % bar, the best floor-holding record of four candidates at the lowest price; the retired head's own 12-01 replacement measured 32 %",
  },
};

/**
 * alpha.130 (B4) — did this archetype's head entry replace `staleId` as the head? True for the
 * three heads alpha.130 moved off `gemini-2.5-flash`, while each is still the bundled head. The
 * stale-model advisory names such a head as the replacement; elsewhere it keeps the family head.
 */
export function chainHeadReplaced(archetype: IntentArchetypeName, headId: string, staleId: string): boolean {
  const fixed = CHAIN_HEAD_WORDS[archetype];
  return !!fixed && fixed.id === headId && fixed.replaces === staleId && STARTER_CHAINS_GROUNDED[archetype]?.[0]?.id === headId;
}

export function chainHeadGroundingWord(archetype: IntentArchetypeName, id: string): string {
  const fixed = CHAIN_HEAD_WORDS[archetype];
  const entry = STARTER_CHAINS_GROUNDED[archetype]?.find((e) => e.id === id);
  if (fixed && fixed.id === id && entry) return fixed.word;
  if (!entry) return "the brain's chain head; no bundled grounding for it";
  if (entry.grounding === 'measured') {
    const run = /golden run #(\d+)/.exec(entry.reason ?? '');
    return run ? `measured (golden run #${run[1]})` : `placed on brain evidence (n=${entry.n ?? 0}), no run named`;
  }
  if (entry.grounding === 'capability-fact') return 'a capability fact, unmeasured';
  return 'curated, unmeasured';
}

const STARTER_CHAINS: Record<IntentArchetypeName, string[]> = (() => {
  const out: Partial<Record<IntentArchetypeName, string[]>> = {};
  for (const [archetype, entries] of Object.entries(STARTER_CHAINS_GROUNDED)) {
    out[archetype as IntentArchetypeName] = entries.map((e) => e.id);
  }
  return out as Record<IntentArchetypeName, string[]>;
})();

// ─────────────────────────────────────────────────────────────────────────
// STARTER CHAINS BY MODE — alpha.20 E3 per-mode overlays
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-`toolOrchestration` chain overlays. When a consumer declares
 * `toolOrchestration: 'sequential'`, the hunt chain swaps to a
 * DeepSeek-tier-0 ordering because the L-040 parallel-tool cliff doesn't
 * apply at single-step granularity.
 *
 * Only `hunt` ships mode-aware in alpha.20 — the archetype where the
 * mode flip materially changes which model wins. Other archetypes
 * resolve via `STARTER_CHAINS[archetype]` regardless of mode; future
 * releases may extend this map when brain evidence supports it.
 *
 * `parallel` and `either` fall through to the default `STARTER_CHAINS`
 * entry — only `sequential` overrides. (Conceptually 'either' could pick
 * brain-best per mode in a future version; today it stays status-quo for
 * back-compat.)
 */
const STARTER_CHAINS_BY_MODE_GROUNDED: Partial<
  Record<IntentArchetypeName, { sequential?: ChainEntry[] }>
> = {
  hunt: {
    sequential: [
      {
        id: 'deepseek-v4-pro',
        grounding: 'judgment',
        reason: 'alpha.20 E3: cheap + good reasoning at single-step granularity; L-040 cliff silenced when sequential — hypothesis not yet measured',
      },
      {
        id: 'deepseek-flash', // alpha.109: V4.1-Flash (the retired v4-flash id serves this model)
        grounding: 'judgment',
        reason: 'Cheapest viable; sibling-provider fallback',
      },
      {
        id: 'claude-sonnet-5',
        grounding: 'judgment',
        reason: 'Cross-provider safety net — Sonnet handles sequential agentic loops cleanly. alpha.90: retargeted from legacy claude-sonnet-4-6',
      },
      {
        id: 'gemini-3.7-flash',
        grounding: 'judgment',
        reason: 'alpha.101: third-provider tail when no DeepSeek key reachable = the gemini-flash family head (3.5-flash legacy per Google 2026-09-03; zero observed rows — a chain tail)',
      },
    ],
  },
};

const STARTER_CHAINS_BY_MODE: Partial<
  Record<IntentArchetypeName, { sequential?: string[] }>
> = (() => {
  const out: Partial<Record<IntentArchetypeName, { sequential?: string[] }>> = {};
  for (const [archetype, modes] of Object.entries(STARTER_CHAINS_BY_MODE_GROUNDED)) {
    if (modes?.sequential) {
      out[archetype as IntentArchetypeName] = {
        sequential: modes.sequential.map((e) => e.id),
      };
    }
  }
  return out;
})();

/**
 * Internal helper — returns the right starter chain for the archetype +
 * mode combo. Brain-driven chains take precedence over the bundled
 * per-mode overlay (the brain only stores the parallel/default chain
 * today; mode-aware brain rows are a future migration). When mode is
 * 'sequential' AND a hardcoded overlay exists for the archetype, the
 * overlay wins.
 */
function resolveStarterForMode(
  archetype: IntentArchetypeName,
  toolOrchestration: 'parallel' | 'sequential' | 'either' | undefined,
  allChains: Record<IntentArchetypeName, string[]>,
): string[] | undefined {
  if (toolOrchestration === 'sequential') {
    const overlay = STARTER_CHAINS_BY_MODE[archetype]?.sequential;
    if (overlay) return [...overlay];
  }
  // parallel / either / undefined → status-quo chain.
  return allChains[archetype];
}

// ─────────────────────────────────────────────────────────────────────────
// THE FUNCTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns the fallback chain for an archetype as a plain `string[]` of
 * model ids.
 *
 * @deprecated since alpha.21 — prefer
 * {@link getDefaultFallbackChainWithGrounding}, which returns the same chain
 * shape with a `grounding` label on every entry (measured / capability-fact /
 * judgment). The string[] return is preserved indefinitely for back-compat —
 * no functional change in alpha.21. Existing callers don't need to migrate
 * unless they want to surface the grounding gap to users.
 */
export function getDefaultFallbackChain(
  opts: GetDefaultFallbackChainOpts,
): string[] {
  // alpha.33 — bumped default maxDepth from 3 → 4. PB s33 surfaced that
  // archetypes with 4-position chains (ask/generate/extract/critique have
  // a third-provider OpenAI tail since alpha.16) were truncating the tail
  // under the default. With maxDepth=4, the cross-provider OpenAI tail is
  // exposed by default — matches PB's expectation that 3-provider chains
  // are STRUCTURALLY available without per-call argument override. See
  // `interfaces/kgauto.md ## Requested 2026-05-18 openai-in-default-fallback-chains`.
  const {
    archetype,
    primary,
    // alpha.108 — 4 → 5. Five archetypes gained a measured head (sonnet-4-6)
    // with sonnet-5 directly behind it, which at depth 4 would have pushed the
    // alpha.33 cross-provider OpenAI tail out of the default chain again — the
    // exact regression alpha.33 fixed. Depth 5 keeps ≥3 providers in every
    // default chain (asserted in tests/fallback.test.ts).
    // alpha.125 — 5 → 6, the same move for the same reason: claude-haiku-5-5
    // enters directly behind claude-haiku-4-5 (deprecation cover), which at
    // depth 5 pushed the cross-provider OpenAI tail out of the generate, ask,
    // extract, transform and hunt default chains (2 providers left — the
    // alpha.108 ≥3-provider test went red). Depth 6 keeps every default chain
    // at ≥3 providers; the extra position is only walked on failure.
    maxDepth = 6,
    policy,
    reachability,
    toolOrchestration,
    optimizeFor = 'quality',
    appId,
    inputModalities,
  } = opts;

  if (maxDepth < 1) {
    throw new Error(
      `getDefaultFallbackChain: maxDepth must be >= 1, got ${maxDepth}`,
    );
  }

  // alpha.11: brain-query default-on (when configureBrain has been called
  // with brainQuery.chains !== false). Returns bundled STARTER_CHAINS on
  // cold cache or brain-down — same shape as before, no behavior change
  // for callers. See `chains-brain.ts` + `brain-query.ts` for SWR semantics.
  //
  // alpha.20 E3: `resolveStarterForMode` overlays the per-mode chain when
  // `toolOrchestration === 'sequential'` AND the archetype has a registered
  // overlay (today: only `hunt`). Other modes / archetypes pass through to
  // the brain-or-bundled chain unchanged.
  const allChains = loadChainsFromBrain();
  const qualityStarter = resolveStarterForMode(archetype, toolOrchestration, allChains);
  if (!qualityStarter) {
    throw new Error(
      `getDefaultFallbackChain: unknown archetype "${archetype}". Known: ${Object.keys(allChains).join(', ')}`,
    );
  }

  // alpha.80 — cost mode replaces the curated ladder with a strictly
  // cheapest-first roster walk above the archetype perf floor. The archetype
  // is validated against the curated table above either way, so an unknown
  // archetype still throws rather than silently returning a roster dump.
  const starter =
    optimizeFor === 'cost' ? buildCostOrderedChain(archetype, appId) : qualityStarter;

  // Build the candidate chain.
  //   - With primary: primary at position 0, then starter chain minus primary
  //   - Without primary: starter chain as-is (best-perf at position 0)
  let chain: string[];
  if (primary) {
    chain = [primary, ...starter.filter((id) => id !== primary)];
  } else {
    chain = [...starter];
  }

  // Apply blockedModels filter. `preferredModels` is no-op here (compile()'s
  // passScoreTargets owns ranking); `maxCostPerCallUsd` requires IR-level
  // token info we don't have at this layer.
  if (policy?.blockedModels && policy.blockedModels.length > 0) {
    const blocked = canonicalPolicySet(policy.blockedModels);
    chain = chain.filter((id) => !policySetHas(blocked, id));
  }
  // alpha.115 — family-level block, same place, same shape.
  if (policy?.blockedProviders && policy.blockedProviders.length > 0) {
    const blockedProviders = new Set<string>(policy.blockedProviders);
    chain = chain.filter((id) => !isProviderBlocked(id, blockedProviders));
  }

  // Dedupe (defensive — primary may have appeared in starter).
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }

  // alpha.10: filter to reachable models when caller opted in. Done AFTER
  // dedupe but BEFORE maxDepth cap — otherwise an unreachable model in
  // position 0 would consume a slot and the cap would amputate a reachable
  // tail. Order: dedupe → reachability → cap.
  // alpha.124 — input-modality requirement, BEFORE reachability + cap.
  let filtered = filterByInputModality(deduped, (id) => id, inputModalities);
  if (reachability) {
    filtered = filtered.filter((id) => isModelReachable(id, reachability));
  }

  // Cap at maxDepth.
  return filtered.slice(0, maxDepth);
}

// ─────────────────────────────────────────────────────────────────────────
// INTROSPECTION — used by docs/tests/operator scripts to surface the
// starter chains without parsing the function body.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns a shallow copy of the hand-curated starter chain for an archetype.
 * Useful for tests + the `scripts/digest.mjs` operator readout.
 */
export function getStarterChain(
  archetype: IntentArchetypeName,
  opts?: { inputModalities?: ReadonlyArray<RequiredInputModality> },
): string[] {
  const chain = STARTER_CHAINS[archetype];
  if (!chain) {
    throw new Error(
      `getStarterChain: unknown archetype "${archetype}"`,
    );
  }
  // alpha.124 — an input-modality requirement keeps only declaring models.
  return filterByInputModality([...chain], (id) => id, opts?.inputModalities);
}

/**
 * Returns a shallow copy of all starter chains keyed by archetype.
 * Useful for the `digest.mjs` readout and consumer audits.
 */
export function getAllStarterChains(): Record<IntentArchetypeName, string[]> {
  const out: Partial<Record<IntentArchetypeName, string[]>> = {};
  for (const [archetype, chain] of Object.entries(STARTER_CHAINS)) {
    out[archetype as IntentArchetypeName] = [...chain];
  }
  return out as Record<IntentArchetypeName, string[]>;
}

/**
 * alpha.20 E3 introspection — returns the sequential-mode overlay for an
 * archetype, or `undefined` when no overlay is registered (the archetype
 * is mode-agnostic and reuses `STARTER_CHAINS[archetype]`).
 *
 * Useful for tests + the `scripts/digest.mjs` operator readout to surface
 * the mode-aware chains.
 */
export function getSequentialStarterChain(
  archetype: IntentArchetypeName,
): string[] | undefined {
  const overlay = STARTER_CHAINS_BY_MODE[archetype]?.sequential;
  return overlay ? [...overlay] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// GROUNDING — alpha.21 (s78 Entry 1) chain-entry provenance
// ─────────────────────────────────────────────────────────────────────────

/**
 * Internal: defensive deep copy of a ChainEntry. Returned values are fresh
 * objects per call so consumer mutation can't poison the static table.
 */
function copyEntry(e: ChainEntry): ChainEntry {
  const out: ChainEntry = { id: e.id, grounding: e.grounding };
  if (e.reason !== undefined) out.reason = e.reason;
  if (e.n !== undefined) out.n = e.n;
  return out;
}

/**
 * Internal: look up a known ChainEntry for `id` within the static
 * STARTER_CHAINS_GROUNDED table (across all archetypes). Used when brain-
 * loaded chains contain a model id — we inherit the static grounding label
 * for that id if known; otherwise default to `'judgment'` (most honest
 * fallback). Order: prefer archetype-matched entry over cross-archetype.
 */
function lookupStaticEntry(
  id: string,
  archetype: IntentArchetypeName,
): ChainEntry | undefined {
  const archetypeEntries = STARTER_CHAINS_GROUNDED[archetype];
  if (archetypeEntries) {
    const hit = archetypeEntries.find((e) => e.id === id);
    if (hit) return hit;
  }
  // Also check the sequential overlay for the archetype.
  const seqOverlay = STARTER_CHAINS_BY_MODE_GROUNDED[archetype]?.sequential;
  if (seqOverlay) {
    const hit = seqOverlay.find((e) => e.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Internal: resolve the grounded chain for an archetype + mode, with brain
 * overrides applied. When brain serves a chain for the archetype, we attach
 * grounding by:
 *
 *   1. Looking up the id in the static STARTER_CHAINS_GROUNDED for this
 *      archetype — if found, inherit grounding/reason/n verbatim.
 *   2. Otherwise default to `{ grounding: 'judgment' }` — brain shipped a
 *      model we don't have grounding metadata for; honest default.
 *
 * When the brain mapper has fallen back to bundled, the lookup hits in step
 * 1 every time — back-compat with pre-alpha.21 grounding.
 */
function resolveGroundedChainForArchetype(
  archetype: IntentArchetypeName,
  toolOrchestration: 'parallel' | 'sequential' | 'either' | undefined,
): ChainEntry[] | undefined {
  // Sequential overlay takes precedence (alpha.20 E3 — same rule as
  // resolveStarterForMode). The overlay is code-only; brain has no
  // sequential-mode rows in alpha.21.
  if (toolOrchestration === 'sequential') {
    const overlay = STARTER_CHAINS_BY_MODE_GROUNDED[archetype]?.sequential;
    if (overlay) return overlay.map(copyEntry);
  }

  // Brain-first chain (or bundled fallback) — string ids only. Attach
  // grounding via the static lookup.
  const allChains = loadChainsFromBrain();
  const ids = allChains[archetype];
  if (!ids) return undefined;
  return ids.map((id) => {
    const known = lookupStaticEntry(id, archetype);
    if (known) return copyEntry(known);
    // Brain-only id (not in static map) — honest 'judgment' default.
    return { id, grounding: 'judgment' as const };
  });
}

/**
 * alpha.21 (s78 Entry 1) — returns the fallback chain as `ChainEntry[]`,
 * with a `grounding` label on every position.
 *
 * Same selection logic as {@link getDefaultFallbackChain} (primary anchoring,
 * blockedModels filter, dedupe, reachability filter, maxDepth cap) — the
 * only difference is the return shape: each position is a `ChainEntry`
 * carrying `{ id, grounding, reason?, n? }` instead of a bare string.
 *
 * Use this when surfacing the chain to consumers who care WHY each entry
 * sits where it sits — Glass-Box panels, operator dashboards, eval
 * scaffolding deciding which entries deserve measurement priority.
 *
 * Returns `[]` when filtering empties the chain (same semantics as the
 * string variant) — consumer decides what to do.
 */
export function getDefaultFallbackChainWithGrounding(
  opts: GetDefaultFallbackChainOpts,
): ChainEntry[] {
  const {
    archetype,
    primary,
    maxDepth = 3,
    policy,
    reachability,
    toolOrchestration,
    inputModalities,
  } = opts;

  if (maxDepth < 1) {
    throw new Error(
      `getDefaultFallbackChainWithGrounding: maxDepth must be >= 1, got ${maxDepth}`,
    );
  }

  const starter = resolveGroundedChainForArchetype(archetype, toolOrchestration);
  if (!starter) {
    throw new Error(
      `getDefaultFallbackChainWithGrounding: unknown archetype "${archetype}". Known: ${Object.keys(STARTER_CHAINS_GROUNDED).join(', ')}`,
    );
  }

  // Build the candidate chain.
  //   - With primary: primary at position 0, then starter chain minus primary
  //   - Without primary: starter chain as-is (best-perf at position 0)
  let chain: ChainEntry[];
  if (primary) {
    // The primary may or may not be in the starter — look up grounding via
    // the same static table; default to 'judgment' when not found.
    const primaryEntry = (() => {
      const inStarter = starter.find((e) => e.id === primary);
      if (inStarter) return copyEntry(inStarter);
      const knownAnywhere = lookupStaticEntry(primary, archetype);
      if (knownAnywhere) return { ...copyEntry(knownAnywhere), id: primary };
      return { id: primary, grounding: 'judgment' as const };
    })();
    chain = [primaryEntry, ...starter.filter((e) => e.id !== primary)];
  } else {
    chain = [...starter];
  }

  // Apply blockedModels filter.
  if (policy?.blockedModels && policy.blockedModels.length > 0) {
    const blocked = canonicalPolicySet(policy.blockedModels);
    chain = chain.filter((e) => !policySetHas(blocked, e.id));
  }
  // alpha.115 — family-level block.
  if (policy?.blockedProviders && policy.blockedProviders.length > 0) {
    const blockedProviders = new Set<string>(policy.blockedProviders);
    chain = chain.filter((e) => !isProviderBlocked(e.id, blockedProviders));
  }

  // Dedupe (defensive — primary may have appeared in starter).
  const seen = new Set<string>();
  const deduped: ChainEntry[] = [];
  for (const e of chain) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      deduped.push(e);
    }
  }

  // alpha.124 — input-modality requirement, BEFORE reachability + cap.
  let filtered = filterByInputModality(deduped, (e) => e.id, inputModalities);
  // Reachability filter (when caller opted in).
  if (reachability) {
    filtered = filtered.filter((e) => isModelReachable(e.id, reachability));
  }

  // Cap at maxDepth.
  return filtered.slice(0, maxDepth);
}

/**
 * alpha.21 introspection — returns the grounded starter chain for an
 * archetype (no primary anchoring, no policy filtering, no maxDepth cap).
 * Use this when you want the raw, hand-curated grounded chain — every
 * entry carries a `grounding` label and optional reason/n.
 */
export function getStarterChainWithGrounding(
  archetype: IntentArchetypeName,
  opts?: { inputModalities?: ReadonlyArray<RequiredInputModality> },
): ChainEntry[] {
  const entries = STARTER_CHAINS_GROUNDED[archetype];
  if (!entries) {
    throw new Error(
      `getStarterChainWithGrounding: unknown archetype "${archetype}"`,
    );
  }
  // alpha.124 — an input-modality requirement keeps only declaring models.
  return filterByInputModality(entries.map(copyEntry), (e) => e.id, opts?.inputModalities);
}

/**
 * alpha.21 introspection — all grounded starter chains keyed by archetype.
 * Useful for the `digest.mjs` readout and consumer audits that want to
 * surface the grounding gap across the entire chain table.
 */
export function getAllStarterChainsWithGrounding(): Record<
  IntentArchetypeName,
  ChainEntry[]
> {
  const out: Partial<Record<IntentArchetypeName, ChainEntry[]>> = {};
  for (const [archetype, entries] of Object.entries(STARTER_CHAINS_GROUNDED)) {
    out[archetype as IntentArchetypeName] = entries.map(copyEntry);
  }
  return out as Record<IntentArchetypeName, ChainEntry[]>;
}

/**
 * alpha.21 introspection — sequential-mode overlay with grounding labels,
 * or `undefined` when no overlay is registered for the archetype.
 */
export function getSequentialStarterChainWithGrounding(
  archetype: IntentArchetypeName,
): ChainEntry[] | undefined {
  const overlay = STARTER_CHAINS_BY_MODE_GROUNDED[archetype]?.sequential;
  return overlay ? overlay.map(copyEntry) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// CROSS-PROVIDER-TAIL INVARIANT (alpha.15 — PB request 2026-05-15)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ensure the chain contains at least 2 distinct providers post-filter.
 *
 * Driven by PB's `archetype-chains-need-cross-provider-tail` request. PB
 * shipped alpha.14 (chain-walk-on-401), then post-deploy smoke surfaced
 * that `ask` / `generate` / `extract` chains went mono-provider after
 * call()'s auto-filter dropped DeepSeek (no DEEPSEEK_API_KEY): the chain
 * `[sonnet, v4-pro, haiku]` filters to `[sonnet, haiku]` (both Anthropic),
 * and alpha.14's chain-walk-on-401 had nowhere to walk TO.
 *
 * Invariant: when the filtered chain is mono-provider AND the archetype's
 * full chain definition contains at least one *reachable* cross-provider
 * target not already in the filtered chain, append it.
 *
 * Pure post-pass. No I/O; tryGetProfile and loadChainsFromBrain are sync
 * (the latter via the SWR cache primitive). When no reachable cross-
 * provider option exists, returns the chain unchanged — honest no-op,
 * preserves alpha.14's `no-reachable-models` semantics at the boundary.
 */
export function ensureCrossProviderTail(opts: {
  chain: string[];
  archetype: IntentArchetypeName;
  apiKeys?: ApiKeys;
  envSource?: Record<string, string | undefined>;
  /**
   * alpha.124 — the call's `constraints.inputModalities`. The appended model
   * must declare every one, or nothing is appended: the compile-time filter
   * never sees this model, so this is its call-time twin (the alpha.115
   * lesson — a policy enforced in compile() is not enforced on what call()
   * adds after it).
   */
  inputModalities?: ReadonlyArray<RequiredInputModality>;
}): { chain: string[]; appended?: string } {
  const { chain, archetype, apiKeys, envSource } = opts;
  const requiredModalities = requiredInputModalities(opts.inputModalities);
  if (chain.length < 1) return { chain };

  // Detect mono-provider in the filtered chain.
  const providers = new Set<string>();
  for (const t of chain) {
    const p = tryGetProfile(t);
    if (p) providers.add(p.provider);
  }
  if (providers.size >= 2) return { chain };

  const existingProvider = providers.values().next().value;
  if (!existingProvider) return { chain };

  // Look up the archetype's full chain (brain-first; bundled fallback
  // handled inside loadChainsFromBrain when brain is cold/down).
  const allChains = loadChainsFromBrain();
  const fullChain = allChains[archetype];
  if (!fullChain) return { chain };

  // Find a reachable model from a different provider, in chain-order
  // (preserves the curated archetypePerf-tier ordering).
  for (const candidate of fullChain) {
    if (chain.includes(candidate)) continue;
    const cp = tryGetProfile(candidate);
    if (!cp || cp.provider === existingProvider) continue;
    if (!isModelReachable(candidate, { apiKeys, envSource })) continue;
    // alpha.124 — the call-time twin of the compile-time modality filter.
    if (inputModalityMiss(cp, requiredModalities) !== undefined) continue;
    return { chain: [...chain, candidate], appended: candidate };
  }

  // No reachable cross-provider option. Honest no-op.
  return { chain };
}
