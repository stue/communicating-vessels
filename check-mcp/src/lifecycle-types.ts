/**
 * The lifecycle ledger's row shape (R1). The data lives in
 * `lifecycle-ledger.ts`, generated from the providers' saved pages by
 * `scripts/build-ledger.mjs` — never typed by hand.
 */
export type LedgerProvider = 'anthropic' | 'openai' | 'google' | 'deepseek';

/** The provider's word, mapped onto one small set. `pageWord` keeps the page's own text. */
export type LedgerWord =
  | 'deprecated'
  | 'retired'
  | 'shut down'
  | 'legacy'
  | 'rerouted'
  | 'scheduled for shutdown'
  | 'listed'
  | 'no longer supported';

/**
 * 0.4.2 Amendment A1: `listed` is not a provider word about the model's end. It is a table row on the provider's
 * deprecation page with no shutdown date and no deprecation word; `pageWord` keeps the page's own words for it.
 *
 * 0.4.3 (R6): `no longer supported` is Google's changelog's own phrase ("Gemini 1.0 Pro is no longer supported."),
 * added rather than mapped onto `shut down` or `retired`, which the changelog does not say of these models.
 */
export const LEDGER_WORDS: readonly LedgerWord[] = [
  'deprecated',
  'retired',
  'shut down',
  'legacy',
  'rerouted',
  'scheduled for shutdown',
  'listed',
  'no longer supported',
];

export interface LedgerRow {
  /** The model id exactly as the page writes it. */
  id: string;
  provider: LedgerProvider;
  word: LedgerWord;
  /** The page's own status text for this row (a table cell, a section heading or a sentence). */
  pageWord: string;
  /** ISO date the page gives for the announcement / deprecation, when it gives one. */
  announced?: string;
  /** ISO date the page gives for retirement, shutdown or discontinuation. */
  shutdown?: string;
  /** ISO date the page gives as a floor ("not sooner than", "at earliest"). */
  shutdownFloor?: string;
  /** The page's date text, verbatim. */
  dateText?: string;
  /** The replacement the page names, backticks removed. */
  replacement?: string;
  /** 0.4.2 Amendment A2: set when the replacement cell is not a plain list of model ids — words only, or ids inside a sentence. */
  replacementForm?: 'text' | 'ids-in-text';
  /** Where the page says requests to this id are now routed. */
  routesTo?: string;
  /** DeepSeek: the model the page said the name pointed to when it announced the discontinuation. */
  pointedTo?: string;
  /** How the id was matched when the page names it by display name ("GPT-4o (…)"). */
  matchedBy?: 'display-name';
  /** The page section the row sits in, when the page is split by family. */
  section?: string;
  /** A second sentence from the same page that the row relies on. */
  note?: string;
  url: string;
  /** ISO date the page was read. */
  readOn: string;
  /** The page line (or sentence) the row was built from, verbatim. */
  quote: string;
  /** A second page that confirms the row, with its own quote and read date. */
  alsoUrl?: string;
  alsoQuote?: string;
  alsoReadOn?: string;
  /**
   * 0.4.3 (R6): set on a row from Google's changelog that names the model in words, not by its id — the words it
   * names it by ("Gemini 1.0 Pro"). The link from the id to that name is ours, so such a row's line is never Certain.
   */
  namedAs?: string;
  /** 0.4.3 (R6): the changelog entry's date heading the quote sits under, as the page writes it. */
  entryHeading?: string;
  /** 0.4.3 (R6): the date heading of the `alsoQuote` entry (the changelog's own introduction of the id). */
  alsoHeading?: string;
  /** 0.4.3 (R6): Google's model page for this id, requested by the generator at build time (never at run time). */
  modelPage?: { url: string; status: number; at: string };
}

/** 0.4.2: a provider's own definition of a word the card quotes, verbatim from the page it cites. */
export interface LedgerDefinition {
  provider: LedgerProvider;
  word: LedgerWord;
  url: string;
  quote: string;
}

export interface LedgerSource {
  provider: LedgerProvider;
  url: string;
  /** ISO UTC time of the curl. */
  readAt: string;
  /** sha256 of the saved page bytes. */
  sha256: string;
  /** 0.4.4 (R6): the page's own title, as the generator read it from the saved page (and asserted, as part of its shape). */
  title: string;
}
