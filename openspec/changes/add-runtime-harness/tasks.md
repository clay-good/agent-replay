# Tasks — add-runtime-harness

## 1. Single-step guard evaluation

- [x] 1.1 Extract single-step policy evaluation from `testPolicies` in `guard-service.ts` (no behavior change to `guard test`)
- [x] 1.2 `agent-replay guard check`: step JSON on stdin → verdict JSON on stdout, exit 0/2; `require_review` fails closed without a TTY, prompts with one
- [x] 1.3 Test: allow, warn, deny, require_review (TTY and non-TTY) paths and exit codes

## 2. Enforcement recording

- [x] 2.1 Append a `guard_check` step (with policy, action, reason, and `caused_by_step`) to the trace for every matched evaluation
- [x] 2.2 Test: a blocked tool call appears in `show` as tool_call attempt + guard_check deny

## 3. Hook enforcement mode

- [x] 3.1 `agent-replay hook --enforce` on pre-tool events: structured decisions for Claude Code/Codex (`hookSpecificOutput.permissionDecision: "deny" | "ask"` + reason, exit 0) and Gemini (`decision: "deny"` + reason); exit-2 fallback for dialects without structured output (Crush)
- [x] 3.2 Map policy actions: `deny` → deny; `require_review` → `"ask"` on Claude Code/Codex, deny-with-reason on Gemini; `warn` → capture + `systemMessage` where supported, never blocks
- [x] 3.3 README: enforce-mode setup per harness — Claude Code settings.json, Codex config.toml plus the `/hooks` trust step, Gemini settings.json; state the guardrail-not-boundary limitation and point to harness sandboxing
- [x] 3.4 Test: per-dialect fixture payloads matching deny/require_review policies produce the correct structured response or exit code, and the attempt is recorded as a guard_check step

## 4. `run` wrapper

- [x] 4.1 `agent-replay run [--agent-name <n>] [--tags] -- <command>`: pre-create trace, export `AGENT_REPLAY_DIR` / `AGENT_REPLAY_TRACE_ID` / `AGENT_REPLAY_EVENTS`, read events from the FIFO, pass through stdio, finalize trace from child exit code, propagate exit status
- [x] 4.2 Uninstrumented child still yields a start/end trace with exit metadata
- [x] 4.3 Windows fallback: temp-file event channel instead of FIFO
- [x] 4.4 Test: instrumented script produces full trace; `exit 3` child → trace `failed`, harness exits 3

## 5. Golden regression runner

- [x] 5.1 `agent-replay check --golden <file> [--trace <id> | --agent <n> --since <d>] [--fields <list>]`: match by agent name + input hash, diff on the structural field allowlist, non-zero exit on divergence
- [x] 5.2 Human-readable divergence report plus `--json`
- [x] 5.3 Test: matching run passes; altered tool input fails with the divergent field named

## 6. Docs

- [x] 6.1 README: harness quick start (`run`, enforce mode, CI golden check example)
- [x] 6.2 `npm run verify` passes
