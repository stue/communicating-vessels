export declare function oneRowIn(pageRows: string[], cells: string[]): boolean;
export declare function replacementForm(cell: string): 'ids-in-text' | 'text' | undefined;
export declare function quoteOn(text: string, quote: string): boolean;
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
}
export interface RowTest {
  url: string;
  quote: string;
  what: 'quote' | 'note' | 'also' | 'definition';
  table: boolean;
}
export declare function isGoogleTableRow(r: QuotedRow): boolean;
export declare function rowTests(r: QuotedRow): RowTest[];
export declare function rowPages(r: QuotedRow): string[];
export declare function quoteStands(text: string, quote: string, table: boolean): boolean;

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
