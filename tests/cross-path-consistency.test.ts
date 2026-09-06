import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { applyHookPayload } from '../src/services/hook-adapter.js';
import { importClaudeTranscript } from '../src/services/importers/claude-transcript.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';

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
