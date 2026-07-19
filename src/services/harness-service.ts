import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTrace, updateTrace } from './trace-service.js';
import { applyEvent } from './recorder.js';
import { parseEventLine } from './event-protocol.js';

/**
 * Run a child process under supervision: pre-create a trace, hand the child a
 * recording channel via environment variables, consume the JSONL events it
 * writes there (live), and finalize the trace from the child's exit status.
 *
 * The event channel is a plain temp file (`AGENT_REPLAY_EVENTS`) the child
 * appends to — cross-platform and race-free (only whole, newline-terminated
 * lines are applied). An uninstrumented child that writes nothing still yields
 * a start/end trace with timing and exit metadata.
 */

export interface RunWrappedOptions {
  command: string;
  args: string[];
  agentName?: string;
  tags?: string[];
  dbDir: string;
}

export interface RunWrappedResult {
  traceId: string;
  exitCode: number;
  eventsApplied: number;
}

export async function runWrapped(db: Database.Database, opts: RunWrappedOptions): Promise<RunWrappedResult> {
  const startMs = Date.now();
  const trace = startTrace(db, {
    agent_name: opts.agentName ?? opts.command,
    trigger: 'manual',
    tags: opts.tags,
    input: { command: opts.command, args: opts.args },
  });

  const channelDir = mkdtempSync(join(tmpdir(), 'ar-run-'));
  const eventsPath = join(channelDir, 'events.jsonl');
  writeFileSync(eventsPath, '');

  let applied = 0;
  // Read the events file incrementally from a byte offset so a long run
  // (real sessions emit thousands of events) doesn't re-read the whole growing
  // file on every 200ms poll. Only complete, newline-terminated lines are
  // applied; a trailing partial line is buffered until the rest arrives.
  let bytesRead = 0;
  let partial = '';

  const applyLine = (line: string): void => {
    const { event, warning } = parseEventLine(line);
    if (warning) process.stderr.write(`agent-replay run: ${warning}\n`);
    if (!event) return;
    // The wrapper owns the trace; ignore child trace_start, and stamp our id.
    if (event.type === 'trace_start') return;
    if (!event.trace_id) event.trace_id = trace.id;
    try {
      applyEvent(db, event);
      applied++;
    } catch (err) {
      process.stderr.write(`agent-replay run: skipped ${event.type}: ${(err as Error).message}\n`);
    }
  };

  const drain = (final: boolean): void => {
    let size: number;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return;
    }
    if (size > bytesRead) {
      const fd = openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(size - bytesRead);
        const n = readSync(fd, buf, 0, buf.length, bytesRead);
        bytesRead += n;
        partial += buf.toString('utf-8', 0, n);
      } finally {
        closeSync(fd);
      }
    }
    const lines = partial.split('\n');
    if (final) {
      // Apply everything, including any trailing line with no final newline.
      partial = '';
    } else {
      // Buffer the trailing (possibly incomplete) line until more arrives.
      partial = lines.pop() ?? '';
    }
    for (const line of lines) applyLine(line);
  };

  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(opts.command, opts.args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_REPLAY_DIR: opts.dbDir,
        AGENT_REPLAY_TRACE_ID: trace.id,
        AGENT_REPLAY_EVENTS: eventsPath,
      },
    });

    const poll = setInterval(() => drain(false), 200);

    const done = (code: number): void => {
      clearInterval(poll);
      resolvePromise(code);
    };

    child.on('error', (err) => {
      process.stderr.write(`agent-replay run: failed to spawn: ${err.message}\n`);
      done(127);
    });
    child.on('close', (code, signal) => {
      done(code == null ? (signal ? 1 : 0) : code);
    });
  });

  // Apply anything written right before exit, then finalize.
  drain(true);

  const durationMs = Date.now() - startMs;
  const current = db.prepare('SELECT status, metadata FROM agent_traces WHERE id = ?').get(trace.id) as
    | { status: string; metadata: string }
    | undefined;

  // Honor an explicit trace_end from the child; otherwise derive from exit code.
  if (current && current.status === 'running') {
    updateTrace(db, trace.id, {
      status: exitCode === 0 ? 'completed' : 'failed',
      ended_at: new Date(startMs + durationMs).toISOString(),
      total_duration_ms: durationMs,
      error: exitCode === 0 ? undefined : `child exited with code ${exitCode}`,
    });
  }

  // Merge exit metadata regardless of who finalized the trace.
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(current?.metadata ?? '{}');
  } catch {
    metadata = {};
  }
  metadata.exit_code = exitCode;
  db.prepare('UPDATE agent_traces SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), trace.id);

  rmSync(channelDir, { recursive: true, force: true });

  return { traceId: trace.id, exitCode, eventsApplied: applied };
}
