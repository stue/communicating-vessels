#!/usr/bin/env node
/**
 * table-sweep.mjs (0.4.6, R6) — the check, run on every model id of each provider's deprecation tables.
 *
 *   npm run build && node scripts/table-sweep.mjs --pages <dir>
 *
 * <dir> is a saved page set in the generator's file names, with its read-times.json (the folder the ledger was built
 * from, or one saved by `scripts/ledger-drift.mjs --fetch`). The ids are read from the saved pages' tables by the
 * generator's own parsers (src/ledger-check.mjs `tableIds`: Anthropic's status and history tables, OpenAI's upcoming
 * and past deprecations, Google's deprecations tables), never from the ledger, so a row the generator skipped is still
 * reached. Each id is run through the built engine alone, on the provider's own API, in code that runs, with those
 * pages as the read. An id the card prints no line about from the page its table is on (a line whose basis names that
 * page: a line taken only from the catalog's record of the model does not count), or calls "not recognised", is
 * printed with its table and its row; a second row for an id already seen on the same page is counted and printed, not
 * skipped. Read-only: nothing is fetched or written.
 *
 * Last line: `ids on tables: N · without a line: n · not recognised: n`. Exit 0 when both n are 0; 1 when either is
 * not; 2 on a usage error or a page that is missing or not the page this version reads.
 * 0.4.7 (R3, Amendment A3): each second row is also run, and the line before the summary's group says how many are said
 * on the card (`second rows said on the card: N of N`, a line about the id that quotes the second row under its heading);
 * one not said makes the exit 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGE_URL, pageTextOf, pageShapeMisses, tableIds } from '../src/ledger-check.mjs';

/** The pages with tables: the provider whose they are, the saved file, and the page's address. */
export const TABLE_PAGES = [
  ['anthropic', 'anthropic-deprecations.md', PAGE_URL.anthropic],
  ['openai', 'openai-deprecations.md', PAGE_URL.openai],
  ['google', 'google-deprecations.html', PAGE_URL.google],
];

/**
 * The sweep itself, on an engine passed in (the script passes the build's; a test passes the source's).
 * @param {string} dir the saved page set
 * @param {{ runCheck: Function, pages: object }} engine `runCheck` and the read of `dir` (`readPagesFromDir(dir)`)
 */
export function sweep(dir, engine) {
  const perPage = [];
  const stops = [];
  const seen = new Map(); // provider|id → the first row
  const ids = [];
  const seconds = [];
  for (const [provider, file, url] of TABLE_PAGES) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      stops.push(`${file} is not in ${dir}`);
      continue;
    }
    const text = pageTextOf(file, readFileSync(path, 'utf8'));
    const missing = pageShapeMisses(file, text);
    if (missing.length) {
      stops.push(`${file} is not the page this version reads — it lacks ${missing.join('; ')}`);
      continue;
    }
    const rows = tableIds(file, text);
    perPage.push({ provider, file, rows: rows.length, ids: new Set(rows.map((r) => r.id)).size, feature: rows.filter((r) => r.kind === 'feature').length });
    for (const r of rows) {
      const key = `${provider}|${r.id}`;
      const first = seen.get(key);
      if (first) {
        seconds.push({ provider, ...r, first });
        continue;
      }
      seen.set(key, r);
      ids.push({ provider, url, ...r });
    }
  }
  if (stops.length) return { stops, perPage, ids, seconds, withoutLine: [], notRecognised: [] };
  const withoutLine = [];
  const notRecognised = [];
  const linesOf = (id) => {
    const extract = { project: { name: 'table-sweep' }, callSites: [], models: [{ model: id, where: 'table-sweep', platform: 'provider-api', context: 'runs' }] };
    return engine.runCheck(extract, { pages: engine.pages }).findings.filter((f) => f.confidence !== 'measurable-only');
  };
  for (const t of ids) {
    const lines = linesOf(t.id);
    if (lines.some((f) => /was not recognised$/.test(f.title))) notRecognised.push(t);
    else if (!lines.some((f) => f.basis.includes(t.url))) withoutLine.push(t);
  }
  // 0.4.7 (R3, Amendment A3): a second row is said on the card — a line about the id that names the second row's heading
  // in the sentence the card adds for it ("… is on two rows of …: … the second, under its heading “<heading>”, reads …")
  const said = [];
  const unsaid = [];
  for (const s of seconds) {
    const heading = s.table.replace(/^## /, '').split(' › ').at(-1);
    const lines = linesOf(s.id);
    (lines.some((f) => (f.detail ?? "").includes(`\`${s.id}\` is on two rows of`) && (f.detail ?? "").includes(`under its heading “${heading}”`)) ? said : unsaid).push(s);
  }
  return { stops, perPage, ids, seconds, said, unsaid, withoutLine, notRecognised };
}

/** The report, as the script prints it; the last line is the summary. */
export function report(dir, r) {
  const out = [];
  if (r.stops.length) {
    for (const s of r.stops) out.push(`stop: ${s}`);
    return out;
  }
  let times = {};
  try {
    times = JSON.parse(readFileSync(join(dir, 'read-times.json'), 'utf8'));
  } catch {
    /* the read times are printed when the folder has them */
  }
  const at = TABLE_PAGES.map(([, f]) => times[f]).filter(Boolean).sort();
  out.push(`pages: ${dir}${at.length ? ` — read ${at[0]}${at.at(-1) !== at[0] ? ` … ${at.at(-1)}` : ''}` : ''}`);
  for (const p of r.perPage)
    out.push(`${p.file}: ${p.rows} ids on its table rows, ${p.ids} distinct${p.feature ? `; ${p.feature} of them inside a cell that names a feature, not a model` : ''}`);
  for (const s of r.seconds) out.push(`second row: ${s.provider} ${s.id} — ${s.table}: ${s.line}   (first: ${s.first.table}: ${s.first.line})`);
  out.push(`second rows: ${r.seconds.length}`);
  // 0.4.7 (R3, Amendment A3): each second row not said on the card, then the count said
  for (const s of r.unsaid ?? []) out.push(`second row not said on the card: ${s.provider} ${s.id} — ${s.table}: ${s.line}`);
  out.push(`second rows said on the card: ${(r.said ?? []).length} of ${r.seconds.length}`);
  for (const t of r.withoutLine) out.push(`without a line: ${t.provider} ${t.id} — ${t.table}: ${t.line}`);
  for (const t of r.notRecognised) out.push(`not recognised: ${t.provider} ${t.id} — ${t.table}: ${t.line}`);
  out.push(`ids on tables: ${r.ids.length} · without a line: ${r.withoutLine.length} · not recognised: ${r.notRecognised.length}`);
  return out;
}

export const exitCode = (r) => (r.stops.length ? 2 : r.withoutLine.length || r.notRecognised.length || (r.unsaid ?? []).length ? 1 : 0);

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--pages');
  const dir = i === -1 ? undefined : args[i + 1];
  if (!dir || dir.startsWith('--')) {
    console.error('usage: node scripts/table-sweep.mjs --pages <dir>   (after npm run build)');
    process.exitCode = 2;
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const { runCheck, readPagesFromDir } = await import(pathToFileURL(join(here, '../dist/index.js')).href);
  let pages;
  try {
    pages = readPagesFromDir(dir);
  } catch (e) {
    console.error(`stop: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const r = sweep(dir, { runCheck, pages });
  for (const l of report(dir, r)) console.log(l);
  process.exitCode = exitCode(r);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
