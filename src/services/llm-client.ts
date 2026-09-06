// ── Types ────────────────────────────────────────────────────────────────

export interface LlmClientOptions {
  provider: 'anthropic' | 'google' | 'openai';
  api_key: string;
  model?: string;
  max_tokens?: number;
  /** Per-attempt deadline. Defaults to DEFAULT_TIMEOUT_MS. */
  timeout_ms?: number;
  /** Retries after the first attempt for transient failures. Defaults to DEFAULT_MAX_RETRIES. */
  max_retries?: number;
  /** First backoff delay; doubles per retry. Defaults to DEFAULT_RETRY_BASE_DELAY_MS. */
  retry_base_delay_ms?: number;
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
  /**
   * The provider stopped because the answer hit the token ceiling, so `text` is
   * a PREFIX of what the model was writing.
   *
   * Every provider states this outright and it was read by nobody, which left
   * the callers to infer a cut-off answer from the wreckage: the AI diff hit an
   * unparseable JSON object and presented a `better_trace: "neither"` verdict
   * the model never gave, and the AI eval stored `score: 0, passed: false` for
   * a run it never finished judging. Both are recoverable by raising
   * `--max-tokens`, which neither could say because neither knew.
   *
   * Absent rather than `false` when the provider reported a normal stop, so a
   * response from a shape this does not recognize is never claimed to be
   * complete.
   */
  truncated?: true;
  model: string;
  provider: string;
  cost_estimate_usd: number;
  latency_ms: number;
  /**
   * How many attempts the provider is likely to have billed for. Present only
   * when more than one — a timed-out attempt that the provider completed anyway
   * is charged, so `cost_estimate_usd` covers all of them.
   */
  billable_attempts?: number;
}

export class LlmError extends Error {
  /** Delay the provider asked for via `Retry-After`, when it sent one. */
  retryAfterMs?: number;

  /**
   * True when OUR deadline aborted the request, rather than the connection
   * failing. The distinction matters for cost: a provider that generated the
   * completion and answered after our deadline still bills for it, so a retry
   * after a timeout is a second charge, while a connection that never landed
   * is not billed at all.
   */
  timedOut?: boolean;

  constructor(
    message: string,
    public type: 'network' | 'auth' | 'rate_limit' | 'server' | 'request' | 'parse',
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

// ── Retry / timeout policy ──────────────────────────────────────────────

/**
 * A provider call gets a deadline and a bounded retry budget because `eval --ai`,
 * `diff --ai` and `config test-ai` are meant to run unattended in CI. `fetch`
 * has NO default timeout, so a provider that accepts the connection and then
 * stalls used to hang the command forever — a hung CI job with no output. And a
 * single 429 or 503 (routine on a shared key) used to fail the whole run, which
 * for `eval --ai` means a red gate that says nothing about the trace.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** Ceiling on a single backoff wait, including one the provider asked for. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Only transient failures are retried. A 429, a 5xx and a network error/timeout
 * can succeed on a second attempt; an auth failure (bad key), a 4xx (malformed
 * request) and a parse failure cannot, and retrying them just triples the wait
 * before the same error surfaces.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.type === 'network' || err.type === 'rate_limit') return true;
  return err.type === 'server' && err.statusCode != null && err.statusCode >= 500;
}

function backoffMs(err: unknown, attempt: number, baseDelayMs: number): number {
  const asked = err instanceof LlmError ? err.retryAfterMs : undefined;
  const delay = asked ?? baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Main entry ──────────────────────────────────────────────────────────

export async function callLlm(
  opts: LlmClientOptions,
  request: LlmRequest,
): Promise<LlmResponse> {
  const model = opts.model ?? DEFAULT_MODELS[opts.provider];
  const maxTokens = request.max_tokens ?? opts.max_tokens ?? 1024;
  const timeoutMs = positive(opts.timeout_ms) ?? DEFAULT_TIMEOUT_MS;
  const baseDelayMs = positive(opts.retry_base_delay_ms) ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const retries = Number.isFinite(opts.max_retries as number)
    ? Math.max(0, Math.trunc(opts.max_retries as number))
    : DEFAULT_MAX_RETRIES;

  // `start` is taken once, so latency_ms covers every attempt and the waits
  // between them — the wall-clock cost the caller actually paid.
  const start = Date.now();

  // Attempts our own deadline aborted. A provider that finished generating and
  // answered late still bills for that work, so the retry is a SECOND charge —
  // but `cost_estimate_usd` was computed from the final attempt's usage alone,
  // under-reporting spend by up to the retry count. That number feeds
  // `eval --ai`'s running total and its `--max-cost` gate, so the budget meant
  // to cap spend was reading a floor. A 429 or a 5xx is not counted: the
  // provider produced nothing to bill for.
  let billableAborts = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await callProvider(opts, model, maxTokens, request, start, timeoutMs);
      if (billableAborts === 0) return response;
      // The aborted attempts ran the same request, so the completed one is the
      // best available proxy for what each of them cost. Approximate, and
      // deliberately on the high side: a budget should over-estimate.
      return {
        ...response,
        cost_estimate_usd: response.cost_estimate_usd * (1 + billableAborts),
        billable_attempts: 1 + billableAborts,
      };
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) throw err;
      if (err instanceof LlmError && err.timedOut) billableAborts++;
      await sleep(backoffMs(err, attempt, baseDelayMs));
    }
  }
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function callProvider(
  opts: LlmClientOptions,
  model: string,
  maxTokens: number,
  request: LlmRequest,
  start: number,
  timeoutMs: number,
): Promise<LlmResponse> {
  switch (opts.provider) {
    case 'anthropic':
      return callAnthropic(opts.api_key, model, maxTokens, request, start, timeoutMs);
    case 'google':
      return callGoogle(opts.api_key, model, maxTokens, request, start, timeoutMs);
    case 'openai':
      return callOpenai(opts.api_key, model, maxTokens, request, start, timeoutMs);
    default:
      throw new LlmError(`Unsupported provider: ${opts.provider}`, 'parse', opts.provider);
  }
}

/**
 * The published rate for a model, or `null` when this build does not know one.
 *
 * Real model ids are versioned variants of a base id (`gpt-5.4-nano-2025-12-01`,
 * `claude-haiku-4-5` without the date), so after an exact lookup we try a
 * family/prefix match.
 */
function lookupModelRate(model: string): { input: number; output: number } | null {
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
  return null;
}

/**
 * Whether this build knows a published rate for `model`.
 *
 * `COST_TABLE` holds the three DEFAULT models and nothing else, so anyone who
 * runs `config set ai.model` with a larger model — an Opus, a Sonnet, a GPT-5,
 * a Gemini Pro — is priced by the fallback below. Callers that show a cost, or
 * decide something with one, are expected to say when that is what happened.
 */
export function modelRateIsKnown(model: string): boolean {
  return lookupModelRate(model) != null;
}

/**
 * Resolve the per-1M-token rate for a model, falling back for an unknown one to
 * the most expensive rate in the table — never a rate of 0. A 0 would make
 * `estimateCost` report a misleading "$0.00" and, worse, silently defeat the
 * `eval --max-cost` budget cap (which gates on `estimate > cap`, and 0 never
 * exceeds it).
 *
 * THE FALLBACK IS NOT AN UPPER BOUND ON REALITY, only on what is listed. This
 * comment used to say "never cheaper than reality", which held when every
 * plausible model was in the table and stopped holding once the table shrank to
 * the three cheap defaults: an unlisted model priced above all of them — which
 * is most of them — is estimated far too low, and `--max-cost` then clears a
 * run that costs many times the cap. That is why `modelRateIsKnown` exists and
 * why the pre-gate says so out loud rather than quietly guessing.
 */
function resolveModelRate(model: string): { input: number; output: number } {
  const known = lookupModelRate(model);
  if (known) return known;
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
 * An unknown model is priced at the highest rate this build KNOWS (see
 * resolveModelRate) rather than at a false zero — which is a floor, not a
 * ceiling. Ask `modelRateIsKnown` before presenting the number as the model's
 * price or deciding a budget with it.
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
  timeoutMs: number,
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: request.prompt }],
  };
  if (request.system) {
    body.system = request.system;
  }

  const data = await requestJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, 'anthropic', timeoutMs);

  const text = (data.content as Array<{ text: string }>)?.[0]?.text ?? '';
  const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(data.stop_reason === 'max_tokens' ? { truncated: true as const } : {}),
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
  timeoutMs: number,
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

  const data = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  }, 'google', timeoutMs);

  const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> }; finishReason?: string }> | undefined;
  const text = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usageMeta = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  const inputTokens = usageMeta?.promptTokenCount ?? 0;
  const outputTokens = usageMeta?.candidatesTokenCount ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(candidates?.[0]?.finishReason === 'MAX_TOKENS' ? { truncated: true as const } : {}),
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
  timeoutMs: number,
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

  const data = await requestJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'openai', timeoutMs);

  const choices = data.choices as Array<{ message: { content: string }; finish_reason?: string }> | undefined;
  const text = choices?.[0]?.message?.content ?? '';
  const usage = data.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  return {
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(choices?.[0]?.finish_reason === 'length' ? { truncated: true as const } : {}),
    model,
    provider: 'openai',
    cost_estimate_usd: estimateCost(model, inputTokens, outputTokens),
    latency_ms: Date.now() - start,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────

/**
 * Send one request and parse its JSON under a single deadline.
 *
 * The timer stays armed across the BODY read, not just the connect: a provider
 * can send headers promptly and then stall mid-stream, and aborting only the
 * connect phase would leave that case hanging forever. Because the abort makes
 * `res.json()` reject, the aborted flag is what separates a real timeout from a
 * genuinely malformed body — otherwise a timeout would be reported as a parse
 * error and (correctly, for a parse error) never retried.
 */
async function requestJson(
  url: string,
  init: RequestInit,
  provider: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw networkError(err, provider, timeoutMs, controller.signal.aborted);
    }

    // Check for HTTP errors before parsing — error responses may not be valid JSON
    if (res.status < 200 || res.status >= 300) {
      let data: Record<string, unknown> = {};
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON error response — pass empty data so handleHttpError uses status code
      }
      handleHttpError(res.status, data, provider, retryAfterMs(res));
    }

    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (controller.signal.aborted) throw networkError(err, provider, timeoutMs, true);
      throw new LlmError('Failed to parse response JSON', 'parse', provider, res.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

function networkError(
  err: unknown,
  provider: string,
  timeoutMs: number,
  timedOut: boolean,
): LlmError {
  const msg = timedOut
    ? `Request timed out after ${timeoutMs}ms`
    : `Network error: ${err instanceof Error ? err.message : String(err)}`;
  const error = new LlmError(msg, 'network', provider, undefined, { cause: err });
  error.timedOut = timedOut;
  return error;
}

/**
 * `Retry-After` in delay-seconds form. The HTTP-date form is allowed by the spec
 * but no supported provider sends it, and guessing wrong is worse than falling
 * back to our own backoff, so anything non-numeric is ignored.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get('retry-after');
  if (raw == null) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function handleHttpError(
  status: number,
  data: Record<string, unknown>,
  provider: string,
  retryAfter?: number,
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
  // A 4xx is OUR request's problem, not the provider's. Labelling a 400 or a 404
  // "Server error" pointed the reader at the wrong party — a malformed request,
  // an unknown model name or a wrong endpoint all read as a provider outage, so
  // the natural next step was "wait and retry" when the fix is local. Retry
  // behavior is unchanged: retryability already keyed off `statusCode >= 500`,
  // so these were never retried; only the message was misleading.
  const err = status === 429
    ? new LlmError(`Rate limited: ${msg}`, 'rate_limit', provider, status)
    : status < 500
      ? new LlmError(`Request rejected (HTTP ${status}): ${msg}`, 'request', provider, status)
      : new LlmError(`Server error: ${msg}`, 'server', provider, status);
  err.retryAfterMs = retryAfter;
  throw err;
}
