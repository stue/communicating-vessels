/**
 * The check 0.4.4, fix pass 2 (the filing's Amendment B, rulings B1 and B3). No test here makes a network request:
 * pages are the read record or a page built in the test. B1 was seen red on the head before the fix (2dd4691);
 * each B3 test was seen red with the cold reader's surviving mutant applied (M1, M3, M5, M6) and green without it.
 */
import { describe, it, expect } from 'vitest';
import { allProfiles, type ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck, cutQuote, QUOTE_LIMIT } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { pageShapeMisses } from '../src/ledger-check.mjs';
import { READ } from './helpers/read.js';

const ex = (sites: Partial<Extract['callSites'][number]>[], models: Extract['models'] = []): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: sites.map((s, i) => ({ id: `src/a${i}.py:1`, model: 'x', ...s })), models });
const line3 = (e: Extract) => runCheck(e, { pages: READ }).card.split('\n')[2]!;

// ── B1 — the cheaper-models line agrees with its count ───────────────────
describe('B1 — the cheaper-models line agrees with a count of one, and is as built above one', () => {
  // a made-up roster through the engine's seams: the model checked, and cheaper ones beside it
  const base = allProfiles().find((p) => p.status === 'current' && p.verifiedAgainstDocs)!;
  const mk = (id: string, cin: number, cout: number): ModelProfile => ({ ...base, id, status: 'current', costInputPer1m: cin, costOutputPer1m: cout, cliffs: [], providerLifecycle: undefined });
  const dear = mk('made-up-dear', 10, 40);
  const lineWith = (cheap: ModelProfile[]) => {
    const roster = [dear, ...cheap];
    const byId = new Map(roster.map((p) => [p.id, p]));
    return runCheck(ex([{ model: dear.id, archetype: 'summarize', estInputTokens: 1000, estOutputTokens: 1000 }]), {
      pages: READ,
      resolve: (id) => ({ canonical: id, profile: byId.get(id) }),
      roster: () => roster,
    }).findings.find((f) => / in the catalog prices? under half of /.test(f.title))!;
  };

  it('one cheaper model: the verb is singular, and the line says “it”, never “any of them”', () => {
    const f = lineWith([mk('made-up-cheap', 1, 4)]);
    expect(f.title).toBe('1 model in the catalog prices under half of `made-up-dear` on summarize work');
    expect(f.detail).toContain('whether it holds YOUR quality bar on summarize work');
    expect(f.detail).not.toMatch(/any of them|Cheapest/);
    expect(f.basis).toBe("your token estimates at that model's prices in the catalog; nothing on this line says how well it would do your work");
  });

  it('more than one: the line as built', () => {
    const f = lineWith([mk('made-up-cheap', 1, 4), mk('made-up-cheaper', 0.5, 2)]);
    expect(f.title).toBe('2 models in the catalog price under half of `made-up-dear` on summarize work');
    expect(f.detail).toContain('Cheapest: `made-up-cheaper` at ~$');
    expect(f.detail).toContain('whether any of them holds YOUR quality bar on summarize work');
    expect(f.basis).toBe("your token estimates at each model's prices in the catalog; nothing on this line says how well any of them would do your work");
  });
});

// ── B3 — the cold reader's surviving mutants ─────────────────────────────
describe('B3 — the tests the cold read found missing', () => {
  it('M1: a quote exactly the limit long is printed whole; one character more is cut at its boundary', () => {
    const s = `alpha | ${'b'.repeat(QUOTE_LIMIT - 8)}`;
    expect(s.length).toBe(QUOTE_LIMIT);
    expect(cutQuote(s)).toBe(s);
    expect(cutQuote(`${s}c`)).toBe('alpha…');
  });

  it('M3: an id written in two kinds of place that no provider flags does not bring the counting sentence', () => {
    const l = line3(ex([{ model: 'gpt-4o-mini', context: 'runs' }, { model: 'gpt-4o', context: 'docs' }, { model: 'claude-opus-5-5', context: 'runs' }, { model: 'claude-opus-5-5', context: 'test' }]));
    expect(l).toContain('Of the 2 flagged ids, 1 is in code that runs and 1 in docs.');
    expect(l).not.toMatch(/counted once/);
  });

  it('M5: “Of the N flagged ids” counts the flagged ids only, beside unflagged ids that carry a context', () => {
    expect(line3(ex([{ model: 'gpt-4o-mini', context: 'runs' }, { model: 'gpt-4o', context: 'docs' }, { model: 'claude-opus-5-5', context: 'test' }]))).toBe(
      '3 AI call sites and 3 model ids: `gpt-4o-mini`, `gpt-4o`, `claude-opus-5-5`. 2 are flagged by OpenAI. Of the 2 flagged ids, 1 is in code that runs and 1 in docs.',
    );
  });

  it('M6: a second “Model ID:” line without code marks makes the page one this version does not read', () => {
    const page = ['# GPT-4o mini', '', 'Model ID: `gpt-4o-mini`', '', 'Model ID: gpt-4o', '', 'Status: Deprecated', ''].join('\n');
    expect(pageShapeMisses('openai-model-gpt-4o-mini.md', page)).toEqual(['exactly one "Model ID: `gpt-4o-mini`" line (found `gpt-4o-mini` and "Model ID: gpt-4o")']);
  });
});
