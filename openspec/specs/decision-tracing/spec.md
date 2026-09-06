# decision-tracing Specification

## Purpose
Steps are currently a flat, ordered list. That answers *what* an agent did, but not *why*: there is no record of which alternatives a decision considered, no parent/child structure for subagents or nested tool calls, no causal link from an action back to the decision that triggered it, and no way to group the multiple traces of one user session. Understanding the full trace of decisions requires the data model to carry that structure.
## Requirements
### Requirement: Hierarchical steps

The system SHALL support an optional `parent_step` (step number) on every step, forming a tree of steps within a trace to represent subagents and nested executions. A parent reference MUST point to an existing, earlier step in the same trace. This mirrors how real harnesses report nesting: Claude Code and Codex CLI emit `SubagentStart`/`SubagentStop` hook events (with `agent_id` and, in Claude Code, a `depth` field for trees up to 5 levels deep), and the parent session's `PreToolUse`/`PostToolUse` hooks fire for subagent tool calls — so subagent activity arrives as steps of the parent trace and needs a nesting anchor. Harness identifiers such as `agent_id` and `agent_type` are carried in step `metadata`.

#### Scenario: Subagent steps nested under a spawn step

- **WHEN** a trace is ingested where step 3 records a subagent spawn and steps 4–6 declare `parent_step: 3`
- **THEN** steps 4–6 are stored as children of step 3 and render nested under it in tree views

#### Scenario: Invalid parent reference rejected

- **WHEN** a step declares `parent_step: 9` but the trace has no step 9 earlier than it
- **THEN** ingestion fails (exit `1`) with a validation error naming the offending step, and reporting both faults where both apply: that the reference is not earlier, and that no such step exists

### Requirement: Causal links

The system SHALL support an optional `caused_by_step` (step number) on every step, recording which earlier step triggered it. References MUST be strictly earlier than the referencing step, making causal chains acyclic.

#### Scenario: Tool call caused by a decision

- **WHEN** step 5 (`tool_call`) declares `caused_by_step: 4` where step 4 is a `decision`
- **THEN** the link is stored and step 5's causal antecedent resolves to step 4

### Requirement: Decision records

The system SHALL store, for a step of ANY type, an optional structured decision record: the options considered (each with optional rationale and score), the chosen option, an overall rationale, a confidence value between 0 and 1, and a `decided_by` attribution (`agent`, `user`, or `policy`) so that model choices, human approvals, and policy-engine verdicts are distinguishable — matching how real harnesses attribute decisions (e.g., Gemini CLI records tool-call decisions as `accept`/`reject`/`modify`/`auto_accept`; Claude Code permission decisions are `allow`/`deny`/`ask`). A decision record SHALL be accepted on a step of any type — the live recorder attaches one to whatever step made the choice, and `decisions`, `why` and `diff` all read it wherever it hangs.

#### Scenario: Decision with alternatives

- **WHEN** a decision step includes `{"options": [{"option": "search_flights"}, {"option": "ask_user"}], "chosen": "search_flights", "rationale": "destination is unambiguous", "confidence": 0.9, "decided_by": "agent"}`
- **THEN** the record is persisted and shown when the trace's decisions are inspected

#### Scenario: Human approval recorded as a decision

- **WHEN** a harness reports that the user approved a tool call at a permission prompt
- **THEN** it can be stored as a decision step with `decided_by: "user"` and `chosen: "allow"`

#### Scenario: Decision record on a tool call accepted

- **WHEN** a `tool_call` step carries a `decision` block
- **THEN** it is stored and listed by `decisions` like any other, since the step that made the choice is often the one that acted on it

### Requirement: Session grouping

The system SHALL support an optional `session_id` on traces so that multiple traces from one harness session or conversation can be grouped, and SHALL filter listings by it via `list --session <id>`. The key is an opaque external correlation ID — e.g., Claude Code's and Codex CLI's `session_id` (a UUID delivered in every hook payload), Gemini CLI's `session.id` telemetry attribute, or an application conversation ID. Note that Claude Code subagents carry their own `session_id` distinct from the parent session's; grouping subagent activity therefore relies on step hierarchy or `parent_trace_id`, not on session equality.

#### Scenario: List traces in a session

- **WHEN** three traces share `session_id: "d4c9…-uuid"` and a user runs `agent-replay list --session d4c9`
- **THEN** exactly those three traces are listed (prefix matching applies)

### Requirement: Causal chain inspection

The system SHALL provide `agent-replay why <trace-id> --step N`, walking the causal chain backward from step N (following `caused_by_step`, falling back to `parent_step`, then to the nearest earlier decision step) and printing each hop; decision hops SHALL include the chosen option and rationale. `--json` SHALL emit the chain as structured data.

Each hop SHALL name HOW it was reached — `caused_by`, `parent`, `prior_decision`, or `origin` for the step asked about — so a chain assembled from a fallback is not presented as a recorded causal link. `why` SHALL refuse a step number the trace does not have, at exit `1`, naming the step and how many the trace has.

#### Scenario: Explain a failing step

- **WHEN** a user runs `agent-replay why <id> --step 7` and step 7 was caused by decision step 4
- **THEN** the output shows the chain 7 ← 4 ← … back to the root, with step 4's chosen option and rationale inline

### Requirement: Decision listing

The system SHALL provide `agent-replay decisions <trace-id>` listing every decision step with its options, chosen option, confidence, and rationale, with `--json` output.

A trace with no decision steps is not an error: `decisions` SHALL say so and exit `0`.

#### Scenario: List decision points

- **WHEN** a trace contains two decision steps with records
- **THEN** `agent-replay decisions <id>` prints both, in step order

