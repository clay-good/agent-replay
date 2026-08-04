import { defineConfig } from 'vitest/config';

// Coverage-only config — test discovery stays on vitest's defaults. Run with
// `npm run coverage`. The command layer is exercised by the CLI-integration
// suite, which spawns the built binary out of process, so v8 can't see it;
// coverage numbers are therefore meaningful for the service/util/ui layers.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Barrel re-exports, the interactive TUI, and the TTY spinner have no
      // meaningful headless unit surface — excluding them keeps the report
      // focused on code a test can actually assert.
      exclude: ['src/**/index.ts', 'src/ui/dashboard-view.ts', 'src/ui/spinner.ts'],
      reporter: ['text', 'html'],
    },
  },
});
