# guardrails Specification

## Purpose

Define kill-switch policies that pattern-match trace steps and prescribe actions, and test them against recorded traces.
## Requirements
### Requirement: Policy management

The system SHALL manage guardrail policies via `agent-replay guard add|list|remove|enable|disable`, where each policy has a unique name, an action (`allow`, `deny`, `warn`, `require_review`), a priority, an enabled flag, and a JSON match pattern.

#### Scenario: Add a deny policy

- **WHEN** a user runs `agent-replay guard add --name no-deletes --pattern '{"step_type":"tool_call","name_contains":"delete"}' --action deny`
- **THEN** the policy is stored, enabled, and visible in `guard list`

### Requirement: Step match patterns

The system SHALL match steps against pattern fields — `step_type` (exact), `name_contains` (case-insensitive substring), `name_regex`, `input_contains`, `output_contains` — combining specified fields with AND logic. An empty pattern SHALL match nothing.

`guard add` SHALL REFUSE, at write time, a pattern that cannot match as written: one with no recognized match key, a `step_type` that is not a real step type, or a `name_regex` that is invalid or unsafe against catastrophic backtracking. A policy stored in a form that silently fails to match is worse than no policy, because the gate reports green.

#### Scenario: AND semantics

- **WHEN** a pattern specifies both `step_type: tool_call` and `name_contains: delete`
- **THEN** only tool_call steps whose name contains "delete" match

### Requirement: Post-hoc policy testing

The system SHALL test all enabled policies against every step of a recorded trace via `agent-replay guard test <trace-id>`, reporting which policies matched which steps, in priority order, with human-readable match reasons.

#### Scenario: Test against a trace

- **WHEN** a user runs `agent-replay guard test <id>` on a trace containing a `delete_user` tool call and a `no-deletes` deny policy exists
- **THEN** the report flags that step with the policy name, action `deny`, and the match reason

### Requirement: Real-time step evaluation

The system SHALL evaluate a single proposed step against all enabled policies via `agent-replay guard check` (step JSON on stdin), printing a JSON verdict (`action`, `policy`, `reason`) to stdout and answering by exit code: 0 for allow/warn (warnings on stderr), 2 for deny — the exit code the Claude Code-convention harnesses (Claude Code, Codex CLI, Gemini CLI, Crush) all interpret as "block the pending action, stderr is the reason." In standalone use, `require_review` SHALL prompt for confirmation when a TTY is present and fail closed (deny) when none is. A gate that cannot fire SHALL fail closed rather than wave a call through: `guard check` SHALL answer deny for a store it cannot open AND for a store holding no enabled policies, since the store is created by `init` or by any capture hook, so an empty policy set is indistinguishable from a check pointed at the wrong directory. `--allow-empty` SHALL opt out when an empty policy set is deliberate.

#### Scenario: Deny blocks before execution

- **WHEN** a proposed `tool_call` step named `delete_user` is piped to `guard check` and a matching deny policy exists
- **THEN** the command exits 2 with the policy name and reason, before the tool ever runs

#### Scenario: Warn does not block

- **WHEN** a proposed step matches only a `warn` policy
- **THEN** the command exits 0 and the warning is written to stderr

#### Scenario: Review without a TTY fails closed

- **WHEN** a step matches a `require_review` policy in a non-interactive context
- **THEN** the verdict is deny (exit 2) with a reason indicating review is required

### Requirement: Hook enforcement mode

The system SHALL support `--enforce` on the hook adapter for pre-tool events (`PreToolUse` in Claude Code and Codex CLI, `BeforeTool` in Gemini CLI), evaluating the proposed tool call from the hook payload and answering in the dialect the calling harness documents: for Claude Code and Codex CLI, structured stdout JSON `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny" | "ask", "permissionDecisionReason": "..."}}`, where policy action `deny` maps to `"deny"` and `require_review` maps to `"ask"` (deferring to the harness's own permission prompt); for Gemini CLI, `{"decision": "deny", "reason": "..."}` (its hooks support allow/deny only, so `require_review` maps to deny with the reason stating review is required); exit code 2 with the reason on stderr SHALL be the answer for `--dialect other`, the explicit choice for a harness with no structured hook output (e.g. Crush) — it is not reached by auto-detection, which falls back to the Claude Code shape. Enforcement SHALL never CREATE the policy store: a gating event with no store is a deny, since a store conjured on the spot holds no policies and would allow everything. A tool call the adapter cannot evaluate SHALL also be a deny under `--enforce`: a payload that does not parse, and one carrying no usable `tool_name` (which makes every name-keyed policy unable to match). A store that EXISTS but holds no enabled policy SHALL likewise be a deny, with `--allow-empty` to opt out — the documented setup registers plain capture hooks alongside a single `--enforce` hook, and capture mode creates the store and fires first, so the missing-store rule alone left an empty policy set reachable. Without `--enforce`, hook invocations SHALL remain capture-only and never block.

#### Scenario: Claude Code tool call denied via structured output

- **WHEN** Claude Code invokes the PreToolUse hook in enforce mode for a tool call matching a deny policy
- **THEN** the adapter exits 0 with `permissionDecision: "deny"` and the policy reason on stdout, Claude Code blocks the call and feeds the reason to the model, and the attempt is recorded in the session's trace

#### Scenario: require_review defers to the harness prompt

- **WHEN** a Codex CLI PreToolUse payload matches a `require_review` policy in enforce mode
- **THEN** the adapter answers `permissionDecision: "ask"`, causing Codex's own approval prompt to appear instead of a hard block

#### Scenario: Gemini BeforeTool denied

- **WHEN** a Gemini CLI BeforeTool payload matches a deny policy in enforce mode
- **THEN** the adapter responds `{"decision": "deny", "reason": ...}` and the tool call is not executed

### Requirement: Enforcement recording

The system SHALL record every enforcement evaluation that matches a policy as a `guard_check` step in the corresponding trace, including the policy, action taken, and reason, linked causally to the step that was checked, so blocked attempts are visible in `show` and `why`.

#### Scenario: Blocked attempt visible in the trace

- **WHEN** an agent's tool call is denied in enforce mode
- **THEN** the trace contains the attempted `tool_call` and a `guard_check` step recording the deny and its reason

### Requirement: Enforcement scope disclosure

The system SHALL document, in command help and README, that hook-level enforcement is a guardrail rather than a complete security boundary — the harness vendors state this themselves (OpenAI Codex docs: PreToolUse "is still a guardrail rather than a complete enforcement boundary because Codex can often perform equivalent work through another supported tool path") — and that OS-level sandboxing (Claude Code sandbox, Codex `sandbox_mode`, Gemini CLI sandbox) is the appropriate layer for hard isolation.

#### Scenario: Scope stated in help

- **WHEN** a user runs `agent-replay guard check --help`
- **THEN** the output states the guardrail-not-boundary limitation and points to harness sandboxing for hard isolation

