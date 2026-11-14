/**
 * execute() — fire a CompiledRequest at the right provider, normalize the
 * response shape across providers.
 *
 * This is what call() composes with compile() to own the network round-trip.
 * Pure-fetch consumers stop reinventing per-provider parsing.
 *
 * Error classification follows L-061: 429/5xx/timeout/model_not_found are
 * retryable; auth/validation are terminal. The orchestrator (call.ts) walks
 * fallbackChain on retryable; surfaces terminal immediately.
 */

import type {
  ApiKeys,
  CompiledRequest,
  NormalizedResponse,
  NormalizedTokens,
  ProviderOverrides,
  ToolCall,
} from './ir.js';
import { resolveProviderKey } from './env.js';
import {
  classifyThrownFetchError,
  isAuthSignatureBody,
  isBillingExhaustedBody,
  isThinkingSignatureMessage,
  classifyFallback,
  type FallbackClass,
  streamAnthropic,
  streamOpenAILike,
  streamGoogle,
} from './streaming.js';
import { anthropicBetaFor, mergeThinkingOverride, readInputTransformations } from './request-shapes.js';

export interface ExecuteOptions {
  apiKeys?: ApiKeys;
  fetchImpl?: typeof fetch;
  providerOverrides?: ProviderOverrides;
  /**
   * alpha.34. When supplied AND the chosen provider supports streaming, the
   * execute() per-provider branch switches to SSE wire format and invokes
   * `onChunk(delta)` once per text-delta event. Single-shot behavior
   * preserved when omitted (current consumers unaffected). Wired from
   * `CallOptions.onChunk` by `call()` after gating on `profile.streaming`
   * and `!opts.noStream`.
   */
  onChunk?: (chunk: string) => void;
  /**
   * alpha.78 — abort signal for the provider fetch. call() composes
   * `AbortSignal.timeout(attemptTimeoutMs)` with the caller's own
   * `CallOptions.abortSignal`; direct execute() consumers may pass anything.
   * TimeoutError reasons classify retryable `timeout` (chain walks);
   * AbortError reasons classify terminal `aborted` (caller cancelled).
   */
  signal?: AbortSignal;
  /**
   * alpha.78 — per-chunk stall bound, streaming paths only (see
   * StreamingOptions.stallTimeoutMs). Ignored on non-streaming requests,
   * where `signal` carries the total attempt bound instead.
   */
  stallTimeoutMs?: number;
}

export interface ExecuteOk {
  ok: true;
  status: number;
  response: NormalizedResponse;
}

export interface ExecuteErr {
  ok: false;
  status: number;
  errorType: 'retryable' | 'terminal';
  errorCode: string;
  message: string;
  raw: unknown;
  /** KG-18 step 1 (alpha.111) — which of the five words this failure is: balance / quota / outage / refusal / quality. */
  fallbackClass?: FallbackClass;
  /** KG-18 step 1 — the provider's own name for the limit that fired, when it gave one (Google quota_id, OpenAI error.code, Anthropic error.type). */
  quotaId?: string;
  /**
   * alpha.66 — real token usage when the failure is a SYNTHESIZED
   * structured-output contract violation (the provider returned 200 with
   * usage; the response just violated the contract). Absent on transport-
   * level failures (4xx/5xx/network) where no usage exists. Lets the
   * brain's failure rows carry true `tokens_in` for the cliff class —
   * PB's 2026-05-18 `chain-walk-on-structured-output-parse-failed` ask 4
   * (tokens_in=0 on a 72s parse-fail made diagnosis ambiguous).
   */
  tokens?: { input: number; output: number };
}

export type ExecuteResult = ExecuteOk | ExecuteErr;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
// alpha.65 — both verified against provider docs 2026-07-18 (L-081 step zero).
const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const MOONSHOT_URL = 'https://api.moonshot.ai/v1/chat/completions';
// alpha.92 — the OpenRouter gateway route (execute-leg contract 2026-08-26).
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function execute(
  request: CompiledRequest,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const merged = applyOverrides(request, opts.providerOverrides);
  switch (merged.provider) {
    case 'anthropic':
      return executeAnthropic(merged as Extract<CompiledRequest, { provider: 'anthropic' }>, opts);
    case 'google':
      return executeGoogle(merged as Extract<CompiledRequest, { provider: 'google' }>, opts);
    case 'openai':
      return executeOpenAI(merged as Extract<CompiledRequest, { provider: 'openai' }>, opts);
    case 'deepseek':
      return executeDeepSeek(merged as Extract<CompiledRequest, { provider: 'deepseek' }>, opts);
    case 'zai':
      return executeOpenAICompatible(
        merged as Extract<CompiledRequest, { provider: 'zai' }>,
        opts,
        { provider: 'zai', url: ZAI_URL, missingKeyMessage: 'ZAI_API_KEY missing' },
      );
    case 'moonshot':
      return executeOpenAICompatible(
        merged as Extract<CompiledRequest, { provider: 'moonshot' }>,
        opts,
        { provider: 'moonshot', url: MOONSHOT_URL, missingKeyMessage: 'MOONSHOT_API_KEY missing' },
      );
    case 'openrouter':
      return executeOpenAICompatible(
        merged as Extract<CompiledRequest, { provider: 'openrouter' }>,
        opts,
        { provider: 'openrouter', url: OPENROUTER_URL, missingKeyMessage: 'OPENROUTER_API_KEY missing' },
      );
    default: {
      const _exhaustive: never = merged;
      throw new Error(`execute(): no executor for provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ANTHROPIC
// ─────────────────────────────────────────────────────────────────────────

async function executeAnthropic(
  request: Extract<CompiledRequest, { provider: 'anthropic' }>,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const apiKey = resolveProviderKey('anthropic', { apiKeys: opts.apiKeys });
  if (!apiKey) {
    return terminalError(401, 'auth', 'ANTHROPIC_API_KEY missing');
  }

  if (opts.onChunk) {
    return reclassifyStreamed(
      await streamAnthropic(request, apiKey, {
        onChunk: opts.onChunk,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs,
      }),
    );
  }

  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;
  // alpha.132 (R3a) — the binding control needs its beta header, read off the
  // FINAL body (kgauto's lowering or the consumer's own override).
  const beta = anthropicBetaFor(body as Record<string, unknown>);

  let res: Response;
  let json: unknown;
  try {
    res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(beta ? { 'anthropic-beta': beta } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) return classifyHttpError(res.status, json);
  return { ok: true, status: res.status, response: normalizeAnthropic(json) };
}

function normalizeAnthropic(raw: unknown): NormalizedResponse {
  const r = raw as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
    stop_reason?: string;
  };

  const text = (r.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('');

  const toolCalls: ToolCall[] = (r.content ?? [])
    .filter((b) => b.type === 'tool_use' && b.name && b.id)
    .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} }));

  const tokens: NormalizedTokens = {
    input: r.usage?.input_tokens ?? 0,
    output: r.usage?.output_tokens ?? 0,
    total: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0),
    cached: r.usage?.cache_read_input_tokens,
    cacheCreated: r.usage?.cache_creation_input_tokens,
  };

  // alpha.105 — the model the provider SAYS served the call. Anthropic returns
  // the resolved id (`claude-sonnet-5-2026…`); recorded verbatim, compared by
  // `servedModelDiffers()` in call.ts, never rewritten.
  const servedModel = typeof r.model === 'string' ? r.model : undefined;
  // alpha.132 (R3b) — the thinking blocks the API dropped, verbatim; absent when the body has no array.
  const inputTransformations = readInputTransformations(raw);
  return {
    text,
    structuredOutput: null,
    toolCalls,
    tokens,
    finishReason: r.stop_reason,
    servedModel,
    ...(inputTransformations ? { inputTransformations } : {}),
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GOOGLE (Gemini)
// ─────────────────────────────────────────────────────────────────────────

async function executeGoogle(
  request: Extract<CompiledRequest, { provider: 'google' }>,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const apiKey = resolveProviderKey('google', { apiKeys: opts.apiKeys });
  if (!apiKey) {
    return terminalError(401, 'auth', 'GOOGLE_API_KEY/GEMINI_API_KEY missing');
  }

  // alpha.130 (R6) — the Google stream helper, handed opts.onChunk exactly as
  // the Anthropic and OpenAI-compatible paths hand theirs. (was: single-shot
  // whatever onChunk said, so no Google row carried ttft_ms, until alpha.130.)
  if (opts.onChunk) {
    const streamed = await streamGoogle(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
      request,
      apiKey,
      {
        onChunk: opts.onChunk,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs,
      },
    );
    // An HTTP error body is classified by THIS module's classifier — the one the
    // single-shot Google path uses — through the rule every stream site reads
    // (alpha.131, `reclassifyStreamed`; was: this block's own copy of the condition).
    return reclassifyStreamed(streamed);
  }

  const { provider: _provider, model, ...body } = request;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const fetchFn = opts.fetchImpl ?? fetch;

  let res: Response;
  let json: unknown;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) return classifyHttpError(res.status, json);
  return { ok: true, status: res.status, response: normalizeGoogle(json) };
}

function normalizeGoogle(raw: unknown): NormalizedResponse {
  const r = raw as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
      finishReason?: string;
    }>;
    modelVersion?: string;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };

  const candidate = r.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text!)
    .join('');

  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `gemini-call-${i}`,
      name: p.functionCall!.name!,
      args: p.functionCall!.args ?? {},
    }));

  const u = r.usageMetadata ?? {};
  const tokens: NormalizedTokens = {
    input: u.promptTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    total: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
    cached: u.cachedContentTokenCount,
  };

  // alpha.105 — Google reports the served model as `modelVersion`.
  const servedModel = typeof r.modelVersion === 'string' ? r.modelVersion : undefined;
  return { text, structuredOutput: null, toolCalls, tokens, finishReason: candidate?.finishReason, servedModel, raw };
}

// ─────────────────────────────────────────────────────────────────────────
// OPENAI
// ─────────────────────────────────────────────────────────────────────────

async function executeOpenAI(
  request: Extract<CompiledRequest, { provider: 'openai' }>,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const apiKey = resolveProviderKey('openai', { apiKeys: opts.apiKeys });
  if (!apiKey) {
    return terminalError(401, 'auth', 'OPENAI_API_KEY missing');
  }

  if (opts.onChunk) {
    return reclassifyStreamed(
      await streamOpenAILike(OPENAI_URL, request, apiKey, 'openai', {
        onChunk: opts.onChunk,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs,
      }),
    );
  }

  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;

  let res: Response;
  let json: unknown;
  try {
    res = await fetchFn(OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) return classifyHttpError(res.status, json);
  return { ok: true, status: res.status, response: normalizeOpenAILike(json) };
}

// ─────────────────────────────────────────────────────────────────────────
// DEEPSEEK (OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────

async function executeDeepSeek(
  request: Extract<CompiledRequest, { provider: 'deepseek' }>,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const apiKey = resolveProviderKey('deepseek', { apiKeys: opts.apiKeys });
  if (!apiKey) {
    return terminalError(401, 'auth', 'DEEPSEEK_API_KEY missing');
  }

  if (opts.onChunk) {
    return reclassifyStreamed(
      await streamOpenAILike(DEEPSEEK_URL, request, apiKey, 'deepseek', {
        onChunk: opts.onChunk,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs,
      }),
    );
  }

  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;

  let res: Response;
  let json: unknown;
  try {
    res = await fetchFn(DEEPSEEK_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) return classifyHttpError(res.status, json);
  return { ok: true, status: res.status, response: normalizeOpenAILike(json) };
}

// ─────────────────────────────────────────────────────────────────────────
// Z.AI + MOONSHOT (OpenAI-compatible, Bearer auth)
// ─────────────────────────────────────────────────────────────────────────

async function executeOpenAICompatible(
  request: Extract<CompiledRequest, { provider: 'zai' | 'moonshot' | 'openrouter' }>,
  opts: ExecuteOptions,
  spec: { provider: 'zai' | 'moonshot' | 'openrouter'; url: string; missingKeyMessage: string },
): Promise<ExecuteResult> {
  const apiKey = resolveProviderKey(spec.provider, { apiKeys: opts.apiKeys });
  if (!apiKey) {
    return terminalError(401, 'auth', spec.missingKeyMessage);
  }

  if (opts.onChunk) {
    return reclassifyStreamed(
      await streamOpenAILike(spec.url, request, apiKey, spec.provider, {
        onChunk: opts.onChunk,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs,
      }),
    );
  }

  const { provider: _provider, ...body } = request;
  const fetchFn = opts.fetchImpl ?? fetch;

  let res: Response;
  let json: unknown;
  try {
    res = await fetchFn(spec.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    const c = classifyThrownFetchError(err);
    return { ok: false, status: 0, errorType: c.errorType, errorCode: c.errorCode, message: c.message, raw: null };
  }

  if (!res.ok) return classifyHttpError(res.status, json);
  return { ok: true, status: res.status, response: normalizeOpenAILike(json) };
}

function normalizeOpenAILike(raw: unknown): NormalizedResponse {
  const r = raw as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const choice = r.choices?.[0];
  const text = choice?.message?.content ?? '';
  // alpha.92 — a gateway names the serving host on the response (OpenRouter:
  // top-level `provider` = "Venice", "StreamLake", …). Captured verbatim;
  // absent on direct vendor responses. Dropping it would be the L-073
  // silent-drop at birth.
  const routeHost = typeof (raw as { provider?: unknown })?.provider === 'string'
    ? ((raw as { provider: string }).provider)
    : undefined;

  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
    .filter((tc) => tc.function?.name)
    .map((tc, i) => ({
      id: tc.id ?? `tc-${i}`,
      name: tc.function!.name!,
      args: tryParseJson(tc.function?.arguments) ?? {},
    }));

  const u = r.usage ?? {};
  const tokens: NormalizedTokens = {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    cached: u.prompt_tokens_details?.cached_tokens,
  };

  // alpha.105 — OpenAI-compatible bodies carry `model`; on a gateway it is the
  // id the gateway resolved (`deepseek/deepseek-v4-flash` on OpenRouter). This
  // is the field the 2026-07-07 gateway stance said the integration point
  // would diff, and through alpha.104 nothing read it.
  const servedModel = typeof r.model === 'string' ? r.model : undefined;
  return { text, structuredOutput: null, toolCalls, tokens, finishReason: choice?.finish_reason, routeHost, servedModel, raw };
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shallow-merge providerOverrides into the request matching its provider.
 * Per-provider keys are independent — overrides for 'google' don't touch an
 * 'anthropic' request.
 */
function applyOverrides(request: CompiledRequest, overrides?: ProviderOverrides): CompiledRequest {
  if (!overrides) return request;
  const layer = overrides[request.provider];
  if (!layer) return request;
  const merged = { ...request, ...layer } as CompiledRequest;
  // alpha.132 (R3a) — `thinking` is merged, not replaced, on Anthropic: an
  // adaptive override keeps kgauto's block_binding; an override that sets its
  // own block_binding (or another type) wins whole (mergeThinkingOverride).
  if (request.provider === 'anthropic' && 'thinking' in layer) {
    const thinking = mergeThinkingOverride((request as { thinking?: unknown }).thinking, (layer as { thinking?: unknown }).thinking);
    return { ...merged, thinking } as CompiledRequest;
  }
  return merged;
}

/**
 * alpha.131 (R4) — one rule for every stream call site. `streaming.ts` keeps its own
 * `classifyHttpError` (for direct callers of the helpers), which has no "no longer available"
 * branch and no `classifyFallback`; so a stream result carrying an HTTP error — `!ok`, a real
 * status (> 0) and the error body (`raw` non-null) — is classified HERE, by the classifier the
 * single-shot path uses, and a streamed delisting walks the chain as a single-shot one does.
 * Anything else (a thrown fetch, a stall, an abort: status 0, raw null; or a success) is returned
 * as the stream said it. (was: the Google path only, alpha.130; the Anthropic, OpenAI, DeepSeek
 * and OpenAI-compatible stream paths returned the stream's own verdict, until alpha.131.)
 * Either term alone decides today — every status-0 return in `streaming.ts` carries `raw: null` —
 * so `status > 0` and `raw !== null` are redundant with each other, and both are kept as the stated
 * contract (a helper that one day returns a body with no status, or a status with no body, is not
 * re-classified on half the evidence).
 */
function reclassifyStreamed(streamed: ExecuteResult): ExecuteResult {
  if (!streamed.ok && streamed.status > 0 && streamed.raw !== null) {
    return classifyHttpError(streamed.status, streamed.raw);
  }
  return streamed;
}

function classifyHttpError(status: number, body: unknown): ExecuteErr {
  const message = extractErrorMessage(body) ?? `HTTP ${status}`;
  const err = classifyHttpErrorInner(status, body, message);
  // KG-18 step 1 — the class rides beside errorCode; the row keeps both (fallback_reason's six
  // values are untouched; this is the second axis the wall reads).
  const { fallbackClass, quotaId } = classifyFallback(status, body, message);
  return { ...err, ...(fallbackClass ? { fallbackClass } : {}), ...(quotaId ? { quotaId } : {}) };
}

function classifyHttpErrorInner(status: number, body: unknown, message: string): ExecuteErr {

  // alpha.77 — billing exhaustion FIRST (spans 400/402/403/429; see
  // isBillingExhaustedBody in streaming.ts, the shared derivation). Terminal
  // for the PROVIDER, walkable for the call: call() treats it like the
  // auth-walk and skips every same-provider sibling.
  if (isBillingExhaustedBody(status, body, message)) {
    return { ok: false, status, errorType: 'terminal', errorCode: 'billing_exhausted', message, raw: body };
  }
  // alpha.132 (R3c) — the prefix-check 400 has its own name and is walkable:
  // call() re-sends the same target once with the thinking blocks stripped,
  // then walks the chain as for any other failure.
  if (status === 400 && isThinkingSignatureMessage(message)) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'thinking_prefix_mismatch', message, raw: body };
  }
  // 429: rate limit — retryable
  if (status === 429) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'rate_limit', message, raw: body };
  }
  // 408: timeout — retryable
  if (status === 408) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'timeout', message, raw: body };
  }
  // 5xx: server error — retryable
  if (status >= 500) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'server_error', message, raw: body };
  }
  // 404: model_not_found / deprecated — retryable (L-061)
  if (status === 404) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'model_not_found', message, raw: body };
  }
  // alpha.91 — a provider delisting a model for the caller's account cohort
  // can arrive as 400, not 404, and Google's wording ("no longer available
  // to new users") contains none of the classic deprecation terms. Keyed on
  // the message so the chain walks past it whatever status it rode in on.
  // (tt-intel TT-49, 2026-08-26: both gemini-2.5-pro and -flash-lite refused
  // with exactly this phrasing while the docs page still said Stable.)
  if (status >= 400 && status < 500 && isModelUnavailableMessage(message)) {
    return { ok: false, status, errorType: 'retryable', errorCode: 'model_not_found', message, raw: body };
  }
  // 401, 403: auth — terminal
  if (status === 401 || status === 403) {
    return { ok: false, status, errorType: 'terminal', errorCode: 'auth', message, raw: body };
  }
  // 400: usually validation — terminal (don't loop on consumer mistakes).
  // But an auth-signature body is a key failure wearing a 400 (Google),
  // and must classify as auth so the chain can walk cross-provider.
  if (status === 400) {
    if (isAuthSignatureBody(body, message)) {
      return { ok: false, status, errorType: 'terminal', errorCode: 'auth', message, raw: body };
    }
    return { ok: false, status, errorType: 'terminal', errorCode: 'invalid_request', message, raw: body };
  }
  // Other 4xx — terminal
  return { ok: false, status, errorType: 'terminal', errorCode: 'unknown', message, raw: body };
}

/**
 * Provider wordings that mean "this model will never serve THIS caller" —
 * delistings and retirements that arrive on statuses other than 404. Kept
 * deliberately narrow: a match reroutes the call to the next chain target,
 * so a false positive here would mask a real validation error.
 */
export function isModelUnavailableMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /no longer (available|supported)|not available to new users|has been (deprecated|retired|discontinued|shut ?down)/i.test(
    message,
  );
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  // Anthropic: { type: 'error', error: { type, message } }
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
  }
  // Some providers nest message at top
  if (typeof b.message === 'string') return b.message;
  return undefined;
}

function terminalError(status: number, code: string, message: string): ExecuteErr {
  return { ok: false, status, errorType: 'terminal', errorCode: code, message, raw: null };
}

function retryableError(status: number, code: string, message: string, raw: unknown): ExecuteErr {
  return { ok: false, status, errorType: 'retryable', errorCode: code, message, raw };
}

function tryParseJson(s: string | undefined): Record<string, unknown> | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Exposed for unit tests.
export const _internal = {
  normalizeAnthropic,
  normalizeGoogle,
  normalizeOpenAILike,
  classifyHttpError,
  applyOverrides,
};
