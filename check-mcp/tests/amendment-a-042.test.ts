/**
 * Amendment A of the 0.4.2 filing (the seat, 2026-11-14T22:20Z). Run first against the 0.4.2 build
 * before the amendment (`53514d4`) and seen red.
 *  A1 — an id the provider's page lists, with no shutdown date and no deprecation word, is a ledger
 *       row (`listed`) and gets one informational line: never "not recognised", never flagged.
 *  A2 — a replacement cell that is not a plain list of model ids is quoted in the page's words.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { renderModelFacts } from '../src/model-facts.js';
import { LEDGER } from '../src/lifecycle-ledger.js';
import { replacementForm } from '../src/ledger-check.mjs';
import { READ } from './helpers/read.js';

const row = (id: string) => LEDGER.find((r) => r.id === id);
const ex = (models: string[]): Extract => ({
  project: { name: 't' },
  callSites: models.map((model, i) => ({ id: `s${i}`, model, platform: 'provider-api' as const })),
});
const lineFor = (r: ReturnType<typeof runCheck>, id: string) => r.findings.filter((f) => f.title.includes(`\`${id}\``));

describe('A1 — an id the provider’s page lists is never "not recognised"', () => {
  it('gemini-3.1-flash-live-preview is a `listed` row in the page’s own words, with its replacement and no date', () => {
    const r = row('gemini-3.1-flash-live-preview');
    expect(r?.word).toBe('listed');
    expect(r?.pageWord).toBe('No shutdown date announced');
    expect(r?.replacement).toBe('gemini-3.8-live');
    expect(r?.shutdown).toBeUndefined();
    expect(r?.shutdownFloor).toBeUndefined();
    expect(r?.section).toBe('Live API models › Preview models');
  });

  it('its card line: one informational line on Google’s own API, the replacement, the page and the read date', () => {
    // 0.4.3 (R1): Certain on the pages as read for this release
    const res = runCheck(ex(['gemini-3.1-flash-live-preview']), { pages: READ });
    const ls = lineFor(res, 'gemini-3.1-flash-live-preview');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.severity).toBe('info');
    expect(ls[0]!.confidence).toBe('certain');
    expect(ls[0]!.title).toBe(
      // Amendment B1 rewords the A1 line by the row's heading (tests/amendment-b-042.test.ts)
      "On Google's own API, `gemini-3.1-flash-live-preview` has no shutdown date announced: Google's deprecations page lists it among its preview models; its page names `gemini-3.8-live`",
    );
    expect(ls[0]!.basis).toMatch(/^Google's page, read in this run \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\): https:\/\/aistudio\.google\.com\/docs\/deprecations$/);
    expect(res.card).not.toContain('not recognised');
  });

  it('a listed id is never counted as flagged by its provider', () => {
    const card = runCheck(ex(['gemini-3.1-flash-live-preview'])).card;
    expect(card).not.toMatch(/flagged by its provider/);
    const two = runCheck(ex(['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-preview-tts'])).card;
    expect(two).toContain('(1 flagged by its provider)');
  });

  it('a listed id the catalog knows keeps every catalog check: its price line is still on the card', () => {
    const res = runCheck({
      project: { name: 't' },
      callSites: [{ id: 's0', model: 'gemini-3.8-flash', platform: 'provider-api', estInputTokens: 1000, estOutputTokens: 100 }],
    });
    expect(row('gemini-3.8-flash')?.word).toBe('listed');
    expect(lineFor(res, 'gemini-3.8-flash').some((f) => f.title.includes('no shutdown date announced'))).toBe(true);
    expect(res.findings.some((f) => /\/call on `gemini-3\.8-flash`/.test(f.title))).toBe(true);
    expect(res.card).not.toContain('The catalog has no entry');
    // the page's row has an empty replacement cell: the quote ends at the last cell that says something
    const line = lineFor(res, 'gemini-3.8-flash').find((f) => f.title.includes('no shutdown date announced'))!;
    expect(line.detail).toContain('No shutdown date announced”');
    expect(line.detail).not.toContain('| ”');
  });

  it('every listed row is a Google table row whose date cell says no shutdown date is announced', () => {
    const listed = LEDGER.filter((r) => r.word === 'listed');
    expect(listed.length).toBeGreaterThan(0);
    for (const r of listed) {
      expect(r.provider, r.id).toBe('google');
      expect(r.quote, r.id).toContain('No shutdown date announced');
      expect(r.shutdown ?? r.shutdownFloor, r.id).toBeUndefined();
    }
  });

  it('--model-facts says the page lists it, with no date, and does not call that a deprecation', () => {
    const out = renderModelFacts('gemini-3.1-flash-live-preview');
    expect(out).toContain("Google's page lists it: **no shutdown date announced**");
    expect(out).not.toContain('not recognised');
  });
});

describe('A2 — a replacement that is not a model id is not printed as one', () => {
  it('the generator classes a replacement cell by the page’s own code marks', () => {
    expect(replacementForm('`gpt-6-luna`')).toBeUndefined();
    expect(replacementForm('`gpt-live-transcribe` or `gpt-transcribe`')).toBeUndefined();
    expect(replacementForm('`gpt-image-2`, `gpt-image-1`, or `gpt-image-1-mini`')).toBeUndefined();
    expect(replacementForm('The most capable cyber model available to you.')).toBe('text');
    expect(replacementForm("`gpt-5`, or `gpt-4.1` for latency-sensitive tasks that don't require reasoning")).toBe('ids-in-text');
    expect(replacementForm('`gpt-6.1-sol` (`reasoning.mode: pro`) in the Responses API')).toBe('ids-in-text');
  });

  it('gpt-5.4-cyber: the page’s sentence is quoted, not put in code marks or called a name', () => {
    const t = lineFor(runCheck(ex(['gpt-5.4-cyber'])), 'gpt-5.4-cyber')[0]!.title;
    expect(t).toContain('; for its replacement the page says “The most capable cyber model available to you.”');
    expect(t).not.toContain('names `The most');
    expect(row('gpt-5.5-cyber-preview')?.replacementForm).toBe('text');
  });

  it('a cell with ids inside a sentence is quoted whole', () => {
    const t = lineFor(runCheck(ex(['gpt-4-0314'])), 'gpt-4-0314')[0]!.title;
    expect(t).toContain("; for its replacement the page says “gpt-5, or gpt-4.1 for latency-sensitive tasks that don't require reasoning”");
    expect(t).not.toMatch(/names `gpt-5, or/);
  });

  it('a plain id, or ids joined by "or", still reads "its page names"', () => {
    expect(lineFor(runCheck(ex(['gpt-5'])), 'gpt-5')[0]!.title).toContain('its page names `gpt-6.1-sol`');
    expect(lineFor(runCheck(ex(['gpt-4o-transcribe'])), 'gpt-4o-transcribe')[0]!.title).toContain(
      'its page names `gpt-live-transcribe or gpt-transcribe`',
    );
  });

  it('--model-facts quotes a sentence replacement in the page’s words', () => {
    const out = renderModelFacts('gpt-5.4-cyber');
    expect(out).toContain('replacement, in the page’s words: “The most capable cyber model available to you.”');
    expect(out).not.toContain('replacement the page names: `The most');
  });
});
