/**
 * Amendment B of the 2026-11-12 filing (the cold read on 40d8b42).
 * Every test here was run against 40d8b42's source first and seen red.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { renderModelFacts } from '../src/model-facts.js';
import { resolveId } from '../src/lifecycle.js';

const ex = (sites: Extract['callSites'], models?: Extract['models']): Extract => ({
  project: { name: 't' },
  callSites: sites,
  ...(models ? { models } : {}),
});
const find = (r: ReturnType<typeof runCheck>, s: string) => r.findings.find((f) => f.title.includes(s));

describe('B1 — a partner platform site never gets a certain provider-page line', () => {
  it('a Vertex site (named by its path) is likely, says the provider API and the partner schedule, links both pages', () => {
    const r = runCheck(ex([{ id: 'made-up/llms/GoogleVertexChat.ts:108', model: 'gemini-2.5-flash' }]));
    const f = find(r, 'gemini-2.5-flash');
    expect(f?.confidence).toBe('likely');
    expect(f?.title).toMatch(/^On Google's own API/);
    expect(f?.detail).toMatch(/Vertex AI runs its own schedule/);
    expect(f?.basis).toContain('https://aistudio.google.com/docs/deprecations');
    expect(f?.basis).toContain('cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions');
  });

  it('an Azure site named only in its notes is likely, with the Azure page', () => {
    const r = runCheck(ex([{ id: 'made-up/vision.ts:12', model: 'gpt-4o', notes: 'Azure OpenAI deployment name = model setting' }]));
    const f = find(r, 'gpt-4o');
    expect(f?.confidence).toBe('likely');
    expect(f?.basis).toContain('learn.microsoft.com');
  });

  it('the contract carries a platform field, and it decides the tier', () => {
    const e = ex([{ id: 'a.ts:1', model: 'gemini-2.5-flash', platform: 'vertex' }]);
    expect(ExtractSchema.safeParse(e).success).toBe(true);
    expect(find(runCheck(e), 'gemini-2.5-flash')?.confidence).toBe('likely');
    const p = ex([{ id: 'b.ts:1', model: 'gemini-2.5-flash', platform: 'provider-api' }]);
    expect(find(runCheck(p), 'gemini-2.5-flash')?.confidence).toBe('certain');
  });

  it('the same id on the provider API and on a partner gives one certain and one likely line', () => {
    const r = runCheck(
      ex([
        { id: 'direct.ts:1', model: 'gemini-2.5-flash', platform: 'provider-api' },
        { id: 'vertex/client.ts:1', model: 'gemini-2.5-flash' },
      ]),
    );
    const lines = r.findings.filter((f) => f.title.includes('gemini-2.5-flash'));
    expect(lines.map((f) => f.confidence).sort()).toEqual(['certain', 'likely']);
  });
});

describe('B2 — the documented prefixes resolve; a partner prefix marks the site', () => {
  it('LiteLLM gemini/, the Google SDK models/, a LiteLLM partner prefix and a Bedrock route', () => {
    expect(resolveId('gemini/gemini-2.5-pro').base).toBe('gemini-2.5-pro');
    expect(resolveId('models/gemini-3-flash-preview').base).toBe('gemini-3-flash-preview');
    expect(resolveId('vertex_ai/gemini-2.5-pro')).toMatchObject({ base: 'gemini-2.5-pro', partner: 'vertex' });
    expect(resolveId('azure/gpt-4o')).toMatchObject({ base: 'gpt-4o', partner: 'azure' });
    expect(resolveId('bedrock/converse/anthropic.claude-sonnet-4-20250514-v1:0')).toMatchObject({
      base: 'claude-sonnet-4-20250514',
      partner: 'bedrock',
    });
    expect(resolveId('deepseek/deepseek-chat').base).toBe('deepseek-chat');
  });

  it('--model-facts gemini/gemini-2.5-pro names Google\'s word, not "no page lists it"', () => {
    const t = renderModelFacts('gemini/gemini-2.5-pro');
    expect(t).toMatch(/\*\*deprecated\*\*/);
    expect(t).not.toMatch(/lists it as/);
  });

  it('an id that cannot be resolved is "not recognised", never "no page lists it"', () => {
    const r = runCheck(ex([{ id: 's', model: 'someprovider/mystery-9000' }]));
    expect(r.card).toMatch(/not recognised/);
    expect(r.card).not.toMatch(/lists it as|none of the deprecation pages/i);
    expect(renderModelFacts('mystery-9000')).not.toMatch(/lists it as/);
  });
});

describe('B3/B4 and objection 1 — the ledger', () => {
  it('a row with only a scheduled shutdown date enters as "scheduled for shutdown"', () => {
    const r = runCheck(ex([{ id: 's', model: 'gemini-3.1-flash-tts-preview' }]));
    // 0.4.2: Google's page of 2026-11-14 moved this date from November 17 to December 18, 2026.
    expect(find(r, 'gemini-3.1-flash-tts-preview')?.title).toContain("On Google's own API, `gemini-3.1-flash-tts-preview` is scheduled for shutdown not before 2026-12-18");
  });

  it('a quoted definition cites the page it stands on', () => {
    // gemini-1.5-flash's row comes from the release notes; the "completely turned off" sentence is on the deprecations page.
    const f = find(runCheck(ex([{ id: 's', model: 'gemini-1.5-flash' }])), 'gemini-1.5-flash');
    expect(f?.detail).toMatch(/completely turned off/);
    expect(f?.detail).toContain('https://aistudio.google.com/docs/deprecations');
  });
});

describe('B6 — the card speaks to a stranger', () => {
  const card = runCheck(
    ex(
      [
        { id: 's1', model: 'claude-sonnet-4-20250514', retry: 'none' },
        { id: 's2', model: 'gemini-3.8-flash', retry: 'none', estInputTokens: 1000, estOutputTokens: 100, archetype: 'summarize' },
        { id: 's3', model: 'mystery-9000' },
      ],
      [{ model: 'gpt-4o', where: 'm.ts:1' }],
    ),
  );
  it('the title is the name; kgauto appears only as a literal package name', () => {
    expect(card.card.startsWith('# Communicating Vessels — the check')).toBe(true);
    const withoutPackage = card.card.replaceAll('@warmdrift/kgauto-check', '').replaceAll('@warmdrift/kgauto-compiler', '');
    expect(withoutPackage).not.toMatch(/kgauto/i);
    expect(card.card).not.toMatch(/lifecycle ledger|has no profile|request checks skip/);
  });

  it('the no-fallback line is likely, says what was read, and has no outage sermon', () => {
    const f = card.findings.find((x) => /no second model/i.test(x.title));
    expect(f?.confidence).toBe('likely');
    expect(f?.detail).not.toMatch(/routine/);
  });
});
