/**
 * chains-brain — alpha.11 KG-11 adapter.
 *
 * Brain-driven STARTER_CHAINS for `getDefaultFallbackChain`. Reads
 * `kgauto_chains` table via the shared brain-query SWR cache (D6 + D8);
 * falls back to bundled STARTER_CHAINS on cold-start, brain-down, or
 * empty/missing table (D2 + D4).
 *
 * Behavioral note (locked via D2): the sync API surface returns bundled on
 * cold-start, with a background refresh fired. Subsequent calls within the
 * 5-min TTL return brain data. Vercel cold-start consumers see the seed
 * snapshot (functionally identical to pre-alpha.11); warm-start consumers
 * see live brain mutations within 5 min.
 */

import type { IntentArchetypeName } from './dialect.js';
import { createBrainQueryCache } from './brain-query.js';
import { getAllStarterChains } from './fallback.js';

interface ChainsRow {
  archetype: string;
  tier: number;
  model_id: string;
  active?: boolean;
}

function isChainsRow(x: unknown): x is ChainsRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.archetype === 'string' &&
    typeof r.tier === 'number' &&
    typeof r.model_id === 'string'
  );
}

function mapRowsToChains(
  rows: unknown[],
): Record<IntentArchetypeName, string[]> {
  const grouped = new Map<string, ChainsRow[]>();
  for (const row of rows) {
    if (!isChainsRow(row)) continue;
    const list = grouped.get(row.archetype) ?? [];
    list.push(row);
    grouped.set(row.archetype, list);
  }

  const out: Partial<Record<IntentArchetypeName, string[]>> = {};
  for (const [archetype, group] of grouped.entries()) {
    group.sort((a, b) => a.tier - b.tier);
    out[archetype as IntentArchetypeName] = group.map((r) => r.model_id);
  }
  // If brain returned a partial map (only some archetypes seeded), fill
  // in the gaps from the bundled STARTER_CHAINS — partial brain data is
  // still better than total fallback, but unmapped archetypes must remain
  // resolvable.
  const bundled = getAllStarterChains();
  for (const archetype of Object.keys(bundled) as IntentArchetypeName[]) {
    if (!out[archetype]) out[archetype] = bundled[archetype];
  }
  return out as Record<IntentArchetypeName, string[]>;
}

/**
 * Sync reader for the brain-driven chains map. Returns bundled
 * STARTER_CHAINS when brain-query is disabled, cold, or unreachable.
 */
export const loadChainsFromBrain = createBrainQueryCache<
  Record<IntentArchetypeName, string[]>
>({
  table: 'kgauto_chains',
  mapRows: mapRowsToChains,
  bundledFallback: getAllStarterChains,
});
