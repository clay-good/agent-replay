import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace } from '../src/services/trace-service.js';
import { importCodexRollout } from '../src/services/importers/codex-rollout.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dir = mkdtempSync(join(tmpdir(), 'ar-codex-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(lines: unknown[]): string {
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

describe('importCodexRollout', () => {
  it('imports session identity, paired function calls, reasoning, and messages', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-1', timestamp: '2026-07-02T00:00:00Z', cwd: '/repo', git: { branch: 'main', sha: 'abc123' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'fix the build' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: 'inspect the failing target' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"make"}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'build ok' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Fixed the build.' } },
    ]);

    const report = importCodexRollout(db, path);
    expect(report.trace).not.toBeNull();
    expect(report.skipped).toBe(0);

    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.agent_name).toBe('codex');
    expect(trace.session_id).toBe('roll-1');
    expect(trace.input).toEqual({ prompt: 'fix the build' });
    expect(trace.output).toEqual({ text: 'Fixed the build.' });
    expect((trace.metadata.git as { branch?: string })?.branch).toBe('main');

    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('shell');
    expect(tool.input).toEqual({ cmd: 'make' });
    expect(tool.output).toEqual({ output: 'build ok' });

    expect(trace.steps.some((s) => s.step_type === 'thought' && s.name === 'reasoning')).toBe(true);
  });

  it('counts a follow-up user turn as skipped, not imported (no user step home)', () => {
    // A normal multi-turn session. The first user prompt is the trace input and
    // both assistant answers are steps, but a follow-up user turn is retained
    // nowhere (there is no 'user' step type). It must count as skipped — before,
    // it was marked imported while its text was dropped, inflating the tally.
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-mt' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'first question' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'first answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'second question' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'second answer' } },
    ]);
    const report = importCodexRollout(db, path);
    // 5 records; the follow-up user turn is the one skipped.
    expect(report.imported + report.skipped).toBe(5);
    expect(report.skipped).toBe(1);

    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.input).toEqual({ prompt: 'first question' });
    expect(trace.steps.filter((s) => s.name === 'assistant_message')).toHaveLength(2);
  });

  it('reads reasoning text from content when summary is an empty array', () => {
    // The Responses API serializes a reasoning item with no generated summary as
    // `summary: []` (present but empty), carrying the actual text in `content`.
    // An empty array is not nullish, so a `summary ?? content` fallback keeps the
    // empty summary and drops the reasoning; the fallback must treat "" as absent.
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-3' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'why did it fail?' } },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'the target was missing' }],
        },
      },
    ]);

    const report = importCodexRollout(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    const reasoning = trace.steps.find((s) => s.name === 'reasoning')!;
    expect(reasoning.output).toEqual({ text: 'the target was missing' });
  });

  it('reads an assistant message from text when content is an empty array', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-4' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [], text: 'hello there' } },
    ]);

    const report = importCodexRollout(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.output).toEqual({ text: 'hello there' });
    expect(trace.steps.find((s) => s.name === 'assistant_message')?.output).toEqual({ text: 'hello there' });
  });

  it('is best-effort: skips corrupted and unknown records, notes compaction', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-2' } },
      'not json at all',
      { type: 'response_item', payload: { type: 'some_future_item', foo: 1 } },
      { type: 'compacted', payload: {} },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'ok' } },
    ]);

    const report = importCodexRollout(db, path);
    expect(report.trace).not.toBeNull();
    // one corrupted line + one unknown item type
    expect(report.skipped).toBe(2);
    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.metadata.compacted).toBe(true);
    expect(trace.metadata.source_format).toBe('codex-rollout');
  });
});
