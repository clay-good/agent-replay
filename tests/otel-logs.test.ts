import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';
import { mapOtlpLogs } from '../src/services/otel/log-events.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { handleLogsExport, type OtelStats } from '../src/services/otel/receiver.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

function attr(key: string, value: unknown) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}
function logRecord(eventName: string, attrs: Record<string, unknown>, time = 1_000_000) {
  return { timeUnixNano: String(time), eventName, attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)) };
}
function otlpLogs(records: unknown[]) {
  return { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: records }] }] };
}

describe('mapOtlpLogs — Gemini CLI', () => {
  it('builds a trace with a tool call and a decision record', () => {
    const payload = otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'g1', prompt: 'list files' }, 1_000_000),
      logRecord('gemini_cli.tool_call', { 'session.id': 'g1', function_name: 'run_shell', function_args: '{"cmd":"ls"}', duration_ms: 120, success: true, decision: 'reject' }, 2_000_000),
      logRecord('gemini_cli.api_response', { 'session.id': 'g1', input_token_count: 100, output_token_count: 20 }, 3_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    expect(trace.agent_name).toBe('gemini');
    expect(trace.session_id).toBe('g1');
    expect(trace.input).toEqual({ prompt: 'list files' });
    expect(trace.total_tokens).toBe(120);

    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('run_shell');
    expect(tool.input).toEqual({ cmd: 'ls' });
    expect(tool.duration_ms).toBe(120);

    const decision = trace.steps.find((s) => s.step_type === 'decision')!;
    expect(decision.caused_by_step_number).toBe(tool.step_number);
    expect(decision.decision!.chosen).toBe('reject');
    expect(decision.decision!.decided_by).toBe('user');
  });

  it('preserves malformed tool args by wrapping them as { args } rather than dropping them', () => {
    // function_args need not be a JSON object: a Gemini log can send a bare
    // command string, or a JSON scalar. Either must be kept (wrapped), not lost.
    const nonJson = otlpLogs([logRecord('gemini_cli.tool_call', { 'session.id': 'g3', function_name: 'run_shell', function_args: 'rm -rf tmp' })]);
    const t1 = getTrace(db, ingestTrace(db, mapOtlpLogs(nonJson)[0]).id)!;
    expect(t1.steps.find((s) => s.step_type === 'tool_call')!.input).toEqual({ args: 'rm -rf tmp' });

    const jsonScalar = otlpLogs([logRecord('gemini_cli.tool_call', { 'session.id': 'g4', function_name: 'wait', function_args: '42' })]);
    const t2 = getTrace(db, ingestTrace(db, mapOtlpLogs(jsonScalar)[0]).id)!;
    expect(t2.steps.find((s) => s.step_type === 'tool_call')!.input).toEqual({ args: '42' });
  });

  it('preserves a genuine 0 ms tool duration (does not collapse it to null)', () => {
    // An instant/cached tool really can report duration_ms 0; it must survive as
    // 0, not become "no duration" (the same class as the hook 0 ms fix). A tool
    // call with no duration_ms at all still yields null.
    const withZero = otlpLogs([logRecord('gemini_cli.tool_call', { 'session.id': 'gz', function_name: 'cached', function_args: '{}', duration_ms: 0 })]);
    const t0 = getTrace(db, ingestTrace(db, mapOtlpLogs(withZero)[0]).id)!;
    expect(t0.steps.find((s) => s.step_type === 'tool_call')!.duration_ms).toBe(0);

    const noDur = otlpLogs([logRecord('gemini_cli.tool_call', { 'session.id': 'gn', function_name: 'plain', function_args: '{}' })]);
    const tn = getTrace(db, ingestTrace(db, mapOtlpLogs(noDur)[0]).id)!;
    expect(tn.steps.find((s) => s.step_type === 'tool_call')!.duration_ms).toBeNull();
  });

  it('attributes an auto_accept decision to policy', () => {
    const payload = otlpLogs([
      logRecord('gemini_cli.tool_call', { 'session.id': 'g2', function_name: 'read', function_args: '{}', decision: 'auto_accept' }),
    ]);
    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;
    const decision = trace.steps.find((s) => s.step_type === 'decision')!;
    expect(decision.decision!.decided_by).toBe('policy');
  });
});

describe('mapOtlpLogs — Claude Code', () => {
  it('builds a trace from claude_code.* events with tokens and a decision', () => {
    const payload = otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'c1', prompt: 'fix it' }, 1_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'c1', tool_name: 'Bash', success: true }, 2_000_000),
      logRecord('claude_code.tool_decision', { 'session.id': 'c1', tool_name: 'Bash', decision: 'allow' }, 3_000_000),
      logRecord('claude_code.api_response', { 'session.id': 'c1', input_token_count: 200, output_token_count: 40 }, 4_000_000),
    ]);
    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    expect(trace.agent_name).toBe('claude-code');
    expect(trace.session_id).toBe('c1');
    expect(trace.input).toEqual({ prompt: 'fix it' });
    expect(trace.total_tokens).toBe(240);
    expect(trace.steps.some((s) => s.step_type === 'tool_call' && s.name === 'Bash')).toBe(true);
    expect(trace.steps.some((s) => s.step_type === 'decision' && s.decision?.chosen === 'allow')).toBe(true);
  });

  it('sorts a timestamp-less log record last, not first (no stolen step 1)', () => {
    // timeUnixNano is optional in OTLP. num() flattens a missing one to 0, so an
    // untimed record must NOT sort ahead of real, timed events and take
    // step_number 1. Mirrors the start-less span guard in semconv.
    const untimed = {
      eventName: 'claude_code.tool_result',
      attributes: Object.entries({ 'session.id': 'c2', tool_name: 'Untimed', success: true }).map(([k, v]) => attr(k, v)),
      // no timeUnixNano
    };
    const payload = otlpLogs([
      untimed,
      logRecord('claude_code.tool_result', { 'session.id': 'c2', tool_name: 'Timed', success: true }, 5_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const toolNames = t.steps.filter((s) => s.step_type === 'tool_call').map((s) => s.name);
    // The timed event comes first; the untimed one is appended after it.
    expect(toolNames).toEqual(['Timed', 'Untimed']);
  });

  it('separates two sessions and ignores unrelated events', () => {
    const payload = otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'a', prompt: 'one' }),
      logRecord('claude_code.user_prompt', { 'session.id': 'b', prompt: 'two' }),
      logRecord('some.other.event', { 'session.id': 'a', foo: 'bar' }),
    ]);
    const traces = mapOtlpLogs(payload);
    for (const t of traces) ingestTrace(db, t);
    expect(listTraces(db, {}).total).toBe(2);
  });
});

describe('handleLogsExport (/v1/logs ingest)', () => {
  it('parses a JSON log batch, maps and ingests it, and answers 200', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const body = JSON.stringify(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'lg1', prompt: 'hi' }, 1_000_000),
      logRecord('gemini_cli.tool_call', { 'session.id': 'lg1', function_name: 'run_shell', function_args: '{"cmd":"ls"}', success: true }, 2_000_000),
    ]));
    const res = handleLogsExport(db, body, stats);
    expect(res.status).toBe(200);

    const traces = listTraces(db, { session_id: 'lg1' });
    expect(traces.total).toBe(1);
    const t = getTrace(db, traces.items[0].id)!;
    expect(t.agent_name).toBe('gemini');
    expect(t.steps.some((s) => s.step_type === 'tool_call')).toBe(true);
  });

  it('rejects a malformed log body with 400', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    expect(handleLogsExport(db, '{bad json', stats).status).toBe(400);
  });

  it('assembles one session arriving across log batches into a single trace', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // Batch 1: the prompt and the first tool call for session "s9".
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 's9', prompt: 'go' }, 1_000_000),
      logRecord('gemini_cli.tool_call', { 'session.id': 's9', function_name: 'first', function_args: '{}', success: true }, 2_000_000),
    ])), stats);
    // Batch 2: a later tool call for the SAME session.
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('gemini_cli.tool_call', { 'session.id': 's9', function_name: 'second', function_args: '{}', success: true }, 3_000_000),
    ])), stats);

    const traces = listTraces(db, { session_id: 's9' });
    expect(traces.total).toBe(1); // one session → one trace, not one per batch
    const t = getTrace(db, traces.items[0].id)!;
    const toolNames = t.steps.filter((s) => s.step_type === 'tool_call').map((s) => s.name);
    expect(toolNames).toEqual(['first', 'second']);
  });
});

// ── Failures must be visible ──────────────────────────────────────────────

/**
 * The log path had no error handling at all: `status` was hardcoded
 * `completed`, no step ever received an `error`, and `.api_error` records
 * matched no branch so they vanished entirely (a batch of only those produced
 * zero traces and still answered 200). A session whose every tool call failed
 * therefore looked like a clean run to `list`, `check --golden`, and eval's
 * error criteria alike.
 */
describe('mapOtlpLogs — failure mapping', () => {
  it('records a failed Gemini tool call as a step error and fails the trace', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'f1', prompt: 'do it' }),
      logRecord('gemini_cli.tool_call', {
        'session.id': 'f1', function_name: 'write', success: false,
        error: 'disk full', error_type: 'FileError',
      }),
    ]) as never);

    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].error).toBe('disk full');
  });

  it('records a failed Claude Code tool result, including its duration', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.tool_result', {
        'session.id': 'f2', tool_name: 'Bash', success: false, error: 'exit 1', duration_ms: 12,
      }),
    ]) as never);

    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].error).toBe('exit 1');
    expect(traces[0].steps![0].duration_ms).toBe(12);
  });

  it('keeps an api_error record instead of dropping it', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.api_error', {
        'session.id': 'f3', error: 'rate limited', model: 'claude-opus-5',
      }),
    ]) as never);

    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].step_type).toBe('llm_call');
    expect(traces[0].steps![0].error).toBe('rate limited');
  });

  it('falls back to a generic message when a failure carries no detail', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.tool_call', { 'session.id': 'f4', function_name: 'write', success: false }),
    ]) as never);
    expect(traces[0].steps![0].error).toBe('tool failed');
  });

  it('still reports a fully successful session as completed', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'ok1', prompt: 'go' }),
      logRecord('gemini_cli.tool_call', { 'session.id': 'ok1', function_name: 'read', success: true }),
    ]) as never);
    expect(traces[0].status).toBe('completed');
    expect(traces[0].steps![0].error).toBeUndefined();
  });
});

// ── the logs path must not lose or fabricate data ───────────────────────────

describe('mapOtlpLogs — data fidelity', () => {
  const MS = 1_000_000;

  it('keeps a batch that carries only token counts', () => {
    // Regression: a flush window with only model-call events has no steps and
    // no prompt — but it does have tokens, and the whole group was dropped, so
    // a session's token total depended on where the exporter cut its batches.
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.api_response', { 'session.id': 'sess-tok', input_token_count: 100, output_token_count: 20 }, 2 * MS),
    ]));
    expect(traces).toHaveLength(1);
    expect(traces[0].total_tokens).toBe(120);
  });

  it('does not fuse session-less records from unrelated sources', () => {
    // Regression: every record without session.id joined one '__nosession__'
    // bucket, so unrelated services in one batch became a single trace with
    // summed tokens. The span path already refuses the same fusion.
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.tool_call', { function_name: 'a' }, 1 * MS),
      logRecord('gemini_cli.tool_call', { function_name: 'b' }, 2 * MS),
    ]));
    expect(traces).toHaveLength(2);
    for (const t of traces) expect(t.steps).toHaveLength(1);
  });

  it('stamps steps with their event time and gives the trace a duration', () => {
    // Regression: no log-derived step set started_at, so the writer stamped
    // every one with the ingest wall-clock — a timeline where all steps happen
    // at once. The trace had no ended_at either, so `list` showed "-" forever.
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'sess-t', prompt: 'go' }, 1 * MS),
      logRecord('gemini_cli.tool_call', { 'session.id': 'sess-t', function_name: 'first' }, 2 * MS),
      logRecord('gemini_cli.tool_call', { 'session.id': 'sess-t', function_name: 'second' }, 5 * MS),
    ]));
    const [t] = traces;
    expect(t.started_at).toBe('1970-01-01T00:00:00.001Z');
    expect(t.ended_at).toBe('1970-01-01T00:00:00.005Z');
    expect(t.steps!.map((s) => s.started_at)).toEqual([
      '1970-01-01T00:00:00.002Z',
      '1970-01-01T00:00:00.005Z',
    ]);
  });
});

describe('handleLogsExport — an unrecognized batch is reported, not swallowed', () => {
  it('answers partial_success when nothing in the batch mapped', () => {
    // Regression: the logs endpoint answered a bare 200 unconditionally, while
    // the traces endpoint reports partial_success for the same situation.
    // mapOtlpLogs keeps only gemini_cli.* / claude_code.* events, so an emitter
    // whose event names drift got a clean 200 forever while the store stayed
    // empty — nothing to debug against.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('some_other_tool.tool_call', { 'session.id': 's', function_name: 'x' }),
      logRecord('generic.log', {}),
    ])), stats);

    expect(res.status).toBe(200); // still not a retryable error — the batch was understood
    expect(res.payload).toMatchObject({ partialSuccess: { rejectedLogRecords: 2 } });
    expect(listTraces(db, {}).total).toBe(0);
  });

  it('answers a bare 200 when the batch did map', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('gemini_cli.tool_call', { 'session.id': 'ok', function_name: 'ls' }),
    ])), stats);
    expect(res.payload).toEqual({});
    expect(listTraces(db, {}).total).toBe(1);
  });

  it('answers a bare 200 for a genuinely empty batch', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    expect(handleLogsExport(db, JSON.stringify({ resourceLogs: [] }), stats).payload).toEqual({});
  });
});
