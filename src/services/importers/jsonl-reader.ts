import { closeSync, openSync, readSync } from 'node:fs';

/**
 * Read a JSONL file line by line without ever materializing the whole file as a
 * JavaScript string.
 *
 * `readFileSync(path, 'utf-8')` followed by `.split('\n').map(trim).filter()`
 * kept three copies of the file alive at once — the string, the array of line
 * strings, and (in the importers) the parsed records — which measured 436 MB of
 * peak RSS for a real 52 MB transcript, an 8.3x amplification. Worse, a JS
 * string cannot exceed `buffer.constants.MAX_STRING_LENGTH` (~512 MB), so a
 * transcript above that failed outright with "Cannot create a string longer
 * than 0x1fffffe8 characters" and no partial import — and long-running agent
 * sessions do reach hundreds of megabytes.
 *
 * This reads in fixed chunks and decodes ONE LINE AT A TIME, so the caller's
 * peak is its own retained data rather than a multiple of the file size, and
 * there is no whole-file string to overflow.
 *
 * A UTF-8 sequence split across a chunk boundary is handled by carrying the
 * undecoded tail bytes forward, so a multi-byte character never becomes U+FFFD.
 * Blank lines are skipped and each line is trimmed, matching the previous
 * `split/trim/filter` behavior exactly — callers count records, not lines.
 */
/**
 * The largest a single line may be before the reader gives up on it.
 *
 * A JSONL record is one line, and 64 MB is far beyond any real one (the largest
 * step payload in a transcript is a few MB). Without a bound, an input with no
 * newlines grows the carry buffer without limit — a binary file passed by
 * mistake buffers its whole self, and a character device like `/dev/zero` never
 * ends at all: both the previous whole-file reader and the first version of this
 * one hung there indefinitely. Failing with a message that names the limit is
 * more useful than either.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function* readJsonlLines(filePath: string, chunkSize = 1 << 20): Generator<string> {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    // Bytes of an incomplete final line (or a split multi-byte character)
    // carried into the next chunk.
    let carry = Buffer.alloc(0);

    // SEQUENTIAL reads (position `null`), and no reliance on the file's reported
    // size. Reading at an explicit offset threw `ESPIPE: invalid seek` on a pipe
    // — `import /dev/stdin`, which the previous readFileSync handled — and
    // trusting `fstat().size` was worse on a FIFO, where it reports 0: the loop
    // never ran and the import reported "nothing importable found" for a file
    // that had content, which is silent data loss rather than an error. A
    // sequential read works for a regular file, a pipe and a FIFO alike, and
    // stopping at `bytesRead <= 0` is the only end-of-input signal that is true
    // for all three.
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, chunkSize, null);
      if (bytesRead <= 0) break;

      let chunk = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      let start = 0;
      let nl = chunk.indexOf(0x0a, start);
      while (nl !== -1) {
        const line = chunk.toString('utf8', start, nl).trim();
        if (line) yield line;
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      carry = start < chunk.length ? chunk.subarray(start) : Buffer.alloc(0);
      if (carry.length > MAX_LINE_BYTES) {
        throw new Error(
          `${filePath}: a single line exceeds ${MAX_LINE_BYTES / (1024 * 1024)} MB with no newline — this does not look like JSONL.`,
        );
      }
      // Drop the reference so a large concatenated chunk can be collected while
      // the next read is in flight.
      chunk = Buffer.alloc(0);
    }

    // The file's last line need not end with a newline.
    if (carry.length > 0) {
      const line = carry.toString('utf8').trim();
      if (line) yield line;
    }
  } finally {
    closeSync(fd);
  }
}
