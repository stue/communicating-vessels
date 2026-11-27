export declare function oneRowIn(pageRows: string[], cells: string[]): boolean;
export declare function replacementForm(cell: string): 'ids-in-text' | 'text' | undefined;
export declare function quoteOn(text: string, quote: string): boolean;
/** 0.4.7 (R1): the one link strip, and the comparison of a pageWord with a page's text. */
export declare function unlinked(s: string): string;
export declare function wordOn(text: string, word: string): boolean;
export declare function pageWordMisses(
  rows: readonly { id: string; provider: string; url: string; pageWord?: string; pageWordUrl?: string; alsoUrl?: string }[],
  textOf: (url: string) => string | undefined,
): string[];
/** 0.4.7 (R2): the page's whole sentence around a match in a flattened text. */
export declare function sentenceAround(flatText: string, index: number, length: number): string;
/** 0.4.7 (R4): what OpenAI's note on fine-tunes ties it to, read from the note. */
export declare function fineTuneNoteTie(note: string): { notice: string; month: string } | undefined;
export declare function fineTuneNoteTies(note: string, row: { provider: string; table?: string; announced?: string; shutdown?: string }): boolean;
export declare const PAGE_URL: {
  anthropic: string;
  openai: string;
  openaiModel: (id: string) => string;
  google: string;
  googleChangelog: string;
  googleModel: (id: string) => string;
  deepseekUpdates: string;
  deepseekFirstApiCall: string;
};
export declare function pageFileOf(url: string): string | undefined;
export declare function htmlToText(html: string): string;
export declare function googlePageRows(dep: string): string[];
export declare function googleTableRows(dep: string): { h2: string | null; h3: string | null; cells: string[] }[];
export declare function googleRowCells(r: { cells: string[] }): string[];
export declare function pageTextOf(file: string, raw: string): string;
/** 0.4.8 (R1, R2): Google's callouts, and the notice each routed row carries. */
export declare function googleCallouts(dep: string): { h2: string | null; h3: string | null; text: string }[];
export declare function noticeHolds(notice: string, row: { routesTo?: string; dateText?: string }): boolean;
export declare function googleNotices(dep: string): { notices: { id: string; section: string; notice: string }[]; stops: string[]; notes: string[] };

/** 0.4.6 (R6): the generator's table parsers, exported. */
export declare function anthropicStatusRows(text: string): { id: string; state: string; dep: string; ret: string; line: string }[];
export declare function anthropicHistoryRows(text: string): { id: string; retirementText: string; replacement: string; note: string | null; section: string | null; line: string }[];
export declare function openaiTableRows(text: string): { part: 'upcoming' | 'past'; section: string | null; header: string[]; cells: string[]; line: string }[];
export declare function openaiColumns(header: string[]): { date: number; model: number; replacement: number; notice: number; status: number };
export declare const TABLE_ID: RegExp;
export declare function tableIds(file: string, text: string): { id: string; table: string; line: string; kind: 'model' | 'feature' }[];

export interface PageShape {
  expects: string[];
  misses(text: string, file?: string): string[];
  /** 0.4.4 (R6): the page's own title, read where the page writes it. */
  title(text: string): string | undefined;
  /** 0.4.4 (R6): the title this version expects of the page (part of its shape). */
  expectedTitle(file: string): string | undefined;
  /** 0.4.4 (R6): the card's name for the page, made from its title. */
  name(title: string): string;
}
export declare const PAGE_SHAPES: Record<string, PageShape>;
export declare const OPENAI_MODEL_TITLE: Record<string, string>;
export declare function pageShapeOf(file: string): PageShape | undefined;
export declare function pageShapeMisses(file: string, text: string): string[];
export declare function pageTitleOf(file: string, text: string): string | undefined;
export declare function pageNameOf(file: string, title: string | undefined): string;

export interface QuotedRow {
  url: string;
  quote: string;
  section?: string;
  note?: string;
  alsoUrl?: string;
  alsoQuote?: string;
  /** 0.4.7 (R3): the page's second row for the id, checked like the first. */
  secondRow?: { quote: string };
  /** 0.4.8 (R5): the notice above the row, checked on the row's page like its quote. */
  notice?: string;
}
export interface RowTest {
  url: string;
  quote: string;
  what: 'quote' | 'notice' | 'second' | 'note' | 'also' | 'definition';
  table: boolean;
}
export declare function isGoogleTableRow(r: QuotedRow): boolean;
export declare function rowTests(r: QuotedRow): RowTest[];
export declare function rowPages(r: QuotedRow): string[];
export declare function quoteStands(text: string, quote: string, table: boolean, what?: RowTest['what']): boolean;

export type PageAnswer = { ok: true; text: string; at: string } | { ok: false; reason: string };
/** 0.4.4 (R4): a page a row rests on that was read in this run, and whether it still carries its part of the row. */
export interface PageReadForRow {
  url: string;
  at: string;
  stands: boolean;
}
/** 0.4.4 (R4): a page a row rests on that was not read in this run, and why. */
export interface PageNotReadForRow {
  url: string;
  reason: string;
}
export type RowState =
  | { state: 'confirmed'; at: string; read?: PageReadForRow[] }
  | { state: 'changed'; at: string; gone: RowTest[]; read?: PageReadForRow[] }
  | { state: 'unread'; reason: string; notRead?: PageNotReadForRow[]; read?: PageReadForRow[] };
export declare function rowState(r: QuotedRow, pageOf: (url: string) => PageAnswer): RowState;
export declare function definitionState(d: { url: string; quote: string }, pageOf: (url: string) => PageAnswer): RowState;
