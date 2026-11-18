# @warmdrift/kgauto-check

**Point your AI at your project.**

If you're the human and your agent can browse + run commands, one sentence is enough:

```
Run the kgauto check on this project. Instructions for you, the agent: fetch https://model-check-alpha.vercel.app/check.html and follow its "For the agent" section. Show me the card it produces, verbatim.
```

Or the manual version — your part is two steps.

**Step 1 — add the check to your agent (once).** Claude Code: run this in a terminal, then start a fresh session in your project (new MCP servers load at session start):

```bash
claude mcp add kgauto-check -- npx -y @warmdrift/kgauto-check@0.4.4
```

Cursor and most other agents — add to your MCP config, then restart the app:

```json
{ "mcpServers": { "kgauto-check": { "command": "npx", "args": ["-y", "@warmdrift/kgauto-check@0.4.4"] } } }
```

**Step 2 — paste the ask**, in your agent, inside the project you want checked:

```
Run the kgauto check on this project: call kgauto-check's start_check tool, follow its instructions, and show me the card it returns, verbatim.
```

Everything below is for the agent.

---

## What this is (for you, the agent)

A local MCP server and CLI that checks a project's AI call surface against the providers' own deprecation pages and kgauto's doc-verified model catalog — lifecycle statuses, prices with verification dates, context/output/tool limits, capability flags (parallel tool calls, structured output), and known quality cliffs that the kgauto compiler executes in production.

**The trust boundary:** the check reads your repository on your machine; nothing about your project leaves it unless you choose to share the result. You read the project's code (you already have access); the extract you build carries identifiers and counts only — never prompt text, source code, or secrets.

**What it requests.** To say whether a provider's word still stands, each run reads the same ten public pages, whatever your project holds — plain GET requests, no cookie, no query string, nothing about the project in them, nothing cached or written. By their own titles they are: Anthropic's *Model deprecations*; OpenAI's *Deprecations* and four of its model pages, *GPT-4o*, *GPT-4o mini*, *GPT-4.1* and *GPT-4.1 mini*; Google's *Gemini deprecations* and *Release notes*; and DeepSeek's *Change Log* and *Your First API Call* (the page DeepSeek serves at `api-docs.deepseek.com/news`, which carries a sentence about two retired ids that the change log does not). The card names each page by its title, and a page whose title is not the one this version expects is not read.

A provider line is *Certain* only when all three hold: its page was read in this run and still carries the line; the call is on the provider's own API; and the line is not this check's reading of a provider's release notes that name a model in words. Any other provider line is *Likely* and says why. With `--offline` (or `KGAUTO_CHECK_OFFLINE=1`, or `offline: true` on a server tool) no request is made, and every provider line is *Likely*, saying the day this version read its page.

## Zero-install one-shot (shell-capable agents)

No MCP setup, no restart:

```bash
npx -y @warmdrift/kgauto-check@0.4.4 --extract-contract   # extraction instructions + privacy contract
# ...read the project, write extract.json per those instructions...
npx -y @warmdrift/kgauto-check@0.4.4 --extract extract.json   # prints the findings card (add --offline to make no request)

# Standing-value one-shots:
npx -y @warmdrift/kgauto-check@0.4.4 --model-facts claude-sonnet-5   # one model → the provider's word, verified prices, limits, cliffs
npx -y @warmdrift/kgauto-check@0.4.4 --observe-plan                  # rung 2: the one-day observe run
```

**Sharing (explicit opt-in).** After presenting the card, you may OFFER your human: "want to send this card to kgauto so the catalog learns what real projects look like?" If — and only if — they say yes, re-run with `--share` (on the MCP server: call `share_card` with `humanSaidYes: true`). Sharing stores one row: a row number, the time it arrived, the project name, the extract, the card, the check’s version and the catalog’s version. The check prints where it went and the submission number. Never add `--share` or call `share_card` without their explicit yes. Without it, nothing about the project leaves the machine.

**Offering the durable install.** The natural moment to offer the MCP install below is after a card with real findings ("want me to keep this available? `get_model_facts` answers model questions from the verified catalog between checks"). Don't push it before the card has earned it.

## Tools

| Tool | What it does |
|---|---|
| `start_check` | Call first. Returns extraction instructions — what to read from the project and how to build the extract. |
| `run_check` | Runs the deterministic check on your extract. Returns a findings card grouped by confidence tier — present it to your human **verbatim**. |
| `get_model_facts` | One model id → status, verified prices, limits, capabilities, known cliffs. Honest miss on unknown models. |
| `get_observe_day_plan` | Rung 2: what a one-day observe-only run on real traffic would measure, and the two honesty requirements any setup must carry. |
| `share_card` | Only on your human's yes, after the card: sends the card and the extract, as `--share` does, and returns the stored card with the submission number. |

## An example card

This is the output of `kgauto-check 0.4.4` on a small illustrative extract (two call sites, one on the provider's own API and one on Vertex AI, and a model picker; the extract is `tests/fixtures/readme-example.json`, and a test holds this card to the build's output on the pages as read for this release, `tests/fixtures/pages-read.json`), printed by the real build — not a mock-up:

````markdown
# Communicating Vessels — the check: example-app

2 AI call sites and 3 model ids: `anthropic/claude-sonnet-4-20250514` (looked up as `claude-sonnet-4-20250514`), `gemini-2.5-flash`, `gpt-4o-mini`. 3 are flagged by their providers.

The extract does not say where each id is written, so this count is of every place an id appears.

## Certain — on the provider’s page as read in this run, or read from your code

- 🔴 **On Anthropic's own API, `anthropic/claude-sonnet-4-20250514` (looked up as `claude-sonnet-4-20250514`) was retired on 2026-06-15; its page names `claude-sonnet-5-5`** — Anthropic's model deprecations page (https://platform.claude.com/docs/en/about-claude/model-deprecations.md): “The model is no longer available for use. Requests to retired models fail.” The catalog has no entry for it, so its limits and price were not checked.
  <sub>app/api/chat/route.ts:41 · basis: Anthropic's model deprecations page, read in this run (2026-11-18 18:23 UTC): https://platform.claude.com/docs/en/about-claude/model-deprecations.md</sub>
- 🟡 **On OpenAI's own API, `gpt-4o-mini` is deprecated and shuts down on 2027-01-14; its page names `gpt-6-luna`** — The page's line: “| Jan 14, 2027 | GPT-4o mini (`gpt-4o-mini-2024-07-18`) | Deprecated | `gpt-6-luna` | Oct 14, 2026 |”. The catalog has no entry for it, so its limits and price were not checked.
  <sub>components/ModelPicker.tsx:12 · basis: OpenAI's deprecations page and its model page for GPT-4o mini, read in this run (2026-11-18 18:23 UTC): https://developers.openai.com/api/docs/deprecations.md and https://developers.openai.com/api/docs/models/gpt-4o-mini.md</sub>

## Likely — a provider’s page as read on an earlier day (the day is on the line); a provider’s release notes that name a model in words, not by its id; priced from your estimates; a provider’s word where the call may not use its own API; no retry or fallback found in the code

- 🟡 **On Google's own API, `gemini-2.5-flash` is deprecated; from 2026-12-01 its requests route to `gemini-3.5-flash-lite`** — The page's line: “`gemini-2.5-flash` | June 17, 2025 | December 1, 2026 | `gemini-3.5-flash-lite` (`gemini-2.5-flash` is no longer available in Google AI Studio; effective December 1, 2026, API requests to `gemini-2.5-flash` will automatically route to `gemini-3.5-flash-lite`)”. This site runs on Vertex AI, and Vertex AI runs its own schedule (its page: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions).
  <sub>lib/summarize.ts:18 · basis: Google's Gemini deprecations page, read in this run (2026-11-18 18:23 UTC): https://aistudio.google.com/docs/deprecations; Vertex AI: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions</sub>
- ℹ️ **~$0.0046/call on `gemini-2.5-flash`** — From your token estimates and the catalog's prices for this model ($0.3/M in, $2.5/M out; the catalog's record, checked against Google's documentation on 2026-08-14). This site runs on Vertex AI: the figure is from Google's own API, and Vertex AI may set its own.
  <sub>lib/summarize.ts:18 · basis: your token estimates multiplied by the catalog's prices for this model (the catalog's record, checked against Google's documentation on 2026-08-14)</sub>
- 🟡 **97% of this site's tokens are input** — Above ~85% input share, spend is dominated by context rather than answers — the single strongest signal of a leaking prompt. What's actually IN that context, and how much of it each call needed, is measurable, not guessable.
  <sub>lib/summarize.ts:18 · basis: your token estimates; 85% is a rule of thumb from the projects the check's makers run, not a provider's figure</sub>

## Only measurable — what the observe day answers

- ℹ️ **1 model in the catalog prices under half of `gemini-2.5-flash` on summarize work** — That model is `claude-haiku-5-5` at ~$0.0014/call. The price is arithmetic; whether it holds YOUR quality bar on summarize work is exactly what a one-day observe run with a judged eval measures. The check never ranks a model on price alone.
  <sub>lib/summarize.ts:18 · basis: your token estimates at that model's prices in the catalog; nothing on this line says how well it would do your work</sub>
- ℹ️ **what a code read cannot tell you (and a one-day observe run can)** — Your actual failure rate per model (walkaway failures look like green health checks); your actual input-waste ratio per call; which call sites dominate spend; whether a cheaper model holds quality on your real traffic. These need one day of observed calls — observe-only, your keys, no routing changes.
  <sub>app/api/chat/route.ts:41, lib/summarize.ts:18, components/ModelPicker.tsx:12 · basis: this check reads the extract of your code and runs none of your calls, so it cannot see how they behave</sub>

---
*This check ran on your machine. It read 10 of 10 provider pages in this run — the same 10 public pages whatever your project holds. Nothing about your project was sent anywhere, and no rows were written anywhere.*
<sub>@warmdrift/kgauto-check 0.4.4 · catalog @warmdrift/kgauto-compiler 2.0.0-alpha.134 · deprecation pages bundled 2026-11-18, read in this run 2026-11-18 18:23 UTC</sub>
````

## The confidence tiers (why the card is grouped)

- **certain** — the provider's own page as read in this run (with its URL and the time), or a fact from your code. Stated flatly.
- **likely** — a provider's page as read on an earlier day (the day is on the line); priced from your token estimates against verified prices, or a catalog value (a cliff rule says its reason, what the compiler does about it, and the evidence behind it); a provider's word where the call may not use the provider's own API (a cloud platform, a gateway such as `openrouter/…`, or a platform the extract does not state); no retry or fallback found in the code.

**Where an id is written.** The extract may say, for each call site and listed id, whether it is in code that `runs`, a `test`, `docs` or an `example`. The card counts flagged ids by it, puts findings in running code first, and marks a finding that is only in tests, docs or examples with ℹ️.
- **measurable-only** — honestly unknowable from a code read: actual failure rates, actual input-waste, spend distribution, quality-at-cheaper-price. Each of these is exactly what the one-day observe run answers.

**The provider's word first (0.4.0).** A model id is matched as you wrote it (`openai/gpt-5`, `openrouter/anthropic/…`, a dated snapshot, a Bedrock or Vertex form) and looked up in a lifecycle ledger read from the four providers' own pages (Anthropic, OpenAI, Google, DeepSeek; the ten named above) before the catalog. A retired, shut-down, deprecated or legacy id says so, with the date, the replacement the page names, and the page's URL.

kgauto refuses to fabricate verdicts: unknown models get an honest "no measured evidence", and cheaper candidates are named with their price arithmetic only — never with an unmeasured quality claim.

## Client setup variants

```bash
# Claude Code
claude mcp add kgauto-check -- npx -y @warmdrift/kgauto-check@0.4.4
```

```json
// Cursor / generic mcpServers config
{
  "mcpServers": {
    "kgauto-check": { "command": "npx", "args": ["-y", "@warmdrift/kgauto-check@0.4.4"] }
  }
}
```

## What's underneath

The catalog is `@warmdrift/kgauto-compiler`'s bundled roster — the same executable model knowledge (cliffs, prices, capabilities) that kgauto's prompt compiler runs in production for its consumer apps. This package is a real dependency on it, not a copy: the check and the compiler cannot drift apart.
