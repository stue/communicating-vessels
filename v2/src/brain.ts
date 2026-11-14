/**
 * Brain client — fire-and-forget telemetry to the central kgauto Supabase.
 *
 * The brain is the centralized learning store. Apps POST outcomes here;
 * mutations flow back through a separate pull (in v2.1).
 *
 * Design: never blocks the caller. Failures are silent (logged via optional
 * onError hook). Uses fetch() — works in Node 18+, Edge runtimes, and browsers.
 */

import type {
  BestPracticeAdvisory,
  CompileResult,
  OutcomeResult,
  OutcomeSource,
  RecordInput,
  RecordOutcomeInput,
} from './ir.js';
import { computeShape, estimateInputTokens } from './passes.js';
import { LIBRARY_VERSION } from './version.js';
import { learningKey, routeScopedModel } from './dialect.js';
import { tryGetProfile, inferProviderFromId, priceAtInput } from './profiles.js';
import { resolveProviderKeyUnambiguous } from './env.js';
import { keyFingerprintSync } from './key-health.js';
import { configureBrainQuery } from './brain-query.js';
import {
  configureExclusionFindingsBrain,
  DEFAULT_FINDINGS_ENDPOINT,
} from './exclusion-findings-brain.js';
import {
  configurePromotionsBrain,
  prefetchPromotions,
  isAutoPromoteEnabledFromEnv,
  DEFAULT_PROMOTIONS_ENDPOINT,
} from './promotions-brain.js';
import {
  configureMeasuredFailureBrain,
  prefetchMeasuredFailure,
  isMeasuredFailureGateEnabledFromEnv,
  DEFAULT_MEASURED_FAILURE_ENDPOINT,
} from './measured-failure-brain.js';
import { resolvePricingAt } from './pricing-brain.js';

/**
 * alpha.11 — opt-in nested config for brain-query mode (chains / archetype
 * perf / pricing / models registry). Enabled by default when endpoint is
 * set; per-table opt-out via explicit `false`.
 *
 * Locked via /plan-eng-review 2026-05-15 (decision D3). Structured group
 * keeps the BrainConfig surface clean as more brain-driven tables ship.
 */
export interface BrainQueryConfig {
  /** Default true when endpoint set. Brain-driven fallback chains. */
  chains?: boolean;
  /** Default true when endpoint set. Brain-driven archetype perf scores. */
  perf?: boolean;
  /** Default true when endpoint set. Brain-driven pricing with at-time resolution. */
  pricing?: boolean;
  /** Default true when endpoint set. Brain-driven model registry + aliases. */
  models?: boolean;
  /**
   * alpha.38 — opt-in compile-time advisor for stale exclusions. Default
   * `true` when endpoint is set. When enabled, the library reads
   * `exclusion_findings` from the central kgauto-dashboard for the consumer's
   * `app_id` (no consumer-side proxy work required) and surfaces a
   * `stale-exclusion-candidate` advisory when compile()'s archetype has a
   * recommend-probe finding open. Set `false` to silence (no fetch, no
   * advisory).
   */
  findingsExclusions?: boolean;
  /**
   * alpha.64 — hard opt-out of the surface-promotions fetch layer (Stage 2).
   * Default true; only matters when consent (`BrainConfig.autoPromote` /
   * `KGAUTO_AUTO_PROMOTE`) is present — without consent the layer is off
   * regardless. Set `false` to disable the fetch even while consented
   * (debug/emergency lever).
   */
  promotions?: boolean;
  /** SWR window in ms. Default 300_000 (5 min). */
  cacheTtlMs?: number;
  /** Override the GET URL when the read endpoint differs from the write one.
   *  Defaults to `${endpoint}/v2/config` when omitted. */
  configEndpoint?: string;
  /**
   * alpha.38 — override the findings endpoint when the consumer wants to
   * proxy `exclusion_findings` reads through their own service rather than
   * reading directly from the kgauto-dashboard. Library appends `?app_id=X`.
   * Defaults to `https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/exclusions`.
   */
  findingsEndpoint?: string;
  /**
   * alpha.64 — override the surface-promotions endpoint (Stage 2). Only
   * consulted when the consumer opted in via `BrainConfig.autoPromote` /
   * `KGAUTO_AUTO_PROMOTE`. Library appends `?app_id=X`. Defaults to
   * `https://kgauto-dashboard.vercel.app/api/kgauto-v2/promotions`.
   */
  promotionsEndpoint?: string;
  /**
   * alpha.70 — hard opt-out of the measured-failure gate fetch layer.
   * Default true (the gate is opt-OUT, see `BrainConfig.measuredFailureGate`).
   */
  measuredFailure?: boolean;
  /**
   * alpha.70 — override the measured-failure endpoint. Library appends
   * `?app_id=X`. Defaults to
   * `https://kgauto-dashboard.vercel.app/api/kgauto-v2/measured-failure`.
   */
  measuredFailureEndpoint?: string;
}

export interface BrainConfig {
  /** Brain HTTP endpoint base URL (e.g., https://kgauto-brain.vercel.app/api). */
  endpoint: string;
  /**
   * alpha.73 — the consumer's app id, declared once so brain-driven levers can
   * start their first read at configuration time instead of at the first
   * compile.
   *
   * Optional and purely an optimisation: every IR already carries `appId`, and
   * omitting this changes no verdict — it only means the measured-failure
   * gate's warm-up starts when `call()` runs rather than when the module
   * initialises. Declaring it lets a short-lived isolate spend its startup
   * time on the fetch, so the bounded wait in `call()` usually costs nothing.
   * Consumers running one app per process should set it.
   */
  appId?: string;
  /** Bearer token for auth. */
  apiKey?: string;
  /** Optional error hook for debugging. Defaults to console.warn. */
  onError?: (err: unknown) => void;
  /** If true, records are sent synchronously and awaited (test mode). */
  sync?: boolean;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
  /** alpha.11 — brain-query mode for config tables. Default-on per table
   *  when endpoint is set; opt-out via `false`. See BrainQueryConfig. */
  brainQuery?: BrainQueryConfig;
  /**
   * alpha.52 — emit a dev-mode `console.warn` when a `compileForAISDKv6()`
   * result is passed to record() but its `.system` / `.model` / `.raw` were
   * never read (the compile-then-discard pattern: the recorded brain row's
   * `mutations_applied` / `estimated_tokens_in` / `system_prompt_chars`
   * describe a compile that did NOT shape the served call). Default: warn
   * when `NODE_ENV !== 'production'`, silent in production. Set `true` to
   * force-on (e.g. a prod audit window) or `false` to silence. No-op for
   * `call()` paths and raw `compile()` users — only `compileForAISDKv6`
   * arms the tracking, so good actors never see a false warning.
   */
  warnOnDiscardedCompile?: boolean;
  /**
   * alpha.59 — per-leg timeout (ms) applied to every brain WRITE POST
   * (record() primary + advisory secondary, recordOutcome(),
   * recordShadowProbe()) via `AbortSignal.timeout`. Default 10000.
   *
   * Why: `sync: true` puts these fetches on the USER path (Edge consumers
   * await record() before responding), and alpha.56's representation
   * passthrough added a second sequential POST (advisory secondary) to that
   * same path — an unbounded hang on either leg holds the user to the Edge
   * limit (GE's `brainconfig-first-class-timeout` filing; GE bounded it at
   * 3s via a hand-rolled fetchImpl wrapper every sync consumer had to
   * rediscover).
   *
   * A fired timeout follows each leg's existing degraded-brain path
   * (fire-and-forget: swallowed via onError; sync: `persistence_failed`
   * result — never a throw into the user path). Wraps the configured
   * `fetchImpl` rather than replacing it, so it composes with
   * consumer-supplied impls. Set `0` to disable (pre-alpha.59 unbounded
   * behavior). Brain-query reads (config tables) are cached + SWR and are
   * not affected.
   */
  timeoutMs?: number;
  /**
   * alpha.64 (Stage 2 of the eval trust ladder) — consent switch for the
   * surface-promotion routing effect. Default OFF.
   *
   * When true (or when the `KGAUTO_AUTO_PROMOTE` env var is '1'/'true' and
   * this field is left undefined — env-as-consent, the KGAUTO_GOLDEN_CAPTURE
   * precedent; an explicit `false` here overrides the env), compile()
   * consults the brain's active `kgauto_promotions` rows for this app and
   * boosts the promoted model at scoring time. Promotions are written only
   * by the automated golden-eval trigger after a promote-ready verdict on a
   * price-dominant (cheaper) candidate, and every promotion sits behind the
   * 7-day rollback guard (daily watcher auto-reverts on regression vs the
   * frozen baseline).
   *
   * Not opted in ⇒ promotions have ZERO routing effect (they remain visible
   * as advisories + dashboard rows). Consumer sovereignty is preserved even
   * when opted in: `forceModel`, `policy.blockedModels`, and cost ceilings
   * always win, and a non-empty `policy.preferredModels` defers the
   * promotion entirely.
   */
  autoPromote?: boolean;
  /**
   * alpha.70 — the measured-failure quality gate. **Default ON** wherever
   * the brain is configured; set `false` (or `KGAUTO_MEASURED_FAILURE_GATE=0`)
   * to disable. An explicit value here wins over the env var.
   *
   * Why this is opt-OUT while `autoPromote` is opt-IN: a promotion silently
   * changes WHICH model serves you on kgauto's evidence, so it needs
   * consent. This gate only ever DE-RANKS a model that the consumer's own
   * outcome rows show failing them — the failures are already being paid
   * for on their bill and their users' latency, and the model stays
   * available as a graceful fallback. Requiring an opt-in to stop paying
   * would be the wrong default.
   *
   * Consumer sovereignty is unchanged: `forceModel` still wins. Unlike a
   * promotion, `policy.preferredModels` does NOT defer the gate — a
   * preference says which model you would like to lead, not that a
   * measurably-failing one works.
   */
  measuredFailureGate?: boolean;
}

const DEFAULT_BRAIN_WRITE_TIMEOUT_MS = 10_000;

/**
 * alpha.59 — resolve the fetch used by brain write legs: the configured
 * fetchImpl (or global fetch) wrapped with `AbortSignal.timeout` per
 * `BrainConfig.timeoutMs`. Returns the base impl unwrapped when the timeout
 * is disabled (`timeoutMs: 0`) or the runtime lacks `AbortSignal.timeout`.
 */
function brainWriteFetch(config: BrainConfig): typeof fetch {
  const base = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_BRAIN_WRITE_TIMEOUT_MS;
  if (
    timeoutMs <= 0 ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    return base;
  }
  return (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

let activeConfig: BrainConfig | undefined;

export function configureBrain(config: BrainConfig): void {
  // Defensive normalize: PB-01 hit a silent prod 405 because consumers
  // sometimes pass the full `/outcomes` URL (mirroring their proxy route)
  // instead of the parent path. Library appends `/outcomes` per the contract
  // so trailing-`/outcomes` collapses to a double-suffix POST. Strip it.
  const endpoint = config.endpoint.replace(/\/outcomes\/?$/, '');
  activeConfig = { ...config, endpoint };

  // alpha.11 — wire brain-query runtime per the structured config. Per-table
  // default is ON when endpoint is set; explicit `false` opts out.
  const bq = config.brainQuery ?? {};
  const enabledTables = new Set<string>();
  if (bq.chains !== false) enabledTables.add('kgauto_chains');
  if (bq.perf !== false) enabledTables.add('kgauto_archetype_perf');
  // alpha.112 — the per-app measured scores ride the same `perf` flag: a consumer that reads
  // archetype perf from the brain reads its own measured rows too (R3).
  if (bq.perf !== false) enabledTables.add('kgauto_archetype_perf_measured');
  // alpha.129 — what the app's own calls on each model cost (migration 095's view): app-scoped
  // data beside the measured scores, under the same flag; read by the tier-down sentence only.
  if (bq.perf !== false) enabledTables.add('kgauto_effective_price_v');
  if (bq.pricing !== false) enabledTables.add('kgauto_pricing');
  if (bq.models !== false) {
    enabledTables.add('kgauto_models');
    enabledTables.add('kgauto_aliases');
  }

  if (enabledTables.size === 0) {
    configureBrainQuery(undefined);
  } else {
    configureBrainQuery({
      endpoint,
      configEndpoint: bq.configEndpoint,
      ttlMs: bq.cacheTtlMs ?? 300_000,
      fetchImpl: config.fetchImpl ?? fetch,
      enabledTables,
      onError: config.onError,
    });
  }

  // alpha.38 — wire the per-tenant exclusion-findings cache. Independent of
  // the cross-tenant brain-query enabledTables above; defaults ON when endpoint
  // is set, opt-out via `brainQuery.findingsExclusions = false`.
  if (bq.findingsExclusions !== false) {
    configureExclusionFindingsBrain({
      endpoint: bq.findingsEndpoint ?? DEFAULT_FINDINGS_ENDPOINT,
      ttlMs: bq.cacheTtlMs ?? 300_000,
      fetchImpl: config.fetchImpl ?? fetch,
      onError: config.onError,
    });
  } else {
    configureExclusionFindingsBrain(undefined);
  }

  // alpha.64 — wire the per-tenant surface-promotions cache (Stage 2).
  // Consent-gated, default OFF: `autoPromote: true` wins, explicit `false`
  // wins over the env, undefined falls through to KGAUTO_AUTO_PROMOTE.
  // Additionally respects `brainQuery.promotions = false` as a hard opt-out
  // of the fetch layer even when consent is present.
  const promotionsConsent =
    config.autoPromote ?? isAutoPromoteEnabledFromEnv();
  if (promotionsConsent && bq.promotions !== false) {
    configurePromotionsBrain({
      endpoint: bq.promotionsEndpoint ?? DEFAULT_PROMOTIONS_ENDPOINT,
      ttlMs: bq.cacheTtlMs ?? 300_000,
      fetchImpl: config.fetchImpl ?? fetch,
      onError: config.onError,
    });
    // alpha.86 — start the first read NOW (the alpha.73 prefetch, applied
    // to the sibling subsystem it missed). `compile()` is sync and reads
    // only what the cache holds; without this, a cold isolate silently
    // skips an ACTIVE promotion on the compile that matters most.
    if (config.appId) {
      try {
        void prefetchPromotions(config.appId);
      } catch {
        // Prefetch is an optimisation; never let it break configuration.
      }
    }
  } else {
    configurePromotionsBrain(undefined);
  }

  // alpha.70 — wire the measured-failure gate cache. Opt-OUT, not opt-in:
  // unlike auto-promote (which silently changes WHICH model serves you on
  // brain evidence), this only ever de-ranks a model the consumer's OWN
  // outcome rows show to be failing them, and keeps it as a fallback. The
  // consumer is already paying for those failures; requiring an opt-in to
  // stop paying would be the wrong default. `KGAUTO_MEASURED_FAILURE_GATE=0`
  // or `brainQuery.measuredFailure = false` disables it.
  const measuredFailureConsent =
    config.measuredFailureGate ?? isMeasuredFailureGateEnabledFromEnv();
  if (measuredFailureConsent && bq.measuredFailure !== false) {
    configureMeasuredFailureBrain({
      endpoint: bq.measuredFailureEndpoint ?? DEFAULT_MEASURED_FAILURE_ENDPOINT,
      ttlMs: bq.cacheTtlMs ?? 300_000,
      fetchImpl: config.fetchImpl ?? fetch,
      onError: config.onError,
    });
    // alpha.73 — start the first read NOW rather than at the first compile.
    // `compile()` is sync and can only read what the cache already holds, so
    // on a cold isolate the gate was silently absent on the one compile that
    // matters most. Fire-and-forget: this narrows the window by however long
    // the isolate spends between configure and its first call; `call()`'s
    // bounded `awaitMeasuredFailureReady` closes what remains.
    if (config.appId) {
      try {
        void prefetchMeasuredFailure(config.appId);
      } catch {
        // Prefetch is an optimisation; never let it break configuration.
      }
    }
  } else {
    configureMeasuredFailureBrain(undefined);
  }
}

export function clearBrain(): void {
  activeConfig = undefined;
  configureBrainQuery(undefined);
  configureExclusionFindingsBrain(undefined);
  configurePromotionsBrain(undefined);
  configureMeasuredFailureBrain(undefined);
}

// ── alpha.61 (G1 reliability floor): delivery ledger + dead-letter ──────────
//
// The 2026-07-17 adversarial promise review confirmed (N4) that silent
// telemetry loss was the *specified* behavior of every brain write path:
// fire-and-forget returns success before the POST, failures sink to an
// unwatched console.warn, and a failed payload is unrecoverable (the compile
// registry entry is deleted at record() entry). ≥8 silent-loss incidents in
// 10 weeks; 3 of 4 consumers dark 10–42 days. This block is the floor:
//
//   1. Every write leg counts into a process-local delivery ledger
//      (`brainHealth()` — sent/acked/failed/redirected + timestamps).
//   2. A response that arrived via redirect THROWS (the tt-intel
//      middleware-307-to-login class: fetch follows the redirect, the login
//      page answers 200, `res.ok` lies).
//   3. Failed write payloads land in a bounded in-memory dead-letter
//      (payload survives the registry delete), replayable via
//      `flushBrainDeadLetter()` and auto-flushed opportunistically after the
//      next successful write in the same process.
//
// Scope honesty: all state is per-process. In serverless, each instance has
// its own ledger and the dead-letter dies with the instance — this is a
// *detection + best-effort-recovery* floor, not durable queuing. Durable
// evidence lives brain-side (liveness rule on the cost-watcher).

export interface BrainHealthSnapshot {
  configState: 'configured' | 'not_configured';
  /** Host of the configured endpoint (never the full URL — no secrets/paths). */
  endpointHost?: string;
  /** True when writes are awaited (BrainConfig.sync). */
  sync: boolean;
  /** Write POSTs attempted (all routes, primary + secondary). */
  sent: number;
  /** Write POSTs acknowledged 2xx without redirect. */
  acked: number;
  /** Write POSTs that failed (non-2xx, redirect, timeout, network throw). */
  failed: number;
  /** Subset of `failed` that failed the redirect check (middleware-drift class). */
  redirected: number;
  lastAckAt?: string;
  lastFailureAt?: string;
  /** Most recent failure message, truncated. */
  lastFailure?: string;
  deadLetterCount: number;
}

export interface BrainDeadLetterEntry {
  /** Brain route segment the payload was bound for. */
  route:
    | 'outcomes'
    | 'compile_outcome_quality'
    | 'probe_outcomes'
    | 'compile_outcome_advisories'
    | 'golden_irs';
  /**
   * Endpoint the payload was originally bound for. Flush replays ONLY entries
   * matching the currently-configured endpoint — a reconfigure must never
   * replay another brain's payloads into the new target (caught live by
   * smoke-brain-timeout: a hung-socket test payload auto-flushed into the
   * real brain after the smoke re-pointed configureBrain).
   */
  endpoint: string;
  /** The exact JSON body that failed to land. */
  payload: unknown;
  failedAt: string;
  /** Delivery attempts so far (1 = the original failed POST). */
  attempts: number;
  lastError: string;
}

const DEAD_LETTER_MAX_ENTRIES = 50;
const DEAD_LETTER_MAX_ATTEMPTS = 3;

const ledger = {
  sent: 0,
  acked: 0,
  failed: 0,
  redirected: 0,
  lastAckAt: undefined as string | undefined,
  lastFailureAt: undefined as string | undefined,
  lastFailure: undefined as string | undefined,
};
const deadLetter: BrainDeadLetterEntry[] = [];
let flushing = false;

function noteSent(): void {
  ledger.sent += 1;
}

function noteAck(): void {
  ledger.acked += 1;
  ledger.lastAckAt = new Date().toISOString();
}

function noteFailure(err: unknown): void {
  ledger.failed += 1;
  ledger.lastFailureAt = new Date().toISOString();
  const msg = err instanceof Error ? err.message : String(err);
  ledger.lastFailure = msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/**
 * The one-line check the 2026-07-02 incident asked for: a consumer middleware
 * that 307s brain POSTs to a login page produces a *followed* redirect whose
 * final response is a perfectly healthy-looking 200 — `res.ok` is true and
 * the row never landed. `res.redirected` is the only honest signal.
 */
function assertNotRedirected(res: Response, route: BrainDeadLetterEntry['route']): void {
  if (!res.redirected) return;
  ledger.redirected += 1;
  throw new Error(
    `brain ${route} POST was redirected to ${res.url} — the write did NOT land. ` +
      `Likely cause: consumer middleware (auth/login allowlist) intercepts the ` +
      `brain proxy path. Add your kgauto proxy routes to the middleware public ` +
      `paths (the 2026-07-02 tt-intel/IC middleware-drift class).`,
  );
}

function pushDeadLetter(
  route: BrainDeadLetterEntry['route'],
  endpoint: string,
  payload: unknown,
  err: unknown,
): void {
  if (deadLetter.length >= DEAD_LETTER_MAX_ENTRIES) deadLetter.shift();
  deadLetter.push({
    route,
    endpoint,
    payload,
    failedAt: new Date().toISOString(),
    attempts: 1,
    lastError: err instanceof Error ? err.message : String(err),
  });
}

/** Fire an opportunistic background flush after a successful write. */
function maybeAutoFlush(): void {
  if (deadLetter.length === 0 || flushing) return;
  void flushBrainDeadLetter();
}

/**
 * Process-local brain write delivery ledger. `acked` is the only number that
 * means "a row landed" — fire-and-forget callers that need delivery evidence
 * read this (or set `BrainConfig.sync`). Cheap enough to attach to any debug
 * or health surface the consumer already exposes.
 */
export function brainHealth(): BrainHealthSnapshot {
  let endpointHost: string | undefined;
  if (activeConfig) {
    try {
      endpointHost = new URL(activeConfig.endpoint).host;
    } catch {
      endpointHost = undefined;
    }
  }
  return {
    configState: activeConfig ? 'configured' : 'not_configured',
    endpointHost,
    sync: activeConfig?.sync === true,
    sent: ledger.sent,
    acked: ledger.acked,
    failed: ledger.failed,
    redirected: ledger.redirected,
    lastAckAt: ledger.lastAckAt,
    lastFailureAt: ledger.lastFailureAt,
    lastFailure: ledger.lastFailure,
    deadLetterCount: deadLetter.length,
  };
}

/** Read-only view of the pending dead-letter (for consumer-side persistence). */
export function peekBrainDeadLetter(): readonly BrainDeadLetterEntry[] {
  return deadLetter.slice();
}

/**
 * Replay pending dead-letter payloads against the configured brain. Delivered
 * entries are removed; failures increment `attempts` and entries are dropped
 * after 3 total attempts (bounded — never an infinite retry, per the Redis
 * DLQ rule). Safe to call any time; no-ops when unconfigured or already
 * flushing. Also runs opportunistically after any successful write.
 */
export async function flushBrainDeadLetter(): Promise<{
  attempted: number;
  delivered: number;
  remaining: number;
}> {
  if (!activeConfig || flushing || deadLetter.length === 0) {
    return { attempted: 0, delivered: 0, remaining: deadLetter.length };
  }
  flushing = true;
  const config = activeConfig;
  const fetchFn = brainWriteFetch(config);
  let attempted = 0;
  let delivered = 0;
  try {
    // Snapshot: entries pushed DURING the flush (by concurrent failing writes)
    // wait for the next flush. Endpoint-scoped: only entries bound for the
    // ACTIVE endpoint replay — never another brain's payloads.
    const batch = deadLetter.filter((e) => e.endpoint === config.endpoint);
    for (const entry of batch) {
      attempted += 1;
      noteSent();
      try {
        const res = await fetchFn(`${config.endpoint}/${entry.route}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Replay never chains a secondary — minimal is correct for all routes.
            Prefer: 'return=minimal',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify(entry.payload),
        });
        assertNotRedirected(res, entry.route);
        if (!res.ok) {
          const text = await res.text().catch(() => '<no body>');
          throw new Error(describeBrainWriteFailure(res.status, entry.route, text));
        }
        noteAck();
        delivered += 1;
        const idx = deadLetter.indexOf(entry);
        if (idx !== -1) deadLetter.splice(idx, 1);
      } catch (err) {
        noteFailure(err);
        entry.attempts += 1;
        entry.lastError = err instanceof Error ? err.message : String(err);
        if (entry.attempts >= DEAD_LETTER_MAX_ATTEMPTS) {
          const idx = deadLetter.indexOf(entry);
          if (idx !== -1) deadLetter.splice(idx, 1);
          (config.onError ?? defaultOnError)(
            new Error(
              `brain dead-letter: dropping ${entry.route} payload after ` +
                `${entry.attempts} attempts — last error: ${entry.lastError}`,
            ),
          );
        }
      }
    }
  } finally {
    flushing = false;
  }
  return { attempted, delivered, remaining: deadLetter.length };
}

/**
 * Internal call-record cache: maps handle → metadata captured at compile time.
 * Used by record() to enrich the outcome with archetype/shape/learningKey
 * without forcing the caller to pass everything back.
 */
interface CompileRecord {
  appId: string;
  archetype: string;
  model: string;
  provider: string;
  /** alpha.92 — the route the compile targeted ('direct' when absent). */
  route?: 'direct' | 'openrouter';
  shapeKey: string;
  learningKey: string;
  estimatedTokensIn: number;
  mutationsApplied: string[];
  /**
   * alpha.30: advisories fired at compile time. Cached on the registry so
   * record() can auto-persist them to `compile_outcome_advisories` without
   * the consumer having to thread them explicitly through their record-call
   * wrapper. Same auto-enrichment pattern as `mutationsApplied`.
   *
   * Builder B's alpha.29 brain probe surfaced the gap: `compile_outcome_advisories`
   * was empty across all 3 consumers despite 793 outcomes — consumers don't
   * pass `advisories` to record(). This auto-pull closes the loop without
   * requiring consumer-side code changes; consumers who DO pass advisories
   * still override (input.advisories takes precedence).
   */
  advisoriesFromCompile: BestPracticeAdvisory[];
  startedAt: number;
  /** alpha.5: tokens eligible for history caching per `historyCachePolicy`. */
  historyCacheableTokens: number;
  /** alpha.7: total tokens in input history (pre-compression). */
  historyTokensTotal: number;
  /**
   * alpha.20 E3: consumer-declared tool-orchestration mode at compile-time.
   * Mirrored from `ir.constraints.toolOrchestration`. Undefined when the
   * consumer hadn't adopted the constraint yet (pre-alpha.20 callers).
   */
  toolOrchestration?: 'parallel' | 'sequential' | 'either';
  /**
   * alpha.28 — Glass-Box shape fields captured at compile time. Renderer
   * surfaces these in the Shape card. All optional — older registrations
   * default to undefined and the wire transformer renders "—".
   */
  toolsCount?: number;
  historyDepth?: number;
  systemPromptChars?: number;
  /**
   * alpha.29 — translator rewrites that fired at compile time. Mirrored
   * from `CompileResult.sectionRewritesApplied`. Persisted by `record()` to
   * `compile_outcomes.section_rewrites_applied` (migration 019). Empty
   * array when no rewrites fired; brain stores NULL in that case.
   */
  sectionRewritesApplied?: import('./ir.js').SectionRewrite[];
  /**
   * alpha.52 — compile-then-discard guard state. Armed ONLY by
   * `compileForAISDKv6()` (which installs consume-tracking getters on its
   * result). `consumeTracked === true` means "this handle's adapter output
   * was supposed to be read"; the three `*Consumed` flags flip true when the
   * consumer reads `.system` / `.model` / `.raw`. record() warns when armed
   * but none consumed. Undefined for `call()` / raw `compile()` paths → the
   * guard never fires (no false positives on good actors).
   */
  consumeTracked?: boolean;
  systemConsumed?: boolean;
  modelConsumed?: boolean;
  rawConsumed?: boolean;
  /**
   * alpha.57 (data-first): reasoning-effort tier declared on
   * `ir.constraints.effort` at compile time. Auto-enriched onto the outcome
   * payload by record() when the consumer doesn't pass `effort` explicitly —
   * same pattern as `mutationsApplied` / `advisoriesFromCompile`.
   */
  effortFromCompile?: string;
  /**
   * alpha.68 / Release A (delegation-fanout-accelerator §5.0, R0 linkage) —
   * fan-out linkage derived at compile-registration time from the compile's
   * `parentHandle` + `handle`. Auto-enriched onto the outcome payload by
   * record() (migration 042), same auto-enrich pattern as `effortFromCompile`.
   *
   *   - `parentHandle`  parent's handle when a branch; undefined for a root.
   *   - `traceId`       root handle of the trace (= parentHandle ?? own handle).
   *   - `fanoutRole`    'root' (no parentHandle) | 'branch' (has one). Release A
   *                     produces only these two; 'composer' is reserved (R D).
   */
  parentHandle?: string;
  traceId?: string;
  fanoutRole?: 'root' | 'branch' | 'composer';
  /**
   * alpha.68 / Release A (§5.D) — measured discipline gate-token tax mirrored
   * from `CompileResult.diagnostics.disciplineGateTokens`. 0 when the gate
   * didn't fire. Persisted to `compile_outcomes.discipline_gate_tokens`.
   */
  disciplineGateTokens?: number;
  /** alpha.106 (migration 075) — the receipt, so a consumer's own record() path carries it without threading anything. */
  savings?: { inputTokensAsGiven: number; inputTokensRemoved: number; estimatedUsdSavedFirstCall: number; passes: string[] };
}

const compileRegistry = new Map<string, CompileRecord>();
const REGISTRY_MAX_ENTRIES = 10_000;

/**
 * Register a compile result so record() can later enrich the outcome.
 * Called automatically by the public compile() exit path.
 */
export function registerCompile(
  appId: string,
  archetype: string,
  // alpha.41: `ir.models` is a `ChainModelEntry[]` (string | { family: string })
  // at the public boundary. registerCompile passes it to computeShape which
  // doesn't read `models`, so we accept the loose shape and treat the array
  // as opaque here. The shape-key derivation downstream operates on tools/
  // history/sections/constraints only.
  ir: {
    models: ReadonlyArray<string | { family: string }>;
    tools?: unknown[];
    history?: unknown[];
    sections: unknown[];
    constraints?: { structuredOutput?: boolean; effort?: string };
  },
  result: CompileResult,
  // alpha.68 / Release A (§5.0, R0 linkage) — the fan-out parent handle
  // (CallOptions/CompileOptions.parentHandle). Present ⇒ this compile is a
  // BRANCH of `parentHandle`'s trace; absent ⇒ a root. Optional so pre-alpha.68
  // call sites (and every non-fan-out caller) stay unchanged.
  parentHandle?: string,
  // alpha.92 — the route (execute-leg contract). Scopes the learning key
  // (`model@openrouter`) and stamps the outcome row, so gateway evidence and
  // direct-vendor evidence never mix. Absent ⇒ 'direct'.
  route?: 'direct' | 'openrouter',
): void {
  if (compileRegistry.size >= REGISTRY_MAX_ENTRIES) {
    // Evict oldest 25%
    const cutoff = Math.floor(REGISTRY_MAX_ENTRIES * 0.25);
    let evicted = 0;
    for (const k of compileRegistry.keys()) {
      compileRegistry.delete(k);
      if (++evicted >= cutoff) break;
    }
  }
  // Re-derive shape from CompileResult diagnostics
  const tokens = result.tokensIn;
  const shape = computeShape(
    {
      appId,
      intent: { name: archetype, archetype: archetype as never },
      sections: ir.sections as never,
      tools: ir.tools as never,
      history: ir.history as never,
      models: ir.models as never,
      constraints: ir.constraints as never,
    },
    tokens,
  );
  const shapeKey = `${shape.contextBucket}-${shape.toolCountBucket}-${shape.historyDepth}-${shape.outputMode}`;
  // alpha.28 — Glass-Box shape capture. Renderer surfaces these in the
  // Shape card. Library captures what it observes at compile time; the
  // library can't measure systemPromptChars without lowering, so we infer
  // from sections (sum of section.content lengths is a stable proxy).
  const toolsCount = result.diagnostics.toolsKept;
  const historyDepth = Array.isArray(ir.history) ? ir.history.length : 0;
  const systemPromptChars = estimateSystemPromptChars(ir.sections);

  compileRegistry.set(result.handle, {
    appId,
    archetype,
    model: result.target,
    provider: result.provider,
    shapeKey,
    route: route ?? 'direct',
    // alpha.92 — route-scoped for non-direct routes: the same model id on a
    // gateway is a different serving stack (Venice/StreamLake, 2026-08-26).
    learningKey: learningKey(archetype as never, routeScopedModel(result.target, route), shape),
    estimatedTokensIn: tokens,
    mutationsApplied: result.mutationsApplied.map((m) => m.id),
    // alpha.30: cache the in-memory advisories so record() can auto-persist
    // to `compile_outcome_advisories` without consumer-side threading.
    advisoriesFromCompile: result.advisories ?? [],
    startedAt: Date.now(),
    historyCacheableTokens: result.diagnostics.historyCacheableTokens,
    historyTokensTotal: result.diagnostics.historyTokensTotal,
    // alpha.20 E3: capture consumer's declared mode for the brain payload.
    toolOrchestration: result.diagnostics.toolOrchestration,
    // alpha.28: shape fields for Glass-Box renderer.
    toolsCount,
    historyDepth,
    systemPromptChars,
    // alpha.29: translator activity — persisted on the brain row so
    // cross-app aggregates can answer "Sonnet narration rule fired N times,
    // outcome quality lifted to M."
    sectionRewritesApplied: result.sectionRewritesApplied,
    // alpha.57: cache the declared effort tier for record()'s auto-enrich.
    effortFromCompile: ir.constraints?.effort,
    // alpha.68 / Release A (§5.0, R0 linkage) — derive + cache the fan-out
    // linkage. Release A is 1-level: a branch's trace_id is its parent handle
    // (the root); deeper trees await the delegate primitive (Release D).
    parentHandle,
    traceId: parentHandle ?? result.handle,
    fanoutRole: parentHandle ? 'branch' : 'root',
    // alpha.68 / Release A (§5.D) — measured gate-token tax from diagnostics.
    disciplineGateTokens: result.diagnostics.disciplineGateTokens,
    // alpha.106 — the receipt travels with the handle; record() writes it.
    savings: result.diagnostics.savings
      ? {
          inputTokensAsGiven: result.diagnostics.savings.inputTokensAsGiven,
          inputTokensRemoved: result.diagnostics.savings.inputTokensRemoved,
          estimatedUsdSavedFirstCall: result.diagnostics.savings.estimatedUsdSavedFirstCall,
          passes: result.diagnostics.savings.passes,
        }
      : undefined,
  });
}

/**
 * alpha.28 — sum `section.content` lengths to approximate the rendered
 * system-prompt size in characters. The exact lowered size is provider-
 * dependent (Anthropic inline vs Google `systemInstruction` vs OpenAI
 * developer role), but the sum-of-sections is a stable proxy and the
 * renderer uses this for "system 2,400 chars" display, not for cost math.
 *
 * Returns undefined when sections is missing/empty — renderer renders "—".
 */
function estimateSystemPromptChars(
  sections: unknown,
): number | undefined {
  if (!Array.isArray(sections) || sections.length === 0) return undefined;
  let total = 0;
  for (const s of sections) {
    if (s && typeof s === 'object') {
      const content = (s as { content?: unknown }).content;
      if (typeof content === 'string') total += content.length;
    }
  }
  return total > 0 ? total : undefined;
}

/**
 * Record the outcome of a compiled call. Fire-and-forget by default.
 *
 * Returns a Promise so callers in `sync` mode can await; in async mode the
 * promise resolves immediately (after the request is queued) and any
 * network error is swallowed/forwarded to onError.
 */
/**
 * alpha.52 — arm compile-then-discard tracking for a handle. Called by
 * `compileForAISDKv6()` immediately after `compile()` registers the handle.
 * Sets the three consumed flags to false (= "tracking active, nothing read
 * yet"). No-op if the handle isn't registered.
 */
export function armCompileConsumeTracking(handle: string): void {
  const reg = compileRegistry.get(handle);
  if (!reg) return;
  reg.consumeTracked = true;
  reg.systemConsumed = false;
  reg.modelConsumed = false;
  reg.rawConsumed = false;
}

/**
 * alpha.52 — mark a tracked field as consumed. Called by the consume-getters
 * on the `compileForAISDKv6()` result. No-op for unregistered/untracked
 * handles, so it's safe to call unconditionally from the getters.
 */
export function markCompileConsumed(
  handle: string,
  field: 'system' | 'model' | 'raw',
): void {
  const reg = compileRegistry.get(handle);
  if (!reg || !reg.consumeTracked) return;
  if (field === 'system') reg.systemConsumed = true;
  else if (field === 'model') reg.modelConsumed = true;
  else reg.rawConsumed = true;
}

/**
 * alpha.52 — the compile-then-discard guard. Warns (dev-mode by default) when
 * an armed handle is recorded without any of `.system` / `.model` / `.raw`
 * having been read — i.e. the consumer recorded a compile whose output never
 * shaped the served call. Never throws; record() stays non-load-bearing.
 */
function maybeWarnDiscardedCompile(reg: CompileRecord, handle: string): void {
  if (!reg.consumeTracked) return;
  if (reg.systemConsumed || reg.modelConsumed || reg.rawConsumed) return;
  const isProd =
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  const enabled = activeConfig?.warnOnDiscardedCompile ?? !isProd;
  if (!enabled) return;
  console.warn(
    `[kgauto] compile-then-discard: compileForAISDKv6() output for handle ${handle} ` +
      `(archetype=${reg.archetype}, model=${reg.model}) was recorded but neither ` +
      `.system, .model, nor .raw was read before record(). The brain row's ` +
      `mutations_applied / estimated_tokens_in / system_prompt_chars describe a ` +
      `compile that did NOT shape the served call. Pass compiled.system + ` +
      `compiled.model into your generateText/streamText (or use call()). ` +
      `Silence via configureBrain({ warnOnDiscardedCompile: false }).`,
  );
}

// alpha.115 — 'reader' (readFiling(), migration 082 admits it in the CHECK).
const OUTCOME_SOURCES: readonly string[] = ['canary', 'smoke', 'eval', 'probe', 'synthetic', 'reader'];
let warnedInvalidEnvSource = false;

/**
 * alpha.87 — `KGAUTO_SOURCE` env default for the synthetic self-mark
 * (migration 056). An explicit `source` on the input always wins; when
 * absent, the env var marks every outcome row this PROCESS writes — the
 * zero-code path for replay harnesses and smoke environments that share
 * `call()`/`record()` with real traffic (PB s89's ask: their harness sets
 * `KGAUTO_SOURCE=smoke` in the harness env and touches no call sites).
 *
 * An unrecognized value maps to `'synthetic'` with a one-time warning
 * rather than passing through: migration 056's CHECK constraint would
 * reject the row server-side and the fire-and-forget write would swallow
 * the rejection — silent data loss — while dropping the value entirely
 * would mark declared-synthetic traffic as organic and poison liveness
 * stats. `'synthetic'` keeps both the row and the discriminator honest.
 */
export function resolveOutcomeSource(explicit?: string): OutcomeSource | undefined {
  if (explicit) return explicit as OutcomeSource;
  const raw = typeof process !== 'undefined' ? process.env?.KGAUTO_SOURCE : undefined;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (OUTCOME_SOURCES.includes(trimmed)) return trimmed as OutcomeSource;
  if (!warnedInvalidEnvSource) {
    warnedInvalidEnvSource = true;
    console.warn(
      `[kgauto] KGAUTO_SOURCE="${trimmed}" is not one of ${OUTCOME_SOURCES.join('|')} — ` +
        `recording as 'synthetic' so the row survives the brain's CHECK constraint ` +
        `and stays out of organic-liveness stats.`,
    );
  }
  return 'synthetic';
}

/** @internal — test hook: re-arm the one-time invalid-KGAUTO_SOURCE warning. */
export function _testResetOutcomeSourceWarning(): void {
  warnedInvalidEnvSource = false;
}

export async function record(input: RecordInput): Promise<void> {
  const reg = compileRegistry.get(input.handle);
  // Always remove from registry on record (handle is single-use)
  if (reg) {
    // alpha.52 — compile-then-discard guard (dev-mode warn; no-op unless armed
    // by compileForAISDKv6). Runs before the brain-config early-return so it
    // fires in local dev / CI without a configured brain.
    maybeWarnDiscardedCompile(reg, input.handle);
    compileRegistry.delete(input.handle);
  }

  if (!activeConfig) {
    // No brain configured — quietly drop. Allows local dev / tests without setup.
    return;
  }

  const payload = buildPayload(input, reg);
  const config = activeConfig;
  const fetchFn = brainWriteFetch(config);

  const send = async (): Promise<void> => {
    let outcomeId: number | undefined;
    noteSent();
    try {
      const res = await fetchFn(`${config.endpoint}/outcomes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // alpha.20: request the inserted row back so we can JOIN advisories
          // to it via outcome_id. PostgREST returns the row when
          // `Prefer: return=representation` is set; proxies that pass the
          // header through (the recommended `const row = { ...body }` shape
          // from OutcomePayload's forward-compat rule) will surface
          // the row id. Proxies that don't (legacy / hand-rolled shapes)
          // simply produce no parseable id → secondary advisory POST is
          // skipped silently. Best-effort — primary outcome row is the
          // load-bearing write.
          Prefer: 'return=representation',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      assertNotRedirected(res, 'outcomes');
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(describeBrainWriteFailure(res.status, 'outcomes', text));
      }
      noteAck();
      // Try to extract the inserted row id. PostgREST returns
      // `[{id: ..., ...}]` (array of inserted rows); some proxies return
      // `{id: ..., ...}` (single object). Both shapes handled. Parse
      // failure is silent — secondary advisory POST is skipped.
      outcomeId = await tryExtractOutcomeId(res);
    } catch (err) {
      noteFailure(err);
      // alpha.61: the payload survives the registry delete — a failed write is
      // recoverable via flushBrainDeadLetter(), not gone.
      pushDeadLetter('outcomes', config.endpoint, payload, err);
      (config.onError ?? defaultOnError)(err);
      // Primary POST failed — do NOT fire secondary. There's no parent row
      // to FK-link the advisories to.
      return;
    }
    maybeAutoFlush();

    // alpha.20: fire-and-forget advisory persistence. Only fires when:
    //   1. Primary outcome POST succeeded (we're past the early-return above).
    //   2. Advisories are available — either passed explicitly on RecordInput
    //      OR auto-pulled from the registered compile result (alpha.30 fix
    //      for Builder B's brain probe finding: pre-alpha.30 the table was
    //      empty across all 3 consumers because consumer-side wrappers never
    //      threaded `advisories` to record()).
    //   3. We extracted a parseable outcome_id from the primary response.
    // Failures here are best-effort logged via onError — the primary
    // outcome row is the load-bearing write and is already persisted.
    //
    // alpha.30: input.advisories takes precedence (consumer override path);
    // otherwise fall back to reg.advisoriesFromCompile cached by
    // registerCompile() at compile-result-exit time. Same enrichment pattern
    // as `mutationsApplied` (line ~455).
    const advisories = input.advisories ?? reg?.advisoriesFromCompile;
    if (!advisories || advisories.length === 0) return;
    if (outcomeId === undefined) return;

    const advisoryPayload = advisories.map((a) => buildAdvisoryRow(outcomeId, a));
    noteSent();
    try {
      const res = await fetchFn(`${config.endpoint}/compile_outcome_advisories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(advisoryPayload),
      });
      assertNotRedirected(res, 'compile_outcome_advisories');
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`brain advisories ${res.status}: ${text}`);
      }
      noteAck();
    } catch (err) {
      // Best-effort: primary row already landed, so swallow + log only.
      // The advisory rows carry their outcome_id — replayable from dead-letter.
      noteFailure(err);
      pushDeadLetter('compile_outcome_advisories', config.endpoint, advisoryPayload, err);
      (config.onError ?? defaultOnError)(err);
    }
  };

  if (config.sync) {
    await send();
  } else {
    // Fire-and-forget: kick off but don't await
    void send();
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[kgauto] brain record failed:', err);
}

/**
 * alpha.53 — route-404 observability (L-142). Every brain write path is
 * fire-and-forget by design, so a self-proxying consumer that wired the call
 * but not the proxy route sees only missing rows: the 404 dies in an unwatched
 * onError log. This bit 3 of 3 self-proxying consumers (IC `/probe_outcomes`
 * 2026-06-24; tt-intel + IC `/compile_outcome_quality` 2026-07-02 — verdicts
 * silently dropped for ~6 weeks; PB's mis-mounted `/outcomes/outcomes` 405,
 * 2026-05-08). Naming the likely cause in the error string is the difference
 * between a 2-minute and a 30-minute dig. 405 included: a route mounted at the
 * wrong path segment surfaces as method-not-allowed, same root cause.
 */
function describeBrainWriteFailure(status: number, route: string, body: string): string {
  const base = `brain ${route} ${status}: ${body}`;
  if (status !== 404 && status !== 405) return base;
  return (
    `${base} — likely cause: the brain proxy at your KGAUTO_V2_BRAIN_URL is ` +
    `missing the /${route} forward route. Self-proxying consumers must ` +
    `implement ALL THREE sibling routes (/outcomes, /probe_outcomes, ` +
    `/compile_outcome_quality) — see interfaces/kgauto.md "Consumer adoption ` +
    `checklist" route-completeness (L-142).`
  );
}

/**
 * Wire shape POSTed by `record()` to the brain proxy's `/outcomes` endpoint.
 *
 * Exported so consumer proxies can `import { OutcomePayload } from
 * '@warmdrift/kgauto-compiler'` instead of redefining the shape — that way
 * TypeScript catches future schema additions (cache fields, advisory
 * telemetry, etc.) at consumer build time, not silently at runtime.
 *
 * **Forward-compat rule:** consumer proxies should pass the body through to
 * Supabase rather than reconstructing field-by-field. The recommended shape
 * is `const row = { ...body }` (or `await supabase.from('compile_outcomes')
 * .insert(body)` directly). Filtering proxies break schema evolution
 * silently — see s17 root-cause investigation 2026-05-10.
 */
export interface OutcomePayload {
  handle: string;
  app_id?: string;
  intent_archetype?: string;
  /** The model that ACTUALLY RAN (post-fallback). */
  model?: string;
  /** The model v2 compile() originally targeted. NULL when no fallback. */
  requested_model?: string;
  provider?: string;
  shape_key?: string;
  learning_key?: string;
  /** alpha.92 (migration 067) — route identity: 'direct' | 'openrouter'. */
  route?: string;
  /** alpha.92 — gateway-reported serving host (OpenRouter `provider` field). */
  route_host?: string;
  /** alpha.105 (migration 074) — the model the PROVIDER reported serving, verbatim. */
  served_model?: string;
  /** alpha.106 (migration 075) — the receipt: input tokens the IR would have cost sent as given. */
  input_tokens_as_given?: number;
  /** alpha.106 — tokens kgauto's passes removed (as-given − sent), floored at 0. */
  input_tokens_removed?: number;
  /** alpha.106 — removed tokens × the target's input price at compile time; an ESTIMATE. */
  estimated_usd_saved?: number;
  mutations_applied: string[];
  tokens_in: number;
  tokens_out: number;
  estimated_tokens_in?: number;
  latency_ms: number;
  success: boolean;
  empty_response: boolean;
  /**
   * alpha.86 (migration 056) — synthetic-writer self-mark. Key OMITTED for
   * organic traffic (and against pre-056 brains). NULL in the table means
   * organic; liveness rules compute over `source IS NULL` rows.
   */
  source?: string;
  /**
   * alpha.89 (migration 065) — per-end-user metering: the consumer's opaque
   * customer id, truncated to 128 chars at write. NULL = no end user.
   */
  end_user_id?: string;
  error_type?: string;
  tools_called?: string[];
  oracle_score?: number;
  oracle_dimensions?: Record<string, number>;
  oracle_rationale?: string;
  prompt_preview?: string;
  response_preview?: string;
  dialect_version: string;
  // ── alpha.109: the library version that wrote the row (migration 076) ──
  library_version?: string;
  // ── alpha.4: cost + cache observability (migration 003) ──
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd_actual?: number;
  ttft_ms?: number;
  // ── alpha.5: history-cache telemetry (migration 004) ──
  history_cacheable_tokens?: number;
  // ── alpha.57: effort dimension, data-first (migration 033) ──
  effort?: string;
  // ── alpha.7: byte-aware history-compression telemetry (migration 005) ──
  history_tokens_at_compile?: number;
  // ── alpha.20 E3: consumer-declared tool-orchestration mode (migration 015) ──
  /**
   * Mirrors `ir.constraints.toolOrchestration` from compile time. NULL when
   * the consumer hadn't adopted the constraint (pre-alpha.20). Powers
   * per-mode model-perf queries on the brain (the L-040 parallel-tool
   * cliff lumps DeepSeek sequential perf with parallel without this).
   */
  tool_orchestration?: 'parallel' | 'sequential' | 'either' | null;
  // ── alpha.28: Glass-Box renderer substrate (migration 018) ──
  finish_reason?: string;
  total_ms?: number;
  tools_count?: number;
  history_depth?: number;
  system_prompt_chars?: number;
  fell_over_from?: string;
  // One derivation, not two: this row field IS ir.ts's FallbackReason. The
  // alpha.77 DTS failure caught the drift the moment the canonical union
  // grew — keep it imported, never inlined again.
  fallback_reason?: import('./ir.js').FallbackReason;
  /**
   * alpha.71 (migration 044) — the precise `errorCode` behind
   * `fallback_reason`. Key OMITTED when no fallback fired, so brains that
   * haven't applied 044 never see it.
   */
  fell_over_error_code?: string;
  /** KG-18 step 1 (alpha.111, migration 078) — balance / quota / outage / refusal / quality behind the fall-over. */
  fallback_class?: 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';
  /** KG-18 step 1 — the provider's own name for the limit that fired, when given. */
  quota_id?: string;
  /** KG-18 step 0 — fingerprint of the key the call was served with (never the key; same hash as key-health). */
  key_fingerprint?: string;
  // ── alpha.66: one-shot same-model retry telemetry (migration 039) ──
  /**
   * True when the same-model retry (CallOptions.sameModelRetry) fired
   * during this call. Key OMITTED (not false) when no retry fired — safe
   * against brains that haven't applied migration 039 yet.
   */
  retried_same_model?: boolean;
  // ── alpha.29: translator activity (migration 019) ──
  /**
   * Per-call SectionRewrite[] captured at compile time. Omitted (sent as
   * undefined → stored NULL) when no rewrites fired. Powers cross-app
   * learning aggregates ("rule X fired N times on (app, model, archetype),
   * downstream outcome quality lifted by M points").
   */
  section_rewrites_applied?: import('./ir.js').SectionRewrite[] | null;
  // ── alpha.68 / Release A: delegation-fanout linkage + discipline gate
  //    accounting (migration 042) ──
  /**
   * R0 linkage (§5.0). Parent call's handle when this row is a fan-out branch;
   * key OMITTED (undefined → dropped by JSON.stringify → stored NULL) for a
   * root, safe against pre-042 brains.
   */
  parent_handle?: string;
  /**
   * R0 linkage (§5.0). Root handle of the fan-out trace (= parent_handle when a
   * branch, else this row's own handle). Emitted for every registered compile.
   */
  trace_id?: string;
  /**
   * R0 linkage (§5.0). root | branch | composer. Emitted for every registered
   * compile; surface baselines filter to root/NULL so branch traffic never
   * contaminates a promotion/eval baseline. Release A emits only root/branch.
   */
  fanout_role?: 'root' | 'branch' | 'composer';
  /**
   * RD discipline gate-token accounting (§5.D). Measured token tax of the
   * discipline_contract gate block; 0 when the gate didn't fire.
   */
  discipline_gate_tokens?: number;
}

/**
 * alpha.113 — the fingerprint of the key a self-instantiating consumer most
 * plausibly served `modelId` with (tt-intelligence 2026-09-15). Provider from
 * the bundled profile (or the id's shape), key from the provider's env names,
 * ONLY when every present name agrees; otherwise undefined — never a guess.
 * `call()` users never reach this: they carry the key they actually used.
 */
export function deriveKeyFingerprint(
  modelId: string | undefined,
  envSource?: Record<string, string | undefined>,
): string | undefined {
  if (!modelId) return undefined;
  const provider = tryGetProfile(modelId)?.provider ?? inferProviderFromId(modelId);
  if (!provider) return undefined;
  const { key } = resolveProviderKeyUnambiguous(provider, envSource);
  return key ? keyFingerprintSync(key) : undefined;
}

function buildPayload(input: RecordInput, reg: CompileRecord | undefined): OutcomePayload {
  // s11 truth-in-logging: when consumer reports actualModel different from
  // the compile target, the brain stores the actual as `model` and the
  // compile target as `requested_model`. When actualModel matches (or is
  // omitted), `model` IS the truth — no need to populate `requested_model`.
  const compileTarget = reg?.model;
  const actual = input.actualModel ?? compileTarget;
  const requested =
    input.actualModel && compileTarget && input.actualModel !== compileTarget
      ? compileTarget
      : undefined;

  // alpha.4: input.mutationsApplied (when set by call() on fallback) overrides
  // the registered initial-compile mutations. Without this, fallback rows
  // attribute mutations to the wrong compile.
  const mutationsApplied = input.mutationsApplied ?? reg?.mutationsApplied ?? [];

  // alpha.129 — cost_usd_actual is the finished call priced at its tier
  // (priceAtInput on the profile; the brain pricing row keeps the base) with
  // its cache reads at the cache-read price, read the way the WIRE's
  // normalizer counted tokens_in: Anthropic's input excludes the reads, Google
  // and the OpenAI-compatible wire (OpenRouter included, whatever the model's
  // vendor) include them. Cache writes are not priced (R3). Rows written
  // before alpha.129 are list × tokens — split a series by library_version.
  // NULL when the model has no price or both token counts are zero.
  const costModel = actual;
  const route = input.route ?? reg?.route ?? 'direct';
  const servedProvider = (actual ? tryGetProfile(actual)?.provider : undefined) ?? reg?.provider;
  const costUsdActual = costModel
    ? computeCostUsd(costModel, route === 'openrouter' ? 'openrouter' : servedProvider, {
        in: input.tokensIn,
        out: input.tokensOut,
        cached: input.cacheReadInputTokens,
        cacheCreated: input.cacheCreationInputTokens,
      })
    : undefined;

  // alpha.28 — fallback metadata. `requested` (computed above) covers the
  // legacy `requested_model` column. For migration-018 columns, `fellOverFrom`
  // is the explicit "model originally targeted" — falls back to `requested`
  // when consumer omitted it (the two are aliases when a true fallback fired).
  const fellOverFrom = input.fellOverFrom ?? requested;
  const fallbackReason = fellOverFrom ? input.fallbackReason : undefined;

  return {
    handle: input.handle,
    app_id: reg?.appId,
    intent_archetype: reg?.archetype,
    model: actual,
    requested_model: requested,
    // alpha.118 §C — the provider that SERVED this row, resolved from the
    // served model (`input.actualModel ?? reg.model`). Through alpha.117 a
    // fell-over row copied the registry's provider — the REQUESTED model's,
    // registered at compile time — next to the served model (brain probe
    // 2026-09-30: 14 playbacksam rows in 30 d). Registry provider when the
    // served model is not a bundled profile.
    provider: servedProvider,
    shape_key: reg?.shapeKey,
    learning_key: reg?.learningKey,
    // alpha.92 (migration 067) — route identity on every row. Input wins
    // (a manual record() replaying through a gateway states its own route);
    // registry fills the call() path; column default covers legacy writers.
    route,
    route_host: input.routeHost,
    // alpha.105 (migration 074) — what the provider said it served, verbatim.
    // Through alpha.104 `servedBy` was the model kgauto ASKED for; the brain
    // could not tell a gateway substitution from a direct call (L-073 class).
    served_model: input.servedModel,
    mutations_applied: mutationsApplied,
    tokens_in: input.tokensIn,
    tokens_out: input.tokensOut,
    estimated_tokens_in: reg?.estimatedTokensIn,
    // alpha.106 (migration 075) — the receipt, from the registry (compile
    // time), so both call() and consumer-side record() paths carry it. Absent
    // (not 0) when the handle was never registered — a zero here is a claim.
    input_tokens_as_given: reg?.savings?.inputTokensAsGiven,
    input_tokens_removed: reg?.savings?.inputTokensRemoved,
    estimated_usd_saved: reg?.savings?.estimatedUsdSavedFirstCall,
    latency_ms: input.latencyMs,
    success: input.success,
    // alpha.100 — `&& input.success`. Without it this is a TAUTOLOGY on every
    // failure row: a failed call has no output tokens by definition, so every
    // 429, auth error and timeout was stamped "empty response". Measured
    // 2026-08-30: of 169 rows carrying the flag, 157 were failures with a real
    // error_type (92 rate_limit, 24 auth, 13 timeout, …) and ALL had
    // tokens_out=0 — the flag was describing the error, not the response. The
    // genuine population (a served 200 that carried nothing usable) was 12.
    // The field's own doc said "despite success" all along; the code didn't.
    empty_response: input.emptyResponse ?? (input.success && input.tokensOut === 0),
    // alpha.87 — explicit source wins; KGAUTO_SOURCE env fills the gap (the
    // zero-code synthetic self-mark for harness/smoke processes).
    source: resolveOutcomeSource(input.source),
    // 128-char truncation is the write-side contract (documented on the
    // type); an id that long is almost certainly a mistake, not identity.
    end_user_id: input.endUserId ? String(input.endUserId).slice(0, 128) : undefined,
    error_type: input.errorType,
    tools_called: input.toolsCalled,
    oracle_score: input.oracleScore?.score,
    oracle_dimensions: input.oracleScore?.dimensions,
    oracle_rationale: input.oracleScore?.rationale,
    prompt_preview: input.promptPreview,
    response_preview: input.responsePreview,
    dialect_version: 'v1',
    // alpha.109 — time-to-first-use per release (org decision 3, 2026-09-07)
    // needs the row to say which library wrote it; `dialect_version` is the
    // IR dialect ('v1' for every row ever) and never carried it.
    library_version: LIBRARY_VERSION,
    cache_read_input_tokens: input.cacheReadInputTokens,
    cache_creation_input_tokens: input.cacheCreationInputTokens,
    cost_usd_actual: costUsdActual,
    ttft_ms: input.ttftMs,
    history_cacheable_tokens: reg?.historyCacheableTokens,
    // alpha.57 (data-first): input wins over compile-declared; undefined
    // end-to-end -> key absent from the JSON body entirely (safe against
    // brains that haven't applied migration 033 yet).
    effort: input.effort ?? reg?.effortFromCompile,
    history_tokens_at_compile: reg?.historyTokensTotal,
    // alpha.20 E3: mirror consumer's declared tool-orchestration mode so
    // the brain can measure per-mode model perf separately (DeepSeek in
    // sequential vs parallel mode is two different stories — L-040).
    // Null when consumer hadn't adopted the constraint yet.
    tool_orchestration: reg?.toolOrchestration ?? null,
    // alpha.28 — Glass-Box renderer substrate (migration 018). All optional;
    // omitted-undefined PostgREST inserts store NULL → renderer renders "—".
    finish_reason: input.finishReason,
    total_ms: input.totalMs ?? input.latencyMs,
    tools_count: input.toolsCount ?? reg?.toolsCount,
    history_depth: input.historyDepth ?? reg?.historyDepth,
    system_prompt_chars: input.systemPromptChars ?? reg?.systemPromptChars,
    fell_over_from: fellOverFrom,
    fallback_reason: fallbackReason,
    // alpha.71 — migration 044. The PRECISE code behind `fallback_reason`,
    // which collapses two opposite-remedy failures into 'cliff'. Omitted
    // (not null) when no fallback fired, so pre-044 brains never see the key.
    fell_over_error_code: fellOverFrom ? input.fellOverErrorCode : undefined,
    fallback_class: fellOverFrom ? input.fellOverClass : undefined,
    quota_id: fellOverFrom ? input.fellOverQuotaId : undefined,
    // alpha.113 — a consumer that instantiates its own models never hands
    // kgauto the key; derive the fingerprint from the served model's provider
    // and the env, when (and only when) the env is unambiguous about it.
    key_fingerprint: input.keyFingerprint ?? deriveKeyFingerprint(actual),
    // alpha.66 — omitted-undefined keeps the key out of the JSON body
    // entirely for non-retry rows (pre-migration-039 brain safety).
    retried_same_model: input.retriedSameModel,
    // alpha.29 — translator activity (migration 019). Send NULL when no
    // rewrites fired so the brain's "did the translator do anything?"
    // queries can use `IS NOT NULL` cleanly.
    section_rewrites_applied:
      reg?.sectionRewritesApplied && reg.sectionRewritesApplied.length > 0
        ? reg.sectionRewritesApplied
        : null,
    // alpha.68 / Release A (§5.0 + §5.D, migration 042) — auto-enrich the
    // fan-out linkage + discipline gate tax from the registered compile.
    // Omit-when-undefined (JSON.stringify drops undefined keys), same posture as
    // `effort` / `retried_same_model` → safe against pre-042 brains. A registered
    // compile always carries trace_id + fanout_role + discipline_gate_tokens
    // (root/0 for ordinary traffic); parent_handle is present only for branches.
    parent_handle: reg?.parentHandle,
    trace_id: reg?.traceId,
    fanout_role: reg?.fanoutRole,
    discipline_gate_tokens: reg?.disciplineGateTokens,
  };
}

/**
 * alpha.129 — the meaning of `tokens.input` per wire normalizer (execute.ts):
 * Anthropic `usage.input_tokens` EXCLUDES cache reads; Google
 * `promptTokenCount` and the OpenAI-compatible `prompt_tokens` INCLUDE them.
 */
const CACHE_READS_INCLUDED_IN_INPUT: ReadonlySet<string> = new Set([
  'google',
  'openai',
  'deepseek',
  'zai',
  'moonshot',
  'openrouter',
]);

/**
 * The cost of a finished call, USD, rounded to 6 decimals (numeric(10,6)).
 *
 * alpha.129 — what the number is:
 * - **Input and output** at the price for this request's length: the brain
 *   pricing row (`resolvePricingAt`) is the base when present and non-zero
 *   (alpha.11: a price change without a release), else the profile; above a
 *   profile tier's `overInputTokens` the tier's figures price the call (R2).
 *   The step is chosen on the prompt as the page bills it (R-A): on a direct
 *   Anthropic wire `in + cached + cacheCreated` (its `input_tokens` excludes
 *   both); on a Google or OpenAI-shaped wire `in` (the count includes the reads).
 * - **Cache reads** at the cache-read price, per the wire's meaning of
 *   `tokens.in` — `provider` is the wire's ('openrouter' on that route):
 *   Anthropic: billable input = `in`, plus `cached × cacheRead`; Google and
 *   OpenAI-compatible: billable input = `in − cached`, plus `cached × cacheRead`.
 *   cacheRead = the applying tier's `cacheReadPer1m`, else the brain row's
 *   `cacheInputPer1m`, else `profile.costInputPer1m × lowering.cache.discount`.
 *   No known cache-read price, or a provider whose meaning is unknown → the
 *   reads are not split out (the pre-alpha.129 arithmetic for that row).
 * - **Cache writes** (`cacheCreated`) are NOT priced (R3: the row does not say
 *   which TTL was written); on Anthropic they only move the step (R-A).
 *
 * Undefined when the model has no price, or both token counts are zero.
 */
export function computeCostUsd(
  modelId: string,
  provider: string | undefined,
  tokens: { in: number; out: number; cached?: number; cacheCreated?: number },
): number | undefined {
  if (tokens.in === 0 && tokens.out === 0) return undefined;
  // Per qa-shepherd review of PR #15 (M3): a brain row of {0, 0} would
  // silently zero out cost telemetry for a paid model; fall through.
  const brainRow = resolvePricingAt(modelId);
  const brainBase = brainRow && (brainRow.costInputPer1m > 0 || brainRow.costOutputPer1m > 0) ? brainRow : undefined;
  const profile = tryGetProfile(modelId);
  if (!brainBase && !profile) return undefined;

  const cached = typeof tokens.cached === 'number' && tokens.cached > 0 ? tokens.cached : 0;
  const readsExcluded = provider === 'anthropic';
  const readsIncluded = provider !== undefined && CACHE_READS_INCLUDED_IN_INPUT.has(provider);

  // R-A — the step reads the prompt as the page bills it, whatever is split out below.
  const created = typeof tokens.cacheCreated === 'number' && tokens.cacheCreated > 0 ? tokens.cacheCreated : 0;
  const stepInput = readsExcluded ? tokens.in + cached + created : tokens.in;
  const at = profile ? priceAtInput(profile, stepInput) : undefined;
  const tier =
    at?.overInputTokens !== undefined
      ? profile!.costTiers?.find((t) => t.overInputTokens === at.overInputTokens)
      : undefined;
  const base = tier ?? brainBase ?? profile!;
  const discount = profile?.lowering.cache.discount;
  const cacheRead =
    tier?.cacheReadPer1m ??
    brainRow?.cacheInputPer1m ??
    (profile && discount !== undefined && discount > 0 ? profile.costInputPer1m * discount : undefined);
  const price = { inPer1m: base.costInputPer1m, outPer1m: base.costOutputPer1m, cacheRead };

  let billableInput = tokens.in;
  let cachedPriced = 0;
  if (cached > 0 && (readsExcluded || readsIncluded) && cacheRead !== undefined) {
    billableInput = readsIncluded ? Math.max(0, tokens.in - cached) : tokens.in;
    cachedPriced = cached;
  }
  const usd =
    (billableInput / 1_000_000) * price.inPer1m +
    (cachedPriced / 1_000_000) * (price.cacheRead ?? 0) +
    (tokens.out / 1_000_000) * price.outPer1m;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/**
 * alpha.20: extract the outcome_id from the primary `/outcomes` POST
 * response. PostgREST with `Prefer: return=representation` returns the
 * inserted row(s) — typically `[{id, ...}]`, sometimes (proxy-shaped)
 * `{id, ...}`. Tolerant: returns undefined on any parse failure so the
 * secondary advisory POST silently skips.
 */
async function tryExtractOutcomeId(res: Response): Promise<number | undefined> {
  try {
    // Defensive: some test fetch mocks omit headers entirely.
    const ct = res.headers?.get?.('content-type') ?? '';
    // Best-effort: when content-type is absent, still attempt JSON parse
    // (real PostgREST always sends application/json). The try/catch wraps.
    if (ct && !ct.includes('application/json')) return undefined;
    if (typeof res.json !== 'function') return undefined;
    const body = (await res.json()) as unknown;
    if (Array.isArray(body) && body.length > 0) {
      const first = body[0] as Record<string, unknown> | undefined;
      const id = first?.id;
      if (typeof id === 'number') return id;
    } else if (body && typeof body === 'object') {
      const id = (body as Record<string, unknown>).id;
      if (typeof id === 'number') return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * alpha.20: shape an in-memory `BestPracticeAdvisory` into the brain row
 * shape (snake_case columns matching migration 014). `recommendationType`
 * is optional → omitted when absent; `suggestion` and `docsUrl` similarly
 * optional.
 */
function buildAdvisoryRow(
  outcomeId: number,
  a: BestPracticeAdvisory,
): {
  outcome_id: number;
  code: string;
  level: 'info' | 'warn' | 'critical';
  message: string;
  recommendation_type: string | null;
  suggestion: string | null;
  docs_url: string | null;
  rule_version: string;
} {
  // alpha.59 — optional fields are ALWAYS present (null when absent), never
  // conditionally spread: PostgREST bulk inserts require every object in the
  // array to carry identical keys (PGRST102 "All object keys must match"
  // rejects the WHOLE batch otherwise). A record() carrying one advisory
  // with `suggestion` and one without silently dropped BOTH rows on the
  // best-effort secondary — reachable in prod since alpha.56 un-dormanted
  // the advisory JOIN for factory mounts; caught by smoke-brain-timeout's
  // first real run. All three columns are original to migration 014, so
  // explicit nulls are safe against every brain that has the table.
  return {
    outcome_id: outcomeId,
    code: a.code,
    level: a.level,
    // alpha.81 (tt-intel s118, migration 053) — the emitting library version.
    // A corrected rule cannot rewrite firings that are already open, so a
    // consumer reading a stale suggestion had no way to tell it predated the
    // fix. tt-intel spent two hours on exactly that. NULL on pre-053 rows
    // reads as UNKNOWN; from here every firing self-identifies.
    rule_version: LIBRARY_VERSION,
    message: a.message,
    recommendation_type: a.recommendationType ?? null,
    suggestion: a.suggestion ?? null,
    docs_url: a.docsUrl ?? null,
  };
}

/**
 * alpha.20 Entry 4: record a quality outcome for a previously-compiled call.
 *
 * Fires after the consumer's UX surfaces an approve/reject event (e.g., user
 * clicks Approve on a hunt result). Joins to the original `compile_outcomes`
 * row via outcomeId — enables per-(model, archetype) approve-rate measurement
 * once N ≥ 10 outcomes accumulate.
 *
 * Fire-and-forget by default (matches record() semantics). Set BrainConfig.sync
 * = true for runtime contexts that can't tolerate fire-and-forget teardown
 * (Vercel Edge, Cloudflare Workers, AWS Lambda) — see L-086.
 *
 * Returns (alpha.61): `{ok: true}` only when the POST was acknowledged 2xx
 * (sync mode); `{ok: 'queued'}` in fire-and-forget mode (handed to the
 * runtime, NOT acked — read `brainHealth()` for delivery evidence);
 * `{ok: false, reason}` on known failure. Never throws.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<OutcomeResult> {
  if (!activeConfig) {
    // No brain configured — quietly drop. Allows local dev / tests without setup.
    return { ok: false, reason: 'brain_not_configured' };
  }

  const config = activeConfig;
  const fetchFn = brainWriteFetch(config);

  const payload = {
    outcome_id: input.outcomeId,
    outcome: input.outcome,
    rating: input.rating ?? null,
    reason: input.reason ?? null,
    observed_confidence: input.observedConfidence ?? null,
  };

  const send = async (): Promise<OutcomeResult> => {
    noteSent();
    try {
      const res = await fetchFn(`${config.endpoint}/compile_outcome_quality`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      assertNotRedirected(res, 'compile_outcome_quality');
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(
          describeBrainWriteFailure(res.status, 'compile_outcome_quality', text),
        );
      }
      noteAck();
      maybeAutoFlush();
      return { ok: true };
    } catch (err) {
      noteFailure(err);
      pushDeadLetter('compile_outcome_quality', config.endpoint, payload, err);
      (config.onError ?? defaultOnError)(err);
      return { ok: false, reason: 'persistence_failed' };
    }
  };

  if (config.sync) {
    return send();
  }
  // Fire-and-forget: kick off but don't await. Per L-086, sync=true is the
  // escape hatch for runtimes that tear down between resolve and microtask.
  //
  // alpha.61 (G1): the fire-and-forget return is `{ok: 'queued'}`, NOT
  // `{ok: true}` — "queued" means handed to the runtime, not acknowledged by
  // the brain. Pre-alpha.61 this returned a false `{ok: true}` before the
  // POST even fired, contradicting the docstring and hiding every transport
  // failure (2026-07-17 review, N4). `'queued'` is truthy, so existing
  // `if (result.ok)` consumer checks keep working; consumers that need
  // delivery evidence use `sync: true` or read `brainHealth()`.
  void send();
  return { ok: 'queued' };
}

/**
 * True when the active brain config requests synchronous (awaited) writes.
 * call()'s shadow-probe path reads this to decide whether to await the probe
 * (Edge/Worker/Lambda — L-086) or fire-and-forget (Node). False when no brain
 * is configured.
 */
export function isBrainSync(): boolean {
  return activeConfig?.sync === true;
}

/**
 * Full-IR inline shadow-probe record input (Shape B, Phase 1 — s51). Carries
 * ONLY response previews + metadata; the prompt (system/context/payload) is
 * never included — `promptHash` is an irreversible grouping key, not content.
 */
export interface ShadowProbeRecordInput {
  appId: string;
  archetype: string;
  family: string;
  candidateModel: string;
  currentModel: string;
  /** Irreversible grouping hash (NOT the prompt). */
  promptHash: string;
  /** Served model's response, truncated (RESPONSE text only — never the prompt). */
  currentResponsePreview?: string;
  /** Candidate model's response, truncated. */
  candidateResponsePreview?: string;
  tokensCurrentIn?: number;
  tokensCurrentOut?: number;
  tokensCandidateIn?: number;
  tokensCandidateOut?: number;
  /**
   * Wall-clock latency of the served call, ms (alpha.46). The third swap-decision
   * axis alongside quality + cost — a verdict needs to know the candidate is
   * slower, not just better/cheaper. Served latency mirrors
   * `compile_outcomes.latency_ms`; carried here so a probe row is self-contained.
   */
  latencyCurrentMs?: number;
  /** Wall-clock latency of the candidate replay call, ms (alpha.46). */
  latencyCandidateMs?: number;
  /**
   * alpha — probe-row class (migration 029; `candidate_error` added by 032).
   * Defaults to `'completed'` (the pre-029 row shape: candidate ran, columns
   * populated). `'aborted_latency_budget'` and `'skipped_slow_tier_sync'` are
   * DIAGNOSTIC rows from sync-mode latency protection; `'candidate_error'`
   * (alpha.53) is the failed-candidate diagnostic — the candidate call
   * errored, with the error class + latency-at-death recorded instead of
   * silence (the IC demo-night probe deaths were invisible for ~90 min under
   * the old record-no-row rule). Diagnostic rows carry no candidate response
   * and no verdict — no false quality signal. A verdict rollup MUST filter to
   * `outcome='completed'`.
   */
  outcome?:
    | 'completed'
    | 'aborted_latency_budget'
    | 'skipped_slow_tier_sync'
    | 'candidate_error';

  /**
   * alpha.53 (migration 032) — error class for `outcome='candidate_error'`
   * rows. Values follow execute()'s taxonomy (`rate_limit`, `timeout`,
   * `server_error`, `model_not_found`, `auth`, `invalid_request`, `unknown`)
   * plus `execute_rejected` (the execute promise rejected outright). NULL /
   * omitted on all other row classes.
   */
  errorClass?: string;
}

/**
 * Pure builder for the `probe_outcomes` row written by the inline shadow-probe.
 * Exported so a test can assert the G3 privacy invariant: the row carries NO
 * prompt/system/context text — only response previews + metadata + a hash.
 *
 * Phase 1 (judge: 'off'): `judge_verdict` / `judge_score` are null — the row
 * is an unjudged sample for the Phase-2 offline batch judge. `prompt_fidelity`
 * is 1.0 by construction (the candidate ran the full IR, not a truncated
 * preview), and `replay_source='inline-full-ir'` marks it as a trustworthy row
 * (vs the watchers' lossy `replay-preview`).
 */
export function buildShadowProbeRow(input: ShadowProbeRecordInput): {
  app_id: string;
  intent_archetype: string;
  family: string;
  candidate_model: string;
  current_model: string;
  prompt_hash: string;
  current_response: string | null;
  candidate_response: string | null;
  judge_verdict: null;
  judge_score: null;
  tokens_current_in: number | null;
  tokens_current_out: number | null;
  tokens_candidate_in: number | null;
  tokens_candidate_out: number | null;
  latency_current_ms: number | null;
  latency_candidate_ms: number | null;
  prompt_fidelity: number;
  replay_source: 'inline-full-ir';
  evidence_basis: 'controlled';
  outcome:
    | 'completed'
    | 'aborted_latency_budget'
    | 'skipped_slow_tier_sync'
    | 'candidate_error';
  error_class: string | null;
} {
  return {
    app_id: input.appId,
    intent_archetype: input.archetype,
    family: input.family,
    candidate_model: input.candidateModel,
    current_model: input.currentModel,
    prompt_hash: input.promptHash,
    current_response: input.currentResponsePreview ?? null,
    candidate_response: input.candidateResponsePreview ?? null,
    judge_verdict: null,
    judge_score: null,
    tokens_current_in: input.tokensCurrentIn ?? null,
    tokens_current_out: input.tokensCurrentOut ?? null,
    tokens_candidate_in: input.tokensCandidateIn ?? null,
    tokens_candidate_out: input.tokensCandidateOut ?? null,
    latency_current_ms: input.latencyCurrentMs ?? null,
    latency_candidate_ms: input.latencyCandidateMs ?? null,
    // Full IR was replayed (not a truncated preview), so fidelity is 1.0 — the
    // prompt-fidelity guard never fires on these rows.
    prompt_fidelity: 1.0,
    replay_source: 'inline-full-ir',
    // alpha.93 (migration 068) — shadow probes replay the SAME full IR to
    // the candidate: controlled by construction. Written at write time, per
    // the mig-057 lesson (a marker inferred later can disagree with itself).
    // The column default is 'observational' precisely so only writers that
    // KNOW they are controlled say so.
    evidence_basis: 'controlled',
    // alpha — migration 029. 'completed' is the default completed-probe shape;
    // diagnostic rows (aborted/skipped/errored) pass the explicit class.
    outcome: input.outcome ?? 'completed',
    // alpha.53 — migration 032. Populated only on candidate_error rows.
    // Self-proxying consumers must whitelist `error_class` (and `outcome`,
    // per the alpha.51 PB finding) or diagnostic rows degrade silently.
    error_class: input.errorClass ?? null,
  };
}

/**
 * Persist one inline shadow-probe row to `probe_outcomes`. Fire-and-forget by
 * default; honors `BrainConfig.sync` (L-086). Never throws — failures route to
 * onError. Mirrors record()'s POST shape; consumer proxies forward
 * `/probe_outcomes` the same way they forward `/outcomes`.
 */
export async function recordShadowProbe(input: ShadowProbeRecordInput): Promise<void> {
  if (!activeConfig) return;
  const config = activeConfig;
  const fetchFn = brainWriteFetch(config);
  const row = buildShadowProbeRow(input);

  const send = async (): Promise<void> => {
    noteSent();
    try {
      const res = await fetchFn(`${config.endpoint}/probe_outcomes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(row),
      });
      assertNotRedirected(res, 'probe_outcomes');
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(describeBrainWriteFailure(res.status, 'probe_outcomes', text));
      }
      noteAck();
      maybeAutoFlush();
    } catch (err) {
      noteFailure(err);
      pushDeadLetter('probe_outcomes', config.endpoint, row, err);
      (config.onError ?? defaultOnError)(err);
    }
  };

  if (config.sync) {
    await send();
  } else {
    void send();
  }
}

/**
 * Peek the compile-time shape key for a handle WITHOUT consuming the registry
 * entry (record() pops single-use — callers that need the shape after record()
 * must peek first). alpha.62: used by call()'s golden-capture hook.
 */
export function peekRegisteredShapeKey(handle: string): string | undefined {
  return compileRegistry.get(handle)?.shapeKey;
}

// ─────────────────────────────────────────────────────────────────────────
// Golden-set capture (alpha.62, eval spine — migration 036)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Golden-IR capture input. UNLIKE every other brain write, this row carries the
 * RAW full PromptIR — an explicit, documented posture change from the s51
 * "brain holds no raw consumer prompts" rule, gated on consumer opt-in
 * (`KGAUTO_GOLDEN_CAPTURE` env / `CallOptions.goldenCapture`). The `consent`
 * field records the provenance of that opt-in at capture time.
 */
export interface GoldenIrRecordInput {
  appId: string;
  archetype: string;
  /** hashShape() of the call at compile time (peek before record() pops). */
  shapeKey?: string;
  /** The full PromptIR, verbatim. Plain JSON by construction (ir.ts). */
  ir: unknown;
  incumbentModel: string;
  incumbentOutput?: string;
  incumbentLatencyMs?: number;
  incumbentTokensIn?: number;
  incumbentTokensOut?: number;
  /** 'sampled' (capture flag fired on live traffic) | 'curated' (operator). */
  source: 'sampled' | 'curated';
  /** Consent provenance, e.g. 'KGAUTO_GOLDEN_CAPTURE=0.1 (consumer env opt-in)'. */
  consent: string;
  /** Optional link back to the compile handle of the captured call. */
  outcomeHandle?: string;
}

/** Pure builder for the `kgauto_golden_irs` row (snake_case wire shape). */
export function buildGoldenIrRow(input: GoldenIrRecordInput): {
  app_id: string;
  intent_archetype: string;
  shape_key: string | null;
  ir: unknown;
  incumbent_model: string;
  incumbent_output: string | null;
  incumbent_latency_ms: number | null;
  incumbent_tokens_in: number | null;
  incumbent_tokens_out: number | null;
  source: 'sampled' | 'curated';
  consent: string;
  outcome_handle: string | null;
} {
  return {
    app_id: input.appId,
    intent_archetype: input.archetype,
    shape_key: input.shapeKey ?? null,
    ir: input.ir,
    incumbent_model: input.incumbentModel,
    incumbent_output: input.incumbentOutput ?? null,
    incumbent_latency_ms: input.incumbentLatencyMs ?? null,
    incumbent_tokens_in: input.incumbentTokensIn ?? null,
    incumbent_tokens_out: input.incumbentTokensOut ?? null,
    source: input.source,
    consent: input.consent,
    outcome_handle: input.outcomeHandle ?? null,
  };
}

/**
 * Persist one golden IR to `kgauto_golden_irs`. Same G1 write-leg discipline as
 * every other brain route (redirect check, ledger, dead-letter); fire-and-forget
 * by default, honors `BrainConfig.sync`. Never throws.
 */
export async function recordGoldenIr(input: GoldenIrRecordInput): Promise<void> {
  if (!activeConfig) return;
  const config = activeConfig;
  const fetchFn = brainWriteFetch(config);
  const row = buildGoldenIrRow(input);

  const send = async (): Promise<void> => {
    noteSent();
    try {
      const res = await fetchFn(`${config.endpoint}/golden_irs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(row),
      });
      assertNotRedirected(res, 'golden_irs');
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(describeBrainWriteFailure(res.status, 'golden_irs', text));
      }
      noteAck();
      maybeAutoFlush();
    } catch (err) {
      noteFailure(err);
      pushDeadLetter('golden_irs', config.endpoint, row, err);
      (config.onError ?? defaultOnError)(err);
    }
  };

  if (config.sync) {
    await send();
  } else {
    void send();
  }
}

/** Test helper: drain pending registry + reset the delivery ledger/dead-letter. */
export function _testReset(): void {
  compileRegistry.clear();
  activeConfig = undefined;
  configureBrainQuery(undefined);
  configurePromotionsBrain(undefined);
  configureMeasuredFailureBrain(undefined);
  ledger.sent = 0;
  ledger.acked = 0;
  ledger.failed = 0;
  ledger.redirected = 0;
  ledger.lastAckAt = undefined;
  ledger.lastFailureAt = undefined;
  ledger.lastFailure = undefined;
  deadLetter.length = 0;
  flushing = false;
}
