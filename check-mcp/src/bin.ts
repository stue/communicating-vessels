#!/usr/bin/env node
/**
 * kgauto-check — two modes, one bin (final shape ruled 2026-08-25, Sacha s89):
 *
 * CLI one-shots (rung 1 — the page-pushed route, zero install):
 *   --extract <file> [--share]  run the check on an extract, print the card.
 *                               --share (EXPLICIT opt-in — agents: offer it,
 *                               never add it without your human's yes) also
 *                               posts the extract + card; the row stored is
 *                               named in share.ts (SHARE_STORED_SENTENCE).
 *                               Without it, nothing about the project leaves
 *                               the machine.
 *   --extract-contract          print the extraction instructions.
 *   --model-facts <model-id>    one model → the provider's word, verified
 *                               prices, limits, known cliffs.
 *   --observe-plan              rung 2: what a one-day observe run measures.
 *
 *   0.4.3 (R1): --extract and --model-facts read the providers' pages in this
 *   run — the same public pages whatever the extract holds (src/pages.ts).
 *   --offline (or KGAUTO_CHECK_OFFLINE=1) makes no request; --pages <dir>
 *   reads them from a directory saved by `scripts/ledger-drift.mjs --fetch`
 *   (tests, the Verifier, the regression set).
 *
 * MCP server (no args — the relationship route: agent-OFFERED after a card
 * with real findings, never page-pushed; also the no-shell/Desktop host).
 * The tool surface is additive since 0.1.0: no tool removed or renamed
 * (0.4.3 added share_card) — it is a compatibility contract.
 */
import { readFileSync } from 'node:fs';
import { startStdio } from './server.js';
import { ExtractSchema } from './extract.js';
import { runCheck } from './engine.js';
import { START_CHECK_INSTRUCTIONS, USAGE } from './instructions.js';
import { OBSERVE_DAY_PLAN } from './observe-plan.js';
import { renderModelFacts } from './model-facts.js';
import { CHECK_VERSION } from './version.js';
import { readForRun, type PageRead } from './pages.js';
import { SHARE_ENDPOINT_DEFAULT, postShare, shareConfirmation, shareFailure } from './share.js';

const SHARE_ENDPOINT = process.env.KGAUTO_SHARE_ENDPOINT_OVERRIDE || SHARE_ENDPOINT_DEFAULT;

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** --offline / --pages <dir>, read once before the engine runs; undefined after printing a usage error. */
async function readPages(): Promise<PageRead | undefined> {
  const noRead = args.includes('--offline');
  const hasPages = args.includes('--pages');
  const dir = flagValue('--pages');
  if (hasPages && (!dir || dir.startsWith('--'))) {
    console.error('usage: --pages <dir> (a directory saved by scripts/ledger-drift.mjs --fetch, with its read-times.json)');
    process.exitCode = 1;
    return undefined;
  }
  if (noRead && hasPages) {
    console.error('--offline and --pages both say where the pages come from; pass one of them.');
    process.exitCode = 1;
    return undefined;
  }
  try {
    return await readForRun({ switchedOff: noRead, pagesDir: dir });
  } catch (err) {
    console.error(`could not read the pages: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return undefined;
  }
}

async function main(): Promise<void> {
  if (args.includes('--extract-contract')) {
    console.log(START_CHECK_INSTRUCTIONS);
    return;
  }
  if (args.includes('--observe-plan')) {
    console.log(OBSERVE_DAY_PLAN);
    return;
  }
  if (args.includes('--model-facts')) {
    const id = flagValue('--model-facts');
    if (!id || id.startsWith('--')) {
      console.error('usage: kgauto-check --model-facts <model-id> [--offline]');
      process.exitCode = 1;
      return;
    }
    const pages = await readPages();
    if (!pages) return;
    console.log(renderModelFacts(id, { pages }));
    return;
  }
  if (args.includes('--extract')) {
    const file = flagValue('--extract');
    if (!file || file.startsWith('--')) {
      console.error('usage: kgauto-check --extract <extract.json> [--share] [--offline]');
      process.exitCode = 1;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const parsed = ExtractSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('extract does not match the contract (run --extract-contract for the spec):');
      for (const issue of parsed.error.issues.slice(0, 10)) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    const pages = await readPages();
    if (!pages) return;
    // Amendment B3: a card that will be sent says so in its footer (and is the card that is stored).
    const result = runCheck(parsed.data, { share: args.includes('--share'), pages });
    console.log(result.card);

    if (args.includes('--share')) {
      // 0.4.1 (R7): success is the endpoint's own {ok: true, id}; the confirmation lists the stored fields.
      const out = await postShare(SHARE_ENDPOINT, {
        extract: parsed.data,
        card: result.card,
        check_version: CHECK_VERSION,
        catalog_version: result.catalogVersion,
      });
      if (out.ok) {
        console.log(`\n${shareConfirmation(SHARE_ENDPOINT, out.id)}`);
      } else {
        console.error(`\n${shareFailure(out.reason)}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (args.length === 0) {
    await startStdio();
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('kgauto-check failed:', err);
  process.exit(1);
});
