import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveApiKey,
  resolveProvider,
} from '../src/services/config-service.js';
import type { AgentReplayConfig } from '../src/services/config-service.js';

const TEST_DIR = join(tmpdir(), `ar-config-test-${Date.now()}`);

function makeConfig(overrides: Partial<AgentReplayConfig> = {}): AgentReplayConfig {
  return {
    version: '0.1.0',
    database: join(TEST_DIR, 'traces.db'),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('config-service', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    // Clean up env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  describe('loadConfig / saveConfig', () => {
    it('returns null when config does not exist', () => {
      expect(loadConfig(join(TEST_DIR, 'nonexistent'))).toBeNull();
    });

    it('saves and loads config', () => {
      const config = makeConfig();
      saveConfig(config, TEST_DIR);
      const loaded = loadConfig(TEST_DIR);
      expect(loaded).toEqual(config);
    });

    it('loads config with ai section', () => {
      const config = makeConfig({ ai: { provider: 'anthropic', api_keys: { anthropic: 'sk-test-123' } } });
      saveConfig(config, TEST_DIR);
      const loaded = loadConfig(TEST_DIR);
      expect(loaded?.ai?.provider).toBe('anthropic');
      expect(loaded?.ai?.api_keys?.anthropic).toBe('sk-test-123');
    });
  });

  describe('getConfigValue', () => {
    it('gets top-level values', () => {
      const config = makeConfig();
      expect(getConfigValue(config, 'version')).toBe('0.1.0');
    });

    it('gets nested values with dot notation', () => {
      const config = makeConfig({ ai: { provider: 'google', api_keys: { google: 'key123' } } });
      expect(getConfigValue(config, 'ai.provider')).toBe('google');
      expect(getConfigValue(config, 'ai.api_keys.google')).toBe('key123');
    });

    it('returns undefined for missing keys', () => {
      const config = makeConfig();
      expect(getConfigValue(config, 'ai.nonexistent')).toBeUndefined();
    });
  });

  describe('setConfigValue', () => {
    it('sets nested values', () => {
      const config = makeConfig();
      setConfigValue(config, 'ai.provider', 'openai');
      expect(config.ai?.provider).toBe('openai');
    });

    it('creates intermediate objects', () => {
      const config = makeConfig();
      setConfigValue(config, 'ai.api_keys.anthropic', 'sk-test');
      expect((config.ai as Record<string, unknown>)?.api_keys).toBeDefined();
    });
  });

  describe('resolveApiKey', () => {
    it('prefers env var over config', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const config = makeConfig({ ai: { api_keys: { anthropic: 'config-key' } } });
      expect(resolveApiKey('anthropic', config)).toBe('env-key');
    });

    it('falls back to config when no env var', () => {
      const config = makeConfig({ ai: { api_keys: { anthropic: 'config-key' } } });
      expect(resolveApiKey('anthropic', config)).toBe('config-key');
    });

    it('returns null when no key available', () => {
      const config = makeConfig();
      expect(resolveApiKey('anthropic', config)).toBeNull();
    });

    it('works with null config', () => {
      process.env.GOOGLE_API_KEY = 'gkey';
      expect(resolveApiKey('google', null)).toBe('gkey');
    });
  });

  describe('resolveProvider', () => {
    it('auto-detects anthropic first', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      process.env.GOOGLE_API_KEY = 'goo-key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto' } }));
      expect(result?.provider).toBe('anthropic');
      expect(result?.apiKey).toBe('ant-key');
    });

    it('auto-detects google when anthropic unavailable', () => {
      process.env.GOOGLE_API_KEY = 'goo-key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto' } }));
      expect(result?.provider).toBe('google');
    });

    it('auto-detects openai as last resort', () => {
      process.env.OPENAI_API_KEY = 'oai-key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto' } }));
      expect(result?.provider).toBe('openai');
    });

    it('returns null when no provider available', () => {
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto' } }));
      expect(result).toBeNull();
    });

    it('respects explicit provider selection', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      process.env.GOOGLE_API_KEY = 'goo-key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'google' } }));
      expect(result?.provider).toBe('google');
      expect(result?.apiKey).toBe('goo-key');
    });

    it('returns null when explicit provider has no key', () => {
      const result = resolveProvider(makeConfig({ ai: { provider: 'openai' } }));
      expect(result).toBeNull();
    });

    it('uses default model for provider', () => {
      process.env.ANTHROPIC_API_KEY = 'key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto' } }));
      expect(result?.model).toBe('claude-haiku-4-5-20251001');
    });

    it('respects custom model override', () => {
      process.env.ANTHROPIC_API_KEY = 'key';
      const result = resolveProvider(makeConfig({ ai: { provider: 'auto', model: 'claude-sonnet-4-6' } }));
      expect(result?.model).toBe('claude-sonnet-4-6');
    });
  });
});
