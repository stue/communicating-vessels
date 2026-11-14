/**
 * brain-query — shared SWR cache for brain-driven config (alpha.11).
 *
 * Architecture (locked via /plan-eng-review 2026-05-15, decisions D2/D6/D8):
 *
 * - **Sync API surface (D2).** Adapters return `() => T` — no `await` ever
 *   bubbles to consumers. First call returns bundled (which IS the seed
 *   snapshot — functionally identical to pre-alpha.11 behavior). Async
 *   refresh fires in background; subsequent calls within TTL return brain
 *   data. Vercel cold starts get bundled; warm starts get live.
 *
 * - **Single shared snapshot (D6 + D8).** One module-level cache holds the
 *   full `/v2/config` response (chains + archetype_perf + pricing + models
 *   + aliases). Each adapter is a closure that pulls its own table out of
 *   the snapshot via a mapper. One batched fetch per warm start covers all
 *   four adapters — D8 round-trip optimization is automatic.
 *
 * - **Tolerant parsing (D4).** Missing tables in the response → silent
 *   per-adapter bundled fallback. Mapper exception → silent per-adapter
 *   bundled fallback. Network or HTTP error → warn ONCE per process, keep
 *   bundled, schedule next refresh after TTL (no retry-spam).
 *
 * - **Default-on when endpoint set (D3).** Activation gated on
 *   `configureBrainQuery(...)` having been called with a runtime. The
 *   public `configureBrain()` in brain.ts wires this up automatically when
 *   `BrainConfig.brainQuery.<table> !== false`.
 */

import { splitByPricingBasis } from './cost-basis.js';

interface SnapshotState {
  /** Last successful brain response, keyed by table name. */
  data: Record<string, unknown[]> | null;
  /** Wall-clock millis at which the current snapshot is considered stale. */
  expiresAt: number;
  /** True between async refresh fire and resolve — prevents duplicate fetches. */
  refreshing: boolean;
  /** Whether we've already warned about a brain-down event this process. */
  warned: boolean;
}

const FRESH_SNAPSHOT: SnapshotState = {
  data: null,
  expiresAt: 0,
  refreshing: false,
  warned: false,
};

let snapshot: SnapshotState = { ...FRESH_SNAPSHOT };

/**
 * Internal runtime configuration for the brain-query layer. Set by
 * `configureBrainQuery()` (called from `configureBrain()` in brain.ts when
 * the consumer has BrainConfig.brainQuery enabled for at least one table).
 */
export interface BrainQueryRuntime {
  /** Brain proxy URL used to derive `${endpoint}/v2/config` when
   *  configEndpoint is omitted. */
  endpoint: string;
  /** Override the URL the GET hits. Useful when the lib reads from a
   *  central read-only endpoint distinct from the per-consumer write proxy. */
  configEndpoint?: string;
  /** Stale-while-revalidate window in ms. Default 5 min. */
  ttlMs: number;
  /** Pluggable fetch (tests inject mock). */
  fetchImpl: typeof fetch;
  /** Set of table names the consumer has enabled (e.g. 'chains', 'pricing'). */
  enabledTables: Set<string>;
  /** Optional warn hook for brain-down events. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

let runtime: BrainQueryRuntime | undefined;

/**
 * alpha.87 — which world answered the shared config snapshot (the PB
 * `rankedOn` ask). `'brain'` iff a fetched `/v2/config` payload is held in
 * this process — the state in which chains/pricing/models reads serve live
 * rows. `'bundled'` covers brain-disabled, cold-not-yet-fetched, and
 * fetch-failed alike. Coarse by design: per-table mapper fallbacks exist,
 * but the cold-vs-live split is the one that has produced wrong consumer
 * conclusions (PB s74–s76).
 */
export function configFreshness(): 'bundled' | 'brain' {
  return runtime && snapshot.data ? 'brain' : 'bundled';
}

/**
 * Wire (or rewire) the brain-query runtime. Called from `configureBrain()`
 * in brain.ts. Resets the snapshot — a reconfigure always invalidates the
 * cached data because endpoint or table set may have changed.
 */
export function configureBrainQuery(rt: BrainQueryRuntime | undefined): void {
  runtime = rt;
  snapshot = { ...FRESH_SNAPSHOT };
}

interface CreateBrainQueryCacheOpts<T> {
  /** Table name as it appears in the `/v2/config` response body. */
  table: string;
  /** Map raw rows to the typed shape this adapter returns. */
  mapRows: (rows: unknown[]) => T;
  /** Compile-time fallback returned on cold cache, brain-down, mapper
   *  exception, or empty/missing table. The seed for SWR. */
  bundledFallback: () => T;
}

/**
 * Factory: returns a sync reader. Each adapter calls this once at module
 * load and re-exports the returned function as its public accessor.
 */
export function createBrainQueryCache<T>(
  opts: CreateBrainQueryCacheOpts<T>,
): () => T {
  return () => {
    const rt = runtime;
    if (!rt || !rt.enabledTables.has(opts.table)) {
      return opts.bundledFallback();
    }

    const now = Date.now();
    const stale = snapshot.expiresAt <= now;
    if (stale && !snapshot.refreshing) {
      snapshot.refreshing = true;
      void asyncRefresh(rt);
    }

    if (snapshot.data) {
      const rows = snapshot.data[opts.table];
      if (Array.isArray(rows) && rows.length > 0) {
        try {
          return opts.mapRows(rows);
        } catch {
          // Mapper exception (schema mismatch) — silently fall through.
          // The brain holds an unexpected shape but the lib should keep
          // serving consumers from bundled rather than throwing.
          return opts.bundledFallback();
        }
      }
    }

    return opts.bundledFallback();
  };
}

let pendingRefresh: Promise<void> | undefined;

async function asyncRefresh(rt: BrainQueryRuntime): Promise<void> {
  const promise = doRefresh(rt);
  pendingRefresh = promise;
  try {
    await promise;
  } finally {
    if (pendingRefresh === promise) pendingRefresh = undefined;
  }
}

/**
 * Default read-only config endpoint hosted alongside the operator dashboard.
 * Consumers don't need a per-proxy GET endpoint — central read serves
 * everyone. Override per-instance via `BrainConfig.brainQuery.configEndpoint`
 * when self-hosting (e.g. air-gapped deployments).
 */
const DEFAULT_CONFIG_URL = 'https://kgauto-dashboard.vercel.app/api/kgauto-v2/config';

async function doRefresh(rt: BrainQueryRuntime): Promise<void> {
  const url = rt.configEndpoint ?? DEFAULT_CONFIG_URL;
  try {
    const res = await rt.fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`brain-query ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, unknown[]>;
    // Test-isolation guard (qa-shepherd M1): if `runtime` was cleared
    // mid-flight (test reset, configureBrain reconfigure), drop the
    // result on the floor instead of writing to the new snapshot.
    if (runtime !== rt) return;
    snapshot = {
      data: body,
      expiresAt: Date.now() + rt.ttlMs,
      refreshing: false,
      warned: snapshot.warned,
    };
  } catch (err) {
    if (runtime !== rt) return;
    snapshot.refreshing = false;
    // Push next attempt out by a full TTL so brain-down doesn't retry-spam.
    snapshot.expiresAt = Date.now() + rt.ttlMs;
    if (!snapshot.warned) {
      snapshot.warned = true;
      (rt.onError ?? defaultOnError)(err);
    }
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[kgauto] brain-query failed (using bundled fallback):', err);
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers — exported via _internal in index.ts only.
// ─────────────────────────────────────────────────────────────────────────

/** Reset module state. Tests must call between cases. */
export function _testResetBrainQuery(): void {
  runtime = undefined;
  snapshot = { ...FRESH_SNAPSHOT };
  pendingRefresh = undefined;
}

/** Wait for any in-flight refresh to settle. Tests await this before
 *  asserting that brain data has propagated. */
export async function _testWaitForRefresh(): Promise<void> {
  if (pendingRefresh) await pendingRefresh;
}

/** Inspect snapshot state. Test-only. */
export function _testGetSnapshot(): Readonly<SnapshotState> {
  return snapshot;
}

/**
 * alpha.22 — sync introspection: is brain-query mode active for a given
 * table? Used by the advisor (`model-stale-evidence` rule) to decide
 * whether a `judgment`-grounded chosen model is a measurement gap worth
 * surfacing. Returns false on cold start, when configureBrain() was never
 * called, or when the consumer explicitly opted the table out via
 * `BrainConfig.brainQuery.<table> = false`.
 */
export function isBrainQueryActiveFor(table: string): boolean {
  return runtime !== undefined && runtime.enabledTables.has(table);
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.20 — clean-perf-score query (attribution-aware perf comparator)
// ─────────────────────────────────────────────────────────────────────────
//
// Layered on top of `compile_outcomes` + `compile_outcome_advisories`
// (migration 014). Returns per-(model, archetype) metrics filtered to
// outcomes with ZERO advisories fired — the "clean" subset. Consumers
// use this to distinguish "model is bad" from "client sent
// bloated/uncached/malformed requests."
//
// The function is one-shot async (NOT going through the SWR cache above).
// It's intended for low-frequency operator queries (dashboards,
// kgauto-ops digest), not per-call hot paths.

/**
 * Per-(model, archetype) clean-perf metrics — the attribution-aware
 * comparator that the brain becomes queryable for when migration 014
 * + advisory-persisting record() are deployed end-to-end.
 *
 * `emptyRateClean`, `costMeanClean`, `latencyMeanClean`, and
 * `qualityMeanClean` are NULL when `rowsClean < minRows`. That null is
 * load-bearing: it forces consumers to handle the empty-set case
 * explicitly rather than silently treating "no data" as "perfect score."
 * Binary-floor-not-continuous-weight discipline
 * (`feedback_quality_as_floor` learning).
 */
export interface CleanPerfScore {
  /** Model id (matches `compile_outcomes.model`). */
  model: string;
  /** Intent archetype (matches `compile_outcomes.intent_archetype`). */
  archetype: string;
  /** Rows in window with zero advisories fired. */
  rowsClean: number;
  /** Total rows in window (clean + tainted). */
  rowsTotal: number;
  /**
   * Fraction of clean rows with `empty_response = true`. NULL when
   * `rowsClean < minRows` — don't infer false confidence from sparse data.
   */
  emptyRateClean: number | null;
  /**
   * Mean `cost_usd_actual` across the costed clean rows of ONE pricing basis —
   * the basis (`costBasis`) holding more of the costed clean rows, tiered on a
   * tie. NULL on insufficient data or when no clean row is costed. Rows with
   * NULL `cost_usd_actual` (unknown-model or zero-token failure rows) are
   * excluded. alpha.131 (R2b): rows written by `library_version >=
   * 2.0.0-alpha.129` are priced at the tier with cache reads (tiered); earlier or
   * unversioned rows are list price at the base tier — one mean over both adds
   * two different quantities. (was: the mean over every costed clean row,
   * whatever its basis, until alpha.131.)
   */
  costMeanClean: number | null;
  /**
   * alpha.131 (R2b) — which basis `costMeanClean` is on. NULL when it is NULL.
   */
  costBasis: 'tiered' | 'list' | null;
  /**
   * alpha.131 (R2b) — both per-basis means over the costed clean rows, and their
   * counts. A mean is NULL when its basis has no costed clean row, and both are
   * NULL under `minRows` (the counts still say what the window held).
   */
  costMeanCleanByBasis: { tiered: number | null; list: number | null; tieredN: number; listN: number };
  /** Mean `latency_ms` across clean rows. NULL on insufficient data. */
  latencyMeanClean: number | null;
  /**
   * Mean `oracle_score` across clean rows where oracle_score IS NOT NULL.
   * NULL when no clean rows have an oracle score (the common case until
   * consumers wire oracle scoring) OR when `rowsClean < minRows`.
   */
  qualityMeanClean: number | null;
}

export interface GetCleanPerfScoreOpts {
  /** Model id to filter on. Required. */
  model: string;
  /** Intent archetype to filter on. Required. */
  archetype: string;
  /**
   * Optional app_id scope. When omitted, the query reads across all apps
   * the caller's JWT can see (service_role: everything; scoped JWT: own
   * app_id only — RLS does the work). Pass an explicit value to scope
   * within a multi-tenant service_role session.
   */
  appId?: string;
  /**
   * Minimum clean rows required before metrics are returned. Below this
   * threshold, all metric fields are NULL (rowsClean + rowsTotal still
   * populated). Default 10.
   */
  minRows?: number;
  /**
   * Window in days. Only rows with `created_at > now() - windowDays` are
   * counted. Default 30.
   */
  windowDays?: number;
  /** Pluggable fetch (tests inject mock). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * PostgREST base endpoint (e.g. `https://kgauto-brain.vercel.app/api`).
   * When omitted, attempts to read from the active configureBrainQuery
   * runtime's endpoint. If neither is set, throws.
   */
  endpoint?: string;
  /** Bearer token. Forwarded as `Authorization: Bearer ${apiKey}`. */
  apiKey?: string;
}

/**
 * Read-side query: per-(model, archetype) metrics filtered to rows with
 * zero advisories fired. Implementation issues two PostgREST queries
 * against `compile_outcomes` (one for total, one for clean) and reduces
 * client-side. Acceptable because the query is operator-frequency, not
 * per-call.
 *
 * RLS behavior: the caller's JWT determines which app_ids are readable.
 * service_role sees all; scoped JWTs see only their own app_id rows.
 * `opts.appId` adds a WHERE clause on top of whatever RLS allows —
 * useful for service_role consumers needing per-app filtering.
 */
export async function getCleanPerfScore(
  opts: GetCleanPerfScoreOpts,
): Promise<CleanPerfScore> {
  const fetchFn = opts.fetch ?? fetch;
  const minRows = opts.minRows ?? 10;
  const windowDays = opts.windowDays ?? 30;
  const endpoint = opts.endpoint ?? runtime?.endpoint;
  if (!endpoint) {
    throw new Error(
      'getCleanPerfScore: no endpoint provided and no configureBrainQuery runtime active',
    );
  }

  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const baseFilters = [
    `model=eq.${encodeURIComponent(opts.model)}`,
    `intent_archetype=eq.${encodeURIComponent(opts.archetype)}`,
    `created_at=gt.${encodeURIComponent(sinceIso)}`,
  ];
  if (opts.appId) baseFilters.push(`app_id=eq.${encodeURIComponent(opts.appId)}`);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };

  // Query 1: total rows in window (denominator).
  // We need the row count + the columns to compute means later, but
  // PostgREST's count=exact in Prefer is the cheapest way to get the count.
  // We'll fetch full columns from query 2 (clean rows) and use a count-only
  // request here.
  const totalUrl =
    `${endpoint}/compile_outcomes?${baseFilters.join('&')}` +
    `&select=id`;
  const totalRes = await fetchFn(totalUrl, {
    method: 'GET',
    headers: { ...headers, Prefer: 'count=exact' },
  });
  if (!totalRes.ok) {
    const text = await totalRes.text().catch(() => '<no body>');
    throw new Error(`getCleanPerfScore total ${totalRes.status}: ${text}`);
  }
  const rowsTotal = parseContentRangeCount(totalRes);

  // Query 2: clean rows (rows with NO advisories). Use PostgREST's embedded
  // resource not-null filter: select compile_outcomes with embedded
  // compile_outcome_advisories, then filter to entries where the embedded
  // array is empty. PostgREST's idiomatic way is `not.cs` (contains) but
  // simpler: fetch all rows with their advisory_count via embedded resource
  // and filter client-side. Volume is bounded by archetype+model+window so
  // this is cheap.
  const cleanUrl =
    `${endpoint}/compile_outcomes?${baseFilters.join('&')}` +
    `&select=id,empty_response,success,cost_usd_actual,latency_ms,oracle_score,library_version,` +
    `compile_outcome_advisories(id)`;
  const cleanRes = await fetchFn(cleanUrl, { method: 'GET', headers });
  if (!cleanRes.ok) {
    const text = await cleanRes.text().catch(() => '<no body>');
    throw new Error(`getCleanPerfScore clean ${cleanRes.status}: ${text}`);
  }
  const rawRows = (await cleanRes.json()) as Array<{
    id: number;
    empty_response: boolean | null;
    success: boolean | null;
    cost_usd_actual: number | null;
    latency_ms: number | null;
    oracle_score: number | null;
    library_version: string | null;
    compile_outcome_advisories: Array<{ id: number }> | null;
  }>;

  // Filter to rows with zero advisories. PostgREST embeds the related rows;
  // empty array (or null) means no advisory rows fired for this outcome.
  const cleanRows = rawRows.filter((r) => {
    const adv = r.compile_outcome_advisories;
    return !adv || adv.length === 0;
  });
  const rowsClean = cleanRows.length;

  // alpha.131 (R2b) — the costed clean rows, split by the pricing basis of their cost.
  const costed = cleanRows.filter((r) => typeof r.cost_usd_actual === 'number');
  const byBasis = splitByPricingBasis(costed);

  if (rowsClean < minRows) {
    return {
      model: opts.model,
      archetype: opts.archetype,
      rowsClean,
      rowsTotal,
      emptyRateClean: null,
      costMeanClean: null,
      costBasis: null,
      costMeanCleanByBasis: { tiered: null, list: null, tieredN: byBasis.tiered.length, listN: byBasis.list.length },
      latencyMeanClean: null,
      qualityMeanClean: null,
    };
  }

  // Compute metrics. Each field defends against NULL in the underlying row.
  // alpha.100 — `success !== false` guards the READ as well as the write.
  // `empty_response` was derived as `tokens_out === 0` with no success term,
  // so every historical failure row carries it (157 of the 169 that have it).
  // Those rows are not rewritten — the brain records what happened — so a
  // query that trusts the flag alone scores a model behind a flaky key or an
  // unfunded account as a model that returns empty answers, which is a
  // quality verdict drawn from an availability fact. Belt and suspenders: the
  // write side stops creating them, this stops the existing ones counting.
  const emptyCount = cleanRows.filter(
    (r) => r.empty_response === true && r.success !== false,
  ).length;
  const emptyRateClean = emptyCount / rowsClean;

  // alpha.131 (R2b) — one basis per mean: the basis holding more costed clean
  // rows, tiered on a tie. (was: one mean over every costed clean row, both
  // bases mixed, until alpha.131.)
  const basisMean = (rs: typeof costed) => (rs.length > 0 ? mean(rs.map((r) => r.cost_usd_actual as number)) : null);
  const costMeanCleanByBasis = {
    tiered: basisMean(byBasis.tiered),
    list: basisMean(byBasis.list),
    tieredN: byBasis.tiered.length,
    listN: byBasis.list.length,
  };
  const costBasis: 'tiered' | 'list' | null =
    costed.length === 0 ? null : byBasis.tiered.length >= byBasis.list.length ? 'tiered' : 'list';
  const costMeanClean = costBasis === null ? null : costMeanCleanByBasis[costBasis];

  const latencyVals = cleanRows
    .map((r) => r.latency_ms)
    .filter((v): v is number => typeof v === 'number');
  const latencyMeanClean = latencyVals.length > 0 ? mean(latencyVals) : null;

  const qualityVals = cleanRows
    .map((r) => r.oracle_score)
    .filter((v): v is number => typeof v === 'number');
  const qualityMeanClean = qualityVals.length > 0 ? mean(qualityVals) : null;

  return {
    model: opts.model,
    archetype: opts.archetype,
    rowsClean,
    rowsTotal,
    emptyRateClean,
    costMeanClean,
    costBasis,
    costMeanCleanByBasis,
    latencyMeanClean,
    qualityMeanClean,
  };
}

function mean(xs: number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.23 — getPerAxisMetrics (Phase 3 substrate)
// ─────────────────────────────────────────────────────────────────────────
//
// Calls the `get_per_axis_metrics` PostgreSQL function (migration 017),
// returns the per-axis breakdown for a single (app_id, archetype, model)
// tuple. NO composite score — caller composes a multiplier formula using
// the raw axes. Per `feedback_quality_as_floor`: quality is a BINARY FLOOR,
// not a weight.
//
// Like getCleanPerfScore, this is one-shot async (NOT through the SWR
// cache). Intended for low-frequency operator/dashboard queries, not
// per-call hot paths.
//
// Tolerance: returns null when brain not configured, RPC returns empty,
// fetch throws, or response is malformed. NEVER throws.

import type { PerAxisMetrics } from './ir.js';

export interface GetPerAxisMetricsOpts {
  /** App id to filter on. Required. */
  appId: string;
  /** Intent archetype to filter on. Required. */
  archetype: string;
  /** Canonical model id to filter on. Required. */
  model: string;
  /**
   * Window in days. Default 30. Only rows with
   * `created_at > now() - windowDays` are counted.
   */
  windowDays?: number;
  /**
   * Consumer-declared quality floor (0..1 oracle/approve-rate scale).
   * When set, the response's `qualityFloorMet` is true/false; when omitted,
   * `qualityFloorMet` is null (no floor declared, no judgment).
   */
  qualityFloor?: number;
  /** Pluggable fetch (tests inject mock). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * PostgREST base endpoint (e.g. `https://kgauto-brain.vercel.app/api`).
   * When omitted, falls back to the active configureBrainQuery runtime's
   * endpoint. Returns null when neither is set.
   */
  endpoint?: string;
  /** Bearer token. Forwarded as `Authorization: Bearer ${apiKey}`. */
  apiKey?: string;
}

/**
 * Call the `get_per_axis_metrics` RPC and return the typed result.
 *
 * Returns null when:
 *   - no endpoint provided AND no configureBrainQuery runtime active
 *   - RPC returns empty / null / unexpected shape
 *   - brain unreachable / fetch throws / HTTP error
 *
 * Never throws — operator-facing query, must not blow up the caller.
 */
export async function getPerAxisMetrics(
  opts: GetPerAxisMetricsOpts,
): Promise<PerAxisMetrics | null> {
  const fetchFn = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? runtime?.endpoint;
  if (!endpoint) return null;

  const windowDays = opts.windowDays ?? 30;
  const body: Record<string, unknown> = {
    p_app_id: opts.appId,
    p_archetype: opts.archetype,
    p_model: opts.model,
    p_window_days: windowDays,
    p_quality_floor: opts.qualityFloor ?? null,
  };

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };

  try {
    const res = await fetchFn(`${endpoint}/rpc/get_per_axis_metrics`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    return mapPerAxisMetrics(raw, opts.appId, opts.archetype, opts.model, windowDays);
  } catch {
    return null;
  }
}

/**
 * Map the snake_case JSONB returned by the RPC to the camelCase
 * `PerAxisMetrics` shape. Null-preserving: when the brain returns null
 * for an axis field, the typed result keeps null (NOT coerced to 0).
 *
 * Returns null when the input is null/undefined/non-object — explicit
 * absence rather than a partially-populated metrics object.
 */
function mapPerAxisMetrics(
  raw: unknown,
  fallbackAppId: string,
  fallbackArchetype: string,
  fallbackModel: string,
  fallbackWindowDays: number,
): PerAxisMetrics | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // PostgREST may wrap a scalar RPC return in an array of length 1; unwrap.
  // (jsonb_build_object returns a single jsonb object, so the typical
  // response is the object directly, but defensively handle the array shape.)
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    return mapPerAxisMetrics(raw[0], fallbackAppId, fallbackArchetype, fallbackModel, fallbackWindowDays);
  }

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const int = (v: unknown): number => {
    const n = num(v);
    return n === null ? 0 : Math.trunc(n);
  };
  const bool = (v: unknown): boolean | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v;
    return null;
  };
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' ? v : fallback;

  const cost = (r.cost_efficiency ?? {}) as Record<string, unknown>;
  const time = (r.time_efficiency ?? {}) as Record<string, unknown>;
  const rel = (r.reliability ?? {}) as Record<string, unknown>;

  return {
    appId: str(r.app_id, fallbackAppId),
    archetype: str(r.archetype, fallbackArchetype),
    model: str(r.model, fallbackModel),
    windowDays: num(r.window_days) ?? fallbackWindowDays,
    nRows: int(r.n_rows),
    nRowsClean: int(r.n_rows_clean),
    nQualityOutcomes: int(r.n_quality_outcomes),
    magicRate: num(r.magic_rate),
    qualityFloorMet: bool(r.quality_floor_met),
    costEfficiency: {
      avgCostUsd: num(cost.avg_cost_usd),
      avgCostUsdClean: num(cost.avg_cost_usd_clean),
      avgInputTokens: num(cost.avg_input_tokens),
      avgOutputTokens: num(cost.avg_output_tokens),
      inputTokenRatio: num(cost.input_token_ratio),
    },
    timeEfficiency: {
      avgLatencyMs: num(time.avg_latency_ms),
      avgTtftMs: num(time.avg_ttft_ms),
    },
    reliability: {
      successRate: num(rel.success_rate),
      successRateClean: num(rel.success_rate_clean),
      emptyRate: num(rel.empty_rate),
      emptyRateClean: num(rel.empty_rate_clean),
    },
    evidenceFreshnessDays: num(r.evidence_freshness_days),
  };
}

/**
 * Parse the `Content-Range` header PostgREST returns under
 * `Prefer: count=exact`. Shape: `0-9/123` (or `STAR/0` for empty result).
 * Returns the trailing total. Returns 0 on parse failure (cautious default).
 */
function parseContentRangeCount(res: Response): number {
  const header = res.headers.get('content-range');
  if (!header) return 0;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return 0;
  const tail = header.slice(slash + 1).trim();
  if (tail === '*' || tail === '') return 0;
  const n = Number(tail);
  return Number.isFinite(n) ? n : 0;
}
