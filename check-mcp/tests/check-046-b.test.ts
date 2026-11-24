/**
 * The check 0.4.6, fix pass 1 (the filing's Amendment B, the seat's rulings of 2026-11-24): an Active row prints the
 * page's own cell (B1); no line says what a page lacks (B2); the lookup note says what happened (B3); one page, one line
 * (B4); one id, one code span (B5). No test here makes a network request: the pages are the read record of this release
 * (tests/helpers/read.ts), with one or two pages' outcomes replaced, or a read switched off. Each was seen red on
 * 1686ff6 before it was built; the filing's foot carries the run.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, destinationSentence, distanceWords, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER } from '../src/lifecycle-ledger.js';
import { renderModelFacts } from '../src/model-facts.js';
import { fromRecord, noRequestRead, type PageRead } from '../src/pages.js';
import { READ, RECORD } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-24';
const OFFLINE = noRequestRead();
const ex = (...models: string[]): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: models.map((model, i) => ({ model, where: `src/${i}.py:1`, platform: 'provider-api', context: 'runs' })) });
const lines = (e: Extract, pages: PageRead = READ, today = TODAY) =>
  runCheck(e, { pages, today }).findings.filter((f) => f.confidence !== 'measurable-only');
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
/** The release's record with some pages' outcomes replaced by a failed read. */
const without = (reasons: Record<string, string>): PageRead =>
  fromRecord({
    ...RECORD,
    changedRows: [],
    changedDefinitions: [],
    pages: RECORD.pages.map((p) => (reasons[p.url] ? { url: p.url, file: p.file, ok: false as const, reason: reasons[p.url]! } : p)),
  });
const DEEPSEEK_ROOT = 'https://api-docs.deepseek.com/';
const GOOGLE_DEP = 'https://aistudio.google.com/docs/deprecations';

// ── B1 ────────────────────────────────────────────────────────────────────
describe('B1 — an Active row prints the page’s own cell', () => {
  // the seven ids of the ruling, with the cell as Anthropic's page writes it (read 2026-11-24)
  const SEVEN: [string, string][] = [
    ['claude-fable-5-2', 'Not sooner than November 9, 2027'],
    ['claude-opus-5-5', 'Not sooner than September 22, 2027'],
    ['claude-sonnet-5-5', 'Not sooner than September 28, 2027'],
    ['claude-haiku-5-5', 'Not sooner than October 7, 2027'],
    ['claude-mythos-5-2', 'Not sooner than November 9, 2027'],
    ['claude-mythos-5-1', 'Not sooner than September 1, 2027'],
    ['claude-mythos-5', 'Not sooner than June 9, 2027'],
  ];
  it('the ledger carries those cells, as the page writes them', () => {
    for (const [id, cell] of SEVEN) expect(LEDGER.find((r) => r.id === id)?.dateText, id).toBe(cell);
  });
  for (const [id, cell] of SEVEN) {
    it(`${id}: the form 0.4.5 uses for a near date, the cell quoted, under the heading its evidence gives`, () => {
      const floor = LEDGER.find((r) => r.id === id)!.shutdownFloor!;
      const want = `On Anthropic's own API, \`${id}\` is Active, with a tentative retirement date of “${cell}”, ${distanceWords(TODAY, floor)}`;
      const [read, ...more] = about(lines(ex(id)), id);
      expect(more).toEqual([]);
      expect([read!.severity, read!.confidence, read!.title]).toEqual(['info', 'certain', want]);
      const [off] = about(lines(ex(id), OFFLINE), id);
      expect([off!.confidence, off!.title]).toEqual(['likely', want]);
    });
  }
  it('the card for the seven (verifier-046b.json): every line carries its cell, under Certain', () => {
    const F = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-046b.json'), 'utf8')));
    const card = runCheck(F, { pages: READ, today: TODAY }).card.split('\n');
    const certain = card.findIndex((l) => l.startsWith('## Certain'));
    expect(certain).toBeGreaterThan(-1);
    expect(card.findIndex((l) => l.startsWith('## Likely'))).toBe(-1);
    for (const [id, cell] of SEVEN) {
      const at = card.findIndex((l) => l.startsWith('- ') && l.includes(`**On Anthropic's own API, \`${id}\` is Active, with a tentative retirement date of “${cell}”`));
      expect(at, id).toBeGreaterThan(certain);
    }
  });
});

describe('B1 — a cell that holds no date is quoted as it is; a row with no cell quotes the page’s line', () => {
  const ROW = LEDGER.find((r) => r.id === 'claude-mythos-5')!;
  async function withRow(row: Record<string, unknown>) {
    vi.resetModules();
    const real = await vi.importActual<typeof import('../src/lifecycle-ledger.js')>('../src/lifecycle-ledger.js');
    vi.doMock('../src/lifecycle-ledger.js', () => ({ ...real, LEDGER: real.LEDGER.map((r) => (r.id === ROW.id ? row : r)) }));
    const { runCheck: run } = await import('../src/engine.js');
    vi.doUnmock('../src/lifecycle-ledger.js');
    return run(ex(ROW.id), { pages: OFFLINE, today: TODAY }).findings.filter((f) => f.title.includes(`\`${ROW.id}\``));
  }
  it('a cell with no date: the cell in quotes, no distance', async () => {
    const { shutdownFloor: _f, ...rest } = ROW;
    const [f] = await withRow({ ...rest, dateText: 'To be announced', quote: '| claude-mythos-5 | Active | N/A | To be announced |' });
    expect(f!.title).toBe("On Anthropic's own API, `claude-mythos-5` is Active, with a tentative retirement date of “To be announced”");
  });
  it('no cell at all: the page’s line is quoted', async () => {
    const { shutdownFloor: _f, dateText: _d, ...rest } = ROW;
    const [f] = await withRow({ ...rest, quote: '| claude-mythos-5 | Active | N/A |  |' });
    expect(f!.title).toBe("On Anthropic's own API, `claude-mythos-5` is Active on Anthropic's model deprecations page");
    expect(f!.detail).toContain("The page's line: “| claude-mythos-5 | Active | N/A | |”.");
  });
});

// ── B2 ────────────────────────────────────────────────────────────────────
describe('B2 — no line says what a page lacks', () => {
  const ACTIVE = LEDGER.filter((r) => r.word === 'active');
  const days = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  it('every Active row, far from its floor, near it and past it, read and offline: never “No retirement is announced”, and the cell is on the line', () => {
    expect(ACTIVE.length).toBeGreaterThan(0);
    let seen = 0;
    for (const r of ACTIVE) {
      for (const today of [TODAY, days(r.shutdownFloor!, -4), days(r.shutdownFloor!, 3)]) {
        for (const pages of [READ, OFFLINE]) {
          const fs = about(lines(ex(r.id), pages, today), r.id);
          expect(fs.length, `${r.id} ${today}`).toBe(1);
          const text = `${fs[0]!.title} — ${fs[0]!.detail} · ${fs[0]!.basis}`;
          expect(text, `${r.id} ${today}`).not.toContain('No retirement is announced');
          expect(fs[0]!.title, `${r.id} ${today}`).toContain(`“${r.dateText}”`);
          seen++;
        }
      }
    }
    expect(seen).toBe(ACTIVE.length * 6);
  });
  it('the line a catalog Legacy word gives an Active row keeps the page’s notice sentence, said as the page’s', () => {
    const [f] = about(lines(ex('claude-haiku-4-5-20251001')), 'claude-haiku-4-5-20251001');
    expect(f!.title).toContain('lists it as Active, with a tentative retirement date of “Not sooner than October 15, 2026”');
    expect(f!.detail).toContain("Anthropic's model deprecations page says “Anthropic notifies customers with active deployments for models with upcoming retirements, providing at least 60 days’ notice before model retirement for publicly released models.”");
    expect(f!.detail).not.toContain('No retirement is announced');
  });
  it('the near-date line: the page lists it Active, and says its notice sentence', () => {
    const [f] = about(lines(ex('claude-mythos-5'), READ, '2027-06-05'), 'claude-mythos-5');
    expect(f!.detail).toMatch(/^Anthropic's model deprecations page lists it as Active, and says “Anthropic notifies customers/);
  });
  it('a far-date line names the page that lists it', () => {
    const [f] = about(lines(ex('claude-opus-5-5')), 'claude-opus-5-5');
    expect(f!.detail).toBe("Anthropic's model deprecations page lists it as Active.");
  });
});

// ── B3 ────────────────────────────────────────────────────────────────────
describe('B3 — the lookup note says what happened', () => {
  it('an id matched only in lower case', () => {
    expect(renderModelFacts('GPT-4o', { pages: OFFLINE, today: TODAY }).split('\n')[0]).toBe('# GPT-4o (looked up as `gpt-4o`, the lower-case form of the id as written)');
  });
  it('with another step too, the lower case is said first, as what the steps worked on', () => {
    expect(renderModelFacts('OpenAI/GPT-4o', { pages: OFFLINE, today: TODAY }).split('\n')[0]).toBe(
      '# OpenAI/GPT-4o (looked up as `gpt-4o`: in the lower-case form of the id as written, removed the `openai/` prefix)',
    );
  });
  it('no lookup note says “wrote the id in lower case”', () => {
    for (const id of ['GPT-4o', 'OpenAI/GPT-4o', 'Models/Genie-4', 'CLAUDE-OPUS-4-5-20251101'])
      expect(renderModelFacts(id, { pages: OFFLINE, today: TODAY }), id).not.toContain('wrote the id in lower case');
  });
});

// ── B4 ────────────────────────────────────────────────────────────────────
describe('B4 — one page, one line: the footer says what is true of the pages and of their lines', () => {
  const foot = (e: Extract, pages: PageRead) => runCheck(e, { pages, today: TODAY }).card.split('\n').find((l) => l.startsWith('*This check ran'))!;
  it('one page did not answer and no line rests on it', () => {
    expect(foot(ex('gpt-4o'), without({ [DEEPSEEK_ROOT]: 'HTTP 503' }))).toMatch(/ 1 did not answer; no line on this card rests on it\.\*$/);
  });
  it('one page, one line', () => {
    expect(foot(ex('deepseek-v4-flash'), without({ [DEEPSEEK_ROOT]: 'HTTP 503' }))).toMatch(/ 1 did not answer; its line says so\.\*$/);
  });
  it('one page, two lines', () => {
    expect(foot(ex('deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'), without({ [DEEPSEEK_ROOT]: 'HTTP 503' }))).toMatch(/ 1 did not answer; its lines say so\.\*$/);
  });
  it('two pages, no line', () => {
    expect(foot(ex('gpt-4o'), without({ [DEEPSEEK_ROOT]: 'HTTP 503', [GOOGLE_DEP]: 'HTTP 503' }))).toMatch(/ 2 did not answer; no line on this card rests on them\.\*$/);
  });
  it('two pages, one line', () => {
    expect(foot(ex('deepseek-v4-flash'), without({ [DEEPSEEK_ROOT]: 'HTTP 503', [GOOGLE_DEP]: 'HTTP 503' }))).toMatch(/ 2 did not answer; the one line that rests on them says so\.\*$/);
  });
  it('two pages, two lines', () => {
    expect(foot(ex('deepseek-v4-flash', 'genie-4'), without({ [DEEPSEEK_ROOT]: 'HTTP 503', [GOOGLE_DEP]: 'HTTP 503' }))).toMatch(/ 2 did not answer; their lines say so\.\*$/);
  });
  it('the sentence alone, given no count of lines, names the pages only', () => {
    expect(destinationSentence(without({ [DEEPSEEK_ROOT]: 'HTTP 503' }))).toMatch(/ 1 did not answer\.$/);
  });
});

// ── B5 ────────────────────────────────────────────────────────────────────
describe('B5 — one id, one code span', () => {
  it('two ids the page names as a replacement: two spans', () => {
    const [f] = about(lines(ex('whisper-1')), 'whisper-1');
    expect(f!.title).toContain('its page names `gpt-live-transcribe` or `gpt-transcribe`');
    expect(f!.title).not.toContain('`gpt-live-transcribe or gpt-transcribe`');
  });
  it('three ids: three spans, the page’s commas and “or” kept', () => {
    const [f] = about(lines(ex('dall-e-2')), 'dall-e-2');
    expect(f!.title).toContain('its page names `gpt-image-2`, `gpt-image-1`, or `gpt-image-1-mini`');
  });
  it('`--model-facts` names each id in its own span', () => {
    expect(renderModelFacts('whisper-1', { pages: OFFLINE, today: TODAY })).toContain('replacement the page names: `gpt-live-transcribe` or `gpt-transcribe`');
  });
  it('no card line or lookup puts “ or ” or “, ” inside one code span, for any row', () => {
    /** The code spans of a text, read left to right as Markdown pairs them, that hold a list. */
    const listSpans = (t: string) => [...t.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((s) => / or |, /.test(s));
    let rows = 0;
    for (const r of LEDGER.filter((x) => x.replacement && !x.replacementForm)) {
      for (const f of lines(ex(r.id))) expect(listSpans(f.title), r.id).toEqual([]);
      for (const l of renderModelFacts(r.id, { pages: OFFLINE, today: TODAY }).split('\n')) {
        // a quoted page line keeps the page's own markup; only the check's own words are read here
        expect(listSpans(l.replace(/“[^”]*”/g, '')), r.id).toEqual([]);
      }
      rows++;
    }
    expect(rows).toBeGreaterThan(0);
  });
});
