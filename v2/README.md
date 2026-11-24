# @warmdrift/kgauto-compiler — v2 (alpha)

You write a prompt once and list the models you will accept; kgauto makes the request correct for whichever of them answers, on your own provider keys.
One `call()` gives you the answer, the model that gave it, and a sentence saying what kgauto did to the request on the way (a tool left out, a setting the model would have rejected, a fallback after a failure).

> Prompt compiler with executable provider knowledge for multi-model AI apps.
> **Swap models without rewriting prompts.**

What this package delivers today, and nothing it doesn't:

- **A prompt compiler** — every optimization is a pass on a structured
  Intermediate Representation (IR), not string surgery on a rendered prompt:
  slicing, dedupe, intent-aware tool relevance, history compression,
  target-correct lowering with cache markers.
- **Executable provider knowledge** — model cliffs, lowering rules, and
  recovery handlers as code that fires at compile time, curated against
  provider docs with grounding labels. Seven-plus frontier model transitions
  absorbed centrally with zero consumer prompt rewrites.
- **Normalized multi-provider transport** — `call()` walks a fallback chain
  across Anthropic / Google / OpenAI / DeepSeek with a provider-error
  taxonomy (429 / 404 / 401-auth-walk / parse-fail / MAX_TOKENS), recompiling
  per fallback target. (Scope: the `call()` path. Streaming consumers drive
  their own wire and get compile-time guards, not transport resilience.)
- **A flight recorder** — opt-in telemetry (`record()` / `probeShadow()` /
  key-health) that has repeatedly caught real production defects: empty-response
  cliffs, dead API keys, cache-miss regressions, silent model deprecations.
- **A curated model registry** — capability + pricing data with verification
  stamps, a release watcher, and price-truth test gates.

**What it does not do (yet):** routing does not change itself from measured
outcomes. There is no automatic learning loop in the shipped package — model
promotion is evidence-*informed* but operator-*driven*. What DOES ship as of
alpha.62 is the eval spine (Stage 1 of that architecture): golden-set capture,
a pairwise judge, and a non-inferiority eval whose verdict lands as evidence
on the advisory surface — the eval runs, a human clicks promote. Automatic
promotion (Stages 2–3) returns to this README when it is code, not before.

Greenfield rewrite of `@warmdrift/kgauto` v1 (a behavioral patcher with
telemetry).

## Status

- **Package:** alpha — coexists with v1 (`@warmdrift/kgauto`) under the
  temporary name `@warmdrift/kgauto-compiler`. Renames to v2 final once v1
  is fully retired from production.
- **Tests:** 3,368 passing in the clean-shell run of 2.0.0-alpha.133
  (2026-11-12; 1 skipped). CI has the current count.
- **Brain:** live multi-tenant Supabase substrate (telemetry + curated
  config tables), with two of the author's own apps active in the last 30 days (read 2026-11-12).
- **Learning engine:** not shipped, and archived on 2026-11-24. Automatic promotion from outcomes reopens when a promote-ready verdict on a live surface clears the promotion guard's own floor, a saving of $5.00 a month. What runs today is measured evidence per surface: a golden set, a judge, a verdict, and a head moved by a release. See "What's next."

## Quickstart

Two entry points. Use whichever fits your call path. Both run without a brain: leave `configureBrain(...)` out and nothing is recorded; `compile()` needs no API key at all (a cold install and the snippet below, keyless: 73 ms to a compiled request on 2026-10-06).

### `call()` — kgauto owns the network round-trip (alpha.3)

For plain-fetch consumers who don't already drive the wire themselves. One async call → compiled, executed, normalized. This file runs as written with `node` (save it as `quickstart.mjs`, `npm install @warmdrift/kgauto-compiler`, and set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; with no `configureBrain()` call nothing is recorded anywhere):

<!-- readme-example: quickstart -->
```js
import { call } from '@warmdrift/kgauto-compiler';

const params = { type: 'object', properties: { query: { type: 'string' } } };

// Keys come from the environment: ANTHROPIC_API_KEY and OPENAI_API_KEY.
const result = await call({
  appId: 'quickstart',
  intent: { name: 'one-line-answer', archetype: 'ask' },
  sections: [{ id: 'role', text: 'Answer in one short sentence, from what you know.', cacheable: true }],
  currentTurn: { role: 'user', content: 'What does an HTTP 429 response mean?' },
  tools: [
    { name: 'search_docs', description: 'Search the docs', parameters: params,
      relevanceByIntent: { ask: 0.9 } },
    { name: 'refund_order', description: 'Refund an order', parameters: params,
      relevanceByIntent: { ask: 0 } }, // marked as not needed for ask calls
  ],
  // The first model answers; the second is the fallback, from another provider.
  models: ['claude-haiku-5-5', 'gpt-5.6-luna'],
});

console.log('served by: ', result.servedBy);
console.log('answer:    ', result.response.text);
console.log('summary:   ', result.summary);
console.log('attempts:  ', result.attempts.map((a) => `${a.model} ${a.status}`).join(', '));
console.log('mutations: ', result.mutationsApplied.length || 'none');
for (const m of result.mutationsApplied) console.log(`  ${m.id}: ${m.description}`);
console.log('advisories:', result.advisories.length || 'none');
for (const a of result.advisories) console.log(`  ${a.level} ${a.code}: ${a.message}`);
```

What it printed (recorded by `node scripts/readme-examples.mjs --run`; the receipt beside it has the time, the version and the hosts called):

<!-- readme-example: output docs/receipts/readme-quickstart-2026-11-12.json -->
```text
served by:  claude-haiku-5-5
answer:     HTTP 429 "Too Many Requests" means the client has sent too many requests in a given time period and is being rate-limited by the server.
summary:    claude-haiku-5-5 answered on the first try. kgauto left out 1 of 2 tools.
attempts:   claude-haiku-5-5 success
mutations:  1
  tool-relevance-1: Dropped 1 of 2 tools below relevance 0.2 for intent=ask
advisories: none
```

`result.summary` is the one sentence to read first; `mutationsApplied` and `advisories` carry the detail. `result.requestedModel` is what kgauto first chose, `result.response.tokens` is `{ input, output, total, cached?, cacheCreated? }`, `result.response.toolCalls` is the normalized tool calls, and `result.attempts` lists every model tried.

API keys default to `process.env.{ANTHROPIC,GOOGLE,OPENAI,DEEPSEEK}_API_KEY`. Override per-call via `apiKeys: { anthropic, google, ... }`. Reach provider-specific fields (Gemini `safetySettings`, Anthropic `tool_choice`, OpenAI `seed`) via `providerOverrides: { google: {...}, anthropic: {...} }` shallow-merged into the lowered request.

### `compile()` — drive the wire yourself (existing path)

For consumers who already own provider plumbing (AI SDK adapters, custom retry logic, streaming).

<!-- readme-example: given callProvider -->
```ts
import { compile, configureBrain, record } from '@warmdrift/kgauto-compiler';

configureBrain({ endpoint: 'https://your-app.com/api/kgauto/v2', apiKey: '...' });

const result = compile({
  appId: 'my-app',
  intent: { name: 'search', archetype: 'ask' },
  sections: [{ id: 'role', text: 'You are an assistant.', cacheable: true }],
  currentTurn: { role: 'user', content: 'What does an HTTP 429 response mean?' },
  models: ['claude-haiku-5-5', 'gpt-5.6-luna'],
});

const start = Date.now();
const response = await callProvider(result.target, result.request); // your own provider call

await record({
  handle:    result.handle,
  tokensIn:  response.usage.input,
  tokensOut: response.usage.output,
  latencyMs: Date.now() - start,
  success:   true,
  oracleScore: { score: 0.85 },
});
```

### `probeShadow()` — measure a swap candidate from an AI-SDK route (alpha.48)

`call()` runs a full-IR shadow probe internally (`shadowProbe` option). AI-SDK consumers who drive `streamText()` themselves never call `call()`, so they reach the same probe via the standalone `probeShadow()` export — fire it from `onFinish`, passing the served leg you already have, wrapped in `waitUntil()`/`after()` so it never blocks the response.

<!-- readme-example: fragment — inside an AI SDK route: streamText, model, system, messages, ir, servedModelId and next/server are the route's own -->
```ts
import { probeShadow, configureBrain } from '@warmdrift/kgauto-compiler';
import { after } from 'next/server'; // or the platform's waitUntil()

configureBrain({ endpoint: 'https://your-app.com/api/kgauto/v2', apiKey: '...' });

const t0 = Date.now();
const result = streamText({
  model, system, messages,
  onFinish: ({ text, usage }) => {
    after(() => probeShadow(ir, {
      served: {
        model: servedModelId,
        responseText: text,
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        latencyMs: Date.now() - t0,
      },
      candidates: ['deepseek-v4-pro'], // what you'd consider swapping to
      sampleRate: 0.05,                // pin 1 for a dogfood window
    }));
  },
});
```

kgauto runs each candidate on the **same IR** and persists a `probe_outcomes` row (`replay_source='inline-full-ir'`, `prompt_fidelity=1.0`, both latency legs). Phase 1 is `judge:'off'` — rows accumulate for an offline verdict rollup; inline Opus judging is Phase 2. Fire-and-forget: never throws into your `onFinish`.

#### Sync-mode latency protection (`call()` + `BrainConfig.sync`)

A `probeShadow()` consumer fires from `after()`, so the probe is always off the user-facing path — slow candidates are fine there (it's the right place to evaluate a slow reasoner). But a **`call()`-inline** consumer that sets `BrainConfig.sync: true` (PB-class Edge routes, so the brain write reliably lands before teardown — L-086) *awaits* the probe, putting the candidate's latency on the user's critical path. A `latency_tier='slow'` candidate (deepseek-v4-pro ~78–84s) then blows the route's time budget and the user sees an empty response. Two knobs on `shadowProbe` protect the sync path — **both are no-ops off the critical path** (non-sync `call()` and every `probeShadow()` consumer):

<!-- readme-example: given ir -->
```ts
import { call } from '@warmdrift/kgauto-compiler';

await call(ir, {
  shadowProbe: {
    candidates: ['deepseek-v4-pro'],
    sampleRate: 1,
    maxLatencyMs: 15000,        // default 15000. Sync-mode budget: if the probe
                                // overruns, abort the candidate, return the served
                                // response NOW, record outcome='aborted_latency_budget'.
    skipSlowTierInSync: true,   // default true. Don't even START a latency_tier='slow'
                                // candidate inline; record outcome='skipped_slow_tier_sync'.
  },
});
```

Aborted/skipped probes write a **diagnostic** `probe_outcomes` row (`outcome != 'completed'`, no candidate response, no verdict) so the offline rollup can tell "tried but too slow" from "never armed." A verdict rollup must filter `outcome='completed'`.

**The deeper rule: inline shadow-probe = FAST candidates only.** To evaluate a *slow* reasoner, use the offline/async probe path (the Phase-2 batch direction, off the response entirely) or `probeShadow()` from `after()` — never the inline sync probe.

## Structured advisories API (alpha.29+)

kgauto's compile-time advisories (`caching-off-on-claude`, `tool-bloat`,
`archetype-perf-floor-breach`, etc.) used to vanish after the consumer read
the compile result. alpha.29 ships a structured query + resolution surface
so Admin UIs can render "what's open right now?" without log-scraping.

```ts
import {
  getActionableAdvisories,
  markAdvisoryResolved,
} from '@warmdrift/kgauto-compiler';

// Query open advisories for this app
const open = await getActionableAdvisories({
  appId: 'playbacksam',
  brainEndpoint: process.env.KGAUTO_BRAIN_ENDPOINT!,
  brainJwt: process.env.KGAUTO_BRAIN_JWT!,
  brainAnonKey: process.env.KGAUTO_BRAIN_ANON_KEY!,
});

for (const a of open) {
  console.log(`[${a.severity}] ${a.rule} — ${a.observationCount} firings since ${a.openedAt}`);
  console.log(`  ${a.message}`);
  if (a.suggestedFix?.docsLink) console.log(`  ↳ ${a.suggestedFix.docsLink}`);
}

// After the operator fixes the issue, mark it resolved:
const r = await markAdvisoryResolved({
  id: open[0].id,
  resolutionNote: 'wired historyCachePolicy in compile() — PR #99',
  brainEndpoint: process.env.KGAUTO_BRAIN_ENDPOINT!,
  brainJwt: process.env.KGAUTO_BRAIN_JWT!,
  brainAnonKey: process.env.KGAUTO_BRAIN_ANON_KEY!,
});
if (!r.ok) console.error(r.reason);
```

The view enforces server-side auto-resolution: advisories with no firing
in the last 14 days flip to `status='resolved'` automatically; the next
firing reopens the rule with a fresh stable `id`.

## Architecture

```
APP (any consumer)
  ├── kg.compile(IR) ── runs LOCALLY, no network
  │     ├─ pass: slice (drop sections not for this intent)
  │     ├─ pass: dedupe (collapse identical sections by hash)
  │     ├─ pass: tool_relevance (drop tools below intent threshold)
  │     ├─ pass: compress_history (summarize old turns)
  │     ├─ pass: score_targets (rank allowed models)
  │     ├─ pass: apply_cliffs (executable known_failures from profile)
  │     ├─ pass: lower (target-specific wire format + cache markers)
  │     └─ pass: validate (fits hard constraints)
  │
  ├── app calls provider with the wire request
  │
  └── kg.record(handle, outcome) ── async POST to brain

BRAIN (centralized Supabase)
  ├── compile_outcomes (multi-tenant telemetry)
  ├── probe_outcomes / compile_outcome_quality (shadow-probe + quality rows)
  ├── kgauto_models / kgauto_chains / kgauto_pricing (curated config, operator-maintained)
  └── apps (consumer registry)
```

## Dialect-v1 (cross-app vocabulary)

Apps tag every call with an **intent archetype** (`ask`, `hunt`, `classify`,
`summarize`, `generate`, `extract`, `plan`, `critique`, `transform`) and the
compiler computes a **shape signature** (context bucket × tool count × history
depth × output mode × examples flag).

The `(archetype, model, shape)` tuple is the **learning key** — the shared
grouping vocabulary for telemetry aggregation across apps. It is the
substrate a future cross-app learning engine would key on; today it powers
per-tuple cost/latency observability, nothing more.

## Profiles — executable model knowledge

`profiles.ts` carries every model's capabilities, cliffs, lowering rules, and
recovery handlers as **executable code** — not prose. What each model's rules
are *today*, with the evidence class behind every one and every measurement
kgauto has taken, is published as data and regenerated at every release:

- **[`docs/behaviour-table.md`](docs/behaviour-table.md)** (human) ·
  **[`docs/behaviour-table.json`](docs/behaviour-table.json)** (machine) —
  model × cliffs (metric ≥ threshold → action · evidence class/verdict/date) ×
  probed limits (held/broke, route, claim) × pricing verification date.
  A capability-reducing rule fires only when its evidence is `probed` **and**
  `confirmed` (alpha.103); a `current` model with no measurement says so.
  Generated by `scripts/publish-behaviour-table.mjs`; a drift test fails the
  publish gate when the committed table is stale.

Every compile also returns a **receipt** (alpha.105):

<!-- readme-example: given ir -->
```ts
import { compile } from '@warmdrift/kgauto-compiler';

const r = compile(ir);
r.diagnostics.savings
// { passes: ['dedupe-sections', 'tool-relevance'],
//   inputTokensAsGiven: 6120, inputTokensSent: 4870, inputTokensRemoved: 1250,
//   estimatedUsdSavedFirstCall: 0.000375, estimatedCacheSavingsUsdWarm: 0.0011,
//   dropped: { sections: 1, tools: 3, historyTurns: 0 },
//   basis: { model: 'gemini-2.5-flash', costInputPer1m: 0.3,
//            pricingVerifiedAgainstDocs: '2026-08-14', tokenizer: 'kgauto-estimate' } }
```

It is an estimate against your own IR sent as given, priced at the served
model's verified input price — a call kgauto did nothing to reads `0`. `call()`
carries the same block as `result.savings`, plus `result.servedModel` (what the
provider's response said it served) and `result.servedModelDiffers`.

The 5 prod empty-responses in tt-intelligence's `gemini-2.5-flash` dashboard
calls? v2 catches those automatically — `expectedShortOutput` constraint plus
the `force_thinking_budget_zero` cliff guard.

Since alpha.101 the cap itself is a constraint: declare
`constraints: { maxOutputTokens: 300 }` and a reasoning-default model whose
measured hold point is above it (DeepSeek V4: flash 512, pro 1024) gets
`thinking: { type: 'disabled' }` on the wire — and the cap is emitted on every
provider. AI-SDK consumers pass `providerOptions: compiled.providerOptions`
through to `generateText` to receive the same decision.

## Tools

Tools are first-class IR fields. The compiler's tool-relevance pass drops
tools that don't apply to the current intent before lowering — saves
context budget on every call.

```ts
import type { ToolDefinition } from '@warmdrift/kgauto-compiler';

const tools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the public web',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    relevanceByIntent: {
      ask: 0.9,        // primary tool for ask
      hunt: 0.9,
      classify: 0.0,   // never useful for classification
      summarize: 0.0,
      extract: 0.1,
    },
  },
  // ...
];
```

Each tool declares per-intent relevance scores 0..1. The pass keeps tools
where `relevanceByIntent[currentIntent] >= toolRelevanceThreshold` (default
`0.2`). Missing entries default to neutral (`0.5`) — kept by default. Set
explicit `0.0` to hard-exclude.

Tool definitions eat ~350 tokens of context per tool (L-051), so trimming
matters: 12 declared tools, only 3 relevant → 9 × 350 = 3150 tokens
recovered per call.

The `tool-bloat` advisory (alpha.6) fires when more than 10 tools survive
the relevance pass on a short-output archetype (`classify`, `extract`,
`summarize`, `transform`, `critique`) — those archetypes typically use
≤3 tools, so a kept-count >10 indicates either missing `relevanceByIntent`
or scores set too generously.

DeepSeek profiles cap tools to 1 (sequential-only). Other providers
inherit the count from the IR after the relevance pass.

## Brain provisioning

1. Create a NEW Supabase project (suggested name: `kgauto-brain`)
2. Apply `brain/migrations/001_initial_schema.sql`
3. Insert your apps:
   ```sql
   insert into apps (id, display_name, api_key_hash)
     values ('my-app', 'My App', crypt('<bearer>', gen_salt('bf')));
   ```
4. Configure each consumer with `configureBrain({ endpoint, apiKey })`

For staging without a dedicated brain, point consumers at the same Supabase
they already use — the schema is identical and migration to a dedicated brain
is a `pg_dump` away.

## Golden-set eval (alpha.62 — Stage 1, shipped)

The eval-driven quality-floor-guarded swap architecture (specced 2026-07-17
after an adversarial promise review) began shipping in alpha.62:

- **Capture:** set `KGAUTO_GOLDEN_CAPTURE=0.1` on a consumer and successful
  `call()`s sample their full IR + served output into a per-surface replay
  corpus. Explicit opt-in — golden rows carry raw prompts (documented posture
  change; consent provenance on every row; reads strictly app-scoped). Or
  hand-curate with `scripts/seed-golden-set.mjs`.
- **Eval:** `scripts/run-golden-eval.mjs --app X --archetype Y --candidate M`
  replays the corpus on incumbent AND candidate (fresh outputs both sides),
  applies mechanical hard floors (empty / schema / candidate-error / latency),
  and runs an order-swapped pairwise judge (`judge` archetype, per-archetype
  rubrics). Non-inferiority rule: wins-or-ties ≥ 80% + zero floor violations
  → `promote-ready`.
- **Evidence:** every run lands as brain rows (`kgauto_golden_eval_runs` +
  per-case `probe_outcomes` `golden-replay` rows) and a `golden-eval-verdict`
  advisory on the consumer's advisory surface.

## What's next

Stages 2–3 of the trust ladder (auto-promote downswaps behind a 7-day
rollback guard, then upswaps) and trigger wiring (model-release-watch /
price-truth-watch / live-telemetry drift → auto-eval), then the same harness
pointed at compile variants (Tier D). Each stage lands in this README **when
it ships**, with its gate evidence — the promise follows the code.

## Why this exists

The previous version (v1) treated prompts as opaque strings and could only
*append* behavioral patches. v2 treats prompts as structured IR and makes
every model-specific quirk *executable* (cliffs, lowering, recovery).

The felt pain this solves is real and recurring: every frontier model
release, deprecation, price change, or silent alias flip lands on every
multi-model app at once. Building the absorption layer inline ships one
app's fix. Building it portable — one compiler, one curated registry, one
watcher set, one telemetry substrate — ships the fix to every app at once.

## License

MIT. © Warmdrift.
