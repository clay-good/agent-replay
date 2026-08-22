import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { welcomePanel } from '../ui/boxen-panels.js';
import { resolveDataDir } from '../utils/paths.js';

export interface InitOptions {
  force?: boolean;
  dir?: string;
}



/**
 * `agent-replay init` — create project directory, initialize SQLite database,
 * write a default config.json, and show a welcome panel.
 */
export function runInit(opts: InitOptions = {}): void {
  const baseDir = resolve(resolveDataDir(opts.dir));
  const dbPath = join(baseDir, 'traces.db');
  const configPath = join(baseDir, 'config.json');

  // Guard against re-init without --force
  if (existsSync(configPath) && !opts.force) {
    console.log(
      chalk.yellow(`Already initialized at ${baseDir}. Use --force to reinitialize.`),
    );
    return;
  }

  // Initialize database (creates the directory AND file, then runs migrations).
  //
  // The directory is deliberately NOT created here. `ensureDatabase` creates it
  // too, and it is the only place that knows the store must be private (it
  // holds config.json with API keys in plaintext). Creating it first here, with
  // the plain umask mode, meant the store the tool made for itself was
  // world-readable and only became private again because the connection layer
  // used to re-chmod every directory it opened — including ones the user merely
  // pointed at. One creator, one place that sets the mode.
  ensureDatabase(dbPath);

  // Write default config
  const config = {
    version: '0.1.0',
    database: dbPath,
    created_at: new Date().toISOString(),
    ai: {
      provider: 'auto' as const,
    },
  };
  // Owner-only: the config will hold API keys once the user sets them.
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  // Show welcome
  console.log('');
  console.log(welcomePanel(dbPath));
  console.log('');
}
