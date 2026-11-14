#!/usr/bin/env node
/**
 * build-ledger.mjs — writes src/lifecycle-ledger.ts from the providers' own
 * deprecation pages, saved locally by `curl -sL`. No row is typed by hand:
 * every row comes from a table row or a sentence on a saved page, and the
 * generator refuses to write a row whose `quote` is not found verbatim in
 * the page it cites.
 *
 *   node scripts/build-ledger.mjs --pages <dir> [--out src/lifecycle-ledger.ts] [--print]
 *
 * <dir> holds the pages under these names (fetch them the same day):
 *   anthropic-deprecations.md   https://platform.claude.com/docs/en/about-claude/model-deprecations.md
 *   openai-deprecations.md      https://developers.openai.com/api/docs/deprecations.md
 *   openai-model-<id>.md        https://developers.openai.com/api/docs/models/<id>.md   (optional; confirms a display-name row)
 *   google-deprecations.html    https://aistudio.google.com/docs/deprecations
 *   google-changelog.html       https://aistudio.google.com/docs/changelog
 *   deepseek-updates.html       https://api-docs.deepseek.com/updates
 *   deepseek-news.html          https://api-docs.deepseek.com/news
 *   read-times.json             { "<file>": "<ISO UTC time of the curl>" }
 *
 * DeepSeek's pages are prose, not tables: their rows are named below by the
 * SENTENCE they come from, and the generator checks that sentence is on the
 * saved page before it writes the row.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneRowIn } from './ledger-check.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const PAGES = arg('--pages');
if (!PAGES) {
  console.error('usage: node scripts/build-ledger.mjs --pages <dir> [--out <file>] [--print]');
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = arg('--out', join(HERE, '..', 'src', 'lifecycle-ledger.ts'));
const PRINT = args.includes('--print');

const readTimes = JSON.parse(readFileSync(join(PAGES, 'read-times.json'), 'utf8'));
const page = (f) => readFileSync(join(PAGES, f), 'utf8');
const sha = (f) => createHash('sha256').update(readFileSync(join(PAGES, f))).digest('hex');
const readOnOf = (f) => {
  const t = readTimes[f];
  if (!t) throw new Error(`read-times.json has no time for ${f}`);
  return t.slice(0, 10);
};

const URL = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
  openai: 'https://developers.openai.com/api/docs/deprecations.md',
  openaiModel: (id) => `https://developers.openai.com/api/docs/models/${id}.md`,
  google: 'https://aistudio.google.com/docs/deprecations',
  googleChangelog: 'https://aistudio.google.com/docs/changelog',
  deepseekUpdates: 'https://api-docs.deepseek.com/updates',
  deepseekNews: 'https://api-docs.deepseek.com/news',
};

// ── dates ────────────────────────────────────────────────────────────────
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n) => String(n).padStart(2, '0');
/** The page's date text → ISO, or undefined when the page names no date. */
function isoOf(text) {
  if (!text) return undefined;
  const t = text.replace(/[‐-–]/g, '-').replace(/\*\*/g, '').trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /([A-Z][a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/.exec(t);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(Number(m[2]))}`;
  }
  return undefined;
}

const rows = [];
const log = [];
function push(row) {
  // The quote must be on the page the row cites (whitespace-normalized).
  const src = row._file;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  if (!norm(row._text).includes(norm(row.quote))) {
    throw new Error(`quote for ${row.id} not found on ${src}: ${row.quote}`);
  }
  if (rows.some((r) => r.id === row.id)) {
    log.push(`skip duplicate ${row.provider} ${row.id} (an earlier row on the page wins: most recent announcement first)`);
    return;
  }
  delete row._file;
  delete row._text;
  rows.push(row);
}
const unbacktick = (s) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── Anthropic ────────────────────────────────────────────────────────────
{
  const f = 'anthropic-deprecations.md';
  const text = page(f);
  const readOn = readOnOf(f);
  const lines = text.split('\n');
  // Deprecation history first: id → { retirementText, replacement, note, line }
  const hist = new Map();
  let section = null;
  let note = null;
  let inHistory = false;
  for (const ln of lines) {
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
    if (rm && !hist.has(rm[2])) hist.set(rm[2], { retirementText: rm[1], replacement: rm[3], note, section, line: ln.trim() });
  }
  // Model status table.
  const inStatus = new Set();
  let inTable = false;
  for (const ln of lines) {
    if (ln.startsWith('## Model status')) inTable = true;
    else if (ln.startsWith('## ') && inTable) inTable = false;
    if (!inTable) continue;
    const m = /^\|\s*(claude-[a-z0-9.-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(ln);
    if (!m) continue;
    const [, id, state, dep, ret] = m;
    inStatus.add(id);
    const word = state.toLowerCase();
    if (!['deprecated', 'retired', 'legacy'].includes(word)) continue; // Active: no flag
    const h = hist.get(id);
    push({
      id,
      provider: 'anthropic',
      word,
      pageWord: state,
      announced: isoOf(dep),
      shutdown: /not sooner/i.test(ret) ? undefined : isoOf(ret),
      shutdownFloor: /not sooner/i.test(ret) ? isoOf(ret) : undefined,
      dateText: ret,
      replacement: h ? h.replacement : undefined,
      url: URL.anthropic,
      readOn,
      quote: ln.trim(),
      _file: f,
      _text: text,
    });
  }
  // History rows the status table no longer carries (older retirements).
  for (const [id, h] of hist) {
    if (inStatus.has(id)) continue;
    const retired = !!h.note;
    push({
      id,
      provider: 'anthropic',
      word: retired ? 'retired' : 'deprecated',
      pageWord: retired ? h.note : `Deprecated model (${h.section})`,
      announced: isoOf(h.section),
      shutdown: isoOf(h.retirementText),
      dateText: h.retirementText,
      replacement: h.replacement,
      url: URL.anthropic,
      readOn,
      quote: h.line,
      _file: f,
      _text: text,
    });
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────
{
  const f = 'openai-deprecations.md';
  const text = page(f);
  const readOn = readOnOf(f);
  const lines = text.split('\n');
  let part = null;
  let section = null;
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
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
    const iDate = header.findIndex((h) => h.includes('shutdown date'));
    const iModel = header.findIndex(
      (h) => /model|system/.test(h) && !/price|replacement|substitute/.test(h),
    );
    const iRepl = header.findIndex((h) => /replacement|substitute/.test(h));
    if (iDate === -1 || iModel === -1) continue;
    const cell = cells[iModel];
    const display = /^([A-Z][A-Za-z0-9.\- ]*?) \(`/.exec(cell);
    if (!cell.startsWith('`') && !display) {
      log.push(`openai: skip non-model cell "${cell}" (${section})`);
      continue;
    }
    const ids = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((id) => /^[a-z0-9][a-z0-9.:-]*$/i.test(id));
    if (ids.length === 0) continue;
    const dateText = cells[iDate];
    const shutdown = isoOf(dateText);
    const word = part === 'upcoming' ? 'deprecated' : shutdown && shutdown <= readOn ? 'shut down' : 'deprecated';
    const replRaw = iRepl === -1 ? '' : cells[iRepl];
    const replacement = replRaw && !/^-+$/.test(replRaw) ? unbacktick(replRaw) : undefined;
    const base = {
      provider: 'openai',
      word,
      pageWord: part === 'upcoming' ? `Upcoming deprecations: ${section}` : `Past deprecations: ${section}`,
      announced: isoOf(section),
      shutdown: /earliest/i.test(dateText) ? undefined : shutdown,
      shutdownFloor: /earliest/i.test(dateText) ? shutdown : undefined,
      dateText: dateText.replace(/‑/g, '-'),
      replacement,
      url: URL.openai,
      readOn,
      quote: ln.trim(),
      _file: f,
      _text: text,
    };
    for (const id of ids) push({ id, ...base });
    if (display) {
      // "GPT-4o (`gpt-4o-2024-08-06`, …)": the alias id is the name, lower-cased.
      // Written only when the model's own page confirms it with a Status line.
      const id = display[1].toLowerCase().replace(/\s+/g, '-');
      const mf = `openai-model-${id}.md`;
      if (existsSync(join(PAGES, mf))) {
        const mp = page(mf);
        const st = /^Status: (Deprecated|Shut down)$/m.exec(mp);
        if (st) {
          push({
            id,
            ...base,
            matchedBy: 'display-name',
            alsoUrl: URL.openaiModel(id),
            alsoQuote: st[0],
            alsoReadOn: readOnOf(mf),
          });
          continue;
        }
      }
      log.push(`openai: display name "${display[1]}" → ${id} not written (no saved model page with a Status line)`);
    }
  }
}

// ── Google ───────────────────────────────────────────────────────────────
function htmlToText(html) {
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
{
  const fd = 'google-deprecations.html';
  const fc = 'google-changelog.html';
  const dep = htmlToText(page(fd));
  const chg = htmlToText(page(fc));
  const readOn = readOnOf(fd);
  const flat = (s) => s.replace(/\s+/g, ' ');
  const depFlat = flat(dep);
  const chgFlat = flat(chg);

  /** A sentence on either Google page that calls the id deprecated, verbatim, or null. */
  function deprecatedSentence(id) {
    const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pats = [
      new RegExp(`\`${e}\`(?:\\]\\([^)]*\\))? (?:model )?is (?:\\[)?deprecated(?:\\]\\([^)]*\\))?`),
      new RegExp(`The (?:\`[^\`]+\` and )*\`${e}\`(?: and \`[^\`]+\`)* models are deprecated`),
      new RegExp(`replaces and deprecates \`${e}\``),
    ];
    for (const [where, txt, url] of [
      ['deprecations', depFlat, URL.google],
      ['changelog', chgFlat, URL.googleChangelog],
    ]) {
      for (const p of pats) {
        const m = p.exec(txt);
        if (m) return { where, sentence: m[0], url };
      }
    }
    return null;
  }

  // The page's own rows: the text between consecutive `---` separator lines, flattened.
  const pageRows = dep.split(/\n---\n|\{% \/?table %\}/).map(flat);
  const oneRow = (cells) => oneRowIn(pageRows, cells);

  // Deprecations page tables.
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
  for (const r of tableRows) {
    const [model, , shutdownText = '', replCell = ''] = r.cells;
    const idm = /`([^`]+)`/.exec(model ?? '');
    if (!idm) continue; // header row
    const id = idm[1];
    const deprecatedSection = /^Deprecated (models|agents)/.test(r.h3 ?? '');
    const routes = /rout/i.test(replCell);
    const routesTo = routes ? (/`([^`]+)`/.exec(replCell) ?? [])[1] : undefined;
    const shutdown = isoOf(shutdownText);
    const said = deprecatedSentence(id);
    let word;
    let pageWord;
    if (routes) {
      word = said ? 'deprecated' : 'rerouted';
      pageWord = said ? said.sentence : unbacktick(replCell);
    } else if (deprecatedSection) {
      word = shutdown && shutdown <= readOn ? 'shut down' : 'deprecated';
      pageWord = `listed under ${r.h2} › ${r.h3}`;
    } else if (said) {
      word = 'deprecated';
      pageWord = said.sentence;
    } else if (shutdown) {
      // Amendment B, objection 1: a date and no deprecation word is the page's schedule, written as such.
      word = 'scheduled for shutdown';
      pageWord = `shutdown date ${shutdownText}, no deprecation word on either page`;
    } else {
      continue;
    }
    const replacement = replCell ? unbacktick(unbacktick(replCell).replace(/\s*\([\s\S]*\)\s*$/, '')) || undefined : undefined;
    push({
      id,
      provider: 'google',
      word,
      pageWord,
      // Amendment C, ruling 5: the page says its table dates are "the earliest possible dates";
      // only a routing row's date is the callout's own "Effective <date>" and stays a date.
      shutdown: /no shutdown|n\/a/i.test(shutdownText) || !routes ? undefined : shutdown,
      shutdownFloor: /no shutdown|n\/a/i.test(shutdownText) || routes ? undefined : shutdown,
      dateText: shutdownText || undefined,
      replacement,
      routesTo,
      url: URL.google,
      readOn,
      section: `${r.h2}${r.h3 ? ` › ${r.h3}` : ''}`,
      ...(said && said.where === 'changelog' ? { alsoUrl: URL.googleChangelog, alsoQuote: said.sentence, alsoReadOn: readOnOf(fc) } : {}),
      quote: [model, r.cells[1] ?? '', shutdownText, replCell].join(' | '),
      _file: fd,
      // Amendment B, ruling 3: a Google table row is checked as ONE row of the page — every cell in
      // order inside a single segment between the page's own row separators, not cell by cell.
      _text: oneRow([model, r.cells[1] ?? '', shutdownText, replCell])
        ? [model, r.cells[1] ?? '', shutdownText, replCell].join(' | ')
        : '',
    });
  }

  // Release-notes rows for ids the deprecations page no longer lists.
  const clines = chg.split('\n');
  const sections = [];
  let sec = null;
  for (const ln of clines) {
    const m = /^## ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(ln);
    if (m) {
      sec = { date: isoOf(m[1]), heading: m[1], lines: [] };
      sections.push(sec);
      continue;
    }
    if (sec) sec.lines.push(ln);
  }
  const PAST = /(?:are now|is now|has been|have been|is|are) \[?shut\s+down\]?(?:\([^)]*\))?/;
  const FUTURE = /will be \[?shut\s+down\]?(?:\([^)]*\))?/;
  for (const s of sections) {
    const body = flat(s.lines.join('\n'));
    // Bullets: split on " *  " / " -  " markers that start an item.
    const items = body.split(/\s(?=\*\s{2,}|\*\s(?=\S))/);
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const isPast = PAST.exec(it);
      const isFuture = FUTURE.exec(it);
      const willDep = /`([^`]+)`(?: model)? will be deprecated on ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(it);
      const hit = isPast && !isFuture ? isPast : isFuture;
      if (!hit && !willDep) continue;
      if (willDep) {
        const id = willDep[1];
        const sentence = willDep[0];
        if (!rows.some((r) => r.id === id))
          push({
            id,
            provider: 'google',
            word: 'deprecated',
            pageWord: sentence,
            shutdown: isoOf(willDep[2]),
            dateText: willDep[2],
            url: URL.googleChangelog,
            readOn: readOnOf(fc),
            announced: s.date,
            quote: sentence,
            _file: fc,
            _text: chgFlat,
          });
        continue;
      }
      const before = it.slice(0, hit.index);
      let after = it.slice(hit.index + hit[0].length);
      // ids before the phrase are its subject; ids after it count only as a list (":" then "- `id`").
      const ids = [...before.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const perIdDate = new Map();
      let listText = '';
      if (/^\s*[:]/.test(after) || ids.length === 0) {
        // the list may continue in the following bullet items (sub-bullets of ids)
        let j = k + 1;
        listText = after;
        while (j < items.length && /^\*\s+(`[^`]+`|[A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?:)\s*$/.test(items[j].trim().replace(/\s+-\s+`/g, ' - `').split(' - ')[0])) {
          listText += ' ' + items[j];
          j++;
        }
        let curDate = null;
        for (const tok of listText.split(/\s(?=[-*]\s+)/)) {
          const dm = /^[-*]?\s*([A-Z][a-z]+) (\d{1,2})(?:st|nd|rd|th)?:\s*$/.exec(tok.trim());
          if (dm) {
            const mo = MONTHS[dm[1].slice(0, 3).toLowerCase()];
            let yr = Number(s.date.slice(0, 4));
            if (mo < Number(s.date.slice(5, 7))) yr += 1;
            curDate = `${yr}-${pad(mo)}-${pad(Number(dm[2]))}`;
            continue;
          }
          const im = /^[-*]\s*`([^`]+)`/.exec(tok.trim());
          if (im) {
            ids.push(im[1]);
            if (curDate) perIdDate.set(im[1], curDate);
          }
        }
      }
      if (ids.length === 0) continue;
      const explicit = /([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(after.split(/[.:]\s/)[0] ?? '') ?? /\*\*([A-Z][a-z]+ \d{1,2}, \d{4})\*\*/.exec(after);
      for (const id of ids) {
        if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id)) continue;
        if (rows.some((r) => r.id === id)) continue; // the deprecations page (or a later note) already says it
        const past = hit === isPast && !isFuture;
        const date = past ? s.date : perIdDate.get(id) ?? (explicit ? isoOf(explicit[1]) : undefined);
        const sentence = (before + hit[0]).trim().replace(/^\*\s*/, '');
        push({
          id,
          provider: 'google',
          word: past ? 'shut down' : 'deprecated',
          pageWord: past ? `release notes ${s.heading}: ${hit[0].replace(/[[\]]/g, '')}` : `release notes ${s.heading}: ${hit[0].replace(/[[\]]/g, '')}`,
          shutdown: date,
          dateText: past ? s.heading : date,
          url: URL.googleChangelog,
          readOn: readOnOf(fc),
          announced: s.date,
          quote: sentence.length > 0 ? sentence : hit[0],
          _file: fc,
          _text: chgFlat,
        });
      }
    }
  }
}

// ── DeepSeek (prose pages: each row names its sentence) ─────────────────
{
  const fu = 'deepseek-updates.html';
  const fn = 'deepseek-news.html';
  const upd = htmlToText(page(fu));
  const news = htmlToText(page(fn));
  const entryDate = (sentence) => {
    // the "Date: YYYY-MM-DD" heading the sentence sits under
    const i = upd.indexOf(sentence);
    if (i === -1) return undefined;
    const before = upd.slice(0, i);
    const all = [...before.matchAll(/Date: (\d{4}-\d{2}-\d{2})/g)];
    return all.length ? all[all.length - 1][1] : undefined;
  };
  const LEGACY =
    'The two legacy API model names, deepseek-chat and deepseek-reasoner, will be discontinued in three months (2026-07-24).';
  const LEGACY_POINT =
    'During the current period, these two model names point to the non-thinking mode and thinking mode of deepseek-v4-flash, respectively.';
  const RETIRED =
    'The previous-generation models V4 Flash and V4 Flash Vision Exp have been retired; for compatibility, the model names deepseek-v4-flash and deepseek-v4-flash-vision-exp are temporarily routed to V4.1 Flash.';
  const RENAME = 'Change the model name to deepseek-flash to call the latest V4.1 Flash model.';
  const NEWS =
    'The legacy names deepseek-v4-flash and deepseek-v4-flash-vision-exp are still accepted, but the corresponding models have been retired; their requests are served by DeepSeek-V4.1-Flash-1017 and billed at the Flash price.';
  for (const s of [LEGACY_POINT, RENAME]) if (!upd.includes(s)) throw new Error(`deepseek: sentence not on ${fu}: ${s}`);
  if (!news.includes(NEWS)) throw new Error(`deepseek: sentence not on ${fn}: ${NEWS}`);
  for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
    if (!LEGACY.includes(id)) throw new Error('deepseek legacy sentence does not name ' + id);
    push({
      id,
      provider: 'deepseek',
      word: 'legacy',
      pageWord: 'legacy API model name, to be discontinued',
      announced: entryDate(LEGACY),
      shutdown: /\((\d{4}-\d{2}-\d{2})\)/.exec(LEGACY)[1],
      dateText: '2026-07-24',
      pointedTo: 'deepseek-v4-flash',
      url: URL.deepseekUpdates,
      readOn: readOnOf(fu),
      quote: LEGACY,
      note: LEGACY_POINT,
      _file: fu,
      _text: upd,
    });
  }
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    if (!RETIRED.includes(id) || !NEWS.includes(id)) throw new Error('deepseek retired sentence does not name ' + id);
    push({
      id,
      provider: 'deepseek',
      word: 'retired',
      pageWord: 'have been retired',
      announced: entryDate(RETIRED),
      replacement: /model name to (deepseek-[a-z0-9.-]+)/.exec(RENAME)[1],
      routesTo: 'V4.1 Flash',
      url: URL.deepseekUpdates,
      readOn: readOnOf(fu),
      quote: RETIRED,
      note: RENAME,
      alsoUrl: URL.deepseekNews,
      alsoQuote: NEWS,
      alsoReadOn: readOnOf(fn),
      _file: fu,
      _text: upd,
    });
  }
}

// ── write ────────────────────────────────────────────────────────────────
const ALLOWED = new Set(['deprecated', 'retired', 'shut down', 'legacy', 'rerouted', 'scheduled for shutdown']);
for (const r of rows) {
  if (!ALLOWED.has(r.word)) throw new Error(`row ${r.id}: word ${r.word} not in the allowed set`);
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
}
const sources = [
  ['anthropic', URL.anthropic, 'anthropic-deprecations.md'],
  ['openai', URL.openai, 'openai-deprecations.md'],
  ['google', URL.google, 'google-deprecations.html'],
  ['google', URL.googleChangelog, 'google-changelog.html'],
  ['deepseek', URL.deepseekUpdates, 'deepseek-updates.html'],
  ['deepseek', URL.deepseekNews, 'deepseek-news.html'],
  ...['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']
    .filter((id) => existsSync(join(PAGES, `openai-model-${id}.md`)))
    .map((id) => ['openai', URL.openaiModel(id), `openai-model-${id}.md`]),
].map(([provider, url, file]) => ({ provider, url, readAt: readTimes[file], sha256: sha(file) }));

const byProvider = {};
for (const r of rows) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;

const ts = `/**
 * GENERATED by scripts/build-ledger.mjs from the providers' own deprecation
 * pages, saved by \`curl -sL\` and read on the dates below. Do not edit by
 * hand: re-fetch the pages and re-run the script. Every row carries the page
 * line it came from (\`quote\`), the URL and the day it was read; the script
 * refused any row whose quote is not on the page.
 *
 * Rows per provider: ${Object.entries(byProvider)
   .map(([p, n]) => `${p} ${n}`)
   .join(' · ')} (${rows.length} in all).
 */
import type { LedgerRow, LedgerSource } from './lifecycle-types.js';

export const LEDGER_SOURCES: readonly LedgerSource[] = ${JSON.stringify(sources, null, 2)};

export const LEDGER: readonly LedgerRow[] = ${JSON.stringify(rows, null, 2)};
`;
writeFileSync(OUT, ts);
console.log(`wrote ${OUT}: ${rows.length} rows (${Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(', ')})`);
if (PRINT) {
  for (const r of rows) console.log([r.provider, r.id, r.word, r.shutdown ?? r.shutdownFloor ?? '', r.replacement ?? '', r.routesTo ?? ''].join(' | '));
}
for (const l of log) console.log('note: ' + l);
