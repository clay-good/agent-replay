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
  /** The status the trace ACTUALLY ended with — which is not always derivable
   * from the exit code, because an explicit `trace_end` status from the child
   * is honored over it. The caller must report this rather than re-deriving. */
  status: string;
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
    // The wrapper owns the trace; ignore the child's trace_start and stamp our
    // id onto every other event. Stamp UNCONDITIONALLY: a compliant child
    // generates its own trace_id (the SDK does, unless it threads
    // AGENT_REPLAY_TRACE_ID), and validateEvent already rejected any event
    // missing a trace_id — so `if (!event.trace_id)` never fired and the child's
    // events kept an id the wrapper never created, making every appendStep /
    // updateTrace throw "trace not found" and leaving an empty, stuck-`running`
    // trace.
    if (event.type === 'trace_start') return;
    event.trace_id = trace.id;
    try {
      applyEvent(db, event);
      applied++;
      // Note only an EXPLICIT terminal status, and only once it actually
      // persisted. A statusless trace_end defaults to 'completed' (indistinct
      // from still-open), so it must not suppress the exit-code finalization
      // below — a child that emits a bare trace_end then exits non-zero must
      // still be recorded as failed. Setting the flag only after a successful
      // apply also means a trace_end that failed to persist can't wrongly
      // suppress that finalization.
      if (event.type === 'trace_end' && typeof event.status === 'string' && event.status) {
        childDeclaredStatus = true;
      }
    } catch (err) {
      process.stderr.write(`agent-replay run: skipped ${event.type}: ${(err as Error).message}\n`);
    }
  };

  // Read at most this much per pass. `readSync` rejects a length that overflows
  // int32, so a child that wrote a 2 GiB events file made `Buffer.alloc(size -
  // bytesRead)` produce a length readSync throws on — and that throw happened
  // inside a setInterval callback, i.e. an UNCAUGHT exception: the wrapper died
  // with a raw stack trace, exited 1 instead of the child's status (fatal in CI,
  // the documented use case), left the trace stuck `running`, leaked the temp
  // dir and orphaned the child.
  const MAX_READ_CHUNK = 8 * 1024 * 1024;

  const drainOnce = (final: boolean): void => {
    let size: number;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return;
    }
    if (size < bytesRead) {
      // The channel is contracted to be append-only. A producer that rewrote or
      // truncated it would otherwise never be read again — every later event
      // silently dropped, exit 0, no diagnostic. Resume from the new end and say
      // so, rather than re-applying events already recorded.
      process.stderr.write(
        `agent-replay run: events channel was rewritten (${bytesRead} → ${size} bytes); earlier events may be lost\n`,
      );
      bytesRead = size;
      partial = '';
    }
    if (size > bytesRead) {
      const fd = openSync(eventsPath, 'r');
      try {
        while (size > bytesRead) {
          const len = Math.min(size - bytesRead, MAX_READ_CHUNK);
          const buf = Buffer.alloc(len);
          const n = readSync(fd, buf, 0, len, bytesRead);
          if (n <= 0) break; // nothing more readable; try again next pass
          bytesRead += n;
          partial += decoder.write(buf.subarray(0, n));
        }
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

  /**
   * Never let a read failure escape. This runs on a timer, so a throw here is an
   * uncaught exception that kills the wrapper mid-run — losing the child's exit
   * status, the trace's finalization and the temp dir. Any I/O problem (EMFILE,
   * EACCES, a file that outgrew a single read) must degrade to a warning; the
   * next pass, or the final drain, picks up whatever is readable.
   */
  const drain = (final: boolean): void => {
    try {
      drainOnce(final);
    } catch (err) {
      process.stderr.write(`agent-replay run: could not read the events channel: ${(err as Error).message}\n`);
    }
  };

  let killedSignal: string | null = null;
  const exitCode = await new Promise<number>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.command, opts.args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          AGENT_REPLAY_DIR: opts.dbDir,
          AGENT_REPLAY_TRACE_ID: trace.id,
          AGENT_REPLAY_EVENTS: eventsPath,
        },
      });
    } catch (err) {
      // `spawn` can throw SYNCHRONOUSLY — an empty command (a script running
      // `agent-replay run -- "$AGENT_CMD"` with the variable unset) is enough.
      // The trace row and the temp dir already exist, so an escaping throw left
      // an unfinalizable `running` ghost trace in the store and a leaked temp
      // dir. Treat it like the async spawn failure below.
      process.stderr.write(`agent-replay run: failed to spawn: ${(err as Error).message}\n`);
      resolvePromise(127);
      return;
    }

    const poll = setInterval(() => drain(false), 200);

    // Forward an interrupt to the child rather than dying where we stand.
    // Without this, Ctrl-C or a CI timeout killing the wrapper left the trace
    // `running` forever with no ended_at, no error and no exit code, leaked the
    // temp dir, and orphaned the child still holding the terminal. Forwarding
    // lets the child exit, which runs the normal close → finalize → cleanup
    // path, and the wrapper still reports 128 + signal.
    // Escalate if the child doesn't go. Installing these handlers REPLACES
    // Node's default terminate-on-signal, so forwarding alone traded a stuck
    // trace row for a stuck PROCESS: a child that ignores SIGTERM (`trap "" TERM`)
    // left the wrapper alive indefinitely, which is worse in the CI use case
    // this exists for. SIGKILL cannot be ignored, so a grace period guarantees
    // the run ends — and it ends through the normal close → finalize → cleanup
    // path, which is the point.
    const KILL_GRACE_MS = 5_000;
    let escalation: NodeJS.Timeout | undefined;
    const forward = (sig: NodeJS.Signals) => (): void => {
      try {
        child.kill(sig);
      } catch {
        // The child is already gone; the close handler will finalize.
      }
      if (escalation) return; // a repeated signal doesn't restart the clock
      escalation = setTimeout(() => {
        process.stderr.write(`agent-replay run: child did not exit after ${sig}; sending SIGKILL\n`);
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      // Don't hold the event loop open on the grace timer alone.
      escalation.unref?.();
    };
    const onSigint = forward('SIGINT');
    const onSigterm = forward('SIGTERM');
    const onSighup = forward('SIGHUP');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);

    const done = (code: number): void => {
      clearInterval(poll);
      if (escalation) clearTimeout(escalation);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
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

  const finalStatus = (db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(trace.id) as
    | { status: string }
    | undefined)?.status ?? 'unknown';

  return { traceId: trace.id, status: finalStatus, exitCode, eventsApplied: applied };
}
