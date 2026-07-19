import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { runWrapped } from '../services/harness-service.js';
import { shortId } from '../utils/id.js';

export interface RunOptions {
  agentName?: string;
  tags?: string;
  dir?: string;
}

/**
 * `agent-replay run [options] -- <command>` — run a child process under
 * supervision, recording its emitted events as a trace and propagating its
 * exit status.
 */
export async function runRun(parts: string[] = [], opts: RunOptions = {}): Promise<void> {
  if (parts.length === 0) {
    console.error(chalk.red('  Usage: agent-replay run [--agent-name <n>] [--tags <t>] -- <command> [args...]'));
    process.exitCode = 2;
    return;
  }

  const [command, ...args] = parts;
  const dbDir = resolve(opts.dir ?? '.agent-replay');
  const db = ensureDatabase(resolve(dbDir, 'traces.db'));
  const tags = (opts.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const result = await runWrapped(db, {
    command,
    args,
    agentName: opts.agentName,
    tags: tags.length ? tags : undefined,
    dbDir,
  });

  const status = result.exitCode === 0 ? chalk.green('completed') : chalk.redBright(`failed (exit ${result.exitCode})`);
  console.error(
    chalk.dim(`\n  agent-replay: trace ${shortId(result.traceId)} ${status}, ${result.eventsApplied} event(s) recorded.`),
  );

  // Propagate the child's exit status.
  process.exitCode = result.exitCode;
}
