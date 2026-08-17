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
  // Regression: `turn.completed` is this stream's terminal event, but the
  // translator never declared it expected one, so finalize() closed the trace
  // as `completed` at EOF — reporting a killed run as a clean one. The
  // identical gemini case was already fixed; codex was left behind.
  it('does not record a cut-off run as completed even when finalize runs at EOF', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_cut' },
      { type: 'item.completed', item: { item_type: 'agent_message', text: 'hi' } },
    ], true);
    // Stays running so `record` finalizes it as timeout, like the native path.
    expect(getTrace(db, id)!.status).toBe('running');
  });

  it('records a clean run as completed once turn.completed arrives', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_ok' },
      { type: 'item.completed', item: { item_type: 'agent_message', text: 'hi' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } },
    ], true);
    const trace = getTrace(db, id)!;
    expect(trace.status).toBe('completed');
    expect(trace.total_tokens).toBe(12);
  });

  // Regression: `usage` was only *cast* to numbers, so string counts made
  // `0 + "5" + "7"` concatenate to "057" and store 57 instead of 12.
  it('sums string token counts numerically, not by concatenation', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_str' },
      { type: 'turn.completed', usage: { input_tokens: '5', output_tokens: '7' } },
    ], true);
    expect(getTrace(db, id)!.total_tokens).toBe(12);
  });

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

  it('records a failed item as a step error', () => {
    // Same gap the gemini tool_result branch had, in the same file: a failed
    // command was stored as a clean step, so nothing downstream could see it.
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_err' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'false', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'true', exit_code: 0, status: 'completed' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const steps = getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call');
    expect(steps[0].error).toBeTruthy();
    expect(steps[1].error).toBeNull();
  });

  it('names the real reason a codex item failed, never its success status', () => {
    // The first version was a nested ternary whose OR-ed trigger and `??`
    // fallback did not line up: an item failing by exit code fell through to the
    // status string and was stored with the error text "completed" — the SUCCESS
    // status displayed as the failure reason — and `{is_error: true}` with no
    // exit code produced the literal "exited with code undefined".
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_msg' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'a', status: 'completed', exit_code: 1 } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'b', is_error: true } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'c', exit_code: '2' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'd', status: 'Failed' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'e', status: 'completed', exit_code: 0 } },
      { type: 'turn.completed', usage: {} },
    ]);
    const errs = getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call').map((s) => s.error);
    expect(errs[0]).toBe('exited with code 1');   // not "completed"
    expect(errs[1]).toBe('tool failed');          // not "exited with code undefined"
    expect(errs[2]).toBe('exited with code 2');   // stringified exit code counts
    expect(errs[3]).toBe('tool failed');          // "Failed" counts, like isTrueish
    expect(errs[4]).toBeNull();                   // a clean item stays clean
    for (const e of errs) expect(String(e)).not.toContain('undefined');
  });

  it('treats an empty container error field as success, like "" and false', () => {
    // Same fabricated-failure class as `error: ""`, via a different empty value:
    // `{}` is a plausible "no error" encoding for a structured error field.
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_empty' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
      { type: 'tool_result', id: 't1', error: {}, result: 'fine' },
      { type: 'tool_use', id: 't2', name: 'read', input: {} },
      { type: 'tool_result', id: 't2', error: [], result: 'fine too' },
      { type: 'result', exit_code: 0 },
    ], false);
    for (const step of getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call')) {
      expect(step.error).toBeNull();
    }
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

  it('wraps a bare-string tool_result so the output is not lost on read', () => {
    // A raw string stored verbatim as TEXT fails JSON.parse on read → null.
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_str' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_result', id: 't1', result: 'plain file contents' },
      { type: 'result', exit_code: 0 },
    ], false);
    const tool = getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.output).toEqual({ output: 'plain file contents' });
  });

  it('records a failed gemini tool_result as a step error', () => {
    // The gemini branch had NO error path: a run whose tool calls all failed
    // was stored as clean, so `isErrorStep` saw nothing, ai-root-cause scored a
    // 100% PASS on it, and a golden step_errors baseline had no failure to
    // regress against. Every sibling capture path (hook-adapter,
    // claude-transcript) already populated `error` here.
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_err' },
      { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a' } },
      { type: 'tool_result', id: 't1', is_error: true, result: 'EACCES: permission denied' },
      { type: 'result', exit_code: 0 },
    ], false);
    const tool = getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.error).toBe('EACCES: permission denied');
    // The result content is still preserved as output, not replaced by it.
    expect(tool.output).toEqual({ output: 'EACCES: permission denied' });
  });

  it('flattens a structured gemini tool error instead of collapsing it', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_err2' },
      { type: 'tool_use', id: 't1', name: 'run_cmd', input: {} },
      { type: 'tool_result', id: 't1', error: { message: 'boom', code: 'E1' } },
      { type: 'result', exit_code: 0 },
    ], false);
    const tool = getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.error).toBe('{"message":"boom","code":"E1"}');
  });

  it('does not invent a failure from a success-valued error field', () => {
    // The opposite-direction bug in my own first fix: keying on `error != null`
    // turned a producer that ALWAYS emits the key (`error: ""`, `error: false`)
    // into fabricated failing steps — which feed `check --golden` step_errors
    // and the eval error criteria, so a clean run exits 1.
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_ok2' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      { type: 'tool_result', id: 't1', error: '', result: 'file contents here' },
      { type: 'tool_use', id: 't2', name: 'read_file', input: {} },
      { type: 'tool_result', id: 't2', error: false, result: 'ok2' },
      { type: 'result', exit_code: 0 },
    ], false);
    for (const step of getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call')) {
      expect(step.error).toBeNull();
    }
  });

  it('reads a stringified is_error, like the OTel log mapper does', () => {
    // An exporter that stringifies attribute values sends "true".
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_str_err' },
      { type: 'tool_use', id: 't1', name: 'write_file', input: {} },
      { type: 'tool_result', id: 't1', is_error: 'true', result: 'boom' },
      { type: 'result', exit_code: 0 },
    ], false);
    expect(getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!.error).toBe('boom');
  });

  it('leaves a successful gemini tool_result with no error', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_ok' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      { type: 'tool_result', id: 't1', is_error: false, output: { ok: true } },
      { type: 'result', exit_code: 0 },
    ], false);
    const tool = getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.error).toBeNull();
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

  it('does not record a cut-off run as completed even when finalize runs at EOF', () => {
    const t = makeTranslator('gemini-stream')!;
    // A killed run: a tool call but no terminal `result`. finalize() (which
    // `record` always calls at EOF) must NOT close it as completed — the trace
    // stays running so record finalizes it as timeout, like the native path.
    const id = run(t, [
      { type: 'init', session_id: 'g_4' },
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ], true);
    expect(getTrace(db, id)!.status).toBe('running');
  });

  it('records a clean run as completed once the terminal result arrives', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_5' },
      { type: 'message', content: 'hi' },
      { type: 'result', exit_code: 0 },
    ], true);
    expect(getTrace(db, id)!.status).toBe('completed');
  });
});
