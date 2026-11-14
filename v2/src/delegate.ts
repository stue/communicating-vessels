/**
 * delegate — Release D, the R2 primitive (delegation-fanout accelerator §5.2,
 * design contract advisory/kgauto/2026-07-24_delegation-fanout-accelerator-design.md).
 *
 * A consumer-mountable TOOL the orchestrating model calls mid-loop:
 * `{ sub_archetype, input, quality_floor? }`. kgauto selects the executor
 * from evidence, runs the sub-call through the compiler + call(), returns
 * the result into the loop, links parent↔child rows (R0), and enforces
 * `policy.maxCostPerTraceUsd` against the running trace spend — the field
 * that shipped INERT in Release A precisely so this release could turn it on.
 *
 * THE AUTHORITY SPLIT IS THE CONTAINMENT (§3):
 *   - the MODEL decides whether and what to delegate (kgauto never
 *     decomposes uninvited — §10);
 *   - KGAUTO decides only who runs it — and never selects a model absent
 *     from the consumer's declared `ir.models`;
 *   - the CONSUMER consents: default OFF, `KGAUTO_AUTO_PROMOTE` posture
 *     (explicit option beats `KGAUTO_DELEGATE` env; neither ⇒ the handler
 *     refuses observably, never silently).
 *
 * Budget refusals and floor refusals are RETURNED to the model as
 * structured tool results, never thrown — the orchestrator must be able to
 * compose with what it has (a refusal mid-loop that crashes the loop would
 * convert a budget into an outage).
 *
 * Composition-verification (§7a): every sub-result is 'trusted' until the
 * orchestrator/consumer reports otherwise via `reportComposition` —
 * absence-of-report IS the recorded state (migration 052). Rung 3 reads
 * this to attribute composition failures to stitching, not executor choice.
 *
 * Trace-budget honesty (v1 limits, stated where consumers read):
 *   - the in-process ledger sums DELEGATED spend for this trace (parent's
 *     own root-call spend is not visible to a library ledger until a
 *     brain-informed ledger lands; documented on `maxCostPerTraceUsd`);
 *   - enforcement is estimate-ahead: a sub-call whose compile-time estimate
 *     would cross the ceiling is refused BEFORE any spend;
 *   - realized spend is computed from actual tokens × the executor
 *     profile's prices after each sub-call.
 */

import type { CallOptions, CallResult, CompilePolicy, PromptIR } from './ir.js';
import { CallError } from './ir.js';
import { call } from './call.js';
import { compile } from './compile.js';
import { ALL_ARCHETYPES, type IntentArchetypeName } from './dialect.js';
import { getArchetypePerfScore } from './archetype-perf-brain.js';
import { tryGetProfile } from './profiles.js';
import { readBrainReadEnv } from './env.js';

// ─────────────────────────────────────────────────────────────────────────
// Consent (KGAUTO_AUTO_PROMOTE posture: explicit beats env, default OFF)
// ─────────────────────────────────────────────────────────────────────────

export function isDelegateEnabledFromEnv(
  envSource?: Record<string, string | undefined>,
): boolean {
  const env =
    envSource ?? (typeof process !== 'undefined' && process.env ? process.env : {});
  const raw = (env.KGAUTO_DELEGATE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

// ─────────────────────────────────────────────────────────────────────────
// Tool surface
// ─────────────────────────────────────────────────────────────────────────

/** Arguments the ORCHESTRATING MODEL supplies when it calls the tool. */
export interface DelegateToolArgs {
  /** The sub-task's archetype — its own learning_key downstream. */
  sub_archetype: IntentArchetypeName | string;
  /** Complete, self-contained sub-task input. The model owns fidelity here
   *  (authority split): kgauto runs exactly what it is handed. */
  input: string;
  /**
   * Minimum archetype-perf score (0..10) the executor must carry for this
   * sub-archetype. Candidates below the floor are excluded BEFORE ranking;
   * if nothing in the parent's declared pool clears it, the tool refuses
   * with the scores so the model can lower the floor or do the work itself.
   */
  quality_floor?: number;
}

export type DelegateRefusalReason =
  | 'delegate_not_enabled'
  | 'invalid_sub_archetype'
  | 'no_qualified_executor'
  | 'trace_budget_exhausted'
  | 'call_failed';

export type DelegateResult =
  | {
      ok: true;
      /** The sub-result text (or serialized structured output). */
      output: string;
      /** Branch handle — pass to reportComposition; joins the brain row. */
      subHandle: string;
      executorModel: string;
      costUsd: number;
      latencyMs: number;
      /** Always 'trusted' at return time — flips only via reportComposition. */
      verification: 'trusted';
    }
  | {
      ok: false;
      reason: DelegateRefusalReason;
      /** Human/model-readable detail — written to be COMPOSABLE (“continue
       *  without this sub-result”), never a stack trace. */
      detail: string;
    };

/**
 * Provider-agnostic tool definition. Consumers adapt `inputSchema` to their
 * SDK's tool shape (AI-SDK `parameters`, Anthropic `input_schema`, …). The
 * description IS prompt surface — it teaches the model the authority split
 * and the compose-on-refusal discipline (gates 4/5 of discipline-gates-v1
 * in tool-description form).
 */
export const DELEGATE_TOOL_DEFINITION = {
  name: 'delegate',
  description:
    'Delegate a self-contained sub-task to a cheaper executor model chosen by kgauto from measured evidence. ' +
    'YOU decide what to delegate and supply a complete input; kgauto decides which model runs it (never outside the declared pool). ' +
    'The call may be refused (budget exhausted, no qualified executor) — on refusal, continue and compose with what you have. ' +
    'Verify sub-results before composing them into your answer; do not present unverified delegated content as checked.',
  inputSchema: {
    type: 'object',
    properties: {
      sub_archetype: {
        type: 'string',
        enum: ALL_ARCHETYPES,
        description: 'What kind of work the sub-task is (its routing archetype).',
      },
      input: {
        type: 'string',
        description: 'Complete, self-contained sub-task input. Include everything the executor needs — it sees nothing else.',
      },
      quality_floor: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description: 'Optional minimum executor quality score (0-10) for this archetype. Omit to accept the evidence-ranked default.',
      },
    },
    required: ['sub_archetype', 'input'],
    additionalProperties: false,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────

export interface CreateDelegateOpts {
  /** The PARENT call's IR — supplies the declared model pool (the containment
   *  boundary), appId, and dialect context. */
  parentIr: PromptIR;
  /** The parent's compile/call handle — R0 linkage root. Branch rows record
   *  `parent_handle=<this>` and inherit `trace_id`. */
  parentHandle: string;
  /**
   * Options forwarded to the sub-`call()` (apiKeys, fetchImpl,
   * attemptTimeoutMs, policy…). `policy.maxCostPerTraceUsd` here is what the
   * ledger enforces. `parentHandle` is set by the factory — a value passed
   * in callOpts is overridden.
   */
  callOpts?: CallOptions & { policy?: CompilePolicy };
  /** Explicit consent — beats KGAUTO_DELEGATE env (AUTO_PROMOTE posture). */
  enabled?: boolean;
}

export interface DelegateHandle {
  toolDefinition: typeof DELEGATE_TOOL_DEFINITION;
  handler: (args: DelegateToolArgs) => Promise<DelegateResult>;
  /**
   * §7a — report what the orchestrator did with a sub-result. Writes a
   * migration-052 row via the brain-read env trio (RLS-scoped to appId).
   * Unreported sub-results are 'trusted' by definition — report only
   * 'verified' and 'discarded'.
   */
  reportComposition: (report: {
    subHandle: string;
    disposition: 'verified' | 'discarded';
    note?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** Ledger introspection: delegated spend recorded for this trace so far. */
  traceSpendUsd: () => number;
}

export function createDelegate(opts: CreateDelegateOpts): DelegateHandle {
  const { parentIr, parentHandle } = opts;
  const enabled = opts.enabled ?? isDelegateEnabledFromEnv();
  const budget = opts.callOpts?.policy?.maxCostPerTraceUsd;

  // In-process per-trace ledger. v1 scope: delegated spend only (see module
  // docblock). Keyed by the factory instance — one factory per parent call.
  let spentUsd = 0;

  async function handler(args: DelegateToolArgs): Promise<DelegateResult> {
    if (!enabled) {
      return {
        ok: false,
        reason: 'delegate_not_enabled',
        detail:
          'Delegation is not enabled for this consumer (KGAUTO_DELEGATE / CreateDelegateOpts.enabled). Do the sub-task yourself.',
      };
    }

    const archetype = args.sub_archetype as IntentArchetypeName;
    if (!ALL_ARCHETYPES.includes(archetype)) {
      return {
        ok: false,
        reason: 'invalid_sub_archetype',
        detail: `Unknown sub_archetype '${String(args.sub_archetype)}'. Valid: ${ALL_ARCHETYPES.join(', ')}. Re-classify or do the sub-task yourself.`,
      };
    }

    // Quality floor: exclude below-floor candidates BEFORE ranking. The pool
    // is the PARENT's declared models — the containment boundary (§3).
    // Family entries ({family}) pass through untouched — compile resolves
    // them itself; the floor filters only the concretely-named ids (a
    // family's resolved primary is by definition its newest current, which
    // a floor rarely targets; documented limitation, not silent).
    const pool = parentIr.models;
    const concreteIds = pool.filter((m): m is string => typeof m === 'string');
    let blockedByFloor: string[] = [];
    if (typeof args.quality_floor === 'number') {
      blockedByFloor = concreteIds.filter(
        (m) => getArchetypePerfScore(m, archetype).score < args.quality_floor!,
      );
      if (blockedByFloor.length === pool.length) {
        const scores = concreteIds
          .map((m) => `${m}=${getArchetypePerfScore(m, archetype).score}`)
          .join(', ');
        return {
          ok: false,
          reason: 'no_qualified_executor',
          detail: `No model in the declared pool clears quality_floor=${args.quality_floor} for '${archetype}' (${scores}). Lower the floor or do the sub-task yourself.`,
        };
      }
    }

    const subIr: PromptIR = {
      appId: parentIr.appId,
      intent: { name: `delegate:${archetype}`, archetype },
      sections: [{ id: 'delegated-task', text: args.input }],
      currentTurn: { role: 'user', content: args.input },
      models: pool,
    } as PromptIR;

    const mergedPolicy: CompilePolicy = {
      ...(opts.callOpts?.policy ?? {}),
      blockedModels: [
        ...(opts.callOpts?.policy?.blockedModels ?? []),
        ...blockedByFloor,
      ],
    };

    // Estimate-ahead budget enforcement: refuse BEFORE any spend when the
    // compile-time estimate would cross the ceiling. compile() is free.
    if (typeof budget === 'number' && budget > 0) {
      let estimate = 0;
      try {
        estimate = compile(subIr, { policy: mergedPolicy }).estimatedCostUsd;
      } catch {
        estimate = 0; // estimation failure never blocks; realized spend still counts
      }
      if (spentUsd + estimate > budget) {
        return {
          ok: false,
          reason: 'trace_budget_exhausted',
          detail:
            `Trace budget $${budget.toFixed(4)} would be exceeded ` +
            `(spent $${spentUsd.toFixed(4)} + estimated $${estimate.toFixed(4)}). ` +
            'Compose your answer from the sub-results you already have.',
        };
      }
    }

    let result: CallResult;
    try {
      result = await call(subIr, {
        ...(opts.callOpts ?? {}),
        policy: mergedPolicy,
        parentHandle, // R0 linkage — branch row, trace_id = parent
      } as CallOptions);
    } catch (err) {
      const detail =
        err instanceof CallError
          ? `Sub-call failed after ${err.attempts.length} attempt(s): ${err.attempts.map((a) => a.errorCode).join(' → ')}.`
          : String(err);
      return {
        ok: false,
        reason: 'call_failed',
        detail: `${detail} Compose without this sub-result or retry with different input.`,
      };
    }

    // Realized spend: actual tokens × the SERVING model's profile prices.
    const profile = tryGetProfile(result.actualModel);
    const costUsd = profile
      ? (result.response.tokens.input / 1_000_000) * profile.costInputPer1m +
        (result.response.tokens.output / 1_000_000) * profile.costOutputPer1m
      : 0;
    spentUsd += costUsd;

    return {
      ok: true,
      output:
        result.response.structuredOutput !== null
          ? JSON.stringify(result.response.structuredOutput)
          : result.response.text,
      subHandle: result.handle,
      executorModel: result.actualModel,
      costUsd,
      latencyMs: result.latencyMs,
      verification: 'trusted',
    };
  }

  async function reportComposition(report: {
    subHandle: string;
    disposition: 'verified' | 'discarded';
    note?: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const env = readBrainReadEnv();
    if (!env.endpoint || !env.jwt || !env.anonKey) {
      return { ok: false, reason: `brain_read_not_configured:${env.missingEnv.join(',')}` };
    }
    try {
      const res = await fetch(
        `${env.endpoint.replace(/\/$/, '')}/rest/v1/kgauto_composition_reports`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.jwt}`,
            apikey: env.anonKey,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            app_id: parentIr.appId,
            sub_handle: report.subHandle,
            disposition: report.disposition,
            ...(report.note ? { note: report.note } : {}),
          }),
        },
      );
      if (!res.ok) return { ok: false, reason: `write_failed:${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `network_error:${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return {
    toolDefinition: DELEGATE_TOOL_DEFINITION,
    handler,
    reportComposition,
    traceSpendUsd: () => spentUsd,
  };
}
