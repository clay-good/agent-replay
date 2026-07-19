# Add Runtime Harness

## Why

Even with live capture, agent-replay only observes. Guardrail policies exist but can only be tested against traces after the damage is done, and golden datasets can be exported but nothing consumes them. To be a harness, agent-replay must be able to wrap an agent run end-to-end, enforce policies at the moment a dangerous step is attempted, and turn recorded runs into repeatable regression checks.

## What Changes

- New `agent-replay run [options] -- <command>` wrapper: spawns the agent process, hands it a recording channel via a documented environment contract, records the run as a trace, and propagates the child's exit status
- **Real-time guard enforcement**: new `agent-replay guard check` that evaluates a single proposed step (JSON on stdin) against enabled policies and answers via exit code and JSON verdict — exit 0 for allow/warn, exit 2 for deny — the blocking convention shared by Claude Code, Codex CLI, Gemini CLI, and Crush hooks
- `agent-replay hook --enforce` mode: the capture adapter from `add-live-trace-capture` additionally evaluates pre-tool events and blocks denied tool calls in each harness's documented dialect — `hookSpecificOutput.permissionDecision: "deny" | "ask"` for Claude Code and Codex CLI (`"ask"` hands `require_review` policies to the harness's own permission prompt), `decision: "deny"` for Gemini CLI, exit 2 as the fallback
- Every enforcement decision is recorded as a `guard_check` step in the trace, so the trace shows both what the agent tried and what the harness did about it
- New `agent-replay check --golden <file>` regression runner: compares traces (by filter or ID) against a golden dataset using the diff engine and exits non-zero on divergence — CI-ready

## Impact

- Affected specs: new capability `harness-run`; `guardrails` (added requirements); `trace-evaluation` (added golden regression requirement)
- Affected code: new `src/commands/run.ts`, `src/commands/check.ts`; `src/commands/hook.ts` (`--enforce`); new `src/services/harness-service.ts`; `src/services/guard-service.ts` (single-step evaluation reuse); `src/cli.ts`
- Depends on `add-live-trace-capture` (event channel, hook adapter) and transitively on `add-decision-trace-model`
