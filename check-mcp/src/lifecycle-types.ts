/**
 * The lifecycle ledger's row shape (R1). The data lives in
 * `lifecycle-ledger.ts`, generated from the providers' saved pages by
 * `scripts/build-ledger.mjs` — never typed by hand.
 */
export type LedgerProvider = 'anthropic' | 'openai' | 'google' | 'deepseek';

/** The provider's word, mapped onto one small set. `pageWord` keeps the page's own text. */
export type LedgerWord = 'deprecated' | 'retired' | 'shut down' | 'legacy' | 'rerouted' | 'scheduled for shutdown';

export const LEDGER_WORDS: readonly LedgerWord[] = ['deprecated', 'retired', 'shut down', 'legacy', 'rerouted', 'scheduled for shutdown'];

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
}

export interface LedgerSource {
  provider: LedgerProvider;
  url: string;
  /** ISO UTC time of the curl. */
  readAt: string;
  /** sha256 of the saved page bytes. */
  sha256: string;
}
