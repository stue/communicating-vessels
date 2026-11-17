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
  deepseekNews: string;
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
}
export declare const PAGE_SHAPES: Record<string, PageShape>;
export declare function pageShapeOf(file: string): PageShape | undefined;
export declare function pageShapeMisses(file: string, text: string): string[];

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
export declare function quoteStands(text: string, quote: string, table: boolean): boolean;

export type PageAnswer = { ok: true; text: string; at: string } | { ok: false; reason: string };
export type RowState =
  | { state: 'confirmed'; at: string }
  | { state: 'changed'; at: string; gone: RowTest[] }
  | { state: 'unread'; reason: string };
export declare function rowState(r: QuotedRow, pageOf: (url: string) => PageAnswer): RowState;
export declare function definitionState(d: { url: string; quote: string }, pageOf: (url: string) => PageAnswer): RowState;
