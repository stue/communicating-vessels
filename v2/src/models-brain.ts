/**
 * models-brain — alpha.11 KG-14 adapter (the largest of the four).
 *
 * Brain-driven model registry + aliases. Two adapters share the same
 * SWR snapshot:
 *
 * - `loadModelsFromBrain()` — `Map<modelId, ModelProfile>` from
 *   `kgauto_models` table (cliffs/lowering/recovery as JSONB columns).
 * - `loadAliasesFromBrain()` — `Record<aliasId, canonicalId>` from
 *   `kgauto_aliases` table.
 *
 * After alpha.11, new-model onboarding becomes brain INSERT (vs PR + alpha
 * cut + 3 consumer refreshes). The auto-onboard pipeline
 * (`scripts/check-model-releases.mjs`) shifts from emitting profile.ts
 * edits to writing brain rows directly.
 *
 * **D5 — alias resolution stable regardless of canonical's active state.**
 * `canonicalId('deepseek-chat') → 'deepseek-v4-flash'` even when the
 * canonical row is `active=false`. Aliases are wire-format contracts;
 * legacy callers' resolution promise outlives the canonical's active
 * status. Deprecation (`active=false`) affects chain composition only.
 */

import { createBrainQueryCache } from './brain-query.js';
import {
  type ModelProfile,
  type CliffRule,
  type RecoveryRule,
  type LoweringSpec,
  type LatencyTier,
  type ArchetypeConvention,
  type ProbedLimit,
  type ProviderLifecycle,
  type CacheWritePrice,
  type BatchPrice,
  type PriceTier,
  PROVIDER_LIFECYCLE_ON_THE_WAY_OUT,
  ALIASES,
  allProfilesRaw,
  _setProfileBrainHook,
} from './profiles.js';
import type { InputModality, Provider } from './ir.js';

interface RawModelRow {
  model_id: string;
  provider: string;
  status?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  max_tools?: number;
  parallel_tool_calls?: boolean;
  structured_output?: string;
  system_prompt_mode?: string;
  streaming?: boolean;
  cliffs?: unknown;
  lowering?: unknown;
  recovery?: unknown;
  strengths?: string[] | null;
  weaknesses?: string[] | null;
  cost_input_per_1m?: number;
  cost_output_per_1m?: number;
  notes?: string | null;
  verified_against_docs?: string | null;
  archetype_perf?: Record<string, number> | null;
  // alpha.41 — family-resolution + active filter substrate (migration 024).
  family?: string | null;
  version_added?: string | null;
  active?: boolean | null;
  // alpha.49 — executable-knowledge fields (migration 028). Pre-028 rows
  // omit these → read as undefined → runtime falls back to tag-derivation
  // (latency) / no-conventions exactly as before.
  latency_tier?: string | null;
  archetype_conventions?: unknown;
  // alpha.95 — measured negatives (migration 070). Pre-070 rows omit it →
  // undefined → the bundle's own probedLimits stand, exactly as before.
  probed_limits?: unknown;
  // alpha.124 — declared input modalities (migration 087). Pre-087 rows omit
  // it → undefined → "not declared".
  input_modalities?: unknown;
  // alpha.126 — the provider's lifecycle word with its read date (migration 090).
  // Pre-090 rows omit it → undefined → "no page read".
  provider_lifecycle?: unknown;
  // alpha.128 — the prices the provider states beyond input/output (migration
  // 093). Pre-093 rows omit them → undefined → "the page states none".
  cost_cache_write_per_1m?: unknown;
  cost_batch_per_1m?: unknown;
  cost_tiers?: unknown;
  // alpha.138 — the page's maximum input (migration 107). Pre-107 rows omit it,
  // and a NULL is not "no maximum": both keep the bundled value (rowToProfile).
  max_input_tokens?: unknown;
}

/**
 * Exported brain-row shape for `kgauto_models`. Mirrors the SQL table
 * (`v2/brain/migrations/010_kgauto_models_and_aliases.sql`) — column names
 * are snake_case to match PostgREST. Used by operator scripts that write
 * to brain (auto-onboard, promote-model) — see `profileToRow()`.
 *
 * Read path stays internal via `RawModelRow` to keep `rowToProfile()`'s
 * tolerance contract from leaking into write callers.
 */
export interface ModelBrainRow {
  model_id: string;
  provider: string;
  status?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  max_tools?: number;
  parallel_tool_calls?: boolean;
  structured_output?: string;
  system_prompt_mode?: string;
  streaming?: boolean;
  cliffs?: unknown;
  lowering?: unknown;
  recovery?: unknown;
  strengths?: string[] | null;
  weaknesses?: string[] | null;
  cost_input_per_1m?: number;
  cost_output_per_1m?: number;
  notes?: string | null;
  verified_against_docs?: string | null;
  archetype_perf?: Record<string, number> | null;
  version_added?: string;
  version_removed?: string | null;
  active?: boolean;
  /** alpha.41 — model-family tag (migration 024 column). */
  family?: string | null;
  /** alpha.49 — explicit latency bucket (migration 028 column). */
  latency_tier?: string | null;
  /** alpha.49 — per-archetype prompt-shape conventions (migration 028 column). */
  archetype_conventions?: ArchetypeConvention[] | null;
  /** alpha.95 — measured negatives from --discover (migration 070 column). */
  probed_limits?: ProbedLimit[] | null;
  /** alpha.124 — input modalities the provider's page declares (migration 087 column). NULL = not declared. */
  input_modalities?: InputModality[] | null;
  /** alpha.126 — the provider's lifecycle word, read date, page, floor (migration 090 jsonb). NULL = no page read. */
  provider_lifecycle?: ProviderLifecycle | null;
  /** alpha.128 — the page's cache-write prices, $/MTok (migration 093 jsonb). NULL = the page states none. */
  cost_cache_write_per_1m?: CacheWritePrice | null;
  /** alpha.128 — the page's Batch API prices, $/MTok (migration 093 jsonb). NULL = the page states none. */
  cost_batch_per_1m?: BatchPrice | null;
  /** alpha.128 — the page's prompt-length price steps (migration 093 jsonb). NULL = the page states none. */
  cost_tiers?: PriceTier[] | null;
  /** alpha.138 — the page's maximum input tokens (migration 107 integer). NULL = none stated; the reader keeps a bundled value. */
  max_input_tokens?: number | null;
}

export interface ProfileToRowOptions {
  /** e.g. `'2.0.0-alpha.12'` — leave undefined to omit from row. */
  versionAdded?: string;
  /** Pass `null` to clear; omit to leave field unset. */
  versionRemoved?: string | null;
  /** Defaults to true if omitted. */
  active?: boolean;
  /**
   * Override verifiedAgainstDocs (e.g. set to `null` for auto-onboard).
   * When omitted, the profile's own value is used. Pass `null` explicitly
   * to write a SQL NULL (e.g. unverified auto-onboard rows).
   */
  verifiedAgainstDocs?: string | null;
}

interface RawAliasRow {
  alias_id: string;
  canonical_id: string;
}

function isModelRow(x: unknown): x is RawModelRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.model_id === 'string' && typeof r.provider === 'string';
}

function isAliasRow(x: unknown): x is RawAliasRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.alias_id === 'string' && typeof r.canonical_id === 'string';
}

function rowToProfile(row: RawModelRow): ModelProfile | null {
  // Tolerant reconstruction for absent fields (D4 forward-compat).
  // BUT: type-mismatch on load-bearing JSON columns (cliffs, recovery,
  // lowering) is treated as schema corruption — we return null so the
  // adapter falls through to bundled instead of silently disabling
  // safety guards. A partially-corrupt profile is more dangerous than a
  // missing one because missing falls back; corrupt would silently strip
  // (e.g.) Flash's s11 summarize-strip-tools cliff (trust artifact #2).
  // Per qa-shepherd review of PR #15.
  try {
    if (row.cliffs !== undefined && row.cliffs !== null && !Array.isArray(row.cliffs)) {
      return null;
    }
    if (row.recovery !== undefined && row.recovery !== null && !Array.isArray(row.recovery)) {
      return null;
    }
    if (
      row.lowering !== undefined &&
      row.lowering !== null &&
      (typeof row.lowering !== 'object' || Array.isArray(row.lowering))
    ) {
      return null;
    }
    // alpha.49 — archetype_conventions is load-bearing (it gates quality at
    // ranking, see passScoreTargets). Treat a type-mismatch as schema
    // corruption: return null so the adapter falls back to the bundled
    // profile (which carries the real conventions) rather than silently
    // stripping a quality gate. Same discipline as cliffs/recovery above.
    if (
      row.archetype_conventions !== undefined &&
      row.archetype_conventions !== null &&
      !Array.isArray(row.archetype_conventions)
    ) {
      return null;
    }
    return {
      id: row.model_id,
      provider: row.provider as Provider,
      status: (row.status as ModelProfile['status']) ?? 'current',
      maxContextTokens: row.max_context_tokens ?? 0,
      maxOutputTokens: row.max_output_tokens ?? 0,
      maxTools: row.max_tools ?? 0,
      parallelToolCalls: row.parallel_tool_calls ?? false,
      structuredOutput:
        (row.structured_output as ModelProfile['structuredOutput']) ?? 'none',
      systemPromptMode:
        (row.system_prompt_mode as ModelProfile['systemPromptMode']) ?? 'inline',
      streaming: row.streaming ?? true,
      cliffs: (row.cliffs as CliffRule[] | undefined) ?? [],
      costInputPer1m: row.cost_input_per_1m ?? 0,
      costOutputPer1m: row.cost_output_per_1m ?? 0,
      lowering:
        (row.lowering as LoweringSpec | undefined) ??
        ({ system: { mode: 'inline' }, cache: { strategy: 'unsupported' } } as LoweringSpec),
      recovery: (row.recovery as RecoveryRule[] | undefined) ?? [],
      strengths: row.strengths ?? [],
      weaknesses: row.weaknesses ?? [],
      notes: row.notes ?? undefined,
      verifiedAgainstDocs: row.verified_against_docs ?? undefined,
      archetypePerf: row.archetype_perf ?? undefined,
      // alpha.41 — family-resolution fields. `family` may be null pre-
      // migration 024; runtime falls back to deriveFamilyFromModelId at
      // resolution time (see family-resolution.ts, G1).
      family: row.family ?? undefined,
      versionAdded: row.version_added ?? undefined,
      active: row.active ?? undefined,
      // alpha.49 — executable-knowledge fields (migration 028). Invalid
      // latency_tier → undefined (latencyTierOf derives from tags; not
      // safety-critical). archetype_conventions already array-validated above.
      latencyTier: normalizeLatencyTier(row.latency_tier),
      archetypeConventions:
        (row.archetype_conventions as ArchetypeConvention[] | undefined) ?? undefined,
      // alpha.95 — measured negatives. NOT safety-critical (nothing routes on
      // them), so a type-mismatch degrades to undefined rather than nulling
      // the whole profile the way a corrupt `cliffs` does.
      probedLimits: Array.isArray(row.probed_limits)
        ? (row.probed_limits as ProbedLimit[])
        : undefined,
      // alpha.124 — declared input modalities. A malformed value degrades to
      // undefined ("not declared"), which only ever EXCLUDES a model from a
      // call that requires a modality — the safe direction, so the profile is
      // kept rather than nulled.
      inputModalities: normalizeInputModalities(row.input_modalities),
      // alpha.126 — the provider's lifecycle word. A malformed value degrades to
      // undefined ("no page read"): the field only ever ADDS an advisory and never
      // routes, so the profile is kept rather than nulled.
      providerLifecycle: normalizeProviderLifecycle(row.provider_lifecycle),
      // alpha.128 — the provider's stated prices. A malformed value degrades to
      // undefined ("the page states none"): an absent tier prices the base tier,
      // the price the profile carried before this release, so the profile is kept.
      costCacheWritePer1m: normalizeCacheWrite(row.cost_cache_write_per_1m),
      costBatchPer1m: normalizeBatch(row.cost_batch_per_1m),
      costTiers: normalizeTiers(row.cost_tiers),
      // alpha.138 (R3) — the page's maximum input. A positive integer in the
      // brain wins; NULL, an absent column (pre-107 brain, or an endpoint not yet
      // redeployed with the column) or a malformed value keeps the BUNDLED value
      // for this id. A NULL here would otherwise erase a bound the bundle reads
      // from the page and widen the budget past it on every warm process; a
      // bound is removed by a release, never by a missing cell.
      maxInputTokens: normalizeMaxInput(row.max_input_tokens) ?? bundledMaxInput(row.model_id),
    };
  } catch {
    return null;
  }
}

/** alpha.138 — narrow `max_input_tokens` to a positive integer, else undefined. */
function normalizeMaxInput(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** alpha.138 — the bundled profile's `maxInputTokens` for this id (undefined when not bundled or not set). */
function bundledMaxInput(id: string): number | undefined {
  return allProfilesRaw().find((p) => p.id === id)?.maxInputTokens;
}

/**
 * alpha.126 — narrow a brain row's `provider_lifecycle` jsonb to ProviderLifecycle.
 * Needs a known status word, a string `readOn` and a string `url`; the two
 * optional strings ride when they are strings. Anything else → undefined.
 */
function normalizeProviderLifecycle(v: unknown): ProviderLifecycle | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const status = r.status;
  if (typeof status !== 'string' || !(status === 'active' || PROVIDER_LIFECYCLE_ON_THE_WAY_OUT.has(status as ProviderLifecycle['status']))) {
    return undefined;
  }
  if (typeof r.readOn !== 'string' || typeof r.url !== 'string') return undefined;
  const out: ProviderLifecycle = { status: status as ProviderLifecycle['status'], readOn: r.readOn, url: r.url };
  if (typeof r.retirementFloor === 'string') out.retirementFloor = r.retirementFloor;
  if (typeof r.replacement === 'string') out.replacement = r.replacement;
  return out;
}

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** alpha.128 — narrow `cost_cache_write_per_1m` jsonb: a numeric `fiveMinute`, an optional numeric `oneHour`. */
function normalizeCacheWrite(v: unknown): CacheWritePrice | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (!isPrice(r.fiveMinute)) return undefined;
  const out: CacheWritePrice = { fiveMinute: r.fiveMinute };
  if (isPrice(r.oneHour)) out.oneHour = r.oneHour;
  return out;
}

/** alpha.128 — narrow `cost_batch_per_1m` jsonb: numeric `input` and `output`. */
function normalizeBatch(v: unknown): BatchPrice | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (!isPrice(r.input) || !isPrice(r.output)) return undefined;
  return { input: r.input, output: r.output };
}

/** alpha.128 — narrow `cost_tiers` jsonb: an array of steps; one malformed step → the whole list undefined (the base tier prices). */
function normalizeTiers(v: unknown): PriceTier[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PriceTier[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined;
    const r = t as Record<string, unknown>;
    if (!isPrice(r.overInputTokens) || !isPrice(r.costInputPer1m) || !isPrice(r.costOutputPer1m)) return undefined;
    const tier: PriceTier = { overInputTokens: r.overInputTokens, costInputPer1m: r.costInputPer1m, costOutputPer1m: r.costOutputPer1m };
    const cw = normalizeCacheWrite(r.costCacheWritePer1m);
    if (cw) tier.costCacheWritePer1m = cw;
    const b = normalizeBatch(r.costBatchPer1m);
    if (b) tier.costBatchPer1m = b;
    if (isPrice(r.cacheReadPer1m)) tier.cacheReadPer1m = r.cacheReadPer1m;
    out.push(tier);
  }
  return out;
}

/**
 * alpha.124 — narrow a brain row's `input_modalities` to InputModality[].
 * Anything that is not an array of known modality names → undefined.
 */
const VALID_INPUT_MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'audio', 'video', 'pdf']);
function normalizeInputModalities(v: unknown): InputModality[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.every((m) => typeof m === 'string' && VALID_INPUT_MODALITIES.has(m))) return undefined;
  return [...(v as InputModality[])];
}

/**
 * alpha.49 — narrow a brain row's `latency_tier` to a valid LatencyTier.
 * Returns undefined for absent/invalid values so `latencyTierOf` falls back
 * to tag-derivation (a wrong tier is a routing imprecision, not a safety
 * failure — so we degrade rather than null the whole profile).
 */
const VALID_LATENCY_TIERS: ReadonlySet<string> = new Set(['fast', 'medium', 'slow']);
function normalizeLatencyTier(v: unknown): LatencyTier | undefined {
  return typeof v === 'string' && VALID_LATENCY_TIERS.has(v)
    ? (v as LatencyTier)
    : undefined;
}

/**
 * Inverse of `rowToProfile` — serialize a `ModelProfile` to a `kgauto_models`
 * row payload for INSERT/UPSERT. Used by operator scripts that write to
 * brain (auto-onboard pipeline, promote-model verification CLI).
 *
 * Row-level fields (`version_added`, `version_removed`, `active`) are
 * operator-controlled and pass through `opts`. `verifiedAgainstDocs` can
 * also be overridden via `opts` — auto-onboard explicitly passes `null` to
 * mark unverified rows (the column is DATE, doesn't accept the
 * `'UNVERIFIED-AUTO-ONBOARD'` sentinel used in PROFILES_RAW).
 */
export function profileToRow(
  profile: ModelProfile,
  opts: ProfileToRowOptions = {},
): ModelBrainRow {
  const row: ModelBrainRow = {
    model_id: profile.id,
    provider: profile.provider,
    status: profile.status,
    max_context_tokens: profile.maxContextTokens,
    max_output_tokens: profile.maxOutputTokens,
    max_tools: profile.maxTools,
    parallel_tool_calls: profile.parallelToolCalls,
    structured_output: profile.structuredOutput,
    system_prompt_mode: profile.systemPromptMode,
    streaming: profile.streaming,
    cliffs: profile.cliffs,
    cost_input_per_1m: profile.costInputPer1m,
    cost_output_per_1m: profile.costOutputPer1m,
    lowering: profile.lowering,
    recovery: profile.recovery,
    strengths: profile.strengths,
    weaknesses: profile.weaknesses,
    notes: profile.notes ?? null,
    archetype_perf: profile.archetypePerf ?? null,
    active: opts.active ?? profile.active ?? true,
    // alpha.41 — round-trip family + version_added when present on profile.
    // version_added is operator-controlled via opts; profile-side value is
    // used only when opts didn't override.
    family: profile.family ?? null,
    // alpha.49 — round-trip the executable-knowledge fields (migration 028)
    // so a reseed from bundled profiles makes the latency lever + schema
    // conventions live warm. Closes the silently-dropped-field gap.
    latency_tier: profile.latencyTier ?? null,
    archetype_conventions: profile.archetypeConventions ?? null,
    // alpha.95 — round-trip the measured negatives. The s56 rule: a new
    // ModelProfile field must land in migration + BOTH transformers + the
    // config-endpoint cols list + the parity test, or it is theater for every
    // brain-connected consumer.
    probed_limits: profile.probedLimits ?? null,
    // alpha.124 — rule 11's second place: the declared input modalities
    // round-trip, absent → NULL (not declared), never an empty array.
    input_modalities: profile.inputModalities ? [...profile.inputModalities] : null,
    // alpha.126 — rule 11's second place: the provider's lifecycle word round-trips,
    // absent → NULL (no page read), never an empty object.
    provider_lifecycle: profile.providerLifecycle ? { ...profile.providerLifecycle } : null,
    // alpha.128 — rule 11's second place: the provider's stated prices round-trip,
    // absent → NULL (the page states none), never an empty object or array.
    cost_cache_write_per_1m: profile.costCacheWritePer1m ? { ...profile.costCacheWritePer1m } : null,
    cost_batch_per_1m: profile.costBatchPer1m ? { ...profile.costBatchPer1m } : null,
    cost_tiers: profile.costTiers ? profile.costTiers.map((t) => JSON.parse(JSON.stringify(t)) as PriceTier) : null,
    // alpha.138 — rule 11's second place: the page's maximum input round-trips,
    // absent → NULL (none stated).
    max_input_tokens: profile.maxInputTokens ?? null,
  };
  if (opts.verifiedAgainstDocs !== undefined) {
    row.verified_against_docs = opts.verifiedAgainstDocs;
  } else if (profile.verifiedAgainstDocs !== undefined) {
    // Bundled profiles' `'UNVERIFIED-AUTO-ONBOARD'` sentinel becomes NULL
    // (DATE column rejects the string). Real ISO dates pass through.
    const v = profile.verifiedAgainstDocs;
    row.verified_against_docs = /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null;
  }
  if (opts.versionAdded !== undefined) row.version_added = opts.versionAdded;
  else if (profile.versionAdded !== undefined) row.version_added = profile.versionAdded;
  if (opts.versionRemoved !== undefined) row.version_removed = opts.versionRemoved;
  return row;
}

function mapRowsToModels(rows: unknown[]): Map<string, ModelProfile> {
  const out = new Map<string, ModelProfile>();
  for (const row of rows) {
    if (!isModelRow(row)) continue;
    const profile = rowToProfile(row);
    if (profile) out.set(profile.id, profile);
  }
  return out;
}

function mapRowsToAliases(rows: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!isAliasRow(row)) continue;
    out[row.alias_id] = row.canonical_id;
  }
  return out;
}

function bundledModels(): Map<string, ModelProfile> {
  return new Map(allProfilesRaw().map((p) => [p.id, p]));
}

function bundledAliases(): Record<string, string> {
  return { ...ALIASES };
}

/**
 * Sync reader for the brain-driven model registry. Returns bundled
 * PROFILES_RAW when brain-query is disabled, cold, or unreachable.
 */
export const loadModelsFromBrain = createBrainQueryCache<Map<string, ModelProfile>>({
  table: 'kgauto_models',
  mapRows: mapRowsToModels,
  bundledFallback: bundledModels,
});

/**
 * Sync reader for the brain-driven aliases map. Returns bundled ALIASES
 * when brain-query is disabled, cold, or unreachable.
 *
 * D5: this map carries both active and inactive canonical mappings —
 * alias resolution is stable regardless of canonical's `active` state.
 */
export const loadAliasesFromBrain = createBrainQueryCache<Record<string, string>>({
  table: 'kgauto_aliases',
  mapRows: mapRowsToAliases,
  bundledFallback: bundledAliases,
});

// ─────────────────────────────────────────────────────────────────────────
// Register brain-first hook with profiles.ts at module load. Once
// index.ts re-exports this module, the hook is live for every consumer
// that imports from '@warmdrift/kgauto-compiler'.
// ─────────────────────────────────────────────────────────────────────────

_setProfileBrainHook({
  getProfile: (canonical) => loadModelsFromBrain().get(canonical),
  resolveAlias: (id) => loadAliasesFromBrain()[id],
});
