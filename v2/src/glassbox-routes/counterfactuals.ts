/**
 * computeCounterfactuals — for a served trace, compute up to 2 cheaper
 * alternatives that ALSO meet the archetype quality floor.
 *
 * Pure function. Called at detail-view time by the proxy's `rowToDetail`
 * path. The cost-equivalent answer to "what could this have run on without
 * tanking quality?" lets the Glass-Box render `💰 Cheaper alternatives` so a
 * founder sees the actual cost of the routing choice rather than just the
 * served cost.
 *
 * Mechanism (per design contract Phase 0 spec):
 *   1. Walk the archetype's full default fallback chain.
 *   2. For each model in the chain (excluding the served model):
 *      - Skip if archetypePerf[archetype] < ARCHETYPE_FLOOR_DEFAULT (6).
 *        Matches the cliff-advisor work — never recommend a swap that
 *        violates the quality floor. (Composition with Builder C is
 *        intentional.)
 *      - Skip if profile missing.
 *      - Compute estimated cost at the OBSERVED token counts:
 *          non_cached_in = tokensIn - cacheReadInputTokens
 *          cost = (non_cached_in / 1e6) * profile.costInputPer1m
 *               + (cacheable_in   / 1e6) * profile.costInputPer1m
 *                                       * profile.lowering.cache.discount
 *               + (tokensOut      / 1e6) * profile.costOutputPer1m
 *      - Only include if estimatedCostUsd ≤ 0.9 × servedCostUsd
 *        (≥10% cheaper — below that's noise of token-count estimation).
 *   3. Sort cheapest first.
 *   4. Cap to top 2.
 *
 * Edge cases:
 *   - tokensIn === 0 → return [] (can't meaningfully estimate).
 *   - servedCostUsd === 0 → return [] (no baseline to beat).
 *   - Zero matching alternatives → return [] (renderer hides the card).
 *   - Served model isn't in the chain (e.g. forceModel'd off-chain) → use
 *     the chain for the archetype anyway.
 */

import type { IntentArchetypeName } from '../dialect.js';
import { getDefaultFallbackChain } from '../fallback.js';
import { tryGetProfile } from '../profiles.js';
import type { TraceCounterfactual } from './types.js';

/**
 * Quality-floor threshold — single-sourced from `compatibility.ts` (Builder C
 * canonical). Phase 2 consolidation of the alpha.28-rc1 duplicate constant.
 */
export { ARCHETYPE_FLOOR_DEFAULT } from '../compatibility.js';
import { ARCHETYPE_FLOOR_DEFAULT } from '../compatibility.js';

/** Only surface swaps that save at least 10% vs. served. */
export const COUNTERFACTUAL_MIN_SAVINGS_RATIO = 0.1;

/** Cap on alternatives surfaced per trace. */
export const COUNTERFACTUAL_MAX_RESULTS = 2;

export interface ComputeCounterfactualsArgs {
  servedModel: string;
  servedCostUsd: number;
  archetype: string;
  tokensIn: number;
  tokensOut: number;
  /** Defaults to 0 when caller doesn't know. */
  cacheReadInputTokens?: number;
  /** Reserved for future per-mode chain selection. */
  toolOrchestration?: 'parallel' | 'sequential' | 'either';
}

export function computeCounterfactuals(
  args: ComputeCounterfactualsArgs,
): TraceCounterfactual[] {
  const {
    servedModel,
    servedCostUsd,
    archetype,
    tokensIn,
    tokensOut,
    cacheReadInputTokens = 0,
    toolOrchestration,
  } = args;

  // Guards. Token counts of zero → no observed shape to estimate against.
  // Served cost of zero → no baseline to beat.
  if (tokensIn <= 0) return [];
  if (servedCostUsd <= 0) return [];

  // Get the archetype's default chain. We pass `posture: 'open'` and no
  // policy — counterfactuals SHOULD include models the consumer may have
  // blocked or de-preferred, because the renderer is informational. The
  // founder is the audience, not the deploy.
  let chain: string[];
  try {
    chain = getDefaultFallbackChain({
      archetype: archetype as IntentArchetypeName,
      posture: 'open',
      maxDepth: 10,
      toolOrchestration,
    });
  } catch {
    // Unknown archetype (shouldn't happen for valid rows; defensive).
    return [];
  }

  const candidates: TraceCounterfactual[] = [];
  const minSavings = servedCostUsd * COUNTERFACTUAL_MIN_SAVINGS_RATIO;

  for (const modelId of chain) {
    if (modelId === servedModel) continue;

    const profile = tryGetProfile(modelId);
    if (!profile) continue;

    // Archetype-floor gate (R1 mirror — Builder C's compatibility surface).
    // Missing archetypePerf entries default to 5 (neutral; below floor).
    const perf =
      profile.archetypePerf?.[archetype as IntentArchetypeName] ?? 5;
    if (perf < ARCHETYPE_FLOOR_DEFAULT) continue;

    const estimated = estimateCostUsd({
      profile,
      tokensIn,
      tokensOut,
      cacheReadInputTokens,
    });
    if (estimated === undefined) continue;

    const savings = servedCostUsd - estimated;
    if (savings < minSavings) continue;

    const savingsPercent = Math.round((savings / servedCostUsd) * 100);
    const reason = buildReason({
      modelId,
      archetype,
      perf,
      profile,
    });

    candidates.push({
      modelId,
      estimatedCostUsd: round6(estimated),
      savingsUsd: round6(savings),
      savingsPercent,
      reason,
    });
  }

  // Sort cheapest first.
  candidates.sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd);

  return candidates.slice(0, COUNTERFACTUAL_MAX_RESULTS);
}

interface EstimateArgs {
  profile: NonNullable<ReturnType<typeof tryGetProfile>>;
  tokensIn: number;
  tokensOut: number;
  cacheReadInputTokens: number;
}

/**
 * First-order cost estimation. Mirrors `brain.ts > computeCostUsd` semantics
 * (numeric(10,6) rounding) but applies the cache discount inline because
 * the counterfactual is asking "what if THIS model had run on the SAME
 * cached-input tokens?" — the served cost telemetry on `brain.ts` doesn't
 * discount cache reads (kept raw for the watcher), but for a hypothetical
 * model the cache discount is the load-bearing differentiator (a model
 * with discount=0.1 looks 10× cheaper at high cache hit ratios).
 */
function estimateCostUsd(args: EstimateArgs): number | undefined {
  const { profile, tokensIn, tokensOut, cacheReadInputTokens } = args;
  const cacheableIn = Math.min(cacheReadInputTokens, tokensIn);
  const nonCachedIn = Math.max(tokensIn - cacheableIn, 0);
  const discount = profile.lowering.cache.discount ?? 1;

  const inUsd =
    (nonCachedIn / 1_000_000) * profile.costInputPer1m +
    (cacheableIn / 1_000_000) * profile.costInputPer1m * discount;
  const outUsd = (tokensOut / 1_000_000) * profile.costOutputPer1m;

  const total = inUsd + outUsd;
  if (!Number.isFinite(total)) return undefined;
  if (total < 0) return undefined;
  return total;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

interface ReasonArgs {
  modelId: string;
  archetype: string;
  perf: number;
  profile: NonNullable<ReturnType<typeof tryGetProfile>>;
}

/**
 * Build a plain-English rationale row the renderer can surface as-is.
 *
 * Examples:
 *   "gemini-2.5-flash on hunt: archetypePerf=9, parallel-tool throughput champion"
 *   "claude-haiku-4-5 on summarize: archetypePerf=7, same-provider step-down"
 *
 * Falls back to a generic shape when the profile lacks a `notes` hint.
 */
function buildReason(args: ReasonArgs): string {
  const { modelId, archetype, perf, profile } = args;
  // Prefer the first strength tag as a rationale hook — it's the
  // capability-fact-grounded label the profile authors curated.
  const hook = profile.strengths?.[0];
  const suffix = hook ? `, ${hook.replace(/_/g, ' ')}` : '';
  return `${modelId} on ${archetype}: archetypePerf=${perf}${suffix}`;
}
