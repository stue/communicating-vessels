/**
 * Amendment C of the 2026-11-12 filing (the second cold read on c36ba96).
 * Every test here was run against c36ba96's source first and seen red.
 * The hand-made cases are the second reader's.
 */
import { describe, it, expect } from 'vitest';
import { runCheck, type Finding } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { renderModelFacts } from '../src/model-facts.js';
import { oneRowIn } from '../scripts/ledger-check.mjs';

type Site = Extract['callSites'][number];
const run = (sites: Site[]) => runCheck({ project: { name: 't' }, callSites: sites });
const LIFE = /own API|retired|shut down|deprecated|legacy|Legacy|scheduled for shutdown|routes requests/;
const lifecycle = (r: ReturnType<typeof run>): Finding[] => r.findings.filter((f) => LIFE.test(f.title));

describe('C1 — a lifecycle line says whose API its fact is about; certain only on a stated provider API', () => {
  const SDK_NOTES = [
    'imports google.cloud.aiplatform and calls GenerativeModel',
    "imports @google-cloud/aiplatform's PredictionServiceClient",
    'client built with a project and a location (us-central1)',
    'POSTs to us-central1-aiplatform.googleapis.com',
  ];
  for (const notes of SDK_NOTES) {
    it(`gemini-2.5-flash, platform unstated, notes: ${notes}`, () => {
      const ls = lifecycle(run([{ id: 'app/llm.py:10', model: 'gemini-2.5-flash', notes }]));
      expect(ls.length).toBe(1);
      expect(ls[0]!.confidence).toBe('likely');
      expect(ls[0]!.title.startsWith("On Google's own API, `gemini-2.5-flash`")).toBe(true);
      expect(ls[0]!.detail).toMatch(/Vertex AI runs its own schedule/);
    });
    it(`gemini-2.5-flash, platform: provider-api contradicted by notes: ${notes}`, () => {
      const ls = lifecycle(run([{ id: 'app/llm.py:10', model: 'gemini-2.5-flash', platform: 'provider-api', notes }]));
      expect(ls[0]!.confidence).toBe('likely');
      expect(ls[0]!.detail).toMatch(/disagree/);
    });
  }

  it('a stated provider API with nothing against it is certain, and the sentence names the API', () => {
    const ls = lifecycle(run([{ id: 'a.ts:1', model: 'gemini-2.5-flash', platform: 'provider-api' }]));
    expect(ls[0]!.confidence).toBe('certain');
    expect(ls[0]!.title.startsWith("On Google's own API, `gemini-2.5-flash` is deprecated")).toBe(true);
  });

  it('an unstated platform with no partner sign is likely and carries the one clause', () => {
    const ls = lifecycle(run([{ id: 'a.ts:1', model: 'claude-sonnet-4-20250514' }]));
    expect(ls[0]!.confidence).toBe('likely');
    expect(ls[0]!.detail).toMatch(/If this call goes through a cloud platform \(Vertex, Bedrock, Azure, a gateway\), that platform may keep its own schedule/);
  });

  it('gpt-4o with platform: other is likely with the clause', () => {
    const ls = lifecycle(run([{ id: 'a.ts:1', model: 'gpt-4o', platform: 'other' }]));
    expect(ls[0]!.confidence).toBe('likely');
    expect(ls[0]!.title.startsWith("On OpenAI's own API, `gpt-4o`")).toBe(true);
    expect(ls[0]!.detail).toMatch(/may keep its own schedule/);
  });
});

describe('C2 — a partner-only id form outranks a stated provider API', () => {
  for (const model of ['vertex_ai/gemini-2.5-flash', 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0', 'claude-sonnet-4-5@20250929']) {
    it(`${model} with platform: provider-api`, () => {
      const ls = lifecycle(run([{ id: 'a.ts:1', model, platform: 'provider-api' }]));
      expect(ls.length).toBe(1);
      expect(ls[0]!.confidence).toBe('likely');
      expect(ls[0]!.detail).toMatch(/runs its own schedule/);
      expect(ls[0]!.detail).toMatch(/disagree/);
    });
  }
});

describe('C3 — lines merge only when they agree on the partner', () => {
  it('a Bedrock site and a Vertex site holding the same id give two lines', () => {
    const r = run([
      { id: 'aws.ts:1', model: 'claude-sonnet-4-20250514', notes: 'Amazon Bedrock runtime client' },
      { id: 'gcp.ts:1', model: 'claude-sonnet-4-20250514', notes: 'Vertex AI AnthropicVertex client' },
    ]);
    const ls = lifecycle(r);
    expect(ls.length).toBe(2);
    expect(ls.every((f) => f.confidence === 'likely')).toBe(true);
    expect(ls.find((f) => f.callSites.includes('aws.ts:1'))?.detail).toMatch(/Amazon Bedrock/);
    expect(ls.find((f) => f.callSites.includes('gcp.ts:1'))?.detail).toMatch(/Vertex AI/);
  });
});

describe('C4 — no partner sentence where the provider page covers the platform', () => {
  it('a Claude id on Azure (Microsoft Foundry) carries Anthropic\'s dates without "runs its own schedule"', () => {
    const ls = lifecycle(run([{ id: 'foundry.ts:1', model: 'claude-sonnet-4-20250514', platform: 'azure' }]));
    expect(ls[0]!.detail).not.toMatch(/runs its own schedule/);
    expect(ls[0]!.detail).toMatch(/Microsoft Foundry/);
  });
});

describe('C5 — a Google earliest-possible date reads "not before"', () => {
  it('a scheduled shutdown from the deprecations table', () => {
    const ls = lifecycle(run([{ id: 'a.ts:1', model: 'gemini-3.1-flash-tts-preview', platform: 'provider-api' }]));
    // 0.4.2: Google's page of 2026-11-14 moved this date from November 17 to December 18, 2026.
    expect(ls[0]!.title).toContain('scheduled for shutdown not before 2026-12-18');
  });
});

describe('C6 — no kgauto in the cliff line', () => {
  it('a cliff line fires and says nothing of kgauto', () => {
    const r = run([{ id: 'a.ts:1', model: 'gpt-5.5', platform: 'provider-api', maxInputTokens: 300_000, estInputTokens: 300_000, estOutputTokens: 100 }]);
    const cliff = r.findings.find((f) => f.title.includes('cliff'));
    expect(cliff).toBeDefined();
    expect(r.card.replaceAll('@warmdrift/kgauto-check', '').replaceAll('@warmdrift/kgauto-compiler', '')).not.toMatch(/kgauto/i);
  });
});

describe('C7 — corrections', () => {
  it('--model-facts on an unresolved id says it was not recognised', () => {
    const t = renderModelFacts('someprovider/mystery-9000');
    expect(t).toMatch(/was not recognised/);
    expect(t).not.toMatch(/lists it as/);
  });

  it('the ledger generator refuses a row stitched from two page rows', () => {
    const rows = ['`gemini-a` | May 1, 2026 | June 1, 2026 | `gemini-b`', '`gemini-c` | May 2, 2026 | July 1, 2026 | `gemini-d`'];
    expect(oneRowIn(rows, ['`gemini-a`', 'May 1, 2026', 'June 1, 2026', '`gemini-b`'])).toBe(true);
    expect(oneRowIn(rows, ['`gemini-a`', 'May 1, 2026', 'July 1, 2026', '`gemini-d`'])).toBe(false);
  });
});
