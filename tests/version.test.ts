import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/utils/version.js';

/**
 * The version was hardcoded as `'0.1.0'` in two places — the CLI's fallback and
 * the `version` field `init` stamps into every new `config.json` — while the
 * package had moved on to 0.2.0. Nothing reads that field back, which is the
 * only reason it did no damage; it is still a stored value that was false.
 * These assertions fail the next time the package version moves and a literal
 * is left behind.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

describe('VERSION', () => {
  it('matches the package version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('is a real version, not a placeholder', () => {
    expect(VERSION).not.toBe('unknown');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
