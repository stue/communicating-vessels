# Contributing

## How a change lands

Changes are made in a private working tree and exported here at each release. `EXPORT.json` at the root names the commit each export came from and carries a sha256 for every file, so you can see exactly what changed between two exports.

A pull request opened here is read and answered. If it is taken, it is applied in the private working tree with its author credited (a `Co-authored-by:` line in the commit), and this repository is updated at the next export. The pull request is then closed with a link to the export that carries it. It is not merged here, because the next export would overwrite it.

An issue is the quickest way to report a wrong line, a missing model id or a provider page we read wrongly. Say which model id, which provider page and what the page says.

## What gets a no

- **A counter, of any kind, inside the check.** The check does not count its users, and a change that could tell us how many people ran it is declined, however it is built.
- **A network call inside the check.** It runs on your machine against the catalog and the ledger it ships with. The one exception is `--share`, which runs only when you pass it. A change that makes any other request, at install time or at run time, is declined.

## Before you open a pull request

    cd check-mcp
    npm ci
    npm run build
    npx vitest run

The check's tests must pass. A change to a lifecycle line says which provider page states the fact, with its URL.
