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
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// ── Cost table (per 1M tokens) ──────────────────────────────────────────

export const COST_TABLE: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
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
 * Estimate the cost of a request given an approximate input token count.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number = 1024,
): number {
  const costs = COST_TABLE[model];
  if (!costs) return 0;
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
  handleHttpError(res.status, data, 'anthropic');

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'google');

  const data = await safeJson(res, 'google');
  handleHttpError(res.status, data, 'google');

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

  const body = { model, max_tokens: maxTokens, messages };

  const res = await safeFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'openai');

  const data = await safeJson(res, 'openai');
  handleHttpError(res.status, data, 'openai');

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
    throw new LlmError(`Network error: ${msg}`, 'network', provider);
  }
}

async function safeJson(res: Response, provider: string): Promise<Record<string, unknown>> {
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
