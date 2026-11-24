/**
 * The check 0.4.4, fix pass 1 (the filing's Amendment A, rulings A1–A3; A4 is in check-044-a4.test.ts). No test
 * here makes a network request: pages are the read record. Each behaviour was seen red once against the head
 * before the fix (baca679); the filing's foot ("Fix pass 1 — the builder's report") says which.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allProfiles, type ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck, cliffLine } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { READ } from './helpers/read.js';
import { sweepBases, lineMisses, shapeOf } from './helpers/sweep.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

const ex = (sites: Partial<Extract['callSites'][number]>[], models: Extract['models'] = []): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: sites.map((s, i) => ({ id: `src/a${i}.py:1`, model: 'x', ...s })), models });

const swept = sweepBases();
const bases = [...swept.bases.keys()];

// ── A1 — the four noun-phrase bases become sentences ─────────────────────
describe('A1 — the four noun-phrase bases are sentences a stranger can read', () => {
  const OLD = [
    'arithmetic on your estimates × verified catalog prices',
    'verified catalog prices; quality deliberately unclaimed',
    'the honest limit of static analysis',
    'catalog lookup and the providers’ deprecation lists',
  ];

  it('none of the four noun phrases is printed any more', () => {
    expect(bases.filter((b) => OLD.includes(b))).toEqual([]);
  });

  it('the price line: your estimates multiplied by the catalog’s prices, with where the prices came from in the limit lines’ words', () => {
    const p = allProfiles().find((x) => x.provider === 'openai' && x.status === 'current' && x.verifiedAgainstDocs)!;
    const f = runCheck(ex([{ model: p.id, platform: 'provider-api', estInputTokens: 1000, estOutputTokens: 1000 }]), { pages: READ }).findings.find((x) =>
      x.title.startsWith('~$'),
    )!;
    const src = `the catalog's record, checked against OpenAI's documentation on ${p.verifiedAgainstDocs}`;
    expect(f.basis).toBe(`your token estimates multiplied by the catalog's prices for this model (${src})`);
    // the detail says the same thing in the same source words
    expect(f.detail).toContain(`the catalog's prices for this model ($${p.costInputPer1m}/M in, $${p.costOutputPer1m}/M out; ${src})`);
    expect(f.detail).not.toMatch(/doc-verified|verified/);
  });

  it('the price line on a profile with no date: “not checked”, in the basis and the detail alike', () => {
    const p: ModelProfile = { ...allProfiles().find((x) => x.provider === 'anthropic')!, id: 'made-up-undated', verifiedAgainstDocs: undefined };
    const f = runCheck(ex([{ model: p.id, estInputTokens: 1000, estOutputTokens: 1000 }]), {
      pages: READ,
      resolve: (id) => ({ canonical: id, profile: id === p.id ? p : undefined }),
      roster: () => [p],
    }).findings.find((x) => x.title.startsWith('~$'))!;
    expect(f.basis).toBe("your token estimates multiplied by the catalog's prices for this model (the catalog's record, not checked against Anthropic's documentation)");
    expect(f.detail).toContain("; the catalog's record, not checked against Anthropic's documentation)");
  });

  it('the cheaper-models line, the observe-day line and the not-recognised line', () => {
    expect(bases).toContain("your token estimates at each model's prices in the catalog; nothing on this line says how well any of them would do your work");
    expect(bases).toContain('this check reads the extract of your code and runs none of your calls, so it cannot see how they behave');
    expect(bases).toContain("this id was looked up in the catalog and in the providers' pages this check reads, and matched neither");
  });

  it('“verified” is printed only where a date from the record stands beside it', () => {
    const texts = [...bases, ...swept.titles, ...swept.details];
    const bad = texts.filter((t) => /verified/i.test(t.replace(/verified (?:on )?\d{4}-\d{2}-\d{2}/gi, '')));
    expect([...new Set(bad.map(shapeOf))]).toEqual([]);
  });
});

// ── A2 — no cliff and no probe on any line a card prints ─────────────────
describe('A2 — no “cliff” and no “probe” on any title or detail the engine can print', () => {
  it('every title the sweep printed', () => {
    const bad = [...swept.titles].filter((t) => lineMisses(t));
    expect([...new Set(bad.map(shapeOf))]).toEqual([]);
  });

  it('every detail the sweep printed (a catalog reason in quotation marks is the compiler’s text, set aside)', () => {
    const bad = [...swept.details].filter((t) => lineMisses(t));
    expect([...new Set(bad.map((d) => `${lineMisses(d)} ← ${shapeOf(d)}`))]).toEqual([]);
  });

  it('the threshold line’s title, at the line and over it, on tokens and on tools', () => {
    const c = (metric: 'input_tokens' | 'tool_count', threshold: number) => ({ metric, threshold, action: 'downgrade_quality_warning' as const, reason: 'a reason' });
    expect(cliffLine('m', c('input_tokens', 272000), 300000).title).toBe('`m`: the catalog holds a threshold at 272,000 input tokens, and this site crosses it');
    expect(cliffLine('m', c('input_tokens', 272000), 272000).title).toBe('`m`: the catalog holds a threshold at 272,000 input tokens, and this site reaches it');
    expect(cliffLine('m', c('tool_count', 1), 1).title).toBe('`m`: the catalog holds a threshold at 1 tool, and this site reaches it');
    expect(cliffLine('m', c('tool_count', 5), 9).title).toBe('`m`: the catalog holds a threshold at 5 tools, and this site crosses it');
  });

  it('a capability-reducing action held back: until a test reproduces the problem (the words the basis uses)', () => {
    const d = cliffLine('m', { metric: 'tool_count', threshold: 1, action: 'strip_tools', reason: 'a reason' }, 1).detail;
    expect(d).toContain('but holds that back until a test reproduces the problem.');
  });

  it('the evidence sentence, for every verdict of a test, in the words the basis uses', () => {
    const ev = (verdict?: 'confirmed' | 'flagged' | 'knee-moved') =>
      cliffLine('m', { metric: 'input_tokens', threshold: 1000, action: 'downgrade_quality_warning', reason: 'a reason', evidence: { class: 'probed', lastProbed: '2026-10-01', ...(verdict ? { verdict } : {}) } }, 2000).detail;
    expect(ev('confirmed')).toContain('Evidence: a test reproduced the problem, last run 2026-10-01.');
    expect(ev('flagged')).toContain('Evidence: a test did not reproduce the problem, last run 2026-10-01.');
    expect(ev('knee-moved')).toContain('Evidence: a test moved the threshold, and the catalog was changed to match, last run 2026-10-01.');
    expect(ev()).toContain('Evidence: a test was run and its result is not recorded, last run 2026-10-01.');
  });
});

// ── A3 — the header says its counting rule when the rule did something ──
describe('A3 — the header states the count-once rule only when a flagged id is written in more than one kind of place', () => {
  const F = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-043.json'), 'utf8')));
  const line3 = (e: Extract) => runCheck(e, { pages: READ }).card.split('\n')[2]!;
  const RULE = /counted once/;

  it('no flagged id in two kinds of place (the fixture): the header is as built, with no rule sentence', () => {
    // 0.4.6 (R8): the counts in the order the rule sentence names — runs, not stated, tests, examples, docs (until 0.4.6: "3 are in code that runs, 1 in tests, 1 in docs, 1 in examples and 2 where the extract does not say.")
    expect(line3(F)).toBe(
      '0 AI call sites and 8 model ids: `gpt-4o-realtime-preview`, `claude-3-5-sonnet-20241022`, `gpt-4-turbo-2024-04-09`, `claude-sonnet-4-20250514`, `gpt-4o`, `gemini-2.5-flash`, `claude-opus-4-1`, `gemini-pro`. ' +
        "7 are flagged by their providers, and 1 by this check's reading of Google's release notes page. " +
        'Of the 8 flagged ids, 3 are in code that runs, 2 where the extract does not say, 1 in tests, 1 in examples and 1 in docs.',
    );
  });

  it('one flagged id in two kinds of place: one more sentence, saying it is counted once and under which', () => {
    expect(line3(ex([{ model: 'gpt-4o-mini', platform: 'provider-api', context: 'runs' }, { model: 'gpt-4o-mini', context: 'test' }, { model: 'gpt-4o', context: 'docs' }]))).toBe(
      '3 AI call sites and 2 model ids: `gpt-4o-mini`, `gpt-4o`. 2 are flagged by OpenAI. Of the 2 flagged ids, 1 is in code that runs and 1 in docs. ' +
        '1 of them is written in more than one kind of place, and is counted once, under the first that applies in this order: code that runs, where the extract does not say, tests, examples, docs.',
    );
  });

  it('the fixture with one of its flagged ids written in a second kind of place: the counts follow the rule, and the sentence says so', () => {
    const G = ExtractSchema.parse({ ...F, models: [...(F.models ?? []), { model: 'gemini-pro', where: 'docs/models.md:3', context: 'docs' }] });
    const l = line3(G);
    expect(l).toMatch(/Of the 8 flagged ids, .*\. 1 of them is written in more than one kind of place, and is counted once, under the first that applies in this order: /);
  });

  it('a site with no context beside one in code that runs is two kinds of place (it counts under “code that runs”)', () => {
    expect(line3(ex([{ model: 'gpt-4o-mini', context: 'runs' }, { model: 'gpt-4o-mini' }, { model: 'gpt-4o', context: 'docs' }]))).toContain(
      'Of the 2 flagged ids, 1 is in code that runs and 1 in docs. 1 of them is written in more than one kind of place, and is counted once',
    );
  });

  it('two such ids: the plural', () => {
    const l = line3(
      ex([
        { model: 'gpt-4o-mini', context: 'runs' },
        { model: 'gpt-4o-mini', context: 'test' },
        { model: 'gpt-4o', context: 'example' },
        { model: 'gpt-4o', context: 'docs' },
      ]),
    );
    expect(l).toContain('Of the 2 flagged ids, 1 is in code that runs and 1 in examples. 2 of them are written in more than one kind of place, and each is counted once, under the first that applies in this order: ');
  });

  it('an id in two kinds of place that no provider flags: no rule sentence (nothing flagged was counted)', () => {
    expect(line3(ex([{ model: 'claude-opus-5-5', context: 'runs' }, { model: 'claude-opus-5-5', context: 'test' }]))).not.toMatch(RULE);
  });
  // The check over the 40 private extracts (none prints the sentence) is in tests/regression-cards.test.ts, the file
  // the public export withholds (0.4.4 fix pass 3).
});
