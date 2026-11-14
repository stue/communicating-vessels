/**
 * env.ts — provider env-key resolution + reachability predicates.
 *
 * Centralizes the per-provider env var names that kgauto checks for
 * reachability. Used by:
 *
 *   - execute.ts          — to find an API key when one isn't passed via apiKeys
 *   - call.ts             — to auto-filter unreachable models from the fallback walk
 *   - getDefaultFallbackChain — opt-in chain filter when consumer passes `reachability`
 *   - operator scripts    — getReachabilityDiagnostic() prints what's wired up
 *
 * Keeping the map in ONE place means execute() and the reachability check
 * always agree. Without this, kgauto could declare a model "reachable" because
 * env.ts found GOOGLE_GENERATIVE_AI_API_KEY, while execute() looks at
 * GOOGLE_API_KEY only and 401s — shipping the bug we're trying to fix.
 *
 * Resolution order (apiKeys takes precedence):
 *   1. opts.apiKeys?.[provider]
 *   2. process.env[name] for each name in PROVIDER_ENV_KEYS[provider] (first-present wins)
 *
 * alpha.10 (2026-05-14). Resolves the auto-filter-unreachable-models-silently
 * request from PB after first-deploy 401 on the alpha.9 summarize chain.
 */

import type { ApiKeys, Provider } from './ir.js';
import { tryGetProfile } from './profiles.js';

/**
 * Providers kgauto can resolve keys for today. Subset of `Provider` — `mistral`
 * and `xai` are declared in the type union but not yet executable (no profiles,
 * no execute() handler, no env-var convention). Narrowing here keeps the
 * reachability check structurally honest.
 */
export type SupportedProvider = 'anthropic' | 'google' | 'openai' | 'deepseek' | 'zai' | 'moonshot' | 'openrouter';

const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = Object.freeze([
  'anthropic',
  'google',
  'openai',
  'deepseek',
  'zai',
  'moonshot',
  'openrouter',
]) as readonly SupportedProvider[];

function isSupportedProvider(p: Provider): p is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly Provider[]).includes(p);
}

/**
 * Per-provider env var names kgauto recognizes. Order doesn't matter —
 * first-present wins. Multiple names per provider supported because Google
 * has historical drift (`GOOGLE_API_KEY` from older Google Cloud SDKs,
 * `GEMINI_API_KEY` in many examples, `GOOGLE_GENERATIVE_AI_API_KEY` is the
 * Vercel AI SDK convention used by IC + tt-intel adapters).
 *
 * Frozen so consumers/tests can't mutate (would break the cache invariant
 * that execute() and reachability checks agree).
 */
export const PROVIDER_ENV_KEYS: Readonly<Record<SupportedProvider, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(['ANTHROPIC_API_KEY']) as readonly string[],
  google: Object.freeze([
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ]) as readonly string[],
  openai: Object.freeze(['OPENAI_API_KEY']) as readonly string[],
  deepseek: Object.freeze(['DEEPSEEK_API_KEY']) as readonly string[],
  // alpha.65 — Z.ai (GLM family). ZAI_API_KEY is the canonical name; the
  // Z_AI_API_KEY variant covers the underscore convention some tooling uses
  // for the brand's "Z.ai" spelling.
  zai: Object.freeze(['ZAI_API_KEY', 'Z_AI_API_KEY']) as readonly string[],
  // alpha.65 — Moonshot AI (Kimi family). MOONSHOT_API_KEY is canonical
  // (api.moonshot.ai); KIMI_API_KEY covers the platform.kimi.ai rebrand
  // surface so consumers keyed under either name resolve.
  moonshot: Object.freeze(['MOONSHOT_API_KEY', 'KIMI_API_KEY']) as readonly string[],
  // alpha.92 — the OpenRouter gateway route (execute-leg contract). This is
  // a ROUTE key, not a vendor key: it never makes a vendor "reachable" for
  // chain composition — only explicit `route: 'openrouter'` calls use it.
  openrouter: Object.freeze(['OPENROUTER_API_KEY']) as readonly string[],
});

export interface ReachabilityOpts {
  /** Explicit keys (alpha.3 ApiKeys). Checked first; takes precedence over env. */
  apiKeys?: ApiKeys;
  /**
   * Override env source. Defaults to `process.env` in Node-shaped runtimes,
   * `{}` everywhere else. Pass `{}` explicitly in tests for hermetic runs.
   */
  envSource?: Record<string, string | undefined>;
  /**
   * alpha.104 — the providers this runtime can actually SERVE: the ones it
   * has an SDK / execute path wired for. When set, a provider outside the
   * list is unreachable no matter what keys exist.
   *
   * Why a key is the wrong proxy (tt-intelligence, 2026-09-04): their
   * production env had carried `OPENAI_API_KEY` for months for a provider
   * they had never wired; every starter chain they use ends in an OpenAI
   * model; `isModelReachable('gpt-5.4-mini')` said `true`; and the day two
   * servable models were blocked (a Google quota event + a spend gate) the
   * chain handed them a model whose constructor THREW before any stream —
   * the one failure shape their fell-over cannot restart around. Key-present
   * and servable dissociate in both directions (a key with no SDK; an SDK
   * with no key mid-rotation). This field lets the consumer state the
   * second half; kgauto keeps composing the chain and respects it.
   *
   * Omit to keep key-only semantics (every caller through alpha.103).
   */
  servableProviders?: readonly Provider[];
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/**
 * Normalize a raw env / apiKeys value: trim surrounding whitespace and
 * return undefined when the trimmed value is empty. Closes the
 * paste-newline-trap class (L-060 / L-083 / L-108) where a `vercel env add`
 * paste leaves a trailing `\n` in the value — pre-trim the truthy-check
 * passes and the call 401s at the provider boundary; post-trim the
 * malformed value is classified `unreachable` and the chain auto-filter
 * (call.ts) routes around it.
 */
function readKeyValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve a usable API key for the provider. Returns the key string, or
 * undefined if neither apiKeys nor any of the env names are set.
 *
 * Used internally by execute.ts so the reachability check and the actual
 * call check stay in sync.
 */
export function resolveProviderKey(
  provider: Provider,
  opts: ReachabilityOpts = {},
): string | undefined {
  if (!isSupportedProvider(provider)) return undefined;
  const explicit = readKeyValue(opts.apiKeys?.[provider]);
  if (explicit) return explicit;
  const env = opts.envSource ?? defaultEnv();
  for (const name of PROVIDER_ENV_KEYS[provider]) {
    const v = readKeyValue(env[name]);
    if (v) return v;
  }
  return undefined;
}

/**
 * alpha.113 — the key a SELF-INSTANTIATING consumer's SDK most plausibly read,
 * resolved from the environment alone and only when the answer is unambiguous.
 *
 * tt-intelligence (2026-09-15): consumers that build their own AI-SDK models
 * and report through `record()` never hand kgauto the key, so `key_fingerprint`
 * was NULL on every one of their rows while `call()` users had it for free.
 * `record()` derives it from the served model's provider and the env names
 * `createKeyHealthRoute` already probes — but a provider with SEVERAL names
 * (`GOOGLE_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`) can
 * hold different keys under different names, and which one the consumer's SDK
 * read is not knowable from here. A fingerprint of the wrong key is worse than
 * none (the 09-11 429s were exactly "the wrong key, and nothing could say so"),
 * so: one distinct value across the provider's names → that key; none → no key;
 * more than one → `ambiguous`, naming the env vars, and the consumer passes
 * `keyFingerprint` itself.
 */
export function resolveProviderKeyUnambiguous(
  provider: Provider,
  envSource?: Record<string, string | undefined>,
): { key?: string; ambiguous?: readonly string[] } {
  if (!isSupportedProvider(provider)) return {};
  const env = envSource ?? defaultEnv();
  const present: Array<{ name: string; value: string }> = [];
  for (const name of PROVIDER_ENV_KEYS[provider]) {
    const v = readKeyValue(env[name]);
    if (v) present.push({ name, value: v });
  }
  const distinct = new Set(present.map((x) => x.value));
  if (distinct.size === 0) return {};
  if (distinct.size === 1) return { key: present[0]!.value };
  return { ambiguous: present.map((x) => x.name) };
}

/**
 * True iff the provider has a usable key — either via explicit `apiKeys`
 * or one of the `PROVIDER_ENV_KEYS[provider]` names is set in envSource.
 */
export function isProviderReachable(
  provider: Provider,
  opts: ReachabilityOpts = {},
): boolean {
  if (!isProviderServable(provider, opts)) return false;
  return resolveProviderKey(provider, opts) !== undefined;
}

/**
 * alpha.104 — true unless the consumer declared `servableProviders` and this
 * provider is not in it. A declaration is about the RUNTIME (which SDKs are
 * wired), not about credentials; both must hold for a model to be reachable.
 */
export function isProviderServable(
  provider: Provider,
  opts: ReachabilityOpts = {},
): boolean {
  if (!opts.servableProviders) return true;
  return opts.servableProviders.includes(provider);
}

/**
 * True iff the model's profile exists AND its provider is reachable.
 * Unknown model id returns false (treat as unreachable; the chain walker
 * will surface "no reachable models" if everything filters out).
 */
export function isModelReachable(
  modelId: string,
  opts: ReachabilityOpts = {},
): boolean {
  const profile = tryGetProfile(modelId);
  if (!profile) return false;
  return isProviderReachable(profile.provider, opts);
}

export interface ProviderReachability {
  reachable: boolean;
  /** How the key was found. `null` when unreachable. */
  via: 'apiKeys' | 'env' | null;
  /** Which env var name supplied the key (only when via === 'env'). */
  envKeyFound?: string;
  /**
   * alpha.104 — set when the consumer's `servableProviders` excludes this
   * provider. A key may still exist (`envKeyFound` is reported so the
   * operator can see the dissociation); the provider is unreachable anyway.
   */
  notServable?: true;
}

/**
 * Snapshot of which providers are reachable from the current env / apiKeys.
 * Useful for operator scripts ("kgauto diagnose"), startup-time logging,
 * and the cost-watcher's "which consumer is missing what" report.
 *
 * Does NOT log the key value itself — only the env var name that supplied it.
 */
export function getReachabilityDiagnostic(
  opts: ReachabilityOpts = {},
): Record<SupportedProvider, ProviderReachability> {
  const env = opts.envSource ?? defaultEnv();
  const out = {} as Record<SupportedProvider, ProviderReachability>;
  for (const provider of SUPPORTED_PROVIDERS) {
    const envKeyFound = PROVIDER_ENV_KEYS[provider].find((name) => readKeyValue(env[name]));
    if (!isProviderServable(provider, opts)) {
      out[provider] = { reachable: false, via: null, notServable: true, ...(envKeyFound ? { envKeyFound } : {}) };
      continue;
    }
    if (readKeyValue(opts.apiKeys?.[provider])) {
      out[provider] = { reachable: true, via: 'apiKeys' };
      continue;
    }
    out[provider] = envKeyFound
      ? { reachable: true, via: 'env', envKeyFound }
      : { reachable: false, via: null };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Brain-read env contract (alpha.42)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Brain-read env contract — canonical names + accepted fallbacks for the
 * env vars kgauto's brain-read APIs need.
 *
 * Affected APIs: `getActionableAdvisories`, `markAdvisoryResolved`,
 * `markExclusionFindingHandled`, `markPromoteReadyHandled`,
 * `getStaleExclusionFindings`, and future brain-read surfaces. Each accepts
 * `brainEndpoint`/`brainJwt`/`brainAnonKey` as call-site arguments; this
 * helper centralizes resolution from the consumer's environment.
 *
 * Resolution order (first-truthy-trimmed wins):
 *   endpoint = KGAUTO_V2_BRAIN_SUPABASE_URL ?? KGAUTO_V2_BRAIN_URL
 *   jwt      = KGAUTO_V2_BRAIN_JWT          ?? GLASSBOX_BRAIN_JWT
 *   anonKey  = KGAUTO_V2_BRAIN_ANON_KEY     (no fallback)
 *
 * Why fallbacks exist:
 *
 *   1. Pre-alpha.42, some consumers set `KGAUTO_V2_BRAIN_URL` pointing at
 *      the kgauto-dashboard URL (write target). The canonical
 *      `KGAUTO_V2_BRAIN_SUPABASE_URL` is the Supabase project URL (read
 *      target — PostgREST against `/rest/v1/`). Until consumers split the
 *      two names, the fallback grabs whichever URL is set. When BOTH are
 *      set, canonical wins (the consumer has explicitly split).
 *
 *   2. The s33 Glass-Box ship provisioned `GLASSBOX_BRAIN_JWT` across all
 *      consumers with the same `app_id` claim shape, signed by the same
 *      JWT_SECRET. Reusing it for brain-read avoids re-minting + re-pasting
 *      a second JWT per consumer per surface.
 *
 * `missingEnv` lists the CANONICAL names that aren't satisfied by either
 * canonical OR fallback. Consumer policy: if `missingEnv.length > 0`,
 * render `not_configured`; otherwise pass `endpoint`/`jwt`/`anonKey` to
 * `getActionableAdvisories({ ... })` et al.
 *
 * Pre-trim semantics carry from `readKeyValue` — paste-newline-trap
 * (L-060 / L-083 / L-108) closure extends to brain env vars.
 *
 * Filed by tt-intel-Cairn (s89, 2026-05-27) after the s89 actionable-
 * advisories ref template hit `malformed brain response` on prod because
 * the endpoint env var pointed at the kgauto-dashboard URL instead of the
 * Supabase URL, AND because IC's ref template used a third env name
 * (`KGAUTO_V2_BRAIN_ENDPOINT`) that was unset. Three distinct name shapes
 * across two consumers — the durable closure is one canonical contract.
 */
export interface BrainReadEnv {
  /** Supabase project URL (PostgREST base). Undefined when neither canonical nor fallback is set. */
  endpoint?: string;
  /** JWT carrying `app_id` claim, signed by brain JWT_SECRET. Undefined when neither canonical nor fallback is set. */
  jwt?: string;
  /** Supabase anon (publishable) key. Undefined when not set. */
  anonKey?: string;
  /**
   * Canonical names not satisfied by either canonical OR fallback. Subset
   * (in order) of:
   *   ['KGAUTO_V2_BRAIN_SUPABASE_URL', 'KGAUTO_V2_BRAIN_JWT', 'KGAUTO_V2_BRAIN_ANON_KEY']
   * Consumer policy: render `not_configured` when length > 0.
   */
  missingEnv: string[];
}

/**
 * alpha.78 (PB adoption-gap ask 2) — the canonical brain-read env names as
 * an exported constant, so consumers reference them instead of retyping
 * (PB invented three plausible-but-wrong names and carried the resulting
 * self-authored 503 for two months).
 */
export const BRAIN_READ_ENV_NAMES = {
  endpoint: 'KGAUTO_V2_BRAIN_SUPABASE_URL',
  jwt: 'KGAUTO_V2_BRAIN_JWT',
  anonKey: 'KGAUTO_V2_BRAIN_ANON_KEY',
  /** Accepted fallbacks, in resolution order after the canonical name. */
  fallbacks: {
    endpoint: ['KGAUTO_V2_BRAIN_URL'],
    jwt: ['GLASSBOX_BRAIN_JWT'],
    anonKey: [],
  },
} as const;

/**
 * Resolve brain-read env vars. Defaults to `process.env`; pass `envSource`
 * for hermetic tests. Trims surrounding whitespace and treats
 * empty-after-trim as unset (same shape as `resolveProviderKey`).
 */
export function readBrainReadEnv(
  envSource: Record<string, string | undefined> = defaultEnv(),
): BrainReadEnv {
  const endpoint =
    readKeyValue(envSource.KGAUTO_V2_BRAIN_SUPABASE_URL) ??
    readKeyValue(envSource.KGAUTO_V2_BRAIN_URL);
  const jwt =
    readKeyValue(envSource.KGAUTO_V2_BRAIN_JWT) ??
    readKeyValue(envSource.GLASSBOX_BRAIN_JWT);
  const anonKey = readKeyValue(envSource.KGAUTO_V2_BRAIN_ANON_KEY);

  const missingEnv: string[] = [];
  if (!endpoint) missingEnv.push('KGAUTO_V2_BRAIN_SUPABASE_URL');
  if (!jwt) missingEnv.push('KGAUTO_V2_BRAIN_JWT');
  if (!anonKey) missingEnv.push('KGAUTO_V2_BRAIN_ANON_KEY');

  return { endpoint, jwt, anonKey, missingEnv };
}

/**
 * alpha.66 — env-side consent for the one-shot same-model retry on
 * structured-output contract violations (`CallOptions.sameModelRetry`).
 * Mirrors `isAutoPromoteEnabledFromEnv` exactly: '1'/'true' (trimmed,
 * case-insensitive) enable; anything else is off. Explicit
 * `sameModelRetry: false` in CallOptions beats this env var.
 */
export function isSameModelRetryEnabledFromEnv(
  envSource: Record<string, string | undefined> = defaultEnv(),
): boolean {
  const raw = (envSource.KGAUTO_SAME_MODEL_RETRY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
