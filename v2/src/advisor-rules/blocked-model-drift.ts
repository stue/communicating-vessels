/**
 * blocked-model-drift — advisor rule for the two ways a consumer's
 * `CompilePolicy.blockedModels` can stop meaning what the consumer meant,
 * without anything anywhere reporting a problem.
 *
 * ── The incidents this is grounded in (tt-intel s113 + s119) ─────────────
 *
 * (Correction, s83: an earlier draft cited "claude-sonnet-5 served 30% of
 * tt-intel's ask traffic" as the motivating incident. That number was a
 * FOSSIL — tt-intel's own L-188 traced all 11 calls to a 29-second burst
 * from their own prior spend-gate experiment, fixed minutes later, and
 * their block was in fact working. Do not resurrect it.)
 *
 * The real, verified incidents:
 *
 * 1. alpha.72 retargeted the curated `claude-sonnet` family primary from
 *    `claude-sonnet-4-6` (now `legacy`) to `claude-sonnet-5` (now
 *    `current`), and tt-intel's literal-id gate STOPPED MATCHING the
 *    family's routed traffic — their s113 response was to build
 *    consumer-side family→concrete-id resolution (`parseBlockedModels`)
 *    before ids reach kgauto. Every consumer without that local machinery
 *    is exposed to the same silent retarget: `blockedModels` is matched by
 *    exact id, so a block written against yesterday's primary says nothing
 *    about today's.
 *
 * 2. tt-intel s119 (2026-07-29 filing): a blocked model SERVED when an
 *    unblocked ALIAS of it sat in the candidate set (`deepseek-chat` ≡
 *    `deepseek-v4-flash`). That one was a kgauto correctness bug, fixed in
 *    alpha.85 by canonical matching (`policy-match.ts`) — but it proved
 *    the class: a block-list meaning drifts whenever the roster's id
 *    surface moves under it, and no layer errors.
 *
 * ── What this rule is NOT ────────────────────────────────────────────────
 *
 * It does not change matching semantics. Exact-ID matching is arguably the
 * correct contract: family-glob matching would silently widen every
 * existing consumer's block-list, which is a breaking semantic change and
 * not kgauto's to make unilaterally. The gap here is silence, not
 * semantics — so the fix is a signal, not a behavior change. Selection is
 * untouched; a consumer who blocked one exact id still gets exactly that
 * id blocked and nothing else.
 *
 * ── The two branches ─────────────────────────────────────────────────────
 *
 * (a) `blocked-model-not-in-roster` — a `blockedModels` entry resolves to
 *     no model in the current roster (after alias resolution). The block is
 *     inert: it can never match anything. Causes are a typo, a model
 *     retired out of the roster, or a stale env var carried forward. There
 *     is no reading under which an entry matching nothing is what the
 *     consumer wanted, so this is unambiguous.
 *
 * (b) `blocked-model-family-sibling-served` — the model selected for THIS
 *     call is in the same family as a blocked entry but is a different
 *     exact id. This is the tt-intel shape. Unlike (a) it IS ambiguous:
 *     "block `claude-sonnet-4-6` specifically, `claude-sonnet-5` is fine"
 *     is a legitimate and common intent. So the message states both
 *     readings and says how to act on either. It escalates its wording —
 *     not its level — when the blocked sibling is `legacy`/`deprecated` and
 *     the served sibling is `current`, because that combination is the
 *     signature of a roster lifecycle move rather than a deliberate
 *     per-generation block.
 *
 * Both fire at `warn`, and both fire regardless of `policy.posture`.
 * `posture: 'locked'` means "do not recommend models to me" — these are not
 * recommendations, they are reports that the consumer's own declared
 * constraint is not doing what its author expects. Same reasoning as the
 * alpha.28 `archetype-perf-floor-breach` cliff advisor, which is also
 * posture-independent because it reports a structural fact rather than a
 * preference.
 *
 * Companion watcher: `v2/scripts/blocked-model-drift-watch.mjs` rolls the
 * same two branches up across a consumer's recent traffic from the brain,
 * so the signal survives a consumer who never reads `result.advisories[]`.
 *
 * L-073 family ("no errors = healthy"): as with DeepSeek's `deepseek-chat`
 * compat alias and the alpha.47/.43 field-drop chain, nothing errored,
 * nothing 404'd, latency did not move — and the cached intent was wrong for
 * an unknown duration. The detection loop has to be built deliberately
 * because the failure emits no natural signal.
 */

import type { BestPracticeAdvisory, CompilePolicy } from '../ir.js';
import type { ModelProfile } from '../profiles.js';
import { tryGetProfile, resolveModelAlias, lifecycleOnTheWayOut, providerDisplayName, retirementFloorClause } from '../profiles.js';
import { deriveFamilyFromModelId } from '../family-resolution.js';

/** Stable rule code — branch (a). Written to `compile_outcome_advisories.code`. */
export const BLOCKED_MODEL_NOT_IN_ROSTER_CODE = 'blocked-model-not-in-roster';

/** Stable rule code — branch (b). Written to `compile_outcome_advisories.code`. */
export const BLOCKED_MODEL_FAMILY_SIBLING_SERVED_CODE =
  'blocked-model-family-sibling-served';

const DOCS_URL =
  'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#structured-advisories-api-alpha29';

export interface BlockedModelDriftContext {
  /** Consumer policy for this compile. Rule is silent when absent/empty. */
  policy?: CompilePolicy;
  /** The model id selected for this call (post family-resolution + chain walk). */
  selectedModelId: string;
  /**
   * Roster resolver. Defaults to `tryGetProfile`, which consults the brain
   * registry first and falls back to bundled profiles — so a brain-connected
   * consumer is checked against the roster they actually route on, not the
   * roster their npm version happened to bundle.
   */
  resolveProfile?: (id: string) => ModelProfile | undefined;
}

/**
 * Family of a model id, preferring the profile's own `family` column
 * (brain-backed, authoritative) and falling back to the deterministic
 * taxonomy in `family-resolution.ts`. Returns null for ids the taxonomy
 * does not recognize — an unrecognized id can never be a family sibling of
 * anything, which is the correct silent outcome (better than guessing a
 * family and firing a wrong advisory).
 */
function familyOf(
  modelId: string,
  profile: ModelProfile | undefined,
): string | null {
  return profile?.family ?? deriveFamilyFromModelId(modelId);
}

/**
 * Roster lifecycle states that mean "this id is on its way out".
 *
 * alpha.126 — read through `lifecycleOnTheWayOut`: the PROVIDER's word
 * (`providerLifecycle.status` ∈ legacy / deprecated / retired) OR kgauto's own
 * `status` (`legacy`, or the brain's `deprecated` — the old path, kept). A
 * blocked `claude-sonnet-5` is `status: 'current'` (the measured head stays)
 * while Anthropic lists it legacy; the retarget signature is the provider's
 * word, so the note names it. (was: `status === 'legacy' || 'deprecated'` only,
 * until alpha.126.)
 */
function isOnTheWayOut(profile: ModelProfile | undefined): boolean {
  return lifecycleOnTheWayOut(profile) !== null;
}

/** The sentence the retarget note adds when the provider's page is the source of the word. */
function providerWordNote(id: string, profile: ModelProfile | undefined): string {
  const w = lifecycleOnTheWayOut(profile);
  if (!w || w.by !== 'provider') return '';
  return ` ${providerDisplayName(profile!.provider)} lists \`${id}\` as ${w.word} (read ${w.readOn}${retirementFloorClause(w)}).`;
}

/**
 * Emit blocked-model drift advisories for one compile.
 *
 * Deterministic: entries are sorted, and each branch emits at most one
 * advisory (all affected entries are named inside it) so a consumer who
 * passes a long block-list gets one readable line rather than N.
 *
 * Silent when: no policy, empty `blockedModels`, or neither branch matches.
 */
export function advisorRuleBlockedModelDrift(
  ctx: BlockedModelDriftContext,
): BestPracticeAdvisory[] {
  const blocked = ctx.policy?.blockedModels;
  if (!blocked || blocked.length === 0) return [];

  const resolve = ctx.resolveProfile ?? tryGetProfile;
  const out: BestPracticeAdvisory[] = [];

  // Dedupe + sort so the message text is stable for a given block-list
  // regardless of the order the consumer declared it in. Stability matters:
  // these rows land in `compile_outcome_advisories` and the auto-resolver
  // matches on them.
  const entries = [...new Set(blocked)].sort();

  const selectedProfile = resolve(ctx.selectedModelId);
  const selectedFamily = familyOf(ctx.selectedModelId, selectedProfile);

  // ── Branch (a): entries that match no model in the roster ──────────────
  const orphans = entries.filter((e) => resolve(e) === undefined);
  if (orphans.length > 0) {
    const list = orphans.map((o) => `\`${o}\``).join(', ');
    const plural = orphans.length === 1 ? 'entry' : 'entries';
    const verb = orphans.length === 1 ? 'matches' : 'match';
    out.push({
      level: 'warn',
      code: BLOCKED_MODEL_NOT_IN_ROSTER_CODE,
      message:
        `CompilePolicy.blockedModels ${plural} ${list} ${verb} no model in the current roster, ` +
        `so ${orphans.length === 1 ? 'it is' : 'they are'} inert — ` +
        `\`blockedModels\` is matched by exact model id, and nothing kgauto can select carries ` +
        `${orphans.length === 1 ? 'that id' : 'those ids'}. The block will never fire.`,
      suggestion:
        `Check for a typo, or for an id that was retired from the roster since the block was written. ` +
        `This is how a block goes quiet without an error: tt-intel (2026-07-29) carried ` +
        `\`KGAUTO_BLOCKED_MODELS="claude-sonnet-4-6"\` across a roster retarget and the block stopped ` +
        `covering the traffic they believed it covered. Resolve the intended model id against the live ` +
        `roster — \`getRecommendedPrimary({ family, fallback })\` returns the id the family currently ` +
        `resolves to — and block that id, or drop the entry if it is no longer needed.`,
      docsUrl: DOCS_URL,
    });
  }

  // ── Branch (b): a family sibling of a blocked entry is being served ────
  if (selectedFamily !== null) {
    const siblings = entries.filter((e) => {
      // exact block (canonical — an alias IS the model, alpha.85); enforced
      // by policy-match at selection time, so it can't be "drift".
      if (resolveModelAlias(e) === resolveModelAlias(ctx.selectedModelId)) return false;
      const p = resolve(e);
      if (familyOf(e, p) !== selectedFamily) return false;
      // Family tags are provider-scoped, so family equality already implies
      // same provider. Assert it anyway when both profiles resolve — a
      // future taxonomy entry shared across providers must not produce a
      // false sibling claim.
      if (p && selectedProfile && p.provider !== selectedProfile.provider) {
        return false;
      }
      return true;
    });

    if (siblings.length > 0) {
      const list = siblings.map((s) => `\`${s}\``).join(', ');
      const plural = siblings.length === 1 ? '' : 's';

      // Lifecycle escalation: blocked sibling on the way out + served
      // sibling current is the roster-retarget signature.
      const onTheWayOut = siblings.filter((s) => isOnTheWayOut(resolve(s)));
      const retargetShaped = onTheWayOut.length > 0 && selectedProfile?.status === 'current';
      const retargetNote = retargetShaped
        ? ` The blocked id${plural} ${siblings.length === 1 ? 'is' : 'are'} legacy/deprecated while ` +
          `\`${ctx.selectedModelId}\` is current — that is the signature of a roster lifecycle move ` +
          `rather than a deliberate per-generation block, so this is more likely to be drift than intent.` +
          onTheWayOut.map((s) => providerWordNote(s, resolve(s))).join('')
        : '';

      out.push({
        level: 'warn',
        code: BLOCKED_MODEL_FAMILY_SIBLING_SERVED_CODE,
        message:
          `\`${ctx.selectedModelId}\` was selected for this call. It is in the same family ` +
          `(\`${selectedFamily}\`) as blocked entr${siblings.length === 1 ? 'y' : 'ies'} ${list}, ` +
          `but its exact id differs — and \`CompilePolicy.blockedModels\` matches by exact id, so the ` +
          `block does not cover it.${retargetNote}`,
        suggestion:
          `Two readings, and kgauto cannot tell them apart: (1) intentional — you meant to gate that ` +
          `specific id and \`${ctx.selectedModelId}\` is fine, in which case nothing needs doing and you ` +
          `can filter this code; (2) drift — you meant to gate the family, and a roster change moved ` +
          `traffic to a sibling your block never named. This happened to tt-intel: when the ` +
          `\`claude-sonnet\` family primary retargeted from \`claude-sonnet-4-6\` to \`claude-sonnet-5\`, ` +
          `their literal-id gate stopped matching the family's routed traffic (their fix was local ` +
          `family resolution). If you meant the family, add \`${ctx.selectedModelId}\` to ` +
          `\`blockedModels\` — kgauto deliberately does NOT widen exact-id blocks into family globs, ` +
          `because that would silently change what every existing block covers.`,
        docsUrl: DOCS_URL,
      });
    }
  }

  return out;
}
