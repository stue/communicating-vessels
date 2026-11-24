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
 *   deepseek-first-api-call.html https://api-docs.deepseek.com/   (0.4.4, R6: the page titled "Your First API Call"; until
 *                               0.4.3 the file was named deepseek-news.html; 0.4.6, R1: read at the docs' root, which
 *                               serves it, since /news answered 404 on 2026-11-24 — until 0.4.5 the address was /news)
 *   read-times.json            { "<file>": "<ISO UTC time of the curl>" }
 *   google-model-pages.json     0.4.3 (R6): { "<id>": { "status": <HTTP status>, "at": "<ISO UTC time>" } } for each
 *                               changelog row's id — Google's model page https://aistudio.google.com/docs/models/<id>.
 *                               Written by this script with --fetch-model-pages (its only request, a GET per id);
 *                               without the flag the file must already be in <dir>.
 *
 * DeepSeek's pages are prose, not tables: their rows are named below by the
 * SENTENCE they come from, and the generator checks that sentence is on the
 * saved page before it writes the row.
 *
 * 0.4.3 (R3): before any row is written, every page is checked against the shape this version expects of
 * it (src/ledger-check.mjs, PAGE_SHAPES — the same check the run-time read makes). A page whose shape
 * differs stops the generator with the page and the missing piece named; no ledger is written.
 * 0.4.4 (R6): the shape includes the page's own title, so a page whose title changed stops the generator
 * too; the title read from each page is written into the ledger's source list, and the card names the
 * page by it.
 * 0.4.4 (R9): every sentence typed in this file is checked on its saved page before anything is written
 * (`onPage` and `said` below, and push()'s quote check); a typed value inside a sentence (a date, a name, a
 * model id) is checked inside the sentence it comes from. The drift script re-reads each of them with the
 * rows: each is a row's quote, note or second quote, or a definition.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  oneRowIn,
  quoteOn,
  replacementForm,
  PAGE_URL,
  htmlToText,
  googlePageRows,
  googleTableRows,
  googleRowCells,
  anthropicStatusRows,
  anthropicHistoryRows,
  openaiTableRows,
  openaiColumns,
  pageTextOf,
  pageShapeMisses,
  pageTitleOf,
} from '../src/ledger-check.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const PAGES = arg('--pages');
if (!PAGES) {
  console.error('usage: node scripts/build-ledger.mjs --pages <dir> [--out <file>] [--print] [--fetch-model-pages]');
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = arg('--out', join(HERE, '..', 'src', 'lifecycle-ledger.ts'));
const PRINT = args.includes('--print');

// ── 0.4.3 (R3): each page is the page this version reads, or nothing is written ──
{
  const fixed = ['anthropic-deprecations.md', 'openai-deprecations.md', 'google-deprecations.html', 'google-changelog.html', 'deepseek-updates.html', 'deepseek-first-api-call.html'];
  const models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'].map((id) => `openai-model-${id}.md`).filter((f) => existsSync(join(PAGES, f)));
  for (const f of [...fixed, ...models]) {
    if (!existsSync(join(PAGES, f))) {
      console.error(`stop: ${f} is not in ${PAGES}; no ledger written`);
      process.exit(1);
    }
    const missing = pageShapeMisses(f, pageTextOf(f, readFileSync(join(PAGES, f), 'utf8')));
    if (missing.length) {
      console.error(`stop: ${f} is not the page this version reads — it lacks ${missing.join('; ')}. No ledger written.`);
      process.exit(1);
    }
  }
}

const readTimes = JSON.parse(readFileSync(join(PAGES, 'read-times.json'), 'utf8'));
const page = (f) => readFileSync(join(PAGES, f), 'utf8');
const sha = (f) => createHash('sha256').update(readFileSync(join(PAGES, f))).digest('hex');
const readOnOf = (f) => {
  const t = readTimes[f];
  if (!t) throw new Error(`read-times.json has no time for ${f}`);
  return t.slice(0, 10);
};

const URL = PAGE_URL;

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
  if (!quoteOn(row._text, row.quote)) {
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
  // Deprecation history first: id → { retirementText, replacement, note, line }
  // 0.4.6 (R6): the page's rows through the exported parser (src/ledger-check.mjs), the first row for an id kept, as before
  const hist = new Map();
  for (const h of anthropicHistoryRows(text)) if (!hist.has(h.id)) hist.set(h.id, h);
  // Model status table.
  // 0.4.5 (R3): every row of it is written, Active ones included (until 0.4.4: "Active: no flag", skipped). A state
  // word this version does not read stops the generator, so a row is never dropped without a word.
  const STATE_WORDS = { deprecated: 'deprecated', retired: 'retired', legacy: 'legacy', active: 'active' };
  const inStatus = new Set();
  // 0.4.6 (R6): the table's rows through the exported parser
  for (const { id, state, dep, ret, line } of anthropicStatusRows(text)) {
    inStatus.add(id);
    const word = STATE_WORDS[state.toLowerCase()];
    if (!word) {
      console.error(`stop: ${f}: the state "${state}" on ${id} in "## Model status" is not one this version reads (${Object.keys(STATE_WORDS).join(', ')}). No ledger written.`);
      process.exit(1);
    }
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
      quote: line,
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
  // 0.4.6 (R6): the tables' rows through the exported parser (src/ledger-check.mjs), and their columns by name
  for (const { part, section, header, cells, line: ln } of openaiTableRows(text)) {
    // 0.4.2: OpenAI's page of 2026-11-14 is two tables (upcoming, past) with no dated section headings;
    // each row carries its own "Notice date" and, upcoming, its "Status".
    const { date: iDate, model: iModel, replacement: iRepl, notice: iNotice, status: iStatus } = openaiColumns(header);
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
    const status = iStatus === -1 ? undefined : cells[iStatus];
    if (status !== undefined && !/^deprecated$/i.test(status)) log.push(`openai: status "${status}" on ${cell} (written as ${word})`);
    const replRaw = iRepl === -1 ? '' : cells[iRepl];
    // "No one-to-one replacement" (the 2026-11-14 page; "---" before it) names no model.
    const noRepl = /^-+$/.test(replRaw) || /^no one-to-one replacement\.?$/i.test(replRaw);
    const replacement = replRaw && !noRepl ? unbacktick(replRaw) : undefined;
    const where = section ?? status;
    const base = {
      provider: 'openai',
      word,
      pageWord: `${part === 'upcoming' ? 'Upcoming deprecations' : 'Past deprecations'}${where ? `: ${where}` : ''}`,
      announced: (iNotice === -1 ? undefined : isoOf(cells[iNotice])) ?? isoOf(section),
      shutdown: /earliest/i.test(dateText) ? undefined : shutdown,
      shutdownFloor: /earliest/i.test(dateText) ? shutdown : undefined,
      dateText: dateText.replace(/‑/g, '-').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(),
      replacement,
      replacementForm: replacement ? replacementForm(replRaw) : undefined,
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
  const pageRows = googlePageRows(dep);
  const oneRow = (cells) => oneRowIn(pageRows, cells);

  // Deprecations page tables.
  const tableRows = googleTableRows(dep);
  for (const r of tableRows) {
    const cells = googleRowCells(r);
    const [model, , shutdownText, replCell] = cells;
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
    } else if (/^no shutdown date announced\.?$/i.test(shutdownText.trim())) {
      // 0.4.2 Amendment A1 (amends Amendment B, objection 1): the page lists the id with no date and no
      // deprecation word. It is written in the page's own words, so the card never calls it "not recognised".
      word = 'listed';
      pageWord = shutdownText.trim();
    } else {
      log.push(`google: ${id} not written (date cell "${shutdownText}", no deprecation word)`);
      continue;
    }
    const replacement = replCell ? unbacktick(unbacktick(replCell).replace(/\s*\([\s\S]*\)\s*$/, '')) || undefined : undefined;
    // the same cell as `replacement` reads it (links unwrapped, a trailing parenthesis dropped), with its code marks kept
    const replForm = replacement
      ? replacementForm(replCell.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s*\([\s\S]*\)\s*$/, ''))
      : undefined;
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
      replacementForm: replForm,
      routesTo,
      url: URL.google,
      readOn,
      section: `${r.h2}${r.h3 ? ` › ${r.h3}` : ''}`,
      ...(said && said.where === 'changelog' ? { alsoUrl: URL.googleChangelog, alsoQuote: said.sentence, alsoReadOn: readOnOf(fc) } : {}),
      quote: cells.join(' | '),
      _file: fd,
      // Amendment B, ruling 3: a Google table row is checked as ONE row of the page — every cell in
      // order inside a single segment between the page's own row separators, not cell by cell.
      _text: oneRow(cells) ? cells.join(' | ') : '',
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

// ── 0.4.3 (R6): changelog rows — a model the changelog names in words ───
// Google's changelog never writes these ids in a sentence about their end; it names the model ("Gemini 1.0 Pro").
// Each row is named here by its SENTENCE and the date heading it sits under, like DeepSeek's, and is written only
// if that sentence is on the saved page under that heading. `namedAs` marks the row: the link from the id to the
// name is ours, and the card never prints such a row as Certain. No other changelog row in this release.
{
  const fc = 'google-changelog.html';
  const chg = htmlToText(page(fc));
  const flatC = (s) => s.replace(/\s+/g, ' ').trim();
  /** The text under `## <heading>` up to the next `## `, flattened; throws when the heading is absent. */
  const entry = (heading) => {
    const lines = chg.split('\n');
    const i = lines.findIndex((l) => l.startsWith(`## ${heading}`) && /^(\s|$)/.test(l.slice(3 + heading.length)));
    if (i === -1) throw new Error(`changelog: no entry headed "${heading}" on ${fc}`);
    const out = [];
    for (const l of lines.slice(i + 1)) {
      if (l.startsWith('## ')) break;
      out.push(l);
    }
    return flatC(out.join('\n'));
  };
  const said = (heading, sentence) => {
    if (!entry(heading).includes(flatC(sentence))) throw new Error(`changelog: "${sentence}" is not under "${heading}" on ${fc}`);
  };
  const NAMED = [
    { ids: ['gemini-1.0-pro', 'gemini-pro'], namedAs: 'Gemini 1.0 Pro', heading: 'February 18, 2025', quote: 'Gemini 1.0 Pro is no longer supported.' },
    {
      ids: ['gemini-1.0-pro-vision', 'gemini-pro-vision'],
      namedAs: 'Gemini 1.0 Pro Vision',
      heading: 'July 12, 2024',
      quote: 'Support for Gemini 1.0 Pro Vision removed from Google AI services and tools.',
    },
  ];
  // The changelog's own introduction of the id, where it has one (December 13 2023): the only place a Google page read carries it.
  const INTRO = {
    'gemini-pro': { heading: 'December 13 2023', quote: 'gemini-pro: New text model for a wide variety of tasks.' },
    'gemini-pro-vision': { heading: 'December 13 2023', quote: 'gemini-pro-vision: New multimodal model for a wide variety of tasks.' },
  };
  // Google's model page for each id, requested at build time only (never at run time: that request would carry an id).
  const mpFile = join(PAGES, 'google-model-pages.json');
  const ids = NAMED.flatMap((n) => n.ids);
  if (args.includes('--fetch-model-pages')) {
    const got = {};
    for (const id of ids) {
      const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      try {
        const res = await fetch(URL.googleModel(id), { redirect: 'follow' });
        await res.arrayBuffer();
        got[id] = { status: res.status, at };
        console.log(`model page ${URL.googleModel(id)} ${at} HTTP ${res.status}`);
      } catch (e) {
        console.log(`model page ${URL.googleModel(id)} ${at} failed: ${e.message} — not recorded`);
      }
    }
    writeFileSync(mpFile, `${JSON.stringify(got, null, 2)}\n`);
  }
  if (!existsSync(mpFile)) throw new Error(`${mpFile} is missing: run with --fetch-model-pages once to record Google's model pages for ${ids.join(', ')}`);
  const modelPages = JSON.parse(readFileSync(mpFile, 'utf8'));
  for (const n of NAMED) {
    said(n.heading, n.quote);
    // 0.4.4 (R9): the name typed beside the sentence is the sentence's own words
    if (!n.quote.includes(n.namedAs)) throw new Error(`changelog: the name "${n.namedAs}" is not in its sentence "${n.quote}"`);
    for (const id of n.ids) {
      const intro = INTRO[id];
      if (intro) said(intro.heading, intro.quote);
      if (intro && !intro.quote.startsWith(`${id}:`)) throw new Error(`changelog: the introduction "${intro.quote}" does not name ${id}`);
      const mp = modelPages[id];
      push({
        id,
        provider: 'google',
        word: 'no longer supported',
        pageWord: n.quote.replace(/\.$/, ''),
        announced: isoOf(n.heading),
        dateText: n.heading,
        url: URL.googleChangelog,
        readOn: readOnOf(fc),
        quote: n.quote,
        namedAs: n.namedAs,
        entryHeading: n.heading,
        ...(intro ? { alsoUrl: URL.googleChangelog, alsoQuote: intro.quote, alsoReadOn: readOnOf(fc), alsoHeading: intro.heading } : {}),
        ...(mp ? { modelPage: { url: URL.googleModel(id), status: mp.status, at: mp.at } } : {}),
        _file: fc,
        _text: chg,
      });
    }
  }
}

// ── DeepSeek (prose pages: each row names its sentence) ─────────────────
{
  const fu = 'deepseek-updates.html';
  // 0.4.4 (R6): the page titled "Your First API Call" (DeepSeek's quick-start page); 0.4.6 (R1): served at the docs' root
  const fn = 'deepseek-first-api-call.html';
  const upd = htmlToText(page(fu));
  const firstCall = htmlToText(page(fn));
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
  const FIRST_CALL =
    'The legacy names deepseek-v4-flash and deepseek-v4-flash-vision-exp are still accepted, but the corresponding models have been retired; their requests are served by DeepSeek-V4.1-Flash-1017 and billed at the Flash price.';
  // 0.4.4 (R9): each typed sentence on its page, in one place — the build stops on the first one a saved page no longer carries
  const onPage = (text, file, s) => {
    if (!quoteOn(text, s)) throw new Error(`deepseek: sentence not on ${file}: ${s}`);
  };
  // 0.4.4 Amendment A4: each row's `pageWord` is the phrase of its own sentence that its word is mapped from — the
  // page's words, checked here inside that sentence and on the saved page by the same line (until fix pass 1 the
  // legacy rows carried a paraphrase that is on no page)
  const LEGACY_WORD = 'legacy API model names';
  const RETIRED_WORD = 'have been retired';
  for (const [w, s] of [[LEGACY_WORD, LEGACY], [RETIRED_WORD, RETIRED]]) {
    if (!s.includes(w)) throw new Error(`deepseek: "${w}" is not in "${s}"`);
  }
  for (const s of [LEGACY, LEGACY_POINT, RETIRED, RENAME, LEGACY_WORD, RETIRED_WORD]) onPage(upd, fu, s);
  onPage(firstCall, fn, FIRST_CALL);
  // the typed values below come from these sentences: each is checked inside the sentence it comes from
  const LEGACY_DATE = /\((\d{4}-\d{2}-\d{2})\)/.exec(LEGACY)?.[1];
  const POINTED_TO = 'deepseek-v4-flash';
  const ROUTES_TO = 'V4.1 Flash';
  if (!LEGACY_DATE) throw new Error(`deepseek: no date in "${LEGACY}"`);
  if (!LEGACY_POINT.includes(` ${POINTED_TO},`)) throw new Error(`deepseek: "${POINTED_TO}" is not in "${LEGACY_POINT}"`);
  if (!RETIRED.includes(`routed to ${ROUTES_TO}.`)) throw new Error(`deepseek: "${ROUTES_TO}" is not in "${RETIRED}"`);
  for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
    if (!LEGACY.includes(id)) throw new Error('deepseek legacy sentence does not name ' + id);
    push({
      id,
      provider: 'deepseek',
      word: 'legacy',
      pageWord: LEGACY_WORD,
      announced: entryDate(LEGACY),
      shutdown: LEGACY_DATE,
      dateText: LEGACY_DATE,
      pointedTo: POINTED_TO,
      url: URL.deepseekUpdates,
      readOn: readOnOf(fu),
      quote: LEGACY,
      note: LEGACY_POINT,
      _file: fu,
      _text: upd,
    });
  }
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    if (!RETIRED.includes(id) || !FIRST_CALL.includes(id)) throw new Error('deepseek retired sentence does not name ' + id);
    push({
      id,
      provider: 'deepseek',
      word: 'retired',
      pageWord: RETIRED_WORD,
      announced: entryDate(RETIRED),
      replacement: /model name to (deepseek-[a-z0-9.-]+)/.exec(RENAME)[1],
      routesTo: ROUTES_TO,
      url: URL.deepseekUpdates,
      readOn: readOnOf(fu),
      quote: RETIRED,
      note: RENAME,
      alsoUrl: URL.deepseekFirstApiCall,
      alsoQuote: FIRST_CALL,
      alsoReadOn: readOnOf(fn),
      _file: fu,
      _text: upd,
    });
  }
}

// ── the definitions the card quotes (0.4.2) ─────────────────────────────
// A ledger line for a word that means requests now fail quotes the provider's own definition of it.
// Each is named here by its SENTENCE, like DeepSeek's rows, and is written only if it is on the
// saved page; the drift check (scripts/ledger-drift.mjs) re-reads it with the rows.
// 0.4.5: two more sentences the card quotes, kept and checked the same way — Anthropic's notice period, which the
// line for an Active row quotes (R4 b; the page's "## Notifications", read 2026-11-20T05:02:18Z; kept under its own key,
// `notice period`, not under the row word `active`), and OpenAI's sentence
// about fine-tunes, under its table of upcoming deprecations, which a fine-tune's line quotes (R5; read 2026-11-20T05:02:18Z).
const DEFINITIONS = [
  { provider: 'anthropic', word: 'retired', url: URL.anthropic, file: 'anthropic-deprecations.md', quote: 'The model is no longer available for use. Requests to retired models fail.' },
  { provider: 'openai', word: 'shut down', url: URL.openai, file: 'openai-deprecations.md', quote: 'The model no longer accepts requests through the standard API.' },
  { provider: 'google', word: 'shut down', url: URL.google, file: 'google-deprecations.html', quote: 'it is completely turned off, and the endpoint is no longer available.' },
  {
    provider: 'anthropic',
    word: 'notice period',
    url: URL.anthropic,
    file: 'anthropic-deprecations.md',
    quote: 'Anthropic notifies customers with active deployments for models with upcoming retirements, providing at least 60 days’ notice before model retirement for publicly released models.',
  },
  {
    provider: 'openai',
    word: 'fine-tuned versions',
    url: URL.openai,
    file: 'openai-deprecations.md',
    quote: 'Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.',
  },
];
const definitions = DEFINITIONS.map(({ provider, word, url, file, quote }) => {
  const text = file.endsWith('.html') ? htmlToText(page(file)) : page(file);
  if (!quoteOn(text, quote)) throw new Error(`definition for ${provider} "${word}" not found on ${file}: ${quote}`);
  return { provider, word, url, quote };
});

// ── write ────────────────────────────────────────────────────────────────
const ALLOWED = new Set(['deprecated', 'retired', 'shut down', 'legacy', 'rerouted', 'scheduled for shutdown', 'listed', 'no longer supported', 'active']);
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
  ['deepseek', URL.deepseekFirstApiCall, 'deepseek-first-api-call.html'],
  ...['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']
    .filter((id) => existsSync(join(PAGES, `openai-model-${id}.md`)))
    .map((id) => ['openai', URL.openaiModel(id), `openai-model-${id}.md`]),
  // 0.4.4 (R6): each page's own title, as read from the saved page (the shape check above has already asserted it)
].map(([provider, url, file]) => ({ provider, url, readAt: readTimes[file], sha256: sha(file), title: pageTitleOf(file, pageTextOf(file, page(file))) }));

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
import type { LedgerRow, LedgerSource, LedgerDefinition } from './lifecycle-types.js';

export const LEDGER_SOURCES: readonly LedgerSource[] = ${JSON.stringify(sources, null, 2)};

/** The providers' own definitions the card quotes, each a sentence on the page it cites (0.4.2). */
export const LEDGER_DEFINITIONS: readonly LedgerDefinition[] = ${JSON.stringify(definitions, null, 2)};

export const LEDGER: readonly LedgerRow[] = ${JSON.stringify(rows, null, 2)};
`;
writeFileSync(OUT, ts);
console.log(`wrote ${OUT}: ${rows.length} rows (${Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(', ')})`);
if (PRINT) {
  for (const r of rows) console.log([r.provider, r.id, r.word, r.shutdown ?? r.shutdownFloor ?? '', r.replacement ?? '', r.routesTo ?? ''].join(' | '));
}
for (const l of log) console.log('note: ' + l);
