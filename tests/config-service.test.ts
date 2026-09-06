import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveApiKey,
  resolveProvider,
  configProblems,
  loadRawConfig,
  ConfigFileError,
  configPath,
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

    it('writes the config owner-only (it can hold API keys)', () => {
      if (process.platform === 'win32') return; // POSIX permissions only
      saveConfig(makeConfig({ ai: { provider: 'anthropic', api_keys: { anthropic: 'sk-secret' } } }), TEST_DIR);
      const mode = statSync(join(TEST_DIR, 'config.json')).mode & 0o777;
      expect(mode).toBe(0o600); // -rw------- : not group/world readable
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

describe('resolveProvider with a model from another provider', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.OPENAI_API_KEY = 'openai-key';
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('does not send a configured Claude model to an auto-detected OpenAI key', () => {
    // `ai.model` was applied to WHATEVER provider auto-detection found, so a
    // config naming a Claude model on a machine holding only an OpenAI key sent
    // the Claude name to OpenAI: every eval failed with an opaque server error,
    // and the --max-cost gate priced the run off Anthropic's rate sheet (about
    // 4x) while doing it.
    const config = { ai: { model: 'claude-haiku-4-5-20251001' } } as never;
    const resolved = resolveProvider(config);
    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBe('openai');
    expect(resolved!.model).not.toBe('claude-haiku-4-5-20251001');
  });

  it('keeps a model that suits the resolved provider, and any unrecognized name', () => {
    expect(resolveProvider({ ai: { model: 'gpt-5.4-mini' } } as never)!.model).toBe('gpt-5.4-mini');
    // A model the cost table doesn't know is usually the user being right about
    // their own provider — pass it through.
    expect(resolveProvider({ ai: { model: 'my-finetune-v3' } } as never)!.model).toBe('my-finetune-v3');
  });

  it('lets a recognized model family choose its provider over the priority order', () => {
    // With two keys present, the fixed anthropic→google→openai order won over
    // the user's explicit ai.model: a different vendor was billed and the
    // results came from a model they had not chosen, with no warning.
    process.env.ANTHROPIC_API_KEY = 'ant-key';
    const resolved = resolveProvider({ ai: { model: 'gpt-5.4-nano' } } as never);
    expect(resolved!.provider).toBe('openai');
    expect(resolved!.model).toBe('gpt-5.4-nano');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('ignores a non-string ai.model instead of passing it to a provider', () => {
    // loadConfig does a bare JSON.parse with no schema check, so a hand-edited
    // `"model": 123` is reachable. It used to be passed through as "suits any
    // provider", moving the crash into the provider adapter — or sending the
    // number itself as the model name.
    process.env.ANTHROPIC_API_KEY = 'ant-key';
    const resolved = resolveProvider({ ai: { model: 123 } } as never);
    expect(resolved!.provider).toBe('anthropic');
    expect(typeof resolved!.model).toBe('string');
    expect(resolved!.model).not.toBe(123 as never);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('still honors a model when the provider is set explicitly', () => {
    const resolved = resolveProvider({ ai: { provider: 'openai', model: 'gpt-5.4-mini' } } as never);
    expect(resolved!.model).toBe('gpt-5.4-mini');
  });
});

describe('an explicit ai.provider with a model from another family', () => {
  // The auto-detect path already refused to hand a `claude-*` model to OpenAI;
  // the explicit branch applied any string, so a leftover model setting produced
  // a confusing auth/400 at eval time and priced `--max-cost` off the wrong
  // vendor's sheet.
  it('falls back to the provider\'s default model', () => {
    const resolved = resolveProvider({
      ai: { provider: 'openai', model: 'claude-haiku-4-5-20251001', api_keys: { openai: 'sk-o' } },
    } as unknown as Parameters<typeof resolveProvider>[0]);
    expect(resolved?.provider).toBe('openai');
    expect(resolved?.model).not.toMatch(/claude/);
  });

  it('still honors a model of no known family (a proxy\'s own name)', () => {
    const resolved = resolveProvider({
      ai: { provider: 'openai', model: 'my-proxy-model-v2', api_keys: { openai: 'sk-o' } },
    } as unknown as Parameters<typeof resolveProvider>[0]);
    expect(resolved?.model).toBe('my-proxy-model-v2');
  });

  it('honors a model that does belong to the chosen provider', () => {
    const resolved = resolveProvider({
      ai: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', api_keys: { anthropic: 'sk-a' } },
    } as unknown as Parameters<typeof resolveProvider>[0]);
    expect(resolved?.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('a hand-edited config cannot disable the spend cap', () => {
  // `config set` validates every key; nothing validated them on READ, so the
  // validation was bypassed by editing the file — which is exactly how a config
  // travels between machines. `ai.max_tokens` was the expensive one: it flows
  // into the AI cost estimate, and a non-numeric value makes that estimate NaN.
  // `NaN > maxCost` is FALSE, so `--max-cost 0` — the only spend guard on paid
  // evals — passed everything through. It was forwarded to the provider as
  // `max_tokens` besides.
  // `--dir` IS the store directory, not its parent, so config.json lives
  // directly inside it.
  const dir = join(tmpdir(), `ar-config-bad-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(ai: unknown): void {
    writeFileSync(
      join(dir, 'config.json'),
      // A real store path for this directory: `database` is now derived and a
      // stored value that disagrees is reported as ignored, so a placeholder
      // here would add a problem these AI-config assertions do not mean to test.
      JSON.stringify({ version: '0.1.0', database: join(dir, 'traces.db'), created_at: 'now', ai }),
    );
  }

  it('reads the file this suite writes (guards the assertions below)', () => {
    // Without this, every "the bad value is dropped" case passes vacuously when
    // the path is wrong: no file found → null config → undefined field.
    write({ provider: 'anthropic', max_tokens: 4096 });
    expect(loadConfig(dir)).not.toBeNull();
  });

  it.each([
    ['a string', 'abc'],
    ['a negative number', -100000],
    ['zero', 0],
    ['a float', 12.5],
    ['null-ish text', ''],
  ])('drops ai.max_tokens when it is %s', (_label, value) => {
    write({ provider: 'anthropic', max_tokens: value });
    expect(loadConfig(dir)?.ai?.max_tokens).toBeUndefined();
  });

  it('keeps a usable ai.max_tokens', () => {
    write({ provider: 'anthropic', max_tokens: 4096 });
    expect(loadConfig(dir)?.ai?.max_tokens).toBe(4096);
  });

  // A typo'd provider used to produce "No AI provider configured" — advising the
  // very env var that was already set and would have worked.
  it('falls back to auto-detection for an unknown provider, and still resolves', () => {
    write({ provider: 'claude' });
    const config = loadConfig(dir);
    expect(config?.ai?.provider).toBeUndefined();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      expect(resolveProvider(config)?.provider).toBe('anthropic');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  // Dropping a key keeps the tool working, but a silently ignored value is a
  // typo the user never hears about — the diagnostic commands report it.
  it('names every dropped key so the drop is not silent', () => {
    write({ provider: 'claude', max_tokens: 'abc' });
    expect(configProblems(dir).map((p) => p.key).sort()).toEqual(['max_tokens', 'provider']);
    expect(configProblems(dir).find((p) => p.key === 'provider')!.message).toMatch(/auto-detecting/);
  });

  it('reports nothing for a clean config', () => {
    write({ provider: 'anthropic', max_tokens: 1024 });
    expect(configProblems(dir)).toEqual([]);
  });
});


describe('a broken config file is not a missing one', () => {
  const DIR = join(tmpdir(), `ar-config-broken-${Date.now()}`);
  beforeEach(() => mkdirSync(DIR, { recursive: true }));
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('throws for a file that exists but is not valid JSON', () => {
    // Every read failure used to collapse to `null`, which the commands render
    // as "No configuration found. Run `agent-replay init` first." — while
    // `init` answers "Already initialized. Use --force." The two contradict
    // each other, neither names the parse error, and the user is sent to a
    // command that refuses to run. Meanwhile the stored API key is still on
    // disk, so `test-ai` said "No AI provider configured" about a real key.
    writeFileSync(join(DIR, 'config.json'), '{"ai": {"provider": "auto",}}');
    expect(() => loadConfig(DIR)).toThrow(ConfigFileError);
    expect(() => loadConfig(DIR)).toThrow(/is not valid JSON/);
  });

  it('throws for JSON that is not an object', () => {
    writeFileSync(join(DIR, 'config.json'), '"just a string"');
    expect(() => loadConfig(DIR)).toThrow(ConfigFileError);
  });

  it('names the file in the error, so the user knows what to fix', () => {
    writeFileSync(join(DIR, 'config.json'), '{oops');
    expect(() => loadConfig(DIR)).toThrow(configPath(DIR));
  });

  it('still returns null when there really is no config file', () => {
    // The distinction only helps if "absent" still reads as absent.
    expect(loadConfig(DIR)).toBeNull();
    expect(loadRawConfig(DIR)).toBeNull();
  });
});

describe('loadRawConfig does not drop what a writer must preserve', () => {
  const DIR = join(tmpdir(), `ar-config-raw-${Date.now()}`);
  beforeEach(() => mkdirSync(DIR, { recursive: true }));
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('keeps an unusable value that the sanitizing reader drops', () => {
    // `config set` writes back whatever it read. Reading through the sanitizer
    // meant setting an UNRELATED key permanently deleted the invalid
    // `ai.max_tokens` the user was being warned about — the typo became
    // unrecoverable and every later `config list` reported a clean config.
    writeFileSync(
      join(DIR, 'config.json'),
      JSON.stringify({ version: '1', ai: { provider: 'auto', max_tokens: '4096' } }),
    );
    expect(loadConfig(DIR)!.ai!.max_tokens).toBeUndefined(); // consumers: dropped
    expect(loadRawConfig(DIR)!.ai!.max_tokens).toBe('4096'); // writers: intact
  });
});

describe('a blank value is not a value', () => {
  // An env key would satisfy `resolveApiKey` before the config file is even
  // consulted, which would make these assertions pass for the wrong reason.
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('treats an empty stored API key as not configured', () => {
    // It used to be stored as `''`, which `config get` displayed as `***` —
    // looking set — while every truthiness test downstream treated it as
    // absent, so `test-ai` told the user to set the key they had just set.
    const cfg = makeConfig({ ai: { provider: 'anthropic', api_keys: { anthropic: '' } } } as Partial<AgentReplayConfig>);
    expect(resolveApiKey('anthropic', cfg)).toBeNull();
    expect(resolveProvider(cfg)).toBeNull();
  });

  it('falls back to the default model for a blank ai.model, however the provider was chosen', () => {
    // `modelOwner('')` is null, and a null owner means "suits any provider", so
    // an empty model beat DEFAULT_MODELS and was sent to the provider AS the
    // model name (`Testing anthropic ()`). The auto path guarded on
    // truthiness, so the SAME config behaved differently depending on whether
    // `ai.provider` was explicit.
    const explicit = resolveProvider(makeConfig({
      ai: { provider: 'anthropic', model: '', api_keys: { anthropic: 'sk-test' } },
    } as Partial<AgentReplayConfig>));
    const auto = resolveProvider(makeConfig({
      ai: { provider: 'auto', model: '', api_keys: { anthropic: 'sk-test' } },
    } as Partial<AgentReplayConfig>));

    expect(explicit!.model).not.toBe('');
    expect(explicit!.model).toBe(auto!.model); // the two paths now agree
  });
});

describe('a config file that names a store somewhere else', () => {
  // `init` writes an absolute `database` path and NOTHING opens the store
  // through it — every command resolves `<data dir>/traces.db` itself. So the
  // moment a project is copied, moved, or cloned onto another machine (the very
  // thing the AI-key sanitizing above exists for), the file went on naming a
  // store belonging to somewhere else and `config list` / `config get database`
  // answered with it. The dangerous case is not a path that has gone missing:
  // it is one that still EXISTS, so "which database am I looking at?" — the one
  // question this field answers — came back with a real, wrong, plausible file.
  const DIR = join(tmpdir(), `ar-config-moved-${Date.now()}`);
  const ELSEWHERE = '/somewhere/else/.agent-replay/traces.db';
  beforeEach(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      join(DIR, 'config.json'),
      JSON.stringify({ version: '0.2.0', database: ELSEWHERE, created_at: new Date().toISOString(), ai: { provider: 'auto' } }),
    );
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('reports the store this directory actually uses, not the stored path', () => {
    const config = loadConfig(DIR);
    expect(config?.database).toBe(join(DIR, 'traces.db'));
    expect(getConfigValue(config as AgentReplayConfig, 'database')).toBe(join(DIR, 'traces.db'));
  });

  it('says the stored path is being ignored, rather than swapping it silently', () => {
    // Same rule as the AI keys: a value that does not take effect is reported,
    // so a hand-edited path cannot look effective.
    const problems = configProblems(DIR);
    const stale = problems.find((p) => p.key === 'database');
    expect(stale, 'no problem reported for a stale database path').toBeDefined();
    expect(stale?.message).toContain(ELSEWHERE);
    expect(stale?.message).toContain(join(DIR, 'traces.db'));
    // A note about a state that persists has to say how to end it, or it is a
    // nag on every `config list` for the life of the project.
    expect(stale?.message).toMatch(/Remove the field|init --force/);
  });

  it('is silent when the stored path is the store in use', () => {
    // The guard has to stay quiet in the ordinary case, or it is noise on every
    // `config list` a normal project runs.
    writeFileSync(
      join(DIR, 'config.json'),
      JSON.stringify({ version: '0.2.0', database: join(DIR, 'traces.db'), created_at: new Date().toISOString(), ai: {} }),
    );
    expect(configProblems(DIR).some((p) => p.key === 'database')).toBe(false);
  });
});
