# Tasks — add-decision-trace-model

## 1. Schema & migration

- [x] 1.1 Add v2 DDL: `parent_step_number`, `caused_by_step_number` on `agent_trace_steps`; `session_id` + index on `agent_traces`; `agent_trace_decisions` table
- [x] 1.2 Implement v1→v2 migration in `src/db/migrations.ts`; bump `SCHEMA_VERSION` to 2
- [x] 1.3 Test: opening a v1 database migrates it and preserves all existing rows

## 2. Models & validation

- [x] 2.1 Extend `TraceStep`, `IngestStepInput`, `Trace`, `IngestTraceInput` with the new optional fields; add `DecisionRecord` type
- [x] 2.2 Validators: reject `parent_step`/`caused_by_step` referencing missing or later step numbers; reject `decision` blocks on non-decision steps; clamp/validate `confidence` to [0, 1]; restrict `decided_by` to `agent|user|policy`
- [x] 2.3 Test: valid and invalid reference/decision payloads

## 3. Ingest & fork

- [x] 3.1 Persist new fields and decision records on ingest; default all to NULL when absent
- [x] 3.2 Fork copies preserve step-number references and decision records for copied steps
- [x] 3.3 Test: round-trip ingest → show → export retains hierarchy, causality, decisions, session

## 4. Services

- [x] 4.1 `decision-service.ts`: list decisions for a trace; causal-walk from a step (caused_by → parent → previous decision fallback)
- [x] 4.2 `trace-service.ts`: session filter in `listTraces`
- [x] 4.3 Test: causal walk on a branching demo trace terminates and orders hops correctly

## 5. Commands & UI

- [x] 5.1 `agent-replay why <trace-id> --step N` with `--json`
- [x] 5.2 `agent-replay decisions <trace-id>` with `--json`
- [x] 5.3 `show --tree` hierarchical step rendering; `list --session <id>` filter
- [x] 5.4 Update a demo scenario to include hierarchy + a decision record so `demo` showcases the model

## 6. Docs

- [x] 6.1 README: trace format additions, new commands, migration note
- [x] 6.2 `npm run verify` passes
