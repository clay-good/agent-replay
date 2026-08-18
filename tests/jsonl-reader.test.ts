import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlLines } from '../src/services/importers/jsonl-reader.js';

/**
 * The importers read transcripts through this. Slurping the file as one string
 * and splitting it kept three copies alive (436 MB of peak RSS for a real 52 MB
 * transcript) and could not read a file at all above the ~512 MB JS string
 * limit — a real ceiling for long agent sessions. The behavior asserted here is
 * exactly what `split('\n').map(trim).filter(Boolean)` produced, so the change
 * is invisible to callers, plus the chunk-boundary cases only a streaming reader
 * can get wrong.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ar-jsonl-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: string | Buffer): string {
  const p = join(dir, 'f.jsonl');
  writeFileSync(p, content);
  return p;
}

describe('readJsonlLines', () => {
  it('yields each non-empty trimmed line', () => {
    const p = write('a\n  b  \n\n\nc\n');
    expect([...readJsonlLines(p)]).toEqual(['a', 'b', 'c']);
  });

  it('yields a final line with no trailing newline', () => {
    expect([...readJsonlLines(write('one\ntwo'))]).toEqual(['one', 'two']);
  });

  it('returns nothing for an empty or whitespace-only file', () => {
    expect([...readJsonlLines(write(''))]).toEqual([]);
    expect([...readJsonlLines(write('\n\n   \n'))]).toEqual([]);
  });

  it('trims a CRLF line ending, like the split/trim it replaces', () => {
    expect([...readJsonlLines(write('a\r\nb\r\n'))]).toEqual(['a', 'b']);
  });

  // The part only a streaming reader can get wrong: a multi-byte character
  // straddling a read boundary must not decode to U+FFFD. Driven with a
  // deliberately tiny chunk so every boundary lands mid-character.
  it('keeps a multi-byte character split across a chunk boundary intact', () => {
    const line = '日本語エージェント🤖';
    const p = write(`${line}\n${line}\n`);
    for (const chunk of [1, 2, 3, 5, 7, 13]) {
      expect([...readJsonlLines(p, chunk)], `chunk=${chunk}`).toEqual([line, line]);
    }
  });

  it('reads a line longer than the chunk size', () => {
    const long = 'x'.repeat(5000);
    expect([...readJsonlLines(write(`${long}\n`), 64)]).toEqual([long]);
  });

  it('handles a chunk boundary landing exactly on a newline', () => {
    // 'ab\n' is 3 bytes: a chunk of 3 ends flush with the newline.
    expect([...readJsonlLines(write('ab\ncd\nef\n'), 3)]).toEqual(['ab', 'cd', 'ef']);
  });

  it('agrees with the slurp-and-split it replaced, on mixed content', () => {
    const content = 'a\n\n  {"x":1}  \n日本\r\nlast';
    const expected = content.split('\n').map((l) => l.trim()).filter(Boolean);
    expect([...readJsonlLines(write(content), 4)]).toEqual(expected);
  });
});

describe('sources that are not seekable regular files', () => {
  // The first version read at an explicit byte offset and trusted
  // `fstat().size`. Both assumptions are false for a pipe: an offset read throws
  // `ESPIPE: invalid seek` (so `import /dev/stdin`, which the previous
  // readFileSync handled, broke), and a FIFO reports size 0 — which was worse,
  // because the loop simply never ran and the import reported "nothing
  // importable found" for a file that had content. Silent loss, not an error.
  it('reads a FIFO, which reports a size of 0', () => {
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    // Write from a separate process so the open() does not deadlock.
    const writer = spawn('sh', ['-c', `printf 'a\\nb\\nc\\n' > ${fifo}`], { stdio: 'ignore' });
    try {
      expect([...readJsonlLines(fifo)]).toEqual(['a', 'b', 'c']);
    } finally {
      writer.kill();
    }
  });

  it('reads a growing file to its current end', () => {
    // A sequential read stops at the first zero-length read, which is the only
    // end-of-input signal true for a regular file, a pipe and a FIFO alike.
    const p = join(dir, 'grow.jsonl');
    writeFileSync(p, 'one\ntwo\n');
    expect([...readJsonlLines(p, 4)]).toEqual(['one', 'two']);
  });
});

describe('an input that is not JSONL at all', () => {
  // Without a bound, an input with no newlines grows the carry buffer without
  // limit: a binary file passed by mistake buffers its whole self, and a
  // character device like /dev/zero never ends — both the previous whole-file
  // reader and the first version of this one hung there indefinitely (measured:
  // still running after 25s under a 512 MB heap cap). A message naming the limit
  // is more useful than either.
  it('gives up on a line with no newline past the limit, naming the limit', () => {
    const p = join(dir, 'binary.bin');
    // 65 MB with no newline, just over the 64 MB bound.
    writeFileSync(p, Buffer.alloc(65 * 1024 * 1024, 0x78));
    expect(() => [...readJsonlLines(p)]).toThrow(/exceeds 64 MB with no newline/);
  });

  it('still reads a long line that is under the limit', () => {
    const p = join(dir, 'long.jsonl');
    const line = 'z'.repeat(2 * 1024 * 1024);
    writeFileSync(p, line + '\n');
    expect([...readJsonlLines(p)]).toEqual([line]);
  });
});
