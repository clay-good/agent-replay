import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDataDir } from '../utils/paths.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AiConfig {
  provider?: 'anthropic' | 'google' | 'openai' | 'auto';
  model?: string;
  max_tokens?: number;
  api_keys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
  };
}

export interface AgentReplayConfig {
  version: string;
  database: string;
  created_at: string;
  ai?: AiConfig;
}

export interface ResolvedProvider {
  provider: 'anthropic' | 'google' | 'openai';
  apiKey: string;
  model: string;
}

// ── Default models ───────────────────────────────────────────────────────

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash-lite',
  openai: 'gpt-5.4-nano',
};

// ── Env var names ────────────────────────────────────────────────────────

const ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// ── Config I/O ───────────────────────────────────────────────────────────

export function configPath(dir?: string): string {
  return join(resolve(resolveDataDir(dir)), 'config.json');
}

export function loadConfig(dir?: string): AgentReplayConfig | null {
  const path = configPath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as AgentReplayConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentReplayConfig, dir?: string): void {
  const path = configPath(dir);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  // The config can hold API keys — restrict to owner read/write so other users
  // on a shared machine can't read them. (writeFileSync's mode doesn't apply to
  // an existing file, so chmod explicitly; a no-op on Windows.)
  restrictConfigPermissions(path);
}

/** Best-effort chmod 0600 on the config file (secrets). Ignores failure. */
function restrictConfigPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystem or permission quirk — leave as-is rather than fail.
  }
}

// ── Dot-notation config access ───────────────────────────────────────────

export function getConfigValue(config: AgentReplayConfig, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setConfigValue(config: AgentReplayConfig, key: string, value: string): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ── API key resolution ───────────────────────────────────────────────────

/**
 * Resolve API key for a provider. Priority: env var > config file.
 */
export function resolveApiKey(
  provider: 'anthropic' | 'google' | 'openai',
  config: AgentReplayConfig | null,
): string | null {
  // Env var first
  const envKey = ENV_KEYS[provider];
  const envVal = envKey ? process.env[envKey] : undefined;
  if (envVal) return envVal;

  // Config file
  return config?.ai?.api_keys?.[provider] ?? null;
}

/**
 * Auto-detect the best available provider.
 * Priority: anthropic → google → openai
 */
/**
 * Whether a model name belongs to a provider, by its family prefix. Used to
 * decide whether a configured `ai.model` applies to an auto-detected provider:
 * `ai.model` was applied to WHATEVER provider was found, so a config naming a
 * Claude model on a machine holding only an OpenAI key sent the Claude name to
 * OpenAI — every eval failed with an opaque server error, and the `--max-cost`
 * gate priced the run off Anthropic's rate sheet (4x the real cost) while doing
 * it. An unrecognized model name still applies, since a user naming a model the
 * table doesn't know is usually right about their own provider.
 */
function modelOwner(model: unknown): 'anthropic' | 'google' | 'openai' | null {
  // `loadConfig` does a bare JSON.parse with no schema check, so a hand-edited
  // `"model": 123` reaches here; it used to return null from the key loop and
  // produce eval's friendly "No AI provider configured", not a TypeError.
  if (typeof model !== 'string') return null;
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'google';
  if (/^(gpt|o\d)/.test(m)) return 'openai';
  return null;
}

function modelSuitsProvider(model: unknown, provider: 'anthropic' | 'google' | 'openai'): boolean {
  const owner = modelOwner(model);
  return owner === null || owner === provider;
}

export function resolveProvider(config: AgentReplayConfig | null): ResolvedProvider | null {
  const preferred = config?.ai?.provider ?? 'auto';

  if (preferred !== 'auto') {
    const apiKey = resolveApiKey(preferred, config);
    if (apiKey) {
      return {
        provider: preferred,
        apiKey,
        model: typeof config?.ai?.model === 'string' ? config.ai.model : DEFAULT_MODELS[preferred],
      };
    }
    // Explicit provider set but no key — return null
    return null;
  }

  // Auto-detect. A configured model that names a family gets first refusal on
  // the provider: with two keys present, the fixed priority order otherwise won
  // over the user's explicit `ai.model`, silently billing a different vendor and
  // returning results from a model they did not choose.
  const providers: Array<'anthropic' | 'google' | 'openai'> = ['anthropic', 'google', 'openai'];
  // Only a STRING is a model name. `loadConfig` does a bare JSON.parse with no
  // schema check, and a non-string was passed through as "suits any provider" —
  // moving the crash from here into the provider adapter (`long.startsWith is
  // not a function`), or sending the number itself as the model name.
  const configuredModel = typeof config?.ai?.model === 'string' ? config.ai.model : undefined;
  const preferredByModel = configuredModel
    ? providers.find((p) => modelOwner(configuredModel) === p)
    : undefined;
  if (preferredByModel) {
    const apiKey = resolveApiKey(preferredByModel, config);
    if (apiKey) return { provider: preferredByModel, apiKey, model: configuredModel! };
  }
  for (const p of providers) {
    const apiKey = resolveApiKey(p, config);
    if (apiKey) {
      const configured = configuredModel;
      return {
        provider: p,
        apiKey,
        model: configured && modelSuitsProvider(configured, p) ? configured : DEFAULT_MODELS[p],
      };
    }
  }

  return null;
}

export { DEFAULT_MODELS, ENV_KEYS };
