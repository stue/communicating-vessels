/**
 * The check 0.4.5 (filing 2026-11-20), R3 and R4: every row of Anthropic's status table is in the ledger, and an Active
 * row is never "not recognised" and never a flag (R5–R6: check-045-r5-r6.test.ts; R1, R2, R7, R8: check-045-words.test.ts;
 * R9's M10: check-045-m10.test.ts). No test here makes a network request: the pages are the
 * read record of this release (tests/helpers/read.ts), a read switched off as `--offline` switches it, or a read
 * built in the test. Every card is printed on a fixed day, 2026-11-20 (the day Anthropic's page was read for this
 * release), unless a test moves the day to an edge of the 60-day window. Each behaviour below was seen red on
 * 0.4.4's code (main 254e399) before it was built; the filing's foot carries those runs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGetProfile, type ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER, LEDGER_DEFINITIONS } from '../src/lifecycle-ledger.js';
import { noRequestRead, type PageRead } from '../src/pages.js';
import { READ } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'check-045-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const TODAY = '2026-11-20';
const F: Extract = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-045.json'), 'utf8')));
const OFFLINE: PageRead = noRequestRead();
const card = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).card;
const findings = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).findings;
const one = (model: string): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform: 'provider-api', context: 'runs' }] });
/** The findings that speak of an id: a title that names it in code marks. */
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md';

/**
 * The 17 rows of Anthropic's "Model status" table whose state is Active, as the page read for this release
 * (2026-11-20T05:02:18Z, sha256 83b08416…) writes them, with each row's "Tentative retirement date" cell verbatim.
 * Typed here, not read from the ledger, so that a ledger without them fails this file.
 * 0.4.6: 16 — on the page read 2026-11-24T09:37:37Z (sha256 035274dd…) `claude-opus-4-5-20251101` is Deprecated
 * (November 23, 2026; retirement January 22, 2027), and the other 16 rows are as they were, each date cell verbatim.
 */
const ACTIVE: [string, string][] = [
  ['claude-fable-5-2', 'Not sooner than November 9, 2027'],
  ['claude-mythos-5-2', 'Not sooner than November 9, 2027'],
  ['claude-fable-5-1', 'Not sooner than September 1, 2027'],
  ['claude-mythos-5-1', 'Not sooner than September 1, 2027'],
  ['claude-fable-5', 'Not sooner than June 9, 2027'],
  ['claude-mythos-5', 'Not sooner than June 9, 2027'],
  ['claude-opus-5-5', 'Not sooner than September 22, 2027'],
  ['claude-opus-5', 'Not sooner than July 24, 2027'],
  ['claude-opus-4-8', 'Not sooner than May 28, 2027'],
  ['claude-opus-4-7', 'Not sooner than April 16, 2027'],
  ['claude-opus-4-6', 'Not sooner than February 5, 2027'],
  // 0.4.6: ['claude-opus-4-5-20251101', 'Not sooner than November 24, 2026'] — Deprecated on the page read 2026-11-24 (check-046.test.ts)
  ['claude-sonnet-5-5', 'Not sooner than September 28, 2027'],
  ['claude-sonnet-5', 'Not sooner than June 30, 2027'],
  ['claude-sonnet-4-6', 'Not sooner than February 17, 2027'],
  ['claude-haiku-5-5', 'Not sooner than October 7, 2027'],
  ['claude-haiku-4-5-20251001', 'Not sooner than October 15, 2026'],
];
const NOTICE =
  'Anthropic notifies customers with active deployments for models with upcoming retirements, providing at least 60 days’ notice before model retirement for publicly released models.';
const FINE_TUNES = 'Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.';

// ── R3 — the ledger carries every row of Anthropic's status table ──────────
describe('R3 — every Active row of Anthropic’s status table is in the ledger, its date text verbatim, its floor in shutdownFloor', () => {
  it('the 16 Active rows, and no others (0.4.6; until 0.4.6: 17)', () => {
    const active = LEDGER.filter((r) => (r.word as string) === 'active');
    expect(active.map((r) => r.id).sort()).toEqual(ACTIVE.map(([id]) => id).sort());
  });
  for (const [id, text] of ACTIVE) {
    it(id, () => {
      const r = LEDGER.find((x) => x.id === id)!;
      expect(r.provider).toBe('anthropic');
      expect(r.pageWord).toBe('Active');
      expect(r.dateText).toBe(text);
      expect(r.shutdown).toBeUndefined();
      expect(r.shutdownFloor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.url).toBe(ANTHROPIC);
    });
  }
  it('the page’s notice sentence and OpenAI’s fine-tune sentence are carried and checked like the definitions', () => {
    expect(LEDGER_DEFINITIONS).toContainEqual({ provider: 'anthropic', word: 'notice period', url: ANTHROPIC, quote: NOTICE });
    expect(LEDGER_DEFINITIONS).toContainEqual({ provider: 'openai', word: 'fine-tuned versions', url: 'https://developers.openai.com/api/docs/deprecations.md', quote: FINE_TUNES });
  });

  const gen = (edit?: { file: string; from: string | RegExp; to: string }) => {
    const d = mkdtempSync(join(ROOT, 'pages-'));
    cpSync(MIN, d, { recursive: true });
    if (edit) {
      const f = join(d, edit.file);
      const before = readFileSync(f, 'utf8');
      const after = before.replace(edit.from, edit.to);
      if (after === before) throw new Error(`the edit did not apply to ${edit.file}`);
      writeFileSync(f, after);
    }
    const out = join(mkdtempSync(join(ROOT, 'gen-')), 'lifecycle-ledger.ts');
    const r = spawnSync(process.execPath, [GEN, '--pages', d, '--out', out], { encoding: 'utf8' });
    return { code: r.status, err: r.stderr, out, wrote: existsSync(out), text: existsSync(out) ? readFileSync(out, 'utf8') : '' };
  };
  it('the generator writes the made-up page’s Active row with its date text and floor', () => {
    const g = gen();
    expect(g.code).toBe(0);
    expect(g.text).toContain('"id": "claude-mini-2"');
    expect(g.text).toMatch(/"id": "claude-mini-2",\s+"provider": "anthropic",\s+"word": "active",\s+"pageWord": "Active",\s+"shutdownFloor": "2099-05-01",\s+"dateText": "Not sooner than May 1, 2099"/);
  });
  it('a state word the generator does not read stops it, and no ledger is written', () => {
    const g = gen({ file: 'anthropic-deprecations.md', from: '| claude-mini-2     | Active        |', to: '| claude-mini-2     | Preview       |' });
    expect(g.code).not.toBe(0);
    expect(g.wrote).toBe(false);
    expect(g.err).toMatch(/the state "Preview" on claude-mini-2 .*No ledger written/);
  });
});

// ── R4 — what the card says of an Active row ───────────────────────────────
describe('R4 (a) — an id the page lists as Active is never “not recognised”, by its name or as its dated snapshot', () => {
  for (const [id] of ACTIVE) {
    it(id, () => {
      for (const pages of [READ, OFFLINE]) expect(card(one(id), pages)).not.toContain('was not recognised');
    });
  }
  it('`claude-opus-4-5` is read as the dated snapshot the page lists, in the words the card uses for a retired snapshot', () => {
    const [f] = about(findings(one('claude-opus-4-5')), 'claude-opus-4-5');
    expect(f!.detail).toContain('The page lists the dated snapshot `claude-opus-4-5-20251101`.');
    expect(f!.detail).toContain('The catalog has no entry for it, so its limits and price were not checked.');
  });
  it('on $F, offline: neither Opus 4.5 id is “not recognised” (the fine-tune is R5’s, in check-045-r5-r6.test.ts)', () => {
    const c = card(F, OFFLINE);
    expect(c).not.toContain('`claude-opus-4-5-20251101` was not recognised');
    expect(c).not.toContain('`claude-opus-4-5` was not recognised');
  });
});

// 0.4.6: on an Active row with no catalog entry, `claude-mythos-5` (floor 2027-06-09), each day the same distance from its
// floor as before (until 0.4.6: `claude-opus-4-5-20251101`, floor 2026-11-24, which the page read 2026-11-24 calls Deprecated)
describe('R4 (b) — the date line prints only when the floor has passed or lies within 60 days; ℹ️, the state, the page’s date text and the distance', () => {
  const id = 'claude-mythos-5'; // floor 2027-06-09
  const line = (today: string) => about(findings(one(id), READ, today), id);
  it('4 days before the floor: one ℹ️ line, Certain, the date text in quotes and the distance', () => {
    const [f, ...rest] = line('2027-06-05');
    expect(rest).toEqual([]);
    expect(f!.severity).toBe('info');
    expect(f!.confidence).toBe('certain');
    expect(f!.title).toBe(
      'On Anthropic\'s own API, `claude-mythos-5` is Active, with a tentative retirement date of “Not sooner than June 9, 2027”, 4 days after this run',
    );
    // 0.4.6 Amendment B2: the page's words, never what it lacks (until 0.4.6: "No retirement is announced for it: …")
    expect(f!.detail).toMatch(/^Anthropic's model deprecations page lists it as Active, and says “/);
    expect(f!.detail).toContain(NOTICE);
  });
  it('60 days before the floor (the window’s far edge): the date line prints', () => {
    const [f] = line('2027-04-10');
    expect(f!.title).toContain('“Not sooner than June 9, 2027”, 60 days after this run');
  });
  // 0.4.6 Amendment B1: outside the window the line still prints the page's own cell, in the same form; only the notice
  // sentence is the window's (until 0.4.6: no date, "is Active on Anthropic's model deprecations page")
  it('61 days before the floor (outside the window): the page’s cell in the same form, without the notice sentence', () => {
    const [f, ...rest] = line('2027-04-09');
    expect(rest).toEqual([]);
    expect(f!.title).toBe(
      'On Anthropic\'s own API, `claude-mythos-5` is Active, with a tentative retirement date of “Not sooner than June 9, 2027”, 61 days after this run',
    );
    expect(f!.detail).not.toContain(NOTICE);
    expect(f!.detail).toContain('The catalog has no entry for it, so its limits and price were not checked.');
    expect(f!.severity).toBe('info');
  });
  it('on the floor’s own day, and after it: the date line prints, said as the day of this run and as a date before it', () => {
    expect(line('2027-06-09')[0]!.title).toContain('“Not sooner than June 9, 2027”, the day of this run');
    expect(line('2027-06-10')[0]!.title).toContain('“Not sooner than June 9, 2027”, a date 1 day before this run');
  });
  it('never 🟡 or 🔴 on the card', () => {
    const l = card(one(id), READ, '2027-06-05').split('\n').find((x) => x.includes('`claude-mythos-5` is Active'))!;
    expect(l.startsWith('- ℹ️ ')).toBe(true);
  });
});

describe('R4 (c) — Certain when the page was read in this run and the row stands; Likely otherwise', () => {
  it('read in this run: Certain; offline: Likely, with the day this version read the page', () => {
    const id = 'claude-mythos-5'; // 0.4.6: an Active row (until 0.4.6: `claude-opus-4-5-20251101`, Deprecated on the page read 2026-11-24)
    expect(about(findings(one(id), READ), id)[0]!.confidence).toBe('certain');
    const off = about(findings(one(id), OFFLINE), id)[0]!;
    expect(off.confidence).toBe('likely');
    expect(off.detail).toMatch(/as this version of the check read it on \d{4}-\d{2}-\d{2}/);
  });
});

describe('R4 (d) — an Active id is not counted as flagged; one with a far floor and no catalog entry still prints one ℹ️ line', () => {
  it('`claude-mythos-5` (no catalog entry, floor 2027-06-09): one ℹ️ line, and the header flags nothing', () => {
    expect(tryGetProfile('claude-mythos-5')).toBeUndefined();
    const r = runCheck(one('claude-mythos-5'), { pages: READ, today: TODAY });
    const fs = about(r.findings, 'claude-mythos-5');
    expect(fs.length).toBe(1);
    expect(fs[0]!.severity).toBe('info');
    // 0.4.6 Amendment B1: the page's cell (until 0.4.6: "is Active on Anthropic's model deprecations page", no date)
    expect(fs[0]!.title).toBe(
      "On Anthropic's own API, `claude-mythos-5` is Active, with a tentative retirement date of “Not sooner than June 9, 2027”, 201 days after this run",
    );
    expect(fs[0]!.detail).toContain('The catalog has no entry for it, so its limits and price were not checked.');
    const head = r.card.split('\n')[2]!;
    expect(head).not.toMatch(/flagged/);
    expect(head).not.toMatch(/not recognised/);
  });
  it('an Active id beside a flagged one is not in the flagged count', () => {
    const e = ExtractSchema.parse({
      project: { name: 't' },
      callSites: [],
      models: [
        // 0.4.6: an Active row (until 0.4.6: `claude-opus-4-5-20251101`, Deprecated on the page read 2026-11-24)
        { model: 'claude-mythos-5-1', where: 'a.py:1', platform: 'provider-api', context: 'runs' },
        { model: 'gpt-4o-mini', where: 'b.py:1', platform: 'provider-api', context: 'runs' },
      ],
    });
    expect(card(e).split('\n')[2]).toBe(
      '0 AI call sites and 2 model ids: `claude-mythos-5-1`, `gpt-4o-mini`. 1 is flagged by OpenAI. The flagged id is in code that runs.',
    );
  });
});

describe('R4 (e) — where the catalog carries the provider’s word too, one line: the model page’s word and day, the deprecations page’s floor and read state', () => {
  const id = 'claude-haiku-4-5-20251001';
  it('on $F, read in this run: one line for the id; the floor is the page’s, never “read 2026-11-02”', () => {
    const fs = about(findings(F), id);
    expect(fs.length).toBe(1);
    const f = fs[0]!;
    expect(f.confidence).toBe('likely');
    expect(f.title).toContain('is Legacy: its model page says so (read 2026-11-02)');
    expect(f.title).toContain("Anthropic's model deprecations page lists it as Active, with a tentative retirement date of “Not sooner than October 15, 2026”, a date 36 days before this run");
    expect(f.title).not.toMatch(/retirement floor 2026-10-15/);
    // the catalog's day is said once, of the model page's word, before the deprecations page's part — never beside the floor
    expect(f.title.split('2026-11-02').length - 1).toBe(1);
    expect(f.title.indexOf('(read 2026-11-02)')).toBeLessThan(f.title.indexOf("Anthropic's model deprecations page"));
    // 0.4.6: the re-read of 2026-11-24 (until 0.4.6: 2026-11-20)
    expect(f.detail).toMatch(/That page was read in this run \(2026-11-24 \d{2}:\d{2} UTC\); the model page was not, and its word is as the catalog read it on 2026-11-02\./);
    expect(f.basis).toContain(ANTHROPIC);
    expect(f.basis).toMatch(/model deprecations page, read in this run/);
  });
  it('the same three ids on $F print one line each (`claude-opus-4-6`, `claude-sonnet-4-6`, and the Haiku snapshot)', () => {
    const fs = findings(F);
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', id]) expect(about(fs, m).length, m).toBe(1);
  });
  it('offline: the floor says this version’s read of the deprecations page, not the catalog’s day', () => {
    const f = about(findings(F, OFFLINE), id)[0]!;
    expect(f.detail).toMatch(/This is Anthropic's model deprecations page as this version of the check read it on \d{4}-\d{2}-\d{2}/);
    expect(f.basis).toMatch(/Anthropic's model deprecations page as read \d{4}-\d{2}-\d{2}: https/);
  });
  it('when the two pages give different floors, both print, each beside its page', () => {
    const real = tryGetProfile('claude-opus-4-6')!;
    const moved: ModelProfile = { ...real, providerLifecycle: { ...real.providerLifecycle!, retirementFloor: '2027-03-01' } };
    const r = runCheck(one('claude-opus-4-6'), { pages: READ, today: TODAY, resolve: (x) => ({ canonical: x, profile: x === 'claude-opus-4-6' ? moved : tryGetProfile(x) }) });
    const f = about(r.findings, 'claude-opus-4-6')[0]!;
    expect(f.title).toContain('“Not sooner than February 5, 2027”');
    expect(f.title).toContain('its model page gave a retirement floor of 2027-03-01 (read 2026-11-02)');
  });
});

