/**
 * measured-failure-brain — the CREATE-a-gate direction of
 * measured-supersedes-judgment (alpha.70).
 *
 * alpha.49 gives kgauto a quality gate that fires off a model profile's
 * DECLARED conventions (`archetypeConventions.structuredOutputHint: 'avoid'`).
 * alpha.64 let a MEASURED eval verdict SUPPRESS that gate
 * (`kgauto_promotions.suppress_quality_gate`). Nothing could go the other
 * way — a model whose declarations are wrong could not have a gate CREATED
 * for it, which is precisely the case where declarations cannot be trusted.
 *
 * The originating evidence: `claude-haiku-4-5` on playbacksam/summarize
 * declares `structuredOutput: 'grammar'` + `archetypePerf.summarize: 8`, so
 * every quality signal reads green and it wins the surface on price — while
 * failing **12 of 12 in-window attempts** (2026-07-14..25, seven in one
 * day). The brain held that evidence and nothing could act on it.
 *
 * ── Design notes ───────────────────────────────────────────────────────
 *
 * **No stored decision.** The gate is DERIVED from a rolling 28d window
 * (`kgauto_surface_model_failure_v`), never written down. That kills the
 * flap problem by construction — there is no state to flap — and it means
 * a gated model un-gates itself once its failures age out. Combined with
 * the gate being a DE-RANK (out of leadership, retained as graceful
 * fallback) rather than a hard block, the model keeps earning evidence, so
 * this cannot become the exclusion-lock-in trap where a blocked model can
 * never prove itself again.
 *
 * **The threshold is a confidence bound, not a fixed sample floor.** A flat
 * `minSample: 20` (promotion-guard's rate floor) would NOT have fired on
 * haiku's n=12 — the consumer would keep paying while we waited for a
 * rounder number. But distinguishing 100% from 5% needs far fewer trials
 * than distinguishing 2% from 6%. Gating on the Wilson score lower bound
 * makes the sample requirement adapt to the effect size automatically,
 * which is the alpha.67 insight ("the sample floor for a median can be far
 * lower than for a rate") generalised properly.
 *
 * **Direct app-scoped read, not the config-endpoint cache.** Modelled on
 * `promotions-brain.ts`, deliberately NOT `createBrainQueryCache` — that
 * routes through the dashboard `/v2/config` projection, which is the third
 * layer in the L-073 "executable knowledge is dropped at every transport
 * boundary" chain. One fewer place to forget a field.
 */

import type { IntentArchetypeName } from './dialect.js';

/**
 * One row of the rolling-window evidence view, per (app, archetype, model).
 * Raw counts only — the brain serves facts, this module decides.
 */
export interface SurfaceFailureRow {
  archetype: string;
  model: string;
  /**
   * QUALITY-axis denominator: attempts that produced something judgeable
   * (served + quality walkaways). Excludes calls that never reached an
   * answer — a 429 is not a trial of the model's quality. See migration 071.
   */
  n: number;
  /** Attempts that failed on the quality axis. */
  nFail: number;
  /**
   * alpha.98 — AVAILABILITY-axis denominator: every served attempt is a
   * trial of whether the model can be reached at all.
   */
  nAttempted: number;
  /** Attempts that never reached an answer — 429, auth, timeout, transport. */
  nUnavailable: number;
  /**
   * Failures in NEITHER vocabulary. Carried so the taxonomy's blind spot is
   * a number rather than silence; not gated on.
   */
  nUnclassified: number;
}

interface RawFailureRow {
  intent_archetype: string;
  model: string;
  n: number | string;
  n_fail: number | string;
  n_attempted?: number | string;
  n_unavailable?: number | string;
  n_unclassified?: number | string;
}

function coerceCount(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isRawFailureRow(x: unknown): x is RawFailureRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.intent_archetype === 'string' &&
    typeof r.model === 'string' &&
    (typeof r.n === 'number' || typeof r.n === 'string')
  );
}

function mapRows(rows: unknown[]): SurfaceFailureRow[] {
  const out: SurfaceFailureRow[] = [];
  for (const row of rows) {
    if (!isRawFailureRow(row)) continue;
    const n = coerceCount(row.n);
    const nFail = coerceCount(row.n_fail) ?? 0;
    // alpha.98 — pre-071 brains do not serve the availability columns. Absent
    // is not zero-with-confidence: `nAttempted` falls back to the quality
    // denominator so an old brain behaves exactly as it did, and
    // `nUnavailable: 0` then makes the availability axis unfireable rather
    // than falsely clean. A brain that cannot answer must not be read as
    // answering "no failures" (the s79 success-signals-that-lie shape).
    const nAttempted = coerceCount(row.n_attempted);
    const nUnavailable = coerceCount(row.n_unavailable) ?? 0;
    const nUnclassified = coerceCount(row.n_unclassified) ?? 0;
    if (n === null) continue;
    // A tuple may be 0-for-quality and still carry availability evidence
    // (every call 429'd, so nothing was ever judgeable). Keep it.
    if (n <= 0 && nUnavailable <= 0) continue;
    out.push({
      archetype: row.intent_archetype,
      model: row.model,
      n,
      nFail,
      nAttempted: nAttempted ?? n,
      nUnavailable,
      nUnclassified,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// The statistic
// ─────────────────────────────────────────────────────────────────────────

export const MEASURED_FAILURE_CFG = {
  /**
   * Hard minimum attempts before ANY gate may be created. Guards against
   * pathological tiny samples that the confidence bound alone would let
   * through in edge cases. At 5-for-5 the bound clears the threshold; at
   * 3-for-3 it does not, which is the behaviour we want (three failures is
   * a bad day, five in a row is a pattern).
   */
  minSample: 5,
  /**
   * Gate when we are 95% confident the model fails MORE OFTEN THAN IT
   * SUCCEEDS on this surface. Deliberately unarguable rather than tuned —
   * a model that probably fails the majority of the time has no business
   * leading a surface, whatever its declared scores say.
   */
  lowerBoundThreshold: 0.5,
  /** 95% one-sided-ish confidence (standard two-sided z at α=0.05). */
  z: 1.96,
  /** Must match the view's window. Documented here for the advisory text. */
  windowDays: 28,
  /**
   * alpha.98 — the AVAILABILITY axis. Same statistic, separate vocabulary,
   * separate verdict, because a 429 and a parse-failure send an operator in
   * opposite directions (fund or throttle the account vs. distrust the
   * model's declared structuredOutput). Merging them into one "failure rate"
   * is the s75 normalization defect.
   *
   * Thresholds match the quality axis deliberately: "we are 95% confident
   * this model is unreachable more often than not" is the same unarguable
   * bar, and a de-rank is the same remedy. Kept as a distinct config block
   * so the two can be tuned apart when evidence says they should be.
   */
  availability: {
    minSample: 5,
    lowerBoundThreshold: 0.5,
    z: 1.96,
  },
} as const;

/**
 * Wilson score interval, lower bound. Preferred over the normal
 * approximation because it stays sane at the extremes — at p̂ = 1 the
 * normal approximation gives a zero-width interval (it would gate on a
 * single failure), while Wilson correctly returns a bound that tightens
 * with n.
 *
 * Returns 0 for n <= 0.
 */
export function wilsonLowerBound(
  failures: number,
  n: number,
  z: number = MEASURED_FAILURE_CFG.z,
): number {
  if (n <= 0) return 0;
  const p = failures / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (centre - margin) / denom;
  return lower < 0 ? 0 : lower;
}

/** One axis's numbers. Same statistic, different vocabulary. */
export interface FailureAxisVerdict {
  /** Observed failure rate in-window on this axis. */
  rate: number;
  /** 95% lower confidence bound on that rate — what the gate tests. */
  lowerBound: number;
  /** Attempts backing this axis. */
  n: number;
  /** Failures on this axis. */
  nFail: number;
  /** Whether this axis on its own clears the bar. */
  gated: boolean;
}

export interface MeasuredFailureVerdict {
  /** Whether a measured-failure gate fires for this tuple, on EITHER axis. */
  gated: boolean;
  /**
   * alpha.98 — which axis fired. Undefined when `gated` is false. Read this
   * before rendering `rate`/`n`: the same number means "answered badly" on
   * one axis and "could not be reached" on the other, and the fixes differ.
   * When both axes fire, `'quality'` wins the label — the model is reachable
   * enough to have been judged, so its answers are the actionable half.
   */
  axis?: 'quality' | 'availability';
  /**
   * The numbers that JUSTIFY the gate — i.e. drawn from `axis` when gated,
   * and from the quality axis otherwise. Deliberately not always-quality:
   * a consumer printing "gated: 0% over 16" for a model that 429'd 42 times
   * would be reporting a true number as an explanation of the wrong thing.
   */
  rate: number;
  lowerBound: number;
  n: number;
  nFail: number;
  /** Both axes, always present, so a caller never has to infer one. */
  quality: FailureAxisVerdict;
  availability: FailureAxisVerdict;
  /** Failures in neither vocabulary. Not gated on; surfaced for visibility. */
  nUnclassified: number;
}

/**
 * alpha.78 — public row normalizer (PB 2026-07-25 trap): the counts
 * endpoint speaks snake_case (`intent_archetype`, `n_fail`) and this module
 * speaks camelCase. A consumer reproducing a gate decision by hand from the
 * endpoint previously got a silent `gated: false` — `wilsonLowerBound(
 * undefined, 13)` returns a clean 0 rather than throwing. Exported so the
 * bridge exists exactly once.
 */
export function mapMeasuredFailureRows(rows: unknown[]): SurfaceFailureRow[] {
  return mapRows(rows);
}

/**
 * Pure decision, exported for tests and for the advisory text. Separated
 * from the I/O so the policy can be exercised without a brain.
 *
 * alpha.78 — accepts BOTH row shapes: the module's camelCase
 * `SurfaceFailureRow` and the counts endpoint's raw snake_case row. A
 * snake_case row previously slipped through the type system (all fields
 * `undefined`) and judged `gated: false` silently.
 */
export function judgeMeasuredFailure(
  row:
    | SurfaceFailureRow
    | {
        intent_archetype: string;
        model: string;
        n: number | string;
        n_fail: number | string;
        n_attempted?: number | string;
        n_unavailable?: number | string;
        n_unclassified?: number | string;
      }
    | undefined,
  cfg: typeof MEASURED_FAILURE_CFG = MEASURED_FAILURE_CFG,
): MeasuredFailureVerdict | undefined {
  if (!row) return undefined;
  // alpha.98 — the camelCase fast path bypasses mapRows, so it must fill the
  // availability defaults itself or they arrive `undefined` and every
  // comparison against them is silently false. Same shape as the alpha.78
  // snake_case trap this branch was added to fix: a partially-populated row
  // does not fail, it decides wrongly and quietly.
  const raw: SurfaceFailureRow | undefined =
    'nFail' in row && typeof row.n === 'number'
      ? (row as SurfaceFailureRow)
      : mapRows([row])[0];
  if (!raw) return undefined;
  const normalized: SurfaceFailureRow = {
    ...raw,
    nAttempted: typeof raw.nAttempted === 'number' ? raw.nAttempted : raw.n,
    nUnavailable: typeof raw.nUnavailable === 'number' ? raw.nUnavailable : 0,
    nUnclassified: typeof raw.nUnclassified === 'number' ? raw.nUnclassified : 0,
  };

  const quality = judgeAxis(
    normalized.nFail,
    normalized.n,
    cfg.minSample,
    cfg.lowerBoundThreshold,
    cfg.z,
  );
  const availability = judgeAxis(
    normalized.nUnavailable,
    normalized.nAttempted,
    cfg.availability.minSample,
    cfg.availability.lowerBoundThreshold,
    cfg.availability.z,
  );

  // Neither axis has enough evidence to say anything — same "no verdict"
  // the pre-alpha.98 gate returned for a thin sample.
  if (normalized.n < cfg.minSample && normalized.nAttempted < cfg.availability.minSample) {
    return undefined;
  }

  const axis: 'quality' | 'availability' | undefined = quality.gated
    ? 'quality'
    : availability.gated
      ? 'availability'
      : undefined;
  const lead = axis === 'availability' ? availability : quality;

  return {
    gated: quality.gated || availability.gated,
    axis,
    rate: lead.rate,
    lowerBound: lead.lowerBound,
    n: lead.n,
    nFail: lead.nFail,
    quality,
    availability,
    nUnclassified: normalized.nUnclassified,
  };
}

/**
 * One axis, evaluated. A denominator below `minSample` yields a real,
 * non-gated verdict carrying its (small) numbers rather than nothing —
 * the caller needs to be able to say "measured, not enough" distinctly
 * from "not measured".
 */
function judgeAxis(
  failures: number,
  n: number,
  minSample: number,
  threshold: number,
  z: number,
): FailureAxisVerdict {
  const lowerBound = wilsonLowerBound(failures, n, z);
  return {
    rate: n > 0 ? failures / n : 0,
    lowerBound,
    n,
    nFail: failures,
    gated: n >= minSample && lowerBound > threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SWR cache (mirrors promotions-brain)
// ─────────────────────────────────────────────────────────────────────────

interface AppSnapshot {
  data: SurfaceFailureRow[];
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
export function measuredFailureFreshness(appId: string): 'cold' | 'warm' {
  return snapshots.get(appId)?.loaded ? 'warm' : 'cold';
}

export interface MeasuredFailureRuntime {
  /** Endpoint base URL. The library appends `?app_id=<id>`. */
  endpoint: string;
  /** Stale-while-revalidate window in ms. */
  ttlMs: number;
  fetchImpl: typeof fetch;
  onError?: (err: unknown) => void;
}

let runtime: MeasuredFailureRuntime | undefined;
let warnedOnce = false;

/** Default endpoint on the kgauto-dashboard. Mirrors the promotions convention. */
export const DEFAULT_MEASURED_FAILURE_ENDPOINT =
  'https://kgauto-dashboard.vercel.app/api/kgauto-v2/measured-failure';

/**
 * Opt-out env switch. UNLIKE auto-promote this defaults ON wherever the
 * brain is configured, because the gate is protective: it only ever
 * de-ranks a model the consumer's OWN traffic shows to be failing them, and
 * the failure is already being paid for. Set `KGAUTO_MEASURED_FAILURE_GATE=0`
 * (or 'false') to disable.
 */
export function isMeasuredFailureGateEnabledFromEnv(
  envSource?: Record<string, string | undefined>,
): boolean {
  const env =
    envSource ??
    (typeof process !== 'undefined' && process.env ? process.env : {});
  const raw = (env.KGAUTO_MEASURED_FAILURE_GATE ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

export function configureMeasuredFailureBrain(
  rt: MeasuredFailureRuntime | undefined,
): void {
  runtime = rt;
  snapshots.clear();
  warnedOnce = false;
}

export function isMeasuredFailureBrainActive(): boolean {
  return runtime !== undefined;
}

export interface GetMeasuredFailureOpts {
  appId: string;
  archetype: IntentArchetypeName | string;
  model: string;
}

/**
 * alpha.73 — start the warm-up WITHOUT needing a compile to trigger it.
 *
 * The SWR posture below ("cold start returns undefined and warms in the
 * background") is right for a long-lived process and wrong for a
 * short-lived isolate, where the first compile IS most compiles. Measured on
 * playbacksam: on a cold isolate the gate was absent, `claude-haiku-4-5` led,
 * cliffed, was same-model retried and fell over to gemini — two billed
 * inferences and ~27–34s, every time an isolate is new. PB has ~1 user, so
 * its isolates are cold most of the time, which inverts the usual severity
 * ordering: this hits the LOWEST-traffic consumers hardest, and they are the
 * ones least able to absorb it.
 *
 * Kicking the fetch off at `configureBrain()` moves the refresh into the time
 * the isolate spends on everything else it does before its first compile.
 * Fire-and-forget and non-blocking: on its own this narrows the window rather
 * than closing it, which is why `awaitMeasuredFailureReady()` exists too.
 *
 * Returns the in-flight promise (or undefined when not configured / already
 * fresh) so a caller can await it. NEVER throws.
 */
export function prefetchMeasuredFailure(appId: string): Promise<void> | undefined {
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
 * alpha.73 — bounded await on the warm-up, for async callers only.
 *
 * `compile()` is synchronous and must stay so, so it cannot block on a fetch;
 * `call()` is async and is about to spend seconds on an inference, which makes
 * a few hundred milliseconds here a trivially good trade against the ~27–34s
 * and second billed inference a cold-blind gate costs.
 *
 * Deliberately bounded and deliberately silent on timeout: the gate is
 * protective, never required. If the brain is slow or down, the caller
 * proceeds un-gated exactly as it does today — this can delay a call by at
 * most `timeoutMs`, and can never fail one.
 *
 * NEVER throws.
 */
export async function awaitMeasuredFailureReady(
  appId: string,
  timeoutMs: number,
): Promise<void> {
  if (!runtime || !appId) return;
  // Kick the refresh BEFORE honouring the budget. A zero budget means "do not
  // make me wait", not "do not warm up" — skipping the prefetch here would
  // make the documented opt-out silently disable the gate for the whole
  // isolate rather than just this call. (Caught by its own test: an opt-out
  // that withholds more than it says it does is the same shape as a
  // noise-suppression fix that creates silence.)
  const pending = prefetchMeasuredFailure(appId) ?? pendingRefreshes.get(appId);
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
    // doRefresh swallows its own errors; this is belt-and-braces.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sync reader. Returns the verdict for `(appId, archetype, model)` or
 * undefined (not configured / cold / below minSample / brain down).
 *
 * NEVER throws. Cold start returns undefined and warms in the background —
 * same posture as every other brain-driven lever in compile(). Async callers
 * that can afford a bounded wait should call `awaitMeasuredFailureReady()`
 * first; `call()` does.
 */
export function getMeasuredFailureVerdict(
  opts: GetMeasuredFailureOpts,
): MeasuredFailureVerdict | undefined {
  const rt = runtime;
  if (!rt) return undefined;
  const { appId, archetype, model } = opts;
  if (!appId || !archetype || !model) return undefined;

  let snap = snapshots.get(appId);
  if (!snap) {
    snap = { data: [], expiresAt: 0, refreshing: false };
    snapshots.set(appId, snap);
  }

  const now = Date.now();
  if (snap.expiresAt <= now && !snap.refreshing) {
    snap.refreshing = true;
    void asyncRefresh(rt, appId);
  }

  const row = snap.data.find(
    (r) => r.archetype === archetype && r.model === model,
  );
  return judgeMeasuredFailure(row);
}

let pendingRefreshes = new Map<string, Promise<void>>();

async function asyncRefresh(
  rt: MeasuredFailureRuntime,
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
  rt: MeasuredFailureRuntime,
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
      throw new Error(`measured-failure ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (runtime !== rt) return;
    snap.data = Array.isArray(body) ? mapRows(body) : [];
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
    '[kgauto] measured-failure fetch failed (gate inactive until next refresh):',
    err,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

export function _testResetMeasuredFailure(): void {
  runtime = undefined;
  snapshots.clear();
  pendingRefreshes = new Map();
  warnedOnce = false;
}

export async function _testWaitForMeasuredFailureRefresh(): Promise<void> {
  const pending = Array.from(pendingRefreshes.values());
  if (pending.length > 0) await Promise.all(pending);
}
