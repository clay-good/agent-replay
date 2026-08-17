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

  it('preserves a failed tool_result (is_error) as the step error', () => {
    // Regression: the first pass indexed only tool_result `content` and dropped
    // `is_error`, so a failed tool call (a common shape — a Bash exit 1, a Read
    // on a missing file) imported as a plain `tool_call` with error=null,
    // indistinguishable from success. The failure signal must survive on the
    // `error` column, matching the live hook-adapter capture path.
    const path = fixture([
      {
        type: 'assistant',
        sessionId: 'sess-err',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_ok', name: 'Read', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'exit 1' } },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'sess-err',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'ok data' },
            { type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'Error: command failed, exit 1' },
          ],
        },
      },
    ]);

    const report = importClaudeTranscript(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    const ok = trace.steps.find((s) => s.name === 'Read')!;
    const bad = trace.steps.find((s) => s.name === 'Bash')!;
    // A successful tool call carries no error; the failed one does.
    expect(ok.step_type).toBe('tool_call');
    expect(ok.error).toBeNull();
    expect(bad.step_type).toBe('tool_call');
    expect(bad.error).toBe('Error: command failed, exit 1');
  });

  it('marks an is_error tool_result with no content as a generic tool failure', () => {
    const path = fixture([
      { type: 'assistant', sessionId: 'sess-e2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] } },
      { type: 'user', sessionId: 'sess-e2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true }] } },
    ]);
    const report = importClaudeTranscript(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    const bad = trace.steps.find((s) => s.name === 'Bash')!;
    expect(bad.error).toBe('tool failed');
  });
});

describe('importClaudeTranscript — malformed vendor values', () => {
  it('adds string token counts instead of concatenating them', () => {
    // Regression: `usage` is only *cast* to Record<string, number>; JSON gives
    // whatever the file says. A producer sending "100" made 0 + "100" + 20
    // concatenate to "010020", which numOrNull then stored as 10,020 tokens
    // instead of 120 — and the poisoning is sticky, so every later record
    // concatenated too. The Codex stream translator was hardened against
    // exactly this; the importers were missed.
    const path = fixture([
      { type: 'user', sessionId: 's1', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: '100', output_tokens: 20 } } },
      { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 5, output_tokens: 5 } } },
    ]);

    const report = importClaudeTranscript(db, path);
    expect(getTrace(db, report.trace!.id)!.total_tokens).toBe(130);
  });

  it('keeps the import when a tool_use name is not a string', () => {
    // Regression: `block.name` was bound raw into a TEXT NOT NULL column, so a
    // single non-string name anywhere in the file made better-sqlite3 refuse
    // the bind and threw out of the whole import — exit 1, nothing kept —
    // contradicting the importer's documented best-effort contract. Every
    // scalar beside it in the same insert is coerced for this reason.
    const path = fixture([
      { type: 'user', sessionId: 's2', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 's2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: { oops: 1 }, input: { x: 1 } }] } },
      { type: 'assistant', sessionId: 's2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }] } },
    ]);

    const report = importClaudeTranscript(db, path);
    expect(report.trace).not.toBeNull();
    const names = getTrace(db, report.trace!.id)!.steps.map((s) => s.name);
    expect(names).toEqual(['tool', 'Bash']); // the good step survives alongside a safe fallback
  });
});

describe('importClaudeTranscript — an empty session is a failed import', () => {
  it('produces no trace when a file yields no steps and no prompt', () => {
    // Regression: the guard was `no steps AND no sessionId`, but a header/
    // summary record supplies a session id — so a session killed before its
    // first turn produced a real, content-free trace row and `import` reported
    // success and exited 0. Its own comment says producing no trace should be a
    // failed import, so `import X && use-trace` was proceeding on nothing.
    const path = fixture([
      { type: 'summary', sessionId: 'sess-empty', timestamp: '2026-07-01T00:00:00Z', summary: 'a session that never ran' },
    ]);
    const report = importClaudeTranscript(db, path);
    expect(report.trace).toBeNull();
    expect(report.steps).toBe(0);
  });

  it('still imports a session that captured a prompt but no steps', () => {
    // A prompt is real content — keep it.
    const path = fixture([
      { type: 'user', sessionId: 'sess-prompt', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'do the thing' } },
    ]);
    const report = importClaudeTranscript(db, path);
    expect(report.trace).not.toBeNull();
    expect(getTrace(db, report.trace!.id)!.input).toEqual({ prompt: 'do the thing' });
  });
});

describe('importClaudeTranscript — subagents', () => {
  it('counts a content-less user/assistant record as skipped (every record accounted for)', () => {
    const path = fixture([
      { type: 'user', sessionId: 's3', message: { role: 'user', content: 'start' } },
      { type: 'assistant', sessionId: 's3', message: { role: 'assistant' } }, // no content → no step
      { type: 'assistant', sessionId: 's3', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    ]);
    const report = importClaudeTranscript(db, path);
    // 3 records in: user (imported), content-less assistant (skipped), assistant text (imported).
    expect(report.imported + report.skipped).toBe(3);
    expect(report.skipped).toBe(1);
  });

  it('counts a follow-up user turn and an empty-text block as skipped, not imported', () => {
    // A record that captures no input and emits no step must be tallied as
    // skipped (the imported+skipped=records invariant). Two such zero-step
    // records — a follow-up user turn (no user step type retains it) and an
    // assistant record whose only text block is empty — were mis-counted as
    // imported because `contributed` was set unconditionally in the text paths.
    const path = fixture([
      { type: 'user', sessionId: 's4', message: { content: 'first prompt' } },
      { type: 'user', sessionId: 's4', message: { content: 'second prompt' } },
      { type: 'assistant', sessionId: 's4', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', sessionId: 's4', message: { content: [{ type: 'text', text: 'answer' }] } },
    ]);
    const report = importClaudeTranscript(db, path);
    expect(report.imported + report.skipped).toBe(4);
    expect(report.imported).toBe(2); // first user prompt + assistant answer
    expect(report.skipped).toBe(2);  // follow-up user turn + empty-text assistant
  });

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

  it('preserves a failed subagent tool_result (is_error) as the step error', () => {
    const path = fixture([
      { type: 'user', sessionId: 'sess-serr', message: { role: 'user', content: 'research' } },
      { type: 'assistant', sessionId: 'sess-serr', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }] } },
      { type: 'user', sessionId: 'sess-serr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'st1', name: 'Grep', input: { pattern: 'x' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st1', is_error: true, content: 'grep: no such file' }] } },
      ].map((r) => JSON.stringify(r)).join('\n'),
    );

    const report = importClaudeTranscript(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    const grep = trace.steps.find((s) => s.name === 'Grep')!;
    expect(grep.step_type).toBe('tool_call');
    expect(grep.error).toBe('grep: no such file');
  });

  it('tolerates a corrupt line in a subagent file instead of discarding the whole file', () => {
    const path = fixture([
      { type: 'user', sessionId: 'sess-bad', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'sess-bad', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    // A truncated/garbage line (as a killed run leaves) sits between two valid records.
    writeFileSync(
      join(subDir, 'agent-b2.jsonl'),
      [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sb1', name: 'Read', input: { file: 'a' } }] } }),
        '{ this is not valid json',
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sb1', content: 'ok' }] } }),
      ].join('\n'),
    );

    const report = importClaudeTranscript(db, path);
    const trace = getTrace(db, report.trace!.id)!;
    // The anchor and the valid Read step survive; only the bad line is skipped.
    expect(trace.steps.find((s) => s.name === 'subagent:b2')).toBeTruthy();
    const read = trace.steps.find((s) => s.name === 'Read');
    expect(read).toBeTruthy();
    expect(read!.output).toEqual({ result: 'ok' });
    expect(report.skipped).toBeGreaterThanOrEqual(1);
  });

  it('reports "imported" as a record count, not a step count, for subagents', () => {
    // Regression: the subagent loop added built.steps.length to `imported`, so a
    // single subagent record expanding to N steps inflated "Records imported"
    // and broke the imported + skipped = records invariant.
    const path = fixture([
      { type: 'user', sessionId: 'sess-cnt', message: { role: 'user', content: 'hi' } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-x.jsonl'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'tool_use', id: 'a', name: 'Grep', input: {} }] } }),
    );

    const report = importClaudeTranscript(db, path);
    // Two records total (main user prompt + one subagent assistant record). The
    // subagent record expands to 2 steps but is still one imported record.
    expect(report.imported).toBe(2);
    expect(report.skipped).toBe(0);

    // The 2 subagent steps still land, nested under the anchor.
    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.steps).toHaveLength(3); // anchor + thinking + Grep
  });

  it('counts a tool_result-only subagent record as imported, like the main loop', () => {
    // A tool_result-only record contributes retained data (attached to the
    // paired tool_use step's output), so it must tally as imported — matching
    // how the main transcript loop counts the identical record. Previously the
    // subagent loop counted it skipped (it pushes no step of its own).
    const path = fixture([
      { type: 'user', sessionId: 'sess-tr', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'sess-tr', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }] } },
      { type: 'user', sessionId: 'sess-tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'st1', name: 'Grep', input: { pattern: 'x' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st1', content: '3 matches' }] } },
      ].map((r) => JSON.stringify(r)).join('\n'),
    );

    const report = importClaudeTranscript(db, path);
    // 3 main records + 2 subagent records, all contribute → 0 skipped.
    expect(report.skipped).toBe(0);
    expect(report.imported).toBe(5);
    // The subagent tool_result is retained as the Grep step's output.
    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.steps.find((s) => s.name === 'Grep')!.output).toEqual({ result: '3 matches' });
  });
});

describe('importer robustness', () => {
  it('keeps the rest of a transcript when one line parses to null', () => {
    // Both importers pushed any parsed JSON value into their record list and
    // dereferenced it unguarded, so ONE `null` line threw and aborted the whole
    // import — nothing kept from a 50,000-record transcript, against the
    // documented best-effort contract. Other scalars happened to survive.
    const dir = mkdtempSync(join(tmpdir(), 'ar-import-null-'));
    try {
      const file = join(dir, 'session.jsonl');
      writeFileSync(file, [
        JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
        'null',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      ].join('\n') + '\n');

      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const res = importClaudeTranscript(db, file, {});
        expect(res.trace).not.toBeNull();
        expect(res.imported).toBe(2);
        expect(res.skipped).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not invent a subagent step for a subagent file that yields nothing', () => {
    // The anchor was pushed BEFORE the subagent file was read, so an empty one
    // left a childless `subagent:<id>` thought step — which also made
    // steps.length non-zero, defeating the "nothing importable → exit 1" guard:
    // "Records imported: 0" and success at the same time.
    const dir = mkdtempSync(join(tmpdir(), 'ar-import-ghost-'));
    try {
      const file = join(dir, 'm2.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'y' }) + '\n');
      mkdirSync(join(dir, 'm2', 'subagents'), { recursive: true });
      writeFileSync(join(dir, 'm2', 'subagents', 'agent-ghost.jsonl'), '');

      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const res = importClaudeTranscript(db, file, {});
        expect(res.steps).toBe(0);
        expect(res.trace).toBeNull(); // nothing importable — the guard fires
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
