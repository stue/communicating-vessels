/**
 * The check 0.4.3 (filing 2026-11-16, rulings R1–R9, Amendment A). No test here makes a network
 * request: a page read goes through the `fetchImpl` seam serving the made-up page set in
 * tests/fixtures/pages-min/ (or a status), a share goes through the `shareFetch` seam, and the
 * drift script's --fetch through its KGAUTO_LEDGER_DRIFT_FETCH_FROM seam. Each behaviour was seen red
 * once with its change reverted (the filing's foot names how).
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCheck, DESTINATION_SENTENCE } from '../src/engine.js';
import { ExtractSchema, type Extract } from '../src/extract.js';
import {
  readPagesFromNetwork,
  readPagesFromDir,
  readForRun,
  resolveRead,
  requestUrls,
  REQUEST_URLS,
  NOT_THE_PAGE,
  PAGE_TIMEOUT_MS,
  type LedgerSet,
  type PageRead,
} from '../src/pages.js';
import { pageFileOf, PAGE_SHAPES, pageShapeMisses, pageTextOf } from '../src/ledger-check.mjs';
import { LEDGER, LEDGER_SOURCES } from '../src/lifecycle-ledger.js';
import { buildServer } from '../src/server.js';
import { renderModelFacts } from '../src/model-facts.js';
import { SHARE_STORED_SENTENCE } from '../src/share.js';
import { CHECK_VERSION } from '../src/version.js';
import { READ } from './helpers/read.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const DRIFT = join(PKG, 'scripts/ledger-drift.mjs');
// Amendment B3: every folder a test makes — its own, or the drift script's under --fetch (TMPDIR points the
// script's mkdtemp here) — is inside ROOT, which is removed when the file is done.
const ROOT = mkdtempSync(join(tmpdir(), 'check-043-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const tmp = (p: string) => mkdtempSync(join(ROOT, p));

/** A page set copied to a temp dir, with an edit applied to one file. */
function pagesWith(edit?: { file: string; from: string | RegExp; to: string }): string {
  const d = tmp('pages-043-');
  cpSync(MIN, d, { recursive: true });
  if (edit) {
    const f = join(d, edit.file);
    const before = readFileSync(f, 'utf8');
    const after = before.replace(edit.from, edit.to);
    if (after === before) throw new Error(`the edit did not apply to ${edit.file}`);
    writeFileSync(f, after);
  }
  return d;
}

/** The generator's ledger for a page set, as a LedgerSet (parsed as ledger-drift.mjs parses it). */
function ledgerOf(pagesDir: string): { set: LedgerSet; file: string } {
  const file = join(tmp('ledger-043-'), 'lifecycle-ledger.ts');
  const r = spawnSync(process.execPath, [GEN, '--pages', pagesDir, '--out', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`generator failed: ${r.stderr}`);
  const text = readFileSync(file, 'utf8');
  const block = (name: string) => JSON.parse(new RegExp(`export const ${name}: readonly \\w+\\[\\] = (\\[[\\s\\S]*?\\n\\]);`).exec(text)![1]!);
  const sources = block('LEDGER_SOURCES');
  const definitions = block('LEDGER_DEFINITIONS');
  return { set: { rows: block('LEDGER'), definitions, urls: requestUrls(sources, definitions) }, file };
}
const MIN_LEDGER = ledgerOf(MIN);

/** A fetch seam that serves a page set by URL (the generator's file names), recording each request. */
function serve(dir: string, calls: { url: string; init: RequestInit | undefined }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const f = pageFileOf(url);
    if (!f || !existsSync(join(dir, f))) return new Response('not found', { status: 404 });
    return new Response(readFileSync(join(dir, f), 'utf8'), { status: 200 });
  }) as typeof fetch;
}
const status = (code: number) => (async () => new Response('x', { status: code })) as unknown as typeof fetch;

const ex = (models: { model: string; where?: string; context?: 'runs' | 'test' | 'docs' | 'example' }[], name = 't'): Extract => ({
  project: { name },
  callSites: [],
  models: models.map((m, i) => ({ where: `f${i}.py:1`, platform: 'provider-api' as const, ...m })),
});
const lineOf = (r: ReturnType<typeof runCheck>, id: string) => r.findings.find((f) => f.title.includes(`\`${id}\``));

afterEach(() => {
  vi.useRealTimers();
});

// ── R1 ────────────────────────────────────────────────────────────────────
describe('R1 — a provider line is Certain only when its page was read in this run and still carries it', () => {
  it('every row of the made-up ledger is confirmed on the pages it was built from (one read, no retry, one request per URL)', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const read = await readPagesFromNetwork({ fetchImpl: serve(MIN, calls), ledger: MIN_LEDGER.set });
    expect(calls.map((c) => c.url).sort()).toEqual([...MIN_LEDGER.set.urls].sort());
    expect([...read.rows.values()].every((s) => s.state === 'confirmed')).toBe(true);
    expect(read.rows.size).toBe(19); // 0.4.5 (R3): the made-up page's Active row is a row (until 0.4.5: 18)
  });

  it('the request: plain GET, redirects followed, no cookie, no body, no query string, User-Agent kgauto-check/<version>', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    await readPagesFromNetwork({ fetchImpl: serve(MIN, calls), ledger: MIN_LEDGER.set });
    for (const c of calls) {
      expect(c.init?.method).toBe('GET');
      expect(c.init?.redirect).toBe('follow');
      expect(c.init?.credentials).toBe('omit');
      expect(c.init?.body).toBeUndefined();
      expect(new URL(c.url).search).toBe('');
      expect(c.init?.headers).toEqual({ 'user-agent': `kgauto-check/${CHECK_VERSION}` });
    }
  });

  it('the request set says nothing about the project: two extracts with no id in common make the same requests (through the server)', async () => {
    const lists: string[][] = [];
    for (const models of [['gpt-4o', 'claude-opus-4-1'], ['gemini-pro', 'deepseek-chat', 'not-a-model']]) {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const client = await connect({ pageFetch: serve(MIN, calls) });
      await client.callTool({ name: 'run_check', arguments: { extract: ex(models.map((model) => ({ model }))) } });
      lists.push(calls.map((c) => `${c.init?.method} ${c.url} ${JSON.stringify(c.init?.headers)} ${String(c.init?.body)}`).sort());
    }
    expect(lists[0]).toEqual(lists[1]);
    expect(lists[0]).toHaveLength(REQUEST_URLS.length);
    expect(REQUEST_URLS).toHaveLength(10);
    expect([...REQUEST_URLS].sort()).toEqual([...new Set(LEDGER_SOURCES.map((s) => s.url))].sort());
  });

  it('8 s a page, no retry: a page that never answers is unread (timed out) at 8000 ms and not before', async () => {
    vi.useFakeTimers();
    let n = 0;
    const hang = ((_u: string, init?: RequestInit) => {
      n++;
      return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }) as unknown as typeof fetch;
    let done: PageRead | undefined;
    const p = readPagesFromNetwork({ fetchImpl: hang, ledger: MIN_LEDGER.set }).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(PAGE_TIMEOUT_MS).toBe(8000);
    expect(n).toBe(MIN_LEDGER.set.urls.length);
    expect(done!.pages.every((x) => !x.ok && x.reason === 'timed out')).toBe(true);
  });

  it('unread, with the reason in words: HTTP 503, no network', async () => {
    const r503 = await readPagesFromNetwork({ fetchImpl: status(503), ledger: MIN_LEDGER.set });
    expect([...r503.rows.values()].every((s) => s.state === 'unread' && s.reason === 'HTTP 503')).toBe(true);
    const offNet = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const rNo = await readPagesFromNetwork({ fetchImpl: offNet, ledger: MIN_LEDGER.set });
    expect([...rNo.rows.values()].every((s) => s.state === 'unread' && s.reason === 'no network')).toBe(true);
  });

  it('the engine stays pure: no read passed → every row unread ("not read by this caller"), no provider line Certain', () => {
    const r = runCheck(ex([{ model: 'claude-opus-4-1' }, { model: 'gpt-4o' }]));
    const ls = r.findings.filter((f) => f.title.includes('own API'));
    expect(ls.length).toBe(2);
    for (const f of ls) {
      expect(f.confidence).toBe('likely');
      // 0.4.4 (R4): gpt-4o rests on two pages, neither read — "they were"
      expect(f.detail).toMatch(/(it was|they were) not read in this run \(not read by this caller\)\.$/);
    }
  });

  it('the same id is Certain on a read that confirms it, Likely on --offline', async () => {
    const id = 'claude-opus-4-1';
    expect(lineOf(runCheck(ex([{ model: id }]), { pages: READ }), id)!.confidence).toBe('certain');
    const off = await readForRun({ switchedOff: true });
    const f = lineOf(runCheck(ex([{ model: id }]), { pages: off }), id)!;
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain('it was not read in this run (--offline).');
  });

  it('--offline, KGAUTO_CHECK_OFFLINE=1 and the server’s offline input make no request', async () => {
    const spy = vi.fn(serve(MIN));
    await readForRun({ switchedOff: true, fetchImpl: spy as unknown as typeof fetch });
    await readForRun({ env: { KGAUTO_CHECK_OFFLINE: '1' }, fetchImpl: spy as unknown as typeof fetch });
    const client = await connect({ pageFetch: spy as unknown as typeof fetch });
    for (const name of ['run_check', 'get_model_facts']) {
      const args = name === 'run_check' ? { extract: ex([{ model: 'gpt-4o' }]), offline: true } : { model: 'gpt-4o', offline: true };
      const out = await client.callTool({ name, arguments: args });
      expect(JSON.stringify(out)).toContain('the offline input');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('--pages <dir>: a directory without read-times.json is refused', () => {
    const d = pagesWith();
    rmSync(join(d, 'read-times.json'));
    expect(() => readPagesFromDir(d, MIN_LEDGER.set)).toThrow(/no read-times\.json/);
  });

  it('a catalog line is Likely in every run, a read or none (the model page’s word)', () => {
    // claude-haiku-4-5: its catalog profile carries Anthropic's model page word (Legacy); no ledger row.
    for (const pages of [READ, undefined]) {
      const f = lineOf(runCheck(ex([{ model: 'claude-haiku-4-5' }]), { pages }), 'claude-haiku-4-5')!;
      expect(f.title).toMatch(/its model page says so \(read \d{4}-\d{2}-\d{2}\)/);
      expect(f.confidence).toBe('likely');
    }
  });

  it('one matcher: the run-time read and the drift script name the same rows as moved on one saved page set', () => {
    const moved = pagesWith({ file: 'google-deprecations.html', from: '  * May 1, 2099', to: '  * June 1, 2099' });
    const moved2 = join(moved, 'openai-deprecations.md');
    writeFileSync(moved2, readFileSync(moved2, 'utf8').replace('`gpt-old-a`               | `gpt-mini-b`', '`gpt-old-a`               | `gpt-mini-c`'));
    const d = spawnSync(process.execPath, [DRIFT, '--pages', moved, '--ledger', MIN_LEDGER.file], { encoding: 'utf8' });
    const byDrift = [...d.stdout.matchAll(/^MOVED \w+ (\S+) —/gm)].map((m) => m[1]).sort();
    const read = readPagesFromDir(moved, MIN_LEDGER.set);
    const byRead = [...read.rows].filter(([, s]) => s.state === 'changed').map(([id]) => id).sort();
    expect(byDrift).toEqual(['gemini-mini-a', 'gpt-old-a']);
    expect(byRead).toEqual(byDrift);
    expect(d.status).toBe(1);
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────
describe('R2 — every provider line says when its page was read, in the line', () => {
  // 0.4.4 (R6): the page is named by its own title ("Model deprecations"); until 0.4.3 "Anthropic's page"
  it('confirmed: basis "<Provider>\'s <page, by its title>, read in this run (<YYYY-MM-DD HH:MM> UTC): <url>"', () => {
    const f = lineOf(runCheck(ex([{ model: 'claude-opus-4-1' }]), { pages: READ }), 'claude-opus-4-1')!;
    expect(f.basis).toBe("Anthropic's model deprecations page, read in this run (2026-11-20 05:02 UTC): https://platform.claude.com/docs/en/about-claude/model-deprecations.md");
  });

  it('unread: the detail ends with the day this version read it, n days before, and why not now; the basis says "as read"', async () => {
    const read = await readPagesFromNetwork({ fetchImpl: status(503) });
    const f = lineOf(runCheck(ex([{ model: 'claude-opus-4-1' }]), { pages: read, today: '2026-11-23' }), 'claude-opus-4-1')!; // 0.4.5: three days after the re-read (until 0.4.5: 2026-11-21)
    const row = LEDGER.find((r) => r.id === 'claude-opus-4-1-20250805')!;
    expect(row.readOn).toBe('2026-11-20'); // 0.4.5: the ledger re-read on 2026-11-20 (until 0.4.5: 2026-11-18, fix pass 1's re-read, A4)
    expect(f.detail.endsWith(`This is Anthropic's model deprecations page as this version of the check read it on ${row.readOn}, 3 days before this run; it was not read in this run (HTTP 503).`)).toBe(true);
    expect(f.basis).toBe(`Anthropic's model deprecations page as read ${row.readOn}: ${row.url}`);
  });

  it('changed: the title begins "As read on <readOn> (the page has changed since):", the detail says to read the page, and a changed definition is not quoted', () => {
    const moved = pagesWith({ file: 'anthropic-deprecations.md', from: '| claude-mini-1     | Retired       | May 1, 2026  | June 1, 2026 ', to: '| claude-mini-1     | Retired       | May 1, 2026  | July 1, 2026 ' });
    const def = join(moved, 'anthropic-deprecations.md');
    writeFileSync(def, readFileSync(def, 'utf8').replace('Requests to retired models fail.', 'Requests to retired models are refused.'));
    const read = readPagesFromDir(moved, MIN_LEDGER.set);
    expect(read.rows.get('claude-mini-1')?.state).toBe('changed');
    expect(read.definitions.get('anthropic|retired')?.state).toBe('changed');
    // the card's words for a changed row and a changed definition, on a bundled row (the engine reads the bundled ledger)
    const rec = { ...READ, rows: new Map(READ.rows), definitions: new Map(READ.definitions) } as PageRead;
    (rec.rows as Map<string, unknown>).set('claude-opus-4-1-20250805', { state: 'changed', at: '2026-11-16T22:54:38Z', gone: [] });
    (rec.definitions as Map<string, unknown>).set('anthropic|retired', { state: 'changed', at: '2026-11-16T22:54:38Z', gone: [] });
    const f = lineOf(runCheck(ex([{ model: 'claude-opus-4-1' }]), { pages: rec }), 'claude-opus-4-1')!;
    expect(f.title.startsWith('As read on 2026-11-20 (the page has changed since): On Anthropic\'s own API')).toBe(true);
    expect(f.confidence).toBe('likely');
    expect(f.detail).toContain("This line is no longer on Anthropic's model deprecations page as it was read. Read the page before acting on the date: https://platform.claude.com/docs/en/about-claude/model-deprecations.md. A newer version of the check carries a newer read.");
    expect(f.detail).not.toContain('Requests to retired models fail.');
  });

  it('the footer: n of m pages read, the same m pages whatever the project holds; when n < m one more sentence', async () => {
    expect(runCheck(ex([{ model: 'gpt-4o' }]), { pages: READ }).card).toContain(
      '*This check ran on your machine. It read 10 of 10 provider pages in this run — the same 10 public pages whatever your project holds. Nothing about your project was sent anywhere, and no rows were written anywhere.*',
    );
    const half = (async (u: string) =>
      u.includes('openai') ? new Response('x', { status: 503 }) : serve(MIN)(u)) as unknown as typeof fetch;
    const read = await readPagesFromNetwork({ fetchImpl: half });
    const n = read.pages.filter((p) => p.ok).length;
    const card = runCheck(ex([{ model: 'gpt-4o' }]), { pages: read }).card;
    expect(card).toContain(`It read ${n} of 10 provider pages in this run`);
    expect(card).toMatch(new RegExp(`no rows were written anywhere\\. ${10 - n} (did not answer|did not answer or answered with a page this version does not read); their lines say so\\.\\*`));
  });

  // 0.4.5 (R2): the footer claims no single day for every line (until 0.4.5: "every provider line is the page as this version read it on <day>")
  it('--offline footer, and the share forms keep their last sentence', async () => {
    const off = await readForRun({ switchedOff: true });
    const card = runCheck(ex([{ model: 'gpt-4o' }]), { pages: off }).card;
    expect(card).toMatch(/\*This check ran on your machine and made no network request \(--offline\): the deprecation pages behind its provider lines are as this version read them on \d{4}-\d{2}-\d{2}, and a line taken from a model's own page gives the day that page was read\. Nothing was uploaded; no rows were written anywhere\.\*/);
    expect(runCheck(ex([{ model: 'gpt-4o' }]), { pages: off, share: true }).card).toMatch(/Because you ran it with --share, this card and the extract are sent after it is printed\.\*\n/);
    expect(runCheck(ex([{ model: 'gpt-4o' }]), { pages: READ, share: true }).card).toMatch(/whatever your project holds\. Because you ran it with --share, this card and the extract are sent after it is printed\.\*\n/);
  });

  it('the stamp: "deprecation pages bundled <date>", and after a read ", read in this run <YYYY-MM-DD HH:MM> UTC"', async () => {
    const last = (c: string) => c.split('\n').at(-1)!;
    expect(last(runCheck(ex([{ model: 'gpt-4o' }]), { pages: READ }).card)).toMatch(/· deprecation pages bundled \d{4}-\d{2}-\d{2}, read in this run 2026-11-20 05:02 UTC<\/sub>$/);
    expect(last(runCheck(ex([{ model: 'gpt-4o' }]), { pages: await readForRun({ switchedOff: true }) }).card)).toMatch(/· deprecation pages bundled \d{4}-\d{2}-\d{2}<\/sub>$/);
  });

  it('the age sentence prints only when a provider line on the card is unread or changed', async () => {
    const later = '2027-01-30';
    expect(runCheck(ex([{ model: 'gpt-4o' }]), { pages: READ, today: later }).card).not.toMatch(/were read \d+ days ago/);
    expect(runCheck(ex([{ model: 'gpt-4o' }]), { pages: await readForRun({ switchedOff: true }), today: later }).card).toMatch(/were read \d+ days ago/);
  });

  it('--model-facts and get_model_facts follow it: in this run, or the day it was read and why not now', async () => {
    expect(renderModelFacts('claude-opus-4-1', { pages: READ })).toContain('(read in this run, 2026-11-20 05:02 UTC)');
    const off = renderModelFacts('claude-opus-4-1', { pages: await readForRun({ switchedOff: true }), today: '2026-11-23' }); // 0.4.5: after the re-read (until 0.4.5: 2026-11-20)
    expect(off).toMatch(/\(read \d{4}-\d{2}-\d{2}, \d+ days before this lookup; not read in this run \(--offline\)\)/);
    expect(off).toContain('this lookup made no network request (--offline)');
  });
});

// ── R3 ────────────────────────────────────────────────────────────────────
describe('R3 — a page that answers is not yet the page we know; one shape check for the generator and the read', () => {
  const RENAMES: { provider: string; file: string; from: string | RegExp; to: string; piece: RegExp }[] = [
    { provider: 'Anthropic', file: 'anthropic-deprecations.md', from: 'Current state', to: 'State        ', piece: /"## Model status"/ },
    { provider: 'OpenAI', file: 'openai-deprecations.md', from: 'Affected model |', to: 'Model affected |', piece: /"## Upcoming deprecations"/ },
    { provider: 'Google', file: 'google-deprecations.html', from: /\* Shutdown date/g, to: '* Shutdown', piece: /header row/ },
    { provider: 'DeepSeek', file: 'deepseek-updates.html', from: /Date: 2026/g, to: 'Dated: 2026', piece: /"Date: YYYY-MM-DD"/ },
  ];
  for (const m of RENAMES) {
    it(`${m.provider}: one column (or marker) renamed — the generator stops naming the page and the piece; the read says unread`, () => {
      const d = pagesWith({ file: m.file, from: m.from, to: m.to });
      const out = join(tmp('gen-043-'), 'ledger.ts');
      const g = spawnSync(process.execPath, [GEN, '--pages', d, '--out', out], { encoding: 'utf8' });
      expect(g.status).toBe(1);
      expect(g.stderr).toContain(`stop: ${m.file} is not the page this version reads`);
      expect(g.stderr).toMatch(m.piece);
      expect(existsSync(out)).toBe(false);
      const read = readPagesFromDir(d, MIN_LEDGER.set);
      const page = read.pages.find((p) => p.file === m.file)!;
      expect(page.ok).toBe(false);
      expect(!page.ok && page.reason).toBe(NOT_THE_PAGE);
      // its rows are unread, never changed
      const rows = MIN_LEDGER.set.rows.filter((r) => pageFileOf(r.url) === m.file);
      expect(rows.length).toBeGreaterThan(0);
      // 0.4.4 (R4): the state also names the page that was not read
      for (const r of rows) expect(read.rows.get(r.id)).toMatchObject({ state: 'unread', reason: NOT_THE_PAGE, notRead: [{ url: r.url, reason: NOT_THE_PAGE }] });
    });
  }

  it('a 200 with another page’s body (a consent page, a login page) is unread, never 300 changed rows', async () => {
    const swapped = (async (u: string) =>
      new Response(u === 'https://aistudio.google.com/docs/deprecations' ? '<html><body>Before you continue to Google</body></html>' : 'x', { status: u.includes('aistudio') ? 200 : 503 })) as unknown as typeof fetch;
    const read = await readPagesFromNetwork({ fetchImpl: swapped });
    expect([...read.rows.values()].filter((s) => s.state === 'changed')).toHaveLength(0);
    const g = LEDGER.filter((r) => r.url === 'https://aistudio.google.com/docs/deprecations');
    expect(g.length).toBeGreaterThan(30);
    for (const r of g)
      expect(read.rows.get(r.id)).toMatchObject({ state: 'unread', reason: NOT_THE_PAGE, notRead: expect.arrayContaining([{ url: r.url, reason: NOT_THE_PAGE }]) });
    const card = runCheck(ex([{ model: 'gemini-2.5-flash' }]), { pages: read }).card;
    expect(card).toContain('it was not read in this run (not the page this version reads).');
  });

  it('the expectations are written once, per page, and each made-up page meets them', () => {
    expect(Object.keys(PAGE_SHAPES).sort()).toEqual(
      ['anthropic-deprecations.md', 'deepseek-first-api-call.html', 'deepseek-updates.html', 'google-changelog.html', 'google-deprecations.html', 'openai-deprecations.md', 'openai-model-*.md'].sort(),
    );
    for (const f of ['anthropic-deprecations.md', 'openai-deprecations.md', 'google-deprecations.html', 'google-changelog.html', 'deepseek-updates.html', 'deepseek-first-api-call.html'])
      expect(pageShapeMisses(f, pageTextOf(f, readFileSync(join(MIN, f), 'utf8'))), f).toEqual([]);
    expect(pageShapeMisses('openai-model-gpt-4o.md', '# GPT-4o\n\nModel ID: `gpt-4o`\n\nStatus: Deprecated\n')).toEqual([]);
    expect(pageShapeMisses('openai-model-gpt-4o.md', '# GPT-4o\n\nModel ID: `gpt-4o`\n\nStatus:\n')).toEqual(['a "Status: <word>" line']);
  });
});

// ── R4 ────────────────────────────────────────────────────────────────────
describe('R4 — where an id is written, said by the extract and counted by the card', () => {
  const F = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG, 'tests/fixtures/verifier-043.json'), 'utf8')));

  it('the contract carries `context` on call sites and listed ids, and the extract contract asks for it on every one', async () => {
    expect(F.models!.filter((m) => m.context).length).toBe(6);
    expect(ExtractSchema.safeParse({ project: { name: 'x' }, callSites: [{ id: 'a', model: 'm', context: 'runs' }] }).success).toBe(true);
    expect(ExtractSchema.safeParse({ project: { name: 'x' }, callSites: [{ id: 'a', model: 'm', context: 'prod' }] }).success).toBe(false);
    const { START_CHECK_INSTRUCTIONS } = await import('../src/instructions.js');
    expect(START_CHECK_INSTRUCTIONS).toContain('- context: state it for EVERY call site — where it is written: runs (code or configuration the project executes or loads in normal use');
    expect(START_CHECK_INSTRUCTIONS).toContain('an id in a docstring is listed with context docs, not left out');
  });

  it('the header counts the flagged ids by context, a model once under the first of runs · not stated · test · example · docs', () => {
    const card = runCheck(F, { pages: READ }).card;
    // Amendment B4: the changelog id is counted apart from the provider's own flags; the context counts are over both.
    // 0.4.4 (R3): in two sentences, not one with a dash — who flagged how many, then where the flagged ids are written.
    expect(card).toContain(
      "7 are flagged by their providers, and 1 by this check's reading of Google's release notes page. Of the 8 flagged ids, 3 are in code that runs, 1 in tests, 1 in docs, 1 in examples and 2 where the extract does not say.",
    );
    expect(card.split('\n').filter((l) => l.includes('in code that runs'))).toHaveLength(1);
    // one model on a test site and a runs site counts once, under runs
    const two = runCheck(ex([{ model: 'gpt-4o', context: 'test' }, { model: 'gpt-4o', context: 'runs', where: 'src/x.py:1' }]), { pages: READ }).card;
    expect(two).toContain('1 is flagged by OpenAI. The flagged id is in code that runs.');
  });

  it('with no context stated anywhere: the 0.4.2 header, then one sentence', () => {
    const card = runCheck(ex([{ model: 'gpt-4o' }]), { pages: READ }).card;
    const lines = card.split('\n');
    expect(lines[2]).toMatch(/ 1 is flagged by OpenAI\.$/);
    expect(lines[4]).toBe('The extract does not say where each id is written, so this count is of every place an id appears.');
  });

  it('each site carries its context in brackets; runs first, then not stated, then the rest; the rest print ℹ️ whatever the word', () => {
    const r = runCheck(F, { pages: READ });
    const certain = r.card.split('## Certain')[1]!.split('## Likely')[0]!;
    const sites = [...certain.matchAll(/<sub>([^·]+) ·/g)].map((m) => m[1]!.trim());
    // 0.4.5 (R6): `gpt-4o` at src/defaults.py:1 is a display-name row, never Certain, so it is not in this tier (until 0.4.5 it was second)
    expect(sites).toEqual([
      'src/realtime.py:49 (runs)',
      'src/config.py:1',
      'src/config.py:2',
      'tests/test_llm.py:21 (test)',
      'docs/models.md:45 (docs)',
      'examples/router.py:1 (example)',
    ]);
    const marks = [...certain.matchAll(/^- (\S+) \*\*/gm)].map((m) => m[1]);
    expect(marks.slice(3)).toEqual(['ℹ️', 'ℹ️', 'ℹ️']);
    // severity itself is unchanged: the mark is the card's, chosen after the merge
    expect(r.findings.find((f) => f.title.includes('claude-3-5-sonnet-20241022'))!.severity).toBe('red');
    expect(marks[0]).toBe('🔴');
  });
});

// ── R5 ────────────────────────────────────────────────────────────────────
async function connect(seams: Parameters<typeof buildServer>[0]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(seams).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe('R5 — share_card, a fifth tool on the server', () => {
  it('the tool surface is the four tools and share_card', async () => {
    const client = await connect({ pageFetch: serve(MIN) });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_model_facts', 'get_observe_day_plan', 'run_check', 'share_card', 'start_check']);
    const share = (await client.listTools()).tools.find((t) => t.name === 'share_card')!;
    expect(share.description).toContain('call it only if your human says yes, never by default');
    expect(share.description).toContain(SHARE_STORED_SENTENCE);
  });

  it('one POST of the same body as --share to the override endpoint; returns the stored card and the confirmation', async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const shareFetch = (async (u: string, init: RequestInit) => {
      posts.push({ url: u, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, id: 41 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = await connect({ pageFetch: status(503), shareFetch, env: { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/api' } });
    const extract = ex([{ model: 'gpt-4o', context: 'runs' }], 'cv-test');
    const out = textOf(await client.callTool({ name: 'share_card', arguments: { extract, humanSaidYes: true } }));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('http://127.0.0.1:1/api');
    expect(Object.keys(posts[0]!.body).sort()).toEqual(['card', 'catalog_version', 'check_version', 'extract']);
    expect((posts[0]!.body.extract as Extract).project.name).toBe('cv-test');
    expect(out.startsWith(posts[0]!.body.card as string)).toBe(true);
    expect(posts[0]!.body.card).toContain('Because you said yes to sharing it, this card and the extract are sent after it is printed.');
    expect(out).toContain(`[share_card] Sent to http://127.0.0.1:1/api (submission 41). ${SHARE_STORED_SENTENCE}`);
  });

  it('humanSaidYes is a literal true: anything else is refused by the schema, and nothing is posted', async () => {
    const shareFetch = vi.fn();
    const client = await connect({ pageFetch: status(503), shareFetch: shareFetch as unknown as typeof fetch, env: { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/api' } });
    for (const yes of [false, 'true', 1, undefined]) {
      const r = await client.callTool({ name: 'share_card', arguments: { extract: ex([{ model: 'gpt-4o' }]), ...(yes === undefined ? {} : { humanSaidYes: yes }) } });
      expect(r.isError, String(yes)).toBe(true);
    }
    expect(shareFetch).not.toHaveBeenCalled();
  });

  it('a failed post never throws: the card, then the failure', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = await connect({ pageFetch: status(503), shareFetch: down, env: { KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:1/api' } });
    const r = await client.callTool({ name: 'share_card', arguments: { extract: ex([{ model: 'gpt-4o' }]), humanSaidYes: true } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[share_card] FAILED (ECONNREFUSED) — the endpoint did not confirm a row, so a row may or may not exist.');
  });

  it('bin.ts says the tool surface is additive, not unchanged', () => {
    const bin = readFileSync(join(PKG, 'src/bin.ts'), 'utf8');
    expect(bin).not.toMatch(/unchanged since 0\.1\.0/);
    expect(bin).toContain('no tool removed or renamed');
  });
});

// ── R6 ────────────────────────────────────────────────────────────────────
describe('R6 — a changelog row: news about a model named in words, never Certain', () => {
  it('four rows, marked by `namedAs`, each quote and introduction checked on the changelog', () => {
    const rows = LEDGER.filter((r) => r.namedAs);
    expect(rows.map((r) => r.id).sort()).toEqual(['gemini-1.0-pro', 'gemini-1.0-pro-vision', 'gemini-pro', 'gemini-pro-vision']);
    for (const r of rows) {
      expect(r.url).toBe('https://aistudio.google.com/docs/changelog');
      expect(r.word).toBe('no longer supported');
      expect(r.modelPage?.status).toBe(404);
    }
    expect(rows.find((r) => r.id === 'gemini-pro')!.alsoQuote).toBe('gemini-pro: New text model for a wide variety of tasks.');
    expect(rows.find((r) => r.id === 'gemini-1.0-pro')!.alsoQuote).toBeUndefined();
  });

  it('Likely even when confirmed, in one sentence that says the link is ours, with the changelog’s date and the 404', () => {
    const r = runCheck(ex([{ model: 'gemini-pro', context: 'runs' }]), { pages: READ });
    const f = lineOf(r, 'gemini-pro')!;
    expect(f.confidence).toBe('likely');
    // Amendment B4: "this check's", not "our"
    // 0.4.4 (R6): Google's page is titled "Release notes" (until 0.4.3: "Google's changelog says")
    expect(f.title).toBe("`gemini-pro` is, by this check's reading, Gemini 1.0 Pro: Google's release notes page says “Gemini 1.0 Pro is no longer supported.” (February 18, 2025)");
    expect(f.detail).toContain('the link from `gemini-pro` to “Gemini 1.0 Pro” is this check\'s');
    expect(r.card).not.toMatch(/\bour reading\b|\bis ours\b/);
    expect(r.card).toContain('## Likely — a provider’s page as read on an earlier day (the day is on the line); a provider’s release notes that name a model in words, not by its id;');
    expect(f.detail).toContain('Its entry of December 13 2023 introduced the id: “gemini-pro: New text model for a wide variety of tasks.”');
    // the generator's own request, 2026-11-18T18:24:09Z (until 0.4.3: 2026-11-16; until fix pass 1: 2026-11-17)
    expect(f.detail.endsWith("Google's model page for this id answered 404 on 2026-11-18.")).toBe(true);
    expect(r.card).not.toContain('was not recognised');
    expect(r.card.split('\n').filter((l) => l.includes('no longer supported'))).toHaveLength(1);
  });

  it('the generator refuses a changelog sentence that is not under its heading', () => {
    const d = pagesWith({ file: 'google-changelog.html', from: '## February 18, 2025', to: '## February 19, 2025' });
    const g = spawnSync(process.execPath, [GEN, '--pages', d, '--out', join(tmp('gen-043-'), 'l.ts')], { encoding: 'utf8' });
    expect(g.status).not.toBe(0);
    expect(g.stderr).toContain('no entry headed "February 18, 2025"');
  });
});

// ── R7 ────────────────────────────────────────────────────────────────────
describe('R7 — the words', () => {
  it('no shipped line says "offline" except about the --offline flag', () => {
    const files = ['src/bin.ts', 'src/engine.ts', 'src/extract.ts', 'src/index.ts', 'src/instructions.ts', 'src/lifecycle.ts', 'src/model-facts.ts', 'src/observe-plan.ts', 'src/pages.ts', 'src/server.ts', 'src/share.ts', 'src/version.ts', 'src/ledger-check.mjs', 'README.md', 'package.json'];
    const bad: string[] = [];
    for (const f of files)
      for (const [i, l] of readFileSync(join(PKG, f), 'utf8').split('\n').entries())
        if (/offline/i.test(l) && !l.includes('--offline') && !l.includes('KGAUTO_CHECK_OFFLINE')) bad.push(`${f}:${i + 1}`);
    expect(bad).toEqual([]);
  });

  it('what the check says of itself, in the contract, the server and the card’s exported sentence', async () => {
    const { START_CHECK_INSTRUCTIONS, SERVER_INSTRUCTIONS, USAGE } = await import('../src/instructions.js');
    const S = 'The check reads your repository on your machine; nothing about your project leaves it unless you choose to share the result.';
    expect(DESTINATION_SENTENCE).toBe(S);
    for (const t of [START_CHECK_INSTRUCTIONS, SERVER_INSTRUCTIONS, USAGE]) expect(t).toContain(S);
  });
});

// ── Amendment A ───────────────────────────────────────────────────────────
describe('Amendment A1 — ledger-drift.mjs --fetch --discard-pages', () => {
  // Amendment B3: the script's mkdtemp lands in a folder this file removes
  const run = (args: string[], ledger = MIN_LEDGER.file, from = MIN) =>
    spawnSync(process.execPath, [DRIFT, ...args, '--ledger', ledger], {
      encoding: 'utf8',
      env: { ...process.env, KGAUTO_LEDGER_DRIFT_FETCH_FROM: from, TMPDIR: tmp('drift-root-') },
    });
  const savedIn = (out: string) => /^pages saved in (\S+)$/m.exec(out)![1]!;

  it('a clean run removes the folder it created, prints the line before the summary, and the summary stays last (exit 0)', () => {
    const r = run(['--fetch', '--discard-pages']);
    const lines = r.stdout.trimEnd().split('\n');
    expect(r.status).toBe(0);
    expect(lines.at(-2)).toBe('pages removed (clean run)');
    expect(lines.at(-1)).toBe('0 rows moved — 19 rows checked of 19');
    expect(existsSync(savedIn(r.stdout))).toBe(false);
  });

  it('a moved row keeps the folder (exit 1)', () => {
    const r = run(['--fetch', '--discard-pages'], MIN_LEDGER.file, pagesWith({ file: 'google-deprecations.html', from: '  * May 1, 2099', to: '  * June 1, 2099' }));
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('pages removed');
    expect(existsSync(savedIn(r.stdout))).toBe(true);
  });

  it('Amendment B2(a): a run that ends on exit 2 (a page not saved) keeps the folder', () => {
    const d = pagesWith();
    rmSync(join(d, 'deepseek-first-api-call.html'));
    const r = run(['--fetch', '--discard-pages'], MIN_LEDGER.file, d);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('pages removed');
    expect(existsSync(savedIn(r.stdout))).toBe(true);
  });

  it('a directory passed with --pages is never removed, with or without the flag', () => {
    const d = pagesWith();
    const r = spawnSync(process.execPath, [DRIFT, '--pages', d, '--discard-pages', '--ledger', MIN_LEDGER.file], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('pages removed');
    expect(existsSync(join(d, 'google-deprecations.html'))).toBe(true);
  });

  it('without the flag a clean --fetch keeps its folder, as before', () => {
    const r = run(['--fetch']);
    expect(r.status).toBe(0);
    expect(existsSync(savedIn(r.stdout))).toBe(true);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('0 rows moved — 19 rows checked of 19');
  });
});

describe('a resolveRead sanity check: a URL not in the request set is unread, never confirmed', () => {
  it('a row whose page is not requested', () => {
    const read = resolveRead('network', [], MIN_LEDGER.set);
    for (const s of read.rows.values()) expect(s).toMatchObject({ state: 'unread', reason: 'not a page this version requests', read: [] });
  });
});

// ── Amendment B ───────────────────────────────────────────────────────────
describe('Amendment B1 — a model page is the page asked for, or it is unread', () => {
  const MINI = 'https://developers.openai.com/api/docs/models/gpt-4o-mini.md';
  /** gpt-4o's bytes at the gpt-4o-mini address, every other page as saved. */
  const planted = () => pagesWith({ file: 'openai-model-gpt-4o-mini.md', from: /^[\s\S]*$/, to: readFileSync(join(MIN, 'openai-model-gpt-4o.md'), 'utf8') });

  it('the plant, through the fetch seam: the gpt-4o-mini row is not confirmed, and the footer counts the page as answered with another page', async () => {
    const control = await readPagesFromNetwork({ fetchImpl: serve(MIN), ledger: MIN_LEDGER.set });
    expect(control.rows.get('gpt-4o-mini')?.state).toBe('confirmed'); // its own page confirms it
    const read = await readPagesFromNetwork({ fetchImpl: serve(planted()), ledger: MIN_LEDGER.set });
    // 0.4.4 (R4): the state says which of the row's two pages was not read, and that the other was
    expect(read.rows.get('gpt-4o-mini')).toMatchObject({
      state: 'unread',
      reason: NOT_THE_PAGE,
      notRead: [{ url: MINI, reason: NOT_THE_PAGE }],
      read: [{ url: 'https://developers.openai.com/api/docs/deprecations.md', stands: true }],
    });
    expect(read.rows.get('gpt-4o')?.state).toBe('confirmed');
    const page = read.pages.find((p) => p.url === MINI)!;
    // 0.4.4 (R5, R6): the title is part of the shape now, so the plant misses two pieces: the title and the one id line
    expect(!page.ok && page.missing).toEqual(['the title "GPT-4o mini" (found "GPT-4o")', 'exactly one "Model ID: `gpt-4o-mini`" line (found `gpt-4o`)']);
    const { destinationSentence } = await import('../src/engine.js');
    const m = MIN_LEDGER.set.urls.length;
    expect(destinationSentence(read)).toContain(`It read ${m - 1} of ${m} provider pages in this run`);
    expect(destinationSentence(read)).toMatch(/ 1 answered with a page this version does not read; their lines say so\.$/);
  });

  it('the plant, through --pages: the same row unread, and the generator stops on it', () => {
    const d = planted();
    expect(readPagesFromDir(d, MIN_LEDGER.set).rows.get('gpt-4o-mini')).toMatchObject({ state: 'unread', reason: NOT_THE_PAGE, notRead: [{ url: MINI, reason: NOT_THE_PAGE }] });
    const out = join(tmp('gen-043-'), 'ledger.ts');
    const g = spawnSync(process.execPath, [GEN, '--pages', d, '--out', out], { encoding: 'utf8' });
    expect(g.status).toBe(1);
    expect(g.stderr).toContain(
      'stop: openai-model-gpt-4o-mini.md is not the page this version reads — it lacks the title "GPT-4o mini" (found "GPT-4o"); exactly one "Model ID: `gpt-4o-mini`" line (found `gpt-4o`)',
    );
    expect(existsSync(out)).toBe(false);
  });

  it('the bundled gpt-4o-mini row through the engine, its model page another model’s: Likely, saying why', async () => {
    const real = readFileSync(join(MIN, 'openai-model-gpt-4o.md'), 'utf8');
    const seam = (async (u: string) => (u === MINI ? new Response(real, { status: 200 }) : new Response('x', { status: 503 }))) as unknown as typeof fetch;
    const read = await readPagesFromNetwork({ fetchImpl: seam });
    expect(read.rows.get('gpt-4o-mini')).toMatchObject({ state: 'unread', reason: 'HTTP 503', read: [] }); // its deprecations page did not answer either
    // the record of the release, with only the model page's outcome taken from the planted read: every other page as it was read
    const { fromRecord } = await import('../src/pages.js');
    const planted = fromRecord({ how: 'record', pages: READ.pages.map((p) => (p.url === MINI ? read.pages.find((q) => q.url === MINI)! : p)), changedRows: [], changedDefinitions: [] });
    expect(planted.pages.find((p) => p.url === MINI)!.ok).toBe(false);
    const f = lineOf(runCheck(ex([{ model: 'gpt-4o-mini' }]), { pages: planted }), 'gpt-4o-mini')!;
    expect(f.confidence).toBe('likely');
    // 0.4.4 (R4): the deprecations page WAS read in this run; only the model page was not, and the line says so by name
    expect(f.detail).toContain(
      "In this run OpenAI's deprecations page was read (2026-11-20 05:02 UTC) and still says this, and OpenAI's model page for GPT-4o mini was not read (not the page this version reads);",
    );
    expect(f.detail).not.toContain('was not read in this run (not the page this version reads)');
  });

  it('no page of the made-up set is accepted at another source page’s address (the cross matrix)', () => {
    const files = [
      'anthropic-deprecations.md',
      'openai-deprecations.md',
      'openai-model-gpt-4o.md',
      'openai-model-gpt-4o-mini.md',
      'google-deprecations.html',
      'google-changelog.html',
      'deepseek-updates.html',
      'deepseek-first-api-call.html',
    ];
    const accepted: string[] = [];
    for (const at of files)
      for (const body of files) {
        const misses = pageShapeMisses(at, pageTextOf(at, readFileSync(join(MIN, body), 'utf8')));
        if (at === body) expect(misses, at).toEqual([]);
        else if (misses.length === 0) accepted.push(`${body} at ${at}`);
      }
    expect(accepted).toEqual([]);
  });
});

describe('Amendment B2(b) — a row whose second page is unread is unread, never confirmed', () => {
  const row = MIN_LEDGER.set.rows.find((r) => r.id === 'gpt-4o-mini')!;
  it('rowState: the main page read, the alsoUrl page not', async () => {
    const { rowState } = await import('../src/ledger-check.mjs');
    expect(row.alsoUrl).toBe('https://developers.openai.com/api/docs/models/gpt-4o-mini.md');
    const text = readFileSync(join(MIN, 'openai-deprecations.md'), 'utf8');
    const s = rowState(row, (u) => (u === row.url ? { ok: true, text, at: '2026-11-16T22:54:38Z' } : { ok: false, reason: 'HTTP 503' }));
    // 0.4.4 (R4): and which page was read, which was not
    expect(s).toEqual({
      state: 'unread',
      reason: 'HTTP 503',
      notRead: [{ url: row.alsoUrl, reason: 'HTTP 503' }],
      read: [{ url: row.url, at: '2026-11-16T22:54:38Z', stands: true }],
    });
  });
  it('fromRecord: the same, from a kept record', async () => {
    const { fromRecord } = await import('../src/pages.js');
    const pages = MIN_LEDGER.set.urls.map((url) =>
      url === row.alsoUrl ? { url, ok: false as const, reason: 'HTTP 503' } : { url, ok: true as const, at: '2026-11-16T22:54:38Z' },
    );
    const read = fromRecord({ how: 'record', pages, changedRows: [], changedDefinitions: [] }, MIN_LEDGER.set);
    expect(read.rows.get('gpt-4o-mini')).toEqual({
      state: 'unread',
      reason: 'HTTP 503',
      notRead: [{ url: row.alsoUrl, reason: 'HTTP 503' }],
      read: [{ url: row.url, at: '2026-11-16T22:54:38Z', stands: true }],
    });
    expect(read.rows.get('gpt-mini-a')?.state).toBe('confirmed');
  });
});

describe('Amendment B5 — the README says the three conditions and names the ten pages by their own titles', () => {
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
  it('Certain on all three, never on a page read alone', () => {
    expect(readme).not.toContain('A line from a page read in this run is *Certain*');
    // 0.4.4 (R6): Google's page is titled "Release notes" (the sentence until 0.4.3 said "a changelog")
    expect(readme).toContain(
      "A provider line is *Certain* only when all three hold: its page was read in this run and still carries the line; the call is on the provider's own API; and the line is not this check's reading of a provider's release notes that name a model in words.",
    );
  });
  it('the ten titles, as the pages give them', () => {
    for (const t of ['*Model deprecations*', '*Deprecations*', '*GPT-4o*', '*GPT-4o mini*', '*GPT-4.1*', '*GPT-4.1 mini*', '*Gemini deprecations*', '*Release notes*', '*Change Log*', '*Your First API Call*'])
      expect(readme, t).toContain(t);
    expect(REQUEST_URLS).toHaveLength(10);
  });
});

describe('Amendment B4 — --model-facts says "the day of this lookup", as the card says it', () => {
  it('0 days and 1 day', async () => {
    const off = await readForRun({ switchedOff: true });
    const row = LEDGER.find((r) => r.id === 'claude-opus-4-1-20250805')!;
    expect(renderModelFacts('claude-opus-4-1', { pages: off, today: row.readOn })).toContain(
      `(read ${row.readOn}, the day of this lookup; not read in this run (--offline))`,
    );
    const next = new Date(Date.parse(`${row.readOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(renderModelFacts('claude-opus-4-1', { pages: off, today: next })).toContain('1 day before this lookup;');
  });
});
