import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
    const err = e as { stdout?: string; stderr?: string; status?: number | null; signal?: string };
    // A null status means the process never exited on its own — killed by the
    // timeout or a signal under parallel load. Mapping that to 1 made an
    // infrastructure kill indistinguishable from a real runtime failure, so a
    // flake surfaced as "expected 1 to be 2" and sent the reader hunting a bug
    // in the command. Report it as its own code with the signal in stderr.
    if (err.status == null) {
      return { stdout: err.stdout ?? '', stderr: `${err.stderr ?? ''}\n[killed by ${err.signal ?? 'unknown signal'}]`, code: -1 };
    }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status };
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

  it('will not enforce against a store with no enabled policies', () => {
    // The store-missing guard closes the fail-open only if EVERY registered hook
    // line carries --enforce. The documented setup does not: plain capture hooks
    // on UserPromptSubmit/PostToolUse/Stop, --enforce on PreToolUse alone. Capture
    // mode creates the store and fires first, so from any directory that isn't
    // the project root the tool call met a brand-new EMPTY policy set and was
    // allowed silently — the same fail-open, with the file now present.
    const fresh = mkdtempSync(join(tmpdir(), 'ar-hook-empty-'));
    const hook = (args: string[], input: string) => {
      try {
        const stdout = execFileSync(process.execPath, [CLI, ...args, '--dir', fresh], {
          encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000,
        });
        return { stdout, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; status?: number };
        return { stdout: err.stdout ?? '', code: err.status ?? 1 };
      }
    };
    const call = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'e1',
      tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    });

    // A capture hook creates the store, exactly as the documented config does.
    hook(['hook', 'UserPromptSubmit'], JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: 'e1', prompt: 'go',
    }));
    expect(existsSync(join(fresh, 'traces.db'))).toBe(true);

    // The gate cannot fire, so it refuses rather than allowing.
    const blocked = hook(['hook', 'PreToolUse', '--enforce'], call);
    expect(blocked.stdout).toMatch(/"permissionDecision":"deny"/);
    expect(blocked.stdout).toMatch(/no enabled guardrail policies/);

    // ...with an opt-out for the case where emptiness is deliberate.
    const allowed = hook(['hook', 'PreToolUse', '--enforce', '--allow-empty'], call);
    expect(allowed.stdout).not.toMatch(/"permissionDecision":"deny"/);

    // And once a policy exists, enforcement behaves normally in both directions.
    execFileSync(process.execPath, [CLI, 'guard', 'add', '--name', 'nodrop',
      '--action', 'deny', '--pattern', '{"input_contains":"drop table"}', '--dir', fresh], { encoding: 'utf8' });
    expect(hook(['hook', 'PreToolUse', '--enforce'], JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'e1', tool_name: 'Bash', tool_input: { command: 'ls' },
    })).stdout).not.toMatch(/"permissionDecision":"deny"/);
    expect(hook(['hook', 'PreToolUse', '--enforce'], JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'e1', tool_name: 'Bash', tool_input: { command: 'drop table users' },
    })).stdout).toMatch(/"permissionDecision":"deny"/);

    rmSync(fresh, { recursive: true, force: true });
  });

  it('will not answer allow from a store with no enabled policies', () => {
    // Sibling of the `hook --enforce` gate: the store is created by `init` or by
    // any capture hook, so the "brand-new empty policy set" scenario reached
    // `guard check` — the documented gate for harnesses without hooks — through
    // that door, answering allow at exit 0.
    const fresh = mkdtempSync(join(tmpdir(), 'ar-gc-'));
    const check = (args: string[]) => {
      try {
        const stdout = execFileSync(process.execPath, [CLI, 'guard', 'check', ...args, '--dir', fresh], {
          encoding: 'utf8',
          input: JSON.stringify({ step_type: 'tool_call', name: 'Bash', input: { command: 'rm -rf /' } }),
          stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000,
        });
        return { stdout, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; status?: number };
        return { stdout: err.stdout ?? '', code: err.status ?? 1 };
      }
    };
    // `init` creates the store, so the missing-store guard does not apply.
    execFileSync(process.execPath, [CLI, 'init', '--dir', fresh], { encoding: 'utf8' });

    const denied = check([]);
    expect(denied.code).toBe(2); // the documented block signal, not a bare error
    expect(JSON.parse(denied.stdout).action).toBe('deny'); // --json contract kept
    expect(check(['--allow-empty']).code).toBe(0);

    // With a policy present, both directions behave normally again.
    execFileSync(process.execPath, [CLI, 'guard', 'add', '--name', 'rmrf', '--action', 'deny',
      '--pattern', '{"input_contains":"rm -rf"}', '--dir', fresh], { encoding: 'utf8' });
    expect(check([]).code).toBe(2);
    rmSync(fresh, { recursive: true, force: true });
  });

  it('reports eval results this store cannot restore instead of dropping them silently', () => {
    // `export --with-evals` writes an `evals` array that `ingest` has no field
    // for, so it is dropped — on the documented backup/restore path, for data
    // the user explicitly opted in to keeping, with an exit 0 and no mention.
    const evalDir = mkdtempSync(join(tmpdir(), 'ar-evals-'));
    const file = join(evalDir, 'withevals.json');
    writeFileSync(file, JSON.stringify([{
      agent_name: 'evalbot',
      status: 'completed',
      input: { task: 'x' },
      steps: [{ step_number: 1, step_type: 'output', name: 'answer' }],
      evals: [{ evaluator_type: 'rubric', evaluator_name: 'r1', score: 1, passed: true }],
    }]));
    const res = run(['ingest', file]);
    expect(res.code).toBe(0); // the traces themselves restore faithfully
    expect(`${res.stdout}${res.stderr}`).toMatch(/1 stored eval result\(s\).*cannot be restored/);
    // --dry-run is the documented preview of the real run, so it must say so too.
    const dry = run(['ingest', file, '--dry-run']);
    expect(`${dry.stdout}${dry.stderr}`).toMatch(/1 stored eval result\(s\).*cannot be restored/);
    rmSync(evalDir, { recursive: true, force: true });
  });

  it('warns that a blocking output_contains policy cannot block live', () => {
    // Live enforcement evaluates a PROPOSED tool call — before it runs, so it
    // has no output — and every match key must match. A deny keyed on
    // output_contains therefore never fires under `hook --enforce`, however
    // active it looks in `guard list`. The demo ships such a policy, so users
    // copy the shape. It stays valid (it matches post-hoc in `guard test`), but
    // writing one as a kill switch now says so.
    const blocking = run(['guard', 'add', '--name', 'out-deny', '--action', 'deny', '--pattern', '{"output_contains":"http"}']);
    expect(blocking.code).toBe(0);
    expect(blocking.stdout).toMatch(/cannot block live/);

    // A non-blocking policy on the same key is a normal auditing pattern.
    const warnOnly = run(['guard', 'add', '--name', 'out-warn', '--action', 'warn', '--pattern', '{"output_contains":"http"}']);
    expect(warnOnly.stdout).not.toMatch(/cannot block live/);

    // And a blocking policy that CAN match a proposed call says nothing.
    const inputDeny = run(['guard', 'add', '--name', 'in-deny', '--action', 'deny', '--pattern', '{"input_contains":"rm -rf"}']);
    expect(inputDeny.stdout).not.toMatch(/cannot block live/);
  });

  it('--dialect other blocks by exit code for a harness that ignores hook stdout', () => {
    // The README documents "Crush / others without structured output: exits 2".
    // That was unreachable: detectDialect only answers 'unknown' for an
    // unrecognized EVENT, and an unrecognized event returns before enforcement.
    // So a Crush user registering `hook PreToolUse --enforce` was detected as
    // claude-code and answered with Claude-shaped JSON on exit 0 — which a
    // harness that doesn't read hook stdout ignores, and the call ran. Nothing
    // in a payload distinguishes such a harness, so the user declares it.
    run(['guard', 'add', '--name', 'rm', '--action', 'deny', '--pattern', '{"input_contains":"rm -rf"}']);
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    });

    // Detected dialect: a JSON decision on stdout, exit 0.
    const detected = run(['hook', 'PreToolUse', '--enforce'], payload);
    expect(detected.code).toBe(0);
    expect(JSON.parse(detected.stdout).hookSpecificOutput.permissionDecision).toBe('deny');

    // Declared dialect: the exit-code convention instead.
    const forced = run(['hook', 'PreToolUse', '--enforce', '--dialect', 'other'], payload);
    expect(forced.code).toBe(2);
    expect(forced.stdout).toBe('');
    expect(forced.stderr).toMatch(/rm -rf/);

    // An allowed call is still allowed under a declared dialect.
    const safe = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(run(['hook', 'PreToolUse', '--enforce', '--dialect', 'other'], safe).code).toBe(0);

    // A bad value is a usage error, and capture mode still never blocks.
    expect(run(['hook', 'PreToolUse', '--enforce', '--dialect', 'nonsense'], payload).code).toBe(2);
    expect(run(['hook', 'PreToolUse', '--dialect', 'nonsense'], payload).code).toBe(0);
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

  it('guard check fails CLOSED on stdin it cannot evaluate', () => {
    // `null`/array/primitive/malformed are not step objects. They must yield a
    // clean error — never a raw TypeError from `null.step_type` — and exit 2,
    // the block signal. Exit 1 read as a non-blocking error, so a wrapper gating
    // on `$? == 2` ran the tool it could not get a verdict for: a fail-open on
    // exactly the input a caller cannot vouch for, in the same function whose
    // DB-failure path already denies with 2.
    for (const body of ['null', '[]', '42', '{bad', '', '{"name":"x"}']) {
      const r = run(['guard', 'check'], body);
      expect(r.code).toBe(2);
      expect(r.stderr + r.stdout).not.toMatch(/TypeError|Cannot read/i);
      expect(JSON.parse(r.stdout).action).toBe('deny');
    }

    // A well-formed step no policy denies still passes — with at least one
    // policy present. A store with NO enabled policy is a gate that can never
    // fire, and now denies rather than waving everything through (the same rule
    // `hook --enforce` follows); this assertion used to run against an empty
    // store, so it was pinning that fail-open.
    run(['guard', 'add', '--name', 'gc-present', '--action', 'deny', '--pattern', '{"name_contains":"zzz-no-match"}']);
    expect(run(['guard', 'check'], JSON.stringify({ step_type: 'thought', name: 'ok' })).code).toBe(0);
    run(['guard', 'remove', 'gc-present']);
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
    // Assert the setup step succeeded: its failure is what the fork assertion
    // below would otherwise report, pointing at the wrong command.
    expect(run(['record'], stream).code).toBe(0);
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
    // Assert the setup step succeeded: its failure is what the fork assertion
    // below would otherwise report, pointing at the wrong command.
    expect(run(['record'], stream).code).toBe(0);
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
    // Assert the setup step succeeded: its failure is what the fork assertion
    // below would otherwise report, pointing at the wrong command.
    expect(run(['record'], stream).code).toBe(0);
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

    // The case the fix was written for, and which the first attempt MISSED: with
    // a translator format, an unrecognized line is ignored SILENTLY rather than
    // warned about, so `warnings` stayed 0 and piping the wrong --format
    // reported success having recorded nothing.
    const nativeStream = [
      '{"v":1,"type":"trace_start","trace_id":"twf","agent_name":"x"}',
      '{"v":1,"type":"trace_end","trace_id":"twf","status":"completed"}',
    ].join('\n');
    expect(run(['record', '--format', 'codex-exec'], nativeStream).code).toBe(1);
    expect(run(['record', '--format', 'gemini-stream'], nativeStream).code).toBe(1);
    // The right format for that same stream still succeeds.
    expect(run(['record'], nativeStream).code).toBe(0);

    // And a partial failure stays exit 0: per-event leniency is the contract.
    const partial = [
      '{ truncated',
      '{"v":1,"type":"trace_start","trace_id":"tpart","agent_name":"partial"}',
      '{"v":1,"type":"trace_end","trace_id":"tpart","status":"completed"}',
    ].join('\n');
    expect(run(['record'], partial).code).toBe(0);
  });

  it('marks a windowed show --json so a subset cannot read as the whole trace', () => {
    // The human path prints "Showing 2 of 4 steps"; the JSON path said nothing,
    // so a consumer received a complete-looking trace — trace-level totals
    // intact, evals unwindowed — whose `steps` was silently a subset.
    const stream = ['{"v":1,"type":"trace_start","trace_id":"twin","agent_name":"w"}'];
    for (let i = 1; i <= 4; i++) stream.push(`{"v":1,"type":"step","trace_id":"twin","step_number":${i},"step_type":"thought","name":"s${i}"}`);
    stream.push('{"v":1,"type":"trace_end","trace_id":"twin","status":"completed"}');
    run(['record'], stream.join('\n'));

    const windowed = JSON.parse(run(['show', 'twin', '--from-step', '2', '--to-step', '3', '--json']).stdout);
    expect(windowed.steps.map((s: { step_number: number }) => s.step_number)).toEqual([2, 3]);
    expect(windowed.step_window).toEqual({ from: 2, to: 3, shown: 2, omitted: 2 });

    // An unwindowed trace carries no marker at all.
    expect(JSON.parse(run(['show', 'twin', '--json']).stdout).step_window).toBeUndefined();
  });

  it('reports the steps this record run captured, not the traces lifetime total', () => {
    // Regression: "Total steps" summed getTrace(...).steps.length over every
    // touched trace, so resuming an existing trace by id — which the protocol
    // supports — reported every step the trace had ever accumulated, while
    // every other number in the panel counts this stream.
    // Leave the trace open so a later stream can append to it.
    run(['record', '--leave-open'], [
      '{"v":1,"type":"trace_start","trace_id":"tresume","agent_name":"r"}',
      '{"v":1,"type":"step","trace_id":"tresume","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"step","trace_id":"tresume","step_number":2,"step_type":"thought","name":"b"}',
    ].join('\n'));

    // A second run adds exactly one step to the same, still-running trace.
    const second = run(['record', '--leave-open'], [
      '{"v":1,"type":"step","trace_id":"tresume","step_number":3,"step_type":"thought","name":"c"}',
    ].join('\n'));

    expect(second.stdout).toMatch(/Total steps:\s+1/);
    // The trace really does hold all three.
    expect(JSON.parse(run(['show', 'tresume', '--json']).stdout).steps).toHaveLength(3);
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

    // The header panel keeps reporting the TRACE, not the window. The Tokens
    // line falls back to summing the steps when no producer set a trace-level
    // total (every hook/record/OTel/imported trace), so narrowing the step array
    // in place made `show --from-step` print a window subtotal on a trace-level
    // line — beside a trace-level Duration, and disagreeing with `list`/`stats`.
    const toks = ['{"v":1,"type":"trace_start","trace_id":"ttok","agent_name":"tok"}',
      '{"v":1,"type":"step","trace_id":"ttok","step_number":1,"step_type":"llm_call","name":"one","tokens_used":10}',
      '{"v":1,"type":"step","trace_id":"ttok","step_number":2,"step_type":"llm_call","name":"two","tokens_used":20}',
      '{"v":1,"type":"trace_end","trace_id":"ttok","status":"completed"}'];
    run(['record'], toks.join('\n'));
    const header = (args: string[]) => run(['show', 'ttok', ...args]).stdout.split('\n').find((l) => l.includes('Tokens:'))!;
    expect(header([])).toMatch(/30/);
    expect(header(['--from-step', '2'])).toMatch(/30/);
    expect(header(['--to-step', '1'])).toMatch(/30/);
    // The steps shown are still only the windowed ones.
    expect(run(['show', 'ttok', '--from-step', '2', '--steps-only']).stdout).not.toMatch(/"one"/);

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
      { agent_name: 'bot-a', count: 2, failed_or_timeout: 1 },
      { agent_name: 'bot-b', count: 1, failed_or_timeout: 0 },
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
    // The echoed cutoff is the NORMALIZED bound actually used, not the raw
    // input: `--since` is resolved to a UTC instant so SQLite can always parse
    // it (a `+0200`-style offset it cannot parse would otherwise match nothing).
    expect(windowed.since).toBe('2025-01-01T00:00:00.000Z');
    expect(windowed.by_agent).toEqual([{ agent_name: 'new', count: 1, failed_or_timeout: 0 }]);

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

  it('applies fork --tag as part of the fork itself', () => {
    // The tag used to be written AFTER forkTrace committed, so a failure on that
    // one statement reported "Fork failed" (exit 1) for a fork that existed —
    // an orphan whose id was never printed, and a fresh one on every retry.
    const lines = ['{"v":1,"type":"trace_start","trace_id":"tftag","agent_name":"ft"}',
      '{"v":1,"type":"step","trace_id":"tftag","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"trace_end","trace_id":"tftag","status":"completed"}'];
    run(['record'], lines.join('\n'));

    const out = run(['fork', 'tftag', '--from-step', '1', '--tag', 'whatif']);
    expect(out.code).toBe(0);
    const forkId = JSON.parse(run(['list', '--json', '--tag', 'whatif']).stdout).items[0].id;
    const forked = JSON.parse(run(['show', forkId, '--json']).stdout);
    expect(forked.tags).toContain('whatif');
    expect(forked.parent_trace_id).toBe('tftag');
  });

  it('rejects an unknown check --fields value before it touches the store', () => {
    // The field list was validated inside checkGolden, after every candidate had
    // been fetched, so a typo surfaced as whatever the data layer complained
    // about first — "No traces matched...", never naming the bad field.
    const golden = join(dir, 'g.json');
    writeFileSync(golden, JSON.stringify([{ agent_name: 'nobody', step_count: 1, steps_summary: [] }]));
    const r = run(['check', '--golden', golden, '--fields', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/bogus/);
    expect(r.stderr + r.stdout).toMatch(/Known fields/);
  });

  it('reports two runs that made opposite decisions as different', () => {
    // The step comparison covered type/name/input/output/model/error but never
    // the DECISION record — the one field this whole tool exists to explain. Two
    // runs that took opposite actions at the same step reported "Traces are
    // identical." (exit 0) while `decisions` and `why` correctly showed one
    // choosing rm_rf and the other safe_path.
    const trace = (agent: string, chosen: string) => JSON.stringify({
      agent_name: agent, trigger: 'manual', status: 'completed', input: { q: 'x' },
      steps: [
        { step_number: 1, step_type: 'decision', name: 'pick', decision: { chosen, rationale: 'because', decided_by: 'agent' } },
        { step_number: 2, step_type: 'output', name: 'done' },
      ],
    });
    // `ingest` assigns its own ids, so resolve them by the agent name.
    writeFileSync(join(dir, 'da.json'), trace('decider-a', 'rm_rf'));
    writeFileSync(join(dir, 'db.json'), trace('decider-b', 'safe_path'));
    run(['ingest', join(dir, 'da.json')]);
    run(['ingest', join(dir, 'db.json')]);
    const idOf = (agent: string) => JSON.parse(run(['list', '--json', '--agent', agent]).stdout).items[0].id as string;
    const a = idOf('decider-a');
    const b = idOf('decider-b');

    const report = JSON.parse(run(['diff', a, b, '--json']).stdout);
    expect(report.divergence_step).toBe(1);
    const decision = report.diffs.find((d: { field: string }) => d.field === 'decision');
    expect(decision.left_value.chosen).toBe('rm_rf');
    expect(decision.right_value.chosen).toBe('safe_path');
    expect(run(['diff', a, b]).stdout).not.toMatch(/identical/);

    // And it is selectable on its own.
    expect(run(['diff', a, b, '--fields', 'decision']).code).toBe(0);
    expect(JSON.parse(run(['diff', a, b, '--fields', 'decision', '--json']).stdout).diffs).toHaveLength(1);

    // A list that names no field at all is a usage error, not a silent filter
    // that under-reports real differences.
    const empty = run(['diff', a, b, '--fields', ',']);
    expect(empty.code).toBe(2);
    expect(empty.stderr + empty.stdout).toMatch(/no field names/);
  });

  it('decisions escapes control sequences so it cannot display a different choice than it stored', () => {
    // A lone CR in `chosen` overwrites the line on a real terminal, so the one
    // command whose job is reporting the choice could show the wrong option —
    // and contradict `why` about the same record.
    writeFileSync(join(dir, 'dc.json'), JSON.stringify({
      agent_name: 'decider-esc', trigger: 'manual', status: 'completed', input: {},
      steps: [{
        step_number: 1, step_type: 'decision', name: 'pick',
        decision: { chosen: 'delete_prod_db\r      Chose: noop', rationale: 'x', decided_by: 'agent' },
      }],
    }));
    run(['ingest', join(dir, 'dc.json')]);
    const escId = JSON.parse(run(['list', '--json', '--agent', 'decider-esc']).stdout).items[0].id as string;

    const out = run(['decisions', escId]).stdout;
    expect(out).toContain('delete_prod_db');
    // The raw CR never reaches the terminal, so the real choice cannot be hidden.
    expect(out).not.toContain('\r      Chose: noop');
    expect(out).toMatch(/\\x0d/);
  });

  it('never lets a gate BOOTSTRAP the store it is supposed to consult', () => {
    // `ensureDatabase` creates what it does not find, so a gate pointed at the
    // wrong directory built an empty store, allowed everything, and left that
    // store behind so every later check allowed too. Checking only on the tool
    // call was a one-shot any earlier event disarmed: with one `--enforce`
    // command line registered across all hook events — the configuration that
    // check was written to support — SessionStart fires first and bootstraps it.
    const missing = join(dir, 'no-store-here');
    // Spawned directly: the run() helper appends its own --dir, which would
    // point these at the seeded store instead of the missing one.
    const spawn = (args: string[], payload: unknown) => {
      try {
        const stdout = execFileSync(process.execPath, [CLI, ...args], {
          encoding: 'utf8', input: JSON.stringify(payload), stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { stdout, code: 0 };
      } catch (e) {
        const err = e as { stdout?: string; status?: number | null };
        return { stdout: err.stdout ?? '', code: err.status ?? 1 };
      }
    };

    // A non-gating event neither creates the store nor blocks the session.
    const session = spawn(['hook', 'SessionStart', '--enforce', '--dir', missing],
      { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/p' });
    expect(session.code).toBe(0);
    expect(existsSync(join(missing, 'traces.db'))).toBe(false);

    // The tool call that would have gone unchecked is blocked.
    const gated = spawn(['hook', 'PreToolUse', '--enforce', '--dir', missing],
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    expect(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(existsSync(join(missing, 'traces.db'))).toBe(false);

    // Same fail-open in the command the README documents as the standalone gate.
    const check = spawn(['guard', 'check', '--dir', missing],
      { step_type: 'tool_call', name: 'rm_rf', input: { cmd: 'rm -rf /' } });
    expect(check.code).toBe(2);
    expect(JSON.parse(check.stdout).action).toBe('deny');
    expect(existsSync(join(missing, 'traces.db'))).toBe(false);
  });

  it('demo --reset deletes the store files, not a working tree that merely looks like one', () => {
    // The name check is a naming heuristic, not proof of a store: a source
    // checkout called `agent-replay-project` passes it, and --reset then rm -r'd
    // that tree. Only traces.db and its sidecars may be removed.
    const parent = mkdtempSync(join(tmpdir(), 'ar-reset-'));
    const store = join(parent, 'agent-replay-project');
    mkdirSync(join(store, 'src'), { recursive: true });
    const source = join(store, 'src', 'main.ts');
    writeFileSync(source, 'export const important = 1;');

    execFileSync(process.execPath, [CLI, 'demo', '--reset', '--no-interactive', '--dir', store], { encoding: 'utf8', stdio: 'pipe' });

    expect(existsSync(source)).toBe(true);
    // The demo still seeded a store in there.
    expect(existsSync(join(store, 'traces.db'))).toBe(true);

    // A second --reset clears the store it now holds, and still keeps the source.
    execFileSync(process.execPath, [CLI, 'demo', '--reset', '--no-interactive', '--dir', store], { encoding: 'utf8', stdio: 'pipe' });
    expect(existsSync(source)).toBe(true);
    rmSync(parent, { recursive: true, force: true });
  });

  it('closes every step when a parallel tool batch\'s PostToolUse hooks race', async () => {
    // A harness that dispatches tools in parallel fires the matching PostToolUse
    // hooks near-simultaneously, each as its own process. With the find and the
    // update as separate statements they all claimed the SAME newest open step:
    // last writer won, the other outputs were discarded, and those steps stayed
    // open forever — silently, since updateStep always reports a row changed.
    const session = 'sess_post_race';
    const tools = [1, 2, 3, 4, 5, 6];
    for (const n of tools) {
      run(['hook', 'PreToolUse'], JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Read', tool_input: { n },
      }));
    }
    await Promise.all(tools.map((n) => new Promise<void>((done) => {
      execFile(process.execPath, [CLI, 'hook', 'PostToolUse', '--dir', dir], (): void => done())
        .stdin!.end(JSON.stringify({
          hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Read', tool_output: { r: n },
        }));
    })));

    const traceId = (JSON.parse(run(['list', '--json', '--session', session]).stdout).items as { id: string }[])[0].id;
    const steps = (JSON.parse(run(['show', traceId, '--json']).stdout).steps as {
      ended_at: string | null; output: { r: number } | null;
    }[]).filter((s) => s.output !== undefined);

    // Every step closed, and every distinct output survived.
    expect(steps.filter((s) => s.ended_at == null)).toHaveLength(0);
    expect(new Set(steps.map((s) => s.output?.r)).size).toBe(tools.length);
  });

  it('opens exactly one trace when a session\'s first hook events fire concurrently', async () => {
    // Each hook is its own process. When a session's first events arrive in
    // parallel, every process used to read "no open trace" and create its own:
    // the session split across several traces and the losers stayed `running`
    // forever, since finalize closes only one. Real concurrent processes — the
    // race is between processes, so an in-process test cannot reach it.
    const payload = (tool: string) =>
      JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess_race', tool_name: tool, tool_input: {} });
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F'].map(
        (tool) =>
          new Promise<void>((done) => {
            execFile(process.execPath, [CLI, 'hook', 'PreToolUse', '--dir', dir], (): void => done(), )
              .stdin!.end(payload(tool));
          }),
      ),
    );

    const traces = JSON.parse(run(['list', '--json']).stdout).items as { id: string; step_count: number }[];
    expect(traces).toHaveLength(1);
    // And no step was lost to the uniqueness retry while they raced.
    expect(traces[0].step_count).toBe(6);
  });

  it('prints a trace id that other commands can actually resolve', () => {
    // `run` printed shortId(), which STRIPS the `trc_` prefix — while every
    // consumer resolves an id by prefix from the START of the id. So the only
    // pointer the wrapper gives to the run it just recorded matched nothing,
    // on the one command with no other way to learn the id at the moment it
    // finishes.
    // spawnSync, not the shared `run` helper: the wrapper's summary line goes to
    // stderr, which that helper only captures on a non-zero exit.
    const proc = spawnSync(
      process.execPath,
      [CLI, 'run', '--dir', dir, '--agent-name', 'idcheck', '--', process.execPath, '-e', 'process.exit(0)'],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(proc.status).toBe(0);
    const printed = /trace (\S+) /.exec(proc.stderr)?.[1];
    expect(printed).toBeDefined();

    const shown = run(['show', printed!, '--json']);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout).agent_name).toBe('idcheck');
  });

  it('refuses an ambiguous trace-id prefix rather than picking one', () => {
    // `fork trc_ --from-step 1` used to fork an arbitrary trace out of a whole
    // store at exit 0 — a WRITE derived from a trace the user never named.
    for (const id of ['amb_aaa1', 'amb_bbb2']) {
      run(['record'], [
        `{"v":1,"type":"trace_start","trace_id":"${id}","agent_name":"amb"}`,
        `{"v":1,"type":"step","trace_id":"${id}","step_number":1,"step_type":"thought","name":"a"}`,
        `{"v":1,"type":"trace_end","trace_id":"${id}","status":"completed"}`,
      ].join('\n'));
    }
    const r = run(['show', 'amb_']);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Ambiguous trace id/);

    // A longer, unambiguous prefix still works.
    expect(run(['show', 'amb_aaa', '--json']).code).toBe(0);
  });

  it('answers every --json refusal with a document a pipeline can parse', () => {
    // `--json` is a contract: a caller piping into jq expects a document it can
    // read a verdict from on EVERY outcome. Six commands wrote a bare red line
    // to stderr and left stdout empty, so `show nosuchtrace --json | jq .` died
    // on a parse error rather than reporting a missing trace. Exit codes were
    // already right; the shape was not.
    run(['record'], [
      '{"v":1,"type":"trace_start","trace_id":"jsonc1","agent_name":"jsonc"}',
      '{"v":1,"type":"step","trace_id":"jsonc1","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"trace_end","trace_id":"jsonc1","status":"completed"}',
    ].join('\n'));
    const traceId = 'jsonc1';
    const cases: string[][] = [
      ['list', '--status', 'bogus', '--json'],
      ['list', '--limit', '-1', '--json'],
      ['stats', '--since', 'bogus', '--json'],
      ['show', 'nosuchtrace', '--json'],
      ['show', traceId, '--from-step', '0', '--json'],
      ['why', 'nosuchtrace', '--step', '1', '--json'],
      ['why', traceId, '--step', '999', '--json'],
      ['decisions', 'nosuchtrace', '--json'],
      ['diff', traceId, 'nosuch', '--json'],
      ['diff', traceId, traceId, '--fields', 'bogus', '--json'],
      ['check', '--golden', 'nosuch.json', '--json'],
      ['eval', 'nosuchtrace', '--json'],
    ];
    for (const args of cases) {
      const r = run(args);
      expect(r.code, `${args.join(' ')} should fail`).not.toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok, `${args.join(' ')} should report ok:false`).toBe(false);
      expect(typeof parsed.error, `${args.join(' ')} should name the error`).toBe('string');
    }
  });

  it('rejects a --modify-input that is not an object, but keeps null as a no-op', () => {
    // The parsed value was typed as an object and never checked, so
    // `--modify-input 5` stored the trace input as a bare scalar — a shape the
    // model type and every other producer path guarantee against.
    run(['record'], [
      '{"v":1,"type":"trace_start","trace_id":"modin","agent_name":"m"}',
      '{"v":1,"type":"step","trace_id":"modin","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"trace_end","trace_id":"modin","status":"completed"}',
    ].join('\n'));

    for (const bad of ['5', '"str"', '[1,2]', 'true']) {
      const r = run(['fork', 'modin', '--from-step', '1', '--modify-input', bad]);
      expect(r.code, `--modify-input ${bad}`).toBe(2);
      expect(r.stderr).toMatch(/expected an object/);
    }

    // `null` keeps the original value and is not an error.
    expect(run(['fork', 'modin', '--from-step', '1', '--modify-input', 'null']).code).toBe(0);
    // An object still works.
    expect(run(['fork', 'modin', '--from-step', '1', '--modify-input', '{"q":1}']).code).toBe(0);
  });

  it('names a duplicate policy instead of quoting the SQL constraint', () => {
    const pattern = JSON.stringify({ name_contains: 'rm' });
    expect(run(['guard', 'add', '--name', 'p1', '--action', 'deny', '--pattern', pattern]).code).toBe(0);
    const again = run(['guard', 'add', '--name', 'p1', '--action', 'deny', '--pattern', pattern]);
    expect(again.code).not.toBe(0);
    const out = again.stderr + again.stdout;
    expect(out).toMatch(/already exists/);
    expect(out).not.toMatch(/UNIQUE constraint/);
  });

  it('gives check the same hints array every other --json command emits', () => {
    // `check` kept its own copy of the refusal helper and emitted a singular
    // `hint` STRING where every sibling emits a `hints` ARRAY — so
    // `check --json | jq -r '.hints[]'`, the CI pipeline this command exists
    // for, silently yielded nothing on the refusal path. A second copy of a
    // contract is how the contract splits.
    run(['record'], [
      '{"v":1,"type":"trace_start","trace_id":"hintc","agent_name":"hintbot"}',
      '{"v":1,"type":"step","trace_id":"hintc","step_number":1,"step_type":"thought","name":"a"}',
      '{"v":1,"type":"trace_end","trace_id":"hintc","status":"completed"}',
    ].join('\n'));
    const golden = join(dir, 'g-hints.json');
    expect(run(['export', '--format', 'golden', '--output', golden]).code).toBe(0);

    const r = run(['check', '--golden', golden, '--agent', 'nosuchagent', '--json']);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.hints)).toBe(true);
    expect(parsed.hints.length).toBeGreaterThan(0);
    expect(parsed.hint).toBeUndefined();
  });

  it('answers an unopenable store as JSON too, not just a missing trace', () => {
    // Opening the store happens BEFORE each command's own refusal path, so an
    // unopenable store — corrupt, unreadable, or written by a newer build —
    // escaped to the top-level handler: a bare stderr line, exit 1, and nothing
    // on stdout for a --json caller. The refusal-shape fix covered every case
    // except this one, which is the case a pipeline is least able to guess at.
    run(['record'], [
      '{"v":1,"type":"trace_start","trace_id":"v99t","agent_name":"v"}',
      '{"v":1,"type":"trace_end","trace_id":"v99t","status":"completed"}',
    ].join('\n'));

    // Mark the store as a schema this build does not support.
    const sdb = new BetterSqlite3(join(dir, 'traces.db'));
    try {
      sdb.prepare('INSERT INTO schema_version (version) VALUES (99)').run();
    } finally {
      sdb.close();
    }

    for (const args of [['list', '--json'], ['stats', '--json'], ['decisions', 'v99t', '--json'], ['eval', 'v99t', '--json']]) {
      const r = run(args);
      expect(r.code, `${args.join(' ')} exit`).toBe(2);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/store|schema/i);
    }
  });

  it('rejects --agent together with --agent-exact', () => {
    const golden = join(dir, 'g-both.json');
    writeFileSync(golden, JSON.stringify([{
      id: 'g1', agent_name: 'a', input: { t: 1 }, expected_output: null,
      steps_summary: [], eval_criteria: [], metadata: { status: 'completed' },
    }]));
    const r = run(['check', '--golden', golden, '--agent', 'a', '--agent-exact', 'b', '--json']);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/mutually exclusive/);
  });

  it.each([['--status'], ['--agent'], ['--tag'], ['--session'], ['--since']])(
    'list rejects an empty %s value rather than listing every trace',
    (flag) => {
      // Same class as the `check` guard below, on the command where a script is
      // most likely to build a filter from a shell variable. `list --agent
      // "$AGENT"` with $AGENT unset used to return the WHOLE store at exit 0,
      // which reads exactly like a correct narrow result. `stats` already
      // refused an empty `--since`; `list` did not, despite its own comment
      // claiming the two mirror each other.
      run(['ingest', '-'], JSON.stringify({ agent_name: 'alpha', input: {}, steps: [] }));
      run(['ingest', '-'], JSON.stringify({ agent_name: 'beta', input: {}, steps: [] }));

      const r = run(['list', flag, '', '--json']);
      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/empty value/);
      // The point of the guard: it must not have silently returned everything.
      expect(parsed.items).toBeUndefined();
    },
  );

  it.each([['--agent'], ['--agent-exact']])('rejects an empty %s value rather than widening the gate', (flag) => {
    // `--agent-exact "$AGENT"` with an unset shell variable would otherwise
    // silently widen a gate from one agent to EVERY agent and report green —
    // the same silent scope-widening this command already refuses for an empty
    // `--fields` list, and for the same reason: a narrowing flag that quietly
    // stops narrowing hides the mistake.
    const golden = join(dir, 'g-empty.json');
    writeFileSync(golden, JSON.stringify([{
      id: 'g1', agent_name: 'a', input: { t: 1 }, expected_output: null,
      steps_summary: [], eval_criteria: [], metadata: { status: 'completed' },
    }]));
    const r = run(['check', '--golden', golden, flag, '', '--json']);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/empty value/);
  });
});
