/**
 * The check 0.4.5, R9 — the 0.4.4 reader's M10: the title "<id> is deprecated; shutdown not before <floor>" (engine.ts,
 * ledgerLine's default branch) is reached by no row of the ledger read for this release. It is kept, and reached here
 * by a row planted in the ledger for this file only (a module mock: the planted row is the shape a provider's
 * "Deprecated … not sooner than <date>" row would be written in). M10 put the row's `pageWord` into that title.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LedgerRow } from '../src/lifecycle-types.js';

const PLANTED: LedgerRow = {
  id: 'made-up-floor-1',
  provider: 'anthropic',
  word: 'deprecated',
  pageWord: 'Deprecated',
  announced: '2026-10-01',
  shutdownFloor: '2027-03-01',
  dateText: 'Not sooner than March 1, 2027',
  url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
  readOn: '2026-11-20',
  quote: '| made-up-floor-1 | Deprecated | October 1, 2026 | Not sooner than March 1, 2027 |',
};

vi.mock('../src/lifecycle-ledger.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lifecycle-ledger.js')>();
  return { ...real, LEDGER: [...real.LEDGER, PLANTED] };
});

describe('R9 — M10: the “deprecated; shutdown not before” title is reached by a row, and prints no page word', () => {
  it('a deprecated row with a floor and no date', async () => {
    const { runCheck } = await import('../src/engine.js');
    const { ExtractSchema } = await import('../src/extract.js');
    const e = ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: [{ model: 'made-up-floor-1', where: 'a.py:1', platform: 'provider-api' }] });
    const f = runCheck(e, { today: '2026-11-20' }).findings.find((x) => x.title.includes('`made-up-floor-1`'))!;
    expect(f.title).toBe("On Anthropic's own API, `made-up-floor-1` is deprecated; shutdown not before 2027-03-01");
  });
});
