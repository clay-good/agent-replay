import chalk from 'chalk';
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveProvider,
  configPath,
} from '../services/config-service.js';
import type { AgentReplayConfig } from '../services/config-service.js';
import { callLlm } from '../services/llm-client.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';

export interface ConfigOptions {
  dir?: string;
}

// ── config list ──────────────────────────────────────────────────────────

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

  const value = getConfigValue(config, key);
  if (value === undefined) {
    console.log(chalk.dim(`  ${key}: (not set)`));
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

  // Validate known keys
  const validKeys = ['ai.provider', 'ai.model', 'ai.max_tokens', 'ai.api_keys.anthropic', 'ai.api_keys.google', 'ai.api_keys.openai'];
  const isKnown = validKeys.includes(key);

  if (!isKnown) {
    console.error(chalk.yellow(`  Unknown key: ${key}`));
    console.error(chalk.dim('  Valid keys: ai.provider, ai.model, ai.max_tokens, ai.api_keys.anthropic, ai.api_keys.google, ai.api_keys.openai'));
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

  // For numeric keys, set the value as a number directly instead of going
  // through setConfigValue (which always stores strings)
  if (key === 'ai.max_tokens') {
    const numValue = parseInt(value, 10) || 1024;
    if (!config.ai) {
      (config as unknown as Record<string, unknown>).ai = {};
    }
    config.ai!.max_tokens = numValue;
  } else {
    setConfigValue(config, key, value);
  }

  saveConfig(config, opts.dir);

  if (key.includes('api_key')) {
    console.log(chalk.greenBright(`  ${key} = ${maskKey(value)}`));
    console.log(chalk.dim('  Note: API key is stored in plaintext in config.json'));
  } else {
    console.log(chalk.greenBright(`  ${key} = ${value}`));
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
