import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { VERSION } from '../utils/version.js';
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
 * What an existing config.json holds that a `--force` rewrite discards, as
 * phrases for the warning line.
 *
 * Best-effort and value-free: a config that cannot be read or parsed has
 * nothing to report (and is the very case `--force` exists to repair), and an
 * API key is reported by PROVIDER only — the point is to tell the user what
 * they must set again, never to print a secret.
 */
function discardedSettings(configPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const ai = (parsed as { ai?: unknown }).ai;
  if (ai === null || typeof ai !== 'object') return [];
  const out: string[] = [];
  const keys = (ai as { api_keys?: unknown }).api_keys;
  if (keys !== null && typeof keys === 'object') {
    const providers = Object.entries(keys as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      .map(([k]) => k);
    if (providers.length > 0) {
      out.push(`${providers.length} stored API ${providers.length === 1 ? 'key' : 'keys'} (${providers.join(', ')})`);
    }
  }
  const settings = (['provider', 'model', 'max_tokens'] as const).filter((k) => {
    const v = (ai as Record<string, unknown>)[k];
    // `provider: auto` is the default this rewrite would restore anyway.
    if (k === 'provider' && v === 'auto') return false;
    return v !== undefined && v !== null && v !== '';
  });
  for (const k of settings) out.push(`ai.${k}`);
  return out;
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

  // Say what --force is about to overwrite, before overwriting it.
  //
  // `--force` rewrites config.json from the defaults, and that file is where
  // the API keys live: a stored Anthropic key and a chosen `ai.model` went
  // silently, under the same "agent-replay initialized!" panel a first run
  // prints. That is not an exotic path — five places in the tool send a user
  // here ("Fix the file, or start over with: agent-replay init --force",
  // "To restore defaults, re-run: ..."), so the routine repair is what loses
  // the keys.
  //
  // Named rather than kept: `--force` means reinitialize, and quietly carrying
  // settings across would make it something else. The providers are named
  // because that is what the user has to type back; the key VALUES are never
  // printed.
  if (opts.force && existsSync(configPath)) {
    const lost = discardedSettings(configPath);
    if (lost.length > 0) {
      console.log(chalk.yellow(`  Overwriting ${configPath} — ${lost.join(', ')} will be lost.`));
      console.log(chalk.dim('  Re-run "agent-replay config set <key> <value>" to restore them.'));
    }
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
    version: VERSION,
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
