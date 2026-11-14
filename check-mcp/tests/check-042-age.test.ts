/**
 * 0.4.2 (R3) — the card says its age when that matters: more than seven days after the ledger's read,
 * the footer adds one sentence. The clock is the machine's (UTC date); `today` is the test seam.
 * Run first against 0.4.1's engine: the three tests that need the sentence were red there; the two
 * that guard its absence passed there, and a boundary mutant (`<=` → `<`) turns the seven-day one red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCheck } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { LEDGER_READ_ON } from '../src/lifecycle.js';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ex = (model: string): Extract => ({ project: { name: 't' }, callSites: [{ id: 's1', model, platform: 'provider-api' }] });

describe('0.4.2 R3 — the card says its age when that matters', () => {
  const AGE = /were read \d+ days ago/;
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seven days after the read: nothing is added', () => {
    const card = runCheck(ex('gpt-5'), { today: addDays(LEDGER_READ_ON, 7) }).card;
    expect(card).not.toMatch(AGE);
  });

  it('eight days after the read: one sentence in the footer, with the count, the read date and where a newer read is', () => {
    const card = runCheck(ex('gpt-5'), { today: addDays(LEDGER_READ_ON, 8) }).card;
    expect(card).toContain(
      `*The providers’ pages behind this card were read 8 days ago, on ${LEDGER_READ_ON}; providers change them, and the newest version of the check carries a newer read.*`,
    );
    const lines = card.split('\n');
    const i = lines.findIndex((l) => AGE.test(l));
    expect(lines[i - 1]).toContain('This check ran on your machine');
    expect(lines[i + 1]).toMatch(/^<sub>@warmdrift\/kgauto-check .* deprecation pages read /);
    expect(lines.filter((l) => AGE.test(l)).length).toBe(1);
  });

  it('on the day of the read, and on a clock set before it: nothing is added', () => {
    expect(runCheck(ex('gpt-5'), { today: LEDGER_READ_ON }).card).not.toMatch(AGE);
    expect(runCheck(ex('gpt-5'), { today: addDays(LEDGER_READ_ON, -3) }).card).not.toMatch(AGE);
  });

  it('with no date given, the clock is the machine’s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${addDays(LEDGER_READ_ON, 30)}T12:00:00Z`));
    expect(runCheck(ex('gpt-5')).card).toContain('were read 30 days ago');
    vi.setSystemTime(new Date(`${addDays(LEDGER_READ_ON, 2)}T12:00:00Z`));
    expect(runCheck(ex('gpt-5')).card).not.toMatch(AGE);
  });

  it('a card printed with --share carries it too', () => {
    const card = runCheck(ex('gpt-5'), { share: true, today: addDays(LEDGER_READ_ON, 9) }).card;
    expect(card).toContain('were read 9 days ago');
  });
});
