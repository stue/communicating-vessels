/**
 * The check 0.4.7 (filing 2026-11-25, with its Amendment A): R1 a page word is the page's, R2 a sentence is quoted from the
 * page that holds it, R3 a second row is said, R4 OpenAI's note on fine-tunes of the October 2026 shutdown, R5 Anthropic's
 * own sentences on the platforms its dates cover, R6 two lines say whose word they print, R7 the release, R8 a date before
 * the run is not said in the future. No test here makes a network request: the pages are the read record of this release
 * (tests/helpers/read.ts), a read switched off as `--offline` switches it, or the made-up page set in
 * tests/fixtures/pages-min/ (copied and edited in a scratch folder; real provider pages are never committed, Amendment A3).
 * Each `it` here was run red on main's code (0.4.6, `bfb284e`) before the build; the filing's Report carries that run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER, LEDGER_DEFINITIONS } from '../src/lifecycle-ledger.js';
import * as lifecycle from '../src/lifecycle.js';
import { renderModelFacts } from '../src/model-facts.js';
import { noRequestRead, type PageRead } from '../src/pages.js';
import * as check from '../src/ledger-check.mjs';
import { READ } from './helpers/read.js';
import type { LedgerRow } from '../src/lifecycle-types.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const DRIFT = join(PKG, 'scripts/ledger-drift.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'check-047-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The day of the release's read (the record's pages were read 2026-11-25T09:06Z). */
const TODAY = '2026-11-25';
const OFFLINE: PageRead = noRequestRead();
const one = (model: string, platform: string = 'provider-api'): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform, context: 'runs' }] });
const findings = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).findings;
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
const lineOf = (id: string, pages: PageRead = READ, today = TODAY, platform?: string) => about(findings(one(id, platform), pages, today), id)[0]!;
const row = (id: string) => LEDGER.find((r) => r.id === id)!;

const DEP = 'https://aistudio.google.com/docs/deprecations';
const CHANGELOG = 'https://aistudio.google.com/docs/changelog';
const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md';
const OPENAI = 'https://developers.openai.com/api/docs/deprecations.md';

/** A scratch copy of the made-up page set, with edits applied (each must apply). */
function pagesWith(...edits: { file: string; from: string; to: string }[]): string {
  const d = mkdtempSync(join(ROOT, 'pages-'));
  cpSync(MIN, d, { recursive: true });
  for (const e of edits) {
    const f = join(d, e.file);
    const before = readFileSync(f, 'utf8');
    const after = before.replace(e.from, e.to);
    if (after === before) throw new Error(`the edit did not apply to ${e.file}: ${e.from}`);
    writeFileSync(f, after);
  }
  return d;
}
/** The generator on a page set: its exit, its stderr, and the rows it wrote. */
function gen(dir: string) {
  const out = join(mkdtempSync(join(ROOT, 'gen-')), 'lifecycle-ledger.ts');
  const r = spawnSync(process.execPath, [GEN, '--pages', dir, '--out', out], { encoding: 'utf8' });
  let rows: LedgerRow[] = [];
  try {
    rows = JSON.parse(/export const LEDGER: readonly LedgerRow\[\] = (\[[\s\S]*?\n\]);/.exec(readFileSync(out, 'utf8'))![1]!);
  } catch {
    /* no ledger written */
  }
  return { code: r.status, err: r.stderr, out: r.stdout, file: out, rows };
}

// ── R1 — a page word is the page's ───────────────────────────────────────
describe('R1 — `pageWord` is the page’s word or it is absent; our words are `ourWord`', () => {
  it('wordOn: the generator’s own flattening with the link strip, on both sides (a string cut inside a link included)', () => {
    const page = 'Gemini 3.7 Flash deprecation: [`gemini-3.7-flash`](/docs/whats-new-gemini-3.7) is\n deprecated and has been replaced.';
    expect(check.wordOn(page, '`gemini-3.7-flash` is deprecated')).toBe(true);
    expect(check.wordOn(page, '`gemini-3.7-flash`](/docs/whats-new-gemini-3.7) is deprecated')).toBe(true);
    expect(check.wordOn(page, '`gemini-3.7-flash` is retired')).toBe(false);
    expect(check.quoteOn(page, '`gemini-3.7-flash` is deprecated')).toBe(false);
    expect(check.unlinked('see [the page](https://x/y) now')).toBe('see the page now');
  });

  it('the generator’s check names every row whose pageWord is not on the page it names, and passes a row with none', () => {
    const text = (u: string) => (u === 'https://a' ? 'Model status: Deprecated' : u === 'https://b' ? 'it [is deprecated](/x).' : undefined);
    expect(check.pageWordMisses([{ id: 'm', provider: 'p', url: 'https://a', pageWord: 'Deprecated' }], text)).toEqual([]);
    expect(check.pageWordMisses([{ id: 'm', provider: 'p', url: 'https://a' }], text)).toEqual([]);
    expect(check.pageWordMisses([{ id: 'm', provider: 'p', url: 'https://a', pageWord: 'Upcoming deprecations: Deprecated' }], text)).toEqual([
      'p m: its pageWord "Upcoming deprecations: Deprecated" is not on https://a',
    ]);
    expect(check.pageWordMisses([{ id: 'm', provider: 'p', url: 'https://a', pageWord: 'is deprecated', pageWordUrl: 'https://b', alsoUrl: 'https://b' }], text)).toEqual([]);
    expect(check.pageWordMisses([{ id: 'm', provider: 'p', url: 'https://a', pageWord: 'is deprecated', pageWordUrl: 'https://b' }], text)).toHaveLength(1);
  });

  it('the bundled ledger: no pageWord carries our joins, our descriptions or a link’s dangling end; 124 rows carry ourWord', () => {
    const ours = /^(Upcoming deprecations: |Past deprecations: |listed under |shutdown date |release notes |Deprecated model \()/;
    expect(LEDGER.filter((r) => r.pageWord !== undefined && (ours.test(r.pageWord) || r.pageWord.includes(']('))).map((r) => `${r.id}: ${r.pageWord}`)).toEqual([]);
    expect(LEDGER.filter((r) => r.ourWord !== undefined).length).toBe(124);
    // the four whose word is on their second page say so
    expect(LEDGER.filter((r) => r.pageWordUrl).map((r) => r.id).sort()).toEqual(['gemini-3.1-flash-image', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-embedding-2-preview']);
  });

  it('the made-up set’s ledger, as the generator writes it: every pageWord on its page by wordOn, the joins moved to ourWord, the table a record field', () => {
    const g = gen(MIN);
    expect(g.code, g.err).toBe(0);
    const texts = new Map<string, string>();
    const textOf = (url: string) => {
      const f = check.pageFileOf(url);
      if (!f) return undefined;
      if (!texts.has(url)) texts.set(url, check.pageTextOf(f, readFileSync(join(MIN, f), 'utf8')));
      return texts.get(url);
    };
    expect(check.pageWordMisses(g.rows, textOf)).toEqual([]);
    const a = g.rows.find((r) => r.id === 'gpt-mini-a')!;
    expect([a.pageWord, a.ourWord, a.table, a.wordBy]).toEqual(['Deprecated', 'Upcoming deprecations: Deprecated', 'Upcoming deprecations', undefined]);
    const old = g.rows.find((r) => r.id === 'gemini-mini-old')!;
    // fix pass 1: *shut down* under "Deprecated models" is Google's own word (until fix pass 1: `wordBy: 'date'`)
    expect([old.word, old.pageWord, old.ourWord, old.wordBy]).toEqual(['shut down', 'Deprecated models', 'listed under Gemini 9 models › Deprecated models', undefined]);
  });

  it('a fine-tune of an upcoming base quotes the footnote by the row’s `table`, a record field (until 0.4.7: a test on the words of its pageWord)', () => {
    expect(row('gpt-4o-2024-08-06').table).toBe('Upcoming deprecations');
    expect(lineOf('ft:gpt-4o-2024-08-06:acme::abc123').detail).toContain(
      "OpenAI's deprecations page: “Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.”",
    );
  });

  it('no `--model-facts` lookup prints a row’s ourWord, for every row of the ledger', () => {
    const withOurs = LEDGER.filter((r) => r.ourWord !== undefined);
    expect(withOurs.length).toBeGreaterThan(0);
    expect(withOurs.filter((r) => renderModelFacts(r.id, { pages: READ, today: TODAY }).includes(r.ourWord!)).map((r) => r.id)).toEqual([]);
  });
});

// ── R2 — the quote is the sentence that carries the word ─────────────────
const R2: [string, string, string][] = [
  // id, the release notes' sentence as the card prints it, the row by its columns
  [
    'gemini-3.1-flash-image',
    'Deprecation announcement: The `gemini-3.1-flash-image` model is deprecated (no shutdown date announced).',
    'Model: `gemini-3.1-flash-image` | Release date: May 28, 2026 | Shutdown date: No shutdown date announced | Recommended replacement: `gemini-nano-banana-2.1`',
  ],
  [
    'gemini-3.7-flash',
    'Gemini 3.7 Flash deprecation: `gemini-3.7-flash` is deprecated and has been replaced by `gemini-3.8-flash`.',
    'Model: `gemini-3.7-flash` | Release date: August 13, 2026 | Shutdown date: N/A | Recommended replacement: `gemini-3.8-flash`',
  ],
  [
    'gemini-3.5-flash',
    'Gemini 3.5 Flash deprecation: `gemini-3.5-flash` is deprecated and has been replaced by `gemini-3.6-flash`.',
    'Model: `gemini-3.5-flash` | Release date: May 19, 2026 | Shutdown date: N/A | Recommended replacement: `gemini-3.6-flash`',
  ],
  [
    'gemini-embedding-2-preview',
    'Gemini Embedding 2 Preview deprecation: `gemini-embedding-2-preview` is deprecated.',
    'Model: `gemini-embedding-2-preview` | Release date: March 10, 2026 | Shutdown date: November 6, 2026 | Recommended replacement: `gemini-embedding-2`',
  ],
];
describe('R2 — a row whose word is its second page’s quotes that page’s sentence, named with its read day; the row follows by its columns', () => {
  for (const [id, sentence, columns] of R2) {
    it(id, () => {
      const f = lineOf(id);
      expect(f.title).toContain('is deprecated');
      const s = `Google's release notes page (read in this run, 2026-11-25 09:06 UTC): “${sentence}”`;
      const c = `Its row on Google's Gemini deprecations page, by the table's columns: “${columns}`;
      expect(f.detail.startsWith(s), f.detail).toBe(true);
      expect(f.detail.indexOf(c)).toBeGreaterThan(f.detail.indexOf(s));
      expect(f.detail).not.toContain("The page's line:");
      expect(f.basis).toContain(CHANGELOG);
      // offline: the page named with the day this version read it
      expect(lineOf(id, OFFLINE).detail.startsWith(`Google's release notes page (as read on 2026-11-25): “${sentence}”`)).toBe(true);
    });
  }

  it('Amendment A2: no other row of the ledger is quoted by its column names', () => {
    const byColumns = LEDGER.filter((r) => findings(one(r.id)).some((f) => f.detail.includes("by the table's columns"))).map((r) => r.id);
    expect(byColumns.sort()).toEqual(R2.map(([id]) => id).sort());
  });
});

// ── R3 — a second row is said ─────────────────────────────────────────────
describe('R3 — an id on two rows of its page keeps its line from the first and says the second, with its heading', () => {
  it('the same fact twice (Anthropic’s status and history rows): the sentence, and the line stays Certain', () => {
    const f = lineOf('claude-sonnet-4-20250514');
    expect(f.confidence).toBe('certain');
    expect(f.detail).toContain(
      "`claude-sonnet-4-20250514` is on two rows of Anthropic's model deprecations page: this line is from the first, and the second, under its heading “2026-04-14: Claude Sonnet 4 and Claude Opus 4 models”, reads “| June 15, 2026 | `claude-sonnet-4-20250514` | `claude-sonnet-5-5` |”.",
    );
  });

  it('the same fact under two headings (Google’s Live API table)', () => {
    expect(lineOf('gemini-3.8-live').detail).toContain('under its heading “Live API models”, reads “`gemini-3.8-live` | September 15, 2026 | No shutdown date announced”.');
  });

  it('Amendment A4: a second date or replacement — Likely, and the page carries two rows that differ; no line says which is right', () => {
    for (const id of ['gpt-4-0314', 'code-davinci-002']) {
      const f = lineOf(id);
      expect(f.confidence, id).toBe('likely');
      expect(f.detail, id).toContain(`\`${id}\` is on two rows of OpenAI's deprecations page: this line is from the first`);
      expect(f.detail, id).toContain('; the two rows give different dates and replacements.');
      expect(f.detail, id).not.toMatch(/\b(right|correct|wrong)\b/);
    }
  });

  it('Amendment A4: a second row about something else (fine-tuning) keeps the first row’s tier', () => {
    const f = lineOf('babbage-002');
    expect(f.confidence).toBe('certain');
    expect(f.detail).toContain('reads “| Oct 28, 2024 | New fine-tuning training on `babbage-002` | `gpt-4o-mini` | Aug 29, 2024 |”.');
    expect(f.detail).not.toContain('give different');
  });

  it('the ledger carries 18 second rows, each a record (quote, heading, date text, replacement; a feature marked)', () => {
    const s = LEDGER.filter((r) => r.secondRow);
    expect(s.length).toBe(18);
    expect(row('code-davinci-002').secondRow).toMatchObject({ heading: 'Past deprecations', dateText: 'Mar 23, 2023', replacement: 'gpt-4o' });
    expect(row('ada').secondRow?.feature).toBe(true);
    expect(row('claude-opus-4-5-20251101').secondRow).toMatchObject({ heading: '2026-11-23: Claude Opus 4.5 model', dateText: 'January 22, 2027', replacement: 'claude-opus-5-5' });
  });

  // Amendment A3: on a made-up page set holding second rows of each shape
  const SECOND = {
    file: 'openai-deprecations.md',
    from: '| Jan 1, 2025   | `gpt-old-a`               | `gpt-mini-b`       | Jan 1, 2024  |',
    to: [
      '| Jan 1, 2025   | `gpt-old-a`               | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jan 2, 2025   | `gpt-two-same`            | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jan 2, 2025   | `gpt-two-same` (snapshot) | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jan 3, 2025   | `gpt-two-date`            | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jun 3, 2024   | `gpt-two-date`            | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jan 4, 2025   | `gpt-two-repl`            | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Jan 4, 2025   | `gpt-two-repl`            | `gpt-mini-c`       | Jan 1, 2024  |',
      '| Jan 5, 2025   | `gpt-two-feat`            | `gpt-mini-b`       | Jan 1, 2024  |',
      '| Oct 1, 2024   | Fine-tuning on `gpt-two-feat` | `gpt-mini-c`   | Jan 1, 2024  |',
    ].join('\n'),
  };
  // fix pass 1: the made-up Google page itself carries a second row (`gemini-mini-c` under "Gemini 9 models" and "Live 9 models")

  it('made-up pages: the generator writes each second row onto the first, with its heading, date, replacement and feature mark', () => {
    const g = gen(pagesWith(SECOND));
    expect(g.code, g.err).toBe(0);
    const s = (id: string) => g.rows.find((r) => r.id === id)?.secondRow;
    expect(s('gpt-two-same')).toEqual({ quote: '| Jan 2, 2025   | `gpt-two-same` (snapshot) | `gpt-mini-b`       | Jan 1, 2024  |', heading: 'Past deprecations', dateText: 'Jan 2, 2025', replacement: 'gpt-mini-b' });
    expect(s('gpt-two-date')).toMatchObject({ dateText: 'Jun 3, 2024', replacement: 'gpt-mini-b' });
    expect(s('gpt-two-repl')).toMatchObject({ dateText: 'Jan 4, 2025', replacement: 'gpt-mini-c' });
    expect(s('gpt-two-feat')).toMatchObject({ feature: true, heading: 'Past deprecations' });
    expect(s('gemini-mini-c')).toEqual({ quote: '`gemini-mini-c` | April 1, 2026 | No shutdown date announced | `gemini-mini-b`', heading: 'Live 9 models', dateText: 'No shutdown date announced', replacement: 'gemini-mini-b' });
    // the made-up Anthropic page's own pair: the status row and the history row
    expect(s('claude-mini-1')).toMatchObject({ heading: '2026-05-01: Claude Mini 1 model', dateText: 'June 1, 2026', replacement: 'claude-mini-2' });
    expect(g.rows.filter((r) => r.secondRow).length).toBe(6);
  });

  it('made-up pages: a third row for one id stops the generator, and no ledger is written', () => {
    const third = { ...SECOND, to: `${SECOND.to}\n| Jul 3, 2024   | \`gpt-two-date\`            | \`gpt-mini-b\`       | Jan 1, 2024  |` };
    const g = gen(pagesWith(third));
    expect(g.code).not.toBe(0);
    expect(g.err).toMatch(/gpt-two-date is on a third row/);
    expect(g.rows).toEqual([]);
  });

  it('made-up pages: the second row is checked on its page like the first — a moved second row is a changed row, and the drift check says which', () => {
    const dir = pagesWith(SECOND);
    const g = gen(dir);
    const r = g.rows.find((x) => x.id === 'gpt-two-date')!;
    expect(check.rowTests(r).map((t) => t.what)).toEqual(['quote', 'second']);
    const text = readFileSync(join(dir, 'openai-deprecations.md'), 'utf8');
    const moved = text.replace('| Jun 3, 2024   | `gpt-two-date`', '| Jun 9, 2024   | `gpt-two-date`');
    const pageOf = (t: string) => (url: string) => (url === OPENAI ? { ok: true as const, text: t, at: '2026-11-25T09:06:11Z' } : { ok: false as const, reason: 'x' });
    expect(check.rowState(r, pageOf(text)).state).toBe('confirmed');
    expect(check.rowState(r, pageOf(moved)).state).toBe('changed');
    writeFileSync(join(dir, 'openai-deprecations.md'), moved);
    const d = spawnSync(process.execPath, [DRIFT, '--pages', dir, '--ledger', g.file], { encoding: 'utf8' });
    expect(d.status).toBe(1);
    expect(d.stdout).toContain('MOVED openai gpt-two-date');
    expect(d.stdout).toMatch(/ledger, second row \(read \d{4}-\d{2}-\d{2}\): \| Jun 3, 2024 \| `gpt-two-date`/);
  });

  // fix pass 1 (the reader's surviving mutant): a Google second row is checked as ONE page row, cell by cell (oneRowIn), never
  // by a plain substring — the joined cells are on no line of the page, so the plain check calls an unchanged row moved
  it('made-up pages: a Google second row is confirmed on its unchanged page, as one page row, and a moved one is changed', () => {
    const g = gen(MIN);
    const r = g.rows.find((x) => x.id === 'gemini-mini-c')!;
    expect(r.secondRow).toMatchObject({ heading: 'Live 9 models' });
    expect(check.rowTests(r).map((t) => [t.what, t.table])).toEqual([
      ['quote', true],
      ['second', true],
    ]);
    const text = check.pageTextOf('google-deprecations.html', readFileSync(join(MIN, 'google-deprecations.html'), 'utf8'));
    expect(check.quoteOn(text, r.secondRow!.quote)).toBe(false); // the plain matcher would not find it
    const pageOf = (t: string) => (url: string) => (url === DEP ? { ok: true as const, text: t, at: '2026-11-16T22:54:39Z' } : { ok: false as const, reason: 'x' });
    expect(check.rowState(r, pageOf(text)).state).toBe('confirmed');
    // the second table's row moved: its date cell changed
    // (its release date differs from the first row's, so the first row cannot stand in for it)
    const moved = text.replace('April 1, 2026', 'April 2, 2026');
    expect(check.rowState(r, pageOf(moved)).state).toBe('changed');
    // the drift check on the unchanged made-up set: nothing moved
    const d = spawnSync(process.execPath, [DRIFT, '--pages', MIN, '--ledger', g.file], { encoding: 'utf8' });
    expect(d.status, d.stdout).toBe(0);
    expect(d.stdout.trimEnd().split('\n').at(-1)).toBe(`0 rows moved — ${g.rows.length} rows checked of ${g.rows.length}`);
  });

  it('the table sweep counts the second rows said on the card, and one not said makes its exit 1', async () => {
    // @ts-expect-error a plain .mjs script with no declarations
    const { report, exitCode } = await import('../scripts/table-sweep.mjs');
    const s = { provider: 'openai', id: 'x', table: '## Past deprecations', line: '| a |', first: { table: '## Past deprecations', line: '| b |' } };
    const base = { stops: [], perPage: [], ids: [], seconds: [s], withoutLine: [], notRecognised: [] };
    expect(report(ROOT, { ...base, said: [s], unsaid: [] })).toContain('second rows said on the card: 1 of 1');
    expect(exitCode({ ...base, said: [s], unsaid: [] })).toBe(0);
    expect(report(ROOT, { ...base, said: [], unsaid: [s] })).toContain('second rows said on the card: 0 of 1');
    expect(exitCode({ ...base, said: [], unsaid: [s] })).toBe(1);
  });
});

// ── R4 — OpenAI's note on fine-tunes of the October 2026 shutdown ─────────
const NOTE_PRINTED = 'Fine-tuned versions of the legacy GPT models shut down in October 2026 followed the same shutdown schedule as their underlying base models.';
describe('R4 — the note is quoted for a fine-tune of a base on the rows its own link ties it to, and only those', () => {
  it('Amendment A5: the tie is read from the note — the link’s date, the notice date; the words’ month — and ties exactly the rows of that notice', () => {
    const note = LEDGER_DEFINITIONS.find((d) => d.word === 'fine-tunes of the October 2026 shutdown')!.quote;
    expect(check.fineTuneNoteTie(note)).toEqual({ notice: '2026-04-22', month: '2026-10' });
    const tied = LEDGER.filter((r) => check.fineTuneNoteTies(note, r));
    // the twelve page rows shut down on Oct 23, 2026 with the notice date Apr 22, 2026 name these 24 ids
    expect(tied.length).toBe(24);
    expect(tied.every((r) => r.announced === '2026-04-22' && r.shutdown === '2026-10-23')).toBe(true);
    expect(tied.map((r) => r.id)).toContain('gpt-3.5-turbo-0125');
    // the month alone would add gpt-5.4-cyber (shut down Oct 1, 2026; notice Sep 11, 2026)
    expect(check.fineTuneNoteTies(note, row('gpt-5.4-cyber'))).toBe(false);
  });

  it('V5: `ft:gpt-3.5-turbo-0125:acme::abc123` quotes the note, its page named, under Likely', () => {
    const f = lineOf('ft:gpt-3.5-turbo-0125:acme::abc123');
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain(`OpenAI's deprecations page: “${NOTE_PRINTED}”`);
    expect(f.detail).not.toContain('This check quotes no sentence');
  });

  it('V5’s negatives: `ft:gpt-5.4-cyber`, `ft:gpt-4-0314` quote no sentence; `ft:gpt-4o-2024-08-06` its own footnote', () => {
    for (const id of ['ft:gpt-5.4-cyber:acme::abc123', 'ft:gpt-4-0314:acme::abc123']) {
      const f = lineOf(id);
      expect(f.detail, id).toContain("This check quotes no sentence of OpenAI's about fine-tunes of this model.");
      expect(f.detail, id).not.toContain(NOTE_PRINTED);
    }
    const g = lineOf('ft:gpt-4o-2024-08-06:acme::abc123');
    expect(g.detail).toContain('Fine-tuned versions of the models listed above follow the same shutdown schedule');
    expect(g.detail).not.toContain(NOTE_PRINTED);
  });

  it('the note changed on its page in this run: not quoted, and the line says the sentence is not on the page as read', () => {
    const rec = { ...READ, definitions: new Map(READ.definitions) } as PageRead;
    (rec.definitions as Map<string, unknown>).set('openai|fine-tunes of the October 2026 shutdown', { state: 'changed', at: '2026-11-25T09:06:11Z', gone: [] });
    const f = lineOf('ft:gpt-3.5-turbo-0125:acme::abc123', rec);
    expect(f.detail).not.toContain(NOTE_PRINTED);
    expect(f.detail).toContain("The sentence this version read on OpenAI's deprecations page about fine-tunes is not on it as read in this run.");
  });

  it('OpenAI’s other sentences on fine-tuned models are read and checked like a definition, and none is printed', () => {
    const words = ['existing fine-tuned models', 'fine-tuning training on babbage-002 and davinci-002', 'fine-tunes of the GPT-3.5 Turbo snapshots', 'the legacy fine-tunes endpoint'];
    const defs = LEDGER_DEFINITIONS.filter((d) => words.includes(d.word));
    expect(defs.map((d) => d.word).sort()).toEqual([...words].sort());
    expect(defs.every((d) => d.url === OPENAI)).toBe(true);
    for (const r of LEDGER.filter((x) => x.provider === 'openai').slice(0, 40))
      for (const d of defs) expect(findings(one(`ft:${r.id}:a::b`)).some((f) => f.detail.includes(d.quote))).toBe(false);
  });

  it('made-up pages: the generator ties the two rows of the note’s notice date, not the month-only row; a note whose link names no row stops it', () => {
    const g = gen(MIN);
    expect(g.code, g.err).toBe(0);
    expect(g.out).toContain('the fine-tune note ties 2 rows (notice date 2026-04-22, shut down in 2026-10): gpt-tied-a, gpt-tied-b');
    const moved = gen(pagesWith({ file: 'openai-deprecations.md', from: '| **Oct 23, 2026** | `gpt-tied-a`, `gpt-tied-b` | `gpt-mini-b`    | Apr 22, 2026 |', to: '| **Oct 23, 2026** | `gpt-tied-a`, `gpt-tied-b` | `gpt-mini-b`    | Apr 23, 2026 |' }));
    expect(moved.code).not.toBe(0);
    expect(moved.err).toMatch(/the fine-tune note ties no row/);
  });

  it('made-up pages: a moved sentence about existing fine-tuned models is a moved definition in the drift check', () => {
    const g = gen(MIN);
    const dir = pagesWith({ file: 'openai-deprecations.md', from: 'until OpenAI retires its underlying base model.', to: 'until OpenAI shuts down its underlying base model.' });
    const d = spawnSync(process.execPath, [DRIFT, '--pages', dir, '--ledger', g.file], { encoding: 'utf8' });
    expect(d.status).toBe(1);
    expect(d.stdout).toContain('MOVED definition openai "existing fine-tuned models"');
  });
});

// ── R5 — Anthropic's own sentences on the platforms its dates cover ───────
const PLATFORMS_PRINTED =
  'The dates on this page apply to Anthropic-operated platforms: the Claude API, Claude Platform on AWS, Claude Models on Google Cloud (Anthropic managed), and Microsoft Foundry. Partner-operated platforms, Claude Models on Google Cloud (Google managed) and Amazon Bedrock, set their own retirement schedules, so a model’s lifecycle status and dates can differ.';
describe('R5 — an Anthropic id on Bedrock or Vertex quotes Anthropic’s sentences whole and says which side the platform falls on', () => {
  it('Bedrock: the sentences, then that Amazon Bedrock is partner-operated by them and runs its own schedule; Likely; the basis names the page', () => {
    const f = lineOf('claude-sonnet-4-5-20250929', READ, TODAY, 'bedrock');
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain(`Anthropic's model deprecations page says: “${PLATFORMS_PRINTED}” By those words Amazon Bedrock, where this site runs, is a partner-operated platform: Amazon Bedrock runs its own schedule (its page: https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html).`);
    expect(f.basis).toContain(ANTHROPIC);
  });

  it('Vertex: the sentences, then that the extract does not say which Claude Models on Google Cloud it is', () => {
    const f = lineOf('claude-opus-5-5', READ, TODAY, 'vertex');
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain(`“${PLATFORMS_PRINTED}” This site runs on Google Cloud (Vertex AI), and the extract does not say which Claude Models on Google Cloud it is: the Anthropic-managed one, which those words put under these dates, or the Google-managed one, which runs its own schedule`);
    expect(f.detail).not.toContain('Vertex AI runs its own schedule');
  });

  it('Azure keeps its line (Microsoft Foundry is under the dates); another provider on Vertex keeps its line', () => {
    expect(lineOf('claude-sonnet-4-5-20250929', READ, TODAY, 'azure').detail).toContain('says its dates apply on Microsoft Foundry, so they hold on this site');
    expect(lineOf('gemini-2.5-flash', READ, TODAY, 'vertex').detail).toContain('This site runs on Vertex AI, and Vertex AI runs its own schedule');
  });

  it('`--model-facts` on an id in Bedrock’s or Google Cloud’s form says the same, in the id’s terms', () => {
    const b = renderModelFacts('anthropic.claude-sonnet-4-5-20250929-v1:0', { pages: READ, today: TODAY });
    expect(b).toContain(`“${PLATFORMS_PRINTED}” By those words Amazon Bedrock, whose form this id is written in, is a partner-operated platform`);
    const v = renderModelFacts('claude-sonnet-4-5@20250929', { pages: READ, today: TODAY });
    expect(v).toContain('This id is written in Google Cloud’s (Vertex AI) form, and the id does not say which Claude Models on Google Cloud it is');
    expect(v).not.toContain('Vertex AI runs its own schedule');
  });

  it('Amendment A9: PARTNER_CAVEAT, a paraphrase nothing printed, is gone', () => {
    expect('PARTNER_CAVEAT' in lifecycle).toBe(false);
  });
});

// ── R6 — two lines say whose word they print ──────────────────────────────
describe('R6 — `--model-facts` prints a word as the provider’s only when it is the page’s; a quoted definition names its page', () => {
  it('a date and no status word: said so, never “Google’s word: **scheduled for shutdown**”', () => {
    const t = renderModelFacts('gemini-3.1-flash-lite', { pages: READ, today: TODAY });
    expect(t).toContain("- Google's Gemini deprecations page: a shutdown date and no status word on the page (not before 2027-05-07)");
    expect(t).not.toContain('**scheduled for shutdown**');
  });

  it('Amendment A8: a word this check read from a date is said as that — OpenAI’s past table, a past Shutdown date and no status word', () => {
    const t = renderModelFacts('gpt-3.5-turbo-0125', { pages: READ, today: TODAY });
    expect(t).toContain("- this check's word, read from the date on OpenAI's deprecations page: **shut down**");
    expect(t).not.toContain("OpenAI's word: **shut down**");
    expect(LEDGER.filter((r) => r.wordBy === 'date').every((r) => r.provider === 'openai' && r.table === 'Past deprecations')).toBe(true);
  });

  it('fix pass 1 (the seat’s ruling): under Google’s “Deprecated models” *shut down* is Google’s word, with the page’s sentence quoted (A8’s `gemini-2.0-flash-lite` was the seat’s mistake)', () => {
    const t = renderModelFacts('gemini-2.0-flash-lite', { pages: READ, today: TODAY });
    expect(t).toContain("- Google's word: **shut down**");
    expect(t).toContain("- Google's Gemini deprecations page: “Already-shutdown models and agents are listed under the Deprecated models and Deprecated agents sections.”");
    expect(t).not.toContain("this check's word");
    expect(LEDGER_DEFINITIONS).toContainEqual({
      provider: 'google',
      word: 'already-shutdown sections',
      url: DEP,
      quote: 'Already-shutdown models and agents are listed under the **Deprecated models** and **Deprecated agents** sections.',
    });
    // changed on its page in this run: not quoted
    const rec = { ...READ, definitions: new Map(READ.definitions) } as PageRead;
    (rec.definitions as Map<string, unknown>).set('google|already-shutdown sections', { state: 'changed', at: '2026-11-25T09:06:12Z', gone: [] });
    expect(renderModelFacts('gemini-2.0-flash-lite', { pages: rec, today: TODAY })).not.toContain('Already-shutdown models');
  });

  it('the generator holds the sentence: a page without it stops the build, and a moved one is a moved definition in the drift check', () => {
    const stop = gen(pagesWith({ file: 'google-deprecations.html', from: 'Already-shutdown models and agents', to: 'Shut-down models and agents' }));
    expect(stop.code).not.toBe(0);
    expect(stop.err).toMatch(/definition for google "already-shutdown sections" not found/);
    const g = gen(MIN);
    const dir = pagesWith({ file: 'google-deprecations.html', from: 'Already-shutdown models and agents', to: 'Shut-down models and agents' });
    const d = spawnSync(process.execPath, [DRIFT, '--pages', dir, '--ledger', g.file], { encoding: 'utf8' });
    expect(d.status).toBe(1);
    expect(d.stdout).toContain('MOVED definition google "already-shutdown sections"');
  });

  it('a release-notes entry that announces a deprecation keeps the page’s word', () => {
    // a release-notes entry that says "will be shut down" under "Deprecation announcement:" keeps the page's word
    expect(row('gemini-2.0-pro-exp').quote.startsWith('Deprecation announcement:')).toBe(true);
    expect(renderModelFacts('gemini-2.0-pro-exp', { pages: READ, today: TODAY })).toContain("- Google's word: **deprecated**");
  });

  it('every row whose word is not the page’s prints no “<provider>’s word: **<word>**”', () => {
    const not = LEDGER.filter((r) => r.wordBy !== undefined);
    expect(not.length).toBeGreaterThan(0);
    const P = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek' } as const;
    expect(not.filter((r) => renderModelFacts(r.id, { pages: READ, today: TODAY }).includes(`${P[r.provider]}'s word: **${r.word}**`)).map((r) => r.id)).toEqual([]);
  });

  it('Amendment A8: every line that quotes a definition names the definition’s page in its basis (seven of Google’s rows did not)', () => {
    const missing: string[] = [];
    for (const r of LEDGER) {
      for (const f of about(findings(one(r.id)), r.id)) {
        for (const d of LEDGER_DEFINITIONS) if (d.provider === r.provider && f.detail.includes(`(${d.url}): “${d.quote}”`) && !f.basis.includes(d.url)) missing.push(r.id);
      }
    }
    expect(missing).toEqual([]);
    expect(lineOf('gemini-2.5-flash-preview-09-25').basis).toContain(`Google's Gemini deprecations page, for the definition the line quotes, read in this run (2026-11-25 09:06 UTC): ${DEP}`);
  });
});

// ── R8 — a date before the run is not said in the future ──────────────────
describe('R8 (Amendment A1) — a date after the page’s read day and before the run’s day: the page’s date and its distance, whether or not the page was read', () => {
  for (const [how, pages] of [
    ['read', READ],
    ['offline', OFFLINE],
  ] as const) {
    it(`gpt-5 (${how}): on the run’s day it shuts down; the day after, and 14 and 30 days after, its page gives the date`, () => {
      expect(lineOf('gpt-5', pages, '2026-12-11').title).toContain('is deprecated and shuts down on 2026-12-11');
      expect(lineOf('gpt-5', pages, '2026-12-12').title).toContain('is deprecated, and its page gives a shutdown date of 2026-12-11, a date 1 day before this run');
      expect(lineOf('gpt-5', pages, '2026-12-25').title).toContain('is deprecated, and its page gives a shutdown date of 2026-12-11, a date 14 days before this run');
      expect(lineOf('gpt-5', pages, '2027-01-10').title).toContain('a date 30 days before this run');
      expect(lineOf('gpt-5', pages, '2026-12-25').title).not.toMatch(/shuts down on 2026-12-11|was shut down/);
    });
  }

  // fix pass 1 (the reader's surviving mutant): A1 on a display-name line — a date after the read day and before the run's
  // day carries its distance in the line that gives the date to the snapshots, read or offline
  it('a display-name line (`gpt-4o`) on a run after its row’s date: the date with its distance; on the date itself, the date alone', () => {
    const past =
      "On OpenAI's own API, `gpt-4o` is deprecated by its model page's word (“Status: Deprecated”); OpenAI's deprecations page gives a shutdown date of 2027-01-14 (a date 18 days before this run) to `gpt-4o-2024-08-06` and `gpt-4o-2024-11-20`, the snapshots its row “GPT-4o” names, with `gpt-6-luna` as their replacement; the link from `gpt-4o` to that row is this check's";
    expect(lineOf('gpt-4o', READ, '2027-02-01').title).toBe(past);
    expect(lineOf('gpt-4o', OFFLINE, '2027-02-01').title).toBe(past);
    expect(lineOf('gpt-4o', READ, '2027-01-14').title).toContain('gives a shutdown date of 2027-01-14 to `gpt-4o-2024-08-06`');
    expect(lineOf('gpt-4o', READ, '2027-01-14').title).not.toContain('before this run');
  });

  it('a date already past on the read day keeps the page’s word: babbage-002 was shut down on 2026-09-28', () => {
    expect(lineOf('babbage-002', READ, '2026-12-25').title).toContain('was shut down on 2026-09-28');
  });

  it('no line about any row says a date before the run’s day in the future', () => {
    const day = '2027-12-31';
    const bad: string[] = [];
    for (const r of LEDGER)
      for (const f of about(findings(one(r.id), OFFLINE, day), r.id))
        for (const m of f.title.matchAll(/(?:shuts down on|from) (\d{4}-\d{2}-\d{2})(?! by)/g)) if (m[1]! < day && m[1]! > r.readOn) bad.push(`${r.id}: ${f.title}`);
    expect(bad).toEqual([]);
  });
});

// ── R7 — the release ──────────────────────────────────────────────────────
describe('R7 — 0.4.7', () => {
  it('the CHANGELOG’s 0.4.7 entry opens with what a reader of 0.4.6’s card sees differently, and says the shape of LEDGER changed', () => {
    const log = readFileSync(join(PKG, 'CHANGELOG.md'), 'utf8');
    const entry = log.slice(log.indexOf('## 0.4.7'), log.indexOf('## 0.4.6'));
    expect(entry.length).toBeGreaterThan(0);
    expect(entry).toMatch(/`LEDGER`/);
    expect(entry).toMatch(/`pageWord`/);
  });
});
