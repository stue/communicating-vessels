import { LIBRARY_VERSION } from '@warmdrift/kgauto-compiler';
import { retirementFloorClause } from '@warmdrift/kgauto-compiler/profiles';
import { analyseModel, rowStateIn, daysSinceRead, pageLineQuote } from './engine.js';
import { PROVIDER_NAME, LEDGER_READ_ON, PARTNER_NAME, GATEWAYS, partnerPage, pageName, pagesName } from './lifecycle.js';
import { unreadAll, NOT_READ_BY_CALLER, readInThisRun, pagesCount, lastReadAt, minuteOf, type PageRead } from './pages.js';

/** Amendment B4: "n days before this lookup", said as the card says it — "the day of this lookup" at 0, "1 day" at 1. */
function daysBeforeLookup(today: string, readOn: string): string {
  const n = daysSinceRead(today, readOn);
  return n <= 0 ? 'the day of this lookup' : `${n} day${n === 1 ? '' : 's'} before this lookup`;
}

/** 0.4.3 (R1/R2): the lookup's last line — the catalog, and the pages as this run read them (or did not). */
function factsFooter(read: PageRead, surface: 'cli' | 'mcp'): string {
  const cat = `_Catalog: @warmdrift/kgauto-compiler ${LIBRARY_VERSION}, bundled; deprecation pages bundled ${LEDGER_READ_ON}`;
  if (readInThisRun(read)) {
    const { read: n, requested: m } = pagesCount(read);
    const last = lastReadAt(read);
    return `${cat}; ${n} of ${m} provider pages read in this run${last ? ` (${minuteOf(last)} UTC)` : ''} — the same ${m} public pages whatever the id. Nothing about the id was sent anywhere._`;
  }
  if (read.how === 'switched-off')
    return `${cat}; this lookup made no network request (${surface === 'mcp' ? 'the offline input' : '--offline'})._`;
  return `${cat}; no provider page was read for this lookup._`;
}

/**
 * One model id → what the provider's page says first (the lifecycle ledger,
 * then the catalog profile's providerLifecycle), then the catalog card.
 * Honest miss on an id in neither (s51).
 *
 * 0.4.3 (R1/R2): the provider's line says when its page was read — in this run, or on the day this
 * version read it and why it was not read now, or that the page has changed since.
 */
export function renderModelFacts(model: string, opts: { pages?: PageRead; surface?: 'cli' | 'mcp'; today?: string } = {}): string {
  const read = opts.pages ?? unreadAll('none', NOT_READ_BY_CALLER);
  const surface = opts.surface ?? 'cli';
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const a = analyseModel(model, { pages: read, today });
  const out: string[] = [];
  const looked = a.res.base !== model || (a.profile && a.canonical !== model) ? a.profile ? a.canonical : a.res.base : undefined;
  out.push(`# ${model}${looked ? ` (looked up as \`${looked}\`${a.res.steps.length ? `: ${a.res.steps.join(', ')}` : ''})` : ''}`);
  out.push('');
  // 0.4.5 (R5): a fine-tune is looked up by its base, for lifecycle only; the card's own line says it the same way
  if (a.fineTuneOf) {
    out.push(`- read as a fine-tune of \`${a.fineTuneOf}\`, by this check's reading of the id: what follows is the base model's, and limits and price are not looked up for a fine-tune`);
    for (const l of a.lines) out.push(`- ${l.title} — ${l.detail}`);
    out.push('');
    out.push(factsFooter(read, surface));
    return out.join('\n');
  }

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
    // 0.4.2 Amendment A2: a replacement cell that is not a plain list of ids is quoted, never named.
    const repl = r.replacement
      ? r.replacementForm
        ? ` · replacement, in the page’s words: “${r.replacement}”`
        : ` · replacement the page names: \`${r.replacement}\``
      : '';
    out.push(
      r.namedAs
        ? // 0.4.3 (R6): the changelog names the model in words; the link from the id to the name is this check's (Amendment B4).
          // 0.4.4 (R6): the page by its own title (Google's is "Release notes").
          `- ${pageName(r.provider, r.url)}, by this check's reading of the id as ${r.namedAs}: **${r.pageWord}** (${r.entryHeading}) — the page names the model in words, not by this id, so the link is this check's`
        : r.word === 'listed'
          ? // 0.4.2 Amendment A1: listed on the page with no date and no deprecation word, in the page's own words.
            `- ${pageName(r.provider, r.url)} lists it: **${r.pageWord.charAt(0).toLowerCase()}${r.pageWord.slice(1)}**${repl}`
          : `- ${P}'s word: **${r.word}**${dates.length ? ` (${dates.join('; ')})` : ''}${repl}${r.routesTo ? ` · requests routed to: ${r.routesTo}` : ''}`,
    );
    // 0.4.3 (R2): when the page was read, in the line.
    const st = rowStateIn(read, r.id);
    // 0.4.4 (R4): when one of the row's pages was read in this run and another was not, the line names the one not read
    const partly = st.state === 'unread' && (st.read?.length ?? 0) > 0;
    const when =
      st.state === 'confirmed'
        ? `read in this run, ${minuteOf(st.at)} UTC`
        : st.state === 'changed'
          ? `read ${r.readOn}; the page has changed since — it no longer carries this line as it was read, so read the page before acting on the date`
          : partly
            ? `read in this run, ${minuteOf(st.read!.map((x) => x.at).sort().at(-1)!)} UTC; ${pagesName(r.provider, (st.notRead ?? []).map((n) => n.url))} not read in this run (${st.reason}), as read ${r.readOn}, ${daysBeforeLookup(today, r.readOn)}`
            : `read ${r.readOn}, ${daysBeforeLookup(today, r.readOn)}; not read in this run (${st.reason})`;
    // 0.4.4 (R2): the quote as the card prints it — never cut inside a word or an id (until 0.4.3: `.slice(0, 300)`)
    out.push(`- source: ${r.url} (${when}) — “${pageLineQuote(r)}”`);
    if (r.alsoUrl) out.push(`- also: ${r.alsoUrl}${r.alsoHeading ? ` (${r.alsoHeading})` : ` (read ${r.alsoReadOn})`} — “${r.alsoQuote}”`);
    if (r.modelPage?.status === 404) out.push(`- ${P}'s model page for this id answered 404 on ${r.modelPage.at.slice(0, 10)} (${r.modelPage.url})`);
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
    out.push(factsFooter(read, surface));
    return out.join('\n');
  }

  const pl = p.providerLifecycle;
  // 0.4.5: an Active row (Anthropic's status table) keeps the model page's word beside it, as a listed row does
  if (!a.row || a.row.word === 'listed' || a.row.word === 'active') {
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
    `- capabilities: parallel tool calls ${p.parallelToolCalls ? 'yes' : 'no (the catalog records sequential calls)'} · structured output: ${p.structuredOutput} · streaming: ${p.streaming ? 'yes' : 'no'}`,
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
  out.push(factsFooter(read, surface));
  return out.join('\n');
}
