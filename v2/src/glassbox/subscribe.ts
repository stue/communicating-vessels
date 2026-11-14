/**
 * subscribe(traceId) — public Glass-Box subscription export.
 *
 * Consumer route handlers (e.g. Vercel Edge `/api/glassbox/stream`) import
 * this and bridge the ReadableStream to SSE. The browser-side panel then
 * renders events in real time:
 *
 *   import { subscribe } from '@warmdrift/kgauto-compiler/glassbox';
 *
 *   export async function GET(req: Request) {
 *     const { searchParams } = new URL(req.url);
 *     const traceId = searchParams.get('traceId');
 *     if (!traceId) return new Response('missing traceId', { status: 400 });
 *     const stream = subscribe(traceId);
 *     // ... bridge ReadableStream<GlassboxEvent> → SSE here ...
 *   }
 *
 * Stream behavior:
 *   - Emits events for `traceId` as they're published.
 *   - Closes cleanly 60s after the last event (rolling TTL).
 *   - If no events arrive within 60s of subscription, closes empty.
 *   - Multiple subscribers on the same traceId all fan out.
 *
 * No replay: subscribe() picks up only events published AFTER subscription.
 * Replay is the brain-poll surface's job (see design doc).
 */

import { getPubSub } from './emit.js';
import { traceChannel, appChannel } from './pubsub-upstash.js';
import type { GlassboxEvent } from './types.js';

function emptyStream(): ReadableStream<GlassboxEvent> {
  return new ReadableStream<GlassboxEvent>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Subscribe to Glass-Box events for a traceId. Returns a ReadableStream
 * that yields GlassboxEvent objects until the per-trace TTL elapses.
 *
 * Cancelling the stream (consumer disconnect, AbortController, etc.) tears
 * down the subscription cleanly via the underlying adapter.
 */
export function subscribe(traceId: string): ReadableStream<GlassboxEvent> {
  // Empty traceId → empty stream (pragmatic; keeps SSE handler simple).
  if (!traceId) return emptyStream();
  return getPubSub().subscribe(traceChannel(traceId));
}

/**
 * Subscribe to Glass-Box events for ALL traces under an appId — the
 * "tail-all" surface (alpha.26). Backs the extension's default Live mode:
 * rather than needing a specific traceId ahead of time, the panel sees
 * every event for the configured consumer as calls happen.
 *
 * Per-app routing fires only when emit call-sites pass `appId` (the typed
 * builders thread `ir.appId` automatically). Per-trace channel continues to
 * fire for `subscribe(traceId)` callers — both arms are independent.
 *
 * Cross-tenant isolation: the consumer's `/api/glassbox/stream` uses the
 * factory's configured appId — no caller-supplied `?appId=` URL parameter,
 * so a consumer cannot subscribe to another consumer's stream.
 */
export function subscribeApp({
  appId,
}: {
  appId: string;
}): ReadableStream<GlassboxEvent> {
  if (!appId) return emptyStream();
  return getPubSub().subscribe(appChannel(appId));
}
