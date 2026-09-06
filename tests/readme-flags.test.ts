import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The README and `cli.ts` agree about which flags exist, in both directions.
 *
 * This audit has been run by hand once a session — it has caught undocumented
 * flags before, and the repo's recurring failure mode is the other direction: a
 * limitation or a flag is documented, the code moves on, and the sentence stays
 * behind with nothing to fail. A hand-run audit only catches what someone
 * remembers to look for; this catches it on the commit that causes it.
 *
 * Both directions are green as written, so this is a net over correct
 * behaviour, not a fix. It was checked for vacuity by mutation: adding a
 * `.option('--not-real ...')` to `cli.ts` fails the first test, and writing
 * `agent-replay list --not-real` into a README example fails the second.
 */

const ROOT = new URL('..', import.meta.url);
const cli = readFileSync(fileURLToPath(new URL('src/cli.ts', ROOT)), 'utf8');
const readme = readFileSync(fileURLToPath(new URL('README.md', ROOT)), 'utf8');

/** Every long flag `cli.ts` declares, from `.option(...)` and `.requiredOption(...)`. */
function declaredFlags(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/\.(?:required)?[Oo]ption\(\s*'([^']+)'/g)) {
    // A flag spec is like `-l, --limit <n>` or `--no-input`: take the long forms.
    for (const part of m[1].split(',')) {
      const name = part.trim().split(' ')[0];
      if (name.startsWith('--')) found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * Every long flag the README writes on an `agent-replay` invocation.
 *
 * Scoped to the invocation, not the line: the README also shows OTHER programs'
 * flags piping into this one (`my-agent --emit-events | agent-replay record`,
 * `claude -p --output-format stream-json | agent-replay record`). Those are
 * someone else's flags and must not be held against `cli.ts` — splitting on the
 * pipe keeps them out without an allowlist that would need maintaining.
 */
function flagsOnInvocations(md: string): string[] {
  const found = new Set<string>();
  for (const fence of md.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of fence[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue; // a comment, not a command
      for (const segment of trimmed.split('|')) {
        if (!segment.includes('agent-replay')) continue;
        for (const m of segment.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)) found.add(m[1]);
      }
    }
  }
  return [...found].sort();
}

const declared = declaredFlags(cli);
const shown = flagsOnInvocations(readme);

describe('README and cli.ts agree about the flags', () => {
  it('declares flags at all (guards the two assertions below)', () => {
    // A regex that silently stopped matching would make both tests vacuous.
    expect(declared.length).toBeGreaterThan(40);
    expect(shown.length).toBeGreaterThan(30);
  });

  it.each(declared)('%s is documented in the README', (flag) => {
    // Anywhere in the README, not only in an example: several flags are covered
    // in prose or in a settings block rather than a command line.
    expect(readme.includes(flag), `${flag} is declared in cli.ts but appears nowhere in README.md`).toBe(true);
  });

  it.each(shown)('%s, shown in a README example, is a real flag', (flag) => {
    expect(declared, `README shows "agent-replay ... ${flag}", which cli.ts does not declare`).toContain(flag);
  });
});

describe('a command description does not promise opt-in content', () => {
  // The one-line description is the first thing `--help` prints, and two of
  // them named data the command does not produce by default: `show` promised
  // "steps, evals, and snapshots" (state snapshots need `--snapshots`) and
  // `export` promised "traces and evaluation results" (evals need
  // `--with-evals`). Same rule the rest of the CLI follows: never claim what
  // was not done.
  const descriptionOf = (command: string): string => {
    // The `.description('...')` that follows this command's `.command('...')`.
    const at = cli.indexOf(`.command('${command}`);
    expect(at).toBeGreaterThan(-1);
    const m = cli.slice(at).match(/\.description\('([^']+)'\)/);
    return m ? m[1] : '';
  };

  it.each([
    ['show', 'snapshot', '--snapshots'],
    ['export', 'eval', '--with-evals'],
  ])('%s names the flag when its description mentions %s', (command, noun, flag) => {
    const description = descriptionOf(command);
    if (new RegExp(noun, 'i').test(description)) {
      expect(description).toContain(flag);
    }
  });
});
