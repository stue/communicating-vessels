/**
 * The check 0.4.8 (filing 2026-11-27): a routed row is printed with the notice above it. R1 a notice is the page's, kept
 * whole; R2 the generator stops on a callout it does not read; R3 the card quotes the notice and adds no word of its own;
 * R4 `--model-facts` prints it the same way and points its price line at it; R5 a notice is confirmed like a row; R6 no
 * sentence about what a call returns, tested by allowing the exact templates, never by a list of phrases.
 * No test here makes a network request: the pages are the read record of this release (tests/helpers/read.ts), a read
 * switched off as `--offline` switches it, a read made from a page written here, or the made-up page set in
 * tests/fixtures/pages-min/ copied and edited in a scratch folder (real provider pages are never committed).
 * Each `it` was run on main's code (0.4.7, `011cc56`) before the build; the filing's Report says which were red there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, distanceWords, idSpans, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER } from '../src/lifecycle-ledger.js';
import { renderModelFacts } from '../src/model-facts.js';
import { noRequestRead, resolveRead, REQUEST_URLS, type PageRead } from '../src/pages.js';
import * as check from '../src/ledger-check.mjs';
import { READ } from './helpers/read.js';
import type { LedgerRow } from '../src/lifecycle-types.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const DRIFT = join(PKG, 'scripts/ledger-drift.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'check-048-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The day of the release's read (the record's pages were read 2026-11-25T09:06Z). */
const TODAY = '2026-11-25';
const OFFLINE: PageRead = noRequestRead();
const DEP = 'https://aistudio.google.com/docs/deprecations';
const one = (model: string): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform: 'provider-api', context: 'runs' }] });
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
const lineOf = (id: string, pages: PageRead = READ, today = TODAY) => about(runCheck(one(id), { pages, today }).findings, id)[0]!;
const row = (id: string) => LEDGER.find((r) => r.id === id)! as LedgerRow & { notice?: string };

/** The two notices as Google's page carries them (read 2026-11-27T09:35:10Z, sha256 4518e0d1…), links reduced to their text. */
const PRO_NOTICE =
  '`gemini-2.5-pro` is deprecated and is no longer available to select in Google AI Studio. Access through the API is limited to existing users who have actively used it in the past. Effective December 1, 2026, all API requests to `gemini-2.5-pro` will automatically route to `gemini-3.8-flash` and be billed at Gemini 3.8 Flash rates. Review the breaking API changes in the Gemini 3.8 Flash migration guide before December 1, 2026.';
const FLASH_NOTICE =
  '`gemini-2.5-flash` is deprecated and is no longer available to select in Google AI Studio. Effective December 1, 2026, all API requests to `gemini-2.5-flash` will automatically route to `gemini-3.5-flash-lite` and be billed at Gemini 3.5 Flash-Lite rates. Review the breaking API changes in the Gemini 3.5 Flash-Lite migration guide before December 1, 2026. Access to the 2.5 models is limited to users who have actively used them in the past. `gemini-2.5-flash-lite` is not deprecated and remains available through the API until further notice.';

/** The Pro callout as the page writes it (markup kept), for a page made here. */
const PRO_CALLOUT = `{% callout type="caution" %}
  \`gemini-2.5-pro\` is deprecated and is no longer available to select in Google AI
  Studio. Access through the API is limited to existing users who have actively
  used it in the past. Effective December 1, 2026, all API requests to
  \`gemini-2.5-pro\` will automatically route to
  [\`gemini-3.8-flash\`](/docs/models/gemini-3.8-flash) and be billed at
  [Gemini 3.8 Flash rates](/docs/pricing#gemini-3.8-flash). Review the breaking
  API changes in the
  [Gemini 3.8 Flash migration guide](/docs/whats-new-gemini-3.8#migrate-to-gemini-3-8-flash)
  before December 1, 2026.

{% /callout %}`;

/** A Google deprecations page of the shape this version reads, holding the Pro row's section, with or without its callout. */
function proPage(withCallout: boolean): string {
  const cells = row('gemini-2.5-pro').quote.split(' | ');
  return [
    '# Gemini deprecations',
    '',
    '## Gemini 2.5 Pro models  {% id="gemini-2.5-pro-models" %}',
    '',
    ...(withCallout ? [PRO_CALLOUT, ''] : []),
    '{% table %}',
    '  * Model',
    '  * Release date',
    '  * Shutdown date',
    '  * Recommended replacement',
    '',
    '  ---',
    '',
    ...cells.map((c) => `  * ${c}`),
    '{% /table %}',
    '',
    '### Deprecated models  {% id="gemini-2.5-pro-deprecated-models" %}',
    '',
  ].join('\n');
}
/** A read in which only Google's deprecations page was read, with this text. */
function readWithGoogle(text: string): PageRead {
  const pages = REQUEST_URLS.map((url) =>
    url === DEP
      ? { url, file: 'google-deprecations.html', ok: true as const, at: '2026-11-27T09:35:10Z' }
      : { url, ok: false as const, reason: 'not read by this test' },
  );
  return resolveRead('directory', pages, undefined, new Map([[DEP, check.pageTextOf('google-deprecations.html', text)]]));
}

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
  let rows: (LedgerRow & { notice?: string })[] = [];
  try {
    rows = JSON.parse(/export const LEDGER: readonly LedgerRow\[\] = (\[[\s\S]*?\n\]);/.exec(readFileSync(out, 'utf8'))![1]!);
  } catch {
    /* no ledger written */
  }
  return { code: r.status, err: r.stderr, out: r.stdout, file: out, rows, written: existsSync(out) };
}

/** A made-up section in the real page's shape: a callout above a routed row, naming the row, its target and a second row. */
const EIGHT = (o: { target?: string; date?: string; extra?: string } = {}) => `## Gemini 8 models  {% id="gemini-8-models" %}

{% callout type="caution" %}
  \`gemini-eight\` is deprecated and is no longer available to select in Google AI
  Studio. Effective ${o.date ?? 'December 1, 2026'}, all API requests to \`gemini-eight\`
  will automatically route to
  [\`${o.target ?? 'gemini-nine'}\`](/docs/models/gemini-nine) and be billed at
  [Gemini Nine rates](/docs/pricing#gemini-nine). Review the breaking
  API changes in the
  [Gemini Nine migration guide](/docs/whats-new#nine)
  before ${o.date ?? 'December 1, 2026'}. \`gemini-eight-lite\` is not deprecated.${o.extra ?? ''}

{% /callout %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * \`gemini-eight\`
  * June 17, 2025
  * December 1, 2026
  * \`gemini-nine\` (effective December 1, 2026, API requests to \`gemini-eight\` will automatically route to \`gemini-nine\`)

  ---

  * \`gemini-eight-lite\`
  * July 22, 2025
  * No shutdown date announced
  *
{% /table %}

## Live 9 models`;
const EIGHT_NOTICE =
  '`gemini-eight` is deprecated and is no longer available to select in Google AI Studio. Effective December 1, 2026, all API requests to `gemini-eight` will automatically route to `gemini-nine` and be billed at Gemini Nine rates. Review the breaking API changes in the Gemini Nine migration guide before December 1, 2026. `gemini-eight-lite` is not deprecated.';
const TOP_NOTE = `{% callout type="note" %}
  Note: The **shutdown dates listed in the table indicate the *earliest possible
  dates* on which a model might be retired**.

{% /callout %}

## Gemini 9 models`;
const eight = (o?: Parameters<typeof EIGHT>[0]) => ({ file: 'google-deprecations.html', from: '## Live 9 models', to: EIGHT(o) });
const topNote = { file: 'google-deprecations.html', from: '## Gemini 9 models', to: TOP_NOTE };

// ── R1 — a notice is the page's, kept whole ─────────────────────────────
describe('R1 — a notice is the page’s callout above a routed row, kept whole', () => {
  it('the bundled ledger: the two routed rows under a callout carry it, flattened, links reduced to their text, nothing cut', () => {
    expect(row('gemini-2.5-pro').notice).toBe(PRO_NOTICE);
    expect(row('gemini-2.5-flash').notice).toBe(FLASH_NOTICE);
  });

  it('the bundled ledger: no other row carries a notice — `gemini-2.5-flash-lite`, named in the Flash callout and not routed, included', () => {
    const withNotice = (LEDGER as (LedgerRow & { notice?: string })[]).filter((r) => r.notice !== undefined).map((r) => r.id);
    expect(withNotice).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(row('gemini-2.5-flash-lite').notice).toBeUndefined();
  });

  it('googleNotices reads a page: a callout naming no id is no row’s notice; one above a routed row is that row’s', () => {
    const text = check.pageTextOf('google-deprecations.html', readFileSync(pagesWith(topNote, eight()) + '/google-deprecations.html', 'utf8'));
    const r = check.googleNotices(text);
    expect(r.stops).toEqual([]);
    expect(r.notices).toEqual([{ id: 'gemini-eight', section: 'Gemini 8 models', notice: EIGHT_NOTICE }]);
  });

  it('the generator writes the notice onto its row, and onto no other row', () => {
    const g = gen(pagesWith(topNote, eight()));
    expect(g.code, g.err).toBe(0);
    expect(g.rows.find((r) => r.id === 'gemini-eight')).toMatchObject({ routesTo: 'gemini-nine', notice: EIGHT_NOTICE });
    expect(g.rows.filter((r) => r.notice !== undefined).map((r) => r.id)).toEqual(['gemini-eight']);
  });

  it('a made-up page set with no callout gives no row a notice (the generator’s output is unchanged in that)', () => {
    const g = gen(MIN);
    expect(g.code, g.err).toBe(0);
    expect(g.rows.filter((r) => r.notice !== undefined)).toEqual([]);
  });
});

// ── R2 — the generator stops on a shape it does not read ─────────────────
describe('R2 — the generator stops on a callout it does not read; no row is written from a guess', () => {
  it('a callout under a section heading that names an id with no row in that section: stop, the callout printed, no ledger', () => {
    const g = gen(pagesWith({ file: 'google-deprecations.html', from: '## Gemini 9 models  {% id="gemini-9-models" %}\n', to: '## Gemini 9 models  {% id="gemini-9-models" %}\n\n{% callout type="caution" %}\n  `gemini-ghost` is deprecated.\n{% /callout %}\n' }));
    expect(g.code).toBe(1);
    expect(g.written).toBe(false);
    expect(g.err).toContain('stop:');
    expect(g.err).toContain('`gemini-ghost`');
    expect(g.err).toContain('Gemini 9 models');
    expect(g.err).toContain('notice: `gemini-ghost` is deprecated.');
    expect(g.err).toContain('No ledger written');
  });

  it('a notice whose route target differs from its row’s: stop, with the notice and the row both printed', () => {
    // the notice names another row of its own section as the target, so only the target check can stop it (an id that is
    // no row of the section stops it on its own, the test above)
    const g = gen(pagesWith(eight({ target: 'gemini-eight-lite' })));
    expect(g.code).toBe(1);
    expect(g.written).toBe(false);
    expect(g.err).toContain("does not give its row's route target `gemini-nine`");
    expect(g.err).toContain('notice: `gemini-eight` is deprecated');
    expect(g.err).toContain('route to `gemini-eight-lite`');
    expect(g.err).toContain('row: `gemini-eight` | June 17, 2025 | December 1, 2026 | `gemini-nine`');
  });

  it('a notice whose date differs from its row’s: stop, with the notice and the row both printed', () => {
    const g = gen(pagesWith(eight({ date: 'December 2, 2026' })));
    expect(g.code).toBe(1);
    expect(g.written).toBe(false);
    expect(g.err).toContain('and its date "December 1, 2026"');
    expect(g.err).toContain('Effective December 2, 2026');
    expect(g.err).toContain('row: `gemini-eight` | June 17, 2025 | December 1, 2026');
  });

  it('a callout that names rows of its section none of which routes: stop', () => {
    const g = gen(pagesWith({ file: 'google-deprecations.html', from: '## Gemini 9 models  {% id="gemini-9-models" %}\n', to: '## Gemini 9 models  {% id="gemini-9-models" %}\n\n{% callout type="caution" %}\n  `gemini-mini-a` will be billed at new rates.\n{% /callout %}\n' }));
    expect(g.code).toBe(1);
    expect(g.written).toBe(false);
    expect(g.err).toContain('`gemini-mini-a`');
    expect(g.err).toContain('No ledger written');
  });

  it('a callout above every section that names an id: stop (a notice is read under a section heading only)', () => {
    const g = gen(pagesWith({ file: 'google-deprecations.html', from: '## Gemini 9 models', to: '{% callout type="note" %}\n  `gemini-mini-a` is special.\n{% /callout %}\n\n## Gemini 9 models' }));
    expect(g.code).toBe(1);
    expect(g.written).toBe(false);
    expect(g.err).toContain('`gemini-mini-a` is special.');
  });
});

// ── R3 — the card quotes the notice and adds no word of its own ──────────
const proTitle = "On Google's own API, `gemini-2.5-pro` is deprecated; from 2026-12-01 its requests route to `gemini-3.8-flash`";
describe('R3 — the card quotes the notice above a routed row, introduced as the page’s notice, and adds no word of its own', () => {
  it('gemini-2.5-pro, page read: the template sentence, then the notice whole; Certain', () => {
    const f = lineOf('gemini-2.5-pro');
    expect(f.title).toBe(proTitle);
    expect(f.detail).toBe(`The page's notice above the row: “${PRO_NOTICE}”`);
    expect(f.confidence).toBe('certain');
  });

  it('gemini-2.5-flash, page read: the notice whole, its last sentences included', () => {
    const f = lineOf('gemini-2.5-flash');
    expect(f.title).toBe("On Google's own API, `gemini-2.5-flash` is deprecated; from 2026-12-01 its requests route to `gemini-3.5-flash-lite`");
    expect(f.detail).toBe(`The page's notice above the row: “${FLASH_NOTICE}”`);
  });

  it('page not read (--offline): the notice as this version read it, and the sentence that says the page was not read', () => {
    const f = lineOf('gemini-2.5-pro', OFFLINE);
    expect(f.detail).toBe(
      `The page's notice above the row: “${PRO_NOTICE}” This is Google's Gemini deprecations page as this version of the check read it on 2026-11-25, the day of this run; it was not read in this run (--offline).`,
    );
  });

  it('a notice that does not hold the row’s date and target: the notice, then the row, both printed', () => {
    const r = row('gemini-2.5-pro');
    const was = r.notice;
    try {
      r.notice = '`gemini-2.5-pro` is deprecated and is no longer available to select in Google AI Studio.';
      const f = lineOf('gemini-2.5-pro');
      expect(f.detail).toBe(
        `The page's notice above the row: “${r.notice}” The page's line: “${r.quote.replace(/ \| $/, '')}”.`,
      );
    } finally {
      r.notice = was;
    }
  });

  it('the gortex extract’s card carries both notices and no line of the check’s own about billing, changes or access', () => {
    const card = runCheck(
      ExtractSchema.parse({
        project: { name: 't' },
        callSites: [],
        models: [
          { model: 'gemini-2.5-pro', where: 'a.go:1', platform: 'provider-api', context: 'runs' },
          { model: 'gemini-2.5-flash', where: 'b.go:1', platform: 'provider-api', context: 'runs' },
        ],
      }),
      { pages: READ, today: TODAY },
    ).card;
    expect(card.match(/billed at/g)?.length).toBe(2);
    expect(card.match(/breaking API changes/g)?.length).toBe(2);
    expect(card.match(/limited to (existing )?users who have actively used/g)?.length).toBe(2);
    // every one of those words sits inside a quote
    const unquoted = card.replace(/“[^”]*”/g, '“…”');
    expect(unquoted).not.toMatch(/billed|breaking|limited to/);
  });
});

// ── R5 — a notice is confirmed like a row ───────────────────────────────
describe('R5 — a notice is confirmed like a row: no longer on the page, the card says so and quotes the row', () => {
  it('rowTests: a row with a notice rests on it, on its own page; quoteStands reads it with the link strip', () => {
    const r = row('gemini-2.5-pro');
    expect(check.rowTests(r).map((t) => [t.what, t.url])).toEqual([
      ['quote', DEP],
      ['notice', DEP],
    ]);
    expect(check.quoteStands(check.pageTextOf('google-deprecations.html', proPage(true)), PRO_NOTICE, false, 'notice')).toBe(true);
    expect(check.quoteStands(check.pageTextOf('google-deprecations.html', proPage(false)), PRO_NOTICE, false, 'notice')).toBe(false);
  });

  it('the page carries the row and its notice: confirmed, the notice quoted', () => {
    const read = readWithGoogle(proPage(true));
    expect(read.rows.get('gemini-2.5-pro')!.state).toBe('confirmed');
    const f = lineOf('gemini-2.5-pro', read, '2026-11-27');
    expect(f.detail).toBe(`The page's notice above the row: “${PRO_NOTICE}”`);
  });

  it('the page carries the row and not its notice: changed, the row quoted, and the line says the notice is not on the page', () => {
    const read = readWithGoogle(proPage(false));
    const st = read.rows.get('gemini-2.5-pro')!;
    expect(st.state).toBe('changed');
    expect(st.state === 'changed' && st.gone.map((g) => g.what)).toEqual(['notice']);
    const f = lineOf('gemini-2.5-pro', read, '2026-11-27');
    expect(f.confidence).toBe('likely');
    expect(f.title).toBe(`As read on 2026-11-25 (the page has changed since): ${proTitle}`);
    expect(f.detail).toBe(
      `The page's line: “${row('gemini-2.5-pro').quote}”. This line quotes the row: the notice above it on Google's Gemini deprecations page, as read on 2026-11-25, is not on the page as read in this run (2026-11-27 09:35 UTC). Read the page before acting on the date: ${DEP}. A newer version of the check carries a newer read.`,
    );
    expect(f.detail).not.toContain('billed at');
  });

  // The cold read's surviving mutant (C1): a confirmation that reads only the notice's opening passed every test above,
  // because each of them removes the whole callout. A notice that is still there and has lost a clause has changed.
  it('the page keeps the callout and drops its billing clause: the notice no longer stands, the row is quoted', () => {
    const whole = proPage(true);
    const cut = whole.replace(/\s+and be billed at\s+\[?Gemini 3\.8 Flash rates\]?(\([^)]*\))?/, '');
    expect(cut).not.toBe(whole);
    expect(cut).toContain('will automatically route to');
    expect(cut).not.toContain('billed at');
    expect(check.quoteStands(check.pageTextOf('google-deprecations.html', cut), PRO_NOTICE, false, 'notice')).toBe(false);
    const read = readWithGoogle(cut);
    const st = read.rows.get('gemini-2.5-pro')!;
    expect(st.state).toBe('changed');
    expect(st.state === 'changed' && st.gone.map((g) => g.what)).toEqual(['notice']);
    expect(lineOf('gemini-2.5-pro', read, '2026-11-27').detail).not.toContain('billed at');
  });

  it('ledger-drift: a third line counts the notices checked and moved, and a moved notice moves its row', () => {
    const dir = mkdtempSync(join(ROOT, 'drift-'));
    const ledger = join(dir, 'ledger.ts');
    const r = row('gemini-2.5-pro');
    writeFileSync(
      ledger,
      `export const LEDGER_SOURCES: readonly LedgerSource[] = ${JSON.stringify([{ provider: 'google', url: DEP, readAt: '2026-11-25T09:06:12Z', sha256: 'x', title: 'Gemini deprecations' }], null, 2)};\n\n` +
        `export const LEDGER_DEFINITIONS: readonly LedgerDefinition[] = [\n];\n\nexport const LEDGER: readonly LedgerRow[] = ${JSON.stringify([r], null, 2)};\n`,
    );
    const pages = (withCallout: boolean) => {
      const d = mkdtempSync(join(dir, 'pages-'));
      writeFileSync(join(d, 'google-deprecations.html'), proPage(withCallout));
      writeFileSync(join(d, 'read-times.json'), JSON.stringify({ 'google-deprecations.html': '2026-11-27T09:35:10Z' }));
      return d;
    };
    const ok = spawnSync(process.execPath, [DRIFT, '--pages', pages(true), '--ledger', ledger], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const okLines = ok.stdout.trimEnd().split('\n');
    expect(okLines.at(-2)).toBe('0 notices moved — 1 notice checked of 1');
    expect(okLines.at(-1)).toBe('0 rows moved — 1 rows checked of 1');
    const moved = spawnSync(process.execPath, [DRIFT, '--pages', pages(false), '--ledger', ledger], { encoding: 'utf8' });
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain('MOVED google gemini-2.5-pro');
    expect(moved.stdout).toContain(`ledger notice (read 2026-11-25): ${PRO_NOTICE}`);
    const lines = moved.stdout.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('1 notice moved — 1 notice checked of 1');
    expect(lines.at(-1)).toBe('1 row moved (google 1) — 1 rows checked of 1');
  });
});

// ── R4 — `--model-facts` prints the notice the same way ──────────────────
const priceOf = (id: string) => /- price: (\$[\d.]+\/M input · \$[\d.]+\/M output)/.exec(renderModelFacts(id, { pages: OFFLINE, today: TODAY }))![1]!;
describe('R4 — `--model-facts` quotes the notice, and its price line points at it', () => {
  it('gemini-2.5-pro: the source line quotes the notice; the price line says whose figure it is and quotes the notice’s billing sentence', () => {
    const out = renderModelFacts('gemini-2.5-pro', { pages: READ, today: TODAY });
    expect(out).toContain(`- source: ${DEP} (read in this run, 2026-11-25 09:06 UTC) — the page's notice above the row: “${PRO_NOTICE}”`);
    expect(out).toContain(
      `- price: ${priceOf('gemini-2.5-pro')} (the catalog's figure for this id); the notice quoted above says: “Effective December 1, 2026, all API requests to \`gemini-2.5-pro\` will automatically route to \`gemini-3.8-flash\` and be billed at Gemini 3.8 Flash rates.” · the catalog's figure for \`gemini-3.8-flash\`: ${priceOf('gemini-3.8-flash')}`,
    );
  });

  it('gemini-2.5-flash: the notice whole, breaking API changes included', () => {
    const out = renderModelFacts('gemini-2.5-flash', { pages: READ, today: TODAY });
    expect(out).toContain(`the page's notice above the row: “${FLASH_NOTICE}”`);
    expect(out).toContain(`the catalog's figure for \`gemini-3.5-flash-lite\`: ${priceOf('gemini-3.5-flash-lite')}`);
  });

  it('a notice no longer on the page: the row quoted, the line says so, and the price line is the catalog’s alone', () => {
    const out = renderModelFacts('gemini-2.5-pro', { pages: readWithGoogle(proPage(false)), today: '2026-11-27' });
    expect(out).toContain(
      `- source: ${DEP} (read 2026-11-25; the page has changed since — it no longer carries the notice above this row as it was read, so read the page before acting on the date) — “${row('gemini-2.5-pro').quote}”`,
    );
    expect(out).toContain(`- price: ${priceOf('gemini-2.5-pro')}\n`);
    expect(out).not.toContain('billed at');
  });

  it('a row with no notice prints its source line and price line as before', () => {
    const out = renderModelFacts('gemini-3.8-flash', { pages: READ, today: TODAY });
    expect(out).not.toContain('notice');
    expect(out).toContain(`- price: ${priceOf('gemini-3.8-flash')}\n`);
  });
});

// ── R6 — no sentence about what a call returns: the exact templates are allowed, nothing else ──
/** A line with the page's words taken out: every quoted span, the read time, and the ids. */
const skeleton = (s: string) => s.replace(/“[^”]*”/g, '“Q”').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, 'T UTC');
/** Every sentence a routed row's detail may carry outside the page's quoted words (read in this run, the record's read). */
const ALLOWED_DETAIL = new Set([
  "The page's notice above the row: “Q”",
  "The page's line: “Q”. The catalog has no entry for it, so its limits and price were not checked.",
  "Google's release notes page (read in this run, T UTC): “Q” Its row on Google's Gemini deprecations page, by the table's columns: “Q”.",
  "Google's release notes page (read in this run, T UTC): “Q” Its row on Google's Gemini deprecations page, by the table's columns: “Q”. The catalog has no entry for it, so its limits and price were not checked.",
  'The page\'s line: “Q”. DeepSeek\'s change log: the name is "temporarily routed to V4.1 Flash".',
  'The page\'s line: “Q”. DeepSeek\'s change log: the name is "temporarily routed to V4.1 Flash". The catalog has no entry for it, so its limits and price were not checked.',
]);
/** The title templates of engine.ts (`rerouted`, a routed `deprecated`, a `retired` name routed), filled from the row. */
function allowedTitles(r: LedgerRow, today: string): string[] {
  const P = { google: 'Google', deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic' }[r.provider];
  const on = `On ${P}'s own API, \`${r.id}\``;
  const to = r.routesTo;
  const d = r.shutdown;
  const repl = r.replacement && r.replacement !== to ? (r.replacementForm ? `; for its replacement the page says “${r.replacement}”` : `; its page names ${idSpans(r.replacement)}`) : '';
  const t = [
    `${on} is deprecated; its requests are routed to \`${to}\``,
    `${on} has its requests routed to \`${to}\``,
    `${on} was retired${r.announced ? ` (change log, ${r.announced})` : ''}`,
    ...(d
      ? [
          `${on} is deprecated; from ${d} its requests route to \`${to}\``,
          `${on} is deprecated; its page gives ${d}, ${distanceWords(today, d)}, as the day its requests route to \`${to}\``,
          `${on} has its requests routed to \`${to}\` from ${d}`,
          `${on}: its page gives ${d}, ${distanceWords(today, d)}, as the day its requests route to \`${to}\``,
          `${on} was retired on ${d}`,
        ]
      : []),
  ];
  return t.map((x) => x + repl);
}
describe('R6 — a routed row’s line is the exact templates and the page’s quoted words, nothing else', () => {
  const routed = LEDGER.filter((r) => r.routesTo);
  it('the ledger has routed rows to test (8 on the page set of 2026-11-25)', () => {
    expect(routed.length).toBe(8);
  });
  for (const today of [TODAY, '2026-12-05']) {
    it(`every routed row, page read, on ${today}: its title is a template and its detail an allowed sentence`, () => {
      for (const r of routed) {
        const f = lineOf(r.id, READ, today);
        expect(allowedTitles(r, today), `${r.id}: ${f.title}`).toContain(f.title);
        expect(ALLOWED_DETAIL.has(skeleton(f.detail)), `${r.id}: ${skeleton(f.detail)}`).toBe(true);
      }
    });
  }

  it('the two notice rows under --model-facts: outside the quotes, only the fixed words of the source and price lines', () => {
    for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash']) {
      const out = renderModelFacts(id, { pages: READ, today: TODAY }).split('\n');
      const src = out.find((l) => l.startsWith('- source: '))!;
      const price = out.find((l) => l.startsWith('- price: '))!;
      expect(skeleton(src).replace(DEP, 'URL')).toBe("- source: URL (read in this run, T UTC) — the page's notice above the row: “Q”");
      expect(skeleton(price).replace(/\$[\d.]+/g, '$N').replace(/`[^`]+`/g, '`ID`')).toBe(
        "- price: $N/M input · $N/M output (the catalog's figure for this id); the notice quoted above says: “Q” · the catalog's figure for `ID`: $N/M input · $N/M output",
      );
    }
  });
});

// ── R8 — version ──────────────────────────────────────────────────────────
describe('R8 — the release', () => {
  it('the package is 0.4.8 and its changelog opens on it', () => {
    expect(JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version).toBe('0.4.8');
    expect(readFileSync(join(PKG, 'CHANGELOG.md'), 'utf8')).toMatch(/^# @warmdrift\/kgauto-check — changelog\n\n## 0\.4\.8 — 2026-11-2\d\n/);
  });
});
