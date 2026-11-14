/**
 * Glass-Box observability types (alpha.17).
 *
 * The substrate for kgauto's in-flight observability surface — a Chrome MV3
 * side panel that renders compile + execute + advisor outputs in real-time.
 * See design doc:
 *   the Glass-Box design of 2026-05-18 (a private working note, not in this repository).
 *
 * Wire shape is intentionally minimal:
 *   { kind, at, data } — discriminated union by `kind`.
 *
 * Critical-path safety (L-086 derived): emit MUST NEVER fail the user's
 * `call()` invocation. emit.ts wraps every adapter write in try/catch +
 * silently drops on error. Consumers in Vercel Edge runtimes can lose one
 * event without losing the response.
 */

import type {
  CallAttempt,
  CompileResult,
  MutationApplied,
  BestPracticeAdvisory,
  FallbackReason,
} from '../ir.js';

/**
 * Discriminator. Six event kinds cover the v1 substrate. New kinds added
 * additively; the side-panel renderer treats unknown kinds as "ignore".
 */
export type GlassboxEventKind =
  | 'compile.start'
  | 'compile.done'
  | 'execute.attempt'
  | 'execute.success'
  | 'advisory.fired'
  | 'fallback.walked';

/**
 * Wire envelope. Every emit lands as one of these.
 *
 *   - kind:    discriminator
 *   - at:      unix milliseconds (Date.now())
 *   - data:    kind-specific payload
 *
 * `data` typed loosely as Record<string, unknown> for serialization-friendliness;
 * the per-kind builders below populate it with the structured shape expected
 * by the renderer. We deliberately do NOT typescript-narrow `data` by kind on
 * the wire type — the side panel reads JSON from SSE and only the renderer
 * needs the narrowed shape. Internal callers (emit.ts) get type assistance via
 * the typed factory helpers in emit.ts.
 */
export interface GlassboxEvent {
  kind: GlassboxEventKind;
  at: number;
  data: Record<string, unknown>;
}

/**
 * Per-kind data shapes. Surfaced as type aids; not enforced at the
 * GlassboxEvent boundary (intentionally — see comment above).
 */
export interface CompileStartData {
  appId: string;
  archetype: string;
  models: string[];
}

export interface CompileDoneData {
  target: string;
  provider: string;
  fallbackChain: string[];
  tokensIn: number;
  estimatedCostUsd: number;
  mutationsApplied: MutationApplied[];
  advisories: BestPracticeAdvisory[];
}

export interface ExecuteAttemptData {
  model: string;
  attemptIndex: number;
}

export interface ExecuteSuccessData {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface AdvisoryFiredData {
  code: string;
  message: string;
}

export interface FallbackWalkedData {
  from: string;
  to: string;
  reason: FallbackReason | 'unknown';
  attempt: CallAttempt;
}

/**
 * Pub/sub backend interface. Two adapters implement it: in-memory (dev /
 * single-process) and Upstash Redis Streams (Vercel Edge multi-instance).
 *
 * The choice is made at module load (NOT per-call) based on env-var presence:
 *   if (UPSTASH_REDIS_URL && UPSTASH_REDIS_TOKEN) → Upstash
 *   else                                          → in-memory
 *
 * Stream TTL: 60s after last event. After that, subscriber stream closes
 * cleanly. The adapter owns its own TTL clock; subscribe() is agnostic.
 */
export interface GlassboxPubSub {
  /**
   * Publish a single event to a channel key. The channel is an opaque
   * namespaced string — callers build it via `traceChannel(traceId)` or
   * `appChannel(appId)` (see pubsub-upstash.ts). Returns a promise that
   * resolves after the event is durably appended (or rejects on adapter
   * failure — callers in emit.ts always swallow rejections).
   *
   * Pre-alpha.26 the parameter was named `traceId` because there was only
   * one channel namespace; alpha.26 added per-app channels for the
   * "tail-all" Live tab subscription. Behavior identical to the adapters —
   * they treat the value as an opaque key — but the rename surfaces the
   * generalization at the type level.
   */
  publish(channelKey: string, event: GlassboxEvent): Promise<void>;

  /**
   * Subscribe to events on a channel key. Returns a ReadableStream that
   * emits GlassboxEvent objects as they're published. The stream closes
   * cleanly after the channel-level TTL elapses since the LAST event
   * (rolling 60s).
   *
   * If no publisher writes to the channel within 60s of subscription, the
   * stream closes empty.
   */
  subscribe(channelKey: string): ReadableStream<GlassboxEvent>;

  /**
   * Test-only escape hatch. Clears any in-memory state. Upstash adapter
   * no-ops (server-side state isn't accessible from here). Tests reach for
   * this between cases to keep adapters hermetic.
   */
  _reset?(): void;
}

/**
 * TTL applied to a stream after each event. The design doc names 60s; this
 * constant centralizes it so both adapters + tests agree.
 */
export const GLASSBOX_STREAM_TTL_MS = 60_000;
