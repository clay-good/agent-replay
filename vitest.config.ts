import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's 5s default is too tight for this suite. The CLI integration
    // tests spawn a real `node dist/cli.js` process per assertion, and several
    // service tests build stores of 10k+ rows; on a busy machine or a shared CI
    // runner those exceed 5s from scheduling latency alone, so the suite failed
    // for reasons unrelated to the code under test. A genuinely hung command
    // still fails fast — the integration helper passes its own 20s timeout to
    // execFileSync — so this only removes the false negatives.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
