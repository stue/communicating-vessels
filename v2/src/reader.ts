/**
 * readFiling() — the second-family reader (alpha.115).
 *
 * A design filing written by one model family is read by a DIFFERENT family,
 * which returns located corrections: the claim quoted, why it is wrong, and
 * the one command that would show it. Ruling:
 * `docs/plans/2026-09-26-second-family-reader.md` (cc's `## Requested` entry
 * `2026-09-26 — second-family-reader-route`, Sacha's WB-38 word).
 *
 * The invariant — a filing is never read by its writer's family — is held
 * twice, on purpose:
 *
 *   1. In POLICY, at the family level: `blockedProviders: [writerFamily]`.
 *      compile() never selects the family, the call() walk filters it (that
 *      is the site that matters: `ensureCrossProviderTail` can append a
 *      reachable model the policy never saw), and the block is SAID as a
 *      `blocked-provider-<p>` mutation. A model list would drift as the
 *      family ships new ids; a family block does not.
 *   2. AFTER the call: a result served by the writer's family throws
 *      `ReaderFamilyViolation`. A reading is never returned from the
 *      writer's family, even on a fall-over nothing above anticipated.
 *
 * Model choice is kgauto's: consumers never pass a model. The chain is
 * {@link READER_CHAIN} (three families, head first); the head is pinned with
 * `preferredModels` because compile()'s scorer, left alone, ranks gpt-5.4
 * (critique perf 8) over deepseek-v4-pro (6) — the preference is what keeps
 * the ruled order, and it is said as the `policy-preferred-<id>` mutation.
 *
 * Telemetry: `appId: 'kgauto-reader'`, `source: 'reader'`. Migration 082
 * inserts the app row (compile_outcomes.app_id is an FK) and admits 'reader'
 * in the source CHECK; until it is applied the brain rejects these rows.
 *
 * No tools, no repository access, no HTTP route (the CLI is
 * `scripts/read-filing.mjs`; a route can wrap this function later).
 */

import { call as defaultCall } from './call.js';
import { computeCostUsd } from './brain.js';
import { estimateInputTokens } from './passes.js';
import { tryGetProfile, priceAtInput } from './profiles.js';
import type {
  ApiKeys,
  CallOptions,
  CallResult,
  CallRoute,
  CompilePolicy,
  PromptIR,
  Provider,
} from './ir.js';

/** The brain app id every reading records under (migration 082 inserts it). */
export const READER_APP_ID = 'kgauto-reader';

/**
 * The reader chain, head first: three families. deepseek-v4-pro is the
 * cheapest strong reasoner of the three; gpt-5.4 and gemini-3.8-flash are
 * the cross-family tail. Each is `status: 'current'` in profiles.ts
 * (asserted by tests/reader.test.ts, so a retirement turns the suite red).
 */
export const READER_CHAIN: readonly string[] = ['deepseek-v4-pro', 'gpt-5.4', 'gemini-3.8-flash'];

/** Input ceiling, in `estimateInputTokens` units over the whole reader IR. */
export const READER_MAX_INPUT_TOKENS = 24_000;

/** Default per-call cost ceiling (USD), applied as `policy.maxCostPerCallUsd`. */
export const READER_DEFAULT_MAX_COST_USD = 0.25;

export interface ReaderCorrection {
  /** The claim, quoted from the filing. */
  claim: string;
  /** Why it is wrong or unsupported. */
  why: string;
  /** The one command that would show it. */
  command: string;
}

export interface FilingReading {
  /** The provider family that answered (`CallResult.provider`). */
  family: Provider;
  /** The model that answered (`CallResult.actualModel`). */
  model: string;
  /** Fingerprint of the key the call was served with (never the key). */
  keyFingerprint?: string;
  /**
   * USD for the SERVED attempt, priced by the function `record()` prices the
   * brain row with (`computeCostUsd`, alpha.130 R5): the request's tier, cache
   * reads at the cache-read price by the wire's meaning of `tokens.input`.
   * Failed attempts on a fall-over are not included; cache writes are not
   * priced (as on the row). (was: `estimateModelCostUsd` — list price at the
   * base tier, no cache reads — until alpha.130.)
   */
  costUsd: number;
  /** Compile handle — the brain row's `handle`. */
  handle: string;
  /** Set when the call fell over; the model it fell over from. */
  fellOverFrom?: string;
  corrections: ReaderCorrection[];
  /** The claim the reader is least sure of. Non-null whenever `corrections` is empty. */
  leastSure: string | null;
}

export interface ReadFilingOptions {
  /** The family that WROTE the filing; it is blocked from reading it. Default `'anthropic'`. */
  writerFamily?: Provider;
  /** Per-call cost ceiling (USD). Default {@link READER_DEFAULT_MAX_COST_USD}. */
  maxCostUsd?: number;
  /** Provider keys; `process.env` is read when omitted (the call() default). */
  apiKeys?: ApiKeys;
  /** Fetch override (tests, non-Node runtimes). */
  fetchImpl?: typeof fetch;
  /** Per-attempt time budget, passed to call(). */
  attemptTimeoutMs?: number;
  /** `'openrouter'` when a family has no direct key. Default: kgauto's direct execute leg. */
  route?: CallRoute;
  /**
   * @internal Test seam: replaces call(). The reader's own contract (the
   * post-call family assertion, the output validation) runs on whatever it
   * returns — which is how a same-family fall-over is exercised in tests,
   * since the real call() can no longer produce one.
   */
  callImpl?: (ir: PromptIR, opts: CallOptions) => Promise<CallResult>;
}

/** Thrown when the answer came from the writer's family. Never a reading. */
export class ReaderFamilyViolation extends Error {
  readonly writerFamily: Provider;
  readonly family: string;
  readonly model: string;
  readonly fellOverFrom?: string;
  constructor(writerFamily: Provider, family: string, model: string, fellOverFrom?: string) {
    super(
      `readFiling(): the reading was served by ${family}/${model}, the writer's own family (${writerFamily})` +
        (fellOverFrom ? ` after a fall-over from ${fellOverFrom}` : '') +
        ` — discarded. A filing is never read by the family that wrote it.`,
    );
    this.name = 'ReaderFamilyViolation';
    this.writerFamily = writerFamily;
    this.family = family;
    this.model = model;
    this.fellOverFrom = fellOverFrom;
  }
}

/** Thrown before any call when the reader IR estimates above the ceiling. */
export class ReaderInputTooLarge extends Error {
  readonly estimatedTokens: number;
  readonly limit: number;
  constructor(estimatedTokens: number, limit: number) {
    super(
      `readFiling(): input estimates ${estimatedTokens} tokens (estimateInputTokens over the filing plus the reader prompt) — ` +
        `above the ${limit}-token ceiling. Split the filing or read the part that carries the claims.`,
    );
    this.name = 'ReaderInputTooLarge';
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
  }
}

/**
 * Thrown when every selectable reader model is over the cost ceiling —
 * the existing `cost_cap` preflight reason (`FallbackReason`), surfaced,
 * never a silent fallback to something the cap did not cover.
 */
export class ReaderCostCapExceeded extends Error {
  readonly reason = 'cost_cap' as const;
  readonly maxCostUsd: number;
  /** Estimated input cost per selectable model (passScoreTargets' formula). */
  readonly estimates: Array<{ model: string; estimatedCostUsd: number }>;
  constructor(maxCostUsd: number, estimates: Array<{ model: string; estimatedCostUsd: number }>) {
    super(
      `readFiling(): cost_cap — every selectable reader model is over the $${maxCostUsd.toFixed(4)} ceiling: ` +
        estimates.map((e) => `${e.model} ~$${e.estimatedCostUsd.toFixed(4)}`).join(', ') +
        `. Raise maxCostUsd or shorten the filing.`,
    );
    this.name = 'ReaderCostCapExceeded';
    this.maxCostUsd = maxCostUsd;
    this.estimates = estimates;
  }
}

/** Thrown when the reader's JSON does not meet the output contract. */
export class ReaderOutputInvalid extends Error {
  readonly family: string;
  readonly model: string;
  readonly text: string;
  constructor(detail: string, family: string, model: string, text: string) {
    super(`readFiling(): ${family}/${model} returned a reading outside the contract — ${detail}`);
    this.name = 'ReaderOutputInvalid';
    this.family = family;
    this.model = model;
    this.text = text;
  }
}

const READER_INSTRUCTIONS = [
  'You read a design filing written by a model from a different family than yours. Your only job is to find claims in it that are wrong, unsupported, or unverifiable as stated, and to say how each one could be checked.',
  '',
  'Rules:',
  '- Report LOCATED corrections only. For each one: "claim" quotes the filing\'s exact words (short, verbatim); "why" says in one or two sentences why the claim is wrong or unsupported; "command" is the ONE shell command, query or file read that would show the truth.',
  '- No praise. No summary. No restatement of the filing. No style or wording notes. No general risks that do not name a specific claim.',
  '- Numbers, counts, dates, versions, file paths, and causal claims ("because", "so", "due to") are the claims most worth checking.',
  '- You have no tools and no repository access. Judge from the text; the command is what a reader WITH access would run.',
  '- If you find no correction, return an empty "corrections" array and set "leastSure" to the claim you are least sure of, quoted, with one line on why. "leastSure" may be null only when "corrections" is non-empty.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"corrections":[{"claim":"...","why":"...","command":"..."}],"leastSure":"..." or null}',
].join('\n');

/**
 * The reader IR for a filing. Exported so the size guard, the smoke and the
 * tests measure exactly what is sent.
 */
export function buildReaderIR(markdown: string): PromptIR {
  return {
    appId: READER_APP_ID,
    intent: { name: 'read-filing', archetype: 'critique' },
    sections: [{ id: 'reader-instructions', text: READER_INSTRUCTIONS }],
    currentTurn: { role: 'user', content: `The filing to read:\n\n<filing>\n${markdown}\n</filing>` },
    models: [...READER_CHAIN],
    constraints: { structuredOutput: true },
  };
}

/**
 * Validate the reader's parsed JSON against the output contract:
 * `{ corrections: [{ claim, why, command }], leastSure: string | null }`,
 * each correction's three fields non-empty strings, and — the contract's
 * one rule — an empty `corrections` requires a non-null `leastSure`.
 * Throws a plain Error naming the first violation; `readFiling` wraps it.
 */
export function parseReading(structured: unknown): { corrections: ReaderCorrection[]; leastSure: string | null } {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    throw new Error('the response is not a JSON object');
  }
  const obj = structured as Record<string, unknown>;
  if (!Array.isArray(obj.corrections)) {
    throw new Error('"corrections" is missing or not an array');
  }
  const corrections: ReaderCorrection[] = obj.corrections.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`corrections[${i}] is not an object`);
    }
    const r = c as Record<string, unknown>;
    for (const field of ['claim', 'why', 'command'] as const) {
      if (typeof r[field] !== 'string' || (r[field] as string).trim() === '') {
        throw new Error(`corrections[${i}].${field} is missing or empty`);
      }
    }
    return { claim: (r.claim as string).trim(), why: (r.why as string).trim(), command: (r.command as string).trim() };
  });
  const raw = obj.leastSure;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    throw new Error('"leastSure" is neither a string nor null');
  }
  const leastSure = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (corrections.length === 0 && leastSure === null) {
    throw new Error('"corrections" is empty and "leastSure" is null — a reading with no correction must name its least-sure claim');
  }
  return { corrections, leastSure };
}

/**
 * Read a filing with a family other than its writer's. Returns the reading,
 * naming who answered; throws `ReaderInputTooLarge`, `ReaderCostCapExceeded`,
 * `ReaderFamilyViolation`, `ReaderOutputInvalid`, or call()'s own `CallError`
 * (e.g. `no_reachable_models` when no reader family has a key).
 */
export async function readFiling(markdown: string, opts: ReadFilingOptions = {}): Promise<FilingReading> {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new TypeError('readFiling(): the filing must be a non-empty markdown string');
  }
  const writerFamily: Provider = opts.writerFamily ?? 'anthropic';
  const maxCostUsd = opts.maxCostUsd ?? READER_DEFAULT_MAX_COST_USD;
  if (!(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
    throw new RangeError(`readFiling(): maxCostUsd must be a positive number, got ${String(opts.maxCostUsd)}`);
  }

  const ir = buildReaderIR(markdown);
  const estimatedTokens = estimateInputTokens(ir);
  if (estimatedTokens > READER_MAX_INPUT_TOKENS) {
    throw new ReaderInputTooLarge(estimatedTokens, READER_MAX_INPUT_TOKENS);
  }

  // The ruled head, pinned. If the writer's family IS the head's family, the
  // next model outside it leads instead (the block would void the preference).
  const head = READER_CHAIN.find((id) => tryGetProfile(id)?.provider !== writerFamily);
  const policy: CompilePolicy = {
    blockedProviders: [writerFamily],
    maxCostPerCallUsd: maxCostUsd,
    ...(head ? { preferredModels: [head] } : {}),
  };

  // The cost ceiling, preflighted with passScoreTargets' own formula
  // (estimated input tokens × the profile's input price). When EVERY
  // selectable reader model is over it, that is the `cost_cap` refusal, said
  // before any wire call. When only some are, compile() excludes them itself
  // and says each as a `policy-over-cost-<id>` mutation.
  const selectable = READER_CHAIN.filter((id) => {
    const p = tryGetProfile(id);
    return p !== undefined && p.provider !== writerFamily;
  });
  const estimates = selectable.map((id) => ({
    model: id,
    // alpha.128 — the scorer's formula prices the input's tier; the preflight says the same number.
    estimatedCostUsd: (estimatedTokens / 1_000_000) * priceAtInput(tryGetProfile(id)!, estimatedTokens).costInputPer1m,
  }));
  if (estimates.length > 0 && estimates.every((e) => e.estimatedCostUsd > maxCostUsd)) {
    throw new ReaderCostCapExceeded(maxCostUsd, estimates);
  }

  const callImpl = opts.callImpl ?? defaultCall;
  const result = await callImpl(ir, {
    policy,
    source: 'reader',
    apiKeys: opts.apiKeys,
    fetchImpl: opts.fetchImpl,
    attemptTimeoutMs: opts.attemptTimeoutMs,
    route: opts.route,
  });

  // The invariant, asserted on what actually served.
  const servedFamily = tryGetProfile(result.actualModel)?.provider;
  if (result.provider === writerFamily || servedFamily === writerFamily) {
    throw new ReaderFamilyViolation(writerFamily, result.provider, result.actualModel, result.fellOverFrom);
  }

  let parsed: { corrections: ReaderCorrection[]; leastSure: string | null };
  try {
    parsed = parseReading(result.response.structuredOutput);
  } catch (err) {
    throw new ReaderOutputInvalid(
      err instanceof Error ? err.message : String(err),
      result.provider,
      result.actualModel,
      result.response.text,
    );
  }

  // alpha.130 (R5) — the finished call is priced the way record() prices the
  // brain row: the same function, the same wire (the gateway on the
  // openrouter route, else the served model's provider), the same token
  // counts including cache reads. The `### Read by …` line prints this figure.
  // (was: estimateModelCostUsd — list price at the base tier, no cache reads.)
  const wire =
    opts.route === 'openrouter'
      ? 'openrouter'
      : (tryGetProfile(result.actualModel)?.provider ?? result.provider);
  const costUsd =
    computeCostUsd(result.actualModel, wire, {
      in: result.response.tokens.input,
      out: result.response.tokens.output,
      cached: result.response.tokens.cached,
      cacheCreated: result.response.tokens.cacheCreated,
    }) ?? 0;

  return {
    family: result.provider,
    model: result.actualModel,
    ...(result.keyFingerprint ? { keyFingerprint: result.keyFingerprint } : {}),
    costUsd,
    handle: result.handle,
    ...(result.fellOverFrom ? { fellOverFrom: result.fellOverFrom } : {}),
    corrections: parsed.corrections,
    leastSure: parsed.leastSure,
  };
}

/**
 * The markdown block the CLI prints and cc's filing form pastes. The header
 * line — `Read by <family>/<model> · $<cost>` — is the field the
 * corrections-per-reader ledger splits on.
 */
export function renderReadingMarkdown(reading: FilingReading): string {
  const lines: string[] = [`### Read by ${reading.family}/${reading.model} · $${reading.costUsd.toFixed(4)}`];
  if (reading.fellOverFrom) lines.push('', `_Fell over from ${reading.fellOverFrom}._`);
  lines.push('');
  if (reading.corrections.length === 0) {
    lines.push(`No correction. Least-sure claim: ${reading.leastSure ?? '(none given)'}`);
  } else {
    reading.corrections.forEach((c, i) => {
      lines.push(`${i + 1}. **Claim:** "${c.claim}"`);
      lines.push(`   **Why:** ${c.why}`);
      // A command that itself carries a backtick is fenced with two, so it is shown verbatim.
      const fence = c.command.includes('`') ? '``' : '`';
      const pad = fence.length > 1 ? ' ' : '';
      lines.push(`   **Command:** ${fence}${pad}${c.command}${pad}${fence}`);
    });
    if (reading.leastSure) lines.push('', `Least-sure claim: ${reading.leastSure}`);
  }
  return lines.join('\n');
}
