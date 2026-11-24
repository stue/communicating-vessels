#!/usr/bin/env node
/**
 * ledger-drift.mjs (0.4.2, R2) — can be run on any day: for each row of the lifecycle ledger, is the
 * line it quotes still on the page it cites? Read-only. It uses the generator's own checks — since
 * 0.4.3 in the package's source (src/ledger-check.mjs: `rowTests` for what a row rests on,
 * `quoteStands` — `oneRowIn` for a Google table row, `quoteOn` for every other quote), the same
 * functions the shipped check reads its pages with at run time — never a second matcher.
 *
 *   node scripts/ledger-drift.mjs --pages <dir> [--ledger <file>]
 *   node scripts/ledger-drift.mjs --fetch [--discard-pages] [--ledger <file>]
 *
 * <dir> holds the pages under the names scripts/build-ledger.mjs reads (its head lists them).
 * --ledger defaults to src/lifecycle-ledger.ts; any file in the generator's shape is read the same
 * way (e.g. `git show <sha>:check-mcp/src/lifecycle-ledger.ts > old.ts`).
 * --fetch fetches the pages the ledger cites into a new temporary directory (mkdtemp) first and
 * prints each URL with its UTC time, bytes and sha256, then `pages saved in <dir>`; without it
 * nothing is fetched.
 * --discard-pages (Amendment A1, 0.4.3): with --fetch, when the run is clean (exit 0: nothing moved,
 * every row checked), the folder this run created with mkdtemp is removed and one line,
 * `pages removed (clean run)`, is printed before the final summary line — the last line stays
 * `N rows moved — M rows checked of M` and the exit codes are unchanged. On exit 1 or 2 the folder is
 * kept. A directory passed with --pages <dir> is never removed, with or without the flag. Without the
 * flag nothing changes.
 * Test seam (no network in a test): with KGAUTO_LEDGER_DRIFT_FETCH_FROM=<dir>, --fetch copies the pages
 * and their read times from <dir> instead of requesting them; everything else about --fetch is the same.
 * 0.4.6 (R5): a file named in <dir>/statuses.json ({ "<file>": <HTTP status> }) answers that status instead of
 * being copied, as a page that did not answer does.
 *
 * Checked per row: its `quote` on its `url`, its `note` on the same page, its `alsoQuote` on its
 * `alsoUrl`; and each definition the card quotes (LEDGER_DEFINITIONS, since 0.4.2) on its page.
 * 0.4.3 (R3): a page whose shape is not the one this version reads (src/ledger-check.mjs, PAGE_SHAPES)
 * is treated as not saved: its rows are not checked, and the missing piece is printed.
 * Prints every row that is not on its page, with the page's current line for that id when there
 * is one, then `N rows moved`.
 * 0.4.6 (R5): `page now:` is every line of the page that carries the id, the row in the table the ledger's
 * line came from first (until 0.4.5: one line, a line with the id in backticks preferred, so an Anthropic
 * status row was shown as its history row); and the summary line names each page that was not saved, with
 * its status (`HTTP 404`, a failed request, not the page this version reads, not in the folder).
 * Exit 0: nothing moved and every row was checked · 1: a row or a definition moved · 2: a page
 * was not saved (or not the page this version reads), so some rows were not checked (never reported
 * as 0 moved), or a usage error.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_URL, pageFileOf, pageTextOf, pageShapeMisses, rowTests, quoteStands, quoteOn, googleTableRows, googleRowCells } from '../src/ledger-check.mjs';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = arg('--ledger') ?? join(HERE, '..', 'src', 'lifecycle-ledger.ts');
const FETCH = args.includes('--fetch');
const DISCARD = args.includes('--discard-pages');
let PAGES = arg('--pages');
if (!PAGES && !FETCH) {
  console.error('usage: node scripts/ledger-drift.mjs --pages <dir> [--ledger <file>]   |   --fetch [--discard-pages] [--ledger <file>]');
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
/** The folder this run created itself (Amendment A1: the only folder --discard-pages may remove). */
let CREATED;
/** 0.4.6 (R5): file → why the page was not saved in this run (its HTTP status, or the failed request). */
const unsaved = new Map();
if (FETCH) {
  PAGES = mkdtempSync(join(tmpdir(), 'kgauto-ledger-drift-'));
  CREATED = PAGES;
  const urls = [...new Set([...SOURCES.map((s) => s.url), ...(DEFINITIONS ?? []).map((d) => d.url)])];
  const times = {};
  const seam = process.env.KGAUTO_LEDGER_DRIFT_FETCH_FROM;
  const seamTimes = seam ? JSON.parse(readFileSync(join(seam, 'read-times.json'), 'utf8')) : {};
  const seamStatus = seam && existsSync(join(seam, 'statuses.json')) ? JSON.parse(readFileSync(join(seam, 'statuses.json'), 'utf8')) : {};
  for (const url of urls) {
    const file = pageFileOf(url);
    if (!file) continue;
    if (seam) {
      if (seamStatus[file] !== undefined) {
        console.log(`fetch ${url} (test seam) HTTP ${seamStatus[file]} — not saved`);
        unsaved.set(file, `HTTP ${seamStatus[file]}`);
        continue;
      }
      if (!existsSync(join(seam, file))) {
        console.log(`copy ${file} — not in ${seam} (test seam), not saved`);
        unsaved.set(file, `not in ${seam} (test seam)`);
        continue;
      }
      copyFileSync(join(seam, file), join(PAGES, file));
      times[file] = seamTimes[file];
      console.log(`copied ${file} from ${seam} (test seam)`);
      continue;
    }
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        console.log(`fetch ${url} ${at} HTTP ${res.status} — not saved`);
        unsaved.set(file, `HTTP ${res.status}`);
        continue;
      }
      writeFileSync(join(PAGES, file), buf);
      times[file] = at;
      console.log(`fetched ${url} ${at} ${buf.length} B sha256 ${createHash('sha256').update(buf).digest('hex')}`);
    } catch (e) {
      console.log(`fetch ${url} ${at} failed: ${e.message} — not saved`);
      unsaved.set(file, `the request failed: ${e.message}`);
    }
  }
  writeFileSync(join(PAGES, 'read-times.json'), `${JSON.stringify(times, null, 2)}\n`);
  console.log(`pages saved in ${PAGES}`);
}

// ── the pages, read as the generator reads them ─────────────────────────
const cache = new Map();
/** file → the pieces of its shape it lacks (0.4.3, R3) */
const notThePage = new Map();
/** The page's text for a URL, as the generator checks against it, or undefined when it was not saved or is not the page this version reads. */
function pageText(url) {
  if (cache.has(url)) return cache.get(url);
  const file = pageFileOf(url);
  let text;
  if (file && existsSync(join(PAGES, file))) {
    text = pageTextOf(file, readFileSync(join(PAGES, file), 'utf8'));
    const missing = pageShapeMisses(file, text);
    if (missing.length) {
      notThePage.set(file, missing);
      text = undefined;
    }
  }
  cache.set(url, text);
  return text;
}
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 0.4.6 (R5): the page's current lines for a row's id — every line of the page that carries it, the one that decides
 * first: Google's table rows in the ledger's own shape; else a table line naming the row's display name (a
 * `matchedBy: display-name` row), then the table lines with the id in the same cell the quote had it in (in backticks
 * or bare, as Anthropic's status table writes it), then every other line with the id in backticks or as a word, in
 * page order. Display only — whether the row moved is decided by the checks above. (Until 0.4.5: one line, a line with
 * the id in backticks before a bare one, so Anthropic's status row was shown as its history row.)
 */
const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1);
function currentLines(row) {
  const { url, id, quote } = row;
  const text = pageText(url);
  if (text === undefined) return undefined;
  const out = [];
  const add = (l) => {
    const f = flat(l).slice(0, 400);
    if (!out.includes(f)) out.push(f);
  };
  if (url === PAGE_URL.google) {
    for (const r of googleTableRows(text).filter((t) => (t.cells[0] ?? '').includes(`\`${id}\``)))
      add(`${googleRowCells(r).join(' | ')}   (${r.h2}${r.h3 ? ` › ${r.h3}` : ''})`);
  }
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`(^|[^A-Za-z0-9.-])${e}([^A-Za-z0-9-]|$)`);
  const lines = text.split('\n');
  const display = row.matchedBy === 'display-name' ? /\|\s*([A-Z][A-Za-z0-9.\- ]*?) \(`/.exec(quote)?.[1] : undefined;
  const inCell = (c) => c.trim() === id || c.includes(`\`${id}\``);
  const cell = cellsOf(quote).findIndex(inCell);
  if (display) for (const l of lines.filter((l) => l.startsWith('|') && l.includes(`${display} (\``))) add(l);
  if (cell !== -1) for (const l of lines.filter((l) => l.startsWith('|') && inCell(cellsOf(l)[cell] ?? ''))) add(l);
  for (const l of lines.filter((l) => l.includes(`\`${id}\``) || word.test(l))) add(l);
  return out;
}

const moved = [];
const notChecked = new Map(); // file → count
let checked = 0;
for (const r of ROWS) {
  const gone = [];
  let missing = false;
  for (const t of rowTests(r)) {
    const text = pageText(t.url);
    if (text === undefined) {
      const f = pageFileOf(t.url) ?? t.url;
      notChecked.set(f, (notChecked.get(f) ?? 0) + 1);
      missing = true;
    } else if (!quoteStands(text, t.quote, t.table)) gone.push(t);
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
const t = Object.values(times).filter(Boolean).sort();
console.log(`pages: ${PAGES}${t.length ? ` — read ${t[0]}${t.at(-1) !== t[0] ? ` … ${t.at(-1)}` : ''}` : ''}`);
console.log('');
for (const { r, gone } of moved) {
  console.log(`MOVED ${r.provider} ${r.id} — ${r.url}`);
  for (const g of gone) {
    const label = g.what === 'quote' ? 'ledger' : g.what === 'note' ? 'ledger note' : `ledger, also ${g.url}`;
    console.log(`  ${label} (read ${g.what === 'also' ? r.alsoReadOn ?? r.readOn : r.readOn}): ${flat(g.quote)}`);
  }
  const now = currentLines(r) ?? [];
  if (now.length === 0) console.log(`  page now: the page no longer names \`${r.id}\``);
  for (const l of now) console.log(`  page now: ${l}`);
}
if (moved.length) console.log('');
for (const l of defLines) console.log(l);
console.log(DEFINITIONS ? `definitions: ${DEFINITIONS.length} checked` : 'definitions: none in this ledger file (written before 0.4.2)');
if (DEFINITIONS) console.log(`${defsMoved} definition${defsMoved === 1 ? '' : 's'} moved`);
for (const [f, n] of notChecked) {
  const odd = notThePage.get(f);
  console.log(
    odd
      ? `not checked: ${n} row(s) cite ${f}, which is not the page this version reads (it lacks ${odd.join('; ')})`
      : f.includes('://')
        ? `not checked: ${n} row(s) cite ${f}, which is not an address this version reads` // 0.4.6 (R5): e.g. an older ledger's address
        : `not checked: ${n} row(s) cite ${f}, which is not in ${PAGES}`,
  );
}
const byProvider = {};
for (const { r } of moved) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
const per = Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(', ');
const skipped = [...notChecked.values()].reduce((a, b) => a + b, 0);
// 0.4.6 (R5): each page not saved, by its address, with its status
const urlOfFile = (f) =>
  [...SOURCES.map((s) => s.url), ...(DEFINITIONS ?? []).map((d) => d.url), ...ROWS.flatMap((r) => rowTests(r).map((t) => t.url))].find((u) => pageFileOf(u) === f) ?? f;
const notSaved = [...notChecked.keys()].map(
  (f) =>
    `${urlOfFile(f)} (${unsaved.get(f) ?? (notThePage.has(f) ? 'not the page this version reads' : f.includes('://') ? 'not an address this version reads' : `not in ${PAGES}`)})`,
);
const code = moved.length || defsMoved ? 1 : notChecked.size ? 2 : 0;
// Amendment A1: a clean run removes the folder it created itself; the summary stays the last line.
if (DISCARD && CREATED && code === 0) {
  rmSync(CREATED, { recursive: true, force: true });
  console.log('pages removed (clean run)');
}
console.log(
  `${moved.length} row${moved.length === 1 ? '' : 's'} moved${per ? ` (${per})` : ''} — ${checked} rows checked of ${ROWS.length}` +
    (skipped ? `; ${ROWS.length - checked} not checked — ${notSaved.length === 1 ? 'a page was' : `${notSaved.length} pages were`} not saved: ${notSaved.join('; ')}` : ''),
);
process.exitCode = code;
