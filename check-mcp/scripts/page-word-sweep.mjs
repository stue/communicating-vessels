#!/usr/bin/env node
/**
 * page-word-sweep.mjs (0.4.7, R1) — for each ledger row that carries a `pageWord`, is that string verbatim in the saved
 * text of the page the row cites (or, where the row says so with `pageWordUrl`, of its second page)?
 *
 *   node scripts/page-word-sweep.mjs --pages <dir> [--ledger <file>]
 *
 * <dir> is a saved page set in the generator's file names (scripts/build-ledger.mjs's head lists them). --ledger defaults to
 * src/lifecycle-ledger.ts; any file in the generator's shape is read the same way (an older release's ledger included, whose
 * rows carry no `pageWordUrl` and no `ourWord`).
 *
 * The comparison is the generator's own (src/ledger-check.mjs `wordOn`): whitespace flattened and every markdown link
 * `[text](url)` reduced to its text, the same way on the page's text and on the string; then a plain substring test.
 * Read-only: nothing is fetched or written. Exit 0 when no row's pageWord is off its page, 1 when one is, 2 on a usage error
 * or a page the rows cite that is not in <dir> or is not the page this version reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFileOf, pageTextOf, pageShapeMisses, wordOn } from '../src/ledger-check.mjs';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const PAGES = arg('--pages');
const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = arg('--ledger') ?? join(HERE, '..', 'src', 'lifecycle-ledger.ts');
if (!PAGES) {
  console.error('usage: node scripts/page-word-sweep.mjs --pages <dir> [--ledger <file>]');
  process.exit(2);
}
const m = /export const LEDGER: readonly \w+\[\] = (\[[\s\S]*?\n\]);/.exec(readFileSync(LEDGER_FILE, 'utf8'));
if (!m) {
  console.error(`${LEDGER_FILE} has no LEDGER array in the generator's shape`);
  process.exit(2);
}
const ROWS = JSON.parse(m[1]);

const texts = new Map();
const stops = [];
function textOf(url) {
  if (texts.has(url)) return texts.get(url);
  const file = pageFileOf(url);
  let text;
  if (!file || !existsSync(join(PAGES, file))) stops.push(`${url} is not in ${PAGES}`);
  else {
    text = pageTextOf(file, readFileSync(join(PAGES, file), 'utf8'));
    const missing = pageShapeMisses(file, text);
    if (missing.length) {
      stops.push(`${file} is not the page this version reads — it lacks ${missing.join('; ')}`);
      text = undefined;
    }
  }
  texts.set(url, text);
  return text;
}

const onPage = [];
const onSecondSaid = [];
const onSecondOnly = [];
const onNeither = [];
let withWord = 0;
let ours = 0;
for (const r of ROWS) {
  if (r.ourWord !== undefined) ours++;
  if (r.pageWord === undefined) continue;
  withWord++;
  const own = textOf(r.url);
  const second = r.alsoUrl && r.alsoUrl !== r.url ? textOf(r.alsoUrl) : undefined;
  if (own === undefined) continue;
  // a row that says its word is on its second page is held to that page; any other row to its own
  if (r.pageWordUrl !== undefined && r.pageWordUrl !== r.url) {
    const t = textOf(r.pageWordUrl);
    if (t !== undefined && wordOn(t, r.pageWord)) onSecondSaid.push(r);
    else onNeither.push(r);
    continue;
  }
  if (wordOn(own, r.pageWord)) onPage.push(r);
  else if (second !== undefined && wordOn(second, r.pageWord)) onSecondOnly.push(r);
  else onNeither.push(r);
}
if (stops.length) {
  for (const s of [...new Set(stops)]) console.error(`stop: ${s}`);
  process.exit(2);
}
const show = (r) => `${r.provider} ${r.id}: ${JSON.stringify(r.pageWord)}`;
for (const r of onSecondOnly) console.log(`on its second page only, the row not saying so: ${show(r)} — ${r.alsoUrl}`);
for (const r of onNeither) console.log(`on neither page: ${show(r)} — ${r.url}`);
console.log(`ledger: ${LEDGER_FILE} — ${ROWS.length} rows`);
console.log(
  `comparison: wordOn (src/ledger-check.mjs) — whitespace flattened and each markdown link [text](url) reduced to its text (a link's dangling end "](url)" dropped), on the page's text and on the string alike, then a substring test`,
);
console.log(`rows with a pageWord: ${withWord}`);
console.log(`  on the row's own page: ${onPage.length}`);
console.log(`  on its second page, the row saying which (pageWordUrl): ${onSecondSaid.length}`);
console.log(`  on its second page only, the row not saying so: ${onSecondOnly.length}`);
console.log(`  on neither page: ${onNeither.length}`);
console.log(`rows without a pageWord: ${ROWS.length - withWord}`);
console.log(`moved to our own field: ${ours}`);
const off = onSecondOnly.length + onNeither.length;
console.log(`rows with a pageWord not on its page: ${off}`);
process.exitCode = off ? 1 : 0;
