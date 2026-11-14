/**
 * Tokenizer abstraction.
 *
 * Default: char-based fallback (~4 chars/token, ±20% accuracy).
 * Recommended: caller wires js-tiktoken or a provider-specific tokenizer
 * via setTokenizer(). The compiler always calls countTokens(); the rest of
 * the system never touches the implementation directly.
 */

let tokenizerImpl: (text: string) => number = defaultCharBasedCounter;

function defaultCharBasedCounter(text: string): number {
  if (!text) return 0;
  // ~4 chars/token is a defensible cross-provider average.
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Wire a real tokenizer. Caller is responsible for picking one accurate
 * enough for their dominant provider.
 */
export function setTokenizer(impl: (text: string) => number): void {
  tokenizerImpl = impl;
}

/**
 * Reset to the char-based fallback. Useful in tests.
 */
export function resetTokenizer(): void {
  tokenizerImpl = defaultCharBasedCounter;
}

/**
 * Count tokens for a string. Wraps the configured implementation with
 * safety (never throws, always returns ≥ 0 for non-empty input).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    const n = tokenizerImpl(text);
    return Number.isFinite(n) && n >= 0 ? n : defaultCharBasedCounter(text);
  } catch {
    return defaultCharBasedCounter(text);
  }
}

/**
 * Estimate tokens for a tool definition (name + description + params).
 * Tools eat from the same context budget as text; we include a small
 * overhead per tool for provider framing.
 */
export function countToolTokens(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): number {
  const namePart = countTokens(tool.name);
  const descPart = tool.description ? countTokens(tool.description) : 0;
  const paramPart = tool.parameters
    ? countTokens(JSON.stringify(tool.parameters))
    : 0;
  // +8 for provider framing (e.g., {"name": "...", "input_schema": {...}})
  return namePart + descPart + paramPart + 8;
}

/**
 * Estimate total tokens for a message array. +4 per message for role/structure.
 */
export function countMessagesTokens(
  messages: Array<{ content: string }>,
): number {
  let total = 0;
  for (const m of messages) {
    total += countTokens(m.content) + 4;
  }
  return total;
}
