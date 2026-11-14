/**
 * In-memory pub/sub adapter — dev fallback for single-process consumers.
 *
 * Used when UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN env vars are NOT set.
 * Works for local dev, tests, and any single-process consumer. Production
 * multi-instance deployments MUST configure Upstash (see pubsub-upstash.ts).
 *
 * Behavior:
 *   - Per-traceId fan-out: multiple subscribers see every published event.
 *   - Per-subscriber TTL: stream closes 60s after last event. Each new event
 *     refreshes the clock.
 *   - If no events arrive within 60s of subscription, stream closes empty.
 *   - Subscribers added AFTER an event still pick up subsequent events for
 *     that traceId (we do not replay history; see design doc — replay is
 *     covered by the brain-poll surface, not stream-tap).
 */

import {
  GLASSBOX_STREAM_TTL_MS,
  type GlassboxEvent,
  type GlassboxPubSub,
} from './types.js';

/**
 * Per-subscriber state: the controller (so we can enqueue events + close)
 * and a TTL timer (refreshed on every event; closes the stream on fire).
 */
interface Subscriber {
  controller: ReadableStreamDefaultController<GlassboxEvent>;
  ttlTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class MemoryPubSub implements GlassboxPubSub {
  private subscribers = new Map<string, Set<Subscriber>>();

  async publish(channelKey: string, event: GlassboxEvent): Promise<void> {
    const subs = this.subscribers.get(channelKey);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      if (sub.closed) continue;
      try {
        sub.controller.enqueue(event);
      } catch {
        // Controller already closed by consumer cancel; just skip.
        sub.closed = true;
        continue;
      }
      // Refresh per-subscriber TTL — rolling 60s window since last event.
      this.refreshTtl(channelKey, sub);
    }
  }

  subscribe(channelKey: string): ReadableStream<GlassboxEvent> {
    const self = this;
    let sub: Subscriber | undefined;

    return new ReadableStream<GlassboxEvent>({
      start(controller) {
        sub = {
          controller,
          ttlTimer: setTimeout(() => {
            self.closeSubscriber(channelKey, sub!);
          }, GLASSBOX_STREAM_TTL_MS),
          closed: false,
        };
        let set = self.subscribers.get(channelKey);
        if (!set) {
          set = new Set();
          self.subscribers.set(channelKey, set);
        }
        set.add(sub);
      },
      cancel() {
        if (sub) self.removeSubscriber(channelKey, sub);
      },
    });
  }

  /**
   * Refresh the rolling TTL for a subscriber after an event lands. Replaces
   * the existing timer with a fresh 60s one.
   */
  private refreshTtl(channelKey: string, sub: Subscriber): void {
    clearTimeout(sub.ttlTimer);
    sub.ttlTimer = setTimeout(() => {
      this.closeSubscriber(channelKey, sub);
    }, GLASSBOX_STREAM_TTL_MS);
  }

  /**
   * Close the subscriber's stream cleanly and remove from the fan-out set.
   * Idempotent — safe to call multiple times.
   */
  private closeSubscriber(channelKey: string, sub: Subscriber): void {
    if (sub.closed) return;
    sub.closed = true;
    clearTimeout(sub.ttlTimer);
    try {
      sub.controller.close();
    } catch {
      // Already closed by consumer; ignore.
    }
    this.removeSubscriber(channelKey, sub);
  }

  private removeSubscriber(channelKey: string, sub: Subscriber): void {
    clearTimeout(sub.ttlTimer);
    const set = this.subscribers.get(channelKey);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(channelKey);
  }

  /**
   * Test-only reset. Tears down all subscribers, clears all state. Calling
   * outside of tests is harmless but cancels every active stream.
   */
  _reset(): void {
    for (const [, set] of this.subscribers) {
      for (const sub of set) {
        this.closeSubscriber('', sub);
      }
    }
    this.subscribers.clear();
  }
}
