/**
 * The check 0.4.5, fix pass 1 (the filing's Amendment A, rulings A1–A8). No test here makes a network request: the
 * pages are the read record of this release (tests/helpers/read.ts) or a read switched off as `--offline` switches it.
 * Cards are printed on 2026-11-20. A1, A2, A3 and A6 were seen red on the code of `cc485ea` before they were built
 * (the filing's foot, "Fix pass 1 — the builder's report"). This file is not withheld by the public export: it names
 * no private path (A3's header test lives here for that reason).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { noRequestRead, type PageRead } from '../src/pages.js';
import { renderModelFacts } from '../src/model-facts.js';
import { USAGE } from '../src/instructions.js';
import { OBSERVE_DAY_PLAN } from '../src/observe-plan.js';
import { READ } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-20';
const fixture = (f: string): Extract => ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures', f), 'utf8')));
const F = fixture('verifier-045.json');
const FA = fixture('verifier-045a.json');
const OFFLINE: PageRead = noRequestRead();
const card = (e: Extract, pages: PageRead = READ) => runCheck(e, { pages, today: TODAY }).card;
const findings = (e: Extract, pages: PageRead = READ): Finding[] => runCheck(e, { pages, today: TODAY }).findings;
const one = (model: string): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform: 'provider-api', context: 'runs' }] });
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
const FINE_TUNES = 'Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.';

// ── A1 ─────────────────────────────────────────────────────────────────────
describe('A1 — no sentence says what a page does not say; with no sentence held for the base, the line says only that', () => {
  it('a fine-tune of a base in OpenAI’s past table: “This check quotes no sentence of OpenAI’s about fine-tunes of this model.”', () => {
    const id = 'ft:gpt-3.5-turbo-0125:acme::abc123';
    const f = about(findings(one(id)), id)[0]!;
    expect(f.detail).toContain("This check quotes no sentence of OpenAI's about fine-tunes of this model.");
    expect(f.detail).not.toMatch(/do not say what happens to a fine-tune/);
    expect(f.detail).not.toContain(FINE_TUNES);
  });
  it('$FA offline (VA1): no line says the pages do not say', () => {
    expect(card(FA, OFFLINE)).not.toMatch(/do not say what happens to a fine-tune/);
  });
  it('a base in the table of upcoming deprecations still quotes the page’s sentence', () => {
    const id = 'ft:gpt-4o-2024-08-06:acme::abc123';
    expect(about(findings(one(id)), id)[0]!.detail).toContain(`OpenAI's deprecations page: “${FINE_TUNES}”`);
  });
});

// ── A2 ─────────────────────────────────────────────────────────────────────
describe('A2 — the fine-tune’s title puts the word, the date and the replacement on the base', () => {
  it('the title', () => {
    const id = 'ft:gpt-4o-2024-08-06:acme::abc123';
    const f = about(findings(one(id)), id)[0]!;
    expect(f.title).toBe(
      "On OpenAI's own API, `ft:gpt-4o-2024-08-06:acme::abc123` is a fine-tune of `gpt-4o-2024-08-06` (this check's reading of the id), and for the base, `gpt-4o-2024-08-06` is deprecated and shuts down on 2027-01-14; the page names `gpt-6-luna` as the base's replacement",
    );
  });
  it('$F offline (VA2): never “(a fine-tune of `…`) is deprecated”, and V7 still finds the fine-tune once', () => {
    const c = card(F, OFFLINE);
    expect(c).not.toContain('(a fine-tune of `gpt-4o-2024-08-06`) is deprecated');
    expect(c.split('\n').filter((l) => l.includes('fine-tune of `gpt-4o-2024-08-06`'))).toHaveLength(1);
  });
});

// ── A3 ─────────────────────────────────────────────────────────────────────
describe('A3 — an id whose deprecations-page row says Active is not flagged, whatever its model page’s badge', () => {
  it('the header on an extract that mixes an Active id with a Legacy badge, an Active id the catalog lacks, and a deprecated id', () => {
    const e = ExtractSchema.parse({
      project: { name: 't' },
      callSites: [],
      models: [
        { model: 'claude-opus-4-6', where: 'a.py:1', platform: 'provider-api', context: 'runs' },
        { model: 'claude-mythos-5', where: 'b.py:1', platform: 'provider-api', context: 'test' },
        { model: 'gpt-4o-mini-2024-07-18', where: 'c.py:1', platform: 'provider-api', context: 'docs' },
      ],
    });
    expect(card(e).split('\n')[2]).toBe(
      '0 AI call sites and 3 model ids: `claude-opus-4-6`, `claude-mythos-5`, `gpt-4o-mini-2024-07-18`. 1 is flagged by OpenAI. The flagged id is in docs.',
    );
  });
  it('the line is ℹ️, and still gives the model page’s word and day, and the deprecations page’s date and distance', () => {
    const f = about(findings(one('claude-opus-4-6')), 'claude-opus-4-6')[0]!;
    expect(f.severity).toBe('info');
    expect(f.title).toContain('is Legacy: its model page says so (read 2026-11-02)');
    expect(f.title).toContain('“Not sooner than February 5, 2027”, 77 days after this run');
    expect(card(one('claude-opus-4-6')).split('\n')[2]).toBe('0 AI call sites and 1 model id: `claude-opus-4-6`. Its provider does not flag it.');
  });
  it('$F offline (VA3): the header flags no Anthropic id, and no Anthropic line is 🟡', () => {
    const c = card(F, OFFLINE);
    expect(c.split('\n')[2]).toContain("1 is flagged by OpenAI, and 1 by this check's reading of a fine-tune's id.");
    expect(c).not.toMatch(/🟡 \*\*On Anthropic/);
  });
});

// ── A4 ─────────────────────────────────────────────────────────────────────
describe('A4 — no single-day sentence where a user reads about --offline', () => {
  it('the usage text and the server’s offline input', () => {
    expect(USAGE).not.toContain('every provider line');
    expect(USAGE).toContain('--offline makes no request, and each provider line then gives the day its page was read');
    // VA4 reads both sources, comments included
    for (const f of ['src/server.ts', 'src/instructions.ts']) expect(readFileSync(join(PKG, f), 'utf8'), f).not.toContain('every provider line');
  });
});

// ── A5 ─────────────────────────────────────────────────────────────────────
describe('A5 — what the card points to speaks the card’s words', () => {
  const plainFirst = (t: string) => {
    const plain = t.indexOf('day of recorded calls');
    const ours = Math.min(...['observe run', 'observe day'].map((w) => (t.includes(w) ? t.indexOf(w) : Infinity)));
    return plain !== -1 && plain < ours;
  };
  it('--observe-plan: no walkaway, no judged eval, and the plain words first', () => {
    expect(OBSERVE_DAY_PLAN).not.toMatch(/walkaway|judged eval/);
    expect(plainFirst(OBSERVE_DAY_PLAN)).toBe(true);
  });
  it('the README: no walkaway, no judged eval, no capitals, and the plain words first', () => {
    const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
    expect(readme).not.toMatch(/walkaway|judged eval|actually IN/);
    expect(plainFirst(readme)).toBe(true);
  });
});

// ── A6 ─────────────────────────────────────────────────────────────────────
describe('A6 — a fine-tune id is read by its base in every form that names one; `ft::…` names none', () => {
  it('`ft:gpt-4o-2024-08-06`, nothing after the base, is read by its base', () => {
    const f = about(findings(one('ft:gpt-4o-2024-08-06')), 'ft:gpt-4o-2024-08-06')[0]!;
    expect(f.title).toContain('`ft:gpt-4o-2024-08-06` is a fine-tune of `gpt-4o-2024-08-06`');
    expect(f.confidence).toBe('likely');
  });
  it('`ft::abc123` names no base: not recognised, and no line calls it a fine-tune', () => {
    const fs = about(findings(one('ft::abc123')), 'ft::abc123');
    expect(fs).toHaveLength(1);
    expect(fs[0]!.title).toBe('`ft::abc123` was not recognised');
    expect(fs[0]!.detail).not.toMatch(/fine-tune/);
  });
  it('$FA offline (VA6): exactly one id is not recognised, `ft::abc123`', () => {
    const lines = card(FA, OFFLINE).split('\n').filter((l) => l.includes('was not recognised'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('`ft::abc123` was not recognised');
  });
});

// ── A7 ─────────────────────────────────────────────────────────────────────
describe('A7 — no capitals in the input-share line; the Likely heading names the two linked kinds', () => {
  it('the input-share line', () => {
    const e = ExtractSchema.parse({ project: { name: 't' }, callSites: [{ id: 'a.py:1', model: 'gemini-2.5-flash', estInputTokens: 30000, estOutputTokens: 100 }] });
    const f = findings(e).find((x) => /of this site's tokens are input/.test(x.title))!;
    expect(f.detail).toContain("What's actually in that context");
    expect(f.detail).not.toMatch(/\bIN\b/);
  });
  it('the Likely heading', () => {
    expect(card(F)).toContain('an id this check linked to another id’s row (a fine-tune by its base, a name by its display name)');
  });
});

// ── A8 ─────────────────────────────────────────────────────────────────────
describe('A8 — the paths outside the rulings', () => {
  it('bare `genie-4` is the row Google writes as `models/genie-4`', () => {
    const f = about(findings(one('genie-4')), 'genie-4')[0]!;
    expect(f.title).toContain('`genie-4` has no shutdown date announced');
    expect(card(one('genie-4'))).not.toContain('was not recognised');
  });
  it('--model-facts for a fine-tune: the preface, then the card’s own line', () => {
    const out = renderModelFacts('ft:gpt-4o-2024-08-06:acme::abc123', { pages: READ, today: TODAY });
    expect(out).toContain("- read as a fine-tune of `gpt-4o-2024-08-06`, by this check's reading of the id");
    expect(out).toContain('is a fine-tune of `gpt-4o-2024-08-06` (this check\'s reading of the id), and for the base,');
    expect(out).not.toMatch(/^- OpenAI's word: /m);
  });
  it('--model-facts for an Active row whose model page says Legacy: both words, each beside its page', () => {
    const out = renderModelFacts('claude-opus-4-6', { pages: READ, today: TODAY });
    expect(out).toContain("- Anthropic's word: **active**");
    expect(out).toContain("- Anthropic's word: **legacy** (model page, read 2026-11-02)");
  });
});
