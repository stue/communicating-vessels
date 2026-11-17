/**
 * 0.4.0 — the provider's word first (R1–R5 of the 2026-11-12 filing).
 * Every test here was run against 0.3.0's source first and seen red.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { renderModelFacts } from '../src/model-facts.js';
import { LEDGER, LEDGER_SOURCES } from '../src/lifecycle-ledger.js';
import { LEDGER_WORDS } from '../src/lifecycle-types.js';
import { resolveId, lookupLedger, catalogProfile } from '../src/lifecycle.js';
import { READ } from './helpers/read.js';

const ex = (sites: Extract['callSites'], models?: Extract['models']): Extract => ({
  project: { name: 't' },
  callSites: sites,
  ...(models ? { models } : {}),
});
const find = (r: ReturnType<typeof runCheck>, s: string) => r.findings.find((f) => f.title.includes(s));
const titles = (r: ReturnType<typeof runCheck>) => r.findings.map((f) => f.title).join('\n');

describe('R1 — the ledger', () => {
  it('every row has a URL, a read date, a page quote and a word from the allowed set; ids are unique', () => {
    expect(LEDGER.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const r of LEDGER) {
      expect(r.url, r.id).toMatch(/^https:\/\//);
      expect(r.readOn, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.quote.length, r.id).toBeGreaterThan(0);
      expect(LEDGER_WORDS, r.id).toContain(r.word);
      expect(['anthropic', 'openai', 'google', 'deepseek'], r.id).toContain(r.provider);
      expect(seen.has(r.id), `duplicate ${r.id}`).toBe(false);
      seen.add(r.id);
    }
  });

  it('every row cites a page that is one of the recorded sources', () => {
    const urls = new Set(LEDGER_SOURCES.map((s) => s.url));
    for (const r of LEDGER) {
      expect(urls.has(r.url), r.id).toBe(true);
      if (r.alsoUrl) expect(urls.has(r.alsoUrl), r.id).toBe(true);
    }
    for (const s of LEDGER_SOURCES) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('all four providers are present', () => {
    const ps = new Set(LEDGER.map((r) => r.provider));
    expect([...ps].sort()).toEqual(['anthropic', 'deepseek', 'google', 'openai']);
  });
});

describe('R2 — the provider word first', () => {
  it('a retired id says retired, by whom, when, and the replacement the page names — certain, with the URL', () => {
    // 0.4.3 (R1): Certain on the pages as read for this release
    const r = runCheck(ex([{ id: 's1', model: 'claude-sonnet-4-20250514', platform: 'provider-api' }]), { pages: READ });
    const f = find(r, 'retired');
    expect(f?.title).toContain("On Anthropic's own API, `claude-sonnet-4-20250514` was retired on 2026-06-15");
    expect(f?.title).toContain('claude-sonnet-5-5');
    expect(f?.confidence).toBe('certain');
    expect(f?.severity).toBe('red');
    expect(f?.basis).toContain('https://platform.claude.com/docs/en/about-claude/model-deprecations.md');
    expect(titles(r)).not.toContain("not in kgauto's");
    expect(r.card).not.toContain('new release');
  });

  it('a catalog id prints the profile providerLifecycle word, never kgauto status', () => {
    // claude-haiku-4-5: kgauto status current, Anthropic's model page Legacy.
    const h = runCheck(ex([{ id: 's1', model: 'claude-haiku-4-5' }]));
    expect(find(h, 'claude-haiku-4-5')?.title).toMatch(/On Anthropic's own API, `claude-haiku-4-5` is Legacy: its model page says so/);
    // gemini-3.6-flash: kgauto status legacy, Google's page active — no lifecycle claim at all.
    const g = runCheck(ex([{ id: 's1', model: 'gemini-3.6-flash' }]));
    expect(titles(g)).not.toMatch(/legacy|deprecated|retired/i);
  });

  it('kgauto routing status is never printed as a fact about the model', () => {
    const r = runCheck(ex([{ id: 's1', model: 'gpt-6-luna' }, { id: 's2', model: 'gemini-3.6-flash' }]));
    expect(r.card).not.toMatch(/is a preview model|is a legacy model/);
  });

  it('"not in the catalog" carries the new-release sentence only when the name sorts above its family', () => {
    const plain = runCheck(ex([{ id: 's1', model: 'mystery-9000' }]));
    expect(titles(plain)).toContain('was not recognised');
    expect(plain.card).not.toMatch(/new release|newer than/);
    const newer = runCheck(ex([{ id: 's1', model: 'claude-opus-9' }]));
    expect(newer.card).toMatch(/sorts above every/);
    const older = runCheck(ex([{ id: 's1', model: 'claude-opus-4-5' }]));
    expect(older.card).not.toMatch(/sorts above every/);
  });
});

describe('R3 — an id as a developer writes it', () => {
  it('strips a provider or gateway prefix and says what it resolved to', () => {
    const r = runCheck(ex([{ id: 's1', model: 'openai/gpt-5' }]));
    const f = find(r, 'openai/gpt-5');
    expect(f?.title).toContain('`openai/gpt-5` (looked up as `gpt-5`)');
    expect(f?.title).toContain("On OpenAI's own API, `openai/gpt-5` (looked up as `gpt-5`) is deprecated");
    expect(f?.title).toContain('2026-12-11');
    const g = runCheck(ex([{ id: 's1', model: 'google/gemini-3-pro-preview' }]));
    expect(find(g, 'gemini-3-pro-preview')?.title).toContain('has been shut down (the earliest shutdown date the page gave was 2026-03-09)');
    const o = runCheck(ex([{ id: 's1', model: 'openrouter/anthropic/claude-sonnet-4-20250514' }]));
    expect(find(o, 'claude-sonnet-4-20250514')?.title).toContain("On Anthropic's own API");
  });

  it('a catalog id behind a prefix reaches the catalog', () => {
    const r = runCheck(ex([{ id: 's1', model: 'anthropic/claude-opus-4-6' }]));
    expect(titles(r)).not.toContain("not in kgauto's");
    expect(resolveId('anthropic/claude-opus-4-6').base).toBe('claude-opus-4-6');
  });

  it('a dated snapshot resolves to the base id when the exact id is unknown', () => {
    expect(catalogProfile('gpt-5.5-2026-04-01').id).toBe('gpt-5.5');
    const r = runCheck(ex([{ id: 's1', model: 'claude-opus-4-6-20260205' }]));
    expect(titles(r)).not.toContain("not in kgauto's");
    expect(r.card).toContain('looked up as `claude-opus-4-6`');
    // a dated id the page lists itself is matched as written
    expect(lookupLedger(resolveId('gpt-4o-mini-2024-07-18')).row?.id).toBe('gpt-4o-mini-2024-07-18');
  });

  it('a Bedrock or Vertex form resolves, and the line drops to likely with the partner-schedule caveat', () => {
    const b = runCheck(ex([{ id: 's1', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }]));
    const fb = find(b, 'claude-sonnet-4-20250514');
    expect(fb?.confidence).toBe('likely');
    expect(fb?.detail).toContain('Amazon Bedrock runs its own schedule');
    const v = runCheck(ex([{ id: 's1', model: 'claude-sonnet-4@20250514' }]));
    expect(find(v, 'claude-sonnet-4')?.confidence).toBe('likely');
  });
});

describe('R4 — nothing false printed as certain', () => {
  it('deepseek-chat says what DeepSeek\'s page says, not "a compat alias silently served"', () => {
    const r = runCheck(ex([{ id: 's1', model: 'deepseek-chat' }]));
    expect(r.card).not.toContain('compat alias');
    expect(r.card).not.toContain('silently serves');
    const f = find(r, 'deepseek-chat');
    expect(f?.title).toContain('legacy');
    expect(f?.title).toContain('2026-07-24');
    expect(f?.basis).toContain('https://api-docs.deepseek.com/updates');
  });

  it('no tool-count line from a kgauto default (DeepSeek 16, gpt-6.1-sol 0)', () => {
    const r = runCheck(
      ex([
        { id: 's1', model: 'deepseek-v4-pro', toolCount: 18 },
        { id: 's2', model: 'gpt-6.1-sol', toolCount: 7 },
      ]),
    );
    expect(titles(r)).not.toMatch(/exceeds .* ceiling/);
  });

  // The parallel-tool-calls tier (R4) is tested on a fixture in engine.test.ts: on the real
  // roster no DeepSeek profile is sequential today, so a real-roster test here was vacuous.
});

describe('R5 — no literal call site still gets a card', () => {
  it('the contract accepts zero call sites with model ids', () => {
    const e = ex([], [{ model: 'gpt-4o', where: 'src/models.ts:12', modelSelection: 'dynamic' }]);
    expect(ExtractSchema.safeParse(e).success).toBe(true);
    const r = runCheck(e);
    expect(r.card).toContain('No call site was found to check a request shape against');
    expect(find(r, 'gpt-4o')?.title).toContain("On OpenAI's own API, `gpt-4o` is deprecated");
    expect(find(r, 'gpt-4o')?.callSites).toEqual(['src/models.ts:12']);
  });

  it('an extract with neither call sites nor model ids gets a card that says there is nothing to check', () => {
    const e = ex([]);
    expect(ExtractSchema.safeParse(e).success).toBe(true);
    const r = runCheck(e);
    expect(r.card).toContain('nothing to check');
  });
});

describe('--model-facts', () => {
  it('a retired id prints retired with the page beside it', () => {
    const t = renderModelFacts('claude-sonnet-4-20250514');
    expect(t).toContain('retired');
    expect(t).toContain('https://platform.claude.com/docs/en/about-claude/model-deprecations.md');
    expect(t).not.toContain("not in kgauto's verified catalog");
  });

  it('a catalog id does not print a kgauto tool default as the model\'s limit', () => {
    const t = renderModelFacts('gpt-6.1-sol');
    expect(t).not.toMatch(/· 0 tools/);
  });
});
