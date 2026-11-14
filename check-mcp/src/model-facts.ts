import { LIBRARY_VERSION } from '@warmdrift/kgauto-compiler';
import { retirementFloorClause } from '@warmdrift/kgauto-compiler/profiles';
import { analyseModel } from './engine.js';
import { PROVIDER_NAME, LEDGER_READ_ON, PARTNER_NAME, GATEWAYS, partnerPage } from './lifecycle.js';

/**
 * One model id → what the provider's page says first (the lifecycle ledger,
 * then the catalog profile's providerLifecycle), then the catalog card.
 * Honest miss on an id in neither (s51).
 */
export function renderModelFacts(model: string): string {
  const a = analyseModel(model);
  const out: string[] = [];
  const looked = a.res.base !== model || (a.profile && a.canonical !== model) ? a.profile ? a.canonical : a.res.base : undefined;
  out.push(`# ${model}${looked ? ` (looked up as \`${looked}\`${a.res.steps.length ? `: ${a.res.steps.join(', ')}` : ''})` : ''}`);
  out.push('');

  if (a.row) {
    const r = a.row;
    const P = PROVIDER_NAME[r.provider];
    const dates = [
      r.announced ? `announced ${r.announced}` : '',
      r.shutdown ? `${r.word === 'deprecated' || r.word === 'legacy' || r.word === 'rerouted' ? 'shutdown / discontinuation date' : r.word} ${r.shutdown}` : '',
      // 0.4.1 (R5): on a model already shut down the floor is the page's earliest date, said in the past.
      r.shutdownFloor
        ? r.word === 'shut down'
          ? `the earliest shutdown date the page gave was ${r.shutdownFloor}`
          : `not before ${r.shutdownFloor}`
        : '',
    ].filter(Boolean);
    out.push(
      `- ${P}'s word: **${r.word}**${dates.length ? ` (${dates.join('; ')})` : ''}${r.replacement ? ` · replacement the page names: \`${r.replacement}\`` : ''}${r.routesTo ? ` · requests routed to: ${r.routesTo}` : ''}`,
    );
    out.push(`- source: ${r.url} (read ${r.readOn}) — “${r.quote.replace(/\s+/g, ' ').slice(0, 300)}”`);
    if (r.alsoUrl) out.push(`- also: ${r.alsoUrl} (read ${r.alsoReadOn}) — “${r.alsoQuote}”`);
    if (a.via) out.push(`- matched the dated snapshot \`${a.via}\` the page lists`);
    if (a.partner) {
      const page = partnerPage(a.partner, r.provider);
      const N = PARTNER_NAME[a.partner];
      // 0.4.1 (R3): a gateway form is not the provider's own API; the gateway MAY keep its own schedule.
      out.push(
        GATEWAYS.has(a.partner)
          ? `- this id form is ${N}'s, a gateway: ${P}'s word above is for ${P}'s own API, and ${N} may keep its own schedule${page ? ` (${page})` : ''}`
          : `- this id form is ${N}'s: ${P}'s word above is for ${P}'s own API, and ${N} runs its own schedule${page ? ` (${page})` : ''}`,
      );
    }
  }

  const p = a.profile;
  if (!p) {
    if (!a.row) {
      out.push(
        `\`${model}\` was not recognised: the check could not match it to the catalog (@warmdrift/kgauto-compiler ${LIBRARY_VERSION}) ` +
          `or to a provider's deprecation list, so it says nothing about its lifecycle, limits or price.`,
      );
    } else {
      out.push('- the catalog has no entry for this id, so its limits and price are not shown.');
    }
    out.push('');
    out.push(`_Catalog: @warmdrift/kgauto-compiler ${LIBRARY_VERSION}; deprecation pages read ${LEDGER_READ_ON}; bundled locally — this lookup made no network call._`);
    return out.join('\n');
  }

  const pl = p.providerLifecycle;
  if (!a.row) {
    out.push(
      pl
        ? `- ${PROVIDER_NAME[p.provider as keyof typeof PROVIDER_NAME] ?? p.provider}'s word: **${pl.status}** (model page, read ${pl.readOn})${retirementFloorClause({ retirementFloor: pl.retirementFloor, readOn: pl.readOn })}${pl.replacement ? ` · names \`${pl.replacement}\`` : ''} — ${pl.url}`
        : `- provider's word: no lifecycle page read for this model in this catalog`,
    );
  }
  out.push(
    `- the catalog's routing status: ${p.status} — the catalog's word for whether the model may lead a route, not the provider's`,
  );
  out.push(
    `- provider: ${p.provider}${p.verifiedAgainstDocs ? ` · prices and limits verified against provider docs ${p.verifiedAgainstDocs}` : ''}`,
  );
  out.push(`- price: $${p.costInputPer1m}/M input · $${p.costOutputPer1m}/M output`);
  out.push(`- limits: ${p.maxContextTokens.toLocaleString()} context · ${p.maxOutputTokens.toLocaleString()} max output`);
  out.push(
    `- tool definitions per call the catalog's router sends to it: ${p.maxTools === 0 ? 'none (the router’s own wire for this model sends no tools; that is not a limit of the model)' : `up to ${p.maxTools} (a routing default, not a provider-stated limit)`}`,
  );
  out.push(
    `- capabilities: parallel tool calls ${p.parallelToolCalls ? 'yes' : 'no (measured sequential calls)'} · structured output: ${p.structuredOutput} · streaming: ${p.streaming ? 'yes' : 'no'}`,
  );
  out.push(
    p.cliffs.length > 0
      ? `- known cliffs (executable in the kgauto compiler):\n${p.cliffs
          .map(
            (c) =>
              `  - ${c.metric.replaceAll('_', ' ')} ≥ ${c.threshold.toLocaleString()}${c.whenIntent ? ` on ${c.whenIntent}` : ''} → ${c.action.replaceAll('_', ' ')}`,
          )
          .join('\n')}`
      : p.probedLimits?.length
        ? '- known cliffs: none recorded — and see the probed limits below, which is why that is a finding rather than a blank'
        : '- known cliffs: none recorded (nothing measured here yet — kgauto does not invent one)',
  );
  // alpha.95 — measured NEGATIVES: a probed limit is the one claim here that a
  // general-purpose model cannot produce: it required running the call.
  if (p.probedLimits?.length) {
    out.push(
      `- probed limits (we ran the call; ${p.probedLimits.length === 1 ? 'this is a measurement' : 'these are measurements'}, not a spec sheet):\n${p.probedLimits
        .map(
          (l) =>
            `  - ${l.metric.replaceAll('_', ' ')} @ ${l.testedAt.toLocaleString()} → **${l.outcome}**. ${l.claim}${l.probeRunId ? ` (run ${l.probeRunId})` : ''}`,
        )
        .join('\n')}`,
    );
  }
  if (p.notes) out.push(`- notes: ${p.notes}`);
  out.push('');
  out.push(`_Catalog: @warmdrift/kgauto-compiler ${LIBRARY_VERSION}; deprecation pages read ${LEDGER_READ_ON}; bundled locally — this lookup made no network call._`);
  return out.join('\n');
}
