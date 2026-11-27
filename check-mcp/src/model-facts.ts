import { LIBRARY_VERSION } from '@warmdrift/kgauto-compiler';
import { retirementFloorClause } from '@warmdrift/kgauto-compiler/profiles';
import { analyseModel, rowStateIn, definitionStateIn, daysSinceRead, pageLineQuote, printedText, idSpans, platformSentences, noticeQuoted, LOWER_CASE_STEP } from './engine.js';
import { noticeHolds, sentenceAround } from './ledger-check.mjs';
import type { LedgerRow } from './lifecycle-types.js';
import { PROVIDER_NAME, LEDGER_READ_ON, PARTNER_NAME, GATEWAYS, partnerPage, pageName, pagesName, WORD_DEFINITION } from './lifecycle.js';
import { unreadAll, NOT_READ_BY_CALLER, readInThisRun, pagesCount, lastReadAt, minuteOf, type PageRead, type RowState } from './pages.js';

/** Amendment B4: "n days before this lookup", said as the card says it — "the day of this lookup" at 0, "1 day" at 1. */
function daysBeforeLookup(today: string, readOn: string): string {
  const n = daysSinceRead(today, readOn);
  return n <= 0 ? 'the day of this lookup' : `${n} day${n === 1 ? '' : 's'} before this lookup`;
}

/** 0.4.6 (R7): a probed limit's route in words: `direct`, or a gateway with the provider it was served by (`openrouter:baidu`). */
function routeWords(route: string): string {
  if (route === 'direct') return "on the provider's own API";
  const [gw, by] = route.split(':');
  const name = gw === 'openrouter' ? 'OpenRouter' : gw;
  return by ? `through ${name}, served by ${by}` : `through ${name}`;
}

/**
 * 0.4.6 (R7): when a row's second page was read, in the words of the source line: in this run (and whether it still
 * carries the line), or the day this version read it and why it was not read in this run.
 */
function alsoWhen(st: RowState, url: string, readOn: string, today: string): string {
  const read = st.read?.find((x) => x.url === url);
  if (read)
    return read.stands
      ? `read in this run, ${minuteOf(read.at)} UTC`
      : `read ${readOn}; the page has changed since — it no longer carries this line as it was read, so read the page before acting on it`;
  const notRead = st.state === 'unread' ? (st.notRead?.find((x) => x.url === url)?.reason ?? st.reason) : undefined;
  return notRead ? `read ${readOn}, ${daysBeforeLookup(today, readOn)}; not read in this run (${notRead})` : `read ${readOn}`;
}

/**
 * 0.4.6 Amendment B3: how the id was looked up, after "(looked up as `x`". Matched only in lower case: ", the lower-case
 * form of the id as written"; with other steps too, those steps are said as worked on that form.
 */
function lookupHow(steps: readonly string[]): string {
  const others = steps.filter((s) => s !== LOWER_CASE_STEP);
  if (others.length === steps.length) return steps.length ? `: ${steps.join(', ')}` : '';
  return others.length ? `: in ${LOWER_CASE_STEP}, ${others.join(', ')}` : `, ${LOWER_CASE_STEP}`;
}

/**
 * 0.4.7 (R6, Amendment A8): the row's word, said as whose it is. The page's own status word stays "<provider>'s word";
 * a word this check read from the page's date (`wordBy: 'date'`) is said as this check's reading of the date; where the
 * page gives no status word (`wordBy: 'ours'`) the line says so, or gives the page's own words where it has some
 * ("will be shut down", a replacement cell that routes requests). Until 0.4.7 every one printed as "<provider>'s word".
 */
function wordWords(r: LedgerRow, P: string): string {
  if (r.wordBy === 'date') return `this check's word, read from the date on ${pageName(r.provider, r.url)}: **${r.word}**`;
  if (r.wordBy === 'ours')
    return r.pageWord
      ? `${pageName(r.provider, r.pageWordUrl ?? r.url)}, in its own words: “${printedText(r.pageWord)}”`
      : `${pageName(r.provider, r.url)}: a shutdown date and no status word on the page`;
  return `${P}'s word: **${r.word}**`;
}

/**
 * 0.4.8 (R4): where the notice quoted above the price says the requests are billed at another model's rates, the price line
 * says whose figure it shows, then quotes the notice's own sentence; the routed model's price follows only when the catalog
 * holds that model, labelled as the catalog's figure. '' for every other row, and when the notice is not quoted.
 */
function billedAt(row: LedgerRow | undefined, noticeShown: boolean): string {
  if (!noticeShown || !row?.notice || !row.routesTo) return '';
  const flatNotice = row.notice.replace(/\s+/g, ' ');
  const at = flatNotice.search(/\bbilled at\b/);
  if (at === -1) return '';
  const sentence = sentenceAround(flatNotice, at, 'billed at'.length);
  // the routed model's own catalog entry, found under its own id (never a near match)
  const routed = analyseModel(row.routesTo);
  const to = routed.canonical === row.routesTo ? routed.profile : undefined;
  const toPrice = to ?` · the catalog's figure for \`${row.routesTo}\`: $${to.costInputPer1m}/M input · $${to.costOutputPer1m}/M output` : '';
  return ` (the catalog's figure for this id); the notice quoted above says: “${printedText(sentence)}”${toPrice}`;
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
  /** 0.4.8 (R4): set when the source line quotes the notice above the row. */
  let noticeShown = false;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const a = analyseModel(model, { pages: read, today });
  const out: string[] = [];
  const looked = a.res.base !== model || (a.profile && a.canonical !== model) ? a.profile ? a.canonical : a.res.base : undefined;
  out.push(`# ${model}${looked ? ` (looked up as \`${looked}\`${lookupHow(a.res.steps)})` : ''}`);
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
        : ` · replacement the page names: ${idSpans(r.replacement)}` // Amendment B5: one span per id
      : '';
    out.push(
      r.namedAs
        ? // 0.4.3 (R6): the changelog names the model in words; the link from the id to the name is this check's (Amendment B4).
          // 0.4.4 (R6): the page by its own title (Google's is "Release notes").
          `- ${pageName(r.provider, r.url)}, by this check's reading of the id as ${r.namedAs}: **${r.pageWord ?? r.quote}** (${r.entryHeading}) — the page names the model in words, not by this id, so the link is this check's`
        : r.word === 'listed' && r.pageWord
          ? // 0.4.2 Amendment A1: listed on the page with no date and no deprecation word, in the page's own words.
            `- ${pageName(r.provider, r.url)} lists it: **${r.pageWord.charAt(0).toLowerCase()}${r.pageWord.slice(1)}**${repl}`
          : `- ${wordWords(r, P)}${dates.length ? ` (${dates.join('; ')})` : ''}${repl}${r.routesTo ? ` · requests routed to: ${r.routesTo}` : ''}`,
    );
    // 0.4.7, fix pass 1: a Google row under "Deprecated models" / "Deprecated agents" has *shut down* as Google's own word, by
    // the page's sentence, quoted where it is on the page as read (never a changed one)
    const already = WORD_DEFINITION.google?.['already-shutdown sections'];
    if (
      already &&
      r.provider === 'google' &&
      r.word === 'shut down' &&
      /^Deprecated (models|agents)$/.test(r.section?.split(' › ')[1] ?? '') &&
      definitionStateIn(read, { provider: 'google', word: 'already-shutdown sections' }).state !== 'changed'
    )
      out.push(`- ${pageName(r.provider, r.url)}: “${printedText(already)}”`);
    // 0.4.3 (R2): when the page was read, in the line.
    const st = rowStateIn(read, r.id);
    // 0.4.4 (R4): when one of the row's pages was read in this run and another was not, the line names the one not read
    const partly = st.state === 'unread' && (st.read?.length ?? 0) > 0;
    // 0.4.8 (R4, R5): the notice above the row is quoted as the card quotes it; one no longer on the page is not, and is said
    noticeShown = noticeQuoted(r, st);
    const noticeGone = st.state === 'changed' && st.gone.length > 0 && st.gone.every((g) => g.what === 'notice');
    const when =
      st.state === 'confirmed'
        ? `read in this run, ${minuteOf(st.at)} UTC`
        : noticeGone
          ? `read ${r.readOn}; the page has changed since — it no longer carries the notice above this row as it was read, so read the page before acting on the date`
          : st.state === 'changed'
          ? `read ${r.readOn}; the page has changed since — it no longer carries this line as it was read, so read the page before acting on the date`
          : partly
            ? `read in this run, ${minuteOf(st.read!.map((x) => x.at).sort().at(-1)!)} UTC; ${pagesName(r.provider, (st.notRead ?? []).map((n) => n.url))} not read in this run (${st.reason}), as read ${r.readOn}, ${daysBeforeLookup(today, r.readOn)}`
            : `read ${r.readOn}, ${daysBeforeLookup(today, r.readOn)}; not read in this run (${st.reason})`;
    // 0.4.4 (R2): the quote as the card prints it — never cut inside a word or an id (until 0.4.3: `.slice(0, 300)`)
    out.push(
      noticeShown
        ? `- source: ${r.url} (${when}) — the page's notice above the row: “${printedText(r.notice!)}”${noticeHolds(r.notice!, r) ? '' : ` · the page's line: “${pageLineQuote(r)}”`}`
        : `- source: ${r.url} (${when}) — “${pageLineQuote(r)}”`,
    );
    // 0.4.6 (R7): a second page says when it was read, as the source line does — in this run, or the day it was read and
    // why it was not read now (until 0.4.6: "(read <day>)" whatever this run read, so a page that answered 404 was not said)
    if (r.alsoUrl) {
      const also = r.alsoUrl !== r.url ? alsoWhen(st, r.alsoUrl, r.alsoReadOn ?? r.readOn, today) : undefined;
      // 0.4.7 (R2): the second page's sentence as the card prints it (links reduced to their text, bold's marks removed)
      out.push(`- also: ${r.alsoUrl}${r.alsoHeading ? ` (${r.alsoHeading})` : ` (${also ?? `read ${r.alsoReadOn}`})`} — “${printedText(r.alsoQuote ?? '')}”`);
    }
    if (r.modelPage?.status === 404) out.push(`- ${P}'s model page for this id answered 404 on ${r.modelPage.at.slice(0, 10)} (${r.modelPage.url})`);
    if (a.via) out.push(`- matched the dated snapshot \`${a.via}\` the page lists`);
    if (a.partner) {
      const page = partnerPage(a.partner, r.provider);
      const N = PARTNER_NAME[a.partner];
      // 0.4.1 (R3): a gateway form is not the provider's own API; the gateway MAY keep its own schedule.
      // 0.4.7 (R5, Amendment A9): an Anthropic id in Bedrock's or Google Cloud's form gets the card's sentences — Anthropic's
      // own, quoted, and the side the platform falls on by them (until 0.4.7: "<platform> runs its own schedule", which
      // Anthropic's page says of the Google-managed offering and Bedrock, not of the Anthropic-managed one)
      const platforms = platformSentences(r.provider, a.partner, read, 'id');
      out.push(
        GATEWAYS.has(a.partner)
          ? `- this id form is ${N}'s, a gateway: ${P}'s word above is for ${P}'s own API, and ${N} may keep its own schedule${page ? ` (${page})` : ''}`
          : platforms
            ? `- this id form is ${N}'s: ${P}'s word above is for ${P}'s own API. ${platforms.sentences.join(' ')}`
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
        ? `- ${PROVIDER_NAME[p.provider as keyof typeof PROVIDER_NAME] ?? p.provider}'s word: **${pl.status}** (model page, read ${pl.readOn})${retirementFloorClause({ retirementFloor: pl.retirementFloor, readOn: pl.readOn })}${pl.replacement ? ` · names ${idSpans(pl.replacement)}` : ''} — ${pl.url}`
        : `- provider's word: no lifecycle page read for this model in this catalog`,
    );
  }
  out.push(
    `- the catalog's routing status: ${p.status} — the catalog's word for whether the model may lead a route, not the provider's`,
  );
  out.push(
    `- provider: ${p.provider}${p.verifiedAgainstDocs ? ` · prices and limits verified against provider docs ${p.verifiedAgainstDocs}` : ''}`,
  );
  out.push(`- price: $${p.costInputPer1m}/M input · $${p.costOutputPer1m}/M output${billedAt(a.row, noticeShown)}`);
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
  // 0.4.6 (R7): printed from its fields — the point tested, the outcome, the trials, the day, the route. Until 0.4.6 each
  // also printed its `claim` sentence and its run number, both written for this project's own records (one claim named
  // the tool that ran it, "release watcher").
  if (p.probedLimits?.length) {
    out.push(
      `- probed limits (we ran the call; ${p.probedLimits.length === 1 ? 'this is a measurement' : 'these are measurements'}, not a spec sheet):\n${p.probedLimits
        .map(
          (l) =>
            `  - ${l.metric.replaceAll('_', ' ')} @ ${l.testedAt.toLocaleString()} → **${l.outcome}** (${l.trials} ${l.trials === 1 ? 'trial' : 'trials'}, last run ${l.lastProbed}${l.route ? `, ${routeWords(l.route)}` : ''})`,
        )
        .join('\n')}`,
    );
  }
  // 0.4.6 (R7): the catalog's `notes` are not printed — they are written for this project's own records ("archetypePerf
  // is JUDGMENT, 0 brain rows"); until 0.4.6 they printed raw as "- notes: …".
  out.push('');
  out.push(factsFooter(read, surface));
  return out.join('\n');
}
