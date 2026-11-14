/**
 * Oracle contract — how an app tells the brain whether a response was good.
 *
 * The brain learns from oracle scores. Apps provide an oracle function per
 * intent (or one default). Without oracle scores the brain can still record
 * structural metrics (tokens, latency, success) but mutations cannot fire —
 * structural metrics aren't quality.
 *
 * Two oracle styles supported:
 *   1. App-provided synchronous scorer: cheap, deterministic, app-specific.
 *      Examples: "did the SQL filter return non-empty?", "did the JSON parse?",
 *      "did the response cite a known source?".
 *   2. LLM-as-judge async scorer: built into kgauto for cold-start use. Calls
 *      a frontier model with a comparison prompt and parses a score.
 */

import type { OracleScore } from './ir.js';

export interface OracleContext {
  /** App identifier. */
  appId: string;
  /** App-local intent name. */
  intentName: string;
  /** Canonical archetype. */
  archetype: string;
  /** The original user turn text. */
  userTurn?: string;
  /** The model's text response. */
  response: string;
  /** Whether tool calls were involved. */
  hadTools: boolean;
  /** Free-form metadata the caller can attach. */
  meta?: Record<string, unknown>;
}

/** App-provided oracle: pure function (sync or async). */
export type AppOracle = (ctx: OracleContext) => OracleScore | Promise<OracleScore>;

// ─────────────────────────────────────────────────────────────────────────
// LLM-as-judge fallback
// ─────────────────────────────────────────────────────────────────────────

export interface LLMJudgeOptions {
  /** Function that calls the judge model. Caller wires their own SDK. */
  judgeCall: (prompt: string) => Promise<string>;
  /**
   * The dimensions to score. Default: 4-dimension rubric (correctness,
   * completeness, conciseness, format).
   */
  dimensions?: string[];
  /** Hard cap on judge calls per minute (rate limiting). */
  rateLimitPerMin?: number;
}

const DEFAULT_DIMENSIONS = ['correctness', 'completeness', 'conciseness', 'format'];

let judgeCallTimes: number[] = [];

/**
 * Build an LLM-as-judge oracle. Returns an AppOracle that asks the judge
 * model to rate the response and parses a JSON score.
 */
export function buildLLMJudge(opts: LLMJudgeOptions): AppOracle {
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
  const rateLimit = opts.rateLimitPerMin;

  return async (ctx: OracleContext): Promise<OracleScore> => {
    if (rateLimit) {
      const now = Date.now();
      judgeCallTimes = judgeCallTimes.filter((t) => now - t < 60_000);
      if (judgeCallTimes.length >= rateLimit) {
        return { score: 0.5, rationale: 'judge rate-limited; default neutral' };
      }
      judgeCallTimes.push(now);
    }

    const prompt = buildJudgePrompt(ctx, dimensions);
    let raw: string;
    try {
      raw = await opts.judgeCall(prompt);
    } catch (err) {
      return {
        score: 0.5,
        rationale: `judge error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return parseJudgeOutput(raw, dimensions);
  };
}

function buildJudgePrompt(ctx: OracleContext, dimensions: string[]): string {
  return `You are an oracle scoring an AI response. Output ONLY a JSON object, no other text.

Intent archetype: ${ctx.archetype}
App: ${ctx.appId} / ${ctx.intentName}
Tools were involved: ${ctx.hadTools}

User asked:
${ctx.userTurn ?? '<not provided>'}

Response:
${ctx.response.slice(0, 4000)}

Score from 0.0 to 1.0 on each dimension. 1.0 = perfect, 0.5 = mediocre, 0.0 = wrong.
Be honest — most responses are 0.5-0.8. Reserve 0.9+ for genuinely excellent.

Respond with this JSON shape:
{
  "score": <overall 0..1>,
  "dimensions": { ${dimensions.map((d) => `"${d}": <0..1>`).join(', ')} },
  "rationale": "<one sentence>"
}`;
}

function parseJudgeOutput(raw: string, dimensions: string[]): OracleScore {
  // Strip code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last-ditch: extract first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return { score: 0.5, rationale: 'judge output unparseable' };
      }
    } else {
      return { score: 0.5, rationale: 'judge output unparseable' };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { score: 0.5, rationale: 'judge output not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const score = clamp(typeof obj.score === 'number' ? obj.score : 0.5);
  const dims: Record<string, number> = {};
  if (obj.dimensions && typeof obj.dimensions === 'object') {
    for (const d of dimensions) {
      const v = (obj.dimensions as Record<string, unknown>)[d];
      dims[d] = clamp(typeof v === 'number' ? v : 0.5);
    }
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined;

  return { score, dimensions: Object.keys(dims).length > 0 ? dims : undefined, rationale };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
