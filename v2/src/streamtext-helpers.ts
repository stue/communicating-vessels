/**
 * alpha.33 — AI-SDK streamText helpers.
 *
 * The cross-consumer pattern surfaced 2026-05-20 (`streamText-cache-marker-
 * propagation-gap` on `command-center/interfaces/kgauto.md ## Requested`):
 * AI-SDK consumers using `streamText({ system: <string>, messages:
 * convertToModelMessages(messages), model })` silently drop the Anthropic
 * `cache_control` markers the compiler emits on `result.request.messages`.
 * Two losses on that line:
 *   (a) `convertToModelMessages()` reads raw inputs not the lowered output,
 *       dropping per-message providerOptions; and
 *   (b) `streamText({ system: '<string>' })` strips any providerOptions
 *       on the system prefix.
 *
 * Net effect prior to this surface: `cache_read_input_tokens = 0` across
 * every measured production call by IC + tt-intel even though both
 * consumers had `historyCachePolicy: { strategy: 'all-but-latest' }` wired
 * since alpha.5. The compiler did the right thing; the consumer integration
 * pattern lost the markers at the wire boundary.
 *
 * This helper closes the gap. Pass the consumer's already-converted messages
 * + the kgauto CompileResult and get back a `{ system, messages }` pair
 * with cacheControl re-attached at the deterministic indices the compiler
 * computed (`diagnostics.historyCacheMarkIndex` + `systemMessages` with
 * its own cacheControl markers).
 *
 * No I/O. Pure transform. Idempotent — calling twice with the same inputs
 * produces structurally-identical output.
 */

import type { CompileResult, SystemModelMessage } from './ir.js';

/**
 * AI-SDK-shaped converted-message structure. Matches what
 * `convertToModelMessages()` returns at the wire layer. We don't import
 * the AI-SDK type to avoid pulling that dep into the kgauto-compiler
 * package — consumers pass their own already-converted messages.
 */
export interface AISDKConvertedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  providerOptions?: {
    anthropic?: { cacheControl?: { type: 'ephemeral' } };
  };
}

/**
 * Result of `attachCacheControlToStreamTextInput()` — ready to spread into
 * `streamText(...)` directly.
 *
 * The `system` field is either the structured `SystemModelMessage[]` form
 * (when the compiler computed at least one cacheable section + chose
 * Anthropic) or the flat-string concatenation (when no cacheable sections
 * exist OR the provider isn't Anthropic). Consumers can pass either form
 * to `streamText({ system })` — the AI-SDK accepts both.
 */
export interface AttachCacheControlResult {
  system: string | SystemModelMessage[];
  messages: AISDKConvertedMessage[];
}

/**
 * Attach Anthropic cache_control markers to a streamText input that the
 * consumer has already prepared via `convertToModelMessages()`. Reads
 * `result.diagnostics.historyCacheMarkIndex` for the position-on-history
 * marker and `result.systemMessages` for the per-section system markers.
 *
 * The flat-string `system` form is returned when:
 *   - the compiler produced no `systemMessages` (e.g., zero sections kept), or
 *   - the chosen provider is not Anthropic, so cacheControl wouldn't
 *     achieve anything at the wire layer (other providers cache implicitly
 *     based on prefix shape, no marker needed).
 *
 * Otherwise the structured `SystemModelMessage[]` form is returned —
 * preserves the per-section cacheControl markers across `streamText`.
 *
 * @param result - kgauto CompileResult from `compile(ir, opts)`
 * @param convertedMessages - the consumer's already-converted messages
 *   (from `convertToModelMessages(rawMessages)` in their AI-SDK call site)
 * @returns `{ system, messages }` ready to spread into `streamText(...)`
 */
export function attachCacheControlToStreamTextInput(
  result: CompileResult,
  convertedMessages: AISDKConvertedMessage[],
): AttachCacheControlResult {
  // History cache marker: mutate ONLY the indicated position. The mutation
  // is on a COPY of the messages array — consumers can call this helper
  // repeatedly without accumulating providerOptions across attempts.
  const messages: AISDKConvertedMessage[] = convertedMessages.map((m) => ({ ...m }));
  const markIdx = result.diagnostics.historyCacheMarkIndex;
  if (
    result.provider === 'anthropic' &&
    typeof markIdx === 'number' &&
    markIdx >= 0 &&
    markIdx < messages.length
  ) {
    const target = messages[markIdx];
    if (target) {
      messages[markIdx] = {
        role: target.role,
        content: target.content,
        providerOptions: {
          ...(target.providerOptions ?? {}),
          anthropic: {
            ...(target.providerOptions?.anthropic ?? {}),
            cacheControl: { type: 'ephemeral' },
          },
        },
      };
    }
  }

  // System form: prefer the structured array when it carries cacheControl;
  // otherwise fall back to a concatenated string (matching how the consumer
  // would have constructed `system` in the pre-alpha.33 broken pattern).
  const systemMessages = result.systemMessages;
  const hasStructuredSystemCacheControl =
    result.provider === 'anthropic' &&
    systemMessages.some(
      (m) => m.providerOptions?.anthropic?.cacheControl !== undefined,
    );
  const system: string | SystemModelMessage[] = hasStructuredSystemCacheControl
    ? systemMessages
    : systemMessages.map((m) => m.content).join('\n\n');

  return { system, messages };
}
