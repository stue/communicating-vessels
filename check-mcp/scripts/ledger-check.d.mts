export declare function oneRowIn(pageRows: string[], cells: string[]): boolean;
export declare function replacementForm(cell: string): 'ids-in-text' | 'text' | undefined;
export declare function quoteOn(text: string, quote: string): boolean;
export declare const PAGE_URL: {
  anthropic: string;
  openai: string;
  openaiModel: (id: string) => string;
  google: string;
  googleChangelog: string;
  deepseekUpdates: string;
  deepseekNews: string;
};
export declare function pageFileOf(url: string): string | undefined;
export declare function htmlToText(html: string): string;
export declare function googlePageRows(dep: string): string[];
export declare function googleTableRows(dep: string): { h2: string | null; h3: string | null; cells: string[] }[];
export declare function googleRowCells(r: { cells: string[] }): string[];
