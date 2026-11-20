/**
 * Amendment B of the 0.4.1 filing (the seat, 2026-11-14, from the cold read of c311af0).
 * Every test here was run against c311af0's source first and seen red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ModelProfile } from '@warmdrift/kgauto-compiler';
import { allProfiles } from '@warmdrift/kgauto-compiler';
import { runCheck, cliffLine, DESTINATION_SENTENCE } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { READ } from './helpers/read.js';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string };
type Site = Extract['callSites'][number];
const run = (sites: Site[], opts?: Parameters<typeof runCheck>[1]) => runCheck({ project: { name: 't' }, callSites: sites }, opts);
type Cliff = ModelProfile['cliffs'][number];

describe('B1 — at the line when equal, over the line when greater', () => {
  const c: Cliff = { metric: 'input_tokens', threshold: 200_000, action: 'downgrade_quality_warning', reason: 'Pricing doubles above 200K' };
  it('an estimate equal to the threshold sits at the line', () => {
    expect(cliffLine('m', c, 200_000).detail).toContain('Your estimate of 200,000 sits at the line.');
    expect(cliffLine('m', c, 200_000).detail).not.toContain('over the line');
  });
  it('an estimate above it sits over the line', () => {
    expect(cliffLine('m', c, 200_001).detail).toContain('Your estimate of 200,001 sits over the line.');
  });
  it('a tool count equal to the threshold is at the line, and one tool is one tool', () => {
    const t: Cliff = { ...c, metric: 'tool_count', threshold: 1 };
    expect(cliffLine('m', t, 1).detail).toContain('This site offers 1 tool, at the line.');
    expect(cliffLine('m', t, 30).detail).toContain('This site offers 30 tools, over the line.');
  });
});

describe('B2 — the quality sentence needs an evidence RECORD', () => {
  const QUALITY = 'quality degrades in a measured, repeatable way';
  it('claude-haiku-4-5 (no evidence field, "measured" only in its prose) prints no quality sentence, the plain action, and the ruled evidence words', () => {
    const r = run([{ id: 'a.ts:1', model: 'claude-haiku-4-5', platform: 'provider-api', archetype: 'summarize', estInputTokens: 12_000, expectsStructuredOutput: true }]);
    const f = r.findings.find((x) => x.title.includes('the catalog holds a threshold at'))!;
    expect(f.detail).not.toContain(QUALITY);
    expect(f.detail).toContain(
      "If you call this model through `@warmdrift/kgauto-compiler`, it stops trusting this model's structured output at or above this size on summarize work, and ranks the model lower for such a request.",
    );
    expect(f.detail).toContain("Evidence: no evidence record; the catalog's note describes a measured incident.");
  });
  it('a recorded observed class, or a recorded confirming probe, keeps the quality sentence', () => {
    const base = { metric: 'input_tokens', threshold: 10, action: 'downgrade_quality_warning', reason: 'r' } as const;
    expect(cliffLine('m', { ...base, evidence: { class: 'observed' } }, 11).detail).toContain(QUALITY);
    expect(cliffLine('m', { ...base, evidence: { class: 'probed', verdict: 'confirmed' } }, 11).detail).toContain(QUALITY);
    expect(cliffLine('m', { ...base, reason: 'measured on real traffic' }, 11).detail).not.toContain(QUALITY);
  });
  // 0.4.3 (R8): the pin moved to alpha.134, which bundles 22 cliffs; the sweep still finds 0 quality sentences.
  it('the full-catalog sweep: 0 of the 22 bundled cliffs print the generic quality sentence on alpha.134', () => {
    let lines = 0;
    let quality = 0;
    for (const p of allProfiles()) for (const c of p.cliffs) {
      lines++;
      if (cliffLine(p.id, c, c.threshold + 1).detail.includes(QUALITY)) quality++;
    }
    expect(lines).toBe(22);
    expect(quality).toBe(0);
  });
});

describe('B3 — nothing false about uploads', () => {
  const sites: Site[] = [{ id: 'a.ts:1', model: 'gpt-4o-mini', platform: 'provider-api' }];
  it('with --share the card says it is sent after it is printed, by the user’s flag, and not that nothing was uploaded', async () => {
    const { SHARE_SENTENCE, destinationSentence } = await import('../src/engine.js');
    const card = run(sites, { share: true, pages: READ }).card;
    expect(card).not.toContain('Nothing was uploaded');
    expect(card).not.toContain('Nothing about your project was sent');
    // 0.4.3 (R2): the share forms keep their last sentence
    expect(destinationSentence(READ, true).endsWith(SHARE_SENTENCE)).toBe(true);
    expect(card).toContain(`*${destinationSentence(READ, true)}*`);
    expect(SHARE_SENTENCE).toBe('Because you ran it with --share, this card and the extract are sent after it is printed.');
  });
  it('without --share the footer says nothing about the project was sent', () => {
    expect(run(sites, { pages: READ }).card).toContain(
      '*This check ran on your machine. It read 10 of 10 provider pages in this run — the same 10 public pages whatever your project holds. Nothing about your project was sent anywhere, and no rows were written anywhere.*',
    );
    expect(DESTINATION_SENTENCE).toBe(
      'The check reads your repository on your machine; nothing about your project leaves it unless you choose to share the result.',
    );
  });
  it('a failure says the endpoint did not confirm a row and that a row may or may not exist', async () => {
    const share = (await import('../src/share.js')) as Record<string, unknown>;
    const msg = (share.shareFailure as (r: string) => string)('200: no {ok: true, id} in the answer');
    expect(msg).toBe(
      '[--share] FAILED (200: no {ok: true, id} in the answer) — the endpoint did not confirm a row, so a row may or may not exist. The check itself is unaffected.',
    );
    expect(msg).not.toMatch(/nothing was recorded/i);
    expect(readFileSync(join(PKG_DIR, 'src/bin.ts'), 'utf8')).not.toMatch(/nothing was recorded/i);
  });
});

describe('B5 — the README’s npx lines name the package’s version', () => {
  it('8 lines, each @<package.json version>, none unversioned or stale', () => {
    const lines = readFileSync(join(PKG_DIR, 'README.md'), 'utf8').split('\n').filter((l) => /\bnpx\b/.test(l));
    expect(lines).toHaveLength(8);
    for (const l of lines) {
      expect(l).toContain(`@warmdrift/kgauto-check@${pkg.version}`);
      expect(l).not.toMatch(/@warmdrift\/kgauto-check(?!@)/);
      for (const m of l.matchAll(/@warmdrift\/kgauto-check@([\w.-]+)/g)) expect(m[1]).toBe(pkg.version);
    }
  });
});

describe('B6 — a gateway or partner platform takes every provider-page line out of Certain', () => {
  const big = { maxInputTokens: 5_000_000, estInputTokens: 5_000_000, estOutputTokens: 100 };
  const lineOf = (r: ReturnType<typeof run>, s: string) => r.findings.find((f) => f.title.includes(s));
  it('the reader’s probe: openrouter/anthropic/claude-haiku-5-5 over its window is likely, with the gateway sentence', () => {
    const f = lineOf(run([{ id: 'a.ts:1', model: 'openrouter/anthropic/claude-haiku-5-5', platform: 'provider-api', ...big }]), 'context window')!;
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This id is written for OpenRouter, a gateway: the figure is from Anthropic's own API, and OpenRouter may set its own.");
  });
  it('vertex_ai/… over its window is likely, with the partner sentence', () => {
    const f = lineOf(run([{ id: 'a.ts:1', model: 'vertex_ai/gemini-2.5-flash', ...big }]), 'context window')!;
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site runs on Vertex AI: the figure is from Google's own API, and Vertex AI may set its own.");
  });
  it('a stated partner platform puts the sentence on the price line', () => {
    const r = run([{ id: 'a.ts:1', model: 'gpt-6-luna', platform: 'azure', estInputTokens: 1000, estOutputTokens: 100 }]);
    const cost = r.findings.find((f) => f.title.includes('/call'))!;
    expect(cost.confidence).toBe('likely');
    expect(cost.detail).toContain("This site runs on Azure: the figure is from OpenAI's own API, and Azure may set its own.");
  });
  // 0.4.3 (R1): a catalog limit is Likely in every run (its page is not read at run time); on the provider's own API it carries no partner sentence.
  it('the same id on the provider’s own API: likely, with no partner sentence (until 0.4.2: certain)', () => {
    const f = lineOf(run([{ id: 'a.ts:1', model: 'claude-haiku-5-5', platform: 'provider-api', ...big }], { pages: READ }), 'context window')!;
    expect(f.confidence).toBe('likely');
    // 0.4.4 (R1): in words (until 0.4.3: "catalog, verified against the provider's page <date>: maxContextTokens=<n>")
    expect(f.basis).toMatch(/^your estimate against the model's context limit, [\d,]+ tokens \(the catalog's record, checked against \w+'s documentation on \d{4}-\d{2}-\d{2}\)$/);
    expect(f.detail).not.toContain('may set its own');
  });
});
