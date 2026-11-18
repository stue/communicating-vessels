/**
 * The check 0.4.4 (filing 2026-11-17, rulings R1–R10). No test here makes a network request: pages are
 * the made-up set in tests/fixtures/pages-min/ or a read built in the test, and the share smoke runs
 * against a stand-in for the built CLI that answers without a request (R7). Each behaviour was seen red
 * once against 0.4.3 or with its change reverted (the filing's foot says which).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseModel, runCheck, cutQuote, pageLineQuote, foundWords, cliffLine, QUOTE_LIMIT } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER, LEDGER_SOURCES } from '../src/lifecycle-ledger.js';
import { pageShapeMisses, pageShapeOf, pageFileOf, pageTextOf, pageTitleOf, PAGE_SHAPES, rowState } from '../src/ledger-check.mjs';
import { readPagesFromDir, fromRecord, REQUEST_URLS, type PageRead } from '../src/pages.js';
import { renderModelFacts } from '../src/model-facts.js';
import { START_CHECK_INSTRUCTIONS, SERVER_INSTRUCTIONS, USAGE } from '../src/instructions.js';
import { OBSERVE_DAY_PLAN } from '../src/observe-plan.js';
import { READ } from './helpers/read.js';
import { sweepBases, shapeOf, baseShapeOf, strangerMisses, readWith, statesOf, PARTNER_CLAUSE } from './helpers/sweep.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const DRIFT = join(PKG, 'scripts/ledger-drift.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'check-044-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const tmp = (p: string) => mkdtempSync(join(ROOT, p));

/** A page set copied to a temp dir, with an edit applied to one file (the edit must apply). */
function pagesWith(edit?: { file: string; from: string | RegExp; to: string }): string {
  const d = tmp('pages-044-');
  cpSync(MIN, d, { recursive: true });
  if (edit) {
    const f = join(d, edit.file);
    const before = readFileSync(f, 'utf8');
    const after = before.replace(edit.from, edit.to);
    if (after === before) throw new Error(`the edit did not apply to ${edit.file}`);
    writeFileSync(f, after);
  }
  return d;
}
const gen = (pages: string) => {
  const out = join(tmp('gen-044-'), 'lifecycle-ledger.ts');
  const r = spawnSync(process.execPath, [GEN, '--pages', pages, '--out', out], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr, out, wrote: existsSync(out) };
};
const ex = (sites: Partial<Extract['callSites'][number]>[], models: Extract['models'] = []): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: sites.map((s, i) => ({ id: `src/a${i}.py:1`, model: 'x', ...s })), models });

// ── R1 — a basis line is a sentence a stranger can read, every one of them ──
describe('R1 — every basis the engine can print is a sentence a stranger can read', () => {
  const swept = sweepBases();
  const bases = [...swept.bases.keys()];
  const baseShapes = [...new Set(bases.map(baseShapeOf))].sort();
  if (process.env.PRINT_BASES === '1') {
    console.log(`${swept.findings} findings read, ${swept.bases.size} distinct bases, ${new Set(bases.map(shapeOf)).size} shapes, ${baseShapes.length} without the partner clause`);
    for (const s of baseShapes) console.log(`BASE ${s}`);
  }

  it('the sweep reached every line kind (a sweep that printed little proves little)', () => {
    const kinds: [string, RegExp][] = [
      ['a ledger row read in this run', /, read in this run \(/],
      ['a ledger row as read, unread now', /^[A-Z]\w+'s .* as read \d{4}-\d{2}-\d{2}: http/],
      ['a ledger row whose page changed', /changed when read in this run/],
      ['R4: one page read, the other not', /, not read in this run, as read /],
      ['a partner clause', /; (Amazon Bedrock|Vertex AI|Azure|OpenRouter): http/],
      ['the model page as the catalog read it', /'s page for this model, as the catalog read it /],
      ['the context limit', /^your estimate against the model's context limit, /],
      ['the output limit', /^your estimate against the model's output limit, /],
      ['parallel tool calls', /does not make tool calls in parallel/],
      ['structured output', /the model has no structured-output mode$/],
      ['no retry', /says this call has no retry/],
      ['the input share', /^your token estimates; 85% is a rule of thumb/],
      ['a threshold on input tokens', /input tokens; .*\), against your estimate$/],
      ['a threshold on tools', /tools?; .*\), against this site's tool count$/],
      // fix pass 1 (Amendment A1): the four noun phrases became sentences
      ['the price', /^your token estimates multiplied by the catalog's prices for this model \(the catalog's record, /],
      ['cheaper models', /^your token estimates at each model's prices in the catalog; nothing on this line says how well/],
      ['the observe day', /^this check reads the extract of your code and runs none of your calls/],
      ['not recognised', /^this id was looked up in the catalog and in the providers' pages this check reads, and matched neither$/],
    ];
    expect(kinds.filter(([, re]) => !bases.some((b) => re.test(b))).map(([k]) => k)).toEqual([]);
  });

  it('no basis carries a field name, an "=", or a word of ours', () => {
    const bad = bases.map((b) => ({ b, why: strangerMisses(b) })).filter((x) => x.why.length);
    const byShape = new Map<string, string[]>();
    for (const x of bad) byShape.set(shapeOf(x.b), x.why);
    expect([...byShape].map(([s, why]) => `${s}  ← ${why.join(', ')}`)).toEqual([]);
  });

  it('every value the threshold parenthesis can take is written out, from the record (never from the reason’s prose)', () => {
    expect(foundWords({})).toBe('no record of how it was found');
    expect(foundWords({ evidence: { class: 'probed', verdict: 'confirmed', lastProbed: '2026-11-12' } })).toBe('a test reproduced the problem on 2026-11-12');
    expect(foundWords({ evidence: { class: 'probed', verdict: 'flagged' } })).toBe('a test did not reproduce the problem');
    expect(foundWords({ evidence: { class: 'probed', verdict: 'knee-moved', lastProbed: '2026-10-01' } })).toBe('a test moved the threshold on 2026-10-01, and the catalog was changed to match');
    expect(foundWords({ evidence: { class: 'probed' } })).toBe('a test was run; its result is not recorded');
    expect(foundWords({ evidence: { class: 'observed', lastProbed: '2026-10-01' } })).toBe('the problem was seen in real calls, last on 2026-10-01');
    expect(foundWords({ evidence: { class: 'assumed' } })).toBe('carried over from a similar model, not tested on this one');
    expect(foundWords({ evidence: { class: 'asserted' } })).toBe('stated by the catalog, with no test behind it');
    // a reason that says "measured" with no evidence record is still "no record" (s115: a label from a record, never from prose)
    const prose = cliffLine('m', { metric: 'input_tokens', threshold: 1000, action: 'downgrade_quality_warning', reason: 'measured on real traffic, n=12' }, 2000);
    expect(prose.basis).toBe('a threshold the catalog holds for this model (1,000 input tokens; no record of how it was found), against your estimate');
  });

  it('the set of basis sentences is the one read by a stranger: a new form is added to tests/fixtures/basis-shapes.txt on purpose, never by drift', () => {
    // s119: a gate of forbidden words lets paraphrases through, so the forms themselves are pinned too
    const pinned = readFileSync(join(PKG, 'tests/fixtures/basis-shapes.txt'), 'utf8').trim().split('\n').sort();
    expect(baseShapes).toEqual(pinned);
    expect(bases.every((b) => !PARTNER_CLAUSE.test(baseShapeOf(b)))).toBe(true);
  });
});

// ── R2 — a quote is the page's words or it is marked ──────────────────────
/** The same whitespace and markdown normalisation the page comparison and the card use. */
const norm = (r: (typeof LEDGER)[number]) =>
  (r.section !== undefined ? r.quote.replace(/ \| $/, '') : r.quote)
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '');

/** A prefix of `whole` that ends at a sentence end or a table-cell boundary, outside any backticks. */
function atBoundary(whole: string, prefix: string): boolean {
  if (!whole.startsWith(prefix) || prefix.length === 0) return false;
  if (((prefix.match(/`/g) ?? []).length) % 2 !== 0) return false;
  const rest = whole.slice(prefix.length);
  return rest.startsWith(' | ') || (/[.!?]$/.test(prefix) && /^\s/.test(rest));
}
/** A printed quote is the whole quote, or a boundary prefix and "…". */
const fair = (whole: string, q: string) => q === whole || (q.endsWith('…') && atBoundary(whole, q.slice(0, -1)));

describe('R2 — a quote is never cut inside a word or an id', () => {
  const confirmed = readWith((r) => statesOf(r)[0]!);
  const printed = LEDGER.map((r) => {
    const line = analyseModel(r.id, { pages: confirmed, today: '2026-11-17' }, { platform: 'provider-api' }).lines[0]!;
    const m = /The page's line: “([\s\S]*?)”\.(?: |$)/.exec(line.detail);
    return { r, q: m?.[1] };
  });

  it('every quote a card prints, over the 307 rows: the row’s quote, or a prefix of it ending at a sentence end or a cell boundary, then “…”', () => {
    const shown = printed.filter((p) => p.q !== undefined);
    // the rows whose line quotes the page's line (a row with a provider definition quotes the definition instead)
    expect(shown.length).toBeGreaterThan(100);
    expect(shown.filter(({ r, q }) => !fair(norm(r), q!)).map(({ r, q }) => `${r.id}: “…${q!.slice(-40)}”`)).toEqual([]);
  });

  it('every quote --model-facts prints, over all 307 rows, the same way', () => {
    expect(LEDGER).toHaveLength(307);
    const bad: string[] = [];
    for (const r of LEDGER) {
      const out = renderModelFacts(r.id, { pages: confirmed, today: '2026-11-17' });
      const m = /^- source: \S+ \([^\n]*?\) — “([^\n]*)”$/m.exec(out);
      if (!m) bad.push(`${r.id}: no source line`);
      else if (!fair(norm(r), m[1]!)) bad.push(`${r.id}: “…${m[1]!.slice(-40)}”`);
    }
    expect(bad).toEqual([]);
  });

  it('Google’s reroute of gemini-2.5-flash is printed whole', () => {
    const g = printed.find((p) => p.r.id === 'gemini-2.5-flash')!;
    expect(g.q).toBe(norm(g.r));
    expect(g.q).toContain('API requests to `gemini-2.5-flash` will automatically route to `gemini-3.5-flash-lite`)');
  });

  it('a quote over the limit is cut at its last cell boundary or sentence end before the limit, never inside code marks, and ends with “…”', () => {
    const g = norm(LEDGER.find((r) => r.id === 'gemini-2.5-flash')!);
    // at 120 characters the last cell boundary before the limit ends the quote (the last cell runs past it, so all of it goes)
    expect(cutQuote(g, 120)).toBe('`gemini-2.5-flash` | June 17, 2025 | December 1, 2026…');
    // at 240, 0.4.3's cut, the same: never "…route to `gemi"
    expect(cutQuote(g, 240)).toBe('`gemini-2.5-flash` | June 17, 2025 | December 1, 2026…');
    // a sentence end counts; the "." inside `gemini-2.5-flash` does not
    const s = 'First sentence ends here. Second one names `model-2.5.x` and runs on for quite a while past the limit.';
    expect(cutQuote(s, 60)).toBe('First sentence ends here.…');
    // a boundary inside code marks is not a boundary: the cut falls before the code mark opens
    const c = 'Lead | `a | b. C | d. E | f. G | h. I | j. K | l. M | n. O | p.` | after the code mark, and on to the end';
    expect(c.indexOf('`', 8)).toBeGreaterThan(60);
    expect(cutQuote(c, 60)).toBe('Lead…');
    // and the first boundary after the code mark closes is one
    expect(cutQuote(c, 80)).toBe('Lead | `a | b. C | d. E | f. G | h. I | j. K | l. M | n. O | p.`…');
    // no boundary before the limit: printed whole, never cut inside a word
    const w = 'onelongwordwithnoboundaryatallthatrunspastthelimitandkeepsgoing';
    expect(cutQuote(w, 20)).toBe(w);
    expect(QUOTE_LIMIT).toBe(300);
    expect(Math.max(...LEDGER.map((r) => norm(r).length))).toBeLessThanOrEqual(QUOTE_LIMIT);
    expect(pageLineQuote(LEDGER.find((r) => r.id === 'gemini-2.5-flash')!)).toBe(g);
  });
});

// ── R3 — the header says what each number counts ─────────────────────────
describe('R3 — the header: what each number counts, in sentences, plurals written out', () => {
  const F = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-043.json'), 'utf8')));
  const line3 = (e: Extract, pages: PageRead = READ) => runCheck(e, { pages }).card.split('\n')[2];

  it('the fixture: how many ids are flagged and by whom, then where the flagged ids are written', () => {
    expect(line3(F)).toBe(
      '0 AI call sites and 8 model ids: `gpt-4o-realtime-preview`, `claude-3-5-sonnet-20241022`, `gpt-4-turbo-2024-04-09`, `claude-sonnet-4-20250514`, `gpt-4o`, `gemini-2.5-flash`, `claude-opus-4-1`, `gemini-pro`. ' +
        "7 are flagged by their providers, and 1 by this check's reading of Google's release notes page. " +
        'Of the 8 flagged ids, 3 are in code that runs, 1 in tests, 1 in docs, 1 in examples and 2 where the extract does not say.',
    );
  });

  it('one id: the provider by name, singular words', () => {
    expect(line3(ex([{ model: 'gpt-4o-mini', platform: 'provider-api', context: 'runs' }]))).toBe(
      '1 AI call site and 1 model id: `gpt-4o-mini`. 1 is flagged by OpenAI. The flagged id is in code that runs.',
    );
  });

  it('no id flagged: says so, and counts nothing it did not see', () => {
    expect(line3(ex([{ model: 'claude-opus-5-5' }, { model: 'gemini-3.8-flash' }]))).toBe(
      '2 AI call sites and 2 model ids: `claude-opus-5-5`, `gemini-3.8-flash`. No provider flags any of them.',
    );
    expect(line3(ex([{ model: 'claude-opus-5-5' }]))).toBe('1 AI call site and 1 model id: `claude-opus-5-5`. Its provider does not flag it.');
    expect(line3(ex([{ model: 'claude-opus-5-5' }, { model: 'not-a-model-anyone-ships' }]))).toBe(
      '2 AI call sites and 2 model ids: `claude-opus-5-5`, `not-a-model-anyone-ships`. 1 is not recognised. The other one is not flagged by its provider.',
    );
  });

  // The same check over the 40 private cards as well (46 texts) is in tests/regression-cards.test.ts, the file the
  // public export withholds; this one holds in every tree (0.4.4 fix pass 3).
  it('no "(s)" in any text the CLI or the server prints, nor on the fixture card', () => {
    const texts = [USAGE, START_CHECK_INSTRUCTIONS, SERVER_INSTRUCTIONS, OBSERVE_DAY_PLAN, renderModelFacts('gpt-4o', { pages: READ }), runCheck(F, { pages: READ }).card];
    expect(texts.length).toBe(6);
    expect(texts.filter((t) => /\w\(s\)/.test(t))).toEqual([]);
  });
});

// ── R4 — the sentence names the page that was not read ────────────────────
describe('R4 — a row on two pages, one read and one not, names which', () => {
  const MINI = 'https://developers.openai.com/api/docs/models/gpt-4o-mini.md';
  const DEP = 'https://developers.openai.com/api/docs/deprecations.md';
  const site = { model: 'gpt-4o-mini', platform: 'provider-api' as const, context: 'runs' as const };
  const lineOf = (pages: PageRead) => runCheck(ex([site]), { pages, today: '2026-11-19' }).findings.find((f) => f.title.includes('gpt-4o-mini'))!;
  /** The release's record with one page's outcome replaced. */
  const withPage = (url: string, outcome: { ok: false; reason: string }) => fromRecord({ ...JSON.parse(JSON.stringify({ how: 'record', changedRows: [], changedDefinitions: [] })), pages: READ.pages.map((p) => (p.url === url ? { url, ...outcome } : p)) });

  it('the model page not read: the line and the basis name it; the deprecations page was read', () => {
    const f = lineOf(withPage(MINI, { ok: false, reason: 'not the page this version reads' }));
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain(
      "In this run OpenAI's deprecations page was read (2026-11-18 18:23 UTC) and still says this, and OpenAI's model page for GPT-4o mini was not read (not the page this version reads); for that page, this is what this version of the check read on 2026-11-18, 1 day before this run.",
    );
    expect(f.detail).not.toContain('was not read in this run (not the page this version reads)');
    expect(f.basis).toBe(`OpenAI's deprecations page, read in this run (2026-11-18 18:23 UTC): ${DEP}; OpenAI's model page for GPT-4o mini, not read in this run, as read 2026-11-18: ${MINI}`);
    // --model-facts says the same of its source line
    expect(renderModelFacts('gpt-4o-mini', { pages: withPage(MINI, { ok: false, reason: 'not the page this version reads' }), today: '2026-11-19' })).toContain(
      `- source: ${DEP} (read in this run, 2026-11-18 18:23 UTC; OpenAI's model page for GPT-4o mini not read in this run (not the page this version reads), as read 2026-11-18, 1 day before this lookup)`,
    );
  });

  it('the deprecations page not read, the model page read: the other way round', () => {
    const f = lineOf(withPage(DEP, { ok: false, reason: 'HTTP 503' }));
    expect(f.detail).toContain("In this run OpenAI's model page for GPT-4o mini was read (2026-11-18 18:23 UTC) and still says this, and OpenAI's deprecations page was not read (HTTP 503);");
    expect(f.basis).toBe(`OpenAI's model page for GPT-4o mini, read in this run (2026-11-18 18:23 UTC): ${MINI}; OpenAI's deprecations page, not read in this run, as read 2026-11-18: ${DEP}`);
  });

  it('neither read, for two reasons: both pages named, each with its reason', () => {
    const rows = new Map(READ.rows);
    rows.set('gpt-4o-mini', { state: 'unread', reason: 'HTTP 503', notRead: [{ url: DEP, reason: 'HTTP 503' }, { url: MINI, reason: 'timed out' }], read: [] });
    const f = lineOf({ ...READ, rows });
    expect(f.detail).toContain(
      "This is OpenAI's deprecations page and its model page for GPT-4o mini as this version of the check read them on 2026-11-18, 1 day before this run; they were not read in this run (OpenAI's deprecations page: HTTP 503; OpenAI's model page for GPT-4o mini: timed out).",
    );
  });

  it('the swapped page through --pages (the Verifier’s V6): the line names the model page as the one not read', () => {
    const d = pagesWith({ file: 'openai-model-gpt-4o-mini.md', from: /^[\s\S]*$/, to: readFileSync(join(MIN, 'openai-model-gpt-4o.md'), 'utf8') });
    const f = lineOf(readPagesFromDir(d));
    expect(f.detail).toMatch(/In this run OpenAI's deprecations page was read \([^)]*\) and (still says this|no longer says this as it was read), and OpenAI's model page for GPT-4o mini was not read \(not the page this version reads\)/);
    expect(f.basis).toMatch(/; OpenAI's model page for GPT-4o mini, not read in this run, as read \d{4}-\d{2}-\d{2}: https:\/\/developers\.openai\.com\/api\/docs\/models\/gpt-4o-mini\.md$/);
  });

  it('rowState reports a page that was read and no longer carries its quote as such, beside the one not read', () => {
    const row = LEDGER.find((r) => r.id === 'gpt-4o-mini')!;
    const s = rowState(row, (u) => (u === row.url ? { ok: true, text: 'nothing of the row', at: '2026-11-17T23:31:12Z' } : { ok: false, reason: 'HTTP 503' }));
    expect(s).toEqual({ state: 'unread', reason: 'HTTP 503', notRead: [{ url: MINI, reason: 'HTTP 503' }], read: [{ url: DEP, at: '2026-11-17T23:31:12Z', stands: false }] });
  });
});

// ── R5 — more than one identity line is not the page ─────────────────────
describe('R5 — a model page has exactly one "Model ID:" line, naming its model', () => {
  const page = (...ids: string[]) => ['# GPT-4o mini', '', ...ids.map((id) => `Model ID: \`${id}\`\n`), 'Status: Deprecated', ''].join('\n');
  const F = 'openai-model-gpt-4o-mini.md';
  it('zero lines: not the page', () => expect(pageShapeMisses(F, page()).join(' ')).toMatch(/Model ID/));
  it('one line, right: the page', () => expect(pageShapeMisses(F, page('gpt-4o-mini'))).toEqual([]));
  it('one line, wrong: not the page', () => expect(pageShapeMisses(F, page('gpt-4o')).join(' ')).toMatch(/Model ID/));
  it('two lines, right then wrong: not the page', () => expect(pageShapeMisses(F, page('gpt-4o-mini', 'gpt-4o')).join(' ')).toMatch(/Model ID/));
  it('two lines, wrong then right: not the page', () => expect(pageShapeMisses(F, page('gpt-4o', 'gpt-4o-mini')).join(' ')).toMatch(/Model ID/));
  it('two lines, both right: not the page', () => expect(pageShapeMisses(F, page('gpt-4o-mini', 'gpt-4o-mini')).join(' ')).toMatch(/Model ID/));
  it('the refusal says what it found', () =>
    expect(pageShapeMisses(F, page('gpt-4o-mini', 'gpt-4o'))).toEqual(['exactly one "Model ID: `gpt-4o-mini`" line (found `gpt-4o-mini` and `gpt-4o`)']));
  it('the generator stops on a page with two', () => {
    const d = pagesWith({ file: F, from: 'Model ID: `gpt-4o-mini`', to: 'Model ID: `gpt-4o-mini`\n\nModel ID: `gpt-4o`' });
    const g = gen(d);
    expect(g.code).toBe(1);
    expect(g.err).toContain('stop: openai-model-gpt-4o-mini.md is not the page this version reads — it lacks exactly one "Model ID: `gpt-4o-mini`" line (found `gpt-4o-mini` and `gpt-4o`)');
    expect(g.wrote).toBe(false);
  });
});

// ── R6 — a page is called what its own title calls it ─────────────────────
describe('R6 — each page by its own title', () => {
  const TITLES: Record<string, string> = {
    'anthropic-deprecations.md': 'Model deprecations',
    'openai-deprecations.md': 'Deprecations',
    'openai-model-gpt-4o.md': 'GPT-4o',
    'openai-model-gpt-4o-mini.md': 'GPT-4o mini',
    'openai-model-gpt-4.1.md': 'GPT-4.1',
    'openai-model-gpt-4.1-mini.md': 'GPT-4.1 mini',
    'google-deprecations.html': 'Gemini deprecations',
    'google-changelog.html': 'Release notes',
    'deepseek-updates.html': 'Change Log | DeepSeek API Docs',
    'deepseek-first-api-call.html': 'Your First API Call | DeepSeek API Docs',
  };

  it('the ledger’s source list carries each page’s title, the one its shape expects, read 2026-11-18', () => {
    expect(LEDGER_SOURCES.map((s) => [pageFileOf(s.url), s.title])).toEqual(LEDGER_SOURCES.map((s) => [pageFileOf(s.url), TITLES[pageFileOf(s.url)!]]));
    for (const s of LEDGER_SOURCES) expect(pageShapeOf(pageFileOf(s.url)!)!.expectedTitle(pageFileOf(s.url)!)).toBe(s.title);
  });

  it('the generator writes each page’s title, as read from the saved page, into the source list it writes', () => {
    const g = gen(MIN);
    expect(g.code, g.err).toBe(0);
    const sources = JSON.parse(/export const LEDGER_SOURCES: readonly \w+\[\] = (\[[\s\S]*?\n\]);/.exec(readFileSync(g.out, 'utf8'))![1]!) as { url: string; title?: string }[];
    expect(sources.map((s) => [pageFileOf(s.url), s.title])).toEqual(sources.map((s) => [pageFileOf(s.url), TITLES[pageFileOf(s.url)!]]));
  });

  it('the request list follows from the source list: ten pages, the /news address kept for the sentence only it carries', () => {
    expect(REQUEST_URLS).toHaveLength(LEDGER_SOURCES.length);
    expect(REQUEST_URLS).toContain('https://api-docs.deepseek.com/news');
    expect(pageFileOf('https://api-docs.deepseek.com/news')).toBe('deepseek-first-api-call.html');
    const rows = LEDGER.filter((r) => r.alsoUrl === 'https://api-docs.deepseek.com/news');
    expect(rows.map((r) => r.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
    // its sentence is quoted from that page, and /updates (the row's own page) does not carry it: the fixtures hold the pages' own words
    const upd = pageTextOf('deepseek-updates.html', readFileSync(join(MIN, 'deepseek-updates.html'), 'utf8'));
    for (const r of rows) expect(upd.replace(/\s+/g, ' ')).not.toContain(r.alsoQuote!);
  });

  for (const [file, title] of Object.entries(TITLES).filter(([f]) => existsSync(join(MIN, f)))) {
    it(`${file}: a changed title stops the generator and the page is not read at run time`, () => {
      const raw = readFileSync(join(MIN, file), 'utf8');
      const at = raw.indexOf(title);
      expect(at).toBeGreaterThanOrEqual(0);
      const d = pagesWith({ file, from: title, to: `${title} (renamed)` });
      const g = gen(d);
      expect(g.code).toBe(1);
      expect(g.err).toContain(`stop: ${file} is not the page this version reads — it lacks the title "${title}" (found "${title} (renamed)")`);
      expect(g.wrote).toBe(false);
      expect(pageTitleOf(file, pageTextOf(file, readFileSync(join(d, file), 'utf8')))).toBe(`${title} (renamed)`);
    });
  }

  it('the card names each page by its title', () => {
    const card = runCheck(
      ex([
        { model: 'claude-opus-4-1', platform: 'provider-api' },
        { model: 'gpt-4o-mini', platform: 'provider-api' },
        { model: 'gemini-2.5-flash', platform: 'provider-api' },
        { model: 'gemini-pro', platform: 'provider-api' },
        { model: 'deepseek-v4-flash', platform: 'provider-api' },
      ]),
      { pages: READ },
    ).card;
    for (const name of [
      "Anthropic's model deprecations page",
      "OpenAI's deprecations page and its model page for GPT-4o mini",
      "Google's Gemini deprecations page",
      "Google's release notes page",
      "DeepSeek's change log and its “Your First API Call” page",
    ])
      expect(card, name).toContain(name);
    expect(card).not.toMatch(/\b(Anthropic|OpenAI|Google|DeepSeek)'s page[,: ]/);
    // the address stays as printed (…/docs/changelog); the words never call the page a changelog
    expect(card.replace(/https?:\/\/\S+/g, '')).not.toMatch(/changelog/i);
  });

  it('every shape entry has a title it expects and a name made from it, and the name says the title’s own words', () => {
    for (const [key, s] of Object.entries(PAGE_SHAPES)) {
      const file = key === 'openai-model-*.md' ? 'openai-model-gpt-4o-mini.md' : key;
      const t = s.expectedTitle(file)!;
      expect(t, key).toBeTruthy();
      expect(s.name(t).toLowerCase(), key).toContain(t.replace(/ \| DeepSeek API Docs$/, '').toLowerCase());
    }
  });

  it('the README names the ten pages by the titles the source list carries', () => {
    const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
    for (const s of LEDGER_SOURCES) expect(readme, s.title).toContain(`*${s.title.replace(/ \| DeepSeek API Docs$/, '')}*`);
  });
});

// ── R7 — the share smoke cannot reach production by default (and R8: it leaves nothing behind) ──
describe('R7 — scripts/smoke-share.mjs posts to production only with --production', () => {
  const PRODUCTION = 'https://kgauto-dashboard.vercel.app/api/check-submission';
  /**
   * The real script, copied beside a stand-in for the build: dist/bin.js answers as the CLI does but makes no
   * request (it logs the endpoint it was given), dist/index.js and package.json carry a version. Nothing here
   * can reach any address: the stand-in has no network code, and the script runs only the stand-in.
   */
  function harness() {
    const d = tmp('smoke-share-');
    mkdirSync(join(d, 'scripts'));
    mkdirSync(join(d, 'dist'));
    mkdirSync(join(d, 'tmp'));
    for (const f of readdirSync(join(PKG, 'scripts')).filter((f) => f.startsWith('smoke-share'))) copyFileSync(join(PKG, 'scripts', f), join(d, 'scripts', f));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeFileSync(join(d, 'dist/index.js'), `export const CHECK_VERSION = '9.9.9';\nexport const SHARE_ENDPOINT_DEFAULT = '${PRODUCTION}';\n`);
    writeFileSync(
      join(d, 'dist/bin.js'),
      [
        "import { readFileSync, appendFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        "const ex = JSON.parse(readFileSync(args[args.indexOf('--extract') + 1], 'utf8'));",
        `const endpoint = process.env.KGAUTO_SHARE_ENDPOINT_OVERRIDE || '${PRODUCTION}';`,
        'appendFileSync(process.env.FAKE_BIN_LOG, JSON.stringify({ args, endpoint }) + "\\n");',
        "if (process.env.FAKE_BIN_FAIL === '1') { console.error('the stand-in failed on purpose'); process.exit(1); }",
        'console.log(`# Communicating Vessels — the check: ${ex.project.name}\\n`);',
        "if (args.includes('--share')) console.log(`[--share] Sent to ${endpoint} (submission 1). Sharing stores one row.`);",
      ].join('\n'),
    );
    const log = join(d, 'bin-log.jsonl');
    const run = (flags: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(process.execPath, [join(d, 'scripts/smoke-share.mjs'), ...flags], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: join(d, 'tmp'), FAKE_BIN_LOG: log, ...env },
      });
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { endpoint: string }) : [];
      return { code: r.status, out: r.stdout, err: r.stderr, calls, left: readdirSync(join(d, 'tmp')) };
    };
    return { run };
  }

  it('without --production and without an override: exit 1, one sentence, no request, nothing left behind', () => {
    const r = harness().run([]);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/--production/);
    expect(r.err).toMatch(/KGAUTO_SHARE_ENDPOINT_OVERRIDE/);
    expect(r.calls).toEqual([]);
    expect(r.left).toEqual([]);
  });

  it('with an override: posts there, and leaves nothing behind', () => {
    const r = harness().run([], { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/api/check-submission' });
    expect(r.code, r.err).toBe(0);
    expect(r.calls.map((c) => c.endpoint)).toEqual(['http://127.0.0.1:1/api/check-submission']);
    expect(r.left).toEqual([]);
  });

  it('with --production: the CLI is run with no override, so it posts to the production endpoint (here, the stand-in)', () => {
    const r = harness().run(['--production']);
    expect(r.code, r.err).toBe(0);
    expect(r.calls.map((c) => c.endpoint)).toEqual([PRODUCTION]);
    expect(r.left).toEqual([]);
  });

  it('with --production and an override: refused, no request', () => {
    const r = harness().run(['--production'], { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/' });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.left).toEqual([]);
  });

  it('R8: when the CLI fails, the smoke exits 1 and still leaves nothing behind', () => {
    const r = harness().run([], { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/', FAKE_BIN_FAIL: '1' });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.left).toEqual([]);
  });

  it('the script carries no production address of its own: it reads the build’s', () => {
    const src = readFileSync(join(PKG, 'scripts/smoke-share.mjs'), 'utf8');
    expect(src).not.toContain('kgauto-dashboard.vercel.app');
    expect(src).toContain('SHARE_ENDPOINT_DEFAULT');
  });
});

// ── R9 — every typed sentence in the generator is checked on its page ─────
describe('R9 — each sentence the generator types stops the build when its saved page no longer carries it, and the drift script re-reads it', () => {
  // the made-up page set holds each typed sentence in the pages' own words; each case changes one word of one sentence
  const CASES: { what: string; file: string; from: string; to: string; refusal: RegExp }[] = [
    { what: 'DeepSeek LEGACY', file: 'deepseek-updates.html', from: 'in three months', to: 'in four months', refusal: /deepseek: sentence not on deepseek-updates\.html: The two legacy API model names/ },
    { what: 'DeepSeek LEGACY_POINT', file: 'deepseek-updates.html', from: 'respectively', to: 'in turn', refusal: /deepseek: sentence not on deepseek-updates\.html: During the current period/ },
    { what: 'DeepSeek RETIRED', file: 'deepseek-updates.html', from: 'temporarily routed', to: 'routed for now', refusal: /deepseek: sentence not on deepseek-updates\.html: The previous-generation models/ },
    { what: 'DeepSeek RENAME', file: 'deepseek-updates.html', from: 'to call the latest', to: 'to reach the latest', refusal: /deepseek: sentence not on deepseek-updates\.html: Change the model name/ },
    { what: 'DeepSeek FIRST_CALL', file: 'deepseek-first-api-call.html', from: 'billed at the Flash price', to: 'billed at the Pro price', refusal: /deepseek: sentence not on deepseek-first-api-call\.html: The legacy names/ },
    { what: 'Google NAMED (Pro)', file: 'google-changelog.html', from: 'Gemini 1.0 Pro is no longer supported.', to: 'Gemini 1.0 Pro is not supported.', refusal: /changelog: "Gemini 1\.0 Pro is no longer supported\." is not under "February 18, 2025"/ },
    { what: 'Google NAMED (Vision)', file: 'google-changelog.html', from: 'removed from Google AI', to: 'gone from Google AI', refusal: /changelog: "Support for Gemini 1\.0 Pro Vision removed/ },
    { what: 'Google INTRO (gemini-pro)', file: 'google-changelog.html', from: 'gemini-pro: New text model', to: 'gemini-pro: A text model', refusal: /changelog: "gemini-pro: New text model/ },
    { what: 'Google INTRO (gemini-pro-vision)', file: 'google-changelog.html', from: 'gemini-pro-vision: New multimodal', to: 'gemini-pro-vision: A multimodal', refusal: /changelog: "gemini-pro-vision: New multimodal/ },
    { what: 'Anthropic definition', file: 'anthropic-deprecations.md', from: 'Requests to retired models fail.', to: 'Requests to retired models error.', refusal: /definition for anthropic "retired" not found/ },
    { what: 'OpenAI definition', file: 'openai-deprecations.md', from: 'no longer accepts requests', to: 'refuses requests', refusal: /definition for openai "shut down" not found/ },
    { what: 'Google definition', file: 'google-deprecations.html', from: 'completely turned off', to: 'fully turned off', refusal: /definition for google "shut down" not found/ },
  ];
  // the made-up set's own ledger, written once by the generator
  const minLedger = gen(MIN);

  it('the made-up set builds, and the drift script finds nothing moved on it', () => {
    expect(minLedger.code, minLedger.err).toBe(0);
    const d = spawnSync(process.execPath, [DRIFT, '--pages', MIN, '--ledger', minLedger.out], { encoding: 'utf8' });
    expect(d.status, d.stdout + d.stderr).toBe(0);
  });

  for (const c of CASES) {
    it(`${c.what}: the build stops, and the drift script reports it moved`, () => {
      const d = pagesWith({ file: c.file, from: c.from, to: c.to });
      const g = gen(d);
      expect(g.code).not.toBe(0);
      expect(g.err).toMatch(c.refusal);
      expect(g.wrote).toBe(false);
      const r = spawnSync(process.execPath, [DRIFT, '--pages', d, '--ledger', minLedger.out], { encoding: 'utf8' });
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toMatch(/^MOVED |^MOVED definition /m);
    });
  }
});
