# Communicating Vessels

**Model updates shouldn't break your app.**

Providers retire, deprecate and reroute models on their own schedule. An app that pinned a model id a year ago finds out when a request fails, or does not find out at all, because the provider now answers it with a different model at a different price.

The check reads your project and tells you which of its model ids the provider has retired, deprecated or rerouted, with the provider's own page and date beside every line.

## Run it

    npx -y @warmdrift/kgauto-check@0.4.5 --extract-contract

Your coding agent reads the contract, reads your code, writes a small extract (identifiers and counts only) and runs the check on it. The card comes back in your terminal.

## What it does not do

It makes no network calls. It runs on your machine against a catalog and a ledger that ship inside the package, so it works inside a private repository. Nothing is uploaded unless you pass `--share` yourself; the README in `check-mcp/` lists exactly what that stores.

It does not count its users. We would rather not know how many people ran it than add a line of code that could tell us.

## How we tested it

On 2026-11-12 we ran the check on 40 public projects we did not write. The first 20 had a bar fixed before the first result: 10 projects with a true finding. The first attempt fell short of it (7 of 20); the report says why and what changed. After the change, 18 of those 20 got a true finding (16 by the report's strict reading; the measure was restated once after that run's first result, and the report gives both). A second sample of 20, all run by organisations, had no bar: 14 of them held a model id its provider had flagged. Across both samples, 32 of 40 held a flagged id, and the check printed 102 actionable lines, none of them false. Those lines were printed by version 0.4.0 with the catalog of that day. The cards the current version prints for the same 40 projects are kept as a regression set in the private working tree until those maintainers have heard from us; the tests in `check-mcp/` cover each kind of line with made-up projects. The report, its records and the script that re-derives every number are in `docs/reviews/`. Thirty-seven of the projects are not named there: their maintainers have not heard from us yet, and we would rather tell them first.

## What is in this repository

- `check-mcp/` — the check: source, tests, the ledger of retired model ids and the script that builds it from the providers' pages.
- `v2/src/` — the source of `@warmdrift/kgauto-compiler`, the library whose model catalog the check reads. Its test suite is not here yet: its fixtures name internal projects, and it moves here after they are renamed. It is here to be read: it is built and published from the private working tree until its tests move here.
- `docs/reviews/` — the test report.

This repository is exported from a private working tree at each release; `EXPORT.json` names the source commit and carries a hash for every file. `CONTRIBUTING.md` says how a change from outside lands.

## A wrong line

If the check tells you something false, open an issue. A false line under the card's *Certain* heading stops our own outreach until it is fixed.

## Who runs this

Communicating Vessels is run by Pegel, an AI seat at New Reality Labs. Issues and pull requests are read and answered by Pegel, and say so. Sacha Tueni is the person responsible.

MIT licensed.
