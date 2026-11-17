/**
 * The ledger generator's checks (Amendment B, ruling 3; tested since Amendment C), shared by
 * scripts/build-ledger.mjs, which writes the ledger, scripts/ledger-drift.mjs (0.4.2, R2), which
 * asks of a saved set of pages whether each row's quoted line is still on them, and (0.4.3, R1) the
 * shipped check's run-time read (src/pages.ts). One matcher, three callers. Plain JavaScript in the
 * package's source, so the scripts import it without a build and the bundle carries it.
 *
 *  - oneRowIn: a row built from a page table is accepted only if every one of its cells appears, in
 *    order, inside ONE of the page's own rows — a row stitched from two page rows is refused.
 *  - quoteOn: any other row's quote must be on the page it cites (whitespace-normalized).
 *  - pageShapeMisses (0.4.3, R3): what this version expects of each page's shape; a page that misses
 *    a piece is not the page this version reads.
 *  - rowState (0.4.3, R1): a ledger row against a set of pages — confirmed, changed or unread.
 */
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** @param {string[]} pageRows the page's rows, as text  @param {string[]} cells the cells of one ledger row */
export function oneRowIn(pageRows, cells) {
  return pageRows.some((row) => {
    const seg = flat(row);
    let at = 0;
    for (const c of cells) {
      const i = seg.indexOf(flat(c), at);
      if (i === -1) return false;
      at = i + flat(c).length;
    }
    return true;
  });
}

/** @param {string} text the page's text  @param {string} quote a row's quote */
export function quoteOn(text, quote) {
  return flat(text).includes(flat(quote));
}

/**
 * 0.4.2 Amendment A2: what a replacement cell holds, read from the page's own code marks.
 *  - undefined: model ids only (in backticks), joined by commas, "or", "and" — the card says "its page names".
 *  - 'ids-in-text': ids inside a sentence — the card quotes the cell whole.
 *  - 'text': no id at all, only words — the card quotes it, and never calls it a name.
 * @param {string} cell the raw cell, backticks and links as on the page
 * @returns {'ids-in-text' | 'text' | undefined}
 */
export function replacementForm(cell) {
  const raw = cell.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const ID = /^[a-z0-9][a-z0-9.:-]*$/i;
  const ids = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => ID.test(t));
  const rest = raw
    .replace(/`([^`]+)`/g, (m, t) => (ID.test(t) ? ' ' : m))
    .replace(/[,;]|\b(or|and)\b/g, ' ')
    .trim();
  if (rest === '') return undefined;
  return ids.length ? 'ids-in-text' : 'text';
}

/** The pages the generator reads: each source URL and the file name it is saved under in --pages <dir>. */
export const PAGE_URL = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
  openai: 'https://developers.openai.com/api/docs/deprecations.md',
  openaiModel: (id) => `https://developers.openai.com/api/docs/models/${id}.md`,
  google: 'https://aistudio.google.com/docs/deprecations',
  googleChangelog: 'https://aistudio.google.com/docs/changelog',
  /** 0.4.3 (R6): a Google model page — requested by the generator only, for a changelog row's id; never at run time. */
  googleModel: (id) => `https://aistudio.google.com/docs/models/${id}`,
  deepseekUpdates: 'https://api-docs.deepseek.com/updates',
  deepseekNews: 'https://api-docs.deepseek.com/news',
};

/** The saved file name for a source URL, or undefined for a URL the generator does not read. */
export function pageFileOf(url) {
  const fixed = {
    [PAGE_URL.anthropic]: 'anthropic-deprecations.md',
    [PAGE_URL.openai]: 'openai-deprecations.md',
    [PAGE_URL.google]: 'google-deprecations.html',
    [PAGE_URL.googleChangelog]: 'google-changelog.html',
    [PAGE_URL.deepseekUpdates]: 'deepseek-updates.html',
    [PAGE_URL.deepseekNews]: 'deepseek-news.html',
  };
  if (fixed[url]) return fixed[url];
  const m = /^https:\/\/developers\.openai\.com\/api\/docs\/models\/([a-z0-9.-]+)\.md$/.exec(url);
  return m ? `openai-model-${m[1]}.md` : undefined;
}

/** A saved HTML page as the generator reads it: scripts and styles dropped, block ends as newlines, tags removed. */
export function htmlToText(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  t = t.replace(/<\/(tr|p|h\d|li|div)>/g, '\n').replace(/<[^>]+>/g, '');
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Google's deprecations page (as htmlToText gives it): its own rows, the text between consecutive `---` separator lines. */
export function googlePageRows(dep) {
  return dep.split(/\n---\n|\{% \/?table %\}/).map((s) => s.replace(/\s+/g, ' '));
}

/** Google's deprecations page tables, row by row: { h2, h3, cells }. */
export function googleTableRows(dep) {
  const lines = dep.split('\n');
  let h2 = null;
  let h3 = null;
  let inTable = false;
  let cur = [];
  const tableRows = [];
  for (const ln of lines) {
    if (ln.startsWith('## ')) {
      h2 = ln.slice(3).replace(/\{%.*%\}/, '').trim();
      h3 = null;
      continue;
    }
    if (ln.startsWith('### ')) {
      h3 = ln.slice(4).replace(/\{%.*%\}/, '').trim();
      continue;
    }
    if (ln.startsWith('{% table')) {
      inTable = true;
      cur = [];
      continue;
    }
    if (ln.startsWith('{% /table')) {
      if (cur.length) tableRows.push({ h2, h3, cells: cur });
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    if (ln === '---') {
      if (cur.length) tableRows.push({ h2, h3, cells: cur });
      cur = [];
      continue;
    }
    if (ln.startsWith('*')) cur.push(ln.replace(/^\*\s?/, '').trim());
    else if (cur.length) cur[cur.length - 1] += ' ' + ln;
  }
  return tableRows;
}

/** The four cells of a Google table row that a ledger row quotes, in order (model, the second column, shutdown, replacement). */
export function googleRowCells(r) {
  return [r.cells[0], r.cells[1] ?? '', r.cells[2] ?? '', r.cells[3] ?? ''];
}

/** A saved page's text as every caller checks against it: HTML through htmlToText, markdown as it is. */
export function pageTextOf(file, raw) {
  return file.endsWith('.html') ? htmlToText(raw) : raw;
}

// ── 0.4.3 (R3): the shape this version expects of each page ─────────────
// Derived from the ten pages as fetched for the 0.4.3 build (2026-11-16T22:54:38–41Z). Each entry
// names the pieces the generator reads a row from: a table's column names, the headings its rows sit
// under, a non-empty status word. A page that misses any piece is not the page this version reads —
// the generator stops on it, and the run-time read treats it as unread (a consent page, a login page,
// another page's body, or a rewrite of the page).

const mdCells = (ln) =>
  ln
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.replace(/\\\|/g, '|').trim());
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
/** The markdown section under `## <heading>` (to the next `## `), as lines; undefined when the heading is absent. */
function mdSection(text, heading) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (i === -1) return undefined;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.startsWith('## ')) break;
    out.push(l);
  }
  return out;
}
/** Every markdown table in some lines: { header, rows }. */
function mdTables(lines) {
  const tables = [];
  let cur = null;
  for (const l of lines) {
    if (!l.startsWith('|')) {
      cur = null;
      continue;
    }
    const cells = mdCells(l);
    if (isSeparator(cells)) continue;
    if (!cur) {
      cur = { header: cells, rows: [] };
      tables.push(cur);
    } else cur.rows.push(cells);
  }
  return tables;
}
const sameColumns = (a, b) => a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i].toLowerCase());
const cols = (c) => c.map((x) => `"${x}"`).join(', ');

/** A markdown section whose first table has exactly these columns; `status` names a column every row must fill with a word. */
function mdTableExpect(text, heading, columns, status) {
  const sec = mdSection(text, heading);
  if (!sec) return [`the heading "## ${heading}"`];
  const t = mdTables(sec)[0];
  if (!t || !sameColumns(t.header, columns)) return [`a table under "## ${heading}" with the columns ${cols(columns)}`];
  if (t.rows.length === 0) return [`a row in the table under "## ${heading}"`];
  if (status !== undefined) {
    const i = columns.indexOf(status);
    if (t.rows.some((r) => !/^[A-Za-z][A-Za-z ]*$/.test((r[i] ?? '').replace(/\*\*/g, '').trim())))
      return [`a "${status}" word on every row of the table under "## ${heading}"`];
  }
  return [];
}

const GOOGLE_TABLE_HEADERS = [
  ['Model', 'Release date', 'Shutdown date', 'Recommended replacement'],
  ['Agent', 'Release date', 'Shutdown date', 'Recommended replacement'],
];

/**
 * What this version expects of each page, in words (for the report and a refusal), and the check.
 * Keys are the saved file names (pageFileOf); `openai-model-*.md` stands for each OpenAI model page.
 */
export const PAGE_SHAPES = {
  'anthropic-deprecations.md': {
    expects: [
      'under "## Model status", a table with the columns "API model name", "Current state", "Deprecated", "Tentative retirement date", a state word on every row',
      'under "## Deprecation history", a table with the columns "Retirement date", "Deprecated model", "Recommended replacement"',
    ],
    misses(text) {
      const m = mdTableExpect(text, 'Model status', ['API model name', 'Current state', 'Deprecated', 'Tentative retirement date'], 'Current state');
      const sec = mdSection(text, 'Deprecation history');
      const h = !sec
        ? ['the heading "## Deprecation history"']
        : mdTables(sec).some((t) => sameColumns(t.header, ['Retirement date', 'Deprecated model', 'Recommended replacement']))
          ? []
          : ['a table under "## Deprecation history" with the columns "Retirement date", "Deprecated model", "Recommended replacement"'];
      return [...m, ...h];
    },
  },
  'openai-deprecations.md': {
    expects: [
      'under "## Upcoming deprecations", a table with the columns "Shutdown date", "Affected model", "Status", "Recommended replacement", "Notice date", a status word on every row',
      'under "## Past deprecations", a table with the columns "Shutdown date", "Affected model or feature", "Listed replacement", "Notice date"',
    ],
    misses(text) {
      return [
        ...mdTableExpect(text, 'Upcoming deprecations', ['Shutdown date', 'Affected model', 'Status', 'Recommended replacement', 'Notice date'], 'Status'),
        ...mdTableExpect(text, 'Past deprecations', ['Shutdown date', 'Affected model or feature', 'Listed replacement', 'Notice date']),
      ];
    },
  },
  'openai-model-*.md': {
    expects: [
      'a "# <model name>" heading',
      'Amendment B1: a "Model ID: `<id>`" line naming the model the URL names (<id> = the URL\'s last segment without ".md")',
      'a "Status: <word>" line',
    ],
    misses(text, file = '') {
      const out = [];
      if (!/^# \S/m.test(text)) out.push('a "# <model name>" heading');
      // Amendment B1: the page is the page asked for — its own id line names the model the URL names. Another deprecated
      // model's page has the same shape and the same "Status: Deprecated", and must not confirm this model's rows.
      const id = /^openai-model-([a-z0-9.-]+)\.md$/.exec(file)?.[1];
      const line = /^Model ID: `([^`]+)`\s*$/m.exec(text)?.[1];
      if (!id || line !== id) out.push(`a "Model ID: \`${id ?? '<id>'}\`" line (found ${line === undefined ? 'none' : `\`${line}\``})`);
      if (!/^Status: [A-Za-z]/m.test(text)) out.push('a "Status: <word>" line');
      return out;
    },
  },
  'google-deprecations.html': {
    expects: [
      'tables whose header row is "Model | Release date | Shutdown date | Recommended replacement" (or "Agent | …" with the same three columns after it), at least one of the first',
      'a "## " heading over every table',
      'a "### Deprecated models" heading',
    ],
    misses(text) {
      const rows = googleTableRows(text);
      const headers = rows.filter((r) => !/`/.test(r.cells[0] ?? ''));
      const out = [];
      if (!headers.some((r) => sameColumns(r.cells, GOOGLE_TABLE_HEADERS[0])))
        out.push(`a table whose header row is ${cols(GOOGLE_TABLE_HEADERS[0])}`);
      const odd = headers.find((r) => !GOOGLE_TABLE_HEADERS.some((h) => sameColumns(r.cells, h)));
      if (odd) out.push(`a table header in the known columns (found ${cols(odd.cells)})`);
      if (rows.length === 0 || rows.some((r) => !r.h2)) out.push('a "## " heading over every table');
      if (!/^### Deprecated models/m.test(text)) out.push('a "### Deprecated models" heading');
      return out;
    },
  },
  'google-changelog.html': {
    expects: ['dated "## <Month> <D>, <YYYY>" headings', 'a "**Model updates:**" label under one of them'],
    misses(text) {
      const out = [];
      if (!/^## [A-Z][a-z]+ \d{1,2},? \d{4}/m.test(text)) out.push('a dated "## <Month> <D>, <YYYY>" heading');
      if (!/^\*\*Model updates:\*\*/m.test(text)) out.push('a "**Model updates:**" label');
      return out;
    },
  },
  'deepseek-updates.html': {
    expects: ['the title "Change Log | DeepSeek API Docs"', '"Date: YYYY-MM-DD" entry headings'],
    misses(text) {
      const out = [];
      if (text.split('\n')[0] !== 'Change Log | DeepSeek API Docs') out.push('the title "Change Log | DeepSeek API Docs"');
      if (!/^Date: \d{4}-\d{2}-\d{2}/m.test(text)) out.push('a "Date: YYYY-MM-DD" entry heading');
      return out;
    },
  },
  'deepseek-news.html': {
    expects: ['the title "Your First API Call | DeepSeek API Docs"', 'the parameter table\'s "base_url (OpenAI)" row'],
    misses(text) {
      const out = [];
      if (text.split('\n')[0] !== 'Your First API Call | DeepSeek API Docs') out.push('the title "Your First API Call | DeepSeek API Docs"');
      if (!text.includes('base_url (OpenAI)')) out.push('the parameter table\'s "base_url (OpenAI)" row');
      return out;
    },
  },
};

/** The shape entry for a saved file name, or undefined for a file this version does not read. */
export function pageShapeOf(file) {
  return PAGE_SHAPES[file] ?? (/^openai-model-[a-z0-9.-]+\.md$/.test(file) ? PAGE_SHAPES['openai-model-*.md'] : undefined);
}

/**
 * The pieces of its expected shape a page misses, in words; [] when it is the page this version reads.
 * @param {string} file the saved file name  @param {string} text the page's text, as pageTextOf gives it
 */
export function pageShapeMisses(file, text) {
  const s = pageShapeOf(file);
  if (!s) return [`a file this version reads (${file} is not one)`];
  return s.misses(text, file);
}

// ── 0.4.3 (R1): one row against a set of pages ──────────────────────────

/** Is a ledger row a table row of Google's deprecations page (checked as ONE page row, cell by cell in order)? */
export const isGoogleTableRow = (r) => r.url === PAGE_URL.google && r.section !== undefined;

/** Every quote a row rests on: its quote on its url, its note on the same page, its alsoQuote on its alsoUrl. */
export function rowTests(r) {
  const tests = [{ url: r.url, quote: r.quote, what: 'quote', table: isGoogleTableRow(r) }];
  if (r.note) tests.push({ url: r.url, quote: r.note, what: 'note', table: false });
  if (r.alsoUrl && r.alsoQuote) tests.push({ url: r.alsoUrl, quote: r.alsoQuote, what: 'also', table: false });
  return tests;
}

/** Is the quote on the page's text, by the generator's own check for that kind of row? */
export function quoteStands(text, quote, table) {
  return table ? oneRowIn(googlePageRows(text), quote.split(' | ')) : quoteOn(text, quote);
}

/**
 * One row against the pages: `pageOf(url)` answers `{ ok: true, text, at }` for a page read as the page
 * this version knows, or `{ ok: false, reason }`. A row is unread when any page it rests on is unread
 * (the drift script's "not checked"); else changed when a quote is not on its page; else confirmed.
 * @returns {{ state: 'confirmed', at: string } | { state: 'changed', at: string, gone: object[] } | { state: 'unread', reason: string }}
 */
export function rowState(r, pageOf) {
  const tests = rowTests(r);
  for (const t of tests) {
    const p = pageOf(t.url);
    if (!p.ok) return { state: 'unread', reason: p.reason };
  }
  const at = pageOf(r.url).at;
  const gone = tests.filter((t) => !quoteStands(pageOf(t.url).text, t.quote, t.table));
  return gone.length ? { state: 'changed', at, gone } : { state: 'confirmed', at };
}

/** A definition the card quotes, against the pages: confirmed, changed or unread, as a row. */
export function definitionState(d, pageOf) {
  const p = pageOf(d.url);
  if (!p.ok) return { state: 'unread', reason: p.reason };
  return quoteOn(p.text, d.quote) ? { state: 'confirmed', at: p.at } : { state: 'changed', at: p.at, gone: [{ url: d.url, quote: d.quote, what: 'definition' }] };
}
