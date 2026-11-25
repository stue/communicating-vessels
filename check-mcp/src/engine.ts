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
import { retirementFloorClause, deriveCliffEvidenceClass, providerDisplayName } from '@warmdrift/kgauto-compiler/profiles';
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
  PARTNER_NAME,
  GATEWAYS,
  partnerPage,
  siteState,
  coveredBy,
  pageName,
  pagesName,
  sourceReadOn,
  type SiteState,
  type Partner,
  type Resolution,
} from './lifecycle.js';
import type { LedgerRow, DefinitionWord } from './lifecycle-types.js';
import { rowPages, unlinked, fineTuneNoteTies } from './ledger-check.mjs';
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

/** 0.4.5 (R7 a): what "the catalog" is, said once in the footer of a card that says it. */
export const CATALOG_SENTENCE = `The catalog on this card is the set of model records this check carries (\`@warmdrift/kgauto-compiler\` ${LIBRARY_VERSION}).`;

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
export function destinationSentence(
  read: PageRead,
  share = false,
  surface: 'cli' | 'mcp' = 'cli',
  /** 0.4.6 Amendment B4: how many of the card's lines say a page was not read in this run. */
  saying?: number,
): string {
  const last = share ? (surface === 'mcp' ? SHARE_SENTENCE_MCP : SHARE_SENTENCE) : undefined;
  if (readInThisRun(read)) {
    const { read: n, requested: m } = pagesCount(read);
    const missed = read.pages.filter((p) => !p.ok) as { reason: string }[];
    const other = missed.filter((p) => p.reason === NOT_THE_PAGE).length;
    const k = m - n;
    const what = other === 0 ? 'did not answer' : other === missed.length ? 'answered with a page this version does not read' : 'did not answer or answered with a page this version does not read';
    // 0.4.6 Amendment B4: one page, one line — the clause counts the pages and the card's lines that say so (until fix
    // pass 1: "; their lines say so." for any count of either); a caller that gives no count of lines gets the pages only
    const them = k === 1 ? 'it' : 'them';
    const linesClause =
      saying === undefined
        ? ''
        : saying === 0
          ? `; no line on this card rests on ${them}`
          : saying === 1
            ? k === 1 ? '; its line says so' : '; the one line that rests on them says so'
            : k === 1 ? '; its lines say so' : '; their lines say so';
    const missedSentence = n < m ? `${k} ${what}${linesClause}.` : '';
    const head = `This check ran on your machine. It read ${n} of ${m} provider pages in this run — the same ${m} public pages whatever your project holds.`;
    return last
      ? [head, missedSentence, last].filter(Boolean).join(' ')
      : [head, 'Nothing about your project was sent anywhere, and no rows were written anywhere.', missedSentence].filter(Boolean).join(' ');
  }
  // 0.4.5 (R2): the day the deprecation pages were read, and that a line from a model's own page carries its own (until
  // 0.4.4: "every provider line is the page as this version read it on <day>", beside lines that said another day)
  const bundled = `the deprecation pages behind its provider lines are as this version read them on ${LEDGER_READ_ON}, and a line taken from a model's own page gives the day that page was read.`;
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
  /** 0.4.5 (R5): set when the id reads as a fine-tune (`ft:<base>:…`): the base it was looked up by, for lifecycle only. */
  fineTuneOf?: string;
  /** 0.4.5 (R5): the base's catalog entry, read for its lifecycle word only (never for limits or price). */
  baseProfile?: ModelProfile;
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** 0.4.4 (R3): a count with its noun, the plural written out — "1 AI call site", "8 model ids"; never "(s)". */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** "a", "a and b", "a, b and c". */
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** 0.4.4 (R1): a provider's name as its pages write it — the ledger's four, else the compiler's own (`zai` → "Z.ai"), never a catalog key. */
const providerWord = (p: string) => PROVIDER_NAME[p as keyof typeof PROVIDER_NAME] ?? providerDisplayName(p);

/**
 * Amendment C, ruling 1: the fact is stated about the provider's own API, which is true wherever
 * the call runs. The line is certain only on a stated provider API with nothing against it; on a
 * partner it is likely with the partner's sentence and page (none where the provider's own page
 * covers that platform, ruling 4); on an unstated platform it is likely with one clause.
 */
const UNSTATED_CLAUSE =
  'If this call goes through a cloud platform (Vertex, Bedrock, Azure, a gateway), that platform may keep its own schedule.';

/**
 * 0.4.7 (R5, Amendment A9): for an Anthropic id on Amazon Bedrock or Google Cloud (Vertex AI), what cannot be told from the
 * code, in the page's words: Anthropic's own sentences naming the platforms its dates apply to (Anthropic-operated, Claude
 * Models on Google Cloud "(Anthropic managed)" among them) and those that set their own (Claude Models on Google Cloud
 * "(Google managed)" and Amazon Bedrock), quoted whole; then which side the site's platform falls on by them — Amazon
 * Bedrock is named on the partner side; for Google Cloud the extract does not say which one manages it — and that the
 * partner's own offering runs its own schedule. Undefined for any other provider or platform, and when the sentences are
 * not on the page as read in this run (a changed definition is never quoted).
 */
export function platformSentences(
  provider: string,
  partner: Partner | undefined,
  pages: PageRead | undefined,
  /** what tells the platform: the site (a card) or the id's own form (`--model-facts`, which has no extract) */
  by: 'site' | 'id' = 'site',
): { sentences: string[]; url: string } | undefined {
  if (provider !== 'anthropic' || (partner !== 'bedrock' && partner !== 'vertex')) return undefined;
  const q = WORD_DEFINITION.anthropic?.['operated platforms'];
  const url = DEFINITION_PAGE.anthropic;
  if (!q || !url || definitionStateIn(pages, { provider: 'anthropic', word: 'operated platforms' }).state === 'changed') return undefined;
  const page = partnerPage(partner, provider);
  const its = page ? ` (its page: ${page})` : '';
  return {
    url,
    sentences: [
      `${pageName('anthropic', url)} says: “${printedText(q)}”`,
      partner === 'bedrock'
        ? `By those words Amazon Bedrock, ${by === 'site' ? 'where this site runs' : 'whose form this id is written in'}, is a partner-operated platform: Amazon Bedrock runs its own schedule${its}.`
        : `${by === 'site' ? 'This site runs on Google Cloud (Vertex AI), and the extract does not say' : 'This id is written in Google Cloud’s (Vertex AI) form, and the id does not say'} which Claude Models on Google Cloud it is: the Anthropic-managed one, which those words put under these dates, or the Google-managed one, which runs its own schedule${its}.`,
    ],
  };
}

function placeLine(line: Line, provider: string, st: SiteState, pages?: PageRead): Line {
  if (st.providerApi) return line;
  const P = providerWord(provider);
  const parts: string[] = [];
  let basis = line.basis;
  const platforms = platformSentences(provider, st.partner, pages);
  if (st.partner && platforms) {
    // 0.4.7 (R5): the page's sentences and the side the platform falls on, under Likely (until 0.4.7: "This site runs on
    // <platform>, and <platform> runs its own schedule", true of the Google-managed offering only)
    parts.push(...platforms.sentences);
    const page = partnerPage(st.partner, provider);
    if (page) basis = `${basis}; ${PARTNER_NAME[st.partner]}: ${page}`;
    basis = definitionBasis(basis, 'anthropic', 'operated platforms', pages);
  } else if (st.partner) {
    const N = PARTNER_NAME[st.partner];
    const covered = coveredBy(provider, st.partner);
    if (covered) {
      // 0.4.4 (R6): the page by its own title
      const dep = DEFINITION_PAGE[provider as keyof typeof DEFINITION_PAGE];
      parts.push(`${dep ? pageName(provider, dep) : `${P}'s deprecations page`} says its dates apply on ${covered}, so they hold on this site's platform too.`);
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
 *
 * 0.4.4 (R6): each page is named by its own title ("OpenAI's deprecations page", "Google's release notes page").
 * 0.4.4 (R4): a row that rests on two pages, one read in this run and one not, says which, by name — in the
 * sentence and in the basis. The tier rule is unchanged: such a row is unread, and never Certain.
 */
function stateWords(
  row: { provider: string; readOn: string; url: string; quote: string; note?: string; section?: string; alsoUrl?: string; alsoQuote?: string },
  st: RowState,
  today: string,
): { titlePrefix: string; tail: string; basis: string } {
  const urls = rowPages(row);
  const all = pagesName(row.provider, urls);
  const at = (us: readonly string[]) => us.join(' and ');
  if (st.state === 'confirmed')
    return { titlePrefix: '', tail: '', basis: `${all}, read in this run (${minuteOf(st.at)} UTC): ${at(urls)}` };
  if (st.state === 'changed')
    return {
      titlePrefix: `As read on ${row.readOn} (the page has changed since): `,
      tail: `This line is no longer on ${all} as it was read. Read the page before acting on the date: ${row.url}. A newer version of the check carries a newer read.`,
      basis: `${all} as read ${row.readOn}, changed when read in this run (${minuteOf(st.at)} UTC): ${at(urls)}`,
    };
  const notRead = st.notRead ?? urls.map((url) => ({ url, reason: st.reason }));
  const read = st.read ?? [];
  const days = daysBefore(today, row.readOn);
  if (read.length === 0) {
    const N = pagesName(row.provider, notRead.map((n) => n.url));
    const many = notRead.length > 1;
    const reasons = [...new Set(notRead.map((n) => n.reason))];
    const why = reasons.length === 1 ? reasons[0] : notRead.map((n) => `${pageName(row.provider, n.url)}: ${n.reason}`).join('; ');
    return {
      titlePrefix: '',
      tail: `This is ${N} as this version of the check read ${many ? 'them' : 'it'} on ${row.readOn}, ${days}; ${many ? 'they were' : 'it was'} not read in this run (${why}).`,
      basis: `${N} as read ${row.readOn}: ${at(urls)}`,
    };
  }
  // R4: one page read in this run, another not — the sentence and the basis name each.
  const R = pagesName(row.provider, read.map((r) => r.url));
  const N = pagesName(row.provider, notRead.map((n) => n.url));
  const t = minuteOf(read.map((r) => r.at).sort().at(-1)!);
  const stands = read.every((r) => r.stands);
  const was = (n: number) => (n > 1 ? 'were' : 'was');
  return {
    titlePrefix: '',
    tail:
      `In this run ${R} ${was(read.length)} read (${t} UTC) and ${stands ? 'still says this' : 'no longer says this as it was read'}, ` +
      `and ${N} ${was(notRead.length)} not read (${[...new Set(notRead.map((n) => n.reason))].join('; ')}); ` +
      `for ${notRead.length > 1 ? 'those pages' : 'that page'}, this is what this version of the check read on ${row.readOn}, ${days}.`,
    basis: `${R}, read in this run (${t} UTC): ${at(read.map((r) => r.url))}; ${N}, not read in this run, as read ${row.readOn}: ${at(notRead.map((n) => n.url))}`,
  };
}

/** 0.4.6 Amendment B4: the words stateWords gives a line that rests on a page not read in this run. */
const NOT_READ_SAID = /\bnot read in this run\b|\b(?:was|were) not read \(/;

/**
 * 0.4.6 Amendment B5: a plain list of ids the page names, each id in its own code span, the page's commas and "or" kept
 * (`a` or `b`; `a`, `b`, or `c`). Until fix pass 1 the whole list was one span: `a or b`.
 */
export function idSpans(list: string): string {
  return list
    .split(/(,\s*(?:or|and)\s+|\s+(?:or|and)\s+|,\s*)/)
    .map((p, i) => (i % 2 === 1 ? p : p ? `\`${p}\`` : p))
    .join('');
}

/** 0.4.3 (R6): a changelog row that names the model in words — never Certain, said in one sentence. */
function changelogLine(a: { shown: string; row: LedgerRow; checksSkip: boolean; state: RowState; today: string }): Line {
  const { row, shown } = a;
  const P = PROVIDER_NAME[row.provider];
  // 0.4.4 (R6): the page by its own title — Google's is titled "Release notes"
  const page = pageName(row.provider, row.url);
  const w = stateWords(row, a.state, a.today);
  const parts: string[] = [
    `${page} names the model in words, not by this id; the link from \`${a.row.id}\` to “${row.namedAs}” is this check's, so this line is Likely whatever the page says.`,
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
    title: `${w.titlePrefix}${shown} is, by this check's reading, ${row.namedAs}: ${page} says “${cutQuote(row.quote)}” (${row.entryHeading})`,
    detail: parts.join(' '),
    basis: w.basis,
  };
}

// ── 0.4.4 (R2): a quote is the page's words, or it is marked ───────────
/** A quote longer than this is cut; every row of the ledger read 2026-11-17 is shorter (the longest, 259 characters, is Google's reroute of gemini-2.5-flash). */
export const QUOTE_LIMIT = 300;

/**
 * A quote as the card prints it: whole when it is short enough; else cut at the last sentence end or table-cell
 * boundary before the limit, outside any backticks, and ended with "…" (inside the quotation marks, which the
 * caller adds). A quote with no such boundary before the limit is printed whole: never cut inside a word or an id.
 */
export function cutQuote(s: string, limit: number = QUOTE_LIMIT): string {
  if (s.length <= limit) return s;
  let best = -1;
  let ticks = 0;
  for (let i = 0; i < s.length && i < limit; i++) {
    if (s[i] === '`') ticks++;
    if (ticks % 2 !== 0) continue;
    // a sentence end: the punctuation is kept, the cut is after it
    if (/[.!?]/.test(s[i]!) && /\s/.test(s[i + 1] ?? '') && i + 1 + 1 <= limit) best = i + 1;
    // a table-cell boundary: the cut is before " | "
    if (s.startsWith(' | ', i) && i > 0 && i + 1 <= limit) best = i;
  }
  return best > 0 ? `${s.slice(0, best)}…` : s;
}

/**
 * 0.4.7: a page's text as a card prints it — whitespace flattened, links reduced to their text by the one link strip
 * (src/ledger-check.mjs `unlinked`, the same the generator compares a pageWord with), bold's asterisks removed.
 */
export function printedText(s: string): string {
  return unlinked(s.replace(/\s+/g, ' ')).replace(/\*\*/g, '').trim();
}

/** The page's line as the card quotes it: the same whitespace and markdown normalisation as before, then cutQuote. */
export function pageLineQuote(row: LedgerRow, quote: string = row.quote): string {
  // 0.4.2: markdown markup is not the page's words — links lose their URL, bold its asterisks (OpenAI's page of 2026-11-14 bolds every date).
  // Amendment A1: a Google table row's quote is its cells joined by " | "; an empty last cell is not quoted.
  // 0.4.7 (R3): a second row of the same page is quoted the same way (`quote`).
  return cutQuote(printedText(row.section !== undefined ? quote.replace(/ \| $/, '') : quote));
}

/**
 * 0.4.7 (R2, Amendment A2): a Google table row quoted with its table's column names ("Model: `x` | Release date: May 28,
 * 2026 | …"), so a release date is not read as a shutdown date. Only for a row whose word is its second page's; an empty
 * cell is left out with its name. Undefined for a row the generator gave no column names.
 */
export function columnQuote(row: LedgerRow): string | undefined {
  const cols = row.columns;
  if (!cols) return undefined;
  const cells = row.quote.split(' | ');
  if (cells.length !== cols.length) return undefined;
  return cutQuote(
    cells
      .map((c, i) => [cols[i]!, printedText(c)] as const)
      .filter(([, c]) => c !== '')
      .map(([n, c]) => `${n}: ${c}`)
      .join(' | '),
  );
}

// ── 0.4.5 (R6): a row matched by a display name ─────────────────────────
/**
 * A row the generator wrote for an alias by its display name ("GPT-4o (`gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`)"):
 * the name and the snapshots its cell names, read from the row's own quote (the page's line); undefined for any other row.
 */
export function displayNameRow(row: LedgerRow): { name: string; snapshots: string[] } | undefined {
  if (row.matchedBy !== 'display-name') return undefined;
  const cell = row.quote
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
    .find((c) => /^[A-Z][A-Za-z0-9.\- ]*? \(`/.test(c));
  if (!cell) return undefined;
  return { name: /^(.*?) \(`/.exec(cell)![1]!, snapshots: [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!) };
}

/**
 * R6: a date is printed beside the id it belongs to. The deprecations page dates the snapshots its row names; the alias
 * is the model page's, and only its word ("Status: Deprecated") is that page's. The title says whose word and whose date,
 * and that the link from the alias to the row is this check's; the line is never Certain.
 */
function displayNameLine(a: {
  shown: string;
  row: LedgerRow;
  checksSkip: boolean;
  state: RowState;
  today: string;
  display: { name: string; snapshots: string[] };
}): Line {
  const { row, shown, display } = a;
  const P = PROVIDER_NAME[row.provider];
  const status = row.alsoQuote ?? '';
  const word = status.replace(/^Status:\s*/, '').toLowerCase() || row.word;
  const date = row.shutdown;
  const floor = row.shutdownFloor;
  // 0.4.7 (R8, Amendment A1): a date after the page's read day and before this run's day carries its distance
  const lapsed = (d: string) => d > row.readOn && daysUntil(a.today, d) < 0;
  const when = date
    ? `a shutdown date of ${date}${lapsed(date) ? ` (${distanceWords(a.today, date)})` : ''}`
    : floor
      ? `a shutdown date not before ${floor}${lapsed(floor) ? ` (${distanceWords(a.today, floor)})` : ''}`
      : 'no shutdown date';
  // the line agrees with its count: one snapshot is "the snapshot … its replacement"
  const one = display.snapshots.length === 1;
  const their = one ? 'its' : 'their';
  const repl = row.replacement
    ? row.replacementForm
      ? `, and for ${their} replacement says “${row.replacement}”`
      : `, with ${idSpans(row.replacement)} as ${their} replacement`
    : '';
  const w = stateWords(row, a.state, a.today);
  const parts = [
    `The page's line: “${pageLineQuote(row)}”.`,
    `The link from \`${row.id}\` to that row is this check's reading of the name “${display.name}”, so this line is Likely whatever the pages say.`,
  ];
  if (a.checksSkip) parts.push('The catalog has no entry for it, so its limits and price were not checked.');
  if (w.tail) parts.push(w.tail);
  return {
    severity: word === 'shut down' ? 'red' : 'yellow',
    confidence: 'likely',
    title:
      `${w.titlePrefix}On ${P}'s own API, ${shown} is ${word} by its model page's word (“${status}”); ` +
      `${pageName(row.provider, row.url)} gives ${when} to ${andList(display.snapshots.map((s) => `\`${s}\``))}, the ${one ? 'snapshot' : 'snapshots'} its row “${display.name}” names${repl}; ` +
      `the link from \`${row.id}\` to that row is this check's`,
    detail: parts.join(' '),
    basis: w.basis,
  };
}

// ── 0.4.7 (R3): a second row of the same page ──────────────────────────
const cellWords = (s?: string) => (s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Amendment A4: what an id's second row gives that its first does not — another date, another replacement. [] when the two
 * say the same, and when the second is about something else (the id sits in it inside a cell that names a feature).
 */
export function secondRowDiffers(row: LedgerRow): ('date' | 'replacement')[] {
  const s = row.secondRow;
  if (!s || s.feature) return [];
  const out: ('date' | 'replacement')[] = [];
  if (cellWords(s.dateText) !== cellWords(row.dateText)) out.push('date');
  if (cellWords(s.replacement) !== cellWords(row.replacement)) out.push('replacement');
  return out;
}

/**
 * R3: the one sentence a line about an id on two rows of its page adds — the second row quoted with the heading it sits
 * under. It says which row the line is from and, where they differ, that they differ; never which is right.
 */
export function secondRowSentence(row: LedgerRow): string | undefined {
  const s = row.secondRow;
  if (!s) return undefined;
  const d = secondRowDiffers(row);
  const differ = d.length ? `; the two rows give different ${andList(d.map((x) => (x === 'date' ? 'dates' : 'replacements')))}` : '';
  return `\`${row.id}\` is on two rows of ${pageName(row.provider, row.url)}: this line is from the first, and the second, under its heading “${s.heading}”, reads “${pageLineQuote(row, s.quote)}”${differ}.`;
}

/**
 * 0.4.7 (R2): a row whose lifecycle word is its second page's (`pageWordUrl`) — on Google's pages, a deprecation said in
 * the release notes of a model the deprecations page lists without that word. Its quote is that page's sentence, the page
 * named with its read day; the table row follows, by its columns (Amendment A2). Undefined for every other row.
 */
function secondPageQuote(row: LedgerRow, st: RowState): string[] | undefined {
  if (!row.pageWordUrl || row.pageWordUrl === row.url || row.alsoUrl !== row.pageWordUrl || !row.alsoQuote) return undefined;
  const read = st.read?.find((r) => r.url === row.alsoUrl);
  const day = read ? `read in this run, ${minuteOf(read.at)} UTC` : `as read on ${row.alsoReadOn ?? row.readOn}`;
  const cq = columnQuote(row);
  return [
    `${pageName(row.provider, row.alsoUrl)} (${day}): “${cutQuote(printedText(row.alsoQuote))}”`,
    cq ? `Its row on ${pageName(row.provider, row.url)}, by the table's columns: “${cq}”.` : `The page's line: “${pageLineQuote(row)}”.`,
  ];
}

/**
 * 0.4.7 (R6, Amendment A8): a line that quotes a provider's definition from a page the row does not rest on names that
 * page in its basis, with its read state (until 0.4.7 seven of Google's release-notes rows quoted the deprecations page's
 * definition under a basis that named the release notes alone).
 */
function definitionBasis(basis: string, provider: LedgerRow['provider'], word: string, pages: PageRead | undefined): string {
  const url = DEFINITION_PAGE[provider];
  if (!url || basis.includes(url)) return basis;
  const st = definitionStateIn(pages, { provider, word });
  const when = st.state === 'confirmed' ? `read in this run (${minuteOf(st.at)} UTC)` : `as read ${sourceReadOn(url)}`;
  return `${basis}; ${pageName(provider, url)}, for the definition the line quotes, ${when}: ${url}`;
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
  // 0.4.7 (R8, Amendment A1): a date after the day the page was read and before this run's day is said as the page's date
  // with its distance, never in the future ("shuts down on") and never as done ("was shut down"), which only the page's
  // own word can say; whether or not the page was read in this run (until 0.4.7 the tense came from the read day alone)
  const lapsed = (d: string | undefined) => d !== undefined && d > readOn && daysUntil(a.today, d) < 0;
  const ago = (d: string) => distanceWords(a.today, d);
  const on = `On ${P}'s own API, ${shown}`;
  const display = displayNameRow(row);
  let title: string;
  if (display) return displayNameLine({ ...a, display });
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
      title = `${on} is a legacy name ${P} said it would discontinue on ${date}${
        past ? ', a date before this read; the page states nothing later' : lapsed(date) ? `, ${ago(date!)}` : ''
      }`;
      break;
    case 'rerouted':
      title =
        date && lapsed(date)
          ? `${on}: its page gives ${date}, ${ago(date)}, as the day its requests route to \`${row.routesTo}\``
          : `${on} has its requests routed to \`${row.routesTo}\`${date && !past ? ` from ${date}` : ''}`;
      break;
    case 'scheduled for shutdown':
      title = `${on} is scheduled for shutdown not before ${floor ?? date}${lapsed(floor ?? date) ? `, ${ago((floor ?? date)!)}` : ''}`;
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
      // 0.4.4 (R6): the page by its own title ("Gemini deprecations")
      // 0.4.7 (R1): a listed row's pageWord is its date cell as the page writes it ("No shutdown date announced"); a row
      // without one says only that the page lists it
      const cell = row.pageWord;
      title = cell
        ? `${on} has ${cell.charAt(0).toLowerCase()}${cell.slice(1)}: ${pageName(row.provider, row.url)} lists it ${among}`
        : `${on}: ${pageName(row.provider, row.url)} lists it ${among}`;
      break;
    }
    default: {
      if (row.routesTo) {
        title =
          date && lapsed(date)
            ? `${on} is deprecated; its page gives ${date}, ${ago(date)}, as the day its requests route to \`${row.routesTo}\``
            : `${on} is deprecated; ${date && !past ? `from ${date} its requests route to` : 'its requests are routed to'} \`${row.routesTo}\``;
      } else if (date) {
        title = past
          ? `${on} is deprecated, with a shutdown date of ${date}, before this read`
          : lapsed(date)
            ? `${on} is deprecated, and its page gives a shutdown date of ${date}, ${ago(date)}`
            : `${on} is deprecated and shuts down on ${date}`;
      } else if (floor) {
        title = `${on} is deprecated; shutdown not before ${floor}${lapsed(floor) ? `, ${ago(floor)}` : ''}`;
      } else {
        title = `${on} is deprecated`;
      }
    }
  }
  const repl = row.replacement && row.replacement !== row.routesTo ? row.replacement : undefined;
  // 0.4.2 Amendment A2: a replacement cell that is not a plain list of model ids is quoted in the page's words, never named.
  // 0.4.6 Amendment B5: each id in its own code span
  if (repl) title += row.replacementForm ? `; for its replacement the page says “${repl}”` : `; its page names ${idSpans(repl)}`;

  const parts: string[] = [];
  if (a.via) parts.push(`The page lists the dated snapshot \`${a.via}\`.`);
  // 0.4.3 (R2): a definition is quoted only when it is on its page in this run or its page is unread; a changed one is not.
  const defText = WORD_DEFINITION[row.provider]?.[row.word];
  const def = defText && definitionStateIn(a.pages, { provider: row.provider, word: row.word }).state !== 'changed' ? defText : undefined;
  // 0.4.4 (R6): the page by its own title
  if (def) parts.push(`${pageName(row.provider, DEFINITION_PAGE[row.provider]!)} (${DEFINITION_PAGE[row.provider]}): “${def}”`);
  if (row.word === 'legacy' && row.pointedTo) {
    parts.push(`When ${P} announced it (${row.announced}), the name pointed to \`${row.pointedTo}\`.`);
  }
  if (row.word === 'retired' && row.routesTo) {
    // 0.4.4 (R6): the page by its own title
    parts.push(`${pageName(row.provider, row.url)}: the name is "temporarily routed to ${row.routesTo}".`);
  }
  if (parts.length === 0 || (!def && row.word !== 'legacy' && !a.via))
    // 0.4.4 (R2): never cut inside a word or an id (until 0.4.3: `.slice(0, 240)`, which cut Google's reroute of gemini-2.5-flash inside an id)
    // 0.4.7 (R2): a row whose word is its second page's quotes that page's sentence first, then its row by its columns
    parts.unshift(...(secondPageQuote(row, a.state) ?? [`The page's line: “${pageLineQuote(row)}”.`]));
  // 0.4.7 (R3): an id on two rows of its page says the second
  const second = secondRowSentence(row);
  if (second) parts.push(second);
  if (a.checksSkip) parts.push('The catalog has no entry for it, so its limits and price were not checked.');
  const w = stateWords(row, a.state, a.today);
  if (w.tail) parts.push(w.tail);
  const severity: Severity =
    row.word === 'listed' ? 'info' : row.word === 'retired' || row.word === 'shut down' || (row.word === 'legacy' && past) ? 'red' : 'yellow';
  return {
    severity,
    // 0.4.3 (R1): Certain only when the row is confirmed in this run (placeLine still lowers it off the provider's API).
    // 0.4.7 (Amendment A4): and never when the page's second row for the id gives another date or another replacement
    confidence: a.state.state === 'confirmed' && secondRowDiffers(row).length === 0 ? 'certain' : 'likely',
    title: `${w.titlePrefix}${title}`,
    detail: parts.join(' '),
    // 0.4.7 (R6, Amendment A8): the definition's page, where the row does not rest on it
    basis: def ? definitionBasis(w.basis, row.provider, row.word, a.pages) : w.basis,
  };
}

/**
 * R2: the catalog profile's providerLifecycle word, with its read date and page. Never the catalog's routing `status`.
 * 0.4.3 (R1): Likely in every run — the model page is not read at run time, and the line carries the day it was.
 */
function providerLifecycleLine(shown: string, p: ModelProfile): Line | undefined {
  const pl = p.providerLifecycle;
  if (!pl || pl.status === 'active') return undefined;
  const P = providerWord(p.provider);
  const floor = retirementFloorClause({ retirementFloor: pl.retirementFloor, readOn: pl.readOn });
  return {
    severity: pl.status === 'retired' ? 'red' : 'yellow',
    confidence: 'likely',
    title: `On ${P}'s own API, ${shown} is ${capital(pl.status)}: its model page says so (read ${pl.readOn})${floor}${pl.replacement ? `; it names ${idSpans(pl.replacement)}` : ''}`,
    detail:
      pl.status === 'legacy'
        ? `${P}'s word for a model that no longer receives updates and may be deprecated later.`
        : `${P}'s word, read on the model's own page.`,
    // 0.4.4 (R1): a sentence, not the catalog's field name
    basis: `${P}'s page for this model, as the catalog read it ${pl.readOn}: ${pl.url}`,
  };
}

// ── 0.4.5 (R4): an Active row of a provider's status table ──────────────
/**
 * The days a page's notice period runs before a retirement: the line about an Active row's date prints only when the
 * floor has passed or lies this many days or fewer after the run. Anthropic's page, read 2026-11-20T05:02:18Z: "providing
 * at least 60 days’ notice before model retirement for publicly released models" (the sentence the line quotes).
 */
export const ACTIVE_WINDOW_DAYS = 60;

/** Whole days from the run's day to `iso` (both UTC dates); negative once `iso` has passed. */
export function daysUntil(today: string, iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** A date's distance from the run, in words: "4 days after this run", "the day of this run", "a date 36 days before this run". */
export function distanceWords(today: string, iso: string): string {
  const n = daysUntil(today, iso);
  if (n === 0) return 'the day of this run';
  const days = (k: number) => `${k} day${k === 1 ? '' : 's'}`;
  return n > 0 ? `${days(n)} after this run` : `a date ${days(-n)} before this run`;
}

/** R4 (b): does the line about this floor print? Only when it has passed or lies within the notice period. */
export const floorInWindow = (today: string, floor: string | undefined) => floor !== undefined && daysUntil(today, floor) <= ACTIVE_WINDOW_DAYS;

/** The provider's notice sentence for an Active row, when its page carries it in this run or was not read (never a changed one). */
function noticeQuote(provider: LedgerRow['provider'], pages: PageRead | undefined): string | undefined {
  const q = WORD_DEFINITION[provider]?.['notice period'];
  return q && definitionStateIn(pages, { provider, word: 'notice period' }).state !== 'changed' ? q : undefined;
}

/**
 * R4: what the card says of an id the provider's status table lists as Active — never "not recognised", never a flag.
 *  - (e) the catalog carries the provider's word for the model too (its model page): one line, the word the model page's
 *    with the day the catalog read it, the floor the deprecations page's with that page's own read state; Likely, as
 *    every catalog word is. Two floors that differ both print, each beside its page.
 *  - (b) else, a floor that has passed or lies within the notice period: one ℹ️ line with the state, the page's date
 *    text in quotes and the distance in days, and the page's notice sentence.
 *  - (d) else, no catalog entry: one ℹ️ line in (b)'s form, without the notice sentence, and what was not checked.
 *  - else (the catalog has the model and calls it active too, the floor further out): the same ℹ️ line (0.4.6, R6:
 *    every id on a provider's table gets a line; until 0.4.6: nothing).
 * 0.4.6 Amendment B1–B2: every one of these lines carries the row's cell as the page writes it, and none says what the
 * page lacks (until fix pass 1, (b), (d) and (e) each said that the page announces no retirement for the id).
 * (c) The two ℹ️ lines are Certain only when the page was read in this run and the row stands (placeLine lowers them
 * off the provider's own API).
 */
function activeLines(a: {
  shown: string;
  row: LedgerRow;
  via?: string;
  profile?: ModelProfile;
  state: RowState;
  today: string;
  pages?: PageRead;
}): Line[] {
  const { row, shown, today } = a;
  const P = PROVIDER_NAME[row.provider];
  const on = `On ${P}'s own API, ${shown}`;
  const dep = pageName(row.provider, row.url);
  const w = stateWords(row, a.state, today);
  const notice = noticeQuote(row.provider, a.pages);
  const viaSentence = a.via ? `The page lists the dated snapshot \`${a.via}\`.` : undefined;
  const floor = row.shutdownFloor;
  // 0.4.6 Amendment B1: every Active line carries the row's cell as the page writes it, far floor or near; a cell with no
  // date is quoted as it is (no distance), and a row with no cell has the page's line quoted in its detail
  const dateWords = row.dateText ? `, with a tentative retirement date of “${row.dateText}”${floor ? `, ${distanceWords(today, floor)}` : ''}` : '';
  const lineQuote = row.dateText ? undefined : `The page's line: “${pageLineQuote(row)}”.`;
  const pl = a.profile?.providerLifecycle;

  if (a.profile && pl && pl.status !== 'active') {
    // (e) one line: the model page's word and day; the deprecations page's floor, with its own read state
    const PP = providerWord(a.profile.provider);
    const changed = a.state.state === 'changed' ? `, as read on ${row.readOn} (the page has changed since),` : '';
    let title = `${on} is ${capital(pl.status)}: its model page says so (read ${pl.readOn}); ${dep}${changed} lists it as Active${dateWords}`;
    if (pl.retirementFloor && pl.retirementFloor !== floor) title += `; its model page gave a retirement floor of ${pl.retirementFloor} (read ${pl.readOn})`;
    if (pl.replacement) title += `; its model page names ${idSpans(pl.replacement)}`;
    const parts = [
      viaSentence,
      pl.status === 'legacy' ? `${PP}'s word for a model that no longer receives updates and may be deprecated later.` : `${PP}'s word, read on the model's own page.`,
      // Amendment B2: the title carries the row's cell, so no clause says what the page lacks (until fix pass 1 this
      // sentence opened by saying the page announces no retirement for the id, then quoted the notice sentence)
      lineQuote,
      notice ? `${dep} says “${notice}”` : undefined,
      secondRowSentence(row), // 0.4.7 (R3)
      a.state.state === 'confirmed'
        ? `That page was read in this run (${minuteOf(a.state.at)} UTC); the model page was not, and its word is as the catalog read it on ${pl.readOn}.`
        : w.tail,
    ].filter((x): x is string => !!x);
    return [
      {
        // Amendment A3: the status table is the provider's lifecycle page, read in the run; the model page's word is a
        // badge on a model the same provider lists as Active — ℹ️, never 🟡, and not a flag (until fix pass 1: 🟡, flagged)
        severity: 'info',
        confidence: 'likely',
        title,
        detail: parts.join(' '),
        basis: `${PP}'s page for this model, as the catalog read it ${pl.readOn}: ${pl.url}; ${w.basis}`,
      },
    ];
  }

  // 0.4.7 (Amendment A4): never Certain while the page's second row for the id gives another date or replacement
  const confidence: Confidence = a.state.state === 'confirmed' && secondRowDiffers(row).length === 0 ? 'certain' : 'likely';
  const second = secondRowSentence(row); // 0.4.7 (R3)
  const noEntry = a.profile ? undefined : 'The catalog has no entry for it, so its limits and price were not checked.';
  if (floorInWindow(today, floor)) {
    // (b) the date line: ℹ️, the state, the page's date text and the distance, and the page's notice sentence
    // (Amendment B2: until fix pass 1 the detail opened by saying the page announces no retirement for the id)
    const parts = [
      viaSentence,
      notice ? `${dep} lists it as Active, and says “${notice}”` : `${dep} lists it as Active.`,
      second,
      noEntry,
      w.tail || undefined,
    ].filter((x): x is string => !!x);
    return [{ severity: 'info', confidence, title: `${w.titlePrefix}${on} is Active${dateWords}`, detail: parts.join(' '), basis: w.basis }];
  }
  // (d) no id in an extract goes unmentioned: no catalog entry, or (0.4.6, R6) a catalog entry that calls it active too
  // (until 0.4.6 that second case printed nothing, and the card named the id only in its header). Amendment B1: the
  // title is (b)'s, the row's cell with its distance, without the notice sentence, which is the window's (until fix
  // pass 1: "is Active on <page>", no date, and a detail saying the page announces no retirement for the id)
  const parts = [viaSentence, lineQuote ?? `${dep} lists it as Active.`, second, noEntry, w.tail || undefined].filter((x): x is string => !!x);
  const title = dateWords ? `${on} is Active${dateWords}` : `${on} is Active on ${dep}`;
  return [{ severity: 'info', confidence, title: `${w.titlePrefix}${title}`, detail: parts.join(' '), basis: w.basis }];
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

/**
 * 0.4.5 (R7 b): the sentence is conditional — it says what the compiler does for a caller who calls this model through it,
 * never as a fact about the reader's project (until 0.4.4: "What the compiler does about it: it …", a bare "the compiler"
 * a stranger has no reason to know). Kept rather than dropped: it is the line's only word on whether the rule acts or is
 * held back until a test reproduces the problem.
 */
export const COMPILER_IF = 'If you call this model through `@warmdrift/kgauto-compiler`, it';
function actionSentence(c: Cliff): string {
  // The compiler holds a capability-reducing action back until a confirming test is on record (its evidence gate).
  // 0.4.4 Amendment A2: said in the words the basis uses (the 0.4.3 wording is in the filing's fix pass 1 report).
  if (isCapabilityReducing(c.action) && !hasConfirmedEvidence(c)) {
    return `${COMPILER_IF} would ${ACTION_WOULD[c.action] ?? c.action.replaceAll('_', ' ')}, but holds that back until a test reproduces the problem.`;
  }
  // Amendment B2: the structured-output gate in plain words.
  if (c.action === 'quality_gate_structured') {
    // Amendment D3: the rule fires at >=, so "at or above".
    return `${COMPILER_IF} stops trusting this model's structured output at or above this size${c.whenIntent ? ` on ${c.whenIntent} work` : ''}, and ranks the model lower for such a request.`;
  }
  const w = ACTION_WORDS[c.action];
  return w ? `${COMPILER_IF} ${w}.` : `${COMPILER_IF} applies the rule's action, "${c.action.replaceAll('_', ' ')}".`;
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
      // 0.4.4 Amendment A2: a test, in the words the basis uses (foundWords), never our word for it
      const v =
        ev.verdict === 'confirmed'
          ? 'a test reproduced the problem'
          : ev.verdict === 'knee-moved'
            ? 'a test moved the threshold, and the catalog was changed to match'
            : ev.verdict === 'flagged'
              ? 'a test did not reproduce the problem'
              : 'a test was run and its result is not recorded';
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
  return {
    severity: 'yellow',
    confidence: 'likely',
    // Amendment D2: the title agrees with the sentence — "reaches" at equality, "crosses" above.
    // 0.4.4 Amendment A2: none of our words for the rule on a line a card prints; the threshold in the basis's words
    title: `\`${canonical}\`: the catalog holds a threshold at ${thresholdWords(c)}, and this site ${metricValue === c.threshold ? 'reaches' : 'crosses'} it`,
    detail: parts.join(' '),
    basis: `a threshold the catalog holds for this model (${thresholdWords(c)}; ${foundWords(c)}), against ${c.metric === 'tool_count' ? "this site's tool count" : 'your estimate'}`,
  };
}

/** 0.4.4 (R1): what the threshold is, in words. */
function thresholdWords(c: Cliff): string {
  const n = c.threshold.toLocaleString();
  if (c.metric === 'tool_count') return `${n} ${c.threshold === 1 ? 'tool' : 'tools'}`;
  if (c.metric === 'input_tokens') return `${n} input tokens`;
  return `${n}, counted as ${c.metric.replaceAll('_', ' ')}`;
}

/**
 * 0.4.4 (R1): where the threshold came from, in words, taken from the cliff's evidence RECORD (never from its prose):
 * every value this can take, by class and verdict, with and without a date.
 */
export function foundWords(c: Pick<Cliff, 'evidence'>): string {
  const ev = c.evidence;
  if (!ev) return 'no record of how it was found';
  const on = ev.lastProbed ? ` on ${ev.lastProbed}` : '';
  switch (ev.class) {
    case 'probed':
      return ev.verdict === 'confirmed'
        ? `a test reproduced the problem${on}`
        : ev.verdict === 'knee-moved'
          ? `a test moved the threshold${on}, and the catalog was changed to match`
          : ev.verdict === 'flagged'
            ? `a test${on} did not reproduce the problem`
            : `a test was run${on}; its result is not recorded`;
    case 'observed':
      return `the problem was seen in real calls${ev.lastProbed ? `, last on ${ev.lastProbed}` : ''}`;
    case 'assumed':
      return 'carried over from a similar model, not tested on this one';
    default:
      return 'stated by the catalog, with no test behind it';
  }
}

// ── 0.4.5 (R5): a fine-tune is looked up by its base, for lifecycle only ─
/**
 * A fine-tuned model's id, `ft:<base>:…` (OpenAI writes `ft:gpt-4o-2024-08-06:<org>:<suffix>:<id>`); the base is the second
 * field. Amendment A6: `ft:<base>` with nothing after the base is read the same way; `ft::…` names no base and is no
 * fine-tune the check can name (until fix pass 1: only `ft:<base>:…`).
 */
const FINE_TUNE = /^ft:([^:]+)(?::|$)/;

/**
 * R5: the base's lifecycle line, for a fine-tune of it. Always Likely: the link from the fine-tune to its base is this
 * check's reading of the id, and the line says so, as the release-notes line does. The catalog is not consulted for
 * limits or price (the profile stays empty, so no request-shape check runs), and the line says that too.
 *
 * Amendment A2: the title names the id as a fine-tune of its base, then gives the base's word and date as the base's,
 * and the replacement as the page's replacement for the base (R6's rule; until fix pass 1 the title put all three on
 * the fine-tune: "`ft:…` (a fine-tune of `<base>`) is deprecated and shuts down on …; its page names …").
 *
 * Amendment A1: the provider's sentence about fine-tunes is quoted where the check holds one for the base's row —
 * OpenAI's, under its table of upcoming deprecations, speaking of "the models listed above". Otherwise the line says
 * only that the check quotes no such sentence (until fix pass 1: "The pages this check reads do not say what happens to
 * a fine-tune of this model.", false of OpenAI's page, whose "Historical notes" speak of the models shut down in
 * October 2026).
 *
 * 0.4.7 (R4, Amendment A5): that historical note IS tied to its rows mechanically, by the note's own words. Its link ends
 * "#2026-04-22-legacy-gpt-model-snapshots" — the notice date of exactly the rows shut down on Oct 23, 2026 — and its words
 * say "shut down in October 2026"; both are read from the note (fineTuneNoteTie), never typed. (Until 0.4.7 this comment
 * said no row could be tied to it, since the anchor is on the HTML page and not a section of the markdown page this check
 * reads; the date inside the anchor is on the markdown page as the rows' notice cell.) A fine-tune of a base on one of
 * those rows quotes the note; of any other past base, the line still says the check quotes no sentence.
 */
function analyseFineTune(
  configured: string,
  res: Resolution,
  base: string,
  opts: EngineOptions,
  site: { id?: string; where?: string; notes?: string; platform?: string },
  asWritten?: string,
): ModelAnalysis {
  const resolveCat = opts.resolve ?? defaultResolve;
  const bres: Resolution = { ...res, base };
  const st = siteState(site, bres);
  const hit = lookupLedger(bres);
  const baseProfile = catalogProfile(hit.catalogId, (id) => resolveCat(id).profile).profile;
  const today = opts.today ?? machineToday();
  // 0.4.6 (R9): an id matched only in lower case is shown as written, with the id it was read as
  const shown = asWritten ? `\`${asWritten}\` (looked up as \`${configured}\`)` : `\`${configured}\``;
  const named = `\`${base}\``;
  const link = `The link from ${shown} to \`${base}\` is this check's reading of the id, so this line is Likely whatever the page says.`;
  const notChecked = 'Its limits and price were not checked: the check does not look a fine-tune up in the catalog.';
  const out = (lines: Line[]): ModelAnalysis => ({
    res,
    shown,
    row: hit.row,
    via: hit.via,
    canonical: base,
    lines,
    partner: st.partner,
    state: st,
    fineTuneOf: base,
    ...(baseProfile ? { baseProfile } : {}),
  });
  const row = hit.row;
  const provider = row?.provider ?? baseProfile?.provider;
  if (!row && !baseProfile) {
    return out([
      {
        severity: 'info',
        confidence: 'certain',
        title: `${shown} was not recognised`,
        detail:
          `It reads as a fine-tune of \`${base}\`, and the check could not match \`${base}\` to the catalog or to a provider's deprecation list, ` +
          `so nothing about it was checked: not its lifecycle, its limits or its price.`,
        basis: "this id's base was looked up in the catalog and in the providers' pages this check reads, and matched neither",
      },
    ]);
  }
  // the provider's sentence about fine-tunes, where its page says it of this row: OpenAI's footnote under its table of
  // upcoming deprecations, for a row of that table (0.4.7, R1: by the row's `table`, a record field — until 0.4.7 by the
  // words of its `pageWord`); or (0.4.7, R4) OpenAI's historical note on the legacy GPT models shut down in October 2026,
  // for a row its own link ties it to (fineTuneNoteTies: the notice date in the link, the month in its words)
  const footnote = WORD_DEFINITION.openai?.['fine-tuned versions'];
  const note = WORD_DEFINITION.openai?.['fine-tunes of the October 2026 shutdown'];
  const which: DefinitionWord | undefined =
    row?.provider !== 'openai'
      ? undefined
      : row.table === 'Upcoming deprecations' && footnote
        ? 'fine-tuned versions'
        : note && fineTuneNoteTies(note, row)
          ? 'fine-tunes of the October 2026 shutdown'
          : undefined;
  const ftSentence = which
    ? definitionStateIn(opts.pages, { provider: row!.provider, word: which }).state === 'changed'
      ? `The sentence this version read on ${pageName(row!.provider, row!.url)} about fine-tunes is not on it as read in this run.`
      : `${pageName(row!.provider, row!.url)}: “${printedText(which === 'fine-tuned versions' ? footnote! : note!)}”`
    : `This check quotes no sentence of ${provider ? providerWord(provider) : 'the provider'}'s about fine-tunes of this model.`;

  let line: Line | undefined;
  if (row) {
    const rowLines =
      row.word === 'active'
        ? activeLines({ shown: named, row, via: hit.via, profile: baseProfile, state: rowStateIn(opts.pages, row.id), today, pages: opts.pages })
        : [ledgerLine({ shown: named, row, via: hit.via, res: bres, checksSkip: false, state: rowStateIn(opts.pages, row.id), today, pages: opts.pages })];
    line = rowLines[0];
  } else if (baseProfile) {
    line = providerLifecycleLine(named, baseProfile);
  }
  const isA = `${shown} is a fine-tune of \`${base}\` (this check's reading of the id)`;
  let title: string;
  if (!line) {
    // the base is known and nothing flags it: one ℹ️ line, so no id in an extract goes unmentioned
    line = { severity: 'info', confidence: 'likely', title: '', detail: '', basis: "the catalog's record of the base model, and the providers' pages this check reads" };
    title = `${isA}; no page this check reads flags the base`;
  } else {
    // A2: the base's line was built about the base; the fine-tune is named as a fine-tune of it, then "for the base, …"
    const on = `On ${providerWord(provider!)}'s own API, `;
    const at = line.title.indexOf(on);
    const baseTitle = (at === -1 ? line.title : line.title.slice(at + on.length)).replace(
      // Amendment B5: one span per id, so the list runs from the first span to the last
      /; its page names (`.+`)$/,
      "; the page names $1 as the base's replacement",
    );
    title = at === -1 ? `${isA}: ${baseTitle}` : `${line.title.slice(0, at)}${on}${isA}, and for the base, ${baseTitle}`;
  }
  const rest = line.detail.replace(' The catalog has no entry for it, so its limits and price were not checked.', '').replace(/^The catalog has no entry for it, so its limits and price were not checked\.\s*/, '');
  const fineLine: Line = {
    ...line,
    title,
    confidence: 'likely',
    detail: [link, ftSentence, notChecked, rest].filter(Boolean).join(' '),
  };
  return out([provider ? placeLine(fineLine, provider, st, opts.pages) : fineLine]);
}

/**
 * 0.4.6 (R9): the step said when an id is matched only in lower case. Amendment B3: said as what was looked up, not as
 * an act (until fix pass 1: "wrote the id in lower case", which read as if the reader had written it so).
 */
export const LOWER_CASE_STEP = 'the lower-case form of the id as written';

export function analyseModel(
  configured: string,
  opts: EngineOptions = {},
  site: { id?: string; where?: string; notes?: string; platform?: string } = {},
  /** 0.4.6 (R9): the id as the extract wrote it, when `configured` is that id in lower case. */
  asWritten?: string,
): ModelAnalysis {
  const resolveCat = opts.resolve ?? defaultResolve;
  const roster = opts.roster ?? allProfiles;
  const res = resolveId(configured);
  if (asWritten) res.steps.push(LOWER_CASE_STEP);
  const ft = FINE_TUNE.exec(res.base);
  if (ft) return analyseFineTune(configured, res, ft[1]!, opts, site, asWritten);
  const st = siteState(site, res);
  const partner = st.partner;
  const hit = lookupLedger(res);
  const looked = res.base !== configured ? res.base : undefined;
  const cat = catalogProfile(hit.catalogId, (id) => resolveCat(id).profile);
  let profile = cat.profile;
  const canonical = profile ? resolveCat(cat.id).canonical : cat.id;
  const shownId =
    (cat.profile && cat.id !== res.base) || looked || asWritten
      ? `\`${asWritten ?? configured}\` (looked up as \`${cat.profile ? cat.id : res.base}\`)`
      : `\`${configured}\``;

  const row = hit.row;
  // 0.4.2 Amendment A1: a `listed` row says only that the page lists the id; the catalog's checks and its own
  // lifecycle line (the model page's word) stand beside it, and it never takes the profile away.
  const listed = row?.word === 'listed';
  // 0.4.5 (R4): an Active row is not a flag either, and never takes the profile away
  const active = row?.word === 'active';
  if (row && profile && !listed && !active) {
    // A ledger word that means requests now fail: no request-shape check is meaningful.
    if (row.word === 'retired' && !row.routesTo) profile = undefined;
    else if (row.word === 'shut down' || row.word === 'no longer supported') profile = undefined;
    // A kgauto alias the provider's page does not support: do not check the id as another model.
    else if (canonical !== cat.id && row.replacement !== canonical && row.routesTo !== canonical) profile = undefined;
  }

  const lines: Line[] = [];
  if (row && active) {
    const today = opts.today ?? machineToday();
    for (const l of activeLines({ shown: shownId, row, via: hit.via, profile, state: rowStateIn(opts.pages, row.id), today, pages: opts.pages }))
      lines.push(placeLine(l, row.provider, st, opts.pages));
  } else if (row) {
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
        opts.pages,
      ),
    );
    const pl = listed && profile ? providerLifecycleLine(shownId, profile) : undefined;
    if (pl && profile) lines.push(placeLine(pl, profile.provider, st, opts.pages));
  } else if (profile) {
    const pl = providerLifecycleLine(shownId, profile);
    if (pl) lines.push(placeLine(pl, profile.provider, st, opts.pages));
  } else {
    // 0.4.6 (R9): an id is matched without regard to case before it is called not recognised — `GPT-4o` prints the
    // line `gpt-4o` prints, under the same heading (until 0.4.6 it was "not recognised", under Certain)
    const lower = configured.toLowerCase();
    if (!asWritten && lower !== configured) {
      const a = analyseModel(lower, opts, site, configured);
      if (a.row || a.profile || a.baseProfile) return a;
    }
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
      // 0.4.4 Amendment A1: a sentence, not a noun phrase; the lookup is the catalog and every page the ledger is built
      // from (deprecations, release notes, a change log), so the basis does not name deprecation pages alone
      basis: "this id was looked up in the catalog and in the providers' pages this check reads, and matched neither",
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
    const PP = providerWord(profile.provider);
    // 0.4.4 (R1): where a catalog value came from, in words (until 0.4.3: "catalog, verified against the provider's page <date>")
    const docSource = profile.verifiedAgainstDocs
      ? `the catalog's record, checked against ${PP}'s documentation on ${profile.verifiedAgainstDocs}`
      : `the catalog's record, not checked against ${PP}'s documentation`;
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
        basis: `your estimate against the model's context limit, ${profile.maxContextTokens.toLocaleString()} tokens (${docSource})`,
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
        basis: `your estimate against the model's output limit, ${profile.maxOutputTokens.toLocaleString()} tokens (${docSource})`,
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
        // 0.4.4 (R1): "measured" only where a record says so — the catalog's value is a yes/no with no record behind it
        title: `the catalog records \`${canonical}\` making tool calls one at a time`,
        detail:
          `This site relies on parallel tool use. The catalog records that the model calls tools one at a time (its own finding, ` +
          `not a provider statement) — roughly 10× fewer operations per step on agentic workloads.`,
        basis: "the catalog records that this model does not make tool calls in parallel; that is the catalog's own finding, not a provider page",
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
        basis: `${docSource}: the model has no structured-output mode`,
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
      const PN = providerWord(profile.provider);
      add({
        severity: 'yellow',
        confidence: 'likely',
        title: `no second model and no retry found at this site`,
        detail: `If ${PN} fails this request, the error reaches your users.`,
        basis: 'the extract of your code says this call has no retry and no second model',
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
        // 0.4.4 Amendment A1: the basis is a sentence, and the detail says where the prices came from in the same words as
        // the basis and the limit lines (docSource); "verified" is no longer printed here
        detail:
          `From your token estimates and the catalog's prices for this model ($${profile.costInputPer1m}/M in, ` +
          `$${profile.costOutputPer1m}/M out; ${docSource}).${whose}`,
        basis: `your token estimates multiplied by the catalog's prices for this model (${docSource})`,
        callSites: at,
      });
      if (inputShare > 0.85) {
        add({
          severity: 'yellow',
          confidence: 'likely',
          title: `${Math.round(inputShare * 100)}% of this site's tokens are input`,
          detail:
            `Above ~85% input share, spend is dominated by context rather than answers — the ` +
            `single strongest signal of a leaking prompt. What's actually in that context, and how ` + // Amendment A7: until fix pass 1, "actually IN"
            `much of it each call needed, is measurable, not guessable.`,
          basis: "your token estimates; 85% is a rule of thumb from the projects the check's makers run, not a provider's figure",
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
          // 0.4.4 Amendment B1: the line agrees with its count — one model is "prices", "That model is", "it"
          const one = cheaper.length === 1;
          add({
            severity: 'info',
            confidence: 'measurable-only',
            title: `${count(cheaper.length, 'model')} in the catalog ${one ? 'prices' : 'price'} under half of \`${canonical}\` on ${archetype} work`,
            detail:
              `${one ? 'That model is' : 'Cheapest:'} \`${cheapest.id}\` at ~$${perCallCostUsd(cheapest, site.estInputTokens, site.estOutputTokens).toFixed(4)}/call. ` +
              // 0.4.5 (R7 b): no "YOUR", no "observe run", no "judged eval" (until 0.4.4: "whether it holds YOUR quality bar … is
              // exactly what a one-day observe run with a judged eval measures")
              `The price is arithmetic; whether ${one ? 'it does' : 'any of them does'} your ${archetype} work as well as \`${canonical}\` is ` +
              `what a day of recorded calls, with their answers graded, would show. The check never ` +
              `ranks a model on price alone.`,
            // 0.4.4 Amendment A1: a sentence, not a noun phrase; it says what the line does not claim
            basis: one
              ? "your token estimates at that model's prices in the catalog; nothing on this line says how well it would do your work"
              : "your token estimates at each model's prices in the catalog; nothing on this line says how well any of them would do your work",
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
      // 0.4.5 (R7 b): in plain words, naming the command that prints the plan (until 0.4.4: "… (and a one-day observe run
      // can)", "walkaway failures look like green health checks", "observe-only, your keys, no routing changes")
      title: 'what a code read cannot tell you (and a day of recorded calls can)',
      detail:
        `How often each model's calls fail, counting the failures that still look like a normal answer; ` +
        `how much of each call's input its answer needed; which call sites carry most of the spend; and whether a cheaper ` +
        `model does your work as well on your real traffic. One day of recorded calls would show these, made with your own ` +
        `keys and with no change to where any call goes; ${opts.surface === 'mcp' ? 'the `get_observe_day_plan` tool' : '`--observe-plan`'} prints the plan.`,
      // 0.4.4 Amendment A1: a sentence, not a noun phrase
      basis: 'this check reads the extract of your code and runs none of your calls, so it cannot see how they behave',
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

/**
 * 0.4.3 (R4): the order a model's sites are counted under — the first of these any of its sites carries.
 * 0.4.6 (R8): the one order the header uses — it decides where an id is counted, it is the order the counts are listed
 * in, and it is the order the rule sentence names (until 0.4.6 the counts were listed in an order of their own: runs,
 * tests, docs, examples, not stated).
 */
const CONTEXT_ORDER: (SiteContext | undefined)[] = ['runs', undefined, 'test', 'example', 'docs'];
const CONTEXT_WORDS: Record<string, (n: number) => string> = {
  runs: (n) => `${n} in code that runs`,
  unstated: (n) => `${n} where the extract does not say`,
  test: (n) => `${n} in tests`,
  docs: (n) => `${n} in docs`,
  example: (n) => `${n} in examples`,
};
/** 0.4.4 Amendment A3: each kind of place in words, for the sentence that says the counting order. */
const CONTEXT_PLACE: Record<string, string> = {
  runs: 'code that runs',
  unstated: 'where the extract does not say',
  test: 'tests',
  example: 'examples',
  docs: 'docs',
};

const TIER_ORDER: Confidence[] = ['certain', 'likely', 'measurable-only'];
const TIER_HEADING: Record<Confidence, string> = {
  // 0.4.3 (R1): Certain is the provider's page as read in this run, or your code.
  certain: 'Certain — on the provider’s page as read in this run, or read from your code',
  // 0.4.1 (R5): since 0.4.0 this tier also holds a provider's word on a call that may not use the provider's own
  // API (a partner, a gateway, an unstated platform) and the no-fallback line; 0.4.3 (R1): and a page as read on an earlier day.
  // 0.4.4 (R6): Google's page is titled "Release notes", so the heading says release notes (until 0.4.3: "changelog")
  likely:
    // Amendment A7: and the two kinds of line 0.4.5 adds, in a few words
    'Likely — a provider’s page as read on an earlier day (the day is on the line); a provider’s release notes that name a model in words, not by its id; an id this check linked to another id’s row (a fine-tune by its base, a name by its display name); priced from your estimates; a provider’s word where the call may not use its own API; no retry or fallback found in the code',
  // 0.4.5 (R7 b): until 0.4.4, "what the observe day answers"
  'measurable-only': 'Only measurable — what a day of recorded calls would answer',
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
  // 0.4.5 (R4 d): nor is an `active` row.
  const notAFlag = (w: LedgerRow['word']) => w === 'listed' || w === 'active';
  const flaggedIds = models.filter((m) => {
    const a = analyses.get(m);
    // 0.4.5 (R5): a fine-tune's base is read for its lifecycle word too
    const pl = (a?.profile ?? a?.baseProfile)?.providerLifecycle?.status;
    // Amendment A3: an id whose deprecations-page row says Active is not flagged, whatever its model page's badge
    return (a?.row && !notAFlag(a.row.word)) || (pl !== undefined && pl !== 'active' && a?.row?.word !== 'active');
  });
  const flagged = flaggedIds.length;
  const unknown = models.filter((m) => {
    const a = analyses.get(m);
    return a && !a.row && !a.profile && !a.baseProfile;
  }).length;
  if (models.length === 0) {
    lines.push(
      'No AI call site and no model id were found in this extract, so there is nothing to check against the catalog or the providers’ pages.',
    );
  } else {
    // 0.4.3 (R4): the flagged count, by where each id is written; a model counts once, under the first of
    // runs · not stated · test · example · docs that any of its sites carries.
    const stated = [...extract.callSites, ...(extract.models ?? [])].some((s) => s.context !== undefined);
    const contextsOf = (m: string) => [
      ...extract.callSites.filter((s) => s.model === m).map((s) => s.context),
      ...(extract.models ?? []).filter((s) => s.model === m).map((s) => s.context),
    ];
    const ctxClass = (m: string): string => {
      const c = CONTEXT_ORDER.find((o) => contextsOf(m).includes(o));
      return c ?? 'unstated';
    };
    /** 0.4.4 Amendment A3: the kinds of place an id is written in (a site with no context is its own kind, "not stated"). */
    const kindsOf = (m: string) => new Set(contextsOf(m).map((c) => c ?? 'unstated'));
    const byCtx = new Map<string, number>();
    for (const m of flaggedIds) byCtx.set(ctxClass(m), (byCtx.get(ctxClass(m)) ?? 0) + 1);
    // 0.4.4 (R3): the header says what each number counts — the ids and the call sites; then how many ids are flagged
    // and by whom (the provider by name when there is one); then where the flagged ids are written. Two sentences where
    // 0.4.3 had one with a dash, and every plural written out.
    // Amendment B4 (kept): an id flagged only by this check's reading of a provider's changelog (R6) is counted apart
    // from the provider's own flags; the "where" counts are over both together, each id once.
    // 0.4.5 (R5): and a fine-tune flagged through its base is counted with them — the link to the base is the check's reading
    const fineTuneIds = flaggedIds.filter((m) => analyses.get(m)?.fineTuneOf !== undefined);
    const changelogIds = flaggedIds.filter((m) => analyses.get(m)?.row?.namedAs !== undefined && !fineTuneIds.includes(m));
    const readingIds = [...changelogIds, ...fineTuneIds];
    const providerIds = flaggedIds.filter((m) => !readingIds.includes(m));
    const providerOf = (m: string) => {
      const a = analyses.get(m);
      return a?.row && !notAFlag(a.row.word) ? a.row.provider : (a?.profile?.provider ?? a?.row?.provider ?? '');
    };
    const flaggers = [...new Set(providerIds.map(providerOf))];
    const who = flaggers.length === 1 ? providerWord(flaggers[0]!) : 'their providers';
    const changelogPages = [...new Set(changelogIds.map((m) => `${analyses.get(m)!.row!.provider}|${analyses.get(m)!.row!.url}`))];
    const changelogWho =
      changelogPages.length === 1
        ? pageName(changelogPages[0]!.split('|')[0]!, changelogPages[0]!.split('|')[1]!)
        : 'their providers’ release notes';
    const readingWho = andList([
      ...(changelogIds.length ? [changelogWho] : []),
      ...(fineTuneIds.length ? [fineTuneIds.length === 1 ? "a fine-tune's id" : "fine-tunes' ids"] : []),
    ]);
    const isAre = (n: number) => (n === 1 ? 'is' : 'are');
    const sentences: string[] = [`${count(extract.callSites.length, 'AI call site')} and ${count(models.length, 'model id')}: ${models.map(label).join(', ')}.`];
    if (providerIds.length && readingIds.length)
      sentences.push(`${providerIds.length} ${isAre(providerIds.length)} flagged by ${who}, and ${readingIds.length} by this check's reading of ${readingWho}.`);
    else if (providerIds.length) sentences.push(`${providerIds.length} ${isAre(providerIds.length)} flagged by ${who}.`);
    else if (readingIds.length) sentences.push(`${readingIds.length} ${isAre(readingIds.length)} flagged by this check's reading of ${readingWho}.`);
    if (unknown > 0) sentences.push(`${unknown} ${isAre(unknown)} not recognised.`);
    if (flagged === 0 && unknown < models.length)
      sentences.push(
        unknown === 0
          ? models.length === 1
            ? 'Its provider does not flag it.'
            : 'No provider flags any of them.'
          : models.length - unknown === 1
            ? 'The other one is not flagged by its provider.'
            : `No provider flags the other ${models.length - unknown}.`,
      );
    if (stated && flagged > 0) {
      const ks = CONTEXT_ORDER.map((o) => o ?? 'unstated').filter((k) => (byCtx.get(k) ?? 0) > 0);
      if (flagged === 1) {
        const k = ks[0]!;
        sentences.push(k === 'unstated' ? 'The extract does not say where the flagged id is written.' : `The flagged id is ${CONTEXT_WORDS[k]!(1).replace(/^1 /, '')}.`);
      } else {
        const parts = ks.map((k, i) => {
          const n = byCtx.get(k)!;
          const w = CONTEXT_WORDS[k]!(n);
          return i === 0 ? w.replace(/^(\d+) /, `$1 ${isAre(n)} `) : w;
        });
        sentences.push(`Of the ${count(flagged, 'flagged id')}, ${andList(parts)}.`);
        // 0.4.4 Amendment A3: the counting rule is said only when it did something — when a flagged id is written in more
        // than one kind of place, and so was counted under one of them. The order is the one ctxClass counts by.
        const several = flaggedIds.filter((m) => kindsOf(m).size > 1).length;
        if (several > 0) {
          const order = CONTEXT_ORDER.map((o) => CONTEXT_PLACE[o ?? 'unstated']!).join(', ');
          sentences.push(
            several === 1
              ? `1 of them is written in more than one kind of place, and is counted once, under the first that applies in this order: ${order}.`
              : `${several} of them are written in more than one kind of place, and each is counted once, under the first that applies in this order: ${order}.`,
          );
        }
      }
    }
    lines.push(sentences.join(' '));
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
  // 0.4.5 (R7 a): a card that says "the catalog" says once, in its footer, what the catalog is
  const saysCatalog = /\bthe catalog\b/i.test(lines.join('\n'));
  lines.push('');
  lines.push('---');
  if (saysCatalog) lines.push(`*${CATALOG_SENTENCE}*`);
  // 0.4.6 Amendment B4: the footer counts the lines that say a page was not read in this run (stateWords' sentences)
  const saying = findings.filter((f) => NOT_READ_SAID.test(`${f.detail} ${f.basis}`)).length;
  lines.push(`*${destinationSentence(read, share, extra.surface ?? 'cli', saying)}*`);
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
