#!/usr/bin/env node
/**
 * Real-verb smoke: spawn the built stdio server (dist/bin.mjs — the artifact
 * npx will run, not src) and drive it over JSON-RPC exactly like an MCP
 * client: initialize → tools/list → start_check → run_check → get_model_facts.
 * Gates fail-closed; exit 1 names the failing gate.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../dist/bin.js');

const child = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const gates = [];
const gate = (name, ok, detail = '') => {
  gates.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) finish(1);
};
function finish(code) {
  child.kill();
  console.log(`\n${gates.filter((g) => g.ok).length}/${gates.length} gates green`);
  process.exit(code);
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' },
});
gate('G1 initialize', init?.serverInfo?.name === 'kgauto-check', `server=${init?.serverInfo?.name}@${init?.serverInfo?.version}`);
gate('G1b instructions carry the privacy contract', /Nothing was uploaded/.test(init?.instructions ?? ''));
notify('notifications/initialized', {});

const tools = await rpc('tools/list', {});
const names = (tools?.tools ?? []).map((t) => t.name).sort();
gate(
  'G2 tools/list = the 4-tool surface',
  JSON.stringify(names) ===
    JSON.stringify(['get_model_facts', 'get_observe_day_plan', 'run_check', 'start_check']),
  names.join(', '),
);

const start = await rpc('tools/call', { name: 'start_check', arguments: {} });
gate('G3 start_check teaches extraction + privacy', /identifiers and counts ONLY/i.test(start?.content?.[0]?.text ?? ''));

const run = await rpc('tools/call', {
  name: 'run_check',
  arguments: {
    extract: {
      project: { name: 'smoke-app' },
      callSites: [
        {
          id: 'api/hunt.ts:10',
          model: 'deepseek-v4-flash',
          platform: 'provider-api',
          archetype: 'hunt',
          usesParallelToolCalls: true,
          toolCount: 12,
          estInputTokens: 40_000,
          estOutputTokens: 800,
          retry: 'none',
        },
      ],
    },
  },
});
const card = run?.content?.[0]?.text ?? '';
gate('G4 run_check returns a card', card.startsWith('# Communicating Vessels — the check: smoke-app'));
gate('G4b card carries the destination sentence', card.includes('Nothing was uploaded'));
gate('G4c real-roster finding fired (deepseek-v4-flash retired by DeepSeek, from the ledger)', /On DeepSeek's own API, `deepseek-v4-flash` was retired/.test(card));
gate('G4d confidence tiers present', card.includes('## Certain') && card.includes('## Only measurable'));

const bad = await rpc('tools/call', {
  name: 'run_check',
  arguments: { extract: { project: { name: 'x' } } },
});
gate('G5 invalid extract (no callSites array) is rejected, not crashed', bad?.isError === true);
const empty = await rpc('tools/call', {
  name: 'run_check',
  arguments: { extract: { project: { name: 'x' }, callSites: [], models: [{ model: 'gpt-4o', where: 'src/models.ts:3' }] } },
});
gate('G5b zero call sites + a model id gets a card (R5)', /No call site was found/.test(empty?.content?.[0]?.text ?? '') && /On OpenAI's own API, `gpt-4o` is deprecated/.test(empty?.content?.[0]?.text ?? ''));

const facts = await rpc('tools/call', { name: 'get_model_facts', arguments: { model: 'claude-sonnet-5' } });
gate('G6 get_model_facts on a real model', /provider: anthropic/.test(facts?.content?.[0]?.text ?? ''));
const retired = await rpc('tools/call', { name: 'get_model_facts', arguments: { model: 'claude-sonnet-4-20250514' } });
gate('G6c get_model_facts says retired with Anthropic\'s page', /\*\*retired\*\*/.test(retired?.content?.[0]?.text ?? '') && /model-deprecations/.test(retired?.content?.[0]?.text ?? ''));
const miss = await rpc('tools/call', { name: 'get_model_facts', arguments: { model: 'not-a-model-xyz' } });
gate('G6b honest miss on unknown model', /not recognised/.test(miss?.content?.[0]?.text ?? ''));

const plan = await rpc('tools/call', { name: 'get_observe_day_plan', arguments: {} });
const planText = plan?.content?.[0]?.text ?? '';
gate('G7 observe plan carries both honesty requirements', /Destination, named before/.test(planText) && /never intervenes/.test(planText));

// ── G8: one-shot mode (the zero-install agent path) ────────────────────
const { execFileSync } = await import('node:child_process');
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const dir = mkdtempSync(join(tmpdir(), 'kgauto-check-smoke-'));
const extractPath = join(dir, 'extract.json');
writeFileSync(
  extractPath,
  JSON.stringify({
    project: { name: 'oneshot-app' },
    callSites: [{ id: 's1', model: 'deepseek-chat', platform: 'provider-api', archetype: 'summarize', estInputTokens: 9000, estOutputTokens: 500, retry: 'none' }],
  }),
);
const oneshotOut = execFileSync(process.execPath, [bin, '--extract', extractPath], { encoding: 'utf8' });
gate('G8 one-shot --extract prints the card', oneshotOut.startsWith('# Communicating Vessels — the check: oneshot-app') && oneshotOut.includes('Nothing was uploaded'));
gate('G8b one-shot says what DeepSeek\'s page says of deepseek-chat (legacy, 2026-07-24), no alias claim', /legacy name DeepSeek said it would discontinue on 2026-07-24/.test(oneshotOut) && !/compat alias/.test(oneshotOut));
let badExit = 0;
let badErr = '';
try {
  execFileSync(process.execPath, [bin, '--extract', extractPath.replace('extract.json', 'missing.json')], { encoding: 'utf8' });
} catch (e) {
  badExit = e.status;
  badErr = String(e.stderr);
}
gate('G8c one-shot on a missing file exits 1 with a usable error', badExit === 1 && /could not read/.test(badErr));
const contractOut = execFileSync(process.execPath, [bin, '--extract-contract'], { encoding: 'utf8' });
gate('G8d --extract-contract prints the extraction instructions', /identifiers and counts ONLY/i.test(contractOut));

finish(0);
