import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  google: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
};

// ── Env var names ────────────────────────────────────────────────────────

const ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// ── Config I/O ───────────────────────────────────────────────────────────

export function configPath(dir?: string): string {
  return join(resolve(dir ?? '.agent-replay'), 'config.json');
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
export function resolveProvider(config: AgentReplayConfig | null): ResolvedProvider | null {
  const preferred = config?.ai?.provider ?? 'auto';

  if (preferred !== 'auto') {
    const apiKey = resolveApiKey(preferred, config);
    if (apiKey) {
      return {
        provider: preferred,
        apiKey,
        model: config?.ai?.model ?? DEFAULT_MODELS[preferred],
      };
    }
    // Explicit provider set but no key — return null
    return null;
  }

  // Auto-detect: try in priority order
  const providers: Array<'anthropic' | 'google' | 'openai'> = ['anthropic', 'google', 'openai'];
  for (const p of providers) {
    const apiKey = resolveApiKey(p, config);
    if (apiKey) {
      return {
        provider: p,
        apiKey,
        model: config?.ai?.model ?? DEFAULT_MODELS[p],
      };
    }
  }

  return null;
}

export { DEFAULT_MODELS, ENV_KEYS };
