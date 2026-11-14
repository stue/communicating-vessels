// alpha.41 advisor rule registry — populated by Builders B + C.
// Phase 2 reconciliation activated 2026-05-26 (s47) — re-exports flipped
// from stub to real rule modules. Both rules wired into `runAdvisor` in
// `../advisor.ts` under the existing `posture !== 'locked'` gate.

export { advisorRulePromoteReady } from './promote-ready.js';
export type { PromoteReadyContext } from './promote-ready.js';
export { advisorRuleConsumerOnStaleModel } from './consumer-on-stale-model.js';

// alpha.43 — cross-family-fit positive advisor (architectural fit
// recommendation; complements alpha.41 promote-ready which is
// brain-evidence-driven). Fires regardless of volume per Sacha framing
// 2026-05-28: surface the better-fit at moment of knowing, don't wait
// for traffic to accumulate.
export {
  advisorRuleCrossFamilyFit,
  familyHasCurrentActiveModel,
  listCandidatesInFamily,
} from './cross-family-fit.js';
export type { CrossFamilyFitContext } from './cross-family-fit.js';

// blocked-model drift detector — grounded in the alpha.72 family-primary
// retarget (tt-intel's literal-id gate stopped matching; their s113 fix was
// consumer-side family resolution) and the alpha.85 alias-leak class.
// Reports; does not change matching semantics.
export {
  advisorRuleBlockedModelDrift,
  BLOCKED_MODEL_NOT_IN_ROSTER_CODE,
  BLOCKED_MODEL_FAMILY_SIBLING_SERVED_CODE,
} from './blocked-model-drift.js';

// preferred∩blocked overlap — a pin that can never win (tt-intel s123,
// filed 2026-08-01). Statically detectable at compile time; reports the
// contradiction and names the substitute chosen this call. Selection
// semantics untouched (blocked still outranks preferred).
export {
  advisorRulePreferredBlockedOverlap,
  PREFERRED_MODEL_BLOCKED_CODE,
} from './preferred-blocked-overlap.js';
export type { PreferredBlockedOverlapContext } from './preferred-blocked-overlap.js';
export type { BlockedModelDriftContext } from './blocked-model-drift.js';
