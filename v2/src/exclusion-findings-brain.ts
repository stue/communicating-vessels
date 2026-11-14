/**
 * exclusion-findings-brain — alpha.38 KG-19 adapter.
 *
 * Per-tenant SWR cache for the `exclusion_findings` table populated by the
 * `kgauto-exclusion-re-evaluation-watch` cron (alpha.37 substrate). Distinct
 * from the cross-tenant `brain-query.ts` snapshot because exclusion findings
 * are scoped per `app_id` — one process = one consumer = one appId, but the
 * cache key supports multi-app processes by keying snapshots by appId.
 *
 * Architecture mirrors `brain-query.ts` but with a per-(appId) snapshot:
 *
 * - **Sync API surface.** `getStaleExclusionFindings({ appId, archetype })`
 *   returns `ExclusionFindingRow[]` immediately. First call returns the
 *   bundled fallback (empty array); async refresh fires in background;
 *   subsequent calls within TTL return brain data.
 *
 * - **Per-appId snapshot.** Each appId gets its own cache entry. One fetch
 *   per appId per TTL window. Tests can reset between cases.
 *
 * - **Tolerant.** Brain down / endpoint misconfigured / unexpected shape →
 *   silent bundled fallback (empty array). Never throws. Warns once per
 *   process per error to avoid log spam.
 *
 * - **Opt-in.** Activation gated on `configureExclusionFindingsBrain()`
 *   having been called with a runtime. The public `configureBrain()` in
 *   brain.ts wires this up automatically when `BrainConfig.brainQuery
 *   .findingsExclusions !== false`.
 *
 * Default endpoint:
 *   `https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/exclusions`
 *   The route accepts `?app_id=X` and returns a JSON array of findings
 *   for that app filtered to `resolved_at IS NULL`. Public read; data
 *   carries no consumer PII (app id, archetype, model id, cost ratio,
 *   savings estimate).
 */

/**
 * Shape of one row from the `exclusion_findings` cache table. Mirrors the
 * snake_case JSONB returned by the brain RPC + the dashboard endpoint.
 * Camel-case mapping happens at the boundary (rowToFinding) so the in-memory
 * shape stays consistent with the rest of the library.
 */
export interface ExclusionFindingRow {
  /** Intent archetype the finding applies to (e.g. 'hunt', 'classify'). */
  archetype: string;
  /** Canonical model id that the consumer has excluded (zero traffic in window). */
  excludedModel: string;
  /** Provider of the excluded model (e.g. 'deepseek', 'openai'). */
  excludedProvider: string;
  /** Detection verdict — alpha.37 ships 'recommend-probe' only. */
  verdict: 'recommend-probe' | 'unblock' | 'stay-excluded' | 'inconclusive';
  /**
   * Estimated 30-day savings in USD if the excluded model becomes primary
   * on this archetype. Null when pricing is incomplete or excluded model is
   * more expensive than the leader.
   */
  estimatedSavingsUsd30d: number | null;
  /** Renderable summary; produced by the detector / RPC. */
  message: string;
  /** Actionable recommendation; produced by the detector / RPC. */
  suggestion: string;
  /** Detector confidence tier. */
  confidence: 'high' | 'medium' | 'low';
  /**
   * Free-form evidence pack (cost ratio, leader info, promo flags, parallel-
   * tool hint, etc.). Surfaced verbatim to advisor rules for richer messages.
   * Optional — older detector runs may not populate every field.
   */
  evidence?: Record<string, unknown>;
}

/**
 * Raw row shape returned by the dashboard endpoint / brain RPC. Snake-case
 * matches the PostgREST projection.
 */
interface RawFindingRow {
  intent_archetype: string;
  excluded_model: string;
  excluded_provider: string;
  verdict: string;
  estimated_savings_usd_30d: number | string | null;
  message: string;
  suggestion: string;
  confidence: string;
  evidence?: Record<string, unknown> | null;
}

function isValidVerdict(v: string): v is ExclusionFindingRow['verdict'] {
  return (
    v === 'recommend-probe' ||
    v === 'unblock' ||
    v === 'stay-excluded' ||
    v === 'inconclusive'
  );
}

function isValidConfidence(v: string): v is ExclusionFindingRow['confidence'] {
  return v === 'high' || v === 'medium' || v === 'low';
}

function isRawFindingRow(x: unknown): x is RawFindingRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.intent_archetype === 'string' &&
    typeof r.excluded_model === 'string' &&
    typeof r.excluded_provider === 'string' &&
    typeof r.verdict === 'string' &&
    typeof r.message === 'string' &&
    typeof r.suggestion === 'string' &&
    typeof r.confidence === 'string'
  );
}

function mapRowsToFindings(rows: unknown[]): ExclusionFindingRow[] {
  const out: ExclusionFindingRow[] = [];
  for (const row of rows) {
    if (!isRawFindingRow(row)) continue;
    if (!isValidVerdict(row.verdict)) continue;
    if (!isValidConfidence(row.confidence)) continue;
    let savings: number | null = null;
    if (typeof row.estimated_savings_usd_30d === 'number') {
      savings = Number.isFinite(row.estimated_savings_usd_30d)
        ? row.estimated_savings_usd_30d
        : null;
    } else if (typeof row.estimated_savings_usd_30d === 'string') {
      const n = Number(row.estimated_savings_usd_30d);
      savings = Number.isFinite(n) ? n : null;
    }
    out.push({
      archetype: row.intent_archetype,
      excludedModel: row.excluded_model,
      excludedProvider: row.excluded_provider,
      verdict: row.verdict,
      estimatedSavingsUsd30d: savings,
      message: row.message,
      suggestion: row.suggestion,
      confidence: row.confidence,
      evidence:
        row.evidence && typeof row.evidence === 'object'
          ? (row.evidence as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

interface AppSnapshot {
  data: ExclusionFindingRow[];
  expiresAt: number;
  refreshing: boolean;
  /** alpha.87 — true only after a SUCCESSFUL load for this app. The
   *  error path also stamps expiresAt (to avoid refetch storms), so
   *  expiresAt alone cannot distinguish loaded from load-failed. */
  loaded?: boolean;
}

const snapshots = new Map<string, AppSnapshot>();

/**
 * alpha.87 — per-source freshness for `diagnostics.freshness` (the PB
 * `rankedOn` ask, `per-source-freshness-marker-on-callresult`). `'warm'`
 * iff a successful load has completed for this app in this process —
 * data may legitimately be an empty array (a real answer). `'cold'`
 * covers never-loaded, load-failed, and feature-disabled alike: in all
 * three the gate reads no data, which is the state this marker exists
 * to make visible.
 */
export function exclusionFindingsFreshness(appId: string): 'cold' | 'warm' {
  return snapshots.get(appId)?.loaded ? 'warm' : 'cold';
}

/**
 * Internal runtime config. Set by `configureExclusionFindingsBrain()` from
 * `configureBrain()` in brain.ts when the consumer opts in.
 */
export interface ExclusionFindingsRuntime {
  /** Endpoint base URL. The library appends `?app_id=<id>`. */
  endpoint: string;
  /** Stale-while-revalidate window in ms. */
  ttlMs: number;
  /** Pluggable fetch. */
  fetchImpl: typeof fetch;
  /** Optional warn hook. */
  onError?: (err: unknown) => void;
}

let runtime: ExclusionFindingsRuntime | undefined;
let warnedOnce = false;

/**
 * Default endpoint hosted on the kgauto-dashboard. Public read — data carries
 * no PII (app id, archetype, model id, cost ratio, savings estimate). Mirrors
 * the cross-tenant `/api/kgauto-v2/config` pattern.
 */
export const DEFAULT_FINDINGS_ENDPOINT =
  'https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/exclusions';

/**
 * Wire (or rewire) the runtime. Pass undefined to disable. Resets all
 * snapshots — a reconfigure invalidates cached data because the endpoint
 * may have changed.
 */
export function configureExclusionFindingsBrain(
  rt: ExclusionFindingsRuntime | undefined,
): void {
  runtime = rt;
  snapshots.clear();
  warnedOnce = false;
}

/**
 * Sync introspection — is the findings-brain active? Used by advisor rules
 * to decide whether to even attempt a read.
 */
export function isExclusionFindingsBrainActive(): boolean {
  return runtime !== undefined;
}

interface GetExclusionFindingsOpts {
  /** App id to read findings for. Required. */
  appId: string;
  /**
   * Optional archetype filter. When set, returns only findings where
   * `archetype` matches. When omitted, returns all findings for the app.
   */
  archetype?: string;
}

/**
 * Sync reader. Returns the cached findings for `appId`, optionally filtered
 * to a single archetype. First call returns empty array and triggers async
 * refresh; subsequent calls within TTL return brain data.
 *
 * NEVER throws. Brain down / endpoint misconfigured / mapper exception →
 * empty array.
 */
export function getStaleExclusionFindings(
  opts: GetExclusionFindingsOpts,
): ExclusionFindingRow[] {
  const rt = runtime;
  if (!rt) return [];

  const appId = opts.appId;
  if (!appId) return [];

  let snap = snapshots.get(appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(appId, snap);
  }

  const now = Date.now();
  const stale = snap.expiresAt <= now;
  if (stale && !snap.refreshing) {
    snap.refreshing = true;
    void asyncRefresh(rt, appId);
  }

  if (opts.archetype) {
    return snap.data.filter((f) => f.archetype === opts.archetype);
  }
  return snap.data;
}

let pendingRefreshes = new Map<string, Promise<void>>();

async function asyncRefresh(
  rt: ExclusionFindingsRuntime,
  appId: string,
): Promise<void> {
  const promise = doRefresh(rt, appId);
  pendingRefreshes.set(appId, promise);
  try {
    await promise;
  } finally {
    if (pendingRefreshes.get(appId) === promise) {
      pendingRefreshes.delete(appId);
    }
  }
}

async function doRefresh(
  rt: ExclusionFindingsRuntime,
  appId: string,
): Promise<void> {
  const url = `${rt.endpoint}?app_id=${encodeURIComponent(appId)}`;
  let snap = snapshots.get(appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(appId, snap);
  }
  try {
    const res = await rt.fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`findings ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (runtime !== rt) return;
    const rows = Array.isArray(body)
      ? mapRowsToFindings(body)
      : [];
    snap.data = rows;
    snap.loaded = true;
    snap.expiresAt = Date.now() + rt.ttlMs;
    snap.refreshing = false;
  } catch (err) {
    if (runtime !== rt) return;
    snap.refreshing = false;
    snap.expiresAt = Date.now() + rt.ttlMs;
    if (!warnedOnce) {
      warnedOnce = true;
      (rt.onError ?? defaultOnError)(err);
    }
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    '[kgauto] exclusion-findings fetch failed (using empty fallback):',
    err,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers — exported via _internal in index.ts only.
// ─────────────────────────────────────────────────────────────────────────

/** Reset module state. Tests must call between cases. */
export function _testResetExclusionFindings(): void {
  runtime = undefined;
  snapshots.clear();
  pendingRefreshes = new Map();
  warnedOnce = false;
}

/** Wait for any in-flight refresh to settle. */
export async function _testWaitForExclusionFindingsRefresh(): Promise<void> {
  const pending = Array.from(pendingRefreshes.values());
  if (pending.length > 0) await Promise.all(pending);
}

/** Inspect a snapshot. Test-only. */
export function _testGetExclusionFindingsSnapshot(
  appId: string,
): Readonly<AppSnapshot> | undefined {
  return snapshots.get(appId);
}
