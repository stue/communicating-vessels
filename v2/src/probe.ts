/**
 * `@warmdrift/kgauto-compiler/probe` — guard-probe-suite compile surface.
 *
 * ## This subpath exists for the probe suite. Do not serve traffic with it.
 *
 * A guard must be suppressible to be testable: an active cliff suppresses
 * exactly the evidence that would validate it (the summarize+tools guard
 * strips the tools, so no organic traffic ever sends that shape again —
 * which is why 15 of 17 behavioural guards sat unvalidated with an "n≥20
 * brain evidence" release condition that was structurally never coming).
 * `compileSuppressing` compiles with NAMED cliffs removed so a probe can
 * deliberately send the bad shape.
 *
 * The subpath boundary IS the fence (Phase-0 decision: an env-var gate on a
 * library export is theater). Importing this in a serving path forfeits the
 * named guard for that call — nothing else protects the consumer. The main
 * export carries no suppression affordance; the tests pin that.
 */

import { compile, type CompileOptions } from './compile.js';
import { getProfile, type CliffRule, type ModelProfile } from './profiles.js';
import type { CompileResult, PromptIR } from './ir.js';

export { deriveCliffEvidenceClass } from './profiles.js';
// alpha.103 — the cliff pass itself, for counterfactual gates (a smoke must be
// able to show that a probed/FLAGGED reducer is withheld).
export { passApplyCliffs } from './passes.js';
export type { CliffEvidence, CliffRule } from './profiles.js';

export interface CliffSelector {
  /** Canonical model id whose profile carries the guard. */
  model: string;
  /** The cliff's metric — with `whenIntent`, identifies the guard. */
  metric: CliffRule['metric'];
  /** Narrow to an intent-scoped guard; absent matches any `whenIntent`. */
  whenIntent?: string;
}

export interface CompileSuppressingOptions extends CompileOptions {
  /** The guards to suppress. Every other cliff keeps firing. */
  suppress: CliffSelector[];
}

/**
 * compile() with the named guards removed from the resolved profiles.
 * Refuses (throws) when a selector matches no cliff on its model — a probe
 * that silently "suppresses" a guard that never existed would convict the
 * wrong hypothesis.
 */
export function compileSuppressing(ir: PromptIR, opts: CompileSuppressingOptions): CompileResult {
  const { suppress, profileResolver, ...rest } = opts;
  const base = profileResolver ?? getProfile;

  for (const sel of suppress) {
    const p = base(sel.model);
    const hit = p.cliffs.some(
      (c) => c.metric === sel.metric && (sel.whenIntent === undefined || c.whenIntent === sel.whenIntent),
    );
    if (!hit) {
      throw new Error(
        `compileSuppressing: no cliff {metric: ${sel.metric}${sel.whenIntent ? `, whenIntent: ${sel.whenIntent}` : ''}} on ${sel.model} — refusing to "suppress" a guard that does not exist`,
      );
    }
  }

  // A probe authors the exact bad shape and must see it reach the wire —
  // the tool-relevance pass would silently trim a synthetic tool ladder
  // (thin descriptions score low), converting "guard suppressed" into
  // "different pass ate the shape" and convicting the wrong hypothesis.
  // Overridable, but the probe-correct default is off.
  const toolRelevanceThreshold = rest.toolRelevanceThreshold ?? 0;

  const resolver = (id: string): ModelProfile => {
    const p = base(id);
    const sels = suppress.filter((s) => s.model === id || s.model === p.id);
    if (sels.length === 0) return p;
    return {
      ...p,
      cliffs: p.cliffs.filter(
        (c) =>
          !sels.some(
            (s) => s.metric === c.metric && (s.whenIntent === undefined || c.whenIntent === s.whenIntent),
          ),
      ),
    };
  };

  return compile(ir, { ...rest, toolRelevanceThreshold, profileResolver: resolver });
}
