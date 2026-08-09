// ── Types ────────────────────────────────────────────────────────────────

export interface LlmClientOptions {
  provider: 'anthropic' | 'google' | 'openai';
  api_key: string;
  model?: string;
  max_tokens?: number;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  max_tokens?: number;
}

export interface LlmResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
  provider: string;
  cost_estimate_usd: number;
  latency_ms: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public type: 'network' | 'auth' | 'rate_limit' | 'server' | 'parse',
    public provider: string,
    public statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

// ── Cost table (per 1M tokens) ──────────────────────────────────────────

export const COST_TABLE: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash-lite',
  openai: 'gpt-5.4-nano',
};

// ── Main entry ──────────────────────────────────────────────────────────

export async function callLlm(
  opts: LlmClientOptions,
  request: LlmRequest,
): Promise<LlmResponse> {
  const model = opts.model ?? DEFAULT_MODELS[opts.provider];
  const maxTokens = request.max_tokens ?? opts.max_tokens ?? 1024;

  const start = Date.now();

  switch (opts.provider) {
    case 'anthropic':
      return callAnthropic(opts.api_key, model, maxTokens, request, start);
    case 'google':
      return callGoogle(opts.api_key, model, maxTokens, request, start);
    case 'openai':
      return callOpenai(opts.api_key, model, maxTokens, request, start);
    default:
      throw new LlmError(`Unsupported provider: ${opts.provider}`, 'parse', opts.provider);
  }
}

/**
 * Resolve the per-1M-token rate for a model.
 *
 * Real model ids are versioned variants of a base id (`gpt-5.4-nano-2025-12-01`,
 * `claude-haiku-4-5` without the date), so after an exact lookup we try a
 * family/prefix match. A genuinely unknown model falls back to the most
 * expensive known rate — never a rate of 0. A 0 would make `estimateCost`
 * report a misleading "$0.00" and, worse, silently defeat the `eval --max-cost`
 * budget cap (which gates on `estimate > cap`, and 0 never exceeds it).
 */
function resolveModelRate(model: string): { input: number; output: number } {
  const exact = COST_TABLE[model];
  if (exact) return exact;
  // A family match may only borrow a rate when one id extends the other at a
  // VERSION/DATE boundary (`-<digits>`, e.g. `claude-haiku-4-5` vs
  // `claude-haiku-4-5-20251001`). A non-numeric extension is a DIFFERENT variant
  // with its own pricing (`gemini-2.5-flash` vs the cheaper `gemini-2.5-flash-lite`,
  // `gpt-5` vs `gpt-5-pro`); borrowing across it can under-price a pricier model
  // and silently defeat the `--max-cost` cap. Such models fall through to the
  // conservative max-rate fallback instead (never cheaper than reality).
  for (const [key, rate] of Object.entries(COST_TABLE)) {
    if (isVersionExtension(model, key) || isVersionExtension(key, model)) return rate;
  }
  const rates = Object.values(COST_TABLE);
  return {
    input: Math.max(...rates.map((r) => r.input)),
    output: Math.max(...rates.map((r) => r.output)),
  };
}

/** True if `long` is `short` extended by a `-<digits...>` version/date suffix. */
function isVersionExtension(long: string, short: string): boolean {
  return long.startsWith(short + '-') && /^\d/.test(long.slice(short.length + 1));
}

/**
 * Estimate the cost of a request given an approximate input token count.
 * An unknown model is priced conservatively (see resolveModelRate), so the
 * estimate errs high rather than reporting a false zero.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number = 1024,
): number {
  const costs = resolveModelRate(model);
  return (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;
}

// ── Anthropic ───────────────────────────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  model: string,
  maxTokens: number,
  request: LlmRequest,
  start: number,
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: request.prompt }],
  };
  if (request.system) {
    body.system = request.system;
  }

  const res = await safeFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, 'anthropic');

  const data = await safeJson(res, 'anthropic');

  const text = (data.content as Array<{ text: string }>)?.[0]?.text ?? '';
  const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model,
    provider: 'anthropic',
    cost_estimate_usd: estimateCost(model, inputTokens, outputTokens),
    latency_ms: Date.now() - start,
  };
}

// ── Google Gemini ───────────────────────────────────────────────────────

async function callGoogle(
  apiKey: string,
  model: string,
  maxTokens: number,
  request: LlmRequest,
  start: number,
): Promise<LlmResponse> {
  // Gemini basic API: system prompt prepended to user content
  const userContent = request.system
    ? `${request.system}\n\n${request.prompt}`
    : request.prompt;

  const body = {
    contents: [{ parts: [{ text: userContent }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  }, 'google');

  const data = await safeJson(res, 'google');

  const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }> | undefined;
  const text = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usageMeta = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  const inputTokens = usageMeta?.promptTokenCount ?? 0;
  const outputTokens = usageMeta?.candidatesTokenCount ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model,
    provider: 'google',
    cost_estimate_usd: estimateCost(model, inputTokens, outputTokens),
    latency_ms: Date.now() - start,
  };
}

// ── OpenAI ──────────────────────────────────────────────────────────────

async function callOpenai(
  apiKey: string,
  model: string,
  maxTokens: number,
  request: LlmRequest,
  start: number,
): Promise<LlmResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) {
    messages.push({ role: 'system', content: request.system });
  }
  messages.push({ role: 'user', content: request.prompt });

  // Use `max_completion_tokens`, not the legacy `max_tokens`. The default
  // OpenAI model here is a GPT-5-family model (`gpt-5.4-nano`), and OpenAI's
  // chat/completions endpoint rejects `max_tokens` for GPT-5 / o-series
  // (reasoning-class) models with a 400 ("Unsupported parameter: 'max_tokens'
  // ... Use 'max_completion_tokens' instead."). `max_completion_tokens` is the
  // current field and is accepted by GPT-4o-and-later as well, so it is the
  // forward-compatible choice for every model this adapter targets.
  const body = { model, max_completion_tokens: maxTokens, messages };

  const res = await safeFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'openai');

  const data = await safeJson(res, 'openai');

  const choices = data.choices as Array<{ message: { content: string } }> | undefined;
  const text = choices?.[0]?.message?.content ?? '';
  const usage = data.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model,
    provider: 'openai',
    cost_estimate_usd: estimateCost(model, inputTokens, outputTokens),
    latency_ms: Date.now() - start,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────

async function safeFetch(
  url: string,
  init: RequestInit,
  provider: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmError(`Network error: ${msg}`, 'network', provider, undefined, { cause: err });
  }
}

async function safeJson(res: Response, provider: string): Promise<Record<string, unknown>> {
  // Check for HTTP errors before parsing — error responses may not be valid JSON
  if (res.status < 200 || res.status >= 300) {
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error response — pass empty data so handleHttpError uses status code
    }
    handleHttpError(res.status, data, provider);
  }

  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LlmError('Failed to parse response JSON', 'parse', provider, res.status);
  }
}

function handleHttpError(
  status: number,
  data: Record<string, unknown>,
  provider: string,
): void {
  if (status >= 200 && status < 300) return;

  // Extract error message from various provider response formats
  const errorObj = data.error as Record<string, unknown> | undefined;
  const msg = (errorObj?.message as string)
    ?? (data.message as string)
    ?? `HTTP ${status}`;

  if (status === 401 || status === 403) {
    throw new LlmError(`Authentication failed: ${msg}`, 'auth', provider, status);
  }
  if (status === 429) {
    throw new LlmError(`Rate limited: ${msg}`, 'rate_limit', provider, status);
  }
  throw new LlmError(`Server error: ${msg}`, 'server', provider, status);
}
