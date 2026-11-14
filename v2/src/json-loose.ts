/**
 * Fence-tolerant JSON parsing — ONE implementation, shared.
 *
 * Models asked for JSON very commonly wrap it in a markdown fence, and some
 * prepend a sentence. `JSON.parse` throws on the first backtick.
 *
 * This existed already, correctly, inside `parseJudgeVerdict` in
 * golden-eval.ts — and nowhere else. The shared structured-output path in
 * `call()` used a bare `JSON.parse(text)`, so:
 *
 *   - every Anthropic `structuredOutput: true` call that came back fenced
 *     failed with `structured_output_parse_failed`,
 *   - the chain walked to another provider,
 *   - and the consumer paid for a doomed inference first.
 *
 * That is the mechanism behind `claude-haiku-4-5`'s 12-of-12 failures on
 * playbacksam/summarize (s75/s76). It was read as a model weakness — the
 * profile's `structuredOutput: 'grammar'` claim being wrong — when the real
 * cause was that kgauto never asked Anthropic for JSON (see `lowerAnthropic`)
 * and then rejected the JSON it got.
 *
 * Two independent derivations of one concept drift (alpha.69's Factor C
 * lesson). This module exists so there is only one.
 */

/**
 * Parse JSON that may be wrapped in a markdown fence or preceded by prose.
 *
 * Strategy, in order:
 *   1. parse as-is (the fast, strict path — unchanged behaviour for clean JSON)
 *   2. strip a leading ```/```json fence and trailing ```
 *   3. fall back to the outermost {...} or [...] span in the text
 *
 * Returns `{ ok: true, value }` or `{ ok: false, error }`. Never throws.
 */
export function parseJsonLoose(
  raw: string,
): { ok: true; value: unknown; recovered: boolean } | { ok: false; error: string } {
  const attempt = (s: string): unknown | typeof FAILED => {
    try {
      return JSON.parse(s);
    } catch {
      return FAILED;
    }
  };

  const direct = attempt(raw);
  if (direct !== FAILED) return { ok: true, value: direct, recovered: false };

  const cleaned = raw
    .trim()
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  const fenced = attempt(cleaned);
  if (fenced !== FAILED) return { ok: true, value: fenced, recovered: true };

  // Outermost object or array span — handles a leading sentence like
  // "Here is the JSON you asked for:".
  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  const start =
    objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start !== -1) {
    const openChar = cleaned[start];
    const closeChar = openChar === '{' ? '}' : ']';
    const end = cleaned.lastIndexOf(closeChar);
    if (end > start) {
      const span = attempt(cleaned.slice(start, end + 1));
      if (span !== FAILED) return { ok: true, value: span, recovered: true };
    }
  }

  // Report the ORIGINAL failure, not the last recovery attempt's — the first
  // error is the one that describes what the model actually sent.
  try {
    JSON.parse(raw);
    /* c8 ignore next */
    return { ok: false, error: 'unreachable' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const FAILED = Symbol('parse-failed');
