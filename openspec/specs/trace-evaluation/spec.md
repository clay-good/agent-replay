# trace-evaluation Specification

## Purpose

Score trace quality automatically: deterministic rubric presets, custom rubrics, and AI-powered judges (root cause, quality, security, optimization) with cost budgets.
## Requirements
### Requirement: Deterministic eval presets

The system SHALL provide built-in deterministic presets — `hallucination-check`, `safety-check`, `completeness-check` — runnable via `agent-replay eval <id> --preset <name>` or all at once with `--all`, each producing a weighted score, pass/fail against a threshold, and stored details. A criterion that had NOTHING to measure — no retrieval steps to ground an answer against, no tool calls to check — SHALL be recorded as not applicable and reported as such wherever the criteria are summarized. It scores 1.0 so that a trace which does not exercise it cannot fail on that account, and it therefore carries its full WEIGHT into a total presented as though everything was checked: a trace with no retrieval steps scored 100% on `hallucination-check`, 40% of whose weight is grounding, under the words "All criteria passed". When NO criterion could be measured, the summary SHALL say that instead.

#### Scenario: Run all deterministic checks

- **WHEN** a user runs `agent-replay eval <id> --all`
- **THEN** all three presets run without requiring an API key and results are persisted as eval records

#### Scenario: A criterion with nothing to check

- **WHEN** `hallucination-check` runs against a trace that has no retrieval steps
- **THEN** the grounding criterion is recorded as not applicable and the summary says how many criteria were skipped, rather than "All criteria passed"

### Requirement: Custom rubrics

The system SHALL evaluate traces against user-supplied YAML/JSON rubric files (`--rubric <file>`) containing pattern-based criteria with expected presence/absence, weights, and a pass threshold. Each criterion's `pattern` SHALL be a case-insensitive regular expression, and that SHALL be stated where the format is documented: a pattern written as a literal string silently means something else (`$5.00` cannot match the text `$5.00`), and the resulting verdict is a failure the run did not earn.

#### Scenario: Rubric evaluation

- **WHEN** a rubric with two weighted criteria is applied to a trace
- **THEN** the weighted score is computed and compared against the rubric threshold

### Requirement: AI-powered evaluation

The system SHALL provide AI presets (`ai-root-cause`, `ai-quality-review`, `ai-security-audit`, `ai-optimization`) using the configured provider's default cheap-tier model (currently `claude-haiku-4-5-20251001`, `gemini-2.5-flash-lite`, `gpt-5.4-nano` per provider), honoring a `--max-cost` budget in USD and failing gracefully when no key is configured.

A cost figure priced WITHOUT a published rate for the model SHALL say so. The rate table covers the three default models; any other model — which is every larger one a user would configure — is priced at the highest rate the build knows, and since all three defaults are cheap-tier that is a FLOOR, not a ceiling. Presented unqualified it read as the model's price, and `--max-cost` cleared runs that cost many times the cap. The `--max-cost` pre-gate SHALL name the unpriced model and warn that the limit may not hold, and a stored AI eval SHALL record that its cost came from the fallback, so a figure can still be interpreted later. Neither SHALL appear for a model whose rate is known.

#### Scenario: Cost budget exceeded

- **WHEN** an AI eval would exceed the `--max-cost` budget
- **THEN** the evaluation stops before the call and reports the budget constraint

#### Scenario: A budget priced off a model with no published rate

- **WHEN** `eval --ai --max-cost` runs with a configured model the rate table does not cover
- **THEN** the estimate is shown with a warning naming the model, saying the real cost may be higher and the budget limit may not hold

### Requirement: Eval result persistence

The system SHALL persist every evaluation as an eval record (evaluator type `rubric`, `llm_judge`, or `policy_check`; name; score; passed; details) attached to the trace and visible via `show --evals`.

#### Scenario: Results retrievable

- **WHEN** evaluations have run against a trace
- **THEN** `agent-replay show <id> --evals` lists each result with score and pass/fail

### Requirement: Golden regression check

The system SHALL compare traces against a golden dataset via `agent-replay check --golden <file>`, matching candidate traces to golden traces by agent name and input hash, diffing on a structural field allowlist (step count, step types, step names, tool-call inputs, per-step failure, final status) rather than raw output text, and exiting non-zero with a divergence report when any matched trace regresses. `--fields` SHALL override the allowlist and `--json` SHALL emit the report as structured data. A divergence row SHALL window its two values around the point where they first differ: tool-call payloads share a long prefix, so a cut from position 0 renders both sides identically and the gate's own failure line — the line an engineer reads when CI goes red — shows nothing. The comparison view and the AI summary already window for this reason. Candidates gathered in bulk SHALL exclude forked traces (a never-executed copy of a step prefix, which otherwise matches its own baseline and diverges on step count and status — reporting a regression that never happened) and traces still `running` (a partial shape is not a regression). A trace named explicitly with `--trace` SHALL still be compared, whatever its lineage or status.

`tool_inputs` SHALL compare tool-call arguments VERBATIM. That is the divergence a purely structural gate is blind to, and it is also why model-authored argument text (a rephrased search query) diverges — documentation of the gate SHALL say so rather than promising that non-determinism never fails a run, since the remedy is to name the other fields.

An AI evaluation whose trace summary omitted steps SHALL report how many of the trace's steps it was computed over, in the stored result and in the rendered panel. The summary is budgeted and tells the model what it dropped; a verdict presented to a reader as covering the run, when it covered part of one, is the same overstatement the gate's own refusals exist to prevent — and it matters most for the presets asked to weigh step counts and efficiency.

The gate SHALL refuse a store that is not there — at exit 2, creating nothing, naming the store it looked for and one found above the working directory — rather than opening with a call that creates it and then reporting "no traces matched", which describes a filter problem for what is a wrong-directory problem. `--allow-empty` SHALL NOT cover that case: it says an empty window is expected, not that the store is absent. The gate SHALL refuse rather than report a pass whenever it cannot actually compare: a field named on `--fields` that not every matched baseline can exercise (the refusal SHALL distinguish "no baseline records it", whose cure is a capture path that does, from "only some matched runs record it", whose cure is narrowing the run with `--agent` — naming the first when the second is true tells the reader something the golden file in front of them disproves), a baseline entry without a string `metadata.status`, an empty baseline, and a run in which no candidate matched (unless `--allow-empty`) are each a gate-broken refusal at exit 2, distinct from the exit 1 that means a regression. A trace whose input is empty SHALL NOT be matchable — an empty input is the absence of an identity, not an identity that every such trace shares — and an unmatchable baseline counts as unexercised. `--agent` SHALL match by substring and `--agent-exact` by exact name; they are mutually exclusive, and an empty value for either is a usage error rather than a silently widened scope.

`expected_output` and `eval_criteria` in a golden entry are carried for downstream consumers and human review; the gate SHALL NOT interpret them as assertions.

#### Scenario: Regression detected in CI

- **WHEN** `agent-replay check --golden golden.json --agent travel-bot --since 1d` finds a trace whose tool-call sequence differs from its golden counterpart
- **THEN** the command exits non-zero and names the trace, the divergence step, and the differing fields

#### Scenario: Clean run passes

- **WHEN** all matched traces are structurally equivalent to their golden counterparts
- **THEN** the command exits 0 with a pass summary

#### Scenario: No golden match

- **WHEN** a candidate trace has no golden counterpart by agent name and input hash
- **THEN** it is reported as unmatched (not failed) unless `--strict` is passed

#### Scenario: Nothing could be compared at all

- **WHEN** candidates were fetched but NONE of them matched a golden entry, and neither `--strict` nor `--trace` was passed
- **THEN** the command refuses with exit 2 rather than reporting a vacuous pass, since a run that compared nothing cannot detect a regression, and `--allow-empty` opts out

#### Scenario: A step begins failing

- **WHEN** a matched candidate records an error on a step its golden counterpart completed cleanly
- **THEN** the command reports a `step_errors` divergence and exits non-zero, even when every other structural field matches
- **AND** a step that stops failing is NOT reported, since a fix is not a regression

#### Scenario: A run that used to fail now succeeds

- **WHEN** a matched candidate ends `completed` while its golden counterpart recorded `failed`, `timeout` or `running`
- **THEN** no `status` divergence is reported, for the same reason `step_errors` is one-directional: a baseline that captured one flaky failure would otherwise report REGRESSED on every subsequent green run
- **AND** every other transition still diverges — `completed` to `failed` or `timeout`, and a change of failure mode such as `failed` to `timeout` — because only arriving at `completed` cannot be a regression

#### Scenario: The model is swapped underneath a passing gate

- **WHEN** a matched candidate ran a step on a different model than its golden counterpart, and `model` is among the compared fields
- **THEN** the command reports a `model` divergence and exits non-zero
- **AND** `model` is NOT in the default field set, because a model swap is usually intentional and should not fail an ordinary regression check
- **AND** only a step whose golden counterpart recorded a model is compared, so a baseline captured without per-step models is skipped step by step rather than faulted
- **AND** a `--fields model` run in which NO baseline entry carries a model is the gate-broken refusal above (exit 2), not a pass: the sources that record one are an imported Claude Code transcript or Codex rollout, an OpenTelemetry capture (spans carrying a model attribute, or a Gemini CLI / Claude Code log session), and an agent instrumented through the SDK or the native `record` protocol — a hook-captured session records none, because the harness's hook payload does not name the model

#### Scenario: The agent chooses differently

- **WHEN** a matched candidate records a different `chosen` option than its golden counterpart at the same step, and `decisions` is among the compared fields
- **THEN** the command reports a `decisions` divergence and exits non-zero, even though step count, types, names, tool inputs and status all still match
- **AND** `decisions` is NOT in the default field set, because no baseline exported before it carries the data and defaulting to it would turn a working gate into the "nothing to compare" refusal on upgrade
- **AND** a step whose golden counterpart recorded no decision is not faulted, since a step that made none is not evidence the candidate should not make one

