import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    banner: {
      js: '#!/usr/bin/env node',
    },
    outDir: 'dist',
    clean: true,
    sourcemap: true,
  },
  {
    entry: ['src/index.ts'],
    // ESM only, deliberately. chalk, ora, boxen, string-width and nanoid are all
    // ESM-only packages, and esbuild's CJS interop turns `import chalk from
    // 'chalk'` into `require('chalk').default` — which, under Node's require(ESM)
    // support, is the module NAMESPACE, not the chalk function. The emitted
    // dist/index.cjs therefore threw `Cannot read properties of undefined` on
    // load, on every supported Node (older ones threw ERR_REQUIRE_ESM at the
    // same require instead). Nothing loaded that file in the suite, so it
    // shipped broken. Node >= 20.19/22.12 requires an ESM entry point directly,
    // so dropping the CJS output makes `require('agent-replay')` work rather
    // than removing something that did.
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    dts: true,
    outDir: 'dist',
    sourcemap: true,
  },
]);
