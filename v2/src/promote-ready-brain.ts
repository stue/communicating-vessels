/**
 * promote-ready-brain — alpha.41 substrate.
 *
 * Per-tenant SWR cache for the `promote_ready_findings` table populated by
 * the autonomous `promotion-probe-watcher` (Mode 2). Mirrors
 * `exclusion-findings-brain.ts` shape byte-for-byte where applicable; this
 * is the read-side substrate for the compile-time `promote-ready` advisor
 * rule.
 *
 * Architecture (mirror of exclusion-findings-brain):
 *
 * - **Sync API surface.** `getPromoteReadyFindings({ appId, archetype,
 *   family })` returns `PromoteReadyFindingRow[]` immediately. First call
 *   returns the bundled fallback (empty array); async refresh fires in
 *   background; subsequent calls within TTL return brain data.
 *
 * - **Per-appId snapshot.** Each appId gets its own cache entry. One fetch
 *   per appId per TTL window. Tests reset between cases via
 *   `_testResetPromoteReadyFindings()`.
 *
 * - **Tolerant.** Brain down / endpoint misconfigured / unexpected shape →
 *   silent bundled fallback (empty array). Never throws. Warns once per
 *   process per error to avoid log spam.
 *
 * - **Opt-in.** Activation gated on `configurePromoteReadyBrain()` having
 *   been called with a runtime. The public `configureBrain()` in brain.ts
 *   wires this up automatically when
 *   `BrainConfig.brainQuery.findingsPromoteReady !== false`.
 *
 * Plus: `markPromoteReadyHandled` — direct PostgREST PATCH against the
 * brain (no kgauto proxy). Mirrors `markExclusionFindingHandled` shape
 * byte-for-byte. Idempotent on `resolved_at=is.null` filter.
 *
 * Default endpoint:
 *   `https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/promote-ready`
 *   The route accepts `?app_id=X` and returns a JSON array of findings
 *   for that app filtered to `resolved_at IS NULL`.
 */

import type { IntentArchetypeName } from './dialect.js';

/**
 * Shape of one row from the `promote_ready_findings` cache table. Mirrors
 * the snake_case JSONB returned by the brain endpoint, mapped to camelCase
 * at the boundary (rowToFinding) so the in-memory shape stays consistent
 * with the rest of the library.
 */
export interface PromoteReadyFindingRow {
  /** Intent archetype the finding applies to. */
  archetype: string;
  /** Model family (e.g. 'claude-opus', 'gemini-flash'). */
  family: string;
  /** The candidate model that the probe validated. */
  candidateModel: string;
  /** The current production model the candidate was compared against. */
  currentModel: string;
  /** Sample size of the probe run (typically 10). */
  sampleN: number;
  /** Fraction of probes where the judge verdict was 'candidate-better' or
   *  'tied'. 0.000 to 1.000. */
  judgePassRate: number;
  /** Mean judge score across the probe sample. 1.00 to 5.00. */
  judgeAvgScore: number;
  /** Signed cost delta as a fraction (negative = candidate is cheaper).
   *  Null when pricing data was incomplete at probe time. */
  costDeltaPct: number | null;
  /** ISO timestamp of detection (when the probe wrote the row). */
  detectedAt: string;
}

/**
 * Raw row shape returned by the dashboard endpoint / brain REST. Snake-case
 * matches the PostgREST projection.
 */
interface RawPromoteReadyRow {
  intent_archetype: string;
  family: string;
  candidate_model: string;
  current_model: string;
  sample_n: number | string;
  judge_pass_rate: number | string;
  judge_avg_score: number | string;
  cost_delta_pct: number | string | null;
  detected_at: string;
}

function isRawPromoteReadyRow(x: unknown): x is RawPromoteReadyRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.intent_archetype === 'string' &&
    typeof r.family === 'string' &&
    typeof r.candidate_model === 'string' &&
    typeof r.current_model === 'string' &&
    typeof r.detected_at === 'string'
  );
}

function coerceNumber(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mapRowsToFindings(rows: unknown[]): PromoteReadyFindingRow[] {
  const out: PromoteReadyFindingRow[] = [];
  for (const row of rows) {
    if (!isRawPromoteReadyRow(row)) continue;
    const sampleN = coerceNumber(row.sample_n);
    const passRate = coerceNumber(row.judge_pass_rate);
    const avgScore = coerceNumber(row.judge_avg_score);
    if (sampleN === null || passRate === null || avgScore === null) continue;
    out.push({
      archetype: row.intent_archetype,
      family: row.family,
      candidateModel: row.candidate_model,
      currentModel: row.current_model,
      sampleN,
      judgePassRate: passRate,
      judgeAvgScore: avgScore,
      costDeltaPct: coerceNumber(row.cost_delta_pct),
      detectedAt: row.detected_at,
    });
  }
  return out;
}

interface AppSnapshot {
  data: PromoteReadyFindingRow[];
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
export function promoteReadyFreshness(appId: string): 'cold' | 'warm' {
  return snapshots.get(appId)?.loaded ? 'warm' : 'cold';
}

/**
 * Internal runtime config. Set by `configurePromoteReadyBrain()` from
 * `configureBrain()` in brain.ts when the consumer opts in.
 */
export interface PromoteReadyRuntime {
  /** Endpoint base URL. The library appends `?app_id=<id>`. */
  endpoint: string;
  /** Stale-while-revalidate window in ms. */
  ttlMs: number;
  /** Pluggable fetch. */
  fetchImpl: typeof fetch;
  /** Optional warn hook. */
  onError?: (err: unknown) => void;
}

let runtime: PromoteReadyRuntime | undefined;
let warnedOnce = false;

/**
 * Default endpoint hosted on the kgauto-dashboard. Mirrors the
 * exclusion-findings convention.
 */
export const DEFAULT_PROMOTE_READY_ENDPOINT =
  'https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/promote-ready';

/**
 * Wire (or rewire) the runtime. Pass undefined to disable. Resets all
 * snapshots.
 */
export function configurePromoteReadyBrain(
  rt: PromoteReadyRuntime | undefined,
): void {
  runtime = rt;
  snapshots.clear();
  warnedOnce = false;
}

/**
 * Sync introspection — is the promote-ready brain active? Used by advisor
 * rules to decide whether to even attempt a read.
 */
export function isPromoteReadyBrainActive(): boolean {
  return runtime !== undefined;
}

interface GetPromoteReadyFindingsOpts {
  /** App id to read findings for. Required. */
  appId: string;
  /** Optional archetype filter. */
  archetype?: IntentArchetypeName | string;
  /** Optional family filter. */
  family?: string;
}

/**
 * Sync reader. Returns the cached findings for `appId`, optionally filtered
 * to a single archetype + family. First call returns empty array and
 * triggers async refresh; subsequent calls within TTL return brain data.
 *
 * NEVER throws. Brain down / endpoint misconfigured / mapper exception →
 * empty array.
 */
export function loadPromoteReadyFindings(
  opts: GetPromoteReadyFindingsOpts,
): PromoteReadyFindingRow[] {
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

  let rows = snap.data;
  if (opts.archetype) {
    rows = rows.filter((f) => f.archetype === opts.archetype);
  }
  if (opts.family) {
    rows = rows.filter((f) => f.family === opts.family);
  }
  return rows;
}

let pendingRefreshes = new Map<string, Promise<void>>();

async function asyncRefresh(
  rt: PromoteReadyRuntime,
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
  rt: PromoteReadyRuntime,
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
      throw new Error(`promote-ready ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (runtime !== rt) return;
    const rows = Array.isArray(body) ? mapRowsToFindings(body) : [];
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
    '[kgauto] promote-ready fetch failed (using empty fallback):',
    err,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// markPromoteReadyHandled — alpha.41 per-finding silencer.
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors `markExclusionFindingHandled` shape byte-for-byte. Consumer-side
// silencer for the `promote-ready` advisor rule. Without this API the only
// way to silence a probe-validated promotion candidate would be policy-
// posture='locked', which silences EVERY rule for EVERY call.
//
// Resolution surfaces in:
//   1. The dashboard endpoint filters to `resolved_at IS NULL`, so resolved
//      findings stop being served to the library's SWR cache within ~5min
//      TTL.
//   2. A subsequent probe run for the same (app, archetype, family) tuple
//      CAN INSERT a new row (the partial unique index only catches OPEN
//      rows). So consumer-resolved findings are intentionally re-promotable
//      — the resolution decision decays so stale "declined" decisions don't
//      escape detection forever.

/**
 * Resolution sources supported by alpha.41 `markPromoteReadyHandled`. The
 * three values map to the three CHECK-constrained resolution values on
 * `promote_ready_findings.resolution`:
 *
 * - `'promoted'`         — consumer migrated to the candidate model. Strong
 *                          positive signal; the probe was right.
 * - `'declined'`         — consumer evaluated and chose not to promote.
 *                          Strong negative signal; revisit only on new
 *                          family entries or material score swings.
 * - `'still-evaluating'` — consumer acknowledges the finding but defers
 *                          the decision. Acknowledges-without-deciding;
 *                          finding silences this cycle but next probe may
 *                          re-surface.
 */
export type PromoteReadyResolution =
  | 'promoted'
  | 'declined'
  | 'still-evaluating';

export interface MarkPromoteReadyHandledOptions {
  /** App id the finding belongs to. Required (RLS scopes writes by this). */
  appId: string;
  /** Archetype the finding applies to (e.g. 'hunt', 'classify'). */
  archetype: IntentArchetypeName | string;
  /** Model family the finding applies to (e.g. 'claude-opus'). */
  family: string;
  /** Resolution semantics — see `PromoteReadyResolution`. */
  resolution: PromoteReadyResolution;
  /** Optional free-form note explaining the decision. */
  resolutionNote?: string;
  /** Brain Supabase URL base (e.g. `https://<project>.supabase.co`). */
  brainEndpoint: string;
  /** Consumer-scoped JWT carrying the `app_id` claim. */
  brainJwt: string;
  /** Supabase anon key for the `apikey` header. */
  brainAnonKey: string;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

function resolveFetchImpl(injected: typeof fetch | undefined): typeof fetch {
  return injected ?? ((...args) => globalThis.fetch(...args));
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Mark a probe-validated promote-ready finding as handled. Returns an
 * `ok/reason` envelope matching `markExclusionFindingHandled`.
 *
 * Idempotent: if no row matches the (app_id, archetype, family) tuple
 * (already resolved, never existed, watcher not yet UPSERTed), PostgREST
 * returns 200/204 with zero affected rows and we return `{ ok: true }`.
 *
 * Reasons surfaced on failure:
 *   - `app_id_required` / `archetype_required` / `family_required`
 *   - `resolution_invalid` — not one of the three documented values
 *   - `brain_auth_misconfig` — 401/403
 *   - `brain_unavailable` — 5xx
 *   - `network_error:<message>` — fetch threw
 *   - `patch_failed:<status>` — anything else non-2xx
 */
export async function markPromoteReadyHandled(
  opts: MarkPromoteReadyHandledOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const {
    appId,
    archetype,
    family,
    resolution,
    resolutionNote,
    brainEndpoint,
    brainJwt,
    brainAnonKey,
    fetch: injectedFetch,
  } = opts;

  if (!appId) return { ok: false, reason: 'app_id_required' };
  if (!archetype) return { ok: false, reason: 'archetype_required' };
  if (!family) return { ok: false, reason: 'family_required' };
  if (
    resolution !== 'promoted' &&
    resolution !== 'declined' &&
    resolution !== 'still-evaluating'
  ) {
    return { ok: false, reason: 'resolution_invalid' };
  }

  const doFetch = resolveFetchImpl(injectedFetch);
  const base = normalizeEndpoint(brainEndpoint);

  // PATCH /rest/v1/promote_ready_findings filtered by the unique tuple.
  // `resolved_at=is.null` keeps the operation idempotent — already-resolved
  // rows aren't re-stamped with a fresh timestamp.
  const url =
    `${base}/rest/v1/promote_ready_findings` +
    `?app_id=eq.${encodeURIComponent(appId)}` +
    `&intent_archetype=eq.${encodeURIComponent(archetype)}` +
    `&family=eq.${encodeURIComponent(family)}` +
    `&resolved_at=is.null`;

  const patchBody: Record<string, unknown> = {
    resolved_at: new Date().toISOString(),
    resolution,
  };
  if (resolutionNote !== undefined) {
    patchBody.resolution_note = resolutionNote;
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patchBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network_error:${msg}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'brain_auth_misconfig' };
  }
  if (res.status >= 500) {
    return { ok: false, reason: 'brain_unavailable' };
  }
  if (!res.ok) {
    return { ok: false, reason: `patch_failed:${res.status}` };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/** Reset module state. Tests must call between cases. */
export function _testResetPromoteReadyFindings(): void {
  runtime = undefined;
  snapshots.clear();
  pendingRefreshes = new Map();
  warnedOnce = false;
}

/** Wait for any in-flight refresh to settle. */
export async function _testWaitForPromoteReadyRefresh(): Promise<void> {
  const pending = Array.from(pendingRefreshes.values());
  if (pending.length > 0) await Promise.all(pending);
}

/** Inspect a snapshot. Test-only. */
export function _testGetPromoteReadySnapshot(
  appId: string,
): Readonly<AppSnapshot> | undefined {
  return snapshots.get(appId);
}
