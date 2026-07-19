import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace } from '../src/services/trace-service.js';
import { importClaudeTranscript } from '../src/services/importers/claude-transcript.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dir = mkdtempSync(join(tmpdir(), 'ar-import-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(lines: unknown[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

describe('importClaudeTranscript', () => {
  it('imports a transcript with tool pairing, thinking, and usage', () => {
    const path = fixture([
      { type: 'user', sessionId: 'sess-xyz', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'list the files' } },
      {
        type: 'assistant',
        sessionId: 'sess-xyz',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should run ls' },
            { type: 'text', text: "I'll list them." },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
      { type: 'user', sessionId: 'sess-xyz', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] } },
      { type: 'assistant', sessionId: 'sess-xyz', message: { role: 'assistant', content: [{ type: 'text', text: 'Done — 2 files.' }], usage: { input_tokens: 120, output_tokens: 10 } } },
    ]);

    const report = importClaudeTranscript(db, path);
    expect(report.trace).not.toBeNull();
    expect(report.skipped).toBe(0);

    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.session_id).toBe('sess-xyz');
    expect(trace.status).toBe('completed');
    expect(trace.input).toEqual({ prompt: 'list the files' });
    expect(trace.output).toEqual({ text: 'Done — 2 files.' });
    expect(trace.total_tokens).toBe(250);
    expect(trace.metadata.source_format).toBe('claude-transcript');

    const thought = trace.steps.find((s) => s.step_type === 'thought');
    expect(thought?.output).toEqual({ text: 'I should run ls' });

    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('Bash');
    expect(tool.input).toEqual({ command: 'ls' });
    expect(tool.output).toEqual({ result: 'a.txt\nb.txt' });
  });

  it('is best-effort: skips corrupted and unknown records without failing', () => {
    const path = fixture([
      { type: 'user', sessionId: 's2', message: { role: 'user', content: 'hi' } },
      '{ this is not valid json',
      { type: 'future_record_type', payload: { whatever: true } },
      { type: 'assistant', sessionId: 's2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ]);

    const report = importClaudeTranscript(db, path);
    expect(report.trace).not.toBeNull();
    // one corrupted line + one unknown-type record
    expect(report.skipped).toBe(2);
    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.output).toEqual({ text: 'hello' });
  });
});

describe('importClaudeTranscript — subagents', () => {
  it('imports subagent transcript files as nested steps under an anchor', () => {
    // Main transcript
    const path = fixture([
      { type: 'user', sessionId: 'sess-sub', message: { role: 'user', content: 'research this' } },
      { type: 'assistant', sessionId: 'sess-sub', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { agent: 'Explore' } }] } },
      { type: 'user', sessionId: 'sess-sub', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    // Subagent transcript under <session>/subagents/agent-a1.jsonl
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'searching' }, { type: 'tool_use', id: 'st1', name: 'Grep', input: { pattern: 'x' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st1', content: '3 matches' }] } },
      ].map((r) => JSON.stringify(r)).join('\n'),
    );

    const report = importClaudeTranscript(db, path);
    const trace = getTrace(db, report.trace!.id)!;

    const anchor = trace.steps.find((s) => s.name === 'subagent:a1')!;
    expect(anchor).toBeTruthy();
    expect(anchor.metadata.agent_id).toBe('a1');
    const grep = trace.steps.find((s) => s.name === 'Grep')!;
    expect(grep.parent_step_number).toBe(anchor.step_number);
    expect(grep.output).toEqual({ result: '3 matches' });
  });
});
