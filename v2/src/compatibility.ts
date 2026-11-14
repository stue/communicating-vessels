/**
 * Archetype-cliff compatibility — alpha.28 (tt-intel-Cairn ratified).
 *
 * One question, one answer: *given this model and this intent, can it work
 * — and if not, what adapter (if any) would make it work?*
 *
 * Replaces the silent-archetype-cliff failure mode where a consumer picks a
 * model that's structurally wrong for the intent and kgauto compiles cleanly
 * without surfacing the gap. The triggering incident: tt-intel shipped
 * `deepseek-v4-pro` as the hunt default per a local spec; the kgauto coord
 * doc said L-040 — V4 is structurally wrong for hunt (sequential tools).
 * `archetypePerf.hunt = 4` was already in the profile data. The compiler
 * stayed silent. This API + the matching advisor rule surfaces it.
 *
 * Pure function. No network. No brain query. No side effects. ~1ms.
 *
 * Consultation doc:
 *   command-center/advisory/kgauto/2026-05-21_archetype-cliff-advisor.md
 *
 * Refinements applied per tt-intel-Cairn ratification (2026-05-21):
 *   R1: every variant carries `archetypePerf: number` (raw score) — and
 *       `requires-adapter` adds `archetypePerfWithAdapter: number` so
 *       consumer policy can be expressed as "accept adapter only when score
 *       crosses some threshold WITH the adapter on."
 *   R2: every variant carries a plain-English `reason: string`. No internal
 *       jargon ("L-040", "archetypePerf=4") — the consumer chooses whether
 *       to render it as UI hint or operator-tooling tooltip.
 *   R3: `Adapter` is a CLOSED discriminated union, not `| string`. alpha.28
 *       ships ONE variant (`toolOrchestration: 'sequential'`). Future
 *       adapter parameters extend the union explicitly in named releases.
 *       NO escape hatch — the whole point is catching "I added a new
 *       adapter and forgot to update consumer policy" at compile time.
 */

import { ALL_ARCHETYPES, isArchetype, type IntentArchetypeName } from './dialect.js';
import { tryGetProfile } from './profiles.js';
import type { ModelProfile } from './profiles.js';
import type { Adapter } from './ir.js';

// Re-export the canonical `Adapter` union so consumers can `import { Adapter }
// from '@warmdrift/kgauto-compiler'` alongside `getModelCompatibility`.
// The type definition itself lives in `ir.ts` to avoid the import cycle that
// would form if `compatibility.ts` were the source of truth
// (compatibility.ts → profiles.ts → ir.ts → compatibility.ts).
export type { Adapter } from './ir.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * Minimum `archetypePerf[archetype]` score to count as `compatible` under
 * Option A (default policy). Below this, a documented adapter is needed
 * to lift the model above the floor; if no adapter exists, the model is
 * rejected.
 *
 * Matches `QUALITY_FLOOR_FOR_RECOMMENDATION` in `advisor.ts` — kgauto's
 * library-wide convention for "below this score, swap recommendations stop."
 */
export const ARCHETYPE_FLOOR_DEFAULT = 6;

/**
 * Absolute floor — below this, the cliff is too steep for ANY adapter to
 * lift cleanly. Reserved under Option A (unused today; every below-floor
 * case is gated by adapter availability). Would gate `reject` vs
 * `requires-adapter` under a future Option B per consultation doc Q1.
 *
 * Exported so consumer-side policy can read it (e.g. "accept adapter only
 * when archetypePerf >= ABSOLUTE_FLOOR + 1"). Not used internally by
 * `getModelCompatibility` today — the gate is "does an adapter exist for
 * this cliff?", not score-based.
 */
export const ABSOLUTE_FLOOR = 4;

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * The intent the call is expressing — archetype + optional orchestration
 * mode. Same shape as `ir.intent.archetype` + `ir.constraints.toolOrchestration`
 * so a consumer can pass `{ archetype: ir.intent.archetype,
 * toolOrchestration: ir.constraints?.toolOrchestration }` directly.
 */
export interface CompatibilityIntent {
  archetype: IntentArchetypeName;
  toolOrchestration?: 'parallel' | 'sequential' | 'either';
}

/**
 * `Adapter` — re-exported above. Canonical definition lives in `ir.ts` to
 * avoid an import cycle (compatibility.ts → profiles.ts → ir.ts).
 *
 * **CLOSED discriminated union per R3.** Future adapter parameters extend
 * the union explicitly in named alpha releases. No `| string` escape hatch
 * — consumer policy code SHOULD write exhaustive `switch (adapter.parameter)`
 * and rely on the compiler to flag "I added a new adapter parameter and
 * forgot to update the consumer's policy."
 *
 * alpha.28 variants:
 *   - `{ parameter: 'toolOrchestration'; value: 'sequential'; consequence }`
 *     Lifts DeepSeek V4-family on `hunt` from sequential-tool cliff (L-040).
 *     The "consequence" plain-English-ifies the trade-off:
 *     "Tool calls run one at a time — slower but reliable."
 *
 * alpha.29+ likely additions (per tt-intel-Cairn priority list):
 *   - `{ parameter: 'parallelToolCalls'; value: false; consequence }`
 *   - `{ parameter: 'maxTools'; value: number; consequence }`
 *   - `{ parameter: 'thinkingBudget'; value: 0; consequence }`
 *
 * Each new variant lands in its own named release with the union extended
 * in `ir.ts`. Consumers see the change at compile time.
 */

/**
 * The compatibility verdict for a (model, intent) pair. Discriminated union
 * on `status` — `compatible` | `requires-adapter` | `reject`.
 *
 * **Every variant carries `archetypePerf` (R1) + `reason` (R2):**
 * - `archetypePerf` — the raw 0-10 score for (model, archetype). Lets
 *   consumers build their own thresholds without re-importing the profile
 *   registry.
 * - `reason` — plain-English, consumer-renderable. NOT internal jargon
 *   like "L-040 cliff" or "archetypePerf=4". Examples in R2 ratification:
 *   - compatible:        "Suited for hunt-style parallel discovery."
 *   - requires-adapter:  "Best with sequential tool calls for hunt — slower but works."
 *   - reject:            "Not suited for hunt — would underperform significantly."
 *
 * `requires-adapter` additionally carries:
 * - `archetypePerfWithAdapter` — estimated post-adapter score. May be an
 *   estimate (we don't measure post-adapter scores yet); kgauto's prior is
 *   "adapter lifts to ARCHETYPE_FLOOR_DEFAULT + 1" unless brain-evidenced.
 * - `adapter` — the closed-union variant describing the structural change.
 *
 * Backward-compat: an unknown model returns `reject` with a "model not
 * registered" reason; callers never throw. An unknown archetype ALSO returns
 * `reject` (alpha.104) — the closed `IntentArchetypeName` union guards TS
 * callers only, and JS callers passed `'tool-calling'` and `'chat'` and were
 * told `compatible`. A bare archetype string is accepted as shorthand for
 * `{ archetype }`.
 */
export type ModelCompatibility =
  | {
      status: 'compatible';
      reason: string;
      archetypePerf: number;
    }
  | {
      status: 'requires-adapter';
      reason: string;
      archetypePerf: number;
      archetypePerfWithAdapter: number;
      adapter: Adapter;
    }
  | {
      status: 'reject';
      reason: string;
      archetypePerf: number;
    };

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve raw archetypePerf score from a profile. Missing archetypes
 * default to 5 (neutral) per the master plan §3.3 convention in
 * profiles.ts ModelProfile.archetypePerf.
 *
 * This is the local (judgment-grounded) score — the brain-aware accessor
 * `getArchetypePerfScore` in `archetype-perf-brain.ts` is heavier (it pulls
 * in brain-query cache). Compatibility is a pure-function API; we read the
 * profile's hand-curated baseline directly.
 */
function rawArchetypePerf(
  profile: ModelProfile,
  archetype: IntentArchetypeName,
): number {
  // alpha.97 — the fallback was 5, one below ARCHETYPE_FLOOR_DEFAULT (6), so an
  // ABSENT measurement silently produced `reject`: "Not suited for <x> — would
  // underperform significantly", about a model nobody had measured. That is a
  // hard, consumer-visible gate resting on the absence of data.
  //
  // Scoped by measurement, not by hope: all 15 `current` profiles carry all 9
  // archetype scores (0 gaps of 135 model x archetype cells, script-counted
  // 2026-08-29), so this fallback is reached ONLY by best-effort synthesis and
  // by consumer-registered profiles without perf data — exactly the population
  // where a deficiency claim is least defensible.
  //
  // 6 means "no evidence of deficiency", not "measured good". Same standard
  // applied to DeepSeek and glm-5.2 in alpha.96. Unknown must not reduce.
  return profile.archetypePerf?.[archetype] ?? ARCHETYPE_FLOOR_DEFAULT;
}

/**
 * Detect whether a profile has a sequential-tool cliff that fires on
 * `archetype === 'hunt'` (the L-040 family). Today this is
 * profile-implicit: the cliff appears as `tool_count` metric with threshold
 * 1 + `Sequential tool calls only — L-040` reason on DeepSeek V4-family.
 *
 * Recognition signal: profile carries `parallelToolCalls === false` AND
 * the archetypePerf for hunt is below ARCHETYPE_FLOOR_DEFAULT. That's the
 * substrate-grounded indicator that "this model has a sequential-tool
 * problem on hunt that toolOrchestration: 'sequential' is the adapter for."
 *
 * Pure substrate read — no string matching on profile.notes etc.
 */
function hasSequentialToolCliffForHunt(profile: ModelProfile): boolean {
  if (profile.parallelToolCalls !== false) return false;
  const huntScore = profile.archetypePerf?.hunt ?? 5;
  return huntScore < ARCHETYPE_FLOOR_DEFAULT;
}

/**
 * Map a known cliff to its adapter shape. Returns undefined when no
 * adapter exists that would lift the model above the floor.
 *
 * alpha.28: one cliff family → one adapter (hunt + sequential-tool →
 * `toolOrchestration: 'sequential'`). Future cliffs land as additional
 * `if` branches here, each returning a new `Adapter` union variant.
 *
 * Estimated post-adapter score: the cliff's underlying capability is fine
 * (V4-Pro on `plan` is 7, on `ask` is 7) — the cliff is purely a
 * sequential-tool throughput hit on multi-step archetypes. With the
 * adapter on (one tool call per step), the cliff doesn't fire and the
 * model's underlying quality reasserts. We use the model's median
 * non-hunt archetypePerf as the post-adapter estimate, clipped to the
 * floor.
 */
function adapterForCliff(
  profile: ModelProfile,
  archetype: IntentArchetypeName,
): { adapter: Adapter; estimatedScoreWithAdapter: number } | undefined {
  // Today: the only cliff with a known adapter is the sequential-tool cliff
  // on hunt. Extend with explicit branches as new adapter variants land.
  if (archetype === 'hunt' && hasSequentialToolCliffForHunt(profile)) {
    const otherScores: number[] = [];
    if (profile.archetypePerf) {
      for (const [k, v] of Object.entries(profile.archetypePerf)) {
        if (k === 'hunt') continue;
        if (typeof v === 'number') otherScores.push(v);
      }
    }
    const sorted = [...otherScores].sort((a, b) => a - b);
    const median =
      sorted.length === 0
        ? ARCHETYPE_FLOOR_DEFAULT + 1
        : sorted[Math.floor(sorted.length / 2)] ?? ARCHETYPE_FLOOR_DEFAULT + 1;
    const estimated = Math.max(ARCHETYPE_FLOOR_DEFAULT + 1, median);
    return {
      adapter: {
        parameter: 'toolOrchestration',
        value: 'sequential',
        consequence:
          'Tool calls run one at a time instead of in parallel — slower per step but reliable for this model.',
      },
      estimatedScoreWithAdapter: estimated,
    };
  }
  return undefined;
}

/**
 * Convert an archetype name to a plain-English noun phrase for `reason`
 * strings. R2 requires consumer-renderable text — no jargon. We name the
 * archetype with its dialect description hint when natural.
 */
function archetypeDescriptor(archetype: IntentArchetypeName): string {
  // The dialect already carries plain-English descriptions, but a one-word
  // tag reads better inside a sentence ("Not suited for hunt" vs "Not
  // suited for Discover new entities..."). Use the archetype name directly
  // — `hunt`, `classify`, `summarize` are all idiomatic.
  return archetype;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compatibility query — *does this model fit this intent, and if not,
 * what would?*
 *
 * **Rules (Option A from consultation doc Q1):**
 * 1. If model is unregistered → `reject` with "model not registered" reason.
 * 2. If intent provides `toolOrchestration: 'sequential'` AND that adapter
 *    silences the cliff (because the cliff IS the sequential-tool one)
 *    → return `compatible` with raw score (NOT the post-adapter estimate
 *    — caller already paid the adapter, score reflects reality).
 * 3. If raw `archetypePerf[archetype] >= ARCHETYPE_FLOOR_DEFAULT`
 *    → `compatible`.
 * 4. If below floor BUT a documented adapter exists that lifts to floor
 *    → `requires-adapter` with adapter + estimated post-adapter score.
 * 5. If below floor AND no adapter exists → `reject`.
 *
 * **Pure function.** Deterministic for `(modelId, intent)`. No I/O.
 *
 * @example
 * ```ts
 * import { getModelCompatibility } from '@warmdrift/kgauto-compiler';
 *
 * const c = getModelCompatibility('deepseek-v4-pro', { archetype: 'hunt' });
 * // → { status: 'requires-adapter',
 * //     reason: 'Best with sequential tool calls for hunt — slower but works.',
 * //     archetypePerf: 4,
 * //     archetypePerfWithAdapter: 7,
 * //     adapter: {
 * //       parameter: 'toolOrchestration',
 * //       value: 'sequential',
 * //       consequence: 'Tool calls run one at a time...'
 * //     } }
 *
 * // With the adapter already declared:
 * const c2 = getModelCompatibility('deepseek-v4-pro', {
 *   archetype: 'hunt',
 *   toolOrchestration: 'sequential',
 * });
 * // → { status: 'compatible',
 * //     reason: 'Suited for hunt with sequential tool calls.',
 * //     archetypePerf: 4 }
 * ```
 */
export function getModelCompatibility(
  modelId: string,
  intent: CompatibilityIntent | IntentArchetypeName,
): ModelCompatibility {
  // alpha.104 — the intent is validated at RUNTIME, not only by the type.
  // tt-intelligence (2026-09-03) called this from JS with a bare string
  // (`getModelCompatibility('deepseek-v4-flash', 'ask')`) and with intents that
  // do not exist (`'tool-calling'`, `'chat'`); the destructure read
  // `archetype = undefined`, the perf lookup fell to the no-evidence floor
  // and every (model, intent) pair — twenty of twenty — came back
  // `compatible · "Suited for undefined."`. The surface their no-hardcoded-
  // models rule routes every model opinion to held none. A closed TS union
  // is not a runtime guard; a verdict about an unknown question must be
  // `reject`, never a blessing.
  const normalized: CompatibilityIntent | undefined =
    typeof intent === 'string'
      ? { archetype: intent }
      : intent && typeof intent === 'object'
        ? intent
        : undefined;
  const archetypeRaw: unknown = normalized?.archetype;
  if (typeof archetypeRaw !== 'string' || !isArchetype(archetypeRaw)) {
    return {
      status: 'reject',
      reason: `"${String(archetypeRaw)}" is not an intent kgauto knows — compatibility is defined for: ${ALL_ARCHETYPES.join(', ')}. Pass one of those as the archetype.`,
      archetypePerf: 0,
    };
  }

  const profile = tryGetProfile(modelId);
  if (!profile) {
    return {
      status: 'reject',
      reason: `Model "${modelId}" is not registered with kgauto — no compatibility data available.`,
      archetypePerf: 0,
    };
  }

  const archetype: IntentArchetypeName = archetypeRaw;
  const toolOrchestration = normalized!.toolOrchestration;
  const rawScore = rawArchetypePerf(profile, archetype);
  const descriptor = archetypeDescriptor(archetype);
  const adapterMatch = adapterForCliff(profile, archetype);

  // Case 2: consumer already passed an adapter that silences this cliff.
  // Compatible — the cliff doesn't fire under this orchestration.
  if (
    toolOrchestration === 'sequential' &&
    adapterMatch &&
    adapterMatch.adapter.parameter === 'toolOrchestration' &&
    adapterMatch.adapter.value === 'sequential'
  ) {
    return {
      status: 'compatible',
      reason: `Suited for ${descriptor} with sequential tool calls.`,
      archetypePerf: rawScore,
    };
  }

  // Case 3: raw score clears the floor — compatible without adaptation.
  if (rawScore >= ARCHETYPE_FLOOR_DEFAULT) {
    return {
      status: 'compatible',
      reason: `Suited for ${descriptor}.`,
      archetypePerf: rawScore,
    };
  }

  // Case 4: below floor but adapter exists — requires-adapter.
  if (adapterMatch) {
    return {
      status: 'requires-adapter',
      reason: `Best with ${adapterMatch.adapter.value} ${adapterMatch.adapter.parameter === 'toolOrchestration' ? 'tool calls' : adapterMatch.adapter.parameter} for ${descriptor} — slower but works.`,
      archetypePerf: rawScore,
      archetypePerfWithAdapter: adapterMatch.estimatedScoreWithAdapter,
      adapter: adapterMatch.adapter,
    };
  }

  // Case 5: below floor, no adapter — reject.
  return {
    status: 'reject',
    reason: `Not suited for ${descriptor} — would underperform significantly.`,
    archetypePerf: rawScore,
  };
}
