/**
 * cost-basis — a sum or mean over `compile_outcomes.cost_usd_actual` states its basis
 * (alpha.131 R2a; the library twin of `v2/scripts/lib/cost-basis.mjs`, alpha.130 R4).
 *
 * alpha.129 changed what `cost_usd_actual` MEANS. Rows written by `library_version >=
 * 2.0.0-alpha.129` are the finished call priced at its tier with its cache reads at the
 * cache-read price; rows written before it are list price × tokens at the base tier. A window
 * that crosses that boundary adds two different quantities in one total. A null or unparseable
 * `library_version` is `list` — an unknown version is never assumed to price the new way.
 *
 * The same five names with the same behaviour as the ops-script helper. The two are one concept
 * in two runtimes (the library cannot import `v2/scripts/lib/*`, which is not in the package),
 * so `tests/alpha131-cost-basis-twin.test.ts` asserts they agree over a matrix of versions and
 * that `TIERED_FROM` is equal — two derivations of one concept drift (s75).
 */

/** The first library version whose rows carry tier- and cache-aware cost (alpha.129). */
export const TIERED_FROM = '2.0.0-alpha.129';

/** Parse `MAJOR.MINOR.PATCH[-alpha.N]`. Anything else → null. */
function parseVersion(v: unknown): { core: [number, number, number]; alpha: number | null } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? null : Number(m[4]) };
}

/**
 * semver precedence for the shapes kgauto publishes: a release outranks any of its alphas.
 * Negative / 0 / positive as `a` sorts before / with / after `b`; null when either is unparseable.
 */
export function compareLibraryVersion(a: unknown, b: unknown): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  if (pa.alpha === pb.alpha) return 0;
  if (pa.alpha === null) return 1;
  if (pb.alpha === null) return -1;
  return pa.alpha - pb.alpha;
}

/** Is this row's `cost_usd_actual` on the tiered, cache-aware basis? */
export function isTieredBasis(libraryVersion: unknown): boolean {
  const c = compareLibraryVersion(libraryVersion, TIERED_FROM);
  return c !== null && c >= 0;
}

export interface PricingBasisSplit<T> {
  tiered: T[];
  list: T[];
  note: string;
}

/** Split rows by the pricing basis of their `cost_usd_actual`. */
export function splitByPricingBasis<T extends { library_version?: string | null }>(
  rows: readonly T[] | null | undefined,
): PricingBasisSplit<T> {
  const tiered: T[] = [];
  const list: T[] = [];
  for (const r of rows ?? []) (isTieredBasis(r?.library_version) ? tiered : list).push(r);
  const note =
    `cost basis: ${tiered.length} row(s) tiered + cache-aware (library_version >= ${TIERED_FROM}), ` +
    `${list.length} row(s) list price at the base tier (< ${TIERED_FROM} or unversioned)`;
  return { tiered, list, note };
}

export interface CostByBasis {
  tieredUsd: number;
  listUsd: number;
  totalUsd: number;
  tieredN: number;
  listN: number;
  /** One fragment for the line a caller already prints. */
  text: string;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * Sum a cost field on both bases and say it in one fragment. `get` reads the cost from a row
 * (default `cost_usd_actual`); a non-numeric value adds 0 and is still counted on its basis.
 */
export function costByBasis<T extends { library_version?: string | null }>(
  rows: readonly T[] | null | undefined,
  get: (r: T) => unknown = (r) => (r as { cost_usd_actual?: unknown } | null | undefined)?.cost_usd_actual,
): CostByBasis {
  const { tiered, list } = splitByPricingBasis(rows);
  const sum = (xs: T[]) =>
    xs.reduce((a, r) => {
      const v = Number(get(r));
      return a + (Number.isFinite(v) ? v : 0);
    }, 0);
  const tieredUsd = sum(tiered);
  const listUsd = sum(list);
  let text: string;
  if (list.length === 0) text = `${usd(tieredUsd)} (tiered basis, ${tiered.length} rows)`;
  else if (tiered.length === 0) text = `${usd(listUsd)} (list basis, ${list.length} rows)`;
  else text = `${usd(tieredUsd)} tiered (${tiered.length} rows) + ${usd(listUsd)} list (${list.length} rows, < alpha.129)`;
  return { tieredUsd, listUsd, totalUsd: tieredUsd + listUsd, tieredN: tiered.length, listN: list.length, text };
}
