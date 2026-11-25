/**
 * The check 0.4.6 (filing 2026-11-24): R1 (DeepSeek's first-call page is read at the address that serves it) and R2 (the
 * ledger re-read on 2026-11-24). The other rulings have their own files: R4 the smoke, R5 the drift check
 * (ledger-drift.test.ts), R6 the table sweep (check-046-sweep.test.ts), R7–R9 check-046-words.test.ts. No test here makes a
 * network request: the pages are the read record of this release (tests/helpers/read.ts), a read switched off as
 * `--offline` switches it, or a fetch seam built in the test. Each behaviour was seen red on 0.4.5's code (main c3a03df)
 * before it was built; the filing's foot carries those runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, type Finding } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import { LEDGER, LEDGER_SOURCES } from '../src/lifecycle-ledger.js';
import { lookupLedger, resolveId } from '../src/lifecycle.js';
import { noRequestRead, readPagesFromNetwork, REQUEST_URLS } from '../src/pages.js';
import { PAGE_URL } from '../src/ledger-check.mjs';
import { READ } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const ROOT_URL = 'https://api-docs.deepseek.com/';
const OLD_URL = 'https://api-docs.deepseek.com/news';
const OFFLINE = noRequestRead();
const TODAY = '2026-11-24';

const ex = (ids: string[]): Extract =>
  ExtractSchema.parse({
    project: { name: 't' },
    callSites: [],
    models: ids.map((model, i) => ({ model, where: `src/${i}.py:1`, platform: 'provider-api', context: 'runs' })),
  });
const about = (fs: Finding[], id: string) => fs.filter((f) => f.title.includes(`\`${id}\``));

// ── R1 ────────────────────────────────────────────────────────────────────
describe('R1 — DeepSeek’s “Your First API Call” page is read at the address that serves it', () => {
  it('the address is the docs’ root, in the request list, the source list and both rows that quote the page', () => {
    expect(PAGE_URL.deepseekFirstApiCall).toBe(ROOT_URL);
    expect(REQUEST_URLS).toContain(ROOT_URL);
    expect(REQUEST_URLS).not.toContain(OLD_URL);
    expect(LEDGER_SOURCES.find((s) => s.title === 'Your First API Call | DeepSeek API Docs')?.url).toBe(ROOT_URL);
    expect(LEDGER.filter((r) => r.alsoUrl === ROOT_URL).map((r) => r.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
    expect(LEDGER.filter((r) => JSON.stringify(r).includes(OLD_URL))).toEqual([]);
  });

  it('a run where the root serves the page and /news answers 404 reads the page, and never asks /news', async () => {
    const page = readFileSync(join(MIN, 'deepseek-first-api-call.html'), 'utf8');
    const asked: string[] = [];
    const seam = (async (u: string) => {
      asked.push(String(u));
      return String(u) === ROOT_URL ? new Response(page, { status: 200 }) : new Response('Page Not Found', { status: 404 });
    }) as unknown as typeof fetch;
    const read = await readPagesFromNetwork({ fetchImpl: seam });
    const p = read.pages.find((x) => x.file === 'deepseek-first-api-call.html')!;
    expect(p.url).toBe(ROOT_URL);
    expect(p.ok).toBe(true);
    expect(asked).not.toContain(OLD_URL);
  });

  it('the README’s list of pages says the address read', () => {
    const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
    expect(readme).toContain('`https://api-docs.deepseek.com/`');
    expect(readme).not.toContain('deepseek.com/news');
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────
describe('R2 — the ledger as read on 2026-11-24', () => {
  // 0.4.7 (Amendment A10): the ledger re-read on 2026-11-25 (until 0.4.7: 2026-11-24); the rows this file pins did not move
  it('every page the ledger rests on was read on 2026-11-25', () => {
    expect([...new Set(LEDGER_SOURCES.map((s) => s.readAt.slice(0, 10)))]).toEqual(['2026-11-25']);
  });

  it('`claude-opus-4-5-20251101` is deprecated, with the shutdown date and the replacement Anthropic’s page names', () => {
    const r = LEDGER.find((x) => x.id === 'claude-opus-4-5-20251101')!;
    expect(r).toMatchObject({ provider: 'anthropic', word: 'deprecated', pageWord: 'Deprecated', announced: '2026-11-23', shutdown: '2027-01-22', dateText: 'January 22, 2027', replacement: 'claude-opus-5-5' });
    expect(r.shutdownFloor).toBeUndefined();
    expect(r.quote).toBe('| claude-opus-4-5-20251101 | Deprecated | November 23, 2026 | January 22, 2027 |');
  });

  it('its card line says deprecated and the date, read in this run (Certain) and offline (Likely)', () => {
    for (const [pages, tier] of [[READ, 'certain'], [OFFLINE, 'likely']] as const) {
      const [f, ...rest] = about(runCheck(ex(['claude-opus-4-5-20251101']), { pages, today: TODAY }).findings, 'claude-opus-4-5-20251101');
      expect(rest).toEqual([]);
      expect(f!.title).toBe("On Anthropic's own API, `claude-opus-4-5-20251101` is deprecated and shuts down on 2027-01-22; its page names `claude-opus-5-5`");
      expect(f!.severity).toBe('yellow');
      expect(f!.confidence).toBe(tier);
    }
  });

  it('the header counts it as flagged by Anthropic, beside an Active id (never “No provider flags any of them”)', () => {
    const c = runCheck(ex(['claude-opus-4-5-20251101', 'claude-opus-5-5']), { pages: OFFLINE, today: TODAY }).card;
    expect(c.split('\n')[2]).toBe(
      '0 AI call sites and 2 model ids: `claude-opus-4-5-20251101`, `claude-opus-5-5`. 1 is flagged by Anthropic. The flagged id is in code that runs.',
    );
    expect(c).not.toContain('No provider flags any of them');
  });

  it('`genie-4` is the row, in the page’s own spelling; `models/genie-4` still reaches it', () => {
    expect(LEDGER.find((r) => r.id === 'genie-4')).toMatchObject({ provider: 'google', word: 'listed', section: 'Genie models' });
    expect(LEDGER.find((r) => r.id === 'genie-4')!.quote).toContain('[`genie-4`](/docs/models/genie-4)');
    expect(LEDGER.find((r) => r.id === 'models/genie-4')).toBeUndefined();
    for (const id of ['genie-4', 'models/genie-4']) expect(lookupLedger(resolveId(id)).row?.id, id).toBe('genie-4');
  });

  it('`genie-4` and `models/genie-4` print the same lifecycle sentence, read in this run, with nothing changed since', () => {
    const fs = runCheck(ex(['genie-4', 'models/genie-4']), { pages: READ, today: TODAY }).findings.filter((f) => /genie-4/.test(f.title));
    expect(fs).toHaveLength(2);
    const [bare, prefixed] = fs;
    expect(prefixed!.title.replace('`models/genie-4` (looked up as `genie-4`)', '`genie-4`')).toBe(bare!.title);
    expect(prefixed!.detail).toBe(bare!.detail);
    for (const f of fs) {
      expect(f.confidence).toBe('certain');
      expect(f.title).not.toContain('the page has changed since');
    }
  });
});
