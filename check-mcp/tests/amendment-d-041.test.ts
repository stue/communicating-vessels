/**
 * Amendment D of the 0.4.1 filing (the seat, 2026-11-14, from the re-read of 596a933).
 * Every test here was run against 596a933's source first and seen red.
 */
import { describe, it, expect } from 'vitest';
import type { ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck, cliffLine } from '../src/engine.js';
import type { Extract } from '../src/extract.js';

type Site = Extract['callSites'][number];
const run = (sites: Site[]) => runCheck({ project: { name: 'made-up' }, callSites: sites });
const price = (r: ReturnType<typeof run>) => r.findings.find((f) => f.title.includes('/call'))!;
const tokens = { estInputTokens: 10_000, estOutputTokens: 500 };
type Cliff = ModelProfile['cliffs'][number];

describe('D1 — a word in a path is not a fact about where the site runs', () => {
  it('the reader’s probe: an Azure word in the path, provider-api stated — the conditional sentence and the disagreement clause', () => {
    const f = price(run([{ id: 'src/azure-pricing-table.ts:12', model: 'gpt-5.4', platform: 'provider-api', ...tokens }]));
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site's path or notes name Azure; if it runs there, the figure is from OpenAI's own API and Azure may set its own.");
    expect(f.detail).toContain("The extract and the code disagree: the extract says the provider's own API, but its notes or path name Azure.");
    expect(f.detail).not.toContain('This site runs on Azure');
  });

  it('a partner named only in the notes, platform unstated — the conditional sentence, no disagreement', () => {
    const f = price(run([{ id: 'made-up.ts:1', model: 'gpt-5.4', notes: 'Azure deployment default', ...tokens }]));
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site's path or notes name Azure; if it runs there, the figure is from OpenAI's own API and Azure may set its own.");
    expect(f.detail).not.toContain('disagree');
  });

  it('a stated platform keeps the flat sentence', () => {
    const f = price(run([{ id: 'made-up.ts:1', model: 'gpt-5.4', platform: 'azure', ...tokens }]));
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site runs on Azure: the figure is from OpenAI's own API, and Azure may set its own.");
  });

  it('an id whose own form names the platform keeps the flat sentence', () => {
    const f = price(run([{ id: 'made-up.ts:1', model: 'azure/gpt-5.4', ...tokens }]));
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site runs on Azure: the figure is from OpenAI's own API, and Azure may set its own.");
    expect(f.detail).not.toContain('path or notes');
  });

  it('a stated platform and a words-only site holding the same id are not merged into one analysis', () => {
    const r = run([
      { id: 'a.ts:1', model: 'gpt-5.4', platform: 'azure', ...tokens },
      { id: 'b.ts:1', model: 'gpt-5.4', notes: 'Azure deployment default', ...tokens },
    ]);
    const lines = r.findings.filter((f) => f.title.includes('/call'));
    expect(lines.find((f) => f.callSites.includes('a.ts:1'))!.detail).toContain('This site runs on Azure');
    expect(lines.find((f) => f.callSites.includes('b.ts:1'))!.detail).toContain('path or notes name Azure');
  });
});

describe('D2 — the cliff title agrees with its sentence', () => {
  const c: Cliff = { metric: 'input_tokens', threshold: 200_000, action: 'downgrade_quality_warning', reason: 'r' };
  it('at equality the site reaches the cliff; above, it crosses it', () => {
    // 0.4.4 Amendment A2: the title in the basis's words, with no "cliff" (the 0.4.1–0.4.4 build title is in the filing)
    expect(cliffLine('m', c, 200_000).title).toBe('`m`: the catalog holds a threshold at 200,000 input tokens, and this site reaches it');
    expect(cliffLine('m', c, 200_001).title).toBe('`m`: the catalog holds a threshold at 200,000 input tokens, and this site crosses it');
  });
});

describe('D3 — "at or above this size"', () => {
  it('the structured-output gate fires at >=, and says so', () => {
    const c: Cliff = { metric: 'input_tokens', threshold: 12_000, action: 'quality_gate_structured', whenIntent: 'summarize', reason: 'r' };
    expect(cliffLine('m', c, 12_000).detail).toContain(
      "What the compiler does about it: it stops trusting this model's structured output at or above this size on summarize work, and ranks the model lower for such a request.",
    );
  });
});
