/**
 * `@warmdrift/kgauto-compiler/brain-proxy` — consumer brain-forward factory.
 *
 * ## Why this exists (the 4-consumer silent-drop class, 2026-07-06 s62)
 *
 * The library's `record()` / `recordOutcome()` / `recordShadowProbe()` /
 * advisory paths all POST to a consumer-hosted proxy that forwards the row to
 * the shared Supabase brain (the consumer holds the service-role key; kgauto's
 * library never sees it). Every consumer hand-rolled that proxy layer — and a
 * 4-consumer audit found every one silently broken in a *different* shape:
 *
 *   - tt-intelligence: middleware blocked 2 of 3 routes — server-to-server
 *     POSTs 307-redirected to /login (missing public-path allowlist entry).
 *   - inspire-central: the `/outcomes` proxy carried a column whitelist frozen
 *     at alpha.7 that stripped `fell_over_from` / `fallback_reason`
 *     (migration 018 columns) — Glass-Box fallback telemetry silently NULL.
 *   - playbacksam: the `/probe_outcomes` whitelist would strip alpha.53's
 *     `error_class` — every future migration column drops on the floor.
 *   - global-expansion: mounted 1 of 4 routes — advisory POSTs 404 silently.
 *
 * Same L-142 / L-117 silent-drop family, four independent shapes, all in the
 * layer consumers hand-roll. This factory kills the *class*: kgauto owns the
 * forward handler, the consumer mounts ONE catch-all route. No column
 * whitelist — the body is forwarded verbatim (`{ ...body }`), so any future
 * migration column passes through untouched. One middleware/public-path entry
 * (`/api/kgauto/v2/`) covers all four segments, which structurally prevents
 * the tt-intel middleware-drift failure.
 *
 * ## Mounting recipes
 *
 * ### (a) Next.js app-router catch-all — ONE file, ONE middleware entry
 *
 *   // app/api/kgauto/v2/[segment]/route.ts
 *   import { createBrainForwardRoutes } from '@warmdrift/kgauto-compiler/brain-proxy';
 *   const routes = createBrainForwardRoutes({
 *     ingestSecret: process.env.KGAUTO_INGEST_SECRET!,
 *     brainUrl:     process.env.KGAUTO_BRAIN_URL!,      // https://xxxx.supabase.co
 *     serviceKey:   process.env.KGAUTO_BRAIN_SERVICE_KEY!,
 *   });
 *   export const POST = (req: Request, { params }: { params: { segment: string } }) =>
 *     routes.handle(req, params.segment);
 *
 *   // middleware.ts — ONE public-path entry covers ALL four segments.
 *   // This is the structural fix for the tt-intel drift: you cannot mount
 *   // 3-of-4 routes and forget the 4th, because the catch-all is one file
 *   // and the allowlist is one prefix.
 *   const PUBLIC_PATHS = [ ...  '/api/kgauto/v2/' ];
 *
 * ### (b) Plain Vercel edge function, per segment
 *
 *   // api/kgauto/probe_outcomes.ts
 *   export const config = { runtime: 'edge' };
 *   const routes = createBrainForwardRoutes({ ...  });
 *   export default (req: Request) => routes.handle(req, 'probe_outcomes');
 *
 * The library appends the segment path to the consumer's `endpoint`, so the
 * consumer's `KGAUTO_V2_BRAIN_URL` (the value passed to `configureBrain`)
 * must be the base that resolves to `.../api/kgauto/v2` — i.e. the last path
 * segment of each library POST (`outcomes`, `probe_outcomes`, …) is what
 * `handle()` receives as `segment`.
 *
 * ## Prefer-header relay (alpha.56)
 *
 * `record()` sends `Prefer: return=representation` on its `/outcomes` POST and
 * parses the inserted row id from the PROXY's response to fire the secondary
 * `compile_outcome_advisories` POST. alpha.54/.55 hardcoded
 * `Prefer: return=minimal` toward the brain and returned `{ok:true}` — so the
 * id-parse found nothing and the advisory secondary silently never fired for
 * factory-mounted consumers (PB + GE convergent finding, 2026-07-06). The
 * factory now honors a caller `Prefer: return=representation` header: it is
 * forwarded to the brain and the brain's response body (the inserted row(s))
 * is relayed verbatim on success. Callers that don't send the header keep the
 * `return=minimal` + `{ok:true}` behavior.
 *
 * ## Quality-segment handle resolution (alpha.55)
 *
 * `recordOutcome()` sends `outcome_id` as `CompileResult.handle` (a string),
 * but `compile_outcome_quality.outcome_id` is a BIGINT FK →
 * `compile_outcomes(id)`. A verbatim forward would 400 every handle-shaped
 * verdict (tt-intel + IC convergent finding, 2026-07-06). On the
 * `compile_outcome_quality` segment the factory resolves non-numeric
 * `outcome_id` values to their BIGINT row ids via
 * `compile_outcomes?handle=eq.<v>` (latest row wins) before forwarding.
 * Numeric ids pass through untouched; an unresolvable handle returns
 * `404 handle_not_found` so the library's route-404 observability names the
 * failure instead of the brain's opaque FK error.
 */

/** The write-path segments the library POSTs to (see brain.ts). */
const SEGMENT_TO_TABLE: Readonly<Record<string, string>> = {
  outcomes: 'compile_outcomes',
  compile_outcome_advisories: 'compile_outcome_advisories',
  compile_outcome_quality: 'compile_outcome_quality',
  probe_outcomes: 'probe_outcomes',
  // alpha.62 (eval spine): golden-set capture. Only receives rows when the
  // consumer has explicitly opted in via KGAUTO_GOLDEN_CAPTURE — the segment
  // existing here does not by itself store anything.
  golden_irs: 'kgauto_golden_irs',
};

const KNOWN_SEGMENTS: readonly string[] = Object.keys(SEGMENT_TO_TABLE);

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface BrainForwardConfig {
  /** Bearer token consumers' callers must present (usually KGAUTO_INGEST_SECRET). */
  ingestSecret: string;
  /** Brain Supabase project URL (e.g. https://xxxx.supabase.co). */
  brainUrl: string;
  /** Brain service-role key (server-side only). */
  serviceKey: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export interface BrainForwardRoutes {
  /**
   * Web-standard handler. `segment` is the last path segment of the library's
   * POST URL (e.g. 'outcomes', 'probe_outcomes'). In a Next.js catch-all this
   * is `params.segment`. Never throws — every error path returns a `Response`.
   */
  handle(req: Request, segment: string): Promise<Response>;
  /**
   * The path segments this factory serves. Consumers can use it for route
   * generation, allowlist construction, or tests.
   */
  segments: readonly string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Extract the Bearer token from an Authorization header. Returns '' when
 * absent or malformed. Simple equality (not constant-time) matches the
 * existing consumer proxies this replaces — the ingest secret is a
 * server-to-server shared secret, not a login credential.
 */
function bearerOf(req: Request): string {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? '';
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createBrainForwardRoutes: ${name} is required`);
  }
  return value;
}

/** A value PostgREST can insert into a BIGINT column without resolution. */
function isNumericOutcomeId(value: unknown): boolean {
  return (
    typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
  );
}

export function createBrainForwardRoutes(
  config: BrainForwardConfig,
): BrainForwardRoutes {
  const ingestSecret = requireString('ingestSecret', config.ingestSecret);
  const brainUrl = requireString('brainUrl', config.brainUrl).replace(/\/+$/, '');
  const serviceKey = requireString('serviceKey', config.serviceKey);
  const fetchFn = config.fetchImpl ?? fetch;

  /**
   * Resolve handle-shaped (non-numeric) `outcome_id` values in a
   * compile_outcome_quality body to BIGINT `compile_outcomes.id` values.
   * Returns the rewritten body (same single-object/array shape), or a
   * `Response` on failure:
   *   - 404 `handle_not_found` — no compile_outcomes row carries the handle
   *   - 502 `handle-resolution-failed` — the lookup itself failed
   * Rows whose `outcome_id` is already numeric (or absent/malformed) are
   * forwarded untouched — the brain's own error names those cases.
   */
  async function resolveQualityOutcomeIds(body: unknown): Promise<unknown | Response> {
    const rows = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
    const handles = [
      ...new Set(
        rows
          .map((r) => r?.outcome_id)
          .filter(
            (v): v is string => typeof v === 'string' && !isNumericOutcomeId(v),
          ),
      ),
    ];
    if (handles.length === 0) return body;

    // PostgREST in.() with double-quoted values; handles are library-generated
    // (`c<ts36>-<n>-<rand>`) so quotes never appear, but strip defensively.
    const list = handles.map((h) => `"${h.replace(/"/g, '')}"`).join(',');
    const url =
      `${brainUrl}/rest/v1/compile_outcomes` +
      `?select=id,handle&handle=in.(${encodeURIComponent(list)})&order=id.desc`;

    let idByHandle: Map<string, number>;
    try {
      const res = await fetchFn(url, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        return jsonResponse(502, {
          error: 'handle-resolution-failed',
          table: 'compile_outcome_quality',
          status: res.status,
          detail: text,
        });
      }
      const found = (await res.json()) as Array<{ id: number; handle: string }>;
      idByHandle = new Map();
      // id.desc ordering → first occurrence per handle is the latest row.
      for (const r of found) {
        if (!idByHandle.has(r.handle)) idByHandle.set(r.handle, r.id);
      }
    } catch (err) {
      return jsonResponse(502, {
        error: 'handle-resolution-failed',
        table: 'compile_outcome_quality',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const unresolved = handles.filter((h) => !idByHandle.has(h));
    if (unresolved.length > 0) {
      return jsonResponse(404, {
        error: 'handle_not_found',
        table: 'compile_outcome_quality',
        unresolved,
      });
    }

    const rewritten = rows.map((r) =>
      typeof r?.outcome_id === 'string' && idByHandle.has(r.outcome_id)
        ? { ...r, outcome_id: idByHandle.get(r.outcome_id) }
        : r,
    );
    return Array.isArray(body) ? rewritten : rewritten[0];
  }

  async function handle(req: Request, segment: string): Promise<Response> {
    try {
      // 1) Method gate — only POST forwards a write.
      if (req.method !== 'POST') {
        return jsonResponse(405, {
          error: 'method-not-allowed',
          method: req.method,
          allowed: ['POST'],
        });
      }

      // 2) Segment gate — unknown segment names the knowns so the library's
      // route-404 observability (alpha.53 describeBrainWriteFailure) renders
      // usefully instead of a bare 404.
      const table = SEGMENT_TO_TABLE[segment];
      if (!table) {
        return jsonResponse(404, {
          error: 'unknown-brain-forward-segment',
          segment,
          known: KNOWN_SEGMENTS,
        });
      }

      // 3) Auth gate — Bearer must match the ingest secret.
      if (bearerOf(req) !== ingestSecret) {
        return jsonResponse(401, { error: 'unauthorized' });
      }

      // 4) Body parse.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: 'invalid-json' });
      }

      // 5) Forward VERBATIM. Single object → spread; array → pass as-is.
      // NO column whitelist, NO field stripping — that's the whole point:
      // future migration columns pass through untouched. Supabase REST
      // accepts both a single object and an array of rows.
      let row: unknown = Array.isArray(body)
        ? body
        : { ...(body as Record<string, unknown>) };

      // 5b) Quality segment ONLY: resolve handle-shaped outcome_id values to
      // their BIGINT compile_outcomes row ids (see docstring). This is the one
      // deliberate exception to verbatim forwarding — the field is rewritten,
      // never stripped, and only when non-numeric.
      if (table === 'compile_outcome_quality') {
        const outcome = await resolveQualityOutcomeIds(row);
        if (outcome instanceof Response) return outcome;
        row = outcome;
      }

      // 5c) Prefer relay (alpha.56): record() asks for the inserted row back
      // (return=representation) and parses its id to FK-link the secondary
      // advisories POST. Honor that ask; default stays return=minimal.
      const wantsRepresentation = /return=representation/i.test(
        req.headers.get('Prefer') ?? '',
      );

      let brainRes: Response;
      try {
        brainRes = await fetchFn(`${brainUrl}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Prefer: wantsRepresentation ? 'return=representation' : 'return=minimal',
          },
          body: JSON.stringify(row),
        });
      } catch (err) {
        // Network / fetch-level failure reaching the brain.
        return jsonResponse(502, {
          error: 'brain-unreachable',
          table,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // 6) Success. With return=representation, relay the brain's body (the
      // inserted row(s)) VERBATIM so the caller can read the row id; with
      // return=minimal (201/204, empty body), answer {ok:true}.
      if (brainRes.ok) {
        if (wantsRepresentation) {
          const text = await brainRes.text().catch(() => '');
          if (text.length > 0) {
            return new Response(text, { status: 201, headers: JSON_HEADERS });
          }
        }
        return jsonResponse(201, { ok: true });
      }

      // 7) Failure — surface the brain's status + text verbatim so the
      // consumer can diagnose (RLS reject, missing column, malformed row).
      const text = await brainRes.text().catch(() => '<no body>');
      return jsonResponse(brainRes.status, {
        error: 'brain-write-failed',
        table,
        status: brainRes.status,
        detail: text,
      });
    } catch (err) {
      // Never throw — all error paths return a Response.
      return jsonResponse(500, {
        error: 'brain-forward-internal-error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { handle, segments: KNOWN_SEGMENTS };
}
