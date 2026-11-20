/**
 * The check 0.4.5 (filing 2026-11-20), the words: R1 (the README's first instruction), R2 (the footer claims no single
 * day), R7 (the card's own words) and R8 (the npm description). No test here makes a network request: the pages are
 * the read record of this release (tests/helpers/read.ts), or a read switched off as `--offline` switches it. Cards
 * are printed on 2026-11-20. Each behaviour was seen red on 0.4.4's code (main 254e399) before it was built; the
 * filing's foot carries those runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIBRARY_VERSION } from '@warmdrift/kgauto-compiler';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { noRequestRead, type PageRead } from '../src/pages.js';
import { READ } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-20';
const F: Extract = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-045.json'), 'utf8')));
const OFFLINE: PageRead = noRequestRead();
const card = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).card;
const findings = (e: Extract, pages: PageRead = READ, today = TODAY): Finding[] => runCheck(e, { pages, today }).findings;
const one = (model: string): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform: 'provider-api', context: 'runs' }] });

// ── R1 — the first instruction names a page that exists ────────────────────
describe('R1 — the README’s first instruction is the site’s own sentence', () => {
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
  it('names no .html address of the site and never says “For the agent”', () => {
    expect(readme).not.toMatch(/model-check-alpha\.vercel\.app\/[^\s)"'`]*\.html/);
    expect(readme).not.toContain('For the agent');
  });
  it('carries the site’s sentence, without the page’s version and hash', () => {
    expect(readme).toContain(
      'Follow https://model-check-alpha.vercel.app/agent on this project: list where it calls a model, run the check on that list, and show me the card verbatim.',
    );
  });
});

// ── R2 — the footer claims no single day for every line ────────────────────
describe('R2 — when no page is read, the footer gives the deprecation pages’ day and says a model page’s line carries its own', () => {
  for (const [name, pages] of [
    ['--offline', OFFLINE],
    ['a caller that read nothing', undefined],
  ] as const) {
    it(name, () => {
      const c = runCheck(F, { pages, today: TODAY }).card;
      const foot = c.split('\n---\n')[1]!;
      expect(foot).not.toMatch(/every provider line/);
      expect(foot).toMatch(/the deprecation pages behind its provider lines are as this version read them on \d{4}-\d{2}-\d{2}/);
      expect(foot).toContain("a line taken from a model's own page gives the day that page was read");
    });
  }
});

// ── R7 — the card's own words ──────────────────────────────────────────────
describe('R7 (a) — a card that says “the catalog” says once, in its footer, what the catalog is', () => {
  const SENTENCE = `The catalog on this card is the set of model records this check carries (\`@warmdrift/kgauto-compiler\` ${LIBRARY_VERSION}).`;
  it('$F offline: once, after the rule', () => {
    const c = card(F, OFFLINE);
    expect(c.split(SENTENCE).length - 1).toBe(1);
    expect(c.indexOf(SENTENCE)).toBeGreaterThan(c.indexOf('\n---\n'));
  });
  it('a card that never says “the catalog” does not print it', () => {
    const c = card(one('claude-opus-5-5'));
    expect(c.split('\n---\n')[0]).not.toMatch(/the catalog/i);
    expect(c).not.toContain(SENTENCE);
  });
});

describe('R7 (b) — none of our words on a card; the last line says what a day of recorded calls would show and names --observe-plan', () => {
  const rich = ExtractSchema.parse({
    project: { name: 't' },
    callSites: [
      { id: 'a.py:1', model: 'gpt-6-astra', archetype: 'summarize', estInputTokens: 300000, estOutputTokens: 1000, expectsStructuredOutput: true, retry: 'none', toolCount: 40 },
      { id: 'b.py:1', model: 'gemini-2.5-flash', archetype: 'summarize', estInputTokens: 30000, estOutputTokens: 1000 },
    ],
  });
  const BANNED = [/walkaway/, /YOUR/, /observe run/, /observe day/, /judged eval/, /(^|[^`-])the compiler\b/];
  for (const [name, e] of [
    ['$F', F],
    ['a card with a threshold line, the cheaper-models line and the input-share line', rich],
  ] as const) {
    it(name, () => {
      const c = card(e);
      for (const b of BANNED) expect(c, String(b)).not.toMatch(b);
    });
  }
  it('the last finding names the plan’s command', () => {
    const fs = findings(F);
    const last = fs.at(-1)!;
    expect(last.confidence).toBe('measurable-only');
    expect(last.detail).toContain('One day of recorded calls would show these');
    expect(last.detail).toContain('`--observe-plan` prints the plan');
  });
  it('a threshold line that says what the compiler does says it conditionally', () => {
    const t = findings(rich).find((f) => /holds a threshold/.test(f.title));
    expect(t).toBeDefined();
    expect(t!.detail).toMatch(/If you call this model through `@warmdrift\/kgauto-compiler`, it /);
  });
});

// ── R8 — the npm description ───────────────────────────────────────────────
describe('R8 — the npm description', () => {
  it('is the filing’s sentence', () => {
    expect(JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).description).toBe(
      "Communicating Vessels — the check. Your coding agent lists where your project calls an AI model (ids and counts, never code); this tool reads that list on your machine against the providers' own deprecation pages, read in each run, and a bundled catalog of model limits and prices. Nothing about your project leaves your machine unless you pass --share.",
    );
  });
});
