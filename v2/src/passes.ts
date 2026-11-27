/**
 * Compiler passes — each pass is a pure function that transforms IR or
 * derived state. Passes are composed in compile() in a fixed order.
 *
 * The contract: passes don't mutate input. They return new IR (or the same
 * object if nothing changed). They emit zero-or-more MutationApplied entries
 * describing what they did.
 */

import type {
  Constraints,
  MutationApplied,
  PromptIR,
  PromptSection,
  ToolDefinition,
  Message,
} from './ir.js';
import type { ArchetypeConvention, CliffRule, ModelProfile } from './profiles.js';
import { priceAtInput } from './profiles.js';
import { deriveFamilyFromModelId } from './family-resolution.js';
import {
  tryGetProfile,
  latencyTierOf,
  LATENCY_TIER_MS,
  deriveCliffEvidenceClass,
  inputModalityMiss,
  requiredInputModalities,
} from './profiles.js';
import { canonicalPolicySet, policySetHas } from './policy-match.js';
import { countTokens, countToolTokens, countMessagesTokens } from './tokenizer.js';
import {
  bucketContext,
  bucketHistory,
  bucketToolCount,
  resolveOutputMode,
  type ShapeSignature,
} from './dialect.js';

// ─────────────────────────────────────────────────────────────────────────
// PASS 1: SLICE — drop sections not tagged for the current intent
// ─────────────────────────────────────────────────────────────────────────

export interface PassResult<T> {
  value: T;
  mutations: MutationApplied[];
}

export function passSlice(ir: PromptIR): PassResult<PromptIR> {
  const intent = ir.intent.archetype;
  const before = ir.sections.length;
  const kept = ir.sections.filter((s) => !s.intents || s.intents.length === 0 || s.intents.includes(intent));
  const dropped = before - kept.length;

  if (dropped === 0) return { value: ir, mutations: [] };

  return {
    value: { ...ir, sections: kept },
    mutations: [
      {
        id: `slice-${dropped}`,
        source: 'static_pass',
        passName: 'slice',
        description: `Dropped ${dropped} of ${before} sections not tagged for intent=${intent}`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 2: DEDUPE — collapse sections whose text is identical (by hash)
// ─────────────────────────────────────────────────────────────────────────

export function passDedupe(ir: PromptIR): PassResult<PromptIR> {
  const seen = new Map<string, PromptSection>();
  const order: string[] = [];
  for (const s of ir.sections) {
    const key = simpleHash(s.text.trim());
    if (!seen.has(key)) {
      seen.set(key, s);
      order.push(key);
    }
  }
  const deduped = order.map((k) => seen.get(k)!);
  const dropped = ir.sections.length - deduped.length;

  if (dropped === 0) return { value: ir, mutations: [] };

  return {
    value: { ...ir, sections: deduped },
    mutations: [
      {
        id: `dedupe-${dropped}`,
        source: 'static_pass',
        passName: 'dedupe',
        description: `Removed ${dropped} duplicate section(s) (by text hash)`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 3: TOOL-RELEVANCE — drop tools below relevance threshold for intent
// ─────────────────────────────────────────────────────────────────────────

export interface ToolRelevanceOptions {
  /** Relevance below this is dropped. Default 0.2. */
  threshold?: number;
  /** Hard cap on tools kept (independent of profile.maxTools cliff). */
  maxKeep?: number;
}

export function passToolRelevance(
  ir: PromptIR,
  opts: ToolRelevanceOptions = {},
): PassResult<PromptIR> {
  if (!ir.tools || ir.tools.length === 0) return { value: ir, mutations: [] };
  const threshold = opts.threshold ?? 0.2;
  const intent = ir.intent.archetype;

  // Score each tool by intent relevance.
  const scored = ir.tools.map((t) => {
    const score = t.relevanceByIntent?.[intent] ?? 0.5; // neutral default
    return { tool: t, score };
  });

  // Keep tools above threshold; sort by score desc.
  const kept = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.tool);

  const limited = opts.maxKeep ? kept.slice(0, opts.maxKeep) : kept;
  const dropped = ir.tools.length - limited.length;

  if (dropped === 0) return { value: ir, mutations: [] };

  return {
    value: { ...ir, tools: limited },
    mutations: [
      {
        id: `tool-relevance-${dropped}`,
        source: 'static_pass',
        passName: 'tool_relevance',
        description: `Dropped ${dropped} of ${ir.tools.length} tools below relevance ${threshold} for intent=${intent}`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 4: COMPRESS-HISTORY — summarize old turns
// ─────────────────────────────────────────────────────────────────────────

export interface CompressHistoryOptions {
  /** Keep at least this many recent turns verbatim. Default 4. */
  keepRecent?: number;
  /** If older than this many turns, summarize. Default 8. */
  summarizeOlderThan?: number;
  /**
   * Token-aware threshold (alpha.7). If total history tokens exceed this AND
   * `history.length > keepRecent`, fire compression — even when
   * `history.length <= summarizeOlderThan`. Default undefined (disabled).
   *
   * Why: count-based threshold misses fat-message bloat. Tool-using agents
   * (e.g. AI-SDK `stepCountIs(N)`) pack N tool-call/tool-result pairs into a
   * single assistant message. 3 messages can be 200K tokens. tt-intel Hunter
   * surfaced this at brain row #477 (208K input on history.length=2). Filed
   * as `byte-aware-passCompressHistory` in interfaces/kgauto.md.
   */
  summarizeAboveTokens?: number;
}

/** Sum tokens across history messages using the active tokenizer. */
function totalHistoryTokens(history: Message[]): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === 'string') total += countTokens(m.content);
  }
  return total;
}

/**
 * alpha.120 — a neutral tool result (`role: 'tool'`, no `parts`) whose
 * `toolCallId` matches no call anywhere in the conversation. Matching reads
 * the neutral `toolCalls` of every assistant message AND, so a native
 * exchange is never mistaken for an orphan, any `parts` that mention the id.
 */
export interface OrphanToolResult {
  /** `history[n]` index, or `'currentTurn'`. */
  at: number | 'currentTurn';
  toolCallId: string;
}

function findOrphanToolResults(ir: PromptIR): OrphanToolResult[] {
  const history = ir.history ?? [];
  const turns = ir.currentTurn ? [...history, ir.currentTurn] : history;
  const callIds = new Set<string>();
  const nativeParts: string[] = [];
  for (const m of turns) {
    if (m.role !== 'assistant') continue;
    if (m.parts != null) nativeParts.push(JSON.stringify(m.parts));
    else for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
  }
  const orphans: OrphanToolResult[] = [];
  turns.forEach((m, i) => {
    if (m.role !== 'tool' || m.parts != null || typeof m.toolCallId !== 'string') return;
    if (callIds.has(m.toolCallId)) return;
    const quoted = JSON.stringify(m.toolCallId);
    if (nativeParts.some((p) => p.includes(quoted))) return;
    orphans.push({ at: i < history.length ? i : 'currentTurn', toolCallId: m.toolCallId });
  });
  return orphans;
}

/**
 * alpha.120 — move a cut index so it never separates an assistant message's
 * neutral `toolCalls` from the `role: 'tool'` messages that answer them. A
 * group is [the call message … its last answering result]; a cut strictly
 * inside a group moves to the group's start, so the group is wholly KEPT
 * (never wholly summarised against `keepRecent`, which is a floor: "keep at
 * least this many recent turns"). Repeats until no group straddles the cut.
 *
 * alpha.122 — a group STARTS at the user turn that asked for the call, when
 * that turn sits directly before the assistant tool-call turn (a plain
 * `user` message: no `parts`, no `toolCallId`). Gemini rejects a history
 * whose first content is a `model` turn carrying a `functionCall` — HTTP 400
 * "Please ensure that function call turn comes immediately after a user turn
 * or after a function response turn" (smoke-tool-turns T3b, 2026-10-06) —
 * and the compression summary could not stand in for that user turn on
 * Gemini (it was a `role: 'system'` history turn, which lowerGoogle drops;
 * since alpha.123 it rides inside the first kept user turn — this one, when
 * the group is the first thing kept). Kept with its question, the call is
 * legal on every wire.
 */
export function toolGroupSafeCut(history: Message[], cut: number): number {
  const groups: Array<[number, number]> = [];
  history.forEach((m, callAt) => {
    if (m.role !== 'assistant' || m.parts != null || !m.toolCalls || m.toolCalls.length === 0) return;
    const ids = new Set(m.toolCalls.map((tc) => tc.id));
    let end = callAt;
    for (let j = callAt + 1; j < history.length; j++) {
      const r = history[j]!;
      if (r.role === 'tool' && r.parts == null && typeof r.toolCallId === 'string' && ids.has(r.toolCallId)) end = j;
    }
    if (end === callAt) return;
    const asked = history[callAt - 1];
    const start =
      asked && asked.role === 'user' && asked.parts == null && asked.toolCallId === undefined ? callAt - 1 : callAt;
    groups.push([start, end]);
  });
  let moved = cut;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [start, end] of groups) {
      if (start < moved && moved <= end) {
        moved = start;
        changed = true;
      }
    }
  }
  return moved;
}

/**
 * alpha.123 — put the compression summary at the head of a kept user turn.
 *   - string content: `summary + '\n\n' + content` (the summary alone when
 *     the turn's text is empty);
 *   - `parts` content (provider-native, passed to the wire verbatim): a text
 *     part is added in the shape the turn's own parts use — `{ type: 'text',
 *     text }` when they carry a `type` (Anthropic / OpenAI-family), `{ text }`
 *     otherwise (Gemini) — at the front, except that it goes AFTER any leading
 *     native tool-result parts (Anthropic: "the tool_result blocks must come
 *     FIRST in the content array"). The turn keeps every part it had.
 */
function withLeadingSummary(m: Message, summaryText: string): Message {
  if (!Array.isArray(m.parts)) {
    return { ...m, content: m.content === '' ? summaryText : `${summaryText}\n\n${m.content}` };
  }
  const parts = m.parts as unknown[];
  const isObj = (p: unknown): p is Record<string, unknown> => typeof p === 'object' && p !== null;
  const typed = parts.some((p) => isObj(p) && typeof p.type === 'string');
  const textPart = typed ? { type: 'text', text: summaryText } : { text: summaryText };
  let at = 0;
  while (at < parts.length) {
    const p = parts[at];
    if (!isObj(p) || !(p.type === 'tool_result' || 'functionResponse' in p)) break;
    at++;
  }
  return { ...m, parts: [...parts.slice(0, at), textPart, ...parts.slice(at)] };
}

/**
 * passCompressHistory — extends PassResult with `historyTokensTotal` so
 * compile() can surface it in CompileResult.diagnostics regardless of whether
 * compression actually fired (alpha.7).
 *
 * alpha.120 — also returns `orphanToolResults` (compile() turns them into a
 * `warn` advisory, code `orphan-tool-result`). Computed whether or not
 * compression fires: an orphan is a defect in the conversation, not in the
 * compression.
 */
export function passCompressHistory(
  ir: PromptIR,
  opts: CompressHistoryOptions = {},
): PassResult<PromptIR> & { historyTokensTotal: number; orphanToolResults: OrphanToolResult[]; folded: number } {
  const orphanToolResults = findOrphanToolResults(ir);
  const r = compressHistoryCore(ir, opts, orphanToolResults);
  // alpha.132 (R4) — how many `history` messages the fold removed into its
  // summary (0 when it did not fire, or replaced a fat message in place).
  return { ...r, orphanToolResults, folded: r.folded ?? 0 };
}

function compressHistoryCore(
  ir: PromptIR,
  opts: CompressHistoryOptions,
  orphanToolResults: OrphanToolResult[],
): PassResult<PromptIR> & { historyTokensTotal: number; folded?: number } {
  const history = ir.history;
  if (!history || history.length === 0) {
    return { value: ir, mutations: [], historyTokensTotal: 0 };
  }
  const keepRecent = opts.keepRecent ?? 4;
  const summarizeOlderThan = opts.summarizeOlderThan ?? 8;
  const summarizeAboveTokens = opts.summarizeAboveTokens;

  const historyTokensTotal = totalHistoryTokens(history);

  // Trigger compression when EITHER threshold fires:
  //   1. count > summarizeOlderThan  (cross-message slice path)
  //   2. tokens > summarizeAboveTokens  (byte-aware path; alpha.7+)
  //
  // alpha.15 (TT-41 follow-up): the alpha.7 token path used to require
  // `history.length > keepRecent` as a precondition. That defeated the
  // original spec — AI-SDK-v6's stepCountIs(N) shape collapses many tool
  // steps into ONE fat assistant message, so turn-2 of a multi-step
  // conversation can be 250K tokens at history.length=3. With keepRecent=4
  // the old gate blocked compression exactly when it mattered most.
  //
  // New behavior: detect the threshold without the count gate; then pick
  // the right strategy per shape:
  //   - history.length > keepRecent  →  slice old turns into a summary (as before)
  //   - history.length <= keepRecent  →  summarize the single dominant
  //                                       fat message in place
  const countThresholdHit = history.length > summarizeOlderThan;
  const tokenThresholdHit =
    summarizeAboveTokens !== undefined && historyTokensTotal > summarizeAboveTokens;

  if (!countThresholdHit && !tokenThresholdHit) {
    return { value: ir, mutations: [], historyTokensTotal };
  }

  // ── Branch A: cross-message slice ──
  // Enough messages to safely slice off the front while keeping `keepRecent`.
  // alpha.120 — the cut never splits a tool call from its result (see
  // `toolGroupSafeCut`); an orphan tool result in the old slice is kept
  // verbatim, not folded into the summary.
  const cutIndex = history.length > keepRecent ? toolGroupSafeCut(history, history.length - keepRecent) : 0;
  const orphanIdx = new Set(orphanToolResults.map((o) => o.at));
  const foldable = history.slice(0, cutIndex).filter((_, i) => !orphanIdx.has(i));
  if (history.length > keepRecent && foldable.length > 0) {
    const old = foldable;
    const keptOrphans = history.slice(0, cutIndex).filter((_, i) => orphanIdx.has(i));
    const recent = [...keptOrphans, ...history.slice(cutIndex)];
    const userTurns = old.filter((m) => m.role === 'user');
    const firstUserLine = userTurns[0]?.content.split('\n')[0]?.slice(0, 200) ?? '';
    const oldTokens = totalHistoryTokens(old);
    const trigger = tokenThresholdHit && !countThresholdHit ? 'tokens' : 'count';
    // alpha.123 — the summary rides INSIDE the first kept `user` turn. Until
    // alpha.122 it was a `role: 'system'` history turn, and every lowering
    // drops system-role history (Anthropic/Google carry system in their own
    // field; the OpenAI-family loops `continue` past it) — so since alpha.7
    // the mutation said "compressed into 1 summary" while no wire carried it.
    // A user turn's text reaches every provider and changes no role shape.
    // When no user turn is kept (only assistant turns / orphan tool results),
    // a user turn carrying the summary is inserted at the front — and the
    // mutation says which of the two happened.
    const summaryText = `[Earlier conversation: ${old.length} turns omitted (~${oldTokens} tokens). First user message: "${firstUserLine}"]`;
    const carrierAt = recent.findIndex((m) => m.role === 'user');
    let kept: Message[];
    let placement: string;
    if (carrierAt >= 0) {
      kept = recent.slice();
      kept[carrierAt] = withLeadingSummary(recent[carrierAt]!, summaryText);
      placement = 'summary carried in the first kept user turn';
    } else {
      kept = [{ role: 'user', content: summaryText }, ...recent];
      placement = 'summary inserted as a user turn';
    }
    return {
      value: { ...ir, history: kept },
      mutations: [
        {
          id: `compress-history-${old.length}`,
          source: 'static_pass',
          passName: 'compress_history',
          description:
            (trigger === 'tokens'
              ? `Compressed ${old.length} old turns (~${oldTokens} tokens) into 1 summary — token threshold ${summarizeAboveTokens} exceeded (kept ${recent.length} recent)`
              : `Compressed ${old.length} old turns into 1 summary (kept ${recent.length} recent)`) +
            ` — ${placement}` +
            (cutIndex !== history.length - keepRecent
              ? ` — cut moved from ${history.length - keepRecent} to ${cutIndex} so a tool call stays with its result`
              : '') +
            (keptOrphans.length > 0 ? ` — ${keptOrphans.length} orphan tool result(s) kept verbatim` : ''),
        },
      ],
      historyTokensTotal,
      folded: old.length,
    };
  }

  // ── Branch B: in-place fat-message summarization (alpha.15) ──
  // Token threshold hit but history.length <= keepRecent — there's nothing
  // to slice off the front. AI-SDK-v6 stepCountIs(N) pattern: one message
  // (typically the previous-turn assistant message with collapsed tool
  // steps) dominates the budget. Replace that message's content with a
  // summary stub. Only fire when the fattest message accounts for
  // >= FAT_DOMINANCE_FLOOR of historyTokensTotal — below that, the bytes
  // are spread too evenly for fat-message replacement to help, and
  // emitting a mutation would be misleading.
  if (tokenThresholdHit) {
    let fattestIdx = -1;
    let fattestTokens = 0;
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (!m || typeof m.content !== 'string') continue;
      const t = countTokens(m.content);
      if (t > fattestTokens) {
        fattestTokens = t;
        fattestIdx = i;
      }
    }
    const FAT_DOMINANCE_FLOOR = 0.3;
    const fattest = fattestIdx >= 0 ? history[fattestIdx] : undefined;
    if (
      fattest &&
      historyTokensTotal > 0 &&
      fattestTokens / historyTokensTotal >= FAT_DOMINANCE_FLOOR
    ) {
      const firstLine = fattest.content.split('\n')[0]?.slice(0, 200) ?? '';
      const newContent = `[Earlier ${fattest.role} message content omitted: ~${fattestTokens} tokens. Preview: "${firstLine}"]`;
      const newHistory = history.slice();
      newHistory[fattestIdx] = { ...fattest, content: newContent };
      return {
        value: { ...ir, history: newHistory },
        mutations: [
          {
            id: `compress-fat-message-${fattestIdx}`,
            source: 'static_pass',
            passName: 'compress_history',
            description: `Replaced fat ${fattest.role} message #${fattestIdx} content (~${fattestTokens} of ${historyTokensTotal} tokens, ${Math.round((fattestTokens / historyTokensTotal) * 100)}% of history) with summary stub — token threshold ${summarizeAboveTokens} exceeded (${history.length <= keepRecent ? `history.length ${history.length} <= keepRecent ${keepRecent}` : 'no older turn is foldable — each is in a tool call/result group the cut may not split, or is an orphan tool result kept verbatim'}, slice not possible)`,
          },
        ],
        historyTokensTotal,
      };
    }
  }

  // Threshold hit but nothing actionable (tokens spread evenly across few
  // messages, no single dominant fat one). Honest no-op.
  return { value: ir, mutations: [], historyTokensTotal };
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 5: APPLY-CLIFFS — enforce profile cliffs (drop tools, force flags)
// ─────────────────────────────────────────────────────────────────────────

export interface CliffApplication {
  ir: PromptIR;
  /** Per-cliff side effects to forward to lowering. */
  loweringHints: {
    forceThinkingZero?: boolean;
    forceTerseOutput?: boolean;
    qualityWarning?: string[];
    escalateRequested?: boolean;
  };
}

/** Actions that remove capability from the wire (tools, output, thinking). */
export function isCapabilityReducing(action: CliffRule['action']): boolean {
  return (
    action === 'drop_to_top_relevant' ||
    action === 'strip_tools' ||
    action === 'force_terse_output' ||
    action === 'force_thinking_budget_zero'
  );
}

/** Probe-confirmed: the suite exercised the bad shape and it reproduced (or the knee moved and the rule was re-pinned). */
export function hasConfirmedEvidence(cliff: CliffRule): boolean {
  const ev = cliff.evidence;
  return ev?.class === 'probed' && (ev.verdict === 'confirmed' || ev.verdict === 'knee-moved');
}

/** A quality penalty may move the rank only on an observed incident or a confirmed probe. */
export function qualityPenaltyEvidenced(cliff: CliffRule): boolean {
  if (hasConfirmedEvidence(cliff)) return true;
  return deriveCliffEvidenceClass(cliff) === 'observed';
}

function describeEvidence(cliff: CliffRule): string {
  const ev = cliff.evidence;
  if (!ev) return `${deriveCliffEvidenceClass(cliff)} (no evidence field)`;
  return `${ev.class}${ev.verdict ? `/${ev.verdict}` : ''}${ev.lastProbed ? ` @${ev.lastProbed}` : ''}`;
}

export function passApplyCliffs(
  ir: PromptIR,
  profile: ModelProfile,
  estimatedInputTokens: number,
): PassResult<CliffApplication> {
  const mutations: MutationApplied[] = [];
  const hints: CliffApplication['loweringHints'] = { qualityWarning: [] };
  let nextIR = ir;
  // alpha.20 E3: when the consumer declares sequential tool orchestration,
  // the L-040 parallel-tool cliff doesn't apply — DeepSeek's strength at
  // single-step granularity is the whole point of the mode. Silence cliffs
  // whose reason carries the L-040 marker. Other cliffs (context, history,
  // structured-output) keep firing.
  const sequentialMode = nextIR.constraints?.toolOrchestration === 'sequential';

  for (const cliff of profile.cliffs) {
    // alpha.20 E3 — L-040 gate. Skip when consumer declared sequential
    // tool orchestration; the cliff exists to protect parallel-tool
    // throughput, which isn't being asked of the model in sequential mode.
    if (sequentialMode && cliff.reason.includes('L-040')) {
      continue;
    }

    let triggered = false;
    // alpha.103 — a consumer's explicit `expectedShortOutput` is an instruction,
    // not a kgauto belief; it bypasses the evidence gate below.
    let consumerHinted = false;
    switch (cliff.metric) {
      case 'input_tokens':
        triggered = estimatedInputTokens >= cliff.threshold;
        break;
      case 'tool_count':
        triggered = (nextIR.tools?.length ?? 0) >= cliff.threshold;
        break;
      case 'history_turns':
        triggered = (nextIR.history?.length ?? 0) >= cliff.threshold;
        break;
      case 'thinking_with_short_output': {
        // Two triggers. `expectedShortOutput` is the consumer's boolean hint
        // (every rule since alpha.1). alpha.101 adds the measured one: when
        // the rule's threshold is > 1 it is the smallest output cap the rule
        // LEAVES ALONE — either the smallest cap the model was probed to
        // HOLD under (deepseek 512, gemini-3.7-flash 512) or, alpha.104, one
        // above the LARGEST cap measured to BREAK when no hold has been
        // reached yet (gemini-2.5-flash 513: 300 and 512 both broke, 1024
        // unmeasured). Either way a declared `maxOutputTokens` below it fires
        // the rule on measured ground only. `threshold: 1` rules keep
        // boolean-only semantics — an unmeasured number must not become a
        // gate (P4).
        const cap = nextIR.constraints?.maxOutputTokens;
        const capBelowMeasuredHold =
          cliff.threshold > 1 && typeof cap === 'number' && cap > 0 && cap < cliff.threshold;
        consumerHinted = !!nextIR.constraints?.expectedShortOutput;
        triggered = consumerHinted || capBelowMeasuredHold;
        break;
      }
    }
    // Optional intent gate — when set, cliff only fires for matching archetype.
    if (triggered && cliff.whenIntent && nextIR.intent.archetype !== cliff.whenIntent) {
      triggered = false;
    }
    if (!triggered) continue;

    // ── alpha.103 — THE EVIDENCE GATE (design contract P2, Sacha 2026-08-30). ──
    // A capability-REDUCING action may fire only on evidence the probe suite
    // CONFIRMED. Not `class === 'probed'` alone: the suite stamps `probed` on
    // every guard it exercises and puts the answer in `verdict` — on
    // 2026-09-01 it stamped `probed/flagged` (not reproduced) on nine brain
    // cliffs, and a class-only check would have read that falsification as
    // a licence. Advisory actions (quality warnings, ranking penalties,
    // escalation) are not reductions and pass unchanged. A consumer's own
    // `expectedShortOutput` hint passes: it is their instruction. What is
    // withheld is SAID, as a mutation — the compile result carries what
    // kgauto declined to do and why (s73: enumerate what a suppression will
    // now never say).
    if (isCapabilityReducing(cliff.action) && !consumerHinted && !hasConfirmedEvidence(cliff)) {
      mutations.push({
        id: 'cliff-withheld-unevidenced',
        source: 'cliff_guard',
        passName: 'apply_cliffs',
        description:
          `${profile.id}: ${cliff.metric}${cliff.whenIntent ? `@${cliff.whenIntent}` : ''} → ${cliff.action} WITHHELD — ` +
          `evidence ${describeEvidence(cliff)}; a capability-reducing rule fires only on a probe-confirmed cliff (alpha.103). ${cliff.reason}`,
      });
      continue;
    }

    switch (cliff.action) {
      case 'drop_to_top_relevant': {
        // Halve tool count or drop to threshold-1, whichever fewer —
        // but never below 1: "drop to top relevant" must keep the top tool.
        // (threshold:1 cliffs computed floor(0.75)=0 and silently stripped
        // ALL tools — tt-intel s124 measured repro, 2026-08-02.)
        const targetCount = Math.max(
          1,
          Math.min(
            Math.floor(cliff.threshold * 0.75),
            Math.floor((nextIR.tools?.length ?? 0) / 2),
          ),
        );
        if (nextIR.tools && nextIR.tools.length > targetCount) {
          // Re-score by intent and trim
          const intent = nextIR.intent.archetype;
          const scored = nextIR.tools
            .map((t) => ({ tool: t, score: t.relevanceByIntent?.[intent] ?? 0.5 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, targetCount)
            .map((s) => s.tool);
          nextIR = { ...nextIR, tools: scored };
          mutations.push({
            id: `cliff-${cliff.metric}`,
            source: 'cliff_guard',
            passName: 'apply_cliffs',
            description: `${profile.id}: ${cliff.reason}; trimmed tools to ${targetCount}`,
          });
        }
        break;
      }
      case 'force_thinking_budget_zero':
        hints.forceThinkingZero = true;
        mutations.push({
          id: `cliff-thinking-zero`,
          source: 'cliff_guard',
          passName: 'apply_cliffs',
          description: `${profile.id}: ${cliff.reason}`,
        });
        break;
      case 'force_terse_output':
        hints.forceTerseOutput = true;
        mutations.push({
          id: `cliff-terse`,
          source: 'cliff_guard',
          passName: 'apply_cliffs',
          description: `${profile.id}: ${cliff.reason}`,
        });
        break;
      case 'downgrade_quality_warning':
        hints.qualityWarning!.push(cliff.reason);
        // No IR change — just diagnostic. Routing pass may use this.
        mutations.push({
          id: `cliff-quality-warning`,
          source: 'cliff_guard',
          passName: 'apply_cliffs',
          description: `${profile.id}: ${cliff.reason}`,
        });
        break;
      case 'escalate_target':
        hints.escalateRequested = true;
        mutations.push({
          id: `cliff-escalate`,
          source: 'cliff_guard',
          passName: 'apply_cliffs',
          description: `${profile.id}: ${cliff.reason}`,
        });
        break;
      case 'strip_tools': {
        // Hard-strip all tools. Used for archetype-specific failure modes
        // where tool presence (regardless of count) breaks the model.
        const droppedCount = nextIR.tools?.length ?? 0;
        if (droppedCount > 0) {
          nextIR = { ...nextIR, tools: [] };
          mutations.push({
            id: `cliff-strip-tools${cliff.whenIntent ? `-${cliff.whenIntent}` : ''}`,
            source: 'cliff_guard',
            passName: 'apply_cliffs',
            description: `${profile.id}: ${cliff.reason} — stripped ${droppedCount} tools`,
          });
        }
        break;
      }
    }
  }

  return { value: { ir: nextIR, loweringHints: hints }, mutations };
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 6: SCORE-TARGETS — pick the best model from allowed set
// ─────────────────────────────────────────────────────────────────────────

export interface TargetScore {
  modelId: string;
  /** Estimated input cost in USD. */
  estimatedCostUsd: number;
  /** Whether the IR fits this model's hard constraints. */
  fits: boolean;
  /** Reasons it doesn't fit, if any. */
  rejectReasons: string[];
  /** Quality estimate 0..1 (heuristic for now; PGO replaces in v2.x). */
  qualityScore: number;
  /** Composite rank score — higher = better pick. */
  rank: number;
  /** alpha.106 — the archetype-performance score the quality term read (0–10). */
  archetypePerf?: number;
  /** alpha.106 — the measured-failure gate that docked this model's rank, when one did (axis + numbers), so a pick can say WHY it passed over a higher-ordered candidate. */
  measuredGate?: MeasuredFailureGate;
  /** alpha.110 — where the quality term came from: the brain (n ≥ 10 on this archetype) or the profile's judgment / the no-evidence floor. */
  grounding?: 'measured' | 'judgment';
  /** alpha.110 — input + output cost at the call's real shape (USD), the number "cost decides" reads. */
  blendedCostUsd?: number;
  /** alpha.110 — true when this candidate was ranked by the floor-gated rule (measured, at or above the floor, not gated, fits). */
  measuredFit?: boolean;
}

/**
 * alpha.135 (filing 2026-12-06, Amendment B3) — two ranks closer than this are the same rank.
 * The rank carries `(n − index) · 0.1` for caller order, so two candidates whose terms are equal
 * in decimals can differ in the last float bit, and which bit depends on how many candidates the
 * caller passed (tt-intelligence's `generate`: claude-haiku-4-5 and gemini-3.7-flash both read
 * 1.2000000000000002 at the default depth, 1.3999999999999999 against 1.4000000000000001 at
 * depth 20). The smallest step kgauto sets on purpose is MEASURED_FIT_ORDINAL_STEP (0.01); a
 * difference under 1e-9 is the arithmetic, not the scorer's opinion.
 */
export const RANK_TIE_EPSILON = 1e-9;

/**
 * alpha.135 (B3) — the one order of scored candidates: higher rank first; ranks within
 * `RANK_TIE_EPSILON` are equal, and then the earlier position in the caller's list wins (the
 * first occurrence of an id; an id the list does not hold sorts after every id it does). Used by
 * the pick, the fallback chain and `diagnostics.targetScores`, so the three never disagree about
 * a tie, and the pick does not move with the depth the caller asks for.
 */
export function compareByRankThenCallerOrder(
  callerOrder: readonly unknown[],
): (a: Pick<TargetScore, 'modelId' | 'rank'>, b: Pick<TargetScore, 'modelId' | 'rank'>) => number {
  const position = new Map<string, number>();
  callerOrder.forEach((m, i) => {
    if (typeof m === 'string' && !position.has(m)) position.set(m, i);
  });
  const pos = (id: string) => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => {
    const d = b.rank - a.rank;
    if (Math.abs(d) > RANK_TIE_EPSILON) return d;
    return pos(a.modelId) - pos(b.modelId);
  };
}

export interface ScoreTargetsOptions {
  estimatedInputTokens: number;
  profilesById: (id: string) => ModelProfile;
  /**
   * alpha.124 — the consumer's pin (`forceModel`, or the one id of a
   * single-model `ir.models`), resolved by compile(). Exempt from the
   * input-modality requirement: a pin is the consumer's own knowledge. Read
   * only when `ir.constraints.inputModalities` is non-empty.
   */
  inputModalityPin?: string;
  /**
   * Consumer-declared policy. Filters blocked models, enforces cost
   * ceiling, boosts preferred. See CompilePolicy in ir.ts for rationale.
   */
  policy?: import('./ir.js').CompilePolicy;
  /**
   * alpha.64 — active surface promotion for (ir.appId, ir.intent.archetype),
   * resolved by compile() from the promotions-brain SWR cache (Stage 2;
   * consent-gated, default off — see BrainConfig.autoPromote). When present,
   * the promoted model receives PROMOTION_BOOST at ranking — unless the
   * consumer declared `policy.preferredModels`, in which case the promotion
   * DEFERS entirely (explicit consumer preference outranks brain evidence).
   */
  promotion?: SurfacePromotion;
  /**
   * alpha.70 — per-model measured-failure gates for this surface, resolved
   * by compile() from the measured-failure-brain SWR cache. Keyed by model
   * id; a present entry means the model's own in-window evidence on THIS
   * (app, archetype) says it fails more often than it succeeds.
   *
   * Unlike `promotion` this is NOT deferred by `policy.preferredModels`: a
   * preference expresses which model the consumer would LIKE to lead, not a
   * claim that a measurably-failing model works. `forceModel` still wins —
   * that is an explicit override, not a preference.
   */
  measuredFailureGates?: ReadonlyMap<string, MeasuredFailureGate>;
  /**
   * alpha.106 — the archetype-performance score the ranking's quality term
   * reads (0–10). compile() passes the brain-aware accessor so a MEASURED
   * score wins; when it returns undefined the pass falls back to the
   * profile's own `archetypePerf[archetype]`, then to the no-evidence floor
   * (6, alpha.97: unknown must not reduce).
   */
  archetypePerfOf?: (modelId: string) => number | undefined;
  /** alpha.110 — the row count behind a measured score, for the mutation text ("perf 5 on 41 rows"). Undefined when unmeasured. */
  archetypePerfNOf?: (modelId: string) => number | undefined;
}

/**
 * alpha.64 — the slice of a kgauto_promotions row that scoring needs.
 * Shape-decoupled from promotions-brain.ts's PromotionRow so passes.ts
 * stays free of brain imports (tests drive it directly).
 */
export interface SurfacePromotion {
  /** Brain row id — cited in the promotion-applied mutation. */
  id: number;
  /**
   * Release B channel discriminator. passScoreTargets consumes ONLY
   * 'downswap' rows and filters defensively rather than trusting its
   * caller — the L-073 family says the field gets dropped or mis-read once
   * per layer. A 'strategy' row has promotedModel === incumbentModel, so an
   * unfiltered one here would boost the incumbent and could suppress the
   * quality gate on evidence that was never about quality-gating.
   */
  mode: 'downswap' | 'strategy';
  /** The model this surface's evidence says should lead. */
  promotedModel: string;
  /** The eval run the promotion rests on (Glass-Box provenance). */
  evalRunId: number | null;
  /**
   * Evidence-supersedes-judgment: the promote-ready eval measured the
   * schema floor holding on this surface's real workload (zero floor
   * violations by verdict definition), so the alpha.49 schema-weak
   * quality-gate penalty is skipped for the promoted model only.
   */
  suppressQualityGate: boolean;
}

/**
 * alpha.70 — the slice of a measured-failure verdict that scoring needs,
 * keyed per candidate model. Same shape-decoupling rationale as
 * {@link SurfacePromotion}: passes.ts stays free of brain imports.
 *
 * This is the CREATE direction of measured-supersedes-judgment. alpha.49
 * creates the quality gate from a model's DECLARED conventions; alpha.64
 * let a measured verdict SUPPRESS it. Neither could gate a model whose
 * declarations are wrong — which is exactly when declarations can't be
 * trusted (haiku on playbacksam/summarize: every declared signal green,
 * 12-of-12 in-window failures).
 */
export interface MeasuredFailureGate {
  /** Observed in-window failure rate ON THE AXIS THAT FIRED. */
  rate: number;
  /** 95% lower confidence bound on that rate — what the decision tested. */
  lowerBound: number;
  /** Attempts backing the verdict, on the axis that fired. */
  n: number;
  nFail: number;
  /**
   * alpha.98 — which axis fired. `'quality'`: the model answered and the
   * answer was unusable — distrust its declared contract. `'availability'`:
   * the model could not be reached (429 / auth / timeout / transport) —
   * the account or the route is the subject, not the model's competence.
   * Carried through scoring so an advisory can never describe a quota
   * ceiling as a quality problem.
   */
  axis: 'quality' | 'availability';
}

// alpha.47 — latency-aware ranking constants. The penalty scales with how far
// a model's representative latency overshoots `constraints.maxLatencyMs`, then
// caps. Sized so a 'slow' model (~24s) under a typical synchronous ceiling
// (~12s) loses ~0.5 rank — enough to overcome the 0.25 baseQuality edge a model
// gets for carrying the 'reasoning' strength (the deepseek-v4-flash-over-gemini
// flip PB surfaced). Never a hard reject: maxLatencyMs is advisory, so a slow
// model still wins if it's the only option left.
const LATENCY_OVERAGE_WEIGHT = 0.6;
const LATENCY_PENALTY_CAP = 1.0;

// alpha.49 — quality-floor gate magnitude. "Quality is the floor; latency
// optimizes above it" (Sacha, 2026-06-04: a slower-but-amazing result is good
// UX; a fast result that fails the declared contract is not). When kgauto's
// executable knowledge says a model FAILS a DECLARED hard constraint for this
// archetype (today: structuredOutput + structuredOutputHint:'avoid'), the model
// is below the quality floor for this shape and must not lead. Sized larger than
// the entire legitimate fitting-rank band (qualityScore ≤0.85 + callerOrderBoost
// ≤~0.5 + preferredBoost 0.5 − costPenalty − latencyPenalty ≤1.0 ⇒ span ≈2.9) so
// ANY non-gated fitting model out-ranks ANY gated one — while the gated model
// keeps fits=true and stays a graceful last-resort fallback (served only if
// nothing better fits; alpha.8's contract layer then catches the parse-fail and
// walks on). Additive across gates; finite so order among gated models holds.
/** alpha.106 — no-evidence floor for the ranking's quality term (matches `ARCHETYPE_FLOOR_DEFAULT` in compatibility.ts; alpha.97: unknown must not reduce). */
const ARCHETYPE_PERF_FLOOR = 6;
const QUALITY_GATE_PENALTY = 4.0;

// alpha.64 — Stage-2 surface-promotion boost magnitude. Must dominate the
// entire legitimate fitting-rank band (≈2.9, see QUALITY_GATE_PENALTY sizing
// note) AND the quality-gate penalty itself (4.0 — a promotion may lift a
// convention-gated model into leadership precisely when the eval measured
// the gate's failure mode NOT firing on this surface's real workload), while
// staying below a single hard-reject (10 per reason): a promoted model that
// doesn't FIT — blocked by policy, over the cost ceiling, over context —
// still loses. 5.0 satisfies both bounds with margin.
const PROMOTION_BOOST = 5.0;

// ── alpha.110 — floor-gated ranking, option 2: FIT NEEDS MEASURED EVIDENCE ──
// Sacha's rule (agreed 2026-09-05, "agree w your reco"): below the quality floor a
// candidate is unfit; above it, cost decides at the call's real blended shape, then
// archetype performance, then chain order. Drift's sweep (2026-09-11) showed the LITERAL
// rule moves 8 of 9 starter-chain heads onto cheaper, mostly UNMEASURED models, because
// `archetypePerf` is judgment for almost every model — "cost decides above the floor"
// would have meant "route production onto the cheapest model somebody once scored a 6".
// So the floor is a MEASURED thing (option 2, the default after a silent week):
//   · measured (n ≥ MEASURED_GROUNDING_MIN_N on this archetype) and below the floor →
//     unfit: the same band-dominating lever the alpha.49 quality gate uses, said as a
//     mutation with the numbers;
//   · measured and fit → ordered among themselves by blended cost at the call's shape
//     (ascending), then measured perf (descending), then caller order;
//   · unmeasured → ranked as before (judgment perf, then caller order) and it NEVER wins
//     on price alone: the `estimatedCostUsd × 5` dampener — input-only, worth three perf
//     points at 20K tokens and six at 40K, with no evidence behind it — is gone. Price
//     moves a rank only where the quality side of the trade is measured.
// One cost function for the scorer and the advisor (`blendedCostUsd`) — through alpha.109
// the scorer priced input-only at the call's size while the advisor compared input rates.
const MEASURED_FIT_ORDINAL_STEP = 0.01;

/**
 * Per-archetype output-token estimate for the blended shape — the brain's p50 on organic
 * successful rows since 2026-08-12 (`compile_outcomes`, probed 2026-09-11 by Drift:
 * ask 74 · classify 1454 · extract 1261 · generate 1091 · hunt 1003 · summarize 1059;
 * plan/critique/transform had n ≤ 1 and carry the 250 reference). A caller's
 * `constraints.maxOutputTokens` caps it. Provenance is the point: these are measured
 * shapes, not a designer's 4K/250 guess, and they are here so the number is in one place.
 */
export const ARCHETYPE_OUTPUT_ESTIMATE: Readonly<Record<string, number>> = {
  ask: 74,
  classify: 1454,
  extract: 1261,
  generate: 1091,
  hunt: 1003,
  summarize: 1059,
  plan: 250,
  critique: 250,
  transform: 250,
  judge: 250,
};

/** Estimated output tokens for a call: the archetype's measured p50, capped by the caller's ceiling. */
export function estimatedOutputTokensFor(archetype: string, maxOutputTokens?: number): number {
  const est = ARCHETYPE_OUTPUT_ESTIMATE[archetype] ?? 250;
  return typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? Math.min(est, maxOutputTokens) : est;
}

/**
 * The one cost function (alpha.110): input + output at the call's real shape, in USD.
 * Shared by `passScoreTargets` (ranking among measured-fit candidates) and the advisor's
 * `cost-mismatched-archetype` rule, so "cheaper" means one thing.
 */
export function blendedCostUsd(
  profile: Pick<ModelProfile, 'costInputPer1m' | 'costOutputPer1m' | 'costTiers'>,
  inputTokens: number,
  outputTokens: number,
): number {
  // alpha.128 — the price of the tier the call's input falls in (`costTiers`,
  // the provider's prompt-length steps), else the base price.
  const price = priceAtInput(profile, inputTokens);
  return (inputTokens / 1_000_000) * price.costInputPer1m + (outputTokens / 1_000_000) * price.costOutputPer1m;
}

/**
 * alpha.49 — resolve the effective ArchetypeConvention[] for a selected
 * profile: model-specific own conventions, falling back to the family rep's
 * conventions when the selected profile carries none. Mirrors the resolution
 * passApplyConventions uses (pass 6.25) so the quality-floor gate (pass 5)
 * and the convention application agree on what conventions apply.
 */
export function effectiveConventions(profile: ModelProfile): ArchetypeConvention[] {
  const own = profile.archetypeConventions ?? [];
  if (own.length > 0) return own;
  const family = profile.family ?? deriveFamilyFromModelId(profile.id);
  if (!family) return [];
  const repId = familyRepId(family);
  if (!repId || repId === profile.id) return [];
  const rep = tryGetProfile(repId);
  return rep?.archetypeConventions ?? [];
}

/**
 * alpha.138 (R3) — the most input tokens one request to this model may carry:
 * `min(0.9 × maxContextTokens, maxInputTokens)`, and which bound that is. The
 * one definition of the bound, read by the context-budget test in
 * `passScoreTargets` and by compile()'s final size check, so the two cannot
 * disagree.
 */
export function inputTokenBound(
  profile: Pick<ModelProfile, 'maxContextTokens' | 'maxInputTokens'>,
): { limit: number; by: 'maxInputTokens' | 'window' } {
  const windowBound = profile.maxContextTokens * 0.9;
  if (typeof profile.maxInputTokens === 'number' && profile.maxInputTokens < windowBound) {
    return { limit: profile.maxInputTokens, by: 'maxInputTokens' };
  }
  return { limit: windowBound, by: 'window' };
}

export function passScoreTargets(
  ir: PromptIR,
  opts: ScoreTargetsOptions,
): PassResult<TargetScore[]> {
  const constraints = ir.constraints ?? {};
  const policy = opts.policy ?? {};
  // alpha.85 — canonical matching: an alias and its canonical are the same
  // model, so policy membership is tested on canonical ids for both the
  // list and the candidate (tt-intel s119: `deepseek-chat` in the candidate
  // set let a blocked `deepseek-v4-flash` serve).
  const blockedSet = canonicalPolicySet(policy.blockedModels);
  // alpha.115 — family-level block. Matched on the candidate profile's
  // provider, so a new id in a blocked family is blocked the day it ships.
  const blockedProviderSet = new Set<string>(policy.blockedProviders ?? []);
  const blockedByProvider = new Map<string, string[]>();
  const preferredSet = canonicalPolicySet(policy.preferredModels);
  const scores: TargetScore[] = [];
  const policyMutations: MutationApplied[] = [];
  // alpha.110 — per-candidate standing boosts (preference + promotion) and measured row
  // counts, kept for the post-loop measured-fit ordering and its mutation text.
  const standingBoost = new Map<string, number>();
  const measuredN = new Map<string, number | undefined>();
  // alpha.124 — input-modality REQUIREMENT (not a reducer: it removes nothing
  // the consumer did not ask to remove, and it fires only when the IR names a
  // modality). Every exclusion is collected so it can be SAID in one mutation.
  const requiredModalities = requiredInputModalities(constraints.inputModalities);
  const modalityDropped: Array<{ model: string; why: string }> = [];
  let modalityPinUndeclared: { model: string; why: string } | undefined;

  // alpha.64 — promotion deference: an explicit consumer preference list
  // outranks brain evidence, full stop. The promotion only acts when the
  // consumer left leadership to kgauto (no preferredModels declared).
  const rawPromotion = opts.promotion;
  const promotionDeferred =
    rawPromotion !== undefined && (policy.preferredModels?.length ?? 0) > 0;
  const promotion = promotionDeferred ? undefined : rawPromotion;

  // alpha.41 — compile() pre-resolves family entries to literal ids
  // before passes run. This pass operates on string ids only; the runtime
  // invariant is that every entry in `ir.models` at this point is a
  // string. We narrow at the entry boundary so the rest of the function
  // can treat `modelId` as `string` without per-line casts.
  const modelIds = ir.models.filter((m): m is string => typeof m === 'string');

  for (const modelId of modelIds) {
    let profile: ModelProfile;
    try {
      profile = opts.profilesById(modelId);
    } catch {
      scores.push({
        modelId,
        estimatedCostUsd: 0,
        fits: false,
        rejectReasons: ['unknown_model_id'],
        qualityScore: 0,
        rank: -Infinity,
      });
      continue;
    }

    const reasons: string[] = [];

    // ── Policy: blocked models — hard reject ──
    if (policySetHas(blockedSet, modelId)) {
      reasons.push(`blocked_by_policy (consumer gated this model — see CompilePolicy.blockedModels)`);
    }
    // ── Policy: blocked providers — hard reject (alpha.115) ──
    if (blockedProviderSet.has(profile.provider)) {
      reasons.push(
        `blocked_provider_by_policy (consumer gated provider ${profile.provider} — see CompilePolicy.blockedProviders)`,
      );
      const ids = blockedByProvider.get(profile.provider) ?? [];
      ids.push(modelId);
      blockedByProvider.set(profile.provider, ids);
    }

    // alpha.138 (R3) — the input bound is min(0.9 × window, the page's maximum
    // input) where the profile carries one; the reason names the bound that refused.
    // One function (`inputTokenBound`), read here and by compile()'s final check.
    const bound = inputTokenBound(profile);
    if (opts.estimatedInputTokens > bound.limit) {
      reasons.push(
        bound.by === 'maxInputTokens'
          ? `exceeds maximum input (${opts.estimatedInputTokens} > maxInputTokens ${bound.limit})`
          : `exceeds context budget (${opts.estimatedInputTokens} > 0.9*${profile.maxContextTokens})`,
      );
    }
    if ((ir.tools?.length ?? 0) > profile.maxTools) {
      reasons.push(`exceeds maxTools (${ir.tools?.length} > ${profile.maxTools})`);
    }
    if (constraints.structuredOutput && profile.structuredOutput === 'none') {
      reasons.push(`structuredOutput requested but model has none`);
    }
    // ── alpha.124: input-modality requirement — hard reject, pin exempt ──
    const modalityMiss = inputModalityMiss(profile, requiredModalities);
    if (modalityMiss !== undefined) {
      if (opts.inputModalityPin !== undefined && modelId === opts.inputModalityPin) {
        modalityPinUndeclared = { model: modelId, why: modalityMiss };
      } else {
        reasons.push(
          `input_modality_not_declared (requires ${requiredModalities!.join(', ')}; ${modalityMiss} — see ModelProfile.inputModalities)`,
        );
        modalityDropped.push({ model: modelId, why: modalityMiss });
      }
    }

    // Apply cliffs as soft penalties (not hard rejects).
    // alpha.103 — a quality penalty is a RANKING reduction, and it now needs
    // the same standing as a wire reduction: an observed incident or a
    // confirmed probe. Through alpha.102 every `downgrade_quality_warning`
    // docked 0.3 quality — including the five inherited "degrades above 8K"
    // rules that were never evidenced, and the three PRICING-tier warnings
    // (gpt-5.4/5.5 above 272K, 3.1-pro above 200K), which dock QUALITY for a
    // fact about PRICE. Those still surface in diagnostics.cliffWarnings;
    // they no longer move the rank.
    let qualityPenalty = 0;
    for (const cliff of profile.cliffs) {
      if (cliff.action !== 'downgrade_quality_warning') continue;
      if (!qualityPenaltyEvidenced(cliff)) continue;
      let triggered = false;
      if (cliff.metric === 'input_tokens') triggered = opts.estimatedInputTokens >= cliff.threshold;
      if (cliff.metric === 'tool_count') triggered = (ir.tools?.length ?? 0) >= cliff.threshold;
      if (triggered) qualityPenalty += 0.3;
    }

    // alpha.128 — input priced at the tier this call's input falls in.
    const estimatedCostUsd = (opts.estimatedInputTokens / 1_000_000) * priceAtInput(profile, opts.estimatedInputTokens).costInputPer1m;

    // ── Policy: cost ceiling — hard reject ──
    if (policy.maxCostPerCallUsd !== undefined && estimatedCostUsd > policy.maxCostPerCallUsd) {
      reasons.push(
        `exceeds_max_cost_per_call (estimated $${estimatedCostUsd.toFixed(4)} > policy ceiling $${policy.maxCostPerCallUsd.toFixed(4)})`,
      );
    }

    // alpha.106 — the quality term is the ARCHETYPE PERFORMANCE score, the
    // same number the chains, the cost rule and every recommending advisory
    // are built on. Through alpha.105 it was a greenfield heuristic on
    // `strengths` (reasoning 0.85 · quality 0.8 · else 0.6) that never read
    // `archetypePerf`: deepseek-v4-flash (summarize perf 7, "reasoning")
    // outranked gemini-2.5-flash (summarize perf 7, "speed") on every
    // summarize call, and the cost rule then fired against the scorer's own
    // pick recommending the model the chain had put first — three kgauto
    // opinions on one call, two disagreeing with the one that acted
    // (tt-intelligence 2026-09-05, shape B). One number now; ties fall to
    // caller order, which is what a consumer handing us our own chain means.
    // alpha.110 — `archetypePerfOf` answers ONLY with a measured score (compile() hands
    // the brain's number through when n ≥ MEASURED_GROUNDING_MIN_N); undefined means
    // unmeasured, and the profile's judgment or the no-evidence floor stands in.
    const measuredPerf = opts.archetypePerfOf?.(modelId);
    const measured = measuredPerf !== undefined;
    const archetypePerf =
      measuredPerf ??
      profile.archetypePerf?.[ir.intent.archetype] ??
      ARCHETYPE_PERF_FLOOR;
    const baseQuality = Math.max(0, Math.min(10, archetypePerf)) / 10;
    const qualityScore = Math.max(0, baseQuality - qualityPenalty);

    // alpha.110 — the blended shape: input at the call's size, output at the archetype's
    // measured p50 (capped by the caller's ceiling). This is the number "cost decides" reads.
    const estimatedOutputTokens = estimatedOutputTokensFor(ir.intent.archetype, constraints.maxOutputTokens);
    const blendedCost = blendedCostUsd(profile, opts.estimatedInputTokens, estimatedOutputTokens);

    // alpha.110 — measured and BELOW the floor → unfit for leadership. Same lever as the
    // alpha.49 quality gate ("below the quality floor for this shape" is one idea), said
    // below with the numbers. Judgment scores never trip this: unknown must not reduce.
    const belowMeasuredFloor = measured && measuredPerf < ARCHETYPE_PERF_FLOOR;
    const floorPenalty = belowMeasuredFloor ? QUALITY_GATE_PENALTY : 0;

    // Rank: prefer caller order, but penalize misfit + quality drops.
    const callerOrderBoost = (modelIds.length - modelIds.indexOf(modelId)) * 0.1;
    // alpha.110 — no price term in the base rank. Through alpha.109 `estimatedCostUsd × 5`
    // (input-only, evidence-free) could hand leadership to a cheaper UNMEASURED model.
    // Price now moves a rank only among measured-fit candidates (post-loop, below).
    const costPenalty = 0;
    // ── Policy: preferred models — rank boost (small enough not to override fit/hard rejects) ──
    const preferredBoost = policySetHas(preferredSet, modelId) ? 0.5 : 0;

    // ── alpha.47: latency awareness — implements constraints.maxLatencyMs ──
    // Declared since alpha.0 ("compiler will down-rank slow models") but never
    // wired. When the caller sets maxLatencyMs (synchronous, user-waits paths
    // with no streaming — e.g. PB /api/analyze), soft-penalize models whose
    // representative latency overshoots the ceiling. Zero effect when unset →
    // no regression for any existing caller. Without this, a slow model can
    // leapfrog a fast one on cost+quality alone (the deepseek-v4-flash vs
    // gemini-2.5-flash summarize-leader flip, PB 2026-06-03).
    let latencyPenalty = 0;
    const maxLatencyMs = constraints.maxLatencyMs;
    if (typeof maxLatencyMs === 'number' && maxLatencyMs > 0) {
      const tierMs = LATENCY_TIER_MS[latencyTierOf(profile)];
      if (tierMs > maxLatencyMs) {
        const overage = (tierMs - maxLatencyMs) / maxLatencyMs;
        latencyPenalty = Math.min(LATENCY_OVERAGE_WEIGHT * overage, LATENCY_PENALTY_CAP);
      }
    }

    // ── alpha.49: quality-floor gate (declared-constraint violation) ──
    // "Quality is the floor; latency optimizes above it." When the caller
    // declares a hard output constraint (structuredOutput) AND kgauto's
    // executable knowledge flags this model as schema-weak for this archetype
    // (archetypeConvention structuredOutputHint:'avoid' — e.g. deepseek-v4-flash
    // + summarize, 3/4 parse-fail, alpha.43), the model WILL fail the declared
    // contract and is below the quality floor for this shape. Gate it out of
    // leadership with QUALITY_GATE_PENALTY (band-dominating) — but keep
    // fits=true so it remains a graceful last-resort fallback. This makes the
    // alpha.43 knowledge ACT at ranking (pass 5); previously it only WARNED
    // post-selection (passApplyConventions, pass 6.25) and never stopped the
    // model being picked. The gate is intentionally NOT a hard reject so the
    // chain degrades (serves a schema-weak model only if nothing better fits)
    // rather than throwing when every candidate is flagged.
    let qualityGatePenalty = 0;
    let structuredCliffGate: (typeof profile.cliffs)[number] | undefined;
    if (constraints.structuredOutput) {
      const schemaWeak = effectiveConventions(profile).some(
        (c) =>
          c.archetype === ir.intent.archetype &&
          c.structuredOutputHint === 'avoid',
      );
      if (schemaWeak) qualityGatePenalty = QUALITY_GATE_PENALTY;

      // ── alpha.78: the same gate, from an INPUT-SIZE cliff ──
      // Third way to establish "below the quality floor for this shape":
      // a `quality_gate_structured` cliff encodes measured evidence that a
      // model's declared structured-output support does not hold above an
      // input threshold on an archetype (haiku-4-5 summarize: 21
      // structured_output_parse_failed fallovers, all ≥12K tokens_in, while
      // short-input traffic has no failure evidence — an archetype-wide
      // 'avoid' would overreach what was measured, and a 0.3 soft cliff
      // penalty loses to price-led ranking, which is exactly how the
      // failures happened). Bundled, so it protects COLD isolates — the
      // complement to the alpha.70/.73 measured gate, which needs the brain.
      if (!schemaWeak) {
        structuredCliffGate = profile.cliffs.find(
          (c) =>
            c.action === 'quality_gate_structured' &&
            (!c.whenIntent || c.whenIntent === ir.intent.archetype) &&
            c.metric === 'input_tokens' &&
            opts.estimatedInputTokens >= c.threshold,
        );
        if (structuredCliffGate) qualityGatePenalty = QUALITY_GATE_PENALTY;
      }
    }

    // ── alpha.70: the same gate, created from MEASURED evidence ──
    // Deliberately the SAME lever (QUALITY_GATE_PENALTY), not a second
    // ranking concept: "below the quality floor for this shape" is one idea
    // that can now be established two ways — by kgauto's declared knowledge
    // (above) or by the consumer's own outcome rows (here). A model whose
    // in-window evidence says it fails more often than it succeeds on this
    // surface is below the floor no matter how green its declarations read.
    //
    // NOT conditioned on `constraints.structuredOutput`: the declared gate
    // needs that condition because it reasons about a declared contract,
    // whereas measured failure already encodes whatever actually went wrong.
    const measuredGate = opts.measuredFailureGates?.get(modelId);
    if (measuredGate) qualityGatePenalty = QUALITY_GATE_PENALTY;

    // alpha.64 — Stage-2 surface promotion. Boost only the promoted model,
    // and only among the models the consumer DECLARED (never inject). The
    // eval's measured evidence may suppress the judgment-grounded quality
    // gate for exactly this tuple.
    //
    // alpha.70 — but suppression reaches the DECLARED gate ONLY. A
    // promotion's `suppress_quality_gate` rests on an eval that measured
    // the schema floor holding at promote time; the measured gate rests on
    // what this surface's traffic is doing NOW. When the two disagree, live
    // evidence wins — a frozen verdict must never un-gate a model that is
    // actively failing, or a stale promotion becomes a permanent licence to
    // keep failing. (Same posture as the guard's own auto-revert: the
    // promotion is not privileged against its own subsequent evidence.)
    // Release B defensive channel filter: only a downswap promotion may
    // reach model scoring. compile() already resolves with mode:'downswap',
    // but belt-and-suspenders per the field-drops-once-per-layer rule.
    const isPromoted =
      promotion?.mode === 'downswap' && promotion.promotedModel === modelId;
    if (isPromoted && promotion.suppressQualityGate && !measuredGate) {
      qualityGatePenalty = 0;
    }
    // alpha.70 — and the BOOST must be withheld too, not merely out-weighed.
    // PROMOTION_BOOST (5.0) is deliberately sized to dominate
    // QUALITY_GATE_PENALTY (4.0), so suppressing the suppression is not
    // enough: a promoted-but-failing model would still net +1.0 and keep
    // leading. A promotion is a claim about this exact tuple that the
    // tuple's own live evidence now contradicts, so it does not apply here
    // at all. This is the same decision the 7-day rollback guard would
    // reach on its next run — taken at compile time instead of up to 24h
    // later, which is the difference between a consumer paying for one more
    // failure and paying for a day of them.
    const promotionNeutralized = isPromoted && !!measuredGate;
    const promotionBoost = isPromoted && !measuredGate ? PROMOTION_BOOST : 0;

    const rank =
      qualityScore +
      callerOrderBoost -
      costPenalty -
      reasons.length * 10 +
      preferredBoost -
      latencyPenalty -
      qualityGatePenalty -
      floorPenalty +
      promotionBoost;

    if (belowMeasuredFloor) {
      const n = opts.archetypePerfNOf?.(modelId);
      policyMutations.push({
        id: `floor-unfit-measured-${modelId}`,
        source: 'quality_gate',
        passName: 'score_targets',
        rankDelta: -floorPenalty,
        rankBefore: rank + floorPenalty,
        rankAfter: rank,
        description:
          `Model ${modelId} is below the quality floor for archetype '${ir.intent.archetype}' by MEASURED evidence — ` +
          `archetype performance ${measuredPerf}${n !== undefined ? ` on ${n} rows` : ''} < floor ${ARCHETYPE_PERF_FLOOR}. ` +
          `Rank ${(rank + floorPenalty).toFixed(2)} → ${rank.toFixed(2)} (−${floorPenalty.toFixed(2)}). ` +
          `Unfit for leadership; retained as graceful fallback only (alpha.110 floor-gated ranking, option 2: fit needs measured evidence).`,
      });
    }

    // alpha.110 — the standing boosts (preference, promotion) are re-applied on top of the
    // measured-fit cost ordering below, so a consumer's pin or an eval's promotion keeps its
    // standing over a cheaper measured-fit candidate.
    standingBoost.set(modelId, preferredBoost + promotionBoost);
    measuredN.set(modelId, opts.archetypePerfNOf?.(modelId));

    scores.push({
      archetypePerf,
      ...(measuredGate ? { measuredGate } : {}),
      modelId,
      estimatedCostUsd,
      fits: reasons.length === 0,
      rejectReasons: reasons,
      qualityScore,
      rank,
      grounding: measured ? 'measured' : 'judgment',
      blendedCostUsd: blendedCost,
      measuredFit:
        measured && !belowMeasuredFloor && qualityGatePenalty === 0 && reasons.length === 0,
    });

    if (blockedSet.has(modelId)) {
      policyMutations.push({
        id: `policy-blocked-${modelId}`,
        source: 'compile_policy',
        passName: 'score_targets',
        description: `Model ${modelId} excluded by CompilePolicy.blockedModels`,
      });
    }
    if (
      policy.maxCostPerCallUsd !== undefined &&
      estimatedCostUsd > policy.maxCostPerCallUsd &&
      !blockedSet.has(modelId)
    ) {
      policyMutations.push({
        id: `policy-over-cost-${modelId}`,
        source: 'compile_policy',
        passName: 'score_targets',
        description: `Model ${modelId} excluded — estimated cost $${estimatedCostUsd.toFixed(4)} exceeds policy ceiling $${policy.maxCostPerCallUsd.toFixed(4)}`,
      });
    }
    if (policySetHas(preferredSet, modelId) && reasons.length === 0) {
      policyMutations.push({
        id: `policy-preferred-${modelId}`,
        source: 'compile_policy',
        passName: 'score_targets',
        description: `Model ${modelId} rank boosted by CompilePolicy.preferredModels`,
      });
    }
    if (latencyPenalty > 0) {
      const tier = latencyTierOf(profile);
      policyMutations.push({
        id: `latency-downrank-${modelId}`,
        source: 'latency_guard',
        passName: 'score_targets',
        description: `Model ${modelId} rank down ${latencyPenalty.toFixed(2)} — latency tier '${tier}' (~${LATENCY_TIER_MS[tier]}ms) exceeds constraints.maxLatencyMs (${maxLatencyMs}ms)`,
      });
    }
    if (qualityGatePenalty > 0) {
      // alpha.70 — two causes, two distinct mutations. A consumer reading
      // Glass-Box must be able to tell "kgauto's curated knowledge says this
      // model is weak here" apart from "your own traffic proves it is",
      // because the second is a claim about THEIR data and is actionable.
      // Measured takes the mutation when both apply: it is the stronger,
      // surface-specific statement.
      // alpha.73 — carry the MAGNITUDE, not just the fact and the reason.
      // Without it a consumer cannot tell "the gate did not see this model"
      // from "the gate saw it and the penalty lost to price" — the two states
      // that actually differ, and the gap PB filed two contradictory
      // diagnoses into. Known here for free; discarding it was the defect.
      const rankBefore = rank + qualityGatePenalty;
      if (measuredGate) {
        const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
        policyMutations.push({
          id: `quality-gate-measured-${modelId}`,
          source: 'quality_gate',
          passName: 'score_targets',
          rankDelta: -qualityGatePenalty,
          rankBefore,
          rankAfter: rank,
          description:
            `Model ${modelId} gated below the quality floor for archetype '${ir.intent.archetype}' by MEASURED evidence from this app's own outcomes — ` +
            `${measuredGate.nFail} of ${measuredGate.n} attempts failed on the quality axis in the trailing window ` +
            `(${pct(measuredGate.rate)}; 95% lower bound ${pct(measuredGate.lowerBound)} > 50%). ` +
            `Rank ${rankBefore.toFixed(2)} → ${rank.toFixed(2)} (−${qualityGatePenalty.toFixed(2)}). ` +
            `Down-ranked out of leadership; retained as graceful fallback only. ` +
            `The gate is derived, not stored — it lifts on its own once the failures age out of the window.`,
        });
      } else if (structuredCliffGate) {
        policyMutations.push({
          id: `quality-gate-structured-cliff-${modelId}`,
          source: 'quality_gate',
          passName: 'score_targets',
          rankDelta: -qualityGatePenalty,
          rankBefore,
          rankAfter: rank,
          description:
            `Model ${modelId} gated below the quality floor for archetype '${ir.intent.archetype}' — ` +
            `declared structuredOutput + input_tokens ≥ ${structuredCliffGate.threshold} trips a measured cliff: ` +
            `${structuredCliffGate.reason} Rank ${rankBefore.toFixed(2)} → ${rank.toFixed(2)} (−${qualityGatePenalty.toFixed(2)}). ` +
            `Down-ranked out of leadership; retained as graceful fallback only. Bundled knowledge — active on cold isolates with no brain.`,
        });
      } else {
        policyMutations.push({
          id: `quality-gate-structured-${modelId}`,
          source: 'quality_gate',
          passName: 'score_targets',
          rankDelta: -qualityGatePenalty,
          rankBefore,
          rankAfter: rank,
          description: `Model ${modelId} gated below the quality floor for archetype '${ir.intent.archetype}' — declared structuredOutput + kgauto convention flags it schema-weak for this contract (structuredOutputHint:'avoid'). Rank ${rankBefore.toFixed(2)} → ${rank.toFixed(2)} (−${qualityGatePenalty.toFixed(2)}). Down-ranked out of leadership; retained as graceful fallback only.`,
        });
      }
    }
    if (promotionNeutralized && reasons.length === 0) {
      // A silently-withheld boost would look identical to no promotion at
      // all. Say it out loud: the operator needs to know the promotion is
      // being contradicted by live traffic BEFORE the daily guard rolls it
      // back, and the consumer needs to know why their promoted model
      // stopped leading.
      policyMutations.push({
        id: `promotion-neutralized-${modelId}`,
        source: 'surface_promotion',
        passName: 'score_targets',
        description:
          `Active promotion #${promotion!.id} for ${modelId} NOT applied — the surface's own measured evidence contradicts it ` +
          `(${measuredGate!.nFail}/${measuredGate!.n} attempts failed in the trailing window). ` +
          `A promotion rests on an eval at promote time; this rests on what the surface is doing now, and the fresher evidence wins. ` +
          `The 7-day rollback guard is expected to retire this promotion on its next run.`,
      });
    } else if (isPromoted && reasons.length === 0) {
      policyMutations.push({
        id: `promotion-applied-${modelId}`,
        source: 'surface_promotion',
        passName: 'score_targets',
        description:
          `Model ${modelId} boosted to surface leadership by active promotion #${promotion.id}` +
          ` (golden-eval run ${promotion.evalRunId ?? 'n/a'}, Stage 2 auto-promote, 7-day rollback guard)` +
          (promotion.suppressQualityGate
            ? ' — schema-weak quality gate suppressed for this tuple (eval measured the floor holding on real workload)'
            : ''),
      });
    }
  }

  // alpha.124 — the input-modality filter, SAID: one mutation naming every
  // model dropped and why, plus the pin kept on the consumer's knowledge.
  if (requiredModalities && (modalityDropped.length > 0 || modalityPinUndeclared)) {
    const parts: string[] = [];
    if (modalityDropped.length > 0) {
      parts.push(
        `${modalityDropped.length} candidate(s) dropped: ` +
          modalityDropped.map((d) => `${d.model} (${d.why})`).join(', '),
      );
    }
    if (modalityPinUndeclared) {
      parts.push(
        `pinned ${modalityPinUndeclared.model} kept (${modalityPinUndeclared.why}) — a pin is the consumer's own knowledge, served untouched`,
      );
    }
    policyMutations.push({
      id: 'chain-filtered-by-input-modality',
      source: 'input_modality',
      passName: 'score_targets',
      description:
        `The call requires input modality ${requiredModalities.join(', ')} (constraints.inputModalities); ` +
        `only models whose profile declares it may serve. ${parts.join('; ')}. ` +
        `"not declared" = kgauto has not read that modality on the provider's page, so it will not guess; ` +
        `the chain is never widened to an undeclared model.`,
    });
  }

  // alpha.115 — the family block, SAID: one mutation per blocked provider that
  // had at least one candidate in the set, naming every id it excluded.
  for (const [provider, ids] of blockedByProvider) {
    policyMutations.push({
      id: `blocked-provider-${provider}`,
      source: 'compile_policy',
      passName: 'score_targets',
      description: `Provider ${provider} excluded by CompilePolicy.blockedProviders — ${ids.length} candidate(s) not selectable: ${ids.join(', ')}`,
    });
  }

  if (
    promotionDeferred &&
    rawPromotion &&
    modelIds.includes(rawPromotion.promotedModel)
  ) {
    policyMutations.push({
      id: `promotion-deferred-consumer-preference-${rawPromotion.promotedModel}`,
      source: 'surface_promotion',
      passName: 'score_targets',
      description: `Active promotion #${rawPromotion.id} for ${rawPromotion.promotedModel} deferred — CompilePolicy.preferredModels is declared and explicit consumer preference outranks brain evidence.`,
    });
  }

  // ── alpha.110 — among MEASURED-FIT candidates, cost decides ──
  // Ordered by blended cost at the call's shape (ascending), then measured perf
  // (descending), then caller order. The group keeps the position its best member
  // already held (its top base rank), so nothing UNMEASURED moves relative to it:
  // price re-orders only the candidates whose quality side is measured. Promotion
  // and preference boosts stay additive on top, as everywhere else.
  const measuredFit = scores.filter((s) => s.measuredFit);
  if (measuredFit.length >= 2) {
    const idx = (id: string) => modelIds.indexOf(id);
    const ordered = [...measuredFit].sort(
      (a, b) =>
        (a.blendedCostUsd ?? 0) - (b.blendedCostUsd ?? 0) ||
        (b.archetypePerf ?? 0) - (a.archetypePerf ?? 0) ||
        idx(a.modelId) - idx(b.modelId),
    );
    // Base = rank without the standing boosts; the group's top base rank is where its
    // best member already stood. Boosts go back on top per model, so a consumer's pin
    // (`preferredModels`, +0.5) or an eval's promotion (+5.0) keeps its standing over a
    // cheaper measured-fit candidate — "pins and promotions keep their standing as today".
    const boost = (s: TargetScore) => standingBoost.get(s.modelId) ?? 0;
    const top = Math.max(...measuredFit.map((s) => s.rank - boost(s)));
    // alpha.135 (B3) — the leaders this mutation names are read with the pick's own order.
    const byRank = compareByRankThenCallerOrder(modelIds);
    const byRankBefore = [...measuredFit].sort(byRank).map((s) => s.modelId);
    const nOf = (id: string) => measuredN.get(id);
    const nText = (id: string) => (nOf(id) !== undefined ? `, n=${nOf(id)}` : '');
    ordered.forEach((s, i) => {
      s.rank = top - i * MEASURED_FIT_ORDINAL_STEP + boost(s);
    });
    const leaderAfter = [...measuredFit].sort(byRank)[0]!;
    const prevLeaderId = byRankBefore[0] ?? leaderAfter.modelId;
    if (leaderAfter.modelId !== prevLeaderId) {
      const prev = scores.find((x) => x.modelId === prevLeaderId);
      policyMutations.push({
        id: `measured-fit-cost-leads-${leaderAfter.modelId}`,
        source: 'floor_gated_ranking',
        passName: 'score_targets',
        rankDelta: leaderAfter.rank - (prev?.rank ?? leaderAfter.rank),
        rankBefore: prev?.rank ?? leaderAfter.rank,
        rankAfter: leaderAfter.rank,
        description:
          `Among ${measuredFit.length} measured-fit candidates for archetype '${ir.intent.archetype}' cost decides: ` +
          `${leaderAfter.modelId} (perf ${leaderAfter.archetypePerf}${nText(leaderAfter.modelId)}, $${(leaderAfter.blendedCostUsd ?? 0).toFixed(4)} at ${opts.estimatedInputTokens} in / ` +
          `${estimatedOutputTokensFor(ir.intent.archetype, constraints.maxOutputTokens)} out) leads ` +
          `${prevLeaderId} (perf ${prev?.archetypePerf}${nText(prevLeaderId)}, $${(prev?.blendedCostUsd ?? 0).toFixed(4)}). ` +
          `Every candidate here is measured at or above floor ${ARCHETYPE_PERF_FLOOR}; unmeasured candidates keep their rank; ` +
          `a preferred or promoted candidate keeps its boost (alpha.110, option 2).`,
      });
    }
  }

  return { value: scores, mutations: policyMutations };
}

// ─────────────────────────────────────────────────────────────────────────
// SHAPE COMPUTATION — used for learning key
// ─────────────────────────────────────────────────────────────────────────

export function computeShape(
  ir: PromptIR,
  estimatedInputTokens: number,
): ShapeSignature {
  return {
    contextBucket: bucketContext(estimatedInputTokens),
    toolCountBucket: bucketToolCount(ir.tools?.length ?? 0),
    historyDepth: bucketHistory(ir.history?.length ?? 0),
    outputMode: resolveOutputMode({
      declared: ir.constraints?.outputMode,
      structuredOutput: ir.constraints?.structuredOutput,
      toolCount: ir.tools?.length ?? 0,
    }),
    hasExamples: ir.sections.some((s) => /\bexample\b/i.test(s.id)),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

export function estimateInputTokens(ir: PromptIR): number {
  const sectionTokens = ir.sections.reduce((sum, s) => sum + countTokens(s.text), 0);
  const toolTokens = (ir.tools ?? []).reduce((sum, t) => sum + countToolTokens(t), 0);
  const historyTokens = countMessagesTokens(ir.history ?? []);
  const turnTokens = ir.currentTurn ? countTokens(ir.currentTurn.content) + 4 : 0;
  // +6 for system framing
  return sectionTokens + toolTokens + historyTokens + turnTokens + 6;
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 10: APPLY-CONVENTIONS — per-family-per-archetype prompt-shape rewrites
//
// alpha.43. Cliffs are runtime warnings; conventions are compile-time prompt
// rewrites. The split: "this model hedges on classify" is a fact about the
// model (a convention); "this prompt is 80k tokens on a Flash profile" is a
// fact about the call (a cliff).
//
// Conventions live as data on profiles (see `profiles.ts > ArchetypeConvention`).
// This pass walks the matching conventions for the selected profile +
// archetype and applies prefixes/suffixes, surfaces structured-output
// hints, and emits cliff-style warnings into `loweringHints` /
// `result.diagnostics.cliffWarnings`.
//
// Idempotency: the suffix/prefix is only applied when not already present
// at the tail/head of the target message — re-compiling a request that
// already carries the convention is a no-op.
//
// Resolution: conventions are FAMILY-LEVEL by default. The selected
// profile carries its own conventions only if it's the family rep; other
// family members inherit by deriving the family from the model id and
// reading the family-rep profile's conventions. Model-specific overrides
// on the selected profile win when both apply for the same archetype.
// ─────────────────────────────────────────────────────────────────────────

export interface ConventionApplication {
  ir: PromptIR;
  /** Cliff-style warnings emitted by convention rules (surface in diagnostics). */
  cliffWarnings: string[];
  /** Structured-output hints to bubble up for advisor / consumer visibility. */
  structuredOutputHints: Array<{ archetype: string; hint: 'enforce' | 'avoid'; reason: string }>;
}

/**
 * Resolve the effective ArchetypeConvention[] for a given selected profile,
 * walking family inheritance once. Model-specific entries on the selected
 * profile take precedence over family-level entries for the same archetype.
 *
 * Pure; safe to call from any context (probe-watcher uses the same logic
 * via `applyArchetypeConvention`).
 */
export function resolveConventionsForProfile(profile: ModelProfile): ArchetypeConvention[] {
  const own = profile.archetypeConventions ?? [];
  const family = profile.family ?? deriveFamilyFromModelId(profile.id);
  if (!family) return own;
  // Find the family rep — the profile whose own id matches the family tag
  // or whose deriveFamilyFromModelId result matches. We look up via the
  // common family-rep convention: the profile that owns conventions for
  // the family is the one whose `id` directly resolves to `family`.
  //
  // Implementation: scan known profiles for one whose
  // deriveFamilyFromModelId === family AND archetypeConventions length > 0.
  // tryGetProfile won't help us iterate; instead, we accept the model-
  // specific overrides on the SELECTED profile as the only source. The
  // family-rep convention substrate is reached when the selected profile
  // IS the family rep (which is the default — most consumers call the
  // family rep directly via family-resolution).
  //
  // Future work: when family-resolution surfaces the rep profile, swap in
  // a direct lookup. For alpha.43 the family-rep IS the selected profile
  // in every shipped convention case (V4-Pro and V4-Flash both carry
  // their own family conventions).
  return own;
}

/**
 * Pure helper: apply the matching ArchetypeConvention's suffix (and
 * prefix, when meaningful) to a plain prompt-text string. Used by the
 * exclusion-probe-watcher (`probeOne`) so probe calls carry the same
 * forcing-function shape consumers see at compile time. Without this,
 * every reasoner probe on a decisive archetype gets unfairly stay-excluded
 * for hedging — as ID 20 demonstrated on 2026-05-28.
 *
 * Resolution: looks up the family-rep profile for `family` and reads its
 * `archetypeConventions`. Returns the original text unchanged when no
 * convention matches or when the suffix is already present.
 *
 * @param promptText raw user-prompt text (or prompt_preview from outcome)
 * @param archetype  intent_archetype from the finding row
 * @param family     family tag from deriveFamilyFromModelId / brain row
 * @returns text with prefix/suffix applied (idempotent)
 */
export function applyArchetypeConvention(
  promptText: string,
  archetype: string,
  family: string,
): string {
  if (typeof promptText !== 'string' || promptText.length === 0) return promptText;
  // Look up the family-rep profile (the one whose deriveFamilyFromModelId
  // resolves to `family` AND carries conventions). For alpha.43 the known
  // family reps are deepseek-v4-pro (deepseek-reasoner) and
  // deepseek-v4-flash (deepseek-chat); both ship via tryGetProfile.
  const repId = familyRepId(family);
  if (!repId) return promptText;
  const profile = tryGetProfile(repId);
  if (!profile || !profile.archetypeConventions) return promptText;
  const conventions = profile.archetypeConventions.filter((c) => c.archetype === archetype);
  if (conventions.length === 0) return promptText;

  let next = promptText;
  for (const c of conventions) {
    if (c.promptPrefix) {
      // Idempotent: skip if the prefix is already at the head.
      if (!next.startsWith(c.promptPrefix)) {
        next = c.promptPrefix + next;
      }
    }
    if (c.promptSuffix) {
      // Idempotent: skip if the suffix is already at the tail.
      if (!next.endsWith(c.promptSuffix)) {
        next = next + c.promptSuffix;
      }
    }
  }
  return next;
}

/**
 * Map a family tag to the bundled family-rep profile id. The family rep
 * is the profile that carries the family's archetypeConventions. Returns
 * undefined when no family rep is known.
 *
 * Kept narrow on purpose — only families with shipped conventions need
 * an entry. Adding a new family-level convention means adding a new line
 * here.
 */
function familyRepId(family: string): string | undefined {
  switch (family) {
    case 'deepseek-reasoner':
      return 'deepseek-v4-pro';
    case 'deepseek-chat':
      return 'deepseek-v4-flash';
    default:
      return undefined;
  }
}

export function passApplyConventions(
  ir: PromptIR,
  profile: ModelProfile,
): PassResult<ConventionApplication> {
  const mutations: MutationApplied[] = [];
  const cliffWarnings: string[] = [];
  const structuredOutputHints: ConventionApplication['structuredOutputHints'] = [];

  // Resolve effective conventions for the selected profile (model-specific
  // own + family inheritance). For alpha.43 own === effective when the
  // selected profile IS the family rep.
  const own = profile.archetypeConventions ?? [];
  let effective = own;
  if (effective.length === 0) {
    // Selected profile isn't the family rep — fall back to the family
    // rep's conventions (e.g. a future deepseek-v4-pro-mini would still
    // inherit V4-Pro's reasoner conventions).
    const family = profile.family ?? deriveFamilyFromModelId(profile.id);
    if (family) {
      const repId = familyRepId(family);
      if (repId && repId !== profile.id) {
        const repProfile = tryGetProfile(repId);
        if (repProfile && repProfile.archetypeConventions) {
          effective = repProfile.archetypeConventions;
        }
      }
    }
  }

  if (effective.length === 0) {
    return {
      value: { ir, cliffWarnings, structuredOutputHints },
      mutations,
    };
  }

  const archetype = ir.intent.archetype;
  const matching = effective.filter((c) => c.archetype === archetype);
  if (matching.length === 0) {
    return {
      value: { ir, cliffWarnings, structuredOutputHints },
      mutations,
    };
  }

  // Resolve family for the mutation id (informational; if we're inside a
  // family-rep profile, family is the same as profile-derived).
  const family = profile.family ?? deriveFamilyFromModelId(profile.id) ?? 'unknown';

  let nextIR = ir;
  for (const convention of matching) {
    let touched = false;

    // ── Prompt prefix → prepend to system message ──
    if (convention.promptPrefix) {
      const sections = nextIR.sections ?? [];
      // We insert as a new system-shaped section at index 0 OR prepend to
      // an existing system section's text. For idempotency, skip when the
      // prefix is already present at the head of any section.
      const alreadyPresent = sections.some((s) =>
        s.text.includes(convention.promptPrefix!),
      );
      if (!alreadyPresent) {
        const prefixSection = {
          id: `convention-prefix-${family}-${archetype}`,
          text: convention.promptPrefix,
        };
        nextIR = { ...nextIR, sections: [prefixSection, ...sections] };
        touched = true;
      }
    }

    // ── Prompt suffix → append to last user message in history (or to
    //    currentTurn when history has no user message) ──
    if (convention.promptSuffix) {
      const history = nextIR.history ?? [];
      // Find the LAST user-role message in history.
      let lastUserIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        const target = history[lastUserIdx]!;
        if (!target.content.endsWith(convention.promptSuffix)) {
          const newHistory = history.slice();
          newHistory[lastUserIdx] = {
            ...target,
            content: target.content + convention.promptSuffix,
          };
          nextIR = { ...nextIR, history: newHistory };
          touched = true;
        }
      } else if (nextIR.currentTurn && nextIR.currentTurn.role === 'user') {
        const target = nextIR.currentTurn;
        if (!target.content.endsWith(convention.promptSuffix)) {
          nextIR = {
            ...nextIR,
            currentTurn: {
              ...target,
              content: target.content + convention.promptSuffix,
            },
          };
          touched = true;
        }
      } else {
        // No user message anywhere — fall back to appending a synthetic
        // currentTurn so the forcing-function reaches the model. This
        // preserves the convention's contract even on degenerate IRs.
        nextIR = {
          ...nextIR,
          currentTurn: {
            role: 'user',
            content: convention.promptSuffix.trim(),
          },
        };
        touched = true;
      }
    }

    // ── Structured-output hint ──
    if (convention.structuredOutputHint) {
      const wantsStructured = !!nextIR.constraints?.structuredOutput;
      const shouldSurface =
        (convention.structuredOutputHint === 'avoid' && wantsStructured) ||
        (convention.structuredOutputHint === 'enforce' && !wantsStructured);
      if (shouldSurface) {
        structuredOutputHints.push({
          archetype,
          hint: convention.structuredOutputHint,
          reason: convention.reason,
        });
        if (convention.cliffWarning) {
          cliffWarnings.push(`${profile.id}: ${convention.cliffWarning}`);
        }
        touched = true;
      }
    }

    // ── Standalone cliffWarning (no structured-output gate) ──
    if (convention.cliffWarning && !convention.structuredOutputHint) {
      const toolCount = nextIR.tools?.length ?? 0;
      const thresholdOk =
        convention.whenToolCountAtLeast === undefined ||
        toolCount >= convention.whenToolCountAtLeast;
      if (thresholdOk) {
        cliffWarnings.push(`${profile.id}: ${convention.cliffWarning}`);
        touched = true;
      }
    }

    if (touched) {
      mutations.push({
        id: `apply-convention-${family}-${archetype}`,
        source: 'archetype_convention',
        passName: 'apply_conventions',
        description: `${profile.id}: applied ${family}-family convention for archetype=${archetype} — ${convention.reason}`,
      });
    }
  }

  return {
    value: { ir: nextIR, cliffWarnings, structuredOutputHints },
    mutations,
  };
}
