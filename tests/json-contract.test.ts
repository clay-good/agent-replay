import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `--json` documents are a CONTRACT with scripts, and the repo has lost
 * fields out of them twice: `show --json --snapshots` returned a document with
 * no `snapshots` key at all, and `list`/`show` printed a duration their JSON
 * could not report. Both passed every test, because the tests that covered
 * those commands asserted the shape they had just been given.
 *
 * So this pins the top-level keys of every `--json` payload against the BUILT
 * CLI. It is deliberately an exact set rather than a subset: a field that
 * disappears breaks a caller, and a field that appears without anyone noticing
 * is a contract change nobody reviewed. Either way the fix is to change this
 * list on purpose.
 *
 * Depends on the build, like the other CLI tests.
 */

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let dir: string;
let root: string;
let traceA: string;
let traceB: string;
let golden: string;

function run(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', status: r.status };
}

/** The parsed payload of a `--json` run, failing loudly if it is not JSON. */
function payload(args: string[]): unknown {
  const { stdout } = run(args);
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`\`${args.join(' ')}\` did not print JSON on stdout: ${stdout.slice(0, 200)}`);
  }
}

const keysOf = (v: unknown): string[] => Object.keys(v as Record<string, unknown>).sort();

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`built CLI not found at ${CLI}; run "npm run build" first`);
  root = mkdtempSync(join(tmpdir(), 'ar-jsonshape-'));
  dir = join(root, '.agent-replay');
  run(['init']);
  run(['demo', '--no-interactive']);
  const list = payload(['list', '--json']) as { items: { id: string }[] };
  traceA = list.items[0].id;
  traceB = list.items[1].id;
  // Real evaluations, so `eval --json` describes stored rows rather than an
  // empty list — a payload whose only element is absent proves nothing.
  run(['eval', traceA, '--all']);
  golden = join(root, 'golden.json');
  writeFileSync(golden, run(['export', '--format', 'golden']).stdout);
}, 60000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the --json documents keep their shape', () => {
  it('list', () => {
    expect(keysOf(payload(['list', '--json']))).toEqual(['items', 'total']);
  });

  it('stats', () => {
    expect(keysOf(payload(['stats', '--json']))).toEqual(['by_agent', 'by_status', 'overall', 'since']);
  });

  it('show', () => {
    // `effective_duration_ms` / `effective_tokens` are the DERIVED pair the
    // human view fills a null column with; they were missing here once, so a
    // script could not read the number the table printed. `possibly_abandoned`
    // joined them for the same reason: `list` and the header panel print
    // "⚠ abandoned?" and the payload could not say it.
    expect(keysOf(payload(['show', traceA, '--json']))).toEqual([
      'agent_name', 'agent_version', 'created_at', 'effective_duration_ms', 'effective_tokens',
      'ended_at', 'error', 'evals', 'forked_from_step', 'id', 'input', 'metadata', 'output',
      'parent_trace_id', 'possibly_abandoned', 'session_id', 'started_at', 'status', 'steps',
      'tags', 'total_cost_usd', 'total_duration_ms', 'total_tokens', 'trigger',
    ]);
  });

  it('show --snapshots adds snapshots to the steps, not a top-level key', () => {
    // The shape `ingest` reads back: a snapshot belongs to its step, which is
    // what `export --with-snapshots` had always written. A top-level array
    // round-tripped to nothing.
    const doc = payload(['show', traceA, '--json', '--snapshots']) as { steps: Record<string, unknown>[] };
    expect(keysOf(doc)).not.toContain('snapshots');
    expect(doc.steps.length).toBeGreaterThan(0);
    expect(Object.keys(doc.steps[0])).toContain('snapshot');
  });

  it('guard list', () => {
    expect(keysOf(payload(['guard', 'list', '--json']))).toEqual(['policies', 'warnings']);
  });

  it('guard test', () => {
    expect(keysOf(payload(['guard', 'test', traceA, '--json']))).toEqual(['matches', 'summary', 'trace_id']);
  });

  it('decisions', () => {
    expect(keysOf(payload(['decisions', traceA, '--json']))).toEqual(['decisions', 'trace_id']);
  });

  it('why', () => {
    expect(keysOf(payload(['why', traceA, '--step', '1', '--json']))).toEqual(['chain', 'step', 'trace_id']);
  });

  it('diff', () => {
    expect(keysOf(payload(['diff', traceA, traceB, '--json']))).toEqual([
      'compared_fields', 'diffs', 'divergence_step', 'left_step_count', 'left_trace_id',
      'right_step_count', 'right_trace_id',
    ]);
  });

  it('diff adds common_prefix only when one trace is a prefix of the other', () => {
    // The one conditional key in these payloads, so it is pinned in both
    // directions: two unrelated runs must not carry it (above), and a fork —
    // which stops where it was made — must.
    const forkOut = run(['fork', traceA, '--from-step', '2']).stdout;
    const forkId = (forkOut.match(/trc_[A-Za-z0-9_-]+/g) ?? []).pop() as string;
    const doc = payload(['diff', traceA, forkId, '--json']) as {
      common_prefix?: { shorter: string; last_common_step: number; missing_steps: number };
    };
    expect(doc.common_prefix?.shorter).toBe('right');
    expect(doc.common_prefix?.last_common_step).toBe(2);
    expect(doc.common_prefix?.missing_steps).toBeGreaterThan(0);
  });

  it('eval (an array of stored evaluation rows)', () => {
    const rows = payload(['eval', traceA, '--all', '--json']) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'details', 'evaluated_at', 'evaluator_name', 'evaluator_type', 'id', 'passed', 'score', 'trace_id',
    ]);
  });

  it('check --golden', () => {
    expect(keysOf(payload(['check', '--golden', golden, '--json']))).toEqual([
      'failed', 'ok', 'passed', 'results', 'uncompared', 'uncompared_partial', 'uncovered',
      'unmatched', 'unmatched_no_input',
    ]);
  });

  it('a refusal is a document too, on stdout, with stderr left empty', () => {
    // `makeRefuse`: a `--json` failure answers `{ok:false,error,hints?}` on
    // STDOUT and prints nothing to stderr, so a caller parses one stream in
    // both directions. "Refusal means nothing on stdout" is false here, and a
    // script written on that assumption reads an empty payload.
    const r = spawnSync(process.execPath, [CLI, 'show', 'trc_nosuchtrace', '--json', '--dir', dir], {
      encoding: 'utf8',
    });
    const doc = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(doc.ok).toBe(false);
    expect(doc.error).toBeTruthy();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(1);
  });
});
