/**
 * The check 0.4.4, fix pass 1, ruling A4 (the filing's Amendment A): `pageWord` holds the page's own words on
 * DeepSeek's rows, checked on the saved page by the generator. No test here makes a network request: the pages
 * are the made-up set in tests/fixtures/pages-min/. Seen red once against the head before the fix (baca679).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER } from '../src/lifecycle-ledger.js';
import { quoteOn, pageTextOf } from '../src/ledger-check.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = join(PKG, 'tests/fixtures/pages-min');
const GEN = join(PKG, 'scripts/build-ledger.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'check-044-a4-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('A4 — DeepSeek’s rows: pageWord is a phrase of the page’s own sentence, checked on the saved page', () => {
  it('the bundled ledger: each DeepSeek row’s pageWord is inside the sentence the row quotes (a quote checked on its page)', () => {
    const ds = LEDGER.filter((r) => r.provider === 'deepseek');
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.filter((r) => r.pageWord !== '' && !r.quote.includes(r.pageWord)).map((r) => `${r.id}: ${r.pageWord}`)).toEqual([]);
  });

  const out = join(mkdtempSync(join(ROOT, 'gen-')), 'lifecycle-ledger.ts');
  const g = spawnSync(process.execPath, [GEN, '--pages', MIN, '--out', out], { encoding: 'utf8' });

  it('the made-up set’s ledger, as the generator writes it: each DeepSeek row’s pageWord is on the saved page', () => {
    expect(g.status, g.stderr).toBe(0);
    const rows = JSON.parse(/export const LEDGER: readonly LedgerRow\[\] = (\[[\s\S]*?\n\]);/.exec(readFileSync(out, 'utf8'))![1]!) as { id: string; provider: string; pageWord: string; quote: string }[];
    const page = pageTextOf('deepseek-updates.html', readFileSync(join(MIN, 'deepseek-updates.html'), 'utf8'));
    const ds = rows.filter((r) => r.provider === 'deepseek');
    expect(ds.map((r) => r.id).sort()).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
    expect(ds.filter((r) => !(r.pageWord === '' || (quoteOn(page, r.pageWord) && r.quote.includes(r.pageWord)))).map((r) => `${r.id}: ${r.pageWord}`)).toEqual([]);
  });

  it('a saved page that no longer carries the legacy phrase stops the build, and nothing is written', () => {
    const d = mkdtempSync(join(ROOT, 'pages-'));
    cpSync(MIN, d, { recursive: true });
    const f = join(d, 'deepseek-updates.html');
    const before = readFileSync(f, 'utf8');
    const after = before.replace('legacy API model names', 'older API model names');
    expect(after).not.toBe(before);
    writeFileSync(f, after);
    const o = join(mkdtempSync(join(ROOT, 'gen-')), 'lifecycle-ledger.ts');
    const r = spawnSync(process.execPath, [GEN, '--pages', d, '--out', o], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/deepseek: sentence not on deepseek-updates\.html/);
    expect(existsSync(o)).toBe(false);
  });
});
