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
      timeout: 20000, // a hung command (e.g. a watch that never exits) fails, not blocks
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

  it('ingests a pretty-printed single JSON object (not misdetected as JSONL)', () => {
    // A multi-line object is one JSON value; the old detector saw it didn't
    // start with "[" and parsed it line-by-line, failing on "line 1".
    const file = join(dir, '..', 'pretty.json');
    writeFileSync(file, JSON.stringify(
      { agent_name: 'pretty-bot', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'done' }] },
      null, 2,
    ));
    expect(run(['ingest', file]).code).toBe(0);
    expect(JSON.parse(run(['list', '--json']).stdout).total).toBe(1);
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

    // A non-existent step is a failure, not a silent success: exit 1, message
    // on stderr, nothing on stdout — even in --json mode.
    const missingStep = run(['why', 'tcli', '--step', '999']);
    expect(missingStep.code).toBe(1);
    expect(missingStep.stdout.trim()).toBe('');
    expect(missingStep.stderr).toMatch(/not found/i);
    expect(run(['why', 'tcli', '--step', '999', '--json']).code).toBe(1);

    // Default show surfaces session + decision.
    expect(run(['show', 'tcli']).stdout).toMatch(/scli|Chose/);
  });

  it('finalizes a still-running trace as timeout on EOF, unless --leave-open', () => {
    const noEnd = (id: string) => [
      `{"v":1,"type":"trace_start","trace_id":"${id}","agent_name":"b"}`,
      `{"v":1,"type":"step","trace_id":"${id}","step_number":1,"step_type":"thought","name":"x"}`,
    ].join('\n');
    // A stream that never emits trace_end leaves the trace running; on EOF the
    // recorder finalizes it as timeout so it doesn't linger forever...
    run(['record'], noEnd('eof1'));
    expect(JSON.parse(run(['show', 'eof1', '--json']).stdout).status).toBe('timeout');
    // ...but --leave-open preserves the running state (e.g. a trace continued by
    // a later process).
    run(['record', '--leave-open'], noEnd('eof2'));
    expect(JSON.parse(run(['show', 'eof2', '--json']).stdout).status).toBe('running');
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

    // A file with nothing importable produces no trace, which is a failure, not
    // a no-op success — otherwise `import X && use-trace` would proceed on empty.
    const junk = join(dir, '..', 'junk.jsonl');
    writeFileSync(junk, 'this is not a transcript\n{ broken');
    const res = run(['import', junk, '--format', 'claude-transcript']);
    expect(res.code).toBe(1);
    expect(res.stdout.trim()).toBe('');
  });

  it('watch on a completed trace renders it and exits (no hang)', () => {
    // A regression that hangs (never detecting completion) or exits before
    // polling would break live-tailing; this locks the exit-on-completion path.
    const stream = [
      '{"v":1,"type":"trace_start","trace_id":"tw","agent_name":"w"}',
      '{"v":1,"type":"step","trace_id":"tw","step_number":1,"step_type":"tool_call","name":"go"}',
      '{"v":1,"type":"trace_end","trace_id":"tw","status":"completed"}',
    ].join('\n');
    run(['record'], stream);
    // Short poll so the first tick detects completion quickly; execFileSync would
    // throw ETIMEDOUT (not exit 0) if watch hung.
    const r = run(['watch', 'tw', '--interval', '50']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/go|completed/i);
  });

  it('diffs two traces and reports the model divergence', () => {
    const a = join(dir, '..', 'a.jsonl');
    const b = join(dir, '..', 'b.jsonl');
    writeFileSync(a, JSON.stringify({ agent_name: 'd', status: 'completed', steps: [{ step_number: 1, step_type: 'llm_call', name: 'g', model: 'gpt-4' }] }));
    writeFileSync(b, JSON.stringify({ agent_name: 'd', status: 'completed', steps: [{ step_number: 1, step_type: 'llm_call', name: 'g', model: 'gpt-5.4-nano' }] }));
    run(['ingest', a]);
    run(['ingest', b]);
    const items = JSON.parse(run(['list', '--json']).stdout).items;
    const res = run(['diff', items[0].id, items[1].id, '--json']);
    expect(res.code).toBe(0);
    const diff = JSON.parse(res.stdout);
    expect(diff.diffs.some((x: { field: string }) => x.field === 'model')).toBe(true);
  });

  it('forks a trace, copying steps up to the fork point', () => {
    const stream = [
      '{"v":1,"type":"trace_start","trace_id":"tfk","agent_name":"f"}',
      '{"v":1,"type":"step","trace_id":"tfk","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"step","trace_id":"tfk","step_number":2,"step_type":"tool_call","name":"b"}',
      '{"v":1,"type":"step","trace_id":"tfk","step_number":3,"step_type":"output","name":"c"}',
      '{"v":1,"type":"trace_end","trace_id":"tfk","status":"completed"}',
    ].join('\n');
    run(['record'], stream);
    expect(run(['fork', 'tfk', '--from-step', '2']).code).toBe(0);
    // A new trace exists whose lineage points at the original.
    const forked = JSON.parse(run(['list', '--json']).stdout).items.find((t: { parent_trace_id: string | null }) => t.parent_trace_id);
    expect(forked).toBeTruthy();
    const full = JSON.parse(run(['show', forked.id, '--json']).stdout);
    expect(full.steps).toHaveLength(2); // steps 1..2 copied
    expect(full.forked_from_step).toBe(2);

    // Malformed --modify-context/--modify-input is a usage error, not a crash.
    expect(run(['fork', 'tfk', '--from-step', '2', '--modify-context', 'not json{']).code).toBe(2);
    expect(run(['fork', 'tfk', '--from-step', '2', '--modify-input', '[oops']).code).toBe(2);
  });

  it('runs deterministic evaluations offline via eval --all', () => {
    const f = join(dir, '..', 'e.jsonl');
    writeFileSync(f, JSON.stringify({
      agent_name: 'ev', status: 'completed',
      output: { text: 'Here is the answer.' },
      steps: [{ step_number: 1, step_type: 'output', name: 'respond', output: { text: 'Here is the answer.' } }],
    }));
    run(['ingest', f]);
    const id = firstTraceId();
    const res = run(['eval', id, '--all', '--json']);
    expect(res.code).toBe(0);
    // Deterministic presets produce scored results without any API key.
    const parsed = JSON.parse(res.stdout);
    const results = Array.isArray(parsed) ? parsed : parsed.results ?? parsed.evals ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].score).toBe('number');

    // A malformed --max-cost must fail loudly (exit 2) rather than silently
    // fall back to an unlimited AI budget. Validated before any provider lookup,
    // so no API key is needed; "0.O5" has a letter O, a realistic typo.
    expect(run(['eval', id, '--ai', '--max-cost', '0.O5']).code).toBe(2);
    expect(run(['eval', id, '--ai', '--max-cost', '-1']).code).toBe(2);
  });

  it('translates a codex exec --json stream via record --format codex-exec', () => {
    const stream = [
      '{"type":"thread.started","thread_id":"th_ci"}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"ls"}}',
      '{"type":"turn.completed","usage":{"input_tokens":40,"output_tokens":8}}',
    ].join('\n');
    expect(run(['record', '--format', 'codex-exec'], stream).code).toBe(0);
    const t = JSON.parse(run(['list', '--session', 'th_ci', '--json']).stdout);
    expect(t.total).toBe(1);
    expect(t.items[0].agent_name).toBe('codex');
  });

  it('translates a gemini stream-json stream via record --format gemini-stream', () => {
    const stream = [
      '{"type":"init","session_id":"g_ci"}',
      '{"type":"tool_use","id":"t1","name":"read_file","input":{"path":"a"}}',
      '{"type":"tool_result","id":"t1","output":{"content":"hi"}}',
      '{"type":"result","exit_code":0}',
    ].join('\n');
    expect(run(['record', '--format', 'gemini-stream'], stream).code).toBe(0);
    const id = JSON.parse(run(['list', '--session', 'g_ci', '--json']).stdout).items[0].id;
    const full = JSON.parse(run(['show', id, '--json']).stdout);
    expect(full.status).toBe('completed');
    expect(full.steps.some((s: { step_type: string }) => s.step_type === 'tool_call')).toBe(true);
  });

  it('rejects an unsupported record --format', () => {
    expect(run(['record', '--format', 'nonsense'], '{}').code).toBe(2);
  });

  it('rejects bad filter/format input instead of silently misbehaving', () => {
    const f = join(dir, '..', 't.json');
    writeFileSync(f, JSON.stringify([{ agent_name: 'x', status: 'completed' }]));
    // These once silently returned nothing / mis-parsed; now they error (exit 2).
    expect(run(['ingest', f, '--format', 'xml']).code).toBe(2);
    expect(run(['list', '--status', 'faield']).code).toBe(2);
    expect(run(['list', '--since', 'notaduration']).code).toBe(2);
    expect(run(['list', '--sort', 'nope']).code).toBe(2);
  });

  it('survives an adversarial event stream and still records the valid events', () => {
    // Malformed/hostile lines mixed with valid ones: the recorder must skip the
    // junk (warn), never crash, and still apply the good events.
    const stream = [
      'null',                                                                       // non-object JSON
      '[1,2,3]',                                                                    // array, not an event
      '{ truncated',                                                               // invalid JSON
      '{"v":999,"type":"trace_start","agent_name":"x"}',                            // unsupported version
      '{"v":1,"type":"trace_start","trace_id":"tadv","agent_name":"survivor"}',     // valid
      '{"v":1,"type":"step_end","trace_id":"tadv","step_number":42}',               // step_end for a missing step
      '{"v":1,"type":"step","trace_id":"tadv","step_number":1,"step_type":"bogus","name":"n"}', // invalid step_type
      '{"v":1,"type":"step","trace_id":"tadv","step_number":1,"step_type":"output","name":"ok"}', // valid
      '{"v":1,"type":"trace_end","trace_id":"tadv","status":"completed"}',          // valid
    ].join('\n');
    const r = run(['record'], stream);
    expect(r.code).toBe(0); // never crashes on hostile input
    const t = JSON.parse(run(['list', '--json']).stdout).items.find((x: { agent_name: string }) => x.agent_name === 'survivor');
    expect(t).toBeTruthy();
    const full = JSON.parse(run(['show', t.id, '--json']).stdout);
    expect(full.status).toBe('completed');
    expect(full.steps).toHaveLength(1); // only the one valid step
    expect(full.steps[0].name).toBe('ok');
  });

  it('windows a large trace with show --from-step/--to-step', () => {
    const lines = ['{"v":1,"type":"trace_start","trace_id":"tbig","agent_name":"big"}'];
    for (let i = 1; i <= 8; i++) lines.push(`{"v":1,"type":"step","trace_id":"tbig","step_number":${i},"step_type":"thought","name":"s${i}"}`);
    lines.push('{"v":1,"type":"trace_end","trace_id":"tbig","status":"completed"}');
    run(['record'], lines.join('\n'));

    // JSON output respects the window.
    const windowed = JSON.parse(run(['show', 'tbig', '--from-step', '3', '--to-step', '5', '--json']).stdout);
    expect(windowed.steps.map((s: { step_number: number }) => s.step_number)).toEqual([3, 4, 5]);

    // The human view notes how many steps were omitted.
    const view = run(['show', 'tbig', '--from-step', '3', '--to-step', '5', '--steps-only']).stdout;
    expect(view).toMatch(/Showing 3 of 8 steps/);

    // Invalid window bounds are a usage error (exit 2), not a silent empty view.
    expect(run(['show', 'tbig', '--from-step', 'abc']).code).toBe(2);
    expect(run(['show', 'tbig', '--from-step', '0']).code).toBe(2);
    expect(run(['show', 'tbig', '--from-step', '5', '--to-step', '2']).code).toBe(2);
    // An in-range-but-empty window (valid numbers past the end) is still a success.
    expect(run(['show', 'tbig', '--from-step', '999']).code).toBe(0);

    // replay shares the window flags and adds --speed; same validation applies
    // (--speed 0 keeps the run instant).
    expect(run(['replay', 'tbig', '--speed', '0', '--from-step', 'abc']).code).toBe(2);
    expect(run(['replay', 'tbig', '--speed', '0', '--from-step', '5', '--to-step', '2']).code).toBe(2);
    expect(run(['replay', 'tbig', '--speed', 'abc']).code).toBe(2);
    expect(run(['replay', 'tbig', '--speed', '-5']).code).toBe(2);
    expect(run(['replay', 'tbig', '--speed', '0', '--from-step', '2', '--to-step', '4']).code).toBe(0);
  });

  it('config errors exit non-zero so scripts can detect them', () => {
    expect(run(['config', 'set', 'ai.provider', 'anthropic']).code).toBe(0); // valid
    expect(run(['config', 'set', 'ai.bogus', 'v']).code).toBe(2);            // unknown key
    expect(run(['config', 'set', 'ai.provider', 'notreal']).code).toBe(2);   // invalid provider
  });

  it('reports failures via exit code, not just a stderr message', () => {
    // Usage errors → 2.
    expect(run(['export', '--format', 'bogus']).code).toBe(2);
    expect(run(['guard', 'add', '--name', 'x', '--pattern', 'not json', '--action', 'deny']).code).toBe(2);
    expect(run(['guard', 'add', '--name', 'x', '--pattern', '{}', '--action', 'bogus']).code).toBe(2);
    // Runtime failure → 1: watching a named trace that doesn't exist. (diff's
    // no-provider exit-1 path is env-dependent — a machine with an API key would
    // resolve one — so it's verified manually rather than in this hermetic test.)
    expect(run(['watch', 'no-such-trace']).code).toBe(1);
  });

  it('every command exits non-zero when the trace is missing (scriptability)', () => {
    // `agent-replay <cmd> <id> && next` must not proceed when <id> is absent.
    for (const args of [
      ['show', 'missing'],
      ['replay', 'missing', '--speed', '0'],
      ['why', 'missing', '--step', '1'],
      ['decisions', 'missing'],
      ['fork', 'missing', '--from-step', '1'],
      ['eval', 'missing', '--preset', 'safety-check'],
      ['diff', 'missingA', 'missingB'],
      ['guard', 'test', 'missing'],
      ['guard', 'remove', 'missing'],
    ]) {
      expect(run(args).code, args.join(' ')).not.toBe(0);
    }
  });

  it('ingest exits non-zero on unreadable or all-invalid input', () => {
    expect(run(['ingest', '/no/such/file.json']).code).not.toBe(0);
    const bad = join(dir, '..', 'bad.jsonl');
    writeFileSync(bad, '{"no_agent_name":true}');
    expect(run(['ingest', bad]).code).not.toBe(0);
    // A valid file still exits 0.
    const ok = join(dir, '..', 'ok.jsonl');
    writeFileSync(ok, '{"agent_name":"ok","status":"completed"}');
    expect(run(['ingest', ok]).code).toBe(0);
  });

  it('exits non-zero and reports on an unknown command', () => {
    const r = run(['definitely-not-a-command']);
    expect(r.code).not.toBe(0);
  });

  it('demo --reset refuses to delete a directory that is not an agent-replay store', () => {
    // Safety guard: --reset must never rm a directory whose name isn't an
    // agent-replay data dir. Spawned directly since it needs a custom --dir that
    // the run() helper would override.
    const stranger = mkdtempSync(join(tmpdir(), 'not-agent-data-'));
    const keep = join(stranger, 'important.txt');
    writeFileSync(keep, 'do not delete me');
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, 'demo', '--reset', '--no-interactive', '--dir', stranger], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(1); // refused
    expect(existsSync(keep)).toBe(true); // and nothing was deleted
    rmSync(stranger, { recursive: true, force: true });
  });
});
