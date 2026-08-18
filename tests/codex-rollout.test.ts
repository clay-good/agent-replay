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

  it('keeps a follow-up user turn instead of discarding it', () => {
    // A normal multi-turn session. Every user turn after the first used to be
    // retained NOWHERE and counted as skipped — a session's later questions were
    // unrecoverable from the store, while the two other paths that assemble a
    // trace from turns (the batch merge and the OTLP mapper) both keep them in
    // `metadata.follow_up_prompts`. It now follows that convention, so a turn
    // with text counts as imported.
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-mt' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'first question' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'first answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'second question' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'second answer' } },
    ]);
    const report = importCodexRollout(db, path);
    expect(report.imported + report.skipped).toBe(5);
    expect(report.skipped).toBe(0);

    const trace = getTrace(db, report.trace!.id)!;
    expect(trace.input).toEqual({ prompt: 'first question' });
    expect(trace.metadata.follow_up_prompts).toEqual(['second question']);
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

describe('codex-rollout robustness', () => {
  it('keeps the rest of a rollout when one line parses to null', () => {
    // Same defect as the claude importer: `null` was pushed into the record
    // list and dereferenced unguarded, aborting the entire import.
    const dir = mkdtempSync(join(tmpdir(), 'ar-codex-null-'));
    try {
      const file = join(dir, 'rollout.jsonl');
      writeFileSync(file, [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }),
        'null',
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } }),
      ].join('\n') + '\n');

      const db = new Database(':memory:');
      try {
        runMigrations(db);
        const res = importCodexRollout(db, file, {});
        expect(res.skipped).toBeGreaterThanOrEqual(1);
        expect(res.imported + res.skipped).toBe(3);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an empty first prompt never eats the real one (codex-rollout)', () => {
  // The identical construct was fixed in BOTH branches of the claude-transcript
  // importer and left untouched here: `{prompt: ''}` is truthy, so `!input`
  // read an empty first user record as "input captured", the next REAL prompt
  // fell to the follow-up branch and was discarded, and the empty record was
  // counted as imported.
  for (const [label, first] of [
    ['an empty string', ''],
    ['a whitespace-only string', '   \n'],
    ['empty content blocks', []],
  ] as const) {
    it(`keeps the real question when the first message is ${label}`, () => {
      const path = fixture([
        { type: 'session_meta', payload: { id: 'roll-empty', timestamp: '2026-07-02T00:00:00Z' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: first } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'THE REAL QUESTION' } },
      ]);
      const report = importCodexRollout(db, path);
      expect((report.trace?.input as { prompt?: string })?.prompt).toBe('THE REAL QUESTION');
      // And the empty record counts as skipped, keeping imported + skipped = records.
      expect(report.imported + report.skipped).toBe(2);
    });
  }
});

describe('a rollout that captured nothing is a failed import', () => {
  it('refuses a rollout whose only message is an empty prompt', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-none', timestamp: '2026-07-02T00:00:00Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: '' } },
    ]);
    const report = importCodexRollout(db, path);
    expect(report.trace).toBeNull();
    expect(report.steps).toBe(0);
    // The one response_item is accounted for either way (session_meta is a
    // header, not a tallied record), so the invariant still holds.
    expect(report.imported + report.skipped).toBe(1);
  });
});


describe('codex-rollout: the freeform tool family', () => {
  // `custom_tool_call` is how the current Codex CLI emits most tool
  // invocations (the freeform exec / apply-patch tools). Handling only
  // `function_call` routed them to `default: skipped` and stored them nowhere,
  // exit 0, with no signal that most of what the agent did was missing —
  // measured across 40 real rollouts on this machine, 194 custom vs 25
  // function, so roughly nine tenths of tool activity was dropped.
  it('imports a custom_tool_call and pairs it with its output', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-custom' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'list the files' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: '{"cmd":"ls"}', call_id: 'cc1' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'cc1', output: [{ type: 'input_text', text: 'a.txt' }] } },
    ]);
    const report = importCodexRollout(db, path);
    expect(report.skipped).toBe(0);

    const trace = getTrace(db, report.trace!.id)!;
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('exec');
    expect(tool.input).toEqual({ cmd: 'ls' });
    expect(tool.output).toEqual({ output: [{ type: 'input_text', text: 'a.txt' }] });
  });

  it('keeps an unparseable freeform input verbatim rather than losing it', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-freeform' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'go' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"ls"});', call_id: 'cc2' } },
    ]);
    const trace = getTrace(db, importCodexRollout(db, path).trace!.id)!;
    expect(trace.steps.find((s) => s.step_type === 'tool_call')!.input)
      .toEqual({ arguments: 'const r = await tools.exec_command({cmd:"ls"});' });
  });

  // A failed tool stored with no `error` reads as a clean run to
  // hallucination-check's no_error_steps criterion, completeness-check, and
  // `check --golden`'s step_errors baseline — a fail-open on exactly the traces
  // this tool exists to audit. The claude-transcript importer already did this.
  it('records a failed tool call as failed', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-fail' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'build it' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'f1' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'f1', output: { metadata: { exit_code: 2 }, output: 'boom' } } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'f2' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'f2', output: { success: false, output: 'nope' } } },
      { type: 'response_item', payload: { type: 'function_call', name: 'ok', arguments: '{}', call_id: 'f3' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'f3', output: { metadata: { exit_code: 0 }, output: 'fine' } } },
    ]);
    const trace = getTrace(db, importCodexRollout(db, path).trace!.id)!;
    const byName = Object.fromEntries(trace.steps.filter((s) => s.step_type === 'tool_call').map((s) => [s.name, s]));
    expect(byName.exec.error).toMatch(/exited with code 2/);
    expect(byName.shell.error).toBe('nope');
    // Both families run through ONE branch, so the pair is tested together:
    // these two have drifted apart before.
    expect(byName.ok.error).toBeNull();
  });

  // An exit code that does not parse must NOT fabricate a failure — the
  // opposite default from the failure flag above, and deliberate: over-reading
  // a flag only makes a real failure more visible, while inventing a failed run
  // from an unreadable field is a wrong answer about what happened.
  it('does not invent a failure from an unparseable exit code', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-nan' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'go' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'n1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'n1', output: { metadata: { exit_code: 'ENOENT' }, output: 'x' } } },
    ]);
    const trace = getTrace(db, importCodexRollout(db, path).trace!.id)!;
    expect(trace.steps.find((s) => s.step_type === 'tool_call')!.error).toBeNull();
  });

  // `info.total_token_usage` is CUMULATIVE for the session, so the last record
  // is the total. Summing them over-counted by 34x on a real 82-record session
  // (214,648,081 against an actual 6,267,854).
  it('takes the session token total from the last token_count, not their sum', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-tokens' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'go' } },
      // The REAL wrapper: rollouts carry token_count inside `event_msg`, not as
      // a top-level type. Testing the tidier shape passed while the importer
      // still skipped every record a real file emits.
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 250 } } } },
    ]);
    const report = importCodexRollout(db, path);
    expect(report.skipped).toBe(0);
    expect(getTrace(db, report.trace!.id)!.total_tokens).toBe(250);
  });

  it('leaves the total unset when a rollout carries no token_count', () => {
    const path = fixture([
      { type: 'session_meta', payload: { id: 'roll-notokens' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'go' } },
    ]);
    expect(getTrace(db, importCodexRollout(db, path).trace!.id)!.total_tokens).toBeNull();
  });
});
