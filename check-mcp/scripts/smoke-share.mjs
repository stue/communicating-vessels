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
 * 0.4.4 (R7): it cannot reach production by default. It writes ONE row:
 *   - to production (the CLI's own default endpoint, SHARE_ENDPOINT_DEFAULT in
 *     the build) only with `--production` on its command line, and then only
 *     when KGAUTO_SHARE_ENDPOINT_OVERRIDE is unset (the CLI is run without it);
 *   - else to KGAUTO_SHARE_ENDPOINT_OVERRIDE, which must then be set.
 * With neither it exits 1 with one sentence and makes no request; with both it
 * refuses the same way. It is not part of `npm test` or `npm run smoke`; the
 * production write is run on purpose, once, by the seat.
 *
 * 0.4.4 (R8): the temporary folder it makes is removed on success and on failure.
 *
 *   npm run build && KGAUTO_SHARE_ENDPOINT_OVERRIDE=http://127.0.0.1:<port>/… node scripts/smoke-share.mjs
 *   npm run build && node scripts/smoke-share.mjs --production        # the seat's one real write
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../dist/bin.js');
const production = process.argv.slice(2).includes('--production');
const override = process.env.KGAUTO_SHARE_ENDPOINT_OVERRIDE;

// R7: decided before anything is read, written or requested.
if (!production && !override) {
  console.error('smoke-share: no endpoint — pass --production to write one row to the production endpoint, or set KGAUTO_SHARE_ENDPOINT_OVERRIDE to another one; nothing was sent.');
  process.exit(1);
}
if (production && override) {
  console.error('smoke-share: --production and KGAUTO_SHARE_ENDPOINT_OVERRIDE name two endpoints — pass one of them; nothing was sent.');
  process.exit(1);
}

let dir;
// R8: whatever ends the run, the folder goes with it.
process.on('exit', () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const fail = (why) => {
  console.error(`❌ smoke-share: ${why}`);
  process.exit(1);
};

// G0 — the artifact under test is the one being shipped (s75).
const pkgVersion = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const { CHECK_VERSION, SHARE_ENDPOINT_DEFAULT } = await import(join(here, '../dist/index.js'));
if (CHECK_VERSION !== pkgVersion) fail(`dist is ${CHECK_VERSION}, package.json is ${pkgVersion}: run npm run build first`);
console.log(`✅ G0 dist version ${CHECK_VERSION} == package.json`);

const endpoint = production ? SHARE_ENDPOINT_DEFAULT : override;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const name = `cv-smoke-${stamp}`;
dir = mkdtempSync(join(tmpdir(), 'cv-smoke-share-'));
const extractPath = join(dir, 'extract.json');
writeFileSync(
  extractPath,
  JSON.stringify({
    project: { name, description: 'made-up project for the --share smoke; no real code' },
    callSites: [{ id: 'smoke.ts:1', model: 'gpt-4o-mini', modelSelection: 'hardcoded', platform: 'provider-api' }],
  }),
);
console.log(`… posting project ${name} to ${endpoint}`);

// --production: the CLI is run without the override, so its own default is the endpoint
const env = { ...process.env };
if (production) delete env.KGAUTO_SHARE_ENDPOINT_OVERRIDE;
let out;
try {
  out = execFileSync(process.execPath, [bin, '--extract', extractPath, '--share'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
} catch (e) {
  fail(`the CLI exited ${e.status ?? '?'}: ${String(e.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}`);
}
if (!out.startsWith(`# Communicating Vessels — the check: ${name}`)) fail('the card did not print first');
const m = /\[--share\] Sent to (\S+) \(submission ([^)]+)\)\./.exec(out);
if (!m) fail('no confirmation line: the endpoint did not answer {ok: true, id}');
if (m[1] !== endpoint) fail(`confirmed a different destination: ${m[1]}`);
console.log(`✅ stored: project_name ${name}, id ${m[2]}`);
console.log(m[2]);
