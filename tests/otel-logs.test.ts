import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';
import { mapOtlpLogs } from '../src/services/otel/log-events.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { handleLogsExport, handleTracesExport, type OtelStats } from '../src/services/otel/receiver.js';
import { effectiveDurationMs } from '../src/utils/time.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { mergeBatchIntoTrace } from '../src/services/trace-service.js';
import { validateTraceInput } from '../src/utils/validators.js';

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

  // A log processor flushes each turn in its own batch (turns are minutes apart),
  // so everything a later batch carries has to survive the merge. Cost was absent
  // from the merge UPDATE entirely, and a later turn's prompt was dropped because
  // the input is only adopted for a synthetic trace.
  it('sums cost across batches and keeps every later turn\'s prompt', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'sc', prompt: 'first question' }, 1_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'sc', cost_usd: 0.5, input_tokens: 10, output_tokens: 10 }, 2_000_000),
    ])), stats);
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'sc', prompt: 'second question' }, 3_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'sc', cost_usd: 0.25, input_tokens: 10, output_tokens: 10 }, 4_000_000),
    ])), stats);

    const t = getTrace(db, listTraces(db, { session_id: 'sc' }).items[0].id)!;
    expect(t.total_cost_usd).toBeCloseTo(0.75, 8);
    // The run still started from the first question; the later turn is retained
    // rather than discarded (there is no step type for a user turn).
    expect(t.input).toEqual({ prompt: 'first question' });
    expect((t.metadata as { follow_up_prompts?: string[] }).follow_up_prompts).toEqual(['second question']);
  });

  // An OTLP exporter retries a batch on a 5xx, or on a timeout that arrived after
  // the server had already committed — so the identical batch can merge twice.
  it('does not duplicate a follow-up prompt when a batch is re-delivered', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const first = JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'dup', prompt: 'turn one' }, 1_000_000),
    ]));
    const second = JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'dup', prompt: 'turn two' }, 2_000_000),
    ]));
    handleLogsExport(db, first, stats);
    handleLogsExport(db, second, stats);
    handleLogsExport(db, second, stats); // redelivered
    handleLogsExport(db, second, stats); // and again

    const t = getTrace(db, listTraces(db, { session_id: 'dup' }).items[0].id)!;
    expect((t.metadata as { follow_up_prompts?: string[] }).follow_up_prompts).toEqual(['turn two']);
  });

  // One out-of-range stamp used to poison the whole session's aggregate: the max
  // was taken over RAW nanos, and the formatter then rejected it, so ended_at and
  // total_duration_ms went null even though every other record was properly timed.
  it('keeps the session end time when one record carries an impossible timestamp', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'skew', prompt: 'go' }, 1_000_000_000),
      logRecord('gemini_cli.tool_call', { 'session.id': 'skew', function_name: 'a', function_args: '{}', success: true }, 1_050_000_000),
      // Nanos so large the four-digit-year window cannot render them.
      logRecord('gemini_cli.tool_call', { 'session.id': 'skew', function_name: 'b', function_args: '{}', success: true }, 9e21),
    ])), stats);
    expect(res.status).toBe(200);

    const t = getTrace(db, listTraces(db, { session_id: 'skew' }).items[0].id)!;
    expect(t.ended_at).toBe('1970-01-01T00:00:01.050Z');
    // The log mapper carries no explicit total; the duration is derived from the
    // window, so the recovered end time is what makes it measurable at all.
    expect(effectiveDurationMs(t)).toBe(50);
  });

  // An exporter built on the OTel Python SDK stringifies with `str(False)` →
  // "False", which an exact 'false' comparison missed: the error text was dropped
  // and a failed tool call read as a clean one.
  it('treats a stringified "False" success as a failure, whatever its case', () => {
    for (const value of ['False', 'FALSE', 'false', ' false ']) {
      const [t] = mapOtlpLogs(otlpLogs([
        logRecord('claude_code.tool_result', { 'session.id': 'pyf', name: 'Bash', success: value, error: 'permission denied' }, 1_000_000),
      ]));
      expect(t.steps![0].error).toBe('permission denied');
      // The point of this test is that the stringified false is READ as a
      // failure at all — the STEP carries it. The run itself stays completed:
      // a failed tool is not a failed run on any other capture path.
      expect(t.status).toBe('completed');
    }
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
  // A failed TOOL is a step error, not a run outcome. Asserting the trace
  // `failed` here made these two receivers the only capture paths that promote
  // one: the other eight store `completed` for a session containing a failed
  // tool, the telemetry-ingest spec says a failure becomes a STEP error, and
  // eval's design deliberately does not hard-fail a preset for a recovered step
  // error. The identical session scored the same and PASSED via `ingest` while
  // FAILING at exit 1 here. The failure must stay VISIBLE on the step — that is
  // what these tests are really protecting — and a failed model call
  // (`.api_error`) still fails the run.
  it('records a failed Gemini tool call as a step error, leaving the run completed', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 'f1', prompt: 'do it' }),
      logRecord('gemini_cli.tool_call', {
        'session.id': 'f1', function_name: 'write', success: false,
        error: 'disk full', error_type: 'FileError',
      }),
    ]) as never);

    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe('completed');
    expect(traces[0].steps![0].error).toBe('disk full');
  });

  it('records a failed Claude Code tool result, including its duration', () => {
    const traces = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.tool_result', {
        'session.id': 'f2', tool_name: 'Bash', success: false, error: 'exit 1', duration_ms: 12,
      }),
    ]) as never);

    expect(traces[0].status).toBe('completed');
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

  it('records the model on a failed model call, not only in its name', () => {
    // The model was put in `name` alone, leaving the `model` column null on
    // every log-derived step — so a capture of these CLIs had no model recorded
    // anywhere, while the span path sets it.
    const [t] = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.api_error', { 'session.id': 's-m', 'gen_ai.request.model': 'gemini-2.5-flash', error: 'boom' }, MS),
    ]));
    expect(t.steps![0].model).toBe('gemini-2.5-flash');
    expect(t.steps![0].error).toBe('boom');
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

  it('reports a PARTIAL rejection, which is what drift actually looks like', () => {
    // The guard was `traces.length === 0`, so a batch where anything at all was
    // recognized answered a bare 200 — and the drift this exists to surface is
    // normally partial: a CLI version bump renames some events and keeps
    // others. Those records were discarded under a clean 200, with nothing
    // anywhere to debug against.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('gemini_cli.tool_call', { 'session.id': 's1', function_name: 'ls' }),
      logRecord('someone_elses_cli.tool_call', { 'session.id': 's1' }),
      logRecord('generic.log', {}),
    ])), stats);

    expect(res.status).toBe(200);
    expect(res.payload).toMatchObject({ partialSuccess: { rejectedLogRecords: 2 } });
    // ...and the recognized part really was stored, which is why this is
    // partial rather than a rejection.
    expect(listTraces(db, {}).total).toBe(1);
    const msg = (res.payload as { partialSuccess: { errorMessage: string } }).partialSuccess.errorMessage;
    expect(msg).toMatch(/2 of 3/);

    // Scope, stated so the next reader does not over-trust the number: this
    // counts records whose event NAME the mapper does not recognize. A record
    // carrying a known prefix but an unknown suffix (`gemini_cli.something_new`)
    // still passes the prefix filter and may yield no step, and is not counted
    // here — narrowing that needs per-record reporting from the mapper.
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

describe('log-event mapper robustness', () => {
  it('keeps session-less batches apart instead of fusing them on a placeholder id', () => {
    // The bucket key changed to `!nosession:<i>` but the "is this a placeholder?"
    // test still compared the OLD sentinel, so the synthetic key was PERSISTED
    // as the session id — and the receiver merges log batches on
    // (session_id, source_format), so every batch's first session-less record
    // carried `!nosession:0` and merged into the previous batch's trace.
    const one = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.tool_call', { function_name: 'alpha', success: true }, 1_000_000),
    ]));
    expect(one).toHaveLength(1);
    expect(one[0].session_id).toBeNull();
  });

  it('treats a stringified success:false as a failure', () => {
    // An exporter that stringifies attribute values sends "false" while the same
    // record still carries the error text; keying on `!== false` read the failed
    // tool call as clean.
    const [trace] = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.tool_call', { function_name: 'rm', success: 'false', error: 'nope' }, 1_000_000),
    ]));
    expect(trace.steps![0].error).toBe('nope');
    // Step-level, as above — the run is not failed by a failed tool.
    expect(trace.status).toBe('completed');
  });

  // A failed MODEL CALL is different: the turn did not happen, so it is a
  // session-level failure and still fails the run.
  it('fails the run for an api_error, not for a failed tool', () => {
    const [failed] = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'ae1', prompt: 'go' }, 1_000_000),
      logRecord('claude_code.api_error', { 'session.id': 'ae1', error: 'overloaded', status_code: 529 }, 2_000_000),
    ]));
    expect(failed.status).toBe('failed');

    const [ok] = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'ae2', prompt: 'go' }, 1_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'ae2', tool_name: 'Bash', success: false, error: 'exit 1' }, 2_000_000),
    ]));
    expect(ok.status).toBe('completed');
    // The prompt becomes the trace input, not a step, so the tool is first.
    expect(ok.steps![0].error).toBe('exit 1');
  });

  it('drops an out-of-range timestamp instead of throwing away the whole batch', () => {
    // `new Date(nanos/1e6).toISOString()` threw RangeError on an absurd stamp,
    // and the mapper runs inside the receiver's try — so the batch was answered
    // 400 (not retryable) and every well-formed record alongside it was lost.
    expect(() =>
      mapOtlpLogs(otlpLogs([
        logRecord('gemini_cli.tool_call', { function_name: 'ok', success: true }, 99999999999999999999999),
      ])),
    ).not.toThrow();
  });

  it('keeps every user prompt of a multi-turn session', () => {
    // A session shares one session.id across turns and each later prompt
    // OVERWROTE the input, so only the last question survived anywhere.
    const [trace] = mapOtlpLogs(otlpLogs([
      logRecord('gemini_cli.user_prompt', { 'session.id': 's1', prompt: 'first question' }, 1_000_000),
      logRecord('gemini_cli.user_prompt', { 'session.id': 's1', prompt: 'second question' }, 2_000_000),
    ]));
    expect(trace.input).toEqual({ prompt: 'first question' });
    expect((trace.metadata as { follow_up_prompts?: string[] }).follow_up_prompts).toEqual(['second question']);
  });
});

describe('a later batch fills in what the trace still lacks', () => {
  // The trace's content was adopted only when the existing trace was flagged
  // synthetic, so a session opened by a batch WITHOUT a prompt — a receiver
  // started mid-session, a resumed session, an out-of-order flush — discarded
  // every later prompt from both `input` and metadata.
  it('adopts a prompt that arrives after the trace was opened', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.api_request', { 'session.id': 'late', input_tokens: 10, output_tokens: 5 }, 1_000_000),
    ])), stats);
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'late', prompt: 'the real user question' }, 2_000_000),
    ])), stats);

    const t = getTrace(db, listTraces(db, { session_id: 'late' }).items[0].id)!;
    expect((t.input as { prompt?: string }).prompt).toBe('the real user question');
  });

  it('does not overwrite a prompt the trace already has', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'first', prompt: 'first question' }, 1_000_000),
    ])), stats);
    handleLogsExport(db, JSON.stringify(otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'first', prompt: 'second question' }, 2_000_000),
    ])), stats);

    const t = getTrace(db, listTraces(db, { session_id: 'first' }).items[0].id)!;
    expect((t.input as { prompt?: string }).prompt).toBe('first question');
    expect((t.metadata as { follow_up_prompts?: string[] }).follow_up_prompts).toEqual(['second question']);
  });
});

describe('the log path clamps counters that ingest would reject', () => {
  it('floors a negative token count instead of storing it', () => {
    // `intValue` is a signed int64, so a negative count is wire-legal. The span
    // path floors it (semconv `usage()`, whose comment names this exact
    // consequence); the log path — the one the README documents for Claude Code
    // and Gemini CLI — did not, so `stats` sums went negative and export →
    // ingest of the trace this tool just wrote failed validation.
    const [t] = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.api_request', { 'session.id': 'n1', input_tokens: -4000, output_tokens: 10 }, 1_000_000),
    ]));
    const trace = getTrace(db, ingestTrace(db, t).id)!;
    expect(trace.total_tokens).toBe(10);

    expect(validateTraceInput({ ...t, total_tokens: trace.total_tokens }).valid).toBe(true);
  });

  it('drops a negative duration rather than storing one', () => {
    const [t] = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.tool_result', { 'session.id': 'n2', tool_name: 'Bash', duration_ms: -250, success: true }, 1_000_000),
    ]));
    const trace = getTrace(db, ingestTrace(db, t).id)!;
    const step = trace.steps.find((x) => x.step_type === 'tool_call')!;
    expect(step.duration_ms).toBeNull();
  });

  it('still preserves a genuine zero duration', () => {
    const [t] = mapOtlpLogs(otlpLogs([
      logRecord('claude_code.tool_result', { 'session.id': 'n3', tool_name: 'Bash', duration_ms: 0, success: true }, 1_000_000),
    ]));
    const trace = getTrace(db, ingestTrace(db, t).id)!;
    expect(trace.steps.find((x) => x.step_type === 'tool_call')!.duration_ms).toBe(0);
  });
});

describe('merging a later batch cannot invert the trace window', () => {
  it('keeps the existing duration when the merged end precedes the start', () => {
    // started_at and ended_at come from independent sets (earliest start, latest
    // end), so nothing orders them. A first batch with no renderable timestamps
    // takes the ingest wall clock as its start; a later batch contributing only
    // an end in the past then wrote a large negative total_duration_ms — which
    // the UI renders as a negative duration and `ingest` rejects.
    const first = mapOtlpTraces({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'tX', spanId: 'aa', name: 'chat', attributes: [] }] }] }],
    });
    const id = ingestTrace(db, first[0]).id;
    expect(getTrace(db, id)!.total_duration_ms).toBeNull();

    const second = mapOtlpTraces({
      resourceSpans: [{ scopeSpans: [{ spans: [
        { traceId: 'tX', spanId: 'bb', name: 'chat', endTimeUnixNano: '1610000000000000000', attributes: [] },
      ] }] }],
    });
    mergeBatchIntoTrace(db, id, second[0]);

    const merged = getTrace(db, id)!;
    expect(merged.total_duration_ms).toBeNull();
    expect(validateTraceInput({
      agent_name: merged.agent_name,
      status: merged.status,
      input: merged.input ?? {},
      total_duration_ms: merged.total_duration_ms ?? undefined,
      steps: [],
    }).valid).toBe(true);
  });
});



describe('mapOtlpLogs — per-step model', () => {
  it('gives a Claude Code tool step the model its api_request reported', () => {
    // Only `.api_error` ever set a step's model, so a session whose model calls
    // all succeeded recorded the model NOWHERE — while every api_request states
    // it. `check --golden --fields model` refuses such a baseline outright.
    const payload = otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'm1', prompt: 'fix the bug' }, 1_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'm1', model: 'claude-opus-4-5', input_tokens: 200, output_tokens: 40 }, 2_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'm1', tool_name: 'Read', success: true }, 3_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.model).toBe('claude-opus-4-5');
  });

  it('gives a Gemini tool step the model, and leaves its decision step alone', () => {
    const payload = otlpLogs([
      logRecord('gemini_cli.api_response', { 'session.id': 'm2', model: 'gemini-2.5-pro', input_token_count: 100, output_token_count: 20 }, 1_000_000),
      logRecord('gemini_cli.tool_call', { 'session.id': 'm2', function_name: 'run_shell', success: true, decision: 'accept' }, 2_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    expect(trace.steps.find((s) => s.step_type === 'tool_call')!.model).toBe('gemini-2.5-pro');
    // A tool decision is the user's call, not the model's.
    expect(trace.steps.find((s) => s.step_type === 'decision')!.model).toBeNull();
  });

  it('does not relabel earlier steps when the session falls back to another model', () => {
    const payload = otlpLogs([
      logRecord('claude_code.api_request', { 'session.id': 'm3', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 1_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'm3', tool_name: 'Read', success: true }, 2_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'm3', model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 }, 3_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'm3', tool_name: 'Write', success: true }, 4_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    const byName = Object.fromEntries(trace.steps.map((s) => [s.name, s.model]));
    expect(byName.Read).toBe('claude-opus-4-5');
    expect(byName.Write).toBe('claude-haiku-4-5');
  });

  it('back-fills a step that ran before the first model record', () => {
    const payload = otlpLogs([
      logRecord('claude_code.tool_result', { 'session.id': 'm4', tool_name: 'Read', success: true }, 1_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'm4', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 2_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    expect(trace.steps.find((s) => s.step_type === 'tool_call')!.model).toBe('claude-opus-4-5');
  });

  it('leaves the model absent when the session never reports one', () => {
    // Feed the shape that LACKS the field: an absent model must stay absent
    // rather than become an invented one.
    const payload = otlpLogs([
      logRecord('claude_code.user_prompt', { 'session.id': 'm5', prompt: 'go' }, 1_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'm5', tool_name: 'Read', success: true }, 2_000_000),
    ]);

    const [t] = mapOtlpLogs(payload);
    const trace = getTrace(db, ingestTrace(db, t).id)!;

    expect(trace.steps.every((s) => s.model == null)).toBe(true);
  });
});

describe('a log session keeps its model across batch boundaries', () => {
  // The mapper only sees one batch, and batches are cut mid-session constantly —
  // an `api_request` in one flush and the `tool_result` it led to in the next is
  // the ordinary live shape, not an edge case. Assembling a session from N
  // batches must yield the same per-step models as receiving it in one.
  const send = (db: Database.Database, records: unknown[], stats: OtelStats) =>
    handleLogsExport(db, JSON.stringify(otlpLogs(records)), stats);

  it('gives a step the model an EARLIER batch reported', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    send(db, [
      logRecord('claude_code.user_prompt', { 'session.id': 'x1', prompt: 'go' }, 1_000_000),
      logRecord('claude_code.api_request', { 'session.id': 'x1', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 2_000_000),
    ], stats);
    send(db, [
      logRecord('claude_code.tool_result', { 'session.id': 'x1', tool_name: 'Read', success: true }, 3_000_000),
    ], stats);

    const t = getTrace(db, listTraces(db, { session_id: 'x1' }).items[0].id)!;
    expect(t.steps.find((s) => s.name === 'Read')!.model).toBe('claude-opus-4-5');
  });

  it('gives a step the model a LATER batch reported, when none came before', () => {
    // A receiver started mid-session, or an out-of-order flush.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    send(db, [
      logRecord('claude_code.tool_result', { 'session.id': 'x2', tool_name: 'Read', success: true }, 1_000_000),
    ], stats);
    send(db, [
      logRecord('claude_code.api_request', { 'session.id': 'x2', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 2_000_000),
    ], stats);

    const t = getTrace(db, listTraces(db, { session_id: 'x2' }).items[0].id)!;
    expect(t.steps.find((s) => s.name === 'Read')!.model).toBe('claude-opus-4-5');
  });

  it('does not relabel an earlier batch when a later one falls back to another model', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    send(db, [
      logRecord('claude_code.api_request', { 'session.id': 'x3', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 1_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'x3', tool_name: 'Read', success: true }, 2_000_000),
    ], stats);
    send(db, [
      logRecord('claude_code.api_request', { 'session.id': 'x3', model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 }, 3_000_000),
      logRecord('claude_code.tool_result', { 'session.id': 'x3', tool_name: 'Write', success: true }, 4_000_000),
    ], stats);

    const t = getTrace(db, listTraces(db, { session_id: 'x3' }).items[0].id)!;
    const byName = Object.fromEntries(t.steps.map((s) => [s.name, s.model]));
    expect(byName.Read).toBe('claude-opus-4-5');
    expect(byName.Write).toBe('claude-haiku-4-5');
  });

  it('uses the model in effect, not the session\'s first, after a batch-boundary fallback', () => {
    // The batch that falls back to another model carries no tool step of its own,
    // and the step it affects arrives in a THIRD batch. Freezing the trace's model
    // at the first one reported would label that step with a model the session had
    // already stopped using.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    send(db, [logRecord('claude_code.api_request', { 'session.id': 'x5', model: 'claude-opus-4-5', input_tokens: 10, output_tokens: 5 }, 1_000_000)], stats);
    send(db, [logRecord('claude_code.api_request', { 'session.id': 'x5', model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 }, 2_000_000)], stats);
    send(db, [logRecord('claude_code.tool_result', { 'session.id': 'x5', tool_name: 'Read', success: true }, 3_000_000)], stats);

    const t = getTrace(db, listTraces(db, { session_id: 'x5' }).items[0].id)!;
    expect(t.steps.find((s) => s.name === 'Read')!.model).toBe('claude-haiku-4-5');
  });

  it('leaves every step model-less when no batch ever reports one', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    send(db, [logRecord('claude_code.user_prompt', { 'session.id': 'x4', prompt: 'go' }, 1_000_000)], stats);
    send(db, [logRecord('claude_code.tool_result', { 'session.id': 'x4', tool_name: 'Read', success: true }, 2_000_000)], stats);

    const t = getTrace(db, listTraces(db, { session_id: 'x4' }).items[0].id)!;
    expect(t.steps.every((s) => s.model == null)).toBe(true);
  });

  it('does not let a span step inherit a neighbour model it never declared', () => {
    // A span without a model attribute is stating it had none. Only the log
    // path infers, and only within its own session.
    const spans = (arr: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans: arr }] }] });
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleTracesExport(db, JSON.stringify(spans([
      { traceId: 'tm', spanId: '01', name: 'invoke_agent research', startTimeUnixNano: '1000000', endTimeUnixNano: '2000000',
        attributes: [attr('gen_ai.operation.name', 'invoke_agent'), attr('gen_ai.agent.name', 'research'), attr('gen_ai.request.model', 'gpt-5')] },
      { traceId: 'tm', spanId: '02', parentSpanId: '01', name: 'chat', startTimeUnixNano: '1100000', endTimeUnixNano: '1500000',
        attributes: [attr('gen_ai.operation.name', 'chat'), attr('gen_ai.request.model', 'gpt-5')] },
    ])), stats);
    handleTracesExport(db, JSON.stringify(spans([
      { traceId: 'tm', spanId: '03', parentSpanId: '01', name: 'execute_tool', startTimeUnixNano: '1600000', endTimeUnixNano: '1700000',
        attributes: [attr('gen_ai.operation.name', 'execute_tool'), attr('gen_ai.tool.name', 'search')] },
    ])), stats);

    const t = getTrace(db, listTraces(db, {}).items[0].id)!;
    expect(t.steps.find((s) => s.step_type === 'tool_call')!.model).toBeNull();
  });
});
