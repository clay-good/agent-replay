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

/**
 * A config file that EXISTS but cannot be used — unparseable, unreadable, or
 * not a file at all.
 *
 * Distinct from "no config file", and the distinction is the whole point. Every
 * read failure used to collapse to `null`, which the commands rendered as
 * *"No configuration found. Run `agent-replay init` first."* — so one stray
 * trailing comma from a hand-edit told the user their config was ABSENT while
 * it sat on disk with their API key in it, `init` answered *"Already
 * initialized … Use --force"*, and the two messages contradicted each other
 * with neither naming the parse error. `test-ai` and `eval` reported "No AI
 * provider configured" for a key that was right there.
 */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

/**
 * Parse the config file without dropping unusable values.
 *
 * `loadConfig` sanitizes on read, which is right for consumers — one bad key
 * must not make the whole config unreadable. But a WRITER must start from the
 * file as it is: `config set` saved the sanitized copy back, so setting an
 * unrelated key permanently deleted the invalid `ai.max_tokens` the user was
 * being warned about, leaving nothing to fix and no sign it had happened.
 *
 * Throws {@link ConfigFileError} for a file that exists but cannot be read.
 */
export function loadRawConfig(dir?: string): AgentReplayConfig | null {
  const path = configPath(dir);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new ConfigFileError(
      `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as AgentReplayConfig;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new ConfigFileError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The config file's usable contents, or `null` if there is no config file.
 *
 * Throws {@link ConfigFileError} if a file IS there but cannot be used, so a
 * broken config is never reported as a missing one.
 */
export function loadConfig(dir?: string): AgentReplayConfig | null {
  const config = sanitizeConfig(loadRawConfig(dir));
  // `database` is DERIVED, never read back from the file.
  //
  // `init` writes an absolute path, and nothing has ever opened the store
  // through it — every command resolves `<data dir>/traces.db` itself. So the
  // moment a project is copied, moved, or cloned onto another machine (which
  // `sanitizeConfig` above already names as the thing that happens to config
  // files), the file went on naming a store belonging to somewhere else, and
  // `config list` / `config get database` answered with it. The dangerous shape
  // is not the missing file: it is the path that still EXISTS, so the one
  // question this field is here to answer — "which database am I looking at?" —
  // was answered with a real, wrong, plausible store.
  //
  // Same rule as `effective_tokens` and the displayed duration in the trace
  // model: a value the tool can compute exactly is reported as computed, not as
  // whatever an old copy of a file says. `configProblems` reports the
  // disagreement so an edited value is visibly ignored rather than silently
  // swapped.
  if (config) config.database = storePath(dir);
  return config;
}

/** The store every command opens for this data directory. */
export function storePath(dir?: string): string {
  return join(resolve(resolveDataDir(dir)), 'traces.db');
}

/**
 * Drop values a hand-edited config file can hold that the writers reject.
 *
 * `config set` validates every key, and then nothing validated them on READ —
 * so the validation was bypassed by editing the file, which is exactly how a
 * config gets copied between machines. A non-numeric or negative
 * `ai.max_tokens` was the expensive one: it flowed into the AI cost estimate,
 * making it `NaN`, and `NaN > maxCost` is FALSE, so `--max-cost 0` — the only
 * spend guard on paid evals — passed everything through. It was forwarded to
 * the provider as `max_tokens` besides.
 *
 * An unusable value is dropped rather than rejected, so one bad key never makes
 * the whole config unreadable: the field falls back to its default, which is
 * what a missing key already does.
 */
function sanitizeConfig(config: AgentReplayConfig | null): AgentReplayConfig | null {
  if (!config || typeof config !== 'object') return null;
  const ai = config.ai;
  if (ai && typeof ai === 'object') {
    for (const problem of aiConfigProblems(ai)) delete ai[problem.key];
  }
  return config;
}

/** A value inside `ai` that the loader drops — the key is deleted by name. */
export interface AiConfigProblem {
  key: 'max_tokens' | 'provider';
  message: string;
}

/**
 * Anything the file says that the tool does not act on. `database` joins the
 * `ai` keys here for the same reason they are reported: a value that looks
 * effective and is not.
 */
export type ConfigProblem = AiConfigProblem | { key: 'database'; message: string };

/**
 * Unusable `ai` values, named. Dropping them keeps the tool working, but a
 * silently ignored key is a typo the user never hears about — `config list` and
 * `config test-ai` report these so the diagnostic commands stay honest about
 * what is actually in effect.
 */
export function aiConfigProblems(ai: AiConfig | undefined): AiConfigProblem[] {
  if (!ai || typeof ai !== 'object') return [];
  const problems: AiConfigProblem[] = [];
  const t = ai.max_tokens;
  if (t != null && !(typeof t === 'number' && Number.isInteger(t) && t > 0)) {
    problems.push({
      key: 'max_tokens',
      message: `ai.max_tokens must be a positive integer (found ${JSON.stringify(t)}) — ignoring it.`,
    });
  }
  const valid = ['anthropic', 'google', 'openai', 'auto'];
  if (ai.provider != null && !valid.includes(ai.provider)) {
    problems.push({
      key: 'provider',
      message: `ai.provider ${JSON.stringify(ai.provider)} is not one of ${valid.join(', ')} — auto-detecting instead.`,
    });
  }
  return problems;
}

/** The problems in the config file on disk, before sanitizing drops them. */
export function configProblems(dir?: string): ConfigProblem[] {
  const path = configPath(dir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as AgentReplayConfig;
    const problems: ConfigProblem[] = [...aiConfigProblems(raw?.ai)];
    // A stored `database` that is not the store in use: nothing opens it, so
    // leaving it unmentioned would make a hand-edited value look effective and
    // a copied project's stale value look current.
    const inUse = storePath(dir);
    if (typeof raw?.database === 'string' && raw.database !== inUse) {
      problems.push({
        key: 'database',
        message:
          `config "database" says ${raw.database}, but this directory's store is ${inUse}. ` +
          'Nothing opens the stored path — it is a record of where the store was when `init` ran, ' +
          'and a copied or moved project keeps naming the original. Remove the field, or re-run ' +
          '`agent-replay init --force`, to stop this being reported.',
      });
    }
    return problems;
  } catch {
    return [];
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

  // Config file. A BLANK stored key is not a key: `config set
  // ai.api_keys.anthropic ""` used to store `''`, which `config get` then
  // displayed as `***` — indistinguishable from a real key — while every
  // truthiness test downstream treated it as absent, so `test-ai` told the user
  // to set the key they had just set. Normalize it to "not configured" here,
  // which is what the rest of the code already assumed.
  const fromFile = config?.ai?.api_keys?.[provider];
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile : null;
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
      const configured = config?.ai?.model;
      return {
        provider: preferred,
        apiKey,
        // Same rule as the auto path below: a model is applied only to a provider
        // it belongs to. An explicit `ai.provider = openai` with a leftover
        // `ai.model = claude-*` otherwise sent that name to OpenAI — a confusing
        // auth/400 error at eval time — and priced the request off Anthropic's
        // sheet, so `--max-cost` gated on a number for a different vendor. A
        // model of no known family (a proxy's own name) still passes through.
        // The blank check matters as much as the family check: `modelOwner('')`
        // is null, and a null owner means "suits any provider", so an empty
        // `ai.model` beat DEFAULT_MODELS and was sent to the provider AS the
        // model name (`Testing anthropic ()`). The auto path below already
        // guarded on truthiness, so the same config behaved differently
        // depending on whether `ai.provider` was explicit.
        model: typeof configured === 'string' && configured.trim() !== ''
          && modelSuitsProvider(configured, preferred)
          ? configured
          : DEFAULT_MODELS[preferred],
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
  const configuredModel =
    typeof config?.ai?.model === 'string' && config.ai.model.trim() !== ''
      ? config.ai.model
      : undefined;
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
