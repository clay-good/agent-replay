import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { runInit } from './init.js';
import { listTraces } from '../services/trace-service.js';
import { seedDemoData } from '../demo/seed-data.js';
import { traceTable } from '../ui/table.js';
import { heading, separator, colors } from '../ui/theme.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';

export interface DemoOptions {
  interactive?: boolean;
  reset?: boolean;
  dir?: string;
}

/**
 * `agent-replay demo` — seed sample data and run an interactive walkthrough.
 *
 * The actual seed data is loaded from src/demo/seed-data.ts (created in Prompt 11).
 * This command handles init, reset, seeding, and the walkthrough flow.
 */
export function runDemo(opts: DemoOptions = {}): void {
  const baseDir = resolve(opts.dir ?? '.agent-replay');
  const dbPath = resolve(baseDir, 'traces.db');

  // Reset if requested — safety check: only delete .agent-replay directories
  if (opts.reset && existsSync(baseDir)) {
    const baseName = baseDir.split('/').pop() ?? '';
    if (!baseName.startsWith('.agent-replay') && !baseName.startsWith('agent-replay')) {
      console.error(chalk.red(`  Refusing to delete "${baseDir}" — expected an agent-replay data directory.`));
      return;
    }
    rmSync(baseDir, { recursive: true });
    console.log(chalk.dim('  Cleared existing data.'));
  }

  // Init if needed
  if (!existsSync(dbPath)) {
    runInit({ dir: opts.dir });
  }

  const db = ensureDatabase(dbPath);

  // Check if demo data already loaded
  const { items: existing } = listTraces(db, { limit: 1 });
  if (existing.length > 0 && !opts.reset) {
    console.log(chalk.yellow('  Demo data appears to already be loaded.'));
    console.log(chalk.dim('  Use --reset to clear and reload.'));
    console.log('');
  } else {
    // Only seed if no existing data or user explicitly reset
    const spinner = startSpinner('Loading demo scenarios...');
    try {
      seedDemoData(db);
      successSpinner(spinner, 'Loaded 5 demo traces + 3 guardrail policies.');
    } catch (err) {
      failSpinner(spinner, `Seed error: ${errorMessage(err)}`);
    }
  }

  console.log('');

  // Show loaded traces
  const { items: traces } = listTraces(db, { limit: 10 });
  if (traces.length > 0) {
    console.log(heading('  Loaded traces:'));
    console.log('');
    console.log(traceTable(traces));
    console.log('');
  }

  // Interactive walkthrough
  if (opts.interactive === false) {
    console.log(chalk.dim('  Skipping interactive walkthrough (--no-interactive).'));
    return;
  }

  console.log(separator());
  console.log('');
  console.log(colors.primary.bold('  Interactive Walkthrough'));
  console.log('');
  console.log(chalk.white('  Try these commands to explore the demo data:'));
  console.log('');
  console.log(`    ${chalk.cyanBright('1.')} ${chalk.white('agent-replay list')}                    ${chalk.dim('— See all traces')}`);
  console.log(`    ${chalk.cyanBright('2.')} ${chalk.white('agent-replay list --status failed')}    ${chalk.dim('— Filter failed traces')}`);
  console.log(`    ${chalk.cyanBright('3.')} ${chalk.white('agent-replay show <trace-id>')}         ${chalk.dim('— Detailed trace view')}`);
  console.log(`    ${chalk.cyanBright('4.')} ${chalk.white('agent-replay replay <trace-id>')}       ${chalk.dim('— Animated step replay')}`);
  console.log(`    ${chalk.cyanBright('5.')} ${chalk.white('agent-replay diff <id-a> <id-b>')}      ${chalk.dim('— Compare two traces')}`);
  console.log(`    ${chalk.cyanBright('6.')} ${chalk.white('agent-replay fork <id> --from-step 3')} ${chalk.dim('— Fork at step 3')}`);
  console.log(`    ${chalk.cyanBright('7.')} ${chalk.white('agent-replay eval <id> --preset hallucination-check')}`);
  console.log(`       ${chalk.dim('— Run hallucination evaluator')}`);
  console.log(`    ${chalk.cyanBright('8.')} ${chalk.white('agent-replay guard list')}              ${chalk.dim('— View guardrail policies')}`);
  console.log(`    ${chalk.cyanBright('9.')} ${chalk.white('agent-replay guard test <id>')}         ${chalk.dim('— Test policies against trace')}`);
  console.log(`   ${chalk.cyanBright('10.')} ${chalk.white('agent-replay dashboard')}               ${chalk.dim('— Full-screen TUI')}`);
  console.log('');

  if (traces.length > 0) {
    const first = traces[0];
    console.log(chalk.dim(`  Hint: try ${chalk.white(`agent-replay show ${first.id.slice(0, 8)}`)} to get started!`));
    console.log('');
  }
}
