/**
 * Public entry point for `@warmdrift/kgauto-compiler/glassbox-routes`.
 *
 * One factory call from a Vercel Edge consumer route handler gets you both
 * the replay-query (`proxy`) and live-SSE (`stream`) endpoints that the
 * Glass-Box Chrome panel reads. Wiring is ~6 lines per app:
 *
 *   // app/api/glassbox/proxy/route.ts
 *   import { createGlassboxRoutes } from '@warmdrift/kgauto-compiler/glassbox-routes';
 *   const { proxy } = createGlassboxRoutes({
 *     installToken:  process.env.GLASSBOX_INSTALL_TOKEN!,
 *     extensionId:   process.env.GLASSBOX_EXTENSION_ID!,
 *     brainEndpoint: process.env.GLASSBOX_BRAIN_ENDPOINT!,
 *     brainJwt:      process.env.GLASSBOX_BRAIN_JWT!,      // scoped JWT (RLS via app_id claim)
 *     brainAnonKey:  process.env.GLASSBOX_BRAIN_ANON_KEY!, // project anon/publishable key (Supabase apikey header)
 *     appId:         'playbacksam',
 *   });
 *   export { proxy as GET };
 *
 * Auth model (defense in depth):
 *   - Bearer install token   → primary, constant-time compared
 *   - chrome-extension Origin → secondary CSRF gate
 *
 * Scrub: optional sanitization runs at the proxy boundary before events or
 * rows leave the consumer's infrastructure. Per pii-scrubber-call-site-not-
 * package: kgauto stays naive to PII policy; consumers pass scrub hooks
 * that encode their own data-handling rules.
 *
 * Brain reads use the scoped JWT minted via migration 013. RLS enforces
 * `app_id = jwt.claim.app_id`; the proxy filter is belt-and-suspenders for
 * payload size + log legibility.
 */

import { createProxyHandler } from './proxy.js';
import { createStreamHandler } from './stream.js';
import { subscribe, subscribeApp } from '../glassbox/subscribe.js';
import type { GlassboxEvent } from '../glassbox/types.js';

// Re-export wire contracts so consumers can type their fetch results.
export type {
  TraceSummary,
  TraceDetail,
  TraceCounterfactual,
  TraceHealth,
  TraceSectionRewrite,
  AdvisoryRecord,
} from './types.js';

/**
 * alpha.32 — Glass-Box pivot. Consumer dashboards now mount the substrate
 * directly via these transformers instead of routing through the Chrome
 * extension UI. Same canonical L-118 boundary the proxy uses internally;
 * promoted from `_internal` to public so any consumer admin page can
 * mirror tt-intelligence's `app/admin/kgauto/loadGlassboxTraces.ts` shape
 * without dipping into private internals.
 *
 * The `_internal` namespace stays exported (reference-identity equal) for
 * back-compat with the alpha.28-rc1 test suite.
 */
export { rowToSummary, rowToDetail } from './proxy.js';
export {
  computeCounterfactuals,
  COUNTERFACTUAL_MIN_SAVINGS_RATIO,
  COUNTERFACTUAL_MAX_RESULTS,
} from './counterfactuals.js';
export type { ComputeCounterfactualsArgs } from './counterfactuals.js';

export interface GlassboxRoutesConfig {
  /** Bearer token validated on every request via constant-time compare. Required. */
  installToken: string;
  /** chrome-extension://<id> — exact match required on Origin header. Required. */
  extensionId: string;
  /** Brain endpoint base (e.g. https://kgauto-brain.supabase.co). Used by `proxy` for replay queries. */
  brainEndpoint: string;
  /** Scoped JWT for brain reads. Use the per-consumer JWT minted via migration 013 (claim: app_id). Drives RLS via the `app_id` claim; sent as `Authorization: Bearer <jwt>` only. */
  brainJwt: string;
  /**
   * Anon/publishable key for the Supabase `apikey` header. Supabase requires
   * `apikey` to be one of the project's known keys (anon or service_role) —
   * the scoped JWT in `brainJwt` doesn't qualify there. Pass the project's
   * legacy `anon` key (JWT format, role=anon) or the modern `sb_publishable_...`
   * key. Safe to expose at the wire (that's what "publishable" means).
   *
   * Pre-alpha.24 this was missing and `brainJwt` was used as apikey too — first
   * real call always 401'd against real Supabase. Catching this required a
   * pre-publish smoke against the real brain; unit tests with mocked fetch
   * couldn't surface it. See L-117 in command-center/learnings.md.
   */
  brainAnonKey: string;
  /** App scope filter — must match the JWT's app_id claim. */
  appId: string;
  /**
   * Optional sanitization hook. Called with each event/trace BEFORE it leaves the consumer.
   * Default: identity (no scrub). PII policy lives at the call-site, not in the package.
   */
  scrub?: (
    event: GlassboxEvent | Record<string, unknown>,
  ) => GlassboxEvent | Record<string, unknown>;
  /**
   * Test-only seam: override the brain fetch implementation. Production
   * code never sets this; tests use it to mock PostgREST responses.
   */
  fetch?: typeof fetch;
  /**
   * Test-only seam: override the per-trace live-stream subscriber. Production
   * code resolves to the alpha.17 `subscribe()` export; tests inject a fake
   * source ReadableStream<GlassboxEvent>.
   */
  subscribe?: (traceId: string) => ReadableStream<GlassboxEvent>;
  /**
   * Test-only seam: override the per-app "tail-all" subscriber (alpha.26).
   * Production code resolves to the `subscribeApp()` export; tests inject
   * a fake source. Backs the extension's default Live tab mode when no
   * traceId is supplied in the URL.
   */
  subscribeApp?: (args: { appId: string }) => ReadableStream<GlassboxEvent>;
}

export interface GlassboxRoutes {
  /** GET /api/glassbox/proxy?traceId=<id>  OR  ?limit=20 (recent traces) */
  proxy: (req: Request) => Promise<Response>;
  /** GET /api/glassbox/stream?traceId=<id>  (SSE) */
  stream: (req: Request) => Promise<Response>;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createGlassboxRoutes: ${name} is required`);
  }
  return value;
}

export function createGlassboxRoutes(
  config: GlassboxRoutesConfig,
): GlassboxRoutes {
  const installToken = requireString('installToken', config.installToken);
  const extensionId = requireString('extensionId', config.extensionId);
  const brainEndpoint = requireString('brainEndpoint', config.brainEndpoint);
  const brainJwt = requireString('brainJwt', config.brainJwt);
  const brainAnonKey = requireString('brainAnonKey', config.brainAnonKey);
  const appId = requireString('appId', config.appId);

  const proxy = createProxyHandler({
    installToken,
    extensionId,
    brainEndpoint,
    brainJwt,
    brainAnonKey,
    appId,
    scrub: config.scrub,
    fetch: config.fetch,
  });

  const stream = createStreamHandler(
    {
      installToken,
      extensionId,
      appId,
      scrub: config.scrub,
    },
    config.subscribe ?? subscribe,
    config.subscribeApp ?? subscribeApp,
  );

  return { proxy, stream };
}
