/**
 * advisor-rules/promote-ready — alpha.41 compile-time advisor.
 *
 * Fires when: the per-tenant `promote_ready_findings` cache has one or more
 * OPEN findings (resolved_at IS NULL) for the current `(app_id, archetype,
 * family-of-resolved-primary)` tuple AND the finding's metrics clear the
 * dual-threshold gate (judge_pass_rate >= 0.8 AND judge_avg_score >= 4.0).
 *
 * Why: the `promotion-probe-watcher` (Mode 2) runs autonomous shadow probes
 * of new candidate models against recent consumer traffic. When a candidate
 * clears the quality + cost bar, a row lands in `promote_ready_findings`.
 * This rule surfaces that signal at compile() time so consumers see the
 * recommendation in `result.advisories[]` without polling the operator-side
 * coordination digest.
 *
 * Builder B owns this file (alpha.41 Phase 0 contract). Builder A wires the
 * rule into the advisor pipeline via `advisor-rules/index.ts`.
 *
 * Severity: `info`. The advisory is a recommendation; consumer acts via
 * `markPromoteReadyHandled({ resolution: 'promoted' })` once they've
 * migrated.
 *
 * Silent when:
 *   - the promote-ready brain runtime isn't active (consumer opted out)
 *   - no IR appId
 *   - the resolved primary's family is unknown (deriveFamily returns null)
 *   - no findings exist for the (appId, archetype, family) tuple
 *   - the matching finding's metrics don't clear the dual-threshold gate
 *   - the matching finding's `current_model` doesn't equal the resolved
 *     primary (per contract spec: the rule fires only when the IR is
 *     actually running the model the probe was comparing against)
 */

import type { BestPracticeAdvisory } from '../ir.js';
import {
  loadPromoteReadyFindings,
  isPromoteReadyBrainActive,
  type PromoteReadyFindingRow,
} from '../promote-ready-brain.js';

/**
 * Quality thresholds the finding must clear before the advisory surfaces.
 * Mirrors the dual gate the `promotion-probe-watcher` (Mode 2) uses to
 * decide whether to INSERT/UPSERT a finding row in the first place — the
 * advisor rule re-applies the same gate at read-time so a finding row that
 * predates a threshold bump won't fire if it would no longer qualify.
 */
export const PROMOTE_READY_THRESHOLDS = {
  minPassRate: 0.8,
  minAvgScore: 4.0,
} as const;

/**
 * Pure-predicate: does this finding meet the bar to fire an advisory?
 * Exported so the cron / watcher can reuse the same gate when deciding
 * whether to UPSERT.
 *
 * @param finding   row from `promote_ready_findings` (camelCase shape)
 * @param resolvedPrimary  the model the IR will actually run (post family-
 *                         resolution if the IR carried a `{ family: ... }`
 *                         entry; the literal otherwise)
 */
export function shouldFirePromoteReady(
  finding: PromoteReadyFindingRow,
  resolvedPrimary: string,
): boolean {
  if (finding.currentModel !== resolvedPrimary) return false;
  if (finding.judgePassRate < PROMOTE_READY_THRESHOLDS.minPassRate) return false;
  if (finding.judgeAvgScore < PROMOTE_READY_THRESHOLDS.minAvgScore) return false;
  return true;
}

/**
 * Inlined mirror of Builder A's `deriveFamilyFromModelId` AND migration
 * 024's CASE statement. Phase 2 reconciliation (per contract G3 + Phase 2
 * step 3) audits these three sources stay aligned; MIGRATION WINS on drift.
 *
 * Kept local here so the rule has zero dependency on Builder A's file
 * landing first. Once Builder A's family-resolution.ts ships, this helper
 * can be deleted in a Phase 2 cleanup and the rule can import from there.
 */
function deriveFamilyLocal(modelId: string): string | null {
  if (modelId.startsWith('claude-opus-')) return 'claude-opus';
  if (modelId.startsWith('claude-sonnet-')) return 'claude-sonnet';
  if (modelId.startsWith('claude-haiku-')) return 'claude-haiku';
  // Narrower gemini patterns precede broader — order matters.
  if (/^gemini-.*-flash-lite/.test(modelId)) return 'gemini-flash-lite';
  if (/^gemini-.*-flash/.test(modelId)) return 'gemini-flash';
  if (/^gemini-.*-pro/.test(modelId)) return 'gemini-pro';
  if (/^deepseek-.*-pro/.test(modelId)) return 'deepseek-reasoner';
  if (modelId.startsWith('deepseek-')) return 'deepseek-chat';
  if (modelId.startsWith('gpt-')) return 'openai-gpt';
  return null;
}

/**
 * Context the rule needs at compile time. Builder A's advisor wiring
 * supplies appId, archetype, and the resolved primary model id (after
 * family-resolution if applicable). Keeping the shape opt-in lets the rule
 * stay independent of Builder A's exact pipeline shape.
 */
export interface PromoteReadyContext {
  /** The consumer's app_id. */
  appId: string | undefined;
  /** The intent archetype on the IR. */
  archetype: string;
  /** The model id the IR will actually run for this call (after family
   *  resolution). */
  resolvedPrimary: string;
}

/**
 * advisorRulePromoteReady — named export consumed by Builder A's
 * `advisor-rules/index.ts` per G2 in the Phase 0 contract.
 *
 * Returns `BestPracticeAdvisory[]` so it composes with the existing
 * advisor pipeline (every rule returns an array; empty array = no fire).
 */
export function advisorRulePromoteReady(
  ctx: PromoteReadyContext,
): BestPracticeAdvisory[] {
  if (!isPromoteReadyBrainActive()) return [];
  if (!ctx.appId) return [];
  if (!ctx.resolvedPrimary) return [];

  const family = deriveFamilyLocal(ctx.resolvedPrimary);
  if (!family) return [];

  const findings = loadPromoteReadyFindings({
    appId: ctx.appId,
    archetype: ctx.archetype,
    family,
  });
  if (findings.length === 0) return [];

  // Pick the strongest qualifying finding: highest judge_avg_score, tie-
  // break on judge_pass_rate desc. Only fires if at least one qualifying
  // finding's current_model matches the resolved primary AND clears the
  // dual gate.
  const qualifying = findings.filter((f) =>
    shouldFirePromoteReady(f, ctx.resolvedPrimary),
  );
  if (qualifying.length === 0) return [];

  qualifying.sort((a, b) => {
    if (a.judgeAvgScore !== b.judgeAvgScore) {
      return b.judgeAvgScore - a.judgeAvgScore;
    }
    return b.judgePassRate - a.judgePassRate;
  });
  const top = qualifying[0]!;

  // Build the message per contract spec.
  const pctPass = Math.round(top.judgePassRate * 100);
  const score = top.judgeAvgScore.toFixed(2);
  let costClause = '';
  if (top.costDeltaPct !== null) {
    const sign = top.costDeltaPct < 0 ? 'cheaper' : 'more expensive';
    const magnitude = Math.abs(top.costDeltaPct * 100).toFixed(1);
    costClause = `, cost ${magnitude}% ${sign}`;
  }

  const message =
    `Probe found ${top.candidateModel} produces equivalent-or-better outputs ` +
    `vs ${top.currentModel} on ${top.sampleN} recent ${top.archetype} prompts ` +
    `(pass rate ${pctPass}%, avg score ${score}/5${costClause}). ` +
    `Consider promoting via markPromoteReadyHandled.`;

  return [
    {
      level: 'info',
      code: 'promote-ready',
      message,
      suggestion:
        `Migrate ${top.archetype} traffic from ${top.currentModel} to ${top.candidateModel}, ` +
        `then call markPromoteReadyHandled({ appId, archetype: '${top.archetype}', ` +
        `family: '${top.family}', resolution: 'promoted' }) to silence this advisory.`,
      // alpha.36 architectural field — not a no-ai-needed case.
      recommendedArchitecture: undefined,
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}
