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

  it('reports the true file line number for a malformed JSONL line', () => {
    // Regression: the parse-error line number was computed after blank/comment
    // lines were filtered out, so a bad line preceded by blanks was misreported
    // as an earlier line. The good record on file line 3 must ingest, and the
    // broken record on file line 5 must be named "line 5", not "line 2".
    const f = join(dir, '..', 'lineno.jsonl');
    writeFileSync(f, [
      '',                                                                              // line 1 (blank)
      '// a comment',                                                                  // line 2
      JSON.stringify({ agent_name: 'ok', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }), // line 3
      '',                                                                              // line 4 (blank)
      '{ broken json',                                                                 // line 5
    ].join('\n'));
    const res = run(['ingest', f, '--format', 'jsonl']);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain('line 5');
    expect(res.stderr + res.stdout).not.toContain('line 2');
  });

  it('list --limit consumes the validated number, not a divergent second parse', () => {
    // Regression: --limit was validated with Number() but consumed with
    // parseInt(_, 10). "0x20" is Number → 32 (passes) but parseInt → 0, so the
    // query ran LIMIT 0 (zero rows) and printed a false "No traces found";
    // "1e2" is 100 vs 1. Both must now return all three ingested traces.
    const f = join(dir, '..', 'many.jsonl');
    writeFileSync(f, [
      JSON.stringify({ agent_name: 'a', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }),
      JSON.stringify({ agent_name: 'b', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'y' }] }),
      JSON.stringify({ agent_name: 'c', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'z' }] }),
    ].join('\n'));
    run(['ingest', f, '--format', 'jsonl']);

    expect(JSON.parse(run(['list', '--limit', '0x20', '--json']).stdout).items).toHaveLength(3);
    expect(JSON.parse(run(['list', '--limit', '1e2', '--json']).stdout).items).toHaveLength(3);
    // A genuinely malformed value is still a usage error.
    expect(run(['list', '--limit', 'abc']).code).toBe(2);
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

  it('ingests a JSON array written to a .jsonl-named file (extension not trusted over content)', () => {
    // `export --format json` (the default) into a .jsonl-named file writes a JSON
    // array. The old detector short-circuited on the extension, line-split the
    // array, and died with a misleading "Invalid JSON on line 1". Content now
    // decides, so a valid JSON array ingests regardless of the file name.
    const file = join(dir, '..', 'mismatched.jsonl');
    writeFileSync(file, JSON.stringify(
      [
        { agent_name: 'arr-bot', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'a' }] },
        { agent_name: 'arr-bot', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'b' }] },
      ],
      null, 2,
    ));
    expect(run(['ingest', file]).code).toBe(0);
    expect(JSON.parse(run(['list', '--json']).stdout).total).toBe(2);
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

    // --step is parsed with Number, not parseInt (matching show/replay/fork).
    // `2.9`/`2abc` were silently truncated to a valid step 2 and explained the
    // wrong step; they are now usage errors (exit 2).
    expect(run(['why', 'tcli', '--step', '2.9']).code).toBe(2);
    expect(run(['why', 'tcli', '--step', '2abc']).code).toBe(2);
    // `1e2` means 100 (not a parseInt-truncated 1): step 100 doesn't exist here,
    // so it's a not-found (exit 1), not a silent success explaining step 1.
    expect(run(['why', 'tcli', '--step', '1e2']).code).toBe(1);

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

  it('enforce mode fails CLOSED when the store cannot be read', () => {
    // Corrupt the store so opening/reading it throws part-way through the
    // enforcement evaluation (the real-world case is a transient SQLITE_BUSY on
    // a shared machine). A `pre_tool` event that cannot reach a verdict must
    // BLOCK — a deny policy might have applied — not silently exit 0 (allow),
    // which would run a call the policy would have stopped.
    writeFileSync(join(dir, 'traces.db'), 'not a sqlite database at all');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'delete_all', tool_input: { path: '/' },
    });

    // Claude Code signals a block via a stdout permissionDecision:"deny".
    const blocked = run(['hook', 'PreToolUse', '--enforce'], payload);
    expect(blocked.stdout).toMatch(/permissionDecision/);
    expect(blocked.stdout).toMatch(/deny/);

    // Capture mode (no --enforce) must NEVER block the host, even on a broken
    // store — it stays exit 0 with no decision.
    const captured = run(['hook', 'PreToolUse'], payload);
    expect(captured.code).toBe(0);
    expect(captured.stdout).not.toMatch(/permissionDecision|deny/);

    // A non-pre-tool event under --enforce is capture-only, so a store failure
    // there does not block either.
    const post = run(['hook', 'PostToolUse', '--enforce'],
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'delete_all' }));
    expect(post.stdout).not.toMatch(/permissionDecision|deny/);
  });

  it('show/replay validate step windows strictly (Number, not parseInt)', () => {
    const f = join(dir, '..', 'multi.jsonl');
    writeFileSync(f, JSON.stringify({
      agent_name: 'm', status: 'completed',
      steps: Array.from({ length: 5 }, (_, i) => ({ step_number: i + 1, step_type: 'output', name: `s${i + 1}` })),
    }));
    run(['ingest', f]);
    const id = firstTraceId();

    // Trailing-garbage / non-integer is a usage error (exit 2), not a silent
    // parseInt truncation to 3 / 2.
    expect(run(['show', id, '--to-step', '3abc']).code).toBe(2);
    expect(run(['show', id, '--from-step', '2.9']).code).toBe(2);
    expect(run(['replay', id, '--from-step', '2.9']).code).toBe(2);

    // `1e2` is 100 under Number(), not parseInt's 1 — so the window keeps all 5
    // steps instead of silently capping at step 1.
    const shown = JSON.parse(run(['show', id, '--json', '--to-step', '1e2']).stdout);
    expect(shown.steps).toHaveLength(5);
  });

  it('list shows "-" not "NaNd ago" for an unparseable started_at', () => {
    const f = join(dir, '..', 'nostart.jsonl');
    // `??` in the ingest path does not catch an empty string, so started_at is
    // stored verbatim as "" — new Date("").getTime() is NaN.
    writeFileSync(f, JSON.stringify({ agent_name: 'n', status: 'completed', started_at: '', steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }));
    run(['ingest', f]);
    const out = run(['list']).stdout;
    expect(out).toContain('n');
    expect(out).not.toMatch(/NaN/);
  });

  it('config set ai.max_tokens echoes the normalized stored value', () => {
    const out = run(['config', 'set', 'ai.max_tokens', '1e3']).stdout;
    // Stored as 1000; the confirmation must match what config get/list will show,
    // not the raw `1e3` input.
    expect(out).toMatch(/ai\.max_tokens = 1000/);
    expect(out).not.toContain('1e3');
  });

  // Regression: commander maps every usage error to exit 2, but in each
  // supported harness exit 2 BLOCKS the pending tool call. A single typo'd hook
  // line in settings.json therefore blocked every tool call in the session,
  // from a capture-only hook documented never to affect the host agent.
  it('a usage error on a capture-mode hook still exits 0', () => {
    expect(run(['hook', 'PreToolUse', '--no-such-flag'], '{}').code).toBe(0);
    expect(run(['hook', 'PreToolUse', 'extra-arg'], '{}').code).toBe(0);
    // Under --enforce, blocking is the correct fail-closed answer.
    expect(run(['hook', 'PreToolUse', '--no-such-flag', '--enforce'], '{}').code).toBe(2);
    // A non-hook command still reports a usage error normally.
    expect(run(['list', '--no-such-flag']).code).toBe(2);
  });

  it('guard check rejects non-object JSON stdin cleanly (no crash)', () => {
    // `null`/array/primitive are valid JSON but not a step object; they must
    // yield a clean error + exit 1, not a raw TypeError from `null.step_type`.
    for (const body of ['null', '[]', '42']) {
      const r = run(['guard', 'check'], body);
      expect(r.code).toBe(1);
      expect(r.stderr + r.stdout).not.toMatch(/TypeError|Cannot read/i);
    }
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

  it('export [trace-id] scopes to exactly one trace, matching prefixes like the other commands', () => {
    const file = join(dir, '..', 'two.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ agent_name: 'alpha', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'a' }] }),
        JSON.stringify({ agent_name: 'beta', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'b' }] }),
      ].join('\n'),
    );
    run(['ingest', file, '--format', 'jsonl']);
    const id = firstTraceId();

    // No id → both traces.
    expect(JSON.parse(run(['export', '--format', 'json']).stdout).length).toBe(2);

    // Full id → exactly that one.
    const byFull = JSON.parse(run(['export', id, '--format', 'json']).stdout);
    expect(byFull.length).toBe(1);
    expect(byFull[0].id).toBe(id);

    // A prefix resolves to the same single canonical trace.
    const byPrefix = JSON.parse(run(['export', id.slice(0, 10), '--format', 'json']).stdout);
    expect(byPrefix.length).toBe(1);
    expect(byPrefix[0].id).toBe(id);

    // golden format honors the id too.
    const golden = JSON.parse(run(['export', id, '--format', 'golden']).stdout);
    expect(golden.length).toBe(1);
  });

  it('export rejects a trace-id combined with filter flags, and a missing id', () => {
    const file = join(dir, '..', 'one.jsonl');
    writeFileSync(file, JSON.stringify({ agent_name: 'solo', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 's' }] }));
    run(['ingest', file]);
    const real = firstTraceId();

    // id + filter is a usage error (not a silent ignore of the filter).
    expect(run(['export', real, '--status', 'completed']).code).toBe(2);
    expect(run(['export', real, '--agent', 'solo']).code).toBe(2);
    // unknown id → runtime failure.
    expect(run(['export', 'trc_does_not_exist']).code).toBe(1);

    // A bad --status is a usage error, like everywhere else. It used to reach
    // listTraces inside the export block, whose blanket catch reported exit 1 —
    // so a CI script branching on 1 vs 2 read a typo as a runtime failure,
    // while `list` returned 2 for the identical error.
    expect(run(['export', '--status', 'faield']).code).toBe(2);
    expect(run(['list', '--status', 'faield']).code).toBe(2);
    expect(run(['export', '--status', 'completed']).code).toBe(0);
  });

  it('rejects malformed numeric options instead of silently falling back', () => {
    // --limit: a typo used to fall back to the default (hiding the mistake) and
    // a negative slipped through to SQL `LIMIT` (which SQLite reads as no limit).
    expect(run(['list', '--limit', 'abc']).code).toBe(2);
    expect(run(['list', '--limit', '-5']).code).toBe(2);
    expect(run(['list', '--limit', '0']).code).toBe(2);
    expect(run(['list', '--limit', '2.5']).code).toBe(2);
    expect(run(['list', '--limit', '3']).code).toBe(0); // valid

    // --port: a typo used to silently bind the default 4318. These exit before
    // binding, so they don't leave a server running.
    expect(run(['otel', 'serve', '--port', 'abc']).code).toBe(2);
    expect(run(['otel', 'serve', '--port', '99999']).code).toBe(2);

    // --refresh: exits before launching the (headless-unfriendly) TUI.
    expect(run(['dashboard', '--refresh', 'abc']).code).toBe(2);
    expect(run(['dashboard', '--refresh', '-1']).code).toBe(2);
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

  it('watch rejects a malformed --interval as a usage error (even with no trace)', () => {
    // The interval is validated before resolving the trace, so a typo is a
    // usage error (exit 2) regardless of whether anything is running — it does
    // not fall through to the benign "nothing to watch" (exit 0) path.
    expect(run(['watch', '--interval', 'abc']).code).toBe(2);
    expect(run(['watch', '--interval', '-5']).code).toBe(2);
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

    // A literal `null` modify payload is a no-op (the service keeps the
    // original), so the summary must not claim the modification was applied.
    const nullCtx = run(['fork', 'tfk', '--from-step', '2', '--modify-context', 'null']);
    expect(nullCtx.code).toBe(0);
    expect(nullCtx.stdout).not.toMatch(/Modified context/);
    // A real payload is reported as applied.
    expect(run(['fork', 'tfk', '--from-step', '2', '--modify-context', '{"k":1}']).stdout).toMatch(/Modified context/);

    // --from-step is parsed with Number, not parseInt (matching show/replay):
    // `2.9`/`3abc` were silently truncated to a valid step 2/3 and forked at the
    // wrong point; they are now usage errors (exit 2), not a silent exit 0.
    expect(run(['fork', 'tfk', '--from-step', '2.9']).code).toBe(2);
    expect(run(['fork', 'tfk', '--from-step', '3abc']).code).toBe(2);
  });

  it('rejects forking at a non-existent (gapped) step number', () => {
    // step_number can have gaps. Forking at a missing number must fail loudly,
    // not silently copy a prefix and drop --modify-context while the summary
    // still claims "Modified context: Yes".
    const stream = [
      '{"v":1,"type":"trace_start","trace_id":"tgap","agent_name":"g"}',
      '{"v":1,"type":"step","trace_id":"tgap","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"step","trace_id":"tgap","step_number":3,"step_type":"output","name":"c"}',
      '{"v":1,"type":"trace_end","trace_id":"tgap","status":"completed"}',
    ].join('\n');
    run(['record'], stream);
    // No step 2 → runtime error (exit 1), even with --modify-context supplied.
    expect(run(['fork', 'tgap', '--from-step', '2', '--modify-context', '{"region":"eu"}']).code).toBe(1);
    // The real fork points still work.
    expect(run(['fork', 'tgap', '--from-step', '3']).code).toBe(0);
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

  it('eval --max-cost consumes the validated budget, so a $0 cap is honored', () => {
    // Regression: the cap was validated with Number() but consumed with
    // safeParseFloat, which disagree on e.g. "" (Number → 0; parseFloat → NaN →
    // the Infinity fallback). An empty --max-cost validated as $0 yet silently ran
    // with an unlimited budget — the exact footgun the validation exists to stop.
    // A provider must resolve to reach the consumption path, so set one in config;
    // with a $0 cap the estimate ( > $0 ) is rejected before any network call.
    run(['config', 'set', 'ai.provider', 'anthropic']);
    run(['config', 'set', 'ai.api_keys.anthropic', 'sk-test-not-real']);
    const f = join(dir, '..', 'cap.jsonl');
    writeFileSync(f, JSON.stringify({
      agent_name: 'cap', status: 'completed',
      output: { text: 'enough content here to estimate a non-zero token cost' },
      steps: [{ step_number: 1, step_type: 'output', name: 'respond', output: { text: 'a grounded answer' } }],
    }));
    run(['ingest', f]);
    const id = firstTraceId();
    // "0" is the control (Number and parseFloat agree); "" is the regression.
    // Both mean a $0 budget → estimate exceeds it → exit 1, identically.
    expect(run(['eval', id, '--ai', '--max-cost', '0']).code).toBe(1);
    expect(run(['eval', id, '--ai', '--max-cost', '']).code).toBe(1);
  });

  it('replay --speed consumes the validated value (hex parses, not silent instant)', () => {
    // Regression: --speed was validated with Number() ("0x10" → 16) but consumed
    // with safeParseFloat ("0x10" → 0), so a valid hex speed replayed instantly.
    const f = join(dir, '..', 'spd.jsonl');
    writeFileSync(f, JSON.stringify({
      agent_name: 'spd', status: 'completed',
      steps: [{ step_number: 1, step_type: 'output', name: 'respond', output: { t: 'x' }, duration_ms: 10 }],
    }));
    run(['ingest', f]);
    const id = firstTraceId();
    const out = run(['replay', id, '--speed', '0x10']).stdout;
    expect(out).toContain('16x speed');
    expect(out).not.toContain('(instant)');
  });

  it('eval exits non-zero when an evaluation fails, so it gates CI', () => {
    // The "build regression tests" use case and the README exit-code table
    // require a failing eval to exit 1; otherwise it can never fail a CI job.
    const f = join(dir, '..', 'gate.jsonl');
    writeFileSync(f, JSON.stringify({
      agent_name: 'gate', status: 'completed',
      output: { text: 'the answer is 42' },
      steps: [{ step_number: 1, step_type: 'output', name: 'respond', output: { text: 'the answer is 42' } }],
    }));
    run(['ingest', f]);
    const id = firstTraceId();

    // A custom rubric whose criterion is not met scores below threshold → exit 1.
    const failRubric = join(dir, '..', 'fail.yaml');
    writeFileSync(failRubric, 'name: needs-unicorn\nthreshold: 0.8\ncriteria:\n  - name: mentions-unicorn\n    pattern: unicorn\n    expected: true\n');
    expect(run(['eval', id, '--rubric', failRubric]).code).toBe(1);
    expect(run(['eval', id, '--rubric', failRubric, '--json']).code).toBe(1); // --json gates too

    // A rubric that is satisfied passes → exit 0.
    const passRubric = join(dir, '..', 'pass.yaml');
    writeFileSync(passRubric, 'name: has-answer\nthreshold: 0.8\ncriteria:\n  - name: mentions-answer\n    pattern: answer\n    expected: true\n');
    expect(run(['eval', id, '--rubric', passRubric]).code).toBe(0);

    // A YAML author who quotes the weight ("weight: '2'") still gets a correct
    // score: both criteria pass with equal quoted weights → 1.0 ≥ threshold → exit 0.
    // Before the fix the string weight corrupted the aggregate and this exited 1.
    const quotedRubric = join(dir, '..', 'quoted.yaml');
    writeFileSync(quotedRubric, "name: quoted\nthreshold: 0.8\ncriteria:\n  - name: a\n    pattern: answer\n    expected: true\n    weight: '2'\n  - name: b\n    pattern: '42'\n    expected: true\n    weight: '2'\n");
    expect(run(['eval', id, '--rubric', quotedRubric]).code).toBe(0);

    // A malformed weight is a usage error (exit 2), not a silently wrong score.
    const badRubric = join(dir, '..', 'badweight.yaml');
    writeFileSync(badRubric, 'name: bad\ncriteria:\n  - name: a\n    pattern: answer\n    expected: true\n    weight: -1\n');
    expect(run(['eval', id, '--rubric', badRubric]).code).toBe(2);

    // A quoted numeric threshold ("0.8") is coerced, so a satisfied rubric still
    // passes → exit 0 (not a string flowing into `score >= "0.8"`).
    const quotedThresh = join(dir, '..', 'qthresh.yaml');
    writeFileSync(quotedThresh, "name: qt\nthreshold: '0.8'\ncriteria:\n  - name: a\n    pattern: answer\n    expected: true\n");
    expect(run(['eval', id, '--rubric', quotedThresh]).code).toBe(0);

    // A non-numeric / out-of-range threshold is a usage error (exit 2), not a
    // silent `score >= NaN` that fails every otherwise-passing trace.
    const badThresh = join(dir, '..', 'bthresh.yaml');
    writeFileSync(badThresh, 'name: bt\nthreshold: abc\ncriteria:\n  - name: a\n    pattern: answer\n    expected: true\n');
    expect(run(['eval', id, '--rubric', badThresh]).code).toBe(2);
  });

  it('diff --fields recomputes divergence so the view is self-consistent', () => {
    // Two traces differing only in step name. Filtering to a field with no
    // difference must clear the divergence too, not leave a stale banner that
    // reads "DIVERGES AT STEP N" above "0 difference(s) found".
    const f = join(dir, '..', 'df.jsonl');
    writeFileSync(f, [
      JSON.stringify({ agent_name: 'dl', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'left-name', output: { t: 'same' } }] }),
      JSON.stringify({ agent_name: 'dr', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'right-name', output: { t: 'same' } }] }),
    ].join('\n'));
    run(['ingest', f, '--format', 'jsonl']);
    const ids = JSON.parse(run(['list', '--json']).stdout).items.map((t: { id: string }) => t.id);

    // Unfiltered, the name difference is a genuine divergence at step 1.
    const full = JSON.parse(run(['diff', ids[0], ids[1], '--json']).stdout);
    expect(full.divergence_step).toBe(1);
    expect(full.diffs.length).toBeGreaterThan(0);

    // Filtered to a field with no difference, both the diffs and the divergence
    // clear — the --json output stays internally consistent...
    const filtered = JSON.parse(run(['diff', ids[0], ids[1], '--fields', 'output', '--json']).stdout);
    expect(filtered.diffs).toHaveLength(0);
    expect(filtered.divergence_step).toBeNull();
    // ...and the human view no longer contradicts itself.
    expect(run(['diff', ids[0], ids[1], '--fields', 'output']).stdout).not.toContain('DIVERGES AT STEP');
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

  it('fails when record drops every event, but stays lenient otherwise', () => {
    // A stream where nothing survives: the recording is empty even though the
    // producer sent data. Exiting 0 let `agent | record && check` read a total
    // capture failure (wrong --format, broken producer) as a clean run.
    const allBad = ['{ truncated', '{"v":999,"type":"trace_start","agent_name":"x"}', 'null'].join('\n');
    expect(run(['record'], allBad).code).toBe(1);

    // An empty stream is not a failure — there was nothing to record.
    expect(run(['record'], '').code).toBe(0);

    // And a partial failure stays exit 0: per-event leniency is the contract.
    const partial = [
      '{ truncated',
      '{"v":1,"type":"trace_start","trace_id":"tpart","agent_name":"partial"}',
      '{"v":1,"type":"trace_end","trace_id":"tpart","status":"completed"}',
    ].join('\n');
    expect(run(['record'], partial).code).toBe(0);
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
    // ai.max_tokens must be a positive integer, not silently coerced.
    expect(run(['config', 'set', 'ai.max_tokens', 'abc']).code).toBe(2);
    expect(run(['config', 'set', 'ai.max_tokens', '0']).code).toBe(2);
    expect(run(['config', 'set', 'ai.max_tokens', '-5']).code).toBe(2);
    expect(run(['config', 'set', 'ai.max_tokens', '2048']).code).toBe(0);    // valid
  });

  it('config get never prints an API key in plaintext, even for an object path', () => {
    const secret = 'sk-ant-SECRET1234567890ABCDEF';
    run(['config', 'set', 'ai.api_keys.anthropic', secret]);
    // Object paths (the parent objects) and the scalar path must all be masked.
    for (const path of ['ai.api_keys.anthropic', 'ai.api_keys', 'ai']) {
      const out = run(['config', 'get', path]).stdout;
      expect(out).not.toContain(secret);
      expect(out).toContain('sk-a'); // masked form is still shown
    }
    expect(run(['config', 'list']).stdout).not.toContain(secret);
  });

  it('reports failures via exit code, not just a stderr message', () => {
    // Usage errors → 2.
    expect(run(['export', '--format', 'bogus']).code).toBe(2);
    expect(run(['guard', 'add', '--name', 'x', '--pattern', 'not json', '--action', 'deny']).code).toBe(2);
    expect(run(['guard', 'add', '--name', 'x', '--pattern', '{}', '--action', 'bogus']).code).toBe(2);
    // A deny policy with an unusable name_regex must be rejected, not stored as
    // a kill-switch that silently never fires.
    expect(run(['guard', 'add', '--name', 'x', '--pattern', '{"name_regex":"(a+)+"}', '--action', 'deny']).code).toBe(2);
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

  it('export exits non-zero when the output file cannot be written', () => {
    // A failed write must not read as success: a CI step doing
    // `export --output f && upload f` would otherwise proceed with no file.
    const f = join(dir, '..', 'exp-src.jsonl');
    writeFileSync(f, '{"agent_name":"e","status":"completed"}');
    run(['ingest', f]);
    const bad = join(dir, 'no', 'such', 'subdir', 'out.json'); // parent dir doesn't exist
    expect(run(['export', '--output', bad]).code).not.toBe(0);
  });

  it('ingest exits non-zero on a partial validation failure, not just a total one', () => {
    // One valid record, one invalid (missing agent_name). The valid one is
    // still inserted, but the invalid one is silently dropped — so the command
    // must exit non-zero (as it does when every record is invalid), or a CI
    // gate would read the data loss as success.
    const mixed = join(dir, '..', 'mixed.jsonl');
    writeFileSync(mixed, '{"agent_name":"good","status":"completed"}\n{"no_agent_name":true}\n');
    expect(run(['ingest', mixed]).code).not.toBe(0);
    // --dry-run is the natural "validate my file" gate, so it must fail too.
    expect(run(['ingest', mixed, '--dry-run']).code).not.toBe(0);
  });

  it('exits non-zero and reports on an unknown command', () => {
    const r = run(['definitely-not-a-command']);
    expect(r.code).not.toBe(0);
  });

  it('treats commander usage errors as exit 2, matching the documented convention', () => {
    // The README exit-code table says an unknown flag or bad argument value is a
    // usage error (2). Commander defaults these to 1, so the CLI remaps them.
    expect(run(['list', '--bogusflag']).code).toBe(2);        // unknown option
    expect(run(['show']).code).toBe(2);                        // missing required argument
    expect(run(['definitely-not-a-command']).code).toBe(2);    // unknown command
    // help / version are not errors.
    expect(run(['--help']).code).toBe(0);
    expect(run(['--version']).code).toBe(0);
  });

  it('rejects stray positional arguments instead of silently ignoring them', () => {
    const file = join(dir, '..', 'stray.jsonl');
    writeFileSync(file, JSON.stringify({ agent_name: 'stray', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'o' }] }));
    run(['ingest', file]);
    const id = firstTraceId();

    // `list production` (meant as `--tag production`) must fail, not list everything.
    expect(run(['list', 'production']).code).toBe(2);
    // A typo'd second id on a single-trace command must fail, not run on the first.
    expect(run(['show', id, 'extra']).code).toBe(2);
    // The valid forms still work.
    expect(run(['list']).code).toBe(0);
    expect(run(['show', id]).code).toBe(0);
  });

  it('stats --json reports store aggregates, per-status, and per-agent counts', () => {
    const f = join(dir, '..', 'stats.jsonl');
    writeFileSync(f, [
      JSON.stringify({ agent_name: 'bot-a', status: 'completed', total_tokens: 100, steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }),
      JSON.stringify({ agent_name: 'bot-a', status: 'failed', total_tokens: 50, steps: [{ step_number: 1, step_type: 'error', name: 'boom', error: 'nope' }] }),
      JSON.stringify({ agent_name: 'bot-b', status: 'completed', total_tokens: 25, steps: [{ step_number: 1, step_type: 'output', name: 'y' }] }),
    ].join('\n'));
    run(['ingest', f, '--format', 'jsonl']);

    const res = run(['stats', '--json']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.overall.traces).toBe(3);
    expect(out.overall.totalTokens).toBe(175);
    expect(out.by_status.completed).toBe(2);
    expect(out.by_status.failed).toBe(1);
    expect(out.by_agent).toEqual([
      { agent_name: 'bot-a', count: 2, failed: 1 },
      { agent_name: 'bot-b', count: 1, failed: 0 },
    ]);
  });

  it('stats renders a human summary and rejects an excess argument', () => {
    const f = join(dir, '..', 'stats2.jsonl');
    writeFileSync(f, JSON.stringify({ agent_name: 'solo-bot', status: 'completed', steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }));
    run(['ingest', f]);

    const human = run(['stats']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Store Summary');
    expect(human.stdout).toContain('solo-bot');

    expect(run(['stats', 'bogus']).code).toBe(2); // usage error
  });

  it('stats --since windows the counts and rejects a malformed value', () => {
    const f = join(dir, '..', 'since.jsonl');
    writeFileSync(f, [
      JSON.stringify({ agent_name: 'old', status: 'completed', started_at: '2020-01-01T00:00:00Z', steps: [{ step_number: 1, step_type: 'output', name: 'x' }] }),
      JSON.stringify({ agent_name: 'new', status: 'completed', started_at: '2030-01-01T00:00:00Z', steps: [{ step_number: 1, step_type: 'output', name: 'y' }] }),
    ].join('\n'));
    run(['ingest', f, '--format', 'jsonl']);

    const all = JSON.parse(run(['stats', '--json']).stdout);
    expect(all.overall.traces).toBe(2);
    expect(all.since).toBeNull();

    const windowed = JSON.parse(run(['stats', '--json', '--since', '2025-01-01']).stdout);
    expect(windowed.overall.traces).toBe(1); // only the 2030 trace
    expect(windowed.since).toBe('2025-01-01');
    expect(windowed.by_agent).toEqual([{ agent_name: 'new', count: 1, failed: 0 }]);

    expect(run(['stats', '--since', 'not-a-window']).code).toBe(2); // usage error
  });

  it('stats renders an empty store without crashing (null aggregates → "-")', () => {
    // No traces ingested — AVG/SUM come back null and by_agent is empty. The
    // human view must show "-" rather than "null"/NaN, and --json must carry the
    // nulls through.
    const human = run(['stats']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Traces:');
    expect(human.stdout).not.toContain('NaN');
    expect(human.stdout).not.toContain('null');

    const out = JSON.parse(run(['stats', '--json']).stdout);
    expect(out.overall.traces).toBe(0);
    expect(out.overall.avgDurationMs).toBeNull();
    expect(out.by_agent).toEqual([]);
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
