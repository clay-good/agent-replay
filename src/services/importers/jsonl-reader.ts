import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

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
export function* readJsonlLines(filePath: string, chunkSize = 1 << 20): Generator<string> {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(chunkSize);
    // Bytes of an incomplete final line (or a split multi-byte character)
    // carried into the next chunk.
    let carry = Buffer.alloc(0);
    let position = 0;

    while (position < size) {
      const bytesRead = readSync(fd, buf, 0, Math.min(chunkSize, size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;

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
