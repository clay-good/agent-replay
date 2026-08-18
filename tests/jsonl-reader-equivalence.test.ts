/**
 * The reader, compared against the exact expression it replaced.
 *
 * `readFileSync(path,'utf-8').split('\n').map(trim).filter(Boolean)` is the
 * behavior every caller was written against, so equivalence is the contract —
 * not a hand-written list of what the author happened to think of. Each case is
 * run at ten chunk sizes (1, 2, 3, 4, 5, 7, 8, 16, 64, 1024) so every boundary
 * lands somewhere different: mid-character, flush on a newline, mid-CRLF, and
 * inside a line longer than the chunk. A wrong byte offset in a streaming reader
 * corrupts imported data silently, which is why this is exhaustive rather than
 * illustrative.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlLines } from '../src/services/importers/jsonl-reader.js';

const dir = mkdtempSync(join(tmpdir(), 'ar-fuzz-'));
function ref(content: Buffer): string[] {
  return content.toString('utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
}
function check(label: string, content: Buffer | string, chunks: number[]): string[] {
  const p = join(dir, 'f');
  writeFileSync(p, content);
  const buf = readFileSync(p);
  const expected = ref(buf);
  const bad: string[] = [];
  for (const c of chunks) {
    const got = [...readJsonlLines(p, c)];
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      bad.push(`${label} chunk=${c}: got ${got.length} lines, want ${expected.length}` +
        (got.length === expected.length ? ' (content differs)' : ''));
    }
  }
  return bad;
}

describe('readJsonlLines is equivalent to slurp-and-split', () => {
  it('agrees on every edge case at every chunk size', () => {
    const chunks = [1, 2, 3, 4, 5, 7, 8, 16, 64, 1024];
    const cases: Array<[string, Buffer | string]> = [
      ['no trailing newline', 'a\nb'],
      ['lone CR', 'a\rb\n'],
      ['CRLF', 'a\r\nb\r\n'],
      ['only newlines', '\n\n\n'],
      ['empty', ''],
      ['whitespace last line', 'a\n   '],
      ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n')])],
      ['truncated utf8', Buffer.concat([Buffer.from('a\n'), Buffer.from([0xf0, 0x9f]), Buffer.from('\nb\n')])],
      ['emoji every offset', 'x'.repeat(3) + '🤖\n' + 'y'.repeat(5) + '🤖\n'],
      ['long single line', 'z'.repeat(200000)],
      ['long line then more', 'z'.repeat(100000) + '\nshort\n'],
      ['tabs and spaces', '\t a \t\n\t\n b\n'],
      ['line == chunk size', 'abcd\nabcd\n'],
    ];
    const failures: string[] = [];
    for (const [label, content] of cases) failures.push(...check(label, content, chunks));
    // Emoji straddling EVERY offset in a small window.
    for (let pad = 0; pad < 8; pad++) {
      failures.push(...check(`emoji pad=${pad}`, 'a'.repeat(pad) + '🤖bc\n', [1, 2, 3, 4, 5, 6, 7]));
    }
    if (failures.length) throw new Error('DIVERGENCE:\n' + failures.join('\n'));
    expect(failures).toEqual([]);
  });
});
