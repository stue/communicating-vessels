/**
 * Internal config + hook types for createGlassboxRoutes().
 *
 * The public contract lives on `GlassboxRoutesConfig` in ./index.ts; these
 * are the narrower per-handler shapes consumed by proxy.ts and stream.ts.
 */

import type { GlassboxEvent } from '../glassbox/types.js';
import type { SectionKind } from '../ir.js';

// Re-export `SectionKind` so consumers can import it alongside
// `TraceSectionRewrite` from the same module without dipping into ir.js.
export type { SectionKind } from '../ir.js';

/**
 * Optional sanitization hook. Called with each event/row BEFORE it leaves
 * the consumer's edge. Default is identity. The hook is wrapped in
 * try/catch — a buggy scrub MUST NOT crash the route.
 *
 * For stream events, return a GlassboxEvent. For proxy rows, return any
 * object shape. The signature is intentionally permissive — see the
 * `scrub` parameter on `GlassboxRoutesConfig`.
 */
export type ScrubHook = (
  input: GlassboxEvent | Record<string, unknown>,
) => GlassboxEvent | Record<string, unknown>;

export interface ProxyConfig {
  installToken: string;
  extensionId: string;
  brainEndpoint: string;
  /** Scoped JWT for `Authorization: Bearer` — drives RLS via `app_id` claim. */
  brainJwt: string;
  /**
   * Anon/publishable key for the Supabase `apikey` header. Supabase rejects
   * any apikey that isn't one of the project's known keys; the scoped JWT
   * doesn't qualify there even though it's HS256-signed with the same secret.
   * Pass the project's legacy `anon` key (JWT format, role=anon) OR the
   * modern `sb_publishable_...` key — both are safe to expose at the wire.
   */
  brainAnonKey: string;
  appId: string;
  scrub?: ScrubHook;
  /**
   * Injectable fetch for testing. When omitted, the runtime's
   * `globalThis.fetch` is used (available in Vercel Edge + Node 18+).
   */
  fetch?: typeof fetch;
}

/**
 * Wire contract for the Glass-Box Chrome extension's brain-poll endpoint.
 *
 * The list mode of `proxy(req)` returns `{ traces: TraceSummary[] }`. The
 * detail mode (`?traceId=<id>`) returns a single `TraceDetail`. These are
 * the camelCase shapes the extension renderer expects — distinct from the
 * snake_case `compile_outcomes` row shape that PostgREST returns. The
 * factory's typed `rowToSummary` / `rowToDetail` transformer is the single
 * canonical boundary between the DB shape and the wire shape (see
 * `feedback_typed_boundary_transformers.md` in kgauto memory for the rule).
 */
export interface TraceSummary {
  traceId: string;
  appId: string;
  archetype: string;
  target: string;
  createdAt: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
}

/**
 * alpha.28 — extension/adapter parameter for advisory-driven mutations.
 *
 * Re-exported from the canonical definition in `v2/src/ir.ts` where
 * `BestPracticeAdvisory.suggestedAdaptation` already references it. Phase 2
 * consolidation of the alpha.28-rc1 wire-contract duplicate into the
 * cliff-advisor's single source of truth. Closed discriminated union (R3) —
 * future variants extend the canonical union in ir.ts explicitly.
 */
export type { Adapter } from '../ir.js';
import type { Adapter } from '../ir.js';

export interface AdvisoryRecord {
  level: 'info' | 'warn' | 'critical';
  /** Stable advisory identifier, e.g. "caching-off-on-claude". */
  code: string;
  /** Consumer-renderable message — no internal jargon ("L-040", "R3" etc.). */
  message: string;
  /** Optional secondary one-liner. Renders below `message` in italics. */
  suggestion?: string;
  /** Deep link to the relevant section of `interfaces/kgauto.md` or docs. */
  docsUrl?: string;
  /**
   * alpha.28+ — closed-union adaptation hint surfaced by the advisor when
   * the advisory can be auto-mitigated by a config knob. Renderer surfaces
   * as `→ try toolOrchestration: 'sequential'` on the advisory row.
   *
   * MUST stay byte-identical to Builder C's
   * `BestPracticeAdvisory.suggestedAdaptation` shape (verified at Phase 2
   * integration; the Adapter type itself is the contract).
   */
  suggestedAdaptation?: Adapter;
}

/**
 * Cost-equivalent alternative the chain could have served. Computed at
 * detail-view time by `computeCounterfactuals()` against the served row's
 * observed token counts + archetype + cache state. Up to 2 entries, sorted
 * cheapest first.
 */
export interface TraceCounterfactual {
  modelId: string;
  estimatedCostUsd: number;
  /** servedCostUsd - estimatedCostUsd (always > 0; only ≥10% savings kept). */
  savingsUsd: number;
  /** 0-100. */
  savingsPercent: number;
  /** Plain-English rationale tying archetype + perf score. */
  reason: string;
}

/**
 * Derived axis-health tri-state for the three Glass-Box dots
 * (input-ratio · cache · fallback). Renderer reads; transformer computes.
 *
 * Thresholds (locked in design contract Phase 0):
 *   - inputRatio: green ≤ 0.65 · yellow 0.65–0.85 · red > 0.85
 *   - cache (only when historyCacheableTokens > 1000):
 *       green if inputCacheHitRatio ≥ 0.5
 *       yellow if 0.1 ≤ inputCacheHitRatio < 0.5
 *       red if inputCacheHitRatio < 0.1
 *       na if historyCacheableTokens ≤ 1000
 *   - fallback: red iff fellOverFrom !== undefined && fellOverFrom !== target
 */
export interface TraceHealth {
  inputRatioStatus: 'green' | 'yellow' | 'red';
  cacheStatus: 'green' | 'yellow' | 'red' | 'na';
  fallbackStatus: 'green' | 'red';
}

/**
 * alpha.29+ — wire-boundary representation of a translator section-rewrite.
 *
 * Distinct from the package-internal `SectionRewrite` type in `ir.ts`: this
 * shape drops `originalText` + `transformedText` because those may carry
 * consumer PII. The renderer shows the `rule` + `summary` only. Full text
 * stays on `compile_outcomes.section_rewrites_applied` (Supabase row), gated
 * by RLS for brain-side cross-app learning.
 */
export interface TraceSectionRewrite {
  /** Stable id of the rewritten section. */
  sectionId: string;
  /** Section-kind discriminator that triggered the rewrite. */
  kind: SectionKind;
  /** Stable rule identifier (e.g. `'sequential-tool-cliff-below-floor'`). */
  rule: string;
  /**
   * Plain-English one-liner describing what fired and why. Renderer surfaces
   * this on the Coaching card; no internal jargon ("L-040", "below floor").
   */
  summary: string;
}

export interface TraceDetail extends TraceSummary {
  // ── unchanged from alpha.26 (tighter types) ──────────────────────────
  mutationsApplied: string[];
  advisories: AdvisoryRecord[];
  rawRequest?: string;
  rawResponse?: string;

  // ── new in alpha.28 ─────────────────────────────────────────────────
  // identity refinements
  /** Set when consumer passed a forceModel / fallback fired. */
  requestedModel?: string;
  /** Provider finish reason — 'stop' / 'max_tokens' / 'tool_use' / etc. */
  finishReason?: string;

  // timing
  /** Time to first token (ms); populated when provider surfaces it. */
  ttftMs?: number;
  /** End-to-end wall-clock (ms); from migration 018. */
  totalMs?: number;

  // shape
  /** Tools kept after relevance pass. */
  toolsCount?: number;
  /** Number of history messages at compile time. */
  historyDepth?: number;
  /** Rendered system prompt size in characters. */
  systemPromptChars?: number;

  // caching (default 0 for pre-018 rows — never undefined on these three)
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  historyCacheableTokens: number;
  /** Derived: cacheReadInputTokens / max(tokensIn, 1). 0-1. */
  inputCacheHitRatio: number;

  // fallback (both set together — never one without the other)
  fellOverFrom?: string;
  // One derivation: this IS ir.ts's FallbackReason (the alpha.77 DTS break
  // caught this file's inline copy drifting when the canonical union grew).
  fallbackReason?: import('../ir.js').FallbackReason;
  /** KG-18 step 1 (alpha.111) — balance / quota / outage / refusal / quality behind the fall-over. */
  fallbackClass?: 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';
  /** KG-18 step 1 — the provider's own name for the limit that fired. */
  quotaId?: string;
  /** KG-18 step 0 — fingerprint of the key the call was served with (12 hex; never the key). */
  keyFingerprint?: string;

  // counterfactuals (Full-scope; computed by proxy at detail-view time)
  /** Up to 2 alternatives. Empty array (not undefined) when none qualify. */
  counterfactuals?: TraceCounterfactual[];
  /** Undefined when 7d volume < 5/day (insufficient data). */
  projectedDailyCostUsd?: number;

  /**
   * alpha.29+ — translator activity for this trace. Empty array (not
   * undefined) when no rewrites fired or pre-019 row. Surfaced in the
   * Glass-Box Coaching card as synthetic info-level rows. PII-safe by
   * construction: only sectionId + kind + rule + summary cross the wire.
   */
  sectionRewritesApplied: TraceSectionRewrite[];

  // derived (renderer convenience)
  health: TraceHealth;
}

export interface StreamConfig {
  installToken: string;
  extensionId: string;
  /**
   * App scope filter used by the per-app "tail-all" subscription (alpha.26).
   * When the consumer omits `?traceId=` in the URL, the stream handler routes
   * to `subscribeApp({ appId })` — backs the extension's default Live mode.
   * NEVER read from URL parameters: cross-tenant isolation requires the
   * appId be fixed at factory-construction time, not request time.
   */
  appId: string;
  scrub?: ScrubHook;
}
