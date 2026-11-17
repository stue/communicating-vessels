/**
 * The deterministic check engine. Every finding carries a confidence tier —
 * the mechanical answer to "how much confidence?":
 *
 *   certain          — the provider's own page as read in this run (0.4.3,
 *                      R1), or a fact read from the developer's code or about
 *                      the lookup itself; stated flatly.
 *   likely           — a provider's page as read on an earlier day (the day
 *                      is on the line); priced/inferred from the agent's own
 *                      estimates; a catalog value; a provider's word where the
 *                      call may not use the provider's own API; no retry or
 *                      fallback in the code.
 *   measurable-only  — honestly unknowable from a code read; each one is
 *                      exactly what the observe day exists to measure.
 *
 * 0.4.0: the provider's word comes first. A model id is resolved as the
 * developer wrote it (R3), looked up in the lifecycle ledger read from the
 * providers' deprecation pages (R1), then in the compiler's catalog, whose
 * `providerLifecycle` is the page's word with its read date (R2). kgauto's own
 * routing `status` is never printed as a fact about the model, and a limit
 * that is only a kgauto default is never printed as certain (R4).
 *
 * The engine makes no request and writes nothing: `runCheck` is synchronous.
 * The pages read in this run come in as an option (`pages`, src/pages.ts); with
 * none passed, every provider line is the page as this version read it, unread
 * in this run. The card's destination sentence is true because there is no
 * code path here that could make it false.
 */
import {
  allProfiles,
  tryGetProfile,
  resolveModelAlias,
  isArchetype,
  LIBRARY_VERSION,
  hasConfirmedEvidence,
  isCapabilityReducing,
  type ModelProfile,
} from '@warmdrift/kgauto-compiler';
import { retirementFloorClause, deriveCliffEvidenceClass } from '@warmdrift/kgauto-compiler/profiles';
import type { Extract } from './extract.js';
import { CHECK_VERSION } from './version.js';
import {
  resolveId,
  lookupLedger,
  catalogProfile,
  newerThanFamily,
  PROVIDER_NAME,
  LEDGER_READ_ON,
  WORD_DEFINITION,
  DEFINITION_PAGE,
  PARTNER_CAVEAT,
  PARTNER_NAME,
  GATEWAYS,
  partnerPage,
  siteState,
  coveredBy,
  type SiteState,
  type Partner,
  type Resolution,
} from './lifecycle.js';
import type { LedgerRow } from './lifecycle-types.js';
import {
  unreadAll,
  NOT_READ_BY_CALLER,
  definitionKey,
  minuteOf,
  pagesCount,
  lastReadAt,
  readInThisRun,
  NOT_THE_PAGE,
  type PageRead,
  type RowState,
} from './pages.js';
import type { SiteContext } from './extract.js';

export type Confidence = 'certain' | 'likely' | 'measurable-only';
export type Severity = 'red' | 'yellow' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  detail: string;
  /** Where the claim comes from — a provider page with its URL, a catalog field, an extract field, arithmetic. */
  basis: string;
  callSites: string[];
  /** 0.4.3 (R4): where each call site's id is written, as the extract says (aligned with callSites; undefined = not stated). */
  contexts?: (SiteContext | undefined)[];
}

export interface CheckResult {
  findings: Finding[];
  card: string;
  catalogVersion: string;
}

export interface EngineOptions {
  /** Test seam: catalog lookup override for a resolved id. Defaults to the bundled roster. */
  resolve?: (id: string) => { canonical: string; profile: ModelProfile | undefined };
  /** Test seam: full roster override (for cheaper-candidate scans and the family sort). */
  roster?: () => ModelProfile[];
  /** Amendment B3: the user ran the CLI with --share, so the footer must not say nothing is uploaded. */
  share?: boolean;
  /** 0.4.2 (R3), test seam: the day the card is printed, `YYYY-MM-DD`. Defaults to the machine's clock (UTC date); no network. */
  today?: string;
  /**
   * 0.4.3 (R1): the providers' pages as read in this run (src/pages.ts). The engine never reads them itself;
   * with none passed every row is unread ("not read by this caller") and no provider line is Certain.
   */
  pages?: PageRead;
  /** 0.4.3 (R5): where the check runs — the CLI or the MCP server — so the footer names the right switch. Defaults to the CLI. */
  surface?: 'cli' | 'mcp';
}

/** 0.4.2 (R3): the card says its age only when the pages are more than this many days old. */
export const STALE_AFTER_DAYS = 7;

/** Whole days from the ledger's read date to `today` (both UTC dates). */
export function daysSinceRead(today: string, readOn: string = LEDGER_READ_ON): number {
  const t = Date.parse(`${today}T00:00:00Z`);
  const r = Date.parse(`${readOn}T00:00:00Z`);
  return Number.isNaN(t) || Number.isNaN(r) ? 0 : Math.round((t - r) / 86_400_000);
}

/** 0.4.2 (R3): the footer sentence when the pages behind the card are more than a week old, else undefined. */
export function ageSentence(today: string, readOn: string = LEDGER_READ_ON): string | undefined {
  const n = daysSinceRead(today, readOn);
  if (n <= STALE_AFTER_DAYS) return undefined;
  return `The providers’ pages behind this card were read ${n} days ago, on ${readOn}; providers change them, and the newest version of the check carries a newer read.`;
}

const machineToday = () => new Date().toISOString().slice(0, 10);

/** 0.4.3 (R7): what the check says of itself, wherever it says it. */
export const DESTINATION_SENTENCE =
  'The check reads your repository on your machine; nothing about your project leaves it unless you choose to share the result.';

/** Amendment B3: the last sentence of a card the CLI will send (--share), printed and stored. */
export const SHARE_SENTENCE = 'Because you ran it with --share, this card and the extract are sent after it is printed.';
/** 0.4.3 (R5): the same, for a card the server sends on share_card. */
export const SHARE_SENTENCE_MCP = 'Because you said yes to sharing it, this card and the extract are sent after it is printed.';

/** The switch that stops the read, as each surface names it. */
export const switchName = (surface: 'cli' | 'mcp') => (surface === 'mcp' ? 'the offline input' : '--offline');

/**
 * 0.4.3 (R2): the card's footer — what this run read and what it sent. A run that read pages says how many
 * of the same public pages it read; `--offline` says it made no request; a caller that passed no read says
 * it read none. A card that will be shared ends on the share sentence.
 */
export function destinationSentence(read: PageRead, share = false, surface: 'cli' | 'mcp' = 'cli'): string {
  const last = share ? (surface === 'mcp' ? SHARE_SENTENCE_MCP : SHARE_SENTENCE) : undefined;
  if (readInThisRun(read)) {
    const { read: n, requested: m } = pagesCount(read);
    const missed = read.pages.filter((p) => !p.ok) as { reason: string }[];
    const other = missed.filter((p) => p.reason === NOT_THE_PAGE).length;
    const missedSentence =
      n < m
        ? `${m - n} ${other === 0 ? 'did not answer' : other === missed.length ? 'answered with a page this version does not read' : 'did not answer or answered with a page this version does not read'}; their lines say so.`
        : '';
    const head = `This check ran on your machine. It read ${n} of ${m} provider pages in this run — the same ${m} public pages whatever your project holds.`;
    return last
      ? [head, missedSentence, last].filter(Boolean).join(' ')
      : [head, 'Nothing about your project was sent anywhere, and no rows were written anywhere.', missedSentence].filter(Boolean).join(' ');
  }
  const bundled = `every provider line is the page as this version read it on ${LEDGER_READ_ON}.`;
  const head =
    read.how === 'switched-off'
      ? share
        ? `This check ran on your machine and read no provider page (${switchName(surface)}): ${bundled}`
        : `This check ran on your machine and made no network request (${switchName(surface)}): ${bundled}`
      : `This check ran on your machine and read no provider page in this run: ${bundled}`;
  return `${head} ${last ?? 'Nothing was uploaded; no rows were written anywhere.'}`;
}

const defaultResolve = (id: string) => ({ canonical: resolveModelAlias(id), profile: tryGetProfile(id) });

function perCallCostUsd(p: ModelProfile, inTok: number, outTok: number): number {
  return (inTok / 1e6) * p.costInputPer1m + (outTok / 1e6) * p.costOutputPer1m;
}

type Line = Omit<Finding, 'id' | 'callSites'>;

/** What the check knows about one model id as configured. */
export interface ModelAnalysis {
  res: Resolution;
  /** The id as the card prints it: as configured, with what it was looked up as. */
  shown: string;
  row?: LedgerRow;
  /** The ledger id the row was found under, when it differs from the looked-up id. */
  via?: string;
  /** The catalog profile the request checks run against; absent = the checks skip this id. */
  profile?: ModelProfile;
  /** The id the profile was found under. */
  canonical: string;
  lines: Line[];
  /** The partner platform the site runs on, when the extract shows one. */
  partner?: Partner;
  /** Amendment D1: the site's state, so a line can say where its partner came from. */
  state?: SiteState;
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Amendment C, ruling 1: the fact is stated about the provider's own API, which is true wherever
 * the call runs. The line is certain only on a stated provider API with nothing against it; on a
 * partner it is likely with the partner's sentence and page (none where the provider's own page
 * covers that platform, ruling 4); on an unstated platform it is likely with one clause.
 */
const UNSTATED_CLAUSE =
  'If this call goes through a cloud platform (Vertex, Bedrock, Azure, a gateway), that platform may keep its own schedule.';

function placeLine(line: Line, provider: string, st: SiteState): Line {
  if (st.providerApi) return line;
  const P = PROVIDER_NAME[provider as keyof typeof PROVIDER_NAME] ?? provider;
  const parts: string[] = [];
  let basis = line.basis;
  if (st.partner) {
    const N = PARTNER_NAME[st.partner];
    const covered = coveredBy(provider, st.partner);
    if (covered) {
      parts.push(`${P}'s deprecations page says its dates apply on ${covered}, so they hold on this site's platform too.`);
    } else {
      const page = partnerPage(st.partner, provider);
      const where = page ? ` (its page: ${page}).` : ' (no page of its own for this model was read).';
      // 0.4.1 (R3): an id written for a gateway is not the provider's own API either; the gateway MAY keep its own schedule.
      parts.push(
        GATEWAYS.has(st.partner)
          ? `This id is written for ${N}, a gateway, and ${N} may keep its own schedule for the model${where}`
          : `This site runs on ${N}, and ${N} runs its own schedule${where}`,
      );
      if (page) basis = `${basis}; ${N}: ${page}`;
    }
  } else {
    parts.push(UNSTATED_CLAUSE);
  }
  if (st.conflict) parts.push(`The extract and the code disagree: ${st.conflict}.`);
  return { ...line, confidence: 'likely', detail: `${line.detail} ${parts.join(' ')}`, basis };
}

/** 0.4.3 (R1): a row's state in a read; a caller that passed no read read nothing. */
export function rowStateIn(read: PageRead | undefined, id: string): RowState {
  return read?.rows.get(id) ?? { state: 'unread', reason: NOT_READ_BY_CALLER };
}
/** 0.4.3 (R2): a definition's state in a read. */
export function definitionStateIn(read: PageRead | undefined, d: { provider: string; word: string }): RowState {
  return read?.definitions.get(definitionKey(d)) ?? { state: 'unread', reason: NOT_READ_BY_CALLER };
}

/** 0.4.3 (R2): "n days before this run", in words. */
function daysBefore(today: string, readOn: string): string {
  const n = daysSinceRead(today, readOn);
  return n <= 0 ? 'the day of this run' : `${n} day${n === 1 ? '' : 's'} before this run`;
}

/**
 * 0.4.3 (R2): the state sentence and basis every provider line carries — when its page was read, in the line.
 * Confirmed: read in this run, with its time. Unread: the page as this version read it, n days before, and why
 * it was not read. Changed: the line no longer on the page, and the page to read before acting.
 */
function stateWords(
  P: string,
  row: { readOn: string; url: string; alsoUrl?: string },
  st: RowState,
  today: string,
): { titlePrefix: string; tail: string; basis: string } {
  const also = row.alsoUrl && row.alsoUrl !== row.url ? ` (and ${row.alsoUrl})` : '';
  if (st.state === 'confirmed')
    return { titlePrefix: '', tail: '', basis: `${P}'s page, read in this run (${minuteOf(st.at)} UTC): ${row.url}${also}` };
  if (st.state === 'changed')
    return {
      titlePrefix: `As read on ${row.readOn} (the page has changed since): `,
      tail: `${P}'s page no longer carries this line as it was read. Read the page before acting on the date: ${row.url}. A newer version of the check carries a newer read.`,
      basis: `${P}'s page as read ${row.readOn}, changed when read in this run (${minuteOf(st.at)} UTC): ${row.url}${also}`,
    };
  return {
    titlePrefix: '',
    tail: `This is ${P}'s page as this version of the check read it on ${row.readOn}, ${daysBefore(today, row.readOn)}; it was not read in this run (${st.reason}).`,
    basis: `${P}'s page as read ${row.readOn}: ${row.url}${also}`,
  };
}

/** 0.4.3 (R6): a changelog row that names the model in words — never Certain, said in one sentence. */
function changelogLine(a: { shown: string; row: LedgerRow; checksSkip: boolean; state: RowState; today: string }): Line {
  const { row, shown } = a;
  const P = PROVIDER_NAME[row.provider];
  const w = stateWords(P, row, a.state, a.today);
  const parts: string[] = [
    `${P}'s changelog names the model in words, not by this id; the link from \`${a.row.id}\` to “${row.namedAs}” is this check's, so this line is Likely whatever the page says.`,
  ];
  if (row.alsoQuote && row.alsoHeading)
    parts.push(`Its entry of ${row.alsoHeading} introduced the id: “${row.alsoQuote}” — the only place a ${P} page this version read carries it.`);
  if (a.checksSkip) parts.push('The catalog has no entry for it, so its limits and price were not checked.');
  // R6: the line ends on the build-time fact (before R2's sentence when the page was not read in this run)
  if (row.modelPage && row.modelPage.status === 404)
    parts.push(`${P}'s model page for this id answered 404 on ${row.modelPage.at.slice(0, 10)}.`);
  if (w.tail) parts.push(w.tail);
  return {
    severity: 'red',
    confidence: 'likely',
    title: `${w.titlePrefix}${shown} is, by this check's reading, ${row.namedAs}: ${P}'s changelog says “${row.quote}” (${row.entryHeading})`,
    detail: parts.join(' '),
    basis: w.basis.replace(`${P}'s page`, `${P}'s changelog`),
  };
}

/** R2: one ledger row → the provider's word about its own API, when, and the replacement the page names. */
function ledgerLine(a: {
  shown: string;
  row: LedgerRow;
  via?: string;
  res: Resolution;
  checksSkip: boolean;
  state: RowState;
  today: string;
  pages?: PageRead;
}): Line {
  const { row, shown } = a;
  if (row.namedAs) return changelogLine(a);
  const P = PROVIDER_NAME[row.provider];
  const readOn = row.readOn;
  const date = row.shutdown;
  const floor = row.shutdownFloor;
  const past = date !== undefined && date <= readOn;
  const on = `On ${P}'s own API, ${shown}`;
  let title: string;
  switch (row.word) {
    case 'retired':
      title = date ? `${on} was retired on ${date}` : `${on} was retired${row.announced ? ` (change log, ${row.announced})` : ''}`;
      break;
    case 'shut down':
      // 0.4.1 (R5): a model already gone is not "not before" anything; the floor is the page's earliest date, said in the past.
      title = date
        ? `${on} was shut down on ${date}`
        : floor
          ? `${on} has been shut down (the earliest shutdown date the page gave was ${floor})`
          : `${on} has been shut down`;
      break;
    case 'legacy':
      title = `${on} is a legacy name ${P} said it would discontinue on ${date}${past ? ', a date before this read; the page states nothing later' : ''}`;
      break;
    case 'rerouted':
      title = `${on} has its requests routed to \`${row.routesTo}\`${date && !past ? ` from ${date}` : ''}`;
      break;
    case 'scheduled for shutdown':
      title = `${on} is scheduled for shutdown not before ${floor ?? date}`;
      break;
    case 'listed': {
      // 0.4.2 Amendment A1: the page lists the id with no date and no deprecation word — said in the page's own words.
      // Amendment B1: what the model is, by the heading its row sits under (the row's `section`), never guessed from the id.
      const h3 = row.section?.split(' › ')[1];
      const among =
        h3 === undefined
          ? 'among its current models'
          : /^Preview models/i.test(h3)
            ? 'among its preview models'
            : /^Preview agents/i.test(h3)
              ? 'among its preview agents'
              : `under its heading “${h3}”`;
      title = `${on} has ${row.pageWord.charAt(0).toLowerCase()}${row.pageWord.slice(1)}: ${P}'s deprecations page lists it ${among}`;
      break;
    }
    default: {
      if (row.routesTo) {
        title = `${on} is deprecated; ${date && !past ? `from ${date} its requests route to` : 'its requests are routed to'} \`${row.routesTo}\``;
      } else if (date) {
        title = past ? `${on} is deprecated, with a shutdown date of ${date}, before this read` : `${on} is deprecated and shuts down on ${date}`;
      } else if (floor) {
        title = `${on} is deprecated; shutdown not before ${floor}`;
      } else {
        title = `${on} is deprecated`;
      }
    }
  }
  const repl = row.replacement && row.replacement !== row.routesTo ? row.replacement : undefined;
  // 0.4.2 Amendment A2: a replacement cell that is not a plain list of model ids is quoted in the page's words, never named.
  if (repl) title += row.replacementForm ? `; for its replacement the page says “${repl}”` : `; its page names \`${repl}\``;

  const parts: string[] = [];
  if (a.via) parts.push(`The page lists the dated snapshot \`${a.via}\`.`);
  // 0.4.3 (R2): a definition is quoted only when it is on its page in this run or its page is unread; a changed one is not.
  const defText = WORD_DEFINITION[row.provider]?.[row.word];
  const def = defText && definitionStateIn(a.pages, { provider: row.provider, word: row.word }).state !== 'changed' ? defText : undefined;
  if (def) parts.push(`${P}'s deprecations page (${DEFINITION_PAGE[row.provider]}): “${def}”`);
  if (row.word === 'legacy' && row.pointedTo) {
    parts.push(`When ${P} announced it (${row.announced}), the name pointed to \`${row.pointedTo}\`.`);
  }
  if (row.word === 'retired' && row.routesTo) {
    parts.push(`${P}'s page: the name is "temporarily routed to ${row.routesTo}".`);
  }
  if (parts.length === 0 || (!def && row.word !== 'legacy' && !a.via))
    // 0.4.2: markdown markup is not the page's words — links lose their URL, bold its asterisks (OpenAI's page of 2026-11-14 bolds every date).
    // Amendment A1: a Google table row's quote is its cells joined by " | "; an empty last cell is not quoted.
    parts.unshift(`The page's line: “${(row.section !== undefined ? row.quote.replace(/ \| $/, '') : row.quote).replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').slice(0, 240)}”.`);
  if (a.checksSkip) parts.push('The catalog has no entry for it, so its limits and price were not checked.');
  const w = stateWords(P, row, a.state, a.today);
  if (w.tail) parts.push(w.tail);
  const severity: Severity =
    row.word === 'listed' ? 'info' : row.word === 'retired' || row.word === 'shut down' || (row.word === 'legacy' && past) ? 'red' : 'yellow';
  return {
    severity,
    // 0.4.3 (R1): Certain only when the row is confirmed in this run (placeLine still lowers it off the provider's API).
    confidence: a.state.state === 'confirmed' ? 'certain' : 'likely',
    title: `${w.titlePrefix}${title}`,
    detail: parts.join(' '),
    basis: w.basis,
  };
}

/**
 * R2: the catalog profile's providerLifecycle word, with its read date and page. Never the catalog's routing `status`.
 * 0.4.3 (R1): Likely in every run — the model page is not read at run time, and the line carries the day it was.
 */
function providerLifecycleLine(shown: string, p: ModelProfile): Line | undefined {
  const pl = p.providerLifecycle;
  if (!pl || pl.status === 'active') return undefined;
  const P = PROVIDER_NAME[p.provider as keyof typeof PROVIDER_NAME] ?? p.provider;
  const floor = retirementFloorClause({ retirementFloor: pl.retirementFloor, readOn: pl.readOn });
  return {
    severity: pl.status === 'retired' ? 'red' : 'yellow',
    confidence: 'likely',
    title: `On ${P}'s own API, ${shown} is ${capital(pl.status)}: its model page says so (read ${pl.readOn})${floor}${pl.replacement ? `; it names \`${pl.replacement}\`` : ''}`,
    detail:
      pl.status === 'legacy'
        ? `${P}'s word for a model that no longer receives updates and may be deprecated later.`
        : `${P}'s word, read on the model's own page.`,
    basis: `catalog providerLifecycle, read ${pl.readOn}: ${pl.url}`,
  };
}

// ── 0.4.1 (R1): a cliff line is worded from the cliff ───────────────────
type Cliff = ModelProfile['cliffs'][number];

/** What the compiler does when the rule fires, in plain words (the switch in the compiler's passApplyCliffs; quality_gate_structured is its ranking penalty). */
const ACTION_WORDS: Record<string, string> = {
  downgrade_quality_warning: 'attaches a warning to the compiled request and leaves the request as it is',
  quality_gate_structured: 'ranks the model lower for a request that asks for structured output at this size',
  force_thinking_budget_zero: "turns the model's thinking off for the request",
  force_terse_output: 'asks the model for a short answer',
  drop_to_top_relevant: 'sends only the most relevant tools',
  strip_tools: 'sends the request without its tools',
  escalate_target: 'moves the request to a stronger model',
};
const ACTION_WOULD: Record<string, string> = {
  force_thinking_budget_zero: "turn the model's thinking off for the request",
  force_terse_output: 'ask the model for a short answer',
  drop_to_top_relevant: 'send only the most relevant tools',
  strip_tools: 'send the request without its tools',
};
const QUALITY_ACTIONS = new Set(['downgrade_quality_warning', 'quality_gate_structured']);

function actionSentence(c: Cliff): string {
  // The compiler holds a capability-reducing action back until a probe confirms the cliff (its evidence gate).
  if (isCapabilityReducing(c.action) && !hasConfirmedEvidence(c)) {
    return `What the compiler does about it: it would ${ACTION_WOULD[c.action] ?? c.action.replaceAll('_', ' ')}, but holds that back until a probe confirms the cliff.`;
  }
  // Amendment B2: the structured-output gate in plain words.
  if (c.action === 'quality_gate_structured') {
    // Amendment D3: the rule fires at >=, so "at or above".
    return `What the compiler does about it: it stops trusting this model's structured output at or above this size${c.whenIntent ? ` on ${c.whenIntent} work` : ''}, and ranks the model lower for such a request.`;
  }
  const w = ACTION_WORDS[c.action];
  return w ? `What the compiler does about it: it ${w}.` : `What the compiler does about it: its action is "${c.action.replaceAll('_', ' ')}".`;
}

/** The evidence in plain words: its class, and the date and count where the profile gives them. */
function evidenceSentence(c: Cliff): string {
  const ev = c.evidence;
  const n = /\bn=(\d+)\b/.exec(c.reason)?.[1];
  const count = n ? `, on ${n} ${n === '1' ? 'call' : 'calls'} (the count its reason gives)` : '';
  if (!ev) {
    const derived = deriveCliffEvidenceClass(c);
    // Amendment B2: the class is only derived from the prose, so the line says so in the ruled words.
    if (derived === 'observed') return "Evidence: no evidence record; the catalog's note describes a measured incident.";
    if (derived === 'assumed') return 'Evidence: the rule carries no evidence record; its reason says it is carried over, not measured on this model.';
    return 'Evidence: the rule carries no evidence record.';
  }
  const when = ev.lastProbed ? `, last ${ev.class === 'observed' ? 'seen' : 'run'} ${ev.lastProbed}` : '';
  switch (ev.class) {
    case 'probed': {
      const v =
        ev.verdict === 'confirmed'
          ? 'a probe reproduced it'
          : ev.verdict === 'knee-moved'
            ? 'a probe moved its threshold and the rule was re-pinned'
            : ev.verdict === 'flagged'
              ? 'a probe did not reproduce it'
              : 'a probe ran; its verdict is not recorded';
      return `Evidence: ${v}${when}${count}.`;
    }
    case 'observed':
      return `Evidence: observed in real calls${when}${count}.`;
    case 'assumed':
      return 'Evidence: carried over from a similar model, not measured on this one.';
    default:
      return 'Evidence: stated in the catalog without a measurement.';
  }
}

/** A reason about one endpoint or one wire says which. */
function scopeSentence(reason: string): string {
  const endpoint = /(\/v\d+[a-z]*\/[a-z0-9_/.:-]*[a-z0-9_])/i.exec(reason)?.[1];
  if (endpoint) return `It is about one endpoint, \`${endpoint}\`: it says nothing about the model reached another way.`;
  const wire = /\bon (?:the |kgauto's )?([A-Za-z][\w .-]*?) wire\b/.exec(reason)?.[1];
  if (wire) return `It is about one wire, ${wire}: it says nothing about the model reached another way.`;
  return '';
}

/**
 * Amendment A1: our own applications. A catalog reason is written for our own digests; one that
 * names one of these is not quoted on a stranger's card (and not altered either). The fix at the
 * source, the reason text in the compiler, is the next compiler filing's.
 */
export const INTERNAL_APPS: readonly string[] = [
  'playbacksam',
  'tt-intel',
  'tt-intelligence',
  'inspire-central',
  'global-expansion',
  'lovable-intelligence',
  'incantato',
  'ivypass',
];
const namesInternalApp = (text: string) => INTERNAL_APPS.some((n) => text.toLowerCase().includes(n));

/** Never certain: the rule is the catalog's, and the metric is the extract's estimate or count. */
export function cliffLine(canonical: string, c: Cliff, metricValue: number): Line {
  const parts: string[] = [];
  const onWork = c.whenIntent ? ` on ${c.whenIntent} work` : '';
  // Amendment B2: the generic quality sentence needs an evidence RECORD (observed, or a confirming probe);
  // a class the compiler only derives from the reason's prose does not carry it.
  const recorded = c.evidence?.class === 'observed' || hasConfirmedEvidence(c);
  if (QUALITY_ACTIONS.has(c.action) && recorded) {
    parts.push(`Above this threshold${onWork}, quality degrades in a measured, repeatable way.`);
  }
  parts.push(
    namesInternalApp(c.reason)
      ? "The catalog's note for this rule is written for our own records and is not quoted."
      : `The catalog's reason${c.whenIntent ? ` (for ${c.whenIntent} work)` : ''}: “${c.reason.trim().replace(/\.$/, '')}”.`,
  );
  const scope = scopeSentence(c.reason);
  if (scope) parts.push(scope);
  parts.push(actionSentence(c));
  parts.push(evidenceSentence(c));
  // Amendment B1: the rule fires at equality (the compiler's >=), so equal is "at the line".
  const where = metricValue === c.threshold ? 'at the line' : 'over the line';
  parts.push(
    c.metric === 'tool_count'
      ? `This site offers ${metricValue.toLocaleString()} ${metricValue === 1 ? 'tool' : 'tools'}, ${where}.`
      : `Your estimate of ${metricValue.toLocaleString()} sits ${where}.`,
  );
  const ev = c.evidence;
  const tag = ev ? `evidence: ${[ev.class, ev.verdict, ev.lastProbed].filter(Boolean).join(', ')}` : 'no evidence record';
  return {
    severity: 'yellow',
    confidence: 'likely',
    // Amendment D2: the title agrees with the sentence — "reaches" at equality, "crosses" above.
    title: `\`${canonical}\` has a known ${c.metric.replaceAll('_', ' ')} cliff at ${c.threshold.toLocaleString()} — this site ${metricValue === c.threshold ? 'reaches' : 'crosses'} it`,
    detail: parts.join(' '),
    basis: `the catalog's cliff rule (${tag}) vs ${c.metric === 'tool_count' ? "this site's tool count" : 'your estimate'}`,
  };
}

export function analyseModel(
  configured: string,
  opts: EngineOptions = {},
  site: { id?: string; where?: string; notes?: string; platform?: string } = {},
): ModelAnalysis {
  const resolveCat = opts.resolve ?? defaultResolve;
  const roster = opts.roster ?? allProfiles;
  const res = resolveId(configured);
  const st = siteState(site, res);
  const partner = st.partner;
  const hit = lookupLedger(res);
  const looked = res.base !== configured ? res.base : undefined;
  const cat = catalogProfile(hit.catalogId, (id) => resolveCat(id).profile);
  let profile = cat.profile;
  const canonical = profile ? resolveCat(cat.id).canonical : cat.id;
  const shownId = (cat.profile && cat.id !== res.base) || looked ? `\`${configured}\` (looked up as \`${cat.profile ? cat.id : res.base}\`)` : `\`${configured}\``;

  const row = hit.row;
  // 0.4.2 Amendment A1: a `listed` row says only that the page lists the id; the catalog's checks and its own
  // lifecycle line (the model page's word) stand beside it, and it never takes the profile away.
  const listed = row?.word === 'listed';
  if (row && profile && !listed) {
    // A ledger word that means requests now fail: no request-shape check is meaningful.
    if (row.word === 'retired' && !row.routesTo) profile = undefined;
    else if (row.word === 'shut down' || row.word === 'no longer supported') profile = undefined;
    // A kgauto alias the provider's page does not support: do not check the id as another model.
    else if (canonical !== cat.id && row.replacement !== canonical && row.routesTo !== canonical) profile = undefined;
  }

  const lines: Line[] = [];
  if (row) {
    lines.push(
      placeLine(
        ledgerLine({
          shown: shownId,
          row,
          via: hit.via,
          res,
          checksSkip: !profile,
          state: rowStateIn(opts.pages, row.id),
          today: opts.today ?? machineToday(),
          pages: opts.pages,
        }),
        row.provider,
        st,
      ),
    );
    const pl = listed && profile ? providerLifecycleLine(shownId, profile) : undefined;
    if (pl && profile) lines.push(placeLine(pl, profile.provider, st));
  } else if (profile) {
    const pl = providerLifecycleLine(shownId, profile);
    if (pl) lines.push(placeLine(pl, profile.provider, st));
  } else {
    // Amendment B, ruling 2: an id the check cannot resolve is "not recognised" — never "no page lists it".
    const fam = newerThanFamily(res.base, roster);
    lines.push({
      severity: 'info',
      confidence: 'certain',
      title: `${shownId} was not recognised`,
      detail:
        `The check could not match this id to the catalog or to a provider's deprecation list, so nothing about it was checked: ` +
        `not its lifecycle, its limits or its price.` +
        (fam ? ` Its name sorts above every \`${fam}\` id the check knows, so it may be newer than the catalog.` : ''),
      basis: 'catalog lookup and the providers’ deprecation lists',
    });
  }
  return { res, shown: shownId, row, via: hit.via, profile, canonical: profile ? canonical : res.base, lines, partner, state: st };
}

export function runCheck(extract: Extract, opts: EngineOptions = {}): CheckResult {
  const roster = opts.roster ?? allProfiles;
  const findings: Finding[] = [];
  let n = 0;
  const add = (f: Omit<Finding, 'id'>) => {
    findings.push({ id: `F${++n}`, ...f });
  };

  const analyses = new Map<string, ModelAnalysis>();
  const bySite = new Map<string, ModelAnalysis>();
  const analyse = (m: string, site: { id?: string; where?: string; notes?: string; platform?: string }) => {
    const st = siteState(site, resolveId(m));
    const key = `${m}|${st.partner ?? ''}|${st.providerApi}|${st.conflict ?? ''}|${st.source ?? ''}`;
    let a = bySite.get(key);
    if (!a) {
      a = analyseModel(m, opts, site);
      bySite.set(key, a);
      if (!analyses.has(m)) analyses.set(m, a);
    }
    return a;
  };

  for (const site of extract.callSites) {
    const a = analyse(site.model, site);
    const at = [site.id];
    for (const l of a.lines) add({ ...l, callSites: at });
    const profile = a.profile;
    if (!profile) continue;
    const canonical = a.canonical;
    // A catalog value is certain only when the profile is dated against the provider's page.
    // Amendment B6: and only on the provider's own API — a limit or a price read from the provider's
    // page is a fact about that API. On a partner platform or a gateway (the same SiteState the
    // lifecycle line reads) every such line is likely and carries one sentence saying whose figure it is.
    const offApi = a.partner;
    // 0.4.3 (R1): a catalog value is Likely in every run — its page is not read at run time; the line carries
    // the day the catalog was dated against it (until 0.4.2: certain when dated and on the provider's own API).
    const docTier: Confidence = 'likely';
    const docBasis = profile.verifiedAgainstDocs
      ? `catalog, verified against the provider's page ${profile.verifiedAgainstDocs}`
      : 'catalog value, not dated against a provider page';
    const PP = PROVIDER_NAME[profile.provider as keyof typeof PROVIDER_NAME] ?? profile.provider;
    // Amendment D1: a partner named only by words in the path or notes is a sign, not a fact about
    // where the site runs; a stated platform or the id's own form is. A disagreement is said as the
    // lifecycle line says it.
    const NP = offApi ? PARTNER_NAME[offApi] : '';
    const whose = offApi
      ? (GATEWAYS.has(offApi)
          ? ` This id is written for ${NP}, a gateway: the figure is from ${PP}'s own API, and ${NP} may set its own.`
          : a.state?.source === 'words'
            ? ` This site's path or notes name ${NP}; if it runs there, the figure is from ${PP}'s own API and ${NP} may set its own.`
            : ` This site runs on ${NP}: the figure is from ${PP}'s own API, and ${NP} may set its own.`) +
        (a.state?.conflict ? ` The extract and the code disagree: ${a.state.conflict}.` : '')
      : '';

    // ── Hard capability limits ─────────────────────────────────────────
    const worstIn = site.maxInputTokens ?? site.estInputTokens;
    if (worstIn !== undefined && worstIn > profile.maxContextTokens) {
      add({
        severity: 'red',
        confidence: site.maxInputTokens !== undefined ? docTier : 'likely',
        title: `input can exceed \`${canonical}\`'s context window`,
        detail:
          `Your ${site.maxInputTokens !== undefined ? 'worst-case' : 'typical'} input estimate ` +
          `(${worstIn.toLocaleString()} tokens) exceeds the model's ${profile.maxContextTokens.toLocaleString()}-token ` +
          `window. Those calls fail outright or silently truncate, depending on the provider.${whose}`,
        basis: `your estimate vs ${docBasis}: maxContextTokens=${profile.maxContextTokens}`,
        callSites: at,
      });
    }
    if (site.estOutputTokens !== undefined && site.estOutputTokens > profile.maxOutputTokens) {
      add({
        severity: 'red',
        confidence: 'likely',
        title: `expected output exceeds \`${canonical}\`'s output cap`,
        detail:
          `You expect ~${site.estOutputTokens.toLocaleString()} output tokens; the model caps at ` +
          `${profile.maxOutputTokens.toLocaleString()}. Responses will be cut mid-generation — on JSON ` +
          `output this is the classic unparseable-tail failure.${whose}`,
        basis: `your estimate vs ${docBasis}: maxOutputTokens=${profile.maxOutputTokens}`,
        callSites: at,
      });
    }
    // 0.4.0 (R4): no tool-count line. `maxTools` carries no provider-page
    // provenance (DeepSeek's 16 is a kgauto default; gpt-6.1-sol's 0 is kgauto's
    // Chat Completions wire), so a count over it is not a finding about the project.
    if (site.usesParallelToolCalls && !profile.parallelToolCalls) {
      add({
        severity: 'yellow',
        confidence: 'likely',
        title: `the catalog measured \`${canonical}\` making tool calls one at a time`,
        detail:
          `This site relies on parallel tool use. A measurement made for the catalog (not a provider statement) found the ` +
          `model calls tools sequentially — roughly 10× fewer operations per step on agentic workloads.`,
        basis: 'catalog parallelToolCalls=false (a catalog measurement, not a provider page)',
        callSites: at,
      });
    }
    if (site.expectsStructuredOutput && profile.structuredOutput === 'none') {
      add({
        severity: 'red',
        confidence: docTier,
        title: `\`${canonical}\` has no structured-output support, but this site parses JSON`,
        detail:
          `Output-shape failures here land on your parser as intermittent exceptions. Models with ` +
          `native or grammar-constrained output move that failure from runtime to the request.${whose}`,
        basis: `${docBasis}: structuredOutput=none`,
        callSites: at,
      });
    }

    // ── Soft cliffs (the compiler's executable knowledge) ──────────────
    const archetype = site.archetype && isArchetype(site.archetype) ? site.archetype : undefined;
    for (const cliff of profile.cliffs) {
      if (cliff.whenIntent && cliff.whenIntent !== archetype) continue;
      const metricValue =
        cliff.metric === 'input_tokens' ? worstIn : cliff.metric === 'tool_count' ? site.toolCount : undefined;
      if (metricValue === undefined || metricValue < cliff.threshold) continue;
      // The compiler applies this rule only to a request that declares structured output (scoreTargets'
      // `if (constraints.structuredOutput)`); the line speaks only where the site parses it.
      if (cliff.action === 'quality_gate_structured' && !site.expectsStructuredOutput) continue;
      add({ ...cliffLine(canonical, cliff, metricValue), callSites: at });
    }

    // ── Resilience ─────────────────────────────────────────────────────
    if (site.retry === 'none') {
      const PN = PROVIDER_NAME[profile.provider as keyof typeof PROVIDER_NAME] ?? profile.provider;
      add({
        severity: 'yellow',
        confidence: 'likely',
        title: `no second model and no retry found at this site`,
        detail: `If ${PN} fails this request, the error reaches your users.`,
        basis: 'extract retry=none: what was read in the code at this site',
        callSites: at,
      });
    }

    // ── Cost (their estimates, our verified prices) ────────────────────
    if (
      site.estInputTokens !== undefined &&
      site.estOutputTokens !== undefined &&
      site.estInputTokens + site.estOutputTokens > 0
    ) {
      const perCall = perCallCostUsd(profile, site.estInputTokens, site.estOutputTokens);
      const monthly = site.estCallsPerMonth !== undefined ? perCall * site.estCallsPerMonth : undefined;
      const inputShare = site.estInputTokens / (site.estInputTokens + site.estOutputTokens);
      add({
        severity: 'info',
        confidence: 'likely',
        title: `~$${perCall.toFixed(4)}/call on \`${canonical}\`${monthly !== undefined ? ` (~$${monthly.toFixed(2)}/month at your volume)` : ''}`,
        detail:
          `From your token estimates and doc-verified prices ($${profile.costInputPer1m}/M in, ` +
          `$${profile.costOutputPer1m}/M out${profile.verifiedAgainstDocs ? `, verified ${profile.verifiedAgainstDocs}` : ''}).${whose}`,
        basis: 'arithmetic on your estimates × verified catalog prices',
        callSites: at,
      });
      if (inputShare > 0.85) {
        add({
          severity: 'yellow',
          confidence: 'likely',
          title: `${Math.round(inputShare * 100)}% of this site's tokens are input`,
          detail:
            `Above ~85% input share, spend is dominated by context rather than answers — the ` +
            `single strongest signal of a leaking prompt. What's actually IN that context, and how ` +
            `much of it each call needed, is measurable, not guessable.`,
          basis: 'your token estimates; the >85% threshold is a measured portfolio heuristic',
          callSites: at,
        });
      }

      // Cheaper candidates — honesty-first: price is arithmetic, quality is not.
      if (archetype) {
        const cheaper = roster()
          .filter(
            (p) =>
              p.status === 'current' &&
              p.id !== canonical &&
              perCallCostUsd(p, site.estInputTokens!, site.estOutputTokens!) < perCall * 0.5,
          )
          .sort(
            (a, b) =>
              perCallCostUsd(a, site.estInputTokens!, site.estOutputTokens!) -
              perCallCostUsd(b, site.estInputTokens!, site.estOutputTokens!),
          );
        const cheapest = cheaper[0];
        if (cheapest) {
          add({
            severity: 'info',
            confidence: 'measurable-only',
            title: `${cheaper.length} model(s) in the catalog price under half of \`${canonical}\` on ${archetype} work`,
            detail:
              `Cheapest: \`${cheapest.id}\` at ~$${perCallCostUsd(cheapest, site.estInputTokens, site.estOutputTokens).toFixed(4)}/call. ` +
              `The price is arithmetic; whether any of them holds YOUR quality bar on ${archetype} work is ` +
              `exactly what a one-day observe run with a judged eval measures. The check never ` +
              `ranks a model on price alone.`,
            basis: 'verified catalog prices; quality deliberately unclaimed',
            callSites: at,
          });
        }
      }
    }
  }

  // ── R5: model ids no call site carries (a picker, a config, an env default) ──
  for (const m of extract.models ?? []) {
    const a = analyse(m.model, m);
    for (const l of a.lines) add({ ...l, callSites: [m.where] });
  }

  // ── The standing measurable-only block (project-level) ───────────────
  const everyWhere = [...extract.callSites.map((s) => s.id), ...(extract.models ?? []).map((m) => m.where)];
  if (everyWhere.length > 0) {
    add({
      severity: 'info',
      confidence: 'measurable-only',
      title: 'what a code read cannot tell you (and a one-day observe run can)',
      detail:
        `Your actual failure rate per model (walkaway failures look like green health checks); ` +
        `your actual input-waste ratio per call; which call sites dominate spend; whether a cheaper ` +
        `model holds quality on your real traffic. These need one day of observed calls — ` +
        `observe-only, your keys, no routing changes.`,
      basis: 'the honest limit of static analysis',
      callSites: everyWhere,
    });
  }

  // Collapse identical findings across call sites (first PB dogfood: six
  // separate "legacy model" entries for one model buried the card). Same
  // title + severity + confidence → one finding listing every site.
  const merged: Finding[] = [];
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    // Amendment C, ruling 3: lines merge only when they agree on the platform too (the detail carries it).
    const key = `${f.severity}|${f.confidence}|${f.title}|${f.detail}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const cs of f.callSites) {
        if (!existing.callSites.includes(cs)) existing.callSites.push(cs);
      }
    } else {
      const copy = { ...f, callSites: [...f.callSites] };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }

  // 0.4.3 (R4): where each site's id is written, as the extract says; then, within a tier, findings with a site
  // in code that runs first, then those with a site whose context is not stated, then the rest (a stable sort).
  const ctxOf = new Map<string, SiteContext | undefined>();
  for (const s of extract.callSites) if (!ctxOf.has(s.id)) ctxOf.set(s.id, s.context);
  for (const m of extract.models ?? []) if (!ctxOf.has(m.where)) ctxOf.set(m.where, m.context);
  for (const f of merged) f.contexts = f.callSites.map((s) => ctxOf.get(s));
  const ordered = merged
    .map((f, i) => ({ f, i, r: contextRank(f) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);

  return {
    findings: ordered,
    card: renderCard(extract, ordered, analyses, opts.share === true, opts.today ?? machineToday(), { pages: opts.pages, surface: opts.surface }),
    catalogVersion: LIBRARY_VERSION,
  };
}

/** 0.4.3 (R4): 0 — a site in code that runs; 1 — a site whose context is not stated; 2 — tests, examples or docs only. */
export function contextRank(f: Pick<Finding, 'contexts' | 'callSites'>): number {
  const cs = f.contexts ?? f.callSites.map(() => undefined);
  if (cs.includes('runs')) return 0;
  if (cs.some((c) => c === undefined)) return 1;
  return 2;
}

/** 0.4.3 (R4): the order a model's sites are counted under — the first of these any of its sites carries. */
const CONTEXT_ORDER: (SiteContext | undefined)[] = ['runs', undefined, 'test', 'example', 'docs'];
const CONTEXT_WORDS: Record<string, (n: number) => string> = {
  runs: (n) => `${n} in code that runs`,
  unstated: (n) => `${n} where the extract does not say`,
  test: (n) => `${n} in tests`,
  docs: (n) => `${n} in docs`,
  example: (n) => `${n} in examples`,
};
/** The header's order (R4's sentence): runs, tests, docs, examples, not stated. */
const HEADER_ORDER = ['runs', 'test', 'docs', 'example', 'unstated'];

const TIER_ORDER: Confidence[] = ['certain', 'likely', 'measurable-only'];
const TIER_HEADING: Record<Confidence, string> = {
  // 0.4.3 (R1): Certain is the provider's page as read in this run, or your code.
  certain: 'Certain — on the provider’s page as read in this run, or read from your code',
  // 0.4.1 (R5): since 0.4.0 this tier also holds a provider's word on a call that may not use the provider's own
  // API (a partner, a gateway, an unstated platform) and the no-fallback line; 0.4.3 (R1): and a page as read on an earlier day.
  likely:
    'Likely — a provider’s page as read on an earlier day (the day is on the line); a provider’s changelog about a model it names in words; priced from your estimates; a provider’s word where the call may not use its own API; no retry or fallback found in the code',
  'measurable-only': 'Only measurable — what the observe day answers',
};
const SEV_MARK: Record<Severity, string> = { red: '\u{1F534}', yellow: '\u{1F7E1}', info: 'ℹ️' };

export function renderCard(
  extract: Extract,
  findings: Finding[],
  analyses: ReadonlyMap<string, ModelAnalysis> = new Map(),
  share = false,
  today: string = machineToday(),
  extra: { pages?: PageRead; surface?: 'cli' | 'mcp' } = {},
): string {
  const read = extra.pages ?? unreadAll('none', NOT_READ_BY_CALLER);
  const lines: string[] = [];
  lines.push(`# Communicating Vessels — the check: ${extract.project.name}`);
  lines.push('');
  const models = [
    ...new Set([...extract.callSites.map((s) => s.model), ...(extract.models ?? []).map((m) => m.model)]),
  ];
  const label = (m: string) => {
    const a = analyses.get(m);
    return a ? a.shown : `\`${m}\``;
  };
  // 0.4.2 Amendment A1: a `listed` row is not a flag; the catalog's own lifecycle word still counts.
  const flaggedIds = models.filter((m) => {
    const a = analyses.get(m);
    const pl = a?.profile?.providerLifecycle?.status;
    return (a?.row && a.row.word !== 'listed') || (pl !== undefined && pl !== 'active');
  });
  const flagged = flaggedIds.length;
  const unknown = models.filter((m) => {
    const a = analyses.get(m);
    return a && !a.row && !a.profile;
  }).length;
  if (models.length === 0) {
    lines.push(
      'No AI call site and no model id were found in this extract, so there is nothing to check against the catalog or the providers’ pages.',
    );
  } else {
    // 0.4.3 (R4): the flagged count, by where each id is written; a model counts once, under the first of
    // runs · not stated · test · example · docs that any of its sites carries.
    const stated = [...extract.callSites, ...(extract.models ?? [])].some((s) => s.context !== undefined);
    const ctxClass = (m: string): string => {
      const cs = [
        ...extract.callSites.filter((s) => s.model === m).map((s) => s.context),
        ...(extract.models ?? []).filter((s) => s.model === m).map((s) => s.context),
      ];
      const c = CONTEXT_ORDER.find((o) => cs.includes(o));
      return c ?? 'unstated';
    };
    const byCtx = new Map<string, number>();
    for (const m of flaggedIds) byCtx.set(ctxClass(m), (byCtx.get(ctxClass(m)) ?? 0) + 1);
    const ctxParts = HEADER_ORDER.filter((k) => (byCtx.get(k) ?? 0) > 0).map((k) => CONTEXT_WORDS[k]!(byCtx.get(k)!));
    // Amendment B4: an id flagged only by this check's reading of a provider's changelog (R6) is counted apart from
    // the provider's own flags; the context counts stay over both together.
    const byChangelog = flaggedIds.filter((m) => analyses.get(m)?.row?.namedAs !== undefined).length;
    const byProvider = flagged - byChangelog;
    const flagParts = [
      byProvider > 0 ? `${byProvider} flagged by its provider` : '',
      byChangelog > 0 ? `${byChangelog} by this check's reading of a provider's changelog` : '',
    ].filter(Boolean);
    const flaggedText = flagParts.length ? `${flagParts.join(', ')}${stated && ctxParts.length ? ` — ${ctxParts.join(', ')}` : ''}` : '';
    const unknownText = unknown > 0 ? `${unknown} not recognised` : '';
    const counts = [flaggedText, unknownText].filter(Boolean);
    lines.push(
      `${extract.callSites.length} AI call site(s), ${models.length} model id(s): ${models.map(label).join(', ')}` +
        (counts.length ? ` (${counts.join(stated && ctxParts.length ? '; ' : ', ')})` : ''),
    );
    if (!stated) {
      lines.push('');
      lines.push('The extract does not say where each id is written, so this count is of every place an id appears.');
    }
    if (extract.callSites.length === 0) {
      lines.push('');
      lines.push(
        'No call site was found to check a request shape against: the lines below are about the model ids the project holds.',
      );
    }
  }
  for (const tier of TIER_ORDER) {
    const group = findings.filter((f) => f.confidence === tier);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`## ${TIER_HEADING[tier]}`);
    lines.push('');
    for (const f of group) {
      // 0.4.3 (R4): a finding none of whose sites runs or is unstated prints the ℹ️ mark whatever its word.
      const mark = contextRank(f) === 2 ? SEV_MARK.info : SEV_MARK[f.severity];
      const sites = f.callSites.map((s, i) => {
        const c = f.contexts?.[i];
        return c ? `${s} (${c})` : s;
      });
      lines.push(`- ${mark} **${f.title}** — ${f.detail}`);
      lines.push(`  <sub>${sites.join(', ')} · basis: ${f.basis}</sub>`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(`*${destinationSentence(read, share, extra.surface ?? 'cli')}*`);
  // 0.4.3 (R2): the age sentence only when a provider line on the card is not from a page read in this run.
  const notConfirmed = [...analyses.values()].some((a) => a.row && rowStateIn(read, a.row.id).state !== 'confirmed');
  const age = notConfirmed ? ageSentence(today) : undefined;
  if (age) lines.push(`*${age}*`);
  // Version stamp: the card itself is the only place a bug report can self-identify its versions.
  const last = readInThisRun(read) ? lastReadAt(read) : undefined;
  lines.push(
    `<sub>@warmdrift/kgauto-check ${CHECK_VERSION} · catalog @warmdrift/kgauto-compiler ${LIBRARY_VERSION} · deprecation pages bundled ${LEDGER_READ_ON}${last ? `, read in this run ${minuteOf(last)} UTC` : ''}</sub>`,
  );
  return lines.join('\n');
}
