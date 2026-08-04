import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
  let childDeclaredStatus = false;
  // Decode bytes with a StringDecoder so a multi-byte UTF-8 character split
  // across two reads (a poll boundary landing mid-character, or the child
  // flushing a partial write) recombines instead of each half becoming U+FFFD.
  const decoder = new StringDecoder('utf8');

  const applyLine = (line: string): void => {
    const { event, warning } = parseEventLine(line);
    if (warning) process.stderr.write(`agent-replay run: ${warning}\n`);
    if (!event) return;
    // The wrapper owns the trace; ignore child trace_start, and stamp our id.
    if (event.type === 'trace_start') return;
    if (!event.trace_id) event.trace_id = trace.id;
    // Note only an EXPLICIT terminal status from the child. A statusless
    // trace_end is defaulted to 'completed' by the recorder, which is
    // indistinguishable from the trace still being open — so it must not
    // suppress the exit-code finalization below (a child that emits a bare
    // trace_end then exits non-zero must still be recorded as failed).
    if (event.type === 'trace_end' && typeof event.status === 'string' && event.status) {
      childDeclaredStatus = true;
    }
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
        partial += decoder.write(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    }
    if (final) partial += decoder.end(); // flush any bytes still buffered
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

  let killedSignal: string | null = null;
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
      // A child killed by a signal has no exit code; follow the shell
      // convention and report 128 + signal number (e.g. SIGKILL → 137) so the
      // status propagates and an OOM/kill is distinguishable from a generic
      // failure, rather than flattening every signal death to 1.
      if (code == null && signal) {
        killedSignal = signal;
        const num = (constants.signals as Record<string, number>)[signal] ?? 0;
        done(128 + num);
      } else {
        done(code ?? 0);
      }
    });
  });

  // Apply anything written right before exit, then finalize.
  drain(true);

  const durationMs = Date.now() - startMs;
  const current = db.prepare('SELECT status, metadata FROM agent_traces WHERE id = ?').get(trace.id) as
    | { status: string; metadata: string }
    | undefined;

  // Honor an EXPLICIT terminal status from the child; otherwise derive from the
  // exit code. The trace is still `running` if the child emitted no trace_end,
  // and a statusless trace_end defaults to `completed` — so a non-zero exit
  // without an explicit child status must override that default to `failed`,
  // per the spec (exit 0 → completed, non-zero → failed with the code recorded).
  if (current && !childDeclaredStatus && (current.status === 'running' || exitCode !== 0)) {
    updateTrace(db, trace.id, {
      status: exitCode === 0 ? 'completed' : 'failed',
      ended_at: new Date(startMs + durationMs).toISOString(),
      total_duration_ms: durationMs,
      error: exitCode === 0
        ? undefined
        : killedSignal
          ? `child killed by signal ${killedSignal} (exit ${exitCode})`
          : `child exited with code ${exitCode}`,
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
