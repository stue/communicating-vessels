/**
 * `@warmdrift/kgauto-compiler/key-health` — per-consumer provider-key health
 * endpoint factory (alpha.58, KG-fleet-v1 phase 1).
 *
 * ## Why this exists
 *
 * Consumers (playbacksam, inspire-central, tt-intelligence, global-expansion)
 * hold their own provider API keys in their own Vercel envs — the library
 * never sees keys centrally, by design. That means the operator dashboard has
 * no way to answer "is PB's DeepSeek key still valid?" without a per-consumer
 * probe surface. This factory is that surface: the consumer mounts ONE route,
 * the dashboard polls it with the consumer's existing `KGAUTO_INGEST_SECRET`
 * bearer, and gets back a validity grid for every canonical provider key.
 *
 * Probes are the cheapest authenticated GETs each provider offers (model
 * listings; DeepSeek's balance endpoint) — never a completion call, zero
 * token cost. Keys themselves NEVER appear in any response: only presence,
 * validity, HTTP status, latency, and (DeepSeek only) account balance.
 *
 * Same design contract as `createBrainForwardRoutes` (brain-proxy.ts):
 * web-standard Request→Response, never throws (every path returns a
 * `Response`), bearer gate, runs on Edge/Workers/Node.
 *
 * ## Mounting recipes
 *
 * ### (a) Next.js app-router route handler — ONE file
 *
 *   // app/api/kgauto/v2/keyhealth/route.ts
 *   import { createKeyHealthRoute } from '@warmdrift/kgauto-compiler/key-health';
 *   const routes = createKeyHealthRoute({
 *     appId: 'playbacksam',
 *     ingestSecret: process.env.KGAUTO_INGEST_SECRET!,
 *   });
 *   export const GET = (req: Request) => routes.handle(req);
 *
 *   // middleware.ts — if the app gates routes behind auth middleware, the
 *   // existing brain-proxy public-path prefix ('/api/kgauto/v2/') already
 *   // covers this route. If the allowlist is per-path, add
 *   // '/api/kgauto/v2/keyhealth' or server-to-server GETs 307 to /login
 *   // (the tt-intel middleware-drift shape — see brain-proxy.ts).
 *
 * ### (b) Plain per-file Vercel function
 *
 *   // api/kgauto/keyhealth.ts
 *   export const config = { runtime: 'edge' };
 *   import { createKeyHealthRoute } from '@warmdrift/kgauto-compiler/key-health';
 *   const routes = createKeyHealthRoute({
 *     appId: 'inspire-central',
 *     ingestSecret: process.env.KGAUTO_INGEST_SECRET!,
 *   });
 *   export default (req: Request) => routes.handle(req);
 *
 * ## Wire shape (LOCKED CONTRACT with the operator dashboard — do not rename)
 *
 *   200 {
 *     app_id: string,
 *     checked_at: string,          // ISO timestamp
 *     library_version: string,     // installed @warmdrift/kgauto-compiler
 *                                  // version (alpha.60+) — the dashboard's
 *                                  // live vendor-drift signal; absent on
 *                                  // pre-alpha.60 mounts, render "—"
 *     keys: [                      // sorted by provider name
 *       {
 *         provider: 'anthropic' | 'deepseek' | 'google' | 'openai',
 *         env: string,             // canonical env var name probed
 *         present: boolean,        // key present (non-empty after trim)
 *         valid: boolean | null,   // true 2xx / false 401·403 / null unknown
 *         status?: number,         // probe HTTP status when a response landed
 *         latency_ms?: number,     // probe round-trip
 *         balance_usd?: number,    // DeepSeek only, when currency is USD
 *         detail?: string,         // e.g. 'timeout', 'http_500', 'key_absent'
 *       }
 *     ]
 *   }
 */

import { LIBRARY_VERSION } from './version.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export type KeyHealthProvider = 'anthropic' | 'deepseek' | 'google' | 'moonshot' | 'openai';

export interface KeyHealthConfig {
  /** Consumer app id echoed as `app_id` in the response (e.g. 'playbacksam'). */
  appId: string;
  /** Bearer token the poller must present (consumer's existing KGAUTO_INGEST_SECRET). */
  ingestSecret: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
  /** Env source; defaults to process.env. Test injection point. */
  env?: Record<string, string | undefined>;
  /** Per-provider probe timeout in ms. Default 3000. */
  timeoutMs?: number;
}

/**
 * alpha.81 — a NON-REVERSIBLE identity for a provider key, so the fleet can
 * answer "are two consumers on the same key?" without any consumer, or the
 * brain, ever holding a key value.
 *
 * Origin: PB's `one-shared-provider-key-across-four-consumers` (s83). All four
 * provider keys are Vercel team-level Shared Env Vars across four projects, so
 * one exhausted account is a four-consumer outage that each consumer diagnoses
 * locally as its own, and provider spend is a single undifferentiated number.
 * PB's observation that only kgauto can see this is correct: the library runs
 * inside every consumer's process and resolves the key there; no consumer can
 * compare its key against a peer's.
 *
 * **Why truncation is the safety property, not an optimization.** The digest is
 * cut to 12 hex chars (48 bits) — enough that a collision between the handful
 * of keys in one portfolio is negligible, far too little to verify a guessed
 * key against. Provider keys are high-entropy random strings, so even the full
 * digest would not be brute-forceable; the truncation means the stored value is
 * not a verification oracle even if the key space were later reduced. The
 * domain-separation prefix keeps these digests useless against any hash
 * computed for another purpose.
 *
 * Never log, return, or persist the key itself. This function is the only
 * sanctioned way a key becomes a value that may leave the process.
 */
export const KEY_FINGERPRINT_DOMAIN = 'kgauto-key-fingerprint-v1:';
export const KEY_FINGERPRINT_LENGTH = 12;

/**
 * Pure-JS SHA-256 (FIPS 180-4), synchronous. Exists because the fingerprint must be
 * computable INSIDE call()'s critical path without a real-time async hop: WebCrypto's
 * `subtle.digest` runs on a thread pool, and on a loaded runner the await outlived the
 * fake-timer budgets the call tests measure to the turn (alpha.111's first OIDC publish
 * failed its own gate on exactly this). ~40 lines, no dependencies, Edge-safe. Checked
 * against WebCrypto on every build by tests/kg18-key-fingerprint-fallback-class.test.ts.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0; h[1] = (h[1]! + b!) >>> 0; h[2] = (h[2]! + c!) >>> 0; h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0; h[5] = (h[5]! + f!) >>> 0; h[6] = (h[6]! + g!) >>> 0; h[7] = (h[7]! + hh!) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Synchronous fingerprint — same domain, same digest, same 12 hex chars as `keyFingerprint`. */
export function keyFingerprintSync(key: string): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  return sha256HexSync(KEY_FINGERPRINT_DOMAIN + trimmed).slice(0, KEY_FINGERPRINT_LENGTH);
}

export async function keyFingerprint(key: string): Promise<string | undefined> {
  // alpha.111 — computed synchronously (see sha256HexSync); the async signature is kept for
  // every existing caller. Equality with WebCrypto is asserted by a test on every build.
  return keyFingerprintSync(key);
}

export interface KeyHealthResult {
  provider: KeyHealthProvider;
  /** Canonical env var name probed (the resolved one for Google). */
  env: string;
  /** Key present (non-empty after trim) in env. */
  present: boolean;
  /** true = provider accepted the key (2xx); false = rejected (401/403); null = unknown (absent / timeout / 5xx / 429 / network). */
  valid: boolean | null;
  /** HTTP status of the probe, when a response landed. */
  status?: number;
  /** Probe round-trip in ms, when a probe ran. */
  latency_ms?: number;
  /** DeepSeek only: account balance in USD when the balance API reports USD. */
  balance_usd?: number;
  /** Failure class when valid is null with a probe attempted (e.g. 'timeout', 'http_500') or 'key_absent'. */
  detail?: string;
  /**
   * alpha.81 — truncated, domain-separated SHA-256 of the resolved key. NEVER
   * the key. Identical values across two consumers mean they resolve the same
   * credential; that is the only question it can answer. Absent when the key is
   * absent or the runtime exposes no WebCrypto. See {@link keyFingerprint}.
   */
  key_fingerprint?: string;
}

export interface KeyHealthResponseBody {
  app_id: string;
  checked_at: string;
  /**
   * alpha.60 — installed library version (`LIBRARY_VERSION`). Lets the
   * operator dashboard render per-consumer vendor drift from the same poll
   * it already makes; absent on pre-alpha.60 mounts.
   */
  library_version: string;
  keys: KeyHealthResult[];
}

export interface KeyHealthRoute {
  /**
   * Web-standard handler. GET only. Never throws — every error path returns
   * a `Response`.
   */
  handle(req: Request): Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Extract the Bearer token; '' when absent/malformed (same as brain-proxy). */
function bearerOf(req: Request): string {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? '';
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createKeyHealthRoute: ${name} is required`);
  }
  return value;
}

/** Non-empty-after-trim env read; undefined otherwise. */
function envKey(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface ProbeSpec {
  provider: KeyHealthProvider;
  /** The env var the key was found under (resolved: GEMINI_API_KEY wins over GOOGLE_API_KEY). */
  envName: string;
  /** The env var reported when the key is ABSENT (canonical name). */
  canonicalEnvName: string;
  buildRequest(key: string): { url: string; headers: Record<string, string> };
  /** DeepSeek only: extract balance_usd from a 2xx response body. */
  parseBalanceUsd?: (body: unknown) => number | undefined;
}

/**
 * Cheapest authenticated GET per provider. Endpoints verified against
 * provider docs (step-zero rule, L-081):
 *   - Anthropic: GET /v1/models (x-api-key + anthropic-version)
 *   - Google:    GET /v1beta/models?key=... (key as query param)
 *   - OpenAI:    GET /v1/models (Bearer)
 *   - DeepSeek:  GET /user/balance (Bearer) — also yields account balance
 *   - Moonshot:  GET /v1/models (Bearer) — platform.kimi.ai API overview
 *
 * Z.ai (alpha.65) is deliberately ABSENT: docs.z.ai documents no cheap
 * authenticated GET (no models list, no balance endpoint) — only the paid
 * POST chat-completions route. Probing with a paid call violates the
 * cheapest-authenticated-GET contract; ZAI_API_KEY health stays a
 * Fleet-panel gap until Z.ai documents a read-only endpoint.
 */
const PROBE_SPECS: readonly Omit<ProbeSpec, 'envName'>[] = [
  {
    provider: 'anthropic',
    canonicalEnvName: 'ANTHROPIC_API_KEY',
    buildRequest: (key) => ({
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }),
  },
  {
    provider: 'deepseek',
    canonicalEnvName: 'DEEPSEEK_API_KEY',
    buildRequest: (key) => ({
      url: 'https://api.deepseek.com/user/balance',
      headers: { Authorization: `Bearer ${key}` },
    }),
    parseBalanceUsd: (body) => {
      // { balance_infos: [{ currency: 'USD'|'CNY', total_balance: '12.34', ... }] }
      const infos = (body as { balance_infos?: unknown })?.balance_infos;
      if (!Array.isArray(infos) || infos.length === 0) return undefined;
      const first = infos[0] as { currency?: unknown; total_balance?: unknown };
      if (first?.currency !== 'USD') return undefined;
      const n = Number(first.total_balance);
      return Number.isFinite(n) ? n : undefined;
    },
  },
  {
    provider: 'moonshot',
    canonicalEnvName: 'MOONSHOT_API_KEY',
    buildRequest: (key) => ({
      url: 'https://api.moonshot.ai/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    }),
  },
  {
    provider: 'google',
    canonicalEnvName: 'GEMINI_API_KEY',
    buildRequest: (key) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`,
      headers: {},
    }),
  },
  {
    provider: 'openai',
    canonicalEnvName: 'OPENAI_API_KEY',
    buildRequest: (key) => ({
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    }),
  },
];

/**
 * Create the per-consumer key-health route. See module docstring for the
 * mounting recipes ((a) Next.js route handler, (b) per-file Vercel function)
 * and the locked wire shape.
 */
export function createKeyHealthRoute(config: KeyHealthConfig): KeyHealthRoute {
  const appId = requireString('appId', config.appId);
  const ingestSecret = requireString('ingestSecret', config.ingestSecret);
  const fetchFn = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 3000;

  async function probeProvider(
    spec: Omit<ProbeSpec, 'envName'>,
    env: Record<string, string | undefined>,
  ): Promise<KeyHealthResult> {
    // Resolve the key. Google accepts GEMINI_API_KEY or GOOGLE_API_KEY
    // (GEMINI wins); report the env var actually used, or the canonical
    // name when absent.
    let key: string | undefined;
    let envName = spec.canonicalEnvName;
    if (spec.provider === 'google') {
      // Resolution order covers all conventions live in the portfolio:
      // GEMINI_API_KEY (plain-fetch consumers) > GOOGLE_API_KEY >
      // GOOGLE_GENERATIVE_AI_API_KEY (Vercel AI-SDK default — tt-intel's
      // actual prod name; found at alpha.58 smoke, would have reported
      // present:false forever).
      const gemini = envKey(env, 'GEMINI_API_KEY');
      const google = envKey(env, 'GOOGLE_API_KEY');
      const aiSdk = envKey(env, 'GOOGLE_GENERATIVE_AI_API_KEY');
      key = gemini ?? google ?? aiSdk;
      envName = gemini
        ? 'GEMINI_API_KEY'
        : google
          ? 'GOOGLE_API_KEY'
          : aiSdk
            ? 'GOOGLE_GENERATIVE_AI_API_KEY'
            : 'GEMINI_API_KEY';
    } else if (spec.provider === 'moonshot') {
      // alpha.65 — same multi-name pattern as Google: MOONSHOT_API_KEY
      // (canonical, api.moonshot.ai) wins over KIMI_API_KEY (the
      // platform.kimi.ai rebrand surface). Matches env.ts PROVIDER_ENV_KEYS.
      const moonshot = envKey(env, 'MOONSHOT_API_KEY');
      const kimi = envKey(env, 'KIMI_API_KEY');
      key = moonshot ?? kimi;
      envName = moonshot ? 'MOONSHOT_API_KEY' : kimi ? 'KIMI_API_KEY' : 'MOONSHOT_API_KEY';
    } else {
      key = envKey(env, spec.canonicalEnvName);
    }

    if (!key) {
      return {
        provider: spec.provider,
        env: envName,
        present: false,
        valid: null,
        detail: 'key_absent',
      };
    }

    const fingerprint = await keyFingerprint(key);
    const base: KeyHealthResult = {
      provider: spec.provider,
      env: envName,
      present: true,
      valid: null,
      ...(fingerprint ? { key_fingerprint: fingerprint } : {}),
    };

    const { url, headers } = spec.buildRequest(key);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        ...base,
        latency_ms: Date.now() - started,
        // NEVER echo err.message — provider errors could theoretically carry
        // request context; a fixed vocabulary keeps key material impossible.
        detail: isTimeout ? 'timeout' : 'network_error',
      };
    }
    const latencyMs = Date.now() - started;

    // 2xx → valid. 401/403 → invalid (provider rejected the key).
    // Everything else (5xx, 429, weird 4xx) → unknown: says nothing
    // definitive about the KEY, only about the provider/moment.
    if (res.ok) {
      const result: KeyHealthResult = {
        ...base,
        valid: true,
        status: res.status,
        latency_ms: latencyMs,
      };
      if (spec.parseBalanceUsd) {
        try {
          const body = (await res.json()) as unknown;
          const balance = spec.parseBalanceUsd(body);
          if (balance !== undefined) result.balance_usd = balance;
        } catch {
          /* unparseable balance body — key is still valid; omit balance_usd */
        }
      }
      return result;
    }
    if (res.status === 401 || res.status === 403) {
      return { ...base, valid: false, status: res.status, latency_ms: latencyMs };
    }
    return {
      ...base,
      valid: null,
      status: res.status,
      latency_ms: latencyMs,
      detail: `http_${res.status}`,
    };
  }

  async function handle(req: Request): Promise<Response> {
    try {
      // 1) Method gate — this is a read-only surface.
      if (req.method !== 'GET') {
        return jsonResponse(405, { error: 'method_not_allowed' });
      }

      // 2) Auth gate — Bearer must match the ingest secret.
      if (bearerOf(req) !== ingestSecret) {
        return jsonResponse(401, { error: 'unauthorized' });
      }

      // Env is read per-request (not captured at factory time) so a
      // redeployed/rotated env re-probes correctly on long-lived servers.
      const env = config.env ?? (process.env as Record<string, string | undefined>);

      // 3) All probes in parallel, each independently timeout-bounded.
      // probeProvider never rejects, but belt-and-suspenders: allSettled so
      // one pathological probe can never take down the whole grid.
      const settled = await Promise.allSettled(
        PROBE_SPECS.map((spec) => probeProvider(spec, env)),
      );
      const keys: KeyHealthResult[] = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        const spec = PROBE_SPECS[i]!;
        return {
          provider: spec.provider,
          env: spec.canonicalEnvName,
          present: true,
          valid: null,
          detail: 'probe_failed',
        };
      });
      keys.sort((a, b) => a.provider.localeCompare(b.provider));

      const body: KeyHealthResponseBody = {
        app_id: appId,
        checked_at: new Date().toISOString(),
        library_version: LIBRARY_VERSION,
        keys,
      };
      return jsonResponse(200, body);
    } catch (err) {
      // Never throw — all error paths return a Response. Message is safe:
      // internal errors here never carry key material (keys only flow into
      // probe headers/URLs, and probeProvider catches its own failures).
      // Fixed vocabulary here too — even though keys shouldn't be able to
      // reach this path, never echo runtime error text from a surface whose
      // whole job is key handling. err intentionally unused beyond the catch.
      void err;
      return jsonResponse(500, { error: 'key_health_internal_error' });
    }
  }

  return { handle };
}
