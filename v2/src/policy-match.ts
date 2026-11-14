/**
 * policy-match — the ONE place a model id is tested against a
 * `CompilePolicy` model list (`blockedModels`, `preferredModels`).
 *
 * ── The defect this replaces (alpha.85, tt-intel s119) ───────────────────
 *
 * Four independent sites each did `new Set(policy.blockedModels)` and
 * `.has(rawId)`. Provider aliases broke every one of them: `deepseek-chat`
 * is an alias for `deepseek-v4-flash` (see profiles.ts ALIASES / L-073), so
 * a candidate set carrying the alias sailed past a block naming the
 * canonical id — and the profile lookup then resolved the alias straight
 * back to the blocked model, which served. tt-intel's minimal repro:
 *
 *   compile({ ..., models: ['deepseek-chat', 'deepseek-v4-flash'] },
 *           { policy: { blockedModels: ['deepseek-v4-flash'] } })
 *   // → target 'deepseek-v4-flash'   the blocked model serves
 *
 * `preferredModels` had the mirror defect: preferring the alias while the
 * candidate set carries the canonical id applied no boost.
 *
 * ── What this is, and is not ─────────────────────────────────────────────
 *
 * An alias and its canonical are the SAME MODEL, so canonicalizing both
 * sides of the comparison is a correctness fix to the existing exact-id
 * contract. It is NOT family-glob matching: blocking `deepseek-v4-flash`
 * still says nothing about `deepseek-v4-pro`, and a bare family key like
 * `'deepseek'` remains inert (documented; widening it would be a breaking
 * semantic change — see the s81 decision).
 *
 * Every policy-list membership test MUST go through this module. A
 * structural test (tests/policy-match.test.ts) asserts no raw
 * `new Set(policy.blockedModels)` construction survives in src/.
 */

import { inferProviderFromId, resolveModelAlias, tryGetProfile } from './profiles.js';

/**
 * Build a membership set from a policy model list, canonicalizing each
 * entry. Returns an empty set for undefined/empty input, so callers can
 * unconditionally construct and test `size` where they used to test length.
 */
export function canonicalPolicySet(ids: readonly string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const id of ids ?? []) set.add(resolveModelAlias(id));
  return set;
}

/**
 * Test a model id against a set built by `canonicalPolicySet`, resolving
 * the id's alias before the lookup.
 */
export function policySetHas(set: ReadonlySet<string>, modelId: string): boolean {
  if (set.size === 0) return false;
  return set.has(resolveModelAlias(modelId));
}

/**
 * alpha.115 — test a model id against `CompilePolicy.blockedProviders`.
 * The provider is the profile's (tryGetProfile resolves aliases); an unprofiled id falls
 * back to the id-prefix inference compile() itself uses for best-effort
 * profiles, so an unknown Anthropic id is still an Anthropic id. An id
 * whose provider cannot be named is NOT blocked here — compile() refuses
 * it on its own (unknown_model_id), which is the stricter outcome.
 */
export function isProviderBlocked(modelId: string, blockedProviders: ReadonlySet<string>): boolean {
  if (blockedProviders.size === 0) return false;
  const provider = tryGetProfile(modelId)?.provider ?? inferProviderFromId(modelId);
  return provider !== undefined && blockedProviders.has(provider);
}
