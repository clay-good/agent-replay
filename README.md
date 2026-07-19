# agent-replay

**Time-travel debugging for AI agents.**

When your AI agent hallucinates, calls the wrong tool, or breaks in production — and you're stuck reading thousands of lines of logs trying to figure out what went wrong — this tool fixes that.

## The Problems This Solves

**1. "Why did my agent fail?"**
You deploy an AI agent. It works Monday. Tuesday it hallucinates, makes up a company policy, and tells a customer something completely wrong. Your only debugging option is reading raw JSON logs. `agent-replay` records every step of every agent run — every thought, tool call, retrieval, and output — so you can replay exactly what happened, step by step, like rewinding a tape.

**2. "It worked before, what changed?"**
You push a new prompt or swap a model and suddenly your agent breaks on cases that used to work. `agent-replay diff` puts two runs side-by-side and shows you exactly where they diverged — which step went different, what changed in the context, where things went wrong.

**3. "How do I test a fix without rerunning everything?"**
You think you know what went wrong but you don't want to burn API credits and time reproducing the exact scenario. `agent-replay fork` lets you take any recorded run, rewind to any step, change the input, and see what would have happened differently.

**4. "How do I know if my agent is actually good?"**
You have no systematic way to evaluate agent quality. `agent-replay eval` runs automatic checks — hallucination detection, safety audits, completeness checks — using both deterministic rules and AI-powered analysis. Bring your own API key (Anthropic, Google, or OpenAI) and get root-cause analysis, quality scoring, security audits, and optimization suggestions for pennies per trace.

**5. "How do I stop my agent from doing dangerous things?"**
Your agent has access to tools that can delete data, send emails, or make purchases. `agent-replay guard` lets you define kill-switch policies that flag or block dangerous patterns — like blocking any `delete` tool calls, or warning when token usage spikes.

**6. "How do I build regression tests for a non-deterministic system?"**
Every time you fix a bug, it might break something else. `agent-replay export --format golden` builds golden datasets from known-good runs that you can test against on every deploy.

## What It Is

A CLI tool that stores agent execution traces in a local SQLite database and gives you tools to debug, evaluate, compare, and protect your AI agents.

- 100% local. Single SQLite file. No cloud dependency.
- Works with any agent framework — just export your traces as JSON.
- AI-powered evaluation using your own API key (Anthropic, Google, or OpenAI). Uses the cheapest models by default.

## Quick Start

```bash
npm install -g agent-replay

agent-replay init                  # creates .agent-replay/ with SQLite database
agent-replay demo                  # loads 5 sample traces + 3 guardrail policies
agent-replay list                  # see everything
agent-replay show <trace-id>       # inspect a trace step-by-step
agent-replay replay <trace-id>     # animated terminal replay
```

Requires **Node.js 18+**.

## Commands

### Record

```bash
# Ingest a trace from a JSON file
agent-replay ingest trace.json

# JSONL file (one trace per line)
agent-replay ingest traces.jsonl --format jsonl

# Tag traces during ingest
agent-replay ingest trace.json --tags production,v2

# Validate without inserting
agent-replay ingest trace.json --dry-run
```

#### Live capture

`ingest` loads a complete trace after the fact. To capture a run **as it happens**, stream newline-delimited capture events into `record` — the trace grows step by step and stays `running` until a `trace_end` event arrives.

```bash
# Pipe a JSONL event stream into the recorder
my-agent --emit-events | agent-replay record --tags production

# Keep the trace open (don't finalize as timeout) when the stream ends
my-agent --emit-events | agent-replay record --leave-open
```

`record` also speaks the major CLIs' own non-interactive streams directly, so you can pipe them in without instrumentation:

```bash
codex exec --json "fix the failing tests"      | agent-replay record --format codex-exec
gemini -p "summarize" --output-format stream-json | agent-replay record --format gemini-stream
```

For the native protocol, each event is one JSON object on its own line carrying `v: 1`, a `type`, and (except `trace_start`) the `trace_id` the producer generated:

| Event | Purpose |
|-------|---------|
| `trace_start` | Open a trace (`agent_name` required; optional `trace_id`, `session_id`, `input`, `tags`) |
| `step_start` / `step_end` | Open a step, then close it with output/error/timing/tokens |
| `step` | A complete step in one event (may include a `decision` and `snapshot`) |
| `decision` | Attach a decision record to a `decision` step |
| `snapshot` | Freeze context/environment/tool state at a step |
| `trace_end` | Finalize the trace (`status`, `output`, token/cost totals) |

Unknown event types and fields are skipped with a warning, never a crash — a newer producer stays compatible. A trace left open when the stream ends is finalized as `timeout` unless `--leave-open`.

#### OpenTelemetry ingest

Many agent stacks already emit OpenTelemetry with the GenAI semantic conventions (`gen_ai.*`) — Gemini CLI, Claude Code, OpenHands, Goose, AutoGen, and most Python frameworks via OpenInference/OpenLLMetry. Run a local OTLP receiver and point them at it, no per-framework adapter needed:

```bash
agent-replay otel serve --port 4318
```

It accepts `POST /v1/traces` and `POST /v1/logs` in OTLP/JSON. Spans map onto the trace model: `invoke_agent`/`invoke_workflow` roots become traces (`gen_ai.agent.name` → agent, `gen_ai.conversation.id` → session), `execute_tool` → `tool_call`, `chat`/`generate_content`/`text_completion` → `llm_call`, `embeddings`/`retrieval` → `retrieval`, span parentage → step hierarchy, and `gen_ai.usage.*` → token totals. Deprecated attribute forms (`gen_ai.system`, `prompt_tokens`/`completion_tokens`) are normalized, and OpenInference's `openinference.span.kind` is accepted when GenAI attributes are absent. Spans without an agent root are grouped into a synthetic trace per OTel trace ID.

Log events from the two CLIs that emit richer signal as logs are mapped too: Gemini CLI (`gemini_cli.user_prompt`, `gemini_cli.tool_call` — including its `decision` as a decision record attributed to user or policy, `gemini_cli.api_response` tokens) and Claude Code (`claude_code.*`), correlated by `session.id`.

Point an exporter at it over HTTP/JSON — e.g. Gemini CLI `telemetry: { enabled: true, target: "local", otlpEndpoint: "http://localhost:4318", otlpProtocol: "http" }`. Most emitters default to gRPC on port 4317, so switch them to HTTP.

> This build ingests OTLP/JSON. Protobuf encoding and the OpenLLMetry (`traceloop.*`) dialect are not yet wired up.

#### Hook capture

`agent-replay hook` plugs into the stdin-JSON hook convention shared by Claude Code, OpenAI Codex CLI, and Gemini CLI. It's stateless — each invocation correlates to a trace by the payload's `session_id` — and auto-detects the dialect, so no flag is needed. Capture is side-effect-only: it always exits 0 and writes nothing to stdout (in these harnesses exit 2 blocks the agent and stdout is read as a hook decision), so it can never interfere with a run. Add `--no-input` to drop prompt text and tool inputs on shared machines.

**Claude Code** — `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "PreToolUse":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }]
  }
}
```

**Codex CLI** — `~/.codex/config.toml` (then trust the hooks via `/hooks`; requires a Codex build with hook support):

```toml
[[hooks.PreToolUse]]
command = "agent-replay hook"
[[hooks.PostToolUse]]
command = "agent-replay hook"
[[hooks.Stop]]
command = "agent-replay hook"
```

**Gemini CLI** (v0.26.0+) — `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "AfterTool":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }]
  }
}
```

Then watch a live session with [`agent-replay watch`](#explain-decisions).

#### Import existing session logs

To pull in history that already exists on disk, `import` converts a Claude Code transcript or a Codex CLI rollout into a trace. It's best-effort: unrecognized records are skipped and counted (both vendor formats are internal and version-unstable), and the source format/version is stamped in the trace metadata.

```bash
agent-replay import ~/.claude/projects/my-project/<session-uuid>.jsonl --format claude-transcript
agent-replay import ~/.codex/sessions/2026/07/02/rollout-abc.jsonl      --format codex-rollout
```

For Claude Code, `tool_use`/`tool_result` blocks become paired `tool_call` steps, `thinking` blocks become `thought` steps, and `usage` counts aggregate into token totals. For Codex, `session_meta` supplies identity and git metadata, `function_call`/`function_call_output` pairs (by `call_id`) become `tool_call` steps, and `reasoning` becomes `thought` steps.

#### Enforcement (block dangerous tool calls live)

Add `--enforce` to the hook to evaluate each proposed tool call against your [guardrail policies](#guardrails) before it runs, and block denied calls in the harness's own dialect — no extra wiring beyond the same hook registration on the pre-tool event:

- **Claude Code / Codex CLI**: emits `{"hookSpecificOutput": {"permissionDecision": "deny" | "ask", ...}}` — `deny` policies block, `require_review` policies defer to the harness's own approval prompt (`"ask"`).
- **Gemini CLI**: emits `{"decision": "deny", "reason": ...}` (its hooks are allow/deny only, so `require_review` denies with a "review required" reason).
- **Crush / others without structured output**: exits 2 with the reason on stderr.

`warn` policies never block — they surface a message and allow the call. Every enforcement decision that matches a policy is recorded as a `guard_check` step in the session's trace, linked to the attempted `tool_call`, so blocked attempts show up in [`show`](#inspect) and [`why`](#explain-decisions).

You can also evaluate a single step out of band:

```bash
echo '{"step_type":"tool_call","name":"delete_user"}' | agent-replay guard check   # exit 2 if denied
```

> **Guardrail, not a boundary.** Hook-level enforcement is a guardrail, not a complete security boundary — the harness vendors say so themselves (a determined agent can often reach equivalent effects through another tool path). For hard isolation, use OS-level sandboxing: Claude Code's sandbox, Codex `sandbox_mode`, or Gemini CLI's sandbox.

### Browse

```bash
# List all traces
agent-replay list

# Filter by status, agent, tag, or time
agent-replay list --status failed
agent-replay list --agent travel-bot --since 7d
agent-replay list --tag production --sort tokens --limit 10

# JSON output for piping
agent-replay list --json
```

### Inspect

```bash
# Full detail view with step timeline
agent-replay show <trace-id>

# Just the steps
agent-replay show <trace-id> --steps-only

# Include eval results and state snapshots
agent-replay show <trace-id> --evals --snapshots

# Render steps as a hierarchy (subagents/nested calls) with causal links
agent-replay show <trace-id> --tree
```

Trace IDs support prefix matching — just type the first few characters.

### Explain decisions

When a trace records *why* it acted — decision alternatives, causal links between steps, and step hierarchy — you can inspect that structure directly.

```bash
# Walk the causal chain backward from a step to the decision that triggered it
agent-replay why <trace-id> --step 9

# List every decision point with its options, chosen option, and rationale
agent-replay decisions <trace-id>

# Group traces from one harness session/conversation
agent-replay list --session <session-id>
```

`why` follows each step's `caused_by_step`, falling back to `parent_step` and then to the nearest earlier decision, printing the chosen option and rationale at each decision hop. Both commands accept `--json`.

### Replay

```bash
# Animated step-by-step replay (default 5x speed)
agent-replay replay <trace-id>

# Faster, slower, or instant
agent-replay replay <trace-id> --speed 10
agent-replay replay <trace-id> --speed 0

# Replay only steps 3 through 7
agent-replay replay <trace-id> --from-step 3 --to-step 7
```

### Compare

```bash
# Side-by-side diff of two traces
agent-replay diff <trace-a> <trace-b>

# Summary only
agent-replay diff <a> <b> --compact

# AI-powered analysis of why the traces diverged
agent-replay diff <a> <b> --ai
```

### Fork

```bash
# Fork a trace at step 3
agent-replay fork <trace-id> --from-step 3

# Fork with modified input
agent-replay fork <trace-id> --from-step 2 --modify-input '{"task":"revised prompt"}'

# Tag the fork
agent-replay fork <trace-id> --from-step 4 --tag experiment-1
```

### Run under supervision

Wrap any agent command to record it end-to-end and propagate its exit status — useful as a one-line harness around a run:

```bash
agent-replay run --agent-name my-bot -- node agent.js
```

The wrapper pre-creates a trace and hands the child a recording channel via environment variables (`AGENT_REPLAY_DIR`, `AGENT_REPLAY_TRACE_ID`, `AGENT_REPLAY_EVENTS`). An instrumented child (using the [`TraceRecorder` SDK](#programmatic-api) or writing JSONL events to `$AGENT_REPLAY_EVENTS`) records a full step-by-step trace; an uninstrumented child still gets a trace with timing and exit metadata. The child's stdio passes through untouched, and the trace is finalized from its exit — `0` → completed, non-zero → failed with the code recorded. `agent-replay run` exits with the child's own status, so it drops cleanly into scripts and CI.

### Regression check (CI)

Turn known-good runs into a regression gate. Export a golden dataset once, then `check` new runs against it — the comparison is structural (step count, step types and names, tool-call inputs, final status) rather than raw output text, so non-deterministic wording never causes false failures. It exits non-zero on any regression, ready for CI.

```bash
# Capture a golden dataset from passing runs
agent-replay export --format golden --tag known-good --output golden.json

# Fail the build if recent runs diverge from golden
agent-replay check --golden golden.json --agent travel-bot --since 1d

# Narrow the comparison, or treat unmatched runs as failures
agent-replay check --golden golden.json --fields step_types,tool_inputs
agent-replay check --golden golden.json --strict --json
```

Matches are made by agent name and a hash of the input, so each run is compared to its own golden counterpart. A divergence report names the trace, the step, and the differing field.

### Evaluate

```bash
# Run all built-in deterministic checks
agent-replay eval <trace-id>

# Run a specific preset
agent-replay eval <trace-id> --preset hallucination-check
agent-replay eval <trace-id> --preset safety-check
agent-replay eval <trace-id> --preset completeness-check

# Run AI-powered evaluation (requires API key)
agent-replay eval <trace-id> --ai
agent-replay eval <trace-id> --preset ai-root-cause
agent-replay eval <trace-id> --preset ai-quality-review
agent-replay eval <trace-id> --preset ai-security-audit
agent-replay eval <trace-id> --preset ai-optimization

# Set a cost budget for AI evals
agent-replay eval <trace-id> --ai --max-cost 0.05

# Custom rubric file
agent-replay eval <trace-id> --rubric my-rubric.yaml

# JSON output
agent-replay eval <trace-id> --json
```

### Guardrails

```bash
# List all policies
agent-replay guard list

# Add a policy that blocks delete operations
agent-replay guard add --name no-deletes \
  --pattern '{"step_type":"tool_call","name_contains":"delete"}' \
  --action deny

# Test all policies against a trace
agent-replay guard test <trace-id>

# Remove a policy
agent-replay guard remove <policy-id>
```

### Export

```bash
# Export as JSON
agent-replay export --format json --output traces.json

# Export completed traces as JSONL
agent-replay export --format jsonl --status completed --output good.jsonl

# Build a golden dataset for regression testing
agent-replay export --format golden --tag production --output golden.json
```

### Dashboard

```bash
# Full-screen terminal dashboard with charts and stats
agent-replay dashboard

# Custom refresh interval
agent-replay dashboard --refresh 10
```

Keyboard: `q` quit, `r` refresh, arrow keys navigate.

### Configuration

```bash
# Show current config
agent-replay config list

# Set an API key for AI-powered evaluation
agent-replay config set ai.api_keys.anthropic sk-ant-...
agent-replay config set ai.api_keys.google AIza...
agent-replay config set ai.api_keys.openai sk-...

# Choose a specific provider instead of auto-detect
agent-replay config set ai.provider anthropic

# Test that your API key works
agent-replay config test-ai

# Read a config value
agent-replay config get ai.provider
```

You can also set API keys via environment variables: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`. Environment variables take priority over config file values.

## Evaluation Presets

### Deterministic Presets

These run instantly with no API key required.

**hallucination-check** — Detects hallucination indicators:
- Flags excessive hedging language (30%)
- Checks if output is grounded in retrieval content (40%)
- Verifies no error steps present (30%)
- Threshold: 0.7

**safety-check** — Detects safety concerns:
- Flags dangerous tool calls like delete/drop/destroy (40%)
- Checks for PII in output (SSN, credit card, email patterns) (30%)
- Detects prompt injection patterns (30%)
- Threshold: 0.8

**completeness-check** — Validates execution completeness:
- Ensures at least one output step exists (40%)
- Verifies all tool calls have output (30%)
- Checks trace doesn't end with an error (30%)
- Threshold: 0.7

### AI-Powered Presets

These require an API key. They use the cheapest models by default (Haiku 4.5, Gemini 2.0 Flash, or GPT-4o-mini) and typically cost less than $0.01 per evaluation.

**ai-root-cause** — For failed traces. Identifies what went wrong, which step caused it, contributing factors, and suggests a fix. Returns a confidence score.

**ai-quality-review** — Scores any trace on four dimensions: relevance, completeness, coherence, and accuracy (each 1-10). Returns an overall quality score.

**ai-security-audit** — Checks for prompt injection, data exfiltration, unauthorized access patterns, and privilege escalation. Returns a risk level (none/low/medium/high/critical) and specific findings.

**ai-optimization** — Analyzes token efficiency and identifies redundant steps, unnecessary tool calls, and wasted context. Returns an efficiency score and specific optimization suggestions.

### Custom Rubrics

Create a YAML or JSON file with pattern-based criteria:

```yaml
name: my-custom-check
threshold: 0.8
criteria:
  - name: has_greeting
    pattern: "hello|hi|welcome"
    expected: true
    weight: 1
  - name: no_profanity
    pattern: "badword1|badword2"
    expected: false
    weight: 2
```

```bash
agent-replay eval <trace-id> --rubric my-rubric.yaml
```

## Trace Format

To ingest your agent's execution data, export it as JSON matching this structure:

```json
{
  "agent_name": "my-agent",
  "agent_version": "1.0.0",
  "trigger": "user_message",
  "status": "completed",
  "input": { "task": "book a flight to Tokyo" },
  "output": { "result": "Flight booked: AA 1234" },
  "started_at": "2026-02-27T10:00:00.000Z",
  "ended_at": "2026-02-27T10:00:03.200Z",
  "total_duration_ms": 3200,
  "total_tokens": 4500,
  "total_cost_usd": 0.018,
  "error": null,
  "tags": ["production"],
  "steps": [
    {
      "step_number": 1,
      "step_type": "thought",
      "name": "analyze_request",
      "input": { "message": "book a flight to Tokyo" },
      "output": { "intent": "flight_booking" },
      "duration_ms": 120,
      "tokens_used": 400
    },
    {
      "step_number": 2,
      "step_type": "tool_call",
      "name": "search_flights",
      "input": { "destination": "TYO" },
      "output": { "flights": ["AA 1234", "UA 5678"] },
      "duration_ms": 800,
      "tokens_used": 200
    }
  ]
}
```

Only `agent_name` is required. Everything else is optional.

### Decision & structure fields

Traces and steps carry optional fields that record *why* an agent acted, not just *what* it did. All are backward compatible — omit them and a flat trace remains fully valid.

| Field | On | Meaning |
|-------|----|---------|
| `session_id` | trace | Correlation key grouping traces from one harness session/conversation (e.g. a Claude Code / Codex `session_id`, a Gemini `session.id`, or an app conversation ID) |
| `parent_step` | step | Step number of the parent — nests subagents and nested calls into a tree. Must reference an earlier step |
| `caused_by_step` | step | Step number that triggered this step. Must reference a strictly earlier step (chains are acyclic) |
| `decision` | step | Structured decision record, valid only on `decision` steps (see below) |

A `decision` block:

```json
{
  "step_number": 4,
  "step_type": "decision",
  "name": "rank_options",
  "caused_by_step": 3,
  "decision": {
    "options": [
      { "option": "fl_1", "rationale": "nonstop, lowest price", "score": 0.92 },
      { "option": "fl_2", "rationale": "nonstop but pricier", "score": 0.74 }
    ],
    "chosen": "fl_1",
    "rationale": "Nonstop matches the user preference; lowest price among nonstops.",
    "confidence": 0.92,
    "decided_by": "agent"
  }
}
```

`decided_by` is one of `agent` (the model chose), `user` (a human at a permission prompt), or `policy` (a policy engine). `confidence` is between 0 and 1. Inspect these with [`show --tree`](#inspect), [`why`, and `decisions`](#explain-decisions).

> **Schema migration:** these fields arrived in schema v2. Databases created by earlier versions upgrade automatically the next time they are opened — every existing row is preserved with the new fields defaulting to null. The upgrade is one-way (there is no down-migration).

### Step Types

| Type | Description |
|------|-------------|
| `thought` | Agent reasoning or planning |
| `tool_call` | External tool invocation |
| `llm_call` | LLM API call |
| `retrieval` | RAG / document retrieval |
| `output` | Response delivery |
| `decision` | Decision point |
| `error` | Error occurred |
| `guard_check` | Guardrail policy check |

## Guardrail Policies

Policies match against trace steps and trigger actions.

### Match Pattern

```json
{
  "step_type": "tool_call",
  "name_contains": "delete",
  "name_regex": "drop|destroy",
  "input_contains": "production",
  "output_contains": "error"
}
```

All fields are optional. When multiple fields are specified, all must match (AND logic). `name_contains` does a case-insensitive substring match; `name_regex` uses a regular expression.

### Actions

| Action | Description |
|--------|-------------|
| `allow` | Explicitly allow matching steps |
| `deny` | Block matching steps |
| `warn` | Flag for review |
| `require_review` | Require human review before proceeding |

## AI Provider Setup

`agent-replay` auto-detects your API key in this priority order:

1. **Anthropic** (default model: `claude-haiku-4-5-20251001`)
2. **Google Gemini** (default model: `gemini-2.0-flash`)
3. **OpenAI** (default model: `gpt-4o-mini`)

Set a key via environment variable or config:

```bash
# Environment variable (recommended)
export ANTHROPIC_API_KEY=sk-ant-...

# Or store in config
agent-replay config set ai.api_keys.anthropic sk-ant-...

# Verify it works
agent-replay config test-ai
```

All AI presets use the cheapest available model. A typical evaluation costs less than $0.01.

## Programmatic API

You can also use `agent-replay` as a library:

```typescript
import { openDatabase, createTrace, getTraceById } from 'agent-replay';

const db = openDatabase('.agent-replay/traces.db');
const trace = createTrace(db, { agent_name: 'my-agent', status: 'completed' });
```

To record a run live from TypeScript, use the `TraceRecorder` SDK — the same incremental engine the `record` command uses, no files or subprocess required:

```typescript
import { ensureDatabase, TraceRecorder } from 'agent-replay';

const db = ensureDatabase('.agent-replay/traces.db');
const rec = new TraceRecorder(db);

rec.startTrace({ agent_name: 'my-agent', session_id: conversationId, input: { task } });
rec.startStep({ step_number: 1, step_type: 'tool_call', name: 'search' });
rec.endStep(1, { output: results, tokens_used: 120 });
rec.endTrace({ status: 'completed', output: answer, total_tokens: 120 });
```

## Development

```bash
git clone <repo-url>
cd agent-replay
npm install
npm run verify    # typecheck + build + test
npm run dev       # watch mode
```
