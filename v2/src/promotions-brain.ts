/**
 * promotions-brain — alpha.64 Stage-2 substrate.
 *
 * Per-tenant SWR cache for the `kgauto_promotions` table populated by the
 * golden-eval trigger's auto-promote actor (Stage 2 of the eval trust
 * ladder: auto-promote downswaps behind the 7-day rollback guard). Mirrors
 * `promote-ready-brain.ts` shape where applicable; this is the read-side
 * substrate for the compile-time promotion boost in `passScoreTargets`.
 *
 * Design contract:
 *   command-center/advisory/kgauto/2026-07-18_stage2-auto-promote-design.md
 *
 * Consent posture: the routing effect is OPT-IN, default OFF. The cache is
 * only activated by `configureBrain()` when the consumer opted in via
 * `BrainConfig.autoPromote: true` or the `KGAUTO_AUTO_PROMOTE` env var
 * (config field wins when both are present — mirror of the
 * `KGAUTO_GOLDEN_CAPTURE` env-as-consent precedent). Not opted in ⇒ this
 * module never fetches and `getApplicablePromotion` returns undefined ⇒
 * zero behavior change anywhere in compile().
 *
 * Architecture (mirror of promote-ready-brain):
 *   - Sync API surface: `getApplicablePromotion({ appId, archetype })`
 *     returns immediately. First call returns undefined (cold) and fires an
 *     async refresh; subsequent calls within TTL return brain data.
 *   - Per-appId snapshot; one fetch per appId per TTL window.
 *   - Tolerant: brain down / misconfigured / unexpected shape → undefined.
 *     Never throws. Warns once per process.
 *
 * A rollback (`status='rolled_back'` PATCHed by the promotion-guard
 * watcher) drops the row from the endpoint's `status=active` filter, so
 * routing reverts within one TTL window — the mechanism the 7-day guard's
 * auto-revert rests on.
 */

import type { IntentArchetypeName } from './dialect.js';

/**
 * One active surface promotion, camelCase-mapped at the boundary from the
 * snake_case endpoint row (typed-boundary-transformer convention).
 */
/**
 * Release B (alpha.75): `kgauto_promotions` carries two logical channels
 * sharing one table and one lifecycle (migration 047). `mode` is the
 * discriminator, and each mode has exactly ONE consumption site:
 *
 *   mode        reader                              effect
 *   ----------  ----------------------------------  -------------------
 *   downswap    passScoreTargets (compile pass 5)   which MODEL runs
 *   strategy    applySectionRewrites (pass 6.5)     which IR runs
 *
 * The resolver is mode-filtered and no unfiltered accessor exists — an
 * unfiltered `.find()` was the §7 read-path bug: a strategy row has
 * promoted_model === incumbent_model, so one reaching the model-boost code
 * would boost the incumbent and could suppress the alpha.49 quality gate on
 * evidence that was never about quality-gating.
 */
export type PromotionMode = 'downswap' | 'strategy';

export interface PromotionRow {
  /** Brain row id — cited in the `promotion-applied` mutation for Glass-Box. */
  id: number;
  /** Intent archetype the promotion applies to. */
  archetype: string;
  /**
   * Channel discriminator (migration 047). Rows from a pre-047 endpoint
   * carry no `mode` on the wire and map to 'downswap' — every pre-047 row
   * IS a downswap, and strategy rows can only be written by post-047 code
   * whose endpoint serves the column.
   */
  mode: PromotionMode;
  /**
   * The strategy id for mode='strategy' rows (e.g. 'discipline-gates-v1');
   * null on downswaps. DB CHECK: (mode='strategy') = (strategy IS NOT NULL).
   */
  strategy: string | null;
  /** The model this surface now routes to. */
  promotedModel: string;
  /** The model it replaced (the eval's incumbent). */
  incumbentModel: string;
  /** The promote-ready kgauto_golden_eval_runs row this rests on. */
  evalRunId: number | null;
  /**
   * Evidence-supersedes-judgment: skip the alpha.49 schema-weak
   * quality-gate penalty for the promoted model on this surface (the eval
   * measured the schema floor holding on real workload). Always false on
   * strategy rows (DB CHECK kgauto_promotions_strategy_no_suppress).
   */
  suppressQualityGate: boolean;
  /** ISO timestamp the promotion went active. */
  promotedAt: string;
  /**
   * alpha.78 — lifecycle status. The endpoint serves rolled_back rows only
   * when the library asks (`with_rollbacks=1`), so pre-.78 clients can
   * never receive one. Every reader that APPLIES a promotion must filter
   * to 'active'; rolled_back rows exist so advisors can see what the guard
   * already adjudicated instead of re-recommending it (PB Finding 3).
   */
  status: 'active' | 'rolled_back';
  /** ISO timestamp of the guard's revert, rolled_back rows only. */
  rolledBackAt?: string;
  /** Guard's classification ('latency' | 'economics' | 'strategy' | …). */
  rollbackClass?: string;
}

interface RawPromotionRow {
  id: number | string;
  intent_archetype: string;
  mode?: string;
  strategy?: string | null;
  promoted_model: string;
  incumbent_model: string;
  eval_run_id?: number | string | null;
  suppress_quality_gate?: boolean;
  promoted_at?: string;
  status?: string;
  rolled_back_at?: string | null;
  rollback_class?: string | null;
}

function isRawPromotionRow(x: unknown): x is RawPromotionRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    (typeof r.id === 'number' || typeof r.id === 'string') &&
    typeof r.intent_archetype === 'string' &&
    typeof r.promoted_model === 'string' &&
    typeof r.incumbent_model === 'string'
  );
}

function coerceId(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mapRowsToPromotions(rows: unknown[]): PromotionRow[] {
  const out: PromotionRow[] = [];
  for (const row of rows) {
    if (!isRawPromotionRow(row)) continue;
    const id = coerceId(row.id);
    if (id === null) continue;
    // Unknown mode strings (a future channel this build predates) are
    // DROPPED, not defaulted — defaulting would hand a future channel's row
    // to the downswap reader, recreating the §7 bug one version later.
    const mode: PromotionMode | null =
      row.mode === 'strategy'
        ? 'strategy'
        : row.mode === 'downswap' || row.mode === undefined
          ? 'downswap'
          : null;
    if (mode === null) continue;
    out.push({
      id,
      archetype: row.intent_archetype,
      mode,
      strategy: typeof row.strategy === 'string' ? row.strategy : null,
      promotedModel: row.promoted_model,
      incumbentModel: row.incumbent_model,
      evalRunId: coerceId(row.eval_run_id ?? null),
      suppressQualityGate: row.suppress_quality_gate === true,
      promotedAt: typeof row.promoted_at === 'string' ? row.promoted_at : '',
      // Pre-.78 endpoints serve no status column and only active rows —
      // defaulting to 'active' is exact, not optimistic.
      status: row.status === 'rolled_back' ? 'rolled_back' : 'active',
      ...(typeof row.rolled_back_at === 'string' ? { rolledBackAt: row.rolled_back_at } : {}),
      ...(typeof row.rollback_class === 'string' ? { rollbackClass: row.rollback_class } : {}),
    });
  }
  return out;
}

interface AppSnapshot {
  data: PromotionRow[];
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
export function promotionsFreshness(appId: string): 'cold' | 'warm' {
  return snapshots.get(appId)?.loaded ? 'warm' : 'cold';
}

export interface PromotionsRuntime {
  /** Endpoint base URL. The library appends `?app_id=<id>`. */
  endpoint: string;
  /** Stale-while-revalidate window in ms. */
  ttlMs: number;
  /** Pluggable fetch. */
  fetchImpl: typeof fetch;
  /** Optional warn hook. */
  onError?: (err: unknown) => void;
}

let runtime: PromotionsRuntime | undefined;
let warnedOnce = false;

/**
 * Default endpoint hosted on the kgauto-dashboard. Serves `status='active'`
 * kgauto_promotions rows for one app_id. Mirrors the findings convention.
 */
export const DEFAULT_PROMOTIONS_ENDPOINT =
  'https://kgauto-dashboard.vercel.app/api/kgauto-v2/promotions';

/**
 * True when the KGAUTO_AUTO_PROMOTE env var opts this process in.
 * Accepted truthy forms: '1', 'true' (case-insensitive). Everything else —
 * unset, '', '0', 'false' — is OFF. Read at configureBrain() time, not per
 * call.
 */
export function isAutoPromoteEnabledFromEnv(
  envSource?: Record<string, string | undefined>,
): boolean {
  const env =
    envSource ??
    (typeof process !== 'undefined' && process.env ? process.env : {});
  const raw = (env.KGAUTO_AUTO_PROMOTE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Wire (or rewire) the runtime. Pass undefined to disable. Resets all
 * snapshots. Called from `configureBrain()` ONLY when the consumer opted in.
 */
export function configurePromotionsBrain(
  rt: PromotionsRuntime | undefined,
): void {
  runtime = rt;
  snapshots.clear();
  warnedOnce = false;
}

/** Sync introspection — is the promotions brain active (i.e. opted in)? */
export function isPromotionsBrainActive(): boolean {
  return runtime !== undefined;
}

export interface GetApplicablePromotionOpts {
  /** App id to read promotions for. Required. */
  appId: string;
  /** Archetype of the compile in flight. Required. */
  archetype: IntentArchetypeName | string;
  /**
   * Channel to read (migration 047). Required — there is deliberately no
   * unfiltered accessor: with one active row per (surface, mode) legal, an
   * unfiltered first-match-wins `.find()` returns an arbitrary channel's
   * row, and a strategy row reaching the model-boost reader is the §7
   * read-path bug.
   */
  mode: PromotionMode;
}

/**
 * Sync reader. Returns the active promotion for `(appId, archetype, mode)`
 * or undefined. First call returns undefined and triggers async refresh;
 * subsequent calls within TTL return brain data. The brain enforces one
 * active promotion per (surface, mode) (partial unique index), so at most
 * one row matches.
 *
 * NEVER throws. Not configured / brain down / cold → undefined.
 */
export function getApplicablePromotion(
  opts: GetApplicablePromotionOpts,
): PromotionRow | undefined {
  const rt = runtime;
  if (!rt) return undefined;

  const appId = opts.appId;
  if (!appId || !opts.archetype || !opts.mode) return undefined;

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

  return snap.data.find(
    (p) =>
      p.status === 'active' &&
      p.archetype === opts.archetype &&
      p.mode === opts.mode,
  );
}

/**
 * alpha.78 — how long a guard rollback suppresses re-recommending the same
 * model on the same surface. Matches the measured-failure evidence window:
 * a `rollback_class='latency'` revert deliberately keeps the model ELIGIBLE
 * long-term (traffic patterns change), so the suppression is windowed, not
 * permanent.
 */
export const ROLLBACK_SUPPRESSION_WINDOW_DAYS = 28;

/**
 * alpha.78 (PB Finding 3) — sync reader: did the promotion guard recently
 * roll back `model` on `(appId, archetype)`? The cost advisor consults this
 * so it stops recommending "exactly the downswap your own machinery
 * auto-reverted three days ago" — an advisory acting on it would
 * re-litigate a decision the guard already made correctly. Same SWR
 * posture as `getApplicablePromotion`: cold/unconfigured → undefined
 * (advisor proceeds without rollback knowledge, as before alpha.78).
 */
export function getRecentRollback(opts: {
  appId: string;
  archetype: IntentArchetypeName | string;
  model: string;
  windowDays?: number;
  nowMs?: number;
}): PromotionRow | undefined {
  const rt = runtime;
  if (!rt) return undefined;
  if (!opts.appId || !opts.archetype || !opts.model) return undefined;

  let snap = snapshots.get(opts.appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(opts.appId, snap);
  }
  const now = opts.nowMs ?? Date.now();
  if (snap.expiresAt <= now && !snap.refreshing) {
    snap.refreshing = true;
    void asyncRefresh(rt, opts.appId);
  }

  const windowMs =
    (opts.windowDays ?? ROLLBACK_SUPPRESSION_WINDOW_DAYS) * 86_400_000;
  return snap.data.find(
    (p) =>
      p.status === 'rolled_back' &&
      p.archetype === opts.archetype &&
      p.promotedModel === opts.model &&
      typeof p.rolledBackAt === 'string' &&
      now - Date.parse(p.rolledBackAt) <= windowMs,
  );
}

let pendingRefreshes = new Map<string, Promise<void>>();

async function asyncRefresh(
  rt: PromotionsRuntime,
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
  rt: PromotionsRuntime,
  appId: string,
): Promise<void> {
  // alpha.78 — ask for rollback rows too. Old endpoints ignore the param
  // and serve active-only; readers filter by status either way.
  const url = `${rt.endpoint}?app_id=${encodeURIComponent(appId)}&with_rollbacks=1`;
  let snap = snapshots.get(appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(appId, snap);
  }
  try {
    const res = await rt.fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`promotions ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (runtime !== rt) return;
    const rows = Array.isArray(body) ? mapRowsToPromotions(body) : [];
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
    '[kgauto] promotions fetch failed (promotion boost inactive until next refresh):',
    err,
  );
}

/**
 * alpha.86 — cold-start prefetch, the promotions twin of alpha.73's
 * `prefetchMeasuredFailure`.
 *
 * alpha.73 fixed cold-isolate blindness for the measured-failure gate and
 * did not cover this sibling subsystem: `compile()` is synchronous, so on a
 * cold isolate `getApplicablePromotion` reads an empty snapshot and an
 * ACTIVE promotion silently does not apply — hitting low-traffic consumers
 * (whose isolates are cold most of the time) hardest, directly under
 * trust-artifact #3. Found s81 via the smoke's own cold-cache bug; grep
 * confirmed zero prefetch call sites existed.
 *
 * Also the fix for the s81 smoke incident's root shape: this starts the SWR
 * refresh directly, so it cannot be defeated by `getApplicablePromotion`'s
 * argument validation early-returns.
 *
 * Returns the in-flight promise (or undefined when not configured / already
 * fresh) so a caller can await it. NEVER throws.
 */
export function prefetchPromotions(appId: string): Promise<void> | undefined {
  const rt = runtime;
  if (!rt || !appId) return undefined;

  let snap = snapshots.get(appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(appId, snap);
  }
  if (snap.expiresAt > Date.now()) return undefined; // already fresh
  const inflight = pendingRefreshes.get(appId);
  if (inflight) return inflight;
  if (snap.refreshing) return undefined;

  snap.refreshing = true;
  void asyncRefresh(rt, appId);
  return pendingRefreshes.get(appId);
}

/**
 * alpha.86 — bounded await on the promotions warm-up, for async callers
 * only (`call()`); `compile()` stays synchronous. Same contract as
 * `awaitMeasuredFailureReady`: bounded, silent on timeout, protective
 * never required — a slow or down brain delays a call by at most
 * `timeoutMs` and can never fail one. A zero budget still kicks the
 * prefetch (the opt-out is "do not make me wait", not "do not warm up").
 *
 * NEVER throws.
 */
export async function awaitPromotionsReady(
  appId: string,
  timeoutMs: number,
): Promise<void> {
  if (!runtime || !appId) return;
  const pending = prefetchPromotions(appId) ?? pendingRefreshes.get(appId);
  if (!(timeoutMs > 0)) return; // warmed in background; caller waits for nothing
  if (!pending) return; // already fresh, or not configured
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // doRefresh swallows its own errors; belt-and-braces.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/** Reset module state. Tests must call between cases. */
export function _testResetPromotions(): void {
  runtime = undefined;
  snapshots.clear();
  pendingRefreshes = new Map();
  warnedOnce = false;
}

/** Wait for any in-flight refresh to settle. */
export async function _testWaitForPromotionsRefresh(): Promise<void> {
  const pending = Array.from(pendingRefreshes.values());
  if (pending.length > 0) await Promise.all(pending);
}
