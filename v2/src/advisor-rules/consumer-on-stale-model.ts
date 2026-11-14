/**
 * consumer-on-stale-model — alpha.41 Builder C advisor rule.
 *
 * Fires at compile() time when the `kgauto-model-version-watch` cron has
 * written an open `actionable_advisories_v` row for this (app_id, archetype)
 * tuple with rule='consumer-on-stale-model'. The cron detects when a
 * consumer's recent traffic is firing a model whose `kgauto_models.status`
 * is `'legacy'` or `'deprecated'` while a newer current model exists in the
 * same family.
 *
 * Substrate path:
 *   1. Daily cron (`v2/scripts/model-version-watch.mjs`) scans
 *      `compile_outcomes` over the last 7d. For each (app_id, archetype,
 *      model) tuple with n >= 5 calls, looks up `kgauto_models.status` for
 *      that model. If legacy/deprecated AND a newer-current alternative
 *      exists in the same family, inserts a firing row into
 *      `compile_outcome_advisories` (attached to a representative recent
 *      outcome) so the `actionable_advisories_v` view rolls it up.
 *   2. The s46 `kgauto-advisory-auto-resolver` cron will auto-resolve the
 *      finding when the (app_id, archetype, model) tuple stops appearing
 *      in recent traffic — same uniform predicate as alpha.39+ rules.
 *   3. This compile-time rule reads from a per-(appId) SWR cache populated
 *      from a dashboard endpoint that filters `actionable_advisories_v` to
 *      `rule='consumer-on-stale-model'` AND `status='open'`. Surfaces the
 *      finding as a warn-level `BestPracticeAdvisory` so consumers see it
 *      in `result.advisories[]` without polling the brain themselves.
 *
 * Mirrors `exclusion-findings-brain.ts` shape (alpha.38 substrate): same
 * SWR cache, same per-appId snapshot, same opt-in via configure runtime,
 * same defensive empty fallback when brain unavailable.
 *
 * Severity: `warn`. The advisory is not a hard error — the consumer's calls
 * still succeed against the legacy model — but the model is structurally
 * stale and the same family has a current alternative. Warn-level fits the
 * "you're paying a maintenance tax" shape; consumers who want it silenced
 * can mark the finding handled via the alpha.29 `markAdvisoryResolved` API
 * (since the underlying row lives in `compile_outcome_advisories`).
 *
 * Driven by the alpha.41 Phase 0 design contract
 * (`advisory/kgauto/2026-05-26_alpha-41-model-family-aliases-and-promotion-probe-watcher.md`)
 * — collapses IC's two asks (model-version-watch sentry + `getRecommendedPrimary`)
 * into a single substrate: cron detects, advisor surfaces.
 */

import type { BestPracticeAdvisory, PromptIR } from '../ir.js';
import type { ModelProfile } from '../profiles.js';
import { tryGetProfile, lifecycleOnTheWayOut, providerDisplayName, retirementFloorClause } from '../profiles.js';
import { deriveFamilyFromModelId, getRecommendedPrimary } from '../family-resolution.js';
import { getDefaultFallbackChain, chainHeadGroundingWord, chainHeadReplaced } from '../fallback.js';

// ─────────────────────────────────────────────────────────────────────────
// Public row shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * One stale-model finding for an (app_id, archetype, model) tuple.
 * Camel-case in-memory shape; snake_case wire shape is mapped at the
 * boundary (rowToFinding) per L-118.
 */
export interface StaleModelFindingRow {
  /** Intent archetype the finding applies to (e.g. 'generate', 'hunt'). */
  archetype: string;
  /** The legacy/deprecated model id the consumer is currently firing. */
  staleModel: string;
  /** Provider of the stale model (e.g. 'anthropic', 'google'). */
  staleProvider: string;
  /** Status of the stale model: 'legacy' or 'deprecated'. */
  staleStatus: 'legacy' | 'deprecated';
  /** Recommended replacement: the latest current model in the same family. */
  recommendedModel: string;
  /** Family name (e.g. 'claude-opus', 'gemini-flash'). */
  family: string;
  /** Renderable summary; produced by the cron. */
  message: string;
  /** Optional actionable recommendation; produced by the cron. */
  suggestion?: string;
  /** Optional observation count (how many calls fired the stale model in window). */
  observationCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Wire shape + boundary transformer (L-118)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Snake-case wire shape returned by the dashboard endpoint. Mirrors the
 * `actionable_advisories_v` view projection filtered to
 * rule='consumer-on-stale-model' with the cron's structured-message fields.
 */
interface RawStaleModelRow {
  intent_archetype?: unknown;
  stale_model?: unknown;
  stale_provider?: unknown;
  stale_status?: unknown;
  recommended_model?: unknown;
  family?: unknown;
  message?: unknown;
  suggestion?: unknown;
  observation_count?: unknown;
  // The view may surface these aliases instead; tolerate both shapes.
  applies_to_archetype?: unknown;
  applies_to_model?: unknown;
}

function isStaleStatus(v: unknown): v is 'legacy' | 'deprecated' {
  return v === 'legacy' || v === 'deprecated';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function mapRowsToFindings(rows: unknown[]): StaleModelFindingRow[] {
  const out: StaleModelFindingRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as RawStaleModelRow;
    const archetype =
      asString(r.intent_archetype) ?? asString(r.applies_to_archetype);
    const staleModel = asString(r.stale_model) ?? asString(r.applies_to_model);
    const staleProvider = asString(r.stale_provider);
    const recommendedModel = asString(r.recommended_model);
    const family = asString(r.family);
    const message = asString(r.message);
    if (!archetype || !staleModel || !recommendedModel || !family || !message) {
      continue;
    }
    if (!isStaleStatus(r.stale_status)) continue;
    const row: StaleModelFindingRow = {
      archetype,
      staleModel,
      staleProvider: staleProvider ?? 'unknown',
      staleStatus: r.stale_status,
      recommendedModel,
      family,
      message,
    };
    const suggestion = asString(r.suggestion);
    if (suggestion) row.suggestion = suggestion;
    if (typeof r.observation_count === 'number' && Number.isFinite(r.observation_count)) {
      row.observationCount = r.observation_count;
    }
    out.push(row);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-(appId) SWR cache (mirrors exclusion-findings-brain.ts)
// ─────────────────────────────────────────────────────────────────────────

interface AppSnapshot {
  data: StaleModelFindingRow[];
  expiresAt: number;
  refreshing: boolean;
}

const snapshots = new Map<string, AppSnapshot>();

/**
 * Internal runtime config. Set by `configureStaleModelFindingsBrain()`.
 * The library-public wire-up call lives on Builder A's brain.ts (out of
 * Builder C's scope); test wiring uses this directly.
 */
export interface StaleModelFindingsRuntime {
  /** Endpoint base URL. The library appends `?app_id=<id>`. */
  endpoint: string;
  /** Stale-while-revalidate window in ms. */
  ttlMs: number;
  /** Pluggable fetch. */
  fetchImpl: typeof fetch;
  /** Optional warn hook. */
  onError?: (err: unknown) => void;
}

let runtime: StaleModelFindingsRuntime | undefined;
let warnedOnce = false;
let pendingRefreshes = new Map<string, Promise<void>>();

/**
 * Default endpoint hosted on the kgauto-dashboard. Public read; data
 * carries no PII (app id, archetype, model id, family).
 */
export const DEFAULT_STALE_MODEL_ENDPOINT =
  'https://kgauto-dashboard.vercel.app/api/kgauto-v2/findings/stale-models';

/**
 * Wire (or rewire) the runtime. Pass undefined to disable. Resets all
 * snapshots — a reconfigure invalidates cached data because the endpoint
 * may have changed.
 */
export function configureStaleModelFindingsBrain(
  rt: StaleModelFindingsRuntime | undefined,
): void {
  runtime = rt;
  snapshots.clear();
  warnedOnce = false;
}

/**
 * Sync introspection — is the stale-model findings brain active?
 */
export function isStaleModelFindingsBrainActive(): boolean {
  return runtime !== undefined;
}

interface GetStaleModelFindingsOpts {
  /** App id to read findings for. Required. */
  appId: string;
  /**
   * Optional archetype filter. When set, returns only findings where
   * `archetype` matches. When omitted, returns all findings for the app.
   */
  archetype?: string;
}

/**
 * Sync reader. Returns cached findings for `appId`, optionally filtered
 * to a single archetype. First call returns empty array and triggers
 * async refresh; subsequent calls within TTL return brain data.
 *
 * NEVER throws. Brain down / endpoint misconfigured / mapper exception →
 * empty array.
 */
export function getStaleModelFindings(
  opts: GetStaleModelFindingsOpts,
): StaleModelFindingRow[] {
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

async function asyncRefresh(
  rt: StaleModelFindingsRuntime,
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
  rt: StaleModelFindingsRuntime,
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
      throw new Error(`stale-model findings ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (runtime !== rt) return;
    const rows = Array.isArray(body) ? mapRowsToFindings(body) : [];
    snap.data = rows;
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
    '[kgauto] stale-model findings fetch failed (using empty fallback):',
    err,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/** Reset module state. Tests must call between cases. */
export function _testResetStaleModelFindings(): void {
  runtime = undefined;
  snapshots.clear();
  pendingRefreshes = new Map();
  warnedOnce = false;
}

/** Wait for any in-flight refresh to settle. */
export async function _testWaitForStaleModelFindingsRefresh(): Promise<void> {
  const pending = Array.from(pendingRefreshes.values());
  if (pending.length > 0) await Promise.all(pending);
}

/** Inspect a snapshot. Test-only. */
export function _testGetStaleModelFindingsSnapshot(
  appId: string,
): Readonly<AppSnapshot> | undefined {
  return snapshots.get(appId);
}

/** Expose the boundary transformer for unit tests. */
export const _internal = { mapRowsToFindings };

// ─────────────────────────────────────────────────────────────────────────
// Advisor rule — fires when an open finding exists for (appId, archetype)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stable rule code. The cron writes findings with this code into
 * `compile_outcome_advisories`; the resolver matches on it; this advisor
 * rule emits `BestPracticeAdvisory` using it.
 */
export const CONSUMER_ON_STALE_MODEL_RULE_CODE = 'consumer-on-stale-model';

/**
 * Advisor rule — emits one `warn`-level BestPracticeAdvisory per open
 * stale-model finding matching the IR's (appId, archetype). Picks the top
 * finding by deterministic order (legacy before deprecated; alphabetic on
 * staleModel as tiebreaker) so the message stays stable across polls.
 *
 * Signature matches the other rule modules' shape: `(ir: PromptIR) =>
 * BestPracticeAdvisory[]`. Builder A's advisor-rules/index.ts re-exports
 * this; Builder A's wiring code calls it from `runAdvisor()` alongside
 * the existing rules.
 *
 * Silent when:
 *   - findings brain is OFF (consumer hasn't opted in)
 *   - IR has no appId
 *   - zero findings for (appId, archetype)
 */
export interface ConsumerOnStaleModelContext {
  /**
   * alpha.126 — the model id selected for THIS call (post family-resolution +
   * chain walk). When given, the rule also reads the selected model's own
   * profile: the PROVIDER's lifecycle word (`providerLifecycle`) OR kgauto's
   * `status`, through `lifecycleOnTheWayOut`, and says what the measured head
   * is. Needs no brain and no appId — the fact is on the bundled profile.
   */
  selectedModelId?: string;
  /** Roster resolver; defaults to `tryGetProfile` (brain first, then bundled). */
  resolveProfile?: (id: string) => ModelProfile | undefined;
}

export function advisorRuleConsumerOnStaleModel(
  ir: PromptIR,
  ctx: ConsumerOnStaleModelContext = {},
): BestPracticeAdvisory[] {
  const fromFindings = staleModelFromFindings(ir);
  const fromProfile = ctx.selectedModelId
    ? staleModelFromProfile(ir, ctx.selectedModelId, ctx.resolveProfile ?? tryGetProfile)
    : undefined;
  if (!fromProfile) return fromFindings;
  if (fromFindings.length === 0) return [fromProfile.advisory];
  // One advisory per compile under this code (the brain rows + the auto-resolver
  // key on it): the cron's finding keeps its message and gains the lifecycle
  // sentence when it is about the same model; otherwise the profile-read line
  // is appended to the finding's message so neither word is lost.
  const top = fromFindings[0]!;
  return [{ ...top, message: `${top.message} ${fromProfile.sentence}` }, ...fromFindings.slice(1)];
}

/**
 * alpha.126 — the selected model's OWN lifecycle, read from its profile: the
 * PROVIDER's word (`providerLifecycle`, with the date read and the retirement
 * floor) and whether a measured head exists. Returns the advisory and the one
 * sentence a cron finding about the same model is extended with.
 *
 * Fires on the provider's word ONLY. A model that is on its way out by kgauto's
 * `status` alone stays the cron's (`model-version-watch.mjs`, the alpha.41 path,
 * unchanged): the cron skips a status-legacy model that sits at a brain chain's
 * tier 0 by measurement (golden runs #22/#23 keep `claude-sonnet-4-6` at five
 * heads), and a compile-time read of `status` here would contradict that
 * measured chain on every call.
 *
 *   - kgauto's `status` is `current` and the family head is this model → `info`:
 *     the fact is carried; the head moves only on a measurement.
 *   - the model heads the archetype's chain (bundled, or the brain's when warm)
 *     → `info`: it heads the chain whatever its `status`, said with the head entry's own
 *     grounding word (alpha.131; was: "it is there on measurement", until alpha.131).
 *   - the measured family head is another model → `warn` + `model-swap`.
 *   - the model is in no known family → `warn`, no head named.
 */
function staleModelFromProfile(
  ir: PromptIR,
  selectedModelId: string,
  resolve: (id: string) => ModelProfile | undefined,
): { advisory: BestPracticeAdvisory; sentence: string } | undefined {
  const profile = resolve(selectedModelId);
  const w = lifecycleOnTheWayOut(profile);
  if (!profile || !w || w.by !== 'provider') return undefined;

  const fact = `${providerDisplayName(profile.provider)} lists \`${profile.id}\` as ${w.word} (read ${w.readOn}${retirementFloorClause(w)})`;
  const archetype = ir.intent.archetype;

  const family = profile.family ?? deriveFamilyFromModelId(profile.id);
  const familyHead = family
    ? getRecommendedPrimary({ family, archetype, appId: ir.appId, fallback: profile.id })
    : null;
  let chainHead: string | undefined;
  try {
    chainHead = getDefaultFallbackChain({ archetype, appId: ir.appId })[0];
  } catch {
    chainHead = undefined;
  }

  const movesOnly =
    "moves only on a golden-eval measurement, on the provider's `retired`, or when the seat records why";
  let sentence: string;
  let advisory: BestPracticeAdvisory;
  if (family && profile.status === 'current' && familyHead === profile.id) {
    sentence = `${fact}; your \`${family}\` family head stays on it — kgauto's \`status\` is \`current\`, and it ${movesOnly}.`;
    advisory = {
      level: 'info',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: sentence,
      suggestion:
        `Nothing to change today: the measured head of \`${family}\` for archetype "${archetype}" is this model. ` +
        `The provider's word reaches you here and as \`providerLifecycle\` on the profile; the head moves in a release that cites the golden run.`,
      docsUrl: w.url ?? DOCS_URL,
    };
  } else if (chainHead === profile.id) {
    // alpha.131 (R3) — the head entry's own grounding word, as the replaced-head branch below says
    // it: *measured (golden run #N)* only where the entry is measured and names its run.
    // (was: "it still heads kgauto's `<archetype>` chain on measurement" and "leads with this model
    // on measured evidence", whatever the entry's grounding — `claude-sonnet-4-6` heads ask, plan
    // and transform by judgment — until alpha.131.)
    const word = chainHeadGroundingWord(archetype, chainHead);
    sentence =
      `${fact}; it still heads kgauto's \`${archetype}\` chain — ${word}; kgauto's \`status\` is \`${profile.status}\`, ` +
      `and a chain head ${movesOnly}.`;
    advisory = {
      level: 'info',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: sentence,
      suggestion:
        `Nothing to change today: kgauto's "${archetype}" chain leads with this model (${word}). ` +
        `The provider's word reaches you here and as \`providerLifecycle\` on the profile; the head moves in a release that cites the golden run.`,
      docsUrl: w.url ?? DOCS_URL,
    };
  } else if (chainHead && chainHead !== profile.id && chainHeadReplaced(archetype, chainHead, profile.id)) {
    // alpha.130 (amendment B4) — where this release moved the archetype's head off this model, the
    // replacement is that chain head, said with the head entry's own grounding word
    // (`chainHeadGroundingWord`): *measured* only where the entry is measured and names its run.
    // (was: "the measured `<family>` head is `<familyHead>`" — family resolution's pick, called
    // measured whatever measured it — until alpha.130.)
    const word = chainHeadGroundingWord(archetype, chainHead);
    sentence = `${fact}; kgauto's \`${archetype}\` chain head is \`${chainHead}\` — ${word}.`;
    advisory = {
      level: 'warn',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: sentence,
      suggestion: `Migrate ${profile.id} → ${chainHead} for archetype "${archetype}". ${chainHead} heads kgauto's "${archetype}" chain (${word}); ${profile.id} is ${w.word} on ${providerDisplayName(profile.provider)}'s page (read ${w.readOn}).`,
      recommendationType: 'model-swap',
      recommendedModels: [chainHead],
      docsUrl: w.url ?? DOCS_URL,
    };
  } else if (family && familyHead && familyHead !== profile.id) {
    // Elsewhere the family head, without the word *measured* — family resolution picks by status
    // and stamp, not by a run (alpha.130, B4). (was: "the measured `<family>` head", until alpha.130.)
    sentence = `${fact}; the \`${family}\` family head is \`${familyHead}\`.`;
    advisory = {
      level: 'warn',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: sentence,
      suggestion: `Migrate ${profile.id} → ${familyHead} for archetype "${archetype}". ${familyHead} is the head of the "${family}" family; ${profile.id} is ${w.word} on ${providerDisplayName(profile.provider)}'s page (read ${w.readOn}).`,
      recommendationType: 'model-swap',
      recommendedModels: [familyHead],
      docsUrl: w.url ?? DOCS_URL,
    };
  } else {
    sentence = `${fact}; kgauto knows no family for it, so it names no head.`;
    advisory = {
      level: 'warn',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: sentence,
      docsUrl: w.url ?? DOCS_URL,
    };
  }
  return { advisory, sentence };
}

const DOCS_URL = 'https://github.com/stue/command-center/blob/main/interfaces/kgauto.md#best-practice-advisories';

/** The alpha.41 path: open cron findings for (appId, archetype), unchanged. */
function staleModelFromFindings(ir: PromptIR): BestPracticeAdvisory[] {
  if (!isStaleModelFindingsBrainActive()) return [];
  if (!ir.appId) return [];

  const findings = getStaleModelFindings({
    appId: ir.appId,
    archetype: ir.intent.archetype,
  });
  if (findings.length === 0) return [];

  // Deterministic sort: deprecated (more urgent) before legacy; then alpha
  // by staleModel for stable tiebreaks.
  const ranked = [...findings].sort((a, b) => {
    if (a.staleStatus !== b.staleStatus) {
      return a.staleStatus === 'deprecated' ? -1 : 1;
    }
    return a.staleModel.localeCompare(b.staleModel);
  });

  const top = ranked[0]!;
  const extraCount = findings.length - 1;
  const extraNote =
    extraCount > 0
      ? ` (+ ${extraCount} more stale model${extraCount === 1 ? '' : 's'} for this archetype)`
      : '';

  return [
    {
      level: 'warn',
      code: CONSUMER_ON_STALE_MODEL_RULE_CODE,
      message: `${top.message}${extraNote}`,
      suggestion:
        top.suggestion ??
        `Migrate ${top.staleModel} → ${top.recommendedModel} for archetype "${top.archetype}". The newer model is the current latest in the "${top.family}" family; the stale one is ${top.staleStatus}.`,
      recommendationType: 'model-swap',
      ...(top.recommendedModel ? { recommendedModels: [top.recommendedModel] } : {}),
      docsUrl: DOCS_URL,
    },
  ];
}
