/**
 * archetype-perf-brain — alpha.11 KG-12 adapter.
 *
 * Brain-driven archetypePerf scores. Substrate for the future closed-loop
 * tuning engine (KG-12.5): brain telemetry → human or automated bumps →
 * brain UPDATE → consumers see new scores within 5-min cache TTL with
 * zero refresh.
 *
 * Today: data migrates to brain. No runtime call site reads archetypePerf
 * (it's metadata for the master plan §2.5 anti-hallucination guardrail +
 * future auto-tuning). The adapter exists so future readers — auto-tuning
 * + operator scripts + KG-12.5 — have a shipped substrate to consume.
 */

import type { IntentArchetypeName } from './dialect.js';
import type { Grounding } from './ir.js';
import { createBrainQueryCache } from './brain-query.js';
import { routeScopedModel } from './dialect.js';
import { allProfiles } from './profiles.js';

export type ArchetypePerfMap = Map<
  string,
  Partial<Record<IntentArchetypeName, number>>
>;

/**
 * alpha.21: per-(model, archetype) row count map. Same shape as
 * ArchetypePerfMap but stores brain row counts when the brain backs a
 * placement. Undefined entries → no row count seen → score is the
 * hand-curated cold-start prior (grounding='judgment').
 */
export type ArchetypePerfNMap = Map<
  string,
  Partial<Record<IntentArchetypeName, number>>
>;

interface PerfRow {
  model_id: string;
  archetype: string;
  perf_score: number;
  /**
   * alpha.21: optional row-count column. When the brain reports a row
   * count >=10, we treat the perf score as 'measured'; otherwise
   * 'judgment' (cold-start prior). Brain migrations may or may not
   * populate `n` — when absent we default to 0 (treated as 'judgment').
   */
  n?: number;
  /** Provenance of `perf_score` (brain column `evidence_source`; the config endpoint projects it). */
  evidence_source?: string | null;
}

/** model → archetype → evidence_source of the perf score. */
export type ArchetypePerfSourceMap = Map<
  string,
  Partial<Record<IntentArchetypeName, string>>
>;

/**
 * alpha.110 — is this provenance a MEASUREMENT of the score, or a judgment?
 *
 * Found 2026-09-13 (kgauto s101) while sweeping alpha.110's floor-gated ranking against
 * the live brain: all 144 `kgauto_archetype_perf` rows carry `evidence_source =
 * master_plan_3.3` — the curated 2026-05-17 judgment — and `n` (migration 050) is the
 * COUNT OF CALLS on the tuple in 90 days, any outcome. `grounding: 'measured'` had meant
 * "called ten times", and under that label the floor rule was about to move the `ask`
 * head from claude-sonnet-4-6 (judgment 9, 85 calls) to claude-haiku-4-5 (judgment 7,
 * 11 calls, 2 failed, all 46 days old) — cost deciding between two judgment numbers,
 * the exact thing option 2 forbids. The label was true and the outcome field beside it
 * was never read (the s75 shape).
 *
 * Measured means the score itself was WRITTEN BY A MEASUREMENT — the eval spine (golden
 * evals, the delta report, a judge run). An allowlist, not a denylist: an unknown
 * provenance is judgment until something says otherwise, because "measured" is the
 * licence for cost to decide.
 */
const MEASURED_SOURCE_PREFIXES = ['golden-eval', 'delta-report', 'judge', 'eval'];
export function isMeasuredEvidenceSource(source: string | null | undefined): boolean {
  if (typeof source !== 'string') return false;
  const s = source.trim().toLowerCase();
  return MEASURED_SOURCE_PREFIXES.some((p) => s === p || s.startsWith(`${p}:`) || s.startsWith(`${p}_`) || s.startsWith(`${p}-`));
}

function isPerfRow(x: unknown): x is PerfRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.model_id === 'string' &&
    typeof r.archetype === 'string' &&
    typeof r.perf_score === 'number'
  );
}

function mapRowsToPerfMap(rows: unknown[]): ArchetypePerfMap {
  const out: ArchetypePerfMap = new Map();
  for (const row of rows) {
    if (!isPerfRow(row)) continue;
    const existing = out.get(row.model_id) ?? {};
    existing[row.archetype as IntentArchetypeName] = row.perf_score;
    out.set(row.model_id, existing);
  }
  return out;
}

function mapRowsToNMap(rows: unknown[]): ArchetypePerfNMap {
  const out: ArchetypePerfNMap = new Map();
  for (const row of rows) {
    if (!isPerfRow(row)) continue;
    if (typeof row.n !== 'number') continue;
    const existing = out.get(row.model_id) ?? {};
    existing[row.archetype as IntentArchetypeName] = row.n;
    out.set(row.model_id, existing);
  }
  return out;
}

function mapRowsToSourceMap(rows: unknown[]): ArchetypePerfSourceMap {
  const out: ArchetypePerfSourceMap = new Map();
  for (const row of rows) {
    if (!isPerfRow(row)) continue;
    if (typeof row.evidence_source !== 'string') continue;
    const existing = out.get(row.model_id) ?? {};
    existing[row.archetype as IntentArchetypeName] = row.evidence_source;
    out.set(row.model_id, existing);
  }
  return out;
}

function bundledArchetypePerfSource(): ArchetypePerfSourceMap {
  return new Map();
}

function bundledArchetypePerf(): ArchetypePerfMap {
  const out: ArchetypePerfMap = new Map();
  for (const profile of allProfiles()) {
    if (profile.archetypePerf) out.set(profile.id, profile.archetypePerf);
  }
  return out;
}

function bundledArchetypePerfN(): ArchetypePerfNMap {
  // Bundled has no brain row counts by definition — every score is a
  // hand-curated cold-start prior. Empty map → all lookups return undefined
  // → grounding resolves to 'judgment'.
  return new Map();
}

/**
 * Sync reader for the brain-driven archetypePerf map. Returns bundled
 * profile.archetypePerf data when brain-query is disabled, cold, or
 * unreachable. Identical shape pre/post-alpha.11 by design (D2).
 */
export const loadArchetypePerfFromBrain = createBrainQueryCache<ArchetypePerfMap>({
  table: 'kgauto_archetype_perf',
  mapRows: mapRowsToPerfMap,
  bundledFallback: bundledArchetypePerf,
});

/**
 * alpha.21 — sync reader for the brain row-count map paired with
 * archetype-perf. Returns empty map (no measured backing) on cold start /
 * brain-down / unreachable — all `getArchetypePerfScore` calls then
 * resolve to `grounding: 'judgment'`. When the brain table includes an
 * `n` column on each row, this map mirrors those counts so consumers can
 * see how many measurements back each score.
 */
/** alpha.110 — evidence_source per (model, archetype); empty on cold start. */
export const loadArchetypePerfSourceFromBrain = createBrainQueryCache<ArchetypePerfSourceMap>({
  table: 'kgauto_archetype_perf',
  mapRows: mapRowsToSourceMap,
  bundledFallback: bundledArchetypePerfSource,
});

/**
 * One measured row as the library reads it (alpha.112, table kgauto_archetype_perf_measured,
 * migration 079). alpha.128 — the row's ruler rides with the score: `incumbentModel` /
 * `incumbentScore` are the model and score the measurement was anchored on (079 R2), so a
 * sentence built on the score can say what it was measured AGAINST. Absent when the row
 * does not carry them.
 */
export interface MeasuredPerfEntry {
  score: number;
  n: number;
  source: string;
  incumbentModel?: string;
  incumbentScore?: number;
}

/** app_id → model_id → archetype → the measured row. */
export type ArchetypePerfMeasuredMap = Map<string, Map<string, Partial<Record<IntentArchetypeName, MeasuredPerfEntry>>>>;

function mapRowsToMeasuredMap(rows: unknown[]): ArchetypePerfMeasuredMap {
  const out: ArchetypePerfMeasuredMap = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.app_id !== 'string' || typeof r.model_id !== 'string' || typeof r.archetype !== 'string' || typeof r.perf_score !== 'number') continue;
    const byModel = out.get(r.app_id) ?? new Map();
    const byArch = byModel.get(r.model_id) ?? {};
    const entry: MeasuredPerfEntry = { score: r.perf_score, n: typeof r.n === 'number' ? r.n : 0, source: typeof r.evidence_source === 'string' ? r.evidence_source : '' };
    // alpha.128 — the ruler the score is anchored on (079: incumbent_model / incumbent_score, NOT NULL there).
    if (typeof r.incumbent_model === 'string') entry.incumbentModel = r.incumbent_model;
    if (typeof r.incumbent_score === 'number') entry.incumbentScore = r.incumbent_score;
    byArch[r.archetype as IntentArchetypeName] = entry;
    byModel.set(r.model_id, byArch);
    out.set(r.app_id, byModel);
  }
  return out;
}

/**
 * alpha.112 — the per-app MEASURED scores (R1). Empty on cold start and for any app without
 * its own eval rows: a cold isolate ranks on judgment exactly as before.
 */
export const loadArchetypePerfMeasuredFromBrain = createBrainQueryCache<ArchetypePerfMeasuredMap>({
  table: 'kgauto_archetype_perf_measured',
  mapRows: mapRowsToMeasuredMap,
  bundledFallback: () => new Map(),
});

export const loadArchetypePerfNFromBrain = createBrainQueryCache<ArchetypePerfNMap>(
  {
    table: 'kgauto_archetype_perf',
    mapRows: mapRowsToNMap,
    bundledFallback: bundledArchetypePerfN,
  },
);

/**
 * Threshold above which a brain row count counts as 'measured' grounding.
 * Below this, the score is treated as 'judgment' (cold-start prior or
 * not-yet-enough-evidence). Mirrors the alpha.20 `getCleanPerfScore`
 * `minRows` default — same rule for consistency.
 */
export const MEASURED_GROUNDING_MIN_N = 10;

/**
 * alpha.21 — return shape for the extended {@link getArchetypePerfScore}.
 * Wraps the existing 0..10 score with:
 *
 *   - `n`: brain row count backing this score (0 when no measurement).
 *   - `grounding`: derived label — 'measured' when n >= 10, else 'judgment'.
 *
 * The score itself is unchanged from pre-alpha.21 (numeric, 5 = neutral
 * default). 'capability-fact' is NOT a perf-score grounding — capability
 * decisions live on chain entries, not on perf scores.
 */
export interface ArchetypePerfScoreResult {
  /** 0..10 perf score. 5 = neutral default when no entry exists. */
  score: number;
  /**
   * Brain row count backing this score. 0 when bundled (cold-start prior)
   * or when the brain row didn't carry an `n` column.
   */
  n: number;
  /**
   * Provenance — 'measured' when `n >= 10`, else 'judgment'.
   * Never 'capability-fact' (that label is reserved for chain-entry
   * inclusion/exclusion decisions).
   */
  grounding: Grounding;
  /**
   * alpha.128 — WHERE the score came from, so a sentence that compares two scores
   * can say what each one is:
   *   - `'measured'` — the app's OWN row in kgauto_archetype_perf_measured (a golden
   *     run on this app's corpus, anchored on `incumbentModel` at `incumbentScore`);
   *   - `'curated'`  — a row in the cross-app roster (kgauto_archetype_perf) or, cold,
   *     the bundled profile's archetypePerf; its `grounding` may still be `'measured'`
   *     when the roster row was written by a measurement (`evidenceSource`);
   *   - `'default'`  — no row anywhere: the neutral 5 (under the floor of 6).
   */
  source: 'measured' | 'curated' | 'default';
  /** alpha.128 — the measured row's ruler (source `'measured'` only, when the row carries it). */
  incumbentModel?: string;
  /** alpha.128 — the ruler's score at write time (source `'measured'` only, when the row carries it). */
  incumbentScore?: number;
  /** alpha.128 — the row's `evidence_source` (e.g. `golden-eval:47`), when it carries one. */
  evidenceSource?: string;
  /** alpha.128 — the app whose measured row this is (source `'measured'` only). */
  appId?: string;
}

/**
 * Per-model accessor with grounding (alpha.21). Returns 5 (neutral) when no
 * entry is found — consistent with the master plan §3.3 "missing archetypes
 * default to 5" convention documented in profiles.ts
 * ModelProfile.archetypePerf.
 *
 * Backwards-compat note: pre-alpha.21 callers expected `number` here. The
 * new return shape `{ score, n, grounding }` is a breaking shape change at
 * the type level, but `.score` carries the legacy value. Callers reading
 * `.score` field-by-field continue working; callers using the bare number
 * arithmetically need to switch to `.score`. The migration is single-line
 * (`const x = getArchetypePerfScore(...)` → `const x = getArchetypePerfScore(...).score`).
 */
export function getArchetypePerfScore(
  modelId: string,
  archetype: IntentArchetypeName,
  appId?: string,
  route?: 'direct' | 'openrouter',
): ArchetypePerfScoreResult {
  // alpha.112 (R3) — the app's OWN measured row wins when it exists: the eval measured this
  // consumer's corpus, and only that earns `measured` for this consumer. Another app's row is a
  // lighthouse for the trigger, never a score here.
  if (appId) {
    // alpha.128 (R4) — the measured key carries its host by the existing route dimension:
    // a row measured through a gateway is keyed `model@openrouter` (routeScopedModel, the
    // learning-key convention). A gateway call reads its route's row first, then the bare
    // id; a direct call reads the bare id only — gateway evidence never scores direct.
    const byModel = loadArchetypePerfMeasuredFromBrain().get(appId);
    const scoped = routeScopedModel(modelId, route);
    const own = (scoped !== modelId ? byModel?.get(scoped)?.[archetype] : undefined) ?? byModel?.get(modelId)?.[archetype];
    if (own && isMeasuredEvidenceSource(own.source) && own.n >= MEASURED_GROUNDING_MIN_N) {
      const out: ArchetypePerfScoreResult = { score: own.score, n: own.n, grounding: 'measured', source: 'measured', appId };
      if (own.incumbentModel !== undefined) out.incumbentModel = own.incumbentModel;
      if (own.incumbentScore !== undefined) out.incumbentScore = own.incumbentScore;
      if (own.source) out.evidenceSource = own.source;
      return out;
    }
  }
  const rosterScore = loadArchetypePerfFromBrain().get(modelId)?.[archetype];
  const score = rosterScore ?? 5;
  const n = loadArchetypePerfNFromBrain().get(modelId)?.[archetype] ?? 0;
  const source = loadArchetypePerfSourceFromBrain().get(modelId)?.[archetype];
  // alpha.110 — measured = the SCORE was written by a measurement AND enough rows back it.
  // `n` alone is a call count (migration 050): it says the tuple was exercised, not that
  // anything measured it. See isMeasuredEvidenceSource.
  const grounding: Grounding =
    isMeasuredEvidenceSource(source) && n >= MEASURED_GROUNDING_MIN_N ? 'measured' : 'judgment';
  const out: ArchetypePerfScoreResult = { score, n, grounding, source: rosterScore === undefined ? 'default' : 'curated' };
  if (rosterScore !== undefined && typeof source === 'string' && source) out.evidenceSource = source;
  return out;
}
