/**
 * Family resolution — alpha.41.
 *
 * "I want the latest Opus" → kgauto picks the current+active model in the
 * `claude-opus` family. Closes the loop where consumer code carries hardcoded
 * `claude-opus-4-6` literals long after `claude-opus-4-7` ships and goes
 * current — the s47 trigger (IC's `generate` chain still routing 43 calls to
 * legacy 4-6 in production).
 *
 * Two surfaces:
 *   - `getRecommendedPrimary({ family, ..., fallback })` — public, sync,
 *     used at IR-construction time when the consumer wants a literal id back
 *     (with a fallback floor for cold-start brain).
 *   - `resolveFamilyEntry({ family, archetype?, appId? })` — internal,
 *     called from compile() when an IR's `models[]` entry is shaped
 *     `{ family: string }`. Throws `FamilyResolutionError` on failure.
 *
 * Both routes share the same algorithm (locked in the alpha.41 Phase 0
 * design contract); they differ only in the fallback ergonomics. The
 * public route accepts a required `fallback: string`; the IR route throws.
 *
 * Pure resolution. No network. No async. Brain-registry reads go through
 * the existing SWR cache (`loadModelsFromBrain` from `models-brain.ts`) —
 * cold-start returns bundled profiles, which still resolve via the
 * `deriveFamilyFromModelId` fallback when the brain row's `family` column
 * is null (G1 contract: graceful pre-migration behavior).
 *
 * @see command-center/advisory/kgauto/2026-05-26_alpha-41-model-family-aliases-and-promotion-probe-watcher.md
 */

import type { IntentArchetypeName } from './dialect.js';
import type { ModelProfile } from './profiles.js';
import { loadModelsFromBrain } from './models-brain.js';
import { ARCHETYPE_FLOOR_DEFAULT } from './compatibility.js';
import { getStaleExclusionFindings } from './exclusion-findings-brain.js';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface GetRecommendedPrimaryOptions {
  /**
   * Family tag (e.g. `'claude-opus'`, `'gemini-flash'`). See the Phase 0
   * design contract's family taxonomy table for the locked initial set;
   * extensible via brain migrations.
   */
  family: string;
  /**
   * Optional archetype gate. When provided, candidates must clear
   * {@link ARCHETYPE_FLOOR_DEFAULT} on `archetypePerf[archetype]`. Also used
   * as the primary sort key (DESC) when multiple candidates qualify.
   */
  archetype?: IntentArchetypeName;
  /**
   * Optional consumer-app id. When provided, candidates matching a
   * `stay-excluded` finding for `(appId, archetype)` in the
   * exclusion-findings cache (alpha.38 substrate) are filtered out.
   */
  appId?: string;
  /**
   * Consumer-posture tag. `'locked'` short-circuits resolution and returns
   * the literal `fallback` unconditionally — useful for compliance /
   * contract / brand-promise flows where the consumer doesn't want kgauto
   * picking the model on their behalf.
   */
  posture?: 'preferred' | 'open' | 'locked';
  /**
   * Last-resort literal model id. REQUIRED. Returned when (a) brain
   * registry is cold / no candidates exist, (b) `posture === 'locked'`,
   * (c) every candidate was filtered out by archetype / exclusion gates.
   *
   * The fallback is NOT validated against the family — kgauto trusts the
   * consumer to pass a meaningful floor. The contract intent is "even when
   * everything below is on fire, you still get a model id back."
   */
  fallback: string;
}

/**
 * Thrown by `resolveFamilyEntry` (the internal compile-time twin) when a
 * `{ family: string }` IR entry can't resolve to any current+active model.
 * Surfaces with the family string + a one-line cause so consumer error
 * handling can distinguish "you typo'd the family tag" from "brain is cold
 * and nothing matches."
 *
 * The public `getRecommendedPrimary` does NOT throw — it returns
 * `fallback` instead.
 */
export class FamilyResolutionError extends Error {
  readonly family: string;
  override readonly cause: string;
  constructor(family: string, cause: string) {
    super(
      `Family "${family}" did not resolve to any current+active model. ${cause}. Pass a literal model id in ir.models, or call getRecommendedPrimary({ family, fallback }) at IR-construction time.`,
    );
    this.name = 'FamilyResolutionError';
    this.family = family;
    this.cause = cause;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Family taxonomy — deterministic fallback when brain row's family is null.
// Mirror the Phase 0 contract's mapping table + migration 024 CASE statement
// byte-for-byte. Phase 2 reconciliation audits both sides match.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic model_id → family inference. Pure function; no brain
 * lookup. Used as the runtime fallback when a brain row's `family` column
 * is null (pre-migration 024) and as the canonical mapping that migration
 * 024's CASE statement mirrors.
 *
 * Returns null for unrecognized ids — caller must handle (typically by
 * skipping the row in family resolution).
 *
 * Order matters: more specific patterns first (e.g. `flash-lite` before
 * `flash`; `pro` before `chat`). The brain-side CASE statement uses the
 * same priority.
 */
export function deriveFamilyFromModelId(modelId: string): string | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  // Anthropic
  if (modelId.startsWith('claude-opus-')) return 'claude-opus';
  if (modelId.startsWith('claude-sonnet-')) return 'claude-sonnet';
  if (modelId.startsWith('claude-haiku-')) return 'claude-haiku';
  // Google — flash-lite is a distinct family (gemini-3.1-flash-lite vs
  // gemini-2.5-flash). Check 'flash-lite' before 'flash'.
  if (modelId.startsWith('gemini-') && modelId.includes('flash-lite')) {
    return 'gemini-flash-lite';
  }
  if (modelId.startsWith('gemini-') && modelId.includes('flash')) {
    return 'gemini-flash';
  }
  if (modelId.startsWith('gemini-') && modelId.includes('pro')) {
    return 'gemini-pro';
  }
  // DeepSeek — V4-Pro is the reasoner family; everything else is chat.
  // Check 'pro' before generic 'deepseek-' so the more-specific wins.
  if (modelId.startsWith('deepseek-') && modelId.includes('pro')) {
    return 'deepseek-reasoner';
  }
  if (modelId.startsWith('deepseek-')) return 'deepseek-chat';
  // OpenAI — gpt-* covers gpt-5, gpt-5-mini, gpt-4 etc.; o-series reserved
  // for a future entry.
  if (modelId.startsWith('gpt-')) return 'openai-gpt';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Resolution algorithm — locked in Phase 0 design contract.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read the family tag for a profile, applying the G1 fallback. When the
 * profile carries an explicit `family` field (from brain migration 024),
 * use it; otherwise derive from `profile.id`. Returns null when neither
 * resolves — caller treats as "not in any known family."
 */
function familyOf(profile: ModelProfile): string | null {
  return profile.family ?? deriveFamilyFromModelId(profile.id);
}

/**
 * Read archetype performance score with the standard "missing = 5" default
 * convention (matches `archetypePerf` semantics in profiles.ts).
 */
function archetypePerfFor(
  profile: ModelProfile,
  archetype: IntentArchetypeName | undefined,
): number {
  if (!archetype) return 0;
  const score = profile.archetypePerf?.[archetype];
  return typeof score === 'number' ? score : 5;
}

/**
 * Filter a brain-registry snapshot to family-matching, current, active
 * candidates. Pure; takes the registry + opts; returns the candidate list
 * (post archetype + appId gates).
 */
function selectCandidates(
  registry: Map<string, ModelProfile>,
  family: string,
  archetype: IntentArchetypeName | undefined,
  appId: string | undefined,
): ModelProfile[] {
  const out: ModelProfile[] = [];
  // Build exclusion set when appId+archetype present. The exclusion-findings
  // cache is keyed per (appId, archetype) with `verdict === 'stay-excluded'`
  // marking models the consumer has decided NOT to route to. Cold cache /
  // unconfigured returns empty array → no filtering applied.
  const excluded = new Set<string>();
  if (appId && archetype) {
    const findings = getStaleExclusionFindings({ appId, archetype });
    for (const f of findings) {
      if (f.verdict === 'stay-excluded') excluded.add(f.excludedModel);
    }
  }
  for (const profile of registry.values()) {
    // Step 2: family + status + active filter.
    if (familyOf(profile) !== family) continue;
    // alpha.126 — ELIGIBILITY reads `status` ONLY. `providerLifecycle` (the page's
    // word) is never read here: Anthropic listed claude-opus-5 / claude-sonnet-5 /
    // claude-haiku-4-5 as legacy on 2026-10-25 while golden run #42 kept the
    // claude-sonnet head on sonnet-5 (5.5 below the bar on extract). A page's word
    // moves a head only after it has moved `status` — on a measurement, on
    // `retired`, or when the seat records why. Pinned by
    // tests/alpha126-provider-lifecycle.test.ts §5.
    if (profile.status !== 'current') continue;
    // `active` is undefined on bundled profiles (no brain row); treat
    // undefined as active=true (bundled IS the source of truth at bundle
    // time, per profile-side default).
    if (profile.active === false) continue;
    // Step 3: archetype gate (TRANSLATOR_FLOOR === ARCHETYPE_FLOOR_DEFAULT).
    if (archetype) {
      if (archetypePerfFor(profile, archetype) < ARCHETYPE_FLOOR_DEFAULT) continue;
    }
    // Step 4: per-(appId, archetype) exclusion filter.
    if (excluded.has(profile.id)) continue;
    out.push(profile);
  }
  return out;
}

/**
 * alpha.101 — order two `versionAdded` values. Numeric per dotted/dashed
 * segment, string otherwise; `undefined` is the OLDEST value (a model with
 * no version stamp never outranks one that has one — most bundled profiles
 * carry none, so this is the common case, not the edge).
 *
 * Why this exists: the sort above it was lexicographic with a comment
 * claiming that "works for `2.0.0-alpha.N`-style strings". It does not once
 * N crosses a digit boundary: `'2.0.0-alpha.11' > '2.0.0-alpha.101'` as
 * strings, so the first three-digit alpha (this release) would have ranked
 * BELOW alpha.11 — found by this release's own smoke (G6): the brain row for
 * gemini-3.7-flash was stamped `2.0.0-alpha.101` and every brain-connected
 * consumer's `gemini-flash` head silently became gemini-2.5-flash (stamped
 * alpha.11). Consumers on ≤ alpha.100 still carry the string compare, so
 * brain rows keep their registration-time stamps until those consumers move.
 * ISO dates (`2026-09-03`) still order correctly: their segments are numeric.
 */
export function compareVersionAdded(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1; // unstamped = oldest; in the DESC head order it sorts last
  if (b === undefined) return 1;
  const segs = (v: string) => v.split(/[.\-]/);
  const sa = segs(a);
  const sb = segs(b);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1; // shorter (a prefix) sorts first
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx < ny ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Sort candidates by the locked secondary keys: archetype_perf DESC,
 * then version_added DESC (lexicographic — works for `2.0.0-alpha.N`-style
 * strings and ISO dates), then id ASC for full stability.
 */
function sortCandidates(
  candidates: ModelProfile[],
  archetype: IntentArchetypeName | undefined,
): ModelProfile[] {
  const sorted = [...candidates];
  sorted.sort((a, b) => {
    const perfA = archetypePerfFor(a, archetype);
    const perfB = archetypePerfFor(b, archetype);
    if (perfA !== perfB) return perfB - perfA;
    const byVersion = compareVersionAdded(b.versionAdded, a.versionAdded); // DESC
    if (byVersion !== 0) return byVersion;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted;
}

/**
 * Public sync resolver. Pure (modulo brain snapshot read). Returns the
 * literal model id of the best candidate, or `fallback` when resolution
 * yields nothing.
 */
export function getRecommendedPrimary(
  opts: GetRecommendedPrimaryOptions,
): string {
  // Step 5: short-circuit on locked posture.
  if (opts.posture === 'locked') return opts.fallback;

  const registry = loadModelsFromBrain();
  const candidates = selectCandidates(
    registry,
    opts.family,
    opts.archetype,
    opts.appId,
  );
  // Step 7: empty → fallback.
  if (candidates.length === 0) return opts.fallback;
  // Step 6 + 8: sort and pick top.
  const sorted = sortCandidates(candidates, opts.archetype);
  return sorted[0]?.id ?? opts.fallback;
}

/**
 * Internal compile-time twin. Same algorithm as `getRecommendedPrimary` but
 * throws `FamilyResolutionError` when resolution would have fallen back —
 * the IR shape `{ family: string }` has no fallback by design (consumers
 * who want a fallback inline the resolved id at IR-construction time).
 *
 * Exported for direct use in compile.ts; not part of the public API
 * surface (consumers should use `getRecommendedPrimary` instead).
 */
/**
 * alpha.107 — WHICH KIND of opinion a family resolution is. tt-intelligence
 * (2026-09-04) had two kgauto truths for one classify call: the family head
 * said `gemini-3.7-flash`, the archetype chain and the cost rule said
 * `gemini-2.5-flash`. Both were right about different things: the head is a
 * LIFECYCLE choice (newest current model once archetype performance ties),
 * the chain is a performance choice. The resolution now says which.
 *
 *   - `archetype-perf`  the winner strictly out-scored the runner-up on the
 *                       call's archetype — a performance opinion;
 *   - `lifecycle`       archetype performance tied (or no archetype given) and
 *                       the newest `versionAdded` won — a lifecycle opinion,
 *                       NOT a measured one;
 *   - `only-candidate`  nothing else in the family was current + active + above
 *                       the floor.
 */
export interface FamilyResolution {
  family: string;
  id: string;
  basis: 'archetype-perf' | 'lifecycle' | 'only-candidate';
  archetype?: IntentArchetypeName;
  /** The winner's archetype-performance score (0 when no archetype was given). */
  perf: number;
  runnerUp?: { id: string; perf: number; versionAdded?: string };
  candidateCount: number;
}

export function resolveFamilyEntryDetailed(
  family: string,
  ctx: { archetype?: IntentArchetypeName; appId?: string },
): FamilyResolution {
  const id = resolveFamilyEntry(family, ctx);
  const registry = loadModelsFromBrain();
  const sorted = sortCandidates(selectCandidates(registry, family, ctx.archetype, ctx.appId), ctx.archetype);
  const winner = sorted[0]!;
  const second = sorted[1];
  const perf = archetypePerfFor(winner, ctx.archetype);
  if (!second) return { family, id, basis: 'only-candidate', archetype: ctx.archetype, perf, candidateCount: sorted.length };
  const perf2 = archetypePerfFor(second, ctx.archetype);
  return {
    family,
    id,
    basis: ctx.archetype && perf !== perf2 ? 'archetype-perf' : 'lifecycle',
    archetype: ctx.archetype,
    perf,
    runnerUp: { id: second.id, perf: perf2, versionAdded: second.versionAdded },
    candidateCount: sorted.length,
  };
}

export function resolveFamilyEntry(
  family: string,
  ctx: { archetype?: IntentArchetypeName; appId?: string },
): string {
  if (typeof family !== 'string' || family.length === 0) {
    throw new FamilyResolutionError(
      String(family),
      'Family tag must be a non-empty string',
    );
  }
  const registry = loadModelsFromBrain();
  const candidates = selectCandidates(
    registry,
    family,
    ctx.archetype,
    ctx.appId,
  );
  if (candidates.length === 0) {
    // Probe the registry for context-rich error messages — was the family
    // unrecognized entirely, or just empty after gates?
    let anyInFamily = false;
    for (const profile of registry.values()) {
      if (familyOf(profile) === family) {
        anyInFamily = true;
        break;
      }
    }
    const cause = anyInFamily
      ? `Family has registered models but none are current+active${ctx.archetype ? ` at archetype-perf >= ${ARCHETYPE_FLOOR_DEFAULT} for "${ctx.archetype}"` : ''}${ctx.appId ? ` and not excluded for app "${ctx.appId}"` : ''}`
      : `No models in brain registry carry family="${family}". Check the taxonomy table in family-resolution.ts or migration 024`;
    throw new FamilyResolutionError(family, cause);
  }
  const sorted = sortCandidates(candidates, ctx.archetype);
  const winner = sorted[0];
  if (!winner) {
    throw new FamilyResolutionError(
      family,
      'Candidates non-empty but sort returned undefined — internal invariant violation',
    );
  }
  return winner.id;
}
