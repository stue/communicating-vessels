/**
 * Public entry point for `@warmdrift/kgauto-compiler/glassbox`.
 *
 * Consumers import only from this barrel:
 *
 *   import {
 *     subscribe,
 *     type GlassboxEvent,
 *     type GlassboxEventKind,
 *   } from '@warmdrift/kgauto-compiler/glassbox';
 */

export { subscribe, subscribeApp } from './subscribe.js';
export {
  GLASSBOX_STREAM_TTL_MS,
  type GlassboxEvent,
  type GlassboxEventKind,
  type GlassboxPubSub,
  type CompileStartData,
  type CompileDoneData,
  type ExecuteAttemptData,
  type ExecuteSuccessData,
  type AdvisoryFiredData,
  type FallbackWalkedData,
} from './types.js';
