/**
 * Provider-native SSE streaming for execute().
 *
 * alpha.34: closes `streaming-output-callback-on-callresult` (PB s42).
 * Each provider's SSE wire shape is parsed into the same NormalizedResponse
 * that the non-streaming path returns; the only difference is the
 * `onChunk(delta)` callback fires once per text-delta event during the
 * stream, enabling per-token UX (ComposeDrawer SSE, real-time renderers).
 *
 * `delta` is the text since the previous `onChunk` call (NOT cumulative).
 * Tool calls + usage + finishReason are accumulated to the same shape the
 * non-streaming path returns at end-of-stream.
 */

import type {
  CompiledRequest,
  InputTransformation,
  NormalizedResponse,
  NormalizedTokens,
  ToolCall,
} from './ir.js';
import { anthropicBetaFor, readInputTransformations } from './request-shapes.js';

/**
 * alpha.132 (R3c) — the prefix-check 400's sentence
 * (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking,
 * "The 400 error", read 2026-11-11T23:32Z): "messages.1.content.0: Invalid
 * `signature` in `thinking` block. The block is bound to a different
 * conversation. …". A tampered signature carries the same first sentence and
 * no conversation sentence; removing the block clears both, so both match.
 * One derivation for the single-shot and the streamed classifier.
 */
export const THINKING_SIGNATURE_SENTENCE = 'Invalid `signature` in `thinking` block';
export function isThinkingSignatureMessage(message: string | undefined): boolean {
  return typeof message === 'string' && message.includes(THINKING_SIGNATURE_SENTENCE);
}

export interface StreamingOptions {
  onChunk: (chunk: string) => void;
  fetchImpl?: typeof fetch;
  /**
   * alpha.78 — caller-owned cancellation (CallOptions.abortSignal). Aborting
   * it classifies as terminal `aborted`, which stops the whole chain walk.
   */
  signal?: AbortSignal;
  /**
   * alpha.78 — per-chunk stall bound (CallOptions.attemptTimeoutMs on
   * streaming targets). A TOTAL bound would cut legitimate long streams, so
   * on streaming the knob means "max silence between bytes" instead: the
   * timer starts at request time (covers time-to-first-byte) and re-arms on
   * every read. Firing classifies as retryable `timeout` — the chain walks.
   */
  stallTimeoutMs?: number;
}

/**
 * alpha.78 — one derivation of thrown-fetch classification, shared by the
 * streaming and non-streaming paths (s75 two-derivations-drift rule).
 * A fetch rejects with the ABORT REASON of whichever signal fired:
 * `AbortSignal.timeout()` / the stall guard use a `TimeoutError` DOMException
 * (retryable — the chain walks, per L-061), a caller's `abort()` defaults to
 * `AbortError` (terminal for the CALL — the caller cancelled; walking the
 * chain would spend money on an answer nobody is waiting for).
 */
export function classifyThrownFetchError(err: unknown): {
  errorType: 'retryable' | 'terminal';
  errorCode: string;
  message: string;
} {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'TimeoutError') {
    return { errorType: 'retryable', errorCode: 'timeout', message: String(err) };
  }
  if (name === 'AbortError') {
    return { errorType: 'terminal', errorCode: 'aborted', message: 'aborted by caller signal' };
  }
  return { errorType: 'retryable', errorCode: 'network_error', message: String(err) };
}

/**
 * alpha.78 — stall guard for SSE reads. Composes the caller's external
 * signal with a local controller whose abort reason distinguishes stall
 * (TimeoutError) from cancellation (the external signal's own reason).
 */
function createStallGuard(external: AbortSignal | undefined, stallTimeoutMs: number | undefined) {
  const ctl = new AbortController();
  if (external) {
    if (external.aborted) ctl.abort(external.reason);
    else external.addEventListener('abort', () => ctl.abort(external.reason), { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!stallTimeoutMs || stallTimeoutMs <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      ctl.abort(
        new DOMException(`stream stalled: no bytes for ${stallTimeoutMs}ms`, 'TimeoutError'),
      );
    }, stallTimeoutMs);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return { signal: ctl.signal, arm, clear };
}

export type StreamingResult =
  | { ok: true; status: number; response: NormalizedResponse }
  | {
      ok: false;
      status: number;
      errorType: 'retryable' | 'terminal';
      errorCode: string;
      message: string;
      raw: unknown;
    };

// ─────────────────────────────────────────────────────────────────────────
// ANTHROPIC streaming
// ─────────────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export async function streamAnthropic(
  request: Extract<CompiledRequest, { provider: 'anthropic' }>,
  apiKey: string,
  opts: StreamingOptions,
): Promise<StreamingResult> {
  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;
  const guard = createStallGuard(opts.signal, opts.stallTimeoutMs);

  let res: Response;
  // alpha.129 (R1) — the first-token clock starts at the request send, by
  // Date.now() (the clock call() uses for latencyMs), and stops once, at the
  // first CONTENT event. Undefined when the stream carried none.
  let sentAt = 0;
  let ttftMs: number | undefined;
  const firstContent = () => {
    if (ttftMs === undefined) ttftMs = Date.now() - sentAt;
  };
  try {
    guard.arm();
    sentAt = Date.now();
    // alpha.132 (R3a) — same rule as the single-shot path: the beta header rides with block_binding.
    const beta = anthropicBetaFor(body as Record<string, unknown>);
    res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(beta ? { 'anthropic-beta': beta } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: guard.signal,
    });
  } catch (err) {
    guard.clear();
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) {
    guard.clear();
    // Read the error body (JSON) for classification — non-streaming path shape.
    const errBody = await res.json().catch(() => ({}));
    return classifyHttpError(res.status, errBody);
  }

  // Parse SSE stream. Anthropic events: message_start, content_block_start,
  // content_block_delta, content_block_stop, message_delta, message_stop.
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreatedTokens: number | undefined;
  let stopReason: string | undefined;
  // alpha.132 (R3b) — read where the wire puts it: `message_start` → `message.input_transformations`
  // (the page, read 2026-11-11T23:32Z, and observed on the wire 2026-11-12T00:19Z by
  // smoke-thinking-prefix.mjs gate C: event=message_start key=message.input_transformations, and in
  // no other event). The page adds that after a mid-stream server-side fallback "the final
  // `message_delta` event carries it again" without saying where on that event; that copy has never
  // been observed, so it is not read (Amendment A, closure item 3: no guessed key). (was: also read
  // the message_delta event and its `delta`, until 2026-11-12.)
  let inputTransformations: InputTransformation[] | undefined;
  const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();

  try {
    await parseSSEStream(res, (event) => {
      if (!event.data) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const type = payload.type as string | undefined;

      if (type === 'message_start') {
        const msg = (payload as { message?: { usage?: Record<string, number> } }).message;
        inputTransformations = readInputTransformations(msg) ?? inputTransformations;
        const usage = msg?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
          if (typeof usage.cache_read_input_tokens === 'number')
            cacheReadTokens = usage.cache_read_input_tokens;
          if (typeof usage.cache_creation_input_tokens === 'number')
            cacheCreatedTokens = usage.cache_creation_input_tokens;
        }
        return;
      }

      if (type === 'content_block_start') {
        const p = payload as {
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
        };
        const idx = p.index ?? 0;
        const block = p.content_block;
        if (block?.type === 'tool_use' && block.id && block.name) {
          toolBlocks.set(idx, { id: block.id, name: block.name, argsJson: '' });
        }
        return;
      }

      if (type === 'content_block_delta') {
        const p = payload as {
          index?: number;
          delta?: { type?: string; text?: string; partial_json?: string };
        };
        const delta = p.delta;
        if (!delta) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (delta.text.length > 0) firstContent();
          text += delta.text;
          opts.onChunk(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          // A tool's first argument bytes are a first token (R1); the empty
          // opening delta Anthropic sends is not.
          if (delta.partial_json.length > 0) firstContent();
          const idx = p.index ?? 0;
          const tool = toolBlocks.get(idx);
          if (tool) tool.argsJson += delta.partial_json;
        }
        return;
      }

      if (type === 'message_delta') {
        const p = payload as {
          delta?: { stop_reason?: string };
          usage?: { output_tokens?: number };
        };
        if (p.delta?.stop_reason) stopReason = p.delta.stop_reason;
        if (typeof p.usage?.output_tokens === 'number') outputTokens = p.usage.output_tokens;
        return;
      }
    }, guard.arm, guard.signal);
  } catch (err) {
    const c = classifyThrownFetchError(err);
    // Non-abort mid-stream failures keep their precise historical label.
    const code = c.errorCode === 'network_error' ? 'stream_interrupted' : c.errorCode;
    return { ok: false, status: 0, errorType: c.errorType, errorCode: code, message: c.message, raw: null };
  } finally {
    guard.clear();
  }

  const toolCalls: ToolCall[] = Array.from(toolBlocks.values()).map((b) => ({
    id: b.id,
    name: b.name,
    args: tryParseJson(b.argsJson) ?? {},
  }));

  const tokens: NormalizedTokens = {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
    cached: cacheReadTokens,
    cacheCreated: cacheCreatedTokens,
  };

  const response: NormalizedResponse = {
    text,
    structuredOutput: null,
    toolCalls,
    tokens,
    finishReason: stopReason,
    raw: { streamed: true, provider: 'anthropic' },
  };
  if (ttftMs !== undefined) response.ttftMs = ttftMs;
  if (inputTransformations) response.inputTransformations = inputTransformations;

  return { ok: true, status: res.status, response };
}

// ─────────────────────────────────────────────────────────────────────────
// OPENAI / DEEPSEEK streaming (chat completions wire format)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shared streaming path for any provider speaking OpenAI's
 * chat-completions SSE shape. Used by OpenAI, DeepSeek, Z.ai, and Moonshot
 * (alpha.65 added the latter two).
 *
 * Forces `stream_options.include_usage = true` so the final usage chunk
 * arrives — without it, OpenAI omits usage entirely on streaming responses.
 * DeepSeek mirrors the convention.
 */
export async function streamOpenAILike(
  url: string,
  request: Extract<CompiledRequest, { provider: 'openai' | 'deepseek' | 'zai' | 'moonshot' | 'openrouter' }>,
  apiKey: string,
  providerLabel: 'openai' | 'deepseek' | 'zai' | 'moonshot' | 'openrouter',
  opts: StreamingOptions,
): Promise<StreamingResult> {
  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;
  const guard = createStallGuard(opts.signal, opts.stallTimeoutMs);

  const reqBody = {
    ...body,
    stream: true,
    stream_options: {
      ...((body as { stream_options?: Record<string, unknown> }).stream_options ?? {}),
      include_usage: true,
    },
  };

  let res: Response;
  // alpha.129 (R1) — same clock as streamAnthropic: request send → first
  // content event (a non-empty delta.content, or a tool's first argument bytes;
  // a role-only delta or a tool name alone is not one). Set once.
  let sentAt = 0;
  let ttftMs: number | undefined;
  const firstContent = () => {
    if (ttftMs === undefined) ttftMs = Date.now() - sentAt;
  };
  try {
    guard.arm();
    sentAt = Date.now();
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(reqBody),
      signal: guard.signal,
    });
  } catch (err) {
    guard.clear();
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) {
    guard.clear();
    const errBody = await res.json().catch(() => ({}));
    return classifyHttpError(res.status, errBody);
  }

  let text = '';
  let finishReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens: number | undefined;
  let cachedTokens: number | undefined;
  // Tool calls arrive as deltas indexed by `index` — accumulate by index.
  const toolBuffers = new Map<
    number,
    { id: string; name: string; argsJson: string }
  >();

  try {
    await parseSSEStream(res, (event) => {
      if (!event.data) return;
      if (event.data === '[DONE]') return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const choices = (payload as { choices?: Array<Record<string, unknown>> }).choices;
      if (choices && choices.length > 0) {
        const choice = choices[0] as {
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        };

        const deltaContent = choice.delta?.content;
        if (typeof deltaContent === 'string' && deltaContent.length > 0) {
          firstContent();
          text += deltaContent;
          opts.onChunk(deltaContent);
        }

        const toolDeltas = choice.delta?.tool_calls;
        if (toolDeltas) {
          for (const tcDelta of toolDeltas) {
            const idx = tcDelta.index ?? 0;
            let buf = toolBuffers.get(idx);
            if (!buf) {
              buf = { id: tcDelta.id ?? `tc-${idx}`, name: '', argsJson: '' };
              toolBuffers.set(idx, buf);
            }
            if (tcDelta.id) buf.id = tcDelta.id;
            if (tcDelta.function?.name) buf.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) {
              firstContent();
              buf.argsJson += tcDelta.function.arguments;
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const usage = (payload as { usage?: Record<string, unknown> }).usage;
      if (usage) {
        if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
        if (typeof usage.total_tokens === 'number') totalTokens = usage.total_tokens;
        const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
        if (typeof details?.cached_tokens === 'number') cachedTokens = details.cached_tokens;
      }
    }, guard.arm, guard.signal);
  } catch (err) {
    const c = classifyThrownFetchError(err);
    const code = c.errorCode === 'network_error' ? 'stream_interrupted' : c.errorCode;
    return { ok: false, status: 0, errorType: c.errorType, errorCode: code, message: c.message, raw: null };
  } finally {
    guard.clear();
  }

  const toolCalls: ToolCall[] = Array.from(toolBuffers.values())
    .filter((b) => b.name.length > 0)
    .map((b) => ({
      id: b.id,
      name: b.name,
      args: tryParseJson(b.argsJson) ?? {},
    }));

  const tokens: NormalizedTokens = {
    input: inputTokens,
    output: outputTokens,
    total: totalTokens ?? inputTokens + outputTokens,
    cached: cachedTokens,
  };

  const response: NormalizedResponse = {
    text,
    structuredOutput: null,
    toolCalls,
    tokens,
    finishReason,
    raw: { streamed: true, provider: providerLabel },
  };
  if (ttftMs !== undefined) response.ttftMs = ttftMs;

  return { ok: true, status: res.status, response };
}

// ─────────────────────────────────────────────────────────────────────────
// GOOGLE (Gemini) streaming — alpha.130 (R6)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Google's `streamGenerateContent` over SSE, the same guard shape as
 * `streamAnthropic` / `streamOpenAILike`: the stall guard armed at the send
 * and re-armed on every read, `onChunk` once per non-empty text part, the
 * first-token clock from the send to the first content event (a non-empty
 * text part or a function call — Google sends a call whole, never as argument
 * bytes), and the stream accumulated to the shape `normalizeGoogle` returns for
 * the single-shot call (text = every text part joined; tool calls in arrival
 * order with the single-shot ids `gemini-call-<i>`; usage, `modelVersion` and
 * `finishReason` from the last chunk that carried them).
 *
 * The wire, read 2026-11-09 on
 * https://aistudio.google.com/api-reference/generate-content/stream-generate-content
 * (https://ai.google.dev/api/generate-content 301s to its parent page): `POST
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent`,
 * the request body a `GenerateContentRequest` (the single-shot body), the REST
 * example `…:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}` with
 * `--no-buffer`; the response a stream of `GenerateContentResponse` (candidates,
 * usageMetadata, modelVersion), one per SSE `data:` event. The key rides the
 * query string as the page's example and kgauto's single-shot path do.
 *
 * `url` is the endpoint WITHOUT the key (the caller builds it with `alt=sse`);
 * the helper appends `key=` itself so the key never travels in a caller's string.
 */
export async function streamGoogle(
  url: string,
  request: Extract<CompiledRequest, { provider: 'google' }>,
  apiKey: string,
  opts: StreamingOptions,
): Promise<StreamingResult> {
  const { provider: _provider, model: _model, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;
  const guard = createStallGuard(opts.signal, opts.stallTimeoutMs);
  const keyedUrl = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  // Same clock as the other two helpers (alpha.129 R1): request send → first
  // content event, by Date.now(), set once.
  let sentAt = 0;
  let ttftMs: number | undefined;
  const firstContent = () => {
    if (ttftMs === undefined) ttftMs = Date.now() - sentAt;
  };
  try {
    guard.arm();
    sentAt = Date.now();
    res = await fetchFn(keyedUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (err) {
    guard.clear();
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) {
    guard.clear();
    const errBody = await res.json().catch(() => ({}));
    return classifyHttpError(res.status, errBody);
  }

  let text = '';
  let finishReason: string | undefined;
  let servedModel: string | undefined;
  let usage: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  } = {};
  const toolCalls: ToolCall[] = [];
  let streamError: Record<string, unknown> | undefined;

  try {
    await parseSSEStream(res, (event) => {
      if (!event.data) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      // An error delivered inside the stream (after the 200) — classified below
      // exactly as an HTTP error body would be.
      if (payload.error && typeof payload.error === 'object') {
        streamError = payload;
        return;
      }
      const chunk = payload as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
          finishReason?: string;
        }>;
        modelVersion?: string;
        usageMetadata?: typeof usage;
      };
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string') {
          if (part.text.length > 0) {
            firstContent();
            text += part.text;
            opts.onChunk(part.text);
          }
        }
        if (part.functionCall?.name) {
          firstContent();
          toolCalls.push({
            id: `gemini-call-${toolCalls.length}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
        }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (typeof chunk.modelVersion === 'string') servedModel = chunk.modelVersion;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }, guard.arm, guard.signal);
  } catch (err) {
    const c = classifyThrownFetchError(err);
    const code = c.errorCode === 'network_error' ? 'stream_interrupted' : c.errorCode;
    return { ok: false, status: 0, errorType: c.errorType, errorCode: code, message: c.message, raw: null };
  } finally {
    guard.clear();
  }

  if (streamError) {
    const code = Number((streamError.error as { code?: unknown }).code);
    return classifyHttpError(Number.isFinite(code) && code >= 400 ? code : 500, streamError);
  }

  const tokens: NormalizedTokens = {
    input: usage.promptTokenCount ?? 0,
    output: usage.candidatesTokenCount ?? 0,
    total: usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
    cached: usage.cachedContentTokenCount,
  };

  const response: NormalizedResponse = {
    text,
    structuredOutput: null,
    toolCalls,
    tokens,
    finishReason,
    servedModel,
    raw: { streamed: true, provider: 'google' },
  };
  if (ttftMs !== undefined) response.ttftMs = ttftMs;

  return { ok: true, status: res.status, response };
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Generic SSE parser. Calls `handler` for each complete event in the stream.
 *
 * SSE format: events are separated by `\n\n`; each event has lines like
 * `event: <name>` and `data: <payload>` (data lines concatenated by `\n`).
 *
 * Tolerates `\r\n` line endings and chunked transfer-encoding. Uses
 * `Response.body` ReadableStream (web standard; Node 18+ + Deno + browsers
 * + Cloudflare Workers + Vercel Edge all support).
 */
async function parseSSEStream(
  response: Response,
  handler: (event: SSEEvent) => void,
  onRead?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('Response has no body for SSE parse');

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // alpha.78 — race each read against the abort signal. Real fetch rejects
  // in-flight body reads when the request signal aborts, but that
  // propagation is runtime-dependent; racing here makes the stall guard's
  // abort deterministic everywhere.
  const abortRace: Promise<never> | undefined = signal
    ? new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    : undefined;

  for (;;) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = abortRace
        ? await Promise.race([reader.read(), abortRace])
        : await reader.read();
    } catch (err) {
      void reader.cancel().catch(() => {});
      throw err;
    }
    const { value, done } = readResult;
    if (done) break;
    onRead?.(); // alpha.78 — re-arm the stall guard on every received chunk
    // alpha.130 — CRLF is normalized on the BUFFER (not per chunk), so a `\r` at
    // the end of one read and its `\n` at the start of the next still join.
    // Without it a `\r\n\r\n`-separated stream never matched the `\n\n`
    // separator below and every event fell into the end-of-stream flush as ONE
    // block of concatenated JSON — parsed as nothing. (The doc comment above
    // promised \r\n tolerance; the code had only per-line `\r?\n` in parseSSEBlock.)
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    // Process complete events (\n\n separator). Handle \r\n by normalizing.
    let sep: number;
    while (((sep = buffer.indexOf('\n\n')), sep !== -1)) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseSSEBlock(block);
      if (event) handler(event);
    }
  }

  // Flush any trailing complete event.
  if (buffer.length > 0) {
    const event = parseSSEBlock(buffer);
    if (event) handler(event);
  }
}

function parseSSEBlock(block: string): SSEEvent | undefined {
  const lines = block.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return undefined;
  return { event: eventName, data: dataLines.join('\n') };
}

function tryParseJson(s: string): Record<string, unknown> | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * alpha.74 (IC 2026-07-27 filing). Google delivers an invalid API key as
 * HTTP **400** `INVALID_ARGUMENT` / `API_KEY_INVALID` — not 401/403 like
 * every other provider. Status-only classification labeled it
 * `invalid_request` (terminal, chain-short-circuiting), so a dead Google
 * key killed the whole call even when a working cross-provider target sat
 * in the chain — while a 401 would have walked (alpha.14 auth-walk).
 * Detect the auth signature in the body so a key failure is `auth`
 * regardless of which status code the provider wraps it in.
 *
 * Lives here (not execute.ts) only because execute.ts already imports from
 * this module — one derivation of the concept, shared by both classifiers,
 * per the s75 two-derivations-drift rule.
 */
export function isAuthSignatureBody(body: unknown, message: string): boolean {
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      // Google: { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }
      if (Array.isArray(e.details)) {
        for (const d of e.details) {
          if (d && typeof d === 'object' && (d as Record<string, unknown>).reason === 'API_KEY_INVALID') {
            return true;
          }
        }
      }
      // OpenAI-family: { error: { code: 'invalid_api_key' } }
      if (e.code === 'invalid_api_key') return true;
    }
  }
  // Message-text fallback across provider phrasings ("API key not valid",
  // "Incorrect API key provided", "invalid api key", "invalid x-api-key").
  const m = message.toLowerCase();
  return (
    m.includes('api key not valid') ||
    m.includes('invalid api key') ||
    m.includes('invalid x-api-key') ||
    m.includes('incorrect api key')
  );
}

/**
 * alpha.119 — the message-only shape: a consumer that restarts through its own fell-over and kept
 * only the message (tt-intelligence's hunt tee keeps kind + message). No status — `!status`,
 * because 0 is never an HTTP status and a wrapper passes `status ?? 0` — AND no body. There the
 * money words are billing. Any real status skips this, so every status-bearing path reads exactly
 * as on .118: a 400 whose body says "payment required" is still `invalid_request` (alpha.116).
 */
function isMessageOnlyMoney(status: number | undefined | null, body: unknown, m: string): boolean {
  return (
    !status &&
    body == null &&
    (m.includes('spend cap') || m.includes('spend limit') || m.includes('usage limit') || m.includes('payment required'))
  );
}

/**
 * alpha.77 (PB 2026-07-28 filing). Billing/credit exhaustion is a
 * provider-AVAILABILITY condition wearing four different disguises — one per
 * provider, spanning FOUR status codes:
 *
 *   Anthropic  400  invalid_request_error / "credit balance is too low"
 *   Anthropic  400  invalid_request_error / "reached your specified API usage limits" (alpha.116)
 *   OpenAI     429  insufficient_quota
 *   Google     400/403  billingNotEnabled / billing-disabled shapes
 *   DeepSeek   402  "Insufficient Balance"
 *
 * The request was fine — it would succeed verbatim on any funded provider —
 * so it must WALK the chain (and skip every same-provider sibling: a credit
 * exhaustion is account-wide, not model-specific). Status-only
 * classification called the Anthropic shape `invalid_request` (terminal,
 * chain-aborting) and the OpenAI shape `rate_limit` (retry — but this never
 * clears on its own; only a human spending money clears it). Live incident:
 * PB synthesize-mixtape surfaced a raw error to Sacha while Google was
 * serving the same deploy minutes apart.
 *
 * DELIBERATELY NOT billing: Google free-tier RATE limits also say "exceeded
 * your current quota" but carry `free_tier_requests` + a retry delay — those
 * clear on their own and stay `rate_limit`.
 */
export function isBillingExhaustedBody(
  status: number | undefined | null,
  body: unknown,
  message: string,
): boolean {
  if (status === 402) return true; // Payment Required — the honest provider
  const m = message.toLowerCase();
  // alpha.119 — the message-only shape, checked before the free-tier exclusion exactly as
  // classifyFallback checked it on the first cut of .119. Every status-bearing call skips it.
  if (isMessageOnlyMoney(status, body, m)) return true;
  // Google free-tier quota is a rate limit, not a funding problem.
  if (m.includes('free_tier') || m.includes('free tier')) return false;
  if (m.includes('credit balance is too low')) return true; // Anthropic
  // alpha.116 — Anthropic's SPEND LIMIT (org/workspace monthly cap) arrives in the same disguise as
  // its empty balance: HTTP 400 invalid_request_error, message "You have reached your specified API
  // usage limits. You will regain access on <date>". LIVE 2026-09-29T20:26:42Z (an organisation-
  // level spend cap): through alpha.115 this read `invalid_request` → terminal → call() THREW without
  // trying the funded provider behind it. Account-wide, never model-specific; clears when a human
  // raises the limit or the month turns — the billing class, exactly.
  if (m.includes('reached your specified api usage limits')) return true; // Anthropic spend limit
  if (m.includes('insufficient balance')) return true; // DeepSeek
  if (m.includes('billingnotenabled') || m.includes('billing not enabled')) return true; // Google
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      // OpenAI-family: { error: { code|type: 'insufficient_quota' } }
      if (e.code === 'insufficient_quota' || e.type === 'insufficient_quota') return true;
      // Google: { error: { details: [{ reason: 'BILLING_DISABLED' }] } }
      if (Array.isArray(e.details)) {
        for (const d of e.details) {
          if (d && typeof d === 'object' && (d as Record<string, unknown>).reason === 'BILLING_DISABLED') {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * KG-18 step 1 (alpha.111, 2026-09-13) — classify a provider failure into the FIVE words the
 * wall needs, beside `fallback_reason` (migration 044's six values stay untouched — this is a
 * second axis, not a replacement): `balance` (money: pay), `quota` (rate/tier: wait or raise),
 * `outage` (their side: wait), `refusal` (auth/policy/region: fix the key or the request),
 * `quality` (a 200 that violated the contract: fix the prompt/model). Plus `quotaId` when the
 * provider names the quota — Google's `google.rpc.QuotaFailure.violations[].quota_id`
 * (error_details.proto, read 2026-09-13), OpenAI's `error.code`, Anthropic's `error.type`.
 *
 * Sources read 2026-09-13: platform.claude.com/docs/en/api/errors (402 billing_error; 429
 * rate_limit_error covers BOTH rate limits and the tier spend cap — the spend-cap 429 has no
 * retry-after; 529 overloaded_error; 400 can be an org spend limit), OpenAI error-codes guide
 * (429 credit_balance_exhausted / organization_spend_limit_exceeded / project_spend_limit_exceeded
 * / organization_usage_limit_exceeded are billing with type insufficient_quota; 429 slow_down is
 * rate; 503 server_is_overloaded), Google error_details.proto (QuotaFailure.Violation.quota_id,
 * quota_metric; RESOURCE_EXHAUSTED = 429). Unknown bodies fall to the status-only default.
 */
export type FallbackClass = 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';

const BALANCE_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_error',
]);

export function classifyFallback(
  status: number | undefined | null,
  body: unknown,
  message: string,
): { fallbackClass: FallbackClass | undefined; quotaId: string | undefined } {
  const m = (message ?? '').toLowerCase();
  const err = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  const e = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const type = typeof e?.type === 'string' ? e.type : undefined;
  const gstatus = typeof e?.status === 'string' ? e.status : undefined;

  // quotaId: the provider's own name for the limit, when it gives one.
  let quotaId: string | undefined;
  if (Array.isArray(e?.details)) {
    for (const d of e.details as unknown[]) {
      if (!d || typeof d !== 'object') continue;
      const v = (d as Record<string, unknown>).violations;
      if (!Array.isArray(v)) continue;
      for (const viol of v as unknown[]) {
        if (!viol || typeof viol !== 'object') continue;
        const q = viol as Record<string, unknown>;
        const id = q.quotaId ?? q.quota_id ?? q.quotaMetric ?? q.quota_metric;
        if (typeof id === 'string' && id) { quotaId = id; break; }
      }
      if (quotaId) break;
    }
  }
  if (!quotaId && status === 429 && code && code !== 'rate_limit_exceeded') quotaId = code; // OpenAI names the cap
  if (!quotaId && status === 429 && type === 'rate_limit_error') quotaId = type;

  // balance: money, on any status — the provider's own vocabulary first, then the shared derivation.
  if (isBillingExhaustedBody(status, body, message)) return { fallbackClass: 'balance', quotaId };
  if ((code && BALANCE_CODES.has(code)) || (type && BALANCE_CODES.has(type))) return { fallbackClass: 'balance', quotaId };
  // alpha.119 — the message-only shape (no status, or status 0, AND no body) is balance on the money
  // words. isBillingExhaustedBody above carries it (isMessageOnlyMoney), so both exports agree.
  if (status === 429 && (m.includes('spend limit') || m.includes('spend cap') || m.includes('credit'))) return { fallbackClass: 'balance', quotaId };
  if (status === 400 && m.includes('spend limit')) return { fallbackClass: 'balance', quotaId };

  if (status === 429 || gstatus === 'RESOURCE_EXHAUSTED') return { fallbackClass: 'quota', quotaId };
  if (status === 529 || status === 503 || status === 502 || status === 504 || status === 500 || status === 408) return { fallbackClass: 'outage', quotaId };
  if (status === 401 || status === 403) return { fallbackClass: 'refusal', quotaId };
  if (status === 400 && (m.includes('safety') || m.includes('policy') || m.includes('blocked') || m.includes('region') || m.includes('country'))) return { fallbackClass: 'refusal', quotaId };
  return { fallbackClass: undefined, quotaId };
}

function classifyHttpError(status: number, body: unknown): StreamingResult {
  const message = extractErrorMessage(body) ?? `HTTP ${status}`;
  // Billing exhaustion FIRST — it spans 400/402/403/429, and both the
  // rate-limit branch (would retry something no retry can fix) and the 400
  // branch (would abort a chain that has funded providers) misroute it.
  if (isBillingExhaustedBody(status, body, message))
    return { ok: false, status, errorType: 'terminal', errorCode: 'billing_exhausted', message, raw: body };
  if (status === 429)
    return { ok: false, status, errorType: 'retryable', errorCode: 'rate_limit', message, raw: body };
  if (status === 408)
    return { ok: false, status, errorType: 'retryable', errorCode: 'timeout', message, raw: body };
  if (status >= 500)
    return { ok: false, status, errorType: 'retryable', errorCode: 'server_error', message, raw: body };
  if (status === 404)
    return { ok: false, status, errorType: 'retryable', errorCode: 'model_not_found', message, raw: body };
  if (status === 401 || status === 403)
    return { ok: false, status, errorType: 'terminal', errorCode: 'auth', message, raw: body };
  if (status === 400) {
    if (isAuthSignatureBody(body, message))
      return { ok: false, status, errorType: 'terminal', errorCode: 'auth', message, raw: body };
    // alpha.132 (R3c) — the prefix-check 400, named and walkable (execute.ts classifies it the same way).
    if (isThinkingSignatureMessage(message))
      return { ok: false, status, errorType: 'retryable', errorCode: 'thinking_prefix_mismatch', message, raw: body };
    return { ok: false, status, errorType: 'terminal', errorCode: 'invalid_request', message, raw: body };
  }
  return { ok: false, status, errorType: 'terminal', errorCode: 'unknown', message, raw: body };
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof b.message === 'string') return b.message;
  return undefined;
}

function retryableError(
  status: number,
  code: string,
  message: string,
  raw: unknown,
): StreamingResult {
  return { ok: false, status, errorType: 'retryable', errorCode: code, message, raw };
}

// Exposed for unit tests.
export const _internal = {
  parseSSEStream,
  parseSSEBlock,
};
