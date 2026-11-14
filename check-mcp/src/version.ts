import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** One source of truth: package.json, read at runtime (dist/ sits one level
 * below it in the published tarball). A hardcoded copy went stale at 0.1.1 —
 * two declarations of one fact. */
export const CHECK_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0-unknown';
  }
})();
