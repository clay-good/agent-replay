import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
  types?: string;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const sources = sourceFiles(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8'));

/**
 * A `@types/*` entry is a runtime dependency for a different reason than the
 * rest: nothing in `src/` imports it, but the PUBLISHED declarations do, so it
 * has to install with the package. The type-surface test below is what holds
 * these accountable — this one would report them as dead weight.
 */
const runtimeDeps = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@types/'));

describe('runtime dependencies', () => {
  it.each(runtimeDeps)('%s is imported by src/', (dep) => {
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

/**
 * Everything the PUBLISHED declarations import must be installable, with types,
 * by a consumer who ran `npm install agent-replay` and nothing else.
 *
 * `dist/index.d.ts` opens with `import Database from 'better-sqlite3'` — the
 * store handle is the first argument of most of the public API — and
 * `@types/better-sqlite3` was a devDependency, so it did not install with the
 * package and the module had no types on the other side. With
 * `skipLibCheck: false` a consumer got TS7016 out of OUR declaration file; with
 * it on (the common default) the failure was quieter and worse: `ensureDatabase`
 * returned `any`, so every misuse of the handle compiled silently and the type
 * surface the README advertises was untyped at its centre.
 *
 * Static on purpose — reading the manifest and the emitted declarations rather
 * than compiling a fixture consumer — so it costs milliseconds and covers any
 * future leak, not only this one.
 */
describe('published type surface', () => {
  const dts = join(ROOT, 'dist', 'index.d.ts');
  const declared = existsSync(dts) ? readFileSync(dts, 'utf8') : null;

  // Bare specifiers only: relative paths are inside the bundle, and `node:`
  // builtins are typed by @types/node, which every TypeScript consumer of a
  // Node library already has.
  const imported = [
    ...new Set(
      // Anchored at an import/export statement, not any `from '...'` text: a
      // doc comment inside the declarations mentions one in prose, and a bare
      // `from '...'` matcher read that as a dependency.
      [...(declared ?? '').matchAll(/^\s*(?:import|export)\s[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/gm)]
        .map((m) => m[1])
        .filter((spec) => !spec.startsWith('node:'))
        .map((spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])),
    ),
  ];

  it('has declarations to check (build first)', () => {
    expect(declared, `built declarations not found at ${dts}; run "npm run build" first`).not.toBeNull();
    expect(imported.length).toBeGreaterThan(0);
  });

  it.each(imported)('%s installs with the package', (spec) => {
    expect(Object.keys(pkg.dependencies), `dist/index.d.ts imports "${spec}"`).toContain(spec);
  });

  it.each(imported)('%s brings its types along', (spec) => {
    // Either the package ships declarations itself, or its DefinitelyTyped
    // package is a runtime dependency too — a devDependency does not reach the
    // consumer that has to read these declarations.
    const own = JSON.parse(readFileSync(join(ROOT, 'node_modules', spec, 'package.json'), 'utf8')) as {
      types?: string;
      typings?: string;
    };
    if (own.types ?? own.typings) return;
    const typesPkg = `@types/${spec.startsWith('@') ? spec.slice(1).replace('/', '__') : spec}`;
    expect(
      Object.keys(pkg.dependencies),
      `dist/index.d.ts imports "${spec}", which ships no types of its own, so ${typesPkg} must be a runtime dependency`,
    ).toContain(typesPkg);
  });
});
