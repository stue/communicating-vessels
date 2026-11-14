# The check on 40 public projects — 2026-11-12

This is the public form of the test behind the check's numbers. Every number below is printed by `python3 docs/reviews/tally_public.py`, which reads only `public-records.json` beside this file: one row per project, with its card lines counted by tier, verdict and kind for each run. The extracts, the cards and the reads of each project's owner stay in our private working tree.

Three projects keep their names, because the check's site already shows a line from each: firecrawl/open-lovable, openclaw/openclaw and Mintplex-Labs/anything-llm. The other 37 appear as `project-NN` with their star counts as bands, because their maintainers have not heard from us yet, and the aim is courtesy, not secrecy.

## What was run, and the bars

- **The check**, `@warmdrift/kgauto-check`, ran on an extract of each project: the model ids, call sites and counts its code holds, written by a coding agent from the check's own contract. No provider API was called, `--share` was never passed, and no project was contacted, starred, forked or filed against.
- **The first sample**, 20 projects: public applications that call a model through an AI SDK, found by GitHub code search and chosen by rules written before the first clone. Run one used 0.3.0. Run two used 0.4.0, then the same 0.4.0 after two fixes a cold read asked for (Amendments B and C, below).
- **The second sample**, 20 projects: chosen afterwards to ask whether the gap is a beginner's: repositories with 500 stars or more, owned by an organisation, pushed in the month before and released in the three months before, taken by stars, the first twenty applications.
- **The bars, each written down before the result it judges.** Run one (R4): viable if 10 or more of the 20 get at least one true actionable finding, weak at 5 to 9, fails under 5. Run two (R6): viable if 14 or more of the same 20 do, and no more than one *certain* line in total is false (restated after run two's first result, below). The second sample has no pass bar; its reading was fixed before it was drawn: 10 or more of 20 holding a flagged id reads *not a beginner's pain alone*, under 5 *mostly a beginner's*.

An **actionable** line names a model id in the project and something to do about it: its provider has retired, shut down, deprecated, rerouted or marked it legacy (in run one, also an alias line and a tool-count ceiling line). An actionable line is **true** when its fact was found on the provider's own page and its site was read in the project's file at the commit the run used; a *not recognised* line is true when the check, asked about the id alone, does not recognise it either. Lines about cost, input share and cheaper candidates are arithmetic on the agent's own token estimates; no provider page states them, so they are counted as **not checkable**.

## Run one: weak, 7 of 20

| count | run one (0.3.0) |
|---|---:|
| projects run | 20 |
| projects with a card | 18 |
| projects with at least one true actionable finding | **7** |
| R4 verdict | **weak** |
| lines on all cards | 178 |
| … *certain*: true / false / not checkable | 62 / 9 / 0 |
| … *likely*: true / false / not checkable | 0 / 0 / 55 |
| … *measurable-only*: true / false / not checkable | 0 / 0 / 52 |
| actionable lines: true / false | 11 / 8 |
| projects whose extract held an id its provider flags | 17 |
| flagged ids on a card the card said nothing about | 25 |

**Why it fell short.** 17 of 20 extracts held a model id its provider's own page flags, and the card turned that into a true actionable line on 7. The check read only the routing catalog of the library behind it, which holds current and recent models. A retired or deprecated id was not in it, so the card said the id was *not in the verified catalog* and that it might be a new release: the opposite of the finding. 37 of the 178 lines were that line.

**Its 9 false *certain* lines**, read against the providers' pages: 5 said a DeepSeek model name is now silently served by another model, where DeepSeek's page says those names will be discontinued; 3 said a call's tools exceed a model's tool-count ceiling, where the number was a default of the library's (DeepSeek's page states no limit, and OpenAI's page for the other model lists function calling); 1 called a model a preview its page does not mark as one. Counting the alias lines that were false but pointed the right way, 9 projects would count, still weak.

## What changed before run two

- **A lifecycle ledger.** The check now carries a table of the model ids the four providers (OpenAI, Anthropic, Google, DeepSeek) list as retired, shut down, deprecated, legacy or rerouted, built by script from their deprecation pages (`check-mcp/scripts/build-ledger.mjs`). Each line names the page and the date it was read.
- **Prefixed ids resolve** (`google/…`, `anthropic/…`, `openai/…`), and the line says what the id was looked up as.
- **The false lines went.** The alias, tool-ceiling, preview and legacy lines were removed; the ids they named now carry the provider's own word and its page.
- **A project with no direct model call, or whose model is chosen at run time, gets a card** instead of a refusal. The two projects of the first 20 that got no card in run one were re-extracted under the new contract.

## Run two on the same 20: viable, 18 of 20, no false line

After the first build of 0.4.0, a cold read found two defects. A call through a partner platform (Vertex, Bedrock, Azure) got a *certain* line carrying the provider's own date, which can be false on the partner (**Amendment B**: such a line drops to *likely* and says the platform may keep its own schedule; more prefixes resolve). And a lifecycle line did not say whose API its fact is about (**Amendment C**: it now says *On Google's own API, …*, and is *certain* only when the extract states that the call goes to the provider's own API). None of the stored extracts states a platform, so after Amendment C every lifecycle line sits at *likely*. The measure was restated to match, after run two's first result: a project counts when it has a true actionable line at *certain* or *likely* whose fact was verified on the provider's page, and a false line at either tier counts against the bar. On these records the restated count and R6's count as first written agree (18 and 18). Every card was regenerated from the stored extracts; no extract was rewritten.

| count | run one (0.3.0) | run two, after Amendment C |
|---|---:|---:|
| projects with a card | 18 | 20 |
| projects with at least one true actionable finding | 7 | **18** |
| … strict: without the two weak cases (†) | — | **16** |
| false lines, any tier | 9 | **0** |
| lines on the cards: certain / likely / measurable-only | 71 / 55 / 52 | 18 / 119 / 50 |
| actionable lines: true / false | 11 / 8 | 60 / 0 |
| projects whose extract holds a provider-flagged id | 17 | 18 |
| flagged ids on a card the card said nothing about | 25 | 1 |
| R6 verdict (restated) | — | **viable** |

† **The two weak cases.** One project pins no model: its id is the entry its adapter marks *recommended* in a fallback list, while the line that sends uses whatever the operator configured. One project's re-extract lists the ids of its model picker, and its true lines are all picker entries. Without both, the count is 16 of 20.

The *certain* lines left after Amendment C (18) are the *not recognised* lines: an id the check could match neither to the catalog nor to a provider's list, so nothing about it was checked. Of the flagged ids, 1 is still on a card that says nothing about it: an id whose own model page says **Legacy.** while the provider's deprecations table lists only a dated form of it, as active.

## The second sample: 14 of 20, not a beginner's pain alone

| count | first build of 0.4.0, with the cold read's verdicts | after Amendment C |
|---|---:|---:|
| projects with a card | 20 | 20 |
| projects whose extract holds a provider-flagged id | 14 | **14** |
| projects with at least one true actionable finding | 14 | **14** |
| false lines, any tier | **3** | **0** |
| *certain* lines: true / false / not checkable | 47 / 3 / 1 | 9 / 0 / 0 |
| lines on the cards: certain / likely / measurable-only | 51 / 1 / 17 | 9 / 42 / 17 |
| actionable lines: true / false / not checkable | 34 / 3 / 2 | 42 / 0 / 0 |
| reading (fixed before the sample was drawn) | — | **not a beginner's pain alone** |

The 3 false lines of the first build are the cold read's finding: each gave Google's own API date for `gemini-2.5-flash` at a site that calls it through Vertex, whose page gives another date and another replacement. Amendment B moved such lines to *likely* with the platform named, and Amendment C left them there. The *certain* line marked not checkable was an Azure deployment of `gpt-4o`, whose schedule is Azure's.

All 20 projects of the second sample fall in the *team-run* group (20 of 20).

## By the owners' experience

The owner groups follow rules fixed before the reads: *team-run* is an organisation with 5 or more contributors; a *seasoned individual* is a user account 5 or more years old with 20 or more public repositories; *newer individual* is everything else. Only this aggregate is published; the per-owner reads stay private. The groups are small, and no conclusion is drawn from them.

| sample · owner group | projects | hold a flagged id, run one | after C | ≥1 true actionable line, run one | after C |
|---|---:|---:|---:|---:|---:|
| first 20 · team-run | 7 | 7 | 7 | 3 | 7 |
| first 20 · seasoned individual | 7 | 5 | 6 | 2 | 6 |
| first 20 · newer individual | 6 | 5 | 5 | 2 | 5 |
| second 20 · team-run | 20 | — | 14 | — | 14 |

## The 40

Star bands are from the GitHub API on the day of the run. "Flagged ids held" counts the ids in the extract whose provider's page flags them. † marks the two weak cases.

**The first 20**

| project | stars | owner group | true actionable, run one | after C | flagged ids held, after C | lines after C: certain / likely / measurable-only |
|---|---|---|---:|---:|---:|---|
| project-01 | under 1,000 | seasoned individual | 1 | 1 | 1 | 1 / 9 / 7 |
| project-02 | under 1,000 | team-run | 0 | 4 | 3 | 0 / 4 / 1 |
| project-03 | under 1,000 | team-run | 0 | 1 | 1 | 0 / 1 / 1 |
| project-05 † | under 1,000 | team-run | 1 | 2 | 2 | 2 / 6 / 4 |
| project-08 | under 1,000 | newer individual | 2 | 4 | 4 | 0 / 10 / 4 |
| project-09 | 10,000 or more | team-run | 2 | 5 | 5 | 0 / 12 / 4 |
| project-11 | under 1,000 | seasoned individual | 1 | 2 | 2 | 0 / 9 / 5 |
| project-13 | under 1,000 | newer individual | 0 | 2 | 3 | 1 / 2 / 1 |
| project-14 | under 1,000 | seasoned individual | 0 | 1 | 1 | 1 / 1 / 1 |
| project-15 | under 1,000 | newer individual | no card | 0 | 0 | 0 / 0 / 0 |
| project-16 | under 1,000 | seasoned individual | 0 | 3 | 3 | 0 / 3 / 1 |
| project-18 | under 1,000 | team-run | 3 | 5 | 5 | 0 / 13 / 5 |
| project-19 † | under 1,000 | seasoned individual | no card | 17 | 17 | 6 / 17 / 1 |
| project-23 | under 1,000 | newer individual | 0 | 1 | 1 | 0 / 1 / 1 |
| project-24 | under 1,000 | newer individual | 0 | 1 | 1 | 0 / 6 / 3 |
| project-26 | under 1,000 | seasoned individual | 0 | 0 | 0 | 2 / 3 / 2 |
| project-29 | under 1,000 | newer individual | 1 | 1 | 1 | 1 / 3 / 2 |
| project-31 (firecrawl/open-lovable) | 10,000 or more | team-run | 0 | 4 | 4 | 1 / 4 / 1 |
| project-36 | under 1,000 | seasoned individual | 0 | 4 | 4 | 1 / 8 / 3 |
| project-39 | under 1,000 | team-run | 0 | 2 | 2 | 2 / 7 / 3 |

**The second 20**

| project | stars | owner group | true actionable, first build | after C | flagged ids held, after C | lines after C: certain / likely / measurable-only |
|---|---|---|---:|---:|---:|---|
| project-04 | 10,000 or more | team-run | 3 | 4 | 4 | 0 / 4 / 1 |
| project-06 | 10,000 or more | team-run | 1 | 1 | 1 | 0 / 1 / 1 |
| project-07 | 10,000 or more | team-run | 2 | 2 | 2 | 1 / 2 / 1 |
| project-10 | 10,000 or more | team-run | 3 | 5 | 5 | 0 / 5 / 1 |
| project-12 | 10,000 or more | team-run | 3 | 3 | 3 | 0 / 3 / 1 |
| project-17 | 10,000 or more | team-run | 2 | 2 | 2 | 1 / 2 / 1 |
| project-20 | 10,000 or more | team-run | 0 | 0 | 0 | 0 / 0 / 0 |
| project-21 | 10,000 or more | team-run | 1 | 1 | 1 | 1 / 1 / 1 |
| project-22 | 10,000 or more | team-run | 2 | 3 | 3 | 0 / 3 / 1 |
| project-25 | 10,000 or more | team-run | 0 | 0 | 0 | 0 / 0 / 0 |
| project-27 (openclaw/openclaw) | 10,000 or more | team-run | 1 | 2 | 2 | 2 / 2 / 1 |
| project-28 | 10,000 or more | team-run | 3 | 4 | 4 | 0 / 4 / 1 |
| project-30 | 10,000 or more | team-run | 0 | 0 | 0 | 1 / 0 / 1 |
| project-32 (Mintplex-Labs/anything-llm) | 10,000 or more | team-run | 3 | 5 | 5 | 1 / 5 / 1 |
| project-33 | 10,000 or more | team-run | 3 | 3 | 3 | 1 / 3 / 1 |
| project-34 | 10,000 or more | team-run | 4 | 4 | 4 | 0 / 4 / 1 |
| project-35 | 10,000 or more | team-run | 0 | 0 | 0 | 0 / 0 / 0 |
| project-37 | 10,000 or more | team-run | 0 | 0 | 0 | 0 / 0 / 1 |
| project-38 | 10,000 or more | team-run | 0 | 0 | 0 | 1 / 0 / 1 |
| project-40 | 10,000 or more | team-run | 3 | 3 | 3 | 0 / 3 / 1 |

## What was not checked

- No provider API was called, so whether a retired id still answers today is not known; every verdict rests on the providers' pages.
- The *likely* lines about cost and input share, and every *measurable-only* line, were not checked, including the catalog's prices.
- The ledger covers four providers. Grok, Mistral, Llama, Kimi and GLM ids were not checked against theirs.
- The first sample came from GitHub's code search, which ranks by match and not by stars, so most of it is small: 18 of 20 have under 1,000 stars. Which way that cuts is not measured.
- The agent that wrote the extracts had read the check's engine first, to know which lines it would verify. The extracts follow the contract and nothing else, but it is not a stranger's agent.
- Token estimates, tool counts and retry fields are that agent's reading of each project's code.

## Reproduce

    python3 docs/reviews/tally_public.py

It prints every count above, per run and per project, from `public-records.json` alone.
