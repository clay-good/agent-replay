# Design — add-runtime-harness

## Context

`guard-service.ts` already implements step-vs-policy matching (`matchesPolicy`) but is only invoked post-hoc over whole traces. Live capture (previous change) gives us the event channel and the hook adapter. This change adds the wrapper process, the enforcement path, and the regression runner.

## Goals / Non-Goals

- Goals: wrap any agent command; enforce `deny` policies before a step executes; make enforcement decisions themselves part of the trace; make golden datasets executable in CI
- Non-Goals: sandboxing or syscall interception (we enforce at the protocol level, not the OS level); modifying tool inputs in flight; re-executing an agent's LLM calls deterministically (fork + golden diff remains the replay story)

## Decisions

### Environment contract for `run`

`run` spawns the child with: `AGENT_REPLAY_DIR` (data directory), `AGENT_REPLAY_TRACE_ID` (pre-created trace), and `AGENT_REPLAY_EVENTS` (path to a FIFO the harness reads JSONL events from). SDK-instrumented agents pick these up automatically; uninstrumented agents still get a trace with start/end, exit code, and captured stderr summary. The child's stdout/stderr pass through untouched — the harness must be transparent.

### Enforcement speaks each harness's documented dialect

`guard check` reads one step JSON from stdin, evaluates enabled policies in priority order, prints a JSON verdict (`{action, policy, reason}`) to stdout, and exits 0 (allow/warn — warnings go to stderr) or 2 (deny). In hook enforce mode the adapter prefers each harness's structured decision over the exit-code path, because structured output is richer and documented first-class: Claude Code and Codex CLI both accept `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow" | "deny" | "ask", "permissionDecisionReason": ...}}` on stdout (exit 0); Gemini CLI accepts `{"decision": "deny", "reason": ...}`. This unlocks a better `require_review` mapping: `"ask"` routes the call to the harness's own permission prompt (Claude Code and Codex) instead of hard-failing; Gemini hooks have no ask, so there it degrades to deny-with-reason — the same fail-closed posture Gemini's own policy engine applies to `ask_user` rules in non-interactive mode. Standalone `guard check` keeps the TTY-prompt/fail-closed behavior since there is no harness to defer to. Exit 2 + stderr remains the universal fallback (it is also the only blocking mechanism Crush supports).

### Enforcement is recorded, not just applied

Every `guard check` evaluation that matches a policy appends a `guard_check` step (with `caused_by_step` pointing at the checked step when known) to the corresponding trace. A blocked run tells its own story in `show`/`why`.

### Golden regression compares structure, not prose

`check --golden` matches candidate traces to golden traces by agent name + input hash, then reuses the diff engine with a field allowlist (step count, step types, names, tool-call inputs, final status) rather than raw outputs — LLM output text is non-deterministic, structure is the regression signal. `--fields` overrides the allowlist. Exit non-zero listing each divergence.

## Risks / Trade-offs

- Hook-level enforcement is a guardrail, not a security boundary — OpenAI's own Codex docs say PreToolUse "is still a guardrail rather than a complete enforcement boundary because Codex can often perform equivalent work through another supported tool path." We disclose this in help/README and point to the harnesses' OS-level sandboxes (Claude Code sandbox, Codex `sandbox_mode`, Gemini sandbox) for hard isolation
- Codex CLI requires hooks to be trusted via its `/hooks` command (and admins can restrict to managed hooks); enforce-mode setup docs must cover this or the hook silently never runs
- FIFO transport is POSIX-only; on Windows fall back to a temp file the harness tails. Accepted for v1
- Input-hash matching for golden traces is strict; near-miss matching is future work

## Migration Plan

No schema change. New commands are additive; `guard check` reuses existing policy storage untouched.

## Open Questions

- Should `run` support `--policy-set <tag>` to scope which policies are active per run? Deferred — priority + enabled flags cover current needs.
