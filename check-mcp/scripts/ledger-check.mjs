/**
 * The ledger generator's checks (Amendment B, ruling 3; tested since Amendment C), shared by
 * scripts/build-ledger.mjs, which writes the ledger, and scripts/ledger-drift.mjs (0.4.2, R2), which
 * asks of a saved set of pages whether each row's quoted line is still on them. One matcher, two callers.
 *
 *  - oneRowIn: a row built from a page table is accepted only if every one of its cells appears, in
 *    order, inside ONE of the page's own rows — a row stitched from two page rows is refused.
 *  - quoteOn: any other row's quote must be on the page it cites (whitespace-normalized).
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
