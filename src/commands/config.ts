import chalk from 'chalk';
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveProvider,
  configPath,
  configProblems,
} from '../services/config-service.js';
import type { AgentReplayConfig } from '../services/config-service.js';
import { callLlm } from '../services/llm-client.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';

export interface ConfigOptions {
  dir?: string;
}

// ── config list ──────────────────────────────────────────────────────────

/** Every settable key, in one place: `config set` validates against it, `config
 *  get` accepts it, and both messages are built from it. */
const VALID_KEYS = [
  'ai.provider',
  'ai.model',
  'ai.max_tokens',
  'ai.api_keys.anthropic',
  'ai.api_keys.google',
  'ai.api_keys.openai',
] as const;

/**
 * Keys `config get` will answer for. Broader than the settable list: reading a
 * CONTAINER (`config get ai`) prints the masked subtree, and the file's own
 * bookkeeping fields are readable even though they are not settable.
 */
function isKnownConfigKey(key: string): boolean {
  return (
    (VALID_KEYS as readonly string[]).includes(key) ||
    ['ai', 'ai.api_keys', 'version', 'database', 'created_at'].includes(key)
  );
}

/** Print any key the loader had to drop, so a silently ignored value is visible. */
function reportConfigProblems(dir?: string): void {
  const problems = configProblems(dir);
  if (problems.length === 0) return;
  for (const p of problems) console.error(chalk.yellow(`  ${p.message}`));
  console.error('');
}

export function runConfigList(opts: ConfigOptions = {}): void {
  const config = loadConfig(opts.dir);
  if (!config) {
    console.log(chalk.yellow('  No configuration found. Run `agent-replay init` first.'));
    return;
  }

  console.log('');
  console.log(chalk.cyan.bold('  Configuration'));
  console.log(chalk.dim(`  ${configPath(opts.dir)}`));
  console.log('');

  // Mask API keys for display
  const display = JSON.parse(JSON.stringify(config)) as AgentReplayConfig;
  if (display.ai?.api_keys) {
    for (const [key, val] of Object.entries(display.ai.api_keys)) {
      if (val && typeof val === 'string') {
        (display.ai.api_keys as Record<string, string>)[key] =
          val.length > 12 ? val.slice(0, 4) + '...' + val.slice(-4) : '***';
      }
    }
  }

  console.log(JSON.stringify(display, null, 2));
  console.log('');

  // A key the loader had to drop is in the file but NOT in effect. `config set`
  // validates every key and nothing validated them on read, so a hand-edited or
  // copied config could hold a value that is silently ignored — printing the
  // file without saying so is how it stays invisible.
  reportConfigProblems(opts.dir);

  // Show env var status
  const envVars = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
  const activeEnv = envVars.filter((v) => process.env[v]);
  if (activeEnv.length > 0) {
    console.log(chalk.dim('  Environment variables detected:'));
    for (const v of activeEnv) {
      console.log(chalk.dim(`    ${v} = ${maskKey(process.env[v]!)}`));
    }
    console.log('');
  }
}

// ── config get ───────────────────────────────────────────────────────────

export function runConfigGet(key: string, opts: ConfigOptions = {}): void {
  const config = loadConfig(opts.dir);
  if (!config) {
    console.error(chalk.yellow('  No configuration found. Run `agent-replay init` first.'));
    process.exitCode = 2;
    return;
  }

  // Reject an unknown key rather than answering "(not set)" for it. `config
  // set` already refuses the same key at exit 2, so a typo was undetectable
  // here — identical output and exit code to a real but unset key.
  if (!isKnownConfigKey(key)) {
    console.error(chalk.red(`  Unknown key: ${key}`));
    console.error(chalk.dim(`  Valid keys: ${VALID_KEYS.join(', ')}`));
    process.exitCode = 2;
    return;
  }

  const value = getConfigValue(config, key);
  if (value === undefined) {
    // stderr, not stdout: stdout is the VALUE channel here, and
    // `KEY=$(agent-replay config get ai.api_keys.anthropic)` captured a 34-char
    // human sentence instead of the empty string, so a `[ -n "$KEY" ]` guard
    // passed and the sentence was sent onward as if it were a key.
    console.error(chalk.dim(`  ${key}: (not set)`));
  } else if (typeof value === 'object') {
    // Mask any API keys before printing — `config get ai` or `config get
    // ai.api_keys` returns an object, and dumping it raw would leak secrets in
    // plaintext (config list already masks; this keeps get consistent).
    console.log(JSON.stringify(maskConfigValue(value, key), null, 2));
  } else {
    // Mask API keys (via maskKey, so even a short value never prints raw).
    const str = String(value);
    console.log(key.includes('api_key') ? maskKey(str) : str);
  }
}

// ── config set ───────────────────────────────────────────────────────────

export function runConfigSet(key: string, value: string, opts: ConfigOptions = {}): void {
  const config = loadConfig(opts.dir);
  if (!config) {
    console.error(chalk.yellow('  No configuration found. Run `agent-replay init` first.'));
    process.exitCode = 2;
    return;
  }

  // One list, shared with `config get` and with the message below — the message
  // used to repeat the array as a literal string, which is a copy that can go
  // stale the moment a key is added.
  if (!(VALID_KEYS as readonly string[]).includes(key)) {
    console.error(chalk.yellow(`  Unknown key: ${key}`));
    console.error(chalk.dim(`  Valid keys: ${VALID_KEYS.join(', ')}`));
    process.exitCode = 2;
    return;
  }

  if (key === 'ai.provider') {
    const valid = ['anthropic', 'google', 'openai', 'auto'];
    if (!valid.includes(value)) {
      console.error(chalk.red(`  Invalid provider: ${value}`));
      console.error(chalk.dim(`  Valid: ${valid.join(', ')}`));
      process.exitCode = 2;
      return;
    }
  }

  // The value echoed in the confirmation — the value actually STORED, so it
  // matches what `config get`/`config list` will show. For a normalized numeric
  // key that differs from the raw input (`1e3` → 1000, `08` → 8, `5.0` → 5).
  let displayValue: string | number = value;

  // For numeric keys, set the value as a number directly instead of going
  // through setConfigValue (which always stores strings)
  if (key === 'ai.max_tokens') {
    // Reject a non-positive-integer rather than silently rewriting it: the old
    // `parseInt(value) || 1024` turned `abc` and `0` into 1024 (while still
    // printing "= abc") and let a negative through to break API calls.
    const numValue = Number(value);
    if (!Number.isInteger(numValue) || numValue < 1) {
      console.error(chalk.red(`  Invalid ai.max_tokens: ${value} (must be a positive integer).`));
      process.exitCode = 2;
      return;
    }
    if (!config.ai) {
      (config as unknown as Record<string, unknown>).ai = {};
    }
    config.ai!.max_tokens = numValue;
    displayValue = numValue;
  } else {
    setConfigValue(config, key, value);
  }

  saveConfig(config, opts.dir);

  if (key.includes('api_key')) {
    console.log(chalk.greenBright(`  ${key} = ${maskKey(value)}`));
    console.log(chalk.dim('  Note: API key is stored in plaintext in config.json'));
  } else {
    console.log(chalk.greenBright(`  ${key} = ${displayValue}`));
  }
}

// ── config test-ai ───────────────────────────────────────────────────────

export async function runConfigTestAi(opts: ConfigOptions = {}): Promise<void> {
  const config = loadConfig(opts.dir);
  if (!config) {
    console.error(chalk.yellow('  No configuration found. Run `agent-replay init` first.'));
    process.exitCode = 2;
    return;
  }

  // This is the AI diagnostic command, so a key the loader had to drop is
  // exactly what the user is here to find out about — a typo'd `ai.provider`
  // otherwise produced "No AI provider configured" with no hint that the
  // configured value was the problem.
  reportConfigProblems(opts.dir);

  const resolved = resolveProvider(config);
  if (!resolved) {
    console.error(chalk.red('  No AI provider configured.'));
    console.error(chalk.dim('  Set an API key: agent-replay config set ai.api_keys.anthropic <key>'));
    console.error(chalk.dim('  Or set env var: ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY'));
    process.exitCode = 2;
    return;
  }

  const spinner = startSpinner(
    `Testing ${resolved.provider} (${resolved.model})...`,
  );

  try {
    const response = await callLlm(
      {
        provider: resolved.provider,
        api_key: resolved.apiKey,
        model: resolved.model,
      },
      {
        prompt: 'Respond with exactly: OK',
        max_tokens: 8,
      },
    );

    successSpinner(spinner, `Connected to ${resolved.provider}`);
    console.log(chalk.dim(`  Model: ${response.model}`));
    console.log(chalk.dim(`  Response: "${response.text.trim()}"`));
    console.log(chalk.dim(`  Latency: ${response.latency_ms}ms`));
    console.log(chalk.dim(`  Cost: $${response.cost_estimate_usd.toFixed(6)}`));
    console.log('');
  } catch (err) {
    failSpinner(spinner, `Failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/**
 * Deep-copy a config value with every API key masked, for `config get` on an
 * object path. Handles both the case where the value *is* the api_keys map
 * (e.g. `config get ai.api_keys`) and where it merely contains one (`config get
 * ai`).
 */
function maskConfigValue(value: unknown, keyPath: string): unknown {
  const clone = JSON.parse(JSON.stringify(value));
  if (keyPath.split('.').pop() === 'api_keys' && clone && typeof clone === 'object') {
    maskApiKeyMap(clone as Record<string, unknown>);
    return clone;
  }
  maskApiKeysDeep(clone);
  return clone;
}

function maskApiKeyMap(map: Record<string, unknown>): void {
  for (const k of Object.keys(map)) {
    if (typeof map[k] === 'string') map[k] = maskKey(map[k] as string);
  }
}

function maskApiKeysDeep(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'api_keys' && v && typeof v === 'object') {
      maskApiKeyMap(v as Record<string, unknown>);
    } else {
      maskApiKeysDeep(v);
    }
  }
}
