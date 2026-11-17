/**
 * call() — the high-level orchestrator that owns the network round-trip.
 *
 *   call(ir) ≈ compile(ir) → execute(request) → normalize(response) → record(...)
 *
 * Plain-fetch consumers (playbacksam, future incantato/glass-box/ivypass) use
 * call() instead of importing fetch and reinventing per-provider response
 * parsing. AI-SDK consumers can keep using compile() unchanged — call() is a
 * sibling, not a replacement.
 *
 * Retry/fallback: on a retryable error (429, 5xx, 404, network), walk
 * CompileResult.fallbackChain by re-running compile() with forceModel set on
 * each fallback target. Each fallback gets fresh cliffs + fresh lowering.
 * Hard cap at fallbackChain.length + 1 attempts. Terminal errors short-circuit.
 */

import { parseJsonLoose } from './json-loose.js';
import type {
  CallAttempt,
  CallOptions,
  CallResult,
  FallbackReason,
  PromptIR,
  CompiledRequest,
  CompileResult,
  NormalizedResponse,
  ShadowProbeConfig,
  ApiKeys,
  CompilePolicy,
  ProviderOverrides,
  BestPracticeAdvisory,
  MutationApplied,
  ChainModelEntry,
} from './ir.js';
import { CallError, InputModalityError } from './ir.js';
import { deriveOwnership } from './advisor.js';
import { compile as compileImpl } from './compile.js';
import {
  registerCompile,
  record,
  recordShadowProbe,
  isBrainSync,
  peekRegisteredShapeKey,
} from './brain.js';
import {
  resolveGoldenCaptureRate,
  shouldCaptureGolden,
  captureGoldenIr,
} from './golden.js';
import { execute, type ExecuteOk, type ExecuteResult } from './execute.js';
import { isModelReachable, isSameModelRetryEnabledFromEnv, resolveProviderKey } from './env.js';
import { keyFingerprintSync } from './key-health.js';
import { inferProviderFromId } from './profiles.js';
import { tryGetProfile, latencyTierOf, allProfiles } from './profiles.js';
import { canonicalPolicySet, isProviderBlocked, policySetHas } from './policy-match.js';
import { ensureCrossProviderTail } from './fallback.js';
import {
  fallsOverWithoutThinking,
  gateProviderOverrides,
  inputTransformationAdvisories,
  rejectedShapeAdvisory,
  shapeDropMutations,
  stripThinkingBlocks,
  thinkingDroppedAdvisory,
  thinkingPrefixRecoveredAdvisory,
  type RejectedShapeDrop,
} from './request-shapes.js';
import { deriveFamilyFromModelId } from './family-resolution.js';
import {
  awaitMeasuredFailureReady,
  getMeasuredFailureVerdict,
} from './measured-failure-brain.js';
import { awaitPromotionsReady } from './promotions-brain.js';
import type { IntentArchetypeName } from './dialect.js';
import {
  emitAdvisoryFired,
  emitCompileDone,
  emitCompileStart,
  emitExecuteAttempt,
  emitExecuteSuccess,
  emitFallbackWalked,
} from './glassbox/emit.js';

/**
 * Compile, execute, normalize, record. Returns a CallResult once a provider
 * actually serves the request. Throws CallError if the fallback chain is
 * exhausted without success.
 */
/**
 * alpha.73 — resolve the cold-start gate warm-up budget.
 *
 * 400ms default: an order of magnitude below the ~27–34s a cold-blind gate
 * costs when it lets a failing model lead, and small enough to be invisible
 * next to any real inference. Consumer-overridable per call; `0` disables the
 * wait without disabling the gate.
 */
function resolveGateWarmupMs(opts: CallOptions): number {
  const declared = opts.gateWarmupMs;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return declared;
  }
  return DEFAULT_GATE_WARMUP_MS;
}

const DEFAULT_GATE_WARMUP_MS = 400;

export async function call(ir: PromptIR, opts: CallOptions = {}): Promise<CallResult> {
  // alpha.17: traceId is the routing key for Glass-Box observability events.
  // Generated once per call(); returned on CallResult; emitted on every
  // glassbox event so a side-panel subscriber can tap a single trace.
  // We wrap emit calls in try/catch via emit.ts (critical-path safety).
  const traceId = generateTraceId();

  safeEmit(() =>
    emitCompileStart(traceId, ir.appId, {
      appId: ir.appId,
      archetype: ir.intent.archetype,
      // alpha.41: ir.models is ChainModelEntry[] (string | { family }).
      // Glass-Box renderer carries string ids only; surface family entries
      // as their family tag prefixed so the panel still shows them in the
      // pre-resolution log.
      models: ir.models.map((m) =>
        typeof m === 'string' ? m : `family:${m.family}`,
      ),
    }),
  );

  // alpha.73 — close the cold-isolate gap before compiling.
  //
  // `compile()` is synchronous, so it can only read whatever the SWR cache
  // already holds; on a cold isolate that is nothing, and the measured-failure
  // gate silently does not fire on the one compile that matters most. Measured
  // on playbacksam: cold → gate absent → `claude-haiku-4-5` leads → cliff →
  // same-model retry → fallover to gemini, at two billed inferences and
  // ~27–34s; warm → gate fires → gemini leads directly.
  //
  // `call()` is async and is about to spend seconds in a provider, so a
  // bounded wait here is close to free. Bounded, never required: on timeout,
  // brain-down, or no brain, we proceed exactly as before — un-gated. The
  // ceiling is a delay, never a failure.
  //
  // alpha.86 — the promotions cache warms under the SAME budget,
  // concurrently (one shared ceiling, not two in sequence). Same cold-blind
  // shape as the gate: without this, a cold isolate compiles before the
  // promotions snapshot exists and an active promotion silently does not
  // apply.
  const warmupMs = resolveGateWarmupMs(opts);
  await Promise.all([
    awaitMeasuredFailureReady(ir.appId, warmupMs),
    awaitPromotionsReady(ir.appId, warmupMs),
  ]);

  // alpha.124 — no pinned model and no candidate that declares the required
  // input modality: fail HERE, before any request leaves the process, with a
  // CallError whose code names the modality (never a provider 400 after
  // billing). With a pin, compile() serves it untouched and we never get here.
  let initial: CompileResult;
  try {
    initial = compileAndRegister(ir, opts);
  } catch (err) {
    if (err instanceof InputModalityError) {
      throw new CallError(
        `call(): ${err.message.replace(/^compile\(\): /, '')}`,
        err.dropped.map((d) => ({
          model: d.model,
          status: 'terminal' as const,
          errorCode: err.code,
          message: `Skipped before the wire — ${d.model}: ${d.why} (requires ${err.required.join(', ')})`,
        })),
        undefined,
        err.code,
      );
    }
    throw err;
  }

  safeEmit(() =>
    emitCompileDone(traceId, ir.appId, {
      target: initial.target,
      provider: initial.provider,
      fallbackChain: initial.fallbackChain,
      tokensIn: initial.tokensIn,
      estimatedCostUsd: initial.estimatedCostUsd,
      mutationsApplied: initial.mutationsApplied,
      advisories: initial.advisories,
    }),
  );
  for (const adv of initial.advisories) {
    safeEmit(() =>
      emitAdvisoryFired(traceId, ir.appId, { code: adv.code, message: adv.message }),
    );
  }

  const start = Date.now();

  const attempts: CallAttempt[] = [];
  const rawTargets: string[] = [initial.target, ...initial.fallbackChain];

  // alpha.10: auto-filter unreachable models. Default ON; opt-out via
  // `noAutoFilter`. Resolves PB's first-deploy 401 on the alpha.9 summarize
  // chain (consumer didn't have DEEPSEEK_API_KEY, chain included DeepSeek,
  // execute() returned auth-401, no recovery). Sacha's "kgauto should self-heal"
  // (2026-05-14): drop unreachable silently, surface only when chain empties.
  let unreachableFiltered: string[] | undefined;
  let targetsToTry: string[];
  if (opts.noAutoFilter) {
    targetsToTry = rawTargets;
  } else {
    const dropped: string[] = [];
    targetsToTry = [];
    for (const t of rawTargets) {
      if (isModelReachable(t, { apiKeys: opts.apiKeys })) {
        targetsToTry.push(t);
      } else {
        dropped.push(t);
      }
    }
    unreachableFiltered = dropped;

    if (targetsToTry.length === 0) {
      // Service-impaired boundary: nothing reachable. Throw immediately
      // without firing any HTTP calls. Brain still records the failure.
      const latencyMs = Date.now() - start;
      await record({
        handle: initial.handle,
        source: opts.source,
        endUserId: opts.endUserId,
        route: opts.route,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs,
        success: false,
        errorType: 'no_reachable_models',
        promptPreview: extractPromptPreview(ir),
      });
      const noReachableAttempts: CallAttempt[] = dropped.map((m) => ({
        model: m,
        status: 'terminal',
        errorCode: 'unreachable_provider',
        message: `No API key for ${m}'s provider — set one of PROVIDER_ENV_KEYS or pass apiKeys`,
      }));
      throw new CallError(
        `call(): no reachable models in chain. Filtered: [${dropped.join(', ')}]. Add a key for one provider, or pass apiKeys.`,
        noReachableAttempts,
        undefined,
        'no_reachable_models',
      );
    }

    // alpha.15: cross-provider-tail invariant. PB's `archetype-chains-need-
    // cross-provider-tail` request (2026-05-15). When auto-filter reduces
    // the chain to a single provider AND the archetype has a reachable
    // cross-provider target available, append it. Prevents alpha.14's
    // chain-walk-on-401 from exhausting against a mono-provider chain —
    // the auth-walk needs somewhere different to walk TO.
    const archetypeName = ir.intent?.archetype;
    if (archetypeName) {
      const ensured = ensureCrossProviderTail({
        chain: targetsToTry,
        archetype: archetypeName as IntentArchetypeName,
        apiKeys: opts.apiKeys,
        // alpha.124 — the appended model must declare the call's required
        // input modality, or nothing is appended (compile never saw it).
        inputModalities: ir.constraints?.inputModalities,
      });
      if (ensured.appended) {
        targetsToTry = ensured.chain;
      }
    }
  }

  // alpha.16: policy.blockedModels defense-in-depth at the call() boundary.
  // compile() already excludes blocked models from the initial target +
  // fallbackChain (passScoreTargets sets fits=false on policy-blocked entries),
  // so a well-formed compile path can never put a blocked model in
  // targetsToTry. But consumers can re-shape the chain themselves — TT-40
  // is the canonical example: tt-intel's route drops forceModel and passes
  // a full models[] array, and if it logs `policy-blocked-X` mutation tags
  // for telemetry parity WITHOUT forwarding `policy.blockedModels` to
  // call(), the chain walker can land on the model the route intended to
  // block (brain row #624: model='claude-sonnet-4-6' served despite
  // mutations_applied=['policy-blocked-claude-sonnet-4-6']).
  //
  // Same self-heal pattern as alpha.10 auto-filter (env-absent reachability)
  // and alpha.14 chain-walk-on-401 (runtime auth failure): make the policy
  // contract robust at the call() boundary rather than trusting consumers
  // to thread it through every code path. Resolves TT-40 follow-on
  // `policy-block-not-enforced-on-fallback-chain` (2026-05-15).
  //
  // alpha.115 — `policy.blockedProviders` is enforced HERE too, same filter,
  // same telemetry field. This site matters more for a family block than for
  // a model block: `ensureCrossProviderTail` (above) appends a reachable
  // model from the archetype's default chain when auto-filter leaves one
  // provider, and that model is chosen without the policy — for `critique`
  // it is an Anthropic model whenever an Anthropic key is present.
  let policyBlockedFiltered: string[] | undefined;
  const hasModelBlock = (opts.policy?.blockedModels?.length ?? 0) > 0;
  const hasProviderBlock = (opts.policy?.blockedProviders?.length ?? 0) > 0;
  if (hasModelBlock || hasProviderBlock) {
    const blocked = canonicalPolicySet(opts.policy?.blockedModels);
    const blockedProviders = new Set<string>(opts.policy?.blockedProviders ?? []);
    const filtered: string[] = [];
    const dropped: string[] = [];
    for (const t of targetsToTry) {
      if (policySetHas(blocked, t) || isProviderBlocked(t, blockedProviders)) {
        dropped.push(t);
      } else {
        filtered.push(t);
      }
    }
    if (dropped.length > 0) {
      policyBlockedFiltered = dropped;
      targetsToTry = filtered;
    }

    if (targetsToTry.length === 0) {
      // Every target was policy-blocked. Same boundary shape as the
      // no-reachable case — service-impaired, throw without firing
      // any HTTP calls. Consumer misconfiguration (block-list ate
      // the whole chain) classifies as terminal.
      const latencyMs = Date.now() - start;
      await record({
        handle: initial.handle,
        source: opts.source,
        endUserId: opts.endUserId,
        route: opts.route,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs,
        success: false,
        errorType: 'all_blocked_by_policy',
        promptPreview: extractPromptPreview(ir),
      });
      const blockedAttempts: CallAttempt[] = dropped.map((m) => ({
        model: m,
        status: 'terminal',
        errorCode: 'blocked_by_policy',
        message: isProviderBlocked(m, blockedProviders)
          ? `Skipped — model ${m}'s provider is in CompilePolicy.blockedProviders`
          : `Skipped — model ${m} is in CompilePolicy.blockedModels`,
      }));
      throw new CallError(
        `call(): all chain targets blocked by CompilePolicy.${hasProviderBlock ? (hasModelBlock ? 'blockedModels/blockedProviders' : 'blockedProviders') : 'blockedModels'}: [${dropped.join(', ')}]`,
        blockedAttempts,
        undefined,
        'all_blocked_by_policy',
      );
    }
  }

  let activeCompile: CompileResult = initial;
  let lastErr: Extract<ExecuteResult, { ok: false }> | undefined;

  // alpha.14: sticky 401-marker for the auth-walk pattern. When a provider
  // returns 401/403 (upstream revocation, malformed-but-truthy key, billing
  // lapse), mark it as session-unreachable and continue the chain walk to
  // the next non-same-provider target. Skips remaining same-provider entries
  // with `errorCode: 'auth_inferred'` (same key → same fate).
  //
  // Distinct from alpha.10 auto-filter (env-absent) and alpha.13 trim-on-read
  // (paste-artifact): both of those classify "this provider isn't reachable
  // BEFORE the network call." Auth-walk handles "reachability looked fine,
  // provider 401s at runtime." See `interfaces/kgauto.md ## Requested >
  // chain-walk-on-401-or-pre-flight-key-validity` for the framing.
  //
  // Per-call scope: failedProviders is local to this call() invocation.
  // No global state, no brain write. Brain telemetry captures the auth
  // failures via attempts[] and `actualModel` truth-in-logging.
  // alpha.77 — the marker carries WHY the provider failed ('auth' |
  // 'billing_exhausted') so skipped siblings get an honest label instead of
  // every skip reading as auth (a label's disposition matters: auth = fix
  // the key, billing = fund the account — the IC mislabel lesson).
  const failedProviders = new Map<string, 'auth' | 'billing_exhausted'>();

  // alpha.66 — one-shot same-model retry on structured-output contract
  // violations. Consent posture mirrors KGAUTO_AUTO_PROMOTE: explicit
  // `sameModelRetry: false` beats the env; undefined falls through to
  // KGAUTO_SAME_MODEL_RETRY. One retry budget for the whole call().
  const sameModelRetryEnabled =
    opts.sameModelRetry ?? isSameModelRetryEnabledFromEnv();
  let retriedSameModel = false;

  // alpha.132 (R3c) — the one bounded recovery for a thinking block's prefix
  // check: a `thinking_prefix_mismatch` 400 re-sends the SAME target once with
  // every thinking block stripped from the history, then the walk goes on as for
  // any other failure. One per call(); `thinkingPrefixRetry` says it happened.
  let thinkingPrefixRetry: { model: string; stripped: number } | undefined;

  // alpha.84 — one choke point for attempt recording, so the consumer hook
  // cannot miss a site. There are six `pushAttempt` calls and a seventh added
  // later would get the hook for free; a raw `attempts.push` would not, which
  // is exactly how a notification channel silently goes partial.
  const pushAttempt = (attempt: CallAttempt): void => {
    attempts.push(attempt);
    if (attempt.status === 'success') return;
    // Swallow: a consumer's telemetry bug must never take down the call it is
    // observing. Notification, never veto.
    try { opts.onFailedAttempt?.(attempt); } catch { /* observer, not participant */ }
  };

  for (let i = 0; i < targetsToTry.length; i++) {
    const targetModel = targetsToTry[i]!;

    // alpha.78 — the caller cancelled: stop the whole walk. Starting another
    // wire attempt now spends money on an answer nobody is waiting for.
    if (opts.abortSignal?.aborted) {
      pushAttempt({
        model: targetModel,
        status: 'terminal',
        errorCode: 'aborted',
        message: 'Skipped — caller abortSignal fired before this attempt started',
      });
      break;
    }

    // alpha.14: skip if target's provider failed account-wide earlier in
    // this call. Same provider + same account → same outcome. Saves a wasted
    // round-trip per same-provider entry below the failed one — and for
    // billing (alpha.77, PB's incident) the sibling attempt is GUARANTEED to
    // fail for the identical reason on an account that may meter it: a
    // credit exhaustion is provider-wide, never model-specific.
    const targetProfile = tryGetProfile(targetModel);
    // KG-18 step 0 — start the key fingerprint NOW, in parallel with the provider round-trip,
    // so the await at record time is a resolved microtask and never a real-time hop inside
    // the call's critical path (fake-timer tests measure that path to the turn).
    const servedProviderEarly = targetProfile?.provider ?? inferProviderFromId(targetModel);
    // Synchronous on purpose: no real-time async hop inside the call path (see sha256HexSync).
    const servedKeyFingerprintEarly: string | undefined = servedProviderEarly
      ? keyFingerprintSync(resolveProviderKey(servedProviderEarly, { apiKeys: opts.apiKeys }) ?? '')
      : undefined;
    const providerFailReason = targetProfile
      ? failedProviders.get(targetProfile.provider)
      : undefined;
    if (targetProfile && providerFailReason && !opts.noFallback) {
      pushAttempt({
        model: targetModel,
        status: 'terminal',
        errorCode: `${providerFailReason}_inferred`,
        message:
          providerFailReason === 'billing_exhausted'
            ? `Skipped — provider ${targetProfile.provider} is out of credits (seen earlier in this call); a billing failure is account-wide, so this attempt cannot succeed until a human funds the account`
            : `Skipped — provider ${targetProfile.provider} returned 401/403 earlier in this call; same key inferred to fail`,
      });
      continue;
    }

    // Recompile when we're not on the initially-compiled target. Use the
    // model identity check rather than `i > 0` because alpha.10 auto-filter
    // can drop initial.target from targetsToTry — in which case targetsToTry[0]
    // is already a fallback model and needs recompile.
    // alpha.121 (item C) — thinking blocks are tied to the model that wrote
    // them. A fallover from a 5.5 model to one that cannot read its blocks runs
    // without them (Anthropic drops them at 200; another provider's lowering
    // would carry Anthropic-shaped blocks verbatim), so the leg strips them and
    // the result SAYS so. Producer = the compile target the conversation was
    // compiled for. alpha.125 — the producer → reader verdict is DATA
    // (`THINKING_BLOCK_MATRIX` in request-shapes.ts), now with Claude Haiku 5.5
    // on both sides: INTO haiku-5-5 from Opus 5 / Opus 5.5 / Sonnet 5.5 /
    // Fable / Mythos strips (the API would drop them silently); FROM haiku-5-5
    // into anything but Opus 5.5 / Sonnet 5.5 strips; Sonnet 5 / Opus 4.8 /
    // Haiku 4.5 → haiku-5-5 keeps them.
    let thinkingStripped = 0;
    if (targetModel !== initial.target) {
      let legHistory = ir.history;
      if (fallsOverWithoutThinking(initial.target, targetModel)) {
        const s = stripThinkingBlocks(ir.history);
        legHistory = s.messages;
        thinkingStripped = s.stripped;
      }
      // Re-compile for the fallback target. forceModel + including the model
      // in `ir.models` (so passScoreTargets sees it) is the entry point.
      try {
        activeCompile = compileAndRegister(
          {
            ...ir,
            ...(thinkingStripped > 0 ? { history: legHistory } : {}),
            models: ir.models.includes(targetModel) ? ir.models : [targetModel, ...ir.models],
            constraints: { ...(ir.constraints ?? {}), forceModel: targetModel },
          },
          opts,
        );
      } catch (err) {
        pushAttempt({
          model: targetModel,
          status: 'terminal',
          errorCode: 'compile_error',
          message: err instanceof Error ? err.message : String(err),
        });
        // If we can't even compile for this fallback, treat as terminal for
        // this target and continue walking the chain.
        continue;
      }
    }

    safeEmit(() =>
      emitExecuteAttempt(traceId, ir.appId, { model: targetModel, attemptIndex: i }),
    );

    // alpha.34: gate streaming on (a) consumer-supplied onChunk, (b) not
    // opted out via noStream, (c) chosen target supports streaming per
    // profile. When the chain walks to a non-streaming target, single-shot
    // resumes automatically — onChunk simply doesn't fire from that point.
    const targetSupportsStreaming = targetProfile?.streaming === true;
    const streamingOnChunk =
      opts.onChunk && !opts.noStream && targetSupportsStreaming
        ? opts.onChunk
        : undefined;

    // alpha.78 — each WIRE attempt gets a fresh time budget. Non-streaming:
    // total bound (AbortSignal.timeout). Streaming: the same knob becomes a
    // per-chunk stall bound inside the stream helpers, so only the caller's
    // signal rides through here.
    // alpha.121 — the consumer's override layer is gated per TARGET: a shape
    // this model documents as a 400 (thinking disabled/enabled, forced
    // tool_choice, sampling params, a prefilled messages array) is dropped
    // before execute and said on the result, never billed as a 400.
    const overrideGate = gateProviderOverrides(opts.providerOverrides, targetProfile);
    const mkExecOpts = () => ({
      apiKeys: opts.apiKeys,
      fetchImpl: opts.fetchImpl,
      providerOverrides: overrideGate.overrides,
      onChunk: streamingOnChunk,
      signal: composeAttemptSignal(
        streamingOnChunk ? undefined : opts.attemptTimeoutMs,
        opts.abortSignal,
      ),
      stallTimeoutMs: streamingOnChunk ? opts.attemptTimeoutMs : undefined,
    });
    const exec = await execute(activeCompile.request, mkExecOpts());

    // alpha.8: when exec succeeds, validate the structured-output contract
    // BEFORE returning success. A 200 response with finishReason=MAX_TOKENS
    // or unparseable JSON on a structured call is a contract violation —
    // route it through the fallback chain instead of returning success
    // with a sentinel null. PB-Cairn contract-gaps brief 2026-05-12.
    let validated = exec.ok ? validateStructuredContract(exec, ir) : exec;
    let servedByRetry = false;

    // alpha.132 (R3c) — the prefix-check 400. The provider says retrying the
    // same body fails the same way every time; removing the thinking blocks
    // clears it ("You can remove … all of them", preserved-thinking page). So
    // the same target is re-sent ONCE with every thinking / redacted_thinking
    // block stripped from the history, and the result says so (attempt row
    // `thinkingStrippedRetry`, advisory `thinking-prefix-mismatch-recovered`).
    // Blocks that did not come from `ir.history` (none to strip) → no retry;
    // the error is retryable, so the chain walks.
    let stripRetryTag: number | undefined;
    if (!validated.ok && validated.errorCode === 'thinking_prefix_mismatch' && thinkingPrefixRetry === undefined) {
      const s = stripThinkingBlocks(ir.history);
      if (s.stripped > 0) {
        pushAttempt({
          model: targetModel,
          status: validated.errorType,
          errorCode: validated.errorCode,
          message: validated.message,
          ...attemptClassOf(validated),
        });
        thinkingPrefixRetry = { model: targetModel, stripped: s.stripped };
        stripRetryTag = s.stripped;
        try {
          activeCompile = compileAndRegister(
            {
              ...ir,
              history: s.messages,
              models: ir.models.includes(targetModel) ? ir.models : [targetModel, ...ir.models],
              constraints: { ...(ir.constraints ?? {}), forceModel: targetModel },
            },
            opts,
          );
          safeEmit(() => emitExecuteAttempt(traceId, ir.appId, { model: targetModel, attemptIndex: i }));
          const stripExec = await execute(activeCompile.request, mkExecOpts());
          validated = stripExec.ok ? validateStructuredContract(stripExec, ir) : stripExec;
        } catch (err) {
          validated = {
            ok: false,
            status: 0,
            errorType: 'retryable',
            errorCode: 'compile_error',
            message: err instanceof Error ? err.message : String(err),
            raw: null,
          };
        }
      }
    }
    /** The next attempt row of this leg carries the strip count, once. */
    const takeStripTag = (): { thinkingStrippedRetry?: number } => {
      if (stripRetryTag === undefined) return {};
      const n = stripRetryTag;
      stripRetryTag = undefined;
      return { thinkingStrippedRetry: n };
    };

    // alpha.66 — the same-model retry. Fires at most once per call(), on
    // whichever target hits the contract violation first, BEFORE the chain
    // walks to a lower-ranked tier (PB filing 2026-07-18: on surfaces where
    // the walk destination is measured quality-inferior, one more attempt
    // at the leader beats walking). Truncation-class retries raise any
    // explicit wire output cap below the profile ceiling; parse-fail
    // retries re-roll unchanged (sampling nondeterminism is the lever).
    // Applies under noFallback too — this is a same-model retry, not a
    // fallback.
    // alpha.78 (PB Finding 1, 2026-07-25) — when the target already carries
    // an ACTIVE measured-failure gate for this archetype, a same-model retry
    // is near-certainly a second billed failure: the gate exists because this
    // model fails the majority of the time here. Suppress the retry and let
    // the chain walk immediately. Self-healing: when the model recovers, the
    // failure window drains, the gate lifts, and retry resumes — no state.
    //
    // alpha.98 — QUALITY AXIS ONLY. The retry being suppressed here is a
    // retry after a structured-contract violation, and only the quality axis
    // is evidence about that. An availability gate says the model could not
    // be REACHED (429 / auth / transport) — it says nothing about whether
    // this model's answers parse, and a call that returned a contract
    // violation demonstrably reached it. Suppressing on availability
    // evidence would remove a retry that a raw caller would have made, on
    // evidence about a different question: the never-worse-than-raw rule
    // applied to a decision that looked like it was already justified.
    let retrySuppressionNote: string | undefined;
    if (
      !validated.ok &&
      isStructuredContractViolation(validated.errorCode) &&
      sameModelRetryEnabled &&
      !retriedSameModel &&
      getMeasuredFailureVerdict({
        appId: ir.appId,
        archetype: ir.intent.archetype,
        model: targetModel,
      })?.quality.gated === true
    ) {
      retrySuppressionNote =
        ' [sameModelRetry suppressed: this model carries an active measured-failure gate (quality axis) for this archetype — retrying it would near-certainly bill a second doomed inference; walking the chain instead]';
    }

    if (
      !validated.ok &&
      isStructuredContractViolation(validated.errorCode) &&
      sameModelRetryEnabled &&
      !retriedSameModel &&
      !retrySuppressionNote
    ) {
      retriedSameModel = true;
      // The triggering violation gets its own attempt row; the retry's
      // outcome lands as a second row flagged sameModelRetry below.
      pushAttempt({
        model: targetModel,
        status: validated.errorType,
        errorCode: validated.errorCode,
        message: validated.message,
              ...attemptClassOf(validated),
        ...takeStripTag(),
      });
      const retryRequest =
        validated.errorCode === 'max_tokens_on_structured_output'
          ? raiseOutputBudget(activeCompile.request, targetProfile)
          : activeCompile.request;
      safeEmit(() =>
        emitExecuteAttempt(traceId, ir.appId, { model: targetModel, attemptIndex: i }),
      );
      const retryExec = await execute(retryRequest, mkExecOpts());
      validated = retryExec.ok ? validateStructuredContract(retryExec, ir) : retryExec;
      servedByRetry = true;
    }

    if (validated.ok) {
      pushAttempt({
        model: targetModel,
        status: 'success',
        ...(servedByRetry ? { sameModelRetry: true } : {}),
        ...takeStripTag(),
      });
      const latencyMs = Date.now() - start;

      safeEmit(() =>
        emitExecuteSuccess(traceId, ir.appId, {
          model: targetModel,
          tokensIn: validated.response.tokens.input,
          tokensOut: validated.response.tokens.output,
          latencyMs,
        }),
      );

      // Use the INITIAL handle so the brain's truth-in-logging works:
      // model = actual (what served), requested_model = initial.target
      // (what kgauto first chose). The brain's buildPayload compares
      // input.actualModel to the registry-stored target — using the fallback
      // compile's handle would collapse the distinction.
      //
      // alpha.4: when fallback fires, override mutations_applied with the
      // SERVED compile's mutations (activeCompile, not initial) so the brain
      // doesn't misattribute fallback traffic to the initial compile's rules.
      //
      // alpha.4: await record() instead of `void` — when BrainConfig.sync is
      // true, this gives the network call the latency it needs to land
      // (PB-02 short-lived-runtime fix). When sync is false, record() returns
      // immediately after queueing, so latency cost is one microtask.
      const fellOver = targetModel !== initial.target;
      const fallbackReason = fellOver ? normalizeFallbackReason(attempts) : undefined;
      // alpha.71 — keep the PRECISE code alongside the normalized reason.
      // Same attempt `normalizeFallbackReason` picks, before it collapses
      // two opposite-remedy failures into 'cliff'. See CallResult.fellOverErrorCode.
      const fellOverErrorCode = fellOver ? firstFailureErrorCode(attempts) : undefined;
      // KG-18 step 1 — the class + quota id of the failure that caused the fall-over.
      const fellOverClass = fellOver ? firstFailureClass(attempts) : undefined;
      const fellOverQuotaId = fellOver ? firstFailureQuotaId(attempts) : undefined;
      // KG-18 step 0 — the fingerprint of the key this call was SERVED with (never the key):
      // the same domain-separated hash `createKeyHealthRoute` reports per provider, so the
      // wall can say "expected key vs key in use" from the rows alone. Undefined when the
      // provider is unknown or WebCrypto is absent — never a guess.
      const servedKeyFingerprint = servedKeyFingerprintEarly;

      // alpha.133 (R4) — a fallback is described as one. The fallback leg's
      // compile is forced onto `targetModel`, so its `scorer-took-<target>-over-
      // <first>` mutation ("Ranking picked …") described a failure as a ranking
      // choice; on a fallover it is replaced by one that says which model failed
      // and why. The brain's fallback row carries the same list.
      const servedMutations = fellOver
        ? fallbackLegMutations(activeCompile.mutationsApplied, {
            from: initial.target,
            to: targetModel,
            attempts,
            unreachableFiltered,
            policyBlockedFiltered,
          })
        : activeCompile.mutationsApplied;

      // alpha.62 (eval spine) — golden-capture decision. The rate resolves
      // from CallOptions.goldenCapture.sampleRate, falling back to the
      // KGAUTO_GOLDEN_CAPTURE env var (both default-off). Shape key must be
      // peeked NOW: record() below pops the registry entry single-use.
      const goldenRate = resolveGoldenCaptureRate(opts.goldenCapture?.sampleRate);
      const goldenShapeKey =
        goldenRate > 0 ? peekRegisteredShapeKey(initial.handle) : undefined;

      await record({
        handle: initial.handle,
        source: opts.source,
        endUserId: opts.endUserId,
        // alpha.92 — route identity on the row (registry also carries it;
        // input wins in buildPayload, so state it explicitly here with the
        // host the gateway reported for the WINNING attempt).
        route: opts.route,
        routeHost: validated.response.routeHost,
        // alpha.105 (migration 074) — what the provider said it served.
        servedModel: validated.response.servedModel,
        tokensIn: validated.response.tokens.input,
        tokensOut: validated.response.tokens.output,
        latencyMs,
        success: true,
        emptyResponse: validated.response.tokens.output === 0,
        toolsCalled: validated.response.toolCalls.map((tc) => tc.name),
        actualModel:
          targetModel !== initial.target ? targetModel : undefined,
        mutationsApplied:
          targetModel !== initial.target
            ? servedMutations.map((m) => m.id)
            : undefined,
        promptPreview: extractPromptPreview(ir),
        responsePreview: validated.response.text.slice(0, 200),
        cacheReadInputTokens: validated.response.tokens.cached,
        cacheCreationInputTokens: validated.response.tokens.cacheCreated,
        // alpha.28 — Glass-Box renderer substrate (migration 018). call()
        // owns the lifecycle so it has direct visibility into finishReason
        // (from the normalized provider response), totalMs (mirrors latencyMs
        // for non-streaming; future streaming variant may diverge), and the
        // fell-over-from / fallback-reason pair (already computed above for
        // the CallResult return shape).
        finishReason: validated.response.finishReason,
        totalMs: latencyMs,
        // alpha.129 — the streaming path's first-token clock (R1). Undefined on a
        // single-shot attempt, so the key is absent from the row.
        ttftMs: validated.response.ttftMs,
        fellOverFrom: fellOver ? initial.target : undefined,
        fallbackReason,
        fellOverClass,
        fellOverQuotaId,
        keyFingerprint: servedKeyFingerprint,
        // alpha.71 — migration 044. Omitted when no fallback fired, so
        // pre-044 brains never see the key.
        fellOverErrorCode,
        // alpha.66 — migration 039. Omitted (not false) when no retry fired
        // so pre-039 brains never see the key.
        retriedSameModel: retriedSameModel || undefined,
      });

      if (fellOver) {
        // Emit ONE fallback.walked covering the from→to jump.
        // attempts[0] is the first (failing) attempt; use it as the cause.
        const firstFailed = attempts.find((a) => a.status !== 'success');
        if (firstFailed) {
          safeEmit(() =>
            emitFallbackWalked(traceId, ir.appId, {
              from: initial.target,
              to: targetModel,
              reason: fallbackReason ?? 'unknown',
              attempt: firstFailed,
            }),
          );
        }
      }

      // s51 Phase 1 — full-IR inline shadow-probe. Fire-and-forget AFTER the
      // primary response is ready: it must never add latency to or fail the
      // user's call(). Honors BrainConfig.sync (await) for Edge/Worker/Lambda
      // runtimes that tear down before a fire-and-forget microtask lands (L-086).
      if (opts.shadowProbe) {
        const probe = runShadowProbe({
          ir,
          opts,
          servedModel: targetModel,
          servedResponse: validated.response,
          servedLatencyMs: latencyMs,
        });
        if (isBrainSync()) {
          await probe;
        } else {
          void probe;
        }
      }

      // alpha.62 (eval spine) — golden-set capture. Only successful, non-empty
      // responses make useful reference outputs; empty/failed calls never
      // capture. Fire-and-forget (recordGoldenIr owns the G1 write-leg
      // discipline); honors BrainConfig.sync like the probe above.
      if (
        goldenRate > 0 &&
        validated.response.tokens.output > 0 &&
        shouldCaptureGolden(goldenRate)
      ) {
        const consent =
          opts.goldenCapture?.sampleRate !== undefined
            ? `CallOptions.goldenCapture.sampleRate=${goldenRate} (consumer code opt-in)` +
              (opts.goldenCapture.consentNote ? ` — ${opts.goldenCapture.consentNote}` : '')
            : `KGAUTO_GOLDEN_CAPTURE=${goldenRate} (consumer env opt-in)`;
        const capture = captureGoldenIr({
          ir,
          servedModel: targetModel,
          response: validated.response,
          latencyMs,
          handle: initial.handle,
          shapeKey: goldenShapeKey,
          consent,
        });
        if (isBrainSync()) {
          await capture;
        } else {
          void capture;
        }
      }

      // alpha.118 §C — the provider that SERVED, resolved from the served
      // model's profile (registry provider when the model is not bundled).
      const servedProvider = tryGetProfile(targetModel)?.provider ?? activeCompile.provider;
      // alpha.118 §A — the served model is SAID, not only set.
      const differs = servedModelDiffers(targetModel, validated.response.servedModel);

      // alpha.133 (R3) — a setting dropped because the model rejects it is a
      // change to the request: listed in `mutationsApplied` with an id of its
      // own, beside the `request-shape-rejected-by-model` advisory that quotes
      // the provider. Two sources: the consumer's providerOverrides (gated per
      // target above) and kgauto's own lowering (a trailing assistant turn).
      const shapeDrops: RejectedShapeDrop[] = [
        ...loweringShapeDrops(activeCompile),
        ...overrideGate.dropped,
      ];
      // alpha.134 (R8) — compile() now lists its own lowering drop under the same id, so
      // an id already on the served compile is not added twice.
      const mutationsApplied: MutationApplied[] = shapeDrops.length > 0
        ? [
            ...servedMutations,
            ...shapeDropMutations(targetModel, shapeDrops).filter((m) => !servedMutations.some((s) => s.id === m.id)),
          ]
        : servedMutations;

      // alpha.133 (R4) — no advisory on this result recommends moving to a
      // model that failed on this call.
      const failedOnThisCall = modelsFailedOnThisCall(attempts, targetModel);
      const compileAdvisories = failedOnThisCall.length > 0
        ? activeCompile.advisories.filter((a) => !failedOnThisCall.some((m) => recommendsModel(a, m)))
        : activeCompile.advisories;

      // alpha.44: surface the served compile's advisories so call()
      // consumers (agent paths) can logAdvisories() like compile()
      // consumers (chat/intake) do. activeCompile, not initial — parity
      // with mutationsApplied above on fallback. Closes IC's side-finding.
      const advisories = ((): BestPracticeAdvisory[] => {
        const extra: BestPracticeAdvisory[] = [
          ...(overrideGate.dropped.length > 0
            ? [rejectedShapeAdvisory(targetModel, overrideGate.dropped, initial.handle)]
            : []),
          ...(thinkingStripped > 0
            ? [thinkingDroppedAdvisory(initial.target, targetModel, thinkingStripped, initial.handle)]
            : []),
          ...(differs === true
            ? [
                servedModelDiffersAdvisory({
                  requested: targetModel,
                  served: validated.response.servedModel!,
                  provider: servedProvider,
                  route: opts.route ?? 'direct',
                  handle: initial.handle,
                }),
              ]
            : []),
          // alpha.132 (R3b) — the blocks the API dropped, said: a prefix
          // change as `warn` with the passes that changed this compile; a
          // model or account binding as `info`.
          ...inputTransformationAdvisories(
            targetModel,
            validated.response.inputTransformations,
            activeCompile.mutationsApplied,
            initial.handle,
          ),
          // alpha.132 (R3c) — the prefix-check 400 and its one recovery, said.
          ...(thinkingPrefixRetry
            ? [thinkingPrefixRecoveredAdvisory(thinkingPrefixRetry.model, thinkingPrefixRetry.stripped, targetModel, initial.handle)]
            : []),
        ];
        return extra.length > 0 ? [...compileAdvisories, ...extra] : compileAdvisories;
      })();

      const summary = buildCallSummary({
        servedBy: targetModel,
        initialTarget: initial.target,
        callerFirst: ir.models[0],
        ir,
        mutations: mutationsApplied,
        attempts,
        fellOver,
        unreachableFiltered,
        policyBlockedFiltered,
        compile: activeCompile,
        shapeDrops,
        thinkingStripped,
        thinkingPrefixRetry,
      });

      return {
        handle: initial.handle,
        actualModel: targetModel,
        requestedModel: initial.target,
        provider: servedProvider,
        response: validated.response,
        latencyMs,
        // alpha.92 — route identity + the served profile's cliffs flagged
        // route-unverified on a non-direct route (guards still fired; their
        // evidence is vendor-route evidence — see the execute-leg contract).
        route: opts.route ?? 'direct',
        routeHost: validated.response.routeHost,
        routeUnverifiedCliffs:
          opts.route === 'openrouter'
            ? (tryGetProfile(targetModel)?.cliffs ?? []).map((c) => c.metric)
            : undefined,
        // alpha.105 — the response-model diff the 2026-07-07 gateway stance
        // named as the integration-point check, finally read. `servedBy` is
        // the id kgauto asked for; `servedModel` is the provider's own word.
        servedModel: validated.response.servedModel,
        servedModelDiffers: differs,
        savings: activeCompile.diagnostics.savings,
        mutationsApplied,
        attempts,
        servedBy: targetModel,
        fellOverFrom: fellOver ? initial.target : undefined,
        fallbackReason,
        fellOverErrorCode,
        // KG-18 (alpha.111) — the class behind the fall-over and the key the call was served with.
        ...(fellOverClass ? { fellOverClass } : {}),
        ...(fellOverQuotaId ? { fellOverQuotaId } : {}),
        ...(servedKeyFingerprint ? { keyFingerprint: servedKeyFingerprint } : {}),
        retriedSameModel: retriedSameModel || undefined,
        unreachableFiltered,
        policyBlockedFiltered,
        traceId,
        advisories,
        summary,
      };
    }

    pushAttempt({
      model: targetModel,
      status: validated.errorType,
      errorCode: validated.errorCode,
      message: retrySuppressionNote
        ? validated.message + retrySuppressionNote
        : validated.message,
      ...(servedByRetry ? { sameModelRetry: true } : {}),
      ...attemptClassOf(validated),
      ...takeStripTag(),
    });
    lastErr = validated;

    if (validated.errorType === 'terminal' || opts.noFallback) {
      // alpha.14: auth-401/403 is terminal for THIS MODEL but not for the
      // call — the chain may have a non-same-provider target that the
      // operator wants reached. Mark provider failed + continue walking.
      // Other terminals (400 invalid_request, compile_error) still
      // short-circuit because they signal a request-level problem that
      // walking the chain won't fix.
      // alpha.77 extends the walk to billing exhaustion: like a dead key,
      // it is terminal for the PROVIDER but not for the call — the request
      // would succeed verbatim on any funded provider in the chain (PB's
      // incident: sonnet billing-400ed while google served the same deploy
      // minutes apart, and the user saw the error).
      if (
        (validated.errorCode === 'auth' ||
          validated.errorCode === 'billing_exhausted') &&
        !opts.noFallback &&
        activeCompile.provider
      ) {
        failedProviders.set(
          activeCompile.provider,
          validated.errorCode === 'billing_exhausted' ? 'billing_exhausted' : 'auth',
        );
        continue;
      }
      break;
    }
  }

  // All fallbacks exhausted (or terminal). Record failure against the
  // initial handle for brain-side coherence with the success path.
  // alpha.4: await for sync-mode reliability + populate promptPreview.
  //
  // alpha.66 truth-in-logging on failure rows (PB 2026-05-18 `chain-walk-on-
  // structured-output-parse-failed` asks 3+4): without actualModel the brain
  // stamped `model` = the COMPILE TARGET — which auto-filter may never have
  // attempted (PB's rows showed model=deepseek-v4-flash with no DeepSeek key
  // in env). Stamp the last model that actually went on the wire instead
  // (skip auth_inferred / compile_error rows — those never hit the network);
  // buildPayload then stores the compile target as requested_model when they
  // differ, mirroring the success path. And when the last error is a
  // synthesized contract violation, the provider DID serve the call — carry
  // its real usage instead of 0/0.
  const lastAttempted = [...attempts]
    .reverse()
    .find(
      (a) =>
        a.status !== 'success' &&
        a.errorCode !== 'auth_inferred' &&
        a.errorCode !== 'billing_exhausted_inferred' &&
        a.errorCode !== 'compile_error',
    );
  const latencyMs = Date.now() - start;
  // alpha.100 — an exhausted chain must record that it WALKED.
  //
  // The success path has always stamped fellOverFrom/fallbackReason/
  // fellOverErrorCode; this path never did. The consequence is a blind spot in
  // our own ledger, not just a missing column: a four-model walk that failed
  // is byte-identical in the brain to a single call that failed on its only
  // attempt. Measured 2026-08-30 — across the full history, ZERO rows with
  // success=false carry `fell_over_from`, which reads as "chains never
  // exhaust" and actually means "exhausted chains don't say so."
  //
  // It matters most for the thing kgauto claims: the 119 measured rescues are
  // the successful walks, so the rescue rate is a floor whose denominator —
  // how often the chain walks and STILL fails — is unmeasurable until this
  // row carries the evidence. Same family as [L-073]: the field exists, one
  // writer fills it, the other silently doesn't.
  //
  // `fellOver` here means the chain tried more than one distinct model, which
  // is the honest definition on a path where nothing succeeded (the success
  // path's `targetModel !== initial.target` has no counterpart when there is
  // no winner).
  const modelsAttempted = [...new Set(attempts.map((a) => a.model))];
  const chainWalked = modelsAttempted.length > 1;
  await record({
    handle: initial.handle,
    source: opts.source,
    endUserId: opts.endUserId,
    route: opts.route,
    tokensIn: lastErr?.tokens?.input ?? 0,
    tokensOut: lastErr?.tokens?.output ?? 0,
    latencyMs,
    success: false,
    errorType: lastErr?.errorCode,
    promptPreview: extractPromptPreview(ir),
    actualModel: lastAttempted?.model,
    retriedSameModel: retriedSameModel || undefined,
    fellOverFrom: chainWalked ? initial.target : undefined,
    fallbackReason: chainWalked ? normalizeFallbackReason(attempts) : undefined,
    fellOverErrorCode: chainWalked ? firstFailureErrorCode(attempts) : undefined,
  });

  const filteredNote =
    unreachableFiltered && unreachableFiltered.length > 0
      ? ` (also auto-filtered: [${unreachableFiltered.join(', ')}] — no API key)`
      : '';
  const blockedNote =
    policyBlockedFiltered && policyBlockedFiltered.length > 0
      ? ` (also policy-blocked: [${policyBlockedFiltered.join(', ')}])`
      : '';
  throw new CallError(
    `call(): all attempts failed${lastErr ? ` — ${lastErr.errorCode}: ${lastErr.message}` : ''}${filteredNote}${blockedNote}`,
    attempts,
    lastErr?.status,
    lastErr?.errorCode,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * alpha.78 — compose the per-attempt timeout with the caller's signal.
 * Uses `AbortSignal.any` where available (Node 20.3+/modern runtimes) with a
 * manual-controller fallback so older isolates degrade to identical
 * behavior rather than losing one of the two signals.
 */
function composeAttemptSignal(
  attemptTimeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (typeof attemptTimeoutMs === 'number' && attemptTimeoutMs > 0) {
    signals.push(AbortSignal.timeout(attemptTimeoutMs));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

/**
 * Compile + register handle in one step. Mirrors what index.ts's public
 * compile() does, so call() can stay self-contained without importing from
 * index.ts (which would create a circular dep).
 */
function compileAndRegister(ir: PromptIR, opts: CallOptions): CompileResult {
  const result = compileImpl(ir, {
    policy: opts.policy,
    toolRelevanceThreshold: opts.toolRelevanceThreshold,
    compressHistoryAfter: opts.compressHistoryAfter,
    // alpha.132 (R4) — the fold's window, beside its threshold.
    compressHistoryKeepRecent: opts.compressHistoryKeepRecent,
    // alpha.68 / Release A — carry the fan-out parent handle through to compile.
    parentHandle: opts.parentHandle,
    // alpha.92 — gateway route (execute-leg contract): changes the wire +
    // learning-key encoding, never the pass pipeline.
    route: opts.route,
  });
  // alpha.68 / Release A — register the linkage so record() auto-enriches
  // fanout_role / trace_id / parent_handle onto the outcome row.
  registerCompile(ir.appId, ir.intent.archetype, ir, result, opts.parentHandle, opts.route);
  return result;
}

/**
 * Build a 200-char prompt preview for brain telemetry. Prefers the user's
 * current turn (the most informative for debugging); falls back to the last
 * history message if no current turn was provided. Empty string when neither
 * exists — brain treats empty same as undefined.
 *
 * alpha.4: closes the call() gap where promptPreview was always undefined.
 */
function extractPromptPreview(ir: PromptIR): string | undefined {
  const turn = ir.currentTurn?.content;
  if (turn) return turn.slice(0, 200);
  const lastHist = ir.history?.[ir.history.length - 1]?.content;
  if (lastHist) return lastHist.slice(0, 200);
  return undefined;
}

/**
 * s51 Phase 1 — sampling gate for the inline shadow-probe. Pure + injectable
 * RNG for tests. `sampleRate <= 0`/NaN → never; `>= 1` → always.
 */
export function shouldSampleProbe(sampleRate: number, rng: () => number = Math.random): boolean {
  if (!(sampleRate > 0)) return false;
  if (sampleRate >= 1) return true;
  return rng() < sampleRate;
}

/** s51 Phase 1 — normalize the candidates field to a deduped non-empty list. */
export function normalizeProbeCandidates(candidates: string | string[]): string[] {
  const arr = Array.isArray(candidates) ? candidates : [candidates];
  return [...new Set(arr.filter((c) => typeof c === 'string' && c.length > 0))];
}

/** Irreversible grouping hash for a probe (djb2-ish). NOT reversible to the prompt. */
function hashForProbe(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/**
 * s54 — compile + execute knobs shared by the call()-inline probe and the
 * standalone probeShadow() export. A structural subset of CallOptions, so a
 * full CallOptions value is assignable here directly.
 */
interface ProbeExecOpts {
  policy?: CompilePolicy;
  toolRelevanceThreshold?: number;
  compressHistoryAfter?: number;
  compressHistoryKeepRecent?: number;
  apiKeys?: ApiKeys;
  fetchImpl?: typeof fetch;
  providerOverrides?: ProviderOverrides;
}

/** Default probe latency budget (ms) when the consumer doesn't pin one. */
const DEFAULT_PROBE_MAX_LATENCY_MS = 15000;

/**
 * alpha — is this candidate a registry `latency_tier='slow'` model? Used by the
 * sync-mode `skipSlowTierInSync` guard. When the profile is unknown (no row,
 * brain not loaded), returns false — we never skip on missing data, we let the
 * budget race catch it (fail-open: an unknown model is treated as probe-able,
 * and the budget bounds the worst case).
 */
function isSlowTierCandidate(candidate: string): boolean {
  const profile = tryGetProfile(candidate);
  if (!profile) return false;
  return latencyTierOf(profile) === 'slow';
}

/**
 * s51/s54 — the full-IR shadow-probe candidate loop, shared by BOTH entry
 * points (call()-inline via {@link runShadowProbe}; AI-SDK consumers via
 * {@link probeShadow}). Runs each candidate on the SAME in-memory IR the
 * primary used, after the primary response is ready, and persists a
 * `probe_outcomes` row (replay_source='inline-full-ir', prompt_fidelity=1.0,
 * judge off). Phase 1 stores both responses for an offline batch judge; no
 * inline Opus judge yet.
 *
 * Every probe invariant lives HERE so both entry points inherit them identically
 * (Phase-0 contract G-list):
 *   G1 never blocks the user — callers fire-and-forget after the response is set.
 *      In SYNC mode (`args.sync`, set by the call()-inline path when
 *      `BrainConfig.sync` is true), `call()` *awaits* the probe, so the candidate
 *      latency would land on the user's critical path — `maxLatencyMs` bounds it
 *      (race + abort) and `skipSlowTierInSync` keeps known-slow candidates off the
 *      inline path entirely. Both are no-ops when `args.sync` is false (the probe
 *      runs to completion off the response).
 *   G3 never persists the raw prompt — only response previews + a hash (see
 *      buildShadowProbeRow). The IR is transient in-memory.
 *   G4 never shadow-probes the claude-opus family (Phase-2 Opus judge can't
 *      judge itself).
 *   G6 (revised alpha.53) a failed candidate call records an ERROR-DIAGNOSTIC
 *      row (`outcome='candidate_error'` + error_class + latency-at-death),
 *      never a quality row. The original "no row" rule made candidate deaths
 *      indistinguishable from "never armed" (IC demo-night, 2026-07-02: v4-pro
 *      probe deaths cost ~90 min of blind debugging). The false-signal concern
 *      the original G6 protected is covered by the rollup filter: a verdict
 *      rollup MUST read only `outcome='completed'` rows (029 rule).
 *   alpha.46 captures candidate latency (irrecoverable if not measured here).
 *   alpha (029) sync-mode latency abort / slow-tier skip record a DIAGNOSTIC row
 *      (`outcome != 'completed'`, no candidate response, no verdict) so the
 *      offline rollup can see the event — a silent drop would be indistinguishable
 *      from "never armed."
 *   Absolute backstop: this function never throws into its caller.
 */
async function runProbeCandidates(args: {
  ir: PromptIR;
  cfg: ShadowProbeConfig;
  servedModel: string;
  servedResponse: NormalizedResponse;
  /** Wall-clock latency of the served call, ms (alpha.46) — recorded on the
   * probe row so a swap verdict can weigh speed, not just quality + cost. */
  servedLatencyMs: number;
  exec: ProbeExecOpts;
  /**
   * alpha — true when the probe is on the user-facing critical path (call()
   * inline + `BrainConfig.sync`). Gates `maxLatencyMs` + `skipSlowTierInSync`;
   * both are no-ops when false (fire-and-forget / `after()` consumers don't block
   * the user, so there's no latency to protect).
   */
  sync: boolean;
}): Promise<void> {
  try {
    if (!shouldSampleProbe(args.cfg.sampleRate ?? 0.05)) return;

    const candidates = normalizeProbeCandidates(args.cfg.candidates);
    const promptHash = hashForProbe(args.ir.currentTurn?.content ?? '');

    // alpha — sync-mode latency budget. The deadline bounds the WHOLE probe path
    // (all candidates collectively), because in sync mode call() does
    // `await runShadowProbe(...)` — the probe's total awaited time is what gates
    // the user response. Only armed in sync mode; non-sync (after()/Node
    // fire-and-forget) ignores the deadline and runs every candidate to completion.
    const budgetMs = args.cfg.maxLatencyMs ?? DEFAULT_PROBE_MAX_LATENCY_MS;
    const deadline = args.sync ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
    const skipSlow = args.sync && (args.cfg.skipSlowTierInSync ?? true);

    /** Diagnostic-row writer for aborted / skipped / errored candidates (029 +
     * 032). No candidate response, no verdict — purely an event marker for the
     * rollup. `errorClass` + `latencyCandidateMs` only on candidate_error rows
     * (error class from execute()'s taxonomy; latency = time-at-death). */
    const recordDiagnostic = async (
      candidate: string,
      outcome: 'aborted_latency_budget' | 'skipped_slow_tier_sync' | 'candidate_error',
      detail?: { errorClass?: string; latencyCandidateMs?: number },
    ): Promise<void> => {
      await recordShadowProbe({
        appId: args.ir.appId,
        archetype: args.ir.intent.archetype,
        family: deriveFamilyFromModelId(candidate) ?? 'unknown',
        candidateModel: candidate,
        currentModel: args.servedModel,
        promptHash,
        // Served leg only — the candidate never produced a comparable response.
        currentResponsePreview: args.servedResponse.text.slice(0, 2000),
        tokensCurrentIn: args.servedResponse.tokens.input,
        tokensCurrentOut: args.servedResponse.tokens.output,
        latencyCurrentMs: args.servedLatencyMs,
        outcome,
        ...(detail?.errorClass ? { errorClass: detail.errorClass } : {}),
        ...(detail?.latencyCandidateMs !== undefined
          ? { latencyCandidateMs: detail.latencyCandidateMs }
          : {}),
      });
    };

    for (const candidate of candidates) {
      // No signal in shadowing the model that just served.
      if (candidate === args.servedModel) continue;
      // G4 — forward-safe judge-self lock.
      if (deriveFamilyFromModelId(candidate) === 'claude-opus') continue;
      // Reachability — skip candidates whose provider has no key.
      if (!isModelReachable(candidate, { apiKeys: args.exec.apiKeys })) continue;

      // alpha — sync-mode slow-tier skip: a `latency_tier='slow'` candidate
      // can't fit a sane inline budget, so don't even start it. Record a
      // diagnostic skip row (not a silent drop) and move on. The deeper rule:
      // evaluate slow reasoners via the OFFLINE probe path, not the inline sync
      // probe (see ShadowProbeConfig.skipSlowTierInSync doc).
      if (skipSlow && isSlowTierCandidate(candidate)) {
        try {
          await recordDiagnostic(candidate, 'skipped_slow_tier_sync');
        } catch {
          // Diagnostic write is best-effort; never block the caller.
        }
        continue;
      }

      // alpha — already past the budget before starting this candidate (a prior
      // candidate ate the window). Abort the rest; the user must not wait longer.
      if (args.sync && Date.now() >= deadline) {
        try {
          await recordDiagnostic(candidate, 'aborted_latency_budget');
        } catch {
          // Best-effort.
        }
        break;
      }

      try {
        const candCompile = compileAndRegister(
          {
            ...args.ir,
            models: args.ir.models.includes(candidate)
              ? args.ir.models
              : [candidate, ...args.ir.models],
            constraints: { ...(args.ir.constraints ?? {}), forceModel: candidate },
          },
          args.exec,
        );
        const candStart = Date.now();

        // alpha — race the candidate execute against the remaining budget in sync
        // mode. If the budget wins, we ABANDON the in-flight execute (its eventual
        // resolution is dropped — no row written for it) and return control to the
        // user immediately. The provider request may finish in the background, but
        // the user is never delayed past the budget. Non-sync mode awaits the
        // execute directly with no timer.
        type RaceResult =
          | { kind: 'exec'; exec: ExecuteResult }
          | { kind: 'failed' }
          | { kind: 'timeout' };
        let timer: ReturnType<typeof setTimeout> | undefined;
        // .catch on the execute leg: execute() normally resolves an ExecuteErr
        // rather than rejecting, but (a) a future provider branch could throw,
        // and (b) if the budget wins the race this promise is ABANDONED (no
        // longer awaited) — a late rejection on it would surface as an
        // unhandledRejection. Map any rejection to a 'failed' sentinel so the
        // dangling leg can never escape the fire-and-forget contract AND a
        // genuine reject is treated as G6 (failed candidate records NO row),
        // NOT as a budget abort.
        const execPromise: Promise<RaceResult> = execute(candCompile.request, {
          apiKeys: args.exec.apiKeys,
          fetchImpl: args.exec.fetchImpl,
          // alpha.121 — a probed candidate gets the same per-model gate as a served target.
          providerOverrides: gateProviderOverrides(args.exec.providerOverrides, tryGetProfile(candidate)).overrides,
        })
          .then((exec) => ({ kind: 'exec' as const, exec }))
          .catch(() => ({ kind: 'failed' as const }));

        let raced: RaceResult;
        if (args.sync) {
          const remaining = Math.max(0, deadline - Date.now());
          const timeoutPromise = new Promise<RaceResult>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' as const }), remaining);
          });
          raced = await Promise.race([execPromise, timeoutPromise]);
          if (timer) clearTimeout(timer);
        } else {
          raced = await execPromise;
        }

        if (raced.kind === 'timeout') {
          // Budget exceeded mid-candidate — abandon it, record the abort, stop.
          try {
            await recordDiagnostic(candidate, 'aborted_latency_budget');
          } catch {
            // Best-effort.
          }
          break;
        }

        // G6 (revised alpha.53) — the execute leg rejected (rare; execute()
        // usually resolves an ExecuteErr). Record an error-diagnostic row so
        // the death is visible, then move to the next candidate.
        if (raced.kind === 'failed') {
          try {
            await recordDiagnostic(candidate, 'candidate_error', {
              errorClass: 'execute_rejected',
              latencyCandidateMs: Date.now() - candStart,
            });
          } catch {
            // Best-effort.
          }
          continue;
        }

        const exec = raced.exec;
        const candidateLatencyMs = Date.now() - candStart;
        // G6 (revised alpha.53) — a failed candidate call records an
        // error-diagnostic row (error class + latency-at-death), not silence.
        // "v4-pro dies on IC's runtime" is evidence about the candidate.
        if (!exec.ok) {
          try {
            await recordDiagnostic(candidate, 'candidate_error', {
              errorClass: exec.errorCode,
              latencyCandidateMs: candidateLatencyMs,
            });
          } catch {
            // Best-effort.
          }
          continue;
        }

        await recordShadowProbe({
          appId: args.ir.appId,
          archetype: args.ir.intent.archetype,
          family: deriveFamilyFromModelId(candidate) ?? candCompile.provider,
          candidateModel: candidate,
          currentModel: args.servedModel,
          promptHash,
          currentResponsePreview: args.servedResponse.text.slice(0, 2000),
          candidateResponsePreview: exec.response.text.slice(0, 2000),
          tokensCurrentIn: args.servedResponse.tokens.input,
          tokensCurrentOut: args.servedResponse.tokens.output,
          tokensCandidateIn: exec.response.tokens.input,
          tokensCandidateOut: exec.response.tokens.output,
          // alpha.46 — speed is the third swap-decision axis. Served latency
          // mirrors the user's actual wait; candidate latency is measured only
          // here and stored nowhere else (irrecoverable if not captured now).
          latencyCurrentMs: args.servedLatencyMs,
          latencyCandidateMs: candidateLatencyMs,
          outcome: 'completed',
        });
      } catch {
        // Per-candidate failure must not abort the others or surface to the caller.
      }
    }
  } catch {
    // Absolute backstop: the shadow-probe never throws into its caller.
  }
}

/**
 * s51 Phase 1 — call()-inline shadow-probe wrapper. Reads the probe config off
 * CallOptions and forwards the served result call() just computed into the
 * shared candidate loop. See {@link runProbeCandidates} for the invariants.
 */
async function runShadowProbe(args: {
  ir: PromptIR;
  opts: CallOptions;
  servedModel: string;
  servedResponse: NormalizedResponse;
  servedLatencyMs: number;
}): Promise<void> {
  const cfg = args.opts.shadowProbe;
  if (!cfg) return;
  await runProbeCandidates({
    ir: args.ir,
    cfg,
    servedModel: args.servedModel,
    servedResponse: args.servedResponse,
    servedLatencyMs: args.servedLatencyMs,
    // CallOptions is a structural superset of ProbeExecOpts.
    exec: args.opts,
    // alpha — the call()-inline path is on the user's critical path exactly when
    // BrainConfig.sync is set (call() awaits the probe before returning). That's
    // the only case where the latency budget + slow-tier skip must fire.
    sync: isBrainSync(),
  });
}

/** Served-side result the AI-SDK consumer already holds from streamText. */
export interface ProbeShadowServed {
  /** Model id that actually served the user (becomes `current_model` on the row). */
  model: string;
  /** The served response text (stored as a preview; never the prompt). */
  responseText: string;
  /** Served prompt tokens (AI SDK `usage.promptTokens`). */
  tokensIn: number;
  /** Served completion tokens (AI SDK `usage.completionTokens`). */
  tokensOut: number;
  /** The user's actual wait in ms (alpha.46 served-latency axis). */
  latencyMs: number;
}

/** Options for the standalone {@link probeShadow} export. */
export interface ProbeShadowOptions {
  /** The served leg the consumer supplies; kgauto runs the candidate leg. */
  served: ProbeShadowServed;
  /** Model id(s)/family alias(es) to shadow-test against the served model. */
  candidates: string | string[];
  /** Probability [0,1] a given call fires a probe. Default 0.05; pin 1 for dogfood. */
  sampleRate?: number;
  /** Phase 1 = 'off' (offline rollup). 'opus' inline judge is Phase 2. Default 'off'. */
  judge?: 'off' | 'opus';
  /** Override API keys (defaults: process.env). Gates candidate reachability. */
  apiKeys?: ApiKeys;
  /** Override fetch (for tests / custom transport). */
  fetchImpl?: typeof fetch;
  /** Provider-specific request fields shallow-merged into the candidate request. */
  providerOverrides?: ProviderOverrides;
  /** Forwarded to compile() for the candidate run (match the served-side compile). */
  policy?: CompilePolicy;
  toolRelevanceThreshold?: number;
  compressHistoryAfter?: number;
  compressHistoryKeepRecent?: number;
}

/**
 * s54 — standalone full-IR shadow probe for AI-SDK consumers (tt-intel hunt, IC
 * chat) that own their own streamText round-trip and never call call(). Fire it
 * from the streamText `onFinish` callback, wrapped in the platform's
 * `waitUntil()` / `after()`, so it runs after the response is flushed — no
 * blocking, no `sync:true`, no teardown race (cleaner than call()'s in-process
 * fire-and-forget for Edge runtimes; L-086).
 *
 * Runs the SAME candidate loop as the call()-inline probe ({@link
 * runProbeCandidates}): same gates (sample, self-skip, G4 judge-self,
 * reachability, G6), same fidelity=1.0 full-IR rows, same alpha.46 latency
 * capture. The consumer supplies the served leg it already has; kgauto runs the
 * candidate(s) and writes the `probe_outcomes` row.
 *
 * Requires `configureBrain()` to have been called (same as call()).
 * Fire-and-forget: never throws into the caller.
 *
 * @example
 * const result = streamText({ model, system, messages,
 *   onFinish: ({ text, usage }) => {
 *     after(() => probeShadow(ir, {
 *       served: { model: servedModelId, responseText: text,
 *                 tokensIn: usage.promptTokens, tokensOut: usage.completionTokens,
 *                 latencyMs: Date.now() - t0 },
 *       candidates: ['deepseek-v4-pro'], sampleRate: 0.05,
 *     }));
 *   },
 * });
 */
export async function probeShadow(ir: PromptIR, opts: ProbeShadowOptions): Promise<void> {
  try {
    const servedResponse: NormalizedResponse = {
      text: opts.served.responseText,
      structuredOutput: null,
      toolCalls: [],
      tokens: {
        input: opts.served.tokensIn,
        output: opts.served.tokensOut,
        total: opts.served.tokensIn + opts.served.tokensOut,
      },
      raw: null,
    };
    await runProbeCandidates({
      ir,
      cfg: {
        candidates: opts.candidates,
        sampleRate: opts.sampleRate,
        judge: opts.judge ?? 'off',
      },
      servedModel: opts.served.model,
      servedResponse,
      servedLatencyMs: opts.served.latencyMs,
      exec: {
        policy: opts.policy,
        toolRelevanceThreshold: opts.toolRelevanceThreshold,
        compressHistoryAfter: opts.compressHistoryAfter,
        compressHistoryKeepRecent: opts.compressHistoryKeepRecent,
        apiKeys: opts.apiKeys,
        fetchImpl: opts.fetchImpl,
        providerOverrides: opts.providerOverrides,
      },
      // alpha — probeShadow() is ALWAYS off the user-facing critical path: the
      // consumer fires it from `onFinish` wrapped in `after()`/`waitUntil()`,
      // after the response is flushed. So the sync-mode latency budget +
      // slow-tier skip are no-ops here — slow candidates run to completion (this
      // is in fact the right place to evaluate a slow reasoner). The
      // maxLatencyMs/skipSlowTierInSync knobs aren't even exposed on
      // ProbeShadowOptions for that reason.
      sync: false,
    });
  } catch {
    // probeShadow is fire-and-forget — never throw into the consumer's onFinish.
  }
}

/**
 * alpha.8: validate the structured-output contract on a successful exec, and
 * either populate response.structuredOutput (happy path) or synthesize a
 * retryable failure (contract violation) so call()'s fallback walker can try
 * the next model.
 *
 * Contract violations: (1) finishReason indicates truncation (MAX_TOKENS /
 * length / max_tokens) — output is cut mid-token, no valid JSON possible;
 * (2) JSON.parse fails on the text body.
 *
 * Non-structured calls and empty-text responses pass through unchanged.
 * Empty-text is signaled separately via brain's `empty_response` flag.
 *
 * Source: PB-Cairn contract-gaps brief 2026-05-12 (briefs/pb-kgauto-contract-gaps.md).
 */
function validateStructuredContract(
  exec: ExecuteOk,
  ir: PromptIR,
):
  | { ok: true; response: NormalizedResponse }
  | Extract<ExecuteResult, { ok: false }> {
  if (!ir.constraints?.structuredOutput) {
    return { ok: true, response: exec.response };
  }

  // Gap 2: truncated output is unusable for structured. Anthropic emits
  // `max_tokens`, Google emits `MAX_TOKENS`, OpenAI emits `length`. Compare
  // case-insensitively so we catch all three.
  const finish = (exec.response.finishReason ?? '').toLowerCase();
  if (finish === 'max_tokens' || finish === 'length') {
    return {
      ok: false,
      status: exec.status,
      errorType: 'retryable',
      errorCode: 'max_tokens_on_structured_output',
      message: `Provider returned finishReason="${exec.response.finishReason}" on a structured-output call — output truncated mid-token, JSON cannot be valid`,
      raw: exec.response.raw,
      // alpha.66 — the provider DID serve this call; carry the real usage so
      // exhausted-chain failure rows aren't stamped tokens_in=0 (PB 05-18 ask 4).
      tokens: { input: exec.response.tokens.input, output: exec.response.tokens.output },
    };
  }

  // Empty text: nothing to parse. Preserve existing behavior — structuredOutput
  // stays null; the empty signal is already captured by brain's emptyResponse.
  if (!exec.response.text) {
    return { ok: true, response: exec.response };
  }

  // Gap 1: parse, route to fallback on failure.
  //
  // alpha.72 — fence-tolerant. A bare `JSON.parse(text)` here meant that any
  // model returning ```json-fenced output failed the contract and walked the
  // chain, having already been billed. On Anthropic that was EVERY structured
  // call, because `lowerAnthropic` emitted no JSON instruction at all (also
  // fixed in alpha.72) — the mechanism behind haiku's 12-of-12 failures on
  // playbacksam/summarize. golden-eval's `parseJudgeVerdict` had handled
  // fences correctly since alpha.62; this path never did. Now both call the
  // same helper. See src/json-loose.ts.
  const parsedResult = parseJsonLoose(exec.response.text);
  if (parsedResult.ok) {
    return { ok: true, response: { ...exec.response, structuredOutput: parsedResult.value } };
  }
  {
    const err = new Error(parsedResult.error);
    return {
      ok: false,
      status: exec.status,
      errorType: 'retryable',
      errorCode: 'structured_output_parse_failed',
      message: err instanceof Error ? err.message : String(err),
      raw: exec.response.raw,
      tokens: { input: exec.response.tokens.input, output: exec.response.tokens.output },
    };
  }
}
/**
 * alpha.66 — the two structured-output contract-violation codes that qualify
 * for the one-shot same-model retry. Deliberately NOT every retryable error:
 * 429s/5xxs already have provider-level semantics (walking is right), and a
 * same-model retry on a rate limit would burn the quota window further.
 */
function isStructuredContractViolation(code: string | undefined): boolean {
  return (
    code === 'max_tokens_on_structured_output' ||
    code === 'structured_output_parse_failed'
  );
}

/**
 * alpha.66 — for a truncation-class retry, raise any EXPLICIT wire output
 * cap that sits below the profile's maxOutputTokens ceiling (e.g. a cliff
 * terse-clamp, or a historical compile that capped conservatively). Returns
 * the request unchanged when:
 *   - the profile is unknown (nothing to raise toward),
 *   - the variant carries no explicit cap (Google default / OpenAI-family —
 *     the provider ceiling already applies), or
 *   - the cap is already at/above the profile ceiling (nothing to gain;
 *     re-roll relies on sampling nondeterminism instead).
 *
 * Consumer sovereignty note: `providerOverrides` are shallow-merged at
 * execute() time AFTER this raise, so an explicit consumer cap still wins.
 */
function raiseOutputBudget(
  request: CompiledRequest,
  profile: { maxOutputTokens: number } | undefined,
): CompiledRequest {
  if (!profile) return request;
  if (request.provider === 'anthropic') {
    if (
      typeof request.max_tokens === 'number' &&
      request.max_tokens < profile.maxOutputTokens
    ) {
      return { ...request, max_tokens: profile.maxOutputTokens };
    }
    return request;
  }
  if (request.provider === 'google') {
    const gc = request.generationConfig;
    const cap = gc?.maxOutputTokens;
    if (typeof cap === 'number' && cap < profile.maxOutputTokens) {
      return {
        ...request,
        generationConfig: { ...gc, maxOutputTokens: profile.maxOutputTokens },
      };
    }
    return request;
  }
  // OpenAI-family variants (openai/deepseek/zai/moonshot): lowering never
  // emits an output cap — the provider default (model ceiling) applies.
  return request;
}

/**
 * Normalize `attempts[]` into a `CallResult.fallbackReason` for the alpha.9
 * surface. Walks attempts in order and returns the reason from the FIRST
 * non-success attempt — that's the cause that drove the chain. Returns
 * undefined if no non-success attempts found (shouldn't happen when
 * fallback fired, but keeps the type honest).
 *
 * Mapping:
 *   - errorCode === 'rate_limit_429'                 → 'rate_limit'
 *   - errorCode === 'max_tokens_on_structured_output' → 'cliff'
 *   - errorCode === 'structured_output_parse_failed'  → 'cliff'
 *   - errorCode === 'cost_cap_exceeded' (alpha.10+)   → 'cost_cap'
 *   - errorCode === 'auth' or 'auth_inferred' (alpha.14) → 'provider_auth_failed'
 *   - errorCode === 'billing_exhausted[_inferred]' (alpha.77) → 'provider_billing_exhausted'
 *   - status === 'retryable' (anything else)          → 'provider_error'
 *   - status === 'terminal' (e.g. model_not_found)    → 'provider_error'
 */
/**
 * alpha.71 — the raw `errorCode` of the same attempt `normalizeFallbackReason`
 * summarizes. Deliberately a sibling function reading the SAME attempt via the
 * same predicate, so the precise code and the normalized reason can never
 * describe different attempts.
 */
export function firstFailureErrorCode(
  attempts: CallAttempt[],
): string | undefined {
  return attempts.find((a) => a.status !== 'success')?.errorCode;
}

/** KG-18 step 1 — the class of the first failed attempt (the one the fall-over is about). */
export function firstFailureClass(attempts: CallAttempt[]): CallAttempt['fallbackClass'] {
  return attempts.find((a) => a.status !== 'success')?.fallbackClass;
}
export function firstFailureQuotaId(attempts: CallAttempt[]): string | undefined {
  return attempts.find((a) => a.status !== 'success')?.quotaId;
}

/**
 * KG-18 step 1 — an attempt's class: the provider body's when execute() classified it, else
 * `quality` for a synthesized contract violation (a 200 that broke the declared output
 * contract — the only failures that are about the answer, not the transport).
 */
function attemptClassOf(err: { errorCode: string; fallbackClass?: CallAttempt['fallbackClass']; quotaId?: string }): Pick<CallAttempt, 'fallbackClass' | 'quotaId'> {
  if (err.fallbackClass) return { fallbackClass: err.fallbackClass, ...(err.quotaId ? { quotaId: err.quotaId } : {}) };
  if (isStructuredContractViolation(err.errorCode) || err.errorCode === 'empty_response' || err.errorCode === 'structured_output_parse_failed') return { fallbackClass: 'quality' };
  return {};
}

// ─────────────────────────────────────────────────────────────────────────
// alpha.133 — the result says what was done (R3) and a fallback is one (R4)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One failed or skipped attempt in plain words: the verb (`failed`,
 * `was skipped`, `was not tried`) and why. Keyed on `errorCode`; an unknown
 * code reads as a provider error, never as a code.
 */
export function attemptFailureInWords(a: Pick<CallAttempt, 'errorCode'>): { verb: string; why: string } {
  switch (a.errorCode) {
    case 'auth':
      return { verb: 'failed', why: 'the provider refused the API key' };
    case 'auth_inferred':
      return { verb: 'was skipped', why: 'its provider refused the API key earlier in this call' };
    case 'billing_exhausted':
      return { verb: 'failed', why: 'the provider account is out of credits' };
    case 'billing_exhausted_inferred':
      return { verb: 'was skipped', why: 'its provider account ran out of credits earlier in this call' };
    case 'rate_limit':
      return { verb: 'failed', why: 'the provider rate-limited the request' };
    case 'server_error':
      return { verb: 'failed', why: 'the provider answered with a server error' };
    case 'timeout':
      return { verb: 'failed', why: 'the request timed out' };
    case 'network_error':
      return { verb: 'failed', why: 'the request did not reach the provider' };
    case 'model_not_found':
      return { verb: 'failed', why: 'the provider does not serve the model, or no longer does' };
    case 'invalid_request':
      return { verb: 'failed', why: 'the provider rejected the request as invalid' };
    case 'max_tokens_on_structured_output':
      return { verb: 'failed', why: 'its answer was cut off before the JSON was complete' };
    case 'structured_output_parse_failed':
      return { verb: 'failed', why: 'its answer was not valid JSON' };
    case 'empty_response':
      return { verb: 'failed', why: 'it returned an empty answer' };
    case 'thinking_prefix_mismatch':
      return { verb: 'failed', why: 'the provider rejected the thinking blocks in the history' };
    case 'compile_error':
      return { verb: 'failed', why: 'kgauto could not build the request for it' };
    case 'unreachable_provider':
      return { verb: 'was skipped', why: 'no API key for its provider is set' };
    case 'blocked_by_policy':
      return { verb: 'was skipped', why: 'your policy blocks it' };
    case 'aborted':
      return { verb: 'was not tried', why: 'the caller cancelled' };
    default:
      return { verb: 'failed', why: 'the provider returned an error' };
  }
}

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The models that failed (or were skipped as certain to fail) on this call, in
 * attempt order, without the model that served. A cancelled attempt is not a
 * failure of the model.
 */
export function modelsFailedOnThisCall(attempts: CallAttempt[], servedBy: string): string[] {
  const out: string[] = [];
  for (const a of attempts) {
    if (a.status === 'success' || a.errorCode === 'aborted' || a.model === servedBy) continue;
    if (!out.includes(a.model)) out.push(a.model);
  }
  return out;
}

/** The first failed attempt of each model that failed on this call, in order. */
function failedAttemptsByModel(attempts: CallAttempt[], servedBy: string): CallAttempt[] {
  const failed = modelsFailedOnThisCall(attempts, servedBy);
  return failed.map((m) => attempts.find((a) => a.model === m && a.status !== 'success')!);
}

/**
 * Does this advisory recommend moving to `model`? Read from
 * `recommendedModels` when the rule stamps it; otherwise, for a swap-type
 * advisory (`model-swap` / `tier-down`) with no stamp, from its suggestion
 * naming the id as a whole token.
 */
export function recommendsModel(adv: BestPracticeAdvisory, model: string): boolean {
  if (adv.recommendedModels) return adv.recommendedModels.includes(model);
  if (adv.recommendationType !== 'model-swap' && adv.recommendationType !== 'tier-down') return false;
  if (!adv.suggestion) return false;
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_-]|\\.\\d)`).test(adv.suggestion);
}

/**
 * The fallback leg's mutations, said as a fallback. The leg's compile is forced
 * onto `to`, so a `scorer-took-<to>-over-…` entry there is not a ranking choice;
 * it is replaced by `fell-over-from-<from>-to-<to>`, whose description names
 * each model that failed and why (the provider's own message beside it).
 */
export function fallbackLegMutations(
  compileMutations: MutationApplied[],
  ctx: {
    from: string;
    to: string;
    attempts: CallAttempt[];
    unreachableFiltered?: string[];
    policyBlockedFiltered?: string[];
  },
): MutationApplied[] {
  const failed = failedAttemptsByModel(ctx.attempts, ctx.to);
  const parts = failed.map((a) => {
    const w = attemptFailureInWords(a);
    const said = a.message ? ` ("${a.message.length > 160 ? `${a.message.slice(0, 157)}…` : a.message}")` : '';
    return `${a.model} ${w.verb}: ${w.why}${said}`;
  });
  if (!failed.some((a) => a.model === ctx.from)) {
    if (ctx.unreachableFiltered?.includes(ctx.from)) parts.unshift(`${ctx.from} was not tried: no API key for its provider is set`);
    else if (ctx.policyBlockedFiltered?.includes(ctx.from)) parts.unshift(`${ctx.from} was not tried: your policy blocks it`);
  }
  const why = parts.length > 0 ? parts.join('; ') : `${ctx.from} did not serve this call`;
  // Amendment A 4 — a model that was never called did not fail: the id says
  // which. `fell-over-…` only when `from` went on the wire and failed.
  const fromCalled = failed.some((a) => a.model === ctx.from);
  const fallback: MutationApplied = {
    id: fromCalled ? `fell-over-from-${ctx.from}-to-${ctx.to}` : `not-tried-${ctx.from}-sent-to-${ctx.to}`,
    source: 'fallback',
    passName: 'call',
    description: `Fallback, not a ranking choice: ${why}. kgauto sent the request to ${ctx.to}, the next model in the chain.`,
  };
  const ranked = `scorer-took-${ctx.to}-over-`;
  return [fallback, ...compileMutations.filter((m) => !m.id.startsWith(ranked))];
}

/**
 * The request shapes kgauto's own lowering dropped on this compile. The
 * lowering drops exactly one shape today — a trailing assistant turn on a model
 * that rejects prefill (`lowerAnthropic`'s prefill gate, the only producer of
 * `rejectedShapesDropped`) — and compile() says it as a
 * `request-shape-rejected-by-model` advisory; this reads that advisory back.
 */
export function loweringShapeDrops(compile: Pick<CompileResult, 'advisories'>): RejectedShapeDrop[] {
  const adv = compile.advisories.find((a) => a.code === 'request-shape-rejected-by-model');
  if (!adv) return [];
  const detail = /messages \(([^;]+); from lowering\)/.exec(adv.message)?.[1] ?? 'a trailing assistant turn (a prefill) removed';
  return [{ shape: 'assistant_prefill', field: 'messages', source: 'lowering', detail }];
}

// alpha.134 (R8) — `shapeDropMutations` moved to request-shapes.ts so bare compile() emits the
// same id; re-exported here for callers that import it from call.
export { shapeDropMutations } from './request-shapes.js';

/** The plain name of a dropped setting, for the summary. */
function shapeDropWords(d: RejectedShapeDrop): string {
  if (d.shape === 'assistant_prefill') return 'the prefilled assistant turn';
  if (d.field === 'tool_choice') return 'the forced tool choice';
  if (d.field === 'thinking') return 'the thinking setting';
  return d.field;
}

/** Cache marks on the wire request (Anthropic's `cache_control`); 0 on providers that take none. */
function countCacheMarks(request: CompiledRequest): number {
  if (request.provider !== 'anthropic') return 0;
  return (JSON.stringify(request).match(/"cache_control"/g) ?? []).length;
}

export interface CallSummaryInput {
  servedBy: string;
  initialTarget: string;
  /** The first entry the caller listed in `ir.models`: a model id or a `{ family }`. */
  callerFirst?: ChainModelEntry;
  /** The caller's IR, read only to tell whether a family convention edited the wire. */
  ir?: Pick<PromptIR, 'intent' | 'sections' | 'history' | 'currentTurn'>;
  /**
   * Every mutation on the result (`CallResult.mutationsApplied`). Amendment A 1:
   * each is named by a clause or counted. Absent → the served compile's own list.
   */
  mutations?: MutationApplied[];
  attempts: CallAttempt[];
  fellOver: boolean;
  unreachableFiltered?: string[];
  policyBlockedFiltered?: string[];
  /** The compile that served. */
  compile: Pick<CompileResult, 'mutationsApplied' | 'advisories' | 'diagnostics' | 'request'>;
  /** Settings dropped because the served model rejects them. */
  shapeDrops: RejectedShapeDrop[];
  /** Thinking blocks removed on a fallback leg the served model cannot read. */
  thinkingStripped: number;
  thinkingPrefixRetry?: { model: string; stripped: number };
}

/**
 * Amendment A 1 — mutations that record a DECISION and leave the wire as it
 * was: ranking, gates, policy, promotions, family resolution, a withheld or
 * advisory-only cliff, a labelling note. Anything not listed here and not
 * named by a clause is counted as a change ("N other changes"), so an unknown
 * mutation can never hide behind "made no change to the request".
 */
export function isDecisionOnlyMutation(m: Pick<MutationApplied, 'id' | 'passName'>): boolean {
  if (m.passName === 'score_targets') return true;
  if (m.id.startsWith('family-resolved-')) return true;
  if (m.id.startsWith('strategy-promotion-applied-')) return true; // its rewrite is a `translator:` entry
  if (m.id.startsWith('best_effort_profile_')) return true;
  return [
    'stable-prefix-passes-withheld',
    'cliff-withheld-unevidenced',
    'thinking-off-withheld-effort',
    'thinking-off-withheld-thinking-blocks',
    'thinking-off-withheld-sdk',
    'cliff-quality-warning',
    'cliff-escalate',
    'sequential-mode-chain-selected',
  ].includes(m.id);
}

/**
 * The family-convention edits on this wire: a convention's prompt prefix or
 * suffix that the wire request carries and the caller's IR did not. Read from
 * every bundled profile's `archetypeConventions` for this archetype (the pass
 * also borrows the family representative's).
 */
function conventionEdits(
  ir: CallSummaryInput['ir'],
  request: CompiledRequest,
): { suffix?: string; prefix?: string } {
  if (!ir) return {};
  const wire = JSON.stringify(request);
  const given = JSON.stringify({ s: ir.sections, h: ir.history, c: ir.currentTurn });
  const esc = (t: string) => JSON.stringify(t.trim()).slice(1, -1);
  const out: { suffix?: string; prefix?: string } = {};
  for (const p of allProfiles()) {
    for (const c of p.archetypeConventions ?? []) {
      if (c.archetype !== ir.intent.archetype) continue;
      if (c.promptSuffix && !out.suffix && wire.includes(esc(c.promptSuffix)) && !given.includes(esc(c.promptSuffix))) out.suffix = c.promptSuffix.trim();
      if (c.promptPrefix && !out.prefix && wire.includes(esc(c.promptPrefix)) && !given.includes(esc(c.promptPrefix))) out.prefix = c.promptPrefix.trim();
    }
  }
  return out;
}

/** The first sentence of a convention text, for the summary. */
const firstSentence = (t: string): string => {
  const m = /^[^.!?]*[.!?]/.exec(t);
  return m ? m[0] : t;
};

/**
 * alpha.133 (R3) — `CallResult.summary`: who answered (and, on a fallback,
 * which model failed and why), then each change kgauto made to the request.
 * Two sentences, plain words, no mutation ids. Pure.
 *
 * Amendment A 1: every mutation on the result is named by a clause, counted
 * in a closing clause ("and N other changes, listed under mutations"), or —
 * when it records a decision and leaves the wire as it was — counted as such.
 * "made no change to the request" is said only when no mutation that alters
 * the wire is present.
 */
export function buildCallSummary(x: CallSummaryInput): string {
  const muts = x.mutations ?? x.compile.mutationsApplied;
  const named = new Set<string>();
  const nameAll = (pred: (m: MutationApplied) => boolean): MutationApplied[] => {
    const hit = muts.filter(pred);
    for (const m of hit) named.add(m.id);
    return hit;
  };

  // ── Sentence 1: who answered.
  let first: string;
  const failed = failedAttemptsByModel(x.attempts, x.servedBy);
  const servedOwnFailures = x.attempts.filter((a) => a.model === x.servedBy && a.status !== 'success');
  nameAll((m) => m.passName === 'call' && (m.id.startsWith('fell-over-from-') || m.id.startsWith('not-tried-')));
  if (x.fellOver) {
    const parts = failed.map((a) => {
      const w = attemptFailureInWords(a);
      return `${a.model} ${w.verb} (${w.why})`;
    });
    if (!failed.some((a) => a.model === x.initialTarget)) {
      if (x.unreachableFiltered?.includes(x.initialTarget)) parts.unshift(`${x.initialTarget} was not tried (no API key for its provider is set)`);
      else if (x.policyBlockedFiltered?.includes(x.initialTarget)) parts.unshift(`${x.initialTarget} was not tried (your policy blocks it)`);
    }
    first = parts.length > 0
      ? `${x.servedBy} answered as the fallback, after ${listWords(parts)}.`
      : `${x.servedBy} answered as the fallback; ${x.initialTarget} did not serve this call.`;
  } else if (servedOwnFailures.length > 0) {
    const w = attemptFailureInWords(servedOwnFailures[0]!);
    first = `${x.servedBy} answered on a second try, after the first try failed (${w.why}).`;
  } else {
    first = `${x.servedBy} answered on the first try.`;
    const cf = x.callerFirst;
    if (cf && typeof cf === 'object' && 'family' in cf) {
      // Amendment A 2 — a family is not a model the caller listed: say what it resolved to.
      const res = muts.find((m) => m.id.startsWith(`family-resolved-${cf.family}-`));
      const to = res ? /\} → (\S+) \(/.exec(res.description)?.[1] : undefined;
      if (res && to) {
        named.add(res.id);
        if (to === x.servedBy) {
          first = `${x.servedBy} answered on the first try; the ${cf.family} family you listed first resolved to it.`;
        } else {
          nameAll((m) => m.id.startsWith(`scorer-took-${x.servedBy}-over-`));
          first = `${x.servedBy} answered on the first try; kgauto chose it over ${to}, which the ${cf.family} family you listed first resolved to.`;
        }
      }
    } else if (typeof cf === 'string' && cf !== x.servedBy) {
      nameAll((m) => m.id.startsWith(`scorer-took-${x.servedBy}-over-`));
      first = `${x.servedBy} answered on the first try; kgauto chose it over ${cf}, the first model you listed.`;
    }
  }

  // ── Sentence 2: each change made to the request.
  const changes: string[] = [];
  /** alpha.134 — what kgauto decided NOT to change, said after the changes. */
  const notesExtra: string[] = [];
  const d = x.compile.diagnostics;
  const sumOf = (hit: MutationApplied[], prefix: string): number =>
    hit.reduce((n, m) => n + (Number(m.id.slice(prefix.length)) || 0), 0);

  for (const m of nameAll((m) => m.passName === 'resolve_model_entries' && m.id.startsWith('alias-resolved-'))) {
    const alias = /^'([^']+)' is an alias of '([^']+)'/.exec(m.description);
    changes.push(alias ? `sent ${alias[2]} in place of ${alias[1]}` : 'sent the provider\'s current id in place of an alias');
  }
  const sliced = sumOf(nameAll((m) => m.id.startsWith('slice-')), 'slice-');
  if (sliced > 0) changes.push(`left out ${plural(sliced, 'section')} not meant for this intent`);
  const deduped = sumOf(nameAll((m) => m.id.startsWith('dedupe-')), 'dedupe-');
  if (deduped > 0) changes.push(`removed ${plural(deduped, 'duplicate section')}`);
  if (d.toolsDropped > 0) {
    // The relevance pass and a cliff's tool trim both remove tools; one clause says the count.
    nameAll((m) => m.id.startsWith('tool-relevance-') || m.id.startsWith('cliff-strip-tools') || (m.passName === 'apply_cliffs' && /trimmed tools to/.test(m.description)));
    changes.push(`left out ${d.toolsDropped} of ${d.toolsDropped + d.toolsKept} tools`);
  }
  const folded = sumOf(nameAll((m) => m.id.startsWith('compress-history-')), 'compress-history-');
  if (folded > 0) changes.push(`replaced ${plural(folded, 'older turn')} with one summary note`);
  if (nameAll((m) => m.id.startsWith('compress-fat-message-')).length > 0) changes.push('replaced one long earlier message with a short note');
  const rewrites = nameAll((m) => m.passName === 'translator' && m.id.startsWith('translator:')).length;
  if (rewrites > 0) changes.push(`rewrote ${plural(rewrites, 'section')} for this model`);
  const conv = muts.filter((m) => m.id.startsWith('apply-convention-'));
  if (conv.length > 0) {
    const edits = conventionEdits(x.ir, x.compile.request);
    const family = conv[0]!.id.slice('apply-convention-'.length).replace(new RegExp(`-${x.ir?.intent.archetype ?? '[a-z]+'}$`), '');
    const archetype = x.ir?.intent.archetype;
    const whose = `a convention kgauto keeps for the ${family} family on ${archetype ?? 'these'} calls`;
    if (edits.suffix) changes.push(`added an instruction to the end of your last user message ("${firstSentence(edits.suffix)} …"), ${whose}`);
    if (edits.prefix) changes.push(`added a line before your prompt ("${firstSentence(edits.prefix)} …"), ${whose}`);
    // A convention that touched only a warning or hint left the wire as it was: it is a note.
    if (edits.suffix || edits.prefix) for (const m of conv) named.add(m.id);
  }
  // alpha.134 (R2) — on an Anthropic target the cliff's effect is the off-switch
  // the lowering sent (`thinking-off-sent-<type>`) or withheld; the clause says which.
  const offSent = nameAll((m) => m.id.startsWith('thinking-off-sent-'));
  // Amendment A 2 — the adapter's own pair (compile-aisdk.ts): the switch the SDK cannot carry.
  const offSdk = nameAll((m) => m.id === 'thinking-off-withheld-sdk');
  const offSet = nameAll((m) => m.id === 'thinking-off-set-disabled');
  const effortLow = nameAll((m) => m.id === 'effort-low-set');
  const offWithheld = nameAll((m) => m.id.startsWith('thinking-off-withheld-') && m.id !== 'thinking-off-withheld-sdk');
  if (offSdk.length > 0) {
    nameAll((m) => m.id === 'cliff-thinking-zero');
    // Ruling 19 — ruling 15's verb: the adapter sets, the installed SDK sends. (was: "kept the thinking on;
    // sent effort low (the installed SDK cannot send between_tools)", until ruling 19.)
    changes.push('kept the thinking on; set effort low for the AI SDK (the installed SDK decides what reaches the wire; it cannot send between_tools)');
  } else if (offSet.length > 0) {
    nameAll((m) => m.id === 'cliff-thinking-zero');
    changes.push('set thinking: disabled and effort low for the AI SDK (the installed SDK decides what reaches the wire)');
  } else if (effortLow.length > 0) {
    changes.push('set effort low for the AI SDK');
  }
  if (offSdk.length === 0 && offSet.length === 0 && nameAll((m) => m.id === 'cliff-thinking-zero').length > 0) {
    if (offSent.length > 0) {
      const type = offSent[0]!.id.slice('thinking-off-sent-'.length);
      changes.push(
        type === 'between_tools'
          ? "turned the model's up-front thinking off for this call (thinking: between_tools)"
          : `turned the model's thinking off for this call (thinking: ${type})`,
      );
    } else if (offWithheld.length === 0) {
      changes.push(
        x.compile.advisories.some((a) => a.code === 'reasoning-off-for-tools')
          ? 'turned reasoning off so the tools could be sent (the model takes tools only without reasoning)'
          : "turned the model's thinking off for this call",
      );
    }
  }
  if (offWithheld.length > 0) {
    notesExtra.push(
      offWithheld[0]!.id === 'thinking-off-withheld-effort'
        ? `kept the thinking on: ${x.servedBy} rejects its off-switch at the effort in force`
        : 'kept the thinking on: the conversation carries thinking blocks that must stay bound',
    );
  }
  if (nameAll((m) => m.id === 'cliff-terse').length > 0) changes.push('asked for a short answer');
  const marks = countCacheMarks(x.compile.request);
  if (marks > 0) changes.push(`placed ${plural(marks, 'cache mark')}`);
  if (x.shapeDrops.length > 0) {
    nameAll((m) => m.id.startsWith('request-shape-dropped-'));
    const names = [...new Set(x.shapeDrops.map(shapeDropWords))];
    changes.push(`dropped ${listWords(names)}, which ${x.servedBy} rejects`);
  }
  if (x.thinkingStripped > 0) {
    changes.push(`removed ${plural(x.thinkingStripped, 'thinking block')} ${x.servedBy} cannot read`);
  }
  if (x.thinkingPrefixRetry) {
    changes.push(`removed ${plural(x.thinkingPrefixRetry.stripped, 'thinking block')} from the history for the second try`);
  }

  // ── Every mutation not named above: a decision note, or a change counted.
  const rest = muts.filter((m) => !named.has(m.id));
  const notes = rest.filter((m) => isDecisionOnlyMutation(m) || (m.id.startsWith('apply-convention-')));
  const otherChanges = rest.length - notes.length;
  if (otherChanges > 0) {
    changes.push(`made ${plural(otherChanges, 'other change')}, listed under mutations`);
  }
  let second = changes.length > 0 ? `kgauto ${listWords(changes)}` : 'kgauto made no change to the request';
  if (notesExtra.length > 0) second += `, and ${listWords(notesExtra)}`;
  if (notes.length > 0) {
    second += `; ${plural(notes.length, 'entry', 'entries')} under mutations ${notes.length === 1 ? 'records a decision' : 'record decisions'} that did not change the request`;
  }
  return `${first} ${second}.`;
}

function normalizeFallbackReason(
  attempts: CallAttempt[],
): FallbackReason | undefined {
  const first = attempts.find((a) => a.status !== 'success');
  if (!first) return undefined;
  const code = first.errorCode ?? '';
  if (code === 'rate_limit_429' || code === 'rate_limit') return 'rate_limit';
  if (
    code === 'max_tokens_on_structured_output' ||
    code === 'structured_output_parse_failed'
  ) {
    return 'cliff';
  }
  if (code === 'cost_cap_exceeded') return 'cost_cap';
  if (code === 'auth' || code === 'auth_inferred') return 'provider_auth_failed';
  if (code === 'billing_exhausted' || code === 'billing_exhausted_inferred') {
    return 'provider_billing_exhausted';
  }
  return 'provider_error';
}

// Re-export for advanced consumers who want to drive execute() directly.
export { execute } from './execute.js';
export type { ExecuteResult, ExecuteOptions, ExecuteOk, ExecuteErr } from './execute.js';

/**
 * alpha.17. Generate a unique trace identifier. Prefers `crypto.randomUUID()`
 * (Node 16+ / all modern runtimes). Falls back to a `Math.random`-seeded
 * shape on the rare runtime where `crypto.randomUUID` is absent — the trace
 * ID is for routing/correlation only, not security, so the fallback is fine.
 */
function generateTraceId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto && typeof g.crypto.randomUUID === 'function') {
      return g.crypto.randomUUID();
    }
  } catch {
    // Fall through.
  }
  // Fallback shape: 8-4-4-4-12 hex (UUID-shaped, not RFC-4122-conformant).
  const hex = (n: number) =>
    Math.floor(Math.random() * Math.pow(16, n))
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

/**
 * alpha.17. Wrap a glassbox emit call in try/catch + swallow. Critical-path
 * rule: the user's call() must never fail because an observability emit
 * failed. emit.ts already handles async failures internally, but synchronous
 * throws from a buggy adapter or future custom GlassboxPubSub implementation
 * would otherwise bubble. This is the defense-in-depth.
 */
function safeEmit(fn: () => void): void {
  try {
    fn();
  } catch {
    // Drop — visibility loss > call failure.
  }
}

// Used by call.test.ts to assert orchestrator internals.
export const _internal = {
  compileAndRegister,
  validateStructuredContract,
  isStructuredContractViolation,
  raiseOutputBudget,
  extractPromptPreview,
  normalizeFallbackReason,
  generateTraceId,
  safeEmit,
  shouldSampleProbe,
  normalizeProbeCandidates,
  runShadowProbe,
  runProbeCandidates,
};

// Avoid unused-import warning for CompiledRequest re-export.
export type { CompiledRequest };

/**
 * alpha.118 §A — the `served-model-differs` advisory `call()` appends when
 * `servedModelDiffers()` is true. Built like `policy-in-ir-ignored`
 * (compile.ts): level, code, message, suggestion, docsUrl, then the alpha.42
 * request-link + ownership stamp. Rides `CallResult.advisories`; no new
 * transport.
 */
function servedModelDiffersAdvisory(a: {
  requested: string;
  served: string;
  provider: string;
  route: string;
  handle: string;
}): BestPracticeAdvisory {
  const code = 'served-model-differs';
  return {
    level: 'warn',
    code,
    message:
      `kgauto asked for \`${a.requested}\` and the provider (${a.provider}, route ${a.route}) reported serving \`${a.served}\`. ` +
      'A difference here on a pinned model means the route substituted — it is not a transport.',
    suggestion:
      'The provider answered a different model than asked — on a pinned route this is a substitution, not a transport; check `kgauto_aliases` for a known alias, read the provider\'s page today, and if it is a retarget, the profile is stale (L-073).',
    docsUrl: 'https://github.com/stue/communicating-vessels/blob/main/v2/README.md#quickstart',
    kgautoRequestId: a.handle,
    ownership: deriveOwnership(code),
  };
}

/**
 * alpha.105 — does the provider's reported model name a DIFFERENT model than
 * the one kgauto asked for? Allows for each provider's own id conventions so
 * a routine response never reads as a substitution:
 *   - Anthropic returns dated ids (`claude-sonnet-5-20260812` for `claude-sonnet-5`);
 *   - gateways prefix the vendor (`deepseek/deepseek-v4-flash`);
 *   - some surfaces write versions with dots (`claude-opus-4.8`).
 * Rule: normalize both (lowercase, drop a `vendor/` prefix, dots → hyphens,
 * strip a trailing `-YYYYMMDD` / `-latest` / `-preview*` suffix), then the two
 * must be equal or one a prefix of the other on a `-` boundary.
 * Returns `undefined` when the provider reported nothing (unknown ≠ differs).
 */
export function servedModelDiffers(requested: string, served: string | undefined): boolean | undefined {
  if (!served) return undefined;
  const norm = (id: string) =>
    id
      .toLowerCase()
      .replace(/^[a-z0-9_.-]+\//, '')
      .replace(/\./g, '-')
      .replace(/-(\d{8}|latest|preview(-\d+)?)$/, '');
  const a = norm(requested);
  const b = norm(served);
  if (a === b) return false;
  if (b.startsWith(a + '-') || a.startsWith(b + '-')) return false;
  return true;
}
