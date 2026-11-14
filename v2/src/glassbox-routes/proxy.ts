/**
 * proxy(req) — Glass-Box replay query handler.
 *
 * GET /api/glassbox/proxy?traceId=<id>   → single compile_outcomes row for trace
 * GET /api/glassbox/proxy?limit=<N>      → N most-recent compile_outcomes rows
 * GET /api/glassbox/proxy                → defaults to limit=20
 *
 * Brain reads go through PostgREST on Supabase. We always filter by
 * `app_id=eq.<appId>` even though the scoped JWT's RLS policy already
 * enforces tenant isolation — the explicit filter trims the network payload
 * and makes the query intent obvious to anyone reading logs.
 *
 * Scrub: the optional `scrub` hook runs on each row before responding so
 * sensitive payloads (rendered prompts, tool calls) can be redacted at the
 * proxy boundary. Default is identity (no-op).
 */

import { checkAuth } from './auth.js';
import type {
  AdvisoryRecord,
  Adapter,
  ProxyConfig,
  ScrubHook,
  SectionKind,
  TraceSummary,
  TraceDetail,
  TraceHealth,
  TraceSectionRewrite,
} from './types.js';
import { computeCounterfactuals } from './counterfactuals.js';
import { computeProjectedDailyCost } from './projected-cost.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
} as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(status: number, code: string): Response {
  return jsonResponse(status, { error: code });
}

function applyScrub(row: unknown, scrub: ScrubHook | undefined): unknown {
  if (!scrub || row == null || typeof row !== 'object') return row;
  try {
    return scrub(row as Record<string, unknown>);
  } catch {
    // A buggy scrub hook must never bring down the route. Fall through to
    // the unscrubbed row — the consumer set up scrub themselves and is
    // responsible for diagnosing crashes. Quiet behavior is acceptable
    // because the row never leaves their infrastructure raw.
    return row;
  }
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Typed boundary transformer: compile_outcomes row (snake_case, Postgres
 * native) → TraceSummary (camelCase, TypeScript native + extension wire
 * contract). Single canonical mapping site — every DB-shape ↔ wire-shape
 * crossing routes through here so renderer-expected fields can't silently
 * go missing. See `feedback_typed_boundary_transformers.md` for the rule.
 */
export function rowToSummary(row: Record<string, unknown>): TraceSummary {
  return {
    traceId: typeof row.handle === 'string' ? row.handle : '',
    appId: typeof row.app_id === 'string' ? row.app_id : '',
    archetype:
      typeof row.intent_archetype === 'string' ? row.intent_archetype : '',
    target: typeof row.model === 'string' ? row.model : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    tokensIn: typeof row.tokens_in === 'number' ? row.tokens_in : 0,
    tokensOut: typeof row.tokens_out === 'number' ? row.tokens_out : 0,
    estimatedCostUsd:
      typeof row.cost_usd_actual === 'number' ? row.cost_usd_actual : 0,
  };
}

/** Health threshold (input-ratio dot): green ≤ 0.65 · yellow 0.65–0.85 · red > 0.85. */
const INPUT_RATIO_YELLOW = 0.65;
const INPUT_RATIO_RED = 0.85;

/** Cache health is meaningful only when there's something to cache. */
const CACHE_HEALTH_MIN_TOKENS = 1000;

/** Cache health thresholds on inputCacheHitRatio. */
const CACHE_RATIO_GREEN = 0.5;
const CACHE_RATIO_YELLOW = 0.1;

const FALLBACK_REASONS = new Set<TraceDetail['fallbackReason']>([
  'rate_limit',
  'provider_auth_failed',
  'provider_billing_exhausted',
  'provider_error',
  'cliff',
  'cost_cap',
  'contract_violation',
]);

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asNumberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (typeof e === 'string') out.push(e);
  }
  return out;
}

function asFallbackReason(v: unknown): TraceDetail['fallbackReason'] {
  if (typeof v !== 'string') return undefined;
  // Trust the writer side — but only accept the closed set. Unknown values
  // map to 'provider_error' to keep the renderer's discriminated union
  // exhaustive without throwing.
  const candidate = v as TraceDetail['fallbackReason'];
  if (candidate && FALLBACK_REASONS.has(candidate)) return candidate;
  return 'provider_error';
}

/**
 * alpha.28 — coerce a brain advisory row into a wire-shape AdvisoryRecord.
 *
 * The sibling `compile_outcome_advisories` rows carry the same shape the
 * brain stored from `BestPracticeAdvisory` (snake_case columns). Today the
 * proxy doesn't JOIN against that table inline — the detail-view doc-spec
 * says advisories are a planned join (Phase 2+). For now, `compile_outcomes`
 * itself has no advisories column, so we always return [] unless the row
 * carries an `advisories` array (synthetic / test fixtures).
 *
 * When the production JOIN lands, this transformer is the single place to
 * extend. Keeping it here over a one-off inline-cast preserves the
 * typed-boundary-transformer invariant (L-118).
 */
function rowToAdvisory(raw: unknown): AdvisoryRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const level = r.level;
  const code = r.code;
  const message = r.message;
  if (
    (level !== 'info' && level !== 'warn' && level !== 'critical') ||
    typeof code !== 'string' ||
    typeof message !== 'string'
  ) {
    return undefined;
  }
  const out: AdvisoryRecord = { level, code, message };
  const suggestion = asString(r.suggestion);
  if (suggestion) out.suggestion = suggestion;
  const docsUrl = asString(r.docs_url ?? r.docsUrl);
  if (docsUrl) out.docsUrl = docsUrl;
  const adapter = toAdapter(r.suggested_adaptation ?? r.suggestedAdaptation);
  if (adapter) out.suggestedAdaptation = adapter;
  return out;
}

/**
 * alpha.29 — closed set of `SectionKind` values accepted at the wire
 * boundary. Mirrors `SectionKind` in `ir.ts` but kept as a runtime guard so
 * the transformer can reject unknown kinds from stale brain rows / future
 * additions that the deployed renderer doesn't know about.
 */
const SECTION_KINDS = new Set<SectionKind>([
  'role_intro',
  'tool_call_contract',
  'narration_contract',
  'discipline_contract',
  'user_turn',
  'reference',
  'arbitrary',
]);

/**
 * alpha.29 — humanize a (kind, rule) tuple for the renderer's Coaching card.
 * Plain English; no internal jargon. Per design contract section
 * "Wire-shape extension (Glass-Box layer)" — only `rule` + `summary` cross
 * the wire (no original/transformed text).
 */
function summarizeSectionRewrite(kind: SectionKind, rule: string): string {
  if (kind === 'tool_call_contract' && rule === 'sequential-tool-cliff-below-floor') {
    return 'Sequential tool pattern applied (model cliff cleared at compile time).';
  }
  // alpha.31 — narration rewrites.
  if (kind === 'narration_contract' && rule === 'narration-drift-anthropic') {
    return 'Narration tightened for Anthropic dialect (terse-log shape preserved).';
  }
  if (kind === 'narration_contract' && rule === 'narration-thinking-leak-deepseek') {
    return 'Thinking-block suppression applied (DeepSeek V4 internal reasoning kept off-wire).';
  }
  // alpha.68 / Release A — discipline gate block.
  if (kind === 'discipline_contract' && rule === 'discipline-gates-v1') {
    return 'Discipline gates applied (surface-scaffolding: evidence-before-reasoning, one-extra-signal, source-labeling).';
  }
  // Generic fallback — future rules land here with their own branch.
  return `Translator applied rule "${rule}" to ${kind} section.`;
}

/**
 * alpha.29 — coerce a row's `section_rewrites_applied` JSONB into the wire
 * shape. PII-safe by construction: `originalText` / `transformedText` from
 * the brain row are NEVER copied across — the wire shape carries only
 * `summary`. Returns [] for pre-019 rows (NULL column) or malformed entries.
 */
function rowToSectionRewrite(raw: unknown): TraceSectionRewrite | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const sectionId = r.sectionId ?? r.section_id;
  if (typeof sectionId !== 'string' || sectionId.length === 0) return undefined;
  const kind = r.kind;
  if (typeof kind !== 'string' || !SECTION_KINDS.has(kind as SectionKind)) {
    return undefined;
  }
  const rule = r.rule;
  if (typeof rule !== 'string' || rule.length === 0) return undefined;
  return {
    sectionId,
    kind: kind as SectionKind,
    rule,
    summary: summarizeSectionRewrite(kind as SectionKind, rule),
  };
}

function toAdapter(raw: unknown): Adapter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  // Closed discriminated union — only the alpha.28 ratified variant is
  // accepted here. Future variants extend the type AND this guard
  // explicitly (per design contract R3).
  if (
    a.parameter === 'toolOrchestration' &&
    a.value === 'sequential' &&
    typeof a.consequence === 'string'
  ) {
    return {
      parameter: 'toolOrchestration',
      value: 'sequential',
      consequence: a.consequence,
    };
  }
  return undefined;
}

function computeHealth(args: {
  tokensIn: number;
  tokensOut: number;
  cacheReadInputTokens: number;
  historyCacheableTokens: number;
  inputCacheHitRatio: number;
  fellOverFrom: string | undefined;
  target: string;
}): TraceHealth {
  const {
    tokensIn,
    tokensOut,
    historyCacheableTokens,
    inputCacheHitRatio,
    fellOverFrom,
    target,
  } = args;

  const total = tokensIn + tokensOut;
  const ratio = total > 0 ? tokensIn / total : 0;
  let inputRatioStatus: TraceHealth['inputRatioStatus'];
  if (ratio > INPUT_RATIO_RED) inputRatioStatus = 'red';
  else if (ratio > INPUT_RATIO_YELLOW) inputRatioStatus = 'yellow';
  else inputRatioStatus = 'green';

  let cacheStatus: TraceHealth['cacheStatus'];
  if (historyCacheableTokens <= CACHE_HEALTH_MIN_TOKENS) {
    cacheStatus = 'na';
  } else if (inputCacheHitRatio >= CACHE_RATIO_GREEN) {
    cacheStatus = 'green';
  } else if (inputCacheHitRatio >= CACHE_RATIO_YELLOW) {
    cacheStatus = 'yellow';
  } else {
    cacheStatus = 'red';
  }

  const fallbackStatus: TraceHealth['fallbackStatus'] =
    fellOverFrom !== undefined && fellOverFrom !== target ? 'red' : 'green';

  return { inputRatioStatus, cacheStatus, fallbackStatus };
}

/**
 * Typed boundary transformer (L-118): compile_outcomes row → TraceDetail.
 * Single canonical mapping site for the detail-view wire contract. Pre-018
 * brain rows return NULL for the new columns; this transformer applies
 * type-safe defaults (0 for token columns, undefined for optional strings)
 * so the renderer never crashes on missing fields.
 *
 * alpha.28 extends the field set per the renderer design contract — every
 * extended field has a default. The `counterfactuals` + `projectedDailyCost`
 * fields are populated by the proxy AFTER this transformer runs (they need
 * profile lookup / brain query / async I/O).
 */
export function rowToDetail(row: Record<string, unknown>): TraceDetail {
  const summary = rowToSummary(row);

  const tokensIn = summary.tokensIn;
  const tokensOut = summary.tokensOut;
  const cacheReadInputTokens = asNumberOrZero(row.cache_read_input_tokens);
  const cacheCreationInputTokens = asNumberOrZero(
    row.cache_creation_input_tokens,
  );
  const historyCacheableTokens = asNumberOrZero(row.history_cacheable_tokens);
  const inputCacheHitRatio =
    tokensIn > 0 ? cacheReadInputTokens / tokensIn : 0;

  const fellOverFrom = asString(row.fell_over_from);
  const fallbackReasonRaw = row.fallback_reason;
  // Only surface fallbackReason when fellOverFrom is set — keeps the two
  // fields lockstep. A row carrying fallback_reason without fell_over_from
  // is incoherent (probably a writer bug); honor the contract and drop it.
  const fallbackReason = fellOverFrom
    ? asFallbackReason(fallbackReasonRaw)
    : undefined;
  // KG-18 (alpha.111) — the second axis and the key in use, carried verbatim when present.
  const fallbackClassRaw = asString(row.fallback_class);
  const fallbackClass = fellOverFrom && fallbackClassRaw && ['balance', 'quota', 'outage', 'refusal', 'quality'].includes(fallbackClassRaw)
    ? (fallbackClassRaw as 'balance' | 'quota' | 'outage' | 'refusal' | 'quality')
    : undefined;
  const quotaId = fellOverFrom ? asString(row.quota_id) : undefined;
  const keyFingerprint = asString(row.key_fingerprint);

  // requestedModel: prefer the brain's explicit `requested_model` column
  // (populated when v2's record() detects a fallback fired). If absent but
  // fell_over_from is set, the original target IS the requestedModel.
  const requestedModel = asString(row.requested_model) ?? fellOverFrom;

  const advisoriesRaw = Array.isArray(row.advisories) ? row.advisories : [];
  const advisories: AdvisoryRecord[] = [];
  for (const a of advisoriesRaw) {
    const rec = rowToAdvisory(a);
    if (rec) advisories.push(rec);
  }

  const health = computeHealth({
    tokensIn,
    tokensOut,
    cacheReadInputTokens,
    historyCacheableTokens,
    inputCacheHitRatio,
    fellOverFrom,
    target: summary.target,
  });

  // alpha.29 — translator activity. JSONB array on the brain row → wire
  // shape. PII-safe: originalText / transformedText never leave the brain.
  // Pre-019 rows have NULL → empty array (typed-boundary-transformer
  // discipline; never undefined on the wire).
  const sectionRewritesRaw = Array.isArray(row.section_rewrites_applied)
    ? row.section_rewrites_applied
    : [];
  const sectionRewritesApplied: TraceSectionRewrite[] = [];
  for (const e of sectionRewritesRaw) {
    const rw = rowToSectionRewrite(e);
    if (rw) sectionRewritesApplied.push(rw);
  }

  const detail: TraceDetail = {
    ...summary,
    mutationsApplied: asStringArray(row.mutations_applied),
    advisories,
    rawRequest: asString(row.prompt_preview),
    rawResponse: asString(row.response_preview),

    requestedModel,
    finishReason: asString(row.finish_reason),

    ttftMs: asNumber(row.ttft_ms),
    totalMs:
      asNumber(row.total_ms) ?? asNumber(row.latency_ms),

    toolsCount: asNumber(row.tools_count),
    historyDepth: asNumber(row.history_depth),
    systemPromptChars: asNumber(row.system_prompt_chars),

    cacheReadInputTokens,
    cacheCreationInputTokens,
    historyCacheableTokens,
    inputCacheHitRatio,

    fellOverFrom,
    fallbackReason,
    ...(fallbackClass ? { fallbackClass } : {}),
    ...(quotaId ? { quotaId } : {}),
    ...(keyFingerprint ? { keyFingerprint } : {}),

    sectionRewritesApplied,

    health,
  };

  return detail;
}

/**
 * @internal — exported solely for the alpha.28 test suite. The transformer
 * is the single canonical boundary between brain rows + the wire contract;
 * tests assert it directly so the round-trip from synthetic brain row →
 * TraceDetail is locked at the unit level. Consumers should not import.
 */
export const _internal = {
  rowToSummary,
  rowToDetail,
  computeHealth,
  rowToAdvisory,
  toAdapter,
  rowToSectionRewrite,
  summarizeSectionRewrite,
  parseLimit,
};

export function createProxyHandler(
  config: ProxyConfig,
): (req: Request) => Promise<Response> {
  const {
    installToken,
    extensionId,
    brainEndpoint,
    brainJwt,
    brainAnonKey,
    appId,
    scrub,
    fetch: fetchImpl,
  } = config;

  // Honor injected fetch (tests) but default to the runtime's global —
  // captured at handler-construction time so tests can swap it pre-call.
  const doFetch: typeof fetch =
    fetchImpl ?? ((...args) => globalThis.fetch(...args));

  // Normalize endpoint — strip trailing slash so concatenation is predictable.
  const base = brainEndpoint.replace(/\/+$/, '');

  return async function proxy(req: Request): Promise<Response> {
    const authFail = checkAuth(req, { installToken, extensionId });
    if (authFail) return authFail;

    const url = new URL(req.url);
    const traceId = url.searchParams.get('traceId');
    const limit = parseLimit(url.searchParams.get('limit'));

    const qs = new URLSearchParams();
    qs.set('app_id', `eq.${appId}`);
    if (traceId) {
      // The trace identifier column on compile_outcomes is `handle` (the
      // wire-shape field is `traceId` — see rowToSummary above). Pre-alpha.25
      // this was `trace_id` which doesn't exist on the table → PostgREST
      // returned 400 → proxy mapped to bad_request → detail mode never worked.
      // Same L-117 family as the alpha.24 triple-fix: substrate ships against
      // a contract no smoke test exercised. Filed under KG-18.
      qs.set('handle', `eq.${traceId}`);
    } else {
      qs.set('order', 'created_at.desc');
      qs.set('limit', String(limit));
    }

    const brainUrl = `${base}/rest/v1/compile_outcomes?${qs.toString()}`;

    let brainRes: Response;
    try {
      brainRes = await doFetch(brainUrl, {
        method: 'GET',
        headers: {
          // Authorization carries the scoped JWT — drives RLS via app_id claim.
          Authorization: `Bearer ${brainJwt}`,
          // apikey MUST be one of the project's known keys (anon or
          // service_role). Supabase rejects any other JWT here, even when
          // HS256-signed with the same secret. Pre-alpha.24 this was set to
          // brainJwt and silently 401'd against real Supabase. See L-117.
          apikey: brainAnonKey,
          Accept: 'application/json',
        },
      });
    } catch {
      return jsonError(502, 'brain_unavailable');
    }

    if (brainRes.status === 401 || brainRes.status === 403) {
      // Brain rejected our scoped JWT — consumer misconfig (wrong claim,
      // expired token, mismatched app_id). Surface as 500 because this is
      // a server-side problem, not a client error.
      return jsonError(500, 'brain_auth_misconfig');
    }
    if (brainRes.status >= 500) {
      return jsonError(502, 'brain_unavailable');
    }
    if (!brainRes.ok) {
      // 4xx other than auth — treat as bad request bubbled up from
      // PostgREST (e.g. malformed query). Surface as 400 with the brain's
      // response body when possible.
      return jsonError(400, 'bad_request');
    }

    let rows: unknown;
    try {
      rows = await brainRes.json();
    } catch {
      return jsonError(502, 'brain_unavailable');
    }

    if (!Array.isArray(rows)) {
      return jsonError(502, 'brain_unavailable');
    }

    // Scrub raw compile_outcomes rows BEFORE the wire-shape transform so
    // scrub hooks operate on the documented DB field names. PII payload
    // fields like `prompt_preview` / `response_preview` are still snake_case
    // here; the transform maps them to `rawRequest` / `rawResponse` after.
    const scrubbed = rows.map(
      (row) => applyScrub(row, scrub) as Record<string, unknown>,
    );

    // Wire-shape envelope: detail mode returns a single TraceDetail; list
    // mode returns { traces: TraceSummary[] }. Matches the Chrome extension's
    // brain-poll contract (see extension/lib/types.ts).
    if (traceId) {
      const first = scrubbed[0];
      if (!first) return jsonError(404, 'not_found');
      const detail = rowToDetail(first);

      // alpha.28: enrich the detail with counterfactuals + projected-at-
      // volume. Both are best-effort: counterfactuals is a pure local
      // computation (cost-free); projected-cost makes ONE extra brain
      // query and silently no-ops on failure (renderer hides the row).
      const counterfactuals = computeCounterfactuals({
        servedModel: detail.target,
        servedCostUsd: detail.estimatedCostUsd,
        archetype: detail.archetype,
        tokensIn: detail.tokensIn,
        tokensOut: detail.tokensOut,
        cacheReadInputTokens: detail.cacheReadInputTokens,
      });
      detail.counterfactuals = counterfactuals;

      // Projected-cost: only worth the extra round-trip when we have a
      // servedCost baseline to multiply. The function itself guards on
      // servedCostUsd > 0; we mirror the guard here to skip the network
      // call entirely on free-tier / pre-cost rows.
      if (detail.estimatedCostUsd > 0) {
        const projected = await computeProjectedDailyCost({
          appId: detail.appId,
          archetype: detail.archetype,
          servedCostUsd: detail.estimatedCostUsd,
          brainEndpoint: base,
          brainJwt,
          brainAnonKey,
          fetch: doFetch,
        });
        if (projected !== undefined) {
          detail.projectedDailyCostUsd = projected;
        }
      }

      return jsonResponse(200, detail);
    }
    return jsonResponse(200, { traces: scrubbed.map(rowToSummary) });
  };
}
