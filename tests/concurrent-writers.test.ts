import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Several `agent-replay` processes write to one SQLite file at the same time:
 * every hook invocation is its own process, `otel serve` is a long-lived one,
 * and the user can run `fork` or a reader while both are going. Five source
 * files carry comments about `BEGIN IMMEDIATE` and `busy_timeout` written for
 * exactly this, each describing a real failure — a fork that died with a bare
 * "database is locked", a session that split across several traces — and the
 * suite tested the hook race alone. Nothing exercised MIXED writers, which is
 * the shape a real session actually has.
 *
 * This is that test. It asserts more than "no crash": the store is internally
 * consistent afterwards, and every writer's data is all there and correctly
 * attributed.
 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let dir: string;
let server: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`built CLI not found at ${CLI}; run "npm run build" first`);
});

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'ar-conc-')), '.agent-replay');
  execFileSync(process.execPath, [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
});

afterEach(() => {
  server?.kill('SIGTERM');
  server = undefined;
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

/** Run one CLI process to completion; resolve with its failure, if any. */
function cli(args: string[], stdin?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = execFile(
      process.execPath,
      [CLI, ...args, '--dir', dir],
      { timeout: 30_000 },
      (err, _so, se) => resolve(err ? `${args[0]}: code=${err.code} ${String(se).slice(0, 120)}` : null),
    );
    if (stdin != null) p.stdin!.end(stdin);
  });
}

const SEED = {
  agent_name: 'seed-bot',
  status: 'completed',
  input: { q: 1 },
  steps: [
    { step_number: 1, step_type: 'tool_call', name: 'search' },
    { step_number: 2, step_type: 'output', name: 'done' },
  ],
};

describe('hooks, an OTLP receiver, forks and readers all writing at once', () => {
  it('every writer lands its data, and the store stays consistent', async () => {
    // Seed a trace to fork from. Written to a real file rather than piped
    // through `/dev/stdin`, which is not reliably readable that way on Linux.
    const seedFile = join(dir, '..', 'seed.json');
    writeFileSync(seedFile, JSON.stringify(SEED));
    execFileSync(process.execPath, [CLI, 'ingest', seedFile, '--dir', dir], { encoding: 'utf8' });
    const seedId = (JSON.parse(
      execFileSync(process.execPath, [CLI, 'list', '--json', '--dir', dir], { encoding: 'utf8' }),
    ) as { items: { id: string }[] }).items[0].id;

    const port = await freePort();
    server = spawn(process.execPath, [CLI, 'otel', 'serve', '--port', String(port), '--dir', dir], { stdio: 'ignore' });
    const url = `http://localhost:${port}/v1/traces`;
    for (let i = 0; i < 60; i++) {
      try {
        const probe = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (probe.ok) break;
      } catch { await sleep(100); }
    }

    const N = 6;
    const SESSIONS = 3;
    const failures: string[] = [];

    // One OTLP export per iteration, each its own OTel trace id.
    const otlp = (i: number) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{ scopeSpans: [{ spans: [{
            traceId: 'aa' + String(i).padStart(30, '0'),
            spanId: 'bb' + String(i).padStart(14, '0'),
            name: 'invoke_agent',
            startTimeUnixNano: '1000000',
            endTimeUnixNano: '2000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
              { key: 'gen_ai.agent.name', value: { stringValue: 'otel-bot' } },
            ],
          }] }] }],
        }),
      }).then((r) => { if (!r.ok) failures.push(`otlp status ${r.status}`); },
              (e) => { failures.push(`otlp ${e.message}`); });

    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      jobs.push(otlp(i));
      // Hook events for a few sessions, interleaved — each hook is its own process.
      jobs.push(cli(['hook', 'PreToolUse'], JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: `sess_${i % SESSIONS}`,
        tool_name: `tool_${i}`, tool_input: {},
      })).then((f) => f && failures.push(f)));
      // A fork and two readers, competing for the same file.
      jobs.push(cli(['fork', seedId, '--from-step', '1']).then((f) => f && failures.push(f)));
      jobs.push(cli(['list', '--json']).then((f) => f && failures.push(f)));
      jobs.push(cli(['stats', '--json']).then((f) => f && failures.push(f)));
    }
    await Promise.all(jobs);

    // No writer was refused. A "database is locked" here is the exact failure
    // BEGIN IMMEDIATE was introduced to prevent.
    expect(failures).toEqual([]);

    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // Each OTLP export opened exactly one trace — none lost, none duplicated.
      const otel = db.prepare('SELECT COUNT(*) c FROM agent_traces WHERE agent_name = ?').get('otel-bot') as { c: number };
      expect(otel.c).toBe(N);

      // One trace per hook session, however the processes raced, and every
      // event landed as a step on it.
      const names = Array.from({ length: SESSIONS }, (_, i) => `sess_${i}`);
      const placeholders = names.map(() => '?').join(',');
      const sessions = db.prepare(
        `SELECT session_id, COUNT(*) c FROM agent_traces WHERE session_id IN (${placeholders}) GROUP BY session_id`,
      ).all(...names) as { session_id: string; c: number }[];
      expect(sessions).toHaveLength(SESSIONS);
      expect(sessions.every((s) => s.c === 1)).toBe(true);
      const hookSteps = db.prepare(
        `SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id IN (SELECT id FROM agent_traces WHERE session_id IN (${placeholders}))`,
      ).get(...names) as { c: number };
      expect(hookSteps.c).toBe(N);

      // Every fork committed, and none orphaned a step.
      const forks = db.prepare('SELECT COUNT(*) c FROM agent_traces WHERE parent_trace_id IS NOT NULL').get() as { c: number };
      expect(forks.c).toBe(N);
      const orphans = db.prepare(
        'SELECT COUNT(*) c FROM agent_trace_steps s LEFT JOIN agent_traces t ON t.id = s.trace_id WHERE t.id IS NULL',
      ).get() as { c: number };
      expect(orphans.c).toBe(0);
    } finally {
      db.close();
    }
  }, 120_000);
});
