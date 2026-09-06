import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { applyHookPayload } from '../src/services/hook-adapter.js';
import { importClaudeTranscript } from '../src/services/importers/claude-transcript.js';
import { importCodexRollout } from '../src/services/importers/codex-rollout.js';
import { mapOtlpLogs } from '../src/services/otel/log-events.js';
import { makeTranslator } from '../src/services/stream-translators.js';
import { applyEvent } from '../src/services/recorder.js';
import { ingestTrace } from '../src/services/trace-service.js';
import type { CaptureEvent } from '../src/services/event-protocol.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { checkGolden } from '../src/services/check-service.js';
import type { GoldenEntry } from '../src/models/types.js';

/**
 * ONE SESSION, TWO CAPTURE PATHS, THE SAME FACTS.
 *
 * The premise of this tool is that a trace means the same thing however it was
 * captured: `diff` compares runs across paths, `check --golden` gates a
 * hook-captured run against a baseline that may have been imported, and the
 * evaluators read whichever they are given. Nothing tested that premise
 * directly — each path had its own tests, asserting its own shape.
 *
 * The code carries the scars of the drift this catches: "`{ prompt }` is the
 * shape every other capture path stores a prompt in (the hook adapter, the
 * transcript and rollout importers), so a recorded run matches an imported one
 * of the same prompt", and the importer's step names were changed once because
 * they "disagreed with the codex-rollout importer".
 *
 * So this captures the SAME session both ways and compares what both paths
 * claim to record. It is a net over correct behaviour, not a fix: checked by
 * mutation (renaming the hook's stored prompt key, or its tool step name,
 * fails it).
 */

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dir = mkdtempSync(join(tmpdir(), 'ar-crosspath-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The same session, as the hook adapter sees it. */
function captureViaHook(sessionId: string): string {
  const cwd = dir;
  applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: 'list the files' });
  applyHookPayload(db, {
    hook_event_name: 'PreToolUse', session_id: sessionId, cwd,
    tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  applyHookPayload(db, {
    hook_event_name: 'PostToolUse', session_id: sessionId, cwd,
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a.txt' },
  });
  const done = applyHookPayload(db, { hook_event_name: 'Stop', session_id: sessionId, cwd });
  return done.traceId!;
}

/** The same session, as its transcript on disk. */
function captureViaImport(sessionId: string): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, [
    { type: 'user', sessionId, timestamp: '2026-09-06T10:00:00.000Z', message: { content: 'list the files' } },
    {
      type: 'assistant', sessionId, timestamp: '2026-09-06T10:00:01.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
    },
    {
      type: 'user', sessionId, timestamp: '2026-09-06T10:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] },
    },
  ].map((r) => JSON.stringify(r)).join('\n'));
  return importClaudeTranscript(db, path).trace!.id;
}

/** The same session, as OpenTelemetry log events from the same harness. */
function captureViaOtelLogs(sessionId: string): string {
  const record = (event: string, attrs: Record<string, unknown>, nanos: string) => ({
    timeUnixNano: nanos,
    body: { stringValue: event },
    attributes: [
      { key: 'event.name', value: { stringValue: event } },
      { key: 'session.id', value: { stringValue: sessionId } },
      ...Object.entries(attrs).map(([key, v]) => ({
        key,
        value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) },
      })),
    ],
  });
  const [mapped] = mapOtlpLogs({
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeLogs: [{ logRecords: [
        record('claude_code.user_prompt', { prompt: 'list the files' }, '1750000000000000000'),
        record('claude_code.tool_result', { tool_name: 'Bash', success: 'true', duration_ms: 40 }, '1750000001000000000'),
      ] }],
    }],
  } as never);
  return ingestTrace(db, mapped).id;
}

/** One Codex session, through the stream translator and through its rollout. */
function captureCodexBothWays(): { stream: string; rollout: string } {
  const translator = makeTranslator('codex-exec')!;
  let streamId = '';
  // `translate` takes the PARSED line, and `finalize` flushes what the stream
  // left open at EOF — the same two calls `record` makes.
  for (const line of [
    { type: 'thread.started', thread_id: 'cx-stream' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls -la', exit_code: 0, aggregated_output: 'a.txt' } },
    { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 10 } },
  ]) {
    for (const event of translator.translate(line as Record<string, unknown>)) {
      streamId = applyEvent(db, event as CaptureEvent).traceId;
    }
  }
  for (const event of translator.finalize()) streamId = applyEvent(db, event as CaptureEvent).traceId;

  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, [
    { timestamp: '2026-09-06T10:00:00.000Z', type: 'session_meta', payload: { id: 'cx-roll', cwd: '/tmp' } },
    { timestamp: '2026-09-06T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] } },
    { timestamp: '2026-09-06T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls","-la"]}', call_id: 'c1' } },
    { timestamp: '2026-09-06T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  return { stream: streamId, rollout: importCodexRollout(db, path).trace!.id };
}

describe('one session captured two ways records the same facts', () => {
  it('agrees on the prompt, the status and the tool step', () => {
    const hook = getTrace(db, captureViaHook('sess-hook'))!;
    const imported = getTrace(db, captureViaImport('sess-file'))!;

    // The prompt, in the shape every path stores it in. A path that renamed
    // this key would break `check --golden` matching (agent + input hash)
    // between a live run and its own transcript.
    expect(hook.input).toEqual({ prompt: 'list the files' });
    expect(imported.input).toEqual(hook.input);

    // A finished session is `completed` either way.
    expect(hook.status).toBe('completed');
    expect(imported.status).toBe(hook.status);

    // The tool call is a `tool_call` step named for the TOOL in both — the
    // field `check --fields step_names` compares across paths.
    const shape = (t: typeof hook) => t.steps.map((s) => [s.step_type, s.name]);
    expect(shape(hook)).toEqual([['tool_call', 'Bash']]);
    expect(shape(imported)).toEqual(shape(hook));

    // Both paths close what they finished.
    for (const t of [hook, imported]) {
      expect(t.steps.filter((s) => !s.ended_at)).toEqual([]);
    }
  });

  it('records which path captured each, so a store can tell them apart', () => {
    captureViaHook('sess-hook-2');
    captureViaImport('sess-file-2');
    const sources = listTraces(db, {}).items
      .map((t) => (t.metadata as { source_format?: string } | null)?.source_format)
      .sort();
    expect(sources).toEqual(['claude-transcript', 'hook']);
  });
});

describe('a failed tool call is a failure on every path', () => {
  // The sharpest form of the premise: an evaluator must score one session the
  // same however it was captured. It did not — the hook stored a failed call
  // clean (only a `post_tool_fail` EVENT counted, which Claude Code never
  // sends) while the transcript importer read `is_error` off the tool_result.
  // `no_error_steps` then scored 1.0 against 0.7 for one session.
  it('the hook and the importer agree that the tool failed', () => {
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: 'fail-hook', cwd: dir, prompt: 'delete it' });
    applyHookPayload(db, {
      hook_event_name: 'PreToolUse', session_id: 'fail-hook', cwd: dir,
      tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
    });
    const hookRes = applyHookPayload(db, {
      hook_event_name: 'PostToolUse', session_id: 'fail-hook', cwd: dir,
      tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' },
      tool_response: { stderr: 'permission denied', is_error: true },
    });

    const path = join(dir, 'failed.jsonl');
    writeFileSync(path, [
      { type: 'user', sessionId: 'fail-file', timestamp: '2026-09-06T10:00:00.000Z', message: { content: 'delete it' } },
      {
        type: 'assistant', sessionId: 'fail-file', timestamp: '2026-09-06T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] },
      },
      {
        type: 'user', sessionId: 'fail-file', timestamp: '2026-09-06T10:00:02.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'permission denied', is_error: true }] },
      },
    ].map((r) => JSON.stringify(r)).join('\n'));

    const hook = getTrace(db, hookRes.traceId!)!;
    const imported = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const errorOf = (t: typeof hook) => t.steps.find((s) => s.step_type === 'tool_call')!.error;
    expect(errorOf(hook)).toBe('permission denied');
    expect(errorOf(imported)).toBe(errorOf(hook));
  });
});

describe('a baseline from one path gates a run from another', () => {
  // What the agreement is FOR. The documented workflow is "export a golden
  // dataset once, then check new runs against it" — and the runs in a real
  // project rarely come from the same path as the baseline: you import the
  // transcripts you already have, then capture live in CI through the hook.
  // If the paths disagreed about names, inputs or step shape, that gate would
  // report a regression on every run, caused by the tool rather than the agent.
  it('a hook-captured run passes a baseline exported from its imported twin', () => {
    const path = join(dir, 'good.jsonl');
    writeFileSync(path, [
      { type: 'user', sessionId: 'gate-file', timestamp: '2026-09-06T10:00:00.000Z', message: { content: 'list the files' } },
      {
        type: 'assistant', sessionId: 'gate-file', timestamp: '2026-09-06T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
      },
      {
        type: 'user', sessionId: 'gate-file', timestamp: '2026-09-06T10:00:02.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] },
      },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const imported = importClaudeTranscript(db, path).trace!.id;
    const golden = JSON.parse(exportTraces(db, { id: imported }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(1);

    const live = getTrace(db, captureViaHook('gate-live'))!;
    const report = checkGolden(golden, [live]);
    expect(report.results.map((r) => [r.matched, r.passed])).toEqual([[true, true]]);
    expect(report.failed).toBe(0);
  });
});

describe('every capture path records a tool failure', () => {
  // The invariant behind the bug above, stated once for all five paths: a tool
  // that failed must reach the store as a failed step, whatever captured it.
  // `no_error_steps`, `completeness-check` and `check --fields step_errors` all
  // read that field, so a path that misses it passes runs that failed.
  const errorsOf = (traceId: string): (string | null)[] =>
    getTrace(db, traceId)!.steps.filter((s) => s.step_type === 'tool_call').map((s) => s.error);

  it('hook, claude-stream, codex-exec, transcript and OTel logs all record it', () => {
    // 1. hook: the failure is inside the PostToolUse result.
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: 'e-hook', cwd: dir, prompt: 'go' });
    applyHookPayload(db, { hook_event_name: 'PreToolUse', session_id: 'e-hook', cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } });
    const hook = applyHookPayload(db, {
      hook_event_name: 'PostToolUse', session_id: 'e-hook', cwd: dir, tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' }, tool_response: { stderr: 'permission denied', is_error: true },
    });
    expect(errorsOf(hook.traceId!)).toEqual(['permission denied']);

    // 2. claude-stream: a tool_result block flagged is_error.
    const cs = makeTranslator('claude-stream')!;
    let streamId = '';
    for (const line of [
      { type: 'system', subtype: 'init', session_id: 'e-stream' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'permission denied', is_error: true }] } },
      { type: 'result', subtype: 'success' },
    ]) {
      for (const event of cs.translate(line as Record<string, unknown>)) streamId = applyEvent(db, event as CaptureEvent).traceId;
    }
    expect(errorsOf(streamId)).toEqual(['permission denied']);

    // 3. codex-exec: a non-zero exit code on the completed item.
    const cx = makeTranslator('codex-exec')!;
    let codexId = '';
    for (const line of [
      { type: 'thread.started', thread_id: 'e-codex' },
      { type: 'item.completed', item: { type: 'command_execution', command: 'rm -rf /tmp/x', exit_code: 1, aggregated_output: 'permission denied' } },
      { type: 'turn.completed', usage: {} },
    ]) {
      for (const event of cx.translate(line as Record<string, unknown>)) codexId = applyEvent(db, event as CaptureEvent).traceId;
    }
    for (const event of cx.finalize()) codexId = applyEvent(db, event as CaptureEvent).traceId;
    expect(errorsOf(codexId)).toEqual(['exited with code 1']);

    // 4. the transcript importer: is_error on the tool_result.
    const path = join(dir, 'failed-tool.jsonl');
    writeFileSync(path, [
      { type: 'user', sessionId: 'e-file', timestamp: '2026-09-06T10:00:00.000Z', message: { content: 'go' } },
      {
        type: 'assistant', sessionId: 'e-file', timestamp: '2026-09-06T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] },
      },
      {
        type: 'user', sessionId: 'e-file', timestamp: '2026-09-06T10:00:02.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'permission denied', is_error: true }] },
      },
    ].map((r) => JSON.stringify(r)).join('\n'));
    expect(errorsOf(importClaudeTranscript(db, path).trace!.id)).toEqual(['permission denied']);

    // 5. the OTel log receiver: success=false with an error attribute.
    const [mapped] = mapOtlpLogs({
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: '1750000000000000000',
          body: { stringValue: 'claude_code.tool_result' },
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.tool_result' } },
            { key: 'session.id', value: { stringValue: 'e-otel' } },
            { key: 'tool_name', value: { stringValue: 'Bash' } },
            { key: 'success', value: { stringValue: 'false' } },
            { key: 'error', value: { stringValue: 'permission denied' } },
          ],
        }] }],
      }],
    } as never);
    expect(errorsOf(ingestTrace(db, mapped).id)).toEqual(['permission denied']);
  });
});

describe('the other capture pairs agree too', () => {
  it('the hook and the OTel log receiver record one Claude session the same way', () => {
    const hook = getTrace(db, captureViaHook('sess-hook-otel'))!;
    const otel = getTrace(db, captureViaOtelLogs('sess-otel'))!;

    expect(otel.agent_name).toBe(hook.agent_name);
    expect(otel.input).toEqual(hook.input);
    expect(otel.status).toBe(hook.status);
    expect(otel.steps.map((s) => [s.step_type, s.name])).toEqual(hook.steps.map((s) => [s.step_type, s.name]));
    // Both close what they finished — the log path did not until the mapper
    // learned that a log record reports the past.
    for (const t of [hook, otel]) expect(t.steps.filter((s) => !s.ended_at)).toEqual([]);
  });

  it('the codex stream and the codex rollout agree on everything but the tool NAME', () => {
    const { stream, rollout } = captureCodexBothWays();
    const a = getTrace(db, stream)!;
    const b = getTrace(db, rollout)!;

    expect(b.agent_name).toBe(a.agent_name);
    expect(b.status).toBe(a.status);
    expect(b.steps.map((s) => s.step_type)).toEqual(a.steps.map((s) => s.step_type));

    // A documented difference, not a defect: a STREAM carries no prompt — the
    // harness took it on the command line, which never appears in the stream —
    // so `record --input` exists to supply one, and `check` refuses to match a
    // trace with an empty input rather than pairing unrelated runs.
    expect(a.input).toEqual({});
    expect(b.input).toEqual({ prompt: 'list the files' });
    for (const t of [a, b]) expect(t.steps.filter((s) => !s.ended_at)).toEqual([]);

    // The one difference, held here on purpose: the stream names a shell call
    // after the COMMAND and the rollout after the CALL. `step_names` is a
    // default gate field, so a baseline from one path reports a regression
    // against the other — written up as `openspec/changes/align-tool-step-names`
    // rather than decided here. When it is decided, this expectation is the
    // thing to change.
    expect([a.steps[0].name, b.steps[0].name]).toEqual(['ls', 'shell']);
  });
});
