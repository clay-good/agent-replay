# Reap a Wrapped Child's Own Descendants

> **Status: PROPOSAL — awaiting a decision. Nothing here is implemented.**
> Raised because the gap is measured and reproducible, and closing it trades
> against behavior that currently works — which makes it a call rather than a
> bug.

## Why

`agent-replay run` forwards SIGTERM to its child and escalates to SIGKILL after
a 5-second grace. That part works, and was verified end to end:

```
agent-replay run -- sh -c 'trap "" TERM; sleep 60'
# ...send SIGTERM to the wrapper
```

- the wrapper waits exactly the grace period, sends SIGKILL, and exits `137`;
- the trace is finalized `failed` with `child killed by signal SIGKILL (exit 137)`;
- nothing is left `running`, and the temp channel directory is cleaned up.

What survives is the child's OWN descendants. The `sleep 60` above is a child of
the shell, not of the wrapper, so SIGKILL to the shell leaves it reparented to
init and still running.

For the case `run` exists for — a CI job wrapping an agent — that is the case
that matters: an agent that starts a dev server, a database, or a browser leaves
it running after a timeout kills the wrapper, on a machine the job no longer
owns.

## What Changes

Nothing yet. The options, with what each costs:

1. **Spawn the child in its own process group** (`detached: true`) and signal
   the GROUP (`process.kill(-pid, sig)`). Reaps the whole tree. Costs: it also
   kills anything the child deliberately backgrounded to outlive the run; and
   detaching changes signal delivery and terminal/job control, which is exactly
   what the current forwarding path handles carefully — an interactive child
   would no longer receive Ctrl-C from the shared terminal the way it does now.
2. **Group-kill only on ESCALATION.** Forward SIGTERM to the child alone, as
   today, and widen to the process group only for the SIGKILL after the grace.
   Keeps normal operation and Ctrl-C exactly as they are, and reaps the tree
   only in the case that is already violent. Still kills a deliberately
   backgrounded process, but only when the child ignored a polite request first.
3. **Report rather than reap.** After the child exits, note any surviving
   process group members on stderr and in trace metadata. Nothing is killed;
   the operator is told what was left behind. Cheapest and safest; leaves the
   CI case unsolved.

## Impact

- Affected specs: `harness-run`
- Affected code: `src/services/harness-service.ts` (the `spawn` options and the
  `forward`/escalation path)
- Whichever is chosen, `tests/run.test.ts` should grow a case that starts a
  grandchild and asserts what happens to it, since the current suite covers the
  child's exit code and the trace's finalization but not the tree.
- **Platform note:** `detached` and negative-PID signalling are POSIX. Windows
  has neither, so option 1 or 2 needs a documented no-op there — the repo
  supports Node on Windows via the packaged-install CI job.
