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
 * 0.4.7 (R1): a markdown link `[text](url)` reduced to its text — the one link strip, applied the same way to a page's
 * text and to a string compared with it (`wordOn`), and to a quote the card prints. A string cut inside a link (one that
 * begins at the link's text, "`id`](/docs/…) is deprecated") loses the link's dangling end the same way.
 * @param {string} s
 */
export function unlinked(s) {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\]\([^)\s]*\)/g, '');
}

/**
 * 0.4.7 (R1, Amendment A7): is a row's `pageWord` on a page's text? The generator's own `quoteOn` (whitespace flattened)
 * with the link strip on both sides, then a substring test. The generator stops on a row whose `pageWord` fails it, and
 * scripts/page-word-sweep.mjs counts with it.
 * @param {string} text the page's text, as pageTextOf gives it  @param {string} word
 */
export function wordOn(text, word) {
  return quoteOn(unlinked(text), unlinked(word));
}

/**
 * 0.4.7 (R1): every row whose `pageWord` is not on the page it names — its own page, or the page `pageWordUrl` names —
 * in words; [] when every one is. `textOf(url)` gives a page's text as pageTextOf gives it (undefined: not in the set).
 * The generator stops on any; a row with no `pageWord` is not a miss.
 * @param {{ id: string, provider: string, url: string, pageWord?: string, pageWordUrl?: string, alsoUrl?: string }[]} rows
 * @param {(url: string) => string | undefined} textOf
 */
export function pageWordMisses(rows, textOf) {
  const out = [];
  for (const r of rows) {
    if (r.pageWord === undefined) continue;
    const url = r.pageWordUrl ?? r.url;
    if (r.pageWordUrl !== undefined && r.pageWordUrl !== r.alsoUrl) {
      out.push(`${r.provider} ${r.id}: its pageWord is said to be on ${r.pageWordUrl}, which is not a page the row rests on`);
      continue;
    }
    const text = textOf(url);
    if (text === undefined) out.push(`${r.provider} ${r.id}: ${url} is not in the page set, so its pageWord cannot be checked`);
    else if (!wordOn(text, r.pageWord)) out.push(`${r.provider} ${r.id}: its pageWord ${JSON.stringify(r.pageWord)} is not on ${url}`);
  }
  return out;
}

/**
 * 0.4.7 (R2): the page's whole sentence around a match in a flattened text, verbatim: from the end of the sentence or the
 * start of the list item before it, to the first full stop after it that ends a sentence (a "." before a space or the end).
 * A full stop inside a link's address or a version ("3.7") does not end it.
 * @param {string} flatText whitespace already flattened  @param {number} index  @param {number} length
 */
export function sentenceAround(flatText, index, length) {
  let start = 0;
  for (const m of flatText.slice(0, index).matchAll(/\.(?=\s)|(?:^|\s)\*\s/g)) start = m.index + m[0].length;
  const end = /\.(?=\s|$)/g;
  end.lastIndex = index + length;
  const e = end.exec(flatText);
  return flatText.slice(start, e ? e.index + 1 : flatText.length).trim();
}

/**
 * 0.4.7 (R4, Amendment A5): what OpenAI's note on fine-tunes of the legacy GPT models names, read from the note itself:
 * the date its link ends on ("#2026-04-22-legacy-gpt-model-snapshots": the notice date of the rows it means) and the month
 * its words give ("shut down in October 2026"), as `{ notice: 'YYYY-MM-DD', month: 'YYYY-MM' }`; undefined when the
 * note gives either one no more.
 * @param {string} note the note as the page writes it, its link kept
 */
export function fineTuneNoteTie(note) {
  const notice = /\]\([^)]*#(\d{4}-\d{2}-\d{2})-[^)]*\)/.exec(note)?.[1];
  const m = /shut down in ([A-Z][a-z]+) (\d{4})/.exec(note);
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const mo = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  if (!notice || !mo) return undefined;
  return { notice, month: `${m[2]}-${String(mo).padStart(2, '0')}` };
}

/**
 * Does the note tie this row? An OpenAI row of the past table whose notice date (`announced`) is the date the note's link
 * names and whose shutdown date falls in the month its words name — on the page of 2026-11-25, exactly the twelve rows shut
 * down on Oct 23, 2026 with the notice date Apr 22, 2026 (the month alone would add `gpt-5.4-cyber`, notice Sep 11, 2026).
 * @param {string} note  @param {{ provider: string, table?: string, announced?: string, shutdown?: string }} row
 */
export function fineTuneNoteTies(note, row) {
  const tie = fineTuneNoteTie(note);
  return (
    !!tie &&
    row.provider === 'openai' &&
    row.table === 'Past deprecations' &&
    row.announced === tie.notice &&
    (row.shutdown ?? '').startsWith(`${tie.month}-`)
  );
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
  /**
   * 0.4.4 (R6): the page titled "Your First API Call" — DeepSeek's quick-start page, which carries the sentence two rows
   * quote and /updates does not (read 2026-11-17T23:17:08Z). Named by its title.
   * 0.4.6 (R1): read at the address that serves it, the docs' root. On 2026-11-24 /news and /news/ answered 404 ("Page Not
   * Found | DeepSeek API Docs") and the root answered 200 with this page (until 0.4.5: https://api-docs.deepseek.com/news).
   */
  deepseekFirstApiCall: 'https://api-docs.deepseek.com/',
};

/** The saved file name for a source URL, or undefined for a URL the generator does not read. */
export function pageFileOf(url) {
  const fixed = {
    [PAGE_URL.anthropic]: 'anthropic-deprecations.md',
    [PAGE_URL.openai]: 'openai-deprecations.md',
    [PAGE_URL.google]: 'google-deprecations.html',
    [PAGE_URL.googleChangelog]: 'google-changelog.html',
    [PAGE_URL.deepseekUpdates]: 'deepseek-updates.html',
    [PAGE_URL.deepseekFirstApiCall]: 'deepseek-first-api-call.html',
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

// ── 0.4.8 (R1, R2): the notice above a routed row ───────────────────────
// Google's page prints a `{% callout %}` block under some "## " headings, above that section's table. Two of them, on the
// page read 2026-11-25 and again 2026-11-27, name a row whose requests route to another model and say what the row does
// not: that the requests are billed at the new model's rates, that the API has breaking changes, that access is limited.

/** Every callout on Google's page (as htmlToText gives it): { h2, h3, text } — `text` flattened, links reduced to their text. */
export function googleCallouts(dep) {
  const out = [];
  let h2 = null;
  let h3 = null;
  let cur = null;
  for (const ln of dep.split('\n')) {
    if (cur === null && ln.startsWith('## ')) {
      h2 = ln.slice(3).replace(/\{%.*%\}/, '').trim();
      h3 = null;
      continue;
    }
    if (cur === null && ln.startsWith('### ')) {
      h3 = ln.slice(4).replace(/\{%.*%\}/, '').trim();
      continue;
    }
    if (cur === null && /^\{% callout\b/.test(ln)) {
      cur = [];
      continue;
    }
    if (cur !== null && /^\{% \/callout %\}/.test(ln)) {
      out.push({ h2, h3, text: unlinked(flat(cur.join(' '))) });
      cur = null;
      continue;
    }
    if (cur !== null) cur.push(ln);
  }
  return out;
}

/**
 * Does a notice hold its row's route target (in code marks) and its row's date as the page writes it? The generator stops
 * on a notice that does not (R2); the card quotes the row beside a notice that does not (R3).
 * @param {string} notice  @param {{ routesTo?: string, dateText?: string }} row
 */
export function noticeHolds(notice, row) {
  const n = flat(notice);
  return !!row.routesTo && !!row.dateText && n.includes(`\`${row.routesTo}\``) && n.includes(flat(row.dateText));
}

/**
 * R1, R2: the notices of Google's page, read from its callouts and its tables — `notices`, one per routed row a callout
 * names: { id, section, notice }; `stops`, a callout this version does not read, in words with its text and its rows; and
 * `notes`, what was read and not written. A callout that names no id is no row's notice. A callout under a section heading
 * is the notice of each row of the table under the same heading that it names and whose requests route (the replacement
 * cell says so); an id it names that is a route target of one of those rows is read as the target. Stops: a callout above
 * every section that names an id; an id with no row under the callout's heading and not a route target there; a callout
 * that names rows of which none routes; a notice that does not hold its row's target and date; a row named by two callouts.
 * @param {string} dep the page's text, as pageTextOf gives it
 */
export function googleNotices(dep) {
  const tables = googleTableRows(dep).filter((r) => /`/.test(r.cells[0] ?? ''));
  const notices = [];
  const stops = [];
  const notes = [];
  const lineOf = (r) => googleRowCells(r).join(' | ');
  for (const c of googleCallouts(dep)) {
    const ids = [...new Set([...c.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => TABLE_ID.test(t)))];
    if (ids.length === 0) continue;
    const where = c.h2 === null ? 'above every "## " heading' : `under "## ${c.h2}${c.h3 ? ` › ${c.h3}` : ''}"`;
    if (c.h2 === null) {
      stops.push(`a callout ${where} names ${ids.map((i) => `\`${i}\``).join(', ')}; this version reads a notice under a section heading only\n  notice: ${c.text}`);
      continue;
    }
    const section = tables.filter((r) => r.h2 === c.h2 && (r.h3 ?? null) === c.h3);
    const rowOf = (id) => section.find((r) => (r.cells[0] ?? '').includes(`\`${id}\``));
    const routeOf = (r) => (/rout/i.test(r.cells[3] ?? '') ? (/`([^`]+)`/.exec(r.cells[3]) ?? [])[1] : undefined);
    const named = ids.map((id) => ({ id, r: rowOf(id) })).filter((x) => x.r);
    const routed = named.filter((x) => routeOf(x.r));
    const targets = new Set(section.map(routeOf).filter(Boolean));
    const stray = ids.filter((id) => !rowOf(id) && !targets.has(id));
    const rowsText = named.map((x) => `\n  row: ${lineOf(x.r)}`).join('');
    if (stray.length)
      stops.push(
        `a callout ${where} names ${stray.map((i) => `\`${i}\``).join(', ')}, ${stray.length === 1 ? 'which has no row in that section\'s table and is no row\'s route target there' : 'which have no row in that section\'s table and are no row\'s route target there'}\n  notice: ${c.text}${rowsText}`,
      );
    if (routed.length === 0) {
      if (named.length) stops.push(`a callout ${where} names ${named.map((x) => `\`${x.id}\``).join(', ')}, a row whose requests do not route; this version reads a notice above a routed row only\n  notice: ${c.text}${rowsText}`);
      continue;
    }
    for (const { id, r } of routed) {
      const to = routeOf(r);
      if (!noticeHolds(c.text, { routesTo: to, dateText: r.cells[2] ?? '' })) {
        stops.push(`the notice ${where} names \`${id}\` and does not give its row's route target \`${to}\` and its date "${flat(r.cells[2] ?? '')}"\n  notice: ${c.text}\n  row: ${lineOf(r)}`);
        continue;
      }
      if (notices.some((n) => n.id === id)) {
        stops.push(`\`${id}\` is named by a second callout ${where}; this version reads one notice per row\n  notice: ${c.text}`);
        continue;
      }
      notices.push({ id, section: c.h3 ? `${c.h2} › ${c.h3}` : c.h2, notice: c.text });
    }
    for (const { id } of named.filter((x) => !routeOf(x.r)))
      notes.push(`google: the notice ${where} also names \`${id}\`, a row of that table whose requests do not route; it is not that row's notice`);
  }
  return { notices, stops, notes };
}

// ── 0.4.6 (R6): the generator's table parsers, exported ─────────────────
// scripts/build-ledger.mjs reads every table row through these (until 0.4.6 the same loops were inline in it), and
// scripts/table-sweep.mjs reads the ids of each provider's tables through them, never through the ledger.

/** Anthropic's "## Model status" table, row by row, as the generator reads it: { id, state, dep, ret, line }. */
export function anthropicStatusRows(text) {
  const out = [];
  let inTable = false;
  for (const ln of text.split('\n')) {
    if (ln.startsWith('## Model status')) inTable = true;
    else if (ln.startsWith('## ') && inTable) inTable = false;
    if (!inTable) continue;
    const m = /^\|\s*(claude-[a-z0-9.-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(ln);
    if (!m) continue;
    out.push({ id: m[1], state: m[2], dep: m[3], ret: m[4], line: ln.trim() });
  }
  return out;
}

/**
 * Anthropic's "## Deprecation history" tables, row by row in page order, as the generator reads them:
 * { id, retirementText, replacement, note, section, line } — `section` the "### " heading above the row, `note` the
 * "This model was / These models were retired <date>." sentence under that heading, when there is one.
 */
export function anthropicHistoryRows(text) {
  const out = [];
  let section = null;
  let note = null;
  let inHistory = false;
  for (const ln of text.split('\n')) {
    if (ln.startsWith('## Deprecation history')) inHistory = true;
    else if (ln.startsWith('## ') && inHistory) inHistory = false;
    if (!inHistory) continue;
    if (ln.startsWith('### ')) {
      section = ln.slice(4).trim();
      note = null;
      continue;
    }
    const nm = /(This model was|These models were) retired ([A-Z][a-z]+ \d{1,2}, \d{4})\./.exec(ln);
    if (nm) note = nm[0];
    const rm = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/.exec(ln);
    if (rm) out.push({ id: rm[2], retirementText: rm[1], replacement: rm[3], note, section, line: ln.trim() });
  }
  return out;
}

/**
 * OpenAI's deprecations tables (under "## Upcoming deprecations" and "## Past deprecations"), each data row as the
 * generator reads it: { part, section, header, cells, line } — `header` the table's column names in lower case,
 * `section` the "###"/"####" heading above the table, if any.
 */
export function openaiTableRows(text) {
  const out = [];
  let part = null;
  let section = null;
  let header = null;
  for (const ln of text.split('\n')) {
    if (ln.startsWith('## Upcoming deprecations')) part = 'upcoming';
    else if (ln.startsWith('## Past deprecations')) part = 'past';
    else if (ln.startsWith('### Plain-text aliases')) part = null;
    else if (ln.startsWith('## ') && !/deprecations/i.test(ln)) part = null;
    if (!part) continue;
    if (ln.startsWith('### ') || ln.startsWith('#### ')) {
      section = ln.replace(/^#+\s*/, '').trim();
      header = null;
      continue;
    }
    if (!ln.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = ln.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.replace(/\\\|/g, '|').trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    out.push({ part, section, header, cells, line: ln.trim() });
  }
  return out;
}

/** The columns of an OpenAI deprecations table the generator reads, by index (-1 when the table has none). */
export function openaiColumns(header) {
  return {
    date: header.findIndex((h) => h.includes('shutdown date')),
    model: header.findIndex((h) => /model|system/.test(h) && !/price|replacement|substitute/.test(h)),
    replacement: header.findIndex((h) => /replacement|substitute/.test(h)),
    notice: header.findIndex((h) => h.includes('notice date')),
    status: header.findIndex((h) => h === 'status'),
  };
}

/** A model id as the generator accepts one from a table cell's code marks. */
export const TABLE_ID = /^[a-z0-9][a-z0-9.:-]*$/i;

/**
 * Every model id on a provider's deprecation tables, row by row, read by the parsers above (never from the ledger):
 * { id, table, line, kind } — `table` the table in words; `kind` 'model' for a model cell the generator writes rows
 * from, 'feature' for an id inside an OpenAI cell the generator skips as not a model ("New fine-tuning training on
 * `babbage-002`"). Pages with no tables (the release notes, DeepSeek's pages, the model pages) give none.
 * @param {string} file the saved file name  @param {string} text the page's text, as pageTextOf gives it
 */
export function tableIds(file, text) {
  const out = [];
  if (file === 'anthropic-deprecations.md') {
    for (const r of anthropicStatusRows(text)) out.push({ id: r.id, table: '## Model status', line: r.line, kind: 'model' });
    for (const r of anthropicHistoryRows(text)) out.push({ id: r.id, table: `## Deprecation history${r.section ? ` › ${r.section}` : ''}`, line: r.line, kind: 'model' });
  } else if (file === 'openai-deprecations.md') {
    for (const r of openaiTableRows(text)) {
      const c = openaiColumns(r.header);
      if (c.date === -1 || c.model === -1) continue;
      const cell = r.cells[c.model] ?? '';
      const model = cell.startsWith('`') || /^([A-Z][A-Za-z0-9.\- ]*?) \(`/.test(cell);
      const ids = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((id) => TABLE_ID.test(id));
      const table = `${r.part === 'upcoming' ? '## Upcoming deprecations' : '## Past deprecations'}${r.section ? ` › ${r.section}` : ''}`;
      for (const id of ids) out.push({ id, table, line: r.line, kind: model ? 'model' : 'feature' });
    }
  } else if (file === 'google-deprecations.html') {
    for (const r of googleTableRows(text)) {
      const ids = [...(r.cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const table = `## ${r.h2 ?? ''}${r.h3 ? ` › ${r.h3}` : ''}`;
      for (const id of ids) out.push({ id, table, line: googleRowCells(r).join(' | '), kind: 'model' });
    }
  }
  return out;
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

// ── 0.4.4 (R6): each page's own title, read where the page writes it ────
/** A markdown page's front-matter `title:` (Anthropic's page carries its title there and has no "# " heading). */
const frontMatterTitle = (text) => (text.startsWith('---\n') ? /^title:[ \t]*(.+?)[ \t]*$/m.exec(text.slice(4, text.indexOf('\n---', 4)))?.[1] : undefined);
/** The page's first "# " heading (OpenAI's markdown pages; Google's pages, as htmlToText gives them). */
const firstHeading = (text) => /^# (.+?)\s*$/m.exec(text)?.[1];
/** The page's <title>, which htmlToText leaves as the first line (DeepSeek's pages). */
const firstLine = (text) => text.split('\n')[0];
const DEEPSEEK_SUFFIX = / \| DeepSeek API Docs$/;
/** The title this version expects of each OpenAI model page it reads, by the model id in its address (read 2026-11-17T23:17:08Z). */
export const OPENAI_MODEL_TITLE = { 'gpt-4o': 'GPT-4o', 'gpt-4o-mini': 'GPT-4o mini', 'gpt-4.1': 'GPT-4.1', 'gpt-4.1-mini': 'GPT-4.1 mini' };
const modelIdOf = (file) => /^openai-model-([a-z0-9.-]+)\.md$/.exec(file)?.[1];
/** The miss for a title that is not the one expected, in words. */
const titleMiss = (expected, got) => (got === expected ? [] : [`the title "${expected}" (found ${got === undefined ? 'none' : `"${got}"`})`]);

/**
 * What this version expects of each page, in words (for the report and a refusal), and the check.
 * Keys are the saved file names (pageFileOf); `openai-model-*.md` stands for each OpenAI model page.
 *
 * 0.4.4 (R6): each entry also says where the page writes its title (`title`), the title it expects (part of
 * the shape: a page whose title changed is not the page this version reads), and how the card names the page
 * (`name`, made from the title the ledger's source list carries: the title itself, or a plain description
 * that does not contradict it).
 */
export const PAGE_SHAPES = {
  'anthropic-deprecations.md': {
    expects: [
      'the title "Model deprecations" (its front matter)',
      'under "## Model status", a table with the columns "API model name", "Current state", "Deprecated", "Tentative retirement date", a state word on every row',
      'under "## Deprecation history", a table with the columns "Retirement date", "Deprecated model", "Recommended replacement"',
    ],
    title: frontMatterTitle,
    expectedTitle: () => 'Model deprecations',
    name: (t) => `${t.toLowerCase()} page`,
    misses(text) {
      const m = mdTableExpect(text, 'Model status', ['API model name', 'Current state', 'Deprecated', 'Tentative retirement date'], 'Current state');
      const sec = mdSection(text, 'Deprecation history');
      const h = !sec
        ? ['the heading "## Deprecation history"']
        : mdTables(sec).some((t) => sameColumns(t.header, ['Retirement date', 'Deprecated model', 'Recommended replacement']))
          ? []
          : ['a table under "## Deprecation history" with the columns "Retirement date", "Deprecated model", "Recommended replacement"'];
      return [...titleMiss('Model deprecations', frontMatterTitle(text)), ...m, ...h];
    },
  },
  'openai-deprecations.md': {
    expects: [
      'the title "Deprecations" (its "# " heading)',
      'under "## Upcoming deprecations", a table with the columns "Shutdown date", "Affected model", "Status", "Recommended replacement", "Notice date", a status word on every row',
      'under "## Past deprecations", a table with the columns "Shutdown date", "Affected model or feature", "Listed replacement", "Notice date"',
    ],
    title: firstHeading,
    expectedTitle: () => 'Deprecations',
    name: (t) => `${t.toLowerCase()} page`,
    misses(text) {
      return [
        ...titleMiss('Deprecations', firstHeading(text)),
        ...mdTableExpect(text, 'Upcoming deprecations', ['Shutdown date', 'Affected model', 'Status', 'Recommended replacement', 'Notice date'], 'Status'),
        ...mdTableExpect(text, 'Past deprecations', ['Shutdown date', 'Affected model or feature', 'Listed replacement', 'Notice date']),
      ];
    },
  },
  'openai-model-*.md': {
    expects: [
      'the title the model\'s own page carries (its "# " heading: GPT-4o, GPT-4o mini, GPT-4.1, GPT-4.1 mini)',
      'Amendment B1, 0.4.4 (R5): exactly one "Model ID:" line, and it is "Model ID: `<id>`" for the model the URL names (<id> = the URL\'s last segment without ".md")',
      'a "Status: <word>" line',
    ],
    title: firstHeading,
    expectedTitle: (file) => OPENAI_MODEL_TITLE[modelIdOf(file)],
    name: (t) => `model page for ${t}`,
    misses(text, file = '') {
      const out = [];
      const id = modelIdOf(file);
      const expected = OPENAI_MODEL_TITLE[id];
      if (expected === undefined) out.push(`a model page this version reads (${file || 'no file'} is not one)`);
      else out.push(...titleMiss(expected, firstHeading(text)));
      // Amendment B1: the page is the page asked for — its own id line names the model the URL names. Another deprecated
      // model's page has the same shape and the same "Status: Deprecated", and must not confirm this model's rows.
      // 0.4.4 (R5): and there is exactly one such line — a page with two is not judged by the first.
      const lines = [...text.matchAll(/^Model ID:.*$/gm)].map((m) => m[0]);
      const ids = lines.map((l) => /^Model ID: `([^`]+)`\s*$/.exec(l)?.[1]);
      if (!id || lines.length !== 1 || ids[0] !== id)
        out.push(
          `exactly one "Model ID: \`${id ?? '<id>'}\`" line (found ${
            lines.length === 0 ? 'none' : lines.map((l, i) => (ids[i] === undefined ? `"${l}"` : `\`${ids[i]}\``)).join(' and ')
          })`,
        );
      if (!/^Status: [A-Za-z]/m.test(text)) out.push('a "Status: <word>" line');
      return out;
    },
  },
  'google-deprecations.html': {
    expects: [
      'the title "Gemini deprecations" (its "# " heading)',
      'tables whose header row is "Model | Release date | Shutdown date | Recommended replacement" (or "Agent | …" with the same three columns after it), at least one of the first',
      'a "## " heading over every table',
      'a "### Deprecated models" heading',
    ],
    title: firstHeading,
    expectedTitle: () => 'Gemini deprecations',
    name: (t) => `${t} page`,
    misses(text) {
      const rows = googleTableRows(text);
      const headers = rows.filter((r) => !/`/.test(r.cells[0] ?? ''));
      const out = [...titleMiss('Gemini deprecations', firstHeading(text))];
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
    expects: ['the title "Release notes" (its "# " heading)', 'dated "## <Month> <D>, <YYYY>" headings', 'a "**Model updates:**" label under one of them'],
    title: firstHeading,
    expectedTitle: () => 'Release notes',
    name: (t) => `${t.toLowerCase()} page`,
    misses(text) {
      const out = [...titleMiss('Release notes', firstHeading(text))];
      if (!/^## [A-Z][a-z]+ \d{1,2},? \d{4}/m.test(text)) out.push('a dated "## <Month> <D>, <YYYY>" heading');
      if (!/^\*\*Model updates:\*\*/m.test(text)) out.push('a "**Model updates:**" label');
      return out;
    },
  },
  'deepseek-updates.html': {
    expects: ['the title "Change Log | DeepSeek API Docs" (its <title>)', '"Date: YYYY-MM-DD" entry headings'],
    title: firstLine,
    expectedTitle: () => 'Change Log | DeepSeek API Docs',
    name: (t) => t.replace(DEEPSEEK_SUFFIX, '').toLowerCase(),
    misses(text) {
      const out = [...titleMiss('Change Log | DeepSeek API Docs', firstLine(text))];
      if (!/^Date: \d{4}-\d{2}-\d{2}/m.test(text)) out.push('a "Date: YYYY-MM-DD" entry heading');
      return out;
    },
  },
  'deepseek-first-api-call.html': {
    expects: ['the title "Your First API Call | DeepSeek API Docs" (its <title>; the page served at https://api-docs.deepseek.com/)', 'the parameter table\'s "base_url (OpenAI)" row'],
    title: firstLine,
    expectedTitle: () => 'Your First API Call | DeepSeek API Docs',
    name: (t) => `“${t.replace(DEEPSEEK_SUFFIX, '')}” page`,
    misses(text) {
      const out = [...titleMiss('Your First API Call | DeepSeek API Docs', firstLine(text))];
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

/** 0.4.4 (R6): the page's own title, read where that page writes it; undefined for a file this version does not read. */
export function pageTitleOf(file, text) {
  return pageShapeOf(file)?.title(text);
}

/** 0.4.4 (R6): how the card names a page, from the title the ledger's source list carries (the provider's name goes before it). */
export function pageNameOf(file, title) {
  const s = pageShapeOf(file);
  return s && title ? s.name(title) : 'page';
}

// ── 0.4.3 (R1): one row against a set of pages ──────────────────────────

/** Is a ledger row a table row of Google's deprecations page (checked as ONE page row, cell by cell in order)? */
export const isGoogleTableRow = (r) => r.url === PAGE_URL.google && r.section !== undefined;

/**
 * Every quote a row rests on: its quote on its url, its note on the same page, its alsoQuote on its alsoUrl.
 * 0.4.7 (R3, Amendment A4): and its second row on its url, by the same check as its first, so a moved second row is a
 * changed row — never an unchecked quote inside a Certain line.
 */
export function rowTests(r) {
  const tests = [{ url: r.url, quote: r.quote, what: 'quote', table: isGoogleTableRow(r) }];
  // 0.4.8 (R5): the notice above the row, on the row's own page, read with the link strip (it is kept as `unlinked` gives it)
  if (r.notice) tests.push({ url: r.url, quote: r.notice, what: 'notice', table: false });
  if (r.secondRow) tests.push({ url: r.url, quote: r.secondRow.quote, what: 'second', table: isGoogleTableRow(r) });
  if (r.note) tests.push({ url: r.url, quote: r.note, what: 'note', table: false });
  if (r.alsoUrl && r.alsoQuote) tests.push({ url: r.alsoUrl, quote: r.alsoQuote, what: 'also', table: false });
  return tests;
}

/**
 * Is the quote on the page's text, by the generator's own check for that kind of row? 0.4.8 (R5): a notice (`what`
 * 'notice') by `wordOn`, the link strip on both sides, as it was written.
 */
export function quoteStands(text, quote, table, what) {
  if (what === 'notice') return wordOn(text, quote);
  return table ? oneRowIn(googlePageRows(text), quote.split(' | ')) : quoteOn(text, quote);
}

/** The pages a row rests on, each once, in order: its own page, then its second page when that is another page. */
export function rowPages(r) {
  return [...new Set(rowTests(r).map((t) => t.url))];
}

/**
 * One row against the pages: `pageOf(url)` answers `{ ok: true, text, at }` for a page read as the page
 * this version knows, or `{ ok: false, reason }`. A row is unread when any page it rests on is unread
 * (the drift script's "not checked"); else changed when a quote is not on its page; else confirmed.
 *
 * 0.4.4 (R4): every state also says, page by page, which of the row's pages were read in this run (`read`:
 * the time, and whether that page still carries its part of the row) and which were not (`notRead`, with the
 * reason), so the card can name the page that was not read. `reason` stays the first unread page's reason.
 * @returns {{ state: 'confirmed', at: string, read: object[] } | { state: 'changed', at: string, gone: object[], read: object[] } | { state: 'unread', reason: string, notRead: object[], read: object[] }}
 */
export function rowState(r, pageOf) {
  const tests = rowTests(r);
  const urls = rowPages(r);
  const answers = urls.map((url) => ({ url, p: pageOf(url) }));
  const read = answers
    .filter((a) => a.p.ok)
    .map((a) => ({ url: a.url, at: a.p.at, stands: tests.filter((t) => t.url === a.url).every((t) => quoteStands(a.p.text, t.quote, t.table, t.what)) }));
  const notRead = answers.filter((a) => !a.p.ok).map((a) => ({ url: a.url, reason: a.p.reason }));
  if (notRead.length) return { state: 'unread', reason: notRead[0].reason, notRead, read };
  const at = pageOf(r.url).at;
  const gone = tests.filter((t) => !quoteStands(pageOf(t.url).text, t.quote, t.table, t.what));
  return gone.length ? { state: 'changed', at, gone, read } : { state: 'confirmed', at, read };
}

/** A definition the card quotes, against the pages: confirmed, changed or unread, as a row. */
export function definitionState(d, pageOf) {
  const p = pageOf(d.url);
  if (!p.ok) return { state: 'unread', reason: p.reason };
  return quoteOn(p.text, d.quote) ? { state: 'confirmed', at: p.at } : { state: 'changed', at: p.at, gone: [{ url: d.url, quote: d.quote, what: 'definition' }] };
}
