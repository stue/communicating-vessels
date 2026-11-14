#!/usr/bin/env node
/**
 * Print the lifecycle ledger's rows per provider (from the built dist/).
 *   node scripts/ledger-rows.mjs            # counts per provider and per word, with each source page
 *   node scripts/ledger-rows.mjs --rows     # every row: provider | id | word | date | replacement | url
 *   node scripts/ledger-rows.mjs --provider google --rows
 */
import { LEDGER, LEDGER_SOURCES } from '../dist/index.js';

const args = process.argv.slice(2);
const only = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : undefined;
const rows = LEDGER.filter((r) => !only || r.provider === only);

const by = new Map();
for (const r of rows) {
  const m = by.get(r.provider) ?? new Map();
  m.set(r.word, (m.get(r.word) ?? 0) + 1);
  by.set(r.provider, m);
}
for (const [p, m] of by) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`${p}: ${total} rows (${[...m].map(([w, n]) => `${w} ${n}`).join(', ')})`);
  for (const s of LEDGER_SOURCES.filter((s) => s.provider === p)) console.log(`  read ${s.readAt}  ${s.url}  sha256 ${s.sha256.slice(0, 12)}`);
}
console.log(`total: ${rows.length}`);
if (args.includes('--rows')) {
  for (const r of rows)
    console.log([r.provider, r.id, r.word, r.shutdown ?? r.shutdownFloor ?? '', r.replacement ?? '', r.url].join(' | '));
}
