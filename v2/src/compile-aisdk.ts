/**
 * alpha.52 — official AI-SDK-v6 compile adapter + compile-then-discard guard.
 *
 * Until now each AI-SDK consumer (tt-intel, IC) hand-rolled this adapter in
 * its own `lib/kgauto-v2/index.ts`: `compile()` → reassemble the system param
 * per provider → extract kept tool names per provider → re-derive the history
 * cache-mark index (a copy of the compiler's own `historyCacheMarkIndex`
 * logic — drift-prone). This centralizes that boilerplate and DRYs the two
 * near-identical wrappers.
 *
 * It also closes the compile-then-discard hole. The discard pattern is:
 *
 *     const c = compileForAISDKv6(ir);            // compile runs
 *     const out = await generateText({            // …but a hand-built prompt
 *       model: getModel(otherId), prompt });      //    + a DIFFERENT model run
 *     await record({ handle: c.handle, … });      // brain row attributed to `c`
 *
 * The recorded row's `mutations_applied` / `estimated_tokens_in` /
 * `system_prompt_chars` then describe a compile that never reached the wire.
 * A library-level runtime guard could NOT catch this while the adapter lived
 * in consumer code (the consumer wrapper always reads `compile()`'s result to
 * build its own object, so any getter there is "consumed" every time,
 * regardless of whether the final caller used the wrapper output). With the
 * adapter IN the library, the object the FINAL caller reads is library-owned,
 * so consume-tracking getters on `.system` / `.model` / `.raw` detect non-use
 * and `record()` warns. See `interfaces/kgauto.md` (## Requested:
 * `compiled-output-discarded-guard`).
 *
 * The guard is OPT-IN-BY-USE: only `compileForAISDKv6` arms tracking, so
 * `call()` paths and raw `compile()` users never see a false warning.
 */

import { compile as compileImpl, type CompileOptions } from './compile.js';
import {
  registerCompile,
  armCompileConsumeTracking,
  markCompileConsumed,
} from './brain.js';
import type {
  PromptIR,
  CompileResult,
  SystemModelMessage,
  BestPracticeAdvisory,
} from './ir.js';

export interface CompileForAISDKv6Result {
  /**
   * Pass to `streamText`/`generateText({ model })` — the caller maps this id
   * to an AI-SDK `LanguageModel`. Reading this marks the compile "consumed"
   * (silences the compile-then-discard guard).
   */
  readonly model: string;
  /**
   * System parameter for `streamText`/`generateText({ system })`. Returns the
   * structured `SystemModelMessage[]` form when the target is Anthropic AND a
   * cacheable section exists (preserves the cache_control marker across the
   * wire); a flat concatenated string otherwise. Reading this marks
   * "consumed". (Same rule as `attachCacheControlToStreamTextInput`.)
   */
  readonly system: string | SystemModelMessage[];
  /**
   * The raw kgauto `CompileResult` — for `attachCacheControlToStreamTextInput(raw, msgs)`
   * and `probeShadow(raw.ir-equivalent, …)` paths. Reading this marks
   * "consumed" (it means you're using the compile output via the raw result).
   */
  readonly raw: CompileResult;
  /** Tool names that survived budget + relevance — filter your SDK tool map to these. */
  keptToolNames: Set<string>;
  /**
   * providerOptions for `streamText`/`generateText`. Pass it through verbatim:
   * `generateText({ ..., providerOptions: compiled.providerOptions })`.
   *
   * - `anthropic.cacheControl` — cache marker on the cacheable prefix (alpha.33).
   * - `google.thinkingConfig.thinkingBudget: 0` / `deepseek.thinking.type:
   *   'disabled'` — alpha.101. Present iff a `thinking_with_short_output`
   *   cliff fired AND the lowered wire request carries the disable. Before
   *   alpha.101 the adapter reported `cliff-thinking-zero` in
   *   `mutationsApplied` and gave the consumer nothing to put on the wire —
   *   the mutation "fired as designed" in a log line while the model kept
   *   thinking (tt-intelligence, 2026-09-01: 9 of 9 classify calls returned
   *   an empty answer at a 300-token cap). Read from the lowered request,
   *   not from the mutation list, so the adapter can only report what the
   *   wire actually carries (declares ⇒ emits).
   * - `openai.reasoningEffort: 'none'` — alpha.122. Present iff the lowered
   *   OpenAI request carries `reasoning_effort: 'none'` (today: gpt-5.6-luna
   *   offered tools — its `cliff-thinking-zero` rule, the provider's own
   *   remedy for the HTTP 400). `@ai-sdk/openai` documents `reasoningEffort`
   *   with `'none'` among its values for both the Responses and Chat APIs
   *   (ai-sdk.dev/providers/ai-sdk-providers/openai, read 2026-10-06).
   *
   * Undefined when nothing applies.
   */
  providerOptions?: {
    anthropic?: { cacheControl?: { type: 'ephemeral' } };
    google?: { thinkingConfig?: { thinkingBudget?: number } };
    deepseek?: { thinking?: { type: 'enabled' | 'disabled' } };
    openai?: { reasoningEffort?: 'none' };
  };
  /**
   * Index (into post-strip history) for the Anthropic history cache marker
   * (alpha.33). Mirror of `result.diagnostics.historyCacheMarkIndex` — no
   * consumer re-derivation needed. Undefined when no marker fires, and (since
   * alpha.55) always undefined for non-Anthropic targets: the marker is an
   * Anthropic wire concept, other providers cache prefixes implicitly. The
   * ungated value remains on `diagnostics.historyCacheMarkIndex`.
   */
  historyCacheMarkIndex?: number;
  /** Compile handle — pass to `record()` after the call. */
  handle: string;
  /**
   * Mutation ids the compiler fired (informational).
   *
   * ⚠️ alpha.78 — element type differs BY SURFACE: this adapter carries
   * `string[]` (ids), while `CompileResult`/`CallResult.mutationsApplied`
   * carry `MutationApplied[]` (objects with `description`, `rankDelta`, …).
   * Coding to one surface's type while reading the other's runtime is a
   * silent false negative (PB 2026-07-25). Use the shape-proof helpers
   * `mutationId(m)` / `hasMutation(list, 'quality-gate-measured-*')` from
   * the package root instead of `typeof` checks. Neither element type can
   * change without breaking a live consumer (tt-intel joins these ids;
   * object readers want `description`), so the divergence is documented
   * rather than unified.
   */
  mutationsApplied: string[];
  /** Best-practice advisories (alpha.6). Empty when none fired. */
  advisories: BestPracticeAdvisory[];
  /** Compiler diagnostics + the three commonly-logged top-level fields. */
  diagnostics: CompileResult['diagnostics'] & {
    targetProvider: string;
    estimatedCostUsd: number;
    fallbackChain: string[];
  };
  /** The compiled IR — pass to `probeShadow(ir, …)` in `onFinish` (alpha.48). */
  ir: PromptIR;
}

/**
 * Compile a `PromptIR` and lower it to an AI-SDK-v6 `streamText`/`generateText`
 * bundle. Replaces the hand-rolled per-consumer adapter.
 *
 * Arms the compile-then-discard guard: read `.system` / `.model` / `.raw` to
 * serve the call. If you `record()` the handle without reading any of them,
 * `record()` emits a dev-mode warning that the compile was discarded.
 */
export function compileForAISDKv6(
  ir: PromptIR,
  opts?: CompileOptions,
): CompileForAISDKv6Result {
  // Mirror the public `compile()` exit path: compile, then register so
  // record() can enrich the outcome. Then arm consume-tracking on the handle.
  const result = compileImpl(ir, opts);
  // alpha.68 / Release A — forward the fan-out parent handle (usually undefined
  // for AI-SDK compile paths) so registerCompile derives the linkage.
  registerCompile(ir.appId, ir.intent.archetype, ir, result, opts?.parentHandle);
  armCompileConsumeTracking(result.handle);

  // ── System: structured form (Anthropic + cacheable sections) preserves the
  // cache marker; flat string otherwise. Same rule as
  // attachCacheControlToStreamTextInput() so both library paths agree. ──
  const systemMessages = result.systemMessages;
  const hasStructuredSystemCacheControl =
    result.provider === 'anthropic' &&
    systemMessages.some(
      (m) => m.providerOptions?.anthropic?.cacheControl !== undefined,
    );
  const systemValue: string | SystemModelMessage[] = hasStructuredSystemCacheControl
    ? systemMessages
    : systemMessages.map((m) => m.content).join('\n\n');

  const keptToolNames = extractKeptToolNames(result);

  const providerOptions = deriveProviderOptions(result);

  const handle = result.handle;
  const diagnostics = {
    ...result.diagnostics,
    targetProvider: result.provider,
    estimatedCostUsd: result.estimatedCostUsd,
    fallbackChain: result.fallbackChain,
  };

  return {
    handle,
    // Consume-tracking getters: reading any of these flags the compile as
    // "used", silencing the discard guard at record() time.
    get model() {
      markCompileConsumed(handle, 'model');
      return result.target;
    },
    get system() {
      markCompileConsumed(handle, 'system');
      return systemValue;
    },
    get raw() {
      markCompileConsumed(handle, 'raw');
      return result;
    },
    keptToolNames,
    ...(providerOptions ? { providerOptions } : {}),
    // Provider-gated (alpha.55, IC finding): the marker is an Anthropic
    // concept — Gemini/OpenAI/DeepSeek cache prefixes implicitly, and a
    // consumer attaching Anthropic providerOptions at this index on a
    // non-Anthropic call would ship a no-op-at-best marker. The ungated value
    // stays on diagnostics.historyCacheMarkIndex for observability.
    ...(result.provider === 'anthropic' &&
    result.diagnostics.historyCacheMarkIndex !== undefined
      ? { historyCacheMarkIndex: result.diagnostics.historyCacheMarkIndex }
      : {}),
    mutationsApplied: result.mutationsApplied.map((m) => m.id),
    advisories: result.advisories ?? [],
    diagnostics,
    ir,
  };
}

/**
 * Extract the surviving tool names from the lowered request. The wire shape
 * differs per provider (Google nests under `functionDeclarations`; OpenAI
 * under `function.name`; Anthropic/DeepSeek are flat `{ name }`).
 */
function extractKeptToolNames(result: CompileResult): Set<string> {
  const names = new Set<string>();
  const tools = (result.request as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return names;
  if (result.provider === 'google') {
    for (const td of tools as Array<{ functionDeclarations?: Array<{ name?: string }> }>) {
      for (const fn of td.functionDeclarations ?? []) if (fn.name) names.add(fn.name);
    }
  } else if (result.provider === 'openai') {
    for (const t of tools as Array<{ function?: { name?: string } }>) {
      const n = t.function?.name;
      if (n) names.add(n);
    }
  } else {
    // anthropic / deepseek: flat { name }
    for (const t of tools as Array<{ name?: string }>) {
      if (t.name) names.add(t.name);
    }
  }
  return names;
}

/**
 * alpha.101 — providerOptions are derived from the LOWERED REQUEST, never from
 * the mutation list. A mutation id says a pass decided something; the wire
 * says whether that decision reached the provider. Only the second is worth
 * handing to a consumer.
 */
function deriveProviderOptions(
  result: CompileResult,
): CompileForAISDKv6Result['providerOptions'] {
  const out: NonNullable<CompileForAISDKv6Result['providerOptions']> = {};
  const req = result.request as Record<string, unknown>;

  if (result.provider === 'anthropic' && result.diagnostics.cacheableTokens > 0) {
    out.anthropic = { cacheControl: { type: 'ephemeral' } };
  }
  if (result.provider === 'google') {
    const budget = (req.generationConfig as { thinkingConfig?: { thinkingBudget?: unknown } } | undefined)
      ?.thinkingConfig?.thinkingBudget;
    if (budget === 0) out.google = { thinkingConfig: { thinkingBudget: 0 } };
  }
  if (result.provider === 'deepseek') {
    const thinking = req.thinking as { type?: string } | undefined;
    if (thinking?.type === 'disabled') out.deepseek = { thinking: { type: 'disabled' } };
  }
  if (result.provider === 'openai' && req.reasoning_effort === 'none') {
    out.openai = { reasoningEffort: 'none' };
  }
  return Object.keys(out).length ? out : undefined;
}
