/**
 * Shared auth gate for Glass-Box consumer routes.
 *
 * Both `proxy` and `stream` enforce the same two-factor check:
 *
 *   1. Bearer token — constant-time compare against `installToken`.
 *      The install token is the curl-from-anywhere defense; only the
 *      Chrome extension (which embeds the token at install time) and the
 *      consumer route handler know it.
 *   2. Origin — exact match against `chrome-extension://<extensionId>`.
 *      Defense-in-depth against confused-deputy CSRF from a logged-in
 *      browser tab. The Bearer token is the primary gate; Origin is the
 *      belt-and-suspenders.
 *
 * Returns either a non-200 `Response` (caller forwards it) or `null`
 * (caller proceeds).
 */

export interface AuthConfig {
  installToken: string;
  extensionId: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * Constant-time string compare. Returns false if lengths differ (length
 * itself is not a secret — install tokens have a fixed, public-knowledge
 * length). Pure-JS XOR-accumulator loop so this runs on every JS runtime
 * (Vercel Edge, Cloudflare Workers, Node, Deno) without polyfilling
 * `node:crypto`. Same pattern next-auth, hono, etc. use.
 */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Run both auth checks. Returns a Response on failure, or null on success.
 *
 * Origin gate accepts either:
 *   - `Origin: chrome-extension://<extensionId>` (default browser-set value)
 *   - `X-Glassbox-Extension-Id: <extensionId>` (extension-set fallback)
 *
 * Chrome MV3 fetches to URLs declared in `host_permissions` wildcards may
 * omit the Origin header, AND `Origin` is a JS-forbidden header (extension
 * code can't set it manually), so the X-Glassbox-Extension-Id fallback is
 * load-bearing — without it, real extension calls always 403 even when
 * the extensionId matches. Either gate is sufficient; both verify the
 * caller knows the extension's randomly-generated install ID.
 */
export function checkAuth(req: Request, config: AuthConfig): Response | null {
  // 1) Bearer token.
  const authHeader = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const provided = match?.[1]?.trim() ?? '';
  if (!provided || !tokensEqual(provided, config.installToken)) {
    return jsonError(401, 'unauthorized');
  }

  // 2) Origin OR X-Glassbox-Extension-Id check (defense in depth).
  const origin = req.headers.get('Origin') ?? '';
  const xExtId = req.headers.get('X-Glassbox-Extension-Id') ?? '';
  const expectedOrigin = `chrome-extension://${config.extensionId}`;
  const originOk = origin === expectedOrigin;
  const xExtOk =
    xExtId.length > 0 && tokensEqual(xExtId, config.extensionId);
  if (!originOk && !xExtOk) {
    return jsonError(403, 'forbidden_origin');
  }

  return null;
}
