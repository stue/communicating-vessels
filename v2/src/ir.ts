/**
 * Intermediate Representation — the structured form of a prompt.
 *
 * Everything kgauto v2 does, it does on the IR. The IR is constructed by the
 * caller (or by `parse()` from a string-style prompt for backwards-compat),
 * transformed by the compiler passes, and lowered to a target-specific wire
 * request only at the very end.
 *
 * The IR carries STRUCTURE, not just text. Sections are first-class. Tools
 * carry per-intent relevance. History knows its turn-age. Constraints are
 * explicit. This is what lets passes do real work.
 */

import type { IntentArchetypeName, OutputMode } from './dialect.js';

// ─────────────────────────────────────────────────────────────────────────
// PROMPT IR
// ─────────────────────────────────────────────────────────────────────────

/**
 * A semantically-named section of the system prompt. Sections enable
 * intent-aware slicing (drop sections not tagged for this intent), dedupe
 * (collapse identical sections across files), and cache marking (identify
 * the stable prefix).
 */
export interface PromptSection {
  /** Stable identifier — used for slicing, dedupe, and cache markers. */
  id: string;
  /** Section text. */
  text: string;
  /**
   * Which intents this section applies to. Empty = applies to all intents.
   * Pass `compile()` will drop sections whose intents array doesn't include
   * the current intent.
   */
  intents?: IntentArchetypeName[];
  /**
   * If true, this section is part of the stable cacheable prefix. The lower
   * pass uses this to place cache markers correctly per target.
   */
  cacheable?: boolean;
  /**
   * Section weight when ordering — lower = earlier in the assembled prompt.
   * Defaults to insertion order.
   */
  weight?: number;
  /**
   * alpha.29+ — declares the section's semantic kind so kgauto can apply
   * model-aware rewrites at compile time. Default `'arbitrary'` (when
   * unset) for full back-compat — pre-alpha.29 sections continue working
   * unchanged.
   *
   * alpha.29 ships rewrites for `tool_call_contract` only. Other kinds are
   * type-accepted but pass through. alpha.30+ will add rewrites for
   * `narration_contract`, `role_intro`, etc.
   *
   * See `translator.ts` for the rewrite engine that consumes this field.
   */
  kind?: SectionKind;
}

/**
 * alpha.29+ — semantic kind tag for a `PromptSection`. The translator
 * (`v2/src/translator.ts`) consumes this to apply model-aware rewrites at
 * compile time. CLOSED union; future kinds extend it explicitly in named
 * alpha releases.
 *
 * alpha.29 ships rewrites for `tool_call_contract` only. Other kinds are
 * type-accepted but pass through.
 *
 * - `role_intro`         — "You are a helpful assistant", persona blocks
 * - `tool_call_contract` — tool-use rules ("call X then Y"); the alpha.29
 *                          translator rewrites this for models with a
 *                          sequential-tool cliff on the active archetype
 * - `narration_contract` — output-format rules ("don't narrate your steps");
 *                          alpha.30+ candidate
 * - `discipline_contract`— alpha.68 / Release A (delegation-fanout-accelerator
 *                          §5.D): surface-scaffolding gate block. When declared
 *                          on a role/system section, the translator prepends the
 *                          frozen `discipline-gates-v1` preamble subject to a
 *                          two-factor eligibility screen — Factor A (archetype:
 *                          hunt/summarize/plan/critique/judge) AND Factor C
 *                          (output-shape: text only, never json/tool_call).
 *                          Clears no cliff, emits no wireOverrides ⇒ no advisor
 *                          suppression. See `translator.ts`.
 * - `user_turn`          — when sections carry user content rather than
 *                          system context (rare)
 * - `reference`          — supporting reference data the model may consult
 * - `arbitrary`          — explicit pass-through (default when unset)
 */
export type SectionKind =
  | 'role_intro'
  | 'tool_call_contract'
  | 'narration_contract'
  | 'discipline_contract'
  | 'user_turn'
  | 'reference'
  | 'arbitrary';

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  /**
   * Per-intent relevance scores. Compile uses these to drop irrelevant tools.
   * Missing intents default to 0.5 (neutral).
   */
  relevanceByIntent?: Partial<Record<IntentArchetypeName, number>>;
  /** Pass-through for provider-specific fields (Anthropic input_schema, etc.). */
  [key: string]: unknown;
}

/**
 * A conversation turn.
 *
 * alpha.120 — a tool exchange in `history` is NEUTRAL: write it once and each
 * provider's lowering emits its own blocks.
 *   - an `assistant` message may carry `toolCalls` — the exact shape
 *     `response.toolCalls` returns, so a consumer writes the response straight
 *     back into history. `content` is the assistant's text beside the calls
 *     ('' when there was none).
 *   - a `role: 'tool'` message answers one call: `toolCallId` (REQUIRED —
 *     compile() throws without it), `toolName` (Google's `functionResponse`
 *     needs the name; when omitted it is taken from the matching call in
 *     history), and `content: string` (a consumer holding an object
 *     JSON-stringifies it — the lowering does not guess).
 * Lowered as: Anthropic `tool_use` / `tool_result` blocks; OpenAI-family
 * `tool_calls` / `role:'tool'` + `tool_call_id`; Google `functionCall` /
 * `functionResponse` parts. History compression never splits a call from
 * its result.
 *
 * `parts` stays the escape hatch: when present on a message it wins, exactly
 * as before, and the neutral fields on that message are not read.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional structured parts (provider-native blocks) — passed through to lowering verbatim; wins over the neutral tool fields. */
  parts?: unknown[];
  /** alpha.120 — on an `assistant` message: the tool calls it made (the `response.toolCalls` shape). */
  toolCalls?: ToolCall[];
  /** For tool messages — which tool this corresponds to (Google needs it; falls back to the matching call's name). */
  toolName?: string;
  /** For tool messages — the call id this result answers. Required on a `role: 'tool'` message without `parts`. */
  toolCallId?: string;
}

/**
 * The compile-time intent declaration. `name` is the app's local label;
 * `archetype` is the canonical dialect-v1 archetype the app maps it to.
 *
 * Apps with their own intent vocabulary (tt-intelligence's "ask"/"hunt"/
 * "dashboard") declare the mapping here. The brain learns by archetype, not
 * by app-local name.
 */
export interface IntentDeclaration {
  /** App-local intent name (free-form, for app's own debugging). */
  name: string;
  /** Canonical dialect-v1 archetype. Required for cross-app learning. */
  archetype: IntentArchetypeName;
}

/**
 * alpha.57 — dialect-level reasoning-effort tier (data-first).
 *
 * Vocabulary is a portfolio-level tier ladder (low → max), NOT any provider's
 * wire value — mapping to `reasoning_effort` (OpenAI) / thinking budgets
 * (Anthropic) / `thinkingConfig` (Gemini) stays consumer-side until
 * routing-on-effort ships. Declaring it records the tier on the brain row
 * (`compile_outcomes.effort`, migration 033) so effort×archetype quality
 * evidence accumulates BEFORE any routing logic exists — same data-first
 * sequencing as `tool_orchestration` (alpha.20).
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * alpha.124 — an input modality a provider's model page can declare
 * (`ModelProfile.inputModalities`).
 */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf';

/** alpha.124 — a modality a call can REQUIRE (text is implied). */
export type RequiredInputModality = Exclude<InputModality, 'text'>;

/**
 * alpha.124 — why a model was dropped from a call that requires an input
 * modality: its profile declares nothing (`not declared` — kgauto did not read
 * it on the provider's page, so it will not guess), or it declares a set that
 * lacks a required modality (`declares text only`, `declares text, image only`).
 */
export interface InputModalityDrop {
  model: string;
  why: string;
}

export interface Constraints {
  /** Hard latency ceiling — compiler will down-rank slow models. Advisory. */
  maxLatencyMs?: number;
  /**
   * alpha.132 (R3d) — an append-only compile. `true` withholds the four passes
   * that can change `system`, `tools` or earlier turns between two calls of one
   * conversation — slice, dedupe, tool-relevance and history compression — and
   * says so as one mutation (`stable-prefix-passes-withheld`). For a
   * conversation that sends thinking blocks back: Anthropic checks each block
   * against the `system`, `tools` and messages that preceded it
   * (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking,
   * "Keeping the prefix unchanged"). Opt-in; absent or `false` changes nothing.
   * Cliff guards and translator rewrites still run (they are per target, not
   * per call).
   */
  stablePrefix?: boolean;
  /** Hard cost ceiling per call (USD). Advisory. */
  maxCostUsd?: number;
  /**
   * alpha.57 (data-first): the reasoning-effort tier the consumer ran (or
   * intends to run) this call at. RECORDED, NOT APPLIED — the compiler does
   * not emit provider thinking/effort params from this field and does not
   * route on it yet; it flows to `compile_outcomes.effort` via record()'s
   * registry auto-enrich (same pattern as `mutationsApplied`/advisories).
   * Declare it truthfully: this is consumer-reported ground truth, like
   * `tokensIn`/`latencyMs`. Does NOT enter the shape key (no learning-key
   * fragmentation).
   */
  effort?: EffortLevel;
  /** Caller wants structured (JSON) output. */
  structuredOutput?: boolean;
  /**
   * alpha.69 — consumer-declared output shape. Overrides the inference in
   * `resolveOutputMode` (structuredOutput ⇒ json · tools ⇒ tool_call · else
   * text), which is deliberately conservative: it cannot see that an agentic
   * surface carrying tools ultimately emits prose to the user.
   *
   * Declaring `'text'` on a tool-carrying surface is what re-opens the
   * alpha.68 discipline gates for it (Factor C is a hard screen on inferred
   * `tool_call`, because wrongly firing breaks a parser while wrongly
   * withholding only forgoes a lift). Declare it truthfully — it is
   * consumer-reported ground truth about what the model emits, and it feeds
   * `shape_key`, so a false declaration fragments the learning key AND lets
   * shape-altering rules fire on a structured surface.
   */
  outputMode?: OutputMode;
  /** Hint: caller expects a short response (used to disable thinking on Gemini). */
  expectedShortOutput?: boolean;
  /**
   * alpha.101 — the output-token cap the consumer will put on the wire
   * (`max_tokens` / `maxOutputTokens`). Two effects, both "declares ⇒ emits":
   *
   *  1. Lowering emits it on every provider (capped at the profile's own
   *     `maxOutputTokens`), so kgauto's `call()` path honours the same
   *     ceiling an AI-SDK consumer applies themselves.
   *  2. A `thinking_with_short_output` cliff whose `threshold > 1` fires when
   *     this cap is BELOW the threshold — the smallest cap the model was
   *     measured to hold under. Measured 2026-09-03, direct to
   *     api.deepseek.com: deepseek-v4-flash at `max_tokens: 300` returned
   *     `finish_reason=length` with 300 reasoning tokens and an EMPTY text
   *     channel 3/3 (and 9/9 `length@300` on tt-intelligence's live classify
   *     surface, 2026-09-01 — 8 empty, one cut mid-object); thinking off → `stop` at 53 tokens. A reasoning-default
   *     model under a tight cap burns the whole budget before it writes a
   *     byte, and the row lands as `success=true`.
   *
   * Omit it and nothing changes: the cliff keeps its `expectedShortOutput`
   * trigger and lowering keeps the provider default.
   */
  maxOutputTokens?: number;
  /** Hint: max response words. */
  maxResponseWords?: number;
  /** Override target model selection — if set, compiler uses this instead of routing. */
  forceModel?: string;
  /**
   * alpha.20: consumer-declared tool-orchestration shape for this call.
   * - 'parallel': model may fire multiple tool calls per step (current
   *   default behavior; the L-040 cliff applies — DeepSeek's
   *   `tool_count >= 1` cliff trims tools because parallel-tool throughput
   *   collapses to sequential semantics).
   * - 'sequential': consumer commits to one tool call per step (the agentic
   *   loop pattern). DeepSeek V4-Flash + V4-Pro can compete cleanly in
   *   this mode — the L-040 cliff is silenced and the hunt chain shifts
   *   to a DeepSeek-tier-1 ordering.
   * - 'either': consumer doesn't care; library picks the parallel chain
   *   (status-quo default) and may upgrade to brain-driven per-mode perf
   *   selection in a future release.
   *
   * Affects:
   *   - Chain composition for `archetype: 'hunt'` (see
   *     `getDefaultFallbackChain` and `STARTER_CHAINS_BY_MODE`).
   *   - L-040 cliff in `passApplyCliffs` (silent when 'sequential').
   *
   * Default (when undefined): equivalent to 'parallel' for back-compat
   * with every pre-alpha.20 caller.
   */
  toolOrchestration?: 'parallel' | 'sequential' | 'either';
  /**
   * alpha.124 — input modalities this call REQUIRES the model to accept
   * (text is implied). When present and non-empty, every chain source
   * (`getDefaultFallbackChain`, `getStarterChain`, both `…WithGrounding`
   * variants, compile()'s target scoring, and `call()`'s cross-provider tail)
   * keeps only models whose `ModelProfile.inputModalities` declares every
   * required modality. A model whose profile does NOT declare the field is
   * excluded too — "not declared" is not "accepts", and a call that walks to a
   * text-only model fails after billing (the alpha.66 shape). Every drop is
   * SAID: one `chain-filtered-by-input-modality` mutation naming each model
   * and why, `diagnostics.inputModality` with the surviving provider count, and
   * an advisory when fewer than two providers survive.
   *
   * A consumer PIN — `forceModel`, or an `ir.models` list with exactly one
   * model — is the consumer's own knowledge and is never filtered: compile()
   * returns it untouched, with the advisory, even when its profile declares no
   * such modality. With no pin and no surviving model, compile() throws
   * `InputModalityError` and call() fails BEFORE the wire with a `CallError`
   * whose code is `no_model_declares_input_modality`.
   *
   * Absent (or empty) → no requirement: the chain is byte-identical to a
   * compile that never heard of the field (never-worse-than-raw, P1).
   * Does NOT enter the shape key.
   */
  inputModalities?: ReadonlyArray<RequiredInputModality>;
}

/**
 * Cache marker policy for the messages array (history + currentTurn).
 *
 * Anthropic positional caching: a `cache_control` marker on a content block
 * tells the API "remember the prefix up through this block." On a subsequent
 * request whose first N tokens match, those N billed at the cached rate
 * (10% of the input price). Without a marker, every call re-pays for the
 * entire history.
 *
 * - `'none'` (default when omitted): no history cache marker. System-level
 *   cache markers from `PromptSection.cacheable=true` still apply.
 * - `'all-but-latest'`: marks the message immediately preceding `currentTurn`
 *   (the last history entry). On the next call, that entire history prefix
 *   is cacheable. Good fit for chat/agent loops where every prior turn is
 *   stable.
 * - `'fixed-suffix'`: marks the message `suffix` positions from the end of
 *   `history`. Use when the last few turns are volatile (e.g., scratchpad,
 *   draft revisions) but the earlier prefix is stable.
 *
 * For non-Anthropic providers, no wire-format marker is emitted (Gemini /
 * OpenAI / DeepSeek implicit caching takes effect automatically when a
 * stable prefix is reused). The compiler still computes
 * `diagnostics.historyCacheableTokens` for telemetry on every provider.
 *
 * alpha.5.
 */
export type HistoryCachePolicy =
  | { strategy: 'none' }
  | { strategy: 'all-but-latest' }
  | { strategy: 'fixed-suffix'; suffix: number };

/**
 * Consumer-declared policy for model selection. Lives outside the IR
 * (passed via CompileOptions) because it's a SESSION/APP-level constraint,
 * not a per-call shape.
 *
 * The original tt-intelligence scenario (s11): user capped Anthropic
 * spending on Sonnet for cost reasons. v2 compile() kept picking Sonnet
 * as the best target, Hunter's preflight hit the cap and fell back to
 * Flash — every single call. CompilePolicy.blockedModels lets the
 * consumer tell kgauto "don't pick Sonnet right now" and the compiler
 * routes to the next-best option directly. No wasted preflight tax.
 *
 * This is the "coach knows the constraints" feature — kgauto stops
 * recommending things the consumer has already ruled out.
 */
export interface CompilePolicy {
  /**
   * Model IDs the consumer has gated. Compile() will never select these.
   * Use for: cost caps, account-level rate limits, "this model is broken
   * for our workload" decisions.
   *
   * Matching is by EXACT id after alias resolution (alpha.85): an alias
   * and its canonical id are the same model, so blocking either blocks
   * both (`deepseek-chat` ≡ `deepseek-v4-flash`). Matching does NOT widen
   * to family siblings — blocking `deepseek-v4-flash` says nothing about
   * `deepseek-v4-pro` — and a bare family key (`'deepseek'`,
   * `'claude-sonnet'`) is INERT: it matches no model and no warning fires
   * today. To gate a family, list its concrete ids. Beware roster
   * retargets: when a family primary moves to a new id, a literal-id
   * block does not follow it (tt-intel s113 built consumer-side family
   * resolution for exactly this).
   */
  blockedModels?: string[];
  /**
   * alpha.115 — PROVIDER families the consumer has gated. Compile() never
   * selects a model whose provider is listed, the default-chain composer
   * drops them, and call() filters them from the fallback walk (the same
   * three places `blockedModels` is enforced, with the same shape: a
   * `blocked_provider_by_policy` reject reason on the model's
   * `diagnostics.targetScores` entry, one `blocked-provider-<p>` mutation
   * per blocked provider, and the dropped ids on
   * `CallResult.policyBlockedFiltered`).
   *
   * Use it when the rule is about the FAMILY, not a model list that would
   * drift as the family ships new ids: `readFiling()` sets
   * `blockedProviders: [writerFamily]` so a filing written by Anthropic is
   * never read by Anthropic, whatever Anthropic model is current.
   */
  blockedProviders?: Provider[];
  /**
   * Hard ceiling on estimated input cost per call (USD). Models whose
   * estimated cost exceeds this are rejected. Use for: budget enforcement
   * on high-volume routes.
   */
  maxCostPerCallUsd?: number;
  /**
   * alpha.68 / Release A (delegation-fanout-accelerator §5.1) — trace-level
   * cost ceiling (USD) across a fan-out `trace_id`'s cumulative spend.
   *
   * RECORDED / INERT in Release A: nothing fans out yet, so this field is
   * accepted and carried but the compiler enforces NOTHING from it. It is
   * enforced by the `delegate` primitive against the running trace spend in
   * Release D. Kept distinct from `maxCostPerCallUsd` because that per-call
   * ceiling is trivially evadable N times under fan-out — a fan-out budget
   * has to be trace-scoped, not per-call.
   */
  maxCostPerTraceUsd?: number;
  /**
   * Model IDs the consumer prefers. When multiple models fit, preferred
   * models get a rank boost (large enough to overcome small quality
   * differences but not large enough to override hard rejects).
   */
  preferredModels?: string[];
  /**
   * Customer-posture tag (master plan §1.2, alpha.9).
   *
   *   - `'locked'`    — compliance/contract/brand-promise. Caller passes
   *                     exactly one model; no fallback is desired. kgauto
   *                     never walks the chain.
   *   - `'preferred'` — user-selected primary, fallback chain as safety
   *                     net. On 429/5xx, walk the chain and surface
   *                     `fellOverFrom` so the consumer can show "Claude
   *                     was busy; we used Pro for this answer."
   *   - `'open'`      — library picks the chain. Model identity is
   *                     irrelevant; output is the contract.
   *
   * The field is **informational** — kgauto's execution path is already
   * determined by the shape of `ir.models`. Posture surfaces in
   * telemetry so the cost-watcher can distinguish "locked failed, no
   * fallback was tried" from "open chain exhausted." Default: when
   * `ir.models.length === 1` posture is treated as `'locked'` by the
   * advisor; otherwise unspecified.
   */
  posture?: 'locked' | 'preferred' | 'open';
  /**
   * alpha.87 — what compile() does with a model id no profile covers
   * (gateway review §6; both cold readers hit this wall).
   *
   *   - `'refuse'` (default) — throw, naming `registerProfiles()` and this
   *     option. The fleet's safety posture, unchanged: guards can only be
   *     honest about models kgauto knows.
   *   - `'best-effort'` — synthesize a conservative profile (provider
   *     inferred from the id prefix; wire mechanics borrowed from a bundled
   *     profile of that provider; NO cliffs, NO measured knowledge, cost
   *     UNKNOWN and recorded as 0) and compile anyway, with a loud
   *     `cliffWarnings` entry + `best_effort_profile` mutation naming
   *     every guard that is skipped. If the provider cannot be inferred,
   *     refusal still applies — best-effort cannot lower a wire format it
   *     cannot name.
   *
   * The option converts "wait for the maintainer's weekend" into a
   * consumer's informed choice; it does not make the unknown model safe.
   */
  onUnprofiledModel?: 'refuse' | 'best-effort';
}

/**
 * alpha.41 — entry in `PromptIR.models[]`. Either a literal model id (the
 * pre-alpha.41 shape, fully preserved) or a `{ family: string }` alias that
 * resolves at compile() time to the latest-current model in that family.
 *
 * Family entries resolve via `resolveFamilyEntry` (internal twin of the
 * public `getRecommendedPrimary`). Resolution fails CLOSED — a family that
 * matches no current+active candidate throws `FamilyResolutionError` at
 * compile time. Consumers who want a literal fallback should call
 * `getRecommendedPrimary({ family, fallback, ... })` at IR-construction time
 * and inline the resolved id, rather than passing `{ family }` into the IR.
 *
 * Family taxonomy is defined in `family-resolution.ts`; see also migration
 * 024 (`kgauto_models.family` column + index).
 */
export type ChainModelEntry =
  | string
  | { family: string };

/**
 * The IR — the input to compile().
 */
export interface PromptIR {
  /** App identifier — required for multi-tenant brain. */
  appId: string;
  /** Intent declaration — what is this call doing? */
  intent: IntentDeclaration;
  /** Structured system prompt sections. */
  sections: PromptSection[];
  /** Available tools (compiler may drop based on intent relevance + budget). */
  tools?: ToolDefinition[];
  /** Conversation history (compiler may compress old turns). */
  history?: Message[];
  /** The user's current turn — never dropped. */
  currentTurn?: Message;
  /**
   * Allowed model IDs (or family aliases — alpha.41+), in caller-preference
   * order. Compiler resolves family entries to literal ids before scoring
   * and picks among them. See {@link ChainModelEntry}.
   *
   * Internal passes downstream of compile()'s family-resolution step
   * receive a narrowed `string[]` shape — `string` is a subtype of
   * `ChainModelEntry`, so a `string[]` IS a `ChainModelEntry[]` at the
   * type level. Code that needs to access string ids (passes.ts) reads
   * via `getModelIds(ir)` from `models-runtime.ts` rather than narrowing
   * inline.
   */
  models: ChainModelEntry[];
  /** Compile constraints. */
  constraints?: Constraints;
  /**
   * Cache marker placement policy for the messages array. Default = no
   * history cache markers. See `HistoryCachePolicy` for semantics.
   * alpha.5.
   */
  historyCachePolicy?: HistoryCachePolicy;
}

// ─────────────────────────────────────────────────────────────────────────
// COMPILE OUTPUT
// ─────────────────────────────────────────────────────────────────────────

export type Provider =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'deepseek'
  | 'zai'
  | 'moonshot'
  | 'mistral'
  | 'xai'
  // alpha.92 — present in the union for the execute/env layers' typing only.
  // No profile ever declares it: OpenRouter is a ROUTE to canonical models,
  // not a vendor of models (see CallRoute below).
  | 'openrouter';

/**
 * alpha.92 — the route a call travels, part of a measurement's identity
 * (execute-leg design contract, 2026-08-26). `'direct'` = the vendor's own
 * API (every measurement before this release; the default, and the only
 * route consumer production traffic uses unless a consumer explicitly opts
 * in later). `'openrouter'` = the OpenRouter gateway — the STARTER tier for
 * eval and candidate admission. The route matters because the model behind
 * a name is a different serving stack per gateway host: the same
 * `deepseek-v4-flash` id was served by "Venice" and by "StreamLake"
 * emitting PARALLEL tool calls — behavior opposite to the vendor-API
 * evidence our cliff rests on. Vendor-keyed evidence does not transfer
 * through a gateway, so verdicts never silently transfer across routes.
 */
export type CallRoute = 'direct' | 'openrouter';

/**
 * Mutation IDs that fired during compile. Empty in v1 (no mutation engine
 * yet). Populated when the brain is online and pushing mutations.
 */
export type MutationApplied = {
  id: string;
  source: string; // 'static_profile' | 'cliff_guard' | 'mutation_<id>' | etc.
  passName: string;
  description: string;
  /**
   * alpha.73 — the ranking delta this mutation applied, when it applied one.
   * Negative de-ranks, positive boosts. Absent for mutations that do not touch
   * rank (advisory/labelling mutations).
   *
   * Exists because a consumer could previously see *that* a gate fired and
   * *why*, but not *how much* — which cannot distinguish "the gate did not see
   * this model" from "the gate saw it and the penalty lost to a price
   * advantage." PB spent two days and three wrong conclusions inside that gap
   * (2026-07-25/26), and both wrong conclusions were inferences substituted
   * for a quantity that was known at emit time and thrown away. Same class as
   * the `rankedOn` request: a consumer cannot reason about ranking behaviour
   * it cannot observe, so it will guess.
   */
  rankDelta?: number;
  /**
   * alpha.73 — the model's rank before and after this mutation, when it
   * changed one. Together with `rankDelta` this answers the question a
   * penalty magnitude alone cannot: whether the gated model still WON.
   */
  rankBefore?: number;
  rankAfter?: number;
};

/**
 * alpha.78 — shape-proof accessor for a mutation entry (PB filing
 * 2026-07-25 addendum #2). TWO public surfaces share the name
 * `mutationsApplied` with DIFFERENT element types: `CompileResult` /
 * `CallResult` carry `MutationApplied[]` (objects), while
 * `compileForAISDKv6` carries `string[]` (ids) — each internally
 * consistent, but a consumer coding to one surface's d.ts while reading the
 * other's runtime gets a silent false negative (`typeof m === 'string'`
 * compiles clean, runs clean, and is wrong on every row). Neither element
 * type can change without breaking a live consumer, so the fix is an
 * accessor that is correct on both.
 */
export function mutationId(
  m: string | MutationApplied | null | undefined,
): string | undefined {
  // alpha.82 (PB s85): this used to throw on `null` and on an object with no
  // `id`. PB's argument for why that is worse than ordinary sloppiness is the
  // right one and worth keeping here: **the consumer this export exists for is
  // their deep-smoke CRON — a detector.** A detector that throws on a
  // malformed payload reports nothing, and reporting nothing is
  // indistinguishable from a clean run. Hardening a shared accessor against
  // one bad element is therefore not defensive politeness; it is the
  // difference between a detector that fails loudly and one that goes quiet.
  // Returns `undefined` (not null) for an unusable entry — the id is absent,
  // which is what `undefined` means in this codebase.
  if (m == null) return undefined;
  if (typeof m === 'string') return m;
  return typeof m.id === 'string' ? m.id : undefined;
}

/**
 * alpha.78 — does any mutation in the list match `idOrPrefix` (exact id, or
 * prefix when it ends with `*`)? Works on both `mutationsApplied` element
 * shapes. `hasMutation(result.mutationsApplied, 'quality-gate-measured-*')`
 * is the gate-detection idiom PB hand-rolled in their deep-smoke.
 */
export function hasMutation(
  list: ReadonlyArray<string | MutationApplied> | undefined,
  idOrPrefix: string,
): boolean {
  if (!Array.isArray(list)) return false;
  const prefix = idOrPrefix.endsWith('*') ? idOrPrefix.slice(0, -1) : undefined;
  return list.some((m) => {
    // alpha.82: guard the ELEMENTS, not just the list. `Array.isArray` alone
    // meant one malformed entry anywhere in `mutationsApplied` took down the
    // caller — see the note on `mutationId` for why that matters here.
    const id = mutationId(m as string | MutationApplied | null | undefined);
    if (id === undefined) return false;
    return prefix !== undefined ? id.startsWith(prefix) : id === idOrPrefix;
  });
}

/**
 * Target-specific wire request. Shape varies by provider — caller passes the
 * right field to the right SDK.
 */
export type CompiledRequest =
  | {
      provider: 'anthropic';
      model: string;
      system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      max_tokens?: number;
      /**
       * alpha.29 — emitted only when the translator's wire-overrides set
       * `parallelToolCalls = false`. Shape per Anthropic Messages API docs:
       * `{ type: 'auto', disable_parallel_tool_use: true }`. kgauto defaults
       * to omitting `tool_choice` entirely (Anthropic defaults to auto + parallel),
       * so this field's presence signals an explicit override.
       */
      tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; disable_parallel_tool_use?: boolean; name?: string };
      /**
       * alpha.132 (R3a) — emitted only when the lowered messages carry a
       * `thinking` / `redacted_thinking` block and the target runs the prefix
       * check (`BLOCK_BINDING_MODELS`, request-shapes.ts):
       * `{ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }`.
       * `execute()` sends the `thinking-binding-controls-2026-08-01` beta header
       * whenever the final body carries `thinking.block_binding`.
       */
      thinking?:
        | {
            type: 'adaptive';
            block_binding?: { prefix_mismatch_behavior: 'drop_block' | 'error' };
          }
        /**
         * alpha.134 (R2) — the model's own off-switch (`lowering.thinkingOff`),
         * emitted only when a `thinking_with_short_output` cliff fired:
         * `disabled` (Haiku 5.5, Opus 5, Sonnet 5) or `between_tools` (Sonnet 5.5).
         */
        | { type: 'disabled' | 'between_tools' };
    }
  | {
      provider: 'google';
      model: string;
      systemInstruction?: { role: 'system'; parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: unknown[] }>;
      tools?: unknown[];
      generationConfig?: Record<string, unknown>;
      cachedContent?: string; // populated when cache hit; created lazily by caller
    }
  | {
      provider: 'openai';
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      response_format?: unknown;
      /** alpha.101 — from `constraints.maxOutputTokens`; OpenAI's current field name. */
      max_completion_tokens?: number;
      reasoning_effort?: string;
      /**
       * alpha.29 — emitted only when the translator's wire-overrides set
       * `parallelToolCalls = false`. OpenAI defaults parallel_tool_calls=true
       * server-side; we explicit-set to false only when overriding.
       */
      parallel_tool_calls?: boolean;
    }
  | {
      provider: 'deepseek';
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      /** alpha.101 — from `constraints.maxOutputTokens`. */
      max_tokens?: number;
      /**
       * alpha.101 — DeepSeek V4 thinks by default (effort `high`). Emitted as
       * `disabled` ONLY when a `thinking_with_short_output` cliff fired: under
       * a cap the reasoning burn cannot fit, thinking produces nothing at all.
       */
      thinking?: { type: 'enabled' | 'disabled' };
      /**
       * alpha.99 — DeepSeek's only structured-output mode. The type could not
       * express this field, so `lowerDeepSeek` could not have emitted it even
       * if someone had noticed it was missing: the omission was enforced by
       * the type, and the typecheck stayed green because nothing tried.
       * Same family as the alpha.68 output-mode screen typed too narrowly to
       * receive the value that triggers it — a type that cannot represent the
       * case is indistinguishable from a case that never arises.
       *
       * `{ type: 'json_object' }` only; `json_schema` is rejected outright
       * (measured 2026-08-29: "This response_format type is unavailable now").
       */
      response_format?: unknown;
    }
  | {
      provider: 'zai';
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      response_format?: unknown;
      /** alpha.101 — from `constraints.maxOutputTokens`. */
      max_tokens?: number;
      /**
       * alpha.65 — Z.ai thinking knob (docs.z.ai chat-completion reference):
       * `thinking.type` is 'enabled' (default) or 'disabled'. Emitted only
       * when a cliff forces thinking off (`force_thinking_budget_zero`);
       * omitted otherwise so the provider default applies.
       */
      thinking?: { type: 'enabled' | 'disabled' };
    }
  | {
      provider: 'moonshot';
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      response_format?: unknown;
      /** alpha.101 — from `constraints.maxOutputTokens`. */
      max_tokens?: number;
    }
  | {
      /**
       * alpha.92 — the OpenRouter gateway route. OpenAI-compatible wire;
       * `model` is the OpenRouter id (`vendor/model`, e.g.
       * `deepseek/deepseek-v4-flash`), mapped from the CANONICAL profile id
       * by `openRouterModelId()` — the canonical id stays the measurement
       * identity everywhere else.
       */
      provider: 'openrouter';
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      response_format?: unknown;
      /** alpha.101 — from `constraints.maxOutputTokens`. */
      max_tokens?: number;
    };

/**
 * Best-practice advisory emitted by the compiler at compile time. Non-fatal —
 * consumers log, surface in dev tools, gate on `level === 'critical'` in CI,
 * or ignore. The advisor inspects the IR + selected profile + diagnostics
 * and emits one entry per detected gap.
 *
 * Codes are stable across releases. `suggestion` and `docsUrl` are optional
 * but encouraged: suggestion = the actionable diff; docsUrl = the
 * interfaces/kgauto.md anchor for context.
 *
 * alpha.6 Phase 1 starter rules:
 *   - `caching-off-on-claude` (warn)       system >2000 chars on Anthropic, no cacheable=true
 *   - `single-chunk-system` (info)         Anthropic, only one PromptSection >1000 chars
 *   - `tool-bloat` (warn)                  >10 tools on a short-output archetype
 *   - `history-uncached-on-claude` (warn)  Anthropic, ≥2 history messages, no historyCachePolicy
 *
 * Phase 2 (catalog as `bestPractices` block in profiles) and Phase 3 (brain
 * telemetry on `advisories_fired`) are alpha.7+ territory.
 */
export interface BestPracticeAdvisory {
  /**
   * Severity. `info` = informational; `warn` = behavioral pattern that's
   * usually expensive or wrong; `critical` = likely bug or production-grade
   * misuse. Phase 1 ships info + warn only.
   */
  level: 'info' | 'warn' | 'critical';
  /** Stable kebab-case code. Consumers filter / gate by this. */
  code: string;
  /** Human-readable explanation of what was detected. */
  message: string;
  /** Optional: how to fix — actionable diff or pattern. */
  suggestion?: string;
  /** Optional: link to docs anchor for more context. */
  docsUrl?: string;
  /**
   * alpha.20 — actionable category for routing/dashboard surfacing. When set,
   * the brain persists this as `recommendation_type` on
   * `compile_outcome_advisories` so consumers can filter "show me all
   * client-side issues that are caching-fix recommendations." Optional;
   * absent on legacy or uncategorized rules.
   *
   * - `'model-swap'`          — swap to a different model fixes this
   * - `'prompt-fix'`          — restructure prompt (sections, tools, format)
   * - `'caching-fix'`         — add cache markers (system or history)
   * - `'no-ai-needed'`        — the call shouldn't be using an AI model
   * - `'tier-down'`           — current model is overkill for this archetype
   * - `'architecture-change'` — the issue isn't fixable at the kgauto layer
   */
  recommendationType?:
    | 'model-swap'
    | 'prompt-fix'
    | 'caching-fix'
    | 'no-ai-needed'
    | 'tier-down'
    | 'architecture-change';
  /**
   * alpha.133 — the model id(s) this advisory recommends moving to, when it
   * names one (`cost-mismatched-archetype`, `tier-down`,
   * `consumer-on-stale-model`, `cross-family-fit-candidate`). `call()` reads it
   * to leave off an advisory that recommends a model which failed on the same
   * call. Absent on advisories that recommend no specific model.
   */
  recommendedModels?: string[];
  /**
   * alpha.36 — architectural recommendation when the call shouldn't be an
   * AI call at all, or should be a cheaper non-AI substitute. Optional and
   * orthogonal to {@link recommendationType}: when set, narrows the
   * `no-ai-needed` / `architecture-change` rec-type into an actionable
   * pattern the consumer can implement.
   *
   * - `'lookup-table'`       — deterministic input → output mapping (≥95% agreement at high N). Build a domain table; fall back to AI for novel inputs.
   * - `'memoization-cache'`  — same canonical input recurs across sessions with equivalent output. Add an edge/KV cache keyed on canonical input.
   * - `'tier-down'`          — a cheaper model tier scores at or above the target on this shape; the message names what each score was measured against (alpha.128). Move primary to the cheaper tier.
   * - `'deterministic-parser'` — `constraints.structuredOutput: true` calls where the schema is regex/JSON-extractable from the input.
   * - `'precompute'`         — input is derivable at build / cron / batch time; eliminate the per-request call entirely.
   *
   * Operator-side detection lives in `v2/scripts/no-ai-needed-detector.mjs`
   * (alpha.36); a compile-time advisor rule that consumes the brain-side
   * findings cache follows in a later alpha. Today populated only by the
   * operator-side detector + the brain RPC `get_no_ai_needed_candidates`
   * (migration 021).
   */
  recommendedArchitecture?:
    | 'lookup-table'
    | 'memoization-cache'
    | 'tier-down'
    | 'deterministic-parser'
    | 'precompute';
  /**
   * alpha.28 — when a rule wants to surface a specific structural adaptation
   * (not just a swap or a prompt fix), it attaches the adapter shape here.
   * Shape is the canonical {@link Adapter} discriminated union defined in
   * this module; `compatibility.ts` re-exports it so
   * `getModelCompatibility()` and `BestPracticeAdvisory.suggestedAdaptation`
   * share one source of truth.
   *
   * Today fired by `archetype-perf-floor-breach` (alpha.28) when a
   * documented adapter exists for the chosen model's archetype cliff.
   * Absent on rules without a structural adapter (caching-off-on-claude,
   * tool-bloat, etc.) and on the `reject` branch of
   * `archetype-perf-floor-breach` where no adapter would help.
   *
   * CLOSED discriminated union (R3 from consultation doc) — future adapter
   * parameters extend the union in `compatibility.ts` in named alpha
   * releases. No `| string` escape hatch; consumer code can write
   * exhaustive `switch (suggestedAdaptation.parameter)`.
   *
   * Phase 2 cross-builder coherence: Builder A's
   * `AdvisoryRecord.suggestedAdaptation` (in `glassbox-routes/types.ts`)
   * MUST type to the same union. Phase 2 integration verifies.
   */
  suggestedAdaptation?: Adapter;
  /**
   * alpha.42 — the kgauto request handle that produced this advisory. Stamped
   * by `compile()` after `runAdvisor()` returns, sourced from
   * `CompileResult.handle`. Lets a consumer's admin UI pivot from advisory
   * row → original trace (Glass-Box card, brain `compile_outcomes` lookup).
   *
   * Absent when the advisory was constructed outside the full `compile()`
   * pipeline (e.g., a direct `runAdvisor()` call in tests). Always present
   * on advisories returned from `compile().advisories`.
   */
  kgautoRequestId?: string;
  /**
   * alpha.42 — who is positioned to act on this advisory.
   *
   *   - `'consumer-actionable'` (Class A): the consumer can fix this by
   *     changing their wire-up — add `cacheable: true` markers, swap their
   *     model literal, declare a section, etc. The admin UI should surface
   *     a one-click apply or a "fix it" CTA.
   *   - `'producer-owned'` (Class B): kgauto needs to ship a code or data
   *     change — update a profile, promote a model in the chain, fix a
   *     wire contract. The admin UI should surface this as informational
   *     ("kgauto is on it") and not present a consumer-side action.
   *
   * Stamped by `compile()` after `runAdvisor()` returns. Rules can self-
   * declare via the matching field on their return; otherwise the stamp
   * consults the static `PRODUCER_OWNED_RULE_CODES` set in `advisor.ts`,
   * defaulting to `'consumer-actionable'` when the code isn't listed.
   *
   * Closes the s47 dogfood gap where the tt-intel admin UI conflated the
   * two classes — consumers couldn't tell whether they should act or wait.
   */
  ownership?: 'consumer-actionable' | 'producer-owned';
}

/**
 * alpha.28 — adapter shape attached to advisories and returned by
 * `getModelCompatibility()`. A CLOSED discriminated union: future adapter
 * parameters extend it explicitly in named alpha releases. NO `| string`
 * escape hatch — consumer policy code SHOULD write exhaustive
 * `switch (adapter.parameter)` and rely on the compiler to flag
 * "I added a new adapter parameter and forgot to update consumer policy."
 *
 * Defined here (in `ir.ts`, the foundational types module) and re-exported
 * from `compatibility.ts` for ergonomic consumer imports. Anchoring it
 * here avoids the import cycle that would form if both files tried to be
 * the source of truth (ir.ts → compatibility.ts → profiles.ts → ir.ts).
 *
 * alpha.28 variants:
 *   - `{ parameter: 'toolOrchestration'; value: 'sequential'; consequence }`
 *     Lifts DeepSeek V4-family on `hunt` from the sequential-tool cliff
 *     (L-040). `consequence` is consumer-renderable plain English.
 *
 * Future alpha releases will add e.g. `parallelToolCalls`, `maxTools`,
 * `thinkingBudget` (per tt-intel-Cairn priority list).
 */
export type Adapter =
  | { parameter: 'toolOrchestration'; value: 'sequential'; consequence: string };

/**
 * alpha.29+ — record of a single section rewrite fired by the translator at
 * compile time. Surfaces on `CompileResult.sectionRewritesApplied` and (in
 * scrubbed wire form, without original/transformed text) on
 * `TraceDetail.sectionRewritesApplied` for Glass-Box Coaching-card rendering.
 *
 * `originalText` / `transformedText` stay package-internal — they may carry
 * consumer PII. The wire-shape variant (`TraceSectionRewrite` in
 * `glassbox-routes/types.ts`) carries only `summary` for renderer use.
 */
export interface SectionRewrite {
  /** Stable id of the `PromptSection` that was rewritten. */
  sectionId: string;
  /** The `kind` discriminator that matched the rewrite rule. */
  kind: SectionKind;
  /**
   * Stable identifier of the rule that fired (e.g.
   * `'sequential-tool-cliff-below-floor'`). Future rules add named ids; the
   * brain aggregates by this value for cross-app learning.
   */
  rule: string;
  /** The section's text BEFORE the rewrite fired. */
  originalText: string;
  /** The text the translator emitted into the IR for this section. */
  transformedText: string;
  /**
   * Wire-level overrides emitted alongside the text rewrite. Merged into
   * `CompileResult.wireOverrides` by `applySectionRewrites`. alpha.29 ships
   * `parallelToolCalls`; the union extends as more wire-overrides surface.
   */
  wireOverrides?: { parallelToolCalls?: boolean };
}

/**
 * alpha.105 — the per-call savings receipt.
 *
 * Origin: cheaperinference.com returns `x-ci-saved-usd` + `x-ci-techniques`
 * on every response; the 2026-07-24 cold readers asked kgauto for exactly
 * that felt-utility money line, and kgauto computed every ingredient
 * (`mutationsApplied`, section/tool/history drops, `estimatedCacheSavingsUsd`)
 * without ever adding them up for the consumer.
 *
 * Every number carries its basis so it is never an invented figure:
 *   - `inputTokensAsGiven` is what the IR would have cost sent exactly as the
 *     consumer built it (every section, tool and history turn), on kgauto's
 *     own tokenizer estimate — the same estimate the passes use.
 *   - `inputTokensSent` is the compiled request's estimate.
 *   - `estimatedUsdSavedFirstCall` = removed tokens × the served model's
 *     input price (`basis.costInputPer1m`, verified against the provider's
 *     docs on `basis.pricingVerifiedAgainstDocs`, or unverified when null).
 *   - `estimatedCacheSavingsUsdWarm` is the existing warm-cache estimate
 *     (what a cache-hit re-send of the marked prefix would save), unchanged.
 *
 * It is an ESTIMATE against the consumer's own IR, not a claim against some
 * other product, and it is silent about output tokens (kgauto never lowers a
 * consumer's output ceiling — `never-worse-than-raw`). A receipt with
 * `passes: []` and zero removed tokens is the honest answer for a call kgauto
 * did nothing to.
 */
export interface SavingsReceipt {
  /** Distinct mutation ids that fired on this compile, in order. */
  passes: string[];
  /** Estimated input tokens of the IR sent as given (no passes). */
  inputTokensAsGiven: number;
  /** Estimated input tokens of the compiled request. */
  inputTokensSent: number;
  /** `inputTokensAsGiven - inputTokensSent`, floored at 0. */
  inputTokensRemoved: number;
  /** Removed tokens priced at `basis.costInputPer1m`. */
  estimatedUsdSavedFirstCall: number;
  /** Mirrors `diagnostics.estimatedCacheSavingsUsd` — a warm re-send estimate, not a first-call saving. */
  estimatedCacheSavingsUsdWarm: number;
  /** What was dropped, by kind — the denominators behind `inputTokensRemoved`. */
  dropped: { sections: number; tools: number; historyTurns: number };
  basis: {
    /** The model whose input price priced the receipt (the compile target). */
    model: string;
    /** alpha.128 — the input price of the tier `inputTokensSent` falls in (the provider's prompt-length steps, `ModelProfile.costTiers`), else the base price. */
    costInputPer1m: number;
    /** ISO date the price was last verified against the provider's docs; null = unverified. */
    pricingVerifiedAgainstDocs: string | null;
    /** How the token counts were produced. */
    tokenizer: 'kgauto-estimate';
  };
}

export interface CompileResult {
  /** Unique handle for this call — pass to record() to correlate the outcome. */
  handle: string;
  /** Selected target model id. */
  target: string;
  /** Selected provider. */
  provider: Provider;
  /** The wire request — pass the appropriate fields to your SDK. */
  request: CompiledRequest;
  /** Estimated tokens (input). */
  tokensIn: number;
  /** Estimated cost in USD (input portion). */
  estimatedCostUsd: number;
  /** Mutations that fired during compile (informational). */
  mutationsApplied: MutationApplied[];
  /** Fallback chain — try these in order if target fails. */
  fallbackChain: string[];
  /**
   * Best-practice advisories emitted by the compiler. Non-fatal. Empty
   * array when no rules fired. alpha.6 Phase 1.
   */
  advisories: BestPracticeAdvisory[];
  /**
   * alpha.29+ — per-section rewrites applied by the translator at compile
   * time. Empty array means no rewrites fired (or pre-alpha.29 behavior —
   * all sections default `kind: 'arbitrary'`, which is pass-through).
   *
   * Surfaces to:
   *   - Glass-Box Coaching card (via `TraceDetail.sectionRewritesApplied`,
   *     scrubbed of original/transformed text)
   *   - brain `compile_outcomes.section_rewrites_applied` (migration 019)
   *     for cross-app learning
   */
  sectionRewritesApplied: SectionRewrite[];
  /**
   * alpha.29+ — wire-level overrides emitted by translator rewrites. The
   * provider lowering pass threads these through to the wire request before
   * emit. Today only `parallelToolCalls: boolean`; the type extends as more
   * wire-overrides surface.
   *
   * Undefined when no rewrite emitted overrides — the common case.
   */
  wireOverrides?: { parallelToolCalls?: boolean };
  /** Diagnostics for caller-side logging. */
  diagnostics: {
    /**
     * alpha.105 — the per-call receipt: what kgauto did to this call and
     * what it was worth, with the basis of every number named. See
     * `SavingsReceipt`.
     */
    savings: SavingsReceipt;
    sectionsKept: number;
    sectionsDropped: number;
    toolsKept: number;
    toolsDropped: number;
    historyKept: number;
    historyDropped: number;
    cacheableTokens: number;
    estimatedCacheSavingsUsd: number;
    /**
     * Tokens in `history` (and `currentTurn` when before the marker) that
     * fall within the cacheable prefix per `historyCachePolicy`. Always
     * computed; only Anthropic actually emits a wire-format marker. For
     * Gemini / OpenAI / DeepSeek, this represents the theoretical cacheable
     * prefix that implicit caching may pick up — useful telemetry for the
     * brain to learn which (app, model, archetype) tuples benefit most
     * from history caching. alpha.5.
     */
    historyCacheableTokens: number;
    /**
     * Total tokens in input `history` (pre-compression). Computed regardless
     * of whether `passCompressHistory` fired — surfaces how close a tuple is
     * to its `compressHistoryAboveTokens` threshold so dashboards / cost-
     * watchers can see the bloat axis the count-based threshold misses.
     * 0 when history is empty. alpha.7.
     */
    historyTokensTotal: number;
    /**
     * alpha.132 (R4) — the conversation window the compiled request carries.
     * The conversation is `history` plus `currentTurn`, counted once when the
     * last history message duplicates `currentTurn`; `of` is its length, `kept`
     * the messages the request carries (`of` minus those the history fold
     * removed into its summary — the oldest, so the window is the trailing
     * one). `kept === of` when nothing folded.
     */
    conversationWindow: { kept: number; of: number };
    /**
     * alpha.20 E3. Consumer-declared tool-orchestration mode for this call,
     * mirrored from `ir.constraints.toolOrchestration` for downstream
     * observability (Glass-Box panel, brain telemetry, advisor logs).
     * Undefined when the consumer hadn't adopted the constraint yet —
     * treat as 'parallel' equivalent for back-compat.
     */
    toolOrchestration?: 'parallel' | 'sequential' | 'either';
    /**
     * alpha.33. Zero-based index into the resolved (post-compression) history
     * array at which Anthropic prompt-cache marker should land — i.e., the
     * last message that belongs to the stable cacheable prefix. Consumers
     * using AI-SDK's `streamText({ messages: convertToModelMessages(...) })`
     * lose the per-message `providerOptions.anthropic.cacheControl` markers
     * the compiler emits on `result.request.messages`, because
     * `convertToModelMessages` reads raw input not the lowered output.
     * This index gives the consumer a single deterministic position to
     * attach `cacheControl: { type: 'ephemeral' }` after their own conversion.
     *
     * Computation:
     *   - `historyCachePolicy.strategy === 'all-but-latest'`: history.length - 1
     *     (or undefined if history is empty)
     *   - `historyCachePolicy.strategy === 'fixed-suffix'` with `suffix: N`:
     *     history.length - 1 - N (undefined if N exceeds history length)
     *   - `historyCachePolicy.strategy === 'none'` or omitted: undefined
     *
     * The companion helper `attachCacheControlToStreamTextInput()` reads
     * this field + the consumer's converted messages to perform the per-
     * attempt mutation correctly. Filed by IC + tt-intel cross-consumer
     * pattern 2026-05-20 (`streamText-cache-marker-propagation-gap`).
     */
    historyCacheMarkIndex?: number;
    /**
     * alpha.33. Zero-based index into the structured `systemMessages` array
     * (see top-level `systemMessages` field) at which the cacheable system
     * prefix ends. Useful when the consumer is building a multi-block
     * system parameter for Anthropic streamText — they can attach
     * `providerOptions.anthropic.cacheControl` to `systemMessages[index]`.
     *
     * Undefined when no section had `cacheable: true` OR `systemMessages` is
     * empty. Matches `historyCacheMarkIndex` semantics on the history axis.
     */
    systemCacheMarkIndex?: number;
    /**
     * alpha.43. Cliff-style warnings surfaced by the convention pass
     * (`passApplyConventions`) when the selected profile + archetype carry
     * a `cliffWarning` whose preconditions are met. These are informational
     * — they describe a structural mismatch between the call's shape and
     * the chosen family (e.g. "reasoner family is wrong for parallel-tool
     * hunt") so consumers can route differently next time.
     *
     * Empty array when no convention fired or no warnings surfaced.
     * Separate from `cliff_guard` mutations in `mutationsApplied` — those
     * are profile.cliffs[] runtime triggers; these are convention-level
     * advisory text. Both can fire on the same call.
     */
    cliffWarnings: string[];
    /**
     * alpha.110 — the ranking table this compile chose from, one row per declared
     * candidate: rank, whether it fits, the quality term's grounding (measured brain
     * score vs profile judgment), the archetype-perf number read, and the blended cost
     * at this call's shape. Exists so a consumer (or a sweep) can see WHY a pick was
     * made without re-deriving the scorer — the s119 fact "compile() scores the set and
     * does not honour its order", now legible per call. Sorted by rank, descending.
     */
    targetScores?: Array<{
      modelId: string;
      rank: number;
      fits: boolean;
      grounding?: 'measured' | 'judgment';
      archetypePerf?: number;
      blendedCostUsd?: number;
      measuredFit?: boolean;
      /**
       * alpha.135 — the hard rejects this candidate carried (blocked by policy, over the cost
       * ceiling, no declared input modality, over context …), verbatim from the scorer. Absent
       * when it carried none.
       */
      rejectReasons?: string[];
      /**
       * alpha.135 — the measured-failure gate that docked this candidate's rank on this surface
       * (axis, rate, lower bound, n), when one did.
       */
      measuredGate?: { rate: number; lowerBound: number; n: number; nFail: number; axis: 'quality' | 'availability' };
    }>;
    /**
     * alpha.135 — `CompilePolicy.maxCostPerCallUsd` as this compile read it. Present only when
     * the caller set one; the brain row's `selection.ceilingUsd` carries it.
     */
    ceilingUsd?: number;
    /**
     * alpha.68 / Release A (delegation-fanout-accelerator §5.D) — tokens added
     * by the `discipline_contract` gate block on this call; 0 when the gate
     * didn't fire (no eligible `discipline_contract` section, or Factor A /
     * Factor C screened it out). Measured, never assumed: counted from the
     * exact frozen preamble the translator prepended. Persisted to
     * `compile_outcomes.discipline_gate_tokens` (migration 042) so the tax is a
     * number the cost-watcher can weigh against the lift.
     */
    disciplineGateTokens: number;
    /**
     * alpha.87 — which world answered THIS compile, per data source (the
     * `per-source-freshness-marker-on-callresult` ask, PB s76). kgauto
     * legitimately ranks on bundled profiles when cold and brain-re-ranked
     * profiles when warm, and before this field the response said nothing
     * about which had answered — PB drew three wrong conclusions across
     * s74–s76 from observations taken at unknown temperature. A FLAT marker
     * was rejected in the s76 consult: the app-scoped gates (measured
     * failure, promotions, exclusions, promote-ready) carry cache state
     * independent of the shared config snapshot, and a config-derived
     * marker would read 'brain' in exactly the window where the
     * measured-failure gate is still cold.
     *
     * Semantics: `config` is `'brain'` iff the shared `/v2/config` snapshot
     * held fetched data at compile time (else `'bundled'`). The per-gate
     * fields are `'warm'` iff a successful app-scoped load had completed in
     * this process — `'cold'` covers never-loaded, load-failed, and
     * feature-disabled alike, because in all three the gate read no data.
     * With alpha.73/.86 prefetch + `gateWarmupMs`, a `call()` after warmup
     * should read all-warm; a cold isolate's first compile may not.
     */
    freshness: {
      config: 'bundled' | 'brain';
      measuredFailure: 'cold' | 'warm';
      promotions: 'cold' | 'warm';
      exclusions: 'cold' | 'warm';
      promoteReady: 'cold' | 'warm';
    };
    /**
     * alpha.87 — per-section cost attribution (cc's
     * `per-section-cost-attribution-in-diagnostics` ask, from Sacha's
     * oracle read). `compile()` already receives sections IDed by the
     * consumer, so this itemization is arithmetic on values the compiler
     * computes anyway: zero model calls, no brain write, counts and IDs
     * only — never section text (G3-compatible by construction). Always-on:
     * an itemization nobody remembers to ask for is absent at the moment
     * it is needed, and the payload is one small object per section.
     *
     * One row per INPUT section, in input order — dropped sections appear
     * with `kept: false` and zero cost so a consumer can see what a pass
     * removed and what it was worth.
     *
     * The cacheable interaction is deliberately two explicit columns
     * rather than one blended number or a compile-time `cacheState` guess:
     * whether a given call pays the first-call or the warm price is decided
     * at the provider AFTER compile, so the honest compile-time statement
     * is both prices. `estCostUsdFirstCall` is the section's tokens at the
     * selected model's uncached input price (provider cache-WRITE
     * surcharges, e.g. Anthropic's 1.25×, are not modeled — this
     * understates first-call cost slightly). `estCostUsdWarm` applies the
     * profile's cache-read discount when the section sits in an ACTIVE
     * cacheable prefix (cacheable, and the prefix met the provider's
     * minimum); otherwise it equals `estCostUsdFirstCall` — for a
     * non-cached section the two worlds cost the same.
     */
    sections: Array<{
      id: string;
      tokens: number;
      kept: boolean;
      cacheable: boolean;
      estCostUsdFirstCall: number;
      estCostUsdWarm: number;
    }>;
    /**
     * alpha.124 — present ONLY when the IR carries a non-empty
     * `constraints.inputModalities`. `survivingModels` is the target + the
     * fallback chain that declare every required modality (what the call can
     * walk); `survivingProviders` counts their distinct providers. `dropped`
     * names every candidate excluded and why. `pinnedUndeclared` names the
     * consumer's pin when it was served WITHOUT declaring the modality.
     */
    inputModality?: {
      required: RequiredInputModality[];
      survivingModels: string[];
      survivingProviders: number;
      dropped: InputModalityDrop[];
      pinnedUndeclared?: string;
    };
  };
  /**
   * alpha.33. Structured `system` for AI-SDK `streamText({ system })`
   * consumers. When the consumer's lowered request has cacheable section
   * markers, the flat `system: string` form loses the marker assignment
   * (every `streamText({ system: '<string>' })` call silently strips
   * providerOptions). Pass `systemMessages` instead to `streamText({
   * system: result.systemMessages })` so the cacheable prefix is structurally
   * preserved.
   *
   * Each entry is a `SystemModelMessage`-shaped object:
   *   { role: 'system', content: string, providerOptions?: { anthropic?:
   *     { cacheControl: { type: 'ephemeral' } } } }
   *
   * Provider-agnostic on emit: only Anthropic actually consumes the
   * cacheControl block; Gemini / OpenAI / DeepSeek receive the same
   * shape but ignore the marker (matching their implicit-caching semantics).
   *
   * Empty array when the IR carried zero sections (rare; usually means the
   * compiler dropped everything for the chosen intent). Consumers can fall
   * back to `result.systemMessages.length === 0 ? '' : result.systemMessages`
   * or use the helper `attachCacheControlToStreamTextInput()` which handles
   * both shapes.
   */
  systemMessages: SystemModelMessage[];
}

/**
 * alpha.33. AI-SDK-compatible system-message shape carried on
 * `CompileResult.systemMessages`. Matches the AI-SDK `streamText({ system })`
 * structured form — consumers can pass these directly without conversion.
 *
 * The `providerOptions` field is set ONLY for entries that came from a
 * section with `cacheable: true` AND the chosen provider is Anthropic AND
 * the compiler computed a non-zero `cacheableTokens`. Other providers see
 * `providerOptions: undefined` (or omitted entirely).
 */
export interface SystemModelMessage {
  role: 'system';
  content: string;
  providerOptions?: {
    anthropic?: { cacheControl: { type: 'ephemeral' } };
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CALL() — orchestrator types (alpha.3)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Token usage normalized across providers. `cached` and `cacheCreated` are
 * Anthropic prompt-cache reads/writes (Gemini implicit caching populates
 * `cached` from `usageMetadata.cachedContentTokenCount`; OpenAI populates
 * from `prompt_tokens_details.cached_tokens`).
 */
export interface NormalizedTokens {
  input: number;
  output: number;
  total: number;
  cached?: number;
  cacheCreated?: number;
}

/**
 * Tool call in a provider-agnostic shape. Anthropic `tool_use` blocks,
 * Google `functionCall` parts, and OpenAI/DeepSeek `tool_calls[]` all
 * collapse to this.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface NormalizedResponse {
  /** Main text body. Empty string if response had no text content. */
  text: string;
  /**
   * Parsed structured output. Populated when ir.constraints.structuredOutput
   * is true and JSON.parse(text) succeeds. Null otherwise.
   */
  structuredOutput: unknown | null;
  /** Tool calls in normalized shape. Empty array if none. */
  toolCalls: ToolCall[];
  tokens: NormalizedTokens;
  /** Provider-specific finish reason, passed through unchanged. */
  finishReason?: string;
  /**
   * alpha.92 — the serving host a gateway reported (OpenRouter's response
   * `provider` field, captured verbatim: "Venice", "StreamLake", …).
   * Undefined on direct vendor calls and on gateways that don't report it.
   * Discarding this would be the L-073 silent-drop at birth — the gateway
   * itself tells us which stack served the call.
   */
  routeHost?: string;
  /**
   * alpha.105 — the model id the provider's response REPORTED serving,
   * verbatim (Anthropic `model`, e.g. `claude-sonnet-5-20260812`; Google
   * `modelVersion`; OpenAI-compatible `model`, e.g. `deepseek/deepseek-v4-flash`
   * on OpenRouter). Undefined when the body omits it. Never normalized here —
   * `servedModelDiffers()` (call.ts) is the read-side comparison. Through
   * alpha.104 nothing read this field, so a gateway substitution was
   * unobservable (the L-073 class the 2026-07-07 gateway stance named as
   * THE integration-point check).
   */
  servedModel?: string;
  /**
   * alpha.129 — time to first token, ms: from the request send to the first
   * CONTENT event (a non-empty text delta, or a tool's first argument bytes),
   * by `Date.now()`. Set only by kgauto's streaming path (Anthropic, the
   * OpenAI-compatible providers, and Google since alpha.130 — a Google
   * function call arrives whole, so it is the content event); a single-shot
   * response has no first-token moment and carries none — never 0, never the
   * end-to-end latency. (was: "Google has no kgauto stream helper, so a Google
   * call carries none", until alpha.130.)
   */
  ttftMs?: number;
  /**
   * alpha.132 (R3b) — Anthropic's `input_transformations`, verbatim per entry
   * (`type`, `path`, `reason`): the thinking blocks the API dropped (or let
   * through) before the model read them. Present only when the response
   * carried the array (the `thinking-binding-controls-2026-08-01` beta header,
   * which kgauto sends with `thinking.block_binding`); on a stream, read from
   * `message_start` → `message.input_transformations` (observed on the wire
   * 2026-11-12). The copy the page says a `message_delta` carries after a
   * mid-stream server-side fallback is not read: its location is unobserved.
   */
  inputTransformations?: InputTransformation[];
  /** Untouched provider response — escape hatch for consumers needing fields not yet normalized. */
  raw: unknown;
  /** Set when structuredOutput parsing was attempted and failed. */
  parseError?: string;
}

/**
 * alpha.132 — one entry of Anthropic's `input_transformations`
 * (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking,
 * read 2026-11-11T23:32Z: "Each entry names one thinking block by its `path`
 * … and gives a `reason`"). Types: `thinking_dropped`,
 * `thinking_mismatch_allowed`; reasons: `prefix_binding_mismatch`,
 * `model_binding_mismatch`, `organization_binding_mismatch` — the page adds:
 * "Ignore entries whose `type` or `reason` you don't recognize", so both are
 * plain strings here.
 */
export interface InputTransformation {
  type: string;
  path?: string;
  reason?: string;
}

export interface ApiKeys {
  anthropic?: string;
  google?: string;
  openai?: string;
  deepseek?: string;
  zai?: string;
  moonshot?: string;
  /** alpha.92 — the OpenRouter gateway route's key (a route key, not a vendor key). */
  openrouter?: string;
}

/**
 * Per-provider override fields shallow-merged into the lowered request before
 * execution. Lets consumers reach Gemini `safetySettings`, Anthropic
 * `tool_choice`, OpenAI `seed` etc. without bypassing kgauto.
 */
export interface ProviderOverrides {
  anthropic?: Record<string, unknown>;
  google?: Record<string, unknown>;
  openai?: Record<string, unknown>;
  deepseek?: Record<string, unknown>;
  zai?: Record<string, unknown>;
  moonshot?: Record<string, unknown>;
  /** alpha.92 — overrides for requests traveling the OpenRouter route. */
  openrouter?: Record<string, unknown>;
}

/**
 * Full-IR inline shadow-probe config (Shape B, Phase 1 — 2026-05-29 s51).
 *
 * When set on `call()`, after the primary response is served kgauto re-lowers
 * the SAME in-memory PromptIR to each candidate and runs it, persisting a
 * `probe_outcomes` row with `replay_source='inline-full-ir'` and
 * `prompt_fidelity=1.0` — a fair, full-prompt measurement (vs the watchers'
 * lossy `prompt_preview` replay). The probe NEVER blocks the user response and
 * NEVER persists the raw prompt (system/context/payload) — only response
 * previews + metadata, same policy the brain already holds.
 *
 * This is the trustworthy path that earns the right to a quality verdict;
 * `prompt_preview` replay is retired for verdicts (see CLAUDE.md).
 *
 * Phase 1 enforces `sampleRate` and runs the candidate with `judge: 'off'`
 * (responses stored for an offline batch judge). `judge: 'opus'` (inline
 * verdict) and `maxPerDay` (per-tuple daily cap, needs a brain-count read)
 * are accepted by the type but ENFORCED IN PHASE 2.
 */
export interface ShadowProbeConfig {
  /** Model id(s) or family alias(es) to shadow-test against the served model, on the same IR. */
  candidates: string | string[];
  /** Probability [0,1] that any given call fires a probe. Default 0.05. */
  sampleRate?: number;
  /**
   * 'off' (Phase 1 default): run candidate + store both responses for an
   * offline batch judge. 'opus': judge candidate-vs-served inline (Phase 2).
   */
  judge?: 'opus' | 'off';
  /** Per-(appId, archetype, candidate) daily cap. Phase 2 (needs brain-count read). Default 20. */
  maxPerDay?: number;
  /**
   * alpha — latency budget (ms) for the probe leg. **Only enforced in sync mode**
   * (`BrainConfig.sync === true`), where `call()` awaits the probe before returning
   * the served response (PB-class Edge consumers, L-086) and the candidate's
   * latency therefore lands on the user-facing critical path.
   *
   * The probe path races against this budget: if the candidate(s) don't finish
   * within `maxLatencyMs`, the probe aborts, `call()` returns the already-served
   * response immediately, and an `outcome='aborted_latency_budget'` row is
   * recorded (no verdict, no false quality data). **The user is never delayed
   * past the budget.** Default `15000`.
   *
   * No-op for fire-and-forget consumers (`sync` unset/false, and every
   * `probeShadow()` caller fired from `after()`/`waitUntil()`) — they don't block
   * the user, so there's no latency to bound. The probe runs to completion there.
   *
   * Root cause this closes (PB s57 dogfood incident, 2026-06-05): PB arms the
   * probe inline with `sync:true` on a `maxDuration:120` analyze route; arming a
   * `latency_tier='slow'` candidate (deepseek-v4-pro, ~78–84s) pushed total
   * handler time past the frontend's patience and the served analysis came back
   * empty. A sync probe had no latency budget — this field is the budget.
   */
  maxLatencyMs?: number;
  /**
   * alpha — when true (the default) **in sync mode**, skip a candidate whose
   * registry `latency_tier === 'slow'` *before starting it*: a slow-tier model
   * (e.g. deepseek-v4-pro / deepseek-v4-flash, both `slow` = ~24s+ p50) cannot
   * fit a sane inline budget, so starting it just to abort it wastes a provider
   * call. An `outcome='skipped_slow_tier_sync'` row is recorded so the offline
   * rollup can see the skip (not a silent drop, not a false verdict). Fail-safe.
   *
   * **The deeper rule (slow-reasoner → offline-mode):** inline shadow-probing is
   * for FAST candidates only. To evaluate a slow reasoner you need the offline /
   * async probe path (the Phase-2 batch direction) which runs off the response
   * entirely — never the inline sync probe. Set this `false` only if you've moved
   * the budget high enough that a slow candidate genuinely fits (rare), or you're
   * in a non-sync consumer where this flag is a no-op anyway.
   *
   * No-op for fire-and-forget consumers (`sync` unset/false; `probeShadow()`):
   * there's no user latency to protect, so slow candidates run normally. Default
   * `true`.
   */
  skipSlowTierInSync?: boolean;
}

export interface CallOptions {
  /**
   * alpha.86 — self-mark for synthetic callers (canaries, smokes, eval
   * replays, probes). Passed through to every outcome row this call
   * records, including failure rows. OMIT for real traffic. See
   * {@link OutcomeSource}.
   */
  source?: OutcomeSource;
  /**
   * alpha.89 — per-end-user metering: passed through to every outcome row
   * this call records, including failure rows (a failed call still spent
   * money attributable to the customer). See {@link RecordInput.endUserId}.
   */
  endUserId?: string;
  /**
   * alpha.92 — route this call through a gateway instead of the vendor's
   * own API. Omit (or `'direct'`) for normal calls — this is the STARTER
   * tier for eval and candidate admission, NOT a consumer routing surface:
   * production traffic stays direct-vendor-only by default per the
   * execute-leg design contract. When `'openrouter'`:
   *   - lowering emits the OpenAI-compatible wire with the OpenRouter id
   *     (canonical id stays the measurement identity),
   *   - the outcome row records `route='openrouter'` + `route_host` (the
   *     serving host OpenRouter reports),
   *   - the learning key gains the route dimension (`…::model@openrouter`),
   *     so gateway evidence never pollutes direct-vendor evidence,
   *   - cliff guards still apply but are route-unverified (see
   *     {@link CallResult.routeUnverifiedCliffs}) — never assume a host
   *     fixed a vendor cliff.
   * Requires `OPENROUTER_API_KEY`.
   */
  route?: CallRoute;
  /**
   * alpha.84 — fires once per FAILED attempt during the fallback walk, before
   * the walk continues. IC-Cairn's filing, 2026-07-29.
   *
   * ## The gap this closes
   *
   * `call()` records exactly ONE outcome row per call. An attempt that fails
   * and then walks to a successful fallback survives only as
   * `fellOverFrom`/`fallbackReason` metadata ON the success row — so a
   * `call()`-only consumer's corpus contains **no failure rows at all**, by
   * construction, no matter how carefully they wired `record()`.
   *
   * That is not hypothetical. kgauto's own `corpus-implausible-success`
   * detector fired on inspire-central and told them to "wire record() on the
   * FAILURE path" — which they had already done, in five places. Measured:
   * 89 rows, 0 failure rows, 2 fellover-bearing. **The detector demanded
   * output the API could not produce.** Streaming consumers have had
   * `onFailedAttempt` since alpha.48 via `streamWithFallover`; `call()`
   * consumers had nothing. This restores parity.
   *
   * ## Contract
   *
   * Fires for every attempt whose `status` is `'retryable'` or `'terminal'`,
   * including skipped ones (`*_inferred`, `aborted`) — a skip is a real
   * datum about the chain, not an absence. Never fires for `'success'`.
   *
   * Called synchronously and **its throw is swallowed**: a consumer's
   * telemetry bug must never take down the call it is observing. It is a
   * notification, not a hook that can veto or alter the walk.
   *
   * Typical use — emit a failure row per attempt so the corpus can contain
   * failures at all:
   *
   *   call(ir, { onFailedAttempt: (a) => void recordOutcome({
   *     ...base, success: false, errorType: a.errorCode, model: a.model,
   *   }) })
   */
  onFailedAttempt?: (attempt: CallAttempt) => void;

  /** Forwarded to compile(). */
  policy?: CompilePolicy;
  /**
   * alpha.68 / Release A (delegation-fanout-accelerator §5.0, R0 linkage).
   * When set, this call is a fan-out BRANCH of the parent trace: the outcome
   * row records `fanout_role='branch'`, `parent_handle=<this value>`, and
   * `trace_id` inherits the parent handle (the trace root). Absent ⇒ this is a
   * root (user-facing) call: `fanout_role='root'`, `trace_id=<own handle>`.
   * Pass the parent's `CallResult.handle` / `CompileResult.handle`.
   *
   * Release A supports 1-level linkage (root → branch); deeper trees await the
   * `delegate` primitive in Release D. Labelling only — NOT a routing change.
   */
  parentHandle?: string;
  /**
   * alpha (s51 Phase 1) — full-IR inline shadow-probe. When set, kgauto
   * measures the candidate(s) on the same IR after serving the primary,
   * fire-and-forget. See {@link ShadowProbeConfig}.
   */
  shadowProbe?: ShadowProbeConfig;
  /**
   * alpha.73 — how long `call()` may wait for the measured-failure gate's
   * first brain read before compiling, in ms. Default 400.
   *
   * Exists because `compile()` is synchronous and therefore reads only what
   * the SWR cache already holds: on a cold isolate that is nothing, so the
   * gate silently does not fire on the first compile — measured on
   * playbacksam as two billed inferences and ~27–34s of added latency, every
   * time an isolate is new. Low-traffic consumers are cold most of the time,
   * so this hits them hardest, inverting the usual severity ordering.
   *
   * The wait is bounded and never required: on timeout, brain-down, or no
   * brain configured, the call proceeds un-gated exactly as before. Set `0`
   * to disable the wait entirely (the background prefetch still runs, so
   * later calls in the same isolate are gated either way).
   */
  gateWarmupMs?: number;
  /**
   * alpha.78 — per-ATTEMPT time bound on the provider leg, in ms
   * (IC `per-call-timeout-on-call-options` + the portfolio-wide
   * unbounded-LLM-call scan). Without it the only ceiling is the serverless
   * route's `maxDuration`, and one hung socket eats the entire route budget
   * before the fallback chain — the product's whole promise — can walk.
   *
   * Semantics per attempt shape:
   *   - non-streaming: total bound via `AbortSignal.timeout()`; firing
   *     classifies retryable `timeout` (L-061) so the chain WALKS.
   *   - streaming: per-chunk STALL bound (max silence between bytes,
   *     covering time-to-first-byte) — a total bound would cut legitimate
   *     long streams. Also classifies `timeout` on fire.
   *
   * Each wire attempt (including the same-model retry) gets a fresh budget.
   * Default: none — today's unbounded behavior, additive and opt-in; a
   * consumer-side bounds scan (tt-intel s114 shape) can then require it
   * mechanically. A hang recorded before this existed reads as model
   * latency in brain telemetry — transport stalls were indistinguishable
   * from slow models.
   */
  attemptTimeoutMs?: number;
  /**
   * alpha.78 — caller-owned cancellation (route-level deadline propagation).
   * Composed per-attempt with `attemptTimeoutMs` via `AbortSignal.any`.
   * Aborting classifies terminal `aborted` and stops the WHOLE chain walk —
   * the caller cancelled, so walking would spend money on an answer nobody
   * is waiting for. Distinct from a timeout, which walks.
   */
  abortSignal?: AbortSignal;
  toolRelevanceThreshold?: number;
  compressHistoryAfter?: number;
  /**
   * alpha.132 (R4) — how many recent `history` messages a history fold keeps
   * (default 4), beside `compressHistoryAfter`. See `CompileOptions`.
   */
  compressHistoryKeepRecent?: number;
  /** Override API keys (defaults: process.env). */
  apiKeys?: ApiKeys;
  /** Provider-specific request fields shallow-merged into the lowered request. */
  providerOverrides?: ProviderOverrides;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Disable retry/fallback walk on retryable errors. Default: enabled. */
  noFallback?: boolean;
  /**
   * alpha.10. Disable the silent auto-filter of unreachable models from the
   * fallback walk. Default: false (filter ON). Opt-out exists for tests +
   * the rare consumer that wants the legacy "fail at execute() with auth
   * error" behavior. When ON (default), models whose provider has no
   * resolvable API key are dropped from `targetsToTry` before the first
   * network call; if the chain empties entirely, throws CallError with
   * `lastErrorCode = 'no_reachable_models'`.
   *
   * Reachability source: `apiKeys` (this CallOptions) + `process.env` (via
   * `PROVIDER_ENV_KEYS`). Override env via env.ts's `ReachabilityOpts.envSource`
   * is not exposed here — `call()` always uses process.env. Use
   * `getDefaultFallbackChain({ reachability: { envSource } })` upstream
   * for hermetic test runs.
   */
  noAutoFilter?: boolean;
  /**
   * alpha.34. When provided AND the chosen provider supports streaming
   * (`profile.streaming === true`) AND `noStream` is not set, kgauto
   * enables provider-native SSE streaming at the wire layer and invokes
   * `onChunk(delta)` once per provider stream event. `delta` is the text
   * since the previous `onChunk` call (NOT cumulative) — provider
   * stream-shape headache normalized in kgauto's lowering layer.
   *
   * `CallResult.response.text` is still populated with the full assembled
   * response — kgauto buffers internally regardless of the callback.
   * Consumers can use either the streaming side-effect OR the final
   * `response.text`, doesn't matter.
   *
   * Tool calls + finish reason + usage are collected from stream events
   * and returned in the final `CallResult` exactly as the non-streaming
   * path would shape them. Brain telemetry latency = time-to-stream-end.
   *
   * Chain-walk semantics: if the streaming target fails mid-stream
   * (network error, retryable provider error), kgauto walks to the next
   * fallback target and restarts streaming from its first chunk —
   * `onChunk` fires fresh from the new target. Consumer detects via the
   * post-call `CallResult.fellOverFrom`. To opt out of fallback for
   * streaming, set `noFallback: true` alongside `onChunk`.
   *
   * Filed by playbacksam s42 (2026-05-22) as `streaming-output-callback-
   * on-callresult` for ComposeDrawer SSE; perceived-latency UX win
   * during 10-30s draft assembly.
   */
  onChunk?: (chunk: string) => void;
  /**
   * alpha.34. Explicit opt-out of streaming even when `onChunk` is
   * provided. Default: false (streaming enabled when `onChunk` is set).
   * Use when the consumer wants to pass `onChunk` conditionally without
   * branching the call site (e.g., capture chunks for instrumentation
   * without engaging streaming wire format).
   */
  noStream?: boolean;
  /**
   * alpha.62 (eval spine) — golden-set capture. When the resolved sample rate
   * is > 0, a successful non-empty call's FULL PromptIR + served output is
   * stored to the brain's `kgauto_golden_irs` replay corpus (raw prompt —
   * explicit opt-in; see golden.ts consent posture). `sampleRate` here
   * overrides the `KGAUTO_GOLDEN_CAPTURE` env var; when neither is set,
   * capture never fires.
   */
  goldenCapture?: import('./golden.js').GoldenCaptureOptions;
  /**
   * alpha.66 — one same-model retry on a structured-output contract violation
   * (`max_tokens_on_structured_output` / `structured_output_parse_failed`)
   * BEFORE chain-walking to a lower-ranked tier. Filed by playbacksam
   * 2026-07-18 (`structured-output-truncation-retry-same-model`): on PB's
   * summarize surface the walk destination is measured quality-inferior
   * (golden eval run #3), so one more attempt at the leader beats walking.
   *
   * Consent posture (matches KGAUTO_AUTO_PROMOTE / KGAUTO_GOLDEN_CAPTURE):
   * default OFF; `true` wins, explicit `false` beats the env, undefined
   * falls through to the `KGAUTO_SAME_MODEL_RETRY` env var ('1'/'true').
   * Default-off because the retry adds one full model round-trip of latency
   * in the failure class — the consumer decides whether their fallback tier
   * is bad enough to pay that.
   *
   * Bounds: at most ONE retry per call(), on whichever target hits the
   * contract violation first. Truncation-class retries additionally raise
   * any explicit wire output cap sitting below the profile's
   * `maxOutputTokens` (e.g. a terse-clamp or providerOverrides cap);
   * requests already at the profile ceiling re-roll unchanged.
   */
  sameModelRetry?: boolean;
}

export interface CallAttempt {
  model: string;
  status: 'success' | 'retryable' | 'terminal';
  errorCode?: string;
  message?: string;
  /**
   * alpha.66 — true on the attempt row that was the one-shot same-model
   * retry (CallOptions.sameModelRetry). The preceding row for the same model
   * carries the contract violation that triggered it.
   */
  sameModelRetry?: boolean;
  /** KG-18 step 1 (alpha.111) — balance / quota / outage / refusal / quality, from the provider body. */
  fallbackClass?: 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';
  /** KG-18 step 1 — the provider's own name for the limit, when given. */
  quotaId?: string;
  /**
   * alpha.132 (R3c) — set on the attempt that re-sent the same target with
   * every thinking block stripped from the history, after it answered
   * `thinking_prefix_mismatch`: the number of blocks removed. The row before it
   * (same model) carries the 400.
   */
  thinkingStrippedRetry?: number;
}

/**
 * Why fallback fired. Normalized for `CallResult.fallbackReason` (alpha.9).
 *
 *   - `rate_limit`           provider returned 429
 *   - `provider_error`       5xx, network, or other retryable upstream issue
 *   - `cost_cap`             preflight policy.maxCostPerCallUsd rejected target
 *   - `cliff`                alpha.8 contract violation (MAX_TOKENS on
 *                            structured output, parse-failed JSON)
 *   - `contract_violation`   other compile-time-contract failures (reserved
 *                            for alpha.10+ — e.g. mid-stream policy rejects)
 *   - `provider_auth_failed` alpha.14 — initial provider returned 401/403
 *                            (upstream key revocation, malformed-but-truthy
 *                            key). The chain walks to the next
 *                            non-same-provider target instead of
 *                            short-circuiting; same-provider remaining
 *                            entries skip with errorCode='auth_inferred'.
 *   - `provider_billing_exhausted` alpha.77 — the provider's ACCOUNT is out
 *                            of credits (Anthropic "credit balance is too
 *                            low" 400, OpenAI insufficient_quota 429,
 *                            Google billing-disabled, DeepSeek 402). Walks
 *                            like auth and skips same-provider siblings
 *                            (errorCode='billing_exhausted_inferred').
 *                            Distinct from auth AND from rate_limit because
 *                            its disposition is distinct: it never clears
 *                            on its own — a human funds the account.
 */
export type FallbackReason =
  | 'rate_limit'
  | 'provider_error'
  | 'cost_cap'
  | 'cliff'
  | 'contract_violation'
  | 'provider_auth_failed'
  | 'provider_billing_exhausted';

export interface CallResult {
  /** Compile handle (still valid for record() if consumer wants to add oracle scores later). */
  handle: string;
  /** The model that ACTUALLY served the response (post-fallback). */
  actualModel: string;
  /** What compile() originally targeted. */
  requestedModel: string;
  provider: Provider;
  response: NormalizedResponse;
  latencyMs: number;
  /**
   * alpha.92 — the route this call traveled. `'direct'` unless the caller
   * passed `CallOptions.route`. Part of the measurement's identity: the
   * outcome row and learning key are route-scoped, and verdicts never
   * silently transfer across routes.
   */
  route: CallRoute;
  /**
   * alpha.92 — the serving host the gateway reported for the winning
   * attempt (OpenRouter's `provider` field: "Venice", "StreamLake", …).
   * Undefined on direct calls.
   */
  routeHost?: string;
  /**
   * alpha.92 — cliff metrics of the served profile that applied on a
   * non-direct route. The guards STILL FIRED (conservative default: never
   * assume a host fixed a vendor cliff) but their evidence is vendor-route
   * evidence — a different serving stack may not share the cliff. The
   * probe-suite can promote/demote per (cliff × route). Undefined on
   * direct calls or when the served profile has no cliffs.
   */
  routeUnverifiedCliffs?: string[];
  /**
   * alpha.105 — the model the provider's response reported serving, verbatim
   * (`NormalizedResponse.servedModel` of the winning attempt). Undefined when
   * the body omitted it. `servedBy` is what kgauto ASKED for; this is what
   * the provider SAID it did.
   */
  servedModel?: string;
  /**
   * alpha.105 — true when `servedModel` is present and does not name the
   * same model as `servedBy` after the provider's own id conventions are
   * allowed for (dated Anthropic ids, `vendor/model` gateway slugs, dot vs
   * hyphen versions). A `true` here on a pinned model means the route
   * substituted — it is not a transport. See `servedModelDiffers()`.
   */
  servedModelDiffers?: boolean;
  /** alpha.105 — the per-call receipt of the served compile (mirrors `CompileResult.diagnostics.savings`). */
  savings: SavingsReceipt;
  /** Mutations that fired during compile (informational, mirrors CompileResult.mutationsApplied). */
  mutationsApplied: MutationApplied[];
  /** One entry per provider attempt — observability for retry/fallback walks. */
  attempts: CallAttempt[];
  /**
   * Alpha.9 normalization of fallback-walk telemetry. When the chain
   * succeeded on the first attempt, these collapse to:
   *   - `servedBy === requestedModel`
   *   - `fellOverFrom` undefined
   *   - `fallbackReason` undefined
   *
   * When fallback fired:
   *   - `servedBy` = `actualModel` (the model that produced the response)
   *   - `fellOverFrom` = `requestedModel` (what the caller / compile() asked for)
   *   - `fallbackReason` = normalized cause derived from the first
   *     non-success attempt's `errorCode`
   *
   * Consumer UX use: show "Claude was busy; we used Pro for this answer"
   * when `fellOverFrom` is set (master plan §3.6).
   */
  /** Model that actually answered. Equal to `actualModel`; kept distinct for clarity. */
  servedBy: string;
  /** Set only when fallback fired. Equal to `requestedModel` in that case. */
  fellOverFrom?: string;
  /** Set only when fallback fired. Normalized cause. */
  fallbackReason?: FallbackReason;
  /**
   * alpha.71 — the PRECISE `errorCode` of the attempt that drove the chain,
   * unnormalized. `fallbackReason` is a six-value summary and one of its
   * values, `'cliff'`, absorbs two failures with OPPOSITE remedies:
   *
   *   - `max_tokens_on_structured_output` — the output budget was too small
   *     for the requested shape ⇒ raise the cap / add an output-budget cliff.
   *   - `structured_output_parse_failed`  — the model emitted non-JSON ⇒ its
   *     declared `structuredOutput` capability is wrong for this shape.
   *
   * The code was already computed in `attempts[]` and thrown away at record
   * time, so a surface could accumulate a dozen identical `'cliff'` rows that
   * still could not tell an operator which fix applies. (Found diagnosing
   * claude-haiku-4-5's 12-of-12 failures on playbacksam/summarize, where the
   * measured-failure gate correctly stopped the bleeding but the evidence
   * could not name the cause.)
   */
  fellOverErrorCode?: string;
  /** KG-18 step 1 — class of the failure behind the fall-over (balance/quota/outage/refusal/quality). */
  fellOverClass?: 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';
  /** KG-18 step 1 — the provider's own quota / cap name, when given. */
  fellOverQuotaId?: string;
  /** KG-18 step 0 — fingerprint of the key the call was served with (never the key). */
  keyFingerprint?: string;
  /**
   * alpha.66 — true when the one-shot same-model retry
   * (CallOptions.sameModelRetry) fired during this call, regardless of
   * whether the retry rescued the call or the chain walked afterwards.
   * Cross-check `attempts[]` (the `sameModelRetry: true` row) and
   * `fellOverFrom` to distinguish rescued-by-retry from retried-then-walked.
   */
  retriedSameModel?: boolean;
  /**
   * alpha.10. Models that auto-filter dropped from the fallback walk because
   * their provider had no reachable API key. Empty when nothing was filtered
   * (the common case once consumers have all the keys they need). Surfaces
   * silent self-heal so consumers can log/audit what happened without
   * defeating the "kgauto just gets" UX.
   *
   * Empty array (not undefined) when filter ran but dropped nothing —
   * distinguishes "filter ran cleanly" from "filter was disabled" (`undefined`
   * when `noAutoFilter: true`).
   */
  unreachableFiltered?: string[];
  /**
   * alpha.16. Models that policy.blockedModels filtering dropped from the
   * fallback walk (alpha.115: and policy.blockedProviders — a model whose
   * provider is blocked lands here too). Defense-in-depth at the call() boundary — compile()'s
   * passScoreTargets already excludes blocked entries from the initial
   * target + fallbackChain, but if a consumer re-shapes the chain and
   * threads policy through only partially, this filter catches the gap.
   *
   * Resolves TT-40 follow-on `policy-block-not-enforced-on-fallback-chain`
   * (2026-05-15) where mutations_applied recorded the block intent but
   * the call walker landed on the blocked model anyway.
   *
   * Undefined when no filter ran (no blockedModels set). Populated only
   * when filter ran AND dropped at least one entry — empty drops are
   * stored as `undefined` to keep brain telemetry quiet on the common
   * case.
   */
  policyBlockedFiltered?: string[];
  /**
   * alpha.17. Unique identifier for this call() invocation, generated at
   * call() entry via crypto.randomUUID(). Returned on success and emitted
   * as the routing key for Glass-Box observability events
   * (compile.start, compile.done, execute.attempt, execute.success,
   * fallback.walked, advisory.fired). Pass the same id to
   * `subscribe(traceId)` from `@warmdrift/kgauto-compiler/glassbox` to
   * tap the in-flight event stream.
   *
   * Always present on success. Additive, non-breaking.
   */
  traceId: string;
  /**
   * alpha.44. Best-practice advisories emitted by the compile that actually
   * served the response (mirrors `CompileResult.advisories`; uses the SERVED
   * compile on fallback, same as `mutationsApplied`). Empty array when no
   * rules fired.
   *
   * Closes IC's `callForAgent` side-finding (2026-05-26): call() consumers
   * (agent paths — sweep / dyad / session-title) previously had no way to
   * `logAdvisories('[kgauto-v2 ...]', advisories)` like compile() consumers
   * (chat / intake) do, because the advisories were consumed internally
   * (trace events, brain record) but never returned. Additive, non-breaking.
   *
   * alpha.133 (R4) — when the call fell over, an advisory that recommends a
   * model which failed on THIS call (a cost or tier-down swap back to the
   * model whose key was just refused, say) is left off this list: the advice
   * contradicts what the call just saw. The next call where that model serves
   * carries it again.
   */
  advisories: BestPracticeAdvisory[];
  /**
   * alpha.133 (R3) — what kgauto did to this call, in one or two plain
   * sentences: the model that answered, whether a fallback happened and why,
   * and each change made to the request (sections or tools left out, older
   * turns replaced by a summary note, cache marks placed, settings dropped
   * because the model rejects them, thinking blocks removed). No mutation ids,
   * no handles. A call kgauto changed nothing about says so. Built from the
   * fields beside it (`attempts`, `mutationsApplied`, `advisories`, the served
   * compile's diagnostics and wire request); read them for the detail.
   */
  summary: string;
}

/**
 * Thrown when call() exhausts the fallback chain without success.
 * `attempts` carries every model tried + classification.
 */
/**
 * alpha.124 — thrown by compile() when the IR requires an input modality
 * (`constraints.inputModalities`), no consumer pin is set, and no candidate's
 * profile declares every required modality. `call()` turns it into a
 * `CallError` with the same code BEFORE any request leaves the process.
 */
export class InputModalityError extends Error {
  readonly code = 'no_model_declares_input_modality' as const;
  readonly required: RequiredInputModality[];
  readonly dropped: InputModalityDrop[];
  constructor(message: string, required: RequiredInputModality[], dropped: InputModalityDrop[]) {
    super(message);
    this.name = 'InputModalityError';
    this.required = required;
    this.dropped = dropped;
  }
}

export class CallError extends Error {
  readonly attempts: CallAttempt[];
  readonly lastErrorCode?: string;
  readonly lastStatus?: number;
  constructor(message: string, attempts: CallAttempt[], lastStatus?: number, lastErrorCode?: string) {
    super(message);
    this.name = 'CallError';
    this.attempts = attempts;
    this.lastStatus = lastStatus;
    this.lastErrorCode = lastErrorCode;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// RECORD INPUT (the outcome side)
// ─────────────────────────────────────────────────────────────────────────

export interface OracleScore {
  /** 0..1 overall quality. */
  score: number;
  /** Optional per-dimension breakdown. */
  dimensions?: Record<string, number>;
  /** Free-form explanation for debugging. */
  rationale?: string;
}

/**
 * alpha.86 — who originated an outcome row (migration 056).
 *
 * Absent/undefined means ORGANIC: a real consumer call on behalf of a real
 * user. Consumers change nothing. Synthetic writers — canaries, smoke
 * gates, eval replays, probe harnesses — self-mark, so liveness and volume
 * rules can compute over consumer-originated rows only.
 *
 * The incident this closes (cost-watch 2026-08-06 → 08-08): playbacksam's
 * daily canary wrote exactly 8 rows/day for 13 straight days while PB's
 * organic traffic was near-zero, and the liveness rule scored PB the
 * healthiest consumer in the portfolio. On 08-08 EVERY row the brain
 * received in 24h was canary, and no rule could say so — distinguishing a
 * replay from real traffic took a hand-reconstructed time-window +
 * token-fingerprint argument, three mornings running. A consumer whose
 * only rows are written by kgauto's own machinery is dark, not healthy;
 * this column is what lets a rule print that sentence.
 *
 * alpha.115 — `'reader'`: a `readFiling()` call (app `kgauto-reader`),
 * kgauto's own second-family read of a design filing. Not consumer traffic,
 * so it stays out of organic-liveness math like every other non-NULL value.
 * Migration 082 extends the brain's CHECK to admit it.
 */
export type OutcomeSource = 'canary' | 'smoke' | 'eval' | 'probe' | 'synthetic' | 'reader';

export interface RecordInput {
  /** Handle from CompileResult. */
  handle: string;
  /**
   * alpha.86 — self-mark for synthetic writers (migration 056). OMIT for
   * real traffic; never write an explicit "organic" value. See
   * {@link OutcomeSource}.
   */
  source?: OutcomeSource;
  /**
   * alpha.89 (migration 065) — per-end-user metering. Your own OPAQUE
   * customer id (hash it upstream if your ids are sensitive; kgauto stores
   * it verbatim, truncated to 128 chars). With it, the brain becomes a
   * per-customer COGS ledger: `kgauto_end_user_ledger_v` aggregates calls /
   * tokens / cost_usd per (app, end user, month) over organic traffic only —
   * the substrate for usage-based billing and per-customer quota checks.
   * Omit for traffic that has no end user.
   */
  endUserId?: string;
  /**
   * alpha.92 — the route the call traveled (migration 067). `call()` sets
   * this automatically from `CallOptions.route`; manual `record()` callers
   * replaying through a gateway set it themselves. Omit for direct calls —
   * the column defaults to `'direct'`.
   */
  route?: CallRoute;
  /**
   * alpha.92 — the gateway-reported serving host ("Venice", "StreamLake").
   * Only meaningful with a non-direct `route`.
   */
  routeHost?: string;
  /**
   * alpha.105 (migration 074) — the model the provider reported serving,
   * verbatim from `NormalizedResponse.servedModel`. Omitted when unknown.
   */
  servedModel?: string;
  /** Actual tokens consumed (post-call). */
  tokensIn: number;
  tokensOut: number;
  /** Wall-clock latency in ms. */
  latencyMs: number;
  /** True iff the call returned a usable response. */
  success: boolean;
  /** True iff the call returned 0 output tokens despite success. */
  emptyResponse?: boolean;
  /** Provider error code if any. */
  errorType?: string;
  /** Tools actually invoked by the model. */
  toolsCalled?: string[];
  /** Oracle quality score — required for learning to fire. */
  oracleScore?: OracleScore;
  /** Optional: scrubbed prompt/response previews for debugging. */
  promptPreview?: string;
  responsePreview?: string;
  /**
   * The model that ACTUALLY RAN. Set this when consumer-side fallback ran
   * a different model than v2 compile() targeted. Brain stores this as
   * `model` (the truth) and the original target as `requested_model`.
   *
   * Omit when no fallback occurred — brain stores compile target as `model`
   * (still the truth in that case) and `requested_model` stays NULL.
   *
   * s11 fix: prevents the brain from misattributing fallback traffic to
   * the originally-requested model.
   */
  actualModel?: string;
  /**
   * Override `mutations_applied` for this outcome. Set by `call()` when
   * fallback fires — the served compile's mutations (which actually shaped
   * the request that went on the wire) replace the initial compile's
   * mutations (registered against the handle). Without this override, fallback
   * traffic is attributed to the initial compile's mutations and the brain's
   * mutation effectiveness stats become misleading.
   *
   * alpha.4: extends s11 truth-in-logging to mutations.
   */
  mutationsApplied?: string[];
  /**
   * Cache read input tokens, when supported by the provider.
   * - Anthropic: `usage.cache_read_input_tokens`
   * - Google (implicit caching): `usageMetadata.cachedContentTokenCount`
   * - OpenAI: `usage.prompt_tokens_details.cached_tokens`
   *
   * Powers the cost-and-efficiency-watcher (interfaces/kgauto.md, alpha.4):
   * `tokens_in - cache_read_input_tokens` is the un-cached new context per call.
   */
  cacheReadInputTokens?: number;
  /**
   * Cache creation input tokens (Anthropic-specific).
   * `usage.cache_creation_input_tokens`. The first call that pays the 25%
   * upcharge to write a cache marker; subsequent calls hit `cacheRead`.
   */
  cacheCreationInputTokens?: number;
  /**
   * Time to first token (ms). Distinct from `latencyMs` (end-to-end wall clock).
   * alpha.129 — `call()` writes it on a STREAMED winning attempt (kgauto's
   * streaming path measures it: request send → first content event); a
   * single-shot attempt records none. A consumer calling `record()` itself
   * (the AI-SDK path) passes its own first-token clock when it has one;
   * kgauto does not derive it. Absent → the `ttft_ms` key is absent.
   */
  ttftMs?: number;
  /**
   * alpha.57 (data-first) — the reasoning-effort tier this call actually ran
   * at. Overrides the compile-declared `constraints.effort` when both are
   * present (input wins — same precedence as `mutationsApplied`/`advisories`).
   * When omitted, record() auto-enriches from the registry-cached compile
   * declaration. Undefined end-to-end → the `effort` key is absent from the
   * outcome payload entirely (safe against pre-migration-033 brains).
   * alpha.135: this is the caller's statement; what kgauto set on the wire is
   * `effortSet` (the `effort_set` column).
   */
  effort?: EffortLevel;
  /**
   * alpha.135 — the effort kgauto SET on the request that served this call (the
   * `effort_set` column): on the AI-SDK adapter path the value it put in
   * `providerOptions` (e.g. `anthropic.effort: 'low'`), on the plain-fetch path
   * the value in the lowered request (OpenAI `reasoning_effort`, `'none'`
   * included). `call()` sets it on a fallback row from the compile that served;
   * when omitted, record() takes the registered compile's. `null` says the
   * serving request set none (the key is then left out). Distinct from
   * `effort`, which is what the CALLER declared.
   */
  effortSet?: string | null;
  /**
   * alpha.20 — advisories fired at compile() time. Persisted to the brain's
   * `compile_outcome_advisories` sibling table via a second POST that fires
   * AFTER the primary outcome insert succeeds. Best-effort: a failed
   * advisory POST is logged via onError but does NOT throw or roll back the
   * primary outcome row.
   *
   * Pass `result.advisories` from the CompileResult directly. The brain
   * uses these to compute the `empty_rate_clean` comparator (rows with
   * zero advisories fired) so consumers can distinguish "model is bad"
   * from "client sent a bloated/uncached/malformed request."
   *
   * Empty array / undefined → no second POST fires.
   */
  advisories?: BestPracticeAdvisory[];
  /**
   * alpha.28 — Glass-Box renderer substrate fields (migration 018).
   *
   * All optional. When omitted, brain stores NULL and the renderer falls
   * back to "—" / hidden rows. Library callers (`call.ts`) populate what
   * they observe; adapter / SDK consumers can populate the rest from their
   * own provider response surface.
   */

  /**
   * Provider finish reason. Captured from NormalizedResponse.finishReason
   * (Anthropic `stop_reason`, Google `finishReason`, OpenAI `finish_reason`).
   * Lower-case canonicalization is the brain's job; consumers can pass
   * raw provider strings.
   */
  finishReason?: string;
  /**
   * End-to-end wall-clock latency in ms. Distinct from `latencyMs` only
   * insofar as `latencyMs` was the historical name for the same metric;
   * `totalMs` is the new column on `compile_outcomes` (migration 018).
   * When omitted, brain mirrors `latency_ms`.
   */
  totalMs?: number;
  /** Tools kept after the tool-relevance pass. */
  toolsCount?: number;
  /** Number of history messages at compile time. */
  historyDepth?: number;
  /** Rendered system prompt size in characters. */
  systemPromptChars?: number;
  /** Model originally targeted when a fallback fired. */
  fellOverFrom?: string;
  /**
   * Why the fallback fired — the SAME closed set as CallResult.fallbackReason
   * (one derivation; the alpha.77 DTS break caught this field's inline copy
   * drifting when the canonical union grew a member).
   */
  fallbackReason?: FallbackReason;
  /**
   * alpha.66 — true when the one-shot same-model retry fired during this
   * call (migration 039 `retried_same_model`). Powers the offline rollup:
   * retry rate on the cliff class, and — joined with `fell_over_from` —
   * how often the retry rescued the call vs the chain walking anyway.
   */
  retriedSameModel?: boolean;
  /**
   * alpha.71 — the precise `errorCode` of the attempt that drove the chain
   * (migration 044). Set automatically by `call()`; a consumer driving
   * `record()` by hand may pass it. See `CallResult.fellOverErrorCode` for
   * why the normalized `fallbackReason` is insufficient on its own.
   */
  fellOverErrorCode?: string;
  /** KG-18 step 1 (alpha.111) — class of the failure behind the fall-over (balance/quota/outage/refusal/quality). */
  fellOverClass?: 'balance' | 'quota' | 'outage' | 'refusal' | 'quality';
  /** KG-18 step 1 — the provider's own quota / cap name, when given. */
  fellOverQuotaId?: string;
  /** KG-18 step 0 — fingerprint of the key the call was served with (never the key). */
  keyFingerprint?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// RECORD OUTCOME (alpha.20 Entry 4) — consumer-outcome feedback loop
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.20 Entry 4: kinds of consumer-declared outcomes feeding the quality
 * loop. Surfaces in `recordOutcome()` as the verdict the consumer's UX is
 * forwarding to the brain.
 *
 *   - `approved`  user explicitly approved (thumbs up, "looks good", accepted)
 *   - `rejected`  user explicitly rejected (thumbs down, "redo", discarded)
 *   - `partial`   accepted with edits or partial use (mixed signal)
 *   - `engaged`   user engaged with the output (copy/scroll/dwell)
 *   - `abandoned` user abandoned the response (closed, navigated away)
 *   - `unknown`   verdict could not be inferred — recorded for completeness
 */
export type OutcomeKind =
  | 'approved'
  | 'rejected'
  | 'partial'
  | 'engaged'
  | 'abandoned'
  | 'unknown';

/**
 * Input to `recordOutcome()` — consumer's verdict on a previously-compiled
 * call. Joins to the original `compile_outcomes` row via outcomeId,
 * enabling per-(model, archetype) approve-rate measurement once N ≥ 10
 * outcomes accumulate.
 */
export interface RecordOutcomeInput {
  /**
   * Joins to compile_outcomes.id. Pass the compile `handle` string
   * (CompileResult.handle / CallResult.handle) — consumer proxies resolve
   * handle → compile_outcomes.id via the `compile_outcomes.handle` column
   * (reference implementations: PB `api/kgauto-v2/compile_outcome_quality.js`,
   * tt-intel/IC `app/api/kgauto/v2/compile_outcome_quality/route.ts`). A
   * numeric compile_outcomes.id also works if the caller already has it.
   * (There is no `CompileResult.outcomeId` field — the brain assigns the row
   * id at insert; `handle` is the consumer-visible correlator.)
   */
  outcomeId: number | string;

  /** What did the user / system do with this output? */
  outcome: OutcomeKind;

  /** Optional 1-5 user rating (e.g., thumbs up/down with intensity, NPS-style). */
  rating?: 1 | 2 | 3 | 4 | 5;

  /** Optional free-text reason (e.g., user-typed feedback, system-inferred cause). */
  reason?: string;

  /**
   * Optional model-reported confidence at compile time (0..1). Used for
   * Brier-score calibration in later phases (alpha.21+) — pair this with
   * the actual `outcome` to compute calibration error.
   */
  observedConfidence?: number;
}

/**
 * Return shape of `recordOutcome()`. Never throws — persistence failures
 * surface as `ok: false` with a stable `reason` string.
 */
export interface OutcomeResult {
  /**
   * `true` — the POST was acknowledged 2xx (sync mode only).
   * `'queued'` (alpha.61) — fire-and-forget mode: the write was handed to the
   * runtime but NOT acknowledged; delivery is unknown at return time. Read
   * `brainHealth()` or set `BrainConfig.sync` for delivery evidence.
   * `false` — brain not configured, or the POST failed (sync mode).
   * Both truthy values pass `if (result.ok)`; pre-alpha.61 code that treated
   * the fire-and-forget `true` as an ack was reading a false signal.
   */
  ok: boolean | 'queued';
  /** Stable reason code when ok=false. One of: 'brain_not_configured' | 'persistence_failed'. */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// CHAIN GROUNDING (alpha.21 — s78 Entry 1)
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.21 (s78 Entry 1): provenance label on a chain entry. Surfaces WHY
 * an entry sits where it sits so consumers can distinguish:
 *
 *   - 'measured'         brain has N>=10 rows with a measurable quality
 *                        outcome backing this placement. The number lives on
 *                        `ChainEntry.n`.
 *   - 'capability-fact'  inclusion or exclusion driven by a published or
 *                        measured CAPABILITY (L-040 cliff, ctx window cap,
 *                        structured-output support). Not an opinion — a
 *                        fact about what the model can/can't do.
 *   - 'judgment'         engineer's pick, no measured backing yet. Cold-start
 *                        prior; entirely valid until evidence accumulates.
 *
 * "Judgment" is HONEST, not a downgrade. Most of `STARTER_CHAINS` lands here
 * in alpha.21 — that's the point: consumers can SEE the grounding gap and
 * prioritize the measurement work that would graduate them to 'measured'.
 */
export type Grounding = 'measured' | 'capability-fact' | 'judgment';

/**
 * alpha.21 (s78 Entry 1): a single position in a fallback chain, carrying its
 * provenance label and an optional human-readable reason. The shape replaces
 * the old `string[]` representation everywhere chains are surfaced externally.
 *
 * `n` is REQUIRED when `grounding === 'measured'` — the runtime helper
 * `makeMeasuredEntry()` enforces this. For 'capability-fact' and 'judgment'
 * entries, `n` is undefined.
 */
export interface ChainEntry {
  /** Canonical model id (post-alias). */
  id: string;
  /** Why this entry sits in this position. */
  grounding: Grounding;
  /**
   * Optional one-liner explaining the grounding decision. The inline comments
   * that historically lived next to STARTER_CHAINS entries are now expressed
   * here as machine-readable text.
   */
  reason?: string;
  /**
   * When `grounding === 'measured'`, the brain row count that backs this
   * placement. Undefined for 'capability-fact' and 'judgment' entries.
   */
  n?: number;
}

/**
 * alpha.21 introspection shape — a per-archetype chain with grounding on
 * every position. Consumers reading this never see naked string ids;
 * everything carries provenance.
 */
export interface ChainWithGrounding {
  archetype: IntentArchetypeName;
  /** Ordered: position 0 = primary, rising index = fallback positions. */
  entries: ChainEntry[];
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.23 — per-axis metrics (s78 Phase 3 substrate)
// ─────────────────────────────────────────────────────────────────────────
//
// Returned by `getPerAxisMetrics()` and (via `PerAxisMetricsByModel`)
// surfaced for chain-comparison views. NO composite score / NO weights —
// aggregation policy belongs to the consumer/dashboard, not the library.
//
// Per `feedback_quality_as_floor`: quality is a BINARY FLOOR, not a weight
// to be traded off against cost. Consumers compose multiplier formulas
// appropriate to their use case using the raw per-axis numbers below.

/** alpha.23 (s78 Phase 3): per-axis metrics returned by the brain RPC. */
export interface PerAxisMetrics {
  appId: string;
  archetype: string;
  model: string;
  windowDays: number;
  /** Total brain rows for this tuple in the window. */
  nRows: number;
  /** Subset of nRows with zero advisories fired — the "clean signal" comparator. */
  nRowsClean: number;
  /** Count of compile_outcome_quality entries joining to this tuple's outcomes. */
  nQualityOutcomes: number;
  /** Approve rate from quality outcomes. null when nQualityOutcomes === 0. */
  magicRate: number | null;
  /** Whether magicRate >= consumer-declared qualityFloor. null when no floor declared OR no outcomes. */
  qualityFloorMet: boolean | null;
  costEfficiency: {
    avgCostUsd: number | null;
    avgCostUsdClean: number | null;
    avgInputTokens: number | null;
    avgOutputTokens: number | null;
    inputTokenRatio: number | null;
  };
  timeEfficiency: {
    avgLatencyMs: number | null;
    avgTtftMs: number | null;
  };
  reliability: {
    successRate: number | null;
    successRateClean: number | null;
    emptyRate: number | null;
    emptyRateClean: number | null;
  };
  evidenceFreshnessDays: number | null;
}

/** Per-axis metrics keyed by model — used for chain-comparison views. */
export type PerAxisMetricsByModel = Record<string, PerAxisMetrics>;
