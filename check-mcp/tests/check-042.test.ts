/**
 * 0.4.2 (R1) — the ledger, re-read from the four providers' pages on 2026-11-14. R2 (the drift check)
 * is tests/ledger-drift.test.ts; R3 (the card's age) is tests/check-042-age.test.ts. Each test here was
 * run first against the state it must refuse: the 0.4.1 ledger (df96bd7), and the 0.4.1 generator's
 * output on the pages read 2026-11-14.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { LEDGER, LEDGER_SOURCES, LEDGER_DEFINITIONS } from '../src/lifecycle-ledger.js';
import { LEDGER_READ_ON, lookupLedger, resolveId } from '../src/lifecycle.js';

const row = (id: string) => LEDGER.find((r) => r.id === id);
const ex = (model: string): Extract => ({ project: { name: 't' }, callSites: [{ id: 's1', model, platform: 'provider-api' }] });

describe('0.4.2 R1 — the ledger, re-read from all four providers', () => {
  it('every source page was read the same hour, and not before 2026-11-14', () => {
    const t = LEDGER_SOURCES.map((s) => Date.parse(s.readAt));
    expect(Math.max(...t) - Math.min(...t)).toBeLessThan(3_600_000);
    expect(LEDGER_READ_ON >= '2026-11-14').toBe(true);
    expect(new Set(LEDGER_SOURCES.map((s) => s.provider))).toEqual(new Set(['anthropic', 'openai', 'google', 'deepseek']));
  });

  it('no row carries November 17, 2026: Google’s page no longer gives it for any model', () => {
    const hits = LEDGER.filter((r) => r.shutdown === '2026-11-17' || r.shutdownFloor === '2026-11-17' || /November 17, 2026/.test(JSON.stringify(r)));
    expect(hits.map((r) => r.id)).toEqual([]);
  });

  it('the four Google rows whose date moved say what the page said at the 2026-11-14T21:44Z read', () => {
    for (const id of ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']) {
      expect(row(id)?.word, id).toBe('scheduled for shutdown');
      expect(row(id)?.shutdownFloor, id).toBe('2026-12-18');
      expect(row(id)?.dateText, id).toBe('December 18, 2026');
    }
    expect(row('gemini-2.5-flash-native-audio-preview-12-2025')?.shutdownFloor).toBe('2027-03-31');
    expect(row('gemini-2.5-flash-native-audio-preview-12-2025')?.dateText).toBe('March 31, 2027');
  });

  it('a model whose page now says "No shutdown date announced", with no deprecation word, is no longer scheduled for shutdown', () => {
    // Amendment A1 amends the 0.4.0 rule this test first held (no row): the row is `listed`, with no date (tests/amendment-a-042.test.ts).
    const r = lookupLedger(resolveId('gemini-3.1-flash-live-preview')).row;
    expect(r?.word).toBe('listed');
    expect(r?.shutdown ?? r?.shutdownFloor).toBeUndefined();
  });

  it('every OpenAI row carries the notice date its page row gives, and its date text without markup', () => {
    const openai = LEDGER.filter((r) => r.provider === 'openai');
    expect(openai.length).toBeGreaterThan(0);
    for (const r of openai) {
      expect(r.announced, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.dateText ?? '', r.id).not.toContain('**');
    }
  });

  it('a cell saying there is no one-to-one replacement is not printed as a replacement', () => {
    expect(LEDGER.filter((r) => /one-to-one/i.test(r.replacement ?? '')).map((r) => r.id)).toEqual([]);
    expect(row('sora-2')?.replacement).toBeUndefined();
    expect(row('sora-2')?.quote).toContain('No one-to-one replacement');
  });

  it('the definitions the card quotes are ledger rows of their own, each on a recorded source page', () => {
    const urls = new Set(LEDGER_SOURCES.map((s) => s.url));
    // 0.4.5: and two sentences kept the same way — Anthropic's notice period (R4 b) and OpenAI's sentence about fine-tunes (R5)
    expect(LEDGER_DEFINITIONS.map((d) => `${d.provider}:${d.word}`).sort()).toEqual([
      'anthropic:notice period',
      'anthropic:operated platforms', // 0.4.7 (R5)
      'anthropic:retired',
      'google:already-shutdown sections', // 0.4.7 fix pass 1: what makes *shut down* Google's word under "Deprecated models"
      'google:shut down',
      'openai:existing fine-tuned models', // 0.4.7 (R4): read and checked, not printed
      'openai:fine-tuned versions',
      'openai:fine-tunes of the GPT-3.5 Turbo snapshots', // 0.4.7 (R4): read and checked, not printed
      'openai:fine-tunes of the October 2026 shutdown', // 0.4.7 (R4): quoted for a fine-tune of a base its link ties it to
      'openai:fine-tuning training on babbage-002 and davinci-002', // 0.4.7 (R4): read and checked, not printed
      'openai:shut down',
      'openai:the legacy fine-tunes endpoint', // 0.4.7 (R4): read and checked, not printed
    ]);
    for (const d of LEDGER_DEFINITIONS) expect(urls.has(d.url), d.provider).toBe(true);
  });

  it('an OpenAI shut-down line quotes the sentence OpenAI’s page carries now, not the 2026-11-12 one', () => {
    const f = runCheck(ex('gpt-3.5-turbo')).findings.find((x) => x.title.includes('was shut down'));
    expect(f?.detail).toContain('“The model no longer accepts requests through the standard API.”');
    expect(f?.detail).not.toContain('At the time of the shut down');
  });

  it('a quoted OpenAI row shows the page’s words, not its markdown bold (the ledger keeps the line verbatim)', () => {
    expect(row('gpt-4o-mini-2024-07-18')?.quote).toContain('**Jan 14, 2027**');
    const f = runCheck(ex('gpt-4o-mini-2024-07-18')).findings.find((x) => x.title.includes('gpt-4o-mini-2024-07-18'));
    expect(f?.detail).toContain('“| Jan 14, 2027 | GPT-4o mini (`gpt-4o-mini-2024-07-18`) | Deprecated | `gpt-6-luna` | Oct 14, 2026 |”');
    expect(f?.detail).not.toContain('**');
  });

  it('a card on gpt-5 names the replacement OpenAI’s page names now', () => {
    const f = runCheck(ex('gpt-5')).findings.find((x) => x.title.includes('`gpt-5`'));
    expect(f?.title).toContain('`gpt-6.1-sol`');
    expect(f?.title).not.toContain('gpt-5.6-sol');
  });
});
