/**
 * Amendment B of the 0.4.2 filing (the seat, 2026-11-14T22:50Z, from the cold read of b3fe174).
 * B1 — a `listed` line says what the model is, by the heading its row sits under on Google's page
 * (the row's `section`), not where it is listed. Run first against b3fe174's code and seen red.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { LEDGER } from '../src/lifecycle-ledger.js';

const ex = (model: string): Extract => ({ project: { name: 't' }, callSites: [{ id: 's0', model, platform: 'provider-api' }] });
const listedLine = (id: string) => runCheck(ex(id)).findings.find((f) => f.title.includes(`\`${id}\``) && f.title.includes('no shutdown date announced'));

describe('B1 — the listed line says what the model is', () => {
  it('a row in a family’s main table: "among its current models"', () => {
    expect(listedLine('gemini-4-argon')?.title).toBe(
      "On Google's own API, `gemini-4-argon` has no shutdown date announced: Google's deprecations page lists it among its current models",
    );
  });

  it('a row under Preview models: "among its preview models", with the replacement clause as before', () => {
    expect(listedLine('gemini-3.1-flash-live-preview')?.title).toBe(
      "On Google's own API, `gemini-3.1-flash-live-preview` has no shutdown date announced: Google's deprecations page lists it among its preview models; its page names `gemini-3.8-live`",
    );
  });

  it('a row under Preview agents: "among its preview agents"', () => {
    expect(listedLine('deep-research-preview-04-2026')?.title).toBe(
      "On Google's own API, `deep-research-preview-04-2026` has no shutdown date announced: Google's deprecations page lists it among its preview agents",
    );
  });

  it('every listed row: the phrase follows its section heading, the line is info, and no line says "is listed on"', () => {
    const listed = LEDGER.filter((r) => r.word === 'listed');
    const by: Record<string, number> = {};
    for (const r of listed) {
      const h3 = r.section?.split(' › ')[1];
      const want = h3 === undefined ? 'current models' : /^Preview models/.test(h3) ? 'preview models' : /^Preview agents/.test(h3) ? 'preview agents' : `?${h3}`;
      by[want] = (by[want] ?? 0) + 1;
      const f = listedLine(r.id);
      expect(f?.title, r.id).toContain(`: Google's deprecations page lists it among its ${want}`);
      expect(f?.title, r.id).not.toContain('is listed on');
      expect(f?.severity, r.id).toBe('info');
    }
    expect(by).toEqual({ 'current models': 20, 'preview models': 9, 'preview agents': 3 });
  });
});
