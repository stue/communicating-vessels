/**
 * Lowering — IR → target-specific wire request.
 *
 * This is where the compiler emits provider-correct bytes:
 *   - Anthropic: system as array with cache_control markers; per-message
 *                cache_control on the messages array per `historyCachePolicy`
 *   - Google:    systemInstruction as separate field; cachedContent ref
 *   - OpenAI:    system or developer message based on model family
 *   - DeepSeek:  inline system, no cache, sequential tools
 *
 * System cache marker: the LAST cacheable section gets the cache_control
 * marker (Anthropic semantics — everything up to and including the marker
 * is cached on subsequent calls).
 *
 * History cache marker (alpha.5): driven by `ir.historyCachePolicy`. Only
 * Anthropic emits a wire-format marker; other providers compute the
 * `historyCacheableTokens` diagnostic for telemetry.
 */

import type {
  CompiledRequest,
  Constraints,
  HistoryCachePolicy,
  Message,
  PromptIR,
  PromptSection,
  ToolCall,
  ToolDefinition,
} from './ir.js';
import { priceAtInput, type ModelProfile } from './profiles.js';
import { countTokens, countToolTokens } from './tokenizer.js';
import { dropTrailingAssistantTurns, prefixBindingFor, type RejectedShapeDrop } from './request-shapes.js';

export interface LoweringHints {
  forceThinkingZero?: boolean;
  forceTerseOutput?: boolean;
  /**
   * alpha.29 — wire-level overrides emitted by translator rewrites. Threaded
   * from `CompileResult.wireOverrides` into the provider-specific wire
   * request:
   *
   *   - Anthropic: `tool_choice.disable_parallel_tool_use = true` (when
   *     `parallelToolCalls === false`). The `tool_choice` field is emitted
   *     ONLY when this hint is set — kgauto otherwise omits it and lets
   *     Anthropic default to `{ type: 'auto' }`.
   *   - OpenAI: top-level `parallel_tool_calls = false` (when set).
   *   - DeepSeek: no-op — V4-family is sequential-only by profile;
   *     `parallelToolCalls: false` is consistent with profile behavior, no
   *     wire field exists to emit.
   *   - Google: NOT EMITTED. Gemini has no documented per-call toggle for
   *     parallel function calling; the existing `tool_config.function_calling_config`
   *     only exposes mode (AUTO/ANY/NONE), not parallelism. alpha.30+ may
   *     model this via tool-set trimming if/when the cliff manifests on
   *     Gemini archetypes.
   *
   * Undefined for the common case (no translator rewrite fired).
   */
  wireOverrides?: { parallelToolCalls?: boolean };
  /**
   * alpha.128 — the compile's estimated input tokens, so the cache-savings
   * estimate prices the input at the tier the request falls in (the provider's
   * prompt-length steps, `costTiers`). Absent → the base price, as before.
   */
  estimatedInputTokens?: number;
  /**
   * alpha.92 — lower for a gateway route instead of the profile's own
   * vendor wire. `'openrouter'` emits the OpenAI-compatible wire with the
   * OpenRouter id (`openRouterModelId(profile)`); the canonical profile
   * still drives every pass upstream (cliffs, scoring, budgets), so the
   * guard behavior is identical — only the wire destination changes.
   */
  route?: 'direct' | 'openrouter';
}

/**
 * OpenRouter vendor slugs by kgauto provider. OpenRouter ids are
 * `vendor/model`; for the four majors the model half matches kgauto's
 * canonical id verbatim (empirically: `deepseek/deepseek-v4-flash` served
 * live 2026-08-26). `OPENROUTER_ID_OVERRIDES` is the escape hatch for ids
 * whose tail diverges — extend it as the probe-suite meets real cases.
 */
const OPENROUTER_VENDOR_SLUG: Partial<Record<string, string>> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai',
  deepseek: 'deepseek',
  zai: 'z-ai',
  moonshot: 'moonshotai',
};

export const OPENROUTER_ID_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({});

/** The OpenRouter id for a canonical profile, or a thrown error when the vendor has no slug. */
export function openRouterModelId(profile: Pick<ModelProfile, 'id' | 'provider'>): string {
  const override = OPENROUTER_ID_OVERRIDES[profile.id];
  if (override) return override;
  const slug = OPENROUTER_VENDOR_SLUG[profile.provider];
  if (!slug) throw new Error(`No OpenRouter vendor slug for provider ${profile.provider} (model ${profile.id})`);
  return `${slug}/${profile.id}`;
}

export interface LoweringResult {
  request: CompiledRequest;
  diagnostics: {
    cacheableTokens: number;
    estimatedCacheSavingsUsd: number;
    historyCacheableTokens: number;
    /**
     * alpha.121 — request shapes this lowering dropped because the profile
     * documents them as a 400 (`lowering.rejects`). compile() turns each into a
     * `request-shape-rejected-by-model` advisory. Absent when nothing dropped.
     */
    rejectedShapesDropped?: RejectedShapeDrop[];
    /**
     * alpha.134 (R2) — what became of the model's own thinking off-switch
     * (`lowering.thinkingOff`) when a `thinking_with_short_output` cliff asked
     * for it on an Anthropic target. `sent`: the request carries `thinking:
     * { type }`. `withheld`: it does not, and why — `effort` (the effort in
     * force is above the page's ceiling for the switch: a 400) or
     * `thinking-blocks` (the conversation carries thinking blocks bound for the
     * prefix check, whose `block_binding` takes only `adaptive`; the switch
     * without it would let a changed prefix answer 400). compile() turns each
     * into a mutation. Absent when the cliff did not fire or the model has no
     * off-switch.
     */
    thinkingOff?: ThinkingOffOutcome;
  };
}

export type ThinkingOffOutcome =
  | { sent: 'disabled' | 'between_tools' }
  | { withheld: 'effort'; type: 'disabled' | 'between_tools'; effort: string; effortAtMost: string }
  | { withheld: 'thinking-blocks'; type: 'disabled' | 'between_tools' };

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * alpha.134 (R2) — decide the Anthropic thinking field when the short-output
 * cliff fired. kgauto sends no effort on this wire, so the effort in force is
 * the model's documented default (`lowering.effort.default`). Pure.
 */
export function anthropicThinkingOff(
  profile: Pick<ModelProfile, 'lowering'>,
  forceThinkingZero: boolean | undefined,
  binding: unknown,
): { thinking?: { type: 'disabled' | 'between_tools' }; outcome?: ThinkingOffOutcome } {
  const off = profile.lowering.thinkingOff;
  if (!forceThinkingZero || !off) return {};
  const effort = profile.lowering.effort?.default;
  if (off.effortAtMost && effort && EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(off.effortAtMost)) {
    return { outcome: { withheld: 'effort', type: off.type, effort, effortAtMost: off.effortAtMost } };
  }
  if (binding !== undefined) return { outcome: { withheld: 'thinking-blocks', type: off.type } };
  return { thinking: { type: off.type }, outcome: { sent: off.type } };
}

/** alpha.128 — the input price at the compile's estimated input (the tier it falls in), else the base. */
function inputPriceForHints(profile: ModelProfile, hints: LoweringHints): number {
  return typeof hints.estimatedInputTokens === 'number'
    ? priceAtInput(profile, hints.estimatedInputTokens).costInputPer1m
    : profile.costInputPer1m;
}

export function lower(
  ir: PromptIR,
  profile: ModelProfile,
  hints: LoweringHints = {},
): LoweringResult {
  // alpha.92 — a gateway route overrides the vendor wire entirely; the
  // profile's own provider still drove every upstream pass.
  if (hints.route === 'openrouter') {
    return lowerOpenRouter(ir, profile);
  }
  switch (profile.provider) {
    case 'anthropic':
      return lowerAnthropic(ir, profile, hints);
    case 'google':
      return lowerGoogle(ir, profile, hints);
    case 'openai':
      return lowerOpenAI(ir, profile, hints);
    case 'deepseek':
      return lowerDeepSeek(ir, profile, hints);
    case 'zai':
      return lowerZai(ir, profile, hints);
    case 'moonshot':
      return lowerMoonshot(ir, profile);
    default:
      throw new Error(`No lowering implementation for provider: ${profile.provider}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ANTHROPIC
// ─────────────────────────────────────────────────────────────────────────

function lowerAnthropic(
  ir: PromptIR,
  profile: ModelProfile,
  hints: LoweringHints,
): LoweringResult {
  const systemBlocks = buildAnthropicSystemBlocks(ir.sections, profile);
  // alpha.72 — ask Anthropic for JSON when the caller declared structured
  // output. Until now this branch did not exist: Google got a `native`
  // response-schema branch and OpenAI/DeepSeek got `response_format`, while
  // every Anthropic profile declared `structuredOutput: 'grammar'` and the
  // lowering emitted NOTHING for it. So a structured Anthropic call went out
  // as an ordinary request, came back as prose or a ```json fence, and failed
  // the contract — which is the real mechanism behind claude-haiku-4-5's
  // 12-of-12 failures on playbacksam/summarize (read for two sessions as the
  // model being weak at JSON).
  //
  // Anthropic exposes no `response_format` parameter, so the instruction is
  // the mechanism. Appended as its own system block rather than merged, so it
  // cannot disturb the cache prefix of the blocks before it (cache_control
  // markers are positional).
  if (ir.constraints?.structuredOutput) {
    systemBlocks.push({
      type: 'text',
      text:
        'Respond with a single valid JSON value and nothing else. ' +
        'Do not wrap it in a markdown code fence, and do not add any prose before or after it.',
    });
  }
  // alpha.6.1 (LOWER-001 fix): pre-filter role==='system' messages so the
  // mark-index resolver, sumHistoryTokens, and buildAnthropicMessages all
  // operate on the same filtered view. Without this, a system message at
  // history[markIndex] would silently drop the cache_control marker
  // (buildAnthropicMessages skips system) while sumHistoryTokens still
  // reported a positive token count — telemetry says we cached N tokens,
  // wire request emits no marker.
  const history = (ir.history ?? []).filter((m) => m.role !== 'system');
  const policy = ir.historyCachePolicy;
  const markIndex = resolveHistoryMarkIndex(history.length, policy);
  // alpha.121 — a model that rejects prefill (Opus 5.5 / Sonnet 5.5: "The
  // conversation must end with a user message.") never receives a trailing
  // assistant turn; the drop is reported for compile() to say.
  const prefillGate = dropTrailingAssistantTurns(
    buildAnthropicMessages(history, ir.currentTurn, markIndex),
    profile,
    'lowering',
  );
  const messages = prefillGate.messages;
  const tools = ir.tools ? toAnthropicTools(ir.tools) : undefined;

  // Cache savings estimate: cached input billed at 10% of normal rate.
  const cacheableTokens = computeCacheableTokens(systemBlocks);
  // A dropped prefill can carry the history cache marker away with it; the
  // telemetry then reports what the wire actually marks (LOWER-001 discipline).
  const markerSurvived =
    prefillGate.dropped.length === 0 || JSON.stringify(messages).includes('"cache_control"');
  const historyCacheableTokens =
    markIndex >= 0 && markerSurvived ? sumHistoryTokens(history, markIndex) : 0;
  const totalCacheableTokens = cacheableTokens + historyCacheableTokens;
  const cacheSavings =
    (totalCacheableTokens / 1_000_000) *
    inputPriceForHints(profile, hints) *
    (1 - (profile.lowering.cache.discount ?? 0.1));

  // alpha.29 — translator wire override: emit Anthropic's
  // `tool_choice.disable_parallel_tool_use` when the translator decided this
  // call must be sequential. Anthropic defaults tool_choice to {type:'auto'};
  // we only emit when explicitly overriding.
  const toolChoice =
    hints.wireOverrides?.parallelToolCalls === false && tools && tools.length > 0
      ? { type: 'auto' as const, disable_parallel_tool_use: true }
      : undefined;

  // alpha.132 (R3a) — a conversation that sends thinking blocks back to a model
  // that runs the prefix check asks the API to DROP a block whose prefix changed
  // instead of answering 400: kgauto's passes change system, tools and history
  // by design, and it cannot reproduce the last request. Absent otherwise, so a
  // request without thinking blocks is byte-identical to alpha.131's.
  const binding = prefixBindingFor(profile.id, messages);
  // alpha.134 (R2) — the model's own off-switch, on the short-output cliff.
  // The binding wins when both apply (see ThinkingOffOutcome); said either way.
  const off = anthropicThinkingOff(profile, hints.forceThinkingZero, binding);
  const thinking = off.thinking ?? binding;

  return {
    request: {
      provider: 'anthropic',
      model: profile.id,
      system: systemBlocks,
      messages,
      tools,
      ...(thinking ? { thinking } : {}),
      // alpha.8: trust profile.maxOutputTokens. The historical Math.min(_, 4096)
      // floor surprised every consumer once (PB-Cairn contract-gaps brief, Gap 3).
      // Profile is the single source of truth; consumers wanting a tighter
      // budget can pass providerOverrides.anthropic.max_tokens explicitly.
      max_tokens: hints.forceTerseOutput ? 200 : (declaredOutputCap(ir, profile) ?? profile.maxOutputTokens),
      tool_choice: toolChoice,
    },
    diagnostics: {
      cacheableTokens,
      historyCacheableTokens,
      estimatedCacheSavingsUsd: cacheSavings,
      ...(prefillGate.dropped.length > 0 ? { rejectedShapesDropped: prefillGate.dropped } : {}),
      ...(off.outcome ? { thinkingOff: off.outcome } : {}),
    },
  };
}

function buildAnthropicSystemBlocks(
  sections: PromptSection[],
  profile: ModelProfile,
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  if (sections.length === 0) return [];

  const ordered = sortSections(sections);
  const minTokens = profile.lowering.cache.minTokens ?? 1024;

  // Strategy: concatenate cacheable prefix into ONE block with cache_control,
  // then append non-cacheable as separate blocks. Anthropic caches everything
  // up to and including the marked block, so the marker goes on the largest
  // stable prefix.
  const cacheable: PromptSection[] = [];
  const dynamic: PromptSection[] = [];
  for (const s of ordered) {
    if (s.cacheable) cacheable.push(s);
    else dynamic.push(s);
  }

  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];

  if (cacheable.length > 0) {
    const cacheText = cacheable.map((s) => s.text).join('\n\n');
    const cacheTextTokens = countTokens(cacheText);
    const block: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } } = {
      type: 'text',
      text: cacheText,
    };
    if (cacheTextTokens >= minTokens) {
      block.cache_control = { type: 'ephemeral' };
    }
    blocks.push(block);
  }

  for (const s of dynamic) {
    blocks.push({ type: 'text', text: s.text });
  }

  return blocks;
}

function buildAnthropicMessages(
  history: Message[],
  currentTurn: Message | undefined,
  markIndex: number,
): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  // alpha.120 — the user message currently collecting neutral tool results.
  // Anthropic answers every `tool_use` of one assistant turn in ONE user
  // message, results FIRST, any text AFTER them (docs, handle-tool-calls:
  // "the tool_result blocks must come FIRST in the content array. Any text
  // must come AFTER all tool results"; parallel-tool-use: "all together in the
  // next user message"). So consecutive tool messages merge into it, and a
  // plain user turn that follows rides in it as a trailing text block —
  // roles stay alternating on the wire.
  let openResults: Array<Record<string, unknown>> | null = null;
  const turns: Array<{ m: Message; mark: boolean }> = history.map((m, i) => ({ m, mark: i === markIndex }));
  if (currentTurn) turns.push({ m: currentTurn, mark: false });
  for (const { m, mark } of turns) {
    if (m.role === 'system') continue; // Anthropic system goes in `system`, not messages
    if (isNeutralToolResult(m)) {
      const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: m.toolCallId };
      // An empty result is sent with no `content` (the documented empty form).
      if (m.content !== '') block.content = m.content;
      if (openResults) {
        openResults.push(block);
      } else {
        openResults = [block];
        out.push({ role: 'user', content: openResults });
      }
      if (mark) markLastAnthropicBlock(openResults);
      continue;
    }
    if (openResults && m.role === 'user' && m.parts == null) {
      if (m.content.trim() !== '') openResults.push({ type: 'text', text: m.content });
      if (mark) markLastAnthropicBlock(openResults);
      openResults = null;
      continue;
    }
    openResults = null;
    if (hasNeutralToolCalls(m)) {
      const blocks: Array<Record<string, unknown>> = [];
      // Anthropic rejects an empty/whitespace-only text block; the text block
      // is emitted only when the assistant actually said something.
      if (m.content.trim() !== '') blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      if (mark) markLastAnthropicBlock(blocks);
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({
      role: m.role,
      content: mark ? attachAnthropicCacheControl(m) : (m.parts ?? m.content),
    });
  }
  return out;
}

/** alpha.120 — put the cache marker on the last block of a block array (copy-on-write). */
function markLastAnthropicBlock(blocks: Array<Record<string, unknown>>): void {
  const last = blocks[blocks.length - 1];
  if (!last) return;
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
}

/**
 * Convert a message's content into a content-block array with `cache_control`
 * on the LAST block. Anthropic semantics: the cache_control on a content
 * block tells the API to cache the prompt prefix up through that block, so
 * the final block of the chosen message is the right place.
 *
 * If `m.parts` is set (multimodal / structured), we mutate-by-copy the last
 * block. Otherwise we wrap the string content in a single text block.
 */
function attachAnthropicCacheControl(
  m: Message,
): Array<{ type: string; [key: string]: unknown }> {
  if (Array.isArray(m.parts) && m.parts.length > 0) {
    const blocks = m.parts as Array<Record<string, unknown>>;
    const last = blocks[blocks.length - 1]!;
    const withMarker: Record<string, unknown> = {
      ...last,
      cache_control: { type: 'ephemeral' },
    };
    return [...blocks.slice(0, -1), withMarker] as Array<{
      type: string;
      [key: string]: unknown;
    }>;
  }
  return [
    {
      type: 'text',
      text: m.content,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Resolve the index in `history[]` where the cache_control marker should
 * land, given a policy and current history length. Returns `-1` when no
 * marker should be emitted (no policy, 'none' strategy, empty history,
 * or suffix exceeds history length).
 *
 * Marking semantics (Anthropic): the marker block IS part of the cached
 * prefix. Everything after it (including currentTurn) is the dynamic tail.
 *
 * - 'all-but-latest' on history.length=4 → marks index 3 (last history
 *   message). Cached prefix = system + history[0..3]. Dynamic = currentTurn.
 *
 * - 'fixed-suffix' suffix=2 on history.length=4 → marks index 1
 *   (history.length - suffix - 1). Cached = system + history[0..1].
 *   Dynamic = history[2..3] + currentTurn. (Useful when the last 2 turns
 *   are volatile — scratchpad, draft revisions — but earlier turns stable.)
 *
 * - 'fixed-suffix' suffix=4 on history.length=4 → returns -1 (no marker;
 *   everything is dynamic).
 *
 * - 'fixed-suffix' suffix=0 → equivalent to 'all-but-latest'. Allowed.
 */
function resolveHistoryMarkIndex(
  historyLen: number,
  policy: HistoryCachePolicy | undefined,
): number {
  if (!policy || policy.strategy === 'none') return -1;
  if (historyLen === 0) return -1;
  if (policy.strategy === 'all-but-latest') {
    return historyLen - 1;
  }
  // fixed-suffix
  const idx = historyLen - 1 - policy.suffix;
  return idx >= 0 ? idx : -1;
}

function sumHistoryTokens(history: Message[], throughIndex: number): number {
  let total = 0;
  for (let i = 0; i <= throughIndex && i < history.length; i++) {
    const m = history[i]!;
    if (m.role === 'system') continue;
    if (Array.isArray(m.parts)) {
      // Best-effort: count text in any part shaped { text: string }.
      for (const p of m.parts as Array<Record<string, unknown>>) {
        if (typeof p.text === 'string') total += countTokens(p.text);
      }
    } else if (typeof m.content === 'string') {
      total += countTokens(m.content);
    }
  }
  return total;
}

function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }));
}

function computeCacheableTokens(
  blocks: Array<{ text: string; cache_control?: unknown }>,
): number {
  let total = 0;
  for (const b of blocks) {
    if (b.cache_control) total += countTokens(b.text);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────
// GOOGLE (Gemini)
// ─────────────────────────────────────────────────────────────────────────

function lowerGoogle(
  ir: PromptIR,
  profile: ModelProfile,
  hints: LoweringHints,
): LoweringResult {
  // alpha.29 NOTE: `hints.wireOverrides.parallelToolCalls === false` is
  // observed but NOT emitted on Gemini. Gemini's `tool_config.function_calling_config`
  // only exposes mode (AUTO / ANY / NONE), not parallelism. No documented
  // per-call toggle for parallel function calling exists as of alpha.29.
  // The translator only fires the rule when `profile.archetypePerf[archetype]
  // < TRANSLATOR_FLOOR`; today Gemini's archetypePerf clears the floor for
  // every archetype, so this branch never executes with wireOverrides set.
  // alpha.30+: model via tool-set trimming if/when the cliff manifests on
  // Gemini archetypes.
  const ordered = sortSections(ir.sections);
  const systemText = ordered.map((s) => s.text).join('\n\n');

  const generationConfig: Record<string, unknown> = {};

  // Honor cliff: force thinking off on Flash for short outputs.
  if (hints.forceThinkingZero && profile.lowering.thinking) {
    setNestedField(generationConfig, profile.lowering.thinking.field.replace(/^generationConfig\./, ''), 0);
  }

  if (hints.forceTerseOutput) {
    generationConfig.maxOutputTokens = 200;
  } else {
    // alpha.101 — declared cap reaches the wire (declares ⇒ emits).
    const cap = declaredOutputCap(ir, profile);
    if (cap !== undefined) generationConfig.maxOutputTokens = cap;
  }

  // alpha.99 (declares => emits) — any declared structured-output capability
  // emits, not only `native`. The old `=== 'native'` guard meant that
  // registering a Gemini model as `'grammar'` — an ordinary thing to do for a
  // model that fences rather than schemas — would emit NOTHING and reproduce
  // the alpha.66 omission with a fully green suite. `responseMimeType` is the
  // right emission for both classes: it is what asks Gemini for JSON at all,
  // independent of whether a schema is also supplied.
  if (ir.constraints?.structuredOutput && profile.structuredOutput !== 'none') {
    generationConfig.responseMimeType = 'application/json';
  }

  const contents = buildGoogleContents(ir.history ?? [], ir.currentTurn);
  const tools = ir.tools && ir.tools.length > 0 ? toGoogleTools(ir.tools) : undefined;

  // Gemini caching is created server-side via cachedContent.create() before
  // the call. The compiler estimates how many tokens WOULD be cacheable.
  const cacheable = ordered.filter((s) => s.cacheable);
  const cacheableTokens = cacheable.reduce((sum, s) => sum + countTokens(s.text), 0);
  const minTokens = profile.lowering.cache.minTokens ?? 4096;
  const meetsMin = cacheableTokens >= minTokens;
  const cacheSavings = meetsMin
    ? (cacheableTokens / 1_000_000) *
      inputPriceForHints(profile, hints) *
      (1 - (profile.lowering.cache.discount ?? 0.25))
    : 0;

  // alpha.5: telemetry on theoretical history cacheable tokens. Gemini uses
  // implicit caching server-side; no wire-format marker needed. The diagnostic
  // lets the brain learn which (app, model, archetype) tuples have history
  // worth caching. alpha.6.1 (LOWER-001 fix): filter system-role first so the
  // diagnostic matches the actual contents shape (buildGoogleContents skips
  // system; the diagnostic must too or it overreports).
  const history = (ir.history ?? []).filter((m) => m.role !== 'system');
  const histMarkIndex = resolveHistoryMarkIndex(history.length, ir.historyCachePolicy);
  const historyCacheableTokens =
    histMarkIndex >= 0 ? sumHistoryTokens(history, histMarkIndex) : 0;

  return {
    request: {
      provider: 'google',
      model: profile.id,
      systemInstruction: systemText
        ? { role: 'system', parts: [{ text: systemText }] }
        : undefined,
      contents,
      tools,
      generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
    },
    diagnostics: {
      cacheableTokens: meetsMin ? cacheableTokens : 0,
      historyCacheableTokens,
      estimatedCacheSavingsUsd: cacheSavings,
    },
  };
}

function buildGoogleContents(
  history: Message[],
  currentTurn: Message | undefined,
): Array<{ role: string; parts: unknown[] }> {
  const out: Array<{ role: string; parts: unknown[] }> = [];
  const turns = currentTurn ? [...history, currentTurn] : history;
  // alpha.120 — `functionResponse.name` is required by Gemini; a tool message
  // that omits `toolName` takes the name of the call it answers.
  const callNames = new Map<string, string>();
  for (const m of turns) {
    if (hasNeutralToolCalls(m)) for (const tc of m.toolCalls) callNames.set(tc.id, tc.name);
  }
  // The content turn currently collecting function responses: the responses
  // to one model turn's calls travel together in ONE content.
  let openResponses: unknown[] | null = null;
  for (const m of turns) {
    if (m.role === 'system') continue;
    if (isNeutralToolResult(m)) {
      const name = m.toolName ?? callNames.get(m.toolCallId);
      if (!name) {
        throw new Error(
          `lower(google): the role:'tool' message answering '${m.toolCallId}' has no toolName and no call with that id ` +
            `is in history — Gemini's functionResponse requires the function name. Set toolName on the message.`,
        );
      }
      const part = {
        functionResponse: { id: m.toolCallId, name, response: toGoogleFunctionResponse(m.content) },
      };
      if (openResponses) {
        openResponses.push(part);
      } else {
        openResponses = [part];
        // Content.role "Must be either 'user' or 'model'" (ai.google.dev/api/generate-content, Content).
        out.push({ role: 'user', parts: openResponses });
      }
      continue;
    }
    openResponses = null;
    if (hasNeutralToolCalls(m)) {
      const parts: unknown[] = [];
      if (m.content.trim() !== '') parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { id: tc.id, name: tc.name, args: tc.args ?? {} } });
      }
      out.push({ role: 'model', parts });
      continue;
    }
    out.push({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: m.parts ?? [{ text: m.content }],
    });
  }
  return out;
}

/**
 * alpha.120 — Gemini's `functionResponse.response` is a JSON OBJECT
 * (ai.google.dev/api/generate-content, FunctionResponse: "Required. The
 * function response in JSON object format"). The neutral tool message carries
 * a string, so:
 *   - a string that parses as a JSON object → that object, as-is;
 *   - a string that parses as any other JSON value (array, number, boolean,
 *     null, a quoted string) → `{ result: <parsed value> }`;
 *   - a string that is not JSON → `{ result: <the string> }`.
 */
function toGoogleFunctionResponse(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

function toGoogleTools(tools: ToolDefinition[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      })),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// OPENAI
// ─────────────────────────────────────────────────────────────────────────

function lowerOpenAI(
  ir: PromptIR,
  profile: ModelProfile,
  hints: LoweringHints,
): LoweringResult {
  // alpha.99 (declares => emits, second predicate) — `lowerOpenAI` builds its
  // own messages rather than using `buildOpenAICompatibleParts`, so it needed
  // the same instruction independently. MEASURED 2026-08-29, direct to
  // api.openai.com: `response_format: {type:'json_object'}` with no "json" in
  // the messages returns 400 "'messages' must contain the word 'json' in some
  // form, to use 'response_format' of type 'json_object'." kgauto emitted the
  // field and no instruction, so a structured OpenAI call could not succeed.
  // Latent, not live-harming: 2 rows all-time across these models, both fine.
  //
  // The third bespoke lowerer in three days to be missing something the shared
  // helper has. That is the finding worth carrying, not the field.
  const ordered = sortSections(ir.sections);
  const sectionText = ordered.map((s) => s.text).join('\n\n');
  const jsonInstruction = ir.constraints?.structuredOutput
    ? 'Respond with a single valid JSON value and nothing else. ' +
      'Do not wrap the JSON in a markdown code fence, and do not add any prose before or after it.'
    : '';
  const systemText = [sectionText, jsonInstruction].filter(Boolean).join('\n\n');

  // o-series: system goes as developer message
  const systemRole = profile.systemPromptMode === 'as_developer' ? 'developer' : 'system';

  const messages: Array<{ role: string; content: unknown }> = systemText
    ? [{ role: systemRole, content: systemText }]
    : [];

  for (const m of ir.history ?? []) {
    if (m.role === 'system') continue;
    messages.push(toOpenAICompatibleMessage(m));
  }
  if (ir.currentTurn && ir.currentTurn.role !== 'system') {
    messages.push(toOpenAICompatibleMessage(ir.currentTurn));
  }

  // alpha.5: telemetry only — OpenAI uses implicit caching automatically when
  // a stable prompt prefix is reused (≥1024 tokens). No wire-format marker.
  // alpha.6.1 (LOWER-001 fix): filter system-role first so diagnostic matches
  // the actual messages array shape (system messages get the systemRole prefix
  // entry, not a position in history).
  const history = (ir.history ?? []).filter((m) => m.role !== 'system');
  const histMarkIndex = resolveHistoryMarkIndex(history.length, ir.historyCachePolicy);
  const historyCacheableTokens =
    histMarkIndex >= 0 ? sumHistoryTokens(history, histMarkIndex) : 0;

  // alpha.29 — translator wire override: OpenAI defaults parallel_tool_calls
  // to true server-side; we explicit-set false only when the translator
  // decided to enforce sequential.
  const openaiParallelToolCalls =
    hints.wireOverrides?.parallelToolCalls === false &&
    ir.tools &&
    ir.tools.length > 0
      ? false
      : undefined;

  return {
    request: {
      provider: 'openai',
      model: profile.id,
      messages,
      tools: ir.tools && ir.tools.length > 0 ? toOpenAITools(ir.tools) : undefined,
      response_format: ir.constraints?.structuredOutput
        ? { type: 'json_object' }
        : undefined,
      max_completion_tokens: declaredOutputCap(ir, profile),
      // alpha.121 — `force_thinking_budget_zero` lowers to `'none'` on OpenAI
      // (gpt-5.6-luna's tool rule, the provider's own remedy). It wins over the
      // terse clamp's `'low'`: luna answers a tool call at any effort but none
      // with HTTP 400. No other OpenAI profile carries a thinking-zero cliff.
      reasoning_effort: hints.forceThinkingZero ? 'none' : hints.forceTerseOutput ? 'low' : undefined,
      parallel_tool_calls: openaiParallelToolCalls,
    },
    diagnostics: {
      cacheableTokens: 0,
      historyCacheableTokens,
      estimatedCacheSavingsUsd: 0,
    },
  };
}

function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// DEEPSEEK
// ─────────────────────────────────────────────────────────────────────────

function lowerDeepSeek(ir: PromptIR, profile: ModelProfile, hints: LoweringHints): LoweringResult {
  // alpha.96 — the greenfield (2026-04-25) shipped `ir.tools.slice(0, 1)` here,
  // and alpha.29 wrote a comment defending it: the profile said
  // `parallelToolCalls: false`, so trimming to one tool was called "consistent
  // with profile behavior, not a contradiction." That is the loop, written down:
  // the profile asserted it, the lowering enforced it, and every probe ran
  // through the lowering and confirmed it.
  //
  // MEASURED 2026-08-28, direct to api.deepseek.com with no kgauto in the path,
  // 6 tools offered, 3 trials each: BOTH deepseek-v4-flash and deepseek-v4-pro
  // returned 3 parallel tool calls, 3/3. The profile flag was simply wrong.
  //
  // Root cause worth keeping, because it generalizes: Anthropic and OpenAI
  // express "sequential" with a real wire field (`disable_parallel_tool_use`,
  // `parallel_tool_calls: false`) that passes EVERY tool and only forbids
  // batching. DeepSeek has no such field, so the original author simulated the
  // missing knob by deleting capability. Those are different statements — one
  // says "call them one at a time", the other says "you may only ever call this
  // one." A missing control field is never a licence to remove what it controls.
  //
  // Also measured: DeepSeek ACCEPTS `parallel_tool_calls` and silently ignores
  // it (3 calls returned with true, false, and the field absent). So we emit
  // nothing — sending it would report an enforcement we do not have, which is
  // the same "no errors = healthy" trap in a new place. `hints` is accepted now
  // so the translator can reach this provider at all; if a caller needs
  // sequential execution on DeepSeek it must be enforced above the wire, and
  // we say so rather than faking it.
  // alpha.99 (declares => emits) — this lowerer never carried a
  // structured-output branch, while both DeepSeek profiles declared a
  // structured-output capability. A structured call therefore went out as an
  // ordinary request and came back as prose or a fenced block: the alpha.66
  // omission, on a second provider, found by the mechanical check rather than
  // by an incident. Note WHICH lowerer it was — the one written bespoke
  // instead of against `buildOpenAICompatibleParts`, the same one that carried
  // `ir.tools.slice(0, 1)` for four months.
  //
  // MEASURED 2026-08-29, direct to api.deepseek.com, no kgauto in the path:
  //   A  no response_format, prompt says "JSON"  -> clean JSON, finish=stop
  //   B  response_format json_object + "JSON"    -> clean JSON, finish=stop
  //   C  response_format json_object, no "json"  -> 400 "Prompt must contain
  //        the word 'json' in some form to use 'response_format' of type
  //        'json_object'"
  //   D  response_format json_schema             -> 400 "This response_format
  //        type is unavailable now"
  //
  // So the naive fix — just add `response_format` — would have BROKEN every
  // structured call whose prompt does not happen to contain "json", which is
  // strictly worse than raw. The instruction is emitted FIRST and does the
  // real work (A proves it suffices alone); the field is then safe because the
  // instruction guarantees the required word. D is why the profile now
  // declares 'grammar' rather than 'native': DeepSeek has no schema-enforced
  // mode for 'native' to name.
  const ordered = sortSections(ir.sections);
  const sectionText = ordered.map((s) => s.text).join('\n\n');
  const jsonInstruction = ir.constraints?.structuredOutput
    ? 'Respond with a single valid JSON value and nothing else. ' +
      'Do not wrap the JSON in a markdown code fence, and do not add any prose before or after it.'
    : '';
  const systemText = [sectionText, jsonInstruction].filter(Boolean).join('\n\n');
  const messages: Array<{ role: string; content: unknown }> = systemText
    ? [{ role: 'system', content: systemText }]
    : [];

  for (const m of ir.history ?? []) {
    if (m.role === 'system') continue;
    messages.push(toOpenAICompatibleMessage(m));
  }
  if (ir.currentTurn && ir.currentTurn.role !== 'system') {
    messages.push(toOpenAICompatibleMessage(ir.currentTurn));
  }

  // alpha.5: telemetry only — DeepSeek context caching kicks in automatically
  // for repeated prefixes; no per-call marker. Diagnostic still informs the
  // brain about which tuples have history worth caching. alpha.6.1
  // (LOWER-001 fix): filter system-role first.
  const history = (ir.history ?? []).filter((m) => m.role !== 'system');
  const histMarkIndex = resolveHistoryMarkIndex(history.length, ir.historyCachePolicy);
  const historyCacheableTokens =
    histMarkIndex >= 0 ? sumHistoryTokens(history, histMarkIndex) : 0;

  return {
    request: {
      provider: 'deepseek',
      model: profile.id,
      messages,
      // Safe only because `jsonInstruction` above guarantees the literal word
      // "json" reaches the prompt — DeepSeek 400s otherwise (measurement C).
      response_format: ir.constraints?.structuredOutput
        ? { type: 'json_object' }
        : undefined,
      // alpha.101 — declared cap reaches the wire (declares ⇒ emits).
      max_tokens: declaredOutputCap(ir, profile),
      // alpha.101 — V4 thinks by default at effort `high`, and the reasoning
      // burn counts against `max_tokens`. MEASURED 2026-09-03, direct to
      // api.deepseek.com, a 1.5K-token classify prompt: at `max_tokens: 300`
      // v4-flash returned finish=length with 300 reasoning tokens and an EMPTY
      // text channel 3/3 (v4-pro 3/3; and 9/9 length@300 on tt-intelligence's
      // live surface on 2026-09-01, 8 of them empty); the same prompt with thinking disabled
      // returned finish=stop at 53 tokens. Emitted only when the
      // `thinking_with_short_output` cliff fired — the provider default is
      // otherwise untouched (unknown must not reduce, alpha.97).
      thinking: hints.forceThinkingZero ? { type: 'disabled' as const } : undefined,
      // Every tool the IR carries. Never fewer — see the note above.
      tools:
        ir.tools && ir.tools.length > 0
          ? ir.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description ?? '',
                parameters: t.parameters ?? { type: 'object', properties: {} },
              },
            }))
          : undefined,
    },
    diagnostics: {
      cacheableTokens: 0,
      historyCacheableTokens,
      estimatedCacheSavingsUsd: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Z.AI (GLM) + MOONSHOT (Kimi) — OpenAI-compatible
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.65 — shared OpenAI-compatible message building for the Z.ai and
 * Moonshot wire formats. Both providers take OpenAI-shape `messages` +
 * `tools` + `response_format: {type:'json_object'}`; the per-provider
 * wrappers add the knobs that differ (Z.ai's `thinking.type`).
 *
 * Caching on both is automatic prefix caching (DeepSeek-style) — no wire
 * marker to emit; diagnostics still report history-cacheable tokens so the
 * brain learns which tuples have cache-worthy history.
 */
function buildOpenAICompatibleParts(ir: PromptIR): {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  response_format?: unknown;
  historyCacheableTokens: number;
} {
  // alpha.99 (declares => emits, second predicate) — emitting
  // `response_format: {type:'json_object'}` is not enough: BOTH OpenAI and the
  // OpenAI-compatible providers reject the request outright unless the
  // messages contain the literal word "json".
  //
  // MEASURED 2026-08-29, direct to api.openai.com, no kgauto in the path:
  //   response_format json_object, no "json" in messages
  //     -> 400 "'messages' must contain the word 'json' in some form, to use
  //             'response_format' of type 'json_object'."
  //
  // Before this, kgauto emitted the field and no instruction, so a structured
  // call to OpenAI / Z.ai / Moonshot / OpenRouter 400'd unless the consumer's
  // own section text happened to contain the word. A raw caller writes "return
  // JSON" without being told; kgauto sent a request that could not succeed.
  // Latent rather than live-harming — 2 rows all-time on these models, both
  // successful — but it would have fired the first time anyone routed
  // structured work here, which is exactly the shape a mechanical check exists
  // to catch before an incident does.
  //
  // The instruction also does the real work: on DeepSeek the instruction alone
  // produced clean JSON with no field at all (measurement A there).
  const ordered = sortSections(ir.sections);
  const sectionText = ordered.map((s) => s.text).join('\n\n');
  const jsonInstruction = ir.constraints?.structuredOutput
    ? 'Respond with a single valid JSON value and nothing else. ' +
      'Do not wrap the JSON in a markdown code fence, and do not add any prose before or after it.'
    : '';
  const systemText = [sectionText, jsonInstruction].filter(Boolean).join('\n\n');
  const messages: Array<{ role: string; content: unknown }> = systemText
    ? [{ role: 'system', content: systemText }]
    : [];

  for (const m of ir.history ?? []) {
    if (m.role === 'system') continue;
    messages.push(toOpenAICompatibleMessage(m));
  }
  if (ir.currentTurn && ir.currentTurn.role !== 'system') {
    messages.push(toOpenAICompatibleMessage(ir.currentTurn));
  }

  const history = (ir.history ?? []).filter((m) => m.role !== 'system');
  const histMarkIndex = resolveHistoryMarkIndex(history.length, ir.historyCachePolicy);
  const historyCacheableTokens =
    histMarkIndex >= 0 ? sumHistoryTokens(history, histMarkIndex) : 0;

  return {
    messages,
    tools: ir.tools && ir.tools.length > 0 ? toOpenAITools(ir.tools) : undefined,
    response_format: ir.constraints?.structuredOutput ? { type: 'json_object' } : undefined,
    historyCacheableTokens,
  };
}

function lowerZai(ir: PromptIR, profile: ModelProfile, hints: LoweringHints): LoweringResult {
  const parts = buildOpenAICompatibleParts(ir);
  return {
    request: {
      provider: 'zai',
      model: profile.id,
      messages: parts.messages,
      tools: parts.tools,
      response_format: parts.response_format,
      // Z.ai thinking defaults to enabled server-side; emit an explicit
      // disable only when a cliff forced thinking off (the GLM analogue of
      // Gemini's thinkingBudget=0).
      thinking: hints.forceThinkingZero ? { type: 'disabled' } : undefined,
      max_tokens: declaredOutputCap(ir, profile),
    },
    diagnostics: {
      cacheableTokens: 0,
      historyCacheableTokens: parts.historyCacheableTokens,
      estimatedCacheSavingsUsd: 0,
    },
  };
}

function lowerOpenRouter(ir: PromptIR, profile: ModelProfile): LoweringResult {
  // OpenAI-compatible wire, OpenRouter id. No provider-specific knobs in v1:
  // the gateway normalizes vendor params, and route calls are eval/probe
  // traffic where the conservative default (no thinking overrides emitted)
  // is the comparable one.
  const parts = buildOpenAICompatibleParts(ir);
  return {
    request: {
      provider: 'openrouter',
      model: openRouterModelId(profile),
      messages: parts.messages,
      tools: parts.tools,
      response_format: parts.response_format,
      max_tokens: declaredOutputCap(ir, profile),
    },
    diagnostics: {
      cacheableTokens: 0,
      historyCacheableTokens: parts.historyCacheableTokens,
      estimatedCacheSavingsUsd: 0,
    },
  };
}

function lowerMoonshot(ir: PromptIR, profile: ModelProfile): LoweringResult {
  // kimi-k3 wire constraints (platform.kimi.ai docs, 2026-07-18): temperature
  // is FIXED at 1.0, top_p at 0.95, n at 1 — kgauto never emits those fields,
  // so nothing to strip. Reasoning is always-on (`reasoning_effort: 'max'` is
  // the only supported value = the server default); no thinking knob to lower.
  const parts = buildOpenAICompatibleParts(ir);
  return {
    request: {
      provider: 'moonshot',
      model: profile.id,
      messages: parts.messages,
      tools: parts.tools,
      response_format: parts.response_format,
      max_tokens: declaredOutputCap(ir, profile),
    },
    diagnostics: {
      cacheableTokens: 0,
      historyCacheableTokens: parts.historyCacheableTokens,
      estimatedCacheSavingsUsd: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.120 — an assistant message carrying neutral `toolCalls` (and no
 * `parts`, which would win and pass through verbatim).
 */
function hasNeutralToolCalls(m: Message): m is Message & { toolCalls: ToolCall[] } {
  return m.role === 'assistant' && m.parts == null && Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
}

/**
 * alpha.120 — a neutral tool result: `role: 'tool'`, no `parts`. compile()'s
 * validateIR has already refused one without `toolCallId`.
 */
function isNeutralToolResult(m: Message): m is Message & { toolCallId: string } {
  return m.role === 'tool' && m.parts == null && typeof m.toolCallId === 'string';
}

/**
 * alpha.120 — one IR message → one OpenAI-compatible chat message. Shared by
 * every route on that wire (OpenAI, DeepSeek, Z.ai, Moonshot, OpenRouter), so
 * the tool shape cannot drift between them the way three bespoke lowerers
 * drifted on structured output (alpha.99).
 *
 *   assistant + toolCalls → { role:'assistant', content: text | null,
 *                             tool_calls: [{ id, type:'function',
 *                               function: { name, arguments: JSON string } }] }
 *   tool                  → { role:'tool', tool_call_id, content }
 *
 * Field names read 2026-10-06: OpenAI chat-completions reference
 * (developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create —
 * ChatCompletionToolMessageParam { content, role, tool_call_id }; assistant
 * `content` "Required unless tool_calls or function_call is specified";
 * ChatCompletionMessageFunctionToolCall { id, function { arguments: string, name }, type: "function" });
 * DeepSeek api-docs.deepseek.com/guides/tool_calls (`{"role": "tool", "tool_call_id": tool.id, "content": …}`).
 */
function toOpenAICompatibleMessage(m: Message): { role: string; content: unknown; [key: string]: unknown } {
  if (hasNeutralToolCalls(m)) {
    return {
      role: 'assistant',
      content: m.content.trim() !== '' ? m.content : null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
    };
  }
  if (isNeutralToolResult(m)) {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.parts ?? m.content };
}

/**
 * alpha.101 — the output cap the consumer declared, bounded by the profile's
 * own ceiling. `undefined` when nothing was declared, so every lowerer keeps
 * its provider default and the never-worse-than-raw ceiling gate is
 * untouched. Declared ⇒ emitted, on every provider — kgauto's `call()` path
 * must honour the same ceiling an AI-SDK consumer puts on the wire themselves.
 */
function declaredOutputCap(ir: PromptIR, profile: ModelProfile): number | undefined {
  const cap = ir.constraints?.maxOutputTokens;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return undefined;
  return Math.min(Math.floor(cap), profile.maxOutputTokens);
}

function sortSections(sections: PromptSection[]): PromptSection[] {
  return [...sections].sort((a, b) => {
    const wa = a.weight ?? 100;
    const wb = b.weight ?? 100;
    return wa - wb;
  });
}

function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!(key in cursor) || typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}
