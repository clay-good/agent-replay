# Design Notes

## Open Questions

1. **Is a backgrounded process the child's to keep?** A wrapped agent that
   starts a long-lived helper may intend it to outlive the run. Group-killing
   takes that decision away. Option 2 narrows the question to "did the child
   ignore SIGTERM?", which is a much smaller claim.
2. **What does this do to an interactive child?** `run` is documented for CI,
   but nothing stops someone wrapping an interactive agent. `detached: true`
   moves the child out of the terminal's foreground process group, so Ctrl-C
   from the keyboard would no longer reach it — the wrapper would have to
   forward it, which is the path this change would be modifying.
3. **Windows.** There is no process group to signal. Whatever is chosen must
   degrade to today's behavior there rather than failing, and say so.

## What is already true

- The wrapper's own guarantees hold and are verified: exit code propagation
  (3, 143, 127 all correct), SIGKILL escalation after `KILL_GRACE_MS`, the
  trace finalized `failed` with the signal named, and the temp dir removed even
  when the store write fails.
- The child is spawned with `stdio` inherited so its output reaches the
  terminal unchanged — a property any detaching change has to preserve.
- Nothing in the store is wrong today. This is about processes the tool leaves
  behind, not about what it records.
