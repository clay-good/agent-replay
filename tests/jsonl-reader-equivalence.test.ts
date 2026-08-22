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
 *
 * The one exception is line length. Reading a 200 KB line one byte at a time is
 * 200,000 syscalls per chunk size, which is what made this test slow enough to
 * trip the suite timeout intermittently — and it proves nothing the same code
 * path does not already prove at 2 KB, since what is under test is the carry
 * buffer growing past the chunk, not the size it reaches. So the very long
 * lines run only at realistic chunk sizes (where buffer growth is the point),
 * and a 2 KB line covers the tiny chunks (where "line ≫ chunk" is the point).
 * Both properties stay covered; the syscall count drops ~100x.
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
    // Chunk sizes for the very long lines: big enough that the byte count stays
    // sane, still small enough that a 100–200 KB line spans many reads and
    // forces the carry buffer to grow repeatedly.
    const bigChunks = [64, 1024, 8192];
    const cases: Array<[string, Buffer | string, number[]?]> = [
      ['no trailing newline', 'a\nb'],
      ['lone CR', 'a\rb\n'],
      ['CRLF', 'a\r\nb\r\n'],
      ['only newlines', '\n\n\n'],
      ['empty', ''],
      ['whitespace last line', 'a\n   '],
      ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n')])],
      ['truncated utf8', Buffer.concat([Buffer.from('a\n'), Buffer.from([0xf0, 0x9f]), Buffer.from('\nb\n')])],
      ['emoji every offset', 'x'.repeat(3) + '🤖\n' + 'y'.repeat(5) + '🤖\n'],
      ['long single line', 'z'.repeat(200000), bigChunks],
      ['long line then more', 'z'.repeat(100000) + '\nshort\n', bigChunks],
      // "line much longer than the chunk" at the tiny chunk sizes, cheaply: at
      // chunk=1 this line is still 2,000x the chunk.
      ['line >> tiny chunk', 'z'.repeat(2000) + '\nshort\n'],
      ['tabs and spaces', '\t a \t\n\t\n b\n'],
      ['line == chunk size', 'abcd\nabcd\n'],
    ];
    const failures: string[] = [];
    for (const [label, content, only] of cases) failures.push(...check(label, content, only ?? chunks));
    // Emoji straddling EVERY offset in a small window.
    for (let pad = 0; pad < 8; pad++) {
      failures.push(...check(`emoji pad=${pad}`, 'a'.repeat(pad) + '🤖bc\n', [1, 2, 3, 4, 5, 6, 7]));
    }
    if (failures.length) throw new Error('DIVERGENCE:\n' + failures.join('\n'));
    expect(failures).toEqual([]);
  });
});
