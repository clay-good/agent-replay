import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every declared runtime dependency must actually be imported by `src/`.
 *
 * A `dependencies` entry is a promise to every consumer: npm downloads and
 * installs it on `npm install -g agent-replay`, and it counts toward the
 * install size and the audit surface forever. Two entries (`cli-highlight`,
 * `figures`) were imported by nothing at all — about 200 KB installed for code
 * that never ran.
 *
 * The search deliberately looks for the package NAME anywhere in an import,
 * not just a static `from '<pkg>'`: `yaml` is loaded through a dynamic
 * `await import(\'yaml\')` inside the rubric parser, and a stricter matcher
 * would have called a real dependency unused — the exact wrong answer, since
 * acting on it would break `eval --rubric`.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const sources = sourceFiles(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8'));

describe('runtime dependencies', () => {
  it.each(Object.keys(pkg.dependencies))('%s is imported by src/', (dep) => {
    const used = sources.some(
      (src) =>
        src.includes(`from '${dep}'`) ||
        src.includes(`from "${dep}"`) ||
        src.includes(`import('${dep}')`) ||
        src.includes(`require('${dep}')`) ||
        src.includes(`from '${dep}/`),
    );
    expect(used, `${dep} is in "dependencies" but nothing in src/ imports it`).toBe(true);
  });
});
