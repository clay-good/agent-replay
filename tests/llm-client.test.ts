import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLlm } from '../src/services/llm-client.js';

/**
 * The three provider adapters (Anthropic/Google/OpenAI) build a request and
 * parse a response whose shapes differ per provider. They make a real network
 * call, so a stubbed global fetch locks the request wiring, the response
 * parsing (text + the provider-specific token fields), and the error
 * classification without touching the network.
 */

function res(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('callLlm — provider request/response parsing', () => {
  it('anthropic: builds the request and parses text + input/output_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, {
      content: [{ text: 'hello from claude' }],
      usage: { input_tokens: 30, output_tokens: 7 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await callLlm(
      { provider: 'anthropic', api_key: 'sk-x', model: 'claude-haiku-4-5-20251001' },
      { system: 'sys', prompt: 'hi' },
    );
    expect(out.text).toBe('hello from claude');
    expect(out.input_tokens).toBe(30);
    expect(out.output_tokens).toBe(7);
    expect(out.provider).toBe('anthropic');
    expect(out.cost_estimate_usd).toBeGreaterThan(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-x');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('sys');
    expect(body.messages[0].content).toBe('hi');
  });

  it('google: parses candidates + usageMetadata and prepends the system prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, {
      candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await callLlm({ provider: 'google', api_key: 'g-key' }, { system: 'S', prompt: 'q' });
    expect(out.text).toBe('hi from gemini');
    expect(out.input_tokens).toBe(50);
    expect(out.output_tokens).toBe(12);
    expect(out.provider).toBe('google');

    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    // Gemini has no separate system field — it is prepended to the user content.
    expect(JSON.parse(init.body as string).contents[0].parts[0].text).toBe('S\n\nq');
  });

  it('openai: parses choices + usage and sends system then user messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, {
      choices: [{ message: { content: 'hi from gpt' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await callLlm({ provider: 'openai', api_key: 'o-key' }, { system: 'S', prompt: 'P' });
    expect(out.text).toBe('hi from gpt');
    expect(out.input_tokens).toBe(40);
    expect(out.output_tokens).toBe(8);
    expect(out.provider).toBe('openai');

    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer o-key');
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'P' },
    ]);
    // GPT-5 / o-series (the default `gpt-5.4-nano` is GPT-5-family) reject the
    // legacy `max_tokens` and require `max_completion_tokens`.
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('defaults the model per provider when none is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, { content: [{ text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await callLlm({ provider: 'anthropic', api_key: 'k' }, { prompt: 'p' });
    expect(out.model).toBe('claude-haiku-4-5-20251001');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe('claude-haiku-4-5-20251001');
  });

  it('tolerates a response missing text/usage (empty text, zero tokens)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, {})));
    const out = await callLlm({ provider: 'anthropic', api_key: 'k' }, { prompt: 'p' });
    expect(out.text).toBe('');
    expect(out.input_tokens).toBe(0);
    expect(out.output_tokens).toBe(0);
  });
});

describe('callLlm — error classification', () => {
  const call = () => callLlm({ provider: 'anthropic', api_key: 'k' }, { prompt: 'p' });

  it('maps 401/403 to auth, 429 to rate_limit, and 5xx to server', async () => {
    for (const [status, type] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server']] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(status, { error: { message: 'boom' } })));
      await expect(call()).rejects.toMatchObject({ type, statusCode: status });
    }
  });

  it('maps a thrown fetch to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(call()).rejects.toMatchObject({ type: 'network' });
  });

  it('maps an unparseable 200 body to a parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: async () => { throw new Error('bad json'); } } as unknown as Response));
    await expect(call()).rejects.toMatchObject({ type: 'parse' });
  });
});
