/**
 * computeProjectedDailyCost — at-volume cost extrapolation for the detail
 * view. One extra brain query per detail-view request (acceptable per the
 * design contract: detail views are interactive, not high-frequency, and the
 * query is indexed on `(app_id, intent_archetype, created_at)` via migration
 * 018).
 *
 * Mechanism:
 *   1. Query brain for COUNT of compile_outcomes over the last 7d scoped to
 *      `(appId, archetype)`.
 *   2. avgPerDay = count / 7
 *   3. If avgPerDay < INSUFFICIENT_VOLUME_THRESHOLD → undefined.
 *      Renderer hides the projection row. Honest "we don't know" over
 *      false-precision extrapolation.
 *   4. Otherwise return `avgPerDay * servedCostUsd`. Renderer formats as
 *      `"at N calls/day = $X.XX/day · $YYY/year"`.
 *
 * Network failure → undefined (never throws). The detail view degrades
 * gracefully — the projection is a sidekick to the served cost, not the
 * load-bearing display.
 */

const INSUFFICIENT_VOLUME_THRESHOLD = 5;
const WINDOW_DAYS = 7;

export interface ComputeProjectedDailyCostArgs {
  appId: string;
  archetype: string;
  servedCostUsd: number;
  /** Base URL (no trailing slash). Same shape as ProxyConfig.brainEndpoint. */
  brainEndpoint: string;
  /** Scoped JWT for Bearer header. */
  brainJwt: string;
  /** Anon/publishable key for the apikey header. */
  brainAnonKey: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export async function computeProjectedDailyCost(
  args: ComputeProjectedDailyCostArgs,
): Promise<number | undefined> {
  const {
    appId,
    archetype,
    servedCostUsd,
    brainEndpoint,
    brainJwt,
    brainAnonKey,
    fetch: fetchImpl,
  } = args;

  if (!appId || !archetype) return undefined;
  if (!Number.isFinite(servedCostUsd) || servedCostUsd <= 0) return undefined;

  const doFetch: typeof fetch =
    fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const base = brainEndpoint.replace(/\/+$/, '');

  // PostgREST exact-count query, HEAD-only. Body is empty; the count is in
  // the Content-Range response header (`0-0/<count>` or `*/<count>`).
  const cutoffIso = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const qs = new URLSearchParams();
  qs.set('app_id', `eq.${appId}`);
  qs.set('intent_archetype', `eq.${archetype}`);
  qs.set('created_at', `gte.${cutoffIso}`);
  qs.set('select', 'handle');
  qs.set('limit', '0');

  const url = `${base}/rest/v1/compile_outcomes?${qs.toString()}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${brainJwt}`,
        apikey: brainAnonKey,
        Accept: 'application/json',
        // Triggers PostgREST exact count in Content-Range header.
        Prefer: 'count=exact',
      },
    });
  } catch {
    return undefined;
  }

  if (!res.ok) return undefined;

  const contentRange = res.headers.get('content-range');
  const count = parseContentRangeCount(contentRange);
  if (count === undefined) return undefined;

  const avgPerDay = count / WINDOW_DAYS;
  if (avgPerDay < INSUFFICIENT_VOLUME_THRESHOLD) return undefined;

  const projected = avgPerDay * servedCostUsd;
  return Math.round(projected * 1_000_000) / 1_000_000;
}

/**
 * Parse a PostgREST `Content-Range: <start>-<end>/<total>` header. Returns
 * undefined when the header is missing, malformed, or carries `*` as total.
 * Tolerant — the projection silently no-ops when count can't be parsed.
 */
export function parseContentRangeCount(
  header: string | null,
): number | undefined {
  if (!header) return undefined;
  // Expected shape: `0-19/123` or `*/123` or `0-0/0`.
  const slash = header.lastIndexOf('/');
  if (slash < 0) return undefined;
  const tail = header.slice(slash + 1).trim();
  if (tail === '*' || tail === '') return undefined;
  const n = Number.parseInt(tail, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
