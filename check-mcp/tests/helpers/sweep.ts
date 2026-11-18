/**
 * 0.4.4 (R1): every basis line the engine can print, gathered by running it — never by reading its source.
 *
 *  - every ledger row (all of them), under every state a row can be in after a read (confirmed; changed;
 *    unread with every page it rests on unread; and, for a row on two pages, each page read while the other
 *    was not), on every placement a site can have (the provider's own API, unstated, each partner platform,
 *    and the gateway's id form);
 *  - every profile in the pinned catalog, at a call site built to fire every line kind (over the context and
 *    output limits, parallel tool calls, structured output, no retry, a high input share, every archetype so
 *    every cliff's work type is reached, a tool count over every tool cliff), and as a listed id;
 *  - made-up profiles, through the engine's `resolve`/`roster` seams, for every value the pinned catalog
 *    does not hold today: no parallel tool calls, no structured output, no date against a provider page,
 *    each provider-lifecycle word, and a cliff of every evidence class × verdict × with and without a date,
 *    on each metric the engine prints;
 *  - an id the check does not recognise.
 */
import { allProfiles, ALL_ARCHETYPES, type ModelProfile } from '@warmdrift/kgauto-compiler';
import { analyseModel, runCheck, type Finding } from '../../src/engine.js';
import { LEDGER } from '../../src/lifecycle-ledger.js';
import type { PageRead, RowState } from '../../src/pages.js';
import type { LedgerRow } from '../../src/lifecycle-types.js';

const AT = '2026-11-17T23:17:05Z';
const PLATFORMS: (string | undefined)[] = ['provider-api', undefined, 'vertex', 'bedrock', 'azure', 'other'];

/** A read in which every row is in the state `stateOf(row)` gives it. */
export function readWith(stateOf: (r: LedgerRow) => RowState): PageRead {
  return {
    how: 'network',
    pages: [],
    rows: new Map(LEDGER.map((r) => [r.id, stateOf(r)])),
    definitions: new Map(),
  };
}

/** The pages a row rests on, in order (its own, then its second page when that is another page). */
export const pagesOf = (r: LedgerRow): string[] => [...new Set([r.url, ...(r.alsoUrl && r.alsoQuote ? [r.alsoUrl] : [])])];

/** Every state a row can be in after a read. */
export function statesOf(r: LedgerRow): RowState[] {
  const urls = pagesOf(r);
  const out: RowState[] = [
    { state: 'confirmed', at: AT, read: urls.map((url) => ({ url, at: AT, stands: true })) } as RowState,
    { state: 'changed', at: AT, gone: [], read: urls.map((url) => ({ url, at: AT, stands: url !== r.url })) } as RowState,
    { state: 'unread', reason: 'HTTP 503', notRead: urls.map((url) => ({ url, reason: 'HTTP 503' })), read: [] } as RowState,
  ];
  if (urls.length > 1) {
    for (const missing of urls) {
      out.push({
        state: 'unread',
        reason: 'not the page this version reads',
        notRead: [{ url: missing, reason: 'not the page this version reads' }],
        read: urls.filter((u) => u !== missing).map((url) => ({ url, at: AT, stands: true })),
      } as RowState);
    }
  }
  return out;
}

const synthBase = (): ModelProfile => ({ ...allProfiles()[0]!, cliffs: [], probedLimits: undefined, providerLifecycle: undefined });

/** Made-up profiles for every value the pinned catalog does not hold today. */
export function syntheticProfiles(): ModelProfile[] {
  const out: ModelProfile[] = [];
  let n = 0;
  const mk = (over: Partial<ModelProfile>) => out.push({ ...synthBase(), id: `made-up-model-${++n}`, ...over } as ModelProfile);
  mk({ parallelToolCalls: false, structuredOutput: 'none' as ModelProfile['structuredOutput'] });
  mk({ parallelToolCalls: false, structuredOutput: 'none' as ModelProfile['structuredOutput'], verifiedAgainstDocs: undefined });
  for (const status of ['deprecated', 'legacy', 'retired'] as const) {
    mk({ providerLifecycle: { status, readOn: '2026-11-01', url: 'https://example.com/models/made-up' } });
    mk({ providerLifecycle: { status, readOn: '2026-11-01', url: 'https://example.com/models/made-up', retirementFloor: '2027-01-01', replacement: 'made-up-next' } });
  }
  const evidences: (ModelProfile['cliffs'][number]['evidence'] | undefined)[] = [undefined];
  for (const cls of ['observed', 'assumed', 'asserted', 'probed'] as const) {
    for (const verdict of [undefined, 'confirmed', 'flagged', 'knee-moved'] as const) {
      for (const lastProbed of [undefined, '2026-10-01']) {
        evidences.push({ class: cls, ...(verdict ? { verdict } : {}), ...(lastProbed ? { lastProbed } : {}) });
      }
    }
  }
  const reasons = ['a reason with no word about how it was found', 'measured on real traffic, n=12', 'carried over from a sibling model'];
  const cliffs: ModelProfile['cliffs'] = [];
  for (const metric of ['input_tokens', 'tool_count'] as const) {
    for (const evidence of evidences) {
      for (const reason of reasons) {
        cliffs.push({ metric, threshold: metric === 'tool_count' ? 5 : 1000, action: 'downgrade_quality_warning', reason, ...(evidence ? { evidence } : {}) });
      }
    }
  }
  mk({ cliffs });
  return out;
}

/** A call site built to fire every line kind for one profile. */
function sitesFor(p: ModelProfile, model: string) {
  const inputCliffs = p.cliffs.filter((c) => c.metric === 'input_tokens').map((c) => c.threshold);
  const toolCliffs = p.cliffs.filter((c) => c.metric === 'tool_count').map((c) => c.threshold);
  const input = Math.max(p.maxContextTokens + 1, ...inputCliffs) * 20;
  return [...ALL_ARCHETYPES, undefined].flatMap((archetype) =>
    PLATFORMS.map((platform, i) => ({
      id: `site-${archetype ?? 'none'}-${i}`,
      model,
      ...(platform ? { platform: platform as 'provider-api' } : {}),
      ...(archetype ? { archetype } : {}),
      estInputTokens: input,
      maxInputTokens: input,
      estOutputTokens: p.maxOutputTokens + 1,
      toolCount: Math.max(1, ...toolCliffs),
      usesParallelToolCalls: true,
      expectsStructuredOutput: true,
      retry: 'none' as const,
      estCallsPerMonth: 1000,
    })),
  );
}

export interface Swept {
  /** Every basis printed, with how many times. */
  bases: Map<string, number>;
  /** Amendment A2 (fix pass 1): every title and every detail printed, each once (the same lines, read the same way). */
  titles: Set<string>;
  details: Set<string>;
  /** How many findings were read. */
  findings: number;
}

export function sweepBases(): Swept {
  const bases = new Map<string, number>();
  const titles = new Set<string>();
  const details = new Set<string>();
  let findings = 0;
  const take = (fs: readonly Pick<Finding, 'basis' | 'title' | 'detail'>[]) => {
    for (const f of fs) {
      findings++;
      bases.set(f.basis, (bases.get(f.basis) ?? 0) + 1);
      titles.add(f.title);
      details.add(f.detail);
    }
  };
  // 1. every ledger row × every state × every placement
  for (const r of LEDGER) {
    for (const st of statesOf(r)) {
      const pages = readWith((x) => (x.id === r.id ? st : ({ state: 'unread', reason: 'not read by this caller' } as RowState)));
      for (const platform of PLATFORMS) take(analyseModel(r.id, { pages, today: '2026-11-17' }, { platform }).lines);
      take(analyseModel(`openrouter/${r.provider === 'google' ? 'google' : r.provider}/${r.id}`, { pages, today: '2026-11-17' }, {}).lines);
    }
  }
  // 2. every profile in the pinned catalog, at a site that fires every line kind, and as a listed id
  const confirmedAll = readWith((r) => statesOf(r)[0]!);
  for (const p of allProfiles()) {
    take(runCheck({ project: { name: 'sweep' }, callSites: sitesFor(p, p.id), models: [{ model: p.id, where: 'src/models.ts:1' }] }, { pages: confirmedAll, today: '2026-11-17' }).findings);
  }
  // 3. made-up profiles, through the seams
  const synth = syntheticProfiles();
  const byId = new Map(synth.map((p) => [p.id, p]));
  const roster = () => [...allProfiles(), ...synth];
  const resolve = (id: string) => ({ canonical: id, profile: byId.get(id) });
  for (const p of synth) {
    take(
      runCheck({ project: { name: 'sweep' }, callSites: sitesFor(p, p.id), models: [{ model: p.id, where: 'src/models.ts:1' }] }, { pages: confirmedAll, today: '2026-11-17', resolve, roster })
        .findings,
    );
  }
  // 4. an id nobody knows
  take(runCheck({ project: { name: 'sweep' }, callSites: [{ id: 'a.ts:1', model: 'not-a-model-anyone-ships' }] }, { today: '2026-11-17' }).findings);
  return { bases, titles, details, findings };
}

/**
 * Amendment A2 (fix pass 1): what a stranger must never read on a title or a detail — our words for the catalog's
 * thresholds and its tests (cliff, probe, in every form). A catalog reason quoted on a cliff line (“The catalog's
 * reason: “…””) is the compiler's text in quotation marks, set aside here: those strings are named outside the 0.4.4
 * filing ("Not in this filing": the compiler's cliff reason strings), and two of them say "probed".
 */
export const OUR_LINE_WORDS = /\b(cliffs?|prob(?:e|es|ed|ing))\b/i;
export function lineMisses(text: string): string | undefined {
  const t = text.replace(/The catalog's reason(?: \(for [^)]*\))?: “[^”]*”/g, 'The catalog\'s reason: “<quoted>”');
  return OUR_LINE_WORDS.exec(t)?.[0];
}

/** A basis as a shape: addresses, times, dates and numbers replaced, so the list can be read once each. */
export const shapeOf = (b: string) =>
  b
    .replace(/https?:\/\/\S+?(?=[;)]|\s|$)/g, '<url>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\b\d[\d,]*\b/g, '<n>');

/** The partner clause a basis can end on, one of four (placeLine): listed once in the report, not once per shape. */
export const PARTNER_CLAUSE = /; (Amazon Bedrock|Vertex AI|Azure|OpenRouter): <url>$/;
/** A shape without its partner clause. */
export const baseShapeOf = (b: string) => shapeOf(b).replace(PARTNER_CLAUSE, '');

/** What a stranger must never read in a basis: a field name, an `=`, or one of our own words. */
export function strangerMisses(b: string): string[] {
  const t = b.replace(/https?:\/\/\S+/g, ' ');
  const out: string[] = [];
  const camel = /\b[a-z]+[A-Z][A-Za-z]*\b/.exec(t);
  if (camel) out.push(`a field name (${camel[0]})`);
  const snake = /\b[a-z]+_[a-z_]+\b/.exec(t);
  if (snake) out.push(`a field name (${snake[0]})`);
  if (t.includes('=')) out.push('an "="');
  const word = /\b(cliffs?|portfolio|heuristic|providerLifecycle|evidence record|kgauto|measured|measurement|brain)\b/i.exec(t);
  if (word) out.push(`a word of ours (${word[0]})`);
  return out;
}
