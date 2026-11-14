/**
 * Release C (Rung 1) — the decomposition coach's planning engine.
 *
 * Design contract §5.1: evidence-backed advisories on the existing surface —
 * "you're paying frontier prices for grunt work; here's the measured split."
 * No contract change; nothing here executes a fan-out. This module is PURE:
 * templates + arithmetic. The operator script feeds it measured surface
 * stats and evidence-picked executors; Release D's `delegate` primitive will
 * consume the SAME templates, so they live in the library, versioned.
 *
 * Honesty posture (the roster-with-receipts rule, applied to ourselves):
 *
 *   - The per-step token SHARES are JUDGMENT v1 numbers — labelled as such
 *     in every plan (`assumptions[]`), versioned so a future measured
 *     replacement invalidates nothing silently. No consumer has fan-out
 *     traffic yet (R0 shipped alpha.68, zero adopters), so there is nothing
 *     to measure them from; the moment branch traffic exists, these
 *     graduate per surface.
 *   - Executor grounding is carried per step: 'measured' when the portfolio
 *     corpus has real outcomes for (model, sub-archetype), 'judgment' when
 *     the roster's archetypePerf is all we have.
 *   - The coach's most credible output at low volume is "KEEP THE MONOLITH"
 *     with the break-even volume stated — the never-worse floor in coach
 *     form. The advisory only files when the split is MATERIAL (same $5/mo
 *     felt-utility floor as promotions); the demo report renders every
 *     analysis either way.
 */

import type { IntentArchetypeName } from './dialect.js';

// ─────────────────────────────────────────────────────────────────────────
// Templates — versioned judgment, v1
// ─────────────────────────────────────────────────────────────────────────

export const DECOMPOSITION_TEMPLATES_VERSION = 'decomposition-templates-v1';

export interface DecompositionStep {
  /** Human-readable step name (stable — appears in advisories/recipes). */
  role: string;
  /** The sub-archetype this step runs as (its own learning_key downstream). */
  archetype: IntentArchetypeName;
  /**
   * Which tier runs the step. 'delegate' steps are the grunt work the coach
   * proposes moving to a cheap executor; 'anchor' steps stay on the
   * incumbent (composition is where fan-outs die — §7a — so the composer
   * anchors on the strong model by design).
   */
  tier: 'delegate' | 'anchor';
  /** Share of the monolith's INPUT tokens this step reads. JUDGMENT v1. */
  inputShare: number;
  /**
   * Tokens this step EMITS, as a share of the monolith's input (for
   * intermediate artifacts like extraction notes) — the next anchor step
   * reads these instead of the raw input. JUDGMENT v1.
   */
  emitsShareOfInput: number;
  /** Share of the monolith's OUTPUT tokens this step produces (0 for
   * intermediate steps; the anchor composer typically carries 1). */
  outputShare: number;
}

export interface DecompositionTemplate {
  archetype: IntentArchetypeName;
  steps: DecompositionStep[];
  rationale: string;
  version: typeof DECOMPOSITION_TEMPLATES_VERSION;
}

/**
 * v1 covers the three judgment-heavy archetypes with a clear split shape.
 * Every share number below is a judgment estimate, stated in the plan's
 * assumptions — they exist to make the ARITHMETIC honest, not to claim
 * precision the corpus doesn't have yet.
 */
export const DECOMPOSITION_TEMPLATES: Partial<
  Record<IntentArchetypeName, DecompositionTemplate>
> = {
  summarize: {
    archetype: 'summarize',
    version: DECOMPOSITION_TEMPLATES_VERSION,
    rationale:
      'A long-input summarize is mostly reading. A cheap extractor reads the ' +
      'full payload and emits compressed notes; the incumbent composes the ' +
      'summary from the notes — frontier tokens are spent only on the part ' +
      'that needs frontier judgment.',
    steps: [
      {
        role: 'chunk-extract',
        archetype: 'extract',
        tier: 'delegate',
        inputShare: 1.0,
        emitsShareOfInput: 0.15,
        outputShare: 0,
      },
      {
        role: 'compose',
        archetype: 'summarize',
        tier: 'anchor',
        inputShare: 0.15, // reads the notes, not the raw payload
        emitsShareOfInput: 0,
        outputShare: 1.0,
      },
    ],
  },
  hunt: {
    archetype: 'hunt',
    version: DECOMPOSITION_TEMPLATES_VERSION,
    rationale:
      'Hunt decomposes into breadth (search sweeps), mechanical harvesting ' +
      '(extraction), and judgment (dedupe + compose). The sweeps and the ' +
      'harvest are grunt work; the composition anchors on the incumbent.',
    steps: [
      {
        role: 'search-sweep',
        archetype: 'hunt',
        tier: 'delegate',
        inputShare: 0.5,
        emitsShareOfInput: 0.2,
        outputShare: 0,
      },
      {
        role: 'harvest',
        archetype: 'extract',
        tier: 'delegate',
        inputShare: 0.35,
        emitsShareOfInput: 0.1,
        outputShare: 0,
      },
      {
        role: 'dedupe-compose',
        archetype: 'judge',
        tier: 'anchor',
        inputShare: 0.3, // sweep notes + harvest notes
        emitsShareOfInput: 0,
        outputShare: 1.0,
      },
    ],
  },
  plan: {
    archetype: 'plan',
    version: DECOMPOSITION_TEMPLATES_VERSION,
    rationale:
      'Planning splits into context-gathering (mechanical reading) and the ' +
      'plan itself (judgment). The gatherer reads the corpus and briefs; the ' +
      'incumbent plans from the brief.',
    steps: [
      {
        role: 'gather-brief',
        archetype: 'extract',
        tier: 'delegate',
        inputShare: 1.0,
        emitsShareOfInput: 0.2,
        outputShare: 0,
      },
      {
        role: 'draft-plan',
        archetype: 'plan',
        tier: 'anchor',
        inputShare: 0.2,
        emitsShareOfInput: 0,
        outputShare: 1.0,
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Planner
// ─────────────────────────────────────────────────────────────────────────

export interface SurfaceStats {
  appId: string;
  archetype: IntentArchetypeName | string;
  /** The model serving the monolith today (most-served in the window). */
  incumbentModel: string;
  nCalls: number;
  windowDays: number;
  avgTokensIn: number;
  avgTokensOut: number;
}

export interface ExecutorCandidate {
  modelId: string;
  /** archetypePerf score on the STEP's archetype. */
  perfScore: number;
  grounding: 'measured' | 'judgment';
  costInputPer1m: number;
  costOutputPer1m: number;
}

export interface ModelPricing {
  costInputPer1m: number;
  costOutputPer1m: number;
}

export interface PlannedStep extends DecompositionStep {
  /** The picked executor ('delegate' steps) or the incumbent ('anchor'). */
  executorModel: string;
  executorGrounding: 'measured' | 'judgment';
  executorPerfScore: number | null;
  projectedCostPerCallUsd: number;
}

export interface DecompositionPlan {
  appId: string;
  archetype: string;
  incumbentModel: string;
  template: DecompositionTemplate;
  steps: PlannedStep[];
  monolithCostPerCallUsd: number;
  splitCostPerCallUsd: number;
  savingPerCallUsd: number;
  monthlyCalls: number;
  projectedMonthlySavingUsd: number;
  /** Monthly calls at which the split clears the materiality floor. null
   * when the split doesn't save per-call at all (then no volume helps). */
  breakEvenMonthlyCalls: number | null;
  verdict: 'split-pays' | 'keep-monolith';
  verdictReason: string;
  /** Judgment inputs, stated. Every number that is not measured is here. */
  assumptions: string[];
}

export const COACH_CFG = {
  /** Same felt-utility floor as promotions (alpha.67 family). */
  minMonthlySavingUsd: 5,
  /** Executor must clear this archetypePerf on the step's archetype —
   * same floor as the translator/advisor (ARCHETYPE_FLOOR_DEFAULT). */
  executorPerfFloor: 6,
  daysPerMonth: 30,
};

export interface PlanDecompositionArgs {
  stats: SurfaceStats;
  incumbentPricing: ModelPricing;
  /**
   * Evidence-picked executor per step archetype. Return undefined when no
   * candidate clears the perf floor — the plan then keeps that step on the
   * incumbent and says so (a coach must not route grunt work to a model
   * that can't do it just because it is cheap).
   */
  pickExecutor: (archetype: IntentArchetypeName) => ExecutorCandidate | undefined;
  cfg?: Partial<typeof COACH_CFG>;
}

export function planDecomposition(
  args: PlanDecompositionArgs,
): DecompositionPlan | undefined {
  const { stats, incumbentPricing, pickExecutor } = args;
  const cfg = { ...COACH_CFG, ...(args.cfg ?? {}) };
  const template =
    DECOMPOSITION_TEMPLATES[stats.archetype as IntentArchetypeName];
  if (!template) return undefined;

  const perCall = (
    pricing: ModelPricing,
    tokensIn: number,
    tokensOut: number,
  ): number =>
    (tokensIn / 1_000_000) * pricing.costInputPer1m +
    (tokensOut / 1_000_000) * pricing.costOutputPer1m;

  const monolithCostPerCallUsd = perCall(
    incumbentPricing,
    stats.avgTokensIn,
    stats.avgTokensOut,
  );

  const assumptions: string[] = [
    `per-step token shares are ${template.version} JUDGMENT numbers — no fan-out traffic exists to measure them from yet; they graduate per surface when branch traffic lands`,
  ];

  const steps: PlannedStep[] = [];
  let splitCostPerCallUsd = 0;
  for (const step of template.steps) {
    const stepTokensIn = stats.avgTokensIn * step.inputShare;
    const stepTokensOut =
      stats.avgTokensIn * step.emitsShareOfInput +
      stats.avgTokensOut * step.outputShare;

    if (step.tier === 'anchor') {
      const cost = perCall(incumbentPricing, stepTokensIn, stepTokensOut);
      splitCostPerCallUsd += cost;
      steps.push({
        ...step,
        executorModel: stats.incumbentModel,
        executorGrounding: 'measured', // the incumbent IS the measured baseline
        executorPerfScore: null,
        projectedCostPerCallUsd: cost,
      });
      continue;
    }

    const candidate = pickExecutor(step.archetype);
    // Delegating a step to the incumbent itself is not a delegation — it is
    // the monolith wearing a recipe. When the cheapest qualified executor IS
    // the incumbent, the step anchors and says so (this is the common case
    // on surfaces the downswap machinery already moved to a cheap model).
    if (candidate && candidate.modelId === stats.incumbentModel) {
      const cost = perCall(incumbentPricing, stepTokensIn, stepTokensOut);
      splitCostPerCallUsd += cost;
      steps.push({
        ...step,
        tier: 'anchor',
        executorModel: stats.incumbentModel,
        executorGrounding: candidate.grounding,
        executorPerfScore: candidate.perfScore,
        projectedCostPerCallUsd: cost,
      });
      assumptions.push(
        `step '${step.role}': the cheapest qualified executor IS the incumbent — nothing to delegate to`,
      );
      continue;
    }
    if (!candidate || candidate.perfScore < cfg.executorPerfFloor) {
      // No qualified cheap executor for this step: it stays on the
      // incumbent, honestly — which shrinks the saving instead of
      // fabricating one.
      const cost = perCall(incumbentPricing, stepTokensIn, stepTokensOut);
      splitCostPerCallUsd += cost;
      steps.push({
        ...step,
        tier: 'anchor',
        executorModel: stats.incumbentModel,
        executorGrounding: 'measured',
        executorPerfScore: candidate?.perfScore ?? null,
        projectedCostPerCallUsd: cost,
      });
      assumptions.push(
        `step '${step.role}' (${step.archetype}): no executor clears the perf floor ${cfg.executorPerfFloor} — kept on the incumbent`,
      );
      continue;
    }

    const cost = perCall(candidate, stepTokensIn, stepTokensOut);
    splitCostPerCallUsd += cost;
    steps.push({
      ...step,
      executorModel: candidate.modelId,
      executorGrounding: candidate.grounding,
      executorPerfScore: candidate.perfScore,
      projectedCostPerCallUsd: cost,
    });
    if (candidate.grounding === 'judgment') {
      assumptions.push(
        `step '${step.role}': ${candidate.modelId} perf ${candidate.perfScore}/10 on ${step.archetype} is JUDGMENT-grounded (no measured portfolio outcomes for the tuple yet)`,
      );
    }
  }

  const savingPerCallUsd = monolithCostPerCallUsd - splitCostPerCallUsd;
  const monthlyCalls = (stats.nCalls / stats.windowDays) * cfg.daysPerMonth;
  const projectedMonthlySavingUsd = savingPerCallUsd * monthlyCalls;
  const breakEvenMonthlyCalls =
    savingPerCallUsd > 0 ? cfg.minMonthlySavingUsd / savingPerCallUsd : null;

  let verdict: DecompositionPlan['verdict'];
  let verdictReason: string;
  if (savingPerCallUsd <= 0) {
    verdict = 'keep-monolith';
    verdictReason =
      'the split costs MORE per call than the monolith at current pricing — no volume makes it pay';
  } else if (projectedMonthlySavingUsd < cfg.minMonthlySavingUsd) {
    verdict = 'keep-monolith';
    verdictReason =
      `the split pays $${projectedMonthlySavingUsd.toFixed(2)}/mo at your ~${Math.round(monthlyCalls)} calls/mo — ` +
      `below the $${cfg.minMonthlySavingUsd} felt-utility floor. Break-even is ~${Math.ceil(breakEvenMonthlyCalls ?? 0)} calls/mo; ` +
      `revisit when volume gets there. Decomposition adds moving parts, and a saving you can't feel doesn't buy them`;
  } else {
    verdict = 'split-pays';
    verdictReason =
      `projected $${projectedMonthlySavingUsd.toFixed(2)}/mo saving at ~${Math.round(monthlyCalls)} calls/mo ` +
      `(monolith $${monolithCostPerCallUsd.toFixed(4)}/call → split $${splitCostPerCallUsd.toFixed(4)}/call)`;
  }

  return {
    appId: stats.appId,
    archetype: String(stats.archetype),
    incumbentModel: stats.incumbentModel,
    template,
    steps,
    monolithCostPerCallUsd,
    splitCostPerCallUsd,
    savingPerCallUsd,
    monthlyCalls,
    projectedMonthlySavingUsd,
    breakEvenMonthlyCalls,
    verdict,
    verdictReason,
    assumptions,
  };
}
