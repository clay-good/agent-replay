import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace } from '../src/services/trace-service.js';
import { applyEvent } from '../src/services/recorder.js';
import { makeTranslator } from '../src/services/stream-translators.js';
import type { StreamTranslator } from '../src/services/stream-translators.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

/** Run a translator over input objects; return the trace id it produced. */
function run(t: StreamTranslator, inputs: Record<string, unknown>[], finalize = true): string {
  let traceId = '';
  for (const obj of inputs) {
    for (const ev of t.translate(obj)) traceId = applyEvent(db, ev).traceId;
  }
  if (finalize) for (const ev of t.finalize()) applyEvent(db, ev);
  return traceId;
}

// ── codex exec --json ──────────────────────────────────────────────────────

describe('CodexExecTranslator', () => {
  it('maps a thread into a trace with typed steps and token totals', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_abc' },
      { type: 'item.completed', item: { item_type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls', aggregated_output: 'a.txt' } },
      { type: 'item.completed', item: { item_type: 'web_search', query: 'x' } },
      { type: 'item.completed', item: { item_type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
    ]);

    const trace = getTrace(db, id)!;
    expect(trace.agent_name).toBe('codex');
    expect(trace.session_id).toBe('th_abc');
    expect(trace.status).toBe('completed');
    expect(trace.total_tokens).toBe(120);
    expect(trace.steps.map((s) => s.step_type)).toEqual(['thought', 'tool_call', 'retrieval', 'output']);
    const cmd = trace.steps[1];
    expect(cmd.name).toBe('command_execution');
    expect(cmd.input).toEqual({ command: 'ls' });
  });

  it('marks the trace failed on turn.failed', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_x' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'boom' } },
      { type: 'turn.failed', error: { message: 'exploded' } },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.status).toBe('failed');
    expect(trace.error).toBe('exploded');
  });
});

// ── gemini stream-json ─────────────────────────────────────────────────────

describe('GeminiStreamTranslator', () => {
  it('pairs tool_use/tool_result and finalizes on result', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(
      t,
      [
        { type: 'init', session_id: 'g_1' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_result', id: 't1', output: { content: 'hi' } },
        { type: 'message', content: 'here is the answer' },
        { type: 'result', exit_code: 0 },
      ],
      false, // result already finalizes
    );

    const trace = getTrace(db, id)!;
    expect(trace.agent_name).toBe('gemini');
    expect(trace.session_id).toBe('g_1');
    expect(trace.status).toBe('completed');
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('read_file');
    expect(tool.input).toEqual({ path: 'a' });
    expect(tool.output).toEqual({ content: 'hi' });
    expect(trace.steps.some((s) => s.step_type === 'output' && s.name === 'message')).toBe(true);
  });

  it('respects a non-zero result exit code as failure', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_2' },
      { type: 'message', content: 'partial' },
      { type: 'result', exit_code: 42 },
    ], false);
    expect(getTrace(db, id)!.status).toBe('failed');
  });

  it('leaves the trace running when the stream is cut off before finalize', () => {
    const t = makeTranslator('gemini-stream')!;
    // Simulate a killed stream: translate a few events, never finalize.
    const id = run(t, [
      { type: 'init', session_id: 'g_3' },
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ], false);
    expect(getTrace(db, id)!.status).toBe('running');
  });
});
