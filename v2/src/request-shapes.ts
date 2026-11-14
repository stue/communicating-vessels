/**
 * alpha.121 — request shapes a model documents as a hard 400, gated before the
 * wire and SAID.
 *
 * Claude Opus 5.5 and Claude Sonnet 5.5 reject (HTTP 400) four shapes earlier
 * Claude models accepted (migration guides, read 2026-10-06). kgauto's own
 * Anthropic lowering can emit only one of them — a trailing assistant turn,
 * copied verbatim from the IR's history/currentTurn — and drops it in
 * `lowerAnthropic`. The other three reach the wire only through the consumer's
 * `providerOverrides.anthropic` (shallow-merged in execute.ts), so `call()`
 * gates the override layer per attempt with `gateProviderOverrides` below.
 * Every drop becomes a `request-shape-rejected-by-model` advisory (level
 * `info`): the field dropped and the vendor's own sentence — never a 400 on the
 * consumer's bill, never a silent rewrite.
 *
 * The second half is the fallover rule: thinking blocks are tied to the model
 * that produced them. A conversation that falls over from a 5.5 model to one
 * that cannot read its blocks runs without them on Anthropic (the API drops
 * them, HTTP 200 — Sonnet 5.5 guide) and would carry Anthropic-shaped blocks
 * into another provider's wire (the Google / OpenAI-family lowerings pass
 * `parts` verbatim). `call()` strips them on that leg and says so.
 *
 * alpha.125 — Claude Haiku 5.5 (pages read 2026-10-25) joins on both halves:
 * it rejects `thinking_control` with a DIFFERENT set of types (enabled +
 * between_tools; `disabled` is accepted — THINKING_TYPES_REJECTED), it ACCEPTS
 * forced tool_choice (not in its `rejects`), and the thinking-block verdicts
 * live in one data table (THINKING_BLOCK_MATRIX) with Haiku 5.5 as producer
 * and as reader.
 */

import type { BestPracticeAdvisory, InputTransformation, Message, ProviderOverrides } from './ir.js';
import type { ModelProfile, RejectedRequestShape } from './profiles.js';
import { deriveOwnership } from './advisor.js';

/** The vendor's own words for each shape, verbatim from the 2026-10-06 migration guides. */
export const REJECTED_SHAPE_VENDOR_SENTENCE: Readonly<Record<RejectedRequestShape, string>> = Object.freeze({
  thinking_control: '"thinking.type.disabled" is not supported for this model. / "thinking.type.enabled" is not supported for this model.',
  forced_tool_choice: 'tool_choice: type "tool" and "any" are not supported for this model.',
  sampling_params:
    'Omit `temperature`, `top_p`, and `top_k`, or leave them at their defaults: any other value is rejected.',
  assistant_prefill:
    'This model does not support assistant message prefill. The conversation must end with a user message.',
});

export interface RejectedShapeDrop {
  shape: RejectedRequestShape;
  /** The request field dropped (`thinking`, `tool_choice`, `temperature`, `messages[-1]`, …). */
  field: string;
  /** Where it came from: kgauto's own lowering, or the consumer's providerOverrides. */
  source: 'lowering' | 'providerOverrides';
  /** What was on the wire-to-be, in a few words. */
  detail: string;
  /**
   * alpha.125 — the vendor sentence for THIS model when it differs from the
   * shape's default in {@link REJECTED_SHAPE_VENDOR_SENTENCE} (Haiku 5.5
   * accepts `thinking: disabled`, so the Opus 5.5 sentence would misquote it).
   */
  vendor?: string;
}

/**
 * alpha.125 — which `thinking.type` values the `thinking_control` shape means,
 * per model. The alpha.121 meaning (Opus 5.5 / Sonnet 5.5 migration guides,
 * 2026-10-06) is the default: `disabled` and `enabled` are 400s. Claude Haiku
 * 5.5 differs, per the per-model table on
 * https://platform.claude.com/docs/en/build-with-claude/thinking (read
 * 2026-10-25), row "Claude Haiku 5.5": `"enabled"` with `budget_tokens` → 400
 * error, `"between_tools"` → 400 error, `"disabled"` → "Thinking off at `high`
 * effort or below" (accepted). Dropping `disabled` there would amputate the
 * one way to turn its thinking off (alpha.103); passing `between_tools` would
 * be a 400 on the consumer's bill.
 */
export const THINKING_TYPES_REJECTED: Readonly<Record<string, { types: readonly string[]; vendor: string }>> = Object.freeze({
  // alpha.125 — same table, row "Claude Opus 5.5": `"enabled"` with
  // `budget_tokens` → 400 error, `"between_tools"` → 400 error, `"disabled"` →
  // 400 error. (was: the default disabled + enabled, which let between_tools
  // through to a 400, until 2026-10-25.)
  'claude-opus-5-5': Object.freeze({
    types: Object.freeze(['disabled', 'enabled', 'between_tools']),
    // The alpha.121 migration-guide error strings, plus the thinking page's between_tools cell.
    vendor:
      '"thinking.type.disabled" is not supported for this model. / "thinking.type.enabled" is not supported for this model. / `"between_tools"` → 400 error (thinking page, per-model table, row "Claude Opus 5.5").',
  }),
  // alpha.125 — rows "Claude Opus 5" and "Claude Sonnet 5": `"enabled"` with
  // `budget_tokens` → 400 error, `"between_tools"` → 400 error; `"disabled"` →
  // "Thinking off at `high` effort or below" (Opus 5) / "Thinking off" (Sonnet
  // 5) — accepted, so it passes. (Opus 5 at xhigh/max + disabled is a 400 per
  // the same page; that depends on the request's effort and is not gated.)
  'claude-opus-5': Object.freeze({
    types: Object.freeze(['enabled', 'between_tools']),
    vendor:
      'Claude Opus 5: `"enabled"` with `budget_tokens` → 400 error; `"between_tools"` → 400 error (thinking page, per-model table). `"disabled"` turns thinking off at `high` effort or below; use `{"type": "adaptive"}` with effort to steer it.',
  }),
  'claude-sonnet-5': Object.freeze({
    types: Object.freeze(['enabled', 'between_tools']),
    vendor:
      'Claude Sonnet 5: `"enabled"` with `budget_tokens` → 400 error; `"between_tools"` → 400 error (thinking page, per-model table). `"disabled"` turns thinking off; use `{"type": "adaptive"}` with effort to steer it.',
  }),
  // alpha.132 — row "Claude Fable 5.2" of the same table (read 2026-11-11T23:34Z):
  // `"enabled"` with `budget_tokens` → 400 error, `"between_tools"` → 400 error,
  // `"disabled"` → 400 error ("Thinking can't be turned off on these models").
  'claude-fable-5-2': Object.freeze({
    types: Object.freeze(['disabled', 'enabled', 'between_tools']),
    vendor:
      'Claude Fable 5.2: `"disabled"`, `"enabled"` with `budget_tokens` and `"between_tools"` each → 400 error (thinking page, per-model table, row "Claude Fable 5.2"); "Adaptive thinking is always on and can\'t be turned off. Control thinking depth with the effort parameter." (Fable 5.2 overview)',
  }),
  // alpha.132 (Amendment B 3) — row "Claude Fable 5.1" of the same table (read
  // 2026-11-12T00:16:33Z): `"enabled"` with `budget_tokens` → 400 error,
  // `"between_tools"` → 400 error, `"disabled"` → 400 error.
  'claude-fable-5-1': Object.freeze({
    types: Object.freeze(['disabled', 'enabled', 'between_tools']),
    vendor:
      'Claude Fable 5.1: `"disabled"`, `"enabled"` with `budget_tokens` and `"between_tools"` each → 400 error (thinking page, per-model table, row "Claude Fable 5.1"); "Thinking can\'t be turned off on these models."',
  }),
  'claude-haiku-5-5': Object.freeze({
    types: Object.freeze(['enabled', 'between_tools']),
    vendor:
      'A `thinking` value of `{"type": "enabled", "budget_tokens": N}` returns a 400 error (Haiku 5.5 migration guide); `"between_tools"` → 400 error (thinking page, per-model table). Leave `thinking` unset or set it to `{"type": "adaptive"}`.',
  }),
});
const THINKING_TYPES_REJECTED_DEFAULT: readonly string[] = Object.freeze(['disabled', 'enabled']);

/** The `thinking.type` values `thinking_control` rejects for this model. */
export function rejectedThinkingTypes(modelId: string | undefined): readonly string[] {
  return (modelId !== undefined && THINKING_TYPES_REJECTED[modelId]?.types) || THINKING_TYPES_REJECTED_DEFAULT;
}

/** Does this profile document `shape` as a 400? */
export function profileRejects(profile: Pick<ModelProfile, 'lowering'> | undefined, shape: RejectedRequestShape): boolean {
  return profile?.lowering?.rejects?.includes(shape) === true;
}

/**
 * Drop the trailing assistant turn(s) from an Anthropic `messages` array when
 * the profile rejects prefill. Pure; returns the input array untouched when
 * nothing is dropped.
 */
export function dropTrailingAssistantTurns(
  messages: Array<{ role: string; content: unknown }>,
  profile: Pick<ModelProfile, 'lowering'>,
  source: RejectedShapeDrop['source'],
): { messages: Array<{ role: string; content: unknown }>; dropped: RejectedShapeDrop[] } {
  if (!profileRejects(profile, 'assistant_prefill')) return { messages, dropped: [] };
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === 'assistant') end--;
  const n = messages.length - end;
  if (n === 0) return { messages, dropped: [] };
  return {
    messages: messages.slice(0, end),
    dropped: [
      {
        shape: 'assistant_prefill',
        field: 'messages',
        source,
        detail: `${n} trailing assistant turn${n === 1 ? '' : 's'} (a prefill) removed; the request now ends with ${end > 0 ? 'the last user turn' : 'no messages'}`,
      },
    ],
  };
}

/**
 * Gate one provider-override layer against the profile's documented
 * rejections. Pure; returns the same object when nothing applies.
 */
export function gateOverrideLayer(
  layer: Record<string, unknown>,
  profile: Pick<ModelProfile, 'lowering'> & { id?: string },
): { layer: Record<string, unknown>; dropped: RejectedShapeDrop[] } {
  const dropped: RejectedShapeDrop[] = [];
  let out: Record<string, unknown> | undefined;
  const edit = (): Record<string, unknown> => (out ??= { ...layer });

  if (profileRejects(profile, 'thinking_control') && layer.thinking && typeof layer.thinking === 'object') {
    const type = (layer.thinking as { type?: unknown }).type;
    // Per model (THINKING_TYPES_REJECTED): by default `disabled` and `enabled`;
    // on Haiku 5.5 `enabled` and `between_tools`. `adaptive` is accepted by all.
    if (typeof type === 'string' && rejectedThinkingTypes(profile.id).includes(type)) {
      delete edit().thinking;
      const vendor = profile.id !== undefined ? THINKING_TYPES_REJECTED[profile.id]?.vendor : undefined;
      dropped.push({
        shape: 'thinking_control',
        field: 'thinking',
        source: 'providerOverrides',
        detail: `thinking.type '${type}'`,
        ...(vendor ? { vendor } : {}),
      });
    }
  }
  if (profileRejects(profile, 'forced_tool_choice') && layer.tool_choice && typeof layer.tool_choice === 'object') {
    const tc = layer.tool_choice as { type?: unknown; disable_parallel_tool_use?: unknown };
    if (tc.type === 'any' || tc.type === 'tool') {
      // The vendor's remedy is `auto`; a sequential-calls flag the consumer set survives.
      if (tc.disable_parallel_tool_use === true) edit().tool_choice = { type: 'auto', disable_parallel_tool_use: true };
      else delete edit().tool_choice;
      dropped.push({
        shape: 'forced_tool_choice',
        field: 'tool_choice',
        source: 'providerOverrides',
        detail: `tool_choice.type '${String(tc.type)}' → ${tc.disable_parallel_tool_use === true ? "{ type: 'auto', disable_parallel_tool_use: true }" : "omitted (provider default auto)"}`,
      });
    }
  }
  if (profileRejects(profile, 'sampling_params')) {
    // Every value is dropped, the default included: kgauto cannot tell a default
    // from a non-default per model, and omitting is the vendor's own path ("The
    // safest migration path is to omit these parameters entirely").
    for (const key of ['temperature', 'top_p', 'top_k'] as const) {
      if (layer[key] === undefined) continue;
      const v = layer[key];
      delete edit()[key];
      dropped.push({ shape: 'sampling_params', field: key, source: 'providerOverrides', detail: `${key}: ${JSON.stringify(v)}` });
    }
  }
  if (Array.isArray(layer.messages)) {
    const r = dropTrailingAssistantTurns(layer.messages as Array<{ role: string; content: unknown }>, profile, 'providerOverrides');
    if (r.dropped.length > 0) {
      edit().messages = r.messages;
      dropped.push(...r.dropped);
    }
  }
  return { layer: out ?? layer, dropped };
}

/**
 * Gate `providerOverrides` for one target. Only the `anthropic` layer is read
 * (the profiles that carry `rejects` are Anthropic's; the OpenRouter route has
 * its own layer and its own wire). Returns the same object when nothing applies.
 */
export function gateProviderOverrides(
  overrides: ProviderOverrides | undefined,
  profile: (Pick<ModelProfile, 'lowering' | 'provider'> & { id?: string }) | undefined,
): { overrides: ProviderOverrides | undefined; dropped: RejectedShapeDrop[] } {
  if (!overrides || !profile || profile.provider !== 'anthropic' || !overrides.anthropic) {
    return { overrides, dropped: [] };
  }
  if (!profile.lowering?.rejects?.length) return { overrides, dropped: [] };
  const g = gateOverrideLayer(overrides.anthropic, profile);
  if (g.dropped.length === 0) return { overrides, dropped: [] };
  return { overrides: { ...overrides, anthropic: g.layer }, dropped: g.dropped };
}

/** The `request-shape-rejected-by-model` advisory for one model's drops. */
export function rejectedShapeAdvisory(model: string, drops: RejectedShapeDrop[], handle?: string): BestPracticeAdvisory {
  const code = 'request-shape-rejected-by-model';
  const shapes = [...new Set(drops.map((d) => d.shape))];
  // One sentence per shape: the model's own (drop.vendor) when it has one, else the shape default.
  const sentences = shapes.map((s) => drops.find((d) => d.shape === s && d.vendor)?.vendor ?? REJECTED_SHAPE_VENDOR_SENTENCE[s]);
  return {
    level: 'info',
    code,
    message:
      `${model} rejects ${shapes.length === 1 ? 'this request shape' : 'these request shapes'} with HTTP 400, so kgauto dropped ${drops.length === 1 ? 'it' : 'them'} before the wire: ` +
      drops.map((d) => `${d.field} (${d.detail}; from ${d.source})`).join('; ') +
      '. The provider says: ' +
      sentences.map((s) => `"${s}"`).join(' '),
    suggestion:
      'Stop sending it for this model: steer thinking with `output_config.effort` (or omit `thinking`), use `tool_choice: auto` with strict tools or structured output instead of forcing a tool, guide output by prompt instead of sampling params, and end the conversation with a user turn.',
    docsUrl: migrationGuideUrl(model),
    recommendationType: 'prompt-fix',
    ...(handle ? { kgautoRequestId: handle } : {}),
    ownership: deriveOwnership(code),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Thinking blocks on fallover (alpha.121 item C)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row of the thinking-block matrix: does `reader` read `producer`'s
 * thinking blocks? Ids match exactly, or by prefix when they end in `*`
 * (`claude-fable-*`); `reader: '*'` is "any other model". Rows are read top to
 * bottom and the FIRST row matching (producer, reader) decides; a pair no row
 * matches is not gated (its blocks pass as given — the alpha.121 default).
 */
export interface ThinkingBlockRule {
  producer: string;
  reader: string;
  reads: boolean;
  /** The page sentence this row encodes. */
  source: string;
}

const OPUS_55_GUIDE = 'https://platform.claude.com/docs/en/models/opus-5-5/migration-guide';
const HAIKU_55_GUIDE = 'https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide';
/** alpha.132 — the Fable 5.2 migration guide (read 2026-11-11T23:32Z). */
export const FABLE_52_GUIDE = 'https://platform.claude.com/docs/en/models/fable-5-2/migration-guide';
/** alpha.132 — the preserved-thinking page (read 2026-11-11T23:32Z), source of the Fable 5.2 rows and the block-binding control. */
export const PRESERVED_THINKING_PAGE = 'https://platform.claude.com/docs/en/build-with-claude/preserved-thinking';
// alpha.132 — the page's table "Which model switches keep the reasoning on the
// Claude API" (PRESERVED_THINKING_PAGE, read 2026-11-11T23:32Z): the column
// "To Claude Fable 5.2 or Claude Mythos 5.2" is ✅ on all seven rows (Haiku 5.5,
// Sonnet 5.5, Opus 5, Opus 5.5, Fable 5 / Mythos 5, Fable 5.1 / Mythos 5.1,
// Fable 5.2 / Mythos 5.2); the row "Claude Fable 5.2 or Claude Mythos 5.2" is ✅
// only in that column.
const FABLE_52_READS =
  'Which model switches keep the reasoning on the Claude API — column "To Claude Fable 5.2 or Claude Mythos 5.2": ✅ from Claude Haiku 5.5, Claude Sonnet 5.5, Claude Opus 5, Claude Opus 5.5, Claude Fable 5 or Claude Mythos 5, Claude Fable 5.1 or Claude Mythos 5.1 (preserved-thinking page)';
const FABLE_52_READS_EARLIER =
  'Claude Sonnet 5 and earlier Opus, Sonnet, and Haiku models are the earlier models in this section. A conversation that moves from one of them to … any Claude Fable or Claude Mythos model keeps its reasoning. (preserved-thinking page, "Earlier models")';
const FABLE_52_READ_BY =
  'Row "Claude Fable 5.2 or Claude Mythos 5.2": ✅ only under "To Claude Fable 5.2 or Claude Mythos 5.2"; — under Fable 5.1 / Mythos 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 (preserved-thinking page). "Claude Fable 5.1 can\'t read Claude Fable 5.2\'s thinking blocks" (Fable 5.2 migration guide, breaking change 2).';
const HAIKU_55_READS =
  'Claude Haiku 5.5 reads thinking blocks from Claude Sonnet 5, Claude Opus 4.8, Claude Haiku 4.5, and earlier models';
const HAIKU_55_DOES_NOT_READ =
  "It doesn't read blocks from Claude Opus 5, Claude Opus 5.5, Claude Sonnet 5.5, or any Claude Fable or Claude Mythos model; the API drops those without an error.";
const HAIKU_55_READ_BY =
  "On the Claude API and Claude Models on Google Cloud (Google managed), Claude Opus 5.5 and Claude Sonnet 5.5 read Claude Haiku 5.5's blocks.";

/**
 * The thinking-block matrix, as data. alpha.121 rows from the Opus 5.5 /
 * Sonnet 5.5 migration guides (read 2026-10-06); alpha.125 rows from the Haiku
 * 5.5 migration guide, *Configure thinking*, last paragraph (read 2026-10-25,
 * HAIKU_55_GUIDE) — the same matrix is on
 * https://platform.claude.com/docs/en/build-with-claude/thinking ("Switching
 * models mid-conversation"). The API drops an unreadable block silently (HTTP
 * 200); kgauto strips it on that leg and SAYS so — it says what the wire hides.
 */
export const THINKING_BLOCK_MATRIX: readonly ThinkingBlockRule[] = Object.freeze([
  // ── alpha.132: Claude Fable 5.2 as the READER — FIRST, so no producer-side
  // `reader: '*'` row below (opus-5-5, sonnet-5-5, haiku-5-5) shadows a pair the
  // page keeps (R2: the first matching row decides). ──
  { producer: 'claude-haiku-5-5', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-sonnet-5-5', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-opus-5', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-opus-5-5', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-fable-5', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-fable-5-1', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS },
  { producer: 'claude-mythos-*', reader: 'claude-fable-5-2', reads: true, source: `${FABLE_52_READS}; and "they read each other's thinking blocks" (thinking page, Fable 5.2 and Mythos 5.2) — Mythos is not profiled` },
  { producer: 'claude-*', reader: 'claude-fable-5-2', reads: true, source: FABLE_52_READS_EARLIER },
  // ── alpha.132: Claude Fable 5.2 as the PRODUCER — read by itself and Mythos 5.2 only ──
  { producer: 'claude-fable-5-2', reader: 'claude-mythos-5-2', reads: true, source: `${FABLE_52_READ_BY} (Mythos 5.2 is not profiled)` },
  { producer: 'claude-fable-5-2', reader: '*', reads: false, source: FABLE_52_READ_BY },
  // ── alpha.121: producer-side rows ──
  { producer: 'claude-opus-5-5', reader: 'claude-fable-5-1', reads: true, source: 'On the Claude API, Claude Fable 5.1 and Claude Mythos 5.1 read Claude Opus 5.5 thinking blocks; no other model does. (Opus 5.5 guide; Mythos 5.1 is not profiled)' },
  { producer: 'claude-opus-5-5', reader: '*', reads: false, source: 'no other model does (Opus 5.5 guide)' },
  { producer: 'claude-sonnet-5-5', reader: 'claude-opus-5-5', reads: true, source: 'Claude Opus 5.5 reads thinking blocks from … on the Claude API and Google Cloud, from Claude Sonnet 5.5 (Opus 5.5 guide)' },
  { producer: 'claude-sonnet-5-5', reader: '*', reads: false, source: 'no other reader of Sonnet 5.5 blocks is documented (Sonnet 5.5 guide)' },
  // ── alpha.125: Claude Haiku 5.5 as the PRODUCER ──
  { producer: 'claude-haiku-5-5', reader: 'claude-opus-5-5', reads: true, source: HAIKU_55_READ_BY },
  { producer: 'claude-haiku-5-5', reader: 'claude-sonnet-5-5', reads: true, source: HAIKU_55_READ_BY },
  { producer: 'claude-haiku-5-5', reader: '*', reads: false, source: `${HAIKU_55_READ_BY} (thinking page: "and no other model does")` },
  // ── alpha.125: Claude Haiku 5.5 as the READER ──
  { producer: 'claude-sonnet-5', reader: 'claude-haiku-5-5', reads: true, source: HAIKU_55_READS },
  { producer: 'claude-opus-4-8', reader: 'claude-haiku-5-5', reads: true, source: HAIKU_55_READS },
  { producer: 'claude-haiku-4-5', reader: 'claude-haiku-5-5', reads: true, source: HAIKU_55_READS },
  { producer: 'claude-opus-5', reader: 'claude-haiku-5-5', reads: false, source: HAIKU_55_DOES_NOT_READ },
  { producer: 'claude-fable-*', reader: 'claude-haiku-5-5', reads: false, source: HAIKU_55_DOES_NOT_READ },
  { producer: 'claude-mythos-*', reader: 'claude-haiku-5-5', reads: false, source: HAIKU_55_DOES_NOT_READ },
  // (claude-opus-5-5 / claude-sonnet-5-5 → claude-haiku-5-5 are decided by
  // their producer-side `*` rows above: strip — the same verdict as
  // HAIKU_55_DOES_NOT_READ.)
].map((r) => Object.freeze(r)));

function idMatches(pattern: string, id: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id;
}

/** The first matrix row deciding (producer → reader), or undefined when the pair is not gated. */
export function thinkingBlockRule(from: string, to: string): ThinkingBlockRule | undefined {
  return THINKING_BLOCK_MATRIX.find((r) => idMatches(r.producer, from) && idMatches(r.reader, to));
}

/**
 * Which profiled models READ a producer's thinking blocks — the exact-id
 * `reads: true` rows of the matrix, keyed by producer (alpha.121's table,
 * now derived). Used by the advisory's "documented readers" line.
 */
export const THINKING_BLOCK_READERS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  THINKING_BLOCK_MATRIX.reduce<Record<string, string[]>>((acc, r) => {
    if (r.reads && !r.producer.endsWith('*') && !r.reader.endsWith('*')) (acc[r.producer] ??= []).push(r.reader);
    return acc;
  }, {}),
);

/** Does a fallover from `from` to `to` lose `from`'s thinking blocks? */
export function fallsOverWithoutThinking(from: string, to: string): boolean {
  if (from === to) return false;
  const rule = thinkingBlockRule(from, to);
  return rule !== undefined && !rule.reads;
}

/** alpha.125 — the migration guide an advisory about `model` points at (Opus 5.5's by default, as in alpha.121). */
export function migrationGuideUrl(model: string): string {
  if (model === 'claude-fable-5-2') return FABLE_52_GUIDE;
  // alpha.132 (closure item 2) — Fable 5.1's forced-tool-choice 400 was read on the thinking page, not a migration guide.
  if (model === 'claude-fable-5-1') return 'https://platform.claude.com/docs/en/build-with-claude/thinking#response-prefill-and-forced-tool-use';
  if (model === 'claude-haiku-5-5') return HAIKU_55_GUIDE;
  if (model === 'claude-sonnet-5-5') return 'https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide';
  return OPUS_55_GUIDE;
}

const THINKING_BLOCK_TYPES: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);

/**
 * Remove Anthropic `thinking` / `redacted_thinking` blocks from every
 * message's native `parts`. Pure: messages without such blocks keep their
 * identity; a message whose parts empty out falls back to its `content`.
 */
export function stripThinkingBlocks(messages: Message[] | undefined): { messages: Message[] | undefined; stripped: number } {
  if (!messages) return { messages, stripped: 0 };
  let stripped = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.parts)) return m;
    const kept = (m.parts as Array<Record<string, unknown>>).filter((p) => {
      const isThinking = p && typeof p === 'object' && typeof p.type === 'string' && THINKING_BLOCK_TYPES.has(p.type);
      if (isThinking) stripped++;
      return !isThinking;
    });
    if (kept.length === m.parts.length) return m;
    const next: Message = { ...m };
    if (kept.length > 0) next.parts = kept;
    else delete next.parts;
    return next;
  });
  return { messages: stripped > 0 ? out : messages, stripped };
}

/** The `thinking-blocks-dropped-on-fallover` advisory. */
export function thinkingDroppedAdvisory(from: string, to: string, stripped: number, handle?: string): BestPracticeAdvisory {
  const code = 'thinking-blocks-dropped-on-fallover';
  const readers = THINKING_BLOCK_READERS[from] ?? [];
  const rule = thinkingBlockRule(from, to);
  // A reader-side row (Haiku 5.5 as the target): the producer is read by many
  // models, so a "documented readers" list would mislead — quote the row.
  const readerSide = rule !== undefined && rule.reader !== '*' && !rule.reads;
  return {
    level: 'warn',
    code,
    message:
      `The call fell over from ${from} to ${to}, which cannot read ${from}'s thinking blocks; kgauto removed ${stripped} thinking block${stripped === 1 ? '' : 's'} from the history on that leg, so those turns ran without their reasoning. ` +
      (readerSide
        ? `The provider says: "${rule!.source}"`
        : `Documented readers of ${from}'s blocks: ${readers.length ? readers.join(', ') : 'none'}.`),
    suggestion: readerSide
      ? `If the reasoning matters on fallover, put a model that reads ${from}'s thinking ahead of ${to} in the chain; otherwise nothing to do — the answer was served.`
      : `If the reasoning matters on fallover, put a model that reads ${from}'s thinking (${readers.join(', ') || 'none documented'}) behind it in the chain; otherwise nothing to do — the answer was served.`,
    // alpha.132 — a leg with Fable 5.2 on either side points at its migration guide.
    docsUrl:
      from === 'claude-fable-5-2' || to === 'claude-fable-5-2'
        ? FABLE_52_GUIDE
        : from === 'claude-haiku-5-5' || to === 'claude-haiku-5-5'
          ? HAIKU_55_GUIDE
          : OPUS_55_GUIDE,
    ...(handle ? { kgautoRequestId: handle } : {}),
    ownership: deriveOwnership(code),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.132 (R3) — a thinking block's prefix is never the reason a call fails
// ─────────────────────────────────────────────────────────────────────────
//
// Source for every constant below: PRESERVED_THINKING_PAGE, read
// 2026-11-11T23:32Z with `curl -sL …/preserved-thinking.md` (HTTP 200).
// kgauto's passes change `system`, `tools` and earlier turns by design
// (slice · dedupe · tool-relevance · history compression) and kgauto is
// stateless between calls, so it can neither promise a stable prefix nor
// reproduce the last one. The page's own advice for "a library, proxy, or
// gateway" is to pass the control through and say what was dropped; this asks
// the API to drop and SAYS it.

/**
 * The beta header value. Page, "What the API does with an invalid block": "The
 * field and the `input_transformations` array require the
 * `thinking-binding-controls-2026-08-01` beta header."
 */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * The field path. Page: "Set `thinking.block_binding.prefix_mismatch_behavior`
 * to choose what happens to a block that fails it."
 */
export const BLOCK_BINDING_FIELD_PATH = 'thinking.block_binding.prefix_mismatch_behavior';

/**
 * The models that run the prefix check and accept the control, each with the
 * page line it rests on. Page front matter `supportedModels`: claude-fable-5-2,
 * claude-mythos-5-2, claude-fable-5-1, claude-mythos-5-1, claude-opus-5-5,
 * claude-sonnet-5-5, claude-haiku-5-5; and "Every model that runs the prefix
 * check accepts it with `"adaptive"`, and none of them accepts `"enabled"`."
 * On Sonnet 5.5 and Haiku 5.5 "`block_binding` works only with `thinking:
 * {"type": "adaptive"}`" — kgauto sends `adaptive`, which the thinking page's
 * per-model table lists as the behaviour of "No `thinking` field" on all seven.
 */
export const BLOCK_BINDING_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'claude-fable-5-2': 'supportedModels; "When `prefix_mismatch_behavior` is unset" table: Enforced (400 error) on every account',
  'claude-mythos-5-2': 'supportedModels; Enforced (400 error) on every account',
  'claude-fable-5-1': 'supportedModels; Enforced on accounts created on or after 2026-08-31, varies before',
  'claude-mythos-5-1': 'supportedModels; Enforced (400 error) on every account',
  'claude-opus-5-5': 'supportedModels; Enforced on accounts created on or after 2026-08-31, varies before',
  'claude-sonnet-5-5': 'supportedModels; Enforced on accounts created on or after 2026-08-31, varies before; block_binding only with thinking adaptive',
  'claude-haiku-5-5': 'supportedModels; Enforced on accounts created on or after 2026-08-31, varies before; block_binding only with thinking adaptive',
});

/** Does any lowered Anthropic message carry a `thinking` / `redacted_thinking` content block? */
export function messagesCarryThinkingBlocks(messages: ReadonlyArray<{ content: unknown }> | undefined): boolean {
  if (!messages) return false;
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as unknown[]).some(
        (b) => !!b && typeof b === 'object' && THINKING_BLOCK_TYPES.has(String((b as { type?: unknown }).type)),
      ),
  );
}

/** The `thinking` config R3a puts on the wire: adaptive, dropping a block that fails the prefix check. */
export interface BlockBindingThinking {
  type: 'adaptive';
  block_binding: { prefix_mismatch_behavior: 'drop_block' };
}

/**
 * R3a — the `thinking` field for an Anthropic request to `modelId` whose
 * lowered `messages` are given, or undefined when no control is sent (no
 * thinking block in the messages, or a model that does not run the check).
 */
export function prefixBindingFor(
  modelId: string,
  messages: ReadonlyArray<{ content: unknown }> | undefined,
): BlockBindingThinking | undefined {
  if (!Object.prototype.hasOwnProperty.call(BLOCK_BINDING_MODELS, modelId)) return undefined;
  if (!messagesCarryThinkingBlocks(messages)) return undefined;
  return { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
}

/**
 * R3a — merge the consumer's `providerOverrides.anthropic.thinking` onto the
 * lowered one. "A consumer that set the field itself through its overrides
 * keeps its own value":
 *   - the override carries `block_binding` → the override, whole;
 *   - the override is `{ type: 'adaptive', … }` without it → the override with
 *     kgauto's `block_binding` added (adaptive is the one type that takes it);
 *   - any other type (`enabled`, `disabled`, `between_tools`) → the override,
 *     whole: the page says `block_binding` with those is a 400, so kgauto's is
 *     dropped and the 400 path (R3c) is the recovery.
 * Pure. Returns `lowered` when there is no override.
 */
export function mergeThinkingOverride(lowered: unknown, override: unknown): unknown {
  if (override === undefined) return lowered;
  if (!override || typeof override !== 'object') return override;
  const o = override as Record<string, unknown>;
  if (o.block_binding !== undefined) return override;
  const l = lowered && typeof lowered === 'object' ? (lowered as Record<string, unknown>) : undefined;
  if (o.type === 'adaptive' && l?.block_binding !== undefined) return { ...o, block_binding: l.block_binding };
  return override;
}

/** R3a — the `anthropic-beta` value a final request body needs: the binding beta when it carries `thinking.block_binding`. */
export function anthropicBetaFor(body: Record<string, unknown>): string | undefined {
  const t = body.thinking;
  if (t && typeof t === 'object' && (t as Record<string, unknown>).block_binding !== undefined) return THINKING_BINDING_BETA;
  return undefined;
}

/** R3b — read `input_transformations` from a response body (or a stream event's `message`), entries kept verbatim. */
export function readInputTransformations(raw: unknown): InputTransformation[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const arr = (raw as { input_transformations?: unknown }).input_transformations;
  if (!Array.isArray(arr)) return undefined;
  return arr
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string')
    .map((e) => ({
      type: String(e.type),
      ...(typeof e.path === 'string' ? { path: e.path } : {}),
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    }));
}

/** The pass names whose mutations change `system`, `tools` or earlier turns between two calls (R3b's "passes that mutated this compile"). */
export const PREFIX_MUTATING_PASSES: ReadonlySet<string> = new Set(['slice', 'dedupe', 'tool_relevance', 'compress_history']);

export const THINKING_PREFIX_DROPPED_CODE = 'thinking-blocks-dropped-prefix-changed';
export const THINKING_UNREADABLE_DROPPED_CODE = 'thinking-blocks-dropped-unreadable';
export const THINKING_PREFIX_RECOVERED_CODE = 'thinking-prefix-mismatch-recovered';

/**
 * R3b — the advisories for one response's `input_transformations`:
 *   - `thinking_dropped` / `prefix_binding_mismatch` → one `warn`
 *     (THINKING_PREFIX_DROPPED_CODE) naming the count and the kgauto passes that
 *     changed `system`, `tools` or history on this compile;
 *   - `thinking_dropped` / `model_binding_mismatch` or
 *     `organization_binding_mismatch` → one `info` (THINKING_UNREADABLE_DROPPED_CODE).
 * Entries of any other type or reason are ignored, as the page says to.
 */
export function inputTransformationAdvisories(
  model: string,
  transformations: readonly InputTransformation[] | undefined,
  mutations: ReadonlyArray<{ id: string; passName?: string }>,
  handle?: string,
): BestPracticeAdvisory[] {
  if (!transformations || transformations.length === 0) return [];
  const dropped = transformations.filter((t) => t.type === 'thinking_dropped');
  const prefix = dropped.filter((t) => t.reason === 'prefix_binding_mismatch');
  const unreadable = dropped.filter((t) => t.reason === 'model_binding_mismatch' || t.reason === 'organization_binding_mismatch');
  const out: BestPracticeAdvisory[] = [];
  const paths = (ts: InputTransformation[]) => ts.map((t) => t.path ?? '(no path)').join(', ');
  if (prefix.length > 0) {
    const passes = mutations.filter((m) => m.passName !== undefined && PREFIX_MUTATING_PASSES.has(m.passName));
    out.push({
      level: 'warn',
      code: THINKING_PREFIX_DROPPED_CODE,
      message:
        `${model} dropped ${prefix.length} thinking block${prefix.length === 1 ? '' : 's'} (${paths(prefix)}) because the system prompt, the tools or an earlier message differed from the request that produced ${prefix.length === 1 ? 'it' : 'them'} (input_transformations reason prefix_binding_mismatch); kgauto asked the API to drop rather than fail (${BLOCK_BINDING_FIELD_PATH}: "drop_block"), so the answer was served without that reasoning. ` +
        (passes.length > 0
          ? `kgauto passes that changed the request on this compile: ${passes.map((m) => m.id).join(', ')}.`
          : 'No kgauto pass changed system, tools or history on this compile, so the change came from the request as given.'),
      suggestion:
        "Keep `system` and `tools` the same for the whole conversation and only append to the history. Set `constraints.stablePrefix: true` to withhold kgauto's slice, dedupe, tool-relevance and history-compression passes for this conversation. The provider calls drop_block a stopgap: dropping blocks can raise output tokens.",
      docsUrl: PRESERVED_THINKING_PAGE,
      recommendationType: 'prompt-fix',
      ...(handle ? { kgautoRequestId: handle } : {}),
      ownership: deriveOwnership(THINKING_PREFIX_DROPPED_CODE),
    });
  }
  if (unreadable.length > 0) {
    const reasons = [...new Set(unreadable.map((t) => t.reason))].join(', ');
    out.push({
      level: 'info',
      code: THINKING_UNREADABLE_DROPPED_CODE,
      message: `${model} dropped ${unreadable.length} thinking block${unreadable.length === 1 ? '' : 's'} (${paths(unreadable)}) it cannot read (input_transformations reason ${reasons}): a block from a model ${model} does not read, or from another account. Not an edit; the request succeeded.`,
      suggestion:
        "Nothing to fix for this answer. If the reasoning matters across a model switch, keep the conversation on a model that reads the earlier model's blocks.",
      docsUrl: PRESERVED_THINKING_PAGE,
      ...(handle ? { kgautoRequestId: handle } : {}),
      ownership: deriveOwnership(THINKING_UNREADABLE_DROPPED_CODE),
    });
  }
  return out;
}

/**
 * R3c — the advisory on a call where `model` answered the prefix-check 400 and
 * kgauto re-sent it once with the thinking blocks stripped. `servedBy` is the
 * model that finally answered: the same model (the strip-retry served) or a
 * later chain target (the retry failed too and the call walked on).
 */
export function thinkingPrefixRecoveredAdvisory(
  model: string,
  stripped: number,
  servedBy: string,
  handle?: string,
): BestPracticeAdvisory {
  const servedSame = servedBy === model;
  return {
    level: 'warn',
    code: THINKING_PREFIX_RECOVERED_CODE,
    message:
      `${model} answered HTTP 400 "Invalid \`signature\` in \`thinking\` block" (classified thinking_prefix_mismatch): a thinking block in the history no longer matched the system prompt, tools or messages before it. ` +
      `kgauto re-sent the request to ${model} once with ${stripped} thinking block${stripped === 1 ? '' : 's'} removed from the history; ` +
      (servedSame ? 'that retry served the answer, without the earlier reasoning.' : `that retry did not serve, and the call walked the chain to ${servedBy}.`),
    suggestion:
      'Your history is still edited for later calls: keep `system` and `tools` fixed and append only, or set `constraints.stablePrefix: true`. A `providerOverrides.anthropic.thinking` whose type is not `adaptive` keeps kgauto from sending `block_binding` (the provider rejects it with any other type).',
    docsUrl: PRESERVED_THINKING_PAGE,
    recommendationType: 'prompt-fix',
    ...(handle ? { kgautoRequestId: handle } : {}),
    ownership: deriveOwnership(THINKING_PREFIX_RECOVERED_CODE),
  };
}
