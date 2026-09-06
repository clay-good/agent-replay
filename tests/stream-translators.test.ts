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
    // The COMMAND, not the item type. Naming every tool step
    // `command_execution` made `check --golden --fields step_names` inert for
    // this format (two unrelated sessions produced byte-identical step names)
    // and disagreed with the codex-rollout importer, which names the same steps
    // after the tool.
    expect(cmd.name).toBe('ls');
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

  it('reads the coerced forms of a failure flag, and ignores non-values', () => {
    // Read generously: MISSING a failure signal is the fail-open direction (a
    // failed call stored clean reports green through check --golden and the eval
    // error criteria), and a field named `is_error` holding 1 has no other
    // plausible meaning. Meanwhile `JSON.stringify(NaN)` is the string "null",
    // so an `error: NaN` field used to produce a failing step whose reason read
    // as the word "null".
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ is_error: 1 }, 'tool failed'],
      [{ is_error: '1' }, 'tool failed'],
      [{ is_error: 0 }, null],
      [{ is_error: 'false' }, null],
      [{ error: Number.NaN }, null],
      [{ error: 0 }, null],
      [{ error: 42 }, '42'],
    ];
    for (const [extra, expected] of cases) {
      const t = makeTranslator('codex-exec')!;
      const id = run(t, [
        { type: 'thread.started', thread_id: `th_${JSON.stringify(extra)}` },
        { type: 'item.completed', item: { item_type: 'command_execution', command: 'c', ...extra } },
        { type: 'turn.completed', usage: {} },
      ]);
      const step = getTrace(db, id)!.steps.find((s) => s.step_type === 'tool_call')!;
      expect(step.error, JSON.stringify(extra)).toBe(expected);
    }
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

  it('does not fabricate a run failure from an unreadable exit code', () => {
    // `Number()` of an unparseable value is NaN, which is `!== 0`, so a
    // non-numeric exit code — a Node-style `code: "ENOENT"` reaching the
    // `?? obj.code` fallback, or an object — marked the whole run failed and
    // reported its reason as the literal "exited with code NaN". A code we
    // cannot read is not evidence the run failed. (codexItemError already
    // guarded this; the gemini branch had drifted apart from it again.)
    for (const result of [{ exit_code: 'abc' }, { code: 'ENOENT' }, { exit_code: {} }, { exit_code: true }]) {
      const t = makeTranslator('gemini-stream')!;
      const id = run(t, [
        { type: 'init', session_id: `g_${JSON.stringify(result)}` },
        { type: 'message', content: 'done' },
        { type: 'result', ...result },
      ], false);
      const trace = getTrace(db, id)!;
      expect(trace.status, JSON.stringify(result)).toBe('completed');
      expect(trace.error).toBeNull();
    }
    // A readable non-zero code, including a stringified one, still fails.
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 'g_code3' },
      { type: 'result', exit_code: '3' },
    ], false);
    expect(getTrace(db, id)!.error).toBe('exited with code 3');
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

describe('gemini-stream: a result that cannot be matched by id', () => {
  // A `tool_result` was DISCARDED whenever its id was missing, unknown, or
  // arrived before its `tool_use` — and the branch accepts a `tool_use` with no
  // id in the first place, so a wholly id-less stream lost every result. The
  // step stayed open with no output and, worse, no `error`: a run whose every
  // tool call failed was stored clean. That is the exact fail-open the error
  // path beneath it was written to close, reached by skipping the code entirely.
  it('pairs an id-less result with the open tool step, error and all', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-noid' },
      { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', is_error: true, error: 'boom' },
      { type: 'result', exit_code: 0 },
    ]);
    const step = getTrace(db, id)!.steps[0];
    expect(step.error).toBe('boom');
    expect(step.ended_at).not.toBeNull();
  });

  it('pairs a result that arrives before its call is known', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-unknown' },
      { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      // An id we never registered — an exporter that renumbers, or a truncated id.
      { type: 'tool_result', id: 'other', is_error: true, error: 'nope' },
      { type: 'result', exit_code: 0 },
    ]);
    expect(getTrace(db, id)!.steps[0].error).toBe('nope');
  });

  // Gemini dispatches calls in PARALLEL batches whose results come back in call
  // order, so the fallback must be oldest-first. Taking the most recent open
  // step handed each result to the other call's step: both outputs swapped, the
  // call that SUCCEEDED marked failed, and the call that actually failed stored
  // clean — a fabricated failure and a fail-open in one.
  it('pairs parallel id-less results in call order, not reverse', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-par' },
      { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_use', name: 'Bash', input: { cmd: 'boom' } },
      { type: 'tool_result', output: 'result-of-ls' },
      { type: 'tool_result', output: 'result-of-boom', is_error: true },
      { type: 'result', exit_code: 0 },
    ]);
    const steps = getTrace(db, id)!.steps;
    expect(steps[0].input).toEqual({ cmd: 'ls' });
    expect(steps[0].output).toEqual({ output: 'result-of-ls' });
    expect(steps[0].error).toBeNull();
    expect(steps[1].input).toEqual({ cmd: 'boom' });
    expect(steps[1].output).toEqual({ output: 'result-of-boom' });
    expect(steps[1].error).toBe('result-of-boom');
  });

  // A name that matches nothing open is not evidence about some other call:
  // attaching it would move a failure onto an unrelated tool, and fabricating a
  // failure is the expensive direction.
  it('does not attach a named result to an unrelated open call', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-mismatch' },
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'tool_result', name: 'WebFetch', is_error: true, error: 'nope' },
      { type: 'result', exit_code: 0 },
    ]);
    expect(getTrace(db, id)!.steps[0].error).toBeNull();
  });

  // With several open, the name picks the right one.
  it('prefers a name match when several tools are open', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-multi' },
      { type: 'tool_use', name: 'read', input: {} },
      { type: 'tool_use', name: 'bash', input: {} },
      { type: 'tool_result', name: 'read', is_error: true, error: 'read failed' },
      { type: 'result', exit_code: 0 },
    ]);
    const steps = getTrace(db, id)!.steps;
    expect(steps.find((s) => s.name === 'read')!.error).toBe('read failed');
    expect(steps.find((s) => s.name === 'bash')!.error).toBeNull();
  });

  // Tokens were read for codex-exec and ignored here, so every gemini capture
  // reported "-" while the identical field worked for the sibling format.
  it('records token usage from the terminal result', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-tok' },
      { type: 'result', exit_code: 0, usage: { input_tokens: 100, output_tokens: 50 } },
    ]);
    expect(getTrace(db, id)!.total_tokens).toBe(150);
  });

  it('prefers an explicit total over the input/output pair, without double counting', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's-tok2' },
      { type: 'result', exit_code: 0, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    ]);
    expect(getTrace(db, id)!.total_tokens).toBe(150);
  });
});

describe('codex-exec: an item that is not an object', () => {
  // `{"type":"item.completed","item":"text"}` is a shape the CLI can emit, and
  // the bare string went into the `output` column as a JSON scalar where every
  // reader expects an object. The gemini tool_result branch already wrapped a
  // bare string for exactly this reason; the two branches disagreed.
  it('wraps a bare-string item instead of storing a scalar', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th-str' },
      { type: 'item.completed', item: 'hello world' },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const step = getTrace(db, id)!.steps[0];
    expect(step.output).toEqual({ output: 'hello world' });
  });

  it('still stores a normal object item unchanged', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th-obj' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } },
      { type: 'turn.completed', usage: {} },
    ]);
    const step = getTrace(db, id)!.steps[0];
    expect((step.output as Record<string, unknown>).command).toBe('ls');
  });
});


describe('a translated stream reports what it dropped', () => {
  // `record` counts and reports every line it rejects, so a silent loss is
  // impossible on the native path. The translated formats had no counter at
  // all: an unpairable `tool_result` took the tool's OUTPUT with it and the run
  // still reported "Warnings: 0" — the tool call stored looking clean and
  // output-less, its result gone.
  //
  // Producing no events is not always a loss, which is why the translator
  // reports the reason rather than the caller inferring one from an empty
  // array: a repeated `init`, or a line that only accumulates usage, correctly
  // yields nothing.

  it('flags a gemini tool_result that pairs with no open call', () => {
    // With a call still open, an unmatched id deliberately falls back to the
    // oldest open one — that is documented behavior and not a drop. The loss
    // happens when there is nothing open to attach the result to, and the
    // payload it carries has nowhere to go.
    const t = makeTranslator('gemini-stream')!;
    t.translate({ type: 'init', session_id: 's1' });

    expect(t.translate({ type: 'tool_result', id: 'NOMATCH', output: { data: 1 } })).toEqual([]);
    expect(t.lastSkip()).toMatch(/matched no open tool call/);
  });

  it('flags an unrecognized event type in both translators', () => {
    for (const format of ['gemini-stream', 'codex-exec']) {
      const t = makeTranslator(format)!;
      t.translate({ type: 'init', session_id: 's1' });
      t.translate({ type: 'made_up_kind', payload: 1 });
      // Read ONCE — the reason is cleared on read, so a second call is null.
      const reason = t.lastSkip();
      expect(reason, format).toMatch(/unrecognized/);
      expect(reason, format).toMatch(/made_up_kind/);
    }
  });

  it('does NOT flag a line that legitimately produces no events', () => {
    // The distinction the reason channel exists for. A second `init` is a
    // no-op, not a loss — flagging it would train the reader to ignore
    // warnings.
    const t = makeTranslator('gemini-stream')!;
    t.translate({ type: 'init', session_id: 's1' });
    expect(t.translate({ type: 'init', session_id: 's1' })).toEqual([]);
    expect(t.lastSkip()).toBeNull();
  });

  it('clears the reason once read, so it is reported once', () => {
    const t = makeTranslator('gemini-stream')!;
    t.translate({ type: 'init', session_id: 's1' });
    t.translate({ type: 'made_up_kind' });
    expect(t.lastSkip()).not.toBeNull();
    expect(t.lastSkip()).toBeNull();
  });

  it('pairs a tool_result normally, with nothing flagged', () => {
    const t = makeTranslator('gemini-stream')!;
    t.translate({ type: 'init', session_id: 's1' });
    t.translate({ type: 'tool_use', id: 't1', name: 'ls', input: {} });
    const out = t.translate({ type: 'tool_result', id: 't1', output: { ok: true } });
    expect(out.length).toBeGreaterThan(0);
    expect(t.lastSkip()).toBeNull();
  });
});

// ── the model a stream reports ─────────────────────────────────────────────

describe('the model a translated stream reports', () => {
  it('stamps codex-exec steps with the model the thread declared', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_1', model: 'gpt-5-codex' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls -la' } },
      { type: 'item.completed', item: { item_type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual(['gpt-5-codex', 'gpt-5-codex']);
  });

  it('stamps gemini-stream steps, reading the model off the session object', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session: { id: 's1', model: 'gemini-2.5-pro' } },
      { type: 'tool_use', id: 't1', name: 'ls', input: {} },
      { type: 'tool_result', id: 't1', output: { ok: true } },
      { type: 'message', content: 'done' },
      { type: 'result', exit_code: 0 },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual(['gemini-2.5-pro', 'gemini-2.5-pro']);
  });

  it('follows a mid-session model change, leaving earlier steps on the old one', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_2', model: 'gpt-5-codex' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } },
      { type: 'turn_context', item: { model: 'gpt-5-codex-mini' } },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'pwd' } },
      { type: 'turn.completed', usage: {} },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual(['gpt-5-codex', 'gpt-5-codex-mini']);
  });

  it('stamps a record that both names a model and produces a step with that model', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's1' },
      { type: 'message', content: 'hello', model: 'gemini-2.5-flash' },
      { type: 'result', exit_code: 0 },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual(['gemini-2.5-flash']);
  });

  // The anti-fabrication guard, not a regression test: it passes against the
  // unfixed source too, and that is the point. A stream that names no model
  // must leave every step null — `check` skips a null-model baseline step, so
  // an honest absence costs the gate nothing while an invented value fails it.
  it('leaves the model null when the stream never names one', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_3' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } },
      { type: 'turn.completed', usage: {} },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual([null]);
  });

  it('ignores a non-string model rather than storing a coerced one', () => {
    const t = makeTranslator('gemini-stream')!;
    const id = run(t, [
      { type: 'init', session_id: 's1', model: { name: 'gemini-2.5-pro' } },
      { type: 'message', content: 'hi' },
      { type: 'result', exit_code: 0 },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps.map((s) => s.model)).toEqual([null]);
  });
});

// ── the input a codex item carries ─────────────────────────────────────────

describe('a codex item tool input', () => {
  it('reads an mcp_tool_call\'s JSON arguments into the input column', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_1' },
      {
        type: 'item.completed',
        item: { item_type: 'mcp_tool_call', name: 'search_flights', arguments: '{"from":"SFO","to":"JFK"}' },
      },
      { type: 'turn.completed', usage: {} },
    ]);
    const trace = getTrace(db, id)!;
    expect(trace.steps[0].input).toEqual({ from: 'SFO', to: 'JFK' });
  });

  it('reads arguments already sent as an object', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_2' },
      { type: 'item.completed', item: { item_type: 'mcp_tool_call', name: 'lookup', arguments: { id: 7 } } },
      { type: 'turn.completed', usage: {} },
    ]);
    expect(getTrace(db, id)!.steps[0].input).toEqual({ id: 7 });
  });

  it('keeps a freeform tool input verbatim rather than dropping it', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_3' },
      { type: 'item.completed', item: { item_type: 'mcp_tool_call', name: 'shell', input: 'not json at all' } },
      { type: 'turn.completed', usage: {} },
    ]);
    expect(getTrace(db, id)!.steps[0].input).toEqual({ arguments: 'not json at all' });
  });

  it('wraps a non-object argument value, so the input column stays an object', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_4' },
      { type: 'item.completed', item: { item_type: 'mcp_tool_call', name: 'batch', arguments: ['a', 'b'] } },
      { type: 'turn.completed', usage: {} },
    ]);
    const input = getTrace(db, id)!.steps[0].input;
    expect(input).toEqual({ arguments: ['a', 'b'] });
  });

  it('still prefers a command, which is what a command_execution carries', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_5' },
      { type: 'item.completed', item: { item_type: 'command_execution', command: 'ls -la' } },
      { type: 'turn.completed', usage: {} },
    ]);
    expect(getTrace(db, id)!.steps[0].input).toEqual({ command: 'ls -la' });
  });

  it('records no input for an item that carries none', () => {
    const t = makeTranslator('codex-exec')!;
    const id = run(t, [
      { type: 'thread.started', thread_id: 'th_6' },
      { type: 'item.completed', item: { item_type: 'file_change', path: 'src/a.ts' } },
      { type: 'turn.completed', usage: {} },
    ]);
    expect(getTrace(db, id)!.steps[0].input).toEqual({});
  });
});
