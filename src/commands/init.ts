import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { welcomePanel } from '../ui/boxen-panels.js';

export interface InitOptions {
  force?: boolean;
  dir?: string;
}

const DEFAULT_DIR = '.agent-replay';

/**
 * `agent-replay init` — create project directory, initialize SQLite database,
 * write a default config.json, and show a welcome panel.
 */
export function runInit(opts: InitOptions = {}): void {
  const baseDir = resolve(opts.dir ?? DEFAULT_DIR);
  const dbPath = join(baseDir, 'traces.db');
  const configPath = join(baseDir, 'config.json');

  // Guard against re-init without --force
  if (existsSync(configPath) && !opts.force) {
    console.log(
      chalk.yellow(`Already initialized at ${baseDir}. Use --force to reinitialize.`),
    );
    return;
  }

  // Create directory
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Initialize database (creates file + runs migrations)
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
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // Show welcome
  console.log('');
  console.log(welcomePanel(dbPath));
  console.log('');
}
