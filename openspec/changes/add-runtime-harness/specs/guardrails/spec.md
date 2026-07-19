# guardrails Delta

## ADDED Requirements

### Requirement: Real-time step evaluation

The system SHALL evaluate a single proposed step against all enabled policies via `agent-replay guard check` (step JSON on stdin), printing a JSON verdict (`action`, `policy`, `reason`) to stdout and answering by exit code: 0 for allow/warn (warnings on stderr), 2 for deny — the exit code the Claude Code-convention harnesses (Claude Code, Codex CLI, Gemini CLI, Crush) all interpret as "block the pending action, stderr is the reason." In standalone use, `require_review` SHALL prompt for confirmation when a TTY is present and fail closed (deny) when none is.

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

The system SHALL support `--enforce` on the hook adapter for pre-tool events (`PreToolUse` in Claude Code and Codex CLI, `BeforeTool` in Gemini CLI), evaluating the proposed tool call from the hook payload and answering in the dialect the calling harness documents: for Claude Code and Codex CLI, structured stdout JSON `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny" | "ask", "permissionDecisionReason": "..."}}`, where policy action `deny` maps to `"deny"` and `require_review` maps to `"ask"` (deferring to the harness's own permission prompt); for Gemini CLI, `{"decision": "deny", "reason": "..."}` (its hooks support allow/deny only, so `require_review` maps to deny with the reason stating review is required); exit code 2 with the reason on stderr SHALL be the fallback for dialects without structured output (e.g., Crush). Without `--enforce`, hook invocations SHALL remain capture-only and never block.

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
