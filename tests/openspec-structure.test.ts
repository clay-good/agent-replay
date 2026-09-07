import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The specs are this repo's contract, and NOTHING in CI checks them.
 *
 * `openspec validate --all --strict` is the real validator, but `openspec` is a
 * globally installed tool rather than a dependency of this package — so CI
 * cannot run it without a dependency decision, and today spec drift reaches
 * main unnoticed. That has already happened once: two proposals were added with
 * no spec deltas and no `skip_specs`, which turned strict validation red until
 * someone ran it by hand (4c7052a).
 *
 * These tests pin the structural rules that break in practice, using nothing
 * but the filesystem. They are deliberately NOT a reimplementation of the
 * validator — they are the subset a change is likely to get wrong, so a
 * contributor learns about it from CI rather than from a maintainer.
 */
const ROOT = fileURLToPath(new URL('../openspec', import.meta.url));
const dirsIn = (p: string): string[] =>
  existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) : [];

describe('openspec change proposals keep the shape the validator requires', () => {
  const changes = dirsIn(join(ROOT, 'changes')).filter((n) => n !== 'archive');

  it('there is at least one, so these checks are not vacuous', () => {
    expect(changes.length).toBeGreaterThan(0);
  });

  for (const name of changes) {
    const dir = join(ROOT, 'changes', name);

    it(`${name} carries a proposal and an .openspec.yaml`, () => {
      expect(existsSync(join(dir, 'proposal.md')), `${name}/proposal.md`).toBe(true);
      expect(existsSync(join(dir, '.openspec.yaml')), `${name}/.openspec.yaml`).toBe(true);
    });

    it(`${name} declares skip_specs when it ships no deltas`, () => {
      // The break that actually happened: a proposal with no `specs/` directory
      // and no `skip_specs: true` fails `--strict`, because the validator has
      // nothing to check and will not assume that was intended.
      const yaml = readFileSync(join(dir, '.openspec.yaml'), 'utf8');
      if (!existsSync(join(dir, 'specs'))) {
        expect(yaml, `${name} has no specs/ deltas, so it must set skip_specs: true`)
          .toMatch(/^\s*skip_specs:\s*true\s*$/m);
        expect(yaml, `${name} must name its schema`).toMatch(/^\s*schema:\s*\S+/m);
      }
    });
  }
});

describe('every capability spec keeps the shape the validator requires', () => {
  const specs = dirsIn(join(ROOT, 'specs'));

  it('there is at least one, so these checks are not vacuous', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  for (const name of specs) {
    const file = join(ROOT, 'specs', name, 'spec.md');

    it(`${name} states a purpose and at least one requirement`, () => {
      expect(existsSync(file), `${name}/spec.md`).toBe(true);
      const txt = readFileSync(file, 'utf8');
      expect(txt, `${name} needs a "## Purpose"`).toMatch(/^## Purpose$/m);
      expect((txt.match(/^### Requirement:/gm) ?? []).length, `${name} requirements`).toBeGreaterThan(0);
    });

    it(`${name} gives every requirement a scenario, in WHEN/THEN form`, () => {
      // A requirement with no scenario is unverifiable prose, and strict
      // validation rejects it. The WHEN/THEN bullets are what make a scenario
      // readable as a check rather than a heading.
      const txt = readFileSync(file, 'utf8');
      const blocks = txt.split(/^### Requirement:/m).slice(1);
      for (const block of blocks) {
        const title = block.split('\n', 1)[0].trim().slice(0, 60);
        expect(block, `${name} — "${title}" has no scenario`).toContain('#### Scenario:');
      }
      for (const m of txt.matchAll(/^#### Scenario:(.*)$/gm)) {
        const body = txt.slice(m.index! + m[0].length).split(/^#{3,4} /m)[0];
        expect(body, `${name} — scenario "${m[1].trim().slice(0, 50)}" has no WHEN`).toContain('- **WHEN**');
        expect(body, `${name} — scenario "${m[1].trim().slice(0, 50)}" has no THEN`).toContain('- **THEN**');
      }
    });
  }
});
