/**
 * 0.4.2 (R2) — the drift check: for each ledger row, is its quoted line still on the page it cites?
 * Run as the CLI it is (`node scripts/ledger-drift.mjs --pages <dir> --ledger <file>`) on two small
 * saved pages (tests/fixtures/drift/, made-up ids in the shape of Google's and Anthropic's pages) and
 * ledgers written here in the generator's own shape. Every case that must print `0 rows moved` is
 * beside a case on the same pages that must not.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
// 0.4.3 Amendment B3: the folders these tests make are inside ROOT, removed when the file is done.
const ROOT = mkdtempSync(join(tmpdir(), 'ledger-drift-test-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const SCRIPT = join(PKG, 'scripts/ledger-drift.mjs');
const PAGES = join(PKG, 'tests/fixtures/drift');
const G = 'https://aistudio.google.com/docs/deprecations';
const A = 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md';
const D = 'https://api-docs.deepseek.com/updates';

type Row = Record<string, string>;
const grow = (id: string, released: string, date: string, repl: string): Row => ({
  id,
  provider: 'google',
  word: 'scheduled for shutdown',
  pageWord: `shutdown date ${date}, no deprecation word on either page`,
  shutdownFloor: '2026-11-17',
  dateText: date,
  replacement: repl,
  url: G,
  readOn: '2026-11-12',
  section: 'Gemini 9 models',
  quote: [`\`${id}\``, released, date, `\`${repl}\``].join(' | '),
});
const STEADY = grow('gemini-steady', 'May 1, 2026', 'May 1, 2027', 'gemini-steady-2');
const CLAUDE: Row = {
  id: 'claude-steady-1',
  provider: 'anthropic',
  word: 'retired',
  pageWord: 'Retired',
  url: A,
  readOn: '2026-11-12',
  quote: '| claude-steady-1   | Retired       | May 1, 2026  | June 1, 2026              |',
};
const DEFS = [
  { provider: 'anthropic', word: 'retired', url: A, quote: 'The model is no longer available for use. Requests to retired models fail.' },
  { provider: 'google', word: 'shut down', url: G, quote: 'it is completely turned off, and the endpoint is no longer available.' },
];

/** A ledger file in the shape scripts/build-ledger.mjs writes. */
function ledgerFile(rows: Row[], defs: object[] | null = DEFS): string {
  const dir = mkdtempSync(join(ROOT, 'drift-test-'));
  const f = join(dir, 'lifecycle-ledger.ts');
  const sources = [
    { provider: 'anthropic', url: A, readAt: '2026-11-12T06:20:55Z', sha256: '0'.repeat(64) },
    { provider: 'google', url: G, readAt: '2026-11-12T06:20:56Z', sha256: '0'.repeat(64) },
  ];
  writeFileSync(
    f,
    `/** GENERATED (test) */\nimport type { LedgerRow, LedgerSource, LedgerDefinition } from './lifecycle-types.js';\n\n` +
      `export const LEDGER_SOURCES: readonly LedgerSource[] = ${JSON.stringify(sources, null, 2)};\n\n` +
      (defs ? `export const LEDGER_DEFINITIONS: readonly LedgerDefinition[] = ${JSON.stringify(defs, null, 2)};\n\n` : '') +
      `export const LEDGER: readonly LedgerRow[] = ${JSON.stringify(rows, null, 2)};\n`,
  );
  return f;
}
function drift(ledger: string, pages = PAGES) {
  const r = spawnSync(process.execPath, [SCRIPT, '--pages', pages, '--ledger', ledger], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('R2 — ledger-drift.mjs', () => {
  it('an unchanged ledger: every quoted line is on its page, exit 0, "0 rows moved"', () => {
    const r = drift(ledgerFile([STEADY, CLAUDE]));
    expect(r.out).toMatch(/^0 rows moved\b/m);
    expect(r.out).toContain('2 rows checked');
    expect(r.code).toBe(0);
  });

  it('a moved date: the row is printed with the page line now, and the run exits 1', () => {
    const r = drift(ledgerFile([STEADY, CLAUDE, grow('gemini-moved', 'February 26, 2026', 'November 17, 2026', 'gemini-moved-2')]));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^1 rows? moved\b/m);
    expect(r.out).toContain('gemini-moved');
    expect(r.out).toContain('`gemini-moved` | February 26, 2026 | November 17, 2026 | `gemini-moved-2`');
    expect(r.out).toContain('`gemini-moved` | February 26, 2026 | December 18, 2026 | `gemini-moved-2`');
    expect(r.out).not.toMatch(/MOVED\s+google\s+gemini-steady/);
  });

  it('a withdrawn date: the page now says no shutdown date is announced, and the line shows it', () => {
    const r = drift(ledgerFile([STEADY, grow('gemini-withdrawn', 'March 11, 2026', 'November 17, 2026', 'gemini-withdrawn-2')]));
    expect(r.code).toBe(1);
    expect(r.out).toContain('`gemini-withdrawn` | March 11, 2026 | No shutdown date announced | `gemini-withdrawn-2`');
  });

  it('a row gone from the page: printed, with a sentence that the page no longer names the id', () => {
    const r = drift(ledgerFile([STEADY, grow('gemini-gone', 'May 1, 2025', 'November 17, 2026', 'gemini-steady')]));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gemini-gone[\s\S]*the page no longer names `gemini-gone`/);
  });

  it("the generator's one-row check: a row whose cells stand on the page in two different rows has moved", () => {
    // every cell is on the page, in order, but the date and replacement belong to gemini-stitch-b's row
    const stitched = { ...grow('gemini-stitch-a', 'June 1, 2026', 'July 1, 2027', 'gemini-stitch-b-2') };
    const r = drift(ledgerFile([STEADY, stitched]));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/MOVED\s+google\s+gemini-stitch-a/);
    expect(r.out).toContain('`gemini-stitch-a` | June 1, 2026 | June 1, 2027 | `gemini-stitch-a-2`');
  });

  it('a row whose page was not saved is not checked, and the run does not say 0 rows moved (exit 2)', () => {
    const r = drift(ledgerFile([STEADY, { ...CLAUDE, id: 'deepseek-x', provider: 'deepseek', url: D, quote: 'A sentence.' }]));
    expect(r.code).toBe(2);
    expect(r.out).toContain('deepseek-updates.html');
    expect(r.out).not.toMatch(/^0 rows moved\.?$/m);
  });

  it('a definition the card quotes that is no longer on its page counts as moved (exit 1)', () => {
    const defs = [...DEFS, { provider: 'anthropic', word: 'deprecated', url: A, quote: 'A sentence this page does not carry.' }];
    const r = drift(ledgerFile([STEADY, CLAUDE], defs));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^1 definitions? moved/m);
    expect(r.out).toMatch(/^0 rows moved\b/m);
  });

  it('a ledger written before definitions were in it (0.4.1) says so and checks its rows', () => {
    const r = drift(ledgerFile([STEADY, CLAUDE], null));
    expect(r.out).toContain('definitions: none in this ledger file');
    expect(r.code).toBe(0);
  });

  it('it fetches nothing without --fetch: pages are read only from --pages', () => {
    const dir = mkdtempSync(join(ROOT, 'drift-pages-'));
    cpSync(join(PAGES, 'google-deprecations.html'), join(dir, 'google-deprecations.html'));
    const r = drift(ledgerFile([STEADY, CLAUDE]), dir);
    expect(r.code).toBe(2); // the Anthropic page is not in dir, so its row is not checked
    expect(r.out).toContain('anthropic-deprecations.md');
  });
});

// ── 0.4.6 (R5): the drift check says which page did not answer, and shows the row that decides ──
describe('0.4.6 R5 — ledger-drift.mjs names the page not saved, and prints every line that carries the id', () => {
  it('a moved status row: `page now:` prints the status table’s row first, then the history row', () => {
    const moved = { ...CLAUDE, word: 'deprecated', pageWord: 'Deprecated', quote: '| claude-steady-1   | Deprecated    | May 1, 2026  | June 1, 2026              |' };
    const r = drift(ledgerFile([STEADY, moved]));
    expect(r.code).toBe(1);
    const now = r.out.split('\n').filter((l) => l.startsWith('  page now: '));
    expect(now).toEqual([
      '  page now: | claude-steady-1 | Retired | May 1, 2026 | June 1, 2026 |',
      '  page now: | June 1, 2026 | `claude-steady-1` | `claude-steady-2` |',
    ]);
  });

  it('the row in the quote’s own table comes first, before a line above it on the page that names the id too', () => {
    const dir = mkdtempSync(join(ROOT, 'drift-pages-'));
    for (const f of readdirSync(PAGES)) cpSync(join(PAGES, f), join(dir, f));
    const page = join(dir, 'anthropic-deprecations.md');
    const text = readFileSync(page, 'utf8');
    writeFileSync(page, text.replace('## Model status', 'A sentence that names `claude-steady-1` above the tables.\n\n## Model status'));
    const moved = { ...CLAUDE, quote: '| claude-steady-1   | Deprecated    | May 1, 2026  | June 1, 2026              |' };
    const r = drift(ledgerFile([STEADY, moved]), dir);
    expect(r.out.split('\n').filter((l) => l.startsWith('  page now: '))).toEqual([
      '  page now: | claude-steady-1 | Retired | May 1, 2026 | June 1, 2026 |',
      '  page now: A sentence that names `claude-steady-1` above the tables.',
      '  page now: | June 1, 2026 | `claude-steady-1` | `claude-steady-2` |',
    ]);
  });

  it('a page not in the folder: the summary line names it by its address, and why', () => {
    const r = drift(ledgerFile([STEADY, { ...CLAUDE, id: 'deepseek-x', provider: 'deepseek', url: D, quote: 'A sentence.' }]));
    expect(r.code).toBe(2);
    expect(r.out.trim().split('\n').at(-1)).toBe(`0 rows moved — 1 rows checked of 2; 1 not checked — a page was not saved: ${D} (not in ${PAGES})`);
  });

  it('--fetch, a page that answers 404: the fetch line and the summary line both say HTTP 404', () => {
    const seam = mkdtempSync(join(ROOT, 'drift-seam-'));
    for (const f of readdirSync(PAGES)) cpSync(join(PAGES, f), join(seam, f));
    writeFileSync(join(seam, 'read-times.json'), JSON.stringify({ 'anthropic-deprecations.md': '2026-11-24T09:37:37Z', 'google-deprecations.html': '2026-11-24T09:37:38Z' }));
    writeFileSync(join(seam, 'statuses.json'), JSON.stringify({ 'anthropic-deprecations.md': 404 }));
    const r = spawnSync(process.execPath, [SCRIPT, '--fetch', '--ledger', ledgerFile([STEADY, CLAUDE])], {
      encoding: 'utf8',
      env: { ...process.env, KGAUTO_LEDGER_DRIFT_FETCH_FROM: seam, TMPDIR: ROOT },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(2);
    expect(out).toContain(`fetch ${A} (test seam) HTTP 404 — not saved`);
    expect(out.trim().split('\n').at(-1)).toBe(`0 rows moved — 1 rows checked of 2; 1 not checked — a page was not saved: ${A} (HTTP 404)`);
  });

  it('two pages not saved: both named, each with its own status', () => {
    const seam = mkdtempSync(join(ROOT, 'drift-seam-'));
    writeFileSync(join(seam, 'read-times.json'), '{}');
    writeFileSync(join(seam, 'statuses.json'), JSON.stringify({ 'anthropic-deprecations.md': 404, 'google-deprecations.html': 503 }));
    const r = spawnSync(process.execPath, [SCRIPT, '--fetch', '--ledger', ledgerFile([STEADY, CLAUDE])], {
      encoding: 'utf8',
      env: { ...process.env, KGAUTO_LEDGER_DRIFT_FETCH_FROM: seam, TMPDIR: ROOT },
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}`.trim().split('\n').at(-1)).toBe(`0 rows moved — 0 rows checked of 2; 2 not checked — 2 pages were not saved: ${G} (HTTP 503); ${A} (HTTP 404)`);
  });
});
