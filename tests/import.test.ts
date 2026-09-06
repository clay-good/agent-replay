import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { runImport } from '../src/commands/import.js';
import { forkTrace } from '../src/services/fork-service.js';
import { getTrace, createEval, ingestTrace, listTraces } from '../src/services/trace-service.js';
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

describe('importClaudeTranscript — when each step happened', () => {
  // The storage layer defaults a step with no `started_at` to NOW, so an
  // imported session's steps claimed to have happened at IMPORT time -- months
  // after the trace's own started_at, and after its ended_at, i.e. outside the
  // window of the trace they belong to. A wrong timestamp reads exactly like a
  // right one: `show` drew the whole timeline at the import moment, and
  // `replay` had no real pacing to work from. The trace's own start and end
  // were already read from these very timestamps; only the steps were left out.
  // The OTel mapper has always stamped each step from its span's start.
  const timed = () => fixture([
    { type: 'user', sessionId: 'tt', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', sessionId: 'tt', timestamp: '2026-07-01T00:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', sessionId: 'tt', timestamp: '2026-07-01T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', sessionId: 'tt', timestamp: '2026-07-01T00:00:12Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ]);

  it('stamps each step with the moment its record was written', () => {
    const trace = getTrace(db, importClaudeTranscript(db, timed()).trace!.id)!;
    expect(trace.steps.map((s) => s.started_at)).toEqual([
      '2026-07-01T00:00:05Z', // the tool_use record
      '2026-07-01T00:00:12Z', // the final assistant message
    ]);
  });

  it('leaves no step outside the window of its own trace', () => {
    // The property that made the old behaviour obviously wrong rather than
    // merely missing, and the one worth guarding: an import months later put
    // every step after the trace had already ended.
    const trace = getTrace(db, importClaudeTranscript(db, timed()).trace!.id)!;
    expect(trace.steps.length).toBeGreaterThan(0);
    for (const s of trace.steps) {
      expect(s.started_at! >= trace.started_at, `step ${s.step_number} starts before its trace`).toBe(true);
      expect(s.started_at! <= trace.ended_at!, `step ${s.step_number} starts after its trace ended`).toBe(true);
    }
  });

  it('holds that property even when a record carries no timestamp of its own', () => {
    // The version above only proves the property for a fully-timestamped
    // transcript, which is the easy case -- so on its own it reads stronger
    // than it is. A record with no timestamp still has to hand its steps
    // SOMETHING, because the storage layer defaults a missing started_at to
    // now, which is exactly the out-of-window stamp being guarded against. It
    // inherits the last timestamp seen: a measured value, and an ordering
    // bound, rather than an invented one.
    const path = fixture([
      { type: 'user', sessionId: 'sc', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'sc', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', sessionId: 'sc', timestamp: '2026-07-01T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', sessionId: 'sc', timestamp: '2026-07-01T00:00:12Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const bash = trace.steps.find((s) => s.name === 'Bash')!;
    expect(bash.started_at).toBe('2026-07-01T00:00:00Z'); // the previous record's time
    for (const s of trace.steps) {
      expect(s.started_at! >= trace.started_at).toBe(true);
      expect(s.started_at! <= trace.ended_at!).toBe(true);
    }
  });

  it('keeps an untimestamped subagent record inside the session window', () => {
    const path = fixture([
      { type: 'user', sessionId: 'sub-nt', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'research' } },
      { type: 'assistant', sessionId: 'sub-nt', timestamp: '2026-07-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { agent: 'Explore' } }] } },
      { type: 'user', sessionId: 'sub-nt', timestamp: '2026-07-01T00:00:20Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sub says' }] } }]
        .map((r) => JSON.stringify(r)).join('\n'),
    );
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const sub = trace.steps.find((s) => s.name === 'assistant_message')!;
    // Subagent files are read after the main loop and carry no link back to
    // the Task call that spawned them, so the exact invocation moment is not
    // recoverable. What IS guaranteed, and all that is claimed: a time drawn
    // from the session's own records, inside the session's window -- never the
    // import moment, which is what the storage default would have supplied.
    expect(sub.started_at! >= trace.started_at).toBe(true);
    expect(sub.started_at! <= trace.ended_at!).toBe(true);
    // And specifically NOT the import moment: the session is in 2026-07 and
    // this assertion fails the day the storage default creeps back in.
    expect(sub.started_at!.startsWith('2026-07-01')).toBe(true);
  });

  it('(original window check, fully timestamped)', () => {
    const trace = getTrace(db, importClaudeTranscript(db, timed()).trace!.id)!;
    for (const s of trace.steps) {
      expect(s.started_at! >= trace.started_at, `step ${s.step_number} starts before its trace`).toBe(true);
      expect(s.started_at! <= trace.ended_at!, `step ${s.step_number} starts after its trace ended`).toBe(true);
    }
  });

  it('stamps a subagent step from its own record, not the parent import', () => {
    const path = fixture([
      { type: 'user', sessionId: 'sub-t', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'research' } },
      { type: 'assistant', sessionId: 'sub-t', timestamp: '2026-07-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { agent: 'Explore' } }] } },
      { type: 'user', sessionId: 'sub-t', timestamp: '2026-07-01T00:00:20Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [{ type: 'assistant', timestamp: '2026-07-01T00:00:07Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub says' }] } }]
        .map((r) => JSON.stringify(r)).join('\n'),
    );
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const sub = trace.steps.find((s) => s.name === 'assistant_message')!;
    expect(sub.started_at).toBe('2026-07-01T00:00:07Z');
  });
});

describe('importClaudeTranscript — the model each message ran on', () => {
  // Every assistant record in a real transcript carries `message.model`, and it
  // was read by nobody: an imported session recorded which tools ran and what
  // they cost, but not the model that produced any of it. Every other capture
  // path keeps it -- the live recorder, the hook adapter and the OTel mapper
  // all set a step's `model` -- and `check --golden --fields model` can only
  // compare a field the baseline actually carries, so an imported trace could
  // never be gated on the one thing a model upgrade changes.

  it('records the model on an assistant step, in both content shapes', () => {
    // Real transcripts use the block form; the string form is the older shape
    // the importer still accepts. Fixing one and not the other is the mistake
    // this file has already made once, for the empty-prompt tally.
    const path = fixture([
      { type: 'user', sessionId: 'm1', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId: 'm1', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'block form' }] } },
      { type: 'assistant', sessionId: 'm1', message: { role: 'assistant', model: 'claude-haiku-4-5', content: 'string form' } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const models = trace.steps.filter((s) => s.name === 'assistant_message').map((s) => s.model);
    expect(models).toEqual(['claude-opus-4-5', 'claude-haiku-4-5']);
  });

  it('leaves the model null when the record carries none, rather than inventing one', () => {
    // An older transcript, or a record that simply has no model, must not
    // inherit a neighbour's -- a wrong model reads exactly like a right one.
    const path = fixture([
      { type: 'user', sessionId: 'm2', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId: 'm2', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', sessionId: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      { type: 'assistant', sessionId: 'm2', message: { role: 'assistant', model: '', content: [{ type: 'text', text: 'third' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const models = trace.steps.filter((s) => s.name === 'assistant_message').map((s) => s.model);
    expect(models).toEqual(['claude-opus-4-5', null, null]);
  });

  it('stamps EVERY step the record produced, not just the text reply', () => {
    // A `tool_call` step is the model's decision to call a tool and a
    // `thinking` step is its reasoning; both come from the same assistant
    // record and were produced by the same model. The OTel mapper already
    // treats every step of a span this way, and `--fields model` compares
    // steps -- so stopping at assistant_message would have compared the text
    // replies and silently skipped the tool calls.
    const path = fixture([
      { type: 'user', sessionId: 'all', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'all', message: { role: 'assistant', model: 'claude-opus-4-5', content: [
        { type: 'thinking', thinking: 'I should run ls' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'listing' },
      ] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.steps.map((s) => [s.name, s.model])).toEqual([
      ['thinking', 'claude-opus-4-5'],
      ['Bash', 'claude-opus-4-5'],
      ['assistant_message', 'claude-opus-4-5'],
    ]);
  });

  it('ignores a model that is not a string', () => {
    // `message.model` comes from a file on disk, so its shape is not
    // guaranteed. The sibling `usage` handling in this importer documents what
    // trusting that costs there (one string value poisons every later `+=`),
    // so this is read as a non-empty string rather than cast — an object, a
    // number or a null all leave the step's model unset rather than storing
    // something no consumer can compare.
    const path = fixture([
      { type: 'user', sessionId: 'e1', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'e1', message: { role: 'assistant', model: { weird: 'object' }, content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', sessionId: 'e1', message: { role: 'assistant', model: 123, content: [{ type: 'text', text: 'b' }] } },
      { type: 'assistant', sessionId: 'e1', message: { role: 'assistant', model: null, content: [{ type: 'text', text: 'c' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.steps.map((s) => s.model)).toEqual([null, null, null]);
  });

  it('records the model on a SUBAGENT step too', () => {
    // A subagent may well run a different model from the session that spawned
    // it, which is most of the point of looking. The subagent importer is a
    // separate loop, so it needed the same read -- the twin this repo keeps
    // leaving behind.
    const path = fixture([
      { type: 'user', sessionId: 'sess-model', message: { role: 'user', content: 'research this' } },
      { type: 'assistant', sessionId: 'sess-model', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { agent: 'Explore' } }] } },
      { type: 'user', sessionId: 'sess-model', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [
        { type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'sub says' }] } },
      ].map((r) => JSON.stringify(r)).join('\n'),
    );
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    const sub = trace.steps.find((s) => s.name === 'assistant_message' && s.model === 'claude-haiku-4-5');
    expect(sub, 'the subagent step kept its own model').toBeTruthy();
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

  it('keeps a follow-up user turn, and still counts an empty block as skipped', () => {
    // A record that captures nothing and emits no step must be tallied as
    // skipped (the imported+skipped=records invariant) — that still holds for
    // the empty-text assistant record. A follow-up user turn is no longer one
    // of those: it used to be retained NOWHERE, so a multi-turn session kept
    // only its first question. It now goes to `metadata.follow_up_prompts`,
    // the convention the batch merge and the OTLP mapper already follow, and
    // therefore counts as imported.
    const path = fixture([
      { type: 'user', sessionId: 's4', message: { content: 'first prompt' } },
      { type: 'user', sessionId: 's4', message: { content: 'second prompt' } },
      { type: 'assistant', sessionId: 's4', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', sessionId: 's4', message: { content: [{ type: 'text', text: 'answer' }] } },
    ]);
    const report = importClaudeTranscript(db, path);
    expect(report.imported + report.skipped).toBe(4);
    expect(report.imported).toBe(3); // both user turns + assistant answer
    expect(report.skipped).toBe(1);  // empty-text assistant only

    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.input).toEqual({ prompt: 'first prompt' });
    expect(trace.metadata.follow_up_prompts).toEqual(['second prompt']);
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

describe('records that contribute nothing are not counted as imported', () => {
  // A tool_result whose id pairs with nothing is stored NOWHERE — routine when a
  // transcript is head-truncated (after /compact, a partially copied file, or
  // when the tool_use line itself was unparseable). Counting it as imported
  // reported content the store does not have.
  it('counts an orphan tool_result as skipped', () => {
    const file = join(dir, 'orphan.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ORPHAN', content: 'lost output' }] } }),
    ].join('\n'));

    const report = importClaudeTranscript(db, file);
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.imported + report.skipped).toBe(2);
  });

  it('still counts a paired tool_result as imported', () => {
    const file = join(dir, 'paired.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { cmd: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'a b c' }] } }),
    ].join('\n'));

    const report = importClaudeTranscript(db, file);
    expect(report.skipped).toBe(0);
    expect(report.imported).toBe(3);
  });

  // `{prompt: ''}` is truthy, so an EMPTY first user record read as "input
  // captured" and the next, real prompt was discarded — the trace kept no
  // question at all.
  it('does not let an empty first prompt block the real one', () => {
    const file = join(dir, 'emptyfirst.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: '' } }),
      JSON.stringify({ type: 'user', message: { content: 'the real question' } }),
    ].join('\n'));

    const report = importClaudeTranscript(db, file);
    expect((report.trace?.input as { prompt?: string })?.prompt).toBe('the real question');
  });
});

describe('an empty first prompt never eats the real one', () => {
  // The fix was applied to the string-content branch only; ARRAY content is the
  // shape real Claude Code user records use, so the bug stayed fully reachable.
  for (const [label, first] of [
    ['an empty text block', [{ type: 'text', text: '' }]],
    ['a whitespace-only text block', [{ type: 'text', text: '   \n' }]],
    ['an empty string', ''],
    ['a whitespace-only string', '   \n'],
  ] as const) {
    it(`keeps the real question when the first record is ${label}`, () => {
      const file = join(dir, `first-${label.replace(/\W+/g, '-')}.jsonl`);
      writeFileSync(file, [
        JSON.stringify({ type: 'user', message: { content: first } }),
        JSON.stringify({ type: 'user', message: { content: 'THE REAL QUESTION' } }),
      ].join('\n'));

      const report = importClaudeTranscript(db, file);
      expect((report.trace?.input as { prompt?: string })?.prompt).toBe('THE REAL QUESTION');
      // And the empty record is a skipped record, on both content shapes.
      expect(report.skipped).toBe(1);
      expect(report.imported + report.skipped).toBe(2);
    });
  }
});

describe('the subagent path tallies like the main loop it mirrors', () => {
  it('counts an orphan tool_result in a subagent file as skipped', () => {
    // Subagent transcripts live at <session>/subagents/agent-*.jsonl, beside the
    // main file — the same layout the nesting test uses.
    const main = fixture([
      { type: 'user', sessionId: 'sess-orphan', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 'sess-orphan', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'A1', name: 'Task', input: { agent: 'Explore' } }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-orphan.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ORPHAN', content: 'lost output' }] } }),
    );

    const report = importClaudeTranscript(db, main);
    // The orphan result is retained nowhere, so it is a skipped record — the
    // main loop already counted it that way and this path claimed to mirror it.
    expect(report.skipped).toBe(1);
    expect(report.imported + report.skipped).toBe(3);
  });
});

describe('a file that captured nothing is a failed import in both importers', () => {
  it('refuses a transcript whose only record is an empty prompt', () => {
    // The guard used `!input`, but an empty first user record still SETS input
    // to `{prompt: ''}` — truthy — so the file reported "0 imported, 1 skipped"
    // and then created a trace with an empty prompt and no steps, exiting 0.
    const file = join(dir, 'onlyempty.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: '' } }));
    const report = importClaudeTranscript(db, file);
    expect(report.trace).toBeNull();
    expect(report.imported).toBe(0);
  });

  it('still imports a transcript that captured a real prompt but no steps', () => {
    const file = join(dir, 'promptonly.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'a real question' } }));
    const report = importClaudeTranscript(db, file);
    expect(report.trace).not.toBeNull();
    expect((report.trace?.input as { prompt?: string })?.prompt).toBe('a real question');
  });
});


describe('a usage block is more than its uncached pair', () => {
  // Summing `input_tokens + output_tokens` alone dropped both cache fields,
  // which is where nearly all of a real session's consumption lives: on a 52 MB
  // transcript from this machine the stored figure was 1,216,025 against an
  // actual 581,945,188 — 0.2% of the truth — and the billable-but-uncached
  // 4.3M `cache_creation` went with it. `stats`, the dashboard totals and
  // anything budget-shaped read that number.
  it('counts cache_creation and cache_read tokens', () => {
    const path = fixture([
      { type: 'user', sessionId: 'tok', message: { content: 'go' } },
      {
        type: 'assistant',
        sessionId: 'tok',
        message: {
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
        },
      },
    ]);
    expect(getTrace(db, importClaudeTranscript(db, path).trace!.id)!.total_tokens).toBe(4330);
  });

  // The subagent path is a TWIN of the main loop and has drifted from it
  // before, so both are asserted in one test: they now share one helper, and
  // this fails if either side stops using it.
  it('counts them the same way inside a subagent transcript', () => {
    const path = fixture([
      { type: 'user', sessionId: 'tok-sub', message: { role: 'user', content: 'research' } },
      { type: 'assistant', sessionId: 'tok-sub', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 8 } } },
      { type: 'user', sessionId: 'tok-sub', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    ]);
    const subDir = join(dir, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-t1.jsonl'),
      [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'found it' }], usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } } }]
        .map((l) => JSON.stringify(l)).join('\n'),
    );
    // main 1+1+8 = 10, subagent 2+3+100+900 = 1005
    expect(getTrace(db, importClaudeTranscript(db, path).trace!.id)!.total_tokens).toBe(1015);
  });
});

describe('the stored prompt is what the person asked', () => {
  // Real transcripts open with a harness envelope — a slash-command block,
  // injected instructions, an environment preamble — so `trace.input.prompt`,
  // which `why`, the summarizer, the rubric evals and `check` all read as
  // "what was asked", held boilerplate while the real question sat in a turn
  // that was discarded outright.
  it('skips a slash-command envelope and keeps the real question', () => {
    const path = fixture([
      { type: 'user', sessionId: 'env', message: { content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>' } },
      { type: 'user', sessionId: 'env', message: { content: 'why did the deploy fail?' } },
      { type: 'assistant', sessionId: 'env', message: { content: [{ type: 'text', text: 'because...' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.input).toEqual({ prompt: 'why did the deploy fail?' });
    // The envelope is preserved, not silently dropped — but in `preamble_prompts`,
    // not `follow_up_prompts`: that field means "later turns" in the batch merge
    // and the OTLP mapper, and a turn that came BEFORE the prompt is not one.
    expect(trace.metadata.preamble_prompts).toEqual(['<command-name>/goal</command-name>\n<command-message>goal</command-message>']);
    expect(trace.metadata.follow_up_prompts).toBeUndefined();
  });

  it('says when the session was already captured live', () => {
    // The identity check keys on session id AND source format AND source file,
    // so it only recognizes a previous IMPORT. A live capture of the same
    // session — the hook adapter, or the OTel receiver — carries no
    // source_format and never matches, so importing the transcript of a session
    // you also captured live silently doubles it: two traces, same agent, same
    // session id, and every store-wide count includes both.
    const sessionId = 'sess-live-and-file';
    // Seed the store `runImport` will open, not the in-memory one above.
    const store = ensureDatabase(resolve(dir, 'traces.db'));
    ingestTrace(store, {
      agent_name: 'claude-code', status: 'running', session_id: sessionId,
      input: { prompt: 'fix the bug' },
      metadata: { dialect: 'claude-code' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'Bash' }],
    } as never);

    const path = fixture([
      { type: 'user', sessionId, message: { content: 'fix the bug' } },
      { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: 'done' }] } },
    ]);
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m ?? '')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runImport(path, { dir });
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(errs.join('\n')).toMatch(/already captured live/);
    expect(errs.join('\n')).toMatch(/2 traces for it/);
    // Both are kept: the transcript and the live capture record different things.
    expect(listTraces(store, {}).items.filter((t) => t.session_id === sessionId)).toHaveLength(2);
    resetConnection();
  });

  it('skips the compaction summary and records that the session was continued', () => {
    // A long session runs out of context, is compacted, and the new transcript
    // opens with a summary the HARNESS wrote — as a user turn. It was chosen as
    // the prompt of every such session: measured on two real transcripts,
    // `input.prompt` held 10 KB of summary while the user's own message sat in
    // `follow_up_prompts`.
    const summary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: it did things.';
    const path = fixture([
      { type: 'system', subtype: 'compact_boundary', sessionId: 'cmp' },
      { type: 'user', sessionId: 'cmp', isCompactSummary: true, message: { content: summary } },
      { type: 'user', sessionId: 'cmp', message: { content: 'now fix the flaky test' } },
      { type: 'assistant', sessionId: 'cmp', message: { content: [{ type: 'text', text: 'done' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.input).toEqual({ prompt: 'now fix the flaky test' });
    // Kept, not dropped — and before the prompt, so it is preamble.
    expect(trace.metadata.preamble_prompts).toEqual([summary]);
    // The file starts mid-story: the steps before the boundary are in an
    // earlier transcript, which the Codex importer already records this way.
    expect(trace.metadata.compacted).toBe(true);
  });

  it('keeps the compaction summary as the prompt when the session is only a continuation', () => {
    // The fallback every other envelope uses: a continuation with no later
    // question of its own still imports with something rather than nothing.
    const summary = 'This session is being continued from a previous conversation that ran out of context.';
    const path = fixture([
      { type: 'user', sessionId: 'cmp2', isCompactSummary: true, message: { content: summary } },
      { type: 'assistant', sessionId: 'cmp2', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.input).toEqual({ prompt: summary });
    expect(trace.metadata.compacted).toBe(true);
  });

  // A session that was never compacted says nothing about it.
  it('does not mark an ordinary session as compacted', () => {
    const path = fixture([
      { type: 'user', sessionId: 'plain', message: { content: 'hello' } },
      { type: 'assistant', sessionId: 'plain', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.metadata.compacted).toBeUndefined();
  });

  // An envelope prompt beats no prompt at all: a session that is ALL envelope
  // must still import with its first turn, as it did before.
  it('falls back to the first turn when every turn is an envelope', () => {
    const path = fixture([
      { type: 'user', sessionId: 'env2', message: { content: '<command-name>/x</command-name>' } },
      { type: 'assistant', sessionId: 'env2', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const trace = getTrace(db, importClaudeTranscript(db, path).trace!.id)!;
    expect(trace.input).toEqual({ prompt: '<command-name>/x</command-name>' });
    expect(trace.metadata.follow_up_prompts).toBeUndefined();
  });

  // Narrow by design: a question that merely MENTIONS a wrapper word is a
  // question. Missing an envelope costs a slightly worse prompt; misreading a
  // real question as one loses it from the field every reader treats as the ask.
  it('does not mistake an ordinary question for an envelope', () => {
    // The test is the SHAPE — does the turn open with a wrapper — so a question
    // that merely mentions one mid-sentence is still a question.
    const path = fixture([
      { type: 'user', sessionId: 'env3', message: { content: 'what does <command-name> mean in the transcript format?' } },
      { type: 'assistant', sessionId: 'env3', message: { content: [{ type: 'text', text: 'it is...' }] } },
    ]);
    expect(getTrace(db, importClaudeTranscript(db, path).trace!.id)!.input)
      .toEqual({ prompt: 'what does <command-name> mean in the transcript format?' });
  });
});

describe('importing the same session twice', () => {
  // Nothing checked, so a re-run after a crash — or a scheduled loop over a
  // session directory — silently doubled every store-wide number and left
  // indistinguishable rows in `list` with no way to tell the copies apart.
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'ar-import-dupe-'));
  });

  afterEach(() => {
    resetConnection();
    rmSync(storeDir, { recursive: true, force: true });
  });

  /** Run the command quietly and return what it wrote to stderr. */
  function importQuietly(path: string, opts: { replace?: boolean } = {}): string {
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
    try {
      runImport(path, { dir: storeDir, ...opts });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    return err.join('\n');
  }

  function traces(): Array<{ id: string }> {
    const sdb = ensureDatabase(resolve(storeDir, 'traces.db'));
    return sdb.prepare('SELECT id FROM agent_traces ORDER BY started_at ASC').all() as Array<{ id: string }>;
  }

  function transcript(): string {
    return fixture([
      { type: 'user', sessionId: 'dupe-1', message: { content: 'go' } },
      { type: 'assistant', sessionId: 'dupe-1', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
  }

  it('leaves the store with one trace and names the one already there', () => {
    const path = transcript();
    expect(importQuietly(path)).toBe('');
    const [first] = traces();
    expect(first).toBeDefined();

    const err = importQuietly(path);
    expect(err).toMatch(/already imported/);
    expect(err).toMatch(/--replace/);
    // The trace kept is the ORIGINAL — the copy just made is dropped, so an id
    // anything already refers to stays valid.
    expect(traces().map((t) => t.id)).toEqual([first.id]);
    // Not an error: a scheduled loop re-running is the normal case.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--replace swaps the old trace for a fresh import', () => {
    const path = transcript();
    importQuietly(path);
    const [first] = traces();

    importQuietly(path, { replace: true });
    const after = traces();
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(first.id);
  });

  it('refuses --replace rather than taking a fork down with its parent', () => {
    // A fork inherits its parent's session_id AND its source_format /
    // source_file metadata, so it matched the priors key and was deleted
    // alongside the parent. `--replace` is the documented way to refresh a
    // transcript that has grown, so the routine refresh destroyed the user's
    // what-if sandboxes.
    //
    // Excluding forks from the query is not enough on its own: `parent_trace_id`
    // is ON DELETE SET NULL, so a surviving fork would be silently PROMOTED to
    // a real run — and `parent_trace_id IS NULL` is the only thing marking a
    // fork as never-executed, which golden export, `check`, `stats` and `watch`
    // all rely on.
    const path = transcript();
    importQuietly(path);
    const [parent] = traces();

    const sdb = ensureDatabase(resolve(storeDir, 'traces.db'));
    forkTrace(sdb, parent.id, 1);
    expect(traces()).toHaveLength(2);

    const err = importQuietly(path, { replace: true });
    expect(err).toMatch(/Refusing to replace/);
    expect(err).toMatch(/fork/i);
    // Both survive, and the fork is still a fork.
    expect(traces()).toHaveLength(2);
    const rows = sdb
      .prepare('SELECT id, parent_trace_id FROM agent_traces')
      .all() as Array<{ id: string; parent_trace_id: string | null }>;
    expect(rows.find((r) => r.id === parent.id)).toBeDefined();
    expect(rows.some((r) => r.parent_trace_id === parent.id)).toBe(true);
  });

  // A different session in the same format is a different trace, and the same
  // session id under a different source format is a different session.
  it('does not confuse two different sessions', () => {
    importQuietly(transcript());
    importQuietly(fixture([
      { type: 'user', sessionId: 'dupe-2', message: { content: 'other' } },
      { type: 'assistant', sessionId: 'dupe-2', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]));
    expect(traces()).toHaveLength(2);
  });
});

describe('a subagent sidecar is not the same import as its parent session', () => {
  // Claude Code writes subagent transcripts to `<session>/subagents/agent-*.jsonl`
  // carrying the SAME sessionId as the parent. Keying the import identity on the
  // session id alone therefore collapsed two different files: importing a
  // sidecar reported "already imported" and dropped it, and `--replace` DELETED
  // the parent session's trace — steps, evals and all — in favour of the much
  // smaller sidecar. Verified on a real 180-step session before the fix.
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'ar-import-sub-'));
  });
  afterEach(() => {
    resetConnection();
    rmSync(storeDir, { recursive: true, force: true });
  });

  function importQuietly(path: string, opts: { replace?: boolean } = {}): void {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runImport(path, { dir: storeDir, ...opts });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('keeps both, and --replace does not delete the parent', () => {
    const parent = fixture([
      { type: 'user', sessionId: 'shared-sess', message: { content: 'parent question' } },
      { type: 'assistant', sessionId: 'shared-sess', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', sessionId: 'shared-sess', message: { content: [{ type: 'text', text: 'b' }] } },
    ]);
    // A separate file, same session id — what a sidecar looks like to the importer.
    const sidecar = join(dir, 'agent-a1.jsonl');
    writeFileSync(
      sidecar,
      [
        { type: 'user', sessionId: 'shared-sess', message: { content: 'subagent task' } },
        { type: 'assistant', sessionId: 'shared-sess', message: { content: [{ type: 'text', text: 'sub' }] } },
      ].map((l) => JSON.stringify(l)).join('\n'),
    );

    importQuietly(parent);
    importQuietly(sidecar, { replace: true });

    const sdb = ensureDatabase(resolve(storeDir, 'traces.db'));
    const rows = sdb.prepare('SELECT id FROM agent_traces').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(2);

    // The parent's steps are intact — the regression this guards is its deletion.
    const counts = rows
      .map((r) => (sdb.prepare('SELECT COUNT(*) as c FROM agent_trace_steps WHERE trace_id = ?').get(r.id) as { c: number }).c)
      .sort((a, b) => a - b);
    expect(counts).toEqual([1, 2]);
  });

  // The same file is still deduplicated — the point of the identity key.
  it('still refuses a second import of the same file', () => {
    const path = fixture([
      { type: 'user', sessionId: 'same-file', message: { content: 'go' } },
      { type: 'assistant', sessionId: 'same-file', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    importQuietly(path);
    importQuietly(path);
    const sdb = ensureDatabase(resolve(storeDir, 'traces.db'));
    expect((sdb.prepare('SELECT COUNT(*) as c FROM agent_traces').get() as { c: number }).c).toBe(1);
  });
});

describe('import points at the format that would have read the file', () => {
  // `--format` defaults to `claude-transcript`, so pointing `import` at a Codex
  // rollout without the flag runs the Claude parser over it: every record is
  // skipped and the reader is told nothing is importable about a file that
  // imports thousands of steps with the right flag. Reproduced against a real
  // ~/.codex rollout — 12,604 records skipped, then 2,452 steps with
  // `--format codex-rollout`. The record shapes below are taken from real files
  // of each format, not invented.
  let dir: string;
  let storeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-sniff-'));
    storeDir = join(dir, 'store');
    mkdirSync(storeDir, { recursive: true });
    ensureDatabase(resolve(storeDir, 'traces.db'));
  });
  afterEach(() => {
    resetConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, records: unknown[]): string => {
    const p = join(dir, name);
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
  };

  const run = (path: string, opts: { format?: string } = {}): string => {
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
    const prevExit = process.exitCode;
    try {
      runImport(path, { dir: storeDir, ...opts });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = prevExit;
    }
    return err.join('\n');
  };

  const codexRecords = [
    { type: 'session_meta', timestamp: '2026-08-24T10:52:24Z', payload: { id: 's1', cwd: '/x' } },
    { type: 'turn_context', timestamp: '2026-08-24T10:52:25Z', payload: { model: 'gpt-5-codex' } },
    { type: 'response_item', timestamp: '2026-08-24T10:52:26Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
  ];

  it('names codex-rollout when the default format read nothing', () => {
    const out = run(write('rollout.jsonl', codexRecords));
    expect(out).toContain('Nothing importable found');
    expect(out).toContain('--format codex-rollout');
  });

  it('names claude-transcript in the other direction', () => {
    const path = write('transcript.jsonl', [
      { type: 'user', sessionId: 's9', message: { content: 'go' } },
      { type: 'assistant', sessionId: 's9', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const out = run(path, { format: 'codex-rollout' });
    expect(out).toContain('--format claude-transcript');
  });

  it('says nothing when the records belong to neither', () => {
    // A wrong suggestion sends the reader to a second format that also imports
    // nothing, which is worse than none — the rule `record`'s suggester states.
    const out = run(write('junk.jsonl', [{ a: 1 }, { b: 2 }]));
    expect(out).toContain('Nothing importable found');
    expect(out).not.toContain('--format');
  });

  it('says nothing when the import worked', () => {
    const out = run(write('good.jsonl', [
      { type: 'user', sessionId: 's8', message: { content: 'go' } },
      { type: 'assistant', sessionId: 's8', message: { content: [{ type: 'text', text: 'done' }] } },
    ]));
    expect(out).not.toContain('look like');
  });

  it('does not suggest the format already being used', () => {
    // The suggester is silent when the winner IS the current format: the file
    // is the right kind and empty or unreadable for some other reason.
    const out = run(write('rollout2.jsonl', codexRecords), { format: 'codex-rollout' });
    expect(out).not.toContain('look like');
  });
});

describe('import refuses input it cannot use', () => {
  // Both guards sit in the command layer and had no test. The `--format` check
  // runs BEFORE the store is opened, which is the rule the rest of the CLI
  // follows (`check --fields` was moved ahead of the store for the same
  // reason): a typo must not create a store on its way to being rejected.
  let dir: string;
  let storeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-import-refuse-'));
    storeDir = join(dir, 'store');
  });
  afterEach(() => {
    resetConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (path: string, opts: { format?: string } = {}): { err: string; exit: unknown } => {
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
    const prevExit = process.exitCode;
    process.exitCode = 0;
    let exit: unknown;
    try {
      runImport(path, { dir: storeDir, ...opts });
      exit = process.exitCode;
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = prevExit;
    }
    return { err: err.join('\n'), exit };
  };

  it('names the supported formats for an unknown --format, and creates no store', () => {
    const path = join(dir, 'anything.jsonl');
    writeFileSync(path, '{}\n');
    const { err, exit } = run(path, { format: 'claude-code' });
    expect(exit).toBe(2);
    expect(err).toContain('claude-transcript');
    expect(err).toContain('codex-rollout');
    expect(existsSync(join(storeDir, 'traces.db'))).toBe(false);
  });

  it('reports a file it cannot read as a failed import, naming the reason', () => {
    // A directory passed where a file was meant is the ordinary way here: the
    // path completes to one, and the read throws EISDIR.
    mkdirSync(join(dir, 'a-directory'), { recursive: true });
    const { err, exit } = run(join(dir, 'a-directory'));
    expect(exit).toBe(1);
    expect(err).toMatch(/Import failed/);
    expect(err).toMatch(/EISDIR|directory/i);
  });

  it('reports a missing file the same way', () => {
    const { err, exit } = run(join(dir, 'not-here.jsonl'));
    expect(exit).toBe(1);
    expect(err).toMatch(/ENOENT|no such file/i);
  });
});

describe('import --replace says what goes with the trace it replaces', () => {
  // The fork branch REFUSES rather than take a fork down with its parent.
  // Evaluations are the other thing that hangs off a trace and cascades with
  // it, and `--replace` is the documented way to refresh a transcript that has
  // grown — so the routine refresh silently discarded every stored verdict,
  // including paid AI ones. A note, not a refusal: an evaluation can be re-run,
  // and carrying an old verdict onto changed steps would score a run it never
  // measured.
  let dir: string;
  let storeDir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-replace-evals-'));
    storeDir = join(dir, 'store');
    mkdirSync(storeDir, { recursive: true });
    ensureDatabase(resolve(storeDir, 'traces.db'));
    file = join(dir, 'session.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: 's-ev', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', sessionId: 's-ev', message: { content: [{ type: 'text', text: 'done' }] } }),
    ].join('\n') + '\n');
  });
  afterEach(() => {
    resetConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (opts: Record<string, unknown> = {}): string => {
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
    try {
      runImport(file, { dir: storeDir, ...opts });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    return err.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
  };

  it('names how many evaluations the replace destroyed', () => {
    run();
    const db = ensureDatabase(resolve(storeDir, 'traces.db'));
    const id = (db.prepare('SELECT id FROM agent_traces').get() as { id: string }).id;
    createEval(db, id, { evaluator_type: 'rubric', evaluator_name: 'a', score: 1, passed: true, details: {} });
    createEval(db, id, { evaluator_type: 'rubric', evaluator_name: 'b', score: 1, passed: true, details: {} });

    const out = run({ replace: true });
    expect(out).toMatch(/2 stored evaluation result\(s\)/);
    // ...and points at the trace to evaluate now, not the one that is gone.
    const fresh = (ensureDatabase(resolve(storeDir, 'traces.db'))
      .prepare('SELECT id FROM agent_traces').get() as { id: string }).id;
    expect(out).toContain(fresh);
    expect(out).not.toContain(id);
  });

  it('says nothing when the replaced trace had none', () => {
    // The note must not fire on the ordinary refresh, or it is noise on every
    // re-import.
    run();
    const out = run({ replace: true });
    expect(out).not.toMatch(/stored evaluation result/);
  });
});
