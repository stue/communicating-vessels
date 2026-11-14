/**
 * stream(req) — Glass-Box live SSE handler.
 *
 * GET /api/glassbox/stream?traceId=<id>  → text/event-stream
 *
 * Bridges the alpha.17 `subscribe(traceId)` ReadableStream<GlassboxEvent>
 * to the SSE wire format. The first frame is always `event: ready` so
 * clients know the connection is alive before any real event lands. The
 * underlying pub/sub adapter owns TTL (60s rolling); when its source
 * stream closes, we close the SSE response cleanly.
 *
 * Disconnect handling: when the client aborts (browser tab close, network
 * drop, EventSource.close()), we cancel the source ReadableStream so the
 * adapter can release its reader and the per-trace TTL timer.
 */

import { checkAuth } from './auth.js';
import type { GlassboxEvent } from '../glassbox/types.js';
import type { StreamConfig, ScrubHook } from './types.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: JSON_HEADERS,
  });
}

function applyScrub(
  event: GlassboxEvent,
  scrub: ScrubHook | undefined,
): GlassboxEvent {
  if (!scrub) return event;
  try {
    const out = scrub(event);
    // Defensive: if the scrub returns a non-GlassboxEvent (e.g. caller
    // returns the inner `data` by mistake), fall back to the original
    // event rather than crash the stream. Same rationale as proxy.ts.
    if (
      out &&
      typeof out === 'object' &&
      typeof (out as GlassboxEvent).kind === 'string' &&
      typeof (out as GlassboxEvent).at === 'number'
    ) {
      return out as GlassboxEvent;
    }
    return event;
  } catch {
    return event;
  }
}

function sseFrame(eventName: string, data: unknown): string {
  // Sanitize event name — SSE field names cannot contain CR/LF.
  const safeName = eventName.replace(/[\r\n]/g, '');
  return `event: ${safeName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SubscribeFn {
  (traceId: string): ReadableStream<GlassboxEvent>;
}

export interface SubscribeAppFn {
  (args: { appId: string }): ReadableStream<GlassboxEvent>;
}

export function createStreamHandler(
  config: StreamConfig,
  subscribe: SubscribeFn,
  subscribeApp: SubscribeAppFn,
): (req: Request) => Promise<Response> {
  const { installToken, extensionId, appId, scrub } = config;

  return async function stream(req: Request): Promise<Response> {
    const authFail = checkAuth(req, { installToken, extensionId });
    if (authFail) return authFail;

    const url = new URL(req.url);
    const traceId = url.searchParams.get('traceId');
    // alpha.26: missing traceId → "tail-all" mode subscribing to all events
    // for the configured appId. Cross-tenant safe: appId comes from the
    // factory config (fixed at construction), never from the URL.
    const source = traceId
      ? subscribe(traceId)
      : subscribeApp({ appId });
    const encoder = new TextEncoder();

    // We need a reference to the reader so the abort handler can cancel
    // the source on client disconnect.
    let sourceReader: ReadableStreamDefaultReader<GlassboxEvent> | undefined;
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Emit `ready` before reading from source so the EventSource
        // `open` event fires even if the source has no events yet.
        controller.enqueue(encoder.encode(sseFrame('ready', {})));

        sourceReader = source.getReader();

        // Wire client-abort → source cancel. AbortSignal.addEventListener
        // is supported in all Edge / Node runtimes we target.
        const signal = req.signal;
        if (signal) {
          if (signal.aborted) {
            cancelled = true;
            await sourceReader.cancel();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              sourceReader?.cancel().catch(() => {
                /* swallow */
              });
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        }

        try {
          while (!cancelled) {
            const { value, done } = await sourceReader.read();
            if (done) break;
            const scrubbed = applyScrub(value, scrub);
            controller.enqueue(
              encoder.encode(sseFrame(scrubbed.kind, scrubbed)),
            );
          }
        } catch {
          // Adapter blew up mid-stream — close gracefully. Better to drop
          // the connection than to leak an error frame and a hung reader.
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          // Belt-and-suspenders: release the reader so the underlying
          // pub/sub adapter can tear down its TTL timer.
          try {
            sourceReader?.releaseLock();
          } catch {
            /* lock already released */
          }
        }
      },
      cancel() {
        cancelled = true;
        sourceReader?.cancel().catch(() => {
          /* swallow */
        });
      },
    });

    return new Response(body, { status: 200, headers: SSE_HEADERS });
  };
}
