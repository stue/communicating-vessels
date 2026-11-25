/**
 * The check 0.4.5 (filing 2026-11-20), R5 and R6: a fine-tune is looked up by its base, for lifecycle only; a row
 * matched by a display name is never Certain and says whose word and whose date it prints. No test here makes a
 * network request: the pages are the read record of this release (tests/helpers/read.ts). Cards are printed on
 * 2026-11-20. Each behaviour was seen red on 0.4.4's code (main 254e399) before it was built; the filing's foot
 * carries those runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER, LEDGER_DEFINITIONS } from '../src/lifecycle-ledger.js';
import { fineTuneNoteTies } from '../src/ledger-check.mjs';
import { noRequestRead, type PageRead } from '../src/pages.js';
import { READ } from './helpers/read.js';

const TODAY = '2026-11-20';
const card = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).card;
const findings = (e: Extract, pages: PageRead = READ, today = TODAY) => runCheck(e, { pages, today }).findings;
const one = (model: string): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model, where: 'src/x.py:1', platform: 'provider-api', context: 'runs' }] });
/** The findings that speak of an id: a title that names it in code marks. */
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));
/** OpenAI's sentence under its table of upcoming deprecations, as the page read for this release (2026-11-20T05:02:18Z) writes it. */
const FINE_TUNES = 'Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.';

// ── R5 — a fine-tune is looked up by its base, for lifecycle only ──────────
describe('R5 — `ft:<base>:…` prints the base’s lifecycle line with both names, always Likely', () => {
  const ft = 'ft:gpt-4o-2024-08-06:acme::abc123';
  it('the base’s line, read in this run, is still Likely, and says the link is the check’s and what was not checked', () => {
    const fs = about(findings(one(ft)), ft);
    expect(fs.length).toBe(1);
    const f = fs[0]!;
    expect(f.confidence).toBe('likely');
    // Amendment A2: the word, the date and the replacement are the base's (until fix pass 1: "`ft:…` (a fine-tune of `<base>`) is deprecated …")
    expect(f.title).toContain('`ft:gpt-4o-2024-08-06:acme::abc123` is a fine-tune of `gpt-4o-2024-08-06` (this check\'s reading of the id), and for the base, `gpt-4o-2024-08-06` is deprecated and shuts down on 2027-01-14');
    expect(f.detail).toContain("The link from `ft:gpt-4o-2024-08-06:acme::abc123` to `gpt-4o-2024-08-06` is this check's reading of the id, so this line is Likely whatever the page says.");
    expect(f.detail).toContain(`OpenAI's deprecations page: “${FINE_TUNES}”`);
    expect(f.detail).toContain('Its limits and price were not checked: the check does not look a fine-tune up in the catalog.');
  });
  it('on $F, offline (V4): no id is “not recognised”', () => {
    const F = ExtractSchema.parse(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/verifier-045.json'), 'utf8')));
    expect(card(F, noRequestRead())).not.toContain('was not recognised');
  });
  it('the header neither calls it not recognised nor prints the base beside it', () => {
    const c = card(one(ft));
    expect(c).not.toContain('was not recognised');
    expect(c.split('\n')[2]).toBe(
      "0 AI call sites and 1 model id: `ft:gpt-4o-2024-08-06:acme::abc123`. 1 is flagged by this check's reading of a fine-tune's id. The flagged id is in code that runs.",
    );
  });
  it('a fine-tune of a base no page or catalog knows is not recognised, and the line names the base', () => {
    const f = about(findings(one('ft:made-up-base-9:acme::x1')), 'ft:made-up-base-9:acme::x1')[0]!;
    expect(f.title).toBe('`ft:made-up-base-9:acme::x1` was not recognised');
    expect(f.detail).toContain('It reads as a fine-tune of `made-up-base-9`');
  });
  // Amendment A1: the line says only that the check quotes no sentence (until fix pass 1: "The pages this check reads do not say …", false of OpenAI's page)
  it('on a base the page lists in its past table, the line says the check quotes no sentence of the provider’s about it', () => {
    // 0.4.7 (R4, Amendment A5): a past base the historical note's link does not tie (until 0.4.7 the first shut-down row,
    // `gpt-3.5-turbo-0125`, whose fine-tunes now quote the note: check-047.test.ts)
    const note = LEDGER_DEFINITIONS.find((d) => d.word === 'fine-tunes of the October 2026 shutdown')!.quote;
    const past = LEDGER.find((r) => r.provider === 'openai' && r.word === 'shut down' && /^[a-z0-9.-]+$/.test(r.id) && !fineTuneNoteTies(note, r))!;
    const f = about(findings(one(`ft:${past.id}:acme::x1`)), `ft:${past.id}:acme::x1`)[0]!;
    expect(f.detail).toContain("This check quotes no sentence of OpenAI's about fine-tunes of this model.");
    expect(f.detail).not.toContain(FINE_TUNES);
  });
});

// ── R6 — a date is printed beside the id it belongs to ─────────────────────
describe('R6 — a row matched by display name is never Certain, and its title says whose word and whose date', () => {
  for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']) {
    it(id, () => {
      const fs = about(findings(one(id)), id);
      expect(fs.length).toBe(1);
      const f = fs[0]!;
      expect(f.confidence).toBe('likely');
      expect(f.title).toContain(`\`${id}\` is deprecated by its model page's word (“Status: Deprecated”)`);
      expect(f.title).toMatch(/OpenAI's deprecations page gives a shutdown date of 2027-01-14 to `[a-z0-9.-]+-\d{4}-\d{2}-\d{2}`/);
      expect(f.title).toContain(`the link from \`${id}\` to that row is this check's`);
    });
  }
  it('`gpt-4o`: both snapshots the row names', () => {
    const f = about(findings(one('gpt-4o')), 'gpt-4o')[0]!;
    expect(f.title).toContain('to `gpt-4o-2024-08-06` and `gpt-4o-2024-11-20`, the snapshots its row “GPT-4o” names, with `gpt-6-luna` as their replacement;');
  });
  it('`gpt-4o-mini`: one snapshot, and the line agrees with its count', () => {
    const f = about(findings(one('gpt-4o-mini')), 'gpt-4o-mini')[0]!;
    expect(f.title).toContain('to `gpt-4o-mini-2024-07-18`, the snapshot its row “GPT-4o mini” names, with `gpt-6-luna` as its replacement;');
  });
});

