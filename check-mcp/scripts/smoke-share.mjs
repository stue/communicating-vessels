#!/usr/bin/env node
/**
 * smoke-share.mjs — the one real WRITE of --share, by its real verb (0.4.1, R7).
 *
 * Runs the built CLI (dist/bin.js — the artifact npx runs) with --share on a
 * minimal valid extract for a made-up project named `cv-smoke-<UTC timestamp>`,
 * and exits 0 only when the CLI confirms the endpoint's own `{ok: true, id}`
 * (the CLI prints its confirmation on that answer and on nothing less). It
 * prints the id, so the row can be found and read back.
 *
 * It writes ONE row to the share endpoint: the default is the production one
 * (https://kgauto-dashboard.vercel.app/api/check-submission). It is not part
 * of `npm test` or `npm run smoke`, and it is run on purpose, once, by the
 * seat. KGAUTO_SHARE_ENDPOINT_OVERRIDE points it elsewhere, as it does the CLI.
 *
 *   npm run build && node scripts/smoke-share.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../dist/bin.js');
const fail = (why) => {
  console.error(`❌ smoke-share: ${why}`);
  process.exit(1);
};

// G0 — the artifact under test is the one being shipped (s75).
const pkgVersion = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const { CHECK_VERSION } = await import(join(here, '../dist/index.js'));
if (CHECK_VERSION !== pkgVersion) fail(`dist is ${CHECK_VERSION}, package.json is ${pkgVersion}: run npm run build first`);
console.log(`✅ G0 dist version ${CHECK_VERSION} == package.json`);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const name = `cv-smoke-${stamp}`;
const dir = mkdtempSync(join(tmpdir(), 'cv-smoke-share-'));
const extractPath = join(dir, 'extract.json');
writeFileSync(
  extractPath,
  JSON.stringify({
    project: { name, description: 'made-up project for the --share smoke; no real code' },
    callSites: [{ id: 'smoke.ts:1', model: 'gpt-4o-mini', modelSelection: 'hardcoded', platform: 'provider-api' }],
  }),
);
const endpoint = process.env.KGAUTO_SHARE_ENDPOINT_OVERRIDE || 'https://kgauto-dashboard.vercel.app/api/check-submission';
console.log(`… posting project ${name} to ${endpoint}`);

let out;
try {
  out = execFileSync(process.execPath, [bin, '--extract', extractPath, '--share'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  fail(`the CLI exited ${e.status ?? '?'}: ${String(e.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}`);
}
if (!out.startsWith(`# Communicating Vessels — the check: ${name}`)) fail('the card did not print first');
const m = /\[--share\] Sent to (\S+) \(submission ([^)]+)\)\./.exec(out);
if (!m) fail('no confirmation line: the endpoint did not answer {ok: true, id}');
if (m[1] !== endpoint) fail(`confirmed a different destination: ${m[1]}`);
console.log(`✅ stored: project_name ${name}, id ${m[2]}`);
console.log(m[2]);
