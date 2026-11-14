/**
 * advisories-api — structured advisories API (alpha.29 Workstream B).
 *
 * Closes the L-117 family bottleneck: kgauto's `result.advisories[]` (the
 * compile-time warnings about caching-off, tool-bloat, archetype-perf-floor
 * breaches, etc.) used to disappear after the consumer read the compile
 * result. The s34 caching-off advisory pattern is the canonical failure: an
 * advisory fired 100+ times in 24h on `generate::sonnet` at 99.4% empty
 * rate, and nobody knew because there was no structured channel to surface
 * "what's open right now?"
 *
 * Migration 020 ships the substrate: `compile_outcome_advisories` gains
 * lifecycle columns (`resolved_at`, `resolution_source`, `resolution_note`)
 * and the `actionable_advisories_v` view rolls per-firing rows into
 * per-(app_id, code) tuples with deterministic stable ids + server-side
 * auto-resolution.
 *
 * Public surface:
 *   getActionableAdvisories({ appId, severity?, status?, brainEndpoint, brainJwt, brainAnonKey, fetch? })
 *     → Promise<ActionableAdvisory[]>
 *
 *   markAdvisoryResolved({ id, resolutionNote?, brainEndpoint, brainJwt, brainAnonKey, fetch? })
 *     → Promise<{ ok: true } | { ok: false; reason: string }>
 *
 * Both functions are pure I/O — no module-level state. The fetch wiring
 * mirrors `createProxyHandler` in `glassbox-routes/proxy.ts`: scoped JWT in
 * `Authorization: Bearer`, `apikey` header carries the anon key.
 *
 * The auto-resolution rule is enforced server-side in `actionable_advisories_v`:
 *   • Latest firing > 14 days ago             → status='resolved' (auto-pruned)
 *   • All firings have resolved_at set        → status='resolved' (consumer-marked)
 *   • Otherwise                               → status='open'
 *
 * `markAdvisoryResolved` is the consumer override: "I fixed it; the next
 * firing will reopen the rule, but until then it stays resolved."
 */

import type { IntentArchetypeName } from './dialect.js';
import { readBrainReadEnv } from './env.js';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Severity of an advisory. Maps to the `level` column on
 * `compile_outcome_advisories` (info | warn | critical).
 */
export type AdvisorySeverity = 'info' | 'warn' | 'critical';

/**
 * Status of an advisory rollup.
 *
 * - `open` — at least one unresolved firing in the last 14 days
 * - `resolved` — either auto-pruned (no firings >14d) or consumer-marked
 * - `snoozed` — reserved for alpha.30+ (snooze-until-date); type-accepted
 *   today but the view will never emit this value
 */
export type AdvisoryStatus = 'open' | 'snoozed' | 'resolved';

/**
 * Source of resolution when status='resolved'.
 *
 * - `auto` — server-side rule auto-pruned (>14d since last firing)
 * - `consumer-marked` — consumer called `markAdvisoryResolved`
 * - `declined` — reserved (alpha.30+: consumer marked the suggestion
 *   inapplicable; the advisor will still fire but UIs can hide it)
 */
export type AdvisoryResolutionSource = 'auto' | 'consumer-marked' | 'declined';

/**
 * Suggested-fix metadata. `null` when the advisor has no actionable fix
 * (info-level rules can be observational). When set, the consumer's
 * Admin UI can render a one-click apply (alpha.30+) or surface the
 * before/after diff inline.
 */
export interface AdvisorySuggestedFix {
  type: 'config-change' | 'one-liner' | 'env-var' | 'manual';
  /** File:line hint if kgauto can infer (reserved — alpha.30+). */
  siteHint?: string;
  before?: string;
  after?: string;
  docsLink?: string;
}

/**
 * Per-(app_id, code) advisory rollup. The `id` is stable across polls
 * until the rule auto-resolves and re-opens (a new firing after the 14d
 * boundary advances `opened_at` → new id). Treat id-changes as
 * intentional "fresh re-open" signals.
 *
 * Wire-shape from `actionable_advisories_v`. The transformer maps the
 * view's snake_case columns to camelCase. See `feedback_typed_boundary_transformers.md`
 * (L-118) for the rationale.
 */
/**
 * The window of evidence a finding was computed from — migration 054.
 *
 * READ THE DISTINCTION BEFORE USING THIS. It is NOT `openedAt` /
 * `lastObservedAt` / `observationCount`, which describe the ADVISORY (how
 * long it has been firing, how many times the watcher ran and still saw the
 * condition). This describes what the generator LOOKED AT.
 *
 * A daily cron that keeps firing on a single 29-second burst reports
 * `observationCount: 11` spanning 11 days — the most standing-looking of
 * standing conditions — while its evidence is one event from 11 days ago.
 * Separating the two is the entire point.
 *
 * `null` when the generator did not state its window. Honest unknown; it
 * must never be read as "not a burst". Compile-time library rules carry
 * null legitimately — they fire on ONE call, so their evidence is the call
 * in hand and there is no window to state.
 */
export interface AdvisoryEvidenceWindow {
  firstAt: string;
  lastAt: string;
  n: number;
  /** `lastAt - firstAt`, precomputed so no caller re-derives it wrong. */
  spanMs: number;
  /**
   * `true` when the evidence is clustered tightly enough to be ONE EVENT
   * rather than a standing rate. See `classifyEvidenceWindow`.
   */
  isBurst: boolean;
}

/**
 * Burst-vs-rate, computed rather than judged.
 *
 * Origin: tt-intel s118. A cost query showed `claude-sonnet-5` at 30% of
 * their `ask` traffic and 80% of ask spend. Every number true, every
 * mechanism check correct, and every correct check made them more certain
 * the spend gate had regressed. All eleven calls sat in a 29-second window —
 * their own prior experiment, fixed six minutes after the last one. Their
 * formulation: **a cluster is an event, not a rate.**
 *
 * The rule, deliberately crude because a subtle one would need tuning per
 * rule and would then be wrong per rule: evidence is a burst when it spans
 * less than `BURST_SPAN_MS` (5 minutes). Multiple observations inside five
 * minutes are one incident — a deploy, a retry storm, a test run, a
 * benchmark — not a pattern of behavior over time.
 *
 * Two deliberate non-features:
 *
 * - **n is not in the test.** Two rows 4 minutes apart are as much a single
 *   event as eleven are. Requiring a minimum n would let the smallest, least
 *   evidenced findings skip the check.
 * - **It does not try to detect fossils.** A burst is not necessarily stale;
 *   it is merely not a rate. Only the consumer's own deploy log can turn
 *   "one event" into "an event we already fixed", and this library cannot
 *   see that. Claiming otherwise would be the same over-reach the rule
 *   exists to correct.
 */
export const BURST_SPAN_MS = 5 * 60 * 1000;

export function classifyEvidenceWindow(row: {
  evidence_first_at?: string | null;
  evidence_last_at?: string | null;
  evidence_n?: number | null;
}): AdvisoryEvidenceWindow | null {
  const { evidence_first_at: first, evidence_last_at: last, evidence_n: n } = row;
  if (typeof first !== 'string' || typeof last !== 'string') return null;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const t0 = Date.parse(first);
  const t1 = Date.parse(last);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  // Clamp rather than emit a negative span: out-of-order timestamps are a
  // generator bug, and a negative span would silently read as a tight burst.
  const spanMs = Math.max(0, t1 - t0);
  return { firstAt: first, lastAt: last, n, spanMs, isBurst: spanMs < BURST_SPAN_MS };
}

/** Human-readable span for advisory text. Terse by design — it sits inline. */
export function formatEvidenceSpan(spanMs: number): string {
  if (spanMs < 1000) return `${spanMs}ms`;
  const s = Math.round(spanMs / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The sentence that travels with a burst-shaped finding. Written to be
 * usable verbatim in advisory text, and to say what the library CAN claim
 * (one event) rather than what it cannot (that the event is stale).
 */
export function burstCaveat(w: AdvisoryEvidenceWindow): string {
  return (
    `Evidence is ${w.n} observation${w.n === 1 ? '' : 's'} spanning ` +
    `${formatEvidenceSpan(w.spanMs)} (${w.firstAt} → ${w.lastAt}) — that is a ` +
    `single burst, not a standing rate. Check it against your own deploy log ` +
    `before acting: a cluster this tight is usually one incident, and may ` +
    `already be fixed.`
  );
}

export interface ActionableAdvisory {
  id: string;
  rule: string;
  severity: AdvisorySeverity;
  openedAt: string;
  lastObservedAt: string;
  observationCount: number;
  /**
   * Migration 054. `null` when the generator did not state a window — an
   * honest unknown, NOT an assertion that the evidence is well-spread.
   */
  evidenceWindow: AdvisoryEvidenceWindow | null;
  /**
   * The severity the rule ASKED for, present only when this advisory's
   * effective `severity` was downgraded because its evidence is burst-shaped.
   * Kept so a consumer can see the downgrade happened rather than silently
   * receiving a quieter advisory than the generator wrote.
   */
  severityBeforeBurstDowngrade?: AdvisorySeverity;
  appliesTo: {
    archetype?: IntentArchetypeName;
    model?: string;
    callSiteHint?: string;
  };
  message: string;
  suggestedFix: AdvisorySuggestedFix | null;
  /** Reserved — always `false` in alpha.29. alpha.30+ ships actual auto-apply. */
  autoApplicable: boolean;
  status: AdvisoryStatus;
  resolvedAt?: string;
  resolutionSource?: AdvisoryResolutionSource;
  resolutionNote?: string;
}

/**
 * Filter + transport for `getActionableAdvisories`. The brain JWT must
 * carry an `app_id` claim matching `opts.appId` — RLS enforces tenant
 * isolation on the underlying table, so a mismatch silently returns [].
 */
export interface GetActionableAdvisoriesOptions {
  appId: string;
  /** Severity filter; if omitted, all severities are returned. */
  severity?: AdvisorySeverity;
  /** Status filter; defaults to 'open'. Pass 'all' for the full set. */
  status?: 'open' | 'snoozed' | 'resolved' | 'all';
  /**
   * alpha.78 (PB adoption-gap ask 2): the trio now DEFAULTS from
   * `readBrainReadEnv()` when omitted, so a consumer that passes nothing
   * gets correct behavior from the canonical env names instead of a
   * self-authored config error. Explicit values still win.
   */
  brainEndpoint?: string;
  brainJwt?: string;
  brainAnonKey?: string;
  fetch?: typeof fetch;
}

export interface MarkAdvisoryResolvedOptions {
  /** Stable id from a prior `getActionableAdvisories` call. */
  id: string;
  resolutionNote?: string;
  /**
   * alpha.78 (PB adoption-gap ask 2): the trio now DEFAULTS from
   * `readBrainReadEnv()` when omitted, so a consumer that passes nothing
   * gets correct behavior from the canonical env names instead of a
   * self-authored config error. Explicit values still win.
   */
  brainEndpoint?: string;
  brainJwt?: string;
  brainAnonKey?: string;
  fetch?: typeof fetch;
}

// ─────────────────────────────────────────────────────────────────────────
// Typed boundary transformer (L-118): view row → ActionableAdvisory
// ─────────────────────────────────────────────────────────────────────────

const SEVERITY_SET = new Set<AdvisorySeverity>(['info', 'warn', 'critical']);
const STATUS_SET = new Set<AdvisoryStatus>(['open', 'snoozed', 'resolved']);
const RESOLUTION_SOURCE_SET = new Set<AdvisoryResolutionSource>([
  'auto',
  'consumer-marked',
  'declined',
]);

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asSeverity(v: unknown): AdvisorySeverity {
  if (typeof v === 'string' && SEVERITY_SET.has(v as AdvisorySeverity)) {
    return v as AdvisorySeverity;
  }
  // View should always emit a valid value; defensive fallback keeps the
  // type contract honest if the view ever drifts.
  return 'info';
}

function asStatus(v: unknown): AdvisoryStatus {
  if (typeof v === 'string' && STATUS_SET.has(v as AdvisoryStatus)) {
    return v as AdvisoryStatus;
  }
  return 'open';
}

function asResolutionSource(v: unknown): AdvisoryResolutionSource | undefined {
  if (
    typeof v === 'string' &&
    RESOLUTION_SOURCE_SET.has(v as AdvisoryResolutionSource)
  ) {
    return v as AdvisoryResolutionSource;
  }
  return undefined;
}

/**
 * Map a single `actionable_advisories_v` row (snake_case, Postgres
 * native) to the public `ActionableAdvisory` shape (camelCase). Single
 * canonical mapping site for this boundary (L-118).
 */
export function rowToAdvisory(row: Record<string, unknown>): ActionableAdvisory {
  const archetype = asString(row.applies_to_archetype) as
    | IntentArchetypeName
    | undefined;
  const model = asString(row.applies_to_model);

  const docsLink = asString(row.docs_url);
  const suggestion = asString(row.suggestion);
  // suggestedFix: alpha.29 only surfaces the docs link + manual fallback.
  // Future enhancements (siteHint, before/after diff) extend this shape;
  // null when the advisory carries no actionable hint at all.
  let suggestedFix: AdvisorySuggestedFix | null = null;
  if (docsLink || suggestion) {
    suggestedFix = { type: 'manual' };
    if (docsLink) suggestedFix.docsLink = docsLink;
    if (suggestion) suggestedFix.before = suggestion;
  }

  const evidenceWindow = classifyEvidenceWindow(
    row as {
      evidence_first_at?: string | null;
      evidence_last_at?: string | null;
      evidence_n?: number | null;
    },
  );

  // Burst-shaped evidence downgrades the advisory's own severity.
  //
  // The reasoning, stated because a self-downgrading severity is the kind of
  // thing that looks obviously right to its author and reads as evasive to
  // the reader (tt-intel was explicitly invited to push back on it): a
  // `critical` whose evidence is one 29-second cluster produces exactly the
  // failure it is supposed to prevent — an operator drops what they are
  // doing for an incident that may already be closed. The finding is not
  // wrong and is NOT suppressed; it stays visible, one level quieter, with
  // the window printed so the reader can overrule in a glance.
  //
  // Two guardrails against this becoming a silencer:
  //   - it never goes below 'warn', so a burst-shaped critical still
  //     outranks routine info and cannot vanish into the noise floor;
  //   - the original severity is preserved on the result, so a downgrade is
  //     always visible as a downgrade rather than as a quiet advisory.
  const declaredSeverity = asSeverity(row.severity);
  const downgraded =
    evidenceWindow?.isBurst === true && declaredSeverity === 'critical';
  const effectiveSeverity: AdvisorySeverity = downgraded ? 'warn' : declaredSeverity;

  const out: ActionableAdvisory = {
    id: typeof row.id === 'string' ? row.id : '',
    rule: typeof row.rule === 'string' ? row.rule : '',
    severity: effectiveSeverity,
    evidenceWindow,
    ...(downgraded ? { severityBeforeBurstDowngrade: declaredSeverity } : {}),
    openedAt: typeof row.opened_at === 'string' ? row.opened_at : '',
    lastObservedAt:
      typeof row.last_observed_at === 'string' ? row.last_observed_at : '',
    observationCount:
      typeof row.observation_count === 'number'
        ? row.observation_count
        : 0,
    appliesTo: {
      ...(archetype ? { archetype } : {}),
      ...(model ? { model } : {}),
    },
    // The caveat goes INLINE in the message, not only in `evidenceWindow`.
    // A structured field a consumer must think to read is the same defect
    // one layer along: the substrate knowing and not telling. The whole
    // point is that the check costs a glance rather than a query.
    message:
      (typeof row.message === 'string' ? row.message : '') +
      (evidenceWindow?.isBurst ? `\n\n${burstCaveat(evidenceWindow)}` : ''),
    suggestedFix,
    autoApplicable: false, // reserved — alpha.30+
    status: asStatus(row.status),
  };

  const resolvedAt = asString(row.resolved_at);
  if (resolvedAt) out.resolvedAt = resolvedAt;

  const resolutionSource = asResolutionSource(row.resolution_source);
  if (resolutionSource) out.resolutionSource = resolutionSource;

  const resolutionNote = asString(row.resolution_note);
  if (resolutionNote) out.resolutionNote = resolutionNote;

  return out;
}

/** @internal — exported for the alpha.29 test suite. Do not import in consumers. */
export const _internal = { rowToAdvisory };

// ─────────────────────────────────────────────────────────────────────────
// HTTP wiring
// ─────────────────────────────────────────────────────────────────────────

function resolveFetch(injected: typeof fetch | undefined): typeof fetch {
  return injected ?? ((...args) => globalThis.fetch(...args));
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.78 — resolve the brain-read trio from explicit options, falling back
 * to `readBrainReadEnv()` (canonical names + documented fallbacks). Returns
 * the missing canonical names when neither source satisfies a field.
 */
function resolveBrainReadTrio(opts: {
  brainEndpoint?: string;
  brainJwt?: string;
  brainAnonKey?: string;
}):
  | { ok: true; brainEndpoint: string; brainJwt: string; brainAnonKey: string }
  | { ok: false; missingEnv: string[] } {
  const env = readBrainReadEnv();
  const brainEndpoint = opts.brainEndpoint ?? env.endpoint;
  const brainJwt = opts.brainJwt ?? env.jwt;
  const brainAnonKey = opts.brainAnonKey ?? env.anonKey;
  if (brainEndpoint && brainJwt && brainAnonKey) {
    return { ok: true, brainEndpoint, brainJwt, brainAnonKey };
  }
  const missingEnv: string[] = [];
  if (!brainEndpoint) missingEnv.push('KGAUTO_V2_BRAIN_SUPABASE_URL');
  if (!brainJwt) missingEnv.push('KGAUTO_V2_BRAIN_JWT');
  if (!brainAnonKey) missingEnv.push('KGAUTO_V2_BRAIN_ANON_KEY');
  return { ok: false, missingEnv };
}

/**
 * Query the open advisory set for an app. Pulls from
 * `actionable_advisories_v` (per-(app_id, code) rollup with stable ids
 * + server-side auto-resolution).
 *
 * Default behavior (no status filter): returns only `status='open'`.
 * Pass `status: 'all'` to see resolved + open together — useful for
 * Admin UIs that show "recently fixed" badges.
 *
 * Fetch failures bubble out as thrown Errors. (`markAdvisoryResolved`
 * uses the ok/reason envelope; this read path throws to match
 * existing kgauto query semantics where the consumer can decide to
 * retry or render an error state.)
 */
export async function getActionableAdvisories(
  opts: GetActionableAdvisoriesOptions,
): Promise<ActionableAdvisory[]> {
  const { appId, severity, status, fetch: injectedFetch } = opts;

  if (!appId) {
    throw new Error('getActionableAdvisories: appId is required');
  }

  const trio = resolveBrainReadTrio(opts);
  if (!trio.ok) {
    throw new Error(
      `getActionableAdvisories: brain-read-not-configured — missing ${trio.missingEnv.join(', ')} ` +
        '(pass brainEndpoint/brainJwt/brainAnonKey explicitly or set the canonical env vars)',
    );
  }
  const { brainEndpoint, brainJwt, brainAnonKey } = trio;

  const doFetch = resolveFetch(injectedFetch);
  const base = normalizeEndpoint(brainEndpoint);

  const qs = new URLSearchParams();
  qs.set('app_id', `eq.${appId}`);
  if (severity) qs.set('severity', `eq.${severity}`);
  const effectiveStatus = status ?? 'open';
  if (effectiveStatus !== 'all') {
    qs.set('status', `eq.${effectiveStatus}`);
  }
  qs.set('order', 'last_observed_at.desc');

  const url = `${base}/rest/v1/actionable_advisories_v?${qs.toString()}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // Network-level failure (DNS, refused, abort, etc.). Surface the
    // original message so the consumer can distinguish from auth/5xx.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`getActionableAdvisories: network error: ${msg}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('getActionableAdvisories: brain auth misconfig');
  }
  if (res.status >= 500) {
    throw new Error(`getActionableAdvisories: brain unavailable (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`getActionableAdvisories: bad request (${res.status})`);
  }

  let rows: unknown;
  try {
    rows = await res.json();
  } catch {
    throw new Error('getActionableAdvisories: malformed brain response');
  }

  if (!Array.isArray(rows)) {
    // PostgREST returns [] for empty result sets; a non-array response
    // means the contract drifted. Fail loud.
    throw new Error('getActionableAdvisories: expected array from brain');
  }

  const out: ActionableAdvisory[] = [];
  for (const raw of rows) {
    if (raw && typeof raw === 'object') {
      out.push(rowToAdvisory(raw as Record<string, unknown>));
    }
  }
  return out;
}

/**
 * Mark an advisory as consumer-resolved.
 *
 * Lookup strategy:
 *   1. Query `actionable_advisories_v?id=eq.<id>` to find the (app_id, code)
 *      tuple for this advisory.
 *   2. PATCH EVERY unresolved firing in `compile_outcome_advisories`
 *      matching that tuple via the underlying outcome's app_id. (One call
 *      closes the whole rollup — the alpha.71-era docblock said "latest
 *      firing", which was never what the code did; corrected alpha.78.)
 *
 * The (app_id, code) lookup is necessary because `compile_outcome_advisories`
 * has no `app_id` column — it inherits scope via the FK to compile_outcomes.
 * PostgREST cannot PATCH with a JOIN predicate, so the markAdvisoryResolved
 * path is a two-step round-trip. The cost is one extra GET per resolve call;
 * acceptable because marks are low-frequency operator actions, not per-call
 * hot path.
 *
 * alpha.78 envelope (PB `resolve-envelope-cannot-close-a-rollup`, 2026-07-25):
 * the return now reports WHAT HAPPENED, not that the request was received —
 * `firingsResolved` is the count of rows this call actually flipped, and
 * `status` is the rollup's state after the write. PB measured the old
 * `ok: true` live against prod: the PATCH was being RLS-filtered to zero
 * rows (consumer JWTs had read-grant but no update-grant — migration 049
 * adds it) and the envelope reported success anyway. "When an API can
 * succeed without doing anything, the return value should distinguish those
 * cases" — this is that distinction. `firingsResolved: 0, status: 'open'`
 * on a rollup you expected to close now points at the write grant.
 *
 * Idempotent re-marks stay ok: an already-resolved advisory returns
 * `{ ok: true, firingsResolved: 0, status: 'resolved' }`.
 *
 * Returns ok/reason envelope (vs throwing) because consumer Admin UIs
 * typically want to render the failure inline rather than crash.
 */
export async function markAdvisoryResolved(
  opts: MarkAdvisoryResolvedOptions,
): Promise<
  | { ok: true; firingsResolved: number; status: 'open' | 'resolved' | 'unknown' }
  | { ok: false; reason: string }
> {
  const { id, resolutionNote, fetch: injectedFetch } = opts;

  if (!id) {
    return { ok: false, reason: 'id_required' };
  }

  const trio = resolveBrainReadTrio(opts);
  if (!trio.ok) {
    return { ok: false, reason: `brain_read_not_configured:${trio.missingEnv.join(',')}` };
  }
  const { brainEndpoint, brainJwt, brainAnonKey } = trio;

  const doFetch = resolveFetch(injectedFetch);
  const base = normalizeEndpoint(brainEndpoint);

  // Step 1: look up (app_id, code) tuple via the view.
  const lookupUrl = `${base}/rest/v1/actionable_advisories_v?id=eq.${encodeURIComponent(id)}&select=app_id,rule`;

  let lookupRes: Response;
  try {
    lookupRes = await doFetch(lookupUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network_error:${msg}` };
  }

  if (lookupRes.status === 401 || lookupRes.status === 403) {
    return { ok: false, reason: 'brain_auth_misconfig' };
  }
  if (lookupRes.status >= 500) {
    return { ok: false, reason: 'brain_unavailable' };
  }
  if (!lookupRes.ok) {
    return { ok: false, reason: `brain_lookup_failed:${lookupRes.status}` };
  }

  let lookupRows: unknown;
  try {
    lookupRows = await lookupRes.json();
  } catch {
    return { ok: false, reason: 'brain_lookup_malformed' };
  }

  if (!Array.isArray(lookupRows) || lookupRows.length === 0) {
    return { ok: false, reason: 'advisory_not_found' };
  }
  const tuple = lookupRows[0] as { app_id?: unknown; rule?: unknown };
  const appId = typeof tuple.app_id === 'string' ? tuple.app_id : '';
  const code = typeof tuple.rule === 'string' ? tuple.rule : '';
  if (!appId || !code) {
    return { ok: false, reason: 'advisory_tuple_invalid' };
  }

  // Step 2: PATCH every unresolved firing for this (app_id, code) tuple.
  // PostgREST doesn't support PATCH with a JOIN, so we look up the
  // outcome_ids first, then PATCH where outcome_id IN (...).
  const outcomesUrl =
    `${base}/rest/v1/compile_outcomes` +
    `?app_id=eq.${encodeURIComponent(appId)}&select=id`;

  let outcomesRes: Response;
  try {
    outcomesRes = await doFetch(outcomesUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network_error:${msg}` };
  }

  if (outcomesRes.status === 401 || outcomesRes.status === 403) {
    return { ok: false, reason: 'brain_auth_misconfig' };
  }
  if (outcomesRes.status >= 500) {
    return { ok: false, reason: 'brain_unavailable' };
  }
  if (!outcomesRes.ok) {
    return { ok: false, reason: `brain_lookup_failed:${outcomesRes.status}` };
  }

  let outcomeRows: unknown;
  try {
    outcomeRows = await outcomesRes.json();
  } catch {
    return { ok: false, reason: 'brain_lookup_malformed' };
  }

  if (!Array.isArray(outcomeRows)) {
    return { ok: false, reason: 'brain_lookup_malformed' };
  }

  const outcomeIds: number[] = [];
  for (const row of outcomeRows) {
    if (row && typeof row === 'object') {
      const idVal = (row as { id?: unknown }).id;
      if (typeof idVal === 'number' && Number.isFinite(idVal)) {
        outcomeIds.push(idVal);
      }
    }
  }

  if (outcomeIds.length === 0) {
    // No outcomes for this app_id → no firings to mark. The advisory
    // exists in the view's universe but the lookup race lost (rows
    // possibly deleted concurrently). Idempotent: treat as resolved.
    return { ok: true, firingsResolved: 0, status: 'unknown' };
  }

  // PostgREST `in.(...)` filter expects a comma-separated list, no spaces.
  const inList = outcomeIds.join(',');

  const patchUrl =
    `${base}/rest/v1/compile_outcome_advisories` +
    `?outcome_id=in.(${inList})` +
    `&code=eq.${encodeURIComponent(code)}` +
    `&resolved_at=is.null`;

  const patchBody: Record<string, unknown> = {
    resolved_at: new Date().toISOString(),
    resolution_source: 'consumer-marked',
  };
  if (resolutionNote !== undefined) {
    patchBody.resolution_note = resolutionNote;
  }

  let patchRes: Response;
  try {
    patchRes = await doFetch(patchUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // alpha.78 — count what actually changed. An RLS-filtered PATCH
        // returns 2xx with zero rows; return=representation makes that
        // visible instead of success-shaped.
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network_error:${msg}` };
  }

  if (patchRes.status === 401 || patchRes.status === 403) {
    return { ok: false, reason: 'brain_auth_misconfig' };
  }
  if (patchRes.status >= 500) {
    return { ok: false, reason: 'brain_unavailable' };
  }
  if (!patchRes.ok) {
    return { ok: false, reason: `patch_failed:${patchRes.status}` };
  }

  let patchedRows: unknown = [];
  try {
    patchedRows = await patchRes.json();
  } catch {
    // 204 / empty body — treat as zero visible rows; the status re-read
    // below still reports the truth.
  }
  const firingsResolved = Array.isArray(patchedRows) ? patchedRows.length : 0;

  // Re-read the rollup so the caller learns the post-write state instead of
  // re-deriving it (PB's route hand-rolled exactly this re-read as a
  // consumer-side patch for the old envelope).
  let status: 'open' | 'resolved' | 'unknown' = 'unknown';
  try {
    const statusRes = await doFetch(
      `${base}/rest/v1/actionable_advisories_v?id=eq.${encodeURIComponent(id)}&select=status`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${brainJwt}`,
          apikey: brainAnonKey,
          Accept: 'application/json',
        },
      },
    );
    if (statusRes.ok) {
      const rows = (await statusRes.json()) as Array<{ status?: unknown }>;
      const s = Array.isArray(rows) ? rows[0]?.status : undefined;
      if (s === 'open' || s === 'resolved') status = s;
    }
  } catch {
    // status stays 'unknown' — the write result above is still honest.
  }

  return { ok: true, firingsResolved, status };
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.39 — markExclusionFindingHandled
// ─────────────────────────────────────────────────────────────────────────
//
// Per-finding silencer for the alpha.38 `stale-exclusion-candidate` advisor.
// Without this API, the only way to silence the advisor on a specific
// finding was `policy.posture = 'locked'` — which silences EVERY rule for
// EVERY call, far too broad when the consumer just wants to mark "we
// probed deepseek-v4-pro on hunt; stay-excluded" without losing the
// `cost-mismatched-archetype` / `tier-down` / `caching-off-on-claude`
// surfaces for the same call.
//
// Mirrors `markAdvisoryResolved` shape: consumer supplies Supabase URL +
// scoped JWT + anon key; library PATCHes directly via PostgREST. No
// kgauto-controlled proxy involved — the consumer's brain RLS scopes by
// app_id JWT claim, so they can only resolve their own findings.
//
// Resolution surfaces in:
//   1. The dashboard endpoint (`/api/kgauto-v2/findings/exclusions`)
//      filters to `resolved_at IS NULL`, so resolved findings stop being
//      served to the library's SWR cache within ~5min TTL.
//   2. Operator queries (`kgauto-ops stale-exclusions`) similarly skip
//      resolved rows.
//   3. The next cron tick (`kgauto-exclusion-re-evaluation-watch` weekly)
//      may re-surface the same (app, archetype, excluded_model) tuple if
//      the underlying detection conditions still hold — but with a fresh
//      `last_observed_at` and `resolved_at = NULL`. Consumer-resolved
//      findings are intentionally re-promotable; the resolution decision
//      decays so stale exclusions don't escape detection forever.

/**
 * Resolution sources supported by the alpha.39 `markExclusionFindingHandled`
 * API. Mirrors the subset of `exclusion_findings.resolution_source` CHECK
 * constraint values that consumers can self-set:
 *
 * - `'consumer-marked'` — generic "we've handled this; stop reminding."
 *   Use this for "we evaluated and chose not to act" or "we'll act when
 *   ready but acknowledge the finding now."
 * - `'declined'` — explicit "this exclusion is intentional; do not surface
 *   again." Stronger signal than consumer-marked; useful for compliance
 *   exclusions, brand-promise exclusions, etc.
 * - `'probed-unblock'` — alpha.40+ probe-path verdict: consumer ran a live
 *   probe and decided to unblock the excluded model. Library accepts the
 *   value today so the probe path doesn't need a follow-up API release.
 * - `'probed-stay-excluded'` — alpha.40+ probe-path verdict: consumer
 *   probed and confirmed the exclusion. Same forward-compat shape as
 *   `'probed-unblock'`.
 *
 * The `'auto'` resolution_source is NOT exposed here — that's reserved
 * for the brain's own automatic resolution (e.g. when the detection
 * conditions no longer hold). Consumer code sets only the four values
 * above.
 */
export type ExclusionResolutionSource =
  | 'consumer-marked'
  | 'declined'
  | 'probed-unblock'
  | 'probed-stay-excluded';

export interface MarkExclusionFindingHandledOptions {
  /** App id the finding belongs to. Required (RLS scopes writes by this). */
  appId: string;
  /** Archetype the finding applies to (e.g. 'hunt', 'classify'). */
  archetype: string;
  /** Canonical model id that the consumer had excluded. */
  excludedModel: string;
  /** Resolution semantics — see `ExclusionResolutionSource` for the four
   *  values consumers can set. */
  resolution: ExclusionResolutionSource;
  /** Optional free-form note explaining the decision. Surfaces in operator
   *  digests + dashboards alongside the resolution_source. */
  resolutionNote?: string;
  /** Brain Supabase URL base (e.g. `https://<project>.supabase.co`). The
   *  function appends `/rest/v1/exclusion_findings?...`.
   *  alpha.78: defaults from `readBrainReadEnv()` when omitted. */
  brainEndpoint?: string;
  /** Consumer-scoped JWT carrying the `app_id` claim. The brain's RLS
   *  policy enforces that the JWT's app_id matches the finding's app_id;
   *  cross-tenant writes fail at the database layer regardless of input.
   *  alpha.78: defaults from `readBrainReadEnv()` when omitted. */
  brainJwt?: string;
  /** Supabase anon key for the `apikey` header (PostgREST requires it).
   *  alpha.78: defaults from `readBrainReadEnv()` when omitted. */
  brainAnonKey?: string;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Mark a stale-exclusion finding as handled. Returns an `ok/reason` envelope
 * matching `markAdvisoryResolved` — consumer Admin UIs typically render the
 * failure inline rather than crash.
 *
 * Idempotent: if no row matches the (app_id, archetype, excludedModel)
 * tuple (already resolved, never existed, cron not yet UPSERTed), PostgREST
 * returns 200 with zero affected rows and we return `{ ok: true }`. The
 * caller's "I marked it as handled" intent is satisfied regardless of
 * whether the row was already in that state.
 *
 * Reasons surfaced on failure:
 *   - `app_id_required` / `archetype_required` / `excluded_model_required`
 *   - `resolution_invalid` — `resolution` not one of the four documented values
 *   - `brain_auth_misconfig` — 401/403 (JWT / anon key wrong)
 *   - `brain_unavailable` — 5xx
 *   - `network_error:<message>` — fetch threw
 *   - `patch_failed:<status>` — anything else non-2xx
 */
export async function markExclusionFindingHandled(
  opts: MarkExclusionFindingHandledOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const {
    appId,
    archetype,
    excludedModel,
    resolution,
    resolutionNote,
    fetch: injectedFetch,
  } = opts;

  if (!appId) return { ok: false, reason: 'app_id_required' };

  const trio = resolveBrainReadTrio(opts);
  if (!trio.ok) {
    return { ok: false, reason: `brain_read_not_configured:${trio.missingEnv.join(',')}` };
  }
  const { brainEndpoint, brainJwt, brainAnonKey } = trio;
  if (!archetype) return { ok: false, reason: 'archetype_required' };
  if (!excludedModel) {
    return { ok: false, reason: 'excluded_model_required' };
  }
  if (
    resolution !== 'consumer-marked' &&
    resolution !== 'declined' &&
    resolution !== 'probed-unblock' &&
    resolution !== 'probed-stay-excluded'
  ) {
    return { ok: false, reason: 'resolution_invalid' };
  }

  const doFetch = resolveFetch(injectedFetch);
  const base = normalizeEndpoint(brainEndpoint);

  // PATCH /rest/v1/exclusion_findings filtered by the unique tuple
  // (app_id, intent_archetype, excluded_model). Migration 022 has a
  // UNIQUE index on this tuple, so the PATCH affects at most one row.
  // `resolved_at=is.null` keeps the operation idempotent — already-
  // resolved rows aren't re-stamped with a fresh timestamp.
  const url =
    `${base}/rest/v1/exclusion_findings` +
    `?app_id=eq.${encodeURIComponent(appId)}` +
    `&intent_archetype=eq.${encodeURIComponent(archetype)}` +
    `&excluded_model=eq.${encodeURIComponent(excludedModel)}` +
    `&resolved_at=is.null`;

  const patchBody: Record<string, unknown> = {
    resolved_at: new Date().toISOString(),
    resolution_source: resolution,
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
        // PATCH may match zero rows when already resolved — return=minimal
        // keeps the response body empty so the success path is uniform.
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
