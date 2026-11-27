/**
 * Golden-set eval engine (alpha.62, eval spine — design brief 2026-07-17).
 *
 * Implements the quality-floor-guarded model-swap contract:
 *
 *   > A model replaces another on a surface only by demonstrating
 *   > same-or-better quality on that surface's real workload — never by
 *   > price, recency, or judgment alone.
 *
 * One eval run: load the active golden set for (app, archetype), replay every
 * IR on BOTH the incumbent and the candidate (fresh outputs on both sides —
 * fair comparison, no stale stored output), apply mechanical hard floors,
 * then a pairwise LLM judge (order-swapped to cancel position bias), and
 * aggregate against the bar — "not worse on N of M judged cases" (a win or a tie
 * is not worse):
 *
 *   promote-ready  ⇔  wins-or-ties ≥ threshold (default 80%)
 *                     AND zero hard-floor violations
 *                     AND candidate p50 latency ≤ ratio × incumbent p50
 *   below-bar      ⇔  the run was conclusive and the candidate did NOT
 *                     clear that bar (any of the three legs failed).
 *                     Renamed in alpha.114 (CHANGELOG, migration 081): the
 *                     old name read in English as the opposite of this.
 *   inconclusive   ⇔  not enough judged cases (below minJudgeableCases,
 *                     or attrition above MAX_ATTRITION) to say either way.
 *
 * Evidence lands as brain rows: one `kgauto_golden_eval_runs` aggregate + one
 * `probe_outcomes` row per case (`replay_source='golden-replay'`, full
 * fidelity by construction) + an evidence-attached advisory on the consumer's
 * advisory surface (trust-ladder Stage 1: eval runs, human clicks promote).
 *
 * Judging is PAIRWISE, not absolute — it operationalizes the quality-floor
 * Common Pattern directly ("same or better, never less"). Each pair is judged
 * twice with A/B order swapped; disagreement between the two orders is scored
 * a tie (the honest reading of positional noise).
 *
 * This module is operator-grade: it talks to the brain via direct PostgREST
 * with a service key (the watchers' convention), never through consumer
 * proxies, and it deliberately does NOT call record() — eval traffic must not
 * pollute compile_outcomes.
 */

import type { ApiKeys, PromptIR } from './ir.js';
import { compile } from './compile.js';
import { execute } from './execute.js';
import { tryGetProfile, inferProviderFromId } from './profiles.js';
import { _internal } from './call.js';
import { resolveOutputMode } from './dialect.js';
import { countTokens } from './tokenizer.js';

// ─────────────────────────────────────────────────────────────────────────
// Per-archetype judge rubrics
// ─────────────────────────────────────────────────────────────────────────

const GENERIC_RUBRIC =
  'overall correctness, completeness against the request, clarity, and adherence to any requested format';

/**
 * Default judge model (judge chain tier 0). Exported so operator scripts
 * (golden-eval-trigger's judge pre-flight) probe the SAME model the engine
 * will call — two inline literals of one concept is the s75 drift shape.
 * 2026-08-25: the judge had no pre-flight at all, so an Anthropic billing
 * outage would have burned incumbent+candidate replay spend on non-Anthropic
 * surfaces before dying verdictless at judge time.
 *
 * 2026-08-25 (same session): moved 'claude-opus-4-8' → 'claude-opus-5'. The
 * guard test caught the old default sitting on a status:'legacy' roster
 * entry (4-8 went legacy 2026-07-25 with the Opus 5 generation; nobody moved
 * the judge). Verdict comparability across the switch is preserved by
 * `judge_model` on every run + case row (migrations 024/036).
 */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-5';

/**
 * alpha.102 — the largest share of a golden set a run may EXCLUDE (replay
 * or judge failures) and still emit a conclusive verdict. Above it the run
 * is `inconclusive` with the attrition named, whatever the survivors said.
 */
export const MAX_ATTRITION = 0.5;

/**
 * What "better" means per archetype. Fed verbatim into the pairwise judge
 * prompt. Kept deliberately short — the judge sees the full request, so the
 * rubric only needs to name the failure modes that matter for the archetype.
 */
export const JUDGE_RUBRICS: Record<string, string> = {
  summarize:
    'faithfulness to the source (no fabricated facts), coverage of the key points, concision, and adherence to the requested output format',
  classify:
    'assignment of the correct category from the allowed set, and nothing outside the allowed set',
  generate:
    'relevance to the brief, quality and coherence of the writing, and adherence to the requested format and tone',
  extract:
    'completeness of extraction (nothing relevant missed), precision (no invented fields or values), and exact schema adherence',
  ask: 'correctness of the answer with respect to the provided data, relevance, and absence of fabrication',
  hunt: 'relevance and novelty of the discovered entities, and absence of duplicates or fabricated entries',
  plan: 'quality of the decomposition (complete, ordered, actionable steps) and realism of the sequencing',
  critique:
    'specificity and correctness of the assessment, and actionability of the feedback',
  transform:
    'preservation of the source content and correctness of the target format or style',
};

/**
 * alpha.128 — the one headline for a pairwise run: "not worse on N of M judged
 * cases", N = wins + ties (a win or a tie is not worse), M = wins + ties + losses.
 * Replaces the rule-name headline and the bare wins-or-ties percentage (until alpha.127):
 * the count says what was measured against what; a rule's name does not.
 */
export function notWorseOn(wins: number, ties: number, losses: number): string {
  return `not worse on ${wins + ties} of ${wins + ties + losses} judged cases`;
}

export function rubricFor(archetype: string): string {
  return JUDGE_RUBRICS[archetype] ?? GENERIC_RUBRIC;
}

// ─────────────────────────────────────────────────────────────────────────
// Pairwise judge prompt + verdict parsing (pure, exported for tests)
// ─────────────────────────────────────────────────────────────────────────

const INPUT_TRUNCATE_CHARS = 24_000;
const OUTPUT_TRUNCATE_CHARS = 12_000;

/** Render the golden IR's request for the judge (system sections + user turn). */
export function renderIrForJudge(ir: PromptIR): string {
  const sections = (ir.sections ?? [])
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  const turn =
    typeof ir.currentTurn?.content === 'string' ? ir.currentTurn.content : '';
  const combined = [
    sections ? `[system]\n${sections}` : '',
    turn ? `[user]\n${turn}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return combined.length > INPUT_TRUNCATE_CHARS
    ? `${combined.slice(0, INPUT_TRUNCATE_CHARS)}\n…[truncated]`
    : combined;
}

export function buildPairwiseJudgePrompt(args: {
  archetype: string;
  renderedInput: string;
  outputA: string;
  outputB: string;
}): string {
  const clip = (s: string): string =>
    s.length > OUTPUT_TRUNCATE_CHARS
      ? `${s.slice(0, OUTPUT_TRUNCATE_CHARS)}\n…[truncated]`
      : s;
  return `You are a strict pairwise judge comparing two AI responses to the SAME request.

The request (archetype: ${args.archetype}):
<request>
${args.renderedInput}
</request>

Response A:
<response_a>
${clip(args.outputA)}
</response_a>

Response B:
<response_b>
${clip(args.outputB)}
</response_b>

Judge which response better satisfies the request. Rubric for ${args.archetype}: ${rubricFor(args.archetype)}.

A tie is a legitimate verdict — declare it when the responses are of genuinely comparable quality. Do NOT prefer a response merely for being longer.

Output ONLY this JSON, no other text:
{"winner": "A" | "B" | "tie", "rationale": "<one sentence>"}`;
}

export type PairwiseWinner = 'A' | 'B' | 'tie';

/** Parse the judge's JSON verdict. Returns undefined when unparseable. */
export function parseJudgeVerdict(
  raw: string,
): { winner: PairwiseWinner; rationale?: string } | undefined {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      // alpha.102 — the judge writes prose in `rationale` and sometimes
      // quotes the responses inside it WITHOUT escaping the quotes, which
      // is invalid JSON with a perfectly readable verdict. MEASURED
      // 2026-09-03 on PB golden #66: `{"winner": "A", "rationale": "... a
      // stray "(variant)" artifact ..."}` — this is what excluded 21 of 29
      // cases on the 2026-09-01 fire as "judge failed". The winner field is
      // a closed enum at a fixed position; read it directly.
      const winner = cleaned.match(/"winner"\s*:\s*"(A|B|tie)"/);
      if (!winner) return undefined;
      const rationale = cleaned.match(/"rationale"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
      return {
        winner: winner[1] as PairwiseWinner,
        rationale: rationale?.[1] !== undefined ? rationale[1].slice(0, 500) : undefined,
      };
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const winner = obj.winner;
  if (winner !== 'A' && winner !== 'B' && winner !== 'tie') return undefined;
  return {
    winner,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
  };
}

/**
 * Combine the two order-swapped verdicts into a case verdict. Both verdicts
 * are expressed in incumbent/candidate terms BEFORE this call (the caller
 * un-swaps run 2). Agreement → that verdict; disagreement → 'tied' (positional
 * noise reads as a tie, never as a win).
 */
export function combineOrderSwappedVerdicts(
  run1: 'candidate-better' | 'current-better' | 'tied',
  run2: 'candidate-better' | 'current-better' | 'tied',
): 'candidate-better' | 'current-better' | 'tied' {
  if (run1 === run2) return run1;
  return 'tied';
}

// ─────────────────────────────────────────────────────────────────────────
// Eval run
// ─────────────────────────────────────────────────────────────────────────

/**
 * Release B — the eval's comparison primitive is arm-agnostic: a MODEL
 * comparison varies `model` and holds `ir`; a STRATEGY comparison varies
 * `ir` and holds `model`. Same replay, same judge, same order-swap, same
 * floors.
 */
export type GoldenEvalAxis = 'model' | 'strategy';

/** Strategies the eval can measure. Closed set — a strategy is only
 * measurable against its exact frozen bytes. The `-alt` wording is
 * EVAL-ONLY: it exists to attribute a v1 loss to wording vs mechanism
 * (§6) and never ships in a production compile. */
export type GoldenEvalStrategyId =
  | 'discipline-gates-v1'
  | 'discipline-gates-v1-alt'
  | 'discipline-gates-v1-alt-blind'
  /**
   * alpha.102 — the POSITIVE CONTROL. Arm B is the incumbent's OWN answer,
   * deliberately damaged after replay (`degradeControlArm`): same model,
   * same prompt, same format opening, then cut. The judge MUST prefer arm A
   * on ≥ 80% of cases; if it does not, the judge cannot be trusted this fire
   * and every other verdict from the fire is quarantined. PB-Cairn's
   * condition (2026-08-30): every expensive kgauto bug returned a confident
   * negative, not an error, and "no meaningful change" is exactly that shape.
   */
  | 'control-degraded-v1';

export const CONTROL_STRATEGY_ID: GoldenEvalStrategyId = 'control-degraded-v1';

/**
 * alpha.102 — damage a text answer so that any competent judge prefers the
 * original: keep the opening (so the format looks right), drop the rest.
 * Pure; the same input always yields the same damage.
 */
export function degradeControlArm(text: string): string {
  const keep = Math.max(24, Math.floor(text.length * 0.3));
  if (text.length <= keep + 8) return text.slice(0, Math.max(8, Math.floor(text.length / 2)));
  return `${text.slice(0, keep).trimEnd()} …`;
}

/** Did the control's damage actually take (arm B is strictly shorter)? */
export function controlDamageApplied(original: string, degraded: string): boolean {
  return degraded.length < original.length && original.trim().length > 0;
}

/**
 * alpha.102 — did the judge pass the positive control? Arm B (damaged) must
 * LOSE: wins-or-ties for the damaged arm ≤ 20% of evaluable cases.
 */
export function controlPassed(r: Pick<GoldenEvalRunResult, 'verdict' | 'wins' | 'ties' | 'losses'>): boolean {
  if (r.verdict === 'inconclusive') return false;
  const n = r.wins + r.ties + r.losses;
  if (n === 0) return false;
  return (r.wins + r.ties) / n <= 0.2;
}

/** Both re-wordings of v1. Dispatch keys on this, never on a string prefix,
 * so adding a fourth arm is one edit rather than a grep. */
export const ALT_STRATEGY_IDS: readonly GoldenEvalStrategyId[] = [
  'discipline-gates-v1-alt',
  'discipline-gates-v1-alt-blind',
];

export function isAltStrategy(id: GoldenEvalStrategyId | undefined): boolean {
  return id !== undefined && ALT_STRATEGY_IDS.includes(id);
}

export interface GoldenEvalOptions {
  appId: string;
  archetype: string;
  /**
   * Release B — comparison axis. Default 'model' (alpha.62 behavior,
   * unchanged). On 'strategy': arm A = the golden IR as stored (gates-off),
   * arm B = the same IR with a `discipline_contract` section appended
   * (gates-on), both replayed on ONE model (`strategyModel` or the resolved
   * incumbent). `candidateModel` is ignored on the strategy axis;
   * `strategy` is required.
   */
  axis?: GoldenEvalAxis;
  /** Required when axis==='strategy': the strategy under measurement. */
  strategy?: GoldenEvalStrategyId;
  /**
   * axis==='strategy' only: the model both arms run on. Default: the
   * resolved incumbent (most-captured model in the golden set).
   */
  strategyModel?: string;
  /** Required when axis is 'model' (the default). */
  candidateModel?: string;
  /**
   * Incumbent to compare against. Default: the most frequent incumbent_model
   * across the loaded golden set (the surface's de-facto leader).
   */
  incumbentModel?: string;
  /** Judge model id. Default `DEFAULT_JUDGE_MODEL` (judge chain tier 0). */
  judgeModel?: string;
  /** Max golden cases to load (newest first). Default 50. */
  limit?: number;
  /** The bar: the share of judged cases the candidate must be not worse on (wins + ties). Default 0.8. */
  winOrTieThreshold?: number;
  /** Latency hard floor: candidate p50 ≤ ratio × incumbent p50. Default 3. */
  latencyFloorRatio?: number;
  /** Minimum judged cases for a non-inconclusive verdict. Default 5. */
  minJudgeableCases?: number;
  /** What fired the eval. Default 'manual' (Stage 1). */
  triggerSource?: 'manual' | 'supply' | 'price' | 'demand' | 'fallback' | 'control';
  /** Brain access — direct PostgREST (operator convention). */
  supabaseUrl: string;
  serviceKey: string;
  /** Provider keys for the replay + judge calls. Default: process.env. */
  apiKeys?: ApiKeys;
  fetchImpl?: typeof fetch;
  /** Replay + judge but write NOTHING to the brain. */
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface GoldenEvalCase {
  goldenIrId: number;
  verdict: 'candidate-better' | 'tied' | 'current-better' | 'inconclusive';
  /**
   * Release B — the RAW order-swapped pair, in incumbent/candidate terms,
   * BEFORE `combineOrderSwappedVerdicts` folds disagreement into 'tied'.
   * The fold is public API and unchanged; this records what it discards,
   * because positional DISAGREEMENT RATE is an objective reliability metric
   * needing no ground truth (§4.0 — the strategy experiment's primary
   * metric is positional consistency, not judge quality).
   */
  orderVerdicts?: {
    run1: 'candidate-better' | 'current-better' | 'tied';
    run2: 'candidate-better' | 'current-better' | 'tied';
  };
  judgeRationale?: string;
  /** Hard-floor violations on the candidate side for this case. */
  floorViolations: Array<'empty' | 'schema' | 'candidate_error'>;
  errorClass?: string;
  incumbent?: { latencyMs: number; tokensIn: number; tokensOut: number; text: string };
  candidate?: { latencyMs: number; tokensIn: number; tokensOut: number; text: string };
  /** Case excluded from the denominator (incumbent replay/judge failed). */
  excludedReason?: string;
}

export interface GoldenEvalRunResult {
  verdict: 'promote-ready' | 'below-bar' | 'inconclusive';
  runId?: number;
  /**
   * Release B — which axis produced this verdict. Load-bearing, not
   * cosmetic: a results table that can't tell you which axis produced a
   * verdict is a false-attribution engine. On 'strategy',
   * incumbentModel === candidateModel (the model held constant) and
   * `strategy` names the arm-B mutation.
   */
  axis: GoldenEvalAxis;
  strategy?: GoldenEvalStrategyId;
  appId: string;
  archetype: string;
  incumbentModel: string;
  candidateModel: string;
  judgeModel: string;
  nCases: number;
  wins: number;
  ties: number;
  losses: number;
  floorViolations: number;
  floorDetail: Record<string, number>;
  winOrTieRatio: number | null;
  latencyRatio: number | null;
  costIncumbentUsd: number | null;
  costCandidateUsd: number | null;
  advisoryOutcomeId?: number;
  cases: GoldenEvalCase[];
  notes: string[];
}

interface GoldenIrRow {
  id: number;
  app_id: string;
  intent_archetype: string;
  ir: PromptIR;
  incumbent_model: string;
}

interface ReplayLeg {
  ok: boolean;
  text: string;
  structuredOutput: unknown;
  parseError?: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  errorClass?: string;
  /**
   * alpha.104 — how many tool calls the leg answered with. A surface that
   * answers THROUGH a tool (tt-intelligence's Ask delivers its analysis only
   * via `compose_analysis`) returns empty text by design; the harness
   * compares text, so such a case is not measurable here — it must read
   * `inconclusive`, never `current-better` on an "empty" floor.
   */
  toolCallCount: number;
  /**
   * Release B (strategy axis only) — did the discipline gates actually fire
   * on this leg's compile, and at what token tax. Feeds the hard
   * precondition guard: an arm-B compile where the gates silently no-op'd
   * makes arm A ≡ arm B, every case reads 'tied', and Factor B would record
   * "gates measured, no lift" on a tuple where the gates never ran — a
   * false write into shared state (brain-integrity class).
   */
  gates?: { fired: boolean; rule?: string; gateTokens: number };
  /**
   * Structured-output contract violation, judged by call()'s OWN production
   * validation (`validateStructuredContract`): truncation
   * (`max_tokens_on_structured_output` — the Flash-family cliff class) or
   * JSON parse failure. The first live run (s66, golden run #2) proved a raw
   * `execute()` never populates `structuredOutput` — floors that read it
   * directly convicted a candidate whose JSON was fine. Validation now runs
   * on BOTH legs so the comparison is symmetric.
   */
  contractViolation?: string;
}

/**
 * Retry backoff for a replay leg, by error class. Rate limits get a long
 * wait: provider quota windows are ~35–60s (observed live: google free-tier
 * `limit: 20 … retry in 47s`), so the generic 2s backoff can NEVER outlive
 * one — runs #6–#8 of the first trigger fire went inconclusive exactly this
 * way (every incumbent replay 429 → instant 429 again → case excluded).
 * The eval is an offline batch path; waiting a minute is free, a wasted
 * inconclusive run is not.
 */
export function replayRetryDelayMs(errorCode: string | undefined): number {
  return errorCode === 'rate_limit' ? 65_000 : 2_000;
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function costUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const profile = tryGetProfile(model);
  if (!profile) return null;
  return (
    (tokensIn / 1_000_000) * profile.costInputPer1m +
    (tokensOut / 1_000_000) * profile.costOutputPer1m
  );
}

/** djb2 — same irreversible grouping hash the inline probe uses. */
function hashForGolden(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return `g${h.toString(36)}`;
}

/**
 * Release B — the arm-B IR builder for the strategy axis: the golden IR with
 * a `discipline_contract` section appended. Empty text — the section exists
 * to make the translator prepend the frozen gate block; the measured
 * `disciplineGateTokens` then counts exactly the gate bytes.
 */
const STRATEGY_GATES_SECTION_ID = '__kgauto_strategy_eval_gates__';
export function withDisciplineContract(ir: PromptIR): PromptIR {
  return {
    ...ir,
    sections: [
      ...(ir.sections ?? []),
      { id: STRATEGY_GATES_SECTION_ID, kind: 'discipline_contract', text: '' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Release B §6 — the ALT wording (frozen; eval-only; loss-triggered)
// ─────────────────────────────────────────────────────────────────────────
//
// Re-expresses the SAME six principles as `discipline-gates-v1` in a
// deliberately divergent register: interrogative + self-addressed,
// compressed, bulleted. Frozen and versioned identically — the eval isn't
// reproducible against mutable bytes. LIMITATION, stated plainly and
// carried into every attribution: both wordings share one author, so a
// shared blind spot (the six principles being the wrong six) is invisible
// to the experiment. An independently-authored alt closes that; until one
// exists, only the both-lose and v1-loses/alt-wins verdicts are strong.
//
// Variant matrix mirrors v1's exactly: NO_TOOLS drops the compressed-item
// bullet (v1's gate 3); STRUCTURED drops the two shape-altering bullets
// (v1's gates 5+6) so the arm stays parser-safe on json/tool_call surfaces
// and stays comparable with `discipline-gates-v1-structured`.

export const DISCIPLINE_GATES_V1_ALT_HEADER =
  'Before stating any conclusion, run this check:';

const ALT_BULLETS = {
  observe: '- What did I actually observe? Quote it before reasoning from it.',
  extraSignal:
    '- This feels settled — what one adjacent signal have I not checked?',
  expand:
    '- Is anything here compressed or referenced? Open it; do not infer its contents.',
  innocent:
    '- What is the ordinary explanation? State it before any alarming one.',
  label:
    '- For each claim: is it observed, inferred, or assumed? Say which.',
  gap:
    '- What can I not determine from what I have? Name it rather than filling it in.',
} as const;

function altBlock(parts: Array<keyof typeof ALT_BULLETS>): string {
  return [DISCIPLINE_GATES_V1_ALT_HEADER, ...parts.map((p) => ALT_BULLETS[p])].join('\n');
}

export function altGatesBlockFor(args: {
  outputMode: 'text' | 'json' | 'tool_call';
  hasTools: boolean;
}): string {
  const shapeAltering: Array<keyof typeof ALT_BULLETS> =
    args.outputMode === 'text' ? ['label', 'gap'] : [];
  const expand: Array<keyof typeof ALT_BULLETS> = args.hasTools ? ['expand'] : [];
  return altBlock([
    'observe',
    'extraSignal',
    ...expand,
    'innocent',
    ...shapeAltering,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// The BLIND alt wording — the independently-authored arm the limitation
// above was waiting for (commissioned s81, delivered by cc 2026-07-29)
// ─────────────────────────────────────────────────────────────────────────
//
// PROVENANCE, because this arm is worthless without it. cc-Cairn was
// commissioned to author an independent alt and went one step stricter than
// asked: cc-Cairn shares kgauto-Cairn's SOUL lineage and discipline corpus,
// so cc routed authorship to a FRESH general-purpose subagent with zero repo
// access (0 tool calls), zero knowledge of kgauto/the portfolio/the
// experiment/who was asking, and an explicit instruction not to match any
// house style. cc did not edit the strings. The do-not-read list was honored:
// neither cc nor the subagent read `translator.ts`, the incumbent gate text,
// Release B §8, or any changelog describing the gates.
// Filing: `advisory/kgauto/from-command-center/2026-07-29_blind-alt-gate-strings.md`.
//
// THE STRINGS BELOW ARE VERBATIM. Do not fix the register, do not align the
// bullet style with v1, do not compress. Every edit re-contaminates the arm
// with this seat's prose and destroys the only thing it is for.
//
// It is FIVE gates, not six — the blind author worked from a functional spec
// of 5 numbered functions, so this arm is not a bullet-for-bullet mirror of
// v1 and was never meant to be. It tests the same MECHANISM (a pre-conclusion
// discipline block) under prose from a different mind.

// TOKEN BUDGET — MEASURED, AND IT BREACHES. cc's filing estimated ~240
// tokens via a 0.75 words/token conversion and reported "within budget"
// (ceiling 264 = incumbent 220 +20%), while explicitly inviting kgauto to
// re-verify on its own tokenizer at wiring time. Re-verified, and the
// estimate was optimistic: the real ratio on this prose is ~1.48 tok/word.
//
//   surface          blind   this seat's alt
//   text+tools        285          120
//   text, no tools    235          100
//   json+tools        232           83
//
// So the blind arm is OVER the stated ceiling on its widest surface and
// costs ~2.4x the other alt. That is a real confound and it is named here
// rather than fixed, because the only in-budget fix is compressing prose I
// am forbidden to touch — trimming it myself would re-contaminate the arm
// with this seat's editorial voice, which is the one thing the arm exists
// to exclude.
//
// It does NOT invalidate the experiment, for two reasons: `gateTokens` is
// already captured per replay, so the tax is measured rather than hidden;
// and the eval's floors are quality-based, with token cost reported
// alongside rather than folded into the verdict. But it does constrain
// READING the result: a blind-arm LOSS is not clean evidence of a wording
// failure, because the heavier block is a live alternative explanation. A
// blind-arm WIN is unaffected — winning while paying more tokens is a
// stronger result, not a weaker one.
export const ALT_BLIND_TOKEN_BUDGET_BREACH = {
  ceilingTokens: 264,
  measuredTokensTextWithTools: 285,
  note:
    'Blind arm exceeds the stated 264-token ceiling on text+tools (285) and ' +
    'costs ~2.4x the v1-alt arm. Not corrected: compressing it would require ' +
    'editing prose the arm depends on NOT having been edited by this seat. ' +
    'Read a blind-arm LOSS as confounded by token tax; a WIN is unaffected.',
} as const;

export const DISCIPLINE_GATES_V1_ALT_BLIND_HEADER =
  'Before stating any conclusion, run this check:';

const ALT_BLIND_BULLETS = {
  falsify:
    '- Before committing to an approach, state in one line what evidence would prove it wrong and how you would notice it. If nothing could falsify the approach, you hold a preference, not a plan — rework it until something could.',
  deviation:
    '- When you choose not to follow an applicable instruction, say so explicitly: name the instruction, why you are deviating, and what you are doing instead. Silent deviation is forbidden — an override is only legitimate when it is visible.',
  toolPredict:
    '- When using tools: before each call, state the result you expect. On mismatch, treat the gap as evidence your model of the system is wrong — revise the model before acting again; never silently retry.',
  verifyDelegated:
    '- Verify every delegated or sub-agent result before composing it into an answer: spot-check it against the source or an independent probe. An unverified sub-result is a claim you are repeating, not a fact you know.',
  markAssumed:
    '- In the final answer, keep verified claims and assumptions visibly distinct: mark anything unchecked as "assumed" or "unverified". Never let an assumption borrow the confidence of the verified claims beside it.',
} as const;

/**
 * The variant matrix — and this is the ONE place this seat's judgment enters
 * the blind arm, so it is stated rather than buried.
 *
 * cc's instruction: adapt MECHANICALLY where the injection format demands it,
 * note the diff, never edit semantics. Choosing which gates to drop per
 * surface is a selection, not an edit — the bytes of every retained gate are
 * untouched — but the selection is still mine, so:
 *
 *   NO TOOLS   drops `toolPredict`. Forced, not chosen: the string opens
 *              "When using tools" and is literally inapplicable without them.
 *              Mirrors v1 dropping its compressed-item bullet.
 *   STRUCTURED drops `markAssumed` ONLY. It is the sole gate whose entire
 *              function is text in the final answer ('mark anything unchecked
 *              as "assumed"'), which a JSON/tool_call schema has no field for
 *              and which would corrupt the parse.
 *
 * The judgment call worth flagging: v1 drops TWO bullets on structured
 * surfaces, and a stricter reading would also drop `falsify` ("state in one
 * line") and `deviation` ("say so explicitly"), since both demand output
 * text. I kept them. Their output demand is incidental (and conditional, for
 * `deviation`) while their primary effect is on reasoning before the answer
 * exists — whereas v1's dropped pair (`label`, `gap`) are purely
 * output-shaping. Dropping three of five would leave a two-gate arm that no
 * longer tests the same mechanism, and an arm crippled by my formatting
 * choice would read as a wording loss that was actually a scoping loss.
 * If the structured surface shows anomalous results, this is the first
 * thing to re-examine.
 */
export function altBlindGatesBlockFor(args: {
  outputMode: 'text' | 'json' | 'tool_call';
  hasTools: boolean;
}): string {
  const parts: Array<keyof typeof ALT_BLIND_BULLETS> = [
    'falsify',
    'deviation',
    ...(args.hasTools ? (['toolPredict'] as const) : []),
    'verifyDelegated',
    ...(args.outputMode === 'text' ? (['markAssumed'] as const) : []),
  ];
  return [
    DISCIPLINE_GATES_V1_ALT_BLIND_HEADER,
    ...parts.map((p) => ALT_BLIND_BULLETS[p]),
  ].join('\n');
}

const STRATEGY_ALT_SECTION_ID = '__kgauto_strategy_eval_gates_alt__';
const STRATEGY_ALT_BLIND_SECTION_ID = '__kgauto_strategy_eval_gates_alt_blind__';

/**
 * The alt arm injects its block DIRECTLY as an untagged section — it must
 * not carry `kind: 'discipline_contract'`, or the translator would prepend
 * the v1 bytes on top and the arm would measure both wordings at once. The
 * variant choice mirrors matchRule()'s exactly (same outputMode + hasTools
 * inputs), so the alt arm no-ops nowhere v1 fires and fires nowhere v1
 * no-ops — the attribution is about WORDING, and everything else is held.
 */
export function withAltDisciplineContract(ir: PromptIR): PromptIR {
  const outputMode = resolveOutputMode({
    declared: ir.constraints?.outputMode,
    structuredOutput: ir.constraints?.structuredOutput,
    toolCount: ir.tools?.length ?? 0,
  });
  const hasTools = (ir.tools?.length ?? 0) > 0;
  return {
    ...ir,
    sections: [
      ...(ir.sections ?? []),
      {
        id: STRATEGY_ALT_SECTION_ID,
        text: altGatesBlockFor({ outputMode, hasTools }),
      },
    ],
  };
}

/**
 * Same injection contract as `withAltDisciplineContract` — untagged section,
 * so the translator never prepends the v1 bytes on top and the arm measures
 * exactly one wording. Same variant inputs, so the blind arm no-ops nowhere
 * v1 fires and fires nowhere v1 no-ops; the comparison is about WORDING and
 * everything else is held.
 */
export function withAltBlindDisciplineContract(ir: PromptIR): PromptIR {
  const outputMode = resolveOutputMode({
    declared: ir.constraints?.outputMode,
    structuredOutput: ir.constraints?.structuredOutput,
    toolCount: ir.tools?.length ?? 0,
  });
  const hasTools = (ir.tools?.length ?? 0) > 0;
  return {
    ...ir,
    sections: [
      ...(ir.sections ?? []),
      {
        id: STRATEGY_ALT_BLIND_SECTION_ID,
        text: altBlindGatesBlockFor({ outputMode, hasTools }),
      },
    ],
  };
}

/** The section id each alt arm injects under — used by both the injector and
 * the fired-check, so the two can never disagree about what to look for. */
const ALT_SECTION_ID_BY_STRATEGY: Partial<Record<GoldenEvalStrategyId, string>> = {
  'discipline-gates-v1-alt': STRATEGY_ALT_SECTION_ID,
  'discipline-gates-v1-alt-blind': STRATEGY_ALT_BLIND_SECTION_ID,
};

export async function runGoldenEval(
  opts: GoldenEvalOptions,
): Promise<GoldenEvalRunResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const progress = opts.onProgress ?? (() => {});
  const limit = opts.limit ?? 50;
  const threshold = opts.winOrTieThreshold ?? 0.8;
  const latencyFloorRatio = opts.latencyFloorRatio ?? 3;
  const minJudgeable = opts.minJudgeableCases ?? 5;
  const judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const notes: string[] = [];

  // Release B — axis resolution + validation, before any spend.
  const axis: GoldenEvalAxis = opts.axis ?? 'model';
  const strategyId = opts.strategy;
  if (axis === 'strategy' && !strategyId) {
    throw new Error("golden-eval: axis 'strategy' requires opts.strategy.");
  }
  if (axis === 'model' && !opts.candidateModel) {
    throw new Error("golden-eval: axis 'model' requires opts.candidateModel.");
  }

  const restHeaders = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
  };
  const rest = (path: string): string => `${opts.supabaseUrl}/rest/v1/${path}`;

  // 1) Load the active golden set (newest first).
  const setUrl = rest(
    `kgauto_golden_irs?app_id=eq.${encodeURIComponent(opts.appId)}` +
      `&intent_archetype=eq.${encodeURIComponent(opts.archetype)}` +
      `&active=is.true&select=id,app_id,intent_archetype,ir,incumbent_model` +
      `&order=captured_at.desc&limit=${limit}`,
  );
  const setRes = await fetchFn(setUrl, { headers: restHeaders });
  if (!setRes.ok) {
    throw new Error(
      `golden-eval: failed to load golden set (${setRes.status}): ${await setRes
        .text()
        .catch(() => '<no body>')}`,
    );
  }
  const goldenRows = (await setRes.json()) as GoldenIrRow[];
  if (goldenRows.length === 0) {
    throw new Error(
      `golden-eval: no active golden IRs for (${opts.appId}, ${opts.archetype}) — ` +
        `seed via KGAUTO_GOLDEN_CAPTURE or scripts/seed-golden-set.mjs first.`,
    );
  }
  progress(`Loaded ${goldenRows.length} golden case(s).`);

  // 2) Resolve the incumbent (most frequent captured incumbent by default).
  // On the strategy axis `strategyModel` plays the same role: the one model
  // both arms run on, defaulting to the surface's de-facto leader.
  let incumbentModel =
    axis === 'strategy' ? opts.strategyModel : opts.incumbentModel;
  if (!incumbentModel) {
    const counts = new Map<string, number>();
    for (const row of goldenRows) {
      counts.set(row.incumbent_model, (counts.get(row.incumbent_model) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) throw new Error('golden-eval: could not resolve an incumbent from the golden set.');
    incumbentModel = top[0];
    notes.push(`incumbent defaulted to most-captured model: ${incumbentModel}`);
  }
  // Release B: on the strategy axis the "candidate" IS the incumbent model —
  // the arms differ by IR, not by model. The same-model throw applies only
  // to the model axis, where it still catches a real operator mistake.
  const candidateModel =
    axis === 'strategy' ? incumbentModel : opts.candidateModel!;
  if (axis === 'model' && incumbentModel === candidateModel) {
    throw new Error('golden-eval: candidate and incumbent are the same model.');
  }
  const judgeProfile = tryGetProfile(judgeModel);
  if (!judgeProfile) {
    throw new Error(`golden-eval: judge model '${judgeModel}' is not in the roster.`);
  }
  if (
    judgeProfile.family &&
    [incumbentModel, candidateModel].some(
      (m) => tryGetProfile(m)?.family === judgeProfile.family,
    )
  ) {
    // Same G4 concern as the inline probe's judge-self lock, softened to a
    // recorded warning here: the operator may knowingly accept it (pairwise +
    // order-swap blunts self-preference), but the run must self-report.
    notes.push(
      `WARNING: judge family (${judgeProfile.family}) overlaps a compared model — self-preference risk; consider --judge from another provider.`,
    );
  }

  // 3) Replay each case on both sides.
  //
  // Release B: on the strategy axis, arm B replays the SAME IR with a
  // discipline_contract section appended (armBIr), on the SAME model —
  // `captureGates` records whether the gates actually fired on that
  // compile, feeding the hard precondition guard below.
  const armBIr = (ir: PromptIR): PromptIR => {
    if (axis !== 'strategy') return ir;
    if (strategyId === CONTROL_STRATEGY_ID) return ir; // damage is applied to the OUTPUT, below
    if (strategyId === 'discipline-gates-v1-alt') return withAltDisciplineContract(ir);
    if (strategyId === 'discipline-gates-v1-alt-blind') return withAltBlindDisciplineContract(ir);
    return withDisciplineContract(ir);
  };
  const replay = async (
    ir: PromptIR,
    model: string,
    captureGates = false,
  ): Promise<ReplayLeg> => {
    let gates: ReplayLeg['gates'];
    try {
      const evalIr: PromptIR = {
        ...ir,
        models: [model],
        constraints: { ...(ir.constraints ?? {}), forceModel: model },
      };
      const compiled = compile(evalIr);
      if (captureGates) {
        if (strategyId === CONTROL_STRATEGY_ID) {
          // Filled in after the replay returns (the damage is on the output).
          gates = { fired: false, rule: CONTROL_STRATEGY_ID, gateTokens: 0 };
        } else if (isAltStrategy(strategyId)) {
          // An alt arm injects its bytes directly (untagged section — the
          // translator never touches it), so the compile diagnostics carry
          // no discipline rewrite. Fired = the alt block survived into the
          // section list; its token tax is counted on the same tokenizer
          // the v1 path uses.
          const altSectionId = ALT_SECTION_ID_BY_STRATEGY[strategyId!]!;
          const altSection = (evalIr.sections ?? []).find(
            (s) => s.id === altSectionId,
          );
          gates = {
            fired: altSection !== undefined && altSection.text.length > 0,
            rule: strategyId!,
            gateTokens: altSection ? countTokens(`${altSection.text}\n\n`) : 0,
          };
        } else {
          const gateRewrite = compiled.sectionRewritesApplied.find((rw) =>
            rw.rule.startsWith('discipline-gates-'),
          );
          gates = {
            fired:
              gateRewrite !== undefined &&
              compiled.diagnostics.disciplineGateTokens > 0,
            rule: gateRewrite?.rule,
            gateTokens: compiled.diagnostics.disciplineGateTokens,
          };
        }
      }
      const attempt = () =>
        execute(compiled.request, { apiKeys: opts.apiKeys, fetchImpl: opts.fetchImpl });

      let started = Date.now();
      let exec = await attempt();
      // One retry on RETRYABLE provider errors (5xx/429/timeout). A transient
      // blip is not evidence about the model — only a repeated failure is.
      // (First live run: 2 of 6 cases convicted on single google 5xxs.)
      // The timer restarts with the retry: measured latency is the SUCCESSFUL
      // attempt's, never the backoff + failed attempt (that would poison the
      // latency-floor comparison with retry overhead). Backoff is
      // class-aware: rate limits wait out the quota window (see
      // replayRetryDelayMs), everything else retries fast.
      if (!exec.ok && exec.errorType === 'retryable') {
        const delayMs = replayRetryDelayMs(exec.errorCode);
        await new Promise((r) => setTimeout(r, delayMs));
        started = Date.now();
        exec = await attempt();
      }
      const latencyMs = Date.now() - started;

      if (!exec.ok) {
        return {
          ok: false,
          text: '',
          structuredOutput: null,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs,
          errorClass: exec.errorCode,
          toolCallCount: 0,
          ...(gates ? { gates } : {}),
        };
      }

      // Structured-output contract — call()'s OWN production validation
      // (truncation check + JSON.parse into structuredOutput). Without this,
      // execute()-level structuredOutput stays null and the schema floor
      // fires on perfectly valid JSON (the s66 golden-run-#2 engine bug).
      const validated = _internal.validateStructuredContract(exec, evalIr);
      if (!validated.ok) {
        return {
          ok: true,
          text: exec.response.text,
          structuredOutput: null,
          tokensIn: exec.response.tokens.input,
          tokensOut: exec.response.tokens.output,
          latencyMs,
          contractViolation: validated.errorCode,
          toolCallCount: exec.response.toolCalls?.length ?? 0,
          ...(gates ? { gates } : {}),
        };
      }
      // alpha.102 — the positive control damages arm B's OUTPUT (same
      // model, same prompt), so the only difference the judge sees is the
      // damage. `gates.fired` records that the damage actually took: an
      // undamaged control arm would make A ≡ B, every case 'tied', and the
      // control would "fail" for the wrong reason (Release B's own guard).
      let text = validated.response.text;
      let structuredOutput = validated.response.structuredOutput;
      if (captureGates && strategyId === CONTROL_STRATEGY_ID) {
        const degraded = degradeControlArm(text);
        gates = {
          fired: controlDamageApplied(text, degraded),
          rule: CONTROL_STRATEGY_ID,
          gateTokens: 0,
        };
        text = degraded;
        structuredOutput = null;
      }
      return {
        ok: true,
        text,
        structuredOutput,
        parseError: validated.response.parseError,
        tokensIn: validated.response.tokens.input,
        tokensOut: validated.response.tokens.output,
        latencyMs,
        toolCallCount: validated.response.toolCalls?.length ?? 0,
        ...(gates ? { gates } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        text: '',
        structuredOutput: null,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        errorClass: err instanceof Error ? `execute_rejected:${err.message}` : 'execute_rejected',
        toolCallCount: 0,
        ...(gates ? { gates } : {}),
      };
    }
  };

  // Pairwise judge — one order. Never swallows: a failure comes back with
  // its cause. Through alpha.101 this returned `undefined` on every failure
  // path and the caller wrote one string for all of them — on 2026-09-01
  // the Tuesday fire excluded 21 of 29 cases as "judge failed" and the run
  // notes could not say whether that was a 429, a 400, a timeout or an
  // unparseable answer (s75 normalization trap, in the evaluator).
  const judgeOnce = async (
    ir: PromptIR,
    outputA: string,
    outputB: string,
  ): Promise<
    | { ok: true; winner: PairwiseWinner; rationale?: string }
    | { ok: false; reason: string }
  > => {
    const judgeIr: PromptIR = {
      appId: opts.appId,
      intent: { name: 'golden-eval-judge', archetype: 'judge' },
      sections: [
        {
          id: 'role',
          text: 'You are a strict, impartial pairwise judge. You output only JSON.',
          weight: 10,
        },
      ],
      currentTurn: {
        role: 'user',
        content: buildPairwiseJudgePrompt({
          archetype: opts.archetype,
          renderedInput: renderIrForJudge(ir),
          outputA,
          outputB,
        }),
      },
      models: [judgeModel],
      // alpha.70 — declare the judge's output shape truthfully. The role
      // section says "You output only JSON" and `parseJudgeVerdict` parses
      // exactly that, but nothing in the IR SAID so: no `structuredOutput`,
      // no tools ⇒ `resolveOutputMode` inferred 'text'. That made the judge
      // eligible for the alpha.68 shape-altering discipline gates — inside
      // the very engine Release B would use to measure those gates, where a
      // gate-induced parse failure would be attributed to the gates.
      //
      // Deliberately `outputMode`, NOT `structuredOutput: true`: the latter
      // would switch on kgauto's structured-output validation and change the
      // lowered wire contract (response_format), altering judge behaviour.
      // This declares the shape for screening purposes only — which is the
      // exact reason the alpha.69 hatch is a separate field.
      constraints: { forceModel: judgeModel, outputMode: 'json' },
    };
    try {
      const compiled = compile(judgeIr);
      const exec = await execute(compiled.request, {
        apiKeys: opts.apiKeys,
        fetchImpl: opts.fetchImpl,
      });
      if (!exec.ok) {
        return {
          ok: false,
          reason: `judge ${exec.errorType} ${exec.errorCode ?? 'unknown'} (HTTP ${exec.status}): ${String(exec.message ?? '').slice(0, 120)}`,
        };
      }
      const parsed = parseJudgeVerdict(exec.response.text);
      if (!parsed) {
        return {
          ok: false,
          reason: `judge answer unparseable (finish=${exec.response.finishReason ?? '?'}, ${exec.response.tokens?.output ?? '?'} out tokens): ${JSON.stringify(exec.response.text.slice(0, 80))}`,
        };
      }
      return { ok: true, ...parsed };
    } catch (err) {
      return { ok: false, reason: `judge threw: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
    }
  };

  const cases: GoldenEvalCase[] = [];
  const floorDetail: Record<string, number> = {};
  const bumpFloor = (k: string): void => {
    floorDetail[k] = (floorDetail[k] ?? 0) + 1;
  };

  for (const [i, row] of goldenRows.entries()) {
    // alpha.138 (R2, fix pass 4) — a captured IR whose messages carry
    // provider-native blocks (`parts`) was written for the provider of the model
    // it was captured on (`incumbent_model`); lowering passes them verbatim, so
    // a replay on another provider would send that provider blocks it does not
    // read. Such a case is excluded before any request (named, counted toward
    // attrition, as a failed arm-B replay is), never replayed across providers.
    if (_internal.irCarriesNativeParts(row.ir)) {
      const providerOf = (m: string): string | undefined => tryGetProfile(m)?.provider ?? inferProviderFromId(m);
      const written = providerOf(row.incumbent_model);
      const other = [incumbentModel, candidateModel].filter((m) => providerOf(m) !== written);
      if (other.length > 0) {
        const why = `the captured IR carries native parts written for ${written ?? 'an unknown provider'} (captured on ${row.incumbent_model}); not replayed on ${[...new Set(other)].join(', ')}, another provider`;
        cases.push({ goldenIrId: row.id, verdict: 'inconclusive', floorViolations: [], excludedReason: why });
        notes.push(`case #${row.id}: ${why} — excluded`);
        continue;
      }
    }
    progress(
      `Case ${i + 1}/${goldenRows.length} (golden #${row.id}): replaying ${incumbentModel} + ${candidateModel}…`,
    );
    const [inc, cand] = await Promise.all([
      replay(row.ir, incumbentModel),
      replay(armBIr(row.ir), candidateModel, axis === 'strategy'),
    ]);

    // ── Release B: the HARD precondition guard — the engine convicts itself
    // first. On the strategy axis, arm B's compile must show the gates
    // actually fired; a Factor-A/C screen silently no-oping makes arm A ≡
    // arm B, every case reads 'tied', and Factor B would record "gates
    // measured, no lift" on a tuple where the gates never ran — a false
    // write into shared state. ABORT the whole run: inconclusive,
    // 'gates-did-not-fire', NOTHING persisted. This is the single most
    // important branch in Release B (§5.3).
    // alpha.113 — the guard is about a compile that produced no rewrite, not
    // about a replay that never returned. When arm B's replay FAILED (or broke
    // its output contract) the damage/gates could not be applied to anything,
    // and `gates.fired` is false for that reason alone. Three fires on
    // 2026-09-15 aborted the positive control at three different cases
    // (#120, #62, #94) this way — 0 evals, 23 fallbacks quarantined, digest
    // said "judge failed". Exclude the case (named, counted toward attrition),
    // keep the run; abort only when a SUCCESSFUL arm-B replay shows no gate.
    if (axis === 'strategy' && !cand.gates?.fired && (!cand.ok || cand.contractViolation)) {
      const why = !cand.ok
        ? `arm B replay failed (${cand.errorClass ?? 'unknown'}) — the strategy/damage could not be applied`
        : `arm B contract violation (${cand.contractViolation}) — the strategy/damage could not be applied`;
      cases.push({
        goldenIrId: row.id,
        verdict: 'inconclusive',
        floorViolations: [],
        excludedReason: why,
      });
      notes.push(`case #${row.id}: ${why} — excluded`);
      continue;
    }
    if (axis === 'strategy' && !cand.gates?.fired) {
      notes.push(
        `ABORT gates-did-not-fire: arm B compile produced no discipline-gate ` +
          `rewrite (case golden #${row.id}; archetype=${opts.archetype}; ` +
          `gateTokens=${cand.gates?.gateTokens ?? 0}). No verdict written — ` +
          `a tied-because-identical run is not evidence about the strategy.`,
      );
      return {
        verdict: 'inconclusive',
        axis,
        strategy: strategyId,
        appId: opts.appId,
        archetype: opts.archetype,
        incumbentModel,
        candidateModel,
        judgeModel,
        nCases: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        floorViolations: 0,
        floorDetail: {},
        winOrTieRatio: null,
        latencyRatio: null,
        costIncumbentUsd: null,
        costCandidateUsd: null,
        cases,
        notes,
      };
    }

    if (!inc.ok || inc.contractViolation) {
      // The incumbent failing its own workload (persistent provider error OR
      // its own structured-output contract violation) is not evidence about
      // the candidate — exclude the case, but surface it loudly in notes.
      const why = !inc.ok
        ? `incumbent replay failed (${inc.errorClass ?? 'unknown'})`
        : `incumbent contract violation (${inc.contractViolation})`;
      cases.push({
        goldenIrId: row.id,
        verdict: 'inconclusive',
        floorViolations: [],
        excludedReason: why,
      });
      notes.push(`case #${row.id}: ${why} — excluded`);
      continue;
    }

    const incumbentLeg = {
      latencyMs: inc.latencyMs,
      tokensIn: inc.tokensIn,
      tokensOut: inc.tokensOut,
      text: inc.text,
    };

    // alpha.104 — a TOOL-ANSWERING surface is not measurable by a text judge.
    // tt-intelligence (2026-09-04) traced what the empty floor would have done
    // to their Ask IRs, which deliver the answer only via `compose_analysis`:
    // the replay compiles the IR, so the tools reach the candidate; it
    // answers the way the prompt forces it to — a tool call, empty text —
    // and the floor convicts it `empty` on every case. The incumbent leg has
    // no such check and passes. The run would then say "every fallback
    // regresses on tt-intelligence's ask surface" — a true measurement with
    // a false conclusion, attributed to the MODEL, through the highest-
    // authority channel the portfolio accepts. MAX_ATTRITION would not
    // catch it (the case FAILS rather than excludes). So: either leg
    // answering by tool call with no text → excluded, named, and it counts
    // toward attrition like any other exclusion.
    const toolAnswered = (leg: ReplayLeg) => leg.ok && leg.text.trim() === '' && leg.toolCallCount > 0;
    if (toolAnswered(inc) || toolAnswered(cand)) {
      const why =
        `tool-answering surface — the answer is a tool call (incumbent ${inc.toolCallCount}, ` +
        `candidate ${cand.toolCallCount}); this harness compares text and cannot score it`;
      cases.push({
        goldenIrId: row.id,
        verdict: 'inconclusive',
        floorViolations: [],
        incumbent: incumbentLeg,
        candidate: cand.ok
          ? { latencyMs: cand.latencyMs, tokensIn: cand.tokensIn, tokensOut: cand.tokensOut, text: cand.text }
          : undefined,
        excludedReason: why,
      });
      notes.push(`case #${row.id}: ${why} — excluded`);
      continue;
    }

    // Candidate hard floors (mechanical, pre-judge). Persistent provider
    // error (survived one retry) / empty output / structured-output contract
    // violation per call()'s own validation.
    const violations: Array<'empty' | 'schema' | 'candidate_error'> = [];
    if (!cand.ok) {
      violations.push('candidate_error');
      bumpFloor('candidate_error');
    } else if (cand.tokensOut === 0 || (cand.text.trim() === '' && !cand.structuredOutput)) {
      violations.push('empty');
      bumpFloor('empty');
    } else if (cand.contractViolation) {
      violations.push('schema');
      bumpFloor('schema');
    }
    if (violations.length > 0) {
      cases.push({
        goldenIrId: row.id,
        verdict: 'current-better',
        floorViolations: violations,
        errorClass: cand.errorClass ?? cand.contractViolation,
        incumbent: incumbentLeg,
        candidate: cand.ok
          ? { latencyMs: cand.latencyMs, tokensIn: cand.tokensIn, tokensOut: cand.tokensOut, text: cand.text }
          : undefined,
      });
      continue;
    }

    // Pairwise judge, both orders. Run 1: A=incumbent, B=candidate.
    // Run 2 swaps; its verdict is un-swapped back to incumbent/candidate terms.
    const [order1, order2] = await Promise.all([
      judgeOnce(row.ir, inc.text, cand.text),
      judgeOnce(row.ir, cand.text, inc.text),
    ]);
    if (!order1.ok || !order2.ok) {
      const why = [order1.ok ? null : `order1: ${order1.reason}`, order2.ok ? null : `order2: ${order2.reason}`]
        .filter(Boolean)
        .join(' | ');
      cases.push({
        goldenIrId: row.id,
        verdict: 'inconclusive',
        floorViolations: [],
        incumbent: incumbentLeg,
        candidate: { latencyMs: cand.latencyMs, tokensIn: cand.tokensIn, tokensOut: cand.tokensOut, text: cand.text },
        excludedReason: `judge failed — ${why}`,
      });
      notes.push(`case #${row.id}: judge failed — excluded — ${why}`);
      continue;
    }
    const v1 =
      order1.winner === 'tie' ? 'tied' : order1.winner === 'B' ? 'candidate-better' : 'current-better';
    const v2 =
      order2.winner === 'tie' ? 'tied' : order2.winner === 'A' ? 'candidate-better' : 'current-better';
    const verdict = combineOrderSwappedVerdicts(v1, v2);

    cases.push({
      goldenIrId: row.id,
      verdict,
      // Release B — the raw pair the fold discards; positional-disagreement
      // rate is the strategy experiment's primary metric.
      orderVerdicts: { run1: v1, run2: v2 },
      judgeRationale: order1.rationale ?? order2.rationale,
      floorViolations: [],
      incumbent: incumbentLeg,
      candidate: { latencyMs: cand.latencyMs, tokensIn: cand.tokensIn, tokensOut: cand.tokensOut, text: cand.text },
    });
  }

  // 4) Aggregate against the bar: not worse (win or tie) on N of M judged cases.
  const evaluable = cases.filter((c) => !c.excludedReason);
  const wins = evaluable.filter((c) => c.verdict === 'candidate-better').length;
  const ties = evaluable.filter((c) => c.verdict === 'tied').length;
  const losses = evaluable.filter((c) => c.verdict === 'current-better').length;
  const floorViolations = evaluable.reduce((n, c) => n + c.floorViolations.length, 0);
  const winOrTieRatio = evaluable.length > 0 ? (wins + ties) / evaluable.length : null;

  const incP50 = p50(evaluable.map((c) => c.incumbent?.latencyMs ?? NaN).filter(Number.isFinite));
  const candP50 = p50(evaluable.map((c) => c.candidate?.latencyMs ?? NaN).filter(Number.isFinite));
  const latencyRatio = incP50 && candP50 ? candP50 / incP50 : null;

  const sum = (xs: Array<number | null>): number | null =>
    xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0);
  const costIncumbentUsd = sum(
    evaluable.map((c) =>
      c.incumbent ? costUsd(incumbentModel, c.incumbent.tokensIn, c.incumbent.tokensOut) : null,
    ),
  );
  const costCandidateUsd = sum(
    evaluable.map((c) =>
      c.candidate
        ? costUsd(candidateModel, c.candidate.tokensIn, c.candidate.tokensOut)
        : null,
    ),
  );

  const latencyFloorOk = latencyRatio === null || latencyRatio <= latencyFloorRatio;
  if (!latencyFloorOk) bumpFloor('latency');

  // alpha.102 — attrition guard. A verdict computed over a MINORITY of the
  // golden set is not a verdict about the surface: run #21 (2026-09-01)
  // wrote a below-bar verdict on 7 of 20 cases after 13 judge exclusions with
  // no recorded cause. Same family as the s51 replay-fidelity rule — a
  // confident verdict from a truncated input is worse than no verdict.
  const attrition = goldenRows.length > 0 ? 1 - evaluable.length / goldenRows.length : 0;
  const attritionTooHigh = attrition > MAX_ATTRITION;

  let verdict: GoldenEvalRunResult['verdict'];
  if (evaluable.length < minJudgeable) {
    verdict = 'inconclusive';
    notes.push(
      `only ${evaluable.length} evaluable case(s) < minJudgeableCases=${minJudgeable}`,
    );
  } else if (attritionTooHigh) {
    verdict = 'inconclusive';
    notes.push(
      `ATTRITION ${Math.round(attrition * 100)}%: ${goldenRows.length - evaluable.length} of ${goldenRows.length} cases excluded — above MAX_ATTRITION=${MAX_ATTRITION}; a verdict over a minority of the set is not a verdict (alpha.102)`,
    );
  } else if (
    winOrTieRatio !== null &&
    winOrTieRatio >= threshold &&
    floorViolations === 0 &&
    latencyFloorOk
  ) {
    verdict = 'promote-ready';
  } else {
    verdict = 'below-bar';
  }

  const result: GoldenEvalRunResult = {
    verdict,
    axis,
    ...(strategyId ? { strategy: strategyId } : {}),
    appId: opts.appId,
    archetype: opts.archetype,
    incumbentModel,
    candidateModel,
    judgeModel,
    nCases: evaluable.length,
    wins,
    ties,
    losses,
    floorViolations: floorViolations + (latencyFloorOk ? 0 : 1),
    floorDetail,
    winOrTieRatio,
    latencyRatio,
    costIncumbentUsd,
    costCandidateUsd,
    cases,
    notes,
  };

  if (opts.dryRun) {
    notes.push('dry-run: no brain rows written');
    return result;
  }

  // 5) Persist evidence: run row → per-case probe rows → evidence advisory.
  progress('Writing eval evidence to the brain…');
  const runRes = await fetchFn(rest('kgauto_golden_eval_runs'), {
    method: 'POST',
    headers: {
      ...restHeaders,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      app_id: opts.appId,
      intent_archetype: opts.archetype,
      // Release B (migration 048) — a run row that can't say which axis
      // produced its verdict is a false-attribution engine.
      axis,
      strategy: strategyId ?? null,
      incumbent_model: incumbentModel,
      candidate_model: candidateModel,
      trigger_source: opts.triggerSource ?? 'manual',
      judge_model: judgeModel,
      n_cases: result.nCases,
      wins,
      ties,
      losses,
      floor_violations: result.floorViolations,
      floor_detail: floorDetail,
      win_or_tie_ratio: winOrTieRatio,
      latency_ratio: latencyRatio,
      // alpha.67 (migration 041) — persist the cost basis the verdict was
      // computed against. The Stage-2 materiality gate needs the ABSOLUTE
      // projected saving, and the reconcile path rebuilds its plan from this
      // row alone; an unpersisted in-memory number is invisible to it.
      cost_incumbent_usd: costIncumbentUsd,
      cost_candidate_usd: costCandidateUsd,
      verdict,
      win_or_tie_threshold: threshold,
      notes: notes.join(' | ') || null,
    }),
  });
  if (!runRes.ok) {
    throw new Error(
      `golden-eval: run-row write failed (${runRes.status}): ${await runRes
        .text()
        .catch(() => '<no body>')}`,
    );
  }
  const runRows = (await runRes.json()) as Array<{ id: number }>;
  result.runId = runRows[0]?.id;

  const caseRows = cases
    .filter((c) => !c.excludedReason)
    .map((c) => {
      const row = goldenRows.find((g) => g.id === c.goldenIrId);
      const turn =
        typeof row?.ir.currentTurn?.content === 'string' ? row.ir.currentTurn.content : '';
      return {
        app_id: opts.appId,
        intent_archetype: opts.archetype,
        family: tryGetProfile(candidateModel)?.family ?? 'unknown',
        candidate_model: candidateModel,
        current_model: incumbentModel,
        prompt_hash: hashForGolden(turn),
        current_response: c.incumbent?.text.slice(0, 500) ?? null,
        candidate_response: c.candidate?.text.slice(0, 500) ?? null,
        judge_verdict: c.floorViolations.length > 0 ? null : c.verdict,
        judge_rationale:
          c.floorViolations.length > 0
            ? `hard-floor violation: ${c.floorViolations.join(',')}`
            : c.judgeRationale ?? null,
        judge_model: judgeModel,
        tokens_current_in: c.incumbent?.tokensIn ?? null,
        tokens_current_out: c.incumbent?.tokensOut ?? null,
        tokens_candidate_in: c.candidate?.tokensIn ?? null,
        tokens_candidate_out: c.candidate?.tokensOut ?? null,
        latency_current_ms: c.incumbent?.latencyMs ?? null,
        latency_candidate_ms: c.candidate?.latencyMs ?? null,
        prompt_fidelity: 1.0,
        replay_source: 'golden-replay',
        outcome: c.floorViolations.includes('candidate_error') ? 'candidate_error' : 'completed',
        // migration-032 taxonomy: error_class only on candidate_error rows;
        // schema-floor detail rides in judge_rationale + the run's floor_detail.
        error_class: c.floorViolations.includes('candidate_error')
          ? (c.errorClass ?? null)
          : null,
        golden_run_id: result.runId ?? null,
        golden_ir_id: c.goldenIrId,
      };
    });
  if (caseRows.length > 0) {
    const casesRes = await fetchFn(rest('probe_outcomes'), {
      method: 'POST',
      headers: { ...restHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(caseRows),
    });
    if (!casesRes.ok) {
      notes.push(
        `case-row write failed (${casesRes.status}): ${await casesRes.text().catch(() => '<no body>')}`,
      );
    }
  }

  // alpha.78 (PB Finding 2, second half) — a verdict over ZERO judged cases
  // is a non-event wearing the costume of a result: run #9 (INCONCLUSIVE,
  // 0W/0T/0L — every candidate replay died on provider quota) re-fired as a
  // daily advisory for 8 days, observationCount ticking up on nothing. The
  // RUN row stays (an honest inconclusive is a true record, s67 rule); the
  // ADVISORY is what must not exist, because the advisory surface is for
  // things a consumer can act on and there is nothing here to act on.
  if (wins + ties + losses === 0) {
    notes.push(
      'zero cases judged — run row persisted, evidence advisory deliberately NOT written (a verdict on n=0 is not evidence)',
    );
    return result;
  }

  // Evidence advisory (Stage 1 delivery surface) — attach to the app's latest
  // compile_outcomes row (the view requires a real outcome_id, same constraint
  // promote-model.mjs works under).
  const latestRes = await fetchFn(
    rest(
      `compile_outcomes?app_id=eq.${encodeURIComponent(opts.appId)}` +
        `&select=id&order=id.desc&limit=1`,
    ),
    { headers: restHeaders },
  );
  const latest = latestRes.ok
    ? ((await latestRes.json()) as Array<{ id: number }>)
    : [];
  const latestOutcomeId = latest[0]?.id;
  if (latestOutcomeId !== undefined) {
    const costLine =
      costIncumbentUsd !== null && costCandidateUsd !== null
        ? ` Eval cost basis: incumbent $${costIncumbentUsd.toFixed(4)} vs candidate $${costCandidateUsd.toFixed(4)} across the set.`
        : '';
    const message =
      `Golden-set eval (run #${result.runId}): ${candidateModel} vs ${incumbentModel} ` +
      `on ${opts.appId}/${opts.archetype} — verdict ${verdict.toUpperCase()}. ` +
      `${notWorseOn(wins, ties, losses)} ` +
      `(${wins}W/${ties}T/${losses}L; the bar is ≥ ${(100 * threshold).toFixed(0)} %), ` +
      `${result.floorViolations} hard-floor violation(s), latency ratio ${latencyRatio?.toFixed(2) ?? 'n/a'}.` +
      costLine;
    const suggestion =
      verdict === 'promote-ready'
        ? `Cleared the bar: ${notWorseOn(wins, ties, losses)}. To promote: node v2/scripts/promote-model.mjs --model ${candidateModel} (or ask kgauto-Cairn). Evidence: kgauto_golden_eval_runs #${result.runId} + probe_outcomes golden_run_id=${result.runId}.`
        : `Did not clear the bar: ${notWorseOn(wins, ties, losses)}; the incumbent stays — no action needed. Evidence rows: golden_run_id=${result.runId}.`;
    const advRes = await fetchFn(rest('compile_outcome_advisories'), {
      method: 'POST',
      headers: { ...restHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        outcome_id: latestOutcomeId,
        code: 'golden-eval-verdict',
        level: 'info',
        recommendation_type: 'model-swap',
        message,
        suggestion,
      }),
    });
    if (advRes.ok) {
      result.advisoryOutcomeId = latestOutcomeId;
      await fetchFn(rest(`kgauto_golden_eval_runs?id=eq.${result.runId}`), {
        method: 'PATCH',
        headers: { ...restHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ advisory_outcome_id: latestOutcomeId }),
      }).catch(() => {});
    } else {
      notes.push(`advisory write failed (${advRes.status})`);
    }
  } else {
    notes.push('no compile_outcomes row for app — evidence advisory skipped (view needs a real outcome_id)');
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Release B §6 — attribution: wording failure vs mechanism failure
// ─────────────────────────────────────────────────────────────────────────

/**
 * Aggregate outcome of one strategy run, in gates-on terms. 'loses' is the
 * only branch that costs a third replay — and the only one where wording
 * attribution matters.
 */
export type StrategyOutcome = 'wins' | 'ties' | 'loses' | 'inconclusive';

export function classifyStrategyOutcome(r: GoldenEvalRunResult): StrategyOutcome {
  if (r.verdict === 'inconclusive') return 'inconclusive';
  if (r.wins > r.losses) return 'wins';
  if (r.losses > r.wins) return 'loses';
  return 'ties';
}

/**
 * The §6 attribution matrix. The load-bearing distinction: a WORDING failure
 * recorded as a mechanism failure would let Factor B permanently disable a
 * real capability on evidence about one author's prose.
 *
 * THREE arms since 2026-07-29. Both re-wordings run on a v1 loss, and a win
 * by EITHER is enough to acquit the mechanism — the question "does some
 * wording of this work?" is answered by one existence proof, so there is no
 * reason to require agreement between the alts.
 *
 *   v1 vs off | alt / alt-blind vs off | attribution
 *   ----------+------------------------+------------------------------------
 *   wins      | (not run)              | mechanism-works — ship
 *   ties      | (not run)              | no-lift — inconclusive at n, re-eval
 *   loses     | either wins            | wording-failure — do NOT disable
 *   loses     | BOTH lose              | mechanism-failure — Factor B may disable
 *   loses     | neither wins, not both lose | wording-inconclusive — no disable
 *
 * The `mechanism-failure` cell is the one that changed character. It used to
 * rest on two wordings by one author, so a shared blind spot (the principles
 * being the wrong principles) was invisible and the verdict was hedged. The
 * blind arm was authored by a context-free subagent with no knowledge of this
 * repo, the experiment, or who was asking — so a both-lose verdict now spans
 * independent authorship and is strong on its own terms. That is exactly the
 * gap `STRATEGY_AUTHORSHIP_LIMITATION` was written to confess, which is why
 * the limitation text is now conditional on whether the blind arm ran.
 */
export type StrategyAttribution =
  | 'mechanism-works'
  | 'no-lift'
  | 'wording-failure'
  | 'mechanism-failure'
  | 'wording-inconclusive'
  | 'inconclusive';

export interface StrategyAttributionResult {
  attribution: StrategyAttribution;
  primary: GoldenEvalRunResult;
  /** Present ONLY when the primary lost (the loss-triggered arms). */
  alt?: GoldenEvalRunResult;
  /** The independently-authored arm. Present ONLY when the primary lost. */
  altBlind?: GoldenEvalRunResult;
  /** The authorship limitation, restated on every result so no downstream
   * reader can cite an attribution without it. Which string this carries
   * depends on whether the blind arm actually ran — see below. */
  limitation: string;
}

/**
 * Carried when the blind arm did NOT run — i.e. v1 won or tied, so no
 * re-wording was measured at all and any claim about wording is unevidenced.
 */
export const STRATEGY_AUTHORSHIP_LIMITATION =
  'Only the v1 wording was measured on this run; no re-wording arm was ' +
  'triggered, so this result says nothing about whether the wording or the ' +
  'mechanism produced it.';

/**
 * Carried when both re-wording arms ran. The shared-author caveat is GONE by
 * construction, and saying so is the point: the previous version of this
 * string confessed a gap that has since been closed, and a stale confession
 * is its own kind of false statement — a reader would discount a verdict
 * that no longer deserves discounting.
 */
export const STRATEGY_AUTHORSHIP_INDEPENDENT =
  'Three arms: v1 and one re-wording by this seat, plus an independently ' +
  'authored arm (context-free subagent, no repo access, no knowledge of the ' +
  'experiment). A both-lose verdict therefore spans independent authorship ' +
  'and is not explained by one author\'s blind spot. Residual limitation: ' +
  'all three arms encode a similar set of underlying principles, so a wrong ' +
  'CHOICE of principles remains harder to see than a wrong wording of them.';

/**
 * Run the strategy eval with loss-triggered wording attribution: v1 first;
 * the alt arm replays ONLY on a v1 loss (mirrors the engine's retry
 * posture — don't pay for extra evidence until a result demands it).
 */
export async function runStrategyEvalWithAttribution(
  opts: Omit<GoldenEvalOptions, 'axis' | 'strategy' | 'candidateModel'>,
): Promise<StrategyAttributionResult> {
  const primary = await runGoldenEval({
    ...opts,
    axis: 'strategy',
    strategy: 'discipline-gates-v1',
  });
  const outcome = classifyStrategyOutcome(primary);

  if (outcome !== 'loses') {
    const attribution: StrategyAttribution =
      outcome === 'wins'
        ? 'mechanism-works'
        : outcome === 'ties'
          ? 'no-lift'
          : 'inconclusive';
    return { attribution, primary, limitation: STRATEGY_AUTHORSHIP_LIMITATION };
  }

  // Both re-wordings, sequentially — the same loss-triggered posture, now
  // paying for the arm that makes a both-lose verdict mean something.
  const alt = await runGoldenEval({
    ...opts,
    axis: 'strategy',
    strategy: 'discipline-gates-v1-alt',
  });
  const altBlind = await runGoldenEval({
    ...opts,
    axis: 'strategy',
    strategy: 'discipline-gates-v1-alt-blind',
  });

  const outcomes = [classifyStrategyOutcome(alt), classifyStrategyOutcome(altBlind)];
  // One existence proof acquits the mechanism: the question is whether SOME
  // wording works, so the alts need not agree.
  const attribution: StrategyAttribution =
    outcomes.includes('wins')
      ? 'wording-failure'
      : outcomes.every((o) => o === 'loses')
        ? 'mechanism-failure'
        : 'wording-inconclusive';

  return {
    attribution,
    primary,
    alt,
    altBlind,
    limitation: STRATEGY_AUTHORSHIP_INDEPENDENT,
  };
}
