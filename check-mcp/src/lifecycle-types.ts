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
  | 'no longer supported'
  | 'active';

/**
 * 0.4.2 Amendment A1: `listed` is not a provider word about the model's end. It is a table row on the provider's
 * deprecation page with no shutdown date and no deprecation word; `pageWord` keeps the page's own words for it.
 *
 * 0.4.3 (R6): `no longer supported` is Google's changelog's own phrase ("Gemini 1.0 Pro is no longer supported."),
 * added rather than mapped onto `shut down` or `retired`, which the changelog does not say of these models.
 *
 * 0.4.5 (R3): `active` is Anthropic's status table's own state word for a model it has announced no retirement for.
 * Such a row keeps the page's date text verbatim (`dateText`, "Not sooner than November 24, 2026") and its floor in
 * `shutdownFloor`. It is not a flag: the card never counts it as one.
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
  'active',
];

/**
 * 0.4.5: the words a provider's sentence the card quotes is kept under (LEDGER_DEFINITIONS). Besides the
 * definitions of a row's word, two sentences are kept the same way, checked on their page by the generator,
 * by the drift script and by the run-time read: Anthropic's notice period, under `notice period` (R4 b), and OpenAI's
 * sentence about fine-tunes, under `fine-tuned versions` (R5). Neither is a row word, so neither is quoted as the
 * definition of one.
 */
export type DefinitionWord =
  | LedgerWord
  | 'notice period'
  | 'fine-tuned versions'
  /**
   * 0.4.7 (R4): OpenAI's historical note on fine-tunes of the legacy GPT models shut down in October 2026; quoted on the
   * card for a fine-tune whose base is on a row the note's own link ties it to (fineTuneNoteTie, src/ledger-check.mjs).
   */
  | 'fine-tunes of the October 2026 shutdown'
  /** 0.4.7 (R4): four more of OpenAI's sentences about fine-tuned models, read and checked on their page, not printed. */
  | 'existing fine-tuned models'
  | 'fine-tuning training on babbage-002 and davinci-002'
  | 'fine-tunes of the GPT-3.5 Turbo snapshots'
  | 'the legacy fine-tunes endpoint'
  /** 0.4.7 (R5): Anthropic's two sentences naming the platforms its dates apply to and those that set their own. */
  | 'operated platforms'
  /**
   * 0.4.7, fix pass 1: Google's sentence that the models and agents under "Deprecated models" and "Deprecated agents" are
   * already shut down — what makes *shut down* Google's own word for those rows (`--model-facts` quotes it).
   */
  | 'already-shutdown sections';

/**
 * 0.4.7 (R3): a second row of the same page for the same id. The ledger keeps the first row's facts; the second is
 * carried whole, said on the card, and checked on its page like the first.
 */
export interface SecondRow {
  /** The second row's line, verbatim (a Google row: its four cells joined by " | ", as the first row's quote). */
  quote: string;
  /** The heading the second row sits under, as the page writes it (the nearest one). */
  heading: string;
  /** Its date cell, verbatim, when it has one. */
  dateText?: string;
  /** Its replacement cell, backticks and links removed, when it names one. */
  replacement?: string;
  /** Set when the id sits in the second row inside a cell that names a feature, not a model ("Fine-tuning on `ada`"). */
  feature?: true;
}

export interface LedgerRow {
  /** The model id exactly as the page writes it. */
  id: string;
  provider: LedgerProvider;
  word: LedgerWord;
  /**
   * The page's own status text for this row (a table cell, a section heading or a sentence), verbatim on the page the row
   * cites — or, where `pageWordUrl` says so, on its second page. 0.4.7 (R1): absent when the page has no such words; the
   * generator stops on a row whose `pageWord` is not on its page (src/ledger-check.mjs `wordOn`). Until 0.4.7 it was
   * always present and held this check's own words on 124 rows of 326 (those are `ourWord` now).
   */
  pageWord?: string;
  /** 0.4.7 (R1): set when `pageWord` is on the row's second page (its `alsoUrl`), not the page it cites. */
  pageWordUrl?: string;
  /**
   * 0.4.7 (R1): what this check wrote about the row in its own words (a heading path, a join of a heading and a cell, a
   * description of a date). Never printed as a provider's word.
   */
  ourWord?: string;
  /**
   * 0.4.7 (R6): set where `word` is not the page's own: `date` — this check read it from the page's date against the day
   * the page was read (OpenAI's past table: a `Shutdown date` that is past, and no status word, is read as `shut down`;
   * fix pass 1: not Google's rows under "Deprecated models", whose word is Google's own); `ours` — the page gives no status
   * word for it (a date alone, or a replacement cell that routes requests).
   */
  wordBy?: 'date' | 'ours';
  /** 0.4.7 (R1): an OpenAI row's table, by its heading on the page ("Upcoming deprecations", "Past deprecations"). */
  table?: string;
  /** 0.4.7 (R2): a Google table row's column names, read from its table's header row, for a row the card quotes by column. */
  columns?: string[];
  /** 0.4.7 (R3): the page's second row for this id, when it has one. */
  secondRow?: SecondRow;
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
  /**
   * 0.4.8 (R1): the notice the page prints above this row — on Google's page, a `{% callout %}` under the row's section
   * heading that names the row's id and its route target — verbatim, whitespace flattened, links reduced to their text,
   * nothing cut. Set only on a routed row. Checked on the row's page in each run like `quote` (R5).
   */
  notice?: string;
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
  word: DefinitionWord;
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
