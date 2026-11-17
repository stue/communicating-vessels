/**
 * Amendment C3 of the 0.4.1 filing — the package tests each kind of line the regression cards print,
 * each on a made-up extract (the regression set itself is private). The kinds already covered
 * elsewhere are named in the filing's report; this file holds the ones that had no test of their own.
 */
import { describe, it, expect } from 'vitest';
import type { ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { READ } from './helpers/read.js';

type Site = Extract['callSites'][number];
const run = (sites: Site[], opts?: Parameters<typeof runCheck>[1]) => runCheck({ project: { name: 'made-up' }, callSites: sites }, opts);
const find = (r: ReturnType<typeof run>, s: string) => r.findings.find((f) => f.title.includes(s));

describe('C3 — line kinds with no test of their own until now', () => {
  it('lifecycle, shut down on a date the page gives (certain on a stated provider API)', () => {
    // 0.4.3 (R1): Certain on the pages as read for this release
    const f = find(run([{ id: 'made-up.ts:1', model: 'gemini-1.5-flash', platform: 'provider-api' }], { pages: READ }), 'gemini-1.5-flash')!;
    expect(f.confidence).toBe('certain');
    expect(f.severity).toBe('red');
    expect(f.title).toBe("On Google's own API, `gemini-1.5-flash` was shut down on 2025-09-29");
  });

  it('lifecycle, deprecated with its requests routed to another model from a date', () => {
    const f = find(run([{ id: 'made-up.ts:1', model: 'gemini-2.5-flash', platform: 'provider-api' }], { pages: READ }), 'gemini-2.5-flash')!;
    expect(f.confidence).toBe('certain');
    expect(f.title).toBe("On Google's own API, `gemini-2.5-flash` is deprecated; from 2026-12-01 its requests route to `gemini-3.5-flash-lite`");
  });

  it('B6 — the output-cap line on a partner platform is likely and says whose figure it is', () => {
    const r = run([{ id: 'made-up.ts:1', model: 'gpt-6-luna', platform: 'azure', estOutputTokens: 500_000 }]);
    const f = find(r, 'output cap')!;
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This site runs on Azure: the figure is from OpenAI's own API, and Azure may set its own.");
    const direct = find(run([{ id: 'made-up.ts:1', model: 'gpt-6-luna', platform: 'provider-api', estOutputTokens: 500_000 }]), 'output cap')!;
    expect(direct.detail).not.toContain('may set its own');
  });

  // 0.4.3 (R1): a catalog capability is Likely in every run; only the partner sentence tells the two sites apart.
  it('B6 — the structured-output line is likely on the provider API (until 0.4.2: certain) and likely, with the sentence, on a partner', () => {
    // No bundled profile declares structuredOutput 'none' in alpha.133, so this kind is tested on a made-up profile.
    const p = {
      id: 'made-up-model',
      provider: 'google',
      status: 'current',
      verifiedAgainstDocs: '2026-11-01',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_192,
      maxTools: 64,
      parallelToolCalls: true,
      structuredOutput: 'none',
      systemPromptMode: 'system_param',
      streaming: true,
      cliffs: [],
      costInputPer1m: 1,
      costOutputPer1m: 1,
      lowering: {},
      recovery: [],
      strengths: [],
      weaknesses: [],
    } as unknown as ModelProfile;
    const opts = { resolve: () => ({ canonical: 'made-up-model', profile: p }), roster: () => [p], pages: READ };
    const onApi = find(run([{ id: 'made-up.ts:1', model: 'made-up-model', platform: 'provider-api', expectsStructuredOutput: true }], opts), 'structured-output')!;
    expect(onApi.confidence).toBe('likely');
    expect(onApi.detail).not.toContain('may set its own');
    const onVertex = find(run([{ id: 'made-up.ts:1', model: 'made-up-model', platform: 'vertex', expectsStructuredOutput: true }], opts), 'structured-output')!;
    expect(onVertex.confidence).toBe('likely');
    expect(onVertex.detail).toContain("This site runs on Vertex AI: the figure is from Google's own API, and Vertex AI may set its own.");
  });
});
