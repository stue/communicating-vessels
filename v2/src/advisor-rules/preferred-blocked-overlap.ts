/**
 * preferred-model-blocked — a pin that can never win.
 *
 * ── The incident this is grounded in (tt-intel s123, filed 2026-08-01) ───
 *
 * tt-intel adopted the `single-model-array` remedy as prescribed: widen
 * `models` to the archetype chain and pin the incumbent via
 * `policy.preferredModels`. With a family alias in `KGAUTO_BLOCKED_MODELS`
 * (`claude-sonnet`, alias-resolved since alpha.85), the pin was silently
 * dead at EVERY call site pinning that family — the block hard-rejects the
 * pinned candidate before the preference boost can matter, so substitution
 * is the steady state, on every call, with only a `policy-blocked-<model>`
 * mutation id to show for it.
 *
 * Their felt instance: the `dashboard-argument` summarize site pinned
 * `claude-sonnet` → substitution chose `deepseek-v4-flash`, whose reasoning
 * burn exceeded the site's `maxOutputTokens: 200` — `tokens_out` pegged at
 * exactly 200, empty text, HTTP 200. Three probes, 100% empty payloads,
 * and nothing anywhere named the cause.
 *
 * The overlap is statically detectable at compile time, from inputs compile
 * already holds. Sometimes it IS operator intent (spend gate deliberately
 * outranks the pin); the point is that today intent and misconfiguration
 * are indistinguishable and invisible. This rule makes the state visible
 * and names the substitute actually chosen this call; it changes nothing
 * about selection (blocked still outranks preferred — that contract holds).
 *
 * Fires regardless of `policy.posture` for the same reason as
 * blocked-model-drift: this is a report that the consumer's own declared
 * constraints contradict each other, not a model recommendation.
 */

import type { BestPracticeAdvisory, CompilePolicy } from '../ir.js';
import { canonicalPolicySet, policySetHas } from '../policy-match.js';

/** Stable rule code. Written to `compile_outcome_advisories.code`. */
export const PREFERRED_MODEL_BLOCKED_CODE = 'preferred-model-blocked';

const DOCS_URL =
  'https://github.com/stue/command-center/blob/main/interfaces/kgauto.md#best-practice-advisories';

export interface PreferredBlockedOverlapContext {
  /** Consumer policy for this compile. Rule is silent when absent/empty. */
  policy?: CompilePolicy;
  /** The model id selected for this call (post family-resolution + chain walk). */
  selectedModelId: string;
}

/**
 * Emit a warn when `preferredModels ∩ blockedModels ≠ ∅` (canonical — an
 * alias and its canonical are the same model, alpha.85).
 *
 * Deterministic: at most one advisory naming every dead pin, entries
 * sorted, so a long policy produces one readable line and the
 * auto-resolver can match on stable text.
 */
export function advisorRulePreferredBlockedOverlap(
  ctx: PreferredBlockedOverlapContext,
): BestPracticeAdvisory[] {
  const preferred = ctx.policy?.preferredModels;
  const blocked = ctx.policy?.blockedModels;
  if (!preferred?.length || !blocked?.length) return [];

  const blockedSet = canonicalPolicySet(blocked);
  const deadPins = [...new Set(preferred)]
    .filter((p) => policySetHas(blockedSet, p))
    .sort();
  if (deadPins.length === 0) return [];

  const list = deadPins.map((p) => `\`${p}\``).join(', ');
  const one = deadPins.length === 1;
  // Was the served model itself a (live) pin? If so another pin won and the
  // dead entries are latent; otherwise substitution is the steady state
  // RIGHT NOW and the served model names it.
  const preferredSet = canonicalPolicySet(preferred);
  const servedIsPinned = policySetHas(preferredSet, ctx.selectedModelId);

  return [
    {
      level: 'warn',
      code: PREFERRED_MODEL_BLOCKED_CODE,
      message:
        `CompilePolicy.preferredModels entr${one ? 'y' : 'ies'} ${list} ` +
        `${one ? 'is' : 'are'} also in \`blockedModels\` (matched canonically, aliases included). ` +
        `A blocked model is hard-rejected before preference boosts apply, so ` +
        `${one ? 'this pin' : 'these pins'} can never serve. ` +
        (servedIsPinned
          ? `This call was served by \`${ctx.selectedModelId}\`, which is itself a live pin — the dead ` +
            `entr${one ? 'y is' : 'ies are'} latent, not currently rerouting traffic.`
          : `Substitution is your steady state: this call landed on \`${ctx.selectedModelId}\`, which ` +
            `you did not pin.`),
      suggestion:
        `Two readings, and kgauto cannot tell them apart: (1) intentional — your spend gate ` +
        `deliberately outranks the pin, in which case nothing needs doing and you can filter this ` +
        `code; (2) misconfiguration — the pin and the block were written at different times and the ` +
        `overlap is an accident. tt-intel hit reading (2) on 2026-08-01: a summarize site pinned ` +
        `\`claude-sonnet\` while \`KGAUTO_BLOCKED_MODELS\` carried the same family, and every call ` +
        `silently substituted a reasoning model whose reasoning burn exceeded the site's ` +
        `\`maxOutputTokens\` — 100% empty payloads under HTTP 200. If the block should win, remove ` +
        `the pin so the policy says what it does. If the pin should win, remove ` +
        `${one ? 'the blocking entry' : 'the blocking entries'} or re-scope the block to the exact ` +
        `ids you mean. Check what the substitute costs at your input shape while you are here — a ` +
        `spend gate that lands traffic on a pricier model than the one it blocked is a cost ` +
        `inversion, not a saving.`,
      docsUrl: DOCS_URL,
    },
  ];
}
