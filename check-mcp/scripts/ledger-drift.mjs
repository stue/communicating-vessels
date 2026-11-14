#!/usr/bin/env node
/**
 * ledger-drift.mjs (0.4.2, R2) — can be run on any day: for each row of the lifecycle ledger, is the
 * line it quotes still on the page it cites? Read-only. It uses the generator's own checks
 * (scripts/ledger-check.mjs: `oneRowIn` for a Google table row, `quoteOn` for every other quote),
 * never a second matcher.
 *
 *   node scripts/ledger-drift.mjs --pages <dir> [--ledger <file>]
 *   node scripts/ledger-drift.mjs --fetch [--ledger <file>]
 *
 * <dir> holds the pages under the names scripts/build-ledger.mjs reads (its head lists them).
 * --ledger defaults to src/lifecycle-ledger.ts; any file in the generator's shape is read the same
 * way (e.g. `git show <sha>:check-mcp/src/lifecycle-ledger.ts > old.ts`).
 * --fetch fetches the pages the ledger cites into a new temporary directory first and prints each
 * URL with its UTC time, bytes and sha256; without it nothing is fetched.
 *
 * Checked per row: its `quote` on its `url`, its `note` on the same page, its `alsoQuote` on its
 * `alsoUrl`; and each definition the card quotes (LEDGER_DEFINITIONS, since 0.4.2) on its page.
 * Prints every row that is not on its page, with the page's current line for that id when there
 * is one, then `N rows moved`.
 * Exit 0: nothing moved and every row was checked · 1: a row or a definition moved · 2: a page
 * was not saved, so some rows were not checked (never reported as 0 moved), or a usage error.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneRowIn, quoteOn, PAGE_URL, pageFileOf, htmlToText, googlePageRows, googleTableRows, googleRowCells } from './ledger-check.mjs';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = arg('--ledger') ?? join(HERE, '..', 'src', 'lifecycle-ledger.ts');
const FETCH = args.includes('--fetch');
let PAGES = arg('--pages');
if (!PAGES && !FETCH) {
  console.error('usage: node scripts/ledger-drift.mjs --pages <dir> [--ledger <file>]   |   --fetch [--ledger <file>]');
  process.exit(2);
}

// ── the ledger, read as the generator writes it ─────────────────────────
let ledgerText;
try {
  ledgerText = readFileSync(LEDGER_FILE, 'utf8');
} catch (e) {
  console.error(`could not read the ledger ${LEDGER_FILE}: ${e.message}`);
  process.exit(2);
}
const block = (name) => {
  const m = new RegExp(`export const ${name}: readonly \\w+\\[\\] = (\\[[\\s\\S]*?\\n\\]);`).exec(ledgerText);
  return m ? JSON.parse(m[1]) : undefined;
};
const SOURCES = block('LEDGER_SOURCES') ?? [];
const ROWS = block('LEDGER');
const DEFINITIONS = block('LEDGER_DEFINITIONS');
if (!ROWS) {
  console.error(`${LEDGER_FILE} has no LEDGER array in the generator's shape`);
  process.exit(2);
}

// ── --fetch: the pages the ledger cites, into a new temporary directory ──
if (FETCH) {
  PAGES = mkdtempSync(join(tmpdir(), 'kgauto-ledger-drift-'));
  const urls = [...new Set([...SOURCES.map((s) => s.url), ...(DEFINITIONS ?? []).map((d) => d.url)])];
  const times = {};
  for (const url of urls) {
    const file = pageFileOf(url);
    if (!file) continue;
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        console.log(`fetch ${url} ${at} HTTP ${res.status} — not saved`);
        continue;
      }
      writeFileSync(join(PAGES, file), buf);
      times[file] = at;
      console.log(`fetched ${url} ${at} ${buf.length} B sha256 ${createHash('sha256').update(buf).digest('hex')}`);
    } catch (e) {
      console.log(`fetch ${url} ${at} failed: ${e.message} — not saved`);
    }
  }
  writeFileSync(join(PAGES, 'read-times.json'), `${JSON.stringify(times, null, 2)}\n`);
  console.log(`pages saved in ${PAGES}`);
}

// ── the pages, read as the generator reads them ─────────────────────────
const cache = new Map();
/** The page's text for a URL, as the generator checks against it, or undefined when it was not saved. */
function pageText(url) {
  if (cache.has(url)) return cache.get(url);
  const file = pageFileOf(url);
  let text;
  if (file && existsSync(join(PAGES, file))) {
    const raw = readFileSync(join(PAGES, file), 'utf8');
    text = file.endsWith('.html') ? htmlToText(raw) : raw;
  }
  cache.set(url, text);
  return text;
}
const isGoogleTableRow = (r) => r.url === PAGE_URL.google && r.section !== undefined;
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** Is the quote on its page, by the generator's own check for that kind of row? */
function onPage(row, url, quote, asTableRow) {
  const text = pageText(url);
  if (text === undefined) return undefined;
  return asTableRow ? oneRowIn(googlePageRows(text), quote.split(' | ')) : quoteOn(text, quote);
}

const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1);
/**
 * The page's current line for a row's id: Google's table row in the ledger's own shape; else, in
 * order, a table line naming the row's display name (a `matchedBy: display-name` row), a table line
 * with the id in the same cell the quote had it in, any line with the id in backticks, any line
 * with the id as a word. Display only — whether the row moved is decided by the checks above.
 */
function currentLine(row) {
  const { url, id, quote } = row;
  const text = pageText(url);
  if (text === undefined) return undefined;
  if (url === PAGE_URL.google) {
    const r = googleTableRows(text).find((t) => (t.cells[0] ?? '').includes(`\`${id}\``));
    if (r) return `${googleRowCells(r).join(' | ')}   (${r.h2}${r.h3 ? ` › ${r.h3}` : ''})`;
  }
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = text.split('\n');
  const display = row.matchedBy === 'display-name' ? /\|\s*([A-Z][A-Za-z0-9.\- ]*?) \(`/.exec(quote)?.[1] : undefined;
  const cell = cellsOf(quote).findIndex((c) => c.includes(`\`${id}\``));
  const hit =
    (display ? lines.find((l) => l.startsWith('|') && l.includes(`${display} (\``)) : undefined) ??
    (cell !== -1 ? lines.find((l) => l.startsWith('|') && (cellsOf(l)[cell] ?? '').includes(`\`${id}\``)) : undefined) ??
    lines.find((l) => l.includes(`\`${id}\``)) ??
    lines.find((l) => new RegExp(`(^|[^A-Za-z0-9.-])${e}([^A-Za-z0-9-]|$)`).test(l));
  return hit ? flat(hit).slice(0, 400) : null;
}

const moved = [];
const notChecked = new Map(); // file → count
let checked = 0;
for (const r of ROWS) {
  const tests = [{ url: r.url, quote: r.quote, what: 'quote', table: isGoogleTableRow(r) }];
  if (r.note) tests.push({ url: r.url, quote: r.note, what: 'note', table: false });
  if (r.alsoUrl && r.alsoQuote) tests.push({ url: r.alsoUrl, quote: r.alsoQuote, what: 'also', table: false });
  const gone = [];
  let missing = false;
  for (const t of tests) {
    const ok = onPage(r, t.url, t.quote, t.table);
    if (ok === undefined) {
      const f = pageFileOf(t.url) ?? t.url;
      notChecked.set(f, (notChecked.get(f) ?? 0) + 1);
      missing = true;
    } else if (!ok) gone.push(t);
  }
  if (missing) continue;
  checked++;
  if (gone.length) moved.push({ r, gone });
}

let defsMoved = 0;
const defLines = [];
if (DEFINITIONS) {
  for (const d of DEFINITIONS) {
    const text = pageText(d.url);
    if (text === undefined) {
      const f = pageFileOf(d.url) ?? d.url;
      notChecked.set(f, (notChecked.get(f) ?? 0) + 1);
      continue;
    }
    if (!quoteOn(text, d.quote)) {
      defsMoved++;
      defLines.push(`MOVED definition ${d.provider} "${d.word}" — ${d.url}\n  ledger: ${d.quote}\n  page now: not on the page`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────
const readAt = SOURCES.map((s) => s.readAt).filter(Boolean).sort();
console.log(`ledger: ${LEDGER_FILE} — ${ROWS.length} rows, pages read ${readAt[0] ?? '?'}${readAt.length > 1 && readAt.at(-1) !== readAt[0] ? ` … ${readAt.at(-1)}` : ''}`);
let times = {};
try {
  times = JSON.parse(readFileSync(join(PAGES, 'read-times.json'), 'utf8'));
} catch {
  /* read-times.json is optional here */
}
const t = Object.values(times).sort();
console.log(`pages: ${PAGES}${t.length ? ` — read ${t[0]}${t.at(-1) !== t[0] ? ` … ${t.at(-1)}` : ''}` : ''}`);
console.log('');
for (const { r, gone } of moved) {
  console.log(`MOVED ${r.provider} ${r.id} — ${r.url}`);
  for (const g of gone) {
    const label = g.what === 'quote' ? 'ledger' : g.what === 'note' ? 'ledger note' : `ledger, also ${g.url}`;
    console.log(`  ${label} (read ${g.what === 'also' ? r.alsoReadOn ?? r.readOn : r.readOn}): ${flat(g.quote)}`);
  }
  const now = currentLine(r);
  console.log(`  page now: ${now ?? `the page no longer names \`${r.id}\``}`);
}
if (moved.length) console.log('');
for (const l of defLines) console.log(l);
console.log(DEFINITIONS ? `definitions: ${DEFINITIONS.length} checked` : 'definitions: none in this ledger file (written before 0.4.2)');
if (DEFINITIONS) console.log(`${defsMoved} definition${defsMoved === 1 ? '' : 's'} moved`);
for (const [f, n] of notChecked) console.log(`not checked: ${n} row(s) cite ${f}, which is not in ${PAGES}`);
const byProvider = {};
for (const { r } of moved) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
const per = Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(', ');
const skipped = [...notChecked.values()].reduce((a, b) => a + b, 0);
console.log(
  `${moved.length} row${moved.length === 1 ? '' : 's'} moved${per ? ` (${per})` : ''} — ${checked} rows checked of ${ROWS.length}` +
    (skipped ? `; ${ROWS.length - checked} not checked` : ''),
);
process.exitCode = moved.length || defsMoved ? 1 : notChecked.size ? 2 : 0;
