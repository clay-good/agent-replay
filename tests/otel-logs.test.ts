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
});
