import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package version, read from the shipped `package.json`.
 *
 * Resolved once, in one place, because it was previously hardcoded as `'0.1.0'`
 * in two of them: as the CLI's fallback, and as the `version` field `init`
 * stamps into every new `config.json`. The package had been 0.2.0 for a while,
 * so `init` wrote a version that was simply wrong into every user's config —
 * harmless today only because nothing reads the field back, which is a poor
 * reason for a stored value to be false.
 *
 * Walks UP for the nearest `package.json` rather than assuming a fixed depth.
 * The first version of this assumed one level, which is right for the bundled
 * `dist/cli.js` but wrong when the module is imported from `src/` — so the
 * value silently became "unknown" under the test runner while looking correct
 * in the shipped build. A walk is right in both, and `package.json` always
 * ships (npm includes it regardless of the `files` list).
 *
 * If no `package.json` can be read the version is genuinely unknowable, so say
 * so rather than guessing a number that will go stale.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        version?: string;
      };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Not here (or unreadable) — keep walking.
    }
    if (dir === root) return 'unknown';
    dir = dirname(dir);
  }
}

export const VERSION = readVersion();
