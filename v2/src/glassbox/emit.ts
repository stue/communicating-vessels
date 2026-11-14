/**
 * emitGlassboxEvent — internal publisher used by call.ts (and friends).
 *
 * Critical-path rule (L-086 derived): emit MUST NEVER fail the user's
 * `call()` invocation. We wrap every publish in try/catch and silently drop
 * on adapter failure. The chat route would rather lose visibility for one
 * call than break the request flow.
 *
 * Adapter selection happens once at module load:
 *   if (UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN set) → UpstashPubSub
 *   else                                             → MemoryPubSub
 *
 * Test surface: getPubSub() returns the active singleton; _setPubSubForTests()
 * swaps it. subscribe.ts reads via getPubSub().
 */

import { MemoryPubSub } from './pubsub-memory.js';
import {
  UpstashPubSub,
  traceChannel,
  appChannel,
} from './pubsub-upstash.js';
import type {
  AdvisoryFiredData,
  CompileDoneData,
  CompileStartData,
  ExecuteAttemptData,
  ExecuteSuccessData,
  FallbackWalkedData,
  GlassboxEvent,
  GlassboxEventKind,
  GlassboxPubSub,
} from './types.js';

let activePubSub: GlassboxPubSub | undefined;

/**
 * Initialize (or return existing) pub/sub adapter based on env vars.
 * Picked at module load — process.env is read once. Tests use
 * `_setPubSubForTests` to override.
 */
export function getPubSub(): GlassboxPubSub {
  if (activePubSub) return activePubSub;
  const url = readEnv('UPSTASH_REDIS_URL');
  const token = readEnv('UPSTASH_REDIS_TOKEN');
  if (url && token) {
    activePubSub = new UpstashPubSub({ url, token });
  } else {
    activePubSub = new MemoryPubSub();
  }
  return activePubSub;
}

/**
 * Test-only: swap the active pub/sub. Calling without an arg resets to the
 * default-selection path (next getPubSub() call rebuilds from env vars).
 */
export function _setPubSubForTests(ps?: GlassboxPubSub): void {
  activePubSub = ps;
}

/**
 * Read process.env in a way that doesn't blow up in environments where
 * process is undefined (browser bundles, Deno). Returns undefined for both
 * missing-process and missing-key.
 */
function readEnv(key: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[key];
      return v && v.trim() !== '' ? v : undefined;
    }
  } catch {
    // process not available; fall through.
  }
  return undefined;
}

/**
 * The single emit entrypoint. Builds a GlassboxEvent envelope, publishes
 * via the active adapter, swallows any adapter error.
 *
 * Returns void synchronously — caller doesn't await. Publishing happens
 * async; failure paths log nothing by default (designed for fire-and-forget
 * from inside the hot call() path). If you need diagnostics, wire a custom
 * adapter in tests via `_setPubSubForTests`.
 */
export function emitGlassboxEvent(
  traceId: string,
  appId: string | undefined,
  kind: GlassboxEventKind,
  data: Record<string, unknown>,
): void {
  if (!traceId) return;
  const event: GlassboxEvent = { kind, at: Date.now(), data };
  const ps = getPubSub();
  // Dual-publish (alpha.26): emit to the per-trace channel (existing
  // `subscribe(traceId)` consumers) AND the per-app channel (new alpha.26
  // `subscribeApp({ appId })` for the extension's "tail all" Live mode).
  // Per-app publish only fires when appId is supplied; the substrate stays
  // backward-compatible for emits that don't carry an app context.
  try {
    const p1 = ps.publish(traceChannel(traceId), event);
    if (p1 && typeof p1.then === 'function') {
      p1.catch(() => {
        /* drop — library policy: visibility loss > call failure */
      });
    }
  } catch {
    // Sync throw from adapter (shouldn't happen with our adapters). Drop.
  }
  if (appId) {
    try {
      const p2 = ps.publish(appChannel(appId), event);
      if (p2 && typeof p2.then === 'function') {
        p2.catch(() => {
          /* drop */
        });
      }
    } catch {
      // Drop — per-app channel failure must not affect per-trace publish.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Typed event builders — call sites use these for type assistance.
// ─────────────────────────────────────────────────────────────────────────

// Typed builders carry both traceId and appId so dual-publish fires for every
// emit. The data.appId field on CompileStartData remains for renderer use; the
// channel-routing appId is a separate parameter (passed from `ir.appId` at
// the call-site) so emitters that don't expose appId in their data payload
// (execute.* / advisory.* / fallback.*) still get per-app routing.

export function emitCompileStart(
  traceId: string,
  appId: string | undefined,
  data: CompileStartData,
): void {
  emitGlassboxEvent(traceId, appId, 'compile.start', data as unknown as Record<string, unknown>);
}

export function emitCompileDone(
  traceId: string,
  appId: string | undefined,
  data: CompileDoneData,
): void {
  emitGlassboxEvent(traceId, appId, 'compile.done', data as unknown as Record<string, unknown>);
}

export function emitExecuteAttempt(
  traceId: string,
  appId: string | undefined,
  data: ExecuteAttemptData,
): void {
  emitGlassboxEvent(traceId, appId, 'execute.attempt', data as unknown as Record<string, unknown>);
}

export function emitExecuteSuccess(
  traceId: string,
  appId: string | undefined,
  data: ExecuteSuccessData,
): void {
  emitGlassboxEvent(traceId, appId, 'execute.success', data as unknown as Record<string, unknown>);
}

export function emitAdvisoryFired(
  traceId: string,
  appId: string | undefined,
  data: AdvisoryFiredData,
): void {
  emitGlassboxEvent(traceId, appId, 'advisory.fired', data as unknown as Record<string, unknown>);
}

export function emitFallbackWalked(
  traceId: string,
  appId: string | undefined,
  data: FallbackWalkedData,
): void {
  emitGlassboxEvent(traceId, appId, 'fallback.walked', data as unknown as Record<string, unknown>);
}
