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
```

Trace IDs support prefix matching — just type the first few characters.

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

## Development

```bash
git clone <repo-url>
cd agent-replay
npm install
npm run verify    # typecheck + build + test
npm run dev       # watch mode
```
