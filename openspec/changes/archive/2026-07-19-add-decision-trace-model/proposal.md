# Add Decision Trace Model

## Why

Steps are currently a flat, ordered list. That answers *what* an agent did, but not *why*: there is no record of which alternatives a decision considered, no parent/child structure for subagents or nested tool calls, no causal link from an action back to the decision that triggered it, and no way to group the multiple traces of one user session. Understanding the full trace of decisions requires the data model to carry that structure.

## What Changes

- Schema v2 migration adding to steps: `parent_step_number` (hierarchy for subagents/nested calls) and `caused_by_step_number` (causal link to the step that triggered this one)
- New `agent_trace_decisions` table: per decision step, the options considered (with rationale/score), the chosen option, the rationale, a confidence value, and a `decided_by` attribution (agent/user/policy — real harnesses record all three: model choices, permission-prompt answers, policy verdicts)
- New `session_id` column on traces to group multiple traces belonging to one harness session/conversation (the `session_id` UUID that Claude Code and Codex CLI deliver in every hook payload; Gemini CLI's `session.id`)
- Ingest format extended with optional `parent_step`, `caused_by_step`, `decision` block, and `session_id` (fully backward compatible — all new fields optional)
- New commands: `agent-replay why <trace-id> --step N` (walk the causal chain back to the root, showing decision rationale along the way) and `agent-replay decisions <trace-id>` (list all decision points)
- `show --tree` renders the step hierarchy; `list --session <id>` filters by session

## Impact

- Affected specs: `trace-capture` (modified), `trace-inspection` (added), new capability `decision-tracing`
- Affected code: `src/db/schema.ts`, `src/db/migrations.ts` (first real v1→v2 migration), `src/models/*`, `src/utils/validators.ts`, `src/services/trace-service.ts`, new `src/services/decision-service.ts`, `src/commands/show.ts`, `src/commands/list.ts`, new `src/commands/why.ts` and `src/commands/decisions.ts`, `src/cli.ts`
- This change is the foundation for `add-live-trace-capture`, `add-otel-ingest`, and `add-runtime-harness`; land it first
