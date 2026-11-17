/**
 * 0.4.3 (R1) — the providers' pages, read in this run.
 *
 * A provider line is Certain only when the page it rests on was read in this run and still carries
 * it. This module reads the ledger's pages and says, per ledger row, one of three things:
 *
 *   confirmed — every quote the row rests on is on its page in this run, by the generator's own check;
 *   changed   — the page was read as the page this version knows (R3) and a quote is not on it;
 *   unread    — a page the row rests on was not read, with the reason in words.
 *
 * The request set says nothing about the project: every run requests the same URLs (REQUEST_URLS —
 * the ledger's source pages and its definitions' pages), whatever the extract holds. Plain GET,
 * redirects followed, no cookie, no query string, no body, a User-Agent of `kgauto-check/<version>`;
 * all at once, 8 s a page, no retry. Nothing is cached or written to disk.
 *
 * The engine stays pure: it takes a PageRead as an option and makes no request itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER, LEDGER_SOURCES, LEDGER_DEFINITIONS } from './lifecycle-ledger.js';
import type { LedgerRow, LedgerDefinition } from './lifecycle-types.js';
import { CHECK_VERSION } from './version.js';
import {
  pageFileOf,
  pageTextOf,
  pageShapeMisses,
  rowState,
  definitionState,
  type PageAnswer,
  type RowState,
} from './ledger-check.mjs';

export type { RowState } from './ledger-check.mjs';

/** How the pages behind a card were read. */
export type ReadHow = 'network' | 'directory' | 'switched-off' | 'record' | 'none';

export type PageOutcome =
  | { url: string; file?: string; ok: true; at: string; bytes?: number; sha256?: string }
  | { url: string; file?: string; ok: false; reason: string; missing?: string[] };

export interface PageRead {
  how: ReadHow;
  /** One per requested URL, in request order. */
  pages: PageOutcome[];
  /** Per ledger row id. */
  rows: ReadonlyMap<string, RowState>;
  /** Per definition, keyed `provider|word`. */
  definitions: ReadonlyMap<string, RowState>;
}

/** The pages a ledger rests on, as one request set — never anything from the extract. */
export function requestUrls(sources: readonly { url: string }[] = LEDGER_SOURCES, definitions: readonly { url: string }[] = LEDGER_DEFINITIONS): string[] {
  return [...new Set([...sources.map((s) => s.url), ...definitions.map((d) => d.url)])];
}

/** The URLs every run requests (ten for the ledger of 2026-11-16). */
export const REQUEST_URLS: readonly string[] = requestUrls();

/** The reasons a page is unread, in the card's words. */
export const NOT_READ_BY_CALLER = 'not read by this caller';
export const NOT_THE_PAGE = 'not the page this version reads';
export const SWITCHED_OFF_REASON = '--offline';

export interface LedgerSet {
  rows: readonly LedgerRow[];
  definitions: readonly LedgerDefinition[];
  urls: readonly string[];
}
const BUNDLED: LedgerSet = { rows: LEDGER, definitions: LEDGER_DEFINITIONS, urls: REQUEST_URLS };

export const definitionKey = (d: { provider: string; word: string }) => `${d.provider}|${d.word}`;

/** The rows' and definitions' states from one answer per URL (a page read and of the right shape, or a reason). */
export function resolveRead(how: ReadHow, pages: PageOutcome[], ledger: LedgerSet = BUNDLED, texts: ReadonlyMap<string, string> = new Map()): PageRead {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const pageOf = (url: string): PageAnswer => {
    const p = byUrl.get(url);
    if (!p) return { ok: false, reason: 'not a page this version requests' };
    if (!p.ok) return { ok: false, reason: p.reason };
    return { ok: true, at: p.at, text: texts.get(url) ?? '' };
  };
  const rows = new Map<string, RowState>();
  for (const r of ledger.rows) rows.set(r.id, rowState(r, pageOf));
  const definitions = new Map<string, RowState>();
  for (const d of ledger.definitions) definitions.set(definitionKey(d), definitionState(d, pageOf));
  return { how, pages, rows, definitions };
}

/** Every page unread for one reason: `--offline`, or a caller that did not read (the engine's default). */
export function unreadAll(how: 'switched-off' | 'none', reason: string, ledger: LedgerSet = BUNDLED): PageRead {
  return resolveRead(
    how,
    ledger.urls.map((url) => ({ url, file: pageFileOf(url), ok: false as const, reason })),
    ledger,
  );
}

export const noRequestRead = (ledger: LedgerSet = BUNDLED) => unreadAll('switched-off', SWITCHED_OFF_REASON, ledger);

/** A page's text checked against the shape this version expects (R3); a page of another shape is unread. */
function checked(url: string, file: string | undefined, raw: string, at: string, extra: { bytes?: number; sha256?: string } = {}): { outcome: PageOutcome; text?: string } {
  if (!file) return { outcome: { url, ok: false, reason: NOT_THE_PAGE } };
  const text = pageTextOf(file, raw);
  const missing = pageShapeMisses(file, text);
  if (missing.length) return { outcome: { url, file, ok: false, reason: NOT_THE_PAGE, missing } };
  return { outcome: { url, file, ok: true, at, ...extra }, text };
}

/**
 * `--pages <dir>`: the pages from a directory in the generator's file names, each at its time in the
 * directory's read-times.json. A directory without read-times.json is refused (throws).
 */
export function readPagesFromDir(dir: string, ledger: LedgerSet = BUNDLED): PageRead {
  const timesFile = join(dir, 'read-times.json');
  if (!existsSync(timesFile)) throw new Error(`${dir} has no read-times.json, so the time each page was read is not known`);
  const times = JSON.parse(readFileSync(timesFile, 'utf8')) as Record<string, string>;
  const pages: PageOutcome[] = [];
  const texts = new Map<string, string>();
  for (const url of ledger.urls) {
    const file = pageFileOf(url);
    if (!file || !existsSync(join(dir, file))) {
      pages.push({ url, file, ok: false, reason: 'not in the pages directory' });
      continue;
    }
    const at = times[file];
    if (!at) {
      pages.push({ url, file, ok: false, reason: 'no read time for it in read-times.json' });
      continue;
    }
    const c = checked(url, file, readFileSync(join(dir, file), 'utf8'), at);
    pages.push(c.outcome);
    if (c.text !== undefined) texts.set(url, c.text);
  }
  return resolveRead('directory', pages, ledger, texts);
}

export interface NetworkReadOptions {
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per page; 8 s by ruling. */
  timeoutMs?: number;
  /** Test seam for the time stamped on each page. */
  now?: () => Date;
  ledger?: LedgerSet;
}

export const PAGE_TIMEOUT_MS = 8_000;

const NO_NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT']);

/** A failed request, in words. */
export function failureReason(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timed out';
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } } | undefined;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timed out';
  const code = e?.cause?.code ?? e?.code;
  if (code && NO_NETWORK_CODES.has(code)) return 'no network';
  return `the request failed: ${code ?? e?.cause?.message ?? e?.message ?? String(err)}`;
}

/** The request each page is fetched with — the same for every page and every run (R1). */
export function pageRequestInit(signal?: AbortSignal): RequestInit {
  return {
    method: 'GET',
    redirect: 'follow',
    credentials: 'omit',
    headers: { 'user-agent': `kgauto-check/${CHECK_VERSION}` },
    ...(signal ? { signal } : {}),
  };
}

/** The run-time read: every URL at once, 8 s a page, no retry, nothing written. */
export async function readPagesFromNetwork(opts: NetworkReadOptions = {}): Promise<PageRead> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const ledger = opts.ledger ?? BUNDLED;
  const texts = new Map<string, string>();
  const one = async (url: string): Promise<PageOutcome> => {
    const file = pageFileOf(url);
    const at = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    try {
      const res = await fetchImpl(url, pageRequestInit(ac.signal));
      if (!res.ok) return { url, file, ok: false, reason: `HTTP ${res.status}` };
      const raw = await res.text();
      const c = checked(url, file, raw, at, { bytes: Buffer.byteLength(raw) });
      if (c.text !== undefined) texts.set(url, c.text);
      return c.outcome;
    } catch (err) {
      return { url, file, ok: false, reason: failureReason(err, timedOut) };
    } finally {
      clearTimeout(timer);
    }
  };
  const pages = await Promise.all(ledger.urls.map(one));
  return resolveRead('network', pages, ledger, texts);
}

/** `KGAUTO_CHECK_OFFLINE=1` stops the read as `--offline` does. */
export const switchedOffByEnv = (env: Record<string, string | undefined> = process.env) => env.KGAUTO_CHECK_OFFLINE === '1';

/**
 * The read the CLI and the server do before calling the engine: none on `--offline` (or the env switch),
 * the directory on `--pages <dir>`, else the network.
 */
export async function readForRun(
  o: { switchedOff?: boolean; switchName?: string; pagesDir?: string; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<PageRead> {
  // the reason each line gives is the switch that was used: the flag (or the server's input), else the environment
  if (o.switchedOff) return unreadAll('switched-off', o.switchName ?? SWITCHED_OFF_REASON);
  if (switchedOffByEnv(o.env)) return unreadAll('switched-off', 'KGAUTO_CHECK_OFFLINE=1');
  if (o.pagesDir) return readPagesFromDir(o.pagesDir);
  return readPagesFromNetwork({ fetchImpl: o.fetchImpl });
}

// ── a read, kept as a record (the regression set's committed fixture) ──

export interface ReadRecord {
  how: ReadHow;
  pages: PageOutcome[];
  /** Ids of the rows that were changed in that read. */
  changedRows: string[];
  /** Keys (`provider|word`) of the definitions that were changed in that read. */
  changedDefinitions: string[];
}

export function toRecord(read: PageRead): ReadRecord {
  return {
    how: read.how,
    pages: read.pages,
    changedRows: [...read.rows].filter(([, s]) => s.state === 'changed').map(([id]) => id),
    changedDefinitions: [...read.definitions].filter(([, s]) => s.state === 'changed').map(([k]) => k),
  };
}

/** A record back to a read: a row is unread when a page it rests on was, else changed when the record says so, else confirmed. */
export function fromRecord(rec: ReadRecord, ledger: LedgerSet = BUNDLED): PageRead {
  const byUrl = new Map(rec.pages.map((p) => [p.url, p]));
  const changed = new Set(rec.changedRows);
  const state = (urls: string[], isChanged: boolean): RowState => {
    for (const u of urls) {
      const p = byUrl.get(u);
      if (!p) return { state: 'unread', reason: 'not a page this version requests' };
      if (!p.ok) return { state: 'unread', reason: p.reason };
    }
    const p = byUrl.get(urls[0]!) as Extract<PageOutcome, { ok: true }>;
    return isChanged ? { state: 'changed', at: p.at, gone: [] } : { state: 'confirmed', at: p.at };
  };
  const rows = new Map<string, RowState>();
  for (const r of ledger.rows) rows.set(r.id, state([r.url, ...(r.alsoUrl && r.alsoQuote ? [r.alsoUrl] : [])], changed.has(r.id)));
  const defs = new Map<string, RowState>();
  const changedDefs = new Set(rec.changedDefinitions);
  for (const d of ledger.definitions) defs.set(definitionKey(d), state([d.url], changedDefs.has(definitionKey(d))));
  return { how: 'record', pages: rec.pages, rows, definitions: defs };
}

// ── what the card says about the read ──────────────────────────────────

/** `YYYY-MM-DD HH:MM` (UTC) from an ISO time. */
export const minuteOf = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/** The pages read as this version knows them, of those requested. */
export function pagesCount(read: PageRead): { read: number; requested: number } {
  return { read: read.pages.filter((p) => p.ok).length, requested: read.pages.length };
}

/** The latest time a page was read in this run, or undefined when none was. */
export function lastReadAt(read: PageRead): string | undefined {
  return read.pages
    .filter((p): p is Extract<PageOutcome, { ok: true }> => p.ok)
    .map((p) => p.at)
    .sort()
    .at(-1);
}

/** Did this run read pages (a request, a directory, or a record of one)? `--offline` and a caller that did not read did not. */
export const readInThisRun = (read: PageRead) => read.how === 'network' || read.how === 'directory' || read.how === 'record';
