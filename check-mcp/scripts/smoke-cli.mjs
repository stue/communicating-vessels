#!/usr/bin/env node
/**
 * Real-verb smoke for the pure-CLI check (dist/bin.js — the artifact npx
 * runs, not src). Gates fail-closed; exit 1 names the failing gate.
 * The live --share write is smoked separately (scripts/smoke-share.mjs)
 * because it needs the deployed endpoint; here --share is exercised on its
 * FAILURE path (unreachable endpoint must not corrupt the check output).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../dist/bin.js');

const gates = [];
const gate = (name, ok, detail = '') => {
  gates.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    console.log(`\n${gates.filter((g) => g.ok).length}/${gates.length} gates green`);
    process.exit(1);
  }
};
const run = (cliArgs, opts = {}) => {
  try {
    return { out: execFileSync(process.execPath, [bin, ...cliArgs], { encoding: 'utf8', ...opts }), code: 0, err: '' };
  } catch (e) {
    return { out: String(e.stdout ?? ''), code: e.status ?? 1, err: String(e.stderr ?? '') };
  }
};

const dir = mkdtempSync(join(tmpdir(), 'kgauto-check-smoke-'));
const extractPath = join(dir, 'extract.json');
writeFileSync(
  extractPath,
  JSON.stringify({
    project: { name: 'smoke-app' },
    callSites: [
      { id: 's1', model: 'deepseek-chat', platform: 'provider-api', archetype: 'summarize', estInputTokens: 9000, estOutputTokens: 500, retry: 'none' },
    ],
  }),
);

// G1 — the card, from the real bundled roster
const card = run(['--extract', extractPath]);
gate('G1 --extract prints the card', card.code === 0 && card.out.startsWith('# Communicating Vessels — the check: smoke-app'));
const readLine = /It read (\d+) of (\d+) provider pages in this run — the same \2 public pages whatever your project holds\. Nothing about your project was sent anywhere/.exec(card.out);
gate('G1b card says what this run read and that nothing about the project was sent (0.4.3, R2)', !!readLine, readLine ? `${readLine[1]} of ${readLine[2]} pages read` : 'no read sentence');
gate('G1c real-roster finding fired (deepseek-chat: the page\'s word, not a compat alias)', /legacy name DeepSeek said it would discontinue/.test(card.out) && !/compat alias/.test(card.out));
gate('G1d confidence tiers present', card.out.includes('## Certain') && card.out.includes('## Only measurable'));
gate('G1e version stamp in the footer', /@warmdrift\/kgauto-check \d+\.\d+\.\d+ · catalog @warmdrift\/kgauto-compiler \d/.test(card.out));

// G1f/G1g — 0.4.3 (R1): --offline makes no request and says so; --pages without read-times.json is refused
const off = run(['--extract', extractPath, '--offline']);
gate('G1f --offline: the card says no network request was made, and no provider line is Certain', off.code === 0 && /made no network request \(--offline\)/.test(off.out) && !/## Certain[\s\S]*own API[\s\S]*## Likely/.test(off.out));
const noTimes = mkdtempSync(join(tmpdir(), 'kgauto-check-pages-'));
const refused = run(['--extract', extractPath, '--pages', noTimes]);
gate('G1g --pages <dir> without read-times.json is refused, exit 1', refused.code === 1 && /no read-times\.json/.test(refused.err));
const both = run(['--extract', extractPath, '--pages', noTimes, '--offline']);
gate('G1h --pages and --offline together are refused, exit 1', both.code === 1 && /pass one of them/.test(both.err));

// G2 — contract + plans
gate('G2 --extract-contract teaches extraction + privacy', /identifiers and counts ONLY/i.test(run(['--extract-contract']).out));
gate('G2b contract offers --share (and share_card) as explicit opt-in only', /Never add --share or call share_card without their explicit yes/.test(run(['--extract-contract']).out));
const plan = run(['--observe-plan']).out;
gate('G3 --observe-plan carries both honesty requirements', /Destination, named before/.test(plan) && /never intervenes/.test(plan));

// G4 — model facts
gate('G4 --model-facts on a real model', /provider: anthropic/.test(run(['--model-facts', 'claude-sonnet-5']).out));
gate('G4b honest miss on unknown model', /not recognised/.test(run(['--model-facts', 'not-a-model-xyz']).out));
const retiredFacts = run(['--model-facts', 'claude-sonnet-4-20250514']).out;
gate('G4c --model-facts prints retired with Anthropic\'s page beside it', /\*\*retired\*\*/.test(retiredFacts) && /platform\.claude\.com\/docs\/en\/about-claude\/model-deprecations/.test(retiredFacts));

// G5 — error paths
const missing = run(['--extract', join(dir, 'missing.json')]);
gate('G5 missing file exits 1 with a usable error', missing.code === 1 && /could not read/.test(missing.err));
writeFileSync(join(dir, 'bad.json'), JSON.stringify({ project: { name: 'x' } }));
const bad = run(['--extract', join(dir, 'bad.json')]);
gate('G5b invalid extract (no callSites array) exits 1 naming the contract', bad.code === 1 && /does not match the contract/.test(bad.err));
writeFileSync(join(dir, 'none.json'), JSON.stringify({ project: { name: 'x' }, callSites: [] }));
const none = run(['--extract', join(dir, 'none.json')]);
gate('G5d zero call sites and no model id: a card that says there is nothing to check (R5)', none.code === 0 && /nothing to check/.test(none.out));
const badflag = run(['--wat']);
gate('G5c unknown flag prints usage, exit 1 (no accidental server start)', badflag.code === 1 && /usage:/.test(badflag.err));

// G6 — --share failure path: unreachable endpoint must not corrupt the card
const share = run(['--extract', extractPath, '--share'], {
  env: { ...process.env, KGAUTO_SHARE_ENDPOINT_OVERRIDE: 'http://127.0.0.1:9' },
});
gate('G6 --share failure still prints the full card first', share.out.startsWith('# Communicating Vessels — the check: smoke-app'));
gate('G6b --share failure is loud (FAILED + no row confirmed) and exits 1', share.code === 1 && /\[--share\] FAILED/.test(share.err) && /did not confirm a row, so a row may or may not exist/.test(share.err));
gate('G6c a --share card does not say nothing was sent, and ends on the share sentence', !/Nothing was uploaded|Nothing about your project was sent/.test(share.out) && /Because you ran it with --share, this card and the extract are sent after it is printed\.\*/.test(share.out));

console.log(`\n${gates.length}/${gates.length} gates green`);
