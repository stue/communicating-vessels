/**
 * effective-price-brain — alpha.129 item 4.
 *
 * What an app's own calls on a model cost, per (app_id, intent_archetype,
 * model), over the last 30 days: the view `kgauto_effective_price_v`
 * (migration 095), projected by the config endpoint and read through the
 * shared brain-query cache. App-scoped DATA, read beside
 * `kgauto_archetype_perf_measured` under the same `perf` flag.
 *
 * Read by the tier-down advisory as prose only (R5): it never changes which
 * advisory fires, what `suggestion` says, or any chain's order. Empty on cold
 * start, brain-down, or before migration 095 is applied — the sentence then
 * stands as alpha.128 wrote it.
 */

import { createBrainQueryCache } from './brain-query.js';

/** One row of `kgauto_effective_price_v`. */
export interface EffectivePriceRow {
  /** Organic, served, priced calls in the window. */
  n: number;
  /** Average `cost_usd_actual` per call, USD. */
  avgCostUsd: number;
  avgTokensIn?: number;
  avgTokensOut?: number;
  /**
   * The share of the prompt as billed that was served from cache, per wire
   * (R-B): a direct Anthropic row's reads are added back to its tokens_in,
   * every other wire's tokens_in already holds them. Undefined when the
   * prompt summed to 0.
   */
  cacheReadShare?: number;
  /** The oldest library_version in the window (below alpha.129 = the average mixes both pricing bases). */
  minLibraryVersion?: string;
  computedAt?: string;
}

/** app_id → intent_archetype → model → row. */
export type EffectivePriceMap = Map<string, Map<string, Map<string, EffectivePriceRow>>>;

/** PostgREST serialises `numeric` as a JSON string; accept both. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function mapRowsToEffectivePrice(rows: unknown[]): EffectivePriceMap {
  const out: EffectivePriceMap = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.app_id !== 'string' || typeof r.intent_archetype !== 'string' || typeof r.model !== 'string') continue;
    const n = num(r.n);
    const avgCostUsd = num(r.avg_cost_usd);
    if (n === undefined || avgCostUsd === undefined) continue;
    const entry: EffectivePriceRow = { n, avgCostUsd };
    const tin = num(r.avg_tokens_in);
    if (tin !== undefined) entry.avgTokensIn = tin;
    const tout = num(r.avg_tokens_out);
    if (tout !== undefined) entry.avgTokensOut = tout;
    const share = num(r.cache_read_share);
    if (share !== undefined) entry.cacheReadShare = share;
    if (typeof r.min_library_version === 'string') entry.minLibraryVersion = r.min_library_version;
    if (typeof r.computed_at === 'string') entry.computedAt = r.computed_at;
    const byArch = out.get(r.app_id) ?? new Map<string, Map<string, EffectivePriceRow>>();
    const byModel = byArch.get(r.intent_archetype) ?? new Map<string, EffectivePriceRow>();
    byModel.set(r.model, entry);
    byArch.set(r.intent_archetype, byModel);
    out.set(r.app_id, byArch);
  }
  return out;
}

/** Sync reader for the per-app effective-price map. Empty on cold start (bundled fallback = no rows). */
export const loadEffectivePriceFromBrain = createBrainQueryCache<EffectivePriceMap>({
  table: 'kgauto_effective_price_v',
  mapRows: mapRowsToEffectivePrice,
  bundledFallback: () => new Map(),
});

/** The row for one (app, archetype, model), or undefined. */
export function getEffectivePrice(appId: string, archetype: string, model: string): EffectivePriceRow | undefined {
  return loadEffectivePriceFromBrain().get(appId)?.get(archetype)?.get(model);
}
