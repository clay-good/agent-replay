import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end tests that spawn the built CLI, covering the command-layer wiring
 * (option parsing, exit codes, output) that the service-level tests can't reach.
 * Runs against dist/, which `npm run verify` builds before the test step.
 */

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let dir: string;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(args: string[], input?: string): RunResult {
  // Insert --dir before any `--` separator so it applies to agent-replay, not
  // the wrapped child command (for `run -- <cmd>`).
  const dashIdx = args.indexOf('--');
  const withDir = dashIdx === -1
    ? [...args, '--dir', dir]
    : [...args.slice(0, dashIdx), '--dir', dir, ...args.slice(dashIdx)];
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...withDir], {
      encoding: 'utf8',
      input: input ?? '',
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

function firstTraceId(): string {
  const out = run(['list', '--json']).stdout;
  return JSON.parse(out).items[0].id;
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`built CLI not found at ${CLI}; run "npm run build" first`);
});

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'ar-cli-')), '.agent-replay');
  run(['init']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI integration', () => {
  it('ingests a trace and lists it', () => {
    const file = join(dir, '..', 't.jsonl');
    writeFileSync(file, JSON.stringify({ agent_name: 'cli-bot', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'done' }] }));
    expect(run(['ingest', file]).code).toBe(0);
    const list = run(['list', '--json']);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).total).toBe(1);
    expect(run(['list']).stdout).toContain('cli-bot');
  });

  it('records a decision trace and explains it via decisions/why', () => {
    const stream = [
      '{"v":1,"type":"trace_start","trace_id":"tcli","agent_name":"b","session_id":"scli"}',
      '{"v":1,"type":"step","trace_id":"tcli","step_number":1,"step_type":"decision","name":"pick","decision":{"chosen":"A","rationale":"best","decided_by":"agent"}}',
      '{"v":1,"type":"step","trace_id":"tcli","step_number":2,"step_type":"tool_call","name":"act","caused_by_step":1}',
      '{"v":1,"type":"trace_end","trace_id":"tcli","status":"completed"}',
    ].join('\n');
    expect(run(['record'], stream).code).toBe(0);

    const decisions = run(['decisions', 'tcli', '--json']);
    expect(JSON.parse(decisions.stdout).decisions[0].chosen).toBe('A');

    const why = run(['why', 'tcli', '--step', '2', '--json']);
    expect(JSON.parse(why.stdout).chain.map((h: { step_number: number }) => h.step_number)).toEqual([2, 1]);

    // Default show surfaces session + decision.
    expect(run(['show', 'tcli']).stdout).toMatch(/scli|Chose/);
  });

  it('enforces guard check exit codes', () => {
    run(['guard', 'add', '--name', 'blk', '--action', 'deny', '--pattern', '{"name_contains":"delete"}']);
    expect(run(['guard', 'check'], '{"step_type":"tool_call","name":"delete_x"}').code).toBe(2);
    expect(run(['guard', 'check'], '{"step_type":"tool_call","name":"safe"}').code).toBe(0);
  });

  it('runs a golden regression check with correct exit codes', () => {
    const good = join(dir, '..', 'good.jsonl');
    writeFileSync(good, JSON.stringify({ agent_name: 'g', status: 'completed', input: { t: 'x' }, steps: [{ step_number: 1, step_type: 'tool_call', name: 's', input: { q: 'a' } }] }));
    run(['ingest', good]);
    const golden = join(dir, '..', 'golden.json');
    run(['export', '--format', 'golden', '--agent', 'g', '--output', golden]);

    // Clean run passes.
    expect(run(['check', '--golden', golden, '--agent', 'g']).code).toBe(0);
    // Unknown --fields is rejected, not a false pass.
    expect(run(['check', '--golden', golden, '--fields', 'bogus']).code).toBe(2);
  });

  it('propagates the wrapped child exit status via run', () => {
    expect(run(['run', '--', process.execPath, '-e', 'process.exit(0)']).code).toBe(0);
    expect(run(['run', '--', process.execPath, '-e', 'process.exit(5)']).code).toBe(5);
  });

  it('hook capture ALWAYS exits 0 with empty stdout (never interferes with the agent)', () => {
    // Safety contract: a non-zero exit or stdout JSON would block/mislead the
    // host agent, so capture mode must emit neither — even on odd input.
    const payloads = [
      '{"hook_event_name":"PreToolUse","session_id":"h","tool_name":"Bash","tool_input":{}}',
      '{"hook_event_name":"Stop","session_id":"h"}',
      '{"hook_event_name":"UnknownEvent","session_id":"h"}',
      'not even json',
      '',
    ];
    for (const p of payloads) {
      const r = run(['hook'], p);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('hook --enforce returns a structured deny decision and still exits 0', () => {
    run(['guard', 'add', '--name', 'blk', '--action', 'deny', '--pattern', '{"name_contains":"delete"}']);
    const r = run(['hook', '--enforce'], '{"hook_event_name":"PreToolUse","session_id":"e","tool_name":"delete_all","tool_input":{}}');
    expect(r.code).toBe(0); // blocking happens via the JSON, not the exit code (Claude Code dialect)
    const decision = JSON.parse(r.stdout.trim());
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('imports a Claude Code transcript', () => {
    const t = join(dir, '..', 'transcript.jsonl');
    writeFileSync(t, [
      { type: 'user', sessionId: 'imp1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', sessionId: 'imp1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    expect(run(['import', t, '--format', 'claude-transcript']).code).toBe(0);
    expect(JSON.parse(run(['list', '--session', 'imp1', '--json']).stdout).total).toBe(1);
  });

  it('exits non-zero and reports on an unknown command', () => {
    const r = run(['definitely-not-a-command']);
    expect(r.code).not.toBe(0);
  });
});
