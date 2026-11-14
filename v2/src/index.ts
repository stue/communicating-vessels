/**
 * @warmdrift/kgauto v2 — prompt compiler + central learning brain.
 *
 * Two functions you'll use most:
 *   compile(ir, opts?) → CompileResult
 *   record(input)      → Promise<void>
 *
 * Plus:
 *   configureBrain({ endpoint, apiKey })  — point at the central brain
 *   buildLLMJudge({ judgeCall })          — cold-start oracle
 *
 * Quickstart:
 *
 *   import { compile, record, configureBrain } from '@warmdrift/kgauto';
 *
 *   configureBrain({ endpoint: 'https://kgauto-brain.vercel.app/api', apiKey: '...' });
 *
 *   const r = compile({
 *     appId: 'my-app',
 *     intent: { name: 'search', archetype: 'ask' },
 *     sections: [
 *       { id: 'role', text: 'You are an assistant.', cacheable: true },
 *       { id: 'task', text: userQuestion },
 *     ],
 *     models: ['claude-sonnet-4-6', 'gemini-2.5-flash'],
 *   });
 *
 *   const start = Date.now();
 *   const response = await callProvider(r.target, r.request);
 *
 *   await record({
 *     handle: r.handle,
 *     tokensIn: response.usage.input,
 *     tokensOut: response.usage.output,
 *     latencyMs: Date.now() - start,
 *     success: true,
 *     oracleScore: { score: 0.85 },
 *   });
 */

import { compile as compileImpl, type CompileOptions } from './compile.js';
import { registerCompile } from './brain.js';
import type { CompileResult, PromptIR } from './ir.js';

/**
 * Compile a request. Wraps the pure compile() with brain registration so
 * record() can find call metadata later.
 */
export function compile(ir: PromptIR, opts?: CompileOptions): CompileResult {
  const result = compileImpl(ir, opts);
  // alpha.68 / Release A — forward the fan-out parent handle so registerCompile
  // derives the linkage (fanout_role / trace_id / parent_handle) onto the row.
  registerCompile(ir.appId, ir.intent.archetype, ir, result, opts?.parentHandle, opts?.route);
  return result;
}

// ── Call orchestrator (alpha.3) ──
export { call, servedModelDiffers,
} from './call.js';
export { execute, isModelUnavailableMessage } from './execute.js';
// alpha.117 — the failure classifiers, public. A consumer that instantiates its own models and
// restarts through its own fell-over (tt-intelligence) kept a COPY of these patterns, and a copy
// drifts: on 2026-09-29 the library learned Anthropic's spend-limit sentence (alpha.116) and the
// copy did not. One derivation, exported; consumers call it with the status, the parsed body and
// the message they already hold.
export { classifyFallback, isBillingExhaustedBody } from './streaming.js';
export type { FallbackClass } from './streaming.js';
// alpha.132 (R3) — the thinking-block prefix check: the beta header, the
// models that take the control, the 400's sentence, and the advisory codes.
export {
  THINKING_BINDING_BETA,
  BLOCK_BINDING_MODELS,
  THINKING_PREFIX_DROPPED_CODE,
  THINKING_UNREADABLE_DROPPED_CODE,
  THINKING_PREFIX_RECOVERED_CODE,
} from './request-shapes.js';
export { THINKING_SIGNATURE_SENTENCE, isThinkingSignatureMessage } from './streaming.js';
export type { ExecuteResult, ExecuteOptions, ExecuteOk, ExecuteErr } from './execute.js';

// ── Standalone shadow probe for AI-SDK consumers (alpha.48) ──
// tt-intel + IC own their streamText round-trip and never call call(); they
// fire probeShadow() from onFinish (wrapped in waitUntil()/after()) to land
// full-IR `inline-full-ir` probe rows. Same candidate loop as the call()-inline
// probe; consumer supplies the served leg.
export { probeShadow } from './call.js';
export type { ProbeShadowOptions, ProbeShadowServed } from './call.js';

// ── AI-SDK streamText helpers (alpha.33) ──
// Closes the cross-consumer `streamText-cache-marker-propagation-gap`
// surfaced by IC + tt-intel on 2026-05-20. Consumers using
// `streamText({ messages: convertToModelMessages(...) })` silently dropped
// Anthropic cache_control markers; this helper re-attaches them at the
// deterministic indices the compiler computed.
export {
  attachCacheControlToStreamTextInput,
  type AISDKConvertedMessage,
  type AttachCacheControlResult,
} from './streamtext-helpers.js';

// ── Official AI-SDK-v6 compile adapter + compile-then-discard guard (alpha.52) ──
// Centralizes the per-consumer hand-rolled `compileForAISDKv6` wrapper (system
// reassembly, kept-tool extraction, cache-mark index) AND closes the
// compile-then-discard hole: reading `.system`/`.model`/`.raw` on the result
// marks the compile "consumed"; recording the handle without reading any of
// them triggers a dev-mode warning (the library now owns the object the final
// caller reads, so consume-tracking is reliable). See `interfaces/kgauto.md`
// (## Requested: compiled-output-discarded-guard).
export { compileForAISDKv6 } from './compile-aisdk.js';
export type { CompileForAISDKv6Result } from './compile-aisdk.js';

// ── Brain ──
export { configureBrain, clearBrain, record, recordOutcome, recordShadowProbe, buildShadowProbeRow, isBrainSync } from './brain.js';
// alpha.87 — KGAUTO_SOURCE env default for the synthetic self-mark (exported for tests + operator scripts).
export { resolveOutcomeSource, _testResetOutcomeSourceWarning } from './brain.js';
export type { BrainConfig, OutcomePayload, ShadowProbeRecordInput } from './brain.js';
// alpha.61 (G1 reliability floor) — delivery ledger + bounded dead-letter.
export { brainHealth, peekBrainDeadLetter, flushBrainDeadLetter } from './brain.js';
export type { BrainHealthSnapshot, BrainDeadLetterEntry } from './brain.js';

// ── Golden-set eval spine (alpha.62 — design brief 2026-07-17) ──
// Capture: KGAUTO_GOLDEN_CAPTURE / CallOptions.goldenCapture samples full IRs
// + incumbent output into the brain's replay corpus (explicit consumer
// opt-in — raw prompts, s51 posture amendment). Eval: pairwise judge +
// mechanical hard floors + the promotion bar (not worse on N of M judged cases) over that corpus.
export { recordGoldenIr, buildGoldenIrRow } from './brain.js';
export type { GoldenIrRecordInput } from './brain.js';
export {
  parseGoldenCaptureRate,
  resolveGoldenCaptureRate,
  shouldCaptureGolden,
  captureGoldenIr,
} from './golden.js';
export type { GoldenCaptureOptions } from './golden.js';
export {
  runGoldenEval,
  rubricFor,
  buildPairwiseJudgePrompt,
  parseJudgeVerdict,
  combineOrderSwappedVerdicts,
  renderIrForJudge,
  JUDGE_RUBRICS,
  // Release B — strategy axis + loss-triggered wording attribution.
  withDisciplineContract,
  withAltDisciplineContract,
  altGatesBlockFor,
  classifyStrategyOutcome,
  runStrategyEvalWithAttribution,
  STRATEGY_AUTHORSHIP_LIMITATION,
  DISCIPLINE_GATES_V1_ALT_HEADER,
  // The independently-authored third arm (cc commission, 2026-07-29) — the
  // one that makes a both-lose verdict mean something. Exported at parity
  // with the alt arm so an operator script can reach it without reimporting
  // internals, and `ALT_BLIND_TOKEN_BUDGET_BREACH` travels WITH the block:
  // anyone measuring this arm needs the confound in the same import.
  withAltBlindDisciplineContract,
  altBlindGatesBlockFor,
  DISCIPLINE_GATES_V1_ALT_BLIND_HEADER,
  ALT_BLIND_TOKEN_BUDGET_BREACH,
  STRATEGY_AUTHORSHIP_INDEPENDENT,
  isAltStrategy,
  ALT_STRATEGY_IDS,
  // Judge default, exported so the trigger's judge pre-flight probes the
  // same model the engine will call (2026-08-25 judge-preflight gap).
  DEFAULT_JUDGE_MODEL,
  // alpha.102 — the delta report's positive control + attrition guard
  CONTROL_STRATEGY_ID,
  degradeControlArm,
  controlDamageApplied,
  controlPassed,
  MAX_ATTRITION,
  // alpha.128 — the run headline, "not worse on N of M judged cases".
  notWorseOn,
} from './golden-eval.js';
export type {
  GoldenEvalOptions,
  GoldenEvalRunResult,
  GoldenEvalCase,
  GoldenEvalAxis,
  GoldenEvalStrategyId,
  StrategyOutcome,
  StrategyAttribution,
  StrategyAttributionResult,
} from './golden-eval.js';

// ── Brain-forward proxy factory (alpha.54) ──
// Consumer-hosted forward handler for the library's four brain write paths.
// Kills the 4-consumer silent-drop class (hand-rolled proxies broke four
// different ways — see brain-proxy.ts). Also available at the dedicated
// subpath `@warmdrift/kgauto-compiler/brain-proxy`.
export { createBrainForwardRoutes } from './brain-proxy.js';
export type { BrainForwardConfig, BrainForwardRoutes } from './brain-proxy.js';

// ── Key-health route factory (alpha.58, KG-fleet-v1 phase 1) ──
// Consumer-hosted provider-key health endpoint the operator dashboard polls.
// Cheapest authenticated GET per provider — never a completion, zero token
// cost; keys never appear in responses. Also available at the dedicated
// subpath `@warmdrift/kgauto-compiler/key-health`.
export {
  createKeyHealthRoute,
  // alpha.81 — non-reversible key identity for fleet shared-key detection.
  // Never returns or accepts a key value beyond the call itself. (PB s83.)
  keyFingerprint,
  KEY_FINGERPRINT_DOMAIN,
  KEY_FINGERPRINT_LENGTH,
} from './key-health.js';
export type {
  KeyHealthConfig,
  KeyHealthRoute,
  KeyHealthResult,
  KeyHealthResponseBody,
  KeyHealthProvider,
} from './key-health.js';

// alpha.60 — the library's own version, Edge-safe constant (no fs/require).
// Reported on the key-health wire as `library_version` so the operator
// dashboard sees per-consumer vendor drift live.
export { LIBRARY_VERSION } from './version.js';

// alpha.131 (R2a) — the pricing basis of a `cost_usd_actual` row, by its `library_version`
// (>= TIERED_FROM: tiered + cache-aware; earlier or unversioned: list price at the base tier).
// The twin of the ops scripts' `v2/scripts/lib/cost-basis.mjs`, drift-guarded by a test.
export { TIERED_FROM, compareLibraryVersion, isTieredBasis, splitByPricingBasis, costByBasis } from './cost-basis.js';
export type { PricingBasisSplit, CostByBasis } from './cost-basis.js';

// ── Oracle ──
export { buildLLMJudge } from './oracle.js';
export type { AppOracle, OracleContext, LLMJudgeOptions } from './oracle.js';

// ── Profiles ──
export { getProfile, tryGetProfile, allProfiles, profilesByProvider, ALIASES, resolveModelAlias } from './profiles.js';
// alpha.87 — consumer profile registration + best-effort synthesis (gateway review §6).
export { registerProfiles, bestEffortProfile, inferProviderFromId, _testClearConsumerProfiles } from './profiles.js';
// alpha.47 — latency-tier introspection (the third swap axis: speed). Lets a
// consumer or Glass-Box surface read why a model was down-ranked when it set
// `constraints.maxLatencyMs`.
export { latencyTierOf, LATENCY_TIER_MS } from './profiles.js';
// alpha.128 — the price that applies to a request of N input tokens (the
// provider's prompt-length tiers), for a consumer that prices its own calls.
export { priceAtInput } from './profiles.js';
export type {
  ModelProfile,
  LatencyTier,
  CliffRule,
  RecoveryRule,
  LoweringSpec,
  StructuredOutputCapability,
  SystemPromptMode,
  CacheStrategy,
  // alpha.43 — per-family-per-archetype prompt-shape conventions. Read by
  // `passApplyConventions` at compile time to apply forcing-function
  // prefixes/suffixes and surface structured-output / cliff warnings.
  ArchetypeConvention,
  // alpha.95 — measured negatives. Exported because kgauto-check renders them
  // and consumer dashboards want to show "what we actually measured".
  ProbedLimit,
  // alpha.128 — the prices the provider states beyond input/output.
  CacheWritePrice,
  BatchPrice,
  PriceTier,
  PriceAtInput,
} from './profiles.js';

// ── Convention pass helpers (alpha.43) ──
// `applyArchetypeConvention` is the pure helper used by the
// exclusion-probe-watcher to apply the same (family, archetype) forcing-
// function to probe prompts that compile() applies to consumer calls.
// Without this, every reasoner probe on a decisive archetype gets unfairly
// stay-excluded for hedging.
export { applyArchetypeConvention, resolveConventionsForProfile } from './passes.js';

// ── Dialect ──
export {
  DIALECT_VERSION,
  INTENT_ARCHETYPES,
  ALL_ARCHETYPES,
  isArchetype,
  bucketContext,
  bucketToolCount,
  bucketHistory,
  hashShape,
  learningKey,
} from './dialect.js';
export type {
  IntentArchetypeName,
  ShapeSignature,
  ContextBucket,
  ToolCountBucket,
  HistoryDepth,
  OutputMode,
} from './dialect.js';

// ── Tokenizer ──
export { setTokenizer, resetTokenizer, countTokens } from './tokenizer.js';

// ── IR types (for callers building IR) ──
export type {
  PromptIR,
  PromptSection,
  SectionKind,
  SectionRewrite,
  ToolDefinition,
  Message,
  IntentDeclaration,
  Constraints,
  InputModality,
  RequiredInputModality,
  InputModalityDrop,
  EffortLevel,
  CompilePolicy,
  CompileResult,
  CompiledRequest,
  MutationApplied,
  RecordInput,
  OracleScore,
  Provider,
  // call() types (alpha.3)
  CallOptions,
  CallResult,
  CallAttempt,
  // full-IR inline shadow-probe (s51 Phase 1)
  ShadowProbeConfig,
  NormalizedResponse,
  NormalizedTokens,
  // alpha.132 — Anthropic's input_transformations entry on NormalizedResponse
  InputTransformation,
  ToolCall,
  ApiKeys,
  ProviderOverrides,
  // history cache (alpha.5)
  HistoryCachePolicy,
  // AI-SDK structured system messages (alpha.33)
  SystemModelMessage,
  // best-practice advisories (alpha.6)
  BestPracticeAdvisory,
  // fallback normalization (alpha.9)
  FallbackReason,
  // consumer-outcome feedback (alpha.20 Entry 4)
  RecordOutcomeInput,
  OutcomeKind,
  OutcomeResult,
  // chain grounding labels (alpha.21 — s78 Entry 1)
  Grounding,
  ChainEntry,
  ChainWithGrounding,
  // per-axis metrics (alpha.23 — s78 Phase 3)
  PerAxisMetrics,
  PerAxisMetricsByModel,
} from './ir.js';
export { CallError, InputModalityError } from './ir.js';
// alpha.79 — Release D: the R2 `delegate` primitive (the accelerator
// proper). Consumer-mountable tool: model decides what to delegate, kgauto
// decides who runs it (never outside the declared pool), consumer consents
// (default OFF). Enforces policy.maxCostPerTraceUsd — the field that
// shipped inert in Release A.
export {
  createDelegate,
  isDelegateEnabledFromEnv,
  DELEGATE_TOOL_DEFINITION,
} from './delegate.js';
export type {
  CreateDelegateOpts,
  DelegateHandle,
  DelegateToolArgs,
  DelegateResult,
  DelegateRefusalReason,
} from './delegate.js';
// alpha.115 — the second-family reader: a filing is read by a family other
// than its writer's (policy.blockedProviders + a post-call assertion), and
// the reading names who answered. CLI: scripts/read-filing.mjs.
export {
  readFiling,
  buildReaderIR,
  parseReading,
  renderReadingMarkdown,
  ReaderFamilyViolation,
  ReaderInputTooLarge,
  ReaderCostCapExceeded,
  ReaderOutputInvalid,
  READER_APP_ID,
  READER_CHAIN,
  READER_MAX_INPUT_TOKENS,
  READER_DEFAULT_MAX_COST_USD,
} from './reader.js';
export type { FilingReading, ReadFilingOptions, ReaderCorrection } from './reader.js';
// alpha.78 — shape-proof mutation accessors (PB 2026-07-25 addendum #2):
// `mutationsApplied` element types differ by surface (objects on
// CompileResult/CallResult, id strings on compileForAISDKv6); these are
// correct on both, replacing consumer-side `typeof` checks.
export { mutationId, hasMutation } from './ir.js';

// ── Archetype-family fit registry (alpha.43) ──
// Static table of "this archetype tends to be a better fit for this family"
// recommendations. Powers the compile-time `cross-family-fit-candidate`
// advisor. Exported so consumers can introspect the recommendations and
// build their own UI/policy on top.
export {
  ARCHETYPE_FAMILY_FITS,
  findBetterFit,
} from './archetype-fits.js';
export type { ArchetypeFamilyFit } from './archetype-fits.js';

// ── Advisor (alpha.6) ──
export { runAdvisor } from './advisor.js';
export type { RunAdvisorPhase2Context } from './advisor.js';
// alpha.42 — ownership taxonomy for advisory rules.
// Class A (consumer-actionable) vs Class B (producer-owned) discriminator.
// Stamped on every advisory by compile(); `deriveOwnership(code)` is the
// pure function consumers can use to classify a code outside compile context.
export {
  PRODUCER_OWNED_RULE_CODES,
  deriveOwnership,
} from './advisor.js';
// blocked-model drift codes. Exported so a consumer who deliberately blocks
// one exact id and is fine with its family siblings can filter by constant
// rather than by string literal. Both are `consumer-actionable`: the
// block-list is the consumer's, and only they know which of the two
// readings applies.
export {
  BLOCKED_MODEL_NOT_IN_ROSTER_CODE,
  BLOCKED_MODEL_FAMILY_SIBLING_SERVED_CODE,
} from './advisor-rules/index.js';

// ── Translator (alpha.29) ──
// Pure-function compile-time section-rewrite engine. Same threshold as the
// cliff advisor (TRANSLATOR_FLOOR === ARCHETYPE_FLOOR_DEFAULT) — alpha.28
// said "consumer must accept adapter"; alpha.29 says "kgauto applies the
// adapter when the consumer declared the section kind."
export {
  applySectionRewrites,
  TRANSLATOR_FLOOR,
  RULE_SEQUENTIAL_TOOL_CLIFF,
  RULE_DISCIPLINE_GATES_V1,
  RULE_DISCIPLINE_GATES_V1_STRUCTURED,
} from './translator.js';
export type {
  ApplySectionRewritesArgs,
  ApplySectionRewritesResult,
} from './translator.js';

// ── Advisories API (alpha.29 — structured advisories with lifecycle) ──
// Closes the L-117-family bottleneck where compile-time advisories
// disappeared after the consumer read the result. Migration 020 ships the
// substrate (`actionable_advisories_v` view + resolution_* columns); this
// API layer is the consumer-facing query + mark-resolved surface.
export {
  getActionableAdvisories,
  markAdvisoryResolved,
  // alpha.39 — per-finding silencer for the alpha.38
  // stale-exclusion-candidate advisor. Direct PostgREST PATCH via the
  // consumer's brain credentials; mirrors markAdvisoryResolved shape.
  markExclusionFindingHandled,
  // alpha.83 (migration 054, tt-intel s118) — burst-vs-rate on an advisory's
  // OWN evidence window. Exported because a consumer rendering advisories
  // themselves needs the same classification the library applies, and
  // re-deriving it would be two implementations of one concept (the exact
  // drift this repo has been bitten by three times).
  classifyEvidenceWindow,
  formatEvidenceSpan,
  burstCaveat,
  BURST_SPAN_MS,
  // The boundary transformer itself (L-118 parity with glassbox-routes'
  // `rowToDetail`/`rowToSummary`). A consumer mounting the advisory pane on
  // their own read of `actionable_advisories_v` must get the SAME mapping the
  // library applies — including the burst downgrade — rather than
  // reimplementing it and drifting.
  rowToAdvisory,
} from './advisories-api.js';
export type {
  ActionableAdvisory,
  AdvisoryEvidenceWindow,
  AdvisorySeverity,
  AdvisoryStatus,
  AdvisoryResolutionSource,
  AdvisorySuggestedFix,
  GetActionableAdvisoriesOptions,
  MarkAdvisoryResolvedOptions,
  // alpha.39
  ExclusionResolutionSource,
  MarkExclusionFindingHandledOptions,
} from './advisories-api.js';

// ── Compatibility (alpha.28) ──
// Pure-function compatibility query. Consumers (tt-intel picker, IC, PB)
// use this at picker-render time to grey out incompatible models. The
// compile-time advisor rule `archetype-perf-floor-breach` consumes the
// same function for substrate-time surfacing.
export {
  getModelCompatibility,
  ARCHETYPE_FLOOR_DEFAULT,
  ABSOLUTE_FLOOR,
} from './compatibility.js';
export type {
  Adapter,
  CompatibilityIntent,
  ModelCompatibility,
} from './compatibility.js';

// alpha.22 — sync introspection used by `model-stale-evidence` and any
// consumer that wants to know if brain-query is wired for a given table.
export { isBrainQueryActiveFor } from './brain-query.js';

// alpha.23 — per-axis metrics RPC (s78 Phase 3 substrate). Caller-driven
// query; NO composite score — aggregation is downstream consumer policy.
export { getPerAxisMetrics } from './brain-query.js';
export type { GetPerAxisMetricsOpts } from './brain-query.js';

// ── Fallback chains (alpha.9) ──
export {
  getDefaultFallbackChain,
  getStarterChain,
  getAllStarterChains,
  // alpha.20 E3
  getSequentialStarterChain,
  // alpha.21 — chain grounding labels (s78 Entry 1)
  getDefaultFallbackChainWithGrounding,
  getStarterChainWithGrounding,
  getAllStarterChainsWithGrounding,
  getSequentialStarterChainWithGrounding,
  // alpha.80 — cost-ordered chains + the shared cost derivation. See
  // tt-intel's `chain-builder-and-cost-advisories-give-opposite-answers`.
  estimateModelCostUsd,
  /** @deprecated alpha.81 — use `estimateModelCostUsd` (it takes one model). */
  estimateChainCostUsd,
  chainProviderSpread,
  COST_RANKING_REFERENCE_SHAPE,
} from './fallback.js';
export type {
  FallbackPosture,
  GetDefaultFallbackChainOpts,
} from './fallback.js';

// ── Compile options ──
export type { CompileOptions } from './compile.js';

// ── Reachability (alpha.10) ──
export {
  PROVIDER_ENV_KEYS,
  resolveProviderKey,
  isProviderReachable,
  isProviderServable,
  isModelReachable,
  getReachabilityDiagnostic,
  // alpha.42 — brain-read env contract. Centralizes the canonical names
  // (KGAUTO_V2_BRAIN_SUPABASE_URL / KGAUTO_V2_BRAIN_JWT /
  // KGAUTO_V2_BRAIN_ANON_KEY) + accepted fallbacks so consumers don't
  // reinvent env-var naming per surface. Closes the s89 ref-template gap
  // where IC + tt-intel each invented their own names.
  readBrainReadEnv,
  // alpha.78 — the canonical names as data, so consumers can't drift by typo.
  BRAIN_READ_ENV_NAMES,
} from './env.js';
export type {
  ReachabilityOpts,
  ProviderReachability,
  SupportedProvider,
  // alpha.42
  BrainReadEnv,
} from './env.js';

// ── Brain-query mode (alpha.11) ──
// Importing the four adapter modules here ensures they're loaded when the
// package initializes. models-brain.ts registers a profile-resolution hook
// at module load — without this re-export, brain-first lookups would never
// activate even when configureBrain() enables them.
export type { BrainQueryConfig } from './brain.js';
export { loadChainsFromBrain } from './chains-brain.js';
export {
  loadArchetypePerfFromBrain,
  getArchetypePerfScore,
  // alpha.21 — chain grounding labels (s78 Entry 1)
  loadArchetypePerfNFromBrain,
  MEASURED_GROUNDING_MIN_N,
  // alpha.110 — honest grounding: measured means the score was written by a measurement
  loadArchetypePerfSourceFromBrain,
  isMeasuredEvidenceSource,
  // alpha.112 — per-app measured scores (R1/R3)
  loadArchetypePerfMeasuredFromBrain,
  type ArchetypePerfMeasuredMap,
  type ArchetypePerfSourceMap,
  type ArchetypePerfMap,
  type ArchetypePerfNMap,
  type ArchetypePerfScoreResult,
} from './archetype-perf-brain.js';
export {
  loadPricingFromBrain,
  resolvePricingAt,
  type PricingRow,
} from './pricing-brain.js';
export {
  loadModelsFromBrain,
  loadAliasesFromBrain,
  profileToRow,
  type ModelBrainRow,
  type ProfileToRowOptions,
} from './models-brain.js';

// ── Exclusion-findings (alpha.38) ──
// Per-tenant SWR cache populated by the alpha.37
// `kgauto-exclusion-re-evaluation-watch` cron. Powers the compile-time
// `stale-exclusion-candidate` advisor and can also be queried directly by
// consumer dashboards / operator tooling.
export {
  getStaleExclusionFindings,
  isExclusionFindingsBrainActive,
  DEFAULT_FINDINGS_ENDPOINT,
} from './exclusion-findings-brain.js';
export type { ExclusionFindingRow } from './exclusion-findings-brain.js';

// alpha.41 — family resolution (Builder A)
// "I want the latest Opus" — consumer-side resolution of a model family
// alias to the current+active model id. Closes the s47 trigger where
// consumer code carried hardcoded `claude-opus-4-6` literals after `4-7`
// shipped and went current. Two surfaces:
//   - `getRecommendedPrimary({ family, ..., fallback })` — public sync
//     resolver, accepts a required fallback floor for cold-start brain.
//   - IR-level `{ family: string }` chain entries — compile() resolves
//     them via the internal `resolveFamilyEntry` (throws on no-match).
// Helper `deriveFamilyFromModelId` exported for consumers building their
// own analytics on top of the family taxonomy.
export {
  getRecommendedPrimary,
  deriveFamilyFromModelId,
  compareVersionAdded,
  resolveFamilyEntryDetailed,
  FamilyResolutionError,
} from './family-resolution.js';
export type {
  GetRecommendedPrimaryOptions,
  FamilyResolution,
} from './family-resolution.js';
export type { ChainModelEntry } from './ir.js';

// alpha.41 — promote-ready (Builder B)
// Per-tenant SWR cache + per-finding silencer API for the autonomous
// promotion-probe-watcher. The compile-time `promote-ready` advisor rule
// (wired by Builder A's advisor-rules/index.ts) reads via loadPromoteReady
// Findings; consumers silence handled findings via markPromoteReadyHandled.
export {
  markPromoteReadyHandled,
} from './promote-ready-brain.js';
export type {
  MarkPromoteReadyHandledOptions,
  PromoteReadyResolution,
  PromoteReadyFindingRow,
} from './promote-ready-brain.js';

// alpha.64 — Stage 2 surface promotions (auto-promote downswaps behind the
// 7-day rollback guard). The routing effect is consent-gated
// (BrainConfig.autoPromote / KGAUTO_AUTO_PROMOTE, default OFF); these
// exports let consumers introspect the active promotion on a surface and
// tests/operators drive the cache directly.
export {
  getApplicablePromotion,
  // alpha.78 — rollback visibility (PB Finding 3): the guard's reverts are
  // now readable, so advisors (and consumers) can stop re-recommending what
  // the guard already adjudicated. Windowed by ROLLBACK_SUPPRESSION_WINDOW_DAYS.
  getRecentRollback,
  ROLLBACK_SUPPRESSION_WINDOW_DAYS,
  isPromotionsBrainActive,
  isAutoPromoteEnabledFromEnv,
  configurePromotionsBrain,
  // alpha.86 — cold-start warm-up (the alpha.73 prefetch applied to the
  // promotions sibling it missed). Exported for Edge/Worker consumers who
  // want to prefetch at module init, mirroring prefetchMeasuredFailure.
  prefetchPromotions,
  awaitPromotionsReady,
  DEFAULT_PROMOTIONS_ENDPOINT,
  _testResetPromotions,
  _testWaitForPromotionsRefresh,
} from './promotions-brain.js';
export type {
  PromotionRow,
  PromotionsRuntime,
  GetApplicablePromotionOpts,
} from './promotions-brain.js';

// alpha.70 — measured-failure quality gate (the CREATE direction of
// measured-supersedes-judgment). `wilsonLowerBound` + `judgeMeasuredFailure`
// are exported as pure functions so an operator script or a consumer can
// reproduce a gate decision exactly, from counts alone, without the library.
export {
  getMeasuredFailureVerdict,
  prefetchMeasuredFailure,
  awaitMeasuredFailureReady,
  judgeMeasuredFailure,
  // alpha.78 — the snake_case→camelCase bridge, exported so a consumer
  // reproducing a gate decision from the counts endpoint can't silently
  // judge undefined fields (PB 2026-07-25 trap).
  mapMeasuredFailureRows,
  wilsonLowerBound,
  isMeasuredFailureBrainActive,
  isMeasuredFailureGateEnabledFromEnv,
  configureMeasuredFailureBrain,
  MEASURED_FAILURE_CFG,
  DEFAULT_MEASURED_FAILURE_ENDPOINT,
  _testResetMeasuredFailure,
  _testWaitForMeasuredFailureRefresh,
} from './measured-failure-brain.js';
export type {
  MeasuredFailureVerdict,
  MeasuredFailureRuntime,
  SurfaceFailureRow,
  GetMeasuredFailureOpts,
} from './measured-failure-brain.js';

// ── Release C (Rung 1) — decomposition coach planning engine ──
// Pure templates + arithmetic; the operator script feeds it measured
// surface stats. Release D's `delegate` primitive consumes the SAME
// templates — which is why they live here, versioned.
export {
  DECOMPOSITION_TEMPLATES,
  DECOMPOSITION_TEMPLATES_VERSION,
  planDecomposition,
  COACH_CFG,
} from './decomposition.js';
export type {
  DecompositionTemplate,
  DecompositionStep,
  DecompositionPlan,
  PlannedStep,
  SurfaceStats,
  ExecutorCandidate,
} from './decomposition.js';

// alpha.103 — the evidence gate, exported so consumers can audit what a cliff may do
export { isCapabilityReducing, hasConfirmedEvidence, qualityPenaltyEvidenced } from './passes.js';
