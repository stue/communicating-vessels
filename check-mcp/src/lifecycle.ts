/**
 * R3 — an id is matched as a developer writes it; R1/R2 — the ledger is read
 * before the catalog. Pure functions over the generated ledger and the
 * compiler's catalog; no network.
 */
import { allProfiles, tryGetProfile, type ModelProfile } from '@warmdrift/kgauto-compiler';
import { LEDGER, LEDGER_SOURCES, LEDGER_DEFINITIONS } from './lifecycle-ledger.js';
import { pageFileOf, pageNameOf } from './ledger-check.mjs';
import type { LedgerRow, LedgerProvider, DefinitionWord } from './lifecycle-types.js';

export interface Resolution {
  /** The id exactly as configured. */
  configured: string;
  /** The id looked up. */
  base: string;
  /** What was done to get from one to the other, in words; empty when nothing was. */
  steps: string[];
  /** Set when the id is a partner platform's form: its lifecycle dates may differ from the provider's own API. */
  partner?: Partner;
}

/**
 * A cloud platform that serves a provider's models on its own lifecycle schedule, or (0.4.1, R3)
 * a gateway the id is explicitly written for: neither is the provider's own API.
 */
export type Partner = 'vertex' | 'bedrock' | 'azure' | 'openrouter';

/** 0.4.1 (R3): the partners that are gateways rather than cloud platforms (their sentence is "may keep"). */
export const GATEWAYS: ReadonlySet<Partner> = new Set<Partner>(['openrouter']);

/**
 * The prefixes a developer writes before a model id. Each is credited to a page that SHOWS it
 * (Amendment C, ruling 7; read 2026-11-12, 07:26–07:27Z unless marked):
 *  - docs.litellm.ai/docs/providers (its provider index lists each with its prefix):
 *    `anthropic/` `azure/` `azure_ai/` `bedrock/` `gemini/` `huggingface/` `mistral/`
 *    `nvidia_nim/` `openai/` `perplexity/` `vertex_ai/` `vllm/` `watsonx/` `xai/`.
 *  - docs.litellm.ai/docs/providers/deepseek: `deepseek/` (`deepseek/deepseek-chat`).
 *  - docs.litellm.ai/docs/providers/openrouter (read 07:52:24Z): `openrouter/`
 *    (`openrouter/google/palm-2-chat-bison`).
 *  - openrouter.ai/docs/guides/overview/models: `google/` (`google/gemini-2.5-pro-preview`),
 *    with `anthropic/` and `openai/` (`anthropic/claude-3.5-sonnet`, `openai/gpt-4o`).
 *  - vercel.com/docs/ai-gateway/models-and-providers: `anthropic/claude-opus-5`, `openai/gpt-6-astra`.
 *  - aistudio.google.com/api-reference/models/get-model: the resource name `models/{model}`.
 *  - Route segments after a partner prefix, from LiteLLM's provider pages:
 *    `bedrock/converse|invoke|converse_like|chat_completions/` (…/providers/bedrock),
 *    `vertex_ai/gemini/` (…/providers/vertex), `azure/o_series/` (…/providers/azure).
 * A partner prefix resolves the id AND marks the site as the partner's.
 *
 * 0.4.1 (R3) — the one GATEWAY prefix: `openrouter/` marks the site as OpenRouter's, like a partner
 * platform. openrouter.ai/docs/quickstart (read 2026-11-14T19:39:26Z): "OpenRouter gives you access
 * to hundreds of AI models through a single API endpoint. It handles fallbacks automatically";
 * openrouter.ai/docs/guides/overview/models (same read): each model carries its own
 * `expiration_date`, "Deprecation date for the model endpoint". A bare `provider/` prefix stays
 * null: LiteLLM, OpenRouter and the AI Gateway all write that same form, and LiteLLM's means a
 * direct call to the provider.
 */
const PREFIXES: Record<string, Partner | null> = {
  openrouter: 'openrouter',
  openai: null,
  anthropic: null,
  google: null,
  deepseek: null,
  gemini: null,
  models: null,
  xai: null,
  mistral: null,
  huggingface: null,
  nvidia_nim: null,
  perplexity: null,
  vllm: null,
  watsonx: null,
  vertex_ai: 'vertex',
  bedrock: 'bedrock',
  azure: 'azure',
  azure_ai: 'azure',
};
/** Route segments LiteLLM's provider pages show after a partner prefix. */
const ROUTE_SEGMENTS = new Set(['converse', 'invoke', 'converse_like', 'chat_completions', 'o_series', 'gemini']);

const DATED_ANTHROPIC = /-(\d{8})$/;
const DATED_OPENAI = /-(\d{4}-\d{2}-\d{2})$/;

export function stripSnapshot(id: string): string | undefined {
  if (DATED_ANTHROPIC.test(id)) return id.replace(DATED_ANTHROPIC, '');
  if (DATED_OPENAI.test(id)) return id.replace(DATED_OPENAI, '');
  return undefined;
}

/**
 * The prefix, Bedrock and Vertex forms are rewritten to the provider's own
 * id. A dated snapshot is NOT stripped here — the lookup tries the dated id
 * first, because the pages list dated snapshots as rows of their own.
 */
export function resolveId(configured: string): Resolution {
  let id = configured.trim();
  const steps: string[] = [];
  let partner: Resolution['partner'];

  // Leading gateway/provider prefixes, possibly stacked (openrouter/anthropic/…).
  // Bounded: a prefix stack is never deeper than three, and a loop that cannot
  // spin keeps a mutant at the strip line a red test rather than a hang.
  for (let depth = 0; depth < 4; depth++) {
    const slash = id.indexOf('/');
    if (slash === -1) break;
    const head = id.slice(0, slash).toLowerCase();
    const known = Object.prototype.hasOwnProperty.call(PREFIXES, head);
    const route = depth > 0 && ROUTE_SEGMENTS.has(head) && id.slice(slash + 1).length > 0;
    if (!known && !route) break;
    if (known && PREFIXES[head]) partner = PREFIXES[head]!;
    steps.push(`removed the \`${head}/\` prefix`);
    id = id.slice(slash + 1);
  }
  // Amazon Bedrock: [region.]anthropic.<model>-v<N>[:<M>]
  const bedrock = /^(?:[a-z]{2,6}\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-v\d+(?::\d+)?)?$/.exec(id);
  if (bedrock) {
    steps.push('read the Amazon Bedrock form');
    id = bedrock[1]!;
    partner = 'bedrock';
  }
  // Claude on Google Cloud (Vertex): <model>@<YYYYMMDD>
  const vertex = /^(claude-[a-z0-9.-]+)@(\d{8})$/.exec(id);
  if (vertex) {
    steps.push('read the Google Cloud (Vertex) form');
    id = `${vertex[1]}-${vertex[2]}`;
    partner = 'vertex';
  }
  // A gateway's dotted Claude version (OpenRouter writes claude-sonnet-4.5).
  if (steps.length > 0 && /^claude-.*\d\.\d/.test(id)) {
    const dashed = id.replace(/(\d)\.(\d)/g, '$1-$2');
    if (dashed !== id) {
      steps.push('wrote the dotted version with hyphens, as Anthropic does');
      id = dashed;
    }
  }
  return { configured, base: id, steps, ...(partner ? { partner } : {}) };
}

// ── ledger lookup ─────────────────────────────────────────────────────────
const byId = new Map<string, LedgerRow>();
for (const r of LEDGER) byId.set(r.id, r);
// 0.4.5: a row the page writes with a prefix the lookup removes is also found under the id the lookup arrives at —
// Google's deprecations page, read 2026-11-20T05:02:18Z, lists `models/genie-4`, which resolveId reads as `genie-4`.
// Without this, that id (written either way) would be "not recognised" while the page lists it.
for (const r of LEDGER) {
  const b = resolveId(r.id).base;
  if (b !== r.id && !byId.has(b)) byId.set(b, r);
}

/**
 * Undated base ids whose every dated row on the page agrees (same word, same
 * date): `claude-sonnet-4-5` → `claude-sonnet-4-5-20250929`. A base the page
 * lists itself, or one whose snapshots disagree, is not indexed.
 */
const byBase = new Map<string, LedgerRow>();
{
  const groups = new Map<string, LedgerRow[]>();
  for (const r of LEDGER) {
    const b = stripSnapshot(r.id);
    if (!b || byId.has(b)) continue;
    groups.set(b, [...(groups.get(b) ?? []), r]);
  }
  for (const [b, rs] of groups) {
    const first = rs[0]!;
    if (rs.every((r) => r.word === first.word && r.shutdown === first.shutdown)) byBase.set(b, first);
  }
}

export interface LedgerHit {
  row?: LedgerRow;
  /** The id the ledger row was found under, when it differs from the resolved base. */
  via?: string;
  /** The id the catalog should be read under. */
  catalogId: string;
}

export function lookupLedger(res: Resolution): LedgerHit {
  const exact = byId.get(res.base);
  if (exact) return { row: exact, catalogId: stripSnapshot(res.base) ?? res.base };
  const stripped = stripSnapshot(res.base);
  if (stripped) {
    const r = byId.get(stripped) ?? byBase.get(stripped);
    if (r) return { row: r, via: r.id, catalogId: stripped };
  }
  const derived = byBase.get(res.base);
  if (derived) return { row: derived, via: derived.id, catalogId: res.base };
  return { catalogId: res.base };
}

/** The catalog profile for an id as written: the id itself, then its undated base. */
export function catalogProfile(id: string, get: (id: string) => ModelProfile | undefined = tryGetProfile): {
  profile?: ModelProfile;
  id: string;
} {
  const p = get(id);
  if (p) return { profile: p, id };
  const b = stripSnapshot(id);
  if (b) {
    const q = get(b);
    if (q) return { profile: q, id: b };
  }
  return { id };
}

// ── words ─────────────────────────────────────────────────────────────────
export const PROVIDER_NAME: Record<LedgerProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
};

/** The day the ledger's pages were read (the latest source read). */
export const LEDGER_READ_ON = LEDGER_SOURCES.map((s) => s.readAt.slice(0, 10)).sort().at(-1) ?? 'unknown';

/**
 * The provider's own definition of the consequence, verbatim from its page,
 * for the two words that mean a request now fails. Since 0.4.2 these come from the
 * generated ledger (LEDGER_DEFINITIONS), checked on the page like its rows: OpenAI
 * rewrote its sentence between the 2026-11-12 and 2026-11-14 reads.
 */
export const WORD_DEFINITION: Partial<Record<LedgerProvider, Partial<Record<DefinitionWord, string>>>> = {};
for (const d of LEDGER_DEFINITIONS) (WORD_DEFINITION[d.provider] ??= {})[d.word] = d.quote;

/** The page each definition above stands on (Amendment B, ruling 4), from the same ledger rows. */
export const DEFINITION_PAGE: Partial<Record<LedgerProvider, string>> = {};
for (const d of LEDGER_DEFINITIONS) DEFINITION_PAGE[d.provider] = d.url;

/**
 * 0.4.4 (R6): how the card names one of the ledger's pages — by the page's own title, as the ledger's source
 * list carries it (written by the generator from the saved page): "Google's release notes page", "OpenAI's model
 * page for GPT-4o mini", "DeepSeek's “Your First API Call” page". `provider` goes before it.
 */
export function pageName(provider: string, url: string): string {
  const P = PROVIDER_NAME[provider as LedgerProvider] ?? provider;
  const file = pageFileOf(url);
  const title = LEDGER_SOURCES.find((s) => s.url === url)?.title;
  return `${P}'s ${file ? pageNameOf(file, title) : 'page'}`;
}

/**
 * 0.4.4 (R4, R6): several of one provider's pages, named in one phrase — "OpenAI's deprecations page and its model
 * page for GPT-4o mini".
 */
export function pagesName(provider: string, urls: readonly string[]): string {
  const [first, ...rest] = [...new Set(urls)];
  if (first === undefined) return pageName(provider, '');
  const tail = rest.map((u) => {
    const file = pageFileOf(u);
    return `its ${file ? pageNameOf(file, LEDGER_SOURCES.find((s) => s.url === u)?.title) : 'page'}`;
  });
  return [pageName(provider, first), ...tail].join(' and ');
}

export const PARTNER_NAME: Record<Partner, string> = {
  vertex: 'Vertex AI',
  bedrock: 'Amazon Bedrock',
  azure: 'Azure',
  openrouter: 'OpenRouter',
};

/** The partner's own lifecycle page for a provider's models, where one is known (each fetched 2026-11-12, 07:26Z; OpenRouter's 2026-11-14T19:39:26Z). */
export function partnerPage(partner: Partner, provider: string): string | undefined {
  if (partner === 'openrouter') return 'https://openrouter.ai/docs/guides/overview/models';
  if (partner === 'vertex' && provider === 'google') return 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions';
  if (partner === 'vertex' && provider === 'anthropic')
    return 'https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/google-managed';
  if (partner === 'bedrock') return 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html';
  if (partner === 'azure' && provider === 'openai')
    return 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-retirements';
  return undefined;
}

/**
 * Amendment C, ruling 1: the word list only CHOOSES which sentence is added; it never makes a
 * line certain. Partner signs in a site's path or notes: the platform's name, its SDK, its
 * client shape, its endpoint.
 */
export function wordPartner(site: { id?: string; where?: string; notes?: string }): Partner | undefined {
  const text = `${site.id ?? ''} ${site.where ?? ''} ${site.notes ?? ''}`;
  if (/vertex|aiplatform|\bproject\b[^.]{0,60}\blocation\b|\blocation\b[^.]{0,60}\bproject\b/i.test(text)) return 'vertex';
  if (/bedrock/i.test(text)) return 'bedrock';
  if (/azure|foundry/i.test(text)) return 'azure';
  return undefined;
}

export interface SiteState {
  /** The partner platform the site runs on, if anything says so. */
  partner?: Partner;
  /** The extract stated the provider's own API and nothing contradicts it: the only certain case. */
  providerApi: boolean;
  /** The extract's stated platform and the id's form or the site's notes disagree. */
  conflict?: string;
  /** Amendment D1: where the partner came from — the id's own form, the extract's stated platform, or only words in the path or notes. */
  source?: 'id' | 'stated' | 'words';
}

/**
 * Amendment C, rulings 1 and 2: a partner-only id form is tested first and outranks a stated
 * platform; then the stated platform; then the word list (which can contradict a stated
 * provider API but never confirm one).
 */
export function siteState(site: { id?: string; where?: string; notes?: string; platform?: string }, res: Resolution): SiteState {
  const stated = site.platform;
  if (res.partner) {
    const conflict =
      stated === 'provider-api' || ((stated === 'vertex' || stated === 'bedrock' || stated === 'azure') && stated !== res.partner)
        ? `the extract says ${stated === 'provider-api' ? "the provider's own API" : PARTNER_NAME[stated as Partner]}, but the id's form is ${PARTNER_NAME[res.partner]}'s`
        : undefined;
    return { partner: res.partner, providerApi: false, source: 'id', ...(conflict ? { conflict } : {}) };
  }
  if (stated === 'vertex' || stated === 'bedrock' || stated === 'azure') return { partner: stated, providerApi: false, source: 'stated' };
  const words = wordPartner(site);
  if (stated === 'provider-api') {
    if (words)
      return { partner: words, providerApi: false, source: 'words', conflict: `the extract says the provider's own API, but its notes or path name ${PARTNER_NAME[words]}` };
    return { providerApi: true };
  }
  return { ...(words ? { partner: words, source: 'words' as const } : {}), providerApi: false };
}

/** Back-compat for callers that only need the partner. */
export function sitePartner(site: { id?: string; where?: string; notes?: string; platform?: string }, res: Resolution): Partner | undefined {
  return siteState(site, res).partner;
}

/**
 * Amendment C, ruling 4: platforms the provider's own deprecations page says its dates apply to.
 * Anthropic's page, read 2026-11-12T07:52:24Z (byte-identical to the 06:20:55Z read): "The dates on
 * this page apply to Anthropic-operated platforms: the Claude API, Claude Platform on AWS, Claude
 * Models on Google Cloud (Anthropic managed), and Microsoft Foundry."
 */
export function coveredBy(provider: string, partner: Partner): string | undefined {
  if (provider === 'anthropic' && partner === 'azure') return 'Microsoft Foundry';
  return undefined;
}

export const PARTNER_CAVEAT =
  'Anthropic\'s page: the dates "apply to Anthropic-operated platforms"; Amazon Bedrock and Google-managed Claude on Google Cloud "set their own retirement schedules, so a model’s lifecycle status and dates can differ."';

// ── the new-release sentence ──────────────────────────────────────────────
interface FamVer {
  family: string;
  version: number[];
}
/** `claude-opus-4-8` → {claude-opus, [4,8]}; `gemini-3.8-flash` → {gemini…flash, [3,8]}; null when the name has no clean version. */
export function familyAndVersion(id: string): FamVer | null {
  const base = stripSnapshot(id) ?? id;
  if (base.includes('/')) return null;
  const parts = base.split('-');
  const fam: string[] = [];
  const ver: number[] = [];
  let i = 0;
  while (i < parts.length && /^[a-z]+$/.test(parts[i]!)) fam.push(parts[i++]!);
  while (i < parts.length && /^v?\d+(\.\d+)*$/.test(parts[i]!)) {
    ver.push(...parts[i]!.replace(/^v/, '').split('.').map(Number));
    i++;
  }
  if (fam.length === 0 || ver.length === 0) return null;
  // the words after the version are part of the family too (flash, pro, lite…)
  const tail = parts.slice(i);
  if (tail.some((t) => !/^[a-z]+$/.test(t))) return null;
  return { family: [...fam, ...tail].join('-'), version: ver };
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** The family name when `id` sorts above every id kgauto knows (catalog + ledger) of its family; else null. */
export function newerThanFamily(id: string, roster: () => readonly ModelProfile[] = allProfiles): string | null {
  const me = familyAndVersion(id);
  if (!me) return null;
  const known = [...roster().map((p) => p.id), ...LEDGER.map((r) => r.id)]
    .map(familyAndVersion)
    .filter((x): x is FamVer => !!x && x.family === me.family);
  if (known.length === 0) return null;
  return known.every((k) => cmp(me.version, k.version) > 0) ? me.family : null;
}
