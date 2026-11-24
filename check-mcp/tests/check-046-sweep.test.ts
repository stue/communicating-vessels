/**
 * The check 0.4.6, R6 — the check is run on every id of each provider table (scripts/table-sweep.mjs). The ids are read
 * from the saved pages' tables by the generator's own parsers (src/ledger-check.mjs), never from the ledger; the engine
 * here is the source's, on a ledger the generator writes from the made-up page set (a module mock, so the made-up pages'
 * ids are the ledger's), and on that ledger with one table row left out. The bundled ledger's run on the pages it was
 * built from is the Verifier's V13 (the pages are not kept in this tree). Seen red on main c3a03df: no sweep, no parsers.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicStatusRows, anthropicHistoryRows, openaiTableRows, pageTextOf, tableIds } from '../src/ledger-check.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const ROOT = mkdtempSync(join(tmpdir(), 'check-046-sweep-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The generator's ledger for the made-up pages, parsed as ledger-drift.mjs parses a ledger file. */
function minLedger() {
  const out = join(ROOT, 'lifecycle-ledger.ts');
  const r = spawnSync(process.execPath, [join(PKG, 'scripts/build-ledger.mjs'), '--pages', MIN, '--out', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`generator failed: ${r.stderr}`);
  const text = readFileSync(out, 'utf8');
  const block = (name: string) => JSON.parse(new RegExp(`export const ${name}: readonly \\w+\\[\\] = (\\[[\\s\\S]*?\\n\\]);`).exec(text)![1]!);
  return { LEDGER: block('LEDGER'), LEDGER_SOURCES: block('LEDGER_SOURCES'), LEDGER_DEFINITIONS: block('LEDGER_DEFINITIONS') };
}
const MIN_LEDGER = minLedger();

/** The sweep, with the source's engine on a ledger: the whole made-up one, or that one without the row for `drop`. */
async function sweepWith(drop?: string) {
  vi.resetModules();
  vi.doMock('../src/lifecycle-ledger.js', () => ({ ...MIN_LEDGER, LEDGER: MIN_LEDGER.LEDGER.filter((r: { id: string }) => r.id !== drop) }));
  const { runCheck } = await import('../src/engine.js');
  const { readPagesFromDir } = await import('../src/pages.js');
  // @ts-expect-error a plain .mjs script with no declarations; its exports are read as the script prints them
  const { sweep, report, exitCode } = await import('../scripts/table-sweep.mjs');
  const r = sweep(MIN, { runCheck, pages: readPagesFromDir(MIN) });
  return { r, lines: report(MIN, r) as string[], code: exitCode(r) as number };
}

describe('R6 — the parsers the generator reads its tables with are exported, and read the ids the tables carry', () => {
  const page = (f: string) => pageTextOf(f, readFileSync(join(MIN, f), 'utf8'));
  it('Anthropic: the status table and the history tables, row by row', () => {
    expect(anthropicStatusRows(page('anthropic-deprecations.md')).map((r) => [r.id, r.state])).toEqual([
      ['claude-mini-1', 'Retired'],
      ['claude-mini-2', 'Active'],
    ]);
    expect(anthropicHistoryRows(page('anthropic-deprecations.md')).map((r) => [r.id, r.replacement, r.section])).toEqual([['claude-mini-1', 'claude-mini-2', '2026-05-01: Claude Mini 1 model']]);
  });
  it('OpenAI: every data row of the two deprecations tables, with its header', () => {
    const rows = openaiTableRows(page('openai-deprecations.md'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['upcoming', 'past']).toContain(r.part);
      expect(r.header).toContain('shutdown date');
    }
  });
  it('tableIds: every id on the three pages with tables, and none on a page without', () => {
    const all = ['anthropic-deprecations.md', 'openai-deprecations.md', 'google-deprecations.html'].flatMap((f) => tableIds(f, page(f)).map((t) => t.id));
    expect(all).toEqual(expect.arrayContaining(['claude-mini-1', 'claude-mini-2', 'gemini-mini-a', 'gemini-mini-c']));
    expect(tableIds('google-changelog.html', page('google-changelog.html'))).toEqual([]);
    expect(tableIds('deepseek-updates.html', page('deepseek-updates.html'))).toEqual([]);
  });
});

describe('R6 — the sweep: every table id gets a line and none is “not recognised”, or the script says which and exits non-zero', () => {
  it('on the ledger built from those pages: both counts 0, exit 0, the summary last', async () => {
    const { r, lines, code } = await sweepWith();
    const ids = new Set(['anthropic-deprecations.md', 'openai-deprecations.md', 'google-deprecations.html'].flatMap((f) => tableIds(f, pageTextOf(f, readFileSync(join(MIN, f), 'utf8'))).map((t) => t.id)));
    expect(r.ids.length).toBe(ids.size);
    expect(lines.at(-1)).toBe(`ids on tables: ${ids.size} · without a line: 0 · not recognised: 0`);
    expect(code).toBe(0);
  });

  it('with one table row left out of the ledger: the id is named, and the exit is non-zero', async () => {
    const { lines, code } = await sweepWith('gemini-mini-c');
    expect(lines).toContainEqual(expect.stringMatching(/^not recognised: google gemini-mini-c — ## Gemini 9 models: `gemini-mini-c` \| March 1, 2026 \| No shutdown date announced/));
    expect(lines.at(-1)).toMatch(/ · not recognised: 1$/);
    expect(code).toBe(1);
  });

  it('an Active id the catalog also calls active, with a far floor, gets a line (until 0.4.6 it got none)', async () => {
    vi.resetModules();
    vi.doUnmock('../src/lifecycle-ledger.js');
    const { runCheck } = await import('../src/engine.js');
    const { READ } = await import('./helpers/read.js');
    // Amendment B1: the line prints the page's own cell (until fix pass 1: "is Active on Anthropic's model deprecations
    // page — No retirement is announced for it.", which said what the page lacks)
    const CELL: Record<string, [string, number]> = {
      'claude-opus-5-5': ['Not sooner than September 22, 2027', 302],
      'claude-sonnet-5-5': ['Not sooner than September 28, 2027', 308],
      'claude-haiku-5-5': ['Not sooner than October 7, 2027', 317],
      'claude-fable-5-2': ['Not sooner than November 9, 2027', 350],
    };
    for (const [id, [cell, days]] of Object.entries(CELL)) {
      const fs = runCheck({ project: { name: 't' }, callSites: [], models: [{ model: id, where: 'a.py:1', platform: 'provider-api', context: 'runs' }] }, { pages: READ, today: '2026-11-24' })
        .findings.filter((f) => f.confidence !== 'measurable-only');
      expect(fs.map((f) => [f.severity, f.confidence, f.title, f.detail]), id).toEqual([
        [
          'info',
          'certain',
          `On Anthropic's own API, \`${id}\` is Active, with a tentative retirement date of “${cell}”, ${days} days after this run`,
          "Anthropic's model deprecations page lists it as Active.",
        ],
      ]);
    }
  });

  it('a line taken only from the catalog’s record does not count: the line must name the page its table is on', async () => {
    // @ts-expect-error a plain .mjs script with no declarations
    const { sweep, exitCode } = await import('../scripts/table-sweep.mjs');
    const catalogOnly = { runCheck: () => ({ findings: [{ confidence: 'likely', title: 'On Anthropic’s own API, `x` is Legacy', basis: "Anthropic's page for this model, as the catalog read it 2026-11-02: https://platform.claude.com/docs/en/models/x" }] }), pages: undefined };
    const r = sweep(MIN, catalogOnly);
    expect(r.withoutLine.length).toBe(r.ids.length);
    expect(exitCode(r)).toBe(1);
  });

  it('a second row for an id already seen on the page is counted and listed, not skipped', async () => {
    const { r, lines } = await sweepWith();
    // the made-up Anthropic page lists claude-mini-1 in its status table and in its history
    expect(r.seconds.map((s: { id: string }) => s.id)).toContain('claude-mini-1');
    expect(lines).toContainEqual(expect.stringMatching(/^second row: anthropic claude-mini-1 — ## Deprecation history › 2026-05-01: Claude Mini 1 model: /));
    expect(lines).toContain(`second rows: ${r.seconds.length}`);
  });
});
