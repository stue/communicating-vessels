/**
 * kgauto dialect-v1 — the cross-app vocabulary.
 *
 * For learnings to flow between apps, every app must speak the same vocabulary
 * about (a) what kind of work it's asking for and (b) the rough shape of the
 * call. This file is that vocabulary. It is versioned.
 *
 * Two primitives:
 *   - IntentArchetype: WHAT the call is doing (semantic category)
 *   - ShapeSignature:  HOW the call is shaped (size, tools, history, output)
 *
 * The brain learns by `(archetype, model, shape)` tuples. Apps that declare
 * the same tuple inherit each other's mutations.
 *
 * v1 is intentionally small (10 archetypes, 5 shape dimensions). New entries
 * arrive from real usage signals — never speculatively.
 *
 * Versioning note (alpha.62): `judge` was added as an ADDITIVE 10th entry
 * under dialect-v1 rather than bumping to v2. Bumping the version string
 * would fragment every existing learning key (`v1::…` → `v2::…`) for a
 * purely additive vocabulary change; existing keys are untouched and judge
 * keys are new, so no collision is possible. A v2 bump is reserved for
 * changes that alter the MEANING of existing entries or the shape hash.
 */

export const DIALECT_VERSION = 'v1' as const;

// ─────────────────────────────────────────────────────────────────────────
// INTENT ARCHETYPES — the canonical vocabulary of "what is this call doing?"
// ─────────────────────────────────────────────────────────────────────────

export const INTENT_ARCHETYPES = {
  ask: {
    name: 'ask',
    description: 'Filter, search, or interrogate existing data',
    examples: ['filter creators by criteria', 'find docs matching query', 'lookup a record'],
  },
  hunt: {
    name: 'hunt',
    description: 'Discover new entities not in the current dataset',
    examples: ['find new prospects', 'crawl for unindexed sources', 'expand a seed list'],
  },
  classify: {
    name: 'classify',
    description: 'Assign a category from a finite set',
    examples: ['intent detection', 'sentiment', 'route-to-team'],
  },
  summarize: {
    name: 'summarize',
    description: 'Compress text or data while preserving meaning',
    examples: ['dashboard insight', 'meeting notes', 'briefing'],
  },
  generate: {
    name: 'generate',
    description: 'Produce new content from a prompt or template',
    examples: ['draft email', 'create marketing copy', 'co-founder conversation'],
  },
  extract: {
    name: 'extract',
    description: 'Pull structured data from unstructured input',
    examples: ['parse invoice', 'extract entities', 'transcript → action items'],
  },
  plan: {
    name: 'plan',
    description: 'Multi-step decomposition of a goal',
    examples: ['build a roadmap', 'sequence tasks', 'break a feature into steps'],
  },
  critique: {
    name: 'critique',
    description: 'Quality assessment, review, or scoring',
    examples: ['code review', 'design feedback', 'oracle judgment'],
  },
  transform: {
    name: 'transform',
    description: 'Change format or style while preserving content',
    examples: ['markdown → html', 'formal → casual', 'translate'],
  },
  judge: {
    name: 'judge',
    description: 'Pairwise comparison of two candidate outputs for the same input',
    examples: ['golden-set eval A/B verdict', 'model-swap not-worse check', 'response bake-off'],
  },
} as const satisfies Record<string, { name: string; description: string; examples: string[] }>;

export type IntentArchetypeName = keyof typeof INTENT_ARCHETYPES;

export const ALL_ARCHETYPES = Object.keys(INTENT_ARCHETYPES) as IntentArchetypeName[];

export function isArchetype(name: string): name is IntentArchetypeName {
  return name in INTENT_ARCHETYPES;
}

// ─────────────────────────────────────────────────────────────────────────
// SHAPE SIGNATURES — the call's structural fingerprint
// ─────────────────────────────────────────────────────────────────────────

export type ContextBucket = 'tiny' | 'small' | 'medium' | 'large' | 'huge';
export type ToolCountBucket = 'none' | 'few' | 'many' | 'massive';
export type HistoryDepth = 'single_turn' | 'short' | 'long';
export type OutputMode = 'text' | 'json' | 'tool_call';

export interface ShapeSignature {
  /** Log-binned input token count. */
  contextBucket: ContextBucket;
  /** Tool count bucket. */
  toolCountBucket: ToolCountBucket;
  /** Conversation depth. */
  historyDepth: HistoryDepth;
  /** Expected output shape. */
  outputMode: OutputMode;
  /** Whether the prompt includes few-shot examples. */
  hasExamples: boolean;
}

/**
 * SINGLE source of truth for a call's output shape.
 *
 * Two independent expressions of this concept used to exist — `computeShape`
 * (three-valued, feeding `compile_outcomes.shape_key`) and compile()'s Factor C
 * screen (two-valued). They disagreed on exactly one case: tools present with
 * no `structuredOutput`, which the shape signature calls `tool_call` and the
 * screen called `text`. That gap let alpha.68's shape-altering discipline gates
 * fire on tool-call surfaces — the surface class the design contract names as
 * forbidden, because labelling claims inside a tool-call envelope manufactures
 * the structured-output violations alpha.66 ships a retry for.
 *
 * A consumer `declared` value WINS over inference. The inference cannot see
 * that an agentic surface carrying tools ultimately emits prose, so it is
 * deliberately conservative — wrongly firing a shape-altering rule breaks a
 * parser, wrongly withholding one only forgoes a lift. `constraints.outputMode`
 * is the escape hatch for surfaces that know better.
 *
 * Takes the facts rather than a `PromptIR` so `dialect.ts` stays
 * dependency-free (`ir.ts` imports THIS module, not the reverse).
 */
export function resolveOutputMode(args: {
  declared?: OutputMode;
  structuredOutput?: boolean;
  toolCount: number;
}): OutputMode {
  if (args.declared) return args.declared;
  if (args.structuredOutput === true) return 'json';
  return args.toolCount > 0 ? 'tool_call' : 'text';
}

export function bucketContext(tokens: number): ContextBucket {
  if (tokens < 1_000) return 'tiny';
  if (tokens < 4_000) return 'small';
  if (tokens < 16_000) return 'medium';
  if (tokens < 64_000) return 'large';
  return 'huge';
}

export function bucketToolCount(count: number): ToolCountBucket {
  if (count === 0) return 'none';
  if (count <= 5) return 'few';
  if (count <= 20) return 'many';
  return 'massive';
}

export function bucketHistory(turnCount: number): HistoryDepth {
  if (turnCount <= 1) return 'single_turn';
  if (turnCount <= 6) return 'short';
  return 'long';
}

/**
 * Hash a shape signature into a compact string key. Stable across runs.
 * Format: `<context>-<tools>-<history>-<output>-<examples>`.
 */
export function hashShape(s: ShapeSignature): string {
  return [
    s.contextBucket,
    s.toolCountBucket,
    s.historyDepth,
    s.outputMode,
    s.hasExamples ? 'ex' : 'no_ex',
  ].join('-');
}

/**
 * Compose the full learning key. This is what the brain learns by — a tuple
 * any app can produce and any app can benefit from.
 */
export function learningKey(
  archetype: IntentArchetypeName,
  model: string,
  shape: ShapeSignature,
): string {
  return `${DIALECT_VERSION}::${archetype}::${model}::${hashShape(shape)}`;
}

/**
 * alpha.92 — the model segment of a learning key, route-scoped. A route is
 * part of a measurement's identity (execute-leg contract): the same model id
 * through a gateway is a different serving stack per host, so non-direct
 * evidence carries the route dimension (`model@openrouter`) and can never
 * pollute direct-vendor evidence. ONE derivation, used by compile() and
 * registerCompile() both — two inline encodings of one concept is the s75
 * drift shape.
 */
export function routeScopedModel(model: string, route?: 'direct' | 'openrouter'): string {
  return route === 'openrouter' ? `${model}@openrouter` : model;
}
