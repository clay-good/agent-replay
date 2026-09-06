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
  /** Events the store refused (e.g. a step number already used by this trace). */
  eventsDropped: number;
}

export async function runWrapped(db: Database.Database, opts: RunWrappedOptions): Promise<RunWrappedResult> {
  const startMs = Date.now();
  let trace;
  try {
    trace = startTrace(db, {
      // `?? opts.command` catches only null/undefined, so a BLANK name slipped
      // past the fallback and was stored as-is. `agent_name` is required and
      // non-empty everywhere else: `validateTraceInput` refuses `""` on ingest,
      // so `run --agent-name ""` wrote a trace this store's own `export` →
      // `ingest` round-trip cannot reproduce — the backup fails to restore, at
      // restore time, far from the cause. It also renders as a blank column in
      // `list` and cannot be filtered for by name.
      //
      // Blank falls back rather than throwing, for the reason capture-mode
      // `hook` warns instead of refusing an empty `--dir`: the child process is
      // the user's real work, and losing the run is worse than labelling it
      // with the command that produced it. `run` says so on stderr.
      //
      // Trimmed for the "is this set at all?" test only, and the value itself
      // passed through untrimmed — the rule `resolveDataDir` already follows.
      agent_name: opts.agentName != null && opts.agentName.trim() !== '' ? opts.agentName : opts.command,
      trigger: 'manual',
      tags: opts.tags,
      input: { command: opts.command, args: opts.args },
    });
  } catch (err) {
    // This runs BEFORE the child is spawned, so the command never ran at all.
    // A bare "database is locked" left the user unable to tell that from a
    // child that ran and failed — say which it was.
    throw new Error(
      `could not open a trace for this run, so the command was NOT started: ${(err as Error).message}`,
    );
  }

  const channelDir = mkdtempSync(join(tmpdir(), 'ar-run-'));
  const eventsPath = join(channelDir, 'events.jsonl');
  writeFileSync(eventsPath, '');

  let applied = 0;
  let dropped = 0;
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
  let decoder = new StringDecoder('utf8');
  /** Whether a trace_end's terminal status had to be repaired (see below). */
  let statusRepaired = false;

  const applyLine = (line: string): void => {
    const { event, warning, repaired } = parseEventLine(line);
    if (warning) process.stderr.write(`agent-replay run: ${warning}\n`);
    if (!event) {
      // A line the PROTOCOL rejected is data the child emitted and lost, exactly
      // like one that failed to store — so it belongs in the same count. Only
      // the storage failure below was counted, so a child whose events were
      // malformed (a missing `trace_id`, an unknown type, a bad JSON line — the
      // ordinary first-integration mistakes) got a summary reading "0 event(s)
      // recorded" with nothing saying anything had been thrown away. That reads
      // as "my instrumentation never fired" rather than "it fired and was
      // rejected", which sends the reader looking in the wrong place entirely.
      //
      // The stderr line above is not the durable record here: this wrapper
      // passes the child's own stdout and stderr through unmodified, so a
      // warning is interleaved with the agent's output and scrolls away, while
      // the summary is the last thing printed. `record`, which consumes the same
      // protocol, has always counted these.
      //
      // Only when there IS a warning: a blank or `//` comment line is legal
      // protocol and produces no event, and counting those would report losses
      // for a well-formed stream. And only when there is NO event: validation
      // can keep an event while warning about a single unusable FIELD it
      // ignored, which is a repair, not a drop.
      if (warning) dropped++;
      return;
    }
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
      const { warning: applyWarning } = applyEvent(db, event);
      applied++;
      if (applyWarning) process.stderr.write(`agent-replay run: ${applyWarning}\n`);
      // Note only an EXPLICIT terminal status, and only once it actually
      // persisted. A statusless trace_end defaults to 'completed' (indistinct
      // from still-open), so it must not suppress the exit-code finalization
      // below — a child that emits a bare trace_end then exits non-zero must
      // still be recorded as failed. Setting the flag only after a successful
      // apply also means a trace_end that failed to persist can't wrongly
      // suppress that finalization.
      // Only a TERMINAL status the store can actually record counts as the child
      // owning the outcome. `TraceEndEvent.status` is a free string, and
      // `updateTrace` coerces anything unrecognized to `failed` — so a child
      // ending with `status: "error"` would otherwise both be recorded that way
      // AND suppress the exit-code finalization, leaving no error text on the
      // run. `status: "running"` is worse — it survives coercion, so the trace
      // stays open forever and bare `watch` live-tails a dead process.
      //
      // A REPAIRED status is not a declaration. The protocol validator rewrites
      // an unusable terminal status to `failed`, which is the right answer for a
      // bare stream — but this wrapper holds ground truth the stream does not,
      // namely the child's exit code. Counting the repaired value as "the child
      // declared failed" meant a child that emitted `status: "success"` and then
      // exited 0 was stored as a FAILURE with no error text, because the
      // exit-code finalization below was skipped. Let the exit code decide.
      if (repaired === 'status' && event.type === 'trace_end') statusRepaired = true;
      if (
        repaired !== 'status' &&
        event.type === 'trace_end' &&
        (event.status === 'completed' || event.status === 'failed' || event.status === 'timeout')
      ) {
        childDeclaredStatus = true;
      }
    } catch (err) {
      // Count it. A child that records several sub-traces through one channel
      // collides on UNIQUE(trace_id, step_number) and loses every step after
      // the first sub-trace; with the count only in a stderr line, the summary
      // still read "N event(s) recorded" and nothing said data was missing.
      dropped++;
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

  // The channel's opening bytes, so a rewrite that keeps or grows the size is
  // still detected (see drainOnce).
  const HEAD_BYTES = 256;
  let channelHead: Buffer | null = null;
  const readHead = (path: string): Buffer | null => {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, n);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  };

  /**
   * Whether the channel's opening bytes CHANGED, over the prefix we have already
   * seen. Comparing the fixed-size head wholesale would flag ordinary growth as
   * a rewrite (a file shorter than HEAD_BYTES gains bytes with every append, and
   * a legitimate line split across two writes lands exactly there), which would
   * reset the read offset and drop the event it was in the middle of.
   */
  const headChanged = (head: Buffer | null): boolean => {
    if (head === null || channelHead === null) return false;
    const n = Math.min(head.length, channelHead.length);
    return !head.subarray(0, n).equals(channelHead.subarray(0, n));
  };

  const drainOnce = (final: boolean): void => {
    let size: number;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return;
    }
    // A shrink is only ONE way to rewrite the channel. A producer that reopens it
    // truncating (`createWriteStream(path)` with its default 'w' flags, or
    // writeFileSync — an ordinary mistake) and writes at least as many bytes as
    // were already consumed passed the size check untouched, and reading resumed
    // at a stale offset: events silently dropped, exit 0, no diagnostic — the
    // exact outcome the guard below promises to prevent. An in-place truncate
    // keeps the inode, so compare the file's opening bytes, which a rewrite
    // changes.
    const head = readHead(eventsPath);
    const replaced = headChanged(head);
    if (head !== null && (channelHead === null || head.length >= channelHead.length || replaced)) {
      channelHead = head;
    }

    if (size < bytesRead || replaced) {
      // The channel is contracted to be append-only. A producer that rewrote or
      // truncated it would otherwise never be read again — every later event
      // silently dropped, exit 0, no diagnostic. Resume from the new end and say
      // so, rather than re-applying events already recorded.
      process.stderr.write(
        `agent-replay run: events channel was rewritten (${bytesRead} → ${size} bytes); earlier events may be lost. The channel is append-only — open it with 'a', not 'w'.\n`,
      );
      bytesRead = size;
      partial = '';
      // Adopt the NEW file's head. Keeping the dead file's fingerprint made the
      // very next poll compare fresh bytes against it, declare a second
      // "rewrite" that had not happened, and skip reading — dropping every event
      // written after the truncation, which is precisely the silent loss this
      // branch exists to prevent.
      channelHead = head;
      // Reset the decoder too: its buffered partial multi-byte sequence belongs
      // to the file that was just replaced, and would corrupt the first
      // character read from the new one.
      decoder = new StringDecoder('utf8');
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
  //
  // All of finalization is best-effort. The polling path was hardened against a
  // throw for this reason, but the finalization path was not — and a throw here
  // reaches the CLI's top-level handler, which exits 1. So a store-level hiccup
  // (another writer holding the write lock past busy_timeout — likelier now that
  // the receiver, hook and fork take it up front for a whole batch) DESTROYED
  // the wrapper's headline guarantee: the child's own exit code was replaced by
  // 1, the trace stayed `running` with no ended_at forever, and the channel dir
  // leaked. Report what failed, still return the child's status.
  const finalize = (): string => {
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
    // `statusRepaired` joins the condition because the repaired `trace_end` has
    // ALREADY written `failed` to the row — so `current.status === 'running'` is
    // false and, on a clean exit, so is `exitCode !== 0`. Without it the
    // finalization never ran and a child that exited 0 stayed recorded as a
    // failure with no error text. The stream's guess is overwritten by the
    // wrapper's fact.
    if (current && !childDeclaredStatus && (current.status === 'running' || exitCode !== 0 || statusRepaired)) {
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

    // A child that sent its own trace_end owns the status — but it rarely sends
    // totals, and the wrapper is the only party that knows the wall-clock span
    // of the process. Filling a total_duration_ms the child left null keeps an
    // instrumented run inside duration stats, where it used to drop out while
    // an UNinstrumented run of the same command reported a duration.
    if (current && childDeclaredStatus) {
      const row = db.prepare('SELECT total_duration_ms FROM agent_traces WHERE id = ?').get(trace.id) as
        | { total_duration_ms: number | null }
        | undefined;
      if (row && row.total_duration_ms == null) {
        updateTrace(db, trace.id, { total_duration_ms: durationMs });
      }
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

    return (db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(trace.id) as
      | { status: string }
      | undefined)?.status ?? 'unknown';
  };

  let finalStatus: string;
  try {
    finalStatus = finalize();
  } catch (err) {
    console.error(`agent-replay run: could not finalize trace ${trace.id}: ${(err as Error).message}`);
    console.error(`agent-replay run: the child ran and exited ${exitCode}; that status is still reported.`);
    finalStatus = 'unknown';
  } finally {
    // The channel dir is the wrapper's own temp state; it must go even when the
    // store write failed, or every such run leaks a directory.
    try {
      rmSync(channelDir, { recursive: true, force: true });
    } catch {
      // Nothing useful to do — the OS reclaims it at the latest on reboot.
    }
  }

  return { traceId: trace.id, status: finalStatus, exitCode, eventsApplied: applied, eventsDropped: dropped };
}
