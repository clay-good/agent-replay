# Design — add-decision-trace-model

## Context

Schema is at version 1 with a migration framework (`schema_version` table) that has never run a real migration. Steps have a `UNIQUE(trace_id, step_number)` constraint, and forks copy steps into new traces, so cross-references must survive copying.

## Goals / Non-Goals

- Goals: represent hierarchy, causality, decision alternatives, and sessions; keep ingest backward compatible; keep everything queryable with plain SQL
- Non-Goals: live capture (next change), automatic causality inference, graph visualization beyond the terminal tree

## Decisions

### Reference steps by number, not row ID

`parent_step_number` and `caused_by_step_number` are step numbers within the same trace, not step row IDs. Step numbers are stable under fork-copying (row IDs are regenerated), match how users already address steps in the CLI (`--from-step`), and are what external producers can actually emit. Validation rejects references to step numbers that do not exist in the trace or that point forward in time (a step cannot be caused by a later step).

### Dedicated decisions table

Decision detail lives in `agent_trace_decisions` (`step_id`, `options` JSON array of `{option, rationale?, score?}`, `chosen`, `rationale`, `confidence` 0–1, `decided_by` in `agent|user|policy`) rather than in step `metadata`. A typed table makes `decisions` and `why` simple queries, keeps validation strict, and leaves `metadata` free-form. A decision record is only valid on a step of type `decision`. `decided_by` exists because real traces contain three distinct decision-makers — the model choosing an action, the human at a permission prompt (Claude Code `allow|deny|ask`, Gemini `accept|reject|modify|auto_accept`), and a policy engine — and conflating them makes `why` output misleading.

### Sessions as a column, not a table

`session_id TEXT` on `agent_traces` with an index. A session is an external correlation key we do not own: Claude Code and Codex CLI deliver `session_id` in every hook payload and name transcript/rollout files by it; Gemini CLI stamps `session.id` on all telemetry. One caveat verified against Claude Code docs: subagents get their *own* `session_id` (plus `agent_id` and `parent_session_id`), so session equality must not be treated as the subagent-grouping mechanism — hierarchy (`parent_step`) and `parent_trace_id` are.

### Causal walk semantics for `why`

Starting from step N: follow `caused_by_step_number` when present, else fall back to `parent_step_number`, else the previous decision-type step, until the chain reaches step 1 or a step with no antecedent. Each hop prints the step and, for decision steps, the chosen option and rationale. Cycles are impossible by validation (references must be strictly earlier).

## Risks / Trade-offs

- Step-number references are per-trace only — cross-trace causality (fork lineage) stays on the trace record. Accepted: that is what `parent_trace_id` already covers.
- Producers may not know causality; the model treats every new field as optional so a flat trace remains fully valid.

## Migration Plan

1. `SCHEMA_VERSION = 2`; migration adds the two step columns, the `session_id` column with index, and the decisions table
2. Existing rows get NULLs — every v1 trace remains valid and renderable
3. `migrations.ts` runs v1→v2 automatically on open; down-migration is not supported (documented)

## Open Questions

- None blocking. If per-option token/cost accounting is later needed, extend the `options` JSON shape.
