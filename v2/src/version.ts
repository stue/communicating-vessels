/**
 * alpha.60 — the library's own version, baked as a constant so Edge/Worker
 * runtimes (no fs, no require) can report it on wire surfaces. First
 * consumer: `createKeyHealthRoute` carries it as `library_version`, which is
 * how the operator dashboard's Fleet panel sees per-consumer vendor drift
 * LIVE instead of via wrap-time package.json probes (the L-093 family
 * "declared state lags actual" fix at the vendor-version axis — s47 found
 * IC 13 alphas stale that way).
 *
 * Kept in sync with package.json by hand at each version bump; the drift
 * guard in `tests/version.test.ts` fails the suite (and therefore
 * `prepublishOnly`) when they diverge — a stale constant cannot reach npm.
 */
export const LIBRARY_VERSION = '2.0.0-alpha.134';
