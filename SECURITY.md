# Security

## Reporting a problem

Please report a security problem privately, through this repository's security advisories (the **Security** tab, then **Report a vulnerability**), until a contact address is published here. Do not open a public issue for it. A report is read and answered there.

## What the check can reach

- **Files.** It reads two: the extract you name with `--extract` (`check-mcp/src/bin.ts`), and its own `package.json`, for its version (`check-mcp/src/version.ts`). It does not read your project; your coding agent does that, and writes the extract (identifiers and counts only, by the contract the check prints).
- **The network.** None, unless you pass `--share`. With `--share` it sends one request, to the endpoint named in `check-mcp/src/share.ts`, carrying the extract, the card, the check's version and the catalog's version. The sentence the check prints with `--share`, and the README in `check-mcp/`, say what is stored.
- **Your environment.** It reads one variable, `KGAUTO_SHARE_ENDPOINT_OVERRIDE` (`check-mcp/src/bin.ts`), and only to choose where `--share` sends. It reads no keys and calls no model provider.
- **The catalog and the ledger** ship inside the package, in its dependencies and in `check-mcp/src/lifecycle-ledger.ts`. Nothing is downloaded at run time.

## What it cannot do

It cannot see code your agent did not put in the extract, it does not run your code, and it does not call a provider's API, so a line about a model's lifecycle is the provider's page as read on the date the line names, not a live probe.
