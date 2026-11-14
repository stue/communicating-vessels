/**
 * Golden-set capture (alpha.62, eval spine — design brief 2026-07-17).
 *
 * The eval-driven self-improvement contract needs a replay corpus: 20–50 real
 * historical IRs per (app, archetype), stored WITH the incumbent's output.
 * This module is the capture side — a sampling gate on call()'s success path
 * that stores the full PromptIR + served response to `kgauto_golden_irs`.
 *
 * ## Consent posture (s51 amendment, ratified 2026-07-17)
 *
 * Golden rows carry RAW prompts — a deliberate, documented departure from the
 * s51 "brain holds no raw consumer prompts" rule. Capture is therefore
 * strictly opt-in:
 *
 *   - `KGAUTO_GOLDEN_CAPTURE=0.1` in the consumer's environment (the env var
 *     IS the consent act — the consumer's operator sets it knowingly), or
 *   - `CallOptions.goldenCapture.sampleRate` in consumer code.
 *
 * Default is 0 (off): absent flag, empty string, non-finite, or ≤0 all mean
 * "never capture". Every stored row records its consent provenance in the
 * `consent` column. Reads are strictly app-scoped (RLS) — a consumer can only
 * ever see its own raw prompts.
 */

import type { PromptIR, NormalizedResponse } from './ir.js';
import { recordGoldenIr } from './brain.js';

/** Consumer-facing capture options (CallOptions.goldenCapture). */
export interface GoldenCaptureOptions {
  /**
   * Probability [0..1] that a successful call's IR + output is stored as a
   * golden row. Overrides the KGAUTO_GOLDEN_CAPTURE env var when set.
   */
  sampleRate?: number;
  /**
   * Optional free-text appended to the stored consent provenance (e.g. a
   * ticket ref or the operator who approved capture for this surface).
   */
  consentNote?: string;
}

/**
 * Parse a capture-rate env value. Mirrors the consumer-side
 * `parseShadowProbeRate` semantics playbacksam established: undefined, empty,
 * or non-finite → 0 (default-OFF); result clamped to [0, 1].
 */
export function parseGoldenCaptureRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Resolve the effective capture rate: explicit option wins; otherwise the
 * KGAUTO_GOLDEN_CAPTURE env var (when a process env exists — Edge-safe).
 */
export function resolveGoldenCaptureRate(optRate?: number): number {
  if (optRate !== undefined && Number.isFinite(optRate)) {
    return Math.max(0, Math.min(1, optRate));
  }
  const env =
    typeof process !== 'undefined' && process.env
      ? process.env.KGAUTO_GOLDEN_CAPTURE
      : undefined;
  return parseGoldenCaptureRate(env);
}

/** Sampling gate. Injectable rng for tests (same shape as shouldSampleProbe). */
export function shouldCaptureGolden(
  rate: number,
  rng: () => number = Math.random,
): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng() < rate;
}

/** Everything call()'s success path has in scope when capture fires. */
export interface GoldenCaptureContext {
  ir: PromptIR;
  servedModel: string;
  response: NormalizedResponse;
  latencyMs: number;
  handle: string;
  /** Compile-time shape key (peeked before record() popped the registry). */
  shapeKey?: string;
  /** How the rate was resolved — recorded as consent provenance. */
  consent: string;
}

/**
 * Store one golden row from a live served call. Fire-and-forget discipline is
 * recordGoldenIr()'s (dead-letter, ledger, honors BrainConfig.sync); this
 * wrapper only shapes the row. Never throws.
 */
export async function captureGoldenIr(ctx: GoldenCaptureContext): Promise<void> {
  try {
    await recordGoldenIr({
      appId: ctx.ir.appId,
      archetype: ctx.ir.intent.archetype,
      shapeKey: ctx.shapeKey,
      ir: ctx.ir,
      incumbentModel: ctx.servedModel,
      incumbentOutput: ctx.response.text,
      incumbentLatencyMs: ctx.latencyMs,
      incumbentTokensIn: ctx.response.tokens.input,
      incumbentTokensOut: ctx.response.tokens.output,
      source: 'sampled',
      consent: ctx.consent,
      outcomeHandle: ctx.handle,
    });
  } catch {
    // Capture must never affect the caller. recordGoldenIr already routes
    // failures to onError + dead-letter; this catch is belt-and-suspenders.
  }
}
