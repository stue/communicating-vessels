/**
 * The check 0.4.6 (filing 2026-11-24): R7 (`--model-facts` prints nothing written for our own records, and its second
 * page says when it was read), R8 (the header has one order) and R9 (an id is matched without regard to case before it
 * is called "not recognised"). No test here makes a network request: the pages are the read record of this release
 * (tests/helpers/read.ts), with one page's outcome replaced, or a read switched off. Each behaviour was seen red on
 * 0.4.5's code (main c3a03df) before it was built; the filing's foot carries those runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allProfiles } from '@warmdrift/kgauto-compiler';
import { runCheck } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { renderModelFacts } from '../src/model-facts.js';
import { fromRecord, noRequestRead, type PageRead } from '../src/pages.js';
import { READ, RECORD } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE = noRequestRead();
const ROOT_URL = 'https://api-docs.deepseek.com/';
/** The release's record with one page's outcome replaced. */
const withPage = (url: string, reason: string): PageRead =>
  fromRecord({ ...RECORD, changedRows: [], changedDefinitions: [], pages: RECORD.pages.map((p) => (p.url === url ? { url, file: p.file, ok: false as const, reason } : p)) });
const ex = (models: { model: string; context?: 'runs' | 'test' | 'docs' | 'example' }[]): Extract =>
  ExtractSchema.parse({ project: { name: 't' }, callSites: [], models: models.map((m, i) => ({ where: `src/${i}.py:1`, platform: 'provider-api', ...m })) });

// ── R7 ────────────────────────────────────────────────────────────────────
describe('R7 — `--model-facts` prints nothing written for our own records', () => {
  const OURS = /archetypePerf|brain-validated|release watcher|JUDGMENT|brain rows/;
  it('the Verifier’s two ids: no catalog note, none of our words (V9)', () => {
    for (const id of ['deepseek-v4-flash', 'claude-opus-5-5']) {
      const t = renderModelFacts(id, { pages: OFFLINE, today: '2026-11-24' });
      expect(t, id).not.toMatch(OURS);
      expect(t, id).not.toMatch(/^- notes:/m);
    }
  });
  it('no catalog entry’s notes are printed, for any id in the catalog', () => {
    for (const p of allProfiles()) {
      const t = renderModelFacts(p.id, { pages: OFFLINE, today: '2026-11-24' });
      expect(t, p.id).not.toMatch(/^- notes:/m);
      if (p.notes) expect(t, p.id).not.toContain(p.notes);
    }
  });
  it('a probed limit is printed from its fields: the point, the outcome, the trials, the day, the route — not its sentence or run number', () => {
    for (const p of allProfiles().filter((x) => (x.probedLimits ?? []).length > 0)) {
      const t = renderModelFacts(p.id, { pages: OFFLINE, today: '2026-11-24' });
      for (const l of p.probedLimits!) {
        expect(t, p.id).not.toContain(l.claim);
        expect(t, p.id).toContain(`@ ${l.testedAt.toLocaleString()} → **${l.outcome}** (${l.trials} ${l.trials === 1 ? 'trial' : 'trials'}, last run ${l.lastProbed}`);
      }
      expect(t, p.id).not.toMatch(/\(run \d+\)/);
    }
    expect(renderModelFacts('deepseek-flash', { pages: OFFLINE })).toContain("  - thinking with short output @ 16 → **broke** (2 trials, last run 2026-09-10, on the provider's own API)");
    expect(renderModelFacts('glm-5.2', { pages: OFFLINE })).toContain('  - tool count @ 6 → **held** (3 trials, last run 2026-08-29, through OpenRouter, served by baidu)');
  });
});

describe('R7 — the `also:` line says when its page was read, as the source line does', () => {
  const also = (t: string) => t.split('\n').find((l) => l.startsWith('- also: '))!;
  it('its page did not answer: the same not-read clause as the source line, with the status', () => {
    const t = renderModelFacts('deepseek-v4-flash', { pages: withPage(ROOT_URL, 'HTTP 404'), today: '2026-11-26' }); // 0.4.7: a day after the re-read (until 0.4.7: 2026-11-25)
    // 0.4.7: the ledger re-read on 2026-11-25 (until 0.4.7: 2026-11-24)
    expect(also(t)).toMatch(/^- also: https:\/\/api-docs\.deepseek\.com\/ \(read 2026-11-25, 1 day before this lookup; not read in this run \(HTTP 404\)\) — “The legacy names/);
    expect(t).toContain("DeepSeek's “Your First API Call” page not read in this run (HTTP 404), as read 2026-11-25, 1 day before this lookup)");
  });
  it('offline: the clause names the switch; read in this run: the time it was read', () => {
    // 0.4.7: the ledger re-read on 2026-11-25 at 09:06 UTC (until 0.4.7: 2026-11-24 09:37)
    expect(also(renderModelFacts('deepseek-v4-flash', { pages: OFFLINE, today: '2026-11-25' }))).toContain('(read 2026-11-25, the day of this lookup; not read in this run (--offline))');
    expect(also(renderModelFacts('deepseek-v4-flash', { pages: READ, today: '2026-11-25' }))).toContain('(read in this run, 2026-11-25 09:06 UTC)');
  });
});

// ── R8 ────────────────────────────────────────────────────────────────────
describe('R8 — the header has one order', () => {
  it('one constant in the engine’s source (V10)', () => {
    const src = readFileSync(join(PKG, 'src/engine.ts'), 'utf8');
    expect(src).toContain('CONTEXT_ORDER');
    expect(src).not.toContain('HEADER_ORDER');
  });
  it('the reader’s four-id extract: the counts are listed in the order its rule sentence names', () => {
    const e = ex([
      { model: 'claude-sonnet-4-5', context: 'test' },
      { model: 'claude-sonnet-4-5', context: 'docs' },
      { model: 'deepseek-chat', context: 'docs' },
      { model: 'deepseek-reasoner', context: 'example' },
      { model: 'gpt-3.5-turbo-0125' },
    ]);
    const head = runCheck(e, { pages: READ, today: '2026-11-24' }).card.split('\n')[2]!;
    expect(head).toContain(
      'Of the 4 flagged ids, 1 is where the extract does not say, 1 in tests, 1 in examples and 1 in docs. 1 of them is written in more than one kind of place, and is counted once, under the first that applies in this order: code that runs, where the extract does not say, tests, examples, docs.',
    );
    const rule = /in this order: (.*)\.$/.exec(head)![1]!.split(', ');
    const counts = /Of the 4 flagged ids, (.*?)\. 1 of them/.exec(head)![1]!;
    const placeOf = (part: string) => rule.findIndex((r) => part.endsWith(r) || (r === 'where the extract does not say' && part.includes(r)));
    const order = counts.split(/, | and /).map(placeOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});

// ── R9 ────────────────────────────────────────────────────────────────────
describe('R9 — an id is matched without regard to case before it is called not recognised', () => {
  it('`GPT-4o` prints the line `gpt-4o` prints, under the same heading', () => {
    for (const pages of [READ, OFFLINE]) {
      const lower = runCheck(ex([{ model: 'gpt-4o', context: 'runs' }]), { pages, today: '2026-11-24' }).findings.filter((f) => f.confidence !== 'measurable-only');
      const upper = runCheck(ex([{ model: 'GPT-4o', context: 'runs' }]), { pages, today: '2026-11-24' }).findings.filter((f) => f.confidence !== 'measurable-only');
      expect(upper.length).toBe(lower.length);
      upper.forEach((u, i) => {
        expect(u.title.replace('`GPT-4o` (looked up as `gpt-4o`)', '`gpt-4o`')).toBe(lower[i]!.title);
        expect(u.detail).toBe(lower[i]!.detail);
        expect([u.confidence, u.severity]).toEqual([lower[i]!.confidence, lower[i]!.severity]);
      });
    }
  });
  it('the header names it as written, with the id it was read as, and does not call it not recognised (V8)', () => {
    const c = runCheck(ex([{ model: 'GPT-4o', context: 'runs' }]), { pages: OFFLINE, today: '2026-11-24' }).card;
    expect(c.split('\n')[2]).toBe('0 AI call sites and 1 model id: `GPT-4o` (looked up as `gpt-4o`). 1 is flagged by OpenAI. The flagged id is in code that runs.');
    expect(c).not.toContain('was not recognised');
  });
  // Amendment B3: the note says what happened (until fix pass 1: "(looked up as `gpt-4o`: wrote the id in lower case)",
  // which read as if the reader wrote it)
  it('`--model-facts` says the id was looked up in the lower-case form of the id as written', () => {
    expect(renderModelFacts('GPT-4o', { pages: OFFLINE }).split('\n')[0]).toBe('# GPT-4o (looked up as `gpt-4o`, the lower-case form of the id as written)');
  });
  it('an id known in no case is still not recognised, as written', () => {
    const c = runCheck(ex([{ model: 'NOT-A-Model-9', context: 'runs' }]), { pages: OFFLINE, today: '2026-11-24' }).card;
    expect(c).toContain('- ℹ️ **`NOT-A-Model-9` was not recognised**');
  });
  it('a dated snapshot and a provider prefix in capitals reach their rows too', () => {
    for (const id of ['CLAUDE-OPUS-4-5-20251101', 'OpenAI/GPT-4o', 'Gemini-2.5-Flash']) {
      const c = runCheck(ex([{ model: id, context: 'runs' }]), { pages: OFFLINE, today: '2026-11-24' }).card;
      expect(c, id).not.toContain('was not recognised');
    }
  });
});
