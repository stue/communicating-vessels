/**
 * pricing-brain — alpha.11 KG-13 adapter.
 *
 * Brain-driven pricing data with **time-bounded resolution** (`valid_from`
 * / `valid_until` columns). The V4-Pro 75%-off promo through 2026-05-31
 * gets modeled as two rows; `at` parameter resolution picks the correct
 * row per call timestamp. Promo flips happen automatically at the
 * boundary without alpha cuts.
 *
 * SWR cache holds the FULL pricing snapshot (all active rows for all
 * models). Per-call `at` filtering is in-memory — keeps the SWR semantics
 * uniform with other adapters (one cache, one snapshot, sync reads).
 */

import { createBrainQueryCache } from './brain-query.js';
import { allProfiles } from './profiles.js';

export interface PricingRow {
  modelId: string;
  costInputPer1m: number;
  costOutputPer1m: number;
  cacheInputPer1m?: number;
  cacheCreationPer1m?: number;
  validFrom: number; // wall-clock millis (Date.parse)
  validUntil?: number; // undefined ↔ open-ended
  source?: string;
}

interface RawPricingRow {
  model_id: string;
  cost_input_per_1m: number;
  cost_output_per_1m: number;
  cache_input_per_1m?: number | null;
  cache_creation_per_1m?: number | null;
  valid_from: string;
  valid_until?: string | null;
  source?: string | null;
}

function isPricingRow(x: unknown): x is RawPricingRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.model_id === 'string' &&
    typeof r.cost_input_per_1m === 'number' &&
    typeof r.cost_output_per_1m === 'number' &&
    typeof r.valid_from === 'string'
  );
}

function mapRowsToPricing(rows: unknown[]): PricingRow[] {
  const out: PricingRow[] = [];
  for (const row of rows) {
    if (!isPricingRow(row)) continue;
    out.push({
      modelId: row.model_id,
      costInputPer1m: row.cost_input_per_1m,
      costOutputPer1m: row.cost_output_per_1m,
      cacheInputPer1m: row.cache_input_per_1m ?? undefined,
      cacheCreationPer1m: row.cache_creation_per_1m ?? undefined,
      validFrom: Date.parse(row.valid_from),
      validUntil:
        row.valid_until == null ? undefined : Date.parse(row.valid_until),
      source: row.source ?? undefined,
    });
  }
  return out;
}

function bundledPricing(): PricingRow[] {
  // Bundled snapshot: one row per profile with valid_from = epoch,
  // valid_until = undefined (open-ended). Matches pre-alpha.11 behavior
  // exactly when the brain table is empty/unreachable.
  const out: PricingRow[] = [];
  for (const profile of allProfiles()) {
    out.push({
      modelId: profile.id,
      costInputPer1m: profile.costInputPer1m,
      costOutputPer1m: profile.costOutputPer1m,
      cacheInputPer1m:
        profile.lowering.cache.discount !== undefined &&
        profile.lowering.cache.discount > 0
          ? profile.costInputPer1m * profile.lowering.cache.discount
          : undefined,
      validFrom: 0,
      validUntil: undefined,
      source: 'profile_seed',
    });
  }
  return out;
}

/**
 * Sync reader for the brain-driven pricing snapshot. Returns bundled
 * profile pricing when brain-query is disabled, cold, or unreachable.
 * Caller filters by `at` via {@link resolvePricingAt}.
 */
export const loadPricingFromBrain = createBrainQueryCache<PricingRow[]>({
  table: 'kgauto_pricing',
  mapRows: mapRowsToPricing,
  bundledFallback: bundledPricing,
});

/**
 * Resolve the active pricing row for a model at a given timestamp.
 * Picks the row with the latest `valid_from <= at` whose
 * `valid_until > at` (or NULL — open-ended).
 *
 * Returns `undefined` when no row matches. Callers should fall back to
 * profile static pricing in that case.
 */
export function resolvePricingAt(
  modelId: string,
  at: Date = new Date(),
): PricingRow | undefined {
  const ts = at.getTime();
  const all = loadPricingFromBrain();
  let best: PricingRow | undefined;
  for (const row of all) {
    if (row.modelId !== modelId) continue;
    if (row.validFrom > ts) continue;
    if (row.validUntil !== undefined && row.validUntil <= ts) continue;
    if (!best || row.validFrom > best.validFrom) best = row;
  }
  return best;
}
