import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The package advertises a Node range in `engines`, and that promise is only as
 * good as the narrowest dependency behind it. `better-sqlite3` is a NATIVE
 * module: on a Node release it has no prebuild for, `npm install -g agent-replay`
 * fails at install time with a C++ compiler error — before any test could catch
 * it. That is exactly how the declared `>=18` went stale: Node 18 fell out of
 * better-sqlite3's support range and the floor kept claiming it.
 *
 * These assertions tie the advertised range to the range the native dependency
 * actually supports, so a future bump that quietly moves the floor fails here
 * instead of in a user's install log.
 */

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

const pkg = read('../package.json');
const sqlite = read('../node_modules/better-sqlite3/package.json');

/** Lowest major mentioned anywhere in an engines range like ">=20.12" or "20.x || 22.x". */
function lowestMajor(range: string): number {
  const majors = [...range.matchAll(/(\d+)(?:\.\d+|\.x)?/g)].map((m) => Number(m[1]));
  if (majors.length === 0) throw new Error(`no version found in engines range: ${range}`);
  return Math.min(...majors);
}

describe('declared Node support', () => {
  it('names a floor at all, so npm can refuse an unsupported Node', () => {
    expect(pkg.engines?.node).toBeTypeOf('string');
  });

  it('does not promise a Node older than the native dependency supports', () => {
    expect(lowestMajor(pkg.engines.node)).toBeGreaterThanOrEqual(lowestMajor(sqlite.engines.node));
  });

  it('promises at least the floor the test runner needs (util.styleText, 20.12)', () => {
    expect(lowestMajor(pkg.engines.node)).toBeGreaterThanOrEqual(20);
  });

  it('supports the Node this suite is running on', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(
      lowestMajor(pkg.engines.node),
    );
  });
});
