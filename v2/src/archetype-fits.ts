/**
 * archetype-fits — alpha.43.
 *
 * Static table of "this archetype tends to be a better fit for this family"
 * recommendations. Powers the `cross-family-fit-candidate` compile-time
 * advisor (see `advisor-rules/cross-family-fit.ts`).
 *
 * Strategic framing (Sacha, 2026-05-28): "If we get better results and
 * better price then we do. Even if volume is currently low, that's not an
 * argument to not do it. Volume can increase quickly if tools is great to
 * use, let's not create future bottlenecks because we could have wired in
 * better solution at moment of knowing."
 *
 * The convention substrate (passApplyConventions) is the NEGATIVE side:
 * make a family usable on archetypes it currently fails. This table is the
 * POSITIVE side: actively surface that a different family is the better
 * fit for the archetype's shape — even when current volume is low.
 *
 * Entries are added only when:
 *   - the archetype's shape and the family's behavior have a clear
 *     architectural fit (not vibes)
 *   - real-world evidence (brain rows, probe outcomes, or published
 *     benchmark) backs the claim, OR the reasoning is structurally so clear
 *     that "wait for volume" would create a future bottleneck
 *
 * Alpha.43 ships two entries — `plan` and `critique`. Both fit the
 * reasoner-family architectural read: plan is multi-step reasoning;
 * critique rewards epistemic humility and explicit reasoning. Other
 * archetype-family-fits ride later alphas as evidence accumulates.
 *
 * Anti-pattern: do NOT add archetype-family-fits for archetypes where the
 * fit is unclear (summarize, classify, extract, hunt with parallel tools).
 * The advisor only earns trust when its recommendations land.
 */

import type { IntentArchetypeName } from './dialect.js';

/**
 * One archetype-family-fit recommendation. Read by the compile-time
 * `cross-family-fit-candidate` advisor to decide when to surface a positive
 * recommendation. The advisor pulls `costGuidance` verbatim into the
 * advisory message.
 */
export interface ArchetypeFamilyFit {
  /** Intent archetype this fit applies to. */
  archetype: IntentArchetypeName;
  /** Family tag that fits the archetype better than alternatives. Matches the
   *  same family taxonomy used by `family-resolution.deriveFamilyFromModelId`
   *  (e.g. `'deepseek-reasoner'`, `'gemini-flash'`, `'claude-opus'`). */
  betterFitFamily: string;
  /** Architectural / evidentiary justification. Appears in the advisor's
   *  internal logs and the advisory `evidence` payload, NOT verbatim in the
   *  consumer-facing message. */
  reason: string;
  /** Cost-context clause surfaced VERBATIM in the consumer-facing advisory
   *  message (e.g. "substantially cheaper at current pricing"). Keep
   *  declarative; the advisor wraps this into the larger sentence. */
  costGuidance: string;
}

/**
 * Frozen registry. Add entries by extending the array. Order is irrelevant
 * — the advisor filters by `(archetype, currentFamily)` independently.
 */
export const ARCHETYPE_FAMILY_FITS: readonly ArchetypeFamilyFit[] = Object.freeze([
  {
    archetype: 'plan',
    betterFitFamily: 'deepseek-reasoner',
    reason:
      'Plan archetype is reasoning-shaped (multi-step chains, hypothesis-and-check, sub-goal decomposition) — exactly where reasoner-family models excel. Sonnet/Opus produce plans but at higher cost; reasoners produce equivalent-or-better plans at 7-17x lower cost at current promo pricing (deepseek-v4-pro $0.435/$0.87 per 1M promo through 2026-05-31 vs sonnet $3/$15).',
    costGuidance:
      'substantially cheaper at current pricing (deepseek-v4-pro promo: ~7-17x cheaper than sonnet)',
  },
  {
    archetype: 'critique',
    betterFitFamily: 'deepseek-reasoner',
    reason:
      'Critique archetype rewards epistemic humility and explicit reasoning — reasoner-family default behavior. Sonnet/Opus over-confident on critique tasks; reasoners surface uncertainty productively.',
    costGuidance: 'comparable or cheaper at current pricing',
  },
]);

/**
 * Pure lookup: does `(archetype, currentFamily)` have a better-fit family?
 * Returns the fit entry when the current family is NOT the better fit; null
 * otherwise. Used by the advisor to decide whether to fire.
 */
export function findBetterFit(
  archetype: string,
  currentFamily: string,
): ArchetypeFamilyFit | null {
  for (const fit of ARCHETYPE_FAMILY_FITS) {
    if (fit.archetype !== archetype) continue;
    if (fit.betterFitFamily === currentFamily) return null; // already on the fit
    return fit;
  }
  return null;
}
