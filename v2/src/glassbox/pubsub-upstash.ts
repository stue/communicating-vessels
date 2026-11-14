/**
 * Upstash Redis Streams pub/sub adapter — Vercel Edge multi-instance backend.
 *
 * Used when UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN env vars are set. Writers
 * append to the stream `glassbox:trace:<traceId>` via XADD; readers pull via
 * XREAD BLOCK. Both can sit on any Edge instance (the design closes the
 * pub/sub-doesn't-cross-instance gap in the office-hours doc).
 *
 * Wire protocol: Upstash REST API. We talk via plain fetch so the package
 * stays zero-runtime-dep. The REST shape is:
 *
 *   POST <UPSTASH_REDIS_URL>
 *   Authorization: Bearer <UPSTASH_REDIS_TOKEN>
 *   Content-Type: application/json
 *   Body: ["XADD", "glassbox:trace:abc", "*", "event", "<json>"]
 *
 * Stream maintenance:
 *   - XADD with MAXLEN ~100 trims approximately to 100 entries
 *   - EXPIRE on the stream key, refreshed on each emit (60s TTL)
 *
 * Reader uses XREAD BLOCK with cursor `$` (only new entries) and a 100ms
 * block timeout, looping until the per-trace TTL elapses since last event.
 *
 * Test surface: pass `fetchImpl` to the constructor to inject a mock. The
 * factory in emit.ts wires real fetch by default.
 */

import {
  GLASSBOX_STREAM_TTL_MS,
  type GlassboxEvent,
  type GlassboxPubSub,
} from './types.js';

export interface UpstashConfig {
  url: string;
  token: string;
  /** Override fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * XREAD block timeout in ms — how long the reader waits server-side before
   * returning empty. Lower = more REST calls but lower close latency on TTL
   * fire. Default 100ms (matches design-doc note: events visible within
   * 200ms of emission).
   */
  blockMs?: number;
  /**
   * Approximate cap on stream length — XADD uses `MAXLEN ~ <maxLen>` so old
   * entries trim as new ones append. Approximate means slightly more than
   * maxLen may live briefly. Default 100 (matches design doc).
   */
  maxLen?: number;
}

/**
 * Upstash REST commands return `{ result: <value> }` on success and
 * `{ error: <string> }` on failure. We surface failures by rejecting the
 * adapter's publish() promise — emit.ts wraps in try/catch so this never
 * bubbles to the user's call().
 */
interface UpstashResponse {
  result?: unknown;
  error?: string;
}

export class UpstashPubSub implements GlassboxPubSub {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly blockMs: number;
  private readonly maxLen: number;

  constructor(cfg: UpstashConfig) {
    this.url = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.blockMs = cfg.blockMs ?? 100;
    this.maxLen = cfg.maxLen ?? 100;
  }

  async publish(channelKey: string, event: GlassboxEvent): Promise<void> {
    // channelKey is the fully-namespaced stream key (e.g. `glassbox:trace:<id>`
    // or `glassbox:app:<id>`). emit.ts builds these via traceChannel() /
    // appChannel() helpers; adapter treats the value as opaque.
    const key = channelKey;
    const payload = JSON.stringify(event);
    // XADD <key> MAXLEN ~ <maxLen> * event <json>
    await this.cmd([
      'XADD',
      key,
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      'event',
      payload,
    ]);
    // Refresh TTL on every emit so the stream lives 60s past the last event.
    // Upstash EXPIRE takes seconds.
    await this.cmd(['EXPIRE', key, String(Math.ceil(GLASSBOX_STREAM_TTL_MS / 1000))]);
  }

  subscribe(channelKey: string): ReadableStream<GlassboxEvent> {
    const key = channelKey;
    const self = this;
    let cursor = '$';
    let cancelled = false;
    let ttlDeadline = Date.now() + GLASSBOX_STREAM_TTL_MS;

    return new ReadableStream<GlassboxEvent>({
      async start(controller) {
        try {
          while (!cancelled && Date.now() < ttlDeadline) {
            const resp = await self.cmd([
              'XREAD',
              'BLOCK',
              String(self.blockMs),
              'STREAMS',
              key,
              cursor,
            ]);
            if (cancelled) break;
            const parsed = parseXReadResult(resp.result);
            if (parsed.entries.length === 0) {
              // No event in this block window. Loop until TTL.
              continue;
            }
            for (const entry of parsed.entries) {
              const evt = decodeEvent(entry.fields);
              if (evt) {
                try {
                  controller.enqueue(evt);
                } catch {
                  // Consumer cancelled mid-fan-out.
                  cancelled = true;
                  break;
                }
              }
              cursor = entry.id;
            }
            // Refresh deadline — rolling 60s window since last event.
            ttlDeadline = Date.now() + GLASSBOX_STREAM_TTL_MS;
          }
        } catch (err) {
          // Adapter failure — close gracefully. emit.ts swallows on the
          // publish side; the subscriber side surfaces by ending the stream.
          if (!cancelled) {
            try {
              controller.error(err);
            } catch {
              // Already errored / closed.
            }
            return;
          }
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  private async cmd(args: string[]): Promise<UpstashResponse> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`Upstash ${args[0]} failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as UpstashResponse;
    if (json.error) {
      throw new Error(`Upstash ${args[0]} failed: ${json.error}`);
    }
    return json;
  }
}

/**
 * Build the canonical stream key for a traceId. Centralized so tests can
 * assert on the wire shape without re-coupling to string templates.
 */
export function streamKey(traceId: string): string {
  return traceChannel(traceId);
}

/**
 * Canonical channel key for a per-trace stream. Used by `subscribe(traceId)`
 * + the trace-arm of dual-publish in emit.ts.
 */
export function traceChannel(traceId: string): string {
  return `glassbox:trace:${traceId}`;
}

/**
 * Canonical channel key for a per-app "tail-all" stream (alpha.26). All
 * GlassboxEvents for an app fan out to this channel as well as the per-trace
 * channel — gives the extension a single subscription that catches every
 * call's events without needing to know the traceId in advance. Used by
 * `subscribeApp({ appId })` + the app-arm of dual-publish in emit.ts.
 */
export function appChannel(appId: string): string {
  return `glassbox:app:${appId}`;
}

/**
 * Decode the `fields` Map from an XREAD entry back into a GlassboxEvent.
 * Returns undefined if decoding fails — emit.ts already wraps in try/catch
 * so we surface decode failures as "skip this entry" rather than poisoning
 * the stream.
 */
function decodeEvent(fields: Record<string, string>): GlassboxEvent | undefined {
  const raw = fields['event'];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as GlassboxEvent;
    if (typeof parsed.kind === 'string' && typeof parsed.at === 'number') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse Upstash's XREAD response shape into a flat list of entries.
 *
 * Upstash returns XREAD as:
 *   [
 *     ["<stream-key>", [
 *       ["<entry-id>", ["<field>", "<value>", "<field>", "<value>", ...]],
 *       ...
 *     ]]
 *   ]
 *
 * Null when no entries within block window.
 */
export function parseXReadResult(
  raw: unknown,
): { entries: { id: string; fields: Record<string, string> }[] } {
  if (!Array.isArray(raw)) return { entries: [] };
  const entries: { id: string; fields: Record<string, string> }[] = [];
  for (const stream of raw) {
    if (!Array.isArray(stream) || stream.length < 2) continue;
    const streamEntries = stream[1];
    if (!Array.isArray(streamEntries)) continue;
    for (const entry of streamEntries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const id = String(entry[0]);
      const flat = entry[1];
      if (!Array.isArray(flat)) continue;
      const fields: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) {
        const k = flat[i];
        const v = flat[i + 1];
        if (typeof k === 'string') fields[k] = String(v ?? '');
      }
      entries.push({ id, fields });
    }
  }
  return { entries };
}
