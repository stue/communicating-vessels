/**
 * advisor-rules/cross-family-fit — alpha.43 compile-time advisor.
 *
 * Fires when ALL hold at compile time:
 *   - `request.intent_archetype` matches an entry in `ARCHETYPE_FAMILY_FITS`
 *     (today: `plan`, `critique`).
 *   - The selected model's family does NOT match the better-fit family for
 *     that archetype.
 *   - The better-fit family has at least one model available in the bundled
 *     registry whose `status === 'current'` AND `active !== false`.
 *
 * Severity: `info`. This is a POSITIVE recommendation, not a problem
 * detection. The advisory tells the consumer "your call is fine, but a
 * different family would deliver better quality + cost at this archetype."
 *
 * Ownership: `consumer-actionable`. The fix is on the consumer side
 * (swap the model literal in `ir.models` or call
 * `getRecommendedPrimary({ family: '<better-fit-family>' })`). kgauto can't
 * make the swap for them — consumer policy gates which families they trust.
 *
 * Strategic framing (Sacha, 2026-05-28): "Volume can increase quickly if
 * tools is great to use, let's not create future bottlenecks because we
 * could have wired in better solution at moment of knowing." This rule
 * embodies that principle — fires regardless of current volume, surfaces
 * the better fit at moment of knowing.
 *
 * Silent when:
 *   - the IR's archetype isn't in the ARCHETYPE_FAMILY_FITS table
 *   - the consumer is already on the better-fit family (already taking the win)
 *   - no model in the better-fit family is `current + active` in the
 *     registry (would be a recommendation the consumer can't act on)
 *
 * Complement to (not overlap with) the alpha.41 `promote-ready` advisor:
 *   - promote-ready: per-(app, archetype, family) brain-evidence-backed
 *     swap recommendation from the probe-watcher's empirical findings.
 *   - cross-family-fit: per-archetype architectural-fit recommendation from
 *     the static `ARCHETYPE_FAMILY_FITS` table. No brain dependency.
 *
 * Both can fire on the same call (different codes, different evidence
 * sources); consumer policy picks how to surface.
 */

import type { BestPracticeAdvisory } from '../ir.js';
import { ARCHETYPE_FAMILY_FITS, findBetterFit } from '../archetype-fits.js';
import { deriveFamilyFromModelId } from '../family-resolution.js';
import { allProfiles } from '../profiles.js';

/**
 * Context the rule needs at compile time. Mirrors the
 * `advisorRulePromoteReady` shape — fed by the advisor pipeline in
 * `advisor.ts` from the IR + selected profile.
 */
export interface CrossFamilyFitContext {
  /** Intent archetype on the IR. */
  archetype: string;
  /** The model id the IR will actually run for this call (post family resolution). */
  resolvedPrimary: string;
}

/**
 * Pure predicate: does the better-fit family have at least one current+
 * active model in the bundled registry? Read by the rule before firing —
 * never surface a recommendation the consumer can't act on.
 *
 * Note on brain integration: alpha.43 reads the bundled `allProfiles()`
 * roster. When `loadModelsFromBrain` populates additional models at runtime,
 * those flow through via the same `allProfiles()` (the registry merges
 * brain rows with bundled). Future work: when family-availability checks
 * become hot path, swap to a memoized index keyed on family tag.
 */
export function familyHasCurrentActiveModel(family: string): boolean {
  for (const profile of allProfiles()) {
    const profileFamily = profile.family ?? deriveFamilyFromModelId(profile.id);
    if (profileFamily !== family) continue;
    if (profile.status !== 'current') continue;
    if (profile.active === false) continue;
    return true;
  }
  return false;
}

/**
 * Pure helper: list current+active candidate model ids in the better-fit
 * family. Returned to the advisory message + evidence so the consumer can
 * pick from real options instead of being told "use this family" abstractly.
 *
 * Caps at 3 entries to keep the advisory message readable; consumers needing
 * the full set can call `allProfiles().filter(p => ... )` themselves.
 */
export function listCandidatesInFamily(family: string): string[] {
  const candidates: string[] = [];
  for (const profile of allProfiles()) {
    const profileFamily = profile.family ?? deriveFamilyFromModelId(profile.id);
    if (profileFamily !== family) continue;
    if (profile.status !== 'current') continue;
    if (profile.active === false) continue;
    candidates.push(profile.id);
    if (candidates.length >= 3) break;
  }
  return candidates;
}

/**
 * advisorRuleCrossFamilyFit — named export consumed by
 * `advisor-rules/index.ts` and wired into `runAdvisor` (alpha.43).
 *
 * Returns `BestPracticeAdvisory[]` so it composes with the existing
 * advisor pipeline (every rule returns an array; empty = no fire).
 */
export function advisorRuleCrossFamilyFit(
  ctx: CrossFamilyFitContext,
): BestPracticeAdvisory[] {
  if (!ctx.resolvedPrimary) return [];

  const currentFamily = deriveFamilyFromModelId(ctx.resolvedPrimary);
  if (!currentFamily) return [];

  const fit = findBetterFit(ctx.archetype, currentFamily);
  if (!fit) return [];

  // Don't surface a recommendation the consumer can't act on.
  if (!familyHasCurrentActiveModel(fit.betterFitFamily)) return [];

  const candidates = listCandidatesInFamily(fit.betterFitFamily);
  if (candidates.length === 0) return [];

  const candidateStr = candidates.join(', ');
  const message =
    `Your ${currentFamily} call on ${ctx.archetype} could shift to ` +
    `${fit.betterFitFamily} — typically better quality + ${fit.costGuidance}. ` +
    `Suggested candidates: ${candidateStr}.`;

  return [
    {
      level: 'info',
      code: 'cross-family-fit-candidate',
      ownership: 'consumer-actionable',
      message,
      suggestion:
        `Swap the model literal in \`ir.models\` to one of: ${candidateStr}. ` +
        `Or call \`getRecommendedPrimary({ family: '${fit.betterFitFamily}', archetype: '${ctx.archetype}', ` +
        `fallback: { id: '${candidates[0]}', reason: 'cross-family-fit-recommendation' } })\` ` +
        `to let kgauto resolve to the current+active family member.`,
      recommendationType: 'model-swap',
      recommendedModels: [...candidates],
      docsUrl:
        'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29',
    },
  ];
}

// Re-export the registry helpers for ergonomic consumer introspection.
export { ARCHETYPE_FAMILY_FITS, findBetterFit };
