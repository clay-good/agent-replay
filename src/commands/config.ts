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
    return;
  }

  const value = getConfigValue(config, key);
  if (value === undefined) {
    console.log(chalk.dim(`  ${key}: (not set)`));
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    // Mask API keys
    const str = String(value);
    if (key.includes('api_key') && str.length > 8) {
      console.log(maskKey(str));
    } else {
      console.log(str);
    }
  }
}

// ── config set ───────────────────────────────────────────────────────────

export function runConfigSet(key: string, value: string, opts: ConfigOptions = {}): void {
  const config = loadConfig(opts.dir);
  if (!config) {
    console.error(chalk.yellow('  No configuration found. Run `agent-replay init` first.'));
    return;
  }

  // Validate known keys
  const validKeys = ['ai.provider', 'ai.model', 'ai.max_tokens', 'ai.api_keys.anthropic', 'ai.api_keys.google', 'ai.api_keys.openai'];
  const isKnown = validKeys.includes(key);

  if (!isKnown) {
    console.error(chalk.yellow(`  Unknown key: ${key}`));
    console.error(chalk.dim('  Valid keys: ai.provider, ai.model, ai.max_tokens, ai.api_keys.anthropic, ai.api_keys.google, ai.api_keys.openai'));
    return;
  }

  if (key === 'ai.provider') {
    const valid = ['anthropic', 'google', 'openai', 'auto'];
    if (!valid.includes(value)) {
      console.error(chalk.red(`  Invalid provider: ${value}`));
      console.error(chalk.dim(`  Valid: ${valid.join(', ')}`));
      return;
    }
  }

  // Store numeric values as numbers
  const storeValue = key === 'ai.max_tokens' ? String(parseInt(value, 10) || 1024) : value;
  setConfigValue(config, key, storeValue);

  // For max_tokens, also fix the type in the config object
  if (key === 'ai.max_tokens' && config.ai) {
    (config.ai as Record<string, unknown>).max_tokens = parseInt(value, 10) || 1024;
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
    return;
  }

  const resolved = resolveProvider(config);
  if (!resolved) {
    console.error(chalk.red('  No AI provider configured.'));
    console.error(chalk.dim('  Set an API key: agent-replay config set ai.api_keys.anthropic <key>'));
    console.error(chalk.dim('  Or set env var: ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY'));
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
