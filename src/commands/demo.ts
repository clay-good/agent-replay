import { existsSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import chalk from 'chalk';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ensureDatabase } from '../db/index.js';
import { runInit } from './init.js';
import { listTraces } from '../services/trace-service.js';
import { seedDemoData } from '../demo/seed-data.js';
import { traceTable } from '../ui/table.js';
import { heading, separator, colors } from '../ui/theme.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir, dirWasNamed } from '../utils/paths.js';

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
/**
 * What a store holds, for the line `--reset` prints before deleting it.
 *
 * Read-only and best-effort: a store that cannot be opened (corrupt, locked,
 * written by a newer schema) still gets cleared — the point of the line is to
 * name the loss when it can, never to stand between the user and the flag they
 * typed.
 */
function describeStoreContents(dbPath: string): string {
  let db: DatabaseType | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const count = (sql: string): number => (db!.prepare(sql).get() as { n: number }).n;
    const traces = count('SELECT COUNT(*) AS n FROM agent_traces');
    const evals = count('SELECT COUNT(*) AS n FROM agent_trace_evals');
    const policies = count('SELECT COUNT(*) AS n FROM guardrail_policies');
    const parts = [`${traces} ${traces === 1 ? 'trace' : 'traces'}`];
    if (evals > 0) parts.push(`${evals} evaluation ${evals === 1 ? 'result' : 'results'}`);
    if (policies > 0) parts.push(`${policies} guardrail ${policies === 1 ? 'policy' : 'policies'}`);
    return parts.join(', ');
  } catch {
    return 'the existing store';
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do: the file is about to be unlinked either way.
    }
  }
}

export async function runDemo(opts: DemoOptions = {}): Promise<void> {
  const baseDir = resolve(resolveDataDir(opts.dir));
  const dbPath = resolve(baseDir, 'traces.db');

  // Reset if requested — safety checks before an rmSync.
  if (opts.reset && existsSync(baseDir)) {
    // A destructive command must not inherit its target from the environment.
    // `AGENT_REPLAY_DIR` is a handshake `run` sets for its child (and users may
    // export it), so honoring it here meant `demo --reset` from ANY directory
    // could delete a real store that merely happens to be named .agent-replay.
    // Deleting someone's traces has to be something they typed.
    // `dirWasNamed`, not `!opts.dir`: a blank --dir is not a named target, and
    // treating it as one skipped this guard while the ENV store was what would
    // actually be cleared.
    if (!dirWasNamed(opts.dir) && process.env.AGENT_REPLAY_DIR != null && process.env.AGENT_REPLAY_DIR.trim() !== '') {
      console.error(chalk.red('  Refusing to reset a store named only by AGENT_REPLAY_DIR.'));
      console.error(chalk.dim(`  Pass it explicitly if that is what you mean: --dir ${process.env.AGENT_REPLAY_DIR}`));
      process.exitCode = 1;
      return;
    }
    const baseName = basename(baseDir);
    if (!baseName.startsWith('.agent-replay') && !baseName.startsWith('agent-replay')) {
      console.error(chalk.red(`  Refusing to delete "${baseDir}" — expected an agent-replay data directory.`));
      process.exitCode = 1;
      return;
    }
    // Delete the store's OWN files, never the directory tree. The name check
    // above is a naming heuristic, not proof of a store: a source checkout
    // called `agent-replay-project` passes it, and `--dir agent-replay-project`
    // then recursively deleted that working tree. Unlinking traces.db and its
    // sidecars bounds the blast radius to data this command created, and a
    // directory that holds no store has nothing to reset.
    if (existsSync(dbPath)) {
      // Say what is being destroyed, before destroying it.
      //
      // Every guard above is about WHERE this deletes — a store named only by
      // the environment, a directory that is not one of ours, the tree around
      // the file. None of them opens the store, so the command could not say
      // what was inside: a real captured run, its evaluations and a hand-written
      // guardrail policy were unlinked under one line reading "Cleared existing
      // data." `demo` is the sample-data command, and a user reaching for fresh
      // samples has no reason to expect their own store is what goes.
      //
      // Counted, not judged: which traces are "real" is not something this
      // command can know — the demo's own rows look like any other — so it
      // reports the blast radius and leaves the reading to the person who typed
      // `--reset`, exactly as `import --replace` names what goes with the trace
      // it replaces. Still a report and not a refusal: `--reset` is documented
      // as clearing the store, and honouring that is the contract.
      console.log(chalk.dim(`  Clearing ${describeStoreContents(dbPath)} from ${dbPath}.`));
      for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    }
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
      process.exitCode = 1;
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
  console.log(`       ${chalk.white('agent-replay stats')}                   ${chalk.dim('— Scriptable summary (--json, --since)')}`);
  console.log('');
  console.log(chalk.white('  Understand why an agent acted (the travel-assistant trace has decisions):'));
  console.log('');
  console.log(`   ${chalk.cyanBright('11.')} ${chalk.white('agent-replay decisions <trace-id>')}    ${chalk.dim('— List decision points + rationale')}`);
  console.log(`   ${chalk.cyanBright('12.')} ${chalk.white('agent-replay why <trace-id> --step 8')}  ${chalk.dim('— Walk the causal chain')}`);
  console.log(`   ${chalk.cyanBright('13.')} ${chalk.white('agent-replay show <trace-id> --tree')}   ${chalk.dim('— Hierarchical step view')}`);
  console.log('');
  console.log(chalk.white('  Capture live and enforce guardrails (see the README for setup):'));
  console.log('');
  console.log(`       ${chalk.white('agent-replay record | hook | watch')}    ${chalk.dim('— Capture runs live (hooks, streams, SDK)')}`);
  console.log(`       ${chalk.white('agent-replay run -- <command>')}         ${chalk.dim('— Wrap an agent; guard check / hook --enforce block bad calls')}`);
  console.log(`       ${chalk.white('agent-replay check --golden / otel serve')} ${chalk.dim('— CI regression gate; OpenTelemetry ingest')}`);
  console.log('');

  if (traces.length > 0) {
    // Prefer the decision-rich travel-assistant trace for the hint.
    const showcase = traces.find((t) => t.session_id) ?? traces[0];
    console.log(chalk.dim(`  Hint: try ${chalk.white(`agent-replay show ${showcase.id.slice(0, 8)}`)} — then ${chalk.white(`decisions ${showcase.id.slice(0, 8)}`)} to see why it chose what it did!`));
    console.log('');
  }
}
