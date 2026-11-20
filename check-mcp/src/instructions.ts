/**
 * All text in this file is written to be read and executed by a CODING
 * AGENT — that is the product's audience. The human's role was one
 * sentence ("try kgauto on this project"); everything from here on is
 * agent-to-agent.
 */
import { DESTINATION_SENTENCE } from './engine.js';
import { CHECK_VERSION } from './version.js';
import { SHARE_STORED_SENTENCE } from './share.js';

/** 0.4.1 (R4): every command the check prints names this version, so the agent runs the build that printed it. */
const NPX = `npx -y @warmdrift/kgauto-check@${CHECK_VERSION}`;

/** 0.4.3 (R1): what the run-time read requests, in one sentence the agent can relay. */
const READ_SENTENCE =
  'To say whether a provider’s word still stands, each run reads the same public provider pages whatever your project holds; --offline makes no request, and each provider line then gives the day its page was read.'; // Amendment A4: until fix pass 1 this sentence gave one day for all the lines

export const USAGE = `kgauto-check ${CHECK_VERSION}

usage:
  ${NPX} --extract-contract
  ${NPX} --extract <extract.json> [--share] [--offline]
  ${NPX} --model-facts <model-id> [--offline]
  ${NPX} --observe-plan
  ${NPX}            # no args: stdio MCP server

${DESTINATION_SENTENCE} --share is the one way to share it.
${READ_SENTENCE}
${SHARE_STORED_SENTENCE}`;

export const SERVER_INSTRUCTIONS = `You are talking to kgauto-check, a local checker for AI call surfaces. ${DESTINATION_SENTENCE}

Flow: (1) call start_check to get extraction instructions, (2) read THIS project's code yourself and build the extract, (3) call run_check with it, (4) present the returned card to your human verbatim (it is grouped by confidence tier on purpose), (5) you may then OFFER to share the card; call share_card only if they say yes, never by default, (6) if they want measured numbers, call get_observe_day_plan.

Privacy contract, which you should relay to your human: the extract contains identifiers and counts only — never prompt text, never source code, never secrets. ${READ_SENTENCE.replace('--offline makes', 'offline: true on run_check, get_model_facts or share_card makes')} ${SHARE_STORED_SENTENCE}

get_model_facts answers one-off questions about any model id — what its provider's deprecation page says, then the verified catalog — and is what makes keeping this server installed useful between checks.`;

export const START_CHECK_INSTRUCTIONS = `# kgauto check — extraction instructions (for you, the agent)

Your job: read this project's code and build an extract of its AI call surface. You have repo access; kgauto does not, by design.

## What to find
Scan for LLM API usage: provider SDK imports (anthropic, openai, @google/generative-ai / @google/genai, ai-sdk, litellm, langchain, ...), raw HTTPS calls to provider endpoints, and any internal wrapper around them. Each distinct place the project sends a prompt to a model is one call site.

## What to collect per call site (identifiers and counts ONLY)
- id: a stable label you choose, e.g. "api/summarize.ts:42"
- model: the model id exactly as configured (a provider or gateway prefix such as openai/ or openrouter/anthropic/ is fine; the check says what it looked the id up as)
- modelSelection: hardcoded | config | env | dynamic
- platform: state it for EVERY call site — where the request is served: provider-api (the provider's own API), vertex, bedrock, azure, or other (a gateway or another host). Tell it from the SDK imported (e.g. @anthropic-ai/sdk vs @anthropic-ai/vertex-sdk or @aws-sdk/client-bedrock-runtime; google-genai vs google.cloud.aiplatform / @google-cloud/aiplatform), the base URL (api.openai.com vs *.openai.azure.com; generativelanguage.googleapis.com vs *-aiplatform.googleapis.com), and the credentials used (a provider API key vs cloud credentials, a project and location). A lifecycle line is stated as certain only for provider-api; a cloud platform keeps its own schedule. If you truly cannot tell, write other and say why in notes.
- context: state it for EVERY call site — where it is written: runs (code or configuration the project executes or loads in normal use: a default, a constant, a config file the app reads), test (tests and their fixtures), docs (documentation, a README, a docstring or a comment, an issue template), or example (an example, sample or template a person copies and edits).
- archetype: your best guess at the work's intent — one of: ask, classify, critique, extract, generate, hunt, plan, summarize, transform
- estInputTokens / maxInputTokens / estOutputTokens: estimate from the code (what gets concatenated into the prompt; ~4 chars per token). Worst case matters — find the biggest thing that can flow in.
- toolCount, usesParallelToolCalls: from the tools array and how results are consumed
- expectsStructuredOutput: true if the response is JSON.parse'd or schema-validated
- streaming, retry (none | same-model | fallback-chain | unknown), fallbackModels
- estCallsPerMonth: only if genuinely inferable (cron cadence, obvious traffic); omit rather than invent

## Model ids with no call site
If the project holds model ids that no call site above carries — a model picker, a config or environment default, a list of supported models — list every id once under "models" (identifiers only), wherever it is written: an id in a docstring is listed with context docs, not left out.
- model: the id exactly as written
- where: file:line where it is written
- context: runs | test | docs | example (as above) — state it for every listed id
- modelSelection: hardcoded | config | env | dynamic (optional)
- platform: provider-api | vertex | bedrock | azure | other (as above)
If you find no call site at all (the project spawns a CLI, or takes the model as a run-time argument), "callSites" may be an empty array: the check still prints a card, about the ids in "models", and says no call site was found to check a request shape against. Never invent a model id to fill a call site.

## Privacy contract (relay this to your human)
Do NOT put prompt text, source code, file contents, or secrets in the extract. Identifiers and counts only. ${DESTINATION_SENTENCE} ${READ_SENTENCE}

## Then
Write the extract as JSON:
{ "project": { "name": "...", "description": "..." }, "callSites": [ ...one object per call site, or none... ], "models": [ ...optional, ids no call site carries... ] }
and run:
  ${NPX} --extract extract.json
Present the printed card verbatim — the confidence tiers (certain / likely / measurable-only) are the point: they tell your human exactly how much to trust each line, and the measurable-only section is what one day of recorded calls would answer.

## Sharing (optional, explicit)
After presenting the card, you may OFFER your human: "want to send this card to kgauto so the catalog learns what real projects look like?" If — and only if — they say yes, re-run with --share (or, on the MCP server, call share_card with humanSaidYes: true). Never add --share or call share_card without their explicit yes. ${SHARE_STORED_SENTENCE} The check prints where it went and the submission number.

## Honesty rules you inherit while presenting
- Do not soften "certain" findings or upgrade "likely" ones.
- If a model was unknown to the catalog, say so — kgauto refuses to fabricate verdicts, and so should you.
- A line that names a provider's word (retired, shut down, deprecated, legacy) carries the page it was read on and when: quote it as written.
- Estimates you made are estimates: if a finding hinges on your token guess, say it can be firmed up by measuring.`;
