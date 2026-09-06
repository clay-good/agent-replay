# Changelog

All notable changes to `agent-replay` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A broad hardening pass across the whole CLI, with one theme above the rest:
**a command should never report success, or a number, that it did not
actually measure.** Highlights: consistent exit codes and strict argument
parsing for scripting and CI; gates that fail when they cannot do their job
rather than passing green (`check --golden`, `eval`, `record`, `guard check`);
correctness of the comparison, evaluation, and golden-regression paths
(`diff`, `eval`, `check --golden`); guardrail enforcement that fails closed
(`hook --enforce`); readers that show what is actually stored (`show`,
`replay`, `list`, `stats`); more faithful live capture and import (`record`,
`run`, `import`, `fork`); a more robust OpenTelemetry receiver that keeps the
content, timing, and identity its dialects carry; output that is safe to look
at, since a trace is written by the agent under test and every command that
prints one now escapes what it shows (and an id, which is rendered nearly
everywhere, must be an identifier before it can be stored at all); honesty
about WHICH STORE a command is using, since resolution follows the working
directory and a hook fires from wherever the agent stands, so every command
that only reads now refuses a store that is not there and every command that
creates one says when it is creating a second below a project that already has
one; a package that works when installed — `require('agent-replay')` threw on
load and the published TypeScript types did not resolve, both now covered by a
CI job that installs the tarball and uses it; and work that no longer grows with
what it is looking at: a whole-store `export` that is no longer quadratic in the
size of the store, and a `watch` whose polling no longer costs more the longer
the run it is following.

Three things to know before upgrading:

- **The supported Node range is now `>=20.12`.** Node 18 has been end-of-life
  since April 2025, and `better-sqlite3` — a native module — no longer builds
  against it or against current releases at the version previously pinned, so
  `npm install -g agent-replay` failed at install time on Node 24 and newer.
  The dependency moved to a version with prebuilt binaries for Node 20 through
  26, and CI now tests all four.
- **A read command run where there is no store now refuses (exit `2`)
  instead of creating one.** `list`, `show`, `why`, `decisions`, `stats`,
  `diff`, `eval`, `export`, `fork`, `replay`, `watch` and `dashboard` all
  opened the store with a call that CREATES what it does not find, so running
  any of them from the wrong directory wrote a ~143 KB SQLite file nobody asked
  for and then answered from it — `list` said "No traces found" at exit `0`.
  That names the wrong problem, and it conceals it permanently, because the
  next run finds a store that now genuinely exists and is genuinely empty.
  `guard check` and `hook --enforce` already refused for exactly this reason.
  Creating a store is what `init` is for; an empty store that really exists
  still answers normally. The same rule has since reached the commands this
  sweep missed — `check --golden` and the `guard` subcommands, both below — so
  every command that only reads now refuses, and the ones that legitimately
  create a store say when they are creating a second one below a project that
  already has one.

- **A few commands now refuse input they used to accept**, always where
  accepting it produced a silently wrong answer rather than an error: an empty
  value for a narrowing flag on `list`, `export`, `check` or `config set` (which
  widened the scope to everything, at exit 0); an empty `--dir` on **any**
  command (which silently used a *different store* than the one named — the
  likeliest of these to appear in an existing script, as `--dir "$STORE"` with
  the variable unset); an empty `ingest --format` (which skipped both the
  format check and auto-detection and parsed the file as JSONL); a
  `--refresh`/`--interval` larger than a timer can hold (which inverted into a
  busy loop); and `dashboard` without an interactive terminal (which hung
  forever). Each exits `2`. Two deliberate exceptions to the `--dir` rule: a
  blank `AGENT_REPLAY_DIR` still means "unset", and a capture-mode `hook` warns
  and carries on rather than dropping the event.

The recorded trace *data* model is unchanged — same tables and columns, so
existing stores and exports keep working. Schema v3 through v6 add six indexes
between them (two, one, one and two), and nothing else. Upgrades are automatic
and one-way.


### Added

- **A capture that recorded nothing now names the format that would have
  worked.** There are four `--format` values, and piping the wrong one is the
  easy mistake: every line parses as JSON, the translator recognizes none of
  it, and the run ends having stored nothing. The lines name their own record
  kinds, so the failure now says which format reads them instead of leaving the
  reader to try the other three. Only on a run that already failed, and only on
  unambiguous evidence — a `result` record is emitted by two of the streams, so
  it names neither, and a stream pointing at two formats gets no suggestion at
  all. A wrong suggestion would send the reader to a second format that also
  captures nothing.
- **`record --format claude-stream`, live capture for Claude Code.** Claude
  Code was reachable through hooks and OpenTelemetry but not by piping, which
  is the path a CI job actually uses: `claude -p` in a script has no settings
  file to register hooks in and no collector to point at. The translator reads
  the same `system` / `assistant` / `user` / `result` records, with the same
  content blocks, that the transcript importer already reads off disk, so the
  two paths stay in step — `text` becomes an `output` step, `thinking` a
  `thought` step, and a `tool_use`/`tool_result` pair one `tool_call` step
  whose `is_error` result lands on the step's error field. Token totals include
  both cache fields, and the `total_cost_usd` the run reports is recorded, so
  `stats` can report the store's real spend for a piped capture — a zero cost
  is kept as the real reading a fully cached turn gives, and an unusable one is
  treated as absent. An interrupted run is left open rather than reported
  completed, and a non-success `result` subtype (`error_max_turns`) fails the
  trace on its own.
- **`record --agent-name <name>`, so two piped workflows are not one agent.**
  A translated stream names its agent after the harness, so every
  `record --format codex-exec` capture was called `codex` — a store collecting
  two different Codex-based workflows could not tell them apart, and
  `list --agent`, `stats` and `check --agent` all grouped them together.
  Unlike `--input` it overrides what the stream said: an input is data the
  producer captured, a name is a label. A blank value falls back to the
  stream's name, with a warning, rather than storing an empty one that
  `ingest` would refuse on restore.
- **`record --input <text>`, which makes a piped harness run gateable.**
  `check --golden` matches a candidate to its baseline by agent name and a hash
  of the trace input, and never matches an empty one — so a
  `record --format codex-exec` / `gemini-stream` capture could not be gated at
  all: none of the harness streams carries its prompt, since each of them takes
  it on the command line. The prompt is right there in the shell command, and this passes
  it in, which is the only honest source for it. It fills in only — a native
  producer that sends its own input keeps it — and a blank value is treated as
  absent rather than stored as an empty prompt. The refusal that names this
  cause now names the remedy too.

- **`check --fields decisions` gates on what the agent CHOSE.** The structural
  gate was blind to the one divergence the tool exists to explain: rename
  nothing, change no tool, and swap `escalate_to_human` for `delete_records`,
  and step count, types, names, tool inputs and status all still match — green.
  `export --format golden` now carries each step's chosen option, and
  `--fields decisions` compares it. Opt-in like `model`, because no baseline
  exported before this carries the data and making it a default would turn a
  working gate into the "nothing to compare" refusal on upgrade. Only a step the
  baseline recorded a decision for is compared, and every differing step is
  reported rather than just the first.

- `check --agent-exact <name>` selects exactly one agent, for a regression gate.
  `--agent` matches by substring, which is right for browsing and wrong for a
  gate: `--agent assistant` also selects `travel-assistant` and
  `research-assistant`, and under `--strict` those unrelated candidates decide
  the verdict. Pair it with a baseline exported for the same agent. The two flags
  are mutually exclusive rather than one silently taking precedence.

- `import --replace` re-imports a session that is already in the store.

- `check --golden` compares whether each step FAILED. A baseline could not carry
  step failure at all, so the regression class the gate most needs to catch —
  identical step shape where every tool call now errors — was structurally
  invisible, and `status` does not cover it, because a hook-captured session
  finalizes `completed` from its Stop event however many tool calls failed inside
  it. `export --format golden` now records the outcome of every step and
  `step_errors` is compared by default. Only the flag is stored, never the
  message: error text carries ids and paths that differ run to run, and a gate
  that fails on wording is the false-positive problem this format avoids.
  Baselines exported before this field are skipped step by step, never guessed at.

- AI provider calls now have a deadline and a bounded retry budget. `fetch` has
  no default timeout, so a provider that accepted the connection and then
  stalled hung `eval --ai`, `diff --ai` or `config test-ai` forever — an
  unattended CI job with no output and no way to fail. And a single 429 or 503,
  routine on a shared key, failed a whole evaluation run. Each attempt now has a
  60-second deadline that covers the response body as well as the connect (a
  provider can send headers promptly and stall mid-stream), and a transient
  failure — 429, 5xx, network error, timeout — is retried twice with a doubling
  backoff, honoring `Retry-After` when the provider sends one. Failures that
  cannot succeed on a second attempt (bad key, 4xx, unparseable reply) are not
  retried. Retried attempts return no usage, so `--max-cost` accounting is
  unchanged; `latency_ms` covers every attempt and the waits between them.

- Schema v3 adds two indexes for lookups that were full table scans. `otel
  serve` resolves every incoming batch against
  `json_extract(metadata, '$.otel_trace_id')`, which nothing could index, so
  cross-batch assembly re-scanned the whole trace table once per batch and a
  long-running receiver grew steadily slower as the store filled. The
  dashboard's recent-scores query likewise sorted the entire evals table on
  every refresh tick. The migration is additive — indexes only, no columns and
  no data — so an older binary opening a v3 store is unaffected.

- Schema v4 adds an expression index on `julianday(started_at)` so the
  parsed-instant ordering `list` and the dashboard use is an index seek rather
  than a full scan plus a temp B-tree. Additive, like v3.

- `check --allow-empty` accepts a run where no candidate trace is expected — a
  quiet nightly window, or a matrix job where a given agent didn't run. Failing
  on zero candidates is right by default, but it needed an escape hatch that
  isn't "stop running the gate".

- A `stats` command prints a non-interactive summary of the trace store —
  overall counts (traces, steps, evals, active policies), average duration, and
  token/cost totals, plus a per-status and per-agent breakdown (each agent's
  trace count and a failed+timeout tally). It exposes the same aggregates as the
  `dashboard` TUI but works in a plain terminal, a log, or CI, and `--json`
  emits `{ since, overall, by_status, by_agent }` for piping into `jq` or a
  gate.
  Previously these numbers were reachable only through the full-screen
  dashboard, which needs an interactive TTY. `stats --since <window>` (a
  duration like `7d`/`24h` or an ISO date, matching `list --since`) windows
  every count to traces started at or after the cutoff — steps and evals by
  their parent trace's start time, so the view is internally consistent — while
  the active-policy count stays store-wide (current config, not history). A
  malformed `--since` is a usage error (exit `2`); `--json` always carries a
  `since` field (null when no window was asked for).
- `export` now accepts an optional `[trace-id]` positional, so you can export a
  single trace by id (with prefix matching, like `show`/`why`/`replay`) instead
  of only bulk-filtering. A trace id and the filter flags (`--status`, `--agent`,
  `--tag`, `--since`) are mutually exclusive — passing both is a usage error
  (exit `2`) rather than silently ignoring the filters, and an unknown id exits
  `1`. Previously a trace id passed to `export` was silently dropped and the whole
  database was exported.
- The `otel serve` receiver now accepts `POST /v1/logs` in OTLP/protobuf as well
  as OTLP/JSON (it already accepted both on `/v1/traces`). OTLP exporters default
  to protobuf, so a Gemini CLI or Claude Code session left on the default
  protocol now has its log events ingested without switching the exporter to
  JSON. Malformed protobuf log bodies answer `400`, matching the traces path.

- `hook --dialect <name>` declares the harness dialect for `--enforce` replies
  (`claude-code`, `codex`, `gemini`, or `other`). This makes the documented
  "harness without structured output exits 2" behavior reachable: the dialect
  is otherwise detected from the payload, and detection can only answer with a
  harness it recognizes, so a Crush user registering `hook PreToolUse
  --enforce` was answered with Claude-shaped JSON on exit 0 — which a harness
  that doesn't read hook stdout ignores, letting the denied call run. Nothing
  in a payload distinguishes such a harness, so the user says.

- `guard disable <policy>` and `guard enable <policy>` turn a policy off and on
  without deleting it. Every policy carries an enabled flag that evaluation
  already respected, but nothing could set it: silencing a rule meant deleting
  it — losing its id, priority and description — and retyping it to bring it
  back. Resolves by id or name, like `guard remove`.

- `check --golden` reports baseline entries that no candidate exercised. The
  verdict was candidate-driven only, so a scenario whose run crashed, recorded
  under a different agent name, or ran a different input silently vanished from
  the gate — it reported "1 passed" and exited `0` while the rest of the
  baseline went unchecked. Reported in the summary and in `--json` as
  `uncovered`; a failure only under `--strict`, which already fails unmatched
  runs.

- `export --format golden` warns when a baseline is built from runs that did not
  complete. A `running` trace bakes in a truncated shape, so the next correct run
  "regresses" against it; a `failed` or `timeout` one makes a candidate that
  faithfully reproduces the break pass green. Both are silent otherwise and both
  survive into CI as a wrong verdict.

### Changed

- **The README now states exactly how a value is stored**, for the three cases
  where what comes back is not literally what went in: `input`/`output` keep
  their type (a string stays a string; a string that spells an object or array
  is stored as that structure), `error` is a TEXT column so a structured error
  flattens to JSON text, and trace-level totals are taken at face value and
  never reconciled against the steps — so a producer whose total disagrees with
  its own steps is what `stats` reports. All three were verified against the
  binary; the last two are deliberate and unchanged, they were simply
  undocumented.

- **Dropped two runtime dependencies nothing imported.** `cli-highlight` and
  `figures` were declared in `dependencies`, so npm downloaded and installed
  them (~200 KB) for every consumer of `agent-replay`, and they counted toward
  the audit surface — while no file in `src/` referenced either one. A new test
  asserts that every declared runtime dependency is actually imported. It
  deliberately matches dynamic imports too: `yaml` is loaded through
  `await import('yaml')` inside the rubric parser, and a stricter check would
  have called a real dependency unused, which is the dangerous direction to be
  wrong in.

- **Two capabilities that had no spec at all now have one.** `openspec validate`
  checks document structure, not truth, so a whole area can change while the
  specs stay silent and green — which is what happened here: nothing described
  where the store lives, who may read it, how configuration is loaded, or how
  producer-controlled text reaches the terminal, and every one of those areas
  had a defect this release fixes. `local-store` covers path resolution
  (including blank values and `~`), store confidentiality, configuration
  loading, and independent store handles. `terminal-output` covers control-character
  escaping, the single-line forgery rule, bounding and column-based width, the
  non-interactive refusal, and degrading rather than crashing on a drawing
  problem. Each requirement states the rule and why it exists, so the next fix in
  the area has something to be complete against.

- **Documentation now matches the binary.** `openspec/specs/trace-inspection`
  claimed an ambiguous trace-id prefix returns "the first match — there is no
  ambiguity error", which is the exact inverse of what the code does and would
  have licensed reintroducing a fixed bug; it also omitted `list --session`, the
  empty-filter refusal, instant-based ordering, and both `dashboard` refusals.
  `openspec/specs/guardrails` did not record that `guard add` refuses a pattern
  that cannot match as written. `openspec/project.md` still said Node >= 18. The
  README's schema note still said v4, and did not document the new `list`,
  `dashboard` and `config set` refusals, the `avgDurationSample` field, or the
  store's file permissions. All corrected against the running binary.

- **The export scaling guard no longer measures time at all.** It asserted that
  a 3000-trace export finishes in under 5 seconds — an absolute wall-clock
  bound in a suite that runs files in parallel and spawns real CLI processes, so
  it failed on a loaded machine for reasons unrelated to the code. A time RATIO
  between two store sizes was tried next and still failed under load, and
  averaging that over repeated runs let SQLite's page cache defeat it — the
  quadratic version then passed, which is worse than flaky. The property is now
  asserted two ways, both exact: the query plan SQLite chooses for a
  canonical-id lookup (a keyed `SEARCH`, never `SCAN agent_traces`), and a count
  of how many statement executions full-scan the table during a whole-store
  export, which must not grow with the store. Against the original quadratic
  lookup that count is 202 scans at 200 traces and 802 at 800 — the quadratic
  signature itself.
- **The JSONL reader's equivalence test no longer trips the suite timeout.** It
  read a 200 KB line one byte at a time — 200,000 syscalls per chunk size — and
  took ~110s against a 60s per-test limit, so it failed intermittently on a
  loaded machine. What it proves is that the carry buffer grows past the chunk,
  not the size it reaches, so the very long lines now run only at realistic
  chunk sizes and a 2 KB line (still 2,000x the smallest chunk) covers the tiny
  ones. Both properties stay covered and the run drops from ~110s to ~2s;
  verified the trimmed test still catches a broken carry.
- **The supported Node range is now `>=20.12`, and `better-sqlite3` moved to
  `^12.11.1`.** The old `>=18` floor was a promise the package could not keep:
  `better-sqlite3` v11 does not compile against Node 24 or newer (V8 removed
  the `v8::Object::GetPrototype` and `PropertyCallbackInfo::This` APIs it uses),
  and it has no prebuilt binary for those releases — so `npm install -g
  agent-replay` on a current Node failed at *install* time with a C++ compiler
  error, before any code ran. Node 18 has been end-of-life since April 2025,
  and CI already floored at 20 because Vitest 4 needs `util.styleText` (added
  in 20.12), so the declared range was the only thing still claiming 18.
  `better-sqlite3` 12.11.1 ships prebuilds for Node 20 through 26. The CI
  matrix now also covers Node 24 and 26, and a new test ties the advertised
  `engines` range to the range the native dependency actually supports, so a
  future bump cannot quietly outrun it.
- The openspec specs now describe what the implementation actually guarantees.
  `openspec validate --all` only checks document structure, so nothing had
  verified the normative statements against the binary. The specs had fallen
  behind in three places: the Codex importer's second tool family
  (`custom_tool_call`, the dominant form in real rollouts), its `event_msg`
  wrapper and `token_count` totals, plus import idempotency, the identity key,
  prompt/preamble retention, `ended_at`, streaming and the line limit
  (trace-capture); how an OTel trace's status derives from its root span rather
  than any child, and redelivery de-duplication (telemetry-ingest); and every
  gate-broken refusal, unmatchable empty inputs, `--agent-exact`, and the fact
  that `expected_output`/`eval_criteria` are carried rather than asserted
  (trace-evaluation). Each statement added was verified against the binary.

- Transcript imports read the file a line at a time instead of loading it whole.
  Slurping it as one string and splitting that kept three copies alive at once —
  the string, the array of lines and the parsed records — measuring 436 MB of
  peak RSS for a real 52 MB session, and a JavaScript string cannot exceed
  ~512 MB, so a larger session failed outright with "Cannot create a string
  longer than 0x1fffffe8 characters" and produced no partial import. Long agent
  sessions do reach that size. The same 52 MB session now peaks around 270-290 MB
  (it varies run to run), a 647 MB one imports its 672,000 steps where it
  previously could not be read at all, and the resulting trace is byte-identical
  to what the previous reader produced (tallies, steps, tokens and per-step
  errors all compared on a real transcript).

- A criterion that detects a failed run can now fail its preset on its own.
  `hallucination-check` and `completeness-check` weigh their criteria 0.4 / 0.3 /
  0.3 against a 0.7 threshold, so a lone zeroed 0.3-weight criterion landed on
  EXACTLY 0.7 and passed: the one criterion in each preset that detects a failed
  run was arithmetically incapable of failing it, and a trace the tool renders as
  `✘ FAILED` reported "70% PASS" beside a Details column naming that criterion,
  exit 0. Those two criteria are now marked critical — scoring 0 fails the preset
  whatever the total says, and the report names which one forced the verdict.
  **A run that was passing on a zeroed error criterion will now fail**, which is
  the point. Raising the threshold instead would have moved the PARTIAL band too:
  a retrieval answer that paraphrases rather than quotes scores about 0.3 on the
  word-overlap grounding heuristic, and a run with 1 of 7 tool calls completed
  scores 0.743 — both would have started failing on arithmetic unrelated to the
  defect. Every other band is exactly where it was.

- **Exit codes are now consistent across the CLI**, so scripts and CI can gate
  on `$?`: every failure exits non-zero — `1` for a runtime failure (not found,
  malformed input, a `check --golden` regression, an `eval` over its threshold)
  and `2` for a usage error or a `guard` / `hook --enforce` block. Success and
  empty results exit `0`; `run` propagates the child's status; `hook` capture
  always exits `0`. Previously several commands printed an error but still
  exited `0` (`export` invalid format, `guard add` invalid pattern/action,
  `import` with nothing importable, `watch`/`why` not-found, `diff --ai` with no
  provider, `demo --reset` refusal). A new "Exit codes" section in the README
  documents the convention.
- **Argument parsing now fails loudly on mistakes.** Every command rejects
  unexpected extra positional arguments instead of silently ignoring them, so
  `agent-replay show <id> <typo>` or `list production` (meant as `--tag
  production`) errors rather than quietly running on the first argument. And
  commander's own parse errors (unknown flag, unknown command, missing/excess
  argument) now exit `2` to match the documented "usage error" code — they
  previously exited `1`, contradicting the README's exit-code table.

- `demo --reset` refuses to delete a store named only by `AGENT_REPLAY_DIR`.
  Deleting someone's traces has to be something they typed, so the destructive
  path requires an explicit `--dir` (everything non-destructive still honors the
  handshake).

- Every command honors `AGENT_REPLAY_DIR` as its data directory when `--dir`
  isn't given. `run` sets that variable for its child and the README documents
  it as how the wrapper hands the child its store, but nothing read it back — so
  a nested invocation (`run -- sh -c '... | agent-replay record'`) wrote to a
  fresh `./.agent-replay` instead of the store the wrapper had just opened a
  trace in. An explicit `--dir` still wins.

### Fixed

- **`check --golden` blamed the wrong thing when only SOME matched runs carry
  a field.** A field is compared only when every matched run's baseline can
  exercise it, so that one agent does not pass on another's behalf — but the
  refusal said "no baseline entry carries that data" and then listed the causes
  and cures for a field nothing records. In a mixed run that is false on its
  face: the reader opens the golden file, finds the model right there, and
  every remedy offered (use a capture path that records it) is beside the
  point, while the one that works — narrowing with `--agent` — went unmentioned.
  Hit on the tool's own `demo` data, where one of the two completed traces
  records a model and the other does not. The two cases are now told apart and
  each names its own cure; `--json` carries the distinction as
  `uncompared_partial`.
- **A codex tool call's arguments were dropped.** `record --format
  codex-exec` read only a shell `command` as a step's input, so an
  `mcp_tool_call` — whose arguments live under `arguments`, exactly as the
  Codex rollout importer for the same harness reads them — stored an empty
  input. `show` displayed none, and `diff` could not report a changed MCP
  query, because the field it compares was empty on both sides. Arguments are
  now read into the input column, parsed when they are JSON and kept verbatim
  when they are freeform; the whole item is still preserved as the step's
  output.
- **A translated stream recorded the model nowhere.** `record --format
  codex-exec` / `gemini-stream` never read the model any record named, while
  every sibling capture path does — the Claude Code transcript and Codex
  rollout importers each track the model in force and stamp the steps a record
  produced, and both OpenTelemetry mappers do the same. A step's `model` is
  what `diff` reports a change in and what `show`/`replay` display, so a model
  swap between two captured runs was invisible. The translators now track the
  model as a running cursor and stamp the steps that follow, so a session that
  switches models mid-run keeps each step labelled with the model in effect at
  its own time. A stream that names no model still stores none — an absence is
  reported, never guessed.
- **`check --golden` reported a FIX as a regression.** The per-step
  `step_errors` comparison is deliberately one-directional — a step that stops
  failing is not a regression, because a baseline that captured one flaky
  failure would otherwise report REGRESSED on every green run after it — but the
  trace-level `status` comparison directly beneath it was symmetric, so that
  exact scenario played out a level up: a baseline exported from a run that
  failed or timed out once flagged `status: golden failed → got completed` at
  exit 1 forever, until someone re-exported it. `export --format golden` already
  warns when a baseline entry is not from a completed run and names this very
  outcome ("later correct runs then 'regress'"), so the tool was describing the
  defect in one command and producing it in another. A candidate that reaches
  `completed` is now never a `status` regression. Every other transition still
  diverges — `completed` to `failed` or `timeout`, and a change of failure mode
  such as `failed` to `timeout` — because only arriving at `completed` cannot be
  a regression.
- **`check --golden`'s "nothing to compare" refusal explained the wrong cause,
  and for one field prescribed a cure that cannot work.** A single generic hint
  covered every field and named causes belonging to two of them: `--fields
  decisions` was explained as "a store captured without per-step models, or a
  baseline with no tool_call steps", neither of which has anything to do with
  decisions. Worse, the one cure it offered — re-export the baseline from runs
  that exercise the field — cannot help `--fields model` on a hook-captured
  store, because the harness's hook payload does not name the model, so no
  re-export of those runs will ever carry one. A refusal that names a cause but
  prescribes the wrong cure is worse than a vague one: the reader exhausts the
  suggestion and concludes the tool is broken. The hint is now written per
  field, from the same condition the gate actually tests, and the `model` case
  names the capture paths that do record one.
- **`list --json` and `show --json` could not report the duration the tool
  itself was printing.** Both commands display a duration derived from the
  trace's own `started_at`/`ended_at` when the producer set no
  `total_duration_ms` — which is every hook-captured trace, among others — while
  the `--json` documents carried only the raw column. A table row read "30.0s"
  next to a document that said `total_duration_ms: null`, so a script asking how
  long a run took got nothing for traces the tool was visibly timing.
  `list --json` had already solved exactly this for tokens by carrying
  `effective_tokens`; duration was the twin left behind, and `show --json`
  carried neither. Both now carry `effective_duration_ms` and `effective_tokens`,
  computed with the same helpers the rendered views use, so the document and the
  display cannot disagree. The stored `total_*` columns are passed through
  untouched — a reported total stays distinguishable from a derived one, `null`
  still means nothing measured it rather than a real zero, and the
  export → ingest round trip is unchanged.
- **`run` reported that nothing was lost when a child's events were
  malformed.** The wrapper's closing summary counts the events it could not
  record, but only ones the STORE refused — a line the protocol rejected (bad
  JSON, an unknown event type, a missing `trace_id`: the ordinary
  first-integration mistakes) was warned about on stderr and then dropped from
  the tally. The summary read "0 event(s) recorded" with nothing saying anything
  had been thrown away, which reads as "my instrumentation never fired" rather
  than "it fired and was rejected" and sends the reader looking in the wrong
  place. The stderr warning is not the durable record here: `run` passes the
  child's own stdout and stderr through unmodified, so the warning is
  interleaved with the agent's output and scrolls away, while the summary is the
  last line printed. Rejected lines are now counted alongside unstorable ones
  ("N event(s) could not be recorded"). `record`, which consumes the same
  protocol, has always counted them. Blank and `//` comment lines are legal
  protocol and are still not counted, and neither is an event validation kept
  while ignoring one unusable field — that is a repair, not a loss. (This
  supersedes the narrower fix earlier in this cycle, which added the tally for
  events the store refused — a child recording several sub-traces through one
  channel collides on the per-trace step numbering and loses everything after
  the first, while the count lived only in stderr lines and the summary still
  read "N event(s) recorded".)
- **An OpenTelemetry log capture recorded the model nowhere, so
  `check --golden --fields model` could not gate it.** Every
  `claude_code.api_request` and `gemini_cli.api_response` record states the
  model it called, but only the failure branch (`.api_error`) ever read it — a
  session whose model calls all succeeded stored no model on any step, and there
  is no trace-level model column, so the model sat unread in the payload. A
  baseline exported from such runs made `check --golden --fields model` exit `2`
  ("no baseline entry carries that data"): the gate a CI job added specifically
  to catch a model swap could not run at all. Log-derived `tool_call` and
  `llm_call` steps now carry the model in effect when their record arrived, so a
  session that falls back to a smaller model mid-run keeps the earlier steps
  labelled with the earlier model rather than being relabelled wholesale. A
  session that never reports a model still stores none — an absent model stays
  absent rather than becoming an invented one. `decision` steps are left alone:
  a tool decision is the user's or the policy's call, not the model's. The model
  also survives the batch boundary, which is what makes this work against a real
  receiver: a log processor flushes constantly, so an `api_request` in one batch
  and the `tool_result` it led to in the next is the ordinary shape rather than
  an edge case — and those model-call records produce no step of their own, so
  there was nothing on the trace for the next batch to inherit from. A log
  session now carries the model it was last reported on (the way a span trace
  carries its root's), so assembling a session from any number of batches gives
  the same per-step models as receiving it in one, including a session that falls
  back to a smaller model between flushes.
- **`ingest --format jsonl` on a JSON file reported the symptom thousands of
  times instead of the cause.** Every line of a pretty-printed array is a
  fragment, so an ordinary `--format json` export produced 5,664 "Invalid JSON
  on line N" warnings and a validation error per element — without once saying
  that `--format jsonl` had been pointed at a `--format json` file. A JSONL
  record is an object, so a file whose first meaningful line opens a bracket is
  an array; `ingest` now says exactly that and names both ways out (drop
  `--format` to auto-detect, or pass `--format json`), each verified to read
  the same file. A real JSONL file is unaffected — the tell is the leading
  bracket, not the flag.

- **`ingest` accepted a golden dataset and manufactured empty traces from it.**
  A golden entry carries `agent_name` and `input`, so validation passed and the
  command reported "Ingested 20 trace(s) successfully" — while storing 20
  traces with no steps at all, because a golden file keeps its steps in
  `steps_summary`, a key a trace export never writes and `ingest` never reads.
  Those stepless traces are indistinguishable from real runs: they widen `list`
  and `stats`, and a golden dataset exported afterwards includes them, so a
  baseline built from a store that swallowed one gates CI on empty runs.
  `ingest` now refuses (exit `2`) and points at `check --golden` for the file
  and `--format json` for the traces — the mirror of the guard `check` already
  had for a `--format json` export handed to the gate. A trace whose `steps` is
  legitimately empty still ingests; the tell is `steps_summary`, not the
  absence of steps.

- **`ingest`'s fork note left out the consequence that costs the most.** It
  said a restored fork becomes an ordinary trace and that `check` and `watch`
  would treat it as a real run, but not that `export --format golden` would
  then INCLUDE it in a baseline it deliberately excludes — the reason forks are
  excluded in the first place, and the item its own source comment lists first.
  Measured on a restored backup: a golden export that held 5 entries before the
  round trip held 6 after, the extra one a never-executed copy of a step prefix
  that a real run stopping early would reproduce and pass against. Restoring
  the lineage itself remains a maintainer call (ingest regenerates ids, so it
  needs an in-file remap and a decision about a fork whose parent is absent);
  naming the cost is not.

- **A backup made with `export --with-evals` restored none of them.**
  `ingest` read only `steps`, so a json/jsonl export — the format the spec
  calls a backup — came back with every evaluation gone, and said
  "Ingested N trace(s) successfully" while doing it. `--with-evals` exists to
  put the evaluation history in the file, so a restore that drops it makes the
  flag a no-op on the one path that consumes its output. Evaluations carried on
  an ingested trace are now restored, validated as strictly as everything else
  at that boundary (a bad `evaluator_type` is a named field error rather than a
  cryptic `SqliteError` from the CHECK constraint), and their `evaluated_at` is
  preserved rather than left to the column's `datetime('now')` default — a July
  evaluation restored in September would otherwise be stamped September, and a
  wrong timestamp reads exactly like a right one. A document with no `evals`
  key is unaffected. `ingest`'s note saying stored evals could not be restored
  — which advised re-running `agent-replay eval` to regenerate them — is gone
  with the limitation it described; a note the tool contradicts is worse than
  none, and it sent the reader to redo work the restore had already done.

- **`--json` silently ignored the flags that only shape the human view.**
  `show --json --steps-only`, `show --json --tree` and `diff --json --compact`
  each produced a document byte-for-byte identical to one without the flag, and
  said nothing — so a caller who asked for just the steps, a hierarchy, or a
  smaller payload got the full document and no way to tell. Nothing a JSON
  document could do would honour them, unlike `--evals` and `--snapshots`,
  which name data the payload carries (and neither is flagged, since the data
  is there). Each now says which flag did nothing, on stderr, so the document
  on stdout is untouched. `show` also points at `parent_step_number` and
  `caused_by_step_number`, which are in `steps` and let a consumer rebuild the
  tree `--tree` would have drawn.

- **`show --json --snapshots` returned no snapshots.** `--snapshots` reached
  the human path only, so the JSON document had no `snapshots` key at all —
  exit `0`, no warning, and `jq .snapshots` null forever, while the very same
  trace printed its snapshots without `--json`. That left no machine-readable
  way to get a snapshot out of the tool, though `evals` — the sibling section
  rendered right above it — has always been in the payload. It is the defect
  `diff --ai --json` had and fixed, in the same shape: a flag whose data the
  JSON path could carry, dropped by an early return. Each snapshot is attached
  to its own step as `snapshot`, field for field the shape
  `export --with-snapshots` writes and the one `ingest` reads, so a
  `show --json --snapshots` document re-ingests with its snapshots intact — a
  top-level array would not, and `ingest` would have reported "Ingested 1
  trace(s) successfully" while keeping none of them. A step with no snapshot
  carries `null`, as export writes it. The steps are only rewritten when the
  flag is passed, so a `show --json` without it is byte-for-byte unchanged, and
  the `--from-step`/`--to-step` window applies as it does on the human path.

- **`check --trace` silently ignored `--agent`, `--agent-exact` and
  `--since`.** `--trace` names one trace and the filter branch is never
  consulted, so passing both got the named trace whatever the filters said. The
  contradiction is the interesting case: `--trace X --since 1d` reads as "check
  X if it is recent" and checks X regardless of age. `export` already treats the
  same combination as a usage error ("a trace id can't be combined with filter
  flags"); this warns instead rather than refusing, because checking a named
  trace whatever its lineage or status is documented behaviour a script may
  already rely on — so it says the filter did nothing rather than rejecting a
  command that used to work. The warning goes to stderr, so a `check --json`
  document is untouched.

- **`show --steps-only` silently ignored `--evals` and `--snapshots`.**
  `--steps-only` prints the step timeline and returns before either section, so
  asking for one alongside it got you neither — and the output is
  indistinguishable from a trace that genuinely has no evals or snapshots, so
  the flag's absence reads as an answer. `export` already warns for its own
  inert pair (`--with-evals` / `--with-snapshots` with `--format golden`); this
  is the same rule at the twin site. The warning names the flags that did
  nothing and goes to stderr, so `show --steps-only` stays pipeable.

- **Two inert-flag warnings said "has" for a list of two.** `--with-evals and
  --with-snapshots has no effect` — now "have", in both the export message and
  the new one.

- **`show --evals` was described as "Include evaluation results"**, which
  implies they are excluded without it. They are not: the evaluations section
  is shown whenever the trace has any. The flag's real effect is to show the
  section when the trace has *none*, reporting "No evaluations found" — which
  is the useful thing it does, since an absent section otherwise cannot be
  told from a trace nobody evaluated. The help text now says that.

- **`guard list` showed a kill switch that cannot fire as an armed one.** A
  `deny` (or `require_review`) policy matching on `output_contains` can never
  block during enforcement — that runs *before* a tool call, when there is no
  output yet. `guard add` warns about this at the moment the policy is written,
  and the listing said nothing: the row reads `DENY / Enabled: Yes`, which is
  indistinguishable from a policy that really does block. The add-time warning
  scrolls away; the table is the durable record, and it is what anyone auditing
  an inherited store — or their own a month later — actually looks at. The
  listing now names those policies, with the same explanation `guard add`
  gives. It stays quiet when every blocking policy can genuinely fire, and
  leaves `warn` policies alone, since a `warn` on output is a legitimate
  post-hoc rule that `guard test` and recorded traces both evaluate. Enabled
  state is deliberately not part of the test: enabling one of these later would
  not make it block either.

- **The fail-closed guardrail refusal told you to add a policy when you already
  had one.** `guard check` and `hook --enforce` both refuse a store with no
  *enabled* policy — a gate that cannot fire — and both said "add one with
  `agent-replay guard add`". That is right for an empty store and misleading
  for the other way to get there: a policy that exists and is **disabled**.
  Someone who turns one off to unblock themselves and forgets would follow the
  advice, end up with a duplicate, and leave the policy they meant to use
  switched off. The refusal now distinguishes the two — it says how many
  policies are present but disabled, **names them** so you know what to turn
  back on, and points at `guard enable`. An empty store keeps the original
  wording, including the wrong-store `--dir` guess, which is only worth raising
  when there is nothing to enable. A long list is summarized (three names plus
  a count) rather than printed in full, because this reason travels into a hook
  decision the harness shows to the model. Both commands now build the sentence
  from one place instead of the two copies that had already drifted apart in
  their wording.

- **"No candidate matched the baseline" suggested a remedy that cannot work
  for the commonest cause.** The refusal listed a renamed agent, a changed
  input template, or `hook --no-input`, and then advised re-exporting the
  baseline from current runs. That is right for the first two and wrong for the
  third: a trace with an empty input is *never* matched, deliberately — an
  empty input is the absence of an identity, not one that happens to be blank,
  so every input-less capture hashed to the same key and unrelated sessions
  compared as the same scenario. Re-exporting changes nothing, because neither
  side has an identity to pair on. A reader who followed the advice re-exported,
  saw the identical refusal, and had nothing left to try. The check now counts
  those candidates separately and says which case it is looking at: that they
  recorded no input, that re-exporting will not change it, that the capture has
  to record an input, and where that usually comes from (`hook --no-input`, the
  `codex-exec` / `gemini-stream` translators, which record no input of their
  own — `record --input` now supplies one — or OpenTelemetry spans carrying no
  prompt attribute). A mixed run reports how
  many of each. When every candidate has a real input the original wording is
  unchanged, minus the `hook --no-input` guess that now has its own branch.

- **Imported steps were stamped with the import time, not when they happened.**
  The storage layer defaults a step with no `started_at` to *now*, and neither
  importer passed one — so importing a July session in September recorded every
  step as having happened in September: after the trace's own `ended_at`, and
  so outside the window of the trace they belong to. The trace's start and end
  were already read from these very record timestamps; only the steps were left
  out. A wrong timestamp reads exactly like a right one: `show --json` reported
  them, a `json`/`jsonl` export carried them into the backup, and anything
  reading the store saw a run whose steps happened after it ended. Both
  importers now stamp each step from the record that produced it,
  including a Claude Code subagent's own records — which the OpenTelemetry
  mapper has always done, from each span's start. A record carrying no
  timestamp of its own inherits the last one seen rather than falling back to
  the default: that is still a measured value and an ordering bound, since
  records are in session order, and it keeps every step inside the window of
  its own trace. Nothing is invented — per-step *durations* are still not
  recorded, because the gap between two records includes however long the human
  was away, and a made-up duration is worse than an absent one.

- **An imported Codex session recorded no model.** The same gap as the Claude
  Code one below, in the sibling importer. A rollout states the model on a
  `turn_context` record — verified against a real rollout on disk, at
  `turn_context.payload.model` — and nothing read it, so the record was tallied
  as skipped and the model was lost. It is read **per turn**, not once from the
  session: a rollout that switches models mid-run says so on a later
  `turn_context`, and labelling every step with the first model would be worse
  than labelling none, since a wrong model reads exactly like a right one. A
  step before any `turn_context` keeps a `null` model rather than backfilling.
  A `turn_context` that supplies a model now counts as imported rather than
  skipped, following `session_meta`, which also supplies retained metadata
  rather than a step; one naming no model is still skipped.

- **An imported Claude Code session recorded no model.** Every assistant record
  in a real transcript carries `message.model`, and it was read by nobody — so
  an imported session recorded which tools ran and what they cost, but not the
  model that produced any of it. Every other capture path keeps it: the live
  recorder, the hook adapter and the OpenTelemetry mapper each set a step's
  `model`. It also made `check --golden --fields model` — which the README
  documents, and which refuses a baseline that cannot exercise the field —
  unusable for imported traces, so the one thing a model upgrade changes could
  never be gated on. Each assistant message now records its model, in both the
  block and string content shapes, and **a subagent keeps its own**: a subagent
  often runs a different model from the session that spawned it, and it is
  imported by a separate loop that needed the same read. A record carrying no
  model stays `null` rather than inheriting a neighbour's.

- **A single-span agent trace recorded no model.** A model attribute is read by
  the STEP mapping, into the step's `model` column, but the root span is not a
  step — so on the root nothing read it and every spelling was dropped. That
  contradicted the intent stated where the trace's metadata is assembled, which
  set out to "carry the root's own attributes (model, provider, and any unmapped
  `gen_ai.*` keys) … they were dropped entirely, so a single-span trace recorded
  no model or provider at all". Only the provider half worked, because only it
  was written explicitly. A one-span agent run (a root `invoke_agent` with no
  children) therefore recorded its agent, its tokens and its provider, and lost
  the model it ran on — with no step whose column could hold it, and no
  trace-level model column either. The root's metadata now carries a normalized
  `model`, written the same way `provider` already is, so all three dialects
  land in one place: OpenInference spells it `llm.model_name`, which is not a
  `gen_ai.*` key and so was never eligible for the unmapped-key pass at all —
  the same dialect gap `llm.provider` was fixed for. A step's metadata still
  carries neither, since there the column holds them.

- **A nested agent span lost its own `gen_ai.agent.name`.** In a multi-agent
  trace each `invoke_agent` span names its own sub-agent, and the OTel mapper
  deliberately keeps those nested spans as steps so nothing is dropped. But
  `gen_ai.agent.name` sat in the list of attributes excluded from step metadata
  — a list that exists to stop metadata duplicating what a column already holds.
  It is consumed only from the ROOT span, where it becomes the trace's
  `agent_name`; on any other span nobody consumed it and it was dropped anyway,
  so a step carried no record of which agent ran it. It survived only when the
  producer happened to repeat the name in the span name (`invoke_agent
  researcher`), which is what made the loss easy to miss — a span named plainly
  `invoke_agent` lost it outright. A non-root span now keeps the attribute in
  its metadata; the root still does not, since there it is the agent name.

- **`export` reported where it wrote, never how much.** The one number that
  reveals a filter typo was the one number missing: `export --agent
  no-such-agent --output backup.json` announced `Exported to
  /path/backup.json` at exit `0` over a file holding `[]`, and the caller
  believed they had a backup until they needed it. Its siblings already report
  a count — `list` says "N trace(s) found", `ingest` says "Ingested N
  trace(s)". The success line now names the count too (`Exported 3 trace(s) to
  …`, counted from the bytes just written, so the number reported is
  necessarily the number in the file), and an export that matched nothing warns
  in every format. `--format golden` already warned that an empty baseline
  cannot detect a regression and keeps its own wording. The warning does not
  depend on `--output`: it goes to stderr, so it cannot pollute a piped stdout,
  and making it conditional would mean two byte-identical exports differing
  only in whether they were warned about — the mistake this file already
  corrected once for the golden warning.

- **`ingest --format ""` silently parsed the file as JSONL.** The refusal that
  rejects an unknown `--format` is guarded by a bare truthiness test, and the
  auto-detection below it uses `??`, which catches only null/undefined — so an
  empty value slipped past both and did the exact silent parse-as-JSONL the
  refusal exists to prevent. `ingest traces.json --format "$FMT"` with `FMT`
  unset then failed with "No traces could be parsed from file", naming the file
  rather than the flag, while the same file with the flag omitted ingested
  fine. It is now a usage error (exit `2`) that names the flag, matching the
  sibling commands: `record` and `import` test format membership with no
  truthiness guard in front, so `""` already reached their refusals. `ingest`
  needs the guard at all only because an omitted format means auto-detect.

- **`run --agent-name ""` recorded a trace the store could not read back in.**
  The fallback to the command name was written `opts.agentName ?? opts.command`,
  and `??` catches only null/undefined — so a blank name, which is what
  `run --agent-name "$NAME"` produces when `NAME` is unset, slipped past it and
  was stored as-is. `agent_name` is required and non-empty everywhere else:
  `validateTraceInput` refuses `""` on ingest, so such a run wrote a trace this
  store's own `export` → `ingest` round-trip cannot reproduce. The backup failed
  to restore, at restore time, far from the cause. It also drew a blank agent
  column in `list` and could not be filtered for by name. A blank name now falls
  back to the command name, as an omitted flag already did, and `run` says so on
  stderr. It falls back rather than refusing for the reason a capture-mode
  `hook` warns rather than refusing an empty `--dir`: the child process is the
  user's real work, and losing the run is worse than labelling it. Only the "is
  this set at all?" test is trimmed; a name that is genuinely spaced is stored
  untrimmed, the rule `resolveDataDir` already follows.

- **`--dir ""` silently used a different store than the one named.** `--dir` is
  the flag that chooses *which store*, and it was the only flag that *names*
  something the empty-value rule never reached — the rule the exit-code table
  already stated. `resolveDataDir` deliberately reads a blank as UNSET, which is
  right for `AGENT_REPLAY_DIR` (blank by ordinary shell accident, and resolving
  it to the working directory once let `demo --reset` delete a working tree) and
  wrong for an explicit flag: `--dir "$STORE"` with `STORE` unset does not mean
  "use the default", it means the caller named a store and got a different one.
  Reads then answered from the wrong store — `list` printing "No traces found"
  at exit `0` — and writes landed in it, the same concealed-wrong-store failure
  `openStoreOr` exists to prevent, arriving through the flag instead of the
  working directory. Now a usage error (exit `2`), in the caller's shape, for
  every command including nested subcommands, and for a whitespace-only value
  too. Two deliberate exceptions: a blank `AGENT_REPLAY_DIR` still means unset,
  and a capture-mode `hook` warns on stderr and records to the default store
  rather than refusing, because a non-zero hook exit blocks the pending tool
  call in every supported harness and refusing would drop the event outright.
  `hook --enforce` is not exempt — a gate pointed at a store with no policies
  allows everything, so it fails closed.

- **Assembling a long OpenTelemetry session cost time quadratic in its
  length.** A `BatchSpanProcessor` flushes many batches into one trace — the
  pattern cross-batch assembly exists to serve — and every merge read *every*
  step the trace had so far, `JSON.parse`-ing each one's metadata, to recover
  three things it can get directly: the highest step number, the span-id map,
  and the steps still waiting for a parent. Above the renumber bound it then
  read them all again for the forward-reference sweep. Measured over 1,000
  ten-span batches: 2.32 ms per batch at 4,000 steps, 6.68 ms at 10,000, 4.47s
  in total. Each merge now reads only what the batch needs — the maximum step
  number, the unparented steps, and just the span ids this batch names — and
  **schema v6** adds the two indexes those lookups want. Same measurement: 0.40
  and 0.81 ms per batch, 1.44s in total, and the per-batch cost no longer grows
  with the session. The migration is additive (two indexes) and the assembled
  trace is unchanged.

- **`why` rescanned the whole trace at every hop.** The causal walk falls back
  to "the nearest earlier decision point" when a step carries no `caused_by` or
  `parent`, and it found that by scanning every step — once per hop. That never
  shows while a producer sets `caused_by`, since the walk then never reaches
  the fallback, and it is quadratic the moment one does not: on a trace whose
  steps all carry decisions and no causal links (the shape a hook-captured
  session with `attachDecision` produces), the per-step cost doubled every time
  the trace did — 4.5µs at 500 steps, 49.6µs at 10,000 — and the whole walk went
  from 2.3ms to 495.7ms. The nearest earlier decision for every step is now
  computed once, in a single pass, so the cost is flat at about 2µs per step at
  any size; the same 10,000-step walk takes 21.9ms. The chain itself is
  unchanged.

- **`list` took about seven seconds to draw a large listing.** The query is
  flat — `--json --limit 10000` returns in roughly 0.13s — but the terminal
  table renderer costs time quadratic in its row count (measured on a bare
  table with no options and no styling: 1,000 rows 123ms, 8,000 rows 3.9s), so
  `list --limit 10000` spent ~7s building an 11 MB string for a table nobody
  reads. The human path now draws at most 1,000 rows — already some forty
  screenfuls, and a tenth of a second — and says so, naming `--json` as the
  uncapped path. The count in the header still reports everything that matched,
  and `--json` is untouched: it returns every row the query found.

- **One unusable decision field cost the whole step on the live path.** A
  `confidence` outside `[0, 1]` made `record` and the `TraceRecorder` SDK skip
  the entire event, so a producer sending `confidence: 99` lost the decision
  itself — the chosen option, its options and its rationale, the record `why`
  and `decisions` exist to show — over a single number. That is not the rule
  this validator applies anywhere else: the `trace_end` status is repaired,
  five numeric fields and four causal references are dropped with a warning,
  and the sibling `decided_by` is normalized on this very path. The check was
  added to keep a recorded trace re-ingestable from its own export, and
  dropping the field reaches that just as well, since `null` is a legal
  confidence. It is now dropped, with the warning naming it, and the round-trip
  is pinned by a test that exports what the SDK wrote and feeds it back to
  `ingestTrace`. The README described the dropping behavior already; only the
  lower-level `attachDecision` actually did it.

- **`stats` presented a partial token and cost sum as a store total.** Both
  are sums over whatever subset of traces happens to record the value, and
  neither said so — a store of 100 traces where 3 carry a cost printed "Total
  cost: $0.19" as if it were the store's spend, under a "Traces: 100" and
  directly *below* an "Avg duration" that does state its scope. That
  denominator (`avgDurationSample`) was added for exactly this reason and its
  two neighbours were left behind. `overall` now also carries
  `totalTokensSample` and `totalCostSample`, and the panel says `(over N of M)`
  on each figure that covers fewer traces than the store holds.

- **`diff --json` did not say what it had compared.** The document carried a
  `diffs` array and nothing about scope, so `--fields model --json` reporting
  three differences was byte-for-byte the shape of an *unfiltered* comparison
  that genuinely found three — and a filter that left nothing produced
  `"diffs": []`, which reads as "the traces are identical", the one claim the
  human path is careful never to make. The document now carries
  `compared_fields`: the list when `--fields` narrowed the comparison, `null`
  when it did not. Written on every run, following the rule the golden `failed`
  field settled — a key emitted only in one case makes its absence ambiguous
  between "not narrowed" and "written by a build that predates the field".

- **`fork` silently ignored an empty `--modify-input`, `--modify-context` or
  `--tag`.** Each was read with a plain truthiness test, so an empty string —
  the shape a flag built from an unset shell variable takes — skipped the flag
  entirely, and the command printed "Forked trace successfully." at exit `0`
  for a copy that carried none of the modification asked for, or no tag. This
  is the refusal `list`, `export`, `check` and `config set` already make, and
  the one headline command that had not adopted it. A literal `null` is
  untouched: it remains the documented no-op that keeps the original value.

- **`watch` tailed a trace that had been deleted, forever.** The tick's status
  read returns nothing when the row is gone — `import --replace` drops the prior
  copies of a session it is re-importing, and `deleteTrace` is part of the
  published API — and the branch was written `if (row && ...)`, so the missing
  case fell straight through. The tail went on polling an id that no longer
  existed, which on screen is indistinguishable from an agent that has gone
  quiet. It now stops, says the trace was deleted while it was watching, and
  exits `1`: the code a named trace that does not exist already uses. `check`
  had counted "a trace deleted while this ran" among the states it must account
  for; the live view owed the same.

- **`check --golden` created a store before deciding it had nothing to check.**
  The regression gate never turned green wrongly — no store means no candidates,
  which is already exit `2` — but it wrote a ~143 KB store into the working
  directory and then described the outcome as "No traces matched", which sends
  the reader to widen their filters when the real answer is that this is not the
  directory the runs recorded into. It now refuses first, names the store and
  the store above if the project has one, and writes nothing; the exit code and
  the `--json` refusal document are unchanged. `--allow-empty` does not cover
  this: that flag says an empty *window* is expected, not that the store is
  missing — the distinction `guard check` already makes between an empty policy
  set and a store that is not there.

- **`guard list` created a store and told you the project had no guardrails.**
  The rule the twelve trace-reading commands adopted — refuse a missing store
  rather than create one — never reached the guard subcommands. `guard list`
  wrote a store nobody asked for and answered "No guardrail policies found." at
  exit `0`, which for a policy set is worse than for traces: the reader
  concludes the project is ungoverned while a full set sits one directory up,
  and the next run finds a store that now genuinely exists and is genuinely
  empty. `guard remove`, `guard disable`/`enable` and `guard test` did the same
  and could then only report that the id was not found — again the wrong
  problem. All four now refuse at exit `2`, name the store above when there is
  one, and write nothing. `guard add` still creates the store it writes into,
  since that is a write, but says when it is doing so below a project that
  already has one — a policy stored where the enforcement path will never look
  is a guardrail that cannot fire.

- **Capture reported success while splitting a session across two stores.** A
  hook fires from wherever the agent is standing, and store resolution is
  relative to the working directory — so `agent-replay hook` in a subdirectory
  created a brand-new store under `src/deep/.agent-replay`, answered "prompt
  recorded", and left half the session invisible to a `list` run from the
  project root. `record`, `run`, `ingest`, `import` and `otel serve` all did the
  same. None of them may refuse — losing a run is worse than recording it
  somewhere unexpected — so each now says, once, that it is creating a store
  while a project above already has one, and names both stores and both ways to
  record into the right one. Capture stays exactly as harmless as before: `hook`
  still writes nothing to stdout and still exits `0`. Silent once a local store
  exists, since an ancestor store beside a local one is a deliberate nested
  project rather than a mistake.

- **"No trace store here" sent you to create a second one.** Standing in a
  subdirectory of your own project is the ordinary way to meet that refusal —
  store resolution is relative to the working directory, and a hook fires from
  wherever the agent happens to be. The advice attached to it, run `init` in the
  project directory, is right for someone who has no store and wrong for someone
  who has one two levels up: following it creates a second store beside your
  source and splits your traces between the two, which is also how an
  `--enforce` gate ends up pointed at a store with no policies. Every one of
  these refusals — the ten read, export, replay, fork, dashboard, `guard check`
  and `hook --enforce` sites — now names the store that does exist above the
  working directory, with both ways to reach it (`cd`, or `--dir`). Resolution
  itself is unchanged: nothing walks up to CHOOSE a store, which would silently
  change which store every command reads; only the message looks. Silent when a
  directory was named with `--dir` or `AGENT_REPLAY_DIR`, since the working
  directory is then not the story.

- **`watch` re-read the entire trace on every poll.** The live tail asked for
  every step of the trace twice a second and rebuilt each row — parsing its
  JSON columns — only to discard all but the new ones. The cost of following a
  run therefore grew with the length of the run, which is backwards for the one
  command meant to be left open on a long session: measured at 7.3 ms per poll
  at 2,000 steps and 24.7 ms at 8,000, about 5% of a core at the default
  interval and half a core at the `--interval 50` the README shows. A poll now
  reads what has been written since the last one (cursored on write order, so a
  lower step number written later still arrives), re-reads only the steps it is
  holding open for their closing line, and reconciles against the trace's step
  count — 0.26 ms and 0.46 ms for the same two traces, growing sublinearly.
  Output is byte-for-byte identical, verified against the previous build on a
  live run covering both protocol shapes and an out-of-order step number.

- **`config` reported a database that nothing opens.** `init` records an
  absolute `database` path, and no command has ever opened the store through it
  — every one resolves `<data dir>/traces.db` itself. So a project that was
  copied, moved, or cloned onto another machine went on naming the store it was
  created beside, and `config list` / `config get database` answered with it.
  The harmful shape is not a path that has gone missing but one that still
  exists: the single question the field is there to answer — which database am I
  looking at — came back with a real, wrong, plausible file, next to commands
  reading a different one. The value is now derived from the directory in use,
  as the trace model already derives what it displays, and a stored path that
  disagrees is reported as ignored (with how to stop it being reported) rather
  than silently swapped.

- **The published TypeScript types did not resolve for a consumer.**
  `dist/index.d.ts` opens with `import Database from 'better-sqlite3'` — the
  store handle is the first argument of most of the public API — but
  `@types/better-sqlite3` was a devDependency, so it never installed alongside
  the package and that module had no types on the consumer's side. With
  `skipLibCheck: false` the consumer got `TS7016: Could not find a declaration
  file for module 'better-sqlite3'` pointing into *our* declaration file; with
  `skipLibCheck` on — the common default — it failed more quietly and worse:
  `ensureDatabase` returned `any`, so every misuse of the store handle compiled
  silently and the type surface the Programmatic API section advertises was
  untyped at its centre. The types package is now a runtime dependency, which is
  what a `@types/*` entry named by published declarations has to be, and a test
  reads the emitted declarations and holds every module they import to
  installing with types.

- **The package's `require` entry point threw on load.** `main` and the
  `require` condition both pointed at a bundled `dist/index.cjs`, and that file
  could not be loaded on any supported Node: esbuild's CommonJS interop compiles
  `import chalk from 'chalk'` to `require('chalk').default`, which under Node's
  require(ESM) support is the module *namespace* rather than the chalk function,
  so the bundle threw `Cannot read properties of undefined (reading 'bold')`
  before exporting anything (on a Node without require(ESM) the same line threw
  `ERR_REQUIRE_ESM`). Every dependency doing the colouring, spinners and boxes is
  ESM-only, so the CJS artifact could not be produced correctly at all. Nothing
  in the suite loaded it — the smoke test imported `dist/index.js` by relative
  path — so it shipped broken with every test green. The package is now ESM only
  and both fields point at `dist/index.js`, which Node 20.19+/22.12+ loads from
  `require()` directly: `require('agent-replay')` works where it previously
  crashed, and on an older Node it fails with the standard `ERR_REQUIRE_ESM`
  rather than a TypeError from inside a dependency. `import` is unchanged.

- **`otel serve` dropped a whole OTLP signal without telling either side.**
  A request the receiver does not route — an unknown path, or any method other
  than `POST` — was answered with a bodyless `404`/`405` and nothing on the
  server console. The case that made it matter is not a typo: the exporters the
  README configures take a *base* endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`) and
  append the signal path themselves, so a harness whose metrics exporter is on
  POSTs `/v1/metrics` every export interval for the life of the session. The
  operator saw an idle receiver and the exporter saw an empty `404` it could not
  explain. Unrouted requests now carry a JSON body listing the endpoints that do
  exist (`405` also carries `Allow: POST`), `/v1/metrics` is named as a signal
  this receiver has no target for rather than reported as "not found", and the
  console announces each refused method+path once — with the exporter-side
  setting that stops the exports — rather than a line per interval. Trace and
  log ingest are unchanged, as are the status codes.

- **`otel serve` rejected a bad protobuf body with no reason at all.** The
  request handler took only the status from the protobuf path and answered a
  failure with zero bytes — the reason ("invalid protobuf body") had already
  been computed and was discarded. An exporter got a bare `400` and whoever was
  debugging it had nothing to go on, while the OTLP/JSON path returns the
  message and the handler's own error branch already answers a protobuf request
  with a JSON error body. Failures now say why, on `/v1/traces` and `/v1/logs`
  alike; a success is still an empty protobuf response per the spec.

- **`import` of a Codex rollout could report fewer records than it read.**
  The importer decided `imported++` in one place at the bottom of its loop but
  wrote `skipped++` into the individual branches, and one branch was missed: a
  user message whose text is blank set `contributed = false` and was counted as
  neither. `imported + skipped = records` is the invariant this importer's own
  comments appeal to three times over, and it did not hold — the tally the
  command prints quietly under-reported, with no indication which record went
  missing. It now decides once, `if (contributed) imported++; else skipped++`,
  the shape the sibling `claude-transcript` importer already uses, which cannot
  miss a branch. Three existing assertions had encoded the old numbers, on the
  reasoning that `session_meta` was "a header, not a tallied record" — it is
  tallied, and the blank turn dropping out was what made those numbers come out.

- **Six call sites still cut producer text at a bare code-unit offset.**
  `truncate` has been surrogate-safe for a while, but a check-report value, an
  event-protocol warning preview, the AI panel's fallback rendering, a stored
  `raw_response`, the `diff --ai` explanation fallback, and a Codex tool result
  had each reimplemented the cut with a plain `slice`. Each could land between
  the halves of an astral character and leave a lone surrogate — rendered as
  U+FFFD, and only at some values, since whether it happened depended on the
  length of an unrelated field earlier in the same payload. The two stored ones
  mattered most: a lone surrogate there does not misdraw once, it round-trips
  into `show`, `export`, and the next prompt built from that trace. All six now
  call the shared helper, so they also mark the cut instead of stopping
  mid-value.

- **`diff --ai` ignored `ai.max_tokens`.** The setting is validated, stored,
  priced by the cost estimate, and honored by `eval --ai` — but the diff path
  sent a hard-coded `max_tokens: 1024` at the *request* level, which overrides
  the client option, and the command never read the config value in the first
  place. A comparison with many differences therefore got a truncated reply,
  JSON extraction failed, and the fallback reported `better_trace: "neither"`
  with "Could not parse structured response" — a verdict the model never gave,
  billed in full, with no supported way to raise the ceiling. Both AI paths now
  honor the configured value and share the same 1024 default.

- **`export <trace-id> --format golden` silently exported nothing for a
  fork.** The golden path drops forks so that one stray fork on a shared store
  cannot poison a baseline gathered in bulk — but it applied that rule to a
  trace the caller had named outright too. The command looked the trace up,
  found it, and then wrote `[]`, exited `0`, and reported "No traces matched"
  for a filter the caller never passed. `check --trace` already follows the
  opposite rule for the same reason: a trace named by id is used whatever its
  lineage. Bulk exports are unchanged.

- **`eval` dropped the evaluators that failed to run.** Each throwing
  evaluator was recorded, and then reported only if *every* one of them
  failed. A partial failure — some AI presets erroring at the provider while
  others returned — printed results containing nothing but the successes: under
  `--json`, an array of passes describing a run in which several evaluators
  never looked at the trace, and on the human path a summary reading "3 passed,
  avg score: 100%". The exit code said 1, but the report said the run was
  clean. Both now name what failed to run; under `--json` on stderr, so stdout
  stays a parseable document.

- **`guard check` read "is a human present?" from the wrong channel.** It
  tested `process.stdout.isTTY` — but stdout is the command's *machine*
  channel, carrying the JSON verdict this README documents capturing "so it
  scripts cleanly". Any wrapper that captured it (`v=$(… | guard check)`, a
  pipe into `jq`) therefore made stdout a pipe, so an operator sitting at a
  live terminal was reported as "no TTY" and every `require_review` failed
  closed without ever prompting — the interactive review path was unreachable
  in the command's own documented usage. The prompt is written to stderr and
  the answer read from `/dev/tty`, so stderr is now the signal.

- **`guard test` did not count `require_review` in its summary.**
  `require_review` fails closed without an approval, so it blocks, but the
  closing summary counted only `deny` and `warn`. A trace whose matches were
  all `require_review` listed them step by step and then printed a summary that
  said nothing at all — reporting zero for matches that stop the run, on the
  one line a reader scans to answer "would this have been blocked?".

- **Bounded display fields were measured in code units, not terminal
  columns.** `truncateToWidth` was introduced because every bound in the
  renderers is a *width* — a boxen border, a table column, the timeline gutter
  — but four call sites were still cut with the code-unit `truncate`. A CJK
  character is one code unit and **two** columns, so a name cut to "60" drew
  120 columns: the `show`/`replay` trace header wrapped inside its own box and
  grew extra unlabelled lines of border (the failure the bound was added to
  prevent), a wide step name pushed the timeline and tree gutters out of
  alignment, and a wide agent name overflowed its column in the `dashboard`
  trace list. The trace header (agent name, version, tags, error), the timeline
  and tree step names, and the dashboard agent column now all measure columns.

- **`truncateJson` could leave a lone surrogate.** Its twin `truncate` cuts at
  a surrogate-safe index; this one sliced at a bare offset, so a cut landing
  between the halves of an astral character (an emoji, most CJK extension
  blocks) produced half a character. Whether that happened depended on the
  exact offset — on the length of an unrelated key earlier in the JSON. It
  matters most where the output is not for a terminal at all: `truncateJson`
  builds the step payloads in the evaluator prompt, where a lone surrogate is
  not valid UTF-8 and reaches the provider as U+FFFD.

- **Four smaller `check` contract defects.** A baseline whose `steps_summary`
  holds a `null` or a bare string died inside the comparison with *"Cannot read
  properties of null"*, naming neither the file nor the entry — the same
  diagnostic failure the adjacent shape guard exists to prevent, one level
  deeper. `check --json` with `--golden` omitted printed a bare commander usage
  line to stderr and produced nothing on stdout, breaking the documented
  `--json` contract; the command's own guard for that case existed but never
  ran, because a `requiredOption` is enforced before the command body. `check
  --trace <missing>` exited 2 where the README's table and `diff` both say 1, so
  a CI script splitting 1 (a regression) from 2 (a broken gate) read a typo'd id
  as a broken gate. And a divergence whose baseline entry simply lacked the
  field emitted no `golden` key at all, against a type that declares it
  required.

- **`export --format golden` to stdout suppressed both baseline-trust
  warnings.** The warning was emitted only for a `--output` file, on the stated
  reasoning that it "would be noise in the middle of someone's pipeline" — but
  it is written to **stderr**, so it could never reach a redirected or piped
  stdout. There was no noise to avoid, and the condition instead re-created the
  exact false green the warning exists to prevent: `export --format golden >
  golden.json` is an ordinary idiom, and it produced a baseline built from
  failed or in-flight runs, or an entirely empty one, with no signal at all.
  Two byte-identical baselines, one warned about and one not, purely by how the
  bytes were routed.
- **`diff` rendered a type-only difference as two identical cells.** The table
  printed values with `String(v)`, which collapses the very distinction the
  comparison had just used to decide the traces differ: a step output of the
  string `"42"` and one of the number `42` both printed `42`, under a header
  reading "1 difference(s) found" — so the only way to see what changed was to
  re-run with `--json`. That is the failure the diff renderer's windowing was
  written to end, arriving by another route. When both sides render to the same
  text, their JSON form is shown instead, so ordinary values keep their plain
  rendering.

- **Live capture stored causal references to steps that do not exist, and `why`
  then invented a different antecedent and presented it as fact.** The live
  path checked a `parent_step`/`caused_by_step` for *range* (a positive integer,
  strictly earlier) but never for *existence* — so a producer whose counter
  skips, or the ordinary case where one step is rejected for a bad `step_type`
  and the next references it, stored a dangling number. `why` looked it up,
  found nothing, and fell through to its "prior decision" fallback with no hint
  that the recorded cause was unresolvable; `show --tree` printed `caused by #2`
  for a step not in the trace, so two surfaces contradicted each other about one
  trace; and `export` produced a trace `ingest` **refuses** — the tool rejecting
  its own output. `ingest` already checked existence, and the decision-tracing
  spec requires it. The reference must point strictly earlier, so the step is
  already stored by then and existence is answerable at write time; a dangling
  one is now dropped and reported by `record` and `run`.

- **A producer's string was re-typed by what it happened to say.** `input` and
  `output` stored a string as-is whenever it parsed as JSON, so the type a value
  came back as depended on its content: `"42"` returned the number 42, `"true"`
  the boolean, and — the damaging one — a tool that returned the four-letter
  text `null` was stored as JSON null and became **indistinguishable from a step
  that produced nothing**, with `show` rendering no Output line at all for it.
  Pass-through is now restricted to a string that is genuinely an object or an
  array, which is what the behavior was written for (OTel attributes and harness
  payloads carrying JSON text) and what every reader of those columns expects.
  A scalar-looking string stays the string it was.

- **Live capture dropped a forward causal reference in silence.** A
  `parent_step` or `caused_by_step` that does not point strictly earlier is
  already refused at write time — `causalWalk` depends on the graph being
  acyclic, and a forward reference made `why` present time-travelling causality
  as fact — but the live `record`/SDK path discarded it without a word, while
  `ingest` rejects the same input loudly with the field named. It was the one
  door where a producer could send a reference, be told nothing, and later find
  it missing. It is now reported the way an unusable numeric field beside it
  already is: the field is dropped, the step is kept, and the warning names both
  the field and why.

- **The OTLP logs endpoint reported a rejection only when the WHOLE batch was
  unrecognized.** The guard was "nothing mapped", so a batch in which anything
  at all was recognized answered a bare 200 and the rest was discarded silently
  — and the drift this reporting exists for is normally partial, since a CLI
  version bump renames some events and keeps others. `partialSuccess` now
  carries the count whenever any record was not recognized, naming how many of
  how many. (Scope: this counts records whose event *name* the mapper does not
  recognize. One carrying a known prefix with an unknown suffix still passes the
  filter and is not counted; narrowing that needs per-record reporting from the
  mapper.)

- **A span id repeated inside a single OTLP batch was stored twice.** The merge
  path already refuses a span id it saw in an *earlier* batch — that is what
  makes an exporter's retry safe — but the check compares against what is
  stored, so it cannot see a duplicate that arrives twice inside one payload. A
  batch listing the same span twice became two steps sharing an `otel_span_id`,
  with its tokens counted twice (3 steps and 45 tokens where 2 and 30 were
  correct). The identity and the argument are the same on either side of a batch
  boundary, so the same rule now applies within one. A span carrying no id is
  left alone, since there is nothing to key on.

- **The Codex importer counted an orphan tool output as imported.** A
  `function_call_output` / `custom_tool_call_output` whose `call_id` pairs with
  no call record lands in no step — routine when a rollout is head-truncated, or
  when the call record itself was unparseable — but it was reported as imported
  anyway, crediting the store with content it does not hold. The Claude
  transcript importer already tracked exactly this for its own orphan tool
  results; Codex had no equivalent. Such a record is now counted as skipped, so
  `imported + skipped = records` still holds.

- **`hook --enforce` labelled its decision with an event name the harness will
  not match.** Routing deliberately ignores a `hook_event_name` it cannot route
  and falls back to the event registered on the command line — that fallback
  exists because an unroutable name used to skip every gate. But the response
  formatter read the payload's name directly, so a deny could come back labelled
  with the very name that had just been ignored. Claude Code keys
  `hookSpecificOutput` on a matching `hookEventName`, so such a decision is not
  applied, and the process exits 0, so the call runs. Reproduced with
  `tool.before`, `"PreToolUse "` (trailing space) and `pretooluse`. The response
  now carries the name routing actually used.

- **A rubric with `threshold: 0` reported "All criteria passed" at 0%.** The
  Details column selects failing criteria with `score < threshold`, which cannot
  express "did not pass" when the threshold is 0 — nothing is below it — so
  every criterion that scored zero was folded into a claim that they had all
  passed. That is the same false summary the line was first written to fix for a
  hardcoded 0.7, reappearing at the other end of the range. A criterion that
  scored zero is now always named. (The overall PASS at 0% follows from the
  author's own `threshold: 0`; a rubric whose gate can never fail is worth a
  refusal of its own, which this does not add.)

- **`hallucination-check` reported "70% PASS" for a run in which every step
  failed.** The criticality rule that stops a failed run from passing only
  covers a trace that ended badly by status or by a trace-level error. A run
  recorded `completed` took the other branch, where the error criterion scores 0
  but is not critical — and 0.4 + 0.3 + 0.3·0 is *exactly* the 0.7 threshold, so
  on that branch the criterion could not fail the preset however bad the run
  was. The output named the failing criterion in the Details column beside the
  word PASS, and `eval` exited 0. A run where nothing succeeded is not a
  recovered error, whatever status it recorded, so it is now critical. Partial
  failure still passes, deliberately: that is the documented intent (one failed
  shell command in an imported session must not fail the preset), and narrowing
  it further would mean re-weighting a rubric users gate CI on, moving every
  score.

- **`record --format gemini-stream` and `--format codex-exec` dropped lines and
  reported "Warnings: 0".** The native protocol counts and reports every line it
  rejects, precisely so a silent loss is impossible; the translated formats had
  no counter at all. A `tool_result` that paired with no open tool call took the
  tool's **output** with it — the call was stored looking clean and
  output-less — and an event type the translator had never heard of vanished
  the same way, both under a clean summary at exit 0. Translators now say why
  they produced no events, and `record` reports it. The distinction matters:
  producing nothing is sometimes correct (a repeated `init`, a line that only
  accumulates usage), so an empty result alone could not be used as the
  signal — flagging those would train the reader to ignore warnings.

- **`import --replace` deleted the forks of the trace it replaced.** A fork
  inherits its parent's `session_id` *and* its `source_format`/`source_file`
  metadata, so every fork of the session matched the "already imported" key and
  was deleted alongside the parent — and `--replace` is the documented way to
  refresh a transcript that has grown, so the routine refresh destroyed the
  user's what-if sandboxes. Excluding forks from that lookup is not enough on
  its own: `parent_trace_id` is `ON DELETE SET NULL`, so a surviving fork would
  be silently **promoted to a real run**, and `parent_trace_id IS NULL` is the
  only thing marking a fork as never-executed — golden export, `check`, `stats`
  and `watch` all rely on it, so the fork would start counting as real spend.
  Re-pointing the fork at the new trace is not available either, since a
  refreshed transcript may have different steps and `forked_from_step` would no
  longer mean what it meant. `--replace` now refuses when forks derive from the
  trace, naming them and the two ways forward. Every sibling lookup in the
  codebase already excluded forks for this reason; this one door did not.

- **A guardrail policy with an empty `*_contains` needle blocked every step.**
  `''` is a substring of every string, so `guard add --pattern
  '{"name_contains":""}' --action deny` was stored without complaint and then
  denied `read_file`, every LLM call, and everything else — a fail-closed that
  is really fail-broken, and reachable from an ordinary authoring slip
  (`--pattern "{\"name_contains\":\"$TOOL\"}"` with `$TOOL` unset in CI kills
  every tool call in the session). It also falsified the warning `guard add`
  prints for `output_contains` policies, which says they cannot block live: this
  one could. The fold-away sibling — a needle of only zero-width characters —
  was already rejected for exactly this reason, and the literal empty string had
  been explicitly excluded from that check. It is now refused at write time,
  and a policy already stored fails closed with a reason that says the pattern
  is unusable rather than claiming the step's name matched.

- **A store in a read-only directory now says why it cannot be opened.** The
  message was "check file and directory permissions", which does not convey the
  surprising part: the database runs in WAL mode, and WAL keeps its index in a
  `-shm` sidecar SQLite creates **next to** the database — so the DIRECTORY must
  be writable even for a command that only reads. An operator who deliberately
  locked a store down with `chmod 500` had no way to guess that from the old
  wording. There is no read-only mode to offer instead: opening the store with
  `readonly: true` fails identically, for the same reason.

- **Table and diff cells were budgeted in code units, not columns.** Three
  copies of `truncate` existed — in `json.ts`, `table.ts` and
  `diff-renderer.ts` — and all measured UTF-16 code units against what is a
  **column** budget (`colWidths`). A CJK character is one code unit and two
  columns, so a cell built to a 40-unit budget rendered 80 columns wide and
  pushed the table border out. `table.ts`'s copy was additionally not
  surrogate-safe, so it could cut an emoji in half — the exact defect the diff
  renderer had already been fixed for, in a sibling file that had its own copy.
  All three now share one width-aware truncation, which walks by code point and
  so cannot split a pair either.

- **`export` and `check --since` still widened on an empty value.** `list` was
  fixed for this; its siblings were not. It matters most in `export`, which
  WRITES: `export --agent "$AGENT"` with the variable unset silently dumped the
  whole store into a file the caller believed held one agent's traces — and a
  golden baseline built that way then gates on runs it was never meant to cover.
  `check --since "$WINDOW"` unset gated over the entire store instead of the
  window, green for the same reason. Both now refuse at exit 2.
- **Four selector flags were still skipped entirely on an empty value.** The
  passes above fixed the flags that *widen* when emptied; these four do
  something worse, because they are read with a bare truthiness test and so
  simply VANISH — the command then does something else and calls it success.
  `eval --rubric ""` and `eval --preset ""` fell through to "No evaluator
  specified. Running all built-in presets" and reported the PRESETS' verdict,
  exit code and all, for a run the caller believes was scored against what they
  named: a CI gate that goes red blames a rubric that was never opened, and one
  that goes green certifies a rubric that never ran. `export --output ""` took
  the other branch and wrote the whole export to stdout — no file, no path in
  the success line, exit 0 — so the next step reads a golden baseline that does
  not exist. `list --sort ""` skipped the very check beside it that rejects an
  unknown sort field "rather than silently falling back to the default order",
  and a listing ordered by start time reads exactly like one ordered as asked.
  All four now refuse at exit 2. (Unchanged: the deliberate convention that an
  empty *numeric* value means 0 where 0 is legal — `guard add --priority ""`,
  `eval --max-cost ""`, `replay --speed ""`. These four name a thing, and
  nothing is named by the empty string.)
- **`replay --pause` was accepted and silently ignored off a terminal.** The
  pause returns immediately when stdin is not a TTY — correctly, since there is
  no one to press a key and blocking would hang a pipeline — but it said
  nothing, so `replay <id> --pause | less`, or a `--pause` left in a CI script,
  replayed straight through at full speed and reported exactly the success a
  paused run reports. It now says the flag has no effect, the same one-line
  warning `export` prints for `--with-snapshots --format golden`. The replay
  itself is unchanged; this is a warning, not a refusal.
- **`replay` reported success for a step window it could not replay.** It
  printed "No steps in the specified range" on stderr and then exited `0`, so
  `replay <id> --from-step "$N"` in a script was told the run succeeded having
  replayed nothing — the one outcome the command exists to rule out. `fork`,
  the sibling taking the same `--from-step` against the same trace, has always
  refused this at exit `1`. `replay` now does too, and names the range that
  does exist ("this trace has steps 1-8") the way `fork` names its max step, so
  the line is enough to correct the command. An empty `list` is unchanged at
  exit `0`: that is a filter over a corpus legitimately matching nothing, not a
  request that could never be served.
- **`watch --interval` had the same 32-bit timer overflow `dashboard --refresh`
  was just capped for.** It validated only that the number was positive, so
  `--interval 999999999999` — plainly "poll almost never" — was clamped by Node
  to 1 ms and polled SQLite about a thousand times a second. Now refused, with
  the same reasoning: a value that inverts the request is not clamped quietly.

- **Five more commands could still be made to forge a line of output.** The
  first pass converted `show`, `replay` and the tables; `stats`, `decisions`,
  `why`, `watch` and `guard test` were missed, and they print at column 0 with
  no gutter at all — so an agent named `evil\nagent-replay: store verified
  clean` produced, under `stats`' "By agent" heading, a line indistinguishable
  from this tool's own output. All five now escape single-line fields, and the
  producer-controlled names they render are bounded, as the trace table and
  timeline already were. The `show`/`replay` header panel got the same
  treatment: a newline there inserted an unlabelled line inside the box, and an
  unbounded agent name turned the header into forty wrapped lines of border
  before the steps the user asked for.

- **Hook capture wrote steps to the wrong trace**, for any session whose newest
  trace carries an ISO basic-format offset. The same `julianday()` NULL that
  broke `list` ordering also reached the hook adapter, whose own comment cited
  `getMostRecentRunningTrace` as the reason to rank by parsed instant — but which
  still used the bare form. Here it is not a display bug: the hook WRITES. A tool
  call landed on an older run, and because the closing-event lookup does not
  filter on status, the tool RESULT could land on an unrelated trace while the
  real step stayed open forever — and `hook` disagreed with what `list` and
  `watch` showed. The OTel receiver's cross-batch merge lookup had the same
  defect in the ASC direction (NULLs sort first there, so a basic-offset trace
  always won "oldest merge target"), and `import`'s prior-trace ordering still
  compared raw bytes, having never had the earlier fix at all. All four now use
  the repaired expression.

- **`show`, `init`, `ingest` and `replay` crashed at a terminal width of 1 or 2
  columns.** `boxen` reads `process.stdout.columns` itself and subtracts its
  border width, computing a negative count and throwing `RangeError: Invalid
  count value: -1`. `process.stdout.columns` is whatever the environment
  reports, not necessarily a real terminal width, and a wrong one must degrade
  the drawing rather than stop the command. The panels now fall back to plain
  text — the content is what the user came for; the border is decoration.

- **The store file itself is now owner-only (`0600`).** The directory mode was
  the only thing protecting trace contents — prompts, tool inputs, tool outputs
  — and `traces.db` was created `0644` by the umask, so the protection vanished
  whenever the directory was not `agent-replay`'s to tighten: `mkdir -p
  /var/lib/agent-replay && agent-replay init --dir …`, a mounted volume, any
  pre-created path. The mode now goes on the file, where the content is, so it
  holds whoever made the directory. Set at creation only — a store an operator
  deliberately opened up stays open.
- **`demo --reset --dir "   "` cleared the store named by `AGENT_REPLAY_DIR`.**
  The guard that stops a destructive command from inheriting its target from the
  environment tested the raw `--dir` option for truthiness, while path
  resolution had already decided a blank value means "not named" and fallen
  through to the environment. The two disagreed, so the guard printed nothing
  and the environment's store was cleared. Both now ask the same question.

- **`init` stamped `version: "0.1.0"` into every new `config.json`.** The
  package has been 0.2.0 for a while; the literal was left behind in two places
  (that field, and the CLI's `--version` fallback). Nothing reads the config
  field back, which is the only reason it did no damage — a stored value being
  false is still a defect. Both now read the shipped `package.json`, resolved
  once by walking up to the nearest one, and a test fails the next time a
  literal is left behind.

- **Opening a second store closed the first one's handle.** `ensureDatabase` is
  a documented export, and the connection cache was a single slot keyed on
  nothing: opening a second path closed the connection behind the first, so a
  library caller's first handle began throwing *"The database connection is not
  open"* from code that had done nothing wrong. The CLI opens one store per
  invocation, which is why nothing noticed. Connections are now keyed by
  resolved store path, so two stores can be open at once and the same path still
  returns the same connection.

- **`stats` reported an average duration without saying what it averaged.** A
  duration is unmeasurable for a trace that is still running, one whose
  `ended_at` precedes its `started_at`, or one whose timestamps no format
  parses — and `AVG` skips those. So `Avg duration: 5.0s` could describe a
  single trace while `Traces: 100` sat directly above it, in the panel and in
  the `--json` a CI job reads. The denominator is now reported: the human panel
  appends `(over N of M)` when the two differ, and the JSON carries
  `avgDurationSample` alongside `avgDurationMs`.

- **Non-Latin text rendered wrongly in two different ways.** The timeline
  budgeted its width in UTF-16 code units while the budget itself came from
  `process.stdout.columns` — two different units. A CJK character is one code
  unit but two columns, so a line built to a 90-unit budget rendered about 193
  columns: it wrapped several times and broke the `│` gutter that makes the
  timeline readable. It now measures with `string-width`, as `cli-table3` and
  `boxen` already did (measured 193 → 107 columns against a ~100 budget), and
  `string-width` is now a direct dependency rather than one relied on
  transitively. Separately, the dashboard's blessed screen was created without
  `fullUnicode`, so blessed substituted `?` for every wide or astral character
  in its draw path — a Japanese agent name showed as `??????????` in the Recent
  Traces panel while `list` displayed the same name correctly.

- **One trace could make the whole listing unreadable.** `agent_name` and a
  step's `name` are producer-controlled and were rendered unbounded, while every
  neighbouring field was windowed. cli-table3 sizes a column to its widest cell,
  so a single trace with a 5,000-character agent name widened **every** row of
  `list` to over 15,000 columns — the traces the user was looking for became
  unreadable because of a neighbour — and a 500 KB step name emitted one line of
  500,031 columns in `show`, scrolling the step's real input and output away
  above it. Both are now bounded (40 and 80 characters), matching the limits the
  dashboard and `policyTable` already applied.
- **Truncation could cut an emoji in half.** `truncate` sliced at a fixed
  offset, which can land between the halves of a surrogate pair and leave a lone
  surrogate the terminal shows as `�`. Whether it happened depended on the exact
  cut point, so the same value rendered correctly at one terminal width and as
  mojibake at the next. The JSON windowing helper already had a surrogate-safe
  cut for this reason; `truncate`, used by far more call sites, did not. It now
  shares that cut, and the duplicate helper is gone.

- **Opening a store changed the permissions of a directory the tool did not
  create.** The store is made owner-only because `config.json` holds API keys in
  plaintext — but the narrowing ran on every open, against whatever path
  `--dir` or `AGENT_REPLAY_DIR` named. Pointing at an existing shared directory
  silently stripped group and other access from it, `--dir .` did that to the
  user's working directory, and even read-only commands did it: `agent-replay
  list` altered the permissions of a directory it was only reading. Only a
  directory this tool creates is now given a mode; a pre-existing one belongs to
  whoever made it. `init` no longer pre-creates the directory either, so
  creation and its permissions live in exactly one place — previously `init`
  made it with the plain umask mode and it became private only as a side effect
  of the blanket re-chmod.

- **A broken `config.json` was reported as a missing one.** Every read failure —
  a stray trailing comma from a hand-edit, an unreadable file, a directory in
  its place — collapsed to `null`, which every config command rendered as *"No
  configuration found. Run `agent-replay init` first."* `init` then answered
  *"Already initialized … Use --force"*, so the two messages contradicted each
  other, neither named the parse error, and the user was pointed at a command
  that refuses to run. The stored API key was still sitting in the file the
  whole time, so `test-ai` and `eval --ai` reported "No AI provider configured"
  about a key that was right there. A config file that exists but cannot be used
  is now its own error, naming the file and the parse position.
- **`config set` permanently deleted an unrelated invalid value.** The reader
  drops unusable values so that one bad key cannot make the whole config
  unreadable — but `config set` wrote that sanitized copy back, so setting any
  key destroyed the invalid `ai.max_tokens` the user was being warned about.
  The typo became unrecoverable and every later `config list` reported a clean
  config. Writers now start from the file as it actually is.
- **`config set <key> ""` stored a blank that looked set and behaved unset.** An
  empty API key was displayed as `***` by `config get` and `config list` while
  every check downstream treated it as absent — so `test-ai` told the user to
  set the key they had just set. An empty `ai.model` was worse: it was sent to
  the provider AS the model name (`Testing anthropic ()`), but only when
  `ai.provider` was explicit, since the auto-detect path guarded on truthiness
  and the explicit path did not. Empty values are now refused at `config set`,
  and a blank key or model already on disk is treated as unset by both paths.

- **`dashboard` hung forever when there was no terminal**, after writing
  alt-screen and mouse-tracking escape sequences into whatever its output was
  redirected to. It built the full-screen TUI unconditionally, so with stdin a
  pipe there was no keypress to exit on: a CI job that ran it never finished,
  and its log filled with control codes. It now refuses with exit 2 and points
  at `stats --json`, the way `guard` checks for a terminal before prompting and
  `replay --pause` skips its wait.
- **`dashboard --refresh` accepted values that turned into a busy loop.** Node
  clamps a timer delay above 2,147,483 ms to **1 ms**, so `--refresh
  999999999999` — plainly "refresh almost never" — re-ran every dashboard
  aggregate about a thousand times a second, the exact inverse of the request.
  Values above the timer maximum are now refused rather than clamped, the same
  reasoning the command already applied to a malformed value. Argument
  validation deliberately runs before the terminal check, so a typo is still
  reported to the script that made it.

- **A newline in a trace could forge a line of output.** A trace is written by
  the agent under test, so every rendered string is untrusted — and `safeText`
  deliberately preserves `\n` so a rendered block keeps its shape. On a
  one-line row that was a forgery primitive, and both forms reproduced in `show`
  and `replay`:
  - a step name of `safe\n  ├─ 99  ➡ Output  "…"` drew a **fabricated step
    row**, indistinguishable from a real one;
  - an error of `line1\nagent-replay: all checks passed` drew a line at column
    0 with no gutter, reading as **agent-replay's own output** in the
    operator's terminal and CI log.

  `escapeForMessage` already existed for exactly this reason and the render
  sites' own comments pointed at it, but the single-line renderers never
  adopted it. They now use a named `safeLine` for fields that are single-line by
  construction (step name, model, decision, agent name, evaluator, policy name).
  Errors are handled differently on purpose: they keep their line breaks, since
  a stack trace or a Windows child's CRLF output is shaped information, and
  every continuation line is now drawn inside the step's gutter, where it is
  visibly trace content rather than tool output. Payload blocks (`input`,
  `output`, JSON) stay lenient — there a newline is content, not structure.

- **`list` printed the newest trace last, `list --limit 1` returned the wrong
  trace, and `watch` attached to the wrong running run** — for any trace whose
  `started_at` carries an ISO-8601 basic-format offset (`+0200`). Ordering used
  `julianday(started_at)`, which returns NULL for that form, so those rows had
  no instant to sort by: they clustered at one end of every result and were
  ranked among themselves by BYTES, which is exactly the failure the
  parsed-instant ordering exists to prevent. `--limit` then dropped the wrong
  rows, and `watch` with no arguments showed a live session doing nothing while
  the real run went unwatched.

  Ordering now uses the repaired expression that already handles the format for
  durations. That was previously ruled out because schema v4 indexes the bare
  `julianday(started_at)`, so wrapping the column would have made every ordered
  query full-scan — so **schema v5 adds an expression index over the repaired
  expression**, and the ordering is now both correct and keyed. The migration is
  additive (a new index; no table is rewritten) and v4's index is kept, since
  `SINCE_PREDICATE`'s indexed disjunct still matches it. A test asserts the
  query plan, because an ordering that is correct but unindexed would look
  identical in behavior while scanning the whole store.

- **A `--dir` or `AGENT_REPLAY_DIR` beginning with `~` created a directory
  literally named `~`.** A shell expands the tilde before the CLI sees it, so
  this only bit where nothing does — a quoted `--dir '~/traces'`, a hook or
  settings JSON file, a Docker or systemd `Environment=`, a CI `env:` block.
  The store was created under the working directory instead of the home
  directory, and a read command pointed at it reported an empty store at exit 0
  rather than the traces the user asked for. A leading `~` or `~/` now expands;
  `~otheruser/` is deliberately left alone, since resolving another account's
  home is not portable.
- **A whitespace-only `AGENT_REPLAY_DIR` created a directory named spaces.** The
  guard that treats a blank store path as unset tested `!== ''`, so `"   "`
  slipped past it — the same hazard the guard exists to prevent, wearing a name
  that is nearly invisible in a directory listing. The "is this set at all?"
  decision now uses the trimmed value; the path itself is still passed through
  untrimmed, since a directory name may legitimately end in a space.

- **`list` widened to the whole store when a filter flag was given an empty
  value.** `list --agent "$AGENT"` with `$AGENT` unset returned every trace at
  exit 0, which reads exactly like a correct narrow result — the same silent
  scope-widening already refused by `check` for `--agent`/`--agent-exact` and an
  empty `--fields` list, and by `stats` for `--since`. `list` is where a script
  is most likely to build a filter from a shell variable, and its own comment
  claimed it mirrored `stats`. An empty `--status`, `--agent`, `--tag`,
  `--session`, or `--since` is now a usage error at exit 2.

- **`--since` included traces before the cutoff and dropped traces after it**,
  for any trace whose `started_at` carries an ISO-8601 *basic*-format offset
  (`+0200`) — what `date +%FT%T%z` emits and what `ingest` stores verbatim.
  `SINCE_PREDICATE` used a bare `julianday()`, which returns NULL for that
  form, so those rows fell back to the byte comparison the predicate exists to
  replace: wrong by the whole UTC offset, in both directions. A `+0200` trace
  an hour before the window was counted in, and a `-0200` trace inside it was
  counted out. This reached every command that windows by time — including
  `check --since`, a CI gate that reported "2 trace(s) checked" over the wrong
  two traces. The row side now retries the basic form as the extended one, the
  same repair `julianDayExpr` already made for durations and the same one
  `parseSinceToIso` already made for the *bound*. The repair is confined to the
  branch that runs only when the bare `julianday()` returned NULL, so the
  indexed disjunct still matches schema v4's expression index exactly — checked
  with `EXPLAIN QUERY PLAN`, and asserted in a test. A timestamp no form can
  parse still fails open, as before.

- An AI provider's 4xx was reported as "Server error". A malformed request, an
  unknown model name or a wrong endpoint therefore read as a provider outage, so
  the natural next step was to wait and retry when the fix is local. Those are
  now "Request rejected (HTTP 400): ...". Retry behavior is unchanged — retries
  already keyed off a status of 500 or above, so a 4xx was never retried; only
  the message pointed at the wrong party.

- `check --agent ""` and `check --agent-exact ""` silently checked every agent
  instead of the one intended. A CI script writing `--agent-exact "$AGENT"` with
  an unset shell variable therefore widened its gate from one agent to all of
  them and reported green. An empty value is now a usage error, matching what
  this command already does for an empty `--fields` list — a narrowing flag that
  quietly stops narrowing hides the mistake.

- `eval --json` emitted `[]` when every evaluator failed to run — an empty array
  that reads to a pipeline exactly like a clean run with no evaluators
  (`jq length` gives 0, `jq '.[]|select(.passed==false)'` gives nothing). With an
  invalid API key, `eval --ai --json` produced that while all six AI evaluators
  had failed on authentication. Zero results is only reachable when evaluators
  threw, so it now uses the same `{"ok": false, "error": ...}` shape as every
  other refusal, with each evaluator's cause listed in `hints`.

- `import` no longer hangs forever on an input that is not JSONL. A source with
  no newlines had nothing bounding it, so a binary file passed by mistake
  buffered its whole self and a character device such as `/dev/zero` never ended
  at all — measured, still running after 25 seconds under a 512 MB heap cap, and
  the previous whole-file reader hung there too. A single line over 64 MB (far
  beyond any real JSONL record) now fails in about a second with a message
  naming the limit; legitimate large transcripts are unaffected.

- `import` could not read a non-seekable source, and failed silently on one. The
  new streaming reader read at explicit byte offsets and trusted the file's
  reported size: reading at an offset throws `ESPIPE: invalid seek` on a pipe, so
  `import /dev/stdin` broke, and a FIFO reports a size of 0, so the read loop
  never ran and the import announced "nothing importable found" for a source that
  had content — silent loss rather than an error. Reads are sequential now, with
  end-of-input taken from a zero-length read, which is the only signal true for a
  regular file, a pipe and a FIFO alike.

- A guardrail pattern made only of zero-width or soft-hyphen characters matched
  **every** step. Folding strips those, so the needle became the empty string,
  which is a substring of everything — a deny policy blocked `read_file` and all
  else, reporting "name contains ''" as though the name really matched. A stray
  zero-width character pasted into a pattern is exactly how that happens. Such a
  needle is now treated as an unusable pattern, taking the same path a non-string
  one does: still fail-closed for a blocking policy, but saying why.

- `show --tree` now states a step's depth once the indent stops growing. The
  indent is capped so a deep tree renders at all, but past the cap every level
  draws the same 122 spaces — a step at depth 60 was indistinguishable from one
  at depth 41, which traded a crash for a quietly wrong picture of the nesting.

- Two concurrent `guard add` calls for the same policy name could still surface
  the raw `UNIQUE constraint failed: guardrail_policies.name` — the message the
  duplicate-name pre-check exists to replace. That check reads outside a
  transaction, so both processes can pass it and one then hits the constraint;
  measured, four racing processes leaked it in 1 of 6 trials. The insert now maps
  that error to the same friendly message, so the loser of a race and a plain
  sequential duplicate get the same answer (0 of 10 trials leak it now).

- `show --tree` could not render a deeply nested trace. The walk recursed one
  frame per level of nesting, so a long parent chain blew the stack — measured,
  fine at depth 4,000 and "Maximum call stack size exceeded" before 8,000 — and
  the command printed a one-line error with no tree at all. That depth is
  reachable: a step's parent is the step before it in any run that threads
  causality linearly, and the tree is the view someone opens to understand a long
  session. The traversal is iterative now, and the indent stops growing past 40
  levels: it grew three characters per level, so a 20,000-deep chain summed to
  roughly 600 MB of leading whitespace and failed with "Invalid string length"
  while building the output. A 100,000-step chain now renders in 14.6 MB. Output
  for ordinary trees is byte-identical, verified against the recursive version on
  a mixed tree with branches, a self-parent and a cycle.

- **A guardrail policy could be evaded by a name that reads the same.**
  Matching compared raw code points after case folding, so
  `name_contains: "delete"` did not match the fullwidth `ｄｅｌｅｔｅ_user`, nor
  `delete_user` with a zero-width space or soft hyphen inside it — a policy an
  operator had written to block a tool silently allowed it. Both the needle and
  the step name are now Unicode-folded (NFKC, with zero-width and soft-hyphen
  characters removed), and a `name_regex` is tested against the raw and folded
  name alike. Folding can only make a policy match more, which is the safe
  direction for a guard.

- **`otel serve` was the only capture path that failed a run because a tool
  call failed.** The other eight store `completed` for a session containing a
  failed tool, the telemetry-ingest spec says a span error becomes a *step*
  error, and the eval design deliberately does not hard-fail a preset for a
  recovered step error — so the identical session scored 0.700 and PASSED via
  `ingest` while FAILING at exit 1 via OTel, and `check --golden` reported a
  status regression between two captures of one run. A trace's status now comes
  from its root span (or, on the log path, from a failed model call — the turn
  did not happen), and a failed trace always carries a reason: it was stored
  `failed` with `error: null`, so `show` rendered "✘ FAILED" with nothing to
  explain it.
- **A golden gate could match two unrelated runs.** An empty trace input hashed
  to the same key for every capture that records none, so two
  `record --format codex-exec` captures of different sessions compared as the
  same scenario — inventing a `tool_inputs` regression between them — and a
  `--strict` run reported `uncovered: 0` at exit 0 while a baseline it never
  exercised sat unused. An empty input is now unmatchable, which routes it to
  the loud "no candidate matched" refusal, and unmatchable baselines count as
  uncovered rather than being quietly excluded.
- `record --format codex-exec` named every tool step after the item *type*, so
  two unrelated sessions produced byte-identical step names and
  `check --golden --fields step_names` was inert for that format. It now prefers
  the tool or command name, as the codex-rollout importer already did.
- Neither stream translator carried the agent's final message into the trace
  output, so a capture stored `output: null` and its golden export carried
  `expected_output: null` while an import of the same session carried the text.
- Neither transcript importer set `ended_at`, so every imported session showed
  no duration forever despite each record carrying a timestamp.
- Values interpolated into single-line rows — the `check` gate's pass/regress
  lines and its divergence values, `watch`'s header, `ingest`'s insert error —
  used the renderer's escaper, which preserves newline by design. A newline
  there lets a producer (or a downloaded golden file) forge an extra `✔ … pass`
  row into a CI verdict. Those sites use the one-line escaper now.

- The terminal-status synonym table was a plain object literal, so a lookup
  resolved *inherited* keys: `status: "constructor"` returned Object's
  constructor — a function assigned to a field typed as a string, its
  native-code source echoed into the operator's warning, and the repair marker
  left unset so `run` treated it as the child's declaration. The table has a
  null prototype and the result is type-checked.
- Diagnostics that quote a producer's value now escape newline and tab as well.
  The renderer preserves both on purpose (a multi-line error keeps its shape),
  but a one-line warning that carries a raw newline lets a producer forge a
  second line reading exactly like this tool's own output, in the supervisor's
  terminal and CI log. Two escapers now: the lenient one for rendering, a
  stricter one for messages — which also restores tab/newline escaping the line
  preview lost when the two were unified.
- `skipped: unsupported protocol version …` still echoed a producer's raw ESC
  and C1; it was missed by the sweep that fixed its siblings.
- An OTLP batch carrying a first-time root was **skipped entirely** when all its
  child spans were duplicates, so a rootless synthetic trace was never upgraded
  and the root's own tokens were lost — the redelivery guard swallowing a
  genuine first delivery. Token totals across batches are now pinned by a test
  matrix over every combination of (root present/absent) x (already stored/new)
  x (synthetic target/real) x (new child spans/all duplicates), asserting the
  trace's step count and synthetic flag alongside the total — an earlier version
  checked only the total and so still passed with the synthetic upgrade
  disabled outright.

- **A child that declared failure and exited 0 was stored as a success.**
  Repairing every unrecognized terminal status to `failed` and then letting the
  wrapper's exit code override it laundered `status: "error"` back into
  `completed` — reopening the fail-open the repair was written to close, on the
  common shape of an agent that reports failure in-band while the process exits
  cleanly. A status is now read before it is repaired: recognizable spellings
  (`error`, `aborted`, `cancelled`, `Failed`, `ok`, `done`, `timed_out`, …) are
  folded onto the four stored statuses and treated as the producer's
  declaration, and only a value that maps to nothing is a repair the exit code
  gets to decide.
- The OTLP redelivery recompute was gated on whether the *surviving* steps
  carried token attribution, which is not the same question. When the
  redelivered span was the one carrying the tokens and the new span was a tool
  call — the most ordinary mixed batch — the survivors had none, the recompute
  was skipped, and the batch-wide totals were merged again. It is now gated on
  which endpoint the batch came from.

- **A tool result or model output could address the operator's terminal.**
  `JSON.stringify` escapes C0 controls but not C1 (U+0080-U+009F), and
  xterm/VTE/iTerm2 decode U+009B as CSI — so a step's `input`/`output` re-coloured
  the terminal from `show`, `show --tree` and `replay`, as did `show
  --snapshots`' environment and tool_state (keys as well as values), the AI eval
  panel's token counts, its JSON fallback and its box title, `watch`'s trace id,
  and a policy's match pattern in `guard list`. Escaping is applied at the shared
  stringify helper rather than per call site. Verified by writing a hostile trace
  straight into SQLite and scanning every display command's output byte-wise:
  zero raw control sequences. (`decisions` was already escaped; the change there
  is that a malformed option renders as JSON instead of `[object Object]`.)
- The same class in the messages that quote a producer's own bytes BACK — an
  unknown event type, an invalid `step_type` or `status`, an unparsable line,
  and the note `hook` prints for every tool call, where the tool name is chosen
  by the model. Those are written to a supervisor's terminal and CI log, and
  they carried raw ESC as well as C1: the protocol's line preview escaped only
  C0 and DEL while the renderer had been widened to C1, so two guards for one
  concept disagreed about what a control character is. They now share one
  definition (`escapeControlChars`), which `safeText` delegates to.
- The dashboard rendered a *different* agent name than is stored: its widgets
  run with blessed markup enabled, so `{red-fg}` in a name was consumed as
  formatting. Cells are escaped for blessed as well as for the terminal.
- `show`/`list` and `stats` disagreed about the same trace's duration — 2h
  against 5.0s — because SQLite reads a timestamp with no timezone as UTC while
  JavaScript reads it as local. Both forms occur in real stores. One shared
  parser now reads them the way the SQL side does; the same split made `list`
  print "in the future" for a past run.
- The dashboard's score sparkline rounded, so 0.695 read as 70% there and 69.5%
  in `show`/`eval` for the same stored value — exactly what the shared score
  formatter exists to prevent.
- A run that exited 0 could be recorded as **failed with no error text**: the
  wrapper treated a terminal status the protocol had REPAIRED as the child
  declaring its own outcome, which suppressed the exit-code finalization. A
  repaired value is now distinguished from a declared one, so the wrapper's exit
  code decides.
- `runCustomRubric` still divided by zero for an all-zero-weight rubric,
  reporting "0% FAIL" beside "All criteria passed" — the guard had been added to
  the CLI only, which was the very drift the entry above it describes.

- **A failure could be recorded against the tool call that succeeded.** The
  hook adapter closed the most recently opened tool step, but harnesses dispatch
  tools in parallel batches whose results return in call order — so with two
  calls in flight the first result closed the second step. Outputs were swapped,
  and a `PostToolUseFailure` landed on the call that had actually succeeded
  while the one that failed was stored clean: a fabricated failure and a
  fail-open at once, on the primary capture path. Pairing is oldest-first now,
  matching the stream translator.
- A trace finalized with a terminal status the schema does not recognize was
  stored as **completed**. `endTrace({ status: 'Failed' })` — a case difference —
  and `aborted`, `cancelled` or `Timeout` all became success, and the
  deterministic evaluators read `status`, so a run the caller explicitly
  declared failed scored 1.0 PASS and exited 0. An unreadable terminal status
  now coerces to `failed`. The two capture paths answer differently on purpose:
  a stream **repairs** the field and keeps the rest of the finalization (an
  unusable field must not cost a producer its output, tokens and ended_at) with
  a warning naming the value, while the SDK **throws**, because a caller writing
  `endTrace({status: 'Failed'})` wants to hear that the case did not match. A
  *missing* status still defaults to completed — that is a clean stream ending
  normally, not a value that could not be read.
- `runCustomRubric`, a public export, had no lower bound on a criterion weight,
  so a caller passing `weight: -1` alongside a positive one drove the score
  above 1 — a rubric stored and displayed as **200% PASSED**. Weights are
  clamped and the score is bounded on both sides.
- A rubric whose criteria all weighed 0 divided by zero and reported "0% FAIL"
  at exit 1 directly beside "All criteria passed" — a false CI regression whose
  own report contradicted it. Rejected at parse time, along with duplicate
  criterion names (which collapse in the stored details).
- A malformed YAML rubric blamed a missing package for every parse error,
  discarding the line and column the author needed; an empty rubric file leaked
  a raw TypeError.
- `ingestTrace` stored data the CLI refuses: negative token counts, a
  `step_number` of 0, non-string tags and a numeric `started_at` — the last
  stringified into the column, so every `--since` window and every ordering by
  parsed instant answered about a time the run never had. It now runs the same
  validation `ingest` does, so the two doors agree by construction.
- The OTLP redelivery guard deduped steps but not the numbers: the merge still
  received the batch-wide totals, so a retry re-added the tokens and cost of
  spans it had just dropped, and a root-only retry (the common final flush)
  skipped the guard entirely. On the log path a record carries no span id, so
  there is no equivalent identity: a key built from timestamp, step type, name
  and a batch-local ordinal was tried and reverted — the ordinal resets per
  batch, so a genuinely different failing call at the same timestamp was
  silently dropped as a duplicate, and that path's token carriers produce no
  step at all. Redelivered log batches can still duplicate; the limitation is
  documented rather than traded for lost data.

- The programmatic API answered for its own arguments in SQLite's voice: an
  invalid trace `status` or step `step_type` reached the database raw, so a
  caller got "CHECK constraint failed: status IN (...)" — a constraint name
  rather than the value they passed, with no field or step context — while the
  CLI rejects the same values with precise field paths. Both are now named
  errors. A decision `confidence` outside [0, 1] was likewise stored verbatim
  from an SDK call, though `ingest` and `record` share one rule refusing it, so
  `show`/`why` rendered a value outside its documented range and the trace
  failed its own re-ingest; it is now dropped, as an out-of-range `decided_by`
  already was.

- The `--fields` "nothing to compare" guard scanned every entry in the golden
  file rather than the entries a candidate actually matched, so an unrelated
  agent's baseline could make a field look exercisable and restore the false
  green the guard exists to prevent.
- A `gemini-stream` result was paired with the most recently opened tool call,
  but harnesses dispatch tools in parallel batches whose results return in call
  order — so with two calls open, each result landed on the other's step: both
  outputs swapped, the call that succeeded marked failed, and the call that
  failed stored clean. Pairing is oldest-first now, and a result naming a tool
  that no open call matches is left unpaired rather than moving a failure onto
  an unrelated step.
- `codex-exec` stored a non-object `item` as a bare JSON scalar in the `output`
  column, where every reader expects an object — the `gemini-stream` branch
  already wrapped one.
- A duplicate policy name reported the raw SQLite constraint text, naming a
  column instead of what to do about it.
- `fork --modify-input` / `--modify-context` accepted any JSON value, so
  `--modify-input 5` stored a scalar as the trace input. An object is now
  required; an explicit `null` remains a no-op.
- Opening a store re-widened a directory an operator had deliberately locked
  down: the `chmod 0700` was described as a floor but acted as a set. It now
  only tightens permissions broader than 0700.
- A working directory the user cannot write produced a raw `EACCES … mkdir`
  instead of the actionable message every other open failure gets.
- The OTel span receiver dropped the cost a span reports, while the log receiver
  read the identical attribute — so `stats` showed no cost and `list --sort cost`
  was inert for every span-captured trace. It also ignored a reported
  `total_tokens` when the input/output split was absent.
- An OTLP batch an exporter redelivered had its child spans appended again,
  permanently doubling the trace's steps and token total. Only the identity root
  was guarded; every span in the batch is now checked.

- `export --format golden` baked forks into the baseline, which then let a real
  run that crashed part way reproduce the fork's shorter shape and pass. A golden
  dataset is a set of known-good runs; a `json`/`jsonl` export is a backup and
  still carries them.

- Codex tool-failure detection never fired on a real rollout. It tested for a
  plain-object output and returned early — but measured across 60 recent
  sessions, 636 outputs are arrays of `{type, text}` parts and 109 are strings,
  and **none** is an object. It now flattens to text first and reads the exec
  tool's own leading status line, with the structured rules applied to text that
  parses as JSON. An `exit_code` printed *inside* the output is deliberately not
  read: a "Script completed" run routinely embeds an inner command's non-zero
  code, and inventing a failed tool call is the expensive direction there.
  Verified on a real 382-call session: exactly its 4 genuine failures, no false
  positives.
- **`import --replace` could delete the wrong trace.** Import identity was the
  session id plus format, and a Claude Code subagent sidecar carries the *same*
  session id as its parent transcript — so importing a sidecar reported "already
  imported" and dropped it, and `--replace` deleted the parent session's trace,
  steps and evals included. The source filename is now part of the identity.
- The `--fields` "nothing to compare" refusal could hide a real regression. It
  was derived from comparisons actually performed, and those loops run over
  min(golden steps, candidate steps) — so a candidate that crashed to zero steps
  marked every per-step field uncompared, and the gate reported "gate broken"
  (exit 2) for the most severe regression it could see. Exercisability is now
  read from the baseline alone, and a run with any failure always reports the
  failure.
- A `gemini-stream` `tool_result` was discarded whenever its id was missing,
  unknown, or arrived before its `tool_use` — and that branch accepts a
  `tool_use` with no id, so an id-less stream lost every result. The step stayed
  open with no output and no `error`, storing a run whose every tool call failed
  as clean. Unmatched results now pair with the open tool step the way the hook
  adapter's lookup does.
- `gemini-stream` ignored token usage entirely, so every capture in that format
  reported no tokens while the identical field worked for `codex-exec`.
- An OTel span with no `name` was stored as a step named `""`, which this tool's
  own `ingest` refuses — so an OTel-captured trace could not be restored from
  its own export. It now falls back to the operation name.
- Events produced by the stream translators bypassed the validation every other
  live-capture route performs, making them the one entry point with nothing
  between a vendor's payload and the store.
- An ambiguous trace id now exits 2 (a usage error, like an unknown flag) rather
  than 1, and is answered as JSON under `--json` instead of escaping as a bare
  stderr line — it was breaking the very contract the same release documents.
- `config test-ai` now reports a dropped config key, which the previous entry
  claimed it already did.

- `--json` refusals from `list`, `stats`, `show`, `why`, `decisions` and `diff`
  wrote a bare line to stderr and left stdout empty, so a `| jq` pipeline got a
  parse error exactly where it expected a verdict it could read. All six now
  answer `{"ok": false, "error": ...}` on stdout, like `eval` and `check`
  already did — from one shared helper rather than an eighth copy. That now
  includes a store that cannot be opened at all (corrupt, unreadable, or written
  by a newer build), which is opened before each command's own refusal path and
  so was still escaping as a bare stderr line at exit 1.
- `check --json` emitted a singular `hint` string where every other command
  emits a `hints` array, so `check --json | jq -r '.hints[]'` — the CI pipeline
  the command exists for — silently yielded nothing on the refusal path. It kept
  its own copy of the refusal helper; it now uses the shared one.
- `diff --ai --json` silently dropped `--ai`: the JSON output returned before
  the AI block ran, so there was no analysis in the payload, nothing on stderr,
  and exit 0 — while the same misconfiguration exits 1 interactively. A pipeline
  reading `.ai_analysis` got `null` forever. The analysis now runs first and is
  merged into the payload.

- **The only spend cap on paid AI evaluation failed open.** `config set`
  validates every key and nothing validated them on read, so a hand-edited or
  copied config could hold a non-numeric or negative `ai.max_tokens`. That value
  reached the cost estimate, making it `NaN` — and `NaN > maxCost` is false, so
  `eval --ai --max-cost 0`, the strictest possible budget, ran the whole
  evaluation and billed for it. The value was forwarded to the provider as
  `max_tokens` besides. Unusable `ai` values are now dropped on read (the field
  falls back to its default, as a missing key already does), the gate refuses a
  non-finite estimate rather than passing it, and `config list` / `config
  test-ai` name every dropped key so an ignored value is not silent.
- `eval --max-cost` was validated only on a run that reached the provider, so a
  CI job whose budget flag was a typo'd or empty shell variable passed silently
  until the first run that happened to enable `--ai` — the run where the cap was
  already load-bearing. It is now a usage error on every run.
- A typo in `ai.provider` reported "No AI provider configured" and advised
  setting the very environment variable that was already set and would have
  worked. An unrecognized provider now falls back to auto-detection.
- **An ambiguous trace-id prefix silently resolved to whichever id sorted
  first.** `show`, `why`, `decisions`, `replay` and `watch` answered about a
  trace the user had not named, and `fork` — which writes — derived a new trace
  from one: `fork trc_ --from-step 1` was enough to fork an arbitrary trace out
  of a whole store at exit 0. Deterministic ordering made that stable, not
  correct. An ambiguous prefix is now an error naming the candidates; an exact
  id still wins over a longer id it prefixes.
- `run` printed a trace id no other command could resolve. It used the
  prefix-stripping short form, while every consumer matches a prefix from the
  start of the id — so the wrapper's only pointer to the run it had just
  recorded matched nothing, on the one command with no other way to learn the id
  at the moment it finishes. It now prints the same 12 characters `list` and
  `fork` do.
- Opening a store written by a NEWER build silently read and wrote it. Schema
  upgrades are one-way with no down-migration, so an older binary — an old
  install on a PATH, a pinned CI image — was reading columns it does not know
  about and writing rows that do not satisfy the newer shape, at exit 0. It is
  now refused with both versions named.
- `config get` wrote its "(not set)" message to **stdout**, the value channel,
  so `KEY=$(agent-replay config get ai.api_keys.anthropic)` captured a 34-character
  human sentence instead of the empty string — a `[ -n "$KEY" ]` guard passed
  and the sentence was sent onward as if it were a key. It also answered
  "(not set)" at exit 0 for a key that does not exist, making a typo
  undetectable, while `config set` refuses the same key at exit 2. The message
  now goes to stderr and an unknown key is refused, from one shared key list.

- **The Codex importer dropped roughly nine tenths of what the agent did.** It
  handled only `function_call`, while the current Codex CLI emits most tool
  invocations as the freeform `custom_tool_call` — measured across 40 recent
  rollouts, 194 custom against 25 function. Every one of them was counted into
  "Records skipped" and stored nowhere, at exit 0, so replay, diff and eval
  analysed a session that appeared to have done almost nothing. Both families
  now run through one branch, paired by `call_id` as before.
- The Codex importer never set `total_tokens`, so imported sessions showed "-"
  forever and a store mixing captured and imported runs reported totals that
  omitted the imported ones. It now reads the session's `token_count` records.
  Those totals are cumulative, so the last one is the answer: summing them
  over-counted by 34x on a real session (214,648,081 against an actual
  6,267,854).
- The Codex importer never recorded a step `error`, so an imported trace read as
  a clean run to `hallucination-check`, `completeness-check` and `check
  --golden`'s `step_errors` baseline — a fail-open on exactly the traces this
  tool exists to audit. A non-zero exit code or an explicit failure in the
  paired output is now recorded, as the Claude importer already did.
- Records wrapped in `event_msg` were matched against the literal string
  `"event_msg"` and skipped. It is the more common wrapper in real rollouts
  (7,471 records against 4,351 for `response_item` across 60 sessions), and the
  session token totals live inside it.
- **Claude token totals were short by a factor of ~478.** Only
  `input_tokens + output_tokens` were summed, dropping both cache fields, which
  is where nearly all of a real session's consumption sits: on a 52 MB
  transcript the stored figure was 1,216,025 against an actual 581,945,188, and
  the billable-but-uncached 4.3M `cache_creation` went with it. `stats`, the
  dashboard totals and every budget-shaped reading were meaningless for imported
  traces. The main loop and its subagent twin now share one helper.
- **Every user turn after the first was discarded by both importers**, so a
  59-turn session imported with one question and the rest unrecoverable — while
  the two other paths that assemble a trace from turns (the batch merge and the
  OTLP mapper) both keep them in `metadata.follow_up_prompts`. The importers now
  follow that convention.
- The one turn that was kept was usually not a prompt. Real transcripts open
  with a harness envelope — a slash-command block, injected instructions, an
  environment preamble — so `trace.input.prompt`, which `why`, the summarizer,
  the rubric evals and `check` all read as "what was asked", held boilerplate.
  The prompt is now the first turn that is not an envelope, with the envelope
  still used when that is all the session has.
- **Importing the same session twice created a whole duplicate trace.** Nothing
  checked, so a re-run after a crash — or a scheduled loop over a session
  directory — silently doubled every store-wide number and left indistinguishable
  rows in `list` with no way to tell the copies apart or clean them up. A session
  already in the store is now reported and left alone, with `--replace` to
  re-import it (also how a transcript that has grown is refreshed).

- **The golden CI gate could report a green pass having compared nothing.**
  Every field comparison skips a step whose baseline side lacks the data it
  reads — correct per step, but when every step was skipped the field compared
  nothing and the run still exited 0. `check --fields model` against a baseline
  captured without per-step models (every hook-captured or ingested store) was
  an unconditional pass, and it is the flag the README recommends for catching
  model swaps. A field named on `--fields` that no baseline can exercise is now
  a gate-broken refusal (exit 2), naming the field. Unknown field names were
  already refused for this reason; a valid field with no data behind it reached
  the same false green by a subtler route. The default field set is exempt: it
  deliberately spans fields not every trace shape has.
- A golden entry with no `metadata` silently disabled the `status` comparison —
  the one field that catches "this run now fails" — and reported a green pass.
  The baseline validator checked `steps_summary` but not `metadata`, and
  `metadata` is the block a human is most likely to prune when hand-editing or
  merging a baseline for review. `check` now refuses an entry without a string
  `metadata.status`, which `export --format golden` writes without exception.
- `stats` excluded forks from its headline totals but not from the by-status or
  per-agent breakdowns, so the parts did not sum to the whole: "Traces: 5"
  printed directly above a by-status summing to 6, and
  `stats --json | jq .by_status.running` alerted on a `fork` — a debugging
  action, not a run. Each fork also inflated its agent's count by one.

- A decision's `confidence` was stored by live capture at any value while
  `ingest` refuses anything outside [0, 1], so `record` wrote traces that failed
  their own re-ingest — the same drift the option-shape rule was unified to
  prevent, one field over. Both paths now share one exported check.
- `eval --preset ai-root-cause` reported a clean 100% pass for a run that never
  finished. Its applicability test read the trace error and the steps but not
  the trace **status**, and `record` finalizes an abandoned stream as `timeout`
  with no error text and no failing step — so the preset was "not applicable",
  which stores score 1.0 and passed, without ever calling the provider. The
  deterministic criteria already read status; this was the last reader that did
  not. The cost estimator now sees status too, so it and the run agree about
  which presets will actually run.
- A wrong-typed score from the model was read as full marks: `Number(["10"])` is
  10 and `Number(true)` is 1, so a mis-shaped reply passed. Anything that is not
  a finite number now scores 0.
- `eval --ai` under-reported spend when a request timed out and was retried. A
  provider that finishes generating and answers after the deadline still bills
  for it, so the retry is a second charge, but the reported cost came from the
  final attempt alone — and that number feeds the running total and the
  `--max-cost` gate. Timed-out attempts are now counted; a 429 or 5xx is not,
  since nothing was generated to bill for.
- The `--max-cost` estimate allowed a flat ~200 tokens for everything around the
  trace summary, which predated the injection guard now appended to every AI
  prompt. Measured, the prompts ran up to 44% over that on a small trace.
- The SDK could store what `ingest` refuses. `TraceRecorder` built events and
  called `applyEvent` directly, so `validateEvent` — where the live path's rules
  live — never saw a programmatic event: an out-of-range decision confidence,
  bare-string options, an empty `chosen`, an empty step name and non-string tags
  all round-tripped into a trace that failed its own re-ingest. Every SDK
  emission is validated now, and a rejection throws rather than warning, because
  an SDK call is this process's own code rather than a foreign producer.
- `stats` and the dashboard counted forks. A fork is a never-executed copy of a
  step prefix, tokens and all, so one `fork` of a 2-step 3,000-token trace
  doubled the store's `steps` and `totalTokens` — reporting spend that never
  happened. Every other fork-aware surface already filtered on lineage.
- `ingest` now says when it drops fork lineage. `export` writes
  `parent_trace_id`, `ingest` has nowhere to put it, and a restored fork becomes
  an ordinary trace — which the golden gate and `watch` then treat as a real run.
  Rebuilding the link needs an in-file id remap and is left alone; going quiet
  about it is not.
- Arrow-key navigation in the dashboard's trace list survives a refresh again.
  The list widget resets its selection on every `setData`, unlike the one it
  replaced, so the cursor jumped back to the top row on each auto-refresh.
- An AI score sent as a JSON-quoted number (`"9"`) scored 0 and failed. Guarding
  against `["9"]` and `true` had also rejected the single most common way a model
  mis-sends a number, silently failing a good reply.
- A tool result arriving after the turn ended was discarded, and left a phantom
  live run behind. Every hook fires as its own process, and a closing event
  (`PostToolUse`, `PostToolUseFailure`, `SubagentStop`) went through the same
  find-or-create path as an opening one — so when the turn-ending `Stop`
  committed first, the closing event found no *open* trace and created one. The
  tool's output, `ended_at` and duration were dropped permanently, the real step
  stayed open forever, and the store gained an empty `running` trace that
  `list`, `watch` and the dashboard all render as a live run. It happens
  deterministically whenever the harness dispatches `Stop` before the result
  arrives, and in 47% of simultaneous spawns (measured, 14 of 30), rising
  further while an `otel serve` holds the write lock. Closing events now resolve
  the session's trace whatever its status and never create one, so the result is
  recorded on the finalized trace rather than lost — `updateStep` never required
  a running trace; only `appendStep` does, and a closing event never appends.
  Measured again after the fix: 0 of 30.
- A decision whose `options` were not option objects crashed `decisions`. The
  `chosen` field was validated and the options array was not, so a plain array of
  strings — the most obvious wrong guess at this schema — was accepted by
  `record` and then aborted the command with a bare `TypeError`, losing every
  LATER decision point in the trace and naming neither the field nor the step.
  Options are validated at the boundary now — by the same exported function
  `ingest` uses, not a second copy of the rule, so `record` cannot store an
  options array `ingest` refuses and leave a trace unrestorable from its own
  export. A record stored before that renders instead of aborting.
- A trace id of `''` was stored rather than replaced. An empty string is not
  nullish, so it slipped past `?? generateId`, and because every later event
  requires a non-empty `trace_id` that trace was unreachable forever — finalized
  `timeout`, counted by `list` and by `check`'s candidate scan, openable by
  nothing. The id is now required to be an identifier, not merely free of
  control characters.
- A Gemini stream's unreadable exit code fabricated a run failure. `Number()` of
  an unparseable value is `NaN`, which is `!== 0`, so a non-numeric code — a
  Node-style `code: "ENOENT"`, or an object — marked the whole run failed and
  reported the reason as the literal "exited with code NaN". A code that cannot
  be read is not evidence the run failed. The Codex path was already guarded this
  way; the two had drifted apart again.
- `check`'s new refusal advised naming a trace with `--trace` — but `--trace`
  compares whatever it names, so following that advice pointed the gate at the
  very fork or in-flight run the refusal had just excluded, turning it red on a
  run that never executed.
- A capture stream's `error: NaN` produced a failing step whose reported reason
  was the word "null" (`JSON.stringify(NaN)`), and a numeric `is_error: 1` — what
  an exporter that coerces booleans to ints sends — was not read as a failure at
  all. The flag is now read generously, since missing a failure signal is the
  fail-open direction, while a non-finite number is never an error code.
- `record --format codex-exec` recorded a failed item with the wrong reason —
  including its own SUCCESS status. Detection triggered on any of three signals
  but picked its message from an unrelated fallback chain, so an item failing by
  exit code was stored with the error text `completed`, which is what `show`,
  `watch`, `why` and the AI root-cause prompt then displayed as the failure; an
  item flagged only by `is_error` produced the literal `exited with code
  undefined`. A stringified exit code and a capitalized `Failed` now count too,
  matching the tolerance already applied to `is_error`.
- An `error` field holding an empty array or object still fabricated a failing
  step — the same class as `error: ""` and `error: false`, via a different empty
  value that a producer with a structured error field plausibly sends.
- `check` reported "No traces matched" when traces DID match and were then
  excluded as forks or still-running, sending the reader to widen `--agent` and
  `--since` — advice that cannot help. The two cases now read differently.
- A fork turned `check --golden` permanently red. A fork is a never-executed copy
  — same agent name and input, a truncated step prefix, status `running` — so it
  matched its own baseline and diverged on step count and status, reported as
  REGRESSED at exit 1, the code reserved for a real regression. One `fork` on a
  shared store failed every later gate run, indistinguishably from a genuine
  failure. Candidates now exclude forks by lineage, as the hook, OTel and `watch`
  lookups already did, and also exclude `running` traces, whose partial shape is
  not a regression.
- `watch` announced a failed run without saying why. The earlier fix covered a
  failure a STEP recorded, but the two most common failure paths write a
  trace-level error and no step error at all — `run` finalizing a non-zero child
  exit, and a `trace_end` event carrying `error` — so the one view open when a run
  died showed only "FAILED" while `show` printed the reason.
- `list` had its own copy of the relative-time formatter, drifted from the shared
  one: no month bucket ("45d ago" where the dashboard said "1mo ago") and no
  future guard, so a skewed future timestamp read as "just now" while sorting to
  the top.

- Exporting a whole store was quadratic. `getTrace` resolves an id prefix with
  `id = ? OR id LIKE ?`, and that disjunction cannot use the primary key index,
  so every lookup was a full scan of `agent_traces` plus a temp B-tree for the
  ordering. `export` calls it once per trace — with an already-canonical id, so
  the prefix machinery was pure waste — and applies no limit, so the cost grew
  with the square of the store: a 3,000-trace export took 10.4 s, and larger
  stores far worse. It now tries the exact id first and only falls back to the
  prefix query, which resolves identically. The same export now takes 1.1 s and
  scales linearly. This is the same class of defect the schema v4 expression
  index exists to fix, on the path that builds golden datasets and backups.

- `guard list` printed a truncated policy id that `guard disable`, `guard
  enable` and `guard remove` then rejected as "not found" — they resolve by
  exact id or name, with no prefix matching, so copying the id out of the table
  was guaranteed to fail. The full id is shown.

- `eval --json` reported `criteria[].critical` for only some critical criteria.
  The flag was set when a check returned it (the conditionally-critical
  `no_error_steps`) but not when the preset declared it, so
  `all_tool_calls_completed` and `no_unresolved_errors` appeared in
  `failed_critical` with no flag on the criterion itself. Every criterion that
  can fail a preset on its own now says so.

- An import that captured nothing exited 0 and stored an empty trace. The
  "nothing importable" guard in both importers keyed on `!input`, but an empty
  first user record still sets the input to `{prompt: ''}`, which is truthy —
  so a file reporting "0 records imported" went on to create a trace with an
  empty prompt and no steps, and `import X && use-trace` proceeded against
  content-free data. A file that captured a real prompt but no steps still
  imports, as before.

- The `codex-rollout` importer discarded the real first prompt when the record
  before it was empty. `{prompt: ''}` is truthy, so `!input` read an empty first
  user message as "input captured", the next real prompt fell through to the
  follow-up branch, and the trace kept no question at all — while the empty
  record still counted as imported. The identical construct was fixed in both
  branches of the Claude transcript importer; this sibling was missed.

- `guard add --priority ""` silently stored the default instead of refusing.
  `Number('')` is 0, which is an integer, so the blank string was the one input
  this check accepted where every sibling numeric option rejects it — so
  `--priority "$UNSET_VAR"` ranked a policy 0 rather than failing.

- `eval --json` now answers in JSON when a rubric or a deterministic preset
  throws while running. Both paths returned before the empty-results JSON
  fallback, so a `| jq` pipeline got a parse error instead of a verdict. (No new
  test: reaching either catch requires an internal store failure rather than any
  user input.)

- A root span arriving in a later OTLP batch was dropped entirely. The first
  root span becomes the trace, so it is deliberately not among the batch's
  steps — right for the batch that opens the trace, wrong for every later one.
  A span exporter flushes inner spans first, so a trace with more than one root
  (GenAI emits `create_agent` before `invoke_agent`; multi-agent runs nest
  `invoke_agent`) naturally splits with a root in a later batch, which then
  promoted itself to an identity the trace already had. Merging inserts only
  steps, so that span produced no row at all. Whether a span survives no longer
  depends on where the exporter cut its batches. A rootless synthetic trace still adopts a late root
  as its identity rather than duplicating it as a step.

- The OTLP **logs** path stored counters that `ingest` rejects. `intValue` is a
  signed int64, so a negative token count or `duration_ms` is wire-legal; the
  span path floors both, and this path — the one documented for Claude Code and
  Gemini CLI — did not. A negative count dragged `stats` sums negative and broke
  export → `ingest` of a trace this tool had just written. A genuine zero
  duration still survives.

- Merging a later OTLP batch could write a negative `total_duration_ms`. The
  trace start and end come from independent sets (earliest start, latest end),
  so nothing orders them; a trace whose first batch carried no renderable
  timestamps takes the ingest wall clock as its start, and a later batch
  contributing only an end in the past inverted the window. The mapper already
  guards its own window this way; the merge now does too.

- The Gemini stream's new failure detection read `error != null`, so a producer
  that always emits the key — `error: ""` or `error: false` on success — got
  fabricated failing steps, which feed `check --golden` `step_errors` and the
  eval error criteria and fail a clean run. An error must now be a non-empty
  value, and a stringified `is_error: "true"` counts, the way the OTel log
  mapper already reads its own signals.

- `record --format codex-exec` recorded a failed item as a clean step — the same
  gap in the same file as the Gemini one, so the fix now covers both streams.

- A redelivered OTLP batch added the trace's own identity root back as a step, so
  the trace contained a step that was itself. An exporter retries any batch it did
  not get a 200 for; a span already present as the trace's identity, or as a step,
  is never added again.

- The OTLP log mapper let a whitespace-only first prompt claim the input slot and
  demote the real question to a follow-up — the third site of a defect already
  fixed in both importers and in the cross-batch path.

- A failed tool call in a Gemini stream (`record --format gemini-stream`) was
  recorded as a clean one. The gemini translator's `tool_result` branch had no
  error path at all, while every sibling capture path (`hook`, the Claude
  transcript importer) already kept `step_type: tool_call` and populated
  `error`. Nothing downstream could then see the failure: `eval --preset
  ai-root-cause` treats a trace with no failing step as not-applicable and
  scores it a 100% PASS, and a `check --golden` `step_errors` baseline had no
  failure to regress against — so a run whose every tool call errored reported
  green twice over. Only unambiguous, shape-generic signals are read
  (`is_error: true`, a non-null `error`); the result content is still preserved
  as the step output either way.

- `check` echoed producer text raw — the one human-readable renderer left
  without `safeText`. Agent names and divergence values are agent-authored, and
  on the golden side they arrive from a baseline file that may have been shared
  or downloaded. A lone carriage return in one returns the cursor to column 0
  and lets following bytes overwrite the `REGRESSED` line above it, so the
  regression gate could be made to misreport its own verdict; an OSC sequence
  retitles the operator's terminal.

- A run wrapped by `agent-replay run` could be recorded as clean when it failed,
  or left open forever. `trace_end.status` is a free string, and any non-empty one
  counted as "the child owns the outcome" — but `updateTrace` coerces anything
  unrecognized to `completed`, so a child ending with `status: "error"` was
  laundered into a clean-looking trace AND suppressed the exit-code finalization,
  leaving no error text on a run that exited non-zero. A golden baseline recorded
  that way then matched it. `status: "running"` was worse: it survives coercion,
  so the trace stayed open forever and a bare `watch` live-tailed a dead process.
  Only a terminal status the store can record now counts.

- A trace's `started_at`/`ended_at` were coerced by the writer and validated by
  nobody, so a non-string timestamp was silently replaced by the INGEST WALL CLOCK
  at exit 0 — with `--dry-run` reporting the file valid. Every `--since` window and
  every ordering then answered about a time the run never had.

- `completeness-check` could not fail a run in which no tool call completed:
  `all_tool_calls_completed` has the same 0.3-weight-against-0.7-threshold shape as
  the error criteria, so a score of 0 landed on exactly the threshold and passed,
  with "0/2 tool calls have output" printed beside the green verdict.

- `hallucination-check` hard-failed any trace containing an error step, including
  a completed run that retried a timed-out tool call successfully — so an imported
  session with one failed shell command failed outright while
  `completeness-check` called the same trace 100% complete. Criticality now keys
  on how the RUN ended (its status or a trace-level error), not on any step error.

- An answer of `0` or `false` was not counted as an answer, so a count query that
  legitimately returns zero, or a predicate step returning false, failed
  `completeness-check` at exit 1 on a correct run.

- An empty or whitespace-only first user record still discarded the next, REAL
  prompt for ARRAY-content records — the shape real Claude Code transcripts use.
  The earlier fix reached only the string-content branch, and the two then
  disagreed on the tally for the identical situation. The subagent path likewise
  never got the orphan-`tool_result` pairing check its own comment claims to
  mirror.

- An OpenTelemetry root span that arrived in a later batch was silently dropped —
  its name, prompt, timing and attributes discarded and the trace attributed to a
  sub-agent — because content was adopted only when the existing trace was flagged
  synthetic. That is the normal `BatchSpanProcessor` order, since a sub-agent span
  ends before its parent. The same gap dropped a log session's prompt outright
  when the batch that opened the trace carried none (a receiver started
  mid-session, a resumed session, an out-of-order flush), and discarded the root's
  own metadata (provider, model, span id).

- A negative usage counter from OTLP was stored verbatim. protobuf `int64` is
  signed, so it is wire-legal; it dragged `stats` sums negative and broke the
  export → `ingest` round trip, which requires a non-negative total.

- `guard add --priority` parsed instead of validating, so `--priority high`
  silently stored 0 and `--priority 1e3` stored 1 — and priority is what orders
  policy evaluation and breaks ties, so a rule meant to rank first ranked last and
  `guard check` cited the wrong policy.

- Six more render sites echoed producer- or model-supplied text raw, including the
  `check` gate's own divergence report (where the values are exactly the
  attacker-influenced fields), the per-agent rows of `stats`, `show --snapshots`,
  `guard test`, the eval table beside the panel that was already escaped, and the
  dashboard, where the bytes also corrupt blessed's width math for the whole
  layout.

- `ingest --dry-run` passed files the real run could never load. A step's
  `error` was the one TEXT column bound without coercion, so a structured error
  (`{"code": …, "message": …}` — a shape real producers send) validated clean and
  then made the insert refuse the bind, rolling back the whole trace with a
  message naming neither the field nor the step; it is now flattened like every
  sibling error column. A duplicate `step_number` also validated clean and then
  hit the schema's UNIQUE constraint. And an object-valued `agent_version` or
  step `model` was silently coerced to null at exit 0 — the writer does that
  deliberately so one bad field can never cost a LIVE capture the whole run, on
  the stated assumption that ingest validates it first, which it did not.

- One unparseable line made `ingest` discard the whole JSONL file: three valid
  traces beside one truncated line ingested nothing. That contradicted the policy
  the validation stage right below it states — load the valid subset, and exit 1
  because something was dropped. Bad lines are now reported by line number and
  the valid records load.

- An orphan `tool_result` was counted as an imported record although it is stored
  nowhere. It has no `tool_use` to attach to — routine when a transcript is
  head-truncated, after `/compact`, or when the `tool_use` line itself was
  unparseable — so the summary reported content the store does not have.

- An EMPTY first user record made the importer discard the next, real prompt:
  `{prompt: ''}` is truthy, so the "input already captured" check read it as
  captured and the trace ended up with no question at all.

- `completeness-check` was unsatisfiable for every live-captured trace. Its
  heaviest criterion keyed on `step_type === 'output'`, which the hook adapter,
  the OTel log path and the span mapper never emit (the Gemini stream translator
  and the transcript importers do), so a flawless hook capture capped at 0.6
  against a 0.7 threshold and `eval <id>` exited 1 for every hook-captured run,
  clean or not. A gate that is always red
  gets ignored. A trace-level output, or the final step that carried one, now
  counts as the answer. Same defect class the error criteria were already fixed
  for: a criterion keyed on something the capture path never produces.

- `hallucination-check`'s error criterion ignored a trace-level error, so a run
  that died before emitting a final step scored a perfect 1.0 — while
  `completeness-check` saw the same trace as failed and documented why ("the only
  marker a run that died before emitting a final step leaves behind"). The two
  now agree.

- A custom rubric matched against one corpus for both polarities, which is wrong
  in each direction. "Must not contain" saw only the trace input/output and step
  OUTPUTS, so it scored a free 1.0 for anything living in a tool-call input, a
  step name, a step error or the trace error — a rubric forbidding `rm -rf`
  passed a run that executed exactly that, exit 0. "Must contain" saw the trace
  INPUT, so a criterion asserting the answer cites a source was satisfied by the
  prompt that asked for one, and one asserting the agent apologized was satisfied
  by a step named `apologize_to_user` while the answer said otherwise. Each
  polarity now searches what it is actually asserting about: "must not contain"
  sees the whole run, "must contain" sees only what the run produced.

- A rubric pattern the ReDoS filter rejects was scored 0 with its full weight
  rather than refused, and the table prints only the criterion name — so a valid,
  non-catastrophic pattern that the deliberately conservative filter declines
  reported a quality FAILURE of the trace, exit 1, on a correct run. Patterns are
  now compiled at parse time, where a bad one is a usage error naming the pattern.

- `eval --rubric` and `eval --max-cost` refusals printed nothing on stdout under
  `--json`, the two paths that bypassed the helper added to guarantee a
  JSON-shaped refusal, so `eval --json | jq -r .ok` got a parse error.

- The shared diff windowing I extracted last commit lost its surrogate safety: a
  cut could split an emoji into a lone surrogate, which renders as U+FFFD in BOTH
  columns — the mojibake becomes the apparent difference — and the index moved
  the wrong way, shrinking the window so the differing tail fell out of view and
  both columns printed identical text again. Restored, and it now covers the
  model-facing summary as well as the terminal view.

- The AI summary still dropped the failing step when EVERY step was important — a
  Gemini import attaches a decision record to every tool call, and a retry storm
  is all errors — because the prioritized fill was itself in-order. The step that
  ended the run is now claimed before anything else competes for the budget.
  Rendering is lazy again rather than rendering every step up front, so a step
  the budget cannot hold is no longer rendered before being discarded (20,000
  tiny steps summarize in ~24 ms). The loop still visits every step: it stops
  early only when the budget is exactly consumed, because there is no sound
  lower bound on a line's length to stop on — a fixed floor is what used to drop
  steps that fit and report them as omitted.

- `diff --fields ""` and `check --fields ""` bypassed the guard that rejects a
  list naming no fields — `diff` silently suppressed every field comparison and
  `check` silently reverted to the default set.

- `diff` never compared the DECISION record, the one field this tool exists to
  explain. Two runs that took opposite actions at the same step — one choosing
  `rm_rf`, the other `safe_path` — reported "Traces are identical." and exit 0
  whenever every other field matched, while `decisions` and `why` on the same
  pair correctly showed the divergence, and `diff --ai` was handed a summary with
  no differences in it and asked why the traces diverged. The chosen option, its
  rationale and who decided are now compared, and `decision` is selectable via
  `--fields`. Confidence and the option list are deliberately excluded: they are
  the model's self-report and vary without the agent having acted differently.

- The AI trace summary dropped the failing step at the DEFAULT budget. Step
  prioritization existed but ran only under a tight budget; the normal path
  walked steps in order and stopped when the budget ran out, so on a long trace
  the LAST steps went first — and the failing step is almost always last. Every
  `eval --ai` preset on a trace over roughly thirty steps therefore judged a
  failure it had never been shown, since the trace-level `error` is null on the
  normal hook-capture shape where the failure detail lives on the step. The
  summary also now says how many steps it dropped on every path that drops any;
  the marker was previously emitted only when the budget ran out mid-loop, so the
  prioritizing path could silently discard forty of forty-one steps.

- `diff --ai`'s evidence could show no difference at all. Values were truncated
  from position 0, so two payloads sharing a long prefix — a system prompt, a
  message array, the ordinary shape of an agent payload — arrived at the model as
  byte-identical text under a heading announcing a divergence. The terminal view
  already windowed around the first difference; both now share one implementation.

- `diff --ai` sent trace content to the model with no fence, while `eval --ai`
  wrapped the same summarizer's output in an untrusted-content fence and an
  injection guard for exactly this reason. The summary is built from agent
  prompts, tool inputs and tool outputs, so a tool result reading "ignore previous
  instructions…" landed in instruction position and its answer was printed as the
  tool's verdict.

- `decisions` rendered the chosen option, the option list and both rationales
  unescaped, so a carriage return in a decision could overwrite the line and make
  the one command whose job is reporting the choice DISPLAY a different option
  than the one stored — contradicting `why` about the same record.

- `diff --fields ,` (or a script interpolating an empty variable) filtered out
  every field comparison while passing the unknown-field guard vacuously, so a
  pair with seven real differences reported three, with no scope label. It is now
  a usage error.

- `check` passed green when NO candidate matched the baseline. An unmatched
  candidate compares exactly as much as no candidate at all — nothing — yet it
  was a pass by default while zero candidates was already refused with exit 2. So
  any change that alters every match key (adding `--no-input` to a hook
  registration blanks each trace's input, an agent rename, an input-template
  edit) left the gate green forever on runs it had silently stopped comparing.
  It now refuses like the zero-candidate case, with `--allow-empty` as the same
  opt-out.

- `check` answered a store it could not open with a bare stderr line and exit 1,
  the one refusal that escaped its own contract: `check --json | jq -r .ok` died
  on a parse error, and a CI script that separates a regression (`1`) from a
  broken gate (`2`) misread an unopenable store as a regression. Reachable from a
  `--dir` typo landing on a file, a read-only workspace, or a locked store.

- `guard check` failed OPEN on input it could not evaluate. Unreadable stdin,
  malformed JSON, a payload that is not a step object, and a missing `step_type`
  all exited `1` — not the block signal, which is `2` — so a wrapper gating on
  `$? == 2` ran the tool anyway. They now deny with exit `2`, matching the
  policy-evaluation failure in the same function.

- An OpenTelemetry step could carry a duration of ~56,000 years. The guard added
  for the trace-level window did not cover the per-step duration, which was still
  derived from raw nanoseconds while the timestamp formatter rejected the same
  value — so the step rendered a null end time beside an enormous duration, and
  the value is finite and non-negative, so validation stored it.

- The native `record` protocol still stored a negative `total_cost_usd`, which
  `ingest` rejects on the same rule as the token counts — the export → ingest
  round trip stayed broken through the field `stats` and `list --sort cost` read.

- `list`, `why` and `diff` still echoed agent-supplied text raw, so the escaping
  added for `show`/`replay`/`watch` missed the most-run command in the tool. A
  CRLF line break — what any Windows or PowerShell child writes — is now
  normalized rather than escaped mid-line, while a lone carriage return, which
  can overwrite what was already printed, is still escaped.

- A re-delivered OpenTelemetry log batch appended its prompt to
  `follow_up_prompts` again every time, so the list grew without bound on exactly
  the retries the receiver's 4xx-not-5xx rule exists to make safe.

- Everything a later OpenTelemetry log batch carried was dropped at the merge. A
  log processor flushes each turn in its own batch, so for a multi-turn session:
  `total_cost_usd` was missing from the merge's UPDATE, leaving only the first
  batch's cost (and null forever if that batch reported none), and a later turn's
  prompt was discarded along with its `follow_up_prompts`, so the store kept only
  the session's first question. Cost now sums like tokens, and later turns are
  retained as follow-ups.

- One record with an impossible timestamp nulled a whole log-derived session's end
  time and duration: the maximum was taken over raw nanoseconds and the formatter
  then rejected it, discarding timing every other record in the session defined.
  The span path had the same gap in the other direction — its duration came from
  raw nanoseconds while `ended_at` was guarded, so a single absurd
  `endTimeUnixNano` produced a ~31-million-year duration beside a null end time.

- A tool failure reported as the string `"False"` — what an exporter built on the
  OTel Python SDK sends, since `str(False)` capitalizes — read as a clean call,
  dropping the error text. The check is now case-insensitive.

- Trace text is escaped before it reaches the terminal. Step names, errors,
  models, decision rationales and agent names are producer output — tool stderr,
  an HTTP error body, a sub-agent's reply — and `show`, `show --tree`, `replay`
  and `watch` echoed them raw, so an ESC sequence in any of them could recolor or
  clear the terminal of the operator reading the run, or set the window title via
  OSC. The same bytes also broke the width math behind the header panel's
  borders. `run` already escaped a rejected event line for this reason; these
  were its sibling render paths. Newlines and tabs still render as formatting.

- An AI evaluator's list field that the model sent as a bare string ("issues":
  "too long" instead of a list) rendered as one bullet PER CHARACTER, and the
  malformed value was persisted in `details` for `show` and `export`. Such a
  reply now carries a single item, and a value that is neither a list nor a
  string carries none.

- The native `record` protocol stored a negative or non-finite `tokens_used` /
  `duration_ms` verbatim, while `ingest` rejects those values — so a trace this
  tool captured could not be re-ingested from its own export, breaking the
  round-trip the golden gate depends on. Both importers and the stream
  translators already clamped. The unusable field is now dropped with a warning
  and the step is kept.

- An explicit `ai.provider` applied a configured `ai.model` from another vendor's
  family, so `provider = openai` with a leftover `model = claude-*` sent that
  name to OpenAI (a confusing auth error at eval time) and priced `--max-cost`
  off Anthropic's sheet. It now falls back to the provider's default model, as
  auto-detection already did, and the README's claim is true again. A model of no
  known family — a proxy's own name — still passes through.

- `watch` never showed a step's outcome. Under the two-phase protocol
  (`step_start` then `step_end`) a step is first seen while it is still open, so
  printing each step exactly once meant duration, tokens and error text were
  always null at print time: a failing run announced `trace finished: FAILED`
  with no error, while `show` on the same trace printed it. A step that ends now
  gets a closing line carrying its outcome. Producers that write a complete step
  in one event are unchanged — no second line.

- One duration formatter across every view. Four copies had drifted apart above a
  minute, so `list` and `show` said "2.1m" where `watch`, `replay` and `stats`
  said "2m 5s" — and a single `replay` screen printed both forms of the same
  number four lines apart. The copies also lacked the shared formatter's guards,
  rendering a negative stored duration as "-500ms".

- `fork --tag` wrote the tag after the fork's transaction had committed, so a
  failure on that one statement reported `Fork failed` (exit 1) for a fork that
  existed — an orphan whose id was never printed, with a fresh one created on
  every retry. The tag is now part of the same transaction.

- `check --fields` validated its field list only after opening the store and
  fetching every candidate, so a typo was reported as whatever the data layer
  complained about first ("No traces matched…") without ever naming the bad
  field. Usage errors are now checked first, as `watch --interval` already did.

- `demo --reset` could delete a working tree that merely looked like a store. The
  guard accepted any directory whose name starts with `agent-replay`, which a
  source checkout called `agent-replay-project` does, and then removed the tree
  recursively. `--reset` now deletes only `traces.db` and its sidecars, so the
  blast radius is data this command created; a directory holding no store has
  nothing to reset.

- One OpenTelemetry span could blackhole a whole pipeline. The span-to-step-type
  tables are plain object literals keyed by untrusted telemetry — the
  `gen_ai.operation.name` attribute and the span name's leading word — so a span
  named `constructor` or `toString` (an auto-instrumented JS class method)
  resolved to a function, survived the fallback that only replaces null, and
  reached the SQLite bind. The batch's transaction rolled back and the receiver
  answered 500, which OTLP exporters retry, so the poisoned batch was resent
  forever and every other span in it was lost with it.

- A parallel tool batch's `PostToolUse` hooks silently lost results. Each hook is
  its own process, and the "find the open tool step" read and the update that
  closes it were separate statements, so simultaneous hooks all claimed the same
  newest open step: the last writer won, the other outputs were discarded, and
  those steps stayed open forever — with no warning, because the update matches
  on `(trace_id, step_number)` and always reports a row changed. Six parallel
  hooks lost one to three results per run before the fix. The claim and the close
  are now one transaction.

- `show --from-step/--to-step` reported the WINDOW's token subtotal on the
  trace-level `Tokens:` line. The header falls back to summing the steps when no
  producer set a trace-level total — the shape of every hook-, `record`-, OTel-
  and import-captured trace — and the window was applied by narrowing the step
  array in place, so a 30-token trace showed `Tokens: 20` beside a trace-level
  `Duration:`, disagreeing with `list` and `stats` for the same trace. The steps
  rendered are unchanged; only the header is trace-level again.

- `stats` and the dashboard silently excluded a trace whose timestamps use an
  ISO-8601 *basic*-format offset (`+0200` — what `date +%FT%T%z` emits and
  `ingest` stores verbatim) from the average duration, because `julianday()`
  returns NULL for that form and `AVG` skips NULLs. The average was therefore
  taken over a subset while `overall.traces` counted every trace, and a store
  built entirely that way printed "Avg duration: -" for traces `list` showed a
  duration for. A timestamp nothing can parse still counts as unmeasured.

- `watch` with no trace id, and the hook capture path's "open trace for this
  session" lookup, ranked candidates by the BYTES of `started_at` rather than the
  parsed instant. SQLite's own space form sorts below every `T`-separated
  timestamp and a negative offset sorts above the UTC instant it precedes, so a
  bare `watch` attached to an older run and showed a live session doing nothing,
  and a hook event could append to the wrong open trace. These were the last two
  raw-TEXT orderings on `started_at`.

- The dashboard TUI rendered total cost with a flat `toFixed(4)`, so a store whose
  entire real spend was under a hundredth of a cent — the normal case for agent
  runs — read as `$0.0000`. It now uses the same `formatCostUsd` `stats` uses.



- `diff` compares the trace's own `input`. It never did, so the one field
  `fork --modify-input` changes was invisible — and `fork` closes by telling you
  to run exactly that diff. Two separately-ingested traces differing only in
  their prompt compared as "identical", while `diff --ai` (whose summary does
  include the input) could reach the opposite conclusion about the same pair.

- `diff --fields` no longer prints "Traces are identical." over a filtered
  comparison — under a header showing COMPLETED beside FAILED, in the case that
  prompted this. It now names the fields it actually compared.

- The `diff` table windows each value around the first difference instead of
  truncating both sides from the left. Agent payloads share long prefixes
  (`{"file_path":"/Users/…"}`), so a real difference routinely rendered as two
  byte-identical cells under "1 difference(s) found", with nothing to suggest
  `--json` was needed to see it. A left-only step is also marked `-` rather than
  a `+` that read backwards next to the green `+ Right only`.

- `why`'s header counts steps rather than calling them "hops" — a one-step chain
  involves no traversal at all.

- An empty `AGENT_REPLAY_DIR` is treated as unset rather than resolving to the
  working directory. `AGENT_REPLAY_DIR= agent-replay init` wrote the store loose
  into the CWD — and `demo --reset` then passed its "is this an agent-replay
  data directory?" name check for anyone standing in a checkout named
  `agent-replay`, and deleted their working tree.

- `record` finalizes a trace it resumed by id, as documented, while leaving
  alone the one trace a *live* enclosing `agent-replay run` handed it — a run
  removes its channel as it finalizes, so a stale `AGENT_REPLAY_TRACE_ID`
  inherited from a finished run no longer strands a resumed trace `running`.

- The `diff` table never cuts a value between the halves of a surrogate pair
  (an emoji in a prompt is enough): a lone surrogate rendered as U+FFFD in both
  columns, so the mojibake looked like the difference. `diff --compact` also
  names the `--fields` filter instead of reporting a bare "Differences: 0".

- A non-string `ai.model` in a hand-edited config is ignored rather than passed
  to a provider adapter, where it surfaced as `long.startsWith is not a
  function` — or was sent as the model name itself. Under the README's own
  nested example (`run -- sh -c '... | agent-replay record'`) the events carry
  the wrapper's trace id, so the end-of-stream `timeout` finalization marked a
  clean run red — and permanently, since the wrapper then sees a non-running
  status and leaves it alone. Only traces this stream opened are finalized.

- `eval --json` answers in JSON on every refusal — a missing trace, an unknown
  preset, no configured provider, a `--max-cost` rejection — instead of leaving
  a `| jq` pipeline with an empty document.

- The `--max-cost` pre-gate prices the ceiling the run will actually use. It
  hardcoded 1024 output tokens while the run began honoring a configured
  `ai.max_tokens`, leaving the check whose job is refusing to spend about 9x
  optimistic at `max_tokens 8192`.

- In auto-detection, a configured `ai.model` naming a known family now selects
  its provider. With two keys present the fixed priority order won instead:
  a different vendor was billed and the verdict came from a model the user had
  not chosen, silently.

- Importing a transcript survives a line that parses to `null`. Both importers
  pushed any parsed JSON value into their record list and dereferenced it
  unguarded, so one such line aborted the entire import — nothing kept from a
  50,000-record transcript. An empty or unreadable subagent file also no longer
  leaves a childless `subagent:<id>` step behind, which had made "nothing
  importable" undetectable (`Records imported: 0` alongside exit 0), and an
  unreadable subagent *file* is no longer counted as a skipped *record*.

- `agent-replay run` keeps its headline guarantee when the store hiccups.
  Finalization was unguarded, so a write that failed (another process holding
  the lock past `busy_timeout` — likelier now that the receiver, hook and fork
  take it up front) replaced the child's own exit code with `1`, left the trace
  `running` with no `ended_at` forever, and leaked the channel directory. It is
  now best-effort: the failure is reported, the child's status is still what
  `run` exits with, and the temp directory always goes. A failure to open the
  trace at all — before the child is spawned — now says the command was never
  started, rather than a bare "database is locked".

- `run` detects an events-channel rewrite that keeps or grows the file's size.
  The append-only guard only compared sizes, so a producer that reopened the
  channel truncating (`createWriteStream`'s default `w` flags, or
  `writeFileSync`) and wrote at least as much as had been consumed slipped
  through and reading resumed at a stale offset — events dropped, exit 0, no
  diagnostic, exactly what the guard exists to prevent.

- `run` records a duration for an instrumented child. A child that sends its own
  `trace_end` owns the status but rarely sends totals, and the wrapper skipped
  its update entirely, so an instrumented run had a null `total_duration_ms`
  while an uninstrumented run of the same command reported one.

- A rejected event line is escaped before being echoed. It is untrusted producer
  output printed straight to the supervising terminal and CI log, so a child
  emitting ESC sequences could move the cursor or recolor the log of the tool
  watching it.

- `record` no longer calls a legal comment-only native stream a total failure:
  `//` lines are part of the protocol, but were counted as unmatched input, so
  such a stream reported "none of the N line(s) matched" and exited 1.

- `eval --json` is parseable on every path. The default invocation
  (`eval <id> --json`, no evaluator flag) printed two lines of prose on stdout
  before the array, and a run where every evaluator threw printed nothing at
  all — so the same flag produced valid JSON, JSON-after-prose, or an empty
  document depending on which path ran.

- `config set ai.model` no longer applies a model to a provider it doesn't
  belong to. It was used for whatever provider auto-detection found, so a config
  naming a Claude model on a machine holding only an `OPENAI_API_KEY` sent the
  Claude model name to OpenAI — every eval failed with an opaque server error,
  and `--max-cost` priced the run off Anthropic's rate sheet while doing it.

- `config set ai.max_tokens` is finally read. It was validated, stored, and then
  ignored: the eval path always sent a hard 1024, and a truncated judge reply
  fails JSON extraction and is stored as score 0 / failed — a CI failure on a
  good trace, billed in full, with no supported way to raise the ceiling.

- `show` lists a trace's evaluations newest-first even when several were written
  in the same millisecond (an `--all` run), and the eval Details column reports
  criteria against the threshold the evaluation recorded rather than a
  hardcoded 0.7.

- `list`, the dashboard and every candidate fetch keep their index. Ordering by
  the parsed instant (`julianday(started_at)`) is required for correctness, but
  it cannot use the plain `started_at` index — measured over 50,000 traces, the
  default `list` page went from an index seek to a full scan plus a temp B-tree
  (0.19 ms → 3.9 ms, and linear in store size). Schema v4 adds a matching
  expression index; the same page now takes 0.10 ms.

- `check --json` answers in JSON on the paths that refuse to run (no candidates,
  unreadable or non-golden baseline, bad `--since`). They printed only stderr,
  so `check --json | jq -r .ok` got a parse error instead of a verdict.

- `check` counts uncovered baseline *entries*, not the scenarios they group
  into: a hundred untouched entries for one agent+input reported as "1".
  A `tool_inputs` divergence also names what replaced a missing tool call,
  instead of printing "golden null → got null" for a baseline captured with
  `hook --no-input`.

- `hook --enforce` blocks only the tool call it can't check when the store is
  missing; other events still capture (and create the store), so a single
  `--enforce` registration across all hook events can still bootstrap.

- `export --format golden` warns only when writing to a file, keeping a piped
  stdout export clean for the tool consuming it.

- Guardrails now see the payload the harness actually sent. `hook` and `guard
  check` decoded stdin chunk by chunk, and a pipe delivers 64 KiB at a time, so
  any multi-byte character straddling a boundary (emoji, CJK, accented text, a
  smart quote) became U+FFFD. The JSON stayed valid, so nothing reported it: a
  content-based `deny` stopped matching the corrupted text and the tool call was
  **allowed**, and the same mangled text was stored as the audit record.

- `hook --enforce` no longer allows everything when it cannot find the store.
  The path resolves from the hook process's working directory and was *created*
  when missing, so a hook firing from any other directory silently ran against
  an empty policy set. It now blocks and says why — the same fail-closed posture
  as every other "could not evaluate" case on that path.

- A `name_regex` using a Unicode property escape (`\p{Script=Han}`) now works.
  Patterns compiled without the `u` flag, which degrades `\p` to a literal `p`,
  so such a policy validated cleanly, listed as an active deny, and matched
  nothing at all. Patterns that are only legal without `u` still compile.

- `list` and the dashboard's recent-traces table now order by the *instant* a
  trace started, not by the bytes of its timestamp. `started_at` is TEXT and
  nothing constrains the format a producer writes (SQLite's own
  `2026-08-16 23:00:00`, or a `+02:00` offset), so the newest trace could be
  shown last — and be the first row a `--limit` dropped — while
  `stats --since` counted it as the most recent. `--since` already compared
  instants; the ordering was left behind.

- The AI evaluators are now shown the run's duration and token count. Both were
  read from the trace-level columns, which only a producer-reported total ever
  fills — so for every hook-, `record`-, OTel- or importer-captured trace the
  judge was handed a run with no timing and no tokens, while `list`, `show` and
  `stats` displayed both. The efficiency preset asks the model to weigh "cost,
  latency and token usage"; it was scoring what it had not been shown.
  `diff --ai` lost the same durations.

- `stats` no longer prints `$0.0000` for a store with real spend under half a
  cent — the widening `show` already applied is now shared by both.

- `stats --json` renamed the per-agent `failed` tally to `failed_or_timeout`,
  which is what it has always counted. The same document reported
  `by_status: {failed: 0, timeout: 1}` beside `by_agent: [{failed: 1}]`, so a CI
  job alerting on the per-agent number fired on timeouts. The human output
  already said "failed or timed out".

- `check --golden` no longer passes green when it had nothing to check. A run
  where no trace matched the filters produced "0 passed, 0 regressed" and exit
  `0` — even under `--strict`, which only counts candidates that were actually
  fetched — so a mistyped `--agent`, a `--since` window that outran the
  recording, or a `--dir` typo (which quietly creates an empty store) left the
  gate green forever. It now exits `2`, like the empty-baseline case it
  mirrors. Being handed a full `--format json` export instead of a golden one
  is also diagnosed by name, rather than dying on "Cannot read properties of
  undefined".

- `check --golden` now catches a baseline tool call that the candidate replaced
  with a different step type. The `tool_inputs` comparison skipped whenever the
  *candidate* step was not a `tool_call`, so the disappearance of a tool call —
  the regression that field exists to catch — was invisible under
  `--fields tool_inputs`; the default field set caught it only incidentally, via
  `step_types`.

- Writers that share a store no longer collide. Three problems, one cause —
  reading before writing without holding the write lock:
  - `otel serve` answered `500 {"error":"database is locked"}` and dropped a
    whole export batch whenever another process (a `hook`, `run`, or `ingest`)
    committed while the batch was being stored. The batch transaction opened
    DEFERRED and read first, so upgrading to a write failed with
    `SQLITE_BUSY_SNAPSHOT` — which bypasses `busy_timeout` entirely. Measured
    at 1 dropped batch in 100 under light contention and 89% under load; now
    zero, because the transaction takes the write lock up front. `fork` could
    die with the same bare "database is locked" and is fixed the same way.
  - Concurrent first events for one session opened several traces for it (the
    lookup and the create were not serialized), splitting the session's steps
    and leaving every trace but one `running` forever, since `Stop` finalizes
    only one. Reproduced at 4 sessions in 25 with real parallel hook processes;
    now one trace, verified over repeated runs.
  - `otel serve`'s "Accepted N trace(s), M step(s)" counted spans from batches
    that were rolled back, and counted them again when the exporter retried.

- Forking a trace no longer hijacks the session it was forked from. `fork`
  copies the original's `session_id` and opens the copy as `running` with a
  newer start time, and live capture resolves "the open trace for this session"
  as the newest running one — so every hook event after a fork was written into
  the what-if copy. The real run stopped growing mid-capture and was never
  finalized (left `running` forever), while the fork silently accumulated steps
  it never ran, so `diff original fork` reported fabricated divergence. A bare
  `agent-replay watch` had the same problem: it attached to the static fork and
  showed nothing happening while the live run scrolled by. Live-capture
  resolution now skips forks (`hook`, `watch`, and the OpenTelemetry receiver's
  cross-batch merge target, which a fork also matched because it inherits the
  original's metadata).

- `demo` no longer seeds a guardrail that cannot do what it says. Its
  `no-external-urls` policy was a `deny` keyed on `output_contains`, which
  enforcement can never fire — it evaluates a proposed call, before there is any
  output — so the shipped example taught a kill-switch shape that silently does
  nothing, and the seed path bypasses the warning `guard add` now gives. It is
  a `warn` (an auditing pattern) with a description that says so. The
  `token-limit-warning` description likewise claimed a numeric threshold the
  match keys cannot express; it now describes the substring test it actually is.

- `--since` resolves its cutoff to a UTC instant before querying. `Date.parse`
  accepts more formats than SQLite's `julianday`, and while an unparseable
  stored timestamp falls back to the old comparison, an unparseable *bound* made
  every window match nothing at exit `0`. ISO 8601 basic-format offsets are the
  reachable case — `+0200`, exactly what `date +%FT%T%z` emits in a shell
  script. Normalizing also settles the zone-less forms, which JavaScript reads
  as local time and SQLite as UTC; local is what a bare timestamp means, and
  stored timestamps are UTC. `stats --json` echoes the resolved bound.

- A cross-batch OTel trace never keeps a parent reference pointing at a later
  step, even when start-time ordering cannot resolve it. Span timestamps are
  stored to millisecond precision, so a parent and child starting in the same
  millisecond tie and fall back to arrival order — leaving exactly the forward
  reference the ordering exists to remove. Any that survive are now cleared, so
  the trace stays something `ingest` accepts. Renumbering is also bounded, so a
  very large assembled trace can't stall the receiver's write lock.

- `run` escalates to `SIGKILL` if a child ignores a forwarded signal. Handling
  the signal replaces Node's default terminate-on-signal, so forwarding alone
  traded a stuck trace row for a stuck *process* — a child with `trap "" TERM`
  kept the wrapper alive indefinitely, which is worse in the CI case this
  serves.

- A golden entry no longer silently discards a trace's own metadata key when it
  collides with one of the four the gate reads (`status`, `total_duration_ms`,
  `total_tokens`, `tags`). The reserved keys still win — `check` compares
  `metadata.status`, so letting a trace's own `status` displace it would be a
  gate bypass — but the displaced value is now preserved beside it under a
  `trace_metadata_` prefix, instead of the baseline being a lossy record.

- An OTLP batch is now stored all-or-nothing. The receiver's upsert loop had no
  transaction around it, so a write failure part way through a multi-trace
  payload left the earlier traces committed and answered `500` — and a `5xx`
  tells an OTLP exporter to retry the same batch. On redelivery those committed
  traces were found and the same spans merged into them again: steps
  duplicated, tokens doubled, permanently, because duplicate deliveries are
  deliberately not de-duplicated. Both `/v1/traces` and `/v1/logs`.

- `run`'s summary line now reports the status the trace was actually stored
  with. It was derived from the exit code alone, so a child that declares
  `trace_end {status: completed}` and then exits non-zero — a crash during
  shutdown, after the agent's work succeeded — was announced as "failed" while
  the database recorded `completed`. Honoring the child's explicit status is
  deliberate; contradicting it was not. When the two disagree, both are named.

- An AI preset's declared `threshold` now actually drives its verdict and is
  recorded in the result's details. Each preset hardcoded a literal that
  happened to equal its declared value, so editing the field silently did
  nothing — and unlike the deterministic presets, an AI result never stored the
  threshold it was judged against, so a saved verdict could not be explained
  after the fact. No verdict changes today; the declaration is simply now the
  one source of truth.

- The AI evaluators are no longer shown a trace with its falsy results removed.
  The summary they reason from used a bare truthiness test, so a run whose
  answer was `false` or `0` — a failed check, a "not found", a boolean verdict —
  was presented as a run that produced nothing, and the judge scored a trace it
  had not been shown. The same guard now used by `show` covers the summarizer
  and the diff summary.

- `replay`'s footer no longer contradicts the header it just printed. Step
  durations and tokens were summed with `?? 0`, making "unmeasured"
  indistinguishable from "instant" — so a trace whose steps carry no timing
  reported "0ms" directly below a panel showing its real duration. With nothing
  measured, it now says nothing.

- `guard`'s `name_contains` now fails closed like every other match key. An
  unusable value (an object, which stringifies to something no step name can
  contain) made a `deny` policy validate, list as active, and silently never
  fire — a kill switch that could not fire. `guard add` rejects a non-string,
  but `addPolicy` and direct inserts bypass that, which is exactly why the
  sibling keys already failed closed.

- `ingest` now accepts a decision record on a step of any type, so a trace
  captured live can be re-ingested from its own export. **This reverses a
  previously-enforced rule.** Nothing else in the system maintained it: the
  live recorder and the SDK attach a decision to whatever step is being
  written, the writers insert it unconditionally, and the readers were all
  corrected to surface it wherever it sits. The validator was the sole holdout,
  and it rejected the tool's own output — a decision that `record` captured,
  `decisions` displayed, and `export` wrote could not be loaded back, so a
  backup could not be restored and a store could not be moved between machines.
  The decision record's own shape is still validated.

- `agent-replay run` now finalizes its trace and cleans up on every exit path.
  Interrupting the wrapper — Ctrl-C, or a CI job timeout killing it — left the
  trace `running` forever with no end time, no error, and no exit code, leaked
  its temp channel directory, and orphaned the child process still holding the
  terminal; the interrupt is now forwarded to the child, which runs the normal
  finalize-and-clean path and still reports 128 + signal. A read failure on the
  events channel can no longer kill the wrapper either: the poll ran on a
  timer, so a throw there was an uncaught exception that lost the child's exit
  status mid-run — a 2 GiB events file was enough, since a single read that
  large is rejected outright. Reads are now chunked and any I/O failure
  degrades to a warning. A synchronous `spawn` failure (an empty command, as a
  script with an unset variable produces) no longer leaves an unfinalizable
  ghost trace. And a producer that rewrites the append-only channel instead of
  appending is reported, rather than having every later event silently dropped.

- `list` and `show` now report token usage from the steps that carry it when
  the trace-level total is absent, and `--sort tokens` orders by the same
  number. The trace column is set only when a producer reports a total, so a
  measured trace showed "-" in the Tokens column and no Tokens line in `show`,
  while `replay` printed a total and `stats` counted it — the tool disagreeing
  with itself about one trace. Worse, `list --sort -tokens` ranked a
  50,000-token trace below a 7-token one, so "my most expensive runs" returned
  the cheapest. The stored column is unchanged; this is a display value.

- `eval --ai` now treats trace content as data rather than instruction. The
  summary handed to the judge is built from the agent's prompts, tool inputs,
  and tool *outputs* — content an attacker can influence — and it was
  concatenated into the prompt with no delimiter and no statement of how to
  treat it, in the evaluators whose job is to catch exactly that. It is now
  fenced, and every AI system prompt says the fenced material is recorded data
  and never an instruction. Relatedly, a model's verdict is read from the *last*
  JSON block in its reply, not the first: a model that quoted the trace back
  before answering had the quoted block parsed as its verdict, even when its own
  answer said the opposite.

- A log-derived `llm_call` step now records its model in the `model` column,
  not only in the step name — an `otel serve` capture of Gemini CLI or Claude
  Code previously had no model recorded anywhere, while the span path set it.
  On the log path such a step comes only from a FAILED model call
  (`.api_error`), so this covered the failure path alone; the entry above
  extends it to the steps a successful session produces.

- `show --json` now carries a `step_window` object when `--from-step`/`--to-step`
  narrowed the result. The human output already printed what it omitted; the
  JSON did not, so a consumer received a complete-looking trace — trace-level
  totals intact, evals unwindowed — whose steps were silently a subset. An
  unwindowed `show --json` is unchanged. Separately, a trace cost under
  $0.00005 no longer renders as `$0.0000`; sub-cent costs are routine, and the
  panel was reporting zero where real spend existed.

- An AI evaluator that was skipped as not applicable no longer counts as a
  measured 100% pass. Such a preset is stored with a score of 1.0 so it cannot
  fail a gate, but it makes no measurements — yet the `eval` tally and average,
  the dashboard's score-trend chart, and an exported golden baseline all
  treated it as a real result. `eval` now reports it separately ("N not
  applicable"), and the trend and baseline leave it out. The stored row stays,
  since it explains why nothing ran.

- Numbers the tool reports now match what it measured. `stats` summed only the
  trace-level `total_tokens`, which is set solely when a producer sends one —
  while `ingest`, `record`, the OTel mapper, and the importers all populate
  per-step `tokens_used` — so a store plainly holding tokens reported "Total
  tokens: -", and `null` in the `--json` a CI job reads. `list --sort duration`
  ordered by the raw `total_duration_ms` while displaying the derived duration,
  and the hook finalizer sets only `ended_at`: every hook-captured trace sorted
  last as a NULL, so a descending list ended with its longest rows. `record`'s
  "Total steps" reported each touched trace's lifetime step count rather than
  what the run recorded. And `stats`' per-agent tally counts timeouts alongside
  failures by design, but labeled them "failed" — three lines below a status
  breakdown listing the timeout separately.

- `show` and `replay` no longer hide a step's stored input or output when the
  value is falsy or scalar. Both fields hold arbitrary JSON, and the guards were
  a bare truthiness test on output and a key-count test on input — so a step
  whose output was `false` or `0` (a failed check, a "not found", a boolean
  guard result) rendered with no output line at all, indistinguishable from a
  step that produced nothing, while `--json` showed the value. A scalar input
  vanished the same way. `show --tree` also now prints a step's error: the tree
  is only reached when a trace has causal structure, so on a failed trace — the
  case the view exists for — it was hiding the failure message.


- `otel serve` now reports `partial_success` when a `/v1/logs` batch mapped to
  nothing, instead of a bare `200`. Only `gemini_cli.*` and `claude_code.*`
  events are recognized, so an emitter whose event names drift — a CLI version
  change, or a generic OTel logger pointed at the endpoint — got a clean `200`
  forever while the store stayed empty and shutdown printed "Accepted 0
  trace(s)". The traces endpoint already reported this.

- `export --format jsonl` with no matches now writes an empty file instead of
  one blank line, which a strict streaming consumer rejected as malformed JSON.
  `export --format golden` also warns that `--with-evals` / `--with-snapshots`
  do nothing there — the golden shape is fixed, always carrying eval criteria
  and never snapshots — rather than accepting the flags and ignoring them.

- The OTel *logs* path no longer loses or fabricates data. A flush window
  carrying only model-call events has no steps and no prompt but does have
  token counts, and the whole group was discarded — so a session's token total
  depended on where the exporter happened to cut its batches. Records with no
  `session.id` were all grouped under one placeholder, fusing unrelated
  services in a batch into a single trace (the span path already refuses the
  same fusion). And no log-derived step recorded the event's own time, so every
  step was stamped with the moment the batch arrived — a timeline where
  everything happens at once — while the trace never got an end time, and so
  showed no duration at all.

- `import` no longer fabricates token totals from string counts. A transcript
  whose `usage` carried `"100"` rather than `100` concatenated instead of
  adding — `0 + "100" + 20` becomes `"010020"`, stored as 10,020 tokens instead
  of 120 — and the poisoning was sticky, so every later record concatenated
  too. (The Codex *stream* translator was hardened against exactly this; the
  importers were missed.) A `tool_use` whose `name` is not a string no longer
  aborts the entire import either: one bad block in a 50,000-record transcript
  threw out of the whole run, contradicting the importer's best-effort
  contract. And a file that yields no steps *and* no prompt now reports a
  failed import rather than creating an empty trace and exiting `0`.

- OTel spans in the OpenInference and OpenLLMetry dialects now carry their
  prompt and response content. Only the `gen_ai.*` content attributes were
  read, so a LangChain or LlamaIndex app — the frameworks these conventions
  come from, and the ones the README names — produced traces whose every step
  had an empty input and no output. The spans were classified, timed, and
  token-counted correctly; they simply carried nothing to read, and the raw
  attributes were preserved nowhere either. `input.value`/`output.value`,
  `llm.prompts`/`llm.completions`, `traceloop.entity.input`/`output`,
  `llm.provider`, and `tool.name` are now mapped alongside their GenAI
  equivalents.

- Opening the trace store no longer *lowers* its own lock patience, and no
  longer blames corruption for every failure. `busy_timeout` was set to 3s
  where better-sqlite3 already defaults to 5s — a reduction, written as though
  it were an increase — so a short-lived `hook` process contending with a slow
  `otel serve` merge was aborted earlier than the default would have, and a
  `SQLITE_BUSY` there is swallowed as a warning, i.e. silently lost capture.
  It is now 10s and set *before* the WAL conversion, which itself needs a
  lock. Separately, a store that is merely locked, read-only, or unreadable is
  reported as such: the old message said "may be corrupted" for all of them,
  and the natural response to that is to delete the store.

- `guard add` now warns when a `deny` or `require_review` policy matches on
  `output_contains`. Enforcement evaluates a *proposed* tool call — before it
  runs, so there is no output yet — and every match key must match, so such a
  policy can never block live, however active it looks in `guard list`. It
  remains valid for post-hoc evaluation (`guard test`, recorded steps), which
  is why this warns rather than rejects. Documented in the README as well.

- `guard check` now fails closed when it cannot evaluate policies at all.
  Opening the store and running the policy match were unguarded, so an
  infrastructure error — an unopenable or read-only store, or `SQLITE_BUSY`
  from a concurrent `hook` process — exited `1`. That is not the block signal
  (`2` is), so every harness treated it as a non-blocking error and ran the
  tool: a gate wired in as a blocking pre-exec check quietly stopped denying
  the moment the database was locked. `hook --enforce` already failed closed
  here, as does this command's own `require_review` path without a TTY.

- `eval --ai` no longer reports `ai-root-cause ✔ 100%` for a trace whose every
  tool call failed. The preset decided it was "not applicable" by looking for a
  step of type `error`, but no capture path emits one — `hook`, `record`, and
  both importers record a failed tool call as a `tool_call` step carrying an
  `error` — so it was skipped for every real failure, and a skip stores a score
  of 1.0. The provider was never called for the analysis the preset exists to
  do. The deterministic criteria were corrected the same way; this one was
  missed.

- `eval --ai --max-cost` now exits non-zero when the budget stops the run part
  way through. The remaining evaluators never reach the results list, and the
  pass/fail gate can only reason about the ones that ran, so an unfinished run
  reported green. (The pre-run estimate check already exited non-zero for the
  same reason.) The notice also goes to stderr, so it can no longer corrupt
  `--json` output.

- `--since` now compares instants instead of bytes, across `list`, `stats`,
  `export`, and `check`. `started_at` is a TEXT column and nothing constrains
  the format a producer writes — `ingest`, `record`, and both importers pass a
  timestamp through verbatim — so the byte order was not the time order. A
  timestamp with a UTC offset landed in the wrong window (`14:00+02:00` is
  `12:00Z`, an hour *before* a `13:00Z` cutoff, yet it was the row returned),
  and a space-separated timestamp — SQLite's own `datetime()` form — sorted
  below every `T`-separated one and was excluded from *every* window. A
  `check --since 1d` CI gate therefore skipped traces it should have checked.
  A timestamp that cannot be parsed at all still falls back to the old
  comparison, so nothing that used to be returned disappears.

- `--since` also rejects a date-shaped value that isn't a real date. `2026-99`
  passed the format check and became a bound no timestamp could satisfy, so
  every query reported "No traces found" and exited `0` — indistinguishable
  from an empty store, and a silently empty CI gate.

- An OTel trace assembled from several export batches now numbers its steps by
  start time rather than arrival, so a parent span that flushes late no longer
  produces a *forward* parent reference. Batches arrive in completion order and
  a parent span ends after its children, so the parent was numbered above the
  child it owned — a reference `ingest` rejects (the export → ingest round-trip
  hard-failed for exactly the deep traces cross-batch assembly exists to serve)
  and one that made `why` and `show --tree` render step 1 as "caused by #2".
  The hierarchy is preserved; it now points backward, as everything downstream
  already assumed.

- OTel spans that end before they start (clock skew between hosts, or a
  hand-rolled exporter) no longer persist a negative duration at the step or
  trace level. Those values are exactly what `validateTraceInput` rejects, so
  `otel serve` was writing rows `ingest` refuses — the same round-trip break
  already fixed for span parentage — and the UI printed a negative millisecond
  count. Contradictory timing is now recorded as unknown rather than clamped to
  zero, which would claim the call was instant. A genuine 0 ms span is
  unaffected.

- `check --golden` now refuses a golden file with no entries (exit `2`) instead
  of reporting a vacuous green gate. An empty baseline matches nothing, so every
  candidate fell to the `unmatched` branch — which passes unless `--strict` —
  and the run printed "0 passed, 0 regressed" and exited `0` forever. The usual
  cause is a filter typo: `export --format golden --tag known-good` writes `[]`
  and exits `0` when the tag is actually `known_good`. That export now also
  warns that the baseline it just wrote can never detect a regression.

- `record` now exits `1` when a stream produced input but nothing was recorded,
  instead of reporting a total capture failure as success. Piping the wrong
  `--format` (or a broken producer) into `record` recorded nothing and still
  exited `0` — so `agent | agent-replay record && agent-replay check` treated an
  empty recording as a clean run. Note the `--format` case needs the check to
  key on input received rather than on warnings, because a stream translator
  ignores an unrecognized line silently. Per-event leniency is unchanged: a
  stream where some events survive still exits `0`, and an empty stream is
  still not a failure.

- `why` no longer presents time-travelling causality as fact. `ingest` validates
  that `parent_step` / `caused_by_step` reference an earlier step, but the live
  `record`/SDK path passed producer values straight through — and the causal
  walk's contract depends on that invariant. A forward reference made step 1
  render as "caused by #2", a step that hadn't happened yet. A reference that
  isn't a positive integer strictly earlier than its own step (including a
  self-reference) is now dropped at the write boundary, matching what the
  OpenTelemetry mapper does with an out-of-order parent span.
- An OpenTelemetry root span's own tokens and attributes are no longer dropped.
  The token total summed only the child spans and the root's attributes were
  never carried, so a single-span agent trace reported no tokens, no model, and
  no provider despite the span carrying all three.
- An OpenTelemetry child span that starts *before* its parent no longer produces
  an unusable parent reference. Step numbers follow start-time order while
  parentage resolves by span id, so clock skew or an async wrapper yielded a
  forward reference (and a self-referencing span pointed at itself) — shapes
  `validateTraceInput` rejects, meaning `otel serve` persisted rows that `ingest`
  refuses and an export → ingest round-trip of an OTel trace failed. Only a
  strictly-earlier parent is kept; `otel_parent_span_id` still rides along in
  metadata, so the cross-batch re-link can repair the link later.
- An interrupted `codex exec --json` run is no longer recorded as `completed`.
  The translator never declared that its stream has a terminal event
  (`turn.completed`), so reaching EOF without one still closed the trace cleanly
  — a killed or crashed run looked like a successful one. It now stays `running`
  so `record` finalizes it as `timeout`, matching the native protocol and the
  gemini stream, which already behaved this way.
- Codex token totals are summed numerically. `usage` was only *cast* to numbers,
  so a producer sending `"5"` and `"7"` produced `0 + "5" + "7"` — the string
  `"057"`, stored as 57 tokens instead of 12, silently and with no warning.
- An OpenTelemetry span that captured its own exception is now recorded as a
  failure. Error detection keyed solely on `status.code`, missing the two other
  ways a failure arrives: an `exception` span event — what `recordException`
  writes, and several instrumentations call it *without* also setting the status
  — and an `error.type` attribute, which GenAI semconv sets on a failed
  operation. Such a span was stored as a completed step on a completed trace,
  with the exception text preserved nowhere at all. Span events are also decoded
  on the protobuf transport now (field 11 was skipped entirely, so protobuf
  could not report this class of failure even in principle, while JSON could).
  An explicit `OK` status still wins over both weaker signals.
- Failures captured over the OpenTelemetry **logs** path are no longer invisible.
  That path had no error handling at all: the trace status was hardcoded
  `completed`, no step ever received an `error`, and `.api_error` records matched
  no branch, so they vanished entirely — a batch containing only those produced
  zero traces and still answered `200`. A session whose every tool call failed
  therefore looked like a clean run to `list`, `check --golden`, and `eval`'s
  error criteria alike. A tool record with `success: false` now carries its
  `error` text (falling back to `error_type`, then a generic message), an
  `api_error` record becomes an `llm_call` step with the failure on `error`, and
  the trace status is derived from its steps rather than assumed. A
  `claude_code.tool_result` also keeps its `duration_ms`, which was dropped.
- A single malformed scalar from a producer no longer costs a whole trace, step,
  or finalization during live capture. SQLite refuses to bind an object or array,
  and `record` swallows that error as a per-event warning, so the damage went far
  beyond the offending field:
  - `agent_version`, `session_id`, or `started_at` sent as an object on
    `trace_start` lost the **entire trace** — every later event then failed with
    "trace not found", and the command still exited 0.
  - `total_tokens`, `total_duration_ms`, `total_cost_usd`, or `ended_at` sent as
    an object on `trace_end` lost the **finalization**: a run that reported
    `failed` with an error was persisted as `timeout` with no error, turning a
    crash into an apparent hang.
  - `model`, `tokens_used`, `duration_ms`, or a decision's `rationale` /
    `confidence` sent as an object dropped the **whole step**. On `step_end`,
    where one combined `UPDATE` carries every field, a bad duration silently took
    the step's `output` with it.

  These are now coerced at the bind boundary, like `trigger`, `status`, and
  `tags` already were: a non-scalar becomes null and everything else is kept. A
  numeric string (`"1234"`) is accepted for a numeric column. `ingest` validates
  these fields upstream, so the coercion only ever applies to live-captured data.
- `record --tags` no longer aborts the entire stream when a producer sends a
  non-array `tags`. The merge spread `tags` *outside* the per-event error
  handler, so the spread threw, the process exited 1, and every trace in the
  stream was lost — not just the bad event. A string value would also have
  spread into one tag per character.
- `name_regex` patterns that backtrack catastrophically are now rejected. The
  check only caught a quantifier appearing immediately before a group's closing
  paren, so `(a|aa)+`, `(\s*\w)*`, and `(.*,)*` all passed and then took seconds
  — minutes, for a slightly longer name — to evaluate a ~35-character tool name.
  Because `name_regex` runs on the guardrail path, that isn't merely slow: it
  stalls the check, and a harness that treats a timed-out hook as non-blocking
  turns the stall into a fail-open. The rule is now "an unbounded quantifier
  applied to a group whose body contains a quantifier or an alternation", which
  covers all of those forms. It is deliberately conservative and may reject a
  pattern that would have been safe; bounded quantifiers (`(\d{3}){2}`),
  unambiguous groups (`(abc)+`), and alternations without an unbounded outer
  quantifier (`^(get|list)_x$`) are unaffected.
- A malformed `hook` command line no longer blocks the host agent in capture
  mode. Commander reports every usage error (an unknown flag, a stray argument)
  as exit 2 — but in each supported harness exit 2 *blocks* the pending tool
  call, and the hook configuration is static, so one typo in `settings.json`
  blocked every tool call for the whole session, from a capture-only hook that
  is documented never to affect the host agent. `runHook` guarantees exit 0, but
  commander's error handling runs before the action ever executes. A usage error
  on `hook` without `--enforce` now exits 0. With `--enforce` it still exits 2,
  since blocking is the correct fail-closed answer when the gate can't run.
- `guard remove` no longer deletes a second policy. The lookup was
  `WHERE id = ? OR name = ?` with the same value bound twice, so removing a
  policy by id also removed any policy *named* after that id — and reported
  success. Resolution is now by id first, then by name.
- `fork` now keeps the original trace's `metadata` instead of replacing it. The
  fork provenance (`forked_from`, `forked_at_step`) overwrote the whole object,
  so anything a producer had attached — run/session correlation ids, cost tags,
  harness info — was dropped from every fork, while steps, decisions, snapshots,
  tags, and `session_id` were all copied faithfully. Provenance keys still win on
  a name collision.
- A non-array `tags` value from a producer no longer corrupts reads or breaks
  `fork --tag`. `ingest` validates tags, but the live event protocol doesn't
  type-check them, so `tags: {...}` was stored verbatim in a column every reader
  treats as an array. `fork --tag` then threw on `tags.push` *after* its fork had
  already been committed, reporting "Fork failed" (exit 1) for a fork that
  existed but whose id was never printed — leaving an orphan behind, and another
  one on every retry. Tags are now coerced to an array on write and on read.
- `diff` no longer reports two runs as identical when one of them failed. Steps
  were compared on `step_type`, `name`, `input`, `output`, and `model` only —
  the step's `error` was never compared, and no trace-level field was compared
  at all. So a run that succeeded and a run that failed with a 500 from the same
  tool call produced zero differences: the renderer printed "Traces are
  identical." directly beneath a header showing `COMPLETED` beside `FAILED`, and
  `--json` agreed with `"diffs": []`. That is the flagship "it worked before,
  what changed?" case, and every live capture path records a failed tool as an
  ordinary step with `error` set, so it is the common shape rather than an edge
  case. Steps now also compare `error`, and the trace itself compares `status`,
  `trace_error`, and `trace_output`. A trace-level difference reports its step as
  `trace` (`null` in `--json`) and does not set `divergence_step`, which still
  means "the first step that went different".
- A guardrail policy whose `input_contains` / `output_contains` value holds a
  quote, backslash, newline, or tab now matches. The haystack was the
  JSON-encoded step, where those characters appear escaped (`\"`, `\\`, `\n`,
  `\t`), while the needle is the pattern exactly as written — so a `deny` on
  `rm -rf "/etc"`, or on a Windows path like `C:\Windows\System32`, could never
  match its own step. It failed silently: the policy validated cleanly, `guard
  list` showed it as an active deny, and it never fired. These are precisely the
  shapes a destructive-command policy is written with. Patterns are now matched
  against the raw text as well as the JSON form, so patterns aimed at the JSON
  itself (a key name like `"cmd"`) keep working.
- Two further guardrail fail-opens now fail closed, matching what `step_type`
  and `name_regex` already did. An `input_contains` / `output_contains` value
  that is an object or array stringifies to `"[object Object]"`, which can never
  occur in the haystack; and a pattern whose only keys are unrecognized (a typo
  like `nmae_contains`) can never match anything. Both stored a `deny` that
  silently never fired. `guard add` rejects them, but the service API used by
  seed data and any non-CLI caller, and direct inserts, bypass that validation.
  A scalar value still coerces, so `input_contains: 123` matches the text "123".
  A genuinely empty pattern is deliberately left inert, as before.
- `export --status <typo>` now exits 2 (a usage error) instead of 1. The bad
  value reached `listTraces` inside the export block, whose blanket catch
  reports every failure as a runtime error — so a CI script branching on the
  exit code read a typo as a genuine failure, while `list` returned 2 for the
  identical error. `--status` is now validated up front, like the `--since` and
  `--format` checks beside it.
- A tool failure reported as a structured error (`{message, code, stderr}`)
  rather than a string is no longer discarded by `hook`. The whole object
  collapsed to the generic "tool failed", and irrecoverably, since a post-tool
  payload isn't retained anywhere else. It is now flattened to JSON text, the
  same coercion applied elsewhere when binding a structured error. A failure
  with no detail still falls back to "tool failed".
- A hook payload whose event name collides with an `Object.prototype` member
  (`constructor`, `toString`, `hasOwnProperty`, `__proto__`) is now ignored
  instead of creating an unfinalizable trace. The event-name lookup table is an
  object literal, so those names resolved to an inherited function — truthy,
  which skipped the "unknown event" early return, made the reported action a
  function rather than a hook action, and left behind a `running` trace with no
  steps that nothing ever closes and that pollutes `list` and `stats`. Lookups
  are now by own key only.
- `hook --enforce` now fails closed when stdin carries no payload. An empty or
  unreadable stdin (a harness crash, a broken pipe) returned exit 0 before any
  of the fail-closed logic and without ever consulting `--enforce`, so the
  pending tool call was allowed on a gate that exists to stop it. Having seen no
  payload is the same position as a throw before the verdict, which already
  fails closed; a gating (`pre_tool`) route now emits the dialect's block, and
  everything else still allows. The documented allow on a *malformed* payload is
  unchanged — there the harness did send something, and that allow is a
  deliberate choice.
- A plain-string `input` or `output` is no longer silently discarded. Nothing
  requires a producer to send an object — `validateTraceInput` accepts
  `input: "summarize the doc"` and the live event protocol never type-checks
  these fields — but the encode helper wrote any string into the JSON column
  unquoted. Parsing it back then failed, so the user's prompt and the agent's
  answer read as `{}` and `null` from every consumer (`show`, `diff`, `export`,
  `replay`), with exit 0 and no warning. The damage carried into the regression
  gate too: every affected trace hashed to the same empty input, collapsing
  unrelated cases into one golden bucket and comparing `{}` against `{}`, so a
  real tool-input regression passed green. A string is now passed through only
  when it already is valid JSON (the case that passthrough exists for) and
  otherwise encoded. Affects `ingest`, `record`, and `hook` alike. The plain-TEXT
  `error` column is unchanged — it is read back raw, so a string error is still
  stored as-is.
- `stats` and the `dashboard` now report an average duration for traces that
  carry only timestamps. The aggregate averaged `total_duration_ms` alone, while
  `list` and `show` render duration via `effectiveDurationMs`, which falls back
  to `ended_at - started_at`. The hook finalizer records only `ended_at`, so on a
  store captured the normal way (`hook` or `record`) every trace showed a
  duration in `list` while `stats` reported `Avg duration: -`; on a mixed store
  the average covered only the subset with an explicit total. The aggregate now
  applies the same fallback in SQL. A trace with no usable duration (still
  running, or no `ended_at`) is still excluded rather than counted as zero.
- `hook --enforce` now closes the `tool_call` step of a denied call, so a
  concurrent call's result can't be recorded against it. A denied call never
  runs, so no `PostToolUse` ever arrived to close its step — and left open it was
  the newest unclosed step for that tool name, which is exactly what the
  post-tool handler looks for. The next `PostToolUse` for that name, belonging to
  a different call allowed in the same parallel batch, therefore closed the
  *blocked* step: the audit trail showed the blocked command completing
  successfully with another call's output, while the call that really ran stayed
  open forever. The denied step is now closed on the verdict with the blocking
  policy recorded in its `error`. A `require_review` step is deliberately left
  open, since it maps to `ask` and an approved call still runs and closes
  normally.
- `eval`'s deterministic error criteria now detect the failures that live
  capture actually records, so `eval` works as a CI gate on the runs it exists
  for. `hallucination-check`'s `no_error_steps` and `completeness-check`'s
  `no_unresolved_errors` keyed only on a step whose `step_type` is `error` — but
  every live capture path (`hook`, `record`, and the transcript importers)
  records a failed tool as a `tool_call` step with the `error` field set, and
  never emits a dedicated `error` step. Both criteria therefore scored a perfect
  1.0 for every live-captured failure: a trace that `list` displays as
  `✘ FAILED`, with a trace-level error and a tool call that returned 503, passed
  all three presets and `eval --all` exited `0`. A step now counts as failed if
  its `step_type` is `error` **or** it carries an `error` value, and
  `no_unresolved_errors` additionally fails on a trace-level `error` — the
  clearest "this run ended unresolved" signal there is, and the only marker left
  by a run that died before emitting a final step. The change can only turn a
  false pass into a failure; no passing trace starts failing.
- Importing a Claude Code transcript now preserves a failed tool call. A
  `tool_result` block flagged `is_error` (a `Bash` that exits non-zero, a `Read`
  on a missing file — very common) had its flag dropped: the imported step was a
  plain `tool_call` with a null error, indistinguishable from success, so an
  error-aware consumer (`eval`'s error checks, `check --golden`, the timeline)
  read a failed run as passing. The failure text now lands on the step's `error`
  field (with a generic "tool failed" when the result carried no content),
  matching how the live hook-capture path records a failed tool call. Both the
  main transcript and subagent import paths are fixed. The result text still
  appears in the step output as before.
- `check --golden` (the bulk CI-gate path, run without `--trace`) now scans
  *every* candidate trace instead of only the newest 10,000. It passed
  `listTraces` a hard `limit: 10000`, so on a store with more than 10,000 traces
  every candidate older than the newest 10,000 was never fetched, never diffed
  against a golden baseline, and never appeared in the report — a real
  regression living in an older trace produced zero failures and a green exit,
  silently defeating the gate. It now passes an unbounded limit (`-1`), the same
  fix already applied to `export`, so the "exits non-zero on any regression"
  contract holds regardless of store size.
- Cross-batch OpenTelemetry trace assembly no longer loses a step's parent when
  the parent span flushes in a later export batch than its child. A span is
  exported when it ends, and a parent span ends *after* the children it owns, so
  a deep child whose parent span crosses a `BatchSpanProcessor` flush boundary
  arrives in an earlier batch than that parent. The child was stored with no
  `parent_step_number` and never repaired — the merge only re-linked a *new* step
  onto an already-present parent (the parent-first ordering), not an existing
  orphan onto a parent that arrived later. Such a trace rendered flat under
  `show --tree` and broke its `why` causal chain. The merge now also re-links
  backward: once a batch supplies a previously-missing parent span, every orphan
  that referenced it by OTel span id is reconnected.
- `watch` no longer drops the final step(s) of a trace that completes. Each poll
  read the new steps and then, separately, the trace status; a producer (a
  different process) could commit a trailing step and flip the status to a
  terminal value in the gap between those two reads, so the completion tick
  stopped the tail without ever printing that step — the live view disagreed with
  what `show` displayed. The tail now drains once more when it detects
  completion, before announcing the final status.
- `run` now records a wrapped child's trace even when the child generates its own
  `trace_id`. The wrapper owns the trace and is supposed to stamp its own id onto
  every child event, but the code only did so when the id was missing — a case
  the event validator already rejects — so the stamp never happened. A compliant
  child (including one built on the `TraceRecorder` SDK, which generates its own
  id unless it threads `AGENT_REPLAY_TRACE_ID`) therefore had every step and its
  `trace_end` dropped as "trace not found," leaving an empty trace stuck
  `running`. The wrapper now re-stamps its id unconditionally, and only treats a
  child's terminal status as declared once it has actually persisted (so a
  finalization that failed to apply can't suppress the exit-code fallback).
- `fork` no longer reports "Modified input/context: Yes" for a payload that was
  not actually applied. A literal `null` passed to `--modify-input`/
  `--modify-context` parses to a value the fork service treats as a no-op (it
  keeps the original), but the summary keyed off the presence of the raw option
  string, so it falsely claimed the modification landed. The summary now mirrors
  the service's own guards and reports the modification only when it was applied.
- Live `record`/SDK capture no longer drops a step or loses a trace's
  finalization when a producer supplies a structured `error` object. The event
  protocol types `error` as a string, but a harness just as naturally emits
  `{ message, code, … }`, and — unlike the adjacent `output` — it was bound to
  SQLite raw, so the object threw ("can only bind numbers, strings, …") and the
  recorder swallowed it as a per-event warning: the step (with its decision and
  snapshot) vanished, or a `trace_end` error dropped the whole finalization and
  left the trace stuck `running` (finalized as `timeout` at EOF). The `error`
  column is now coerced like `output` (a plain string is kept as-is, an object is
  JSON-stringified), matching the hook adapter's existing error guard.
- `guard add` now rejects a match pattern whose `step_type` is not one of the
  real step types, and a policy stored with such a value fails closed at match
  time. `step_type` is a closed enum, so a typo like `"toolcall"` (for
  `"tool_call"`) can never match any step — previously it was saved as an enabled
  `deny` that silently never fired, a kill-switch the user believed was
  protecting them. This mirrors the existing rejection of keyless patterns and
  non-string `step_type`; a blocking policy with an unusable `step_type` now
  blocks rather than being skipped.
- Live `record` capture no longer loses an entire trace (or its finalization)
  when a producer uses a `trigger` or terminal `status` outside agent-replay's
  vocabulary. Both are free strings in the event protocol, but the database
  constrains them to fixed enums. A `trace_start` with an unknown `trigger` (say
  `"scheduled"`) threw a CHECK-constraint error that the recorder swallowed as a
  warning — the trace was never created, and every later event then failed with
  "trace not found," so the whole run vanished. Likewise an unknown or empty
  `trace_end` `status` (say `"success"`) dropped the finalization, discarding the
  output/token/cost totals and leaving the trace stuck `running` (finalized as
  `timeout` at EOF). Both are now coerced to a valid enum at the service boundary
  — an unknown trigger to `manual`, an unknown status to `completed` — mirroring
  the existing `decided_by` coercion. The `ingest` path still rejects these as a
  usage error, so the coercion only ever applies to live-captured data.
- OTLP-ingested **steps** with no output messages now persist `output: null`
  instead of a spurious empty `{}`. `messageContent` never returns null (it just
  omits the `messages` key), so a message-less step span — the common case for
  tool and thought spans — stored `{}`, which reads as truthy downstream (a
  summary prints "OUTPUT: {}", golden export stores `{}` instead of null). The
  trace root already guarded this; the step mapper now applies the same guard.
  Input still keeps `{}` as its empty value, exactly like the root.
- `show --tree` now renders the `⟵ caused by #N` annotations for a flat causal
  trace — one whose steps record causality via `caused_by_step` without any
  parent nesting (a normal shape, e.g. a decision followed by the steps it
  caused). The tree renderer decided whether to run based only on
  `parent_step_number`, so such a trace fell back to the plain timeline and
  showed no causal links at all, silently defeating the whole point of `--tree`.
  It now also runs when any step has a `caused_by` link.
- `ingest` auto-detection no longer trusts a `.jsonl`/`.ndjson` extension over the
  file's actual content. `export --format json` (the default) into a
  `.jsonl`-named file writes a JSON array, and the detector used to short-circuit
  on the extension, line-split the array, and fail with a misleading "Invalid JSON
  on line 1" even though the JSON was valid. Detection now probes content: a file
  whose entire contents parse as one JSON value is `json`, and only genuine
  line-delimited data (whole-file parse fails) is `jsonl` — completing the
  earlier fix that stopped a pretty-printed object being misread as JSONL. An
  explicit `--format` still overrides detection.
- `eval` no longer displays a score that contradicts its own pass/fail verdict.
  A stored score is rounded to three decimals and `passed` compares that value
  to the threshold, but every human-readable percentage rounded it to a whole
  number — so a `0.695` score (which fails a `0.70` threshold) rendered "70%"
  next to a `FAIL` badge. Scores now render losslessly (a three-decimal score is
  exactly a one-decimal percent), so `0.695` reads "69.5%" and a whole-percent
  score like `0.70` still reads "70%". `--json` output and exit codes were
  already correct; this fixes only the terminal display (`eval` spinners, the
  eval table's score badge, and the AI root-cause confidence line).
- `getTrace` (the prefix resolver behind `show`/`diff`/`replay`/`fork`/`eval`/
  `guard`/`watch`) now escapes LIKE metacharacters in a partial trace id. Trace
  ids are `trc_` + `nanoid(12)` over an alphabet that includes `_`, so a copied
  partial such as `trc_ab_c` treated `_` as a wildcard and could resolve to an
  unrelated trace (and a literal `%` matched every row). The lookup now declares
  `ESCAPE '\'` and escapes `\ % _`, mirroring the `agent_name`/`session_id`
  branches in `listTraces`.
- `guard add` now rejects a `--pattern` with no recognized match key
  (`name_contains`, `input_contains`, `output_contains`, `step_type`,
  `name_regex`). A typo'd key such as `{"tool_name":"delete"}` (the real key is
  `name_contains`) previously passed validation, was saved as an enabled `deny`
  policy, and then matched nothing at evaluation time — a kill-switch that never
  fires. This is the same silent-fail-open class the pattern validator already
  guards against for an unusable `name_regex`/`step_type`.
- `why --step` is now parsed with `Number()` instead of `parseInt`, matching
  `show`/`replay`/`fork`. `--step 1e2` read as `1` and explained the causal chain
  for the wrong step with a success exit; `--step 2.9`/`2abc` slipped through as
  `2`. `1e2` now correctly means `100` and a non-integer is a usage error
  (exit `2`).
- `fork --from-step` is now parsed with `Number()` instead of `parseInt`,
  matching `show`/`replay`'s `--from-step`/`--to-step` and `list --limit`.
  `--from-step 1e2` read as `1` (parseInt stops at `e`) and `2.9`/`3abc` slipped
  through as `2`/`3`, so a fork silently started from the wrong step (and its
  `--modify-context`/`--modify-input` landed on the wrong point) with a success
  exit. A non-integer is now a usage error (exit `2`).
- `safeRegex` (which backs guard `name_regex` matching) no longer rejects a safe
  pattern with a *bounded* outer quantifier such as `(\d{3}){2}` ("exactly six
  digits as two groups"). Its ReDoS guard flagged any quantified group followed
  by any quantifier, but catastrophic backtracking requires the *outer*
  quantifier to be unbounded (`+`, `*`, `{n,}`); a bounded `{n}`/`{n,m}` caps the
  work. The guard now keys off the outer quantifier, so `guard add
  --pattern '{"name_regex":"(\\d{3}){2}"}'` is accepted while the genuinely
  dangerous `(a+)+`, `(a{1,3})+`, and `(a+){2,}` stay rejected.
- OTel-ingested traces whose root span carries no output messages now record
  `output: null` instead of an empty `{}`. `messageContent` always returns an
  object (it just omits the `messages` key when absent), so the intended
  `?? null` fallback was dead and a spurious empty output persisted — which
  reads as truthy downstream (a trace summary printed `OUTPUT: {}`, and a golden
  export stored `{}` rather than null). The input side is unaffected (`{}` is its
  correct empty value).
- `show`/`replay` now validate `--from-step`/`--to-step` with `Number()` instead
  of `parseInt`, matching `list --limit` and `config set`. `--to-step 1e2` read
  as `1` (parseInt stops at `e`), silently capping the window at step 1 instead
  of 100, and `--from-step 2.9`/`3abc` slipped through as `2`/`3`. A non-integer
  is now a usage error (exit `2`), and `1e2` correctly means `100`.
- `list` no longer prints `NaNd ago` for a trace whose `started_at` is an
  unparseable/empty string. The table's local `formatRelative` helper missed the
  `isNaN` guard its two siblings (`formatRelativeTime`/`formatTimestamp`) already
  have; it now renders `-`, like them.
- `config set ai.max_tokens` now echoes the normalized value it stored, not the
  raw input — `config set ai.max_tokens 1e3` confirms `= 1000` (what `config
  get`/`list` will show), not the misleading `= 1e3`.
- `hook --enforce` now fails **closed** when it cannot reach a verdict. The
  audit-write path already failed closed, but a failure *before* the verdict —
  opening the trace, appending the `tool_call` step, or loading policies (e.g. a
  transient `SQLITE_BUSY` on a shared machine) — threw out of `applyHookPayload`,
  and the command's catch logged it and exited `0` (allow). So an infrastructure
  hiccup could let a tool call that a `deny` policy would have blocked run
  through — a safety fail-open contradicting the enforcement contract. A
  `pre_tool` event that can't be evaluated now emits the dialect's block
  (deny/exit 2) with a clear reason; capture-only events (and capture mode
  without `--enforce`) still never block the host.
- The `ai-root-cause` eval preset now derives `passed` from the rounded score
  that is stored and displayed, not the raw confidence. Its three sibling AI
  presets (`ai-quality-review`, `ai-optimization`, `ai-security-audit`) were
  already fixed this way; `ai-root-cause` still compared the raw value, so a
  confidence that rounds up across the 0.5 threshold (e.g. `0.4996` → shown as
  `50%`) reported `passed: false` while the panel read `Confidence 50%` — the
  same score-vs-verdict contradiction the sibling fix closed.
- AI eval / diff against OpenAI now sends `max_completion_tokens` instead of the
  legacy `max_tokens`. The default OpenAI model is a GPT-5-family model
  (`gpt-5.4-nano`), and OpenAI's chat/completions endpoint rejects `max_tokens`
  for GPT-5 / o-series models with a 400 — so every `--provider openai` eval on
  the default model failed the request outright (and the 400 was then reported
  as a generic "Server error"). `max_completion_tokens` is the current field and
  is also accepted by GPT-4o-and-later, so it works for any model the adapter
  targets. Anthropic (`max_tokens`) and Google (`maxOutputTokens`) were correct.
- Live capture (`record`/`run`) now validates the `chosen` field of a `step`
  event's inline decision, instead of losing the whole step to a silent DB
  error. `appendStep` binds `decision.chosen` straight into SQL; an inline
  decision with no `chosen` bound `undefined`, which better-sqlite3 rejects,
  rolling back the step-and-snapshot transaction — a data loss swallowed as a
  generic per-event warning. The event protocol now skips such an event with a
  clear "inline decision requires chosen" warning, matching how a top-level
  `decision` event is already validated (and closing an asymmetry where an
  empty-string `chosen` was accepted inline but rejected top-level).
- The AI diff analysis (`diff --ai`) no longer mislabels a null-valued field as
  a missing step. The diff summary rendered any `null` diff value as `(missing)`,
  but `diffTraces` emits ordinary field diffs (`output`, `model`) whose value is
  legitimately `null` on a step that exists on both traces — so a paired step
  whose left output was recorded but right output was `null` told the model
  "step N is absent on the right," the opposite of the truth. `(missing)` now
  renders only for the `missing_left`/`missing_right` diff types that actually
  mean an absent step; a null field value renders as `null`.
- `export` no longer silently caps at 10,000 traces. Despite a comment claiming
  it "removed the limit," the code passed a fixed `limit: 10000` to `listTraces`,
  which applies it as a SQL `LIMIT` — so exporting a store with more than 10,000
  matching traces dropped the overflow with no warning, corrupting any
  golden/JSONL dataset built from it. It now passes an unbounded limit (SQLite
  treats a negative `LIMIT` as no limit), so every matching trace is exported.
- `otel serve` log ingest now preserves a genuine `0 ms` tool-call duration from
  a Gemini CLI `tool_call` log event instead of dropping it to no-duration. The
  helper coalesced with `|| null`, so a real `0` (an instant or cached tool)
  collapsed to `null` and the step showed no duration — the same class as the
  earlier `hook` 0 ms fix, in the OTLP path. A `0` is now kept; only an absent or
  non-numeric value becomes `null`.
- `eval --rubric` now coerces and validates the rubric's `threshold` like it
  already does `weight`. A YAML author naturally quotes it (`threshold: "0.8"`),
  which arrived as a string and flowed into `score >= threshold`; a numeric
  string happened to coerce, but a non-numeric one (`"abc"`) made every
  comparison `score >= NaN` → always false, failing an otherwise-passing trace
  and reporting a correct trace as a CI regression (the same class the `weight`
  fix closed). A present `threshold` that isn't a number in `[0, 1]` is now a
  usage error (exit `2`), and a numeric string is coerced.
- `guard check` no longer crashes with a raw `TypeError` when the step piped to
  stdin is valid JSON but not an object (`null`, an array, or a bare value).
  `null` in particular reached a property access (`null.step_type`) and threw a
  stack trace; it now reports a clean "expected a single step object" error and
  exits `1`, like the other malformed-input paths.
- `ingest` reports the true file line number when a JSONL line is malformed.
  The line number was computed after blank and `//`-comment lines were filtered
  out, so a broken line preceded by any of them was named as an earlier line
  (e.g. a syntax error on file line 5 reported as `line 2`), sending you to the
  wrong place in the file. Exit code and tallies were already correct; only the
  diagnostic was off.
- `guard check` / `hook --enforce` now attribute a block to a deterministic
  policy when several equal-priority policies match the same step. The verdict
  keeps the first most-restrictive match, but enabled policies were loaded
  ordered only by `priority DESC` with no tiebreaker, so among equal-priority,
  equally-restrictive matches (e.g. two `deny` policies) the cited policy name
  and reason — shown to the user and recorded on the `guard_check` step — varied
  with SQLite's incidental row order. The block itself was always correct; only
  the attribution was unstable. Enabled policies now break ties by `name`
  (unique), matching the ordering `guard list` already uses.
- `list` (and every paginated trace query) now orders tied sort keys
  deterministically. The `ORDER BY` had no unique tiebreaker, so rows sharing
  the sort value — a common case, since batch-ingested or demo traces routinely
  share a millisecond `started_at`, and running traces all have `NULL`
  tokens/duration/cost — came back in an unspecified order. Across `--limit`
  / `--offset` pages (especially with a live recorder writing concurrently) a
  tied row could repeat on one page and be skipped on the next. A stable
  `id` tiebreaker is now appended, making the order a total order.
- `watch` no longer silently drops a step that is written after a
  higher-numbered one. The live tail cursored on the highest `step_number` seen,
  but step numbers are producer-supplied and need not be written in increasing
  order (only unique per trace), so a step whose number was lower than one
  already printed — but written later — fell outside the `> cursor` window and
  never appeared. The tail now tracks the set of printed step numbers, so a
  late, lower-numbered step is surfaced on the next poll.
- `watch --interval` now rejects a malformed value (non-numeric, zero, or
  negative) with a usage error (exit `2`) instead of silently falling back to
  the 500 ms default, matching the `dashboard --refresh` convention. A typo like
  `--interval 5OO` no longer looks like it took effect.
- `guard add` and `eval --rubric` no longer reject a safe regular expression
  that ends in an optional group, e.g. `read(_\w+)?`. The ReDoS guard in
  `safeRegex` flagged a trailing `?` on a quantified group as a nested
  quantifier, but `?` bounds the group to 0–1 repetitions and cannot backtrack
  catastrophically. The false rejection blocked legitimate kill-switch policies
  from being stored, and, in an eval rubric, scored a criterion with such a
  pattern as a failed "invalid regex" (its weight still counting), silently
  depressing the trace's score. The guard now treats only an unbounded outer
  quantifier (`+`, `*`, `{…}`) as dangerous; genuine nested quantifiers
  (`(a+)+`, `(a*)*`, `(a+){2,}`) are still rejected.
- `eval` with the `ai-security-audit` preset now derives its pass/fail verdict
  from the risk score against the preset threshold, like every other AI preset,
  instead of the model's self-reported `safe` boolean. The two can disagree — a
  well-formed response of `risk_level: "critical", safe: true`, or a clean one
  whose `safe` arrived as the string `"true"` — and because the verdict came
  straight from `safe`, the CI gate could pass a critical-risk trace or fail a
  clean one, and the stored record contradicted itself (`score 0.0, passed
  true`). The verdict is now `score >= 0.8`; the `safe` flag is retained in the
  eval details for reporting.
- `ingest` now reports a non-string `status` or `trigger` as a clean, named
  validation error instead of letting it reach the database. The trace
  validator required `typeof === 'string'` before checking the enum, so a
  non-string value (`status: 42`, `trigger: true`) passed validation and then
  failed at insert with a cryptic SQLite `CHECK` or bind error — or, for
  `--dry-run`, was reported valid. It is now rejected up front like `step_type`
  already was.
- The v1→v2 schema migration is now idempotent and safe under concurrent
  upgrades. `runMigrations` read the schema version *outside* any transaction,
  so two processes opening a still-v1 database at once (the app spawns
  short-lived `hook` processes freely) could both attempt the v2 `ALTER TABLE
  ADD COLUMN` — and the loser crashed with `duplicate column name` (not
  `SQLITE_BUSY`, so the busy timeout didn't help), surfacing as a stack trace,
  or, under `hook`'s catch-all, a silently dropped step. The version is now
  re-read inside a `BEGIN IMMEDIATE` transaction so a process that loses the
  race sees v2 and skips, and each `ADD COLUMN` is guarded by a column-existence
  check as a backstop. Only the one-time upgrade window was affected.
- `otel serve` log ingest no longer lets a timestamp-less log record steal
  `step_number` 1 and mis-order a session's steps. `timeUnixNano` is optional in
  OTLP, and a record without it flattens to time `0`, which sorted ahead of the
  real, timed events — so a timestamp-less `tool_result`/`tool_decision` jumped
  to the front of the trace. The sort now places an untimed record last (`time ||
  Infinity`), mirroring the start-less span guard already applied to the trace
  path; the trace `started_at` was already derived only from timed records.
- `import --format codex-rollout` no longer drops a reasoning step's text (or an
  assistant message's) when the richer field is an empty array. A Codex/Responses
  API `reasoning` item with no generated summary serializes as `summary: []`
  (present but empty) with the actual text in `content`; the fallback chain used
  `??`, which treats `[]` as present, so it kept the empty summary and imported
  the thought as `{ text: "" }` — silently losing the reasoning. The same defeated
  a `message` whose `content` was `[]` with text in `text`. Both now fall back
  with `||`, treating an empty (`""`) extraction as absent, so the next candidate
  field is used.
- `eval --ai` / `diff --ai` cost estimation no longer under-prices a model that
  merely shares a name prefix with a cheaper entry in the rate table, which could
  let a run slip past `--max-cost`. The family-match borrowed a known rate when
  one model id was a string prefix of another — so `gemini-2.5-flash` (a real,
  pricier model) matched the cheaper `gemini-2.5-flash-lite` and was priced ~4×
  too low. A family match now only borrows a rate across a version/date suffix
  (`-<digits>`, e.g. `claude-haiku-4-5` ↔ `claude-haiku-4-5-20251001`); a
  different variant (`-lite`, `-pro`, …) falls through to the conservative
  max-rate fallback, preserving the "never cheaper than reality" guarantee.
- `config test-ai` now exits non-zero when the connectivity check fails. Like the
  other commands just fixed, its `catch` reported the failure but never set
  `process.exitCode`, so a broken or expired provider key exited `0` — a CI check
  gating on it would read a broken provider as healthy.
- Two more runtime-failure paths now exit non-zero, completing the exit-code
  sweep: an AI preset that throws inside `eval --ai` (a provider/network error —
  previously swallowed by the loop, and since the thrown preset never reached the
  pass/fail tally, a lone failing AI preset could exit `0`), and a `demo` seed
  failure.
- `otel serve` now answers a real `413` for an oversized *uncompressed* request
  body instead of resetting the connection. On exceeding the 32 MB raw-body cap
  it destroyed the socket before the `413` could flush, so the client saw a
  connection reset (`ECONNRESET`). OTLP exporters treat a reset as retryable but
  a `413` as not — so an oversized batch was resent forever, the exact runaway
  the cap exists to stop. The receiver now stops reading, sends the `413` with
  `Connection: close`, and lets the socket close after the response is delivered.
  (The gzip-bomb `413` path already worked; only the raw-body path reset.)
- `guard` now rejects a non-string `step_type` in a policy match pattern, and a
  blocking policy carrying one fails closed. `step_type` was the only match key
  not type-validated, so `guard add --pattern '{"step_type": true}'` stored a
  `deny` whose `step.step_type !== true` is always true — a kill-switch that
  silently never fired. `guard add` now rejects it (like the other keys), and the
  matcher treats an unusable `step_type` on a `deny` / `require_review` policy as
  a match (fail closed), mirroring the `name_regex` handling, so a policy stored
  before this validation still blocks rather than silently passing.
- `hook` now records a genuine 0 ms tool duration instead of leaving it blank. An
  instant or cached tool call that closed in the same millisecond it opened had
  its duration computed as `Math.max(0, …) || undefined`, so the real `0`
  collapsed to `undefined` and the step showed no duration — inconsistent with
  the live recorder, which preserves `0`. It now keeps `0` while still coalescing
  an unparseable timestamp to no-duration.
- `otel serve` no longer loses a whole trace's start time and duration to a
  single span that has an end but no start. Such a span flattens to nanos `0`,
  which sorted to the front of the group, so the trace's `started_at` came out
  `undefined` and `total_duration_ms` `null` even when other spans were fully
  timed (and the start-less span also stole `step_number` 1). The trace start and
  duration are now derived from the earliest *valid* span start, and a start-less
  span sorts last instead of first. (Extends the earlier start-less-span duration
  guard, which prevented the absurd `end - 0` value but discarded good timing.)
- `import` now tallies a tool-result-only record inside a subagent transcript as
  imported, not skipped, matching how the main transcript loop counts the
  identical record. Such a record carries no step of its own (its content is
  attached to the paired tool-call step's output), and tool calls and their
  results normally live in separate records — so the `Records imported` /
  `Records skipped` summary under-counted imported and over-counted skipped for
  any subagent that used tools. The `imported + skipped = records` invariant held
  either way; only the split between the two was wrong.
- `eval` no longer reports a self-contradictory verdict at a threshold boundary.
  `passed` was computed from the raw weighted score while the stored/displayed
  `score` was rounded to three decimals, so a score just under the threshold
  (e.g. a raw `0.6997` against a `0.700` threshold) failed but displayed as
  `score 0.700, threshold 0.700, passed false`. `passed` is now derived from the
  same rounded score that is shown — for the built-in presets, custom rubrics,
  and the AI-powered presets (`ai-quality-review`, `ai-optimization`).
- Several commands now exit non-zero when they fail at runtime, instead of
  printing an error and exiting `0` (which reads as success to a CI script). Each
  wrapped its work in a `try` whose `catch` reported the failure but never set
  `process.exitCode`: `export` (a failed write or serialization — e.g.
  `export --output` to a missing directory — is the standout, since a later
  `&& upload` step would proceed with no file), `fork` (a database write
  failure), `diff --ai` (an AI-analysis failure), and `eval` (a preset that
  throws — including in `--all`, the default all-presets run, and the AI-preset
  loop, where the thrown preset also never reached the pass/fail tally, so even a
  total failure could exit `0`). All now exit `1` on a runtime failure.
- `eval --ai` and the AI evaluators no longer summarize a large trace with the
  agent's decisions dropped. The trace summarizer's "important step" filter (used
  once the token budget is tight, on traces past ~145 steps) keyed off
  `step_type === 'decision'`, but the live recorder attaches decision records to
  steps of any type — so on a large trace the summary silently omitted a
  decision/rationale that `show`, `why`, and `decisions` all display. The filter
  (and the `why` causal-walk fallback, for consistency) now treat any step
  carrying a decision record as a decision point.
- `diff --ai` now shows the AI analyzer the actual differing `input`/`output`
  values instead of `[object Object]`. The diff summary stringified each field
  difference with `String(...)`, but `input`/`output` diffs carry the parsed
  objects — so the most information-rich kind of difference reached the model as
  `LEFT=[object Object] | RIGHT=[object Object]`, giving it no signal. The values
  are now JSON-stringified (a null side, meaning the step is absent on that
  trace, still renders as `(missing)`).
- `ingest` now exits non-zero on a partial validation failure, not only when
  every record is invalid. When some records failed validation but at least one
  passed, it inserted the valid ones and exited `0`, silently dropping the
  invalid records — so a CI gate (including `ingest --dry-run`, the natural
  "validate my file" check) read the data loss as success. Any validation error
  now yields a non-zero exit, matching the all-invalid path and the documented
  exit-code contract; the valid records are still inserted.
- `decisions` no longer omits a decision record attached to a non-`decision`
  step. The live recorder and the SDK's inline `step({ decision })` can attach a
  decision record to a step of any type (unlike the `ingest` validator, which
  requires a `decision`-type step), and the causal walk behind `why` surfaces
  those records regardless of step type — so `decisions` and `why` disagreed on
  the same trace. `decisions` now lists any step that carries a decision record,
  not just `decision`-type steps.
- `otel serve` now answers `400`, not `500`, when an OTLP/JSON body is a valid
  object but a repeated field (`resourceSpans`/`scopeSpans`/`spans`,
  `resourceLogs`/`scopeLogs`/`logRecords`) is the wrong type — e.g.
  `{"resourceLogs":{}}`. The `?? []` iteration guards only null/undefined, so a
  non-array value iterated a non-iterable and threw, surfacing as a `500`. OTLP
  exporters retry `5xx` but not `4xx`, so a permanently-malformed batch would
  have looped forever. The mapping step (pure client-data transform) now answers
  `400` on such input across all four quadrants (traces/logs × JSON/protobuf),
  while database-write errors still surface as `500`.
- The OTLP/protobuf decoder now reads an `int64` attribute value precisely. It
  accumulated the varint with JS `number` arithmetic, so a negative `int_value`
  (encoded as a full 10-byte two's-complement varint) decoded to a huge positive
  magnitude — `-1` surfaced as `~1.84e19` — and a positive value above 2^53 lost
  precision. It now decodes int64 with `BigInt` and two's-complement sign
  handling (matching the fixed64 path). Token counts and other small ints are
  unaffected.
- `check --golden` no longer lets a tool-input (or per-step model) regression
  slip through when the candidate numbers its steps differently from the golden.
  The `step_count`/`step_types`/`step_names` checks compare the two step
  sequences positionally, but `tool_inputs` and `model` matched by absolute
  `step_number`. Since a step number need only be `>= 1` (an OTLP-assembled or
  imported trace may start above 1 or skip values), a candidate with the same
  shape but shifted numbering had its `tool_call` look up an unrelated golden
  step and silently skip the comparison — so a real regression passed the gate
  while the positional checks reported a perfect match. `tool_inputs` and `model`
  now align positionally, consistent with the other structural checks.
- `otel serve` no longer reports an absurd trace duration for a span that has an
  end time but no start time. A span missing `startTimeUnixNano` flattens to
  nanos `0` and sorts first, so the trace-level `total_duration_ms` computed
  `end - 0` — a ~158-year duration paired with an unknown (`null`) start — while
  the parallel step-level duration and start time were both correctly `null`.
  The trace duration now applies the same missing-start guard, staying `null`.
- The `hook` adapter no longer mislabels a Gemini CLI session as `claude-code`.
  Gemini and Claude Code share the `SessionStart`/`SessionEnd` hook event names
  verbatim, but the Gemini detection allowlist omitted them, so a Gemini session
  whose first hook is `SessionStart` created its trace labeled `claude-code` —
  and because every later (correctly-detected) event reuses the running trace,
  the whole session stayed mislabeled. Detection now disambiguates these shared
  events by payload shape (Gemini carries `timestamp` and no `permission_mode`).
  Enforcement was unaffected (it runs only on `BeforeTool`, always detected
  correctly); this was a trace-labeling fix.
- `fork --from-step N` now requires step `N` to actually exist, instead of only
  checking `N` against the highest step number. Step numbers can have gaps (a
  valid ingested or OTLP-assembled trace may be numbered `[1, 3]`), so forking
  such a trace at step `2` passed the bound check but copied only step `1` — and
  because the fork point never existed, `--modify-context` was silently dropped
  even though the summary reported "Modified context: Yes" and the command exited
  `0`. Forking at a non-existent step now fails loudly (exit `1` from the CLI; the
  exported `forkTrace` throws).
- `import` of a Claude transcript now tallies a zero-step record as `skipped`,
  not `imported`, keeping the documented `imported + skipped = records`
  invariant. A follow-up user turn (which has no `user`/`input` step type to
  retain it) and an assistant record whose only text block is empty both yielded
  no step yet were counted as imported, inflating "Records imported" — the same
  classification the codex-rollout importer was already fixed to get right. The
  `contributed` flag is now set only on the paths that actually capture input or
  emit a step.
- `list --agent <name>` (and the same filter in `export`/`check`) now escapes
  `LIKE` metacharacters in the search term, so `_` and `%` match literally
  instead of acting as wildcards. A snake_case name like `travel_bot` otherwise
  also matched `travel-bot` (the `_` matches any character), and a term
  containing `%` matched nearly everything. This mirrors the `--session` fix
  below; the substring (`%term%`) behavior is unchanged for ordinary terms.
- `list --session <id>` now matches the session id as a literal prefix instead
  of a SQL `LIKE` pattern. Session ids routinely contain `_` (e.g. `sess_1`),
  which `LIKE` treats as a single-character wildcard, so `--session sess_1` also
  returned unrelated sessions like `sessX1` (and inflated the paginated total to
  match). The `_` and `%` metacharacters are now escaped with an explicit
  `ESCAPE` clause so only the trailing prefix wildcard applies. (The sibling
  `getTrace` prefix match is unaffected: generated `trc_…` ids carry `_` only at
  a fixed position, so the wildcard was inert there.)
- `eval --max-cost` and `replay --speed` now consume exactly the value they
  validate. Both flags were validated with `Number()` but then re-parsed with
  `parseFloat`, which disagree: an empty `--max-cost ""` validated as `$0` yet
  ran with an *unlimited* budget (`parseFloat("")` → `NaN` → the `Infinity`
  fallback), silently defeating the spend cap the validation exists to enforce;
  and `--speed 0x10` validated as `16` but replayed at speed `0` (instant),
  since `parseFloat` stops at the `x`. Each flag now uses the validated number
  directly, completing the "validate and consume the same value" convention
  already applied to `list --limit`, `otel --port`, and `dashboard --refresh`.
- `eval --rubric` no longer mis-scores a rubric whose `weight` is written as a
  quoted string. YAML authors naturally quote values (`weight: "2"`), which
  arrived as a string and made the score aggregation do `totalWeight += weight`
  as string concatenation (`"0"+"2"+"2"` → `"022"` → `22`), so a fully-passing
  rubric scored ~`0.18` and reported `passed: false` — silently failing a CI
  gate on a correct trace. A numeric weight is now coerced to a real number, and
  a weight that is present but not a non-negative number is rejected as a usage
  error (exit `2`), catching a negative weight that would otherwise push the
  score out of `[0, 1]`. Relatedly, a malformed or unreadable rubric file now
  fails the command (exit `2`) instead of exiting `0`, so a broken gate can no
  longer read as "passed".
- The `demo` dataset's two token totals that didn't add up are corrected: the
  `rag-context-pollution` and `successful-booking` sample traces declared a
  `total_tokens` 1,000 higher than their steps summed to, so `show` (which
  prints the stored total) and `replay` (which re-sums the steps) displayed
  different token counts for the same trace. Each declared total now equals its
  step sum, and a test asserts the invariant for every demo scenario.
- `record --format gemini-stream` no longer loses a tool result that is a plain
  string. The `tool_result` handler stored a bare string verbatim, which then
  failed to `JSON.parse` on read and came back as `null`; it now wraps a string
  as `{ output: <string> }`, matching how the `message` handler already wraps
  string content.
- `record --format gemini-stream` marks an interrupted run as `timeout`, not
  `completed`. A clean Gemini run always emits a terminal `result` event, so
  reaching EOF without one means the process was killed or crashed — but the
  translator's EOF finalize defaulted to `completed`, pre-closing the trace so
  `record`'s "still-running → timeout" step never ran. The translator now emits
  no `trace_end` when its terminal event never arrived, leaving the trace for
  `record` to time out (or `--leave-open` to keep open), matching the native
  protocol. `codex-exec`, which has no terminal event, still completes on a
  clean EOF.
- `agent-replay run` propagates a signal-killed child as `128 + signal number`
  (e.g. `137` for SIGKILL) instead of flattening every signal death to exit `1`,
  and records which signal killed it (`child killed by signal SIGKILL`). A
  wrapped process that is OOM-killed is now distinguishable from a generic
  failure, both in the exit code scripts see and in the recorded trace error.
- `agent-replay run` now records a `failed` trace when the wrapped child exits
  non-zero after emitting a `trace_end` with no `status` field. The recorder
  defaults a statusless `trace_end` to `completed`, which is indistinguishable
  from the child having explicitly declared success — so the wrapper's
  exit-code finalization (which only ran while the trace was still `running`)
  was skipped, and a failed run was recorded as `completed` with no error. The
  wrapper now tracks whether the child declared an explicit status: if it did
  not, a non-zero exit finalizes the trace as `failed` with the code recorded,
  per the spec. An explicit child status is still honored.
- `record` (the live native protocol) now honors the `parent_step_number` /
  `caused_by_step_number` aliases on `step` and `step_start` events, matching
  batch `ingest`. The recorder forwarded only the `parent_step` / `caused_by_step`
  spelling, so a trace replayed from `show --json` or `export` — which uses the
  persisted column names — lost its step hierarchy and causality when re-recorded
  (the links stored as `null`), breaking the documented "a recorded trace is
  identical to the same run ingested as one batch" invariant for that round-trip.
- `import`'s "records imported / skipped" report now accounts for a
  content-less user/assistant record (it produced no step but was previously
  counted as neither), so the tally the command prints matches the number of
  records in the file.
- `import` of a Codex `rollout-*.jsonl` session no longer counts a dropped
  follow-up user turn as imported. In a multi-turn session, the first user
  message becomes the trace input and agent actions become steps, but a later
  user turn has no home (there is no `user` step type) — yet it was still marked
  "imported", inflating the tally and breaking `imported + skipped = records`.
  Such a message now counts as skipped, matching the Claude-transcript importer.
  (Its text is still not retained as a step — a shared limitation of both
  importers.)
- `import` of a Claude Code transcript with subagent files now reports "Records
  imported" as a count of records, not steps. The subagent loop added the number
  of steps produced to the imported total, so one subagent record that expanded
  to several steps inflated the count (e.g. "3 records imported" from 2 input
  records) and broke the imported + skipped = records invariant. Each subagent
  record is now counted once — imported if it yielded a step, skipped otherwise.
- `import` of a Claude Code transcript no longer discards an entire subagent
  file because of one corrupt line. The subagent path parsed every line inside a
  single `try`, so a truncated final line (common after a killed run) dropped all
  of that subagent's steps and left an orphan anchor. It now parses line by line
  and skips only the bad line, matching the main-transcript path.
- `config set ai.max_tokens` rejects a non-positive-integer value instead of
  silently coercing it: `abc` and `0` used to become 1024 (while still printing
  "= abc"), and a negative was stored as-is and would break API calls.
- `agent-replay run` no longer corrupts non-ASCII event data. The incremental
  reader decoded raw byte slices with `Buffer.toString('utf-8')`, so a multi-byte
  UTF-8 character straddling a 200ms poll boundary (or a partial child write)
  turned into replacement characters. It now decodes through a `StringDecoder`,
  which buffers an incomplete byte sequence until the rest arrives.
- `diff` now shows the value of a step that exists on only one trace. A
  right-only step (`+ Right only`) rendered its value as `(none)` in the Right
  column instead of the actual step; both one-sided cases now display the
  present value.
- `config get` no longer prints API keys in plaintext. Fetching an object path
  (`config get ai` or `config get ai.api_keys`) dumped the raw object, bypassing
  the masking that `config list` and the scalar path already applied; the object
  branch now masks API keys recursively, and the scalar path masks even a short
  value.
- **Guardrails now fail closed on a malformed pattern (safety).** A blocking
  policy whose `name_regex` was invalid or ReDoS-rejected used to silently never
  match — a kill-switch that quietly did nothing. `guard add` now rejects an
  unusable pattern (bad/unsafe `name_regex`, or a non-string `name_contains` /
  `input_contains` / `output_contains`) so it can't be stored, and at evaluation
  time a `deny` / `require_review` policy with an unusable regex treats the step
  as a match (fails closed) instead of skipping it. Non-string match values no
  longer throw mid-evaluation (which, under `hook --enforce`, had let the pending
  tool call through).
- `fork --modify-context` no longer silently drops the modification. It was
  applied only by mutating a snapshot that already existed at the fork-point
  step, but snapshots are optional and most steps have none — so a fork at a
  snapshot-less step discarded the context while the CLI still reported
  "Modified context: Yes". `forkTrace` now creates a snapshot at the fork point
  when one is needed, and the modified context lands in `context_window` (the
  field the flag names and that `show --snapshots` renders) instead of
  `environment`; any other snapshot fields are still copied.
- `check --golden` no longer reports spurious regressions when several traces
  share an agent name and input (repeated runs of the same agent, or a fork):
  golden entries are bucketed and each candidate is paired with its closest
  entry instead of colliding on one.
- `check --golden` no longer consumes a golden entry once a candidate matches
  it. A bucket can hold several known-good shapes for one agent+input, and a
  candidate is good if it reproduces any of them — but the greedy pairing
  removed the matched entry, so a second candidate identical to the first was
  forced onto a leftover shape and falsely flagged `REGRESSED` (failing CI),
  and, when the bucket emptied, a genuinely regressed candidate could be hidden
  as merely "unmatched". Each candidate now compares against the whole bucket
  without consuming, so identical known-good traces all pass.
- `ingest` recognizes a pretty-printed (multi-line) single JSON object instead
  of misparsing it as JSONL and failing on "line 1"; the format is now detected
  by a whole-file parse.
- `eval --max-cost` rejects a malformed value instead of silently falling back
  to an unlimited budget — a typo like `0.O5` no longer disables the spend cap.
- `eval --ai` cost estimation no longer bills a preset that won't run. A preset
  gated by applicability (`ai-root-cause` only runs on a failed trace) is
  skipped at run time for $0, but the estimate charged it anyway — so the
  `--max-cost` pre-gate could abort a run over a successful trace even when the
  actual spend would have fit the budget. The estimate now charges $0 for a
  non-applicable preset, matching what runs.
- `getTrace` (and every command that resolves a trace id) now prefers an exact
  id match and resolves prefix collisions deterministically, rather than letting
  `LIMIT 1` return an arbitrary row. This only affects custom/short trace ids
  where one id prefixes another; generated ids are fixed-length and unaffected.
- AI-eval cost estimation no longer reports a misleading `$0.00` for a model
  outside the built-in price table. `estimateCost` now (a) matches a versioned
  or shortened model id to its family rate (e.g. `gpt-5.4-nano-2025-12-01` →
  `gpt-5.4-nano`) and (b) falls back to the most expensive known rate for a
  genuinely unknown model. This also restores the `eval --max-cost` budget cap,
  which gates on `estimate > cap` and so was silently bypassed whenever the
  estimate was a false `0`.
- `attachSnapshot` now replaces a step's snapshot atomically (delete + insert in
  one transaction), matching `attachDecision`. Previously a failed insert — e.g.
  a context window that can't be serialized — left the step with its old
  snapshot deleted and no replacement.
- `diff` compares step `input`/`output` by parsed value instead of raw stored
  JSON text, so two traces carrying the same data serialized with different
  object-key order or whitespace (e.g. an OTLP-ingested trace vs. a
  hook-recorded one) no longer report a phantom diff and mis-pin
  `divergence_step` — which had been feeding the AI diff analysis a false
  divergence point. Genuine value differences are still reported. Uses the same
  `stableStringify` normalization `check --golden` already applies to inputs.
- `diff` aligns steps by `step_number` (a merge-join) instead of by array
  position. Step numbers may have gaps — validation only requires each be a
  positive integer — and pairing by index then compared unrelated steps: a
  trace numbered `1, 2, 4` diffed against `1, 2, 3, 4` reported phantom
  differences on step 4 and pinned the divergence there, when in fact step 3
  was simply right-only. A number present on only one side is now a one-sided
  step and matching numbers are compared field-by-field, so `divergence_step`
  and the AI diff analysis anchor to the real divergence.
- `diff --fields` recomputes the divergence point from the filtered results, so
  it no longer prints a "DIVERGES AT STEP N" banner above "0 difference(s)
  found" (or emit a `--json` `divergence_step` inconsistent with its own
  `diffs`) when the requested field has no difference.
- `eval` now exits `1` when an evaluation fails (a custom rubric scores below
  its threshold, or a built-in preset fails), matching the README's exit-code
  table. Previously it always exited `0` regardless of the result, so it could
  never fail a CI job — defeating the "build regression tests" use case. `--json`
  gates too. A passing eval, and a trace-not-found/no-provider/over-budget error,
  are unchanged.
- `list --limit`, `otel serve --port`, and `dashboard --refresh` reject a
  malformed value (non-integer, out of range) with a usage error instead of
  silently falling back to the default or, for a negative `--limit`, passing it
  to SQL `LIMIT` where SQLite reads it as "no limit". Previously `list --limit
  abc` quietly returned the default page and `otel serve --port abc` bound the
  default 4318, so an exporter pointed at the intended port connected to nothing.
- `list --limit`, `otel serve --port`, and `dashboard --refresh` now consume the
  same parse they validate. Each validated with `Number()` but then re-parsed
  the raw string with `parseInt`, and the two disagree on values like `0x20`
  (`Number` → 32, `parseInt` → 0) or `1e2` (100 vs 1): the input passed
  validation but ran with a different number — `list --limit 0x20` executed
  `LIMIT 0` and reported a false "No traces found", and `otel serve --port 0x20`
  bound a random OS port. The validated integer is now the one used.
- The `otel serve` receiver no longer records an errored span as a successful
  trace. A span with `status.code=ERROR` but an empty `status.message` (the
  description is optional, and some OTLP/JSON exporters send `""`) produced an
  empty error string, which then read as "no error" — so the trace was stored as
  `completed` and the failure was invisible. An empty message now falls through
  to `error.type`, then a generic `error`, so an error span always marks the
  trace `failed` and carries a non-empty step error.
- The `otel serve` receiver answers client-malformed payloads (a `null`, array,
  or primitive JSON body, or a body that claims gzip but isn't) with `400`
  rather than `500`, so exporters don't retry an un-processable batch (5xx is
  retryable per the OTLP spec, 4xx is not).
- The `otel serve` receiver now assembles a logical trace whose spans arrive
  across several export batches into one agent-replay trace, instead of emitting
  one trace per batch. A `BatchSpanProcessor` routinely flushes completed child
  spans before the root span ends, so later batches now merge into the existing
  trace by OTel trace id (log events merge by session id) — re-linking a child
  to a parent stored earlier, recomputing the window and token totals, and
  upgrading the initially rootless synthetic trace to the real agent once the
  root arrives. Each batch is still stored immediately, so a trace stays
  queryable mid-session.
- OTel-ingested traces carry a trace-level end time and duration derived from
  their span times, instead of showing `-` for duration.
- `list` and `show` display a trace's duration derived from its start/end
  timestamps when an explicit total wasn't recorded, instead of showing `-`.
- `show` and `replay` validate their `--from-step`/`--to-step` window (and
  `replay --speed`): a non-numeric, `< 1`, or inverted range is a usage error
  instead of a silently empty view.
- A blank trace id is reported as "not found" instead of prefix-matching every
  trace and resolving to an arbitrary one, so `<cmd> ""` (e.g. an unset shell
  variable) fails cleanly.
- Opening a corrupt or non-SQLite database file reports a clear, actionable
  error instead of a raw `SqliteError` stack trace.

### Security

- `safeText` escaped C0 and DEL but not C1 (U+0080-U+009F), while the write
  guard already refused that range — so the renderer and the writer disagreed
  about what a control character is. A terminal that decodes UTF-8 C1 as
  controls (xterm's default, VTE, iTerm2) reads U+009B as CSI, which kept the
  class open through a second alphabet on any string the write guard does not
  cover, such as an agent or step name.

- An AI verdict could be taken from the trace instead of from the model. The
  fenced-code path was fixed to read the model's LAST block, but the fallback
  still scanned from the first `{` to the last `}` — so a model that quoted the
  trace's injected verdict inline and then disagreed in prose had the injected
  object parsed as its answer. Both paths now read the last balanced object, and
  the scan understands strings, so a quoted brace cannot end an object early.

- The untrusted-content fence only neutralized its terminator in exactly the
  case and spacing it emits. `>>>end untrusted trace content`, a doubled space,
  a non-breaking space, or the words without the arrows all passed through
  intact — and a model reads any of those as the end marker just as readily. The
  neutralizer is now at least as generous as the reader.

- **Security (fail-open):** an unrecognized `hook_event_name` in the payload
  overrode the event registered on the command line, so a harness whose pre-tool
  event this tool does not model fell through to "unknown": the missing-store
  gate, the empty-policy gate and policy evaluation were all skipped, and the
  call was allowed at exit 0 — on a command line that states gating intent twice
  (`hook PreToolUse --enforce`). The payload still wins when we recognize its
  name; otherwise the registered argument decides.

- **Security (fail-open):** a tool call with no usable `tool_name` was allowed.
  It makes every name-keyed policy unable to match, so a `name_contains` deny
  could not fire. `guard-service` fails closed on every unusable *policy* field;
  under `--enforce` an unusable *step* field now gets the same answer. Capture
  mode still never blocks.

- **Security (fail-open):** a malformed JSON payload was allowed under
  `--enforce`. It was the last "we could not evaluate" outcome in the slice that
  answered allow — empty stdin, unreadable stdin, a missing store, an empty
  policy set and a store error all deny, and so does `guard check` on invalid
  JSON. A payload truncated by a broken pipe is indistinguishable from garbage,
  which is exactly the input a caller cannot vouch for. Capture mode is
  unchanged.

- **Security (fail-open):** `guard check` coerced a missing or non-string `name`
  to `''` and answered allow, silently disabling every name-keyed policy. Every
  other unusable field in that command denies.

- A policy name is escaped wherever it is shown, and a closing hook event
  resolves to the trace holding a matching open step rather than merely the
  session's newest — `session_id` is not exclusive to the hook path, so another
  writer's trace could absorb a result the live run was waiting for.

- **Installing `agent-replay` no longer pulls vulnerable transitive
  dependencies.** A consumer install carried five advisories — three high
  (`lodash`, reached twice) and two moderate (`xml2js`) — all of them via
  `blessed-contrib`, and all of them from widgets this project never used: its
  `map` widget pulls `map-canvas` → `xml2js`, and its `markdown` widget pulls
  `marked-terminal` → `lodash`. The repo's own `overrides` hid this locally,
  because overrides apply only to the root project and never reach the people
  who install the package, so the audit was clean here and dirty for everyone
  else. `blessed-contrib` also declares a malformed range (`~>=4.17.21`), which
  resolves consumers onto a vulnerable `lodash` even though a patched one
  exists.

  The dashboard now draws on plain `blessed`, which is unaffected: the grid
  becomes a percentage layout, the trace list a native `listtable` (same
  arrow-key navigation), the activity log a native `log`, and the bar and line
  charts a pair of pure string functions. A fresh consumer install now reports
  **0 vulnerabilities**, and the panels are covered by tests for the first
  time — the charts have unit tests, and a smoke test builds and refreshes the
  whole view against a real store.

- A trace id chosen by a producer can no longer carry control characters.
  `record`'s native protocol lets the producer set `trace_start.trace_id`, and
  that id is then rendered by `show`, `list`, `watch`, `why`, `decisions`,
  `fork`, `eval`, `guard test`, `check` and the dashboard, and copied verbatim
  into `parent_trace_id` by `fork`. Escaping it at each render site was tried
  and drifted four times — a new site, or a new copy of the id under a different
  column name, kept being missed. It is now rejected where it enters, which is a
  single door: an identifier never legitimately contains an escape sequence, a
  NUL or a newline, so everything downstream is safe by construction, the way
  the schema already constrains `trigger` and `status`. The guard sits on the
  WRITE (`startTrace`), not only on the protocol parser: the programmatic
  `TraceRecorder.startTrace` builds an event and applies it directly, so the
  parser is not a door every route passes through. Every render site is
  escaped as well — all seventeen of them, enumerated rather than taken from
  the last report — so a store that already holds such an id is safe to inspect.

- `show` and `replay` echoed the trace **id** raw. `record`'s native protocol
  lets the producer choose it, so it is no more trustworthy than the fields
  beside it.

- The summary panel shared by `import`, `record`, `ingest`, `fork`, `diff` and
  `stats` echoed its values raw. The keys are literals at every call site, but
  the values are not — `import` puts the transcript file's own `session_id`
  there, and a transcript is producer output like any other. Values are escaped
  at the panel, so every current and future caller is covered.

- `show` and `replay` echoed five producer-authored header fields raw —
  `agent_version`, `tags`, `session_id`, `started_at` and `ended_at` — beside `agent_name` and `error`,
  which were already escaped. Ingest validation only checks that these are
  strings, so an ESC or OSC sequence survived it and reached the terminal of
  whoever inspected the trace: setting the window title, leaving an attribute set
  after the command, or (a lone carriage return) overwriting the line it sits on.
  The model-authored fields in the `diff --ai` and `eval --ai` panels are escaped
  now too.

- `guard check` answered `allow` at exit 0 against a store holding no enabled
  policies — the same fail-open as `hook --enforce`, in the command documented
  as the gate for harnesses without hooks, and reachable through the same door
  (`init`, or any capture hook, creates the store). It now denies with the
  reason at exit 2, the block signal, keeping its `--json` contract, and takes
  `--allow-empty` when an empty policy set is deliberate.

- `hook --enforce` allowed every tool call, silently, when it ran against a
  store holding no policies. A previous fix stopped an enforcing event from
  *creating* the store, but that only closes the hole if
  every registered hook line carries `--enforce` — which is not the documented
  setup: plain capture hooks on `UserPromptSubmit`/`PostToolUse`/`Stop`, and
  `--enforce` on `PreToolUse` alone. Capture mode creates the store and fires
  first, so a session started from any directory other than the project root met
  a brand-new, empty policy set and ran completely unguarded while the
  configuration still looked correct. An enforcing gate that cannot fire now
  blocks with the reason, like the other gates, and `--allow-empty` is there for
  the case where an empty policy set is deliberate.

- The guardrail gate could be silenced by pointing it at the wrong directory.
  `ensureDatabase` creates what it does not find, so `guard check` run from
  anywhere but the project root built an empty store, answered `allow` at exit 0,
  and left that store behind so every later check allowed too. `hook --enforce`
  had the same hole through a different door: its missing-store check ran only on
  the tool call, so with one `--enforce` command line registered across every hook
  event — the configuration the check existed to support — `SessionStart` fired
  first, bootstrapped an empty store, and from then on every tool call was allowed
  unchecked and silently. No event under `--enforce` may create the store now; a
  gating event with no store is a deny, and a non-gating one is a loud no-op.

- The OpenTelemetry receiver listened on every interface while calling itself
  local and printing `http://localhost`. Any host on the network could POST
  unauthenticated traces into the store, or spend its 32 MB body budget. It now
  binds loopback only.

- An OTLP attribute literally named `__proto__` reassigned the prototype of the
  map its attributes are read from, so its entries became inherited reads for
  every later lookup — enough to reclassify a span as a trace root and drop its
  step. The map is now prototype-less. (Today's earlier fix covered the step-type
  lookup TABLES; this is the map being built.)

- `hook --enforce --no-input` no longer fails open on content-based guardrails.
  `--no-input` redacted the tool-call arguments before policy evaluation, not
  just before storage, so a `deny` / `require_review` policy keyed on the input
  (e.g. `input_contains: "rm -rf"`) silently never matched and the dangerous
  call was allowed — on exactly the shared machines where `--no-input` is used.
  Enforcement now evaluates the real arguments (held only in memory) while the
  stored tool-call input stays redacted. Name-based policies were unaffected.
- `hook --enforce` no longer downgrades a block to an allow when the audit write
  fails. The `guard_check` step is recorded after the verdict is decided but
  before it is returned, so a write error there (disk full, a locked database)
  propagated out and was swallowed into an exit `0`. The audit write is now
  best-effort — a failure is logged to stderr but the deny / require_review
  verdict is still returned, so the call is blocked (fail closed).
- The `otel serve` receiver now bounds request memory. It read the entire
  request body into memory unbounded and `gunzip`-ed it with no output limit, so
  a runaway or hostile client could exhaust memory — a gzip body decompresses at
  up to ~1000x, so a few KB could expand to gigabytes (a "zip bomb"). The
  receiver now caps the request body (32 MB) and the decompressed size (64 MB) —
  both far above any real OTLP batch — and answers `413` (not retryable) instead
  of crashing. Legitimate exporters are unaffected.

- Cleared a newly-disclosed high-severity `nanoid` advisory
  (GHSA-28wg-ghj8-5hjv / GHSA-2v37-7h3g-55p8 — a non-secure generator can loop
  indefinitely on a negative or zero size). Bumped the direct dependency to
  `^5.1.16` (the patched 5.x release; `nanoid`'s API is unchanged) and raised the
  `postcss` override to `^8.5.26`, which pulls the patched `nanoid ^3.3.17`
  transitively. `npm audit` is back to 0 vulnerabilities.

- The untrusted-trace fence around AI-evaluated content is no longer escapable.
  Trace content is wrapped in `<<<BEGIN/>>>END UNTRUSTED TRACE CONTENT` markers
  and the judge is told to treat everything between them as data — but not every
  summarized field is JSON-escaped (a trace error, a step name, a decision
  rationale, tags are raw), so content carrying a newline plus the literal
  terminator closed the fence early and continued in the position reserved for
  operator instructions. Verified end to end: a trace whose error string carried
  such a payload made `eval --preset ai-security-audit` report a clean 100% pass
  — defeating the defense inside the one evaluator meant to catch it. Any run
  whose error text an attacker can influence (tool stderr echoed into the trace
  error, an HTTP error body) was a carrier. The markers are now neutralized in
  the content before fencing, so a forged terminator survives as quoted
  evidence rather than as syntax.

- `ai-security-audit` scores the worst of the judge's declared `risk_level` and
  the findings it listed. A reply of `{"risk_level":"none","safe":false,
  "findings":[{"severity":"critical"}]}` stored 1.0 / PASS and rendered a green
  panel with the critical finding printed inside it. The declared value is kept
  as `declared_risk_level` when the two disagree.

## [0.2.0]

This release grows agent-replay from a post-hoc trace debugger into an active
agent harness: it can capture runs live from the harnesses people already use,
enforce guardrails at the moment a dangerous tool call is attempted, and gate CI
on structural regressions.

### Added

- **Decision-trace model.** Step hierarchy (`parent_step`) and causality
  (`caused_by_step`), a typed decision record (options, chosen, confidence,
  `decided_by` = agent/user/policy), and a `session_id` correlation key on
  traces. New commands `why <trace> --step N` (walk the causal chain) and
  `decisions <trace>`; `show --tree` renders the step hierarchy; `list --session`
  filters by session. Schema v2 with an automatic v1→v2 migration.
- **Live capture.** A versioned JSONL event protocol and `record` command that
  writes traces incrementally, plus a `TraceRecorder` SDK. `record --format`
  also translates the CLIs' own streams (`codex-exec`, `gemini-stream`). A
  stateless `hook` adapter for the Claude Code / Codex CLI / Gemini CLI hook
  convention (dialect auto-detected), `import` for Claude Code transcripts and
  Codex rollouts, and `watch` to live-tail a running trace. WAL mode + busy
  timeout for concurrent writers and readers; `list` flags abandoned running
  traces.
- **Runtime harness.** `guard check` evaluates a proposed step against policies
  (exit 0 allow/warn, exit 2 deny; `require_review` fails closed without a TTY).
  `hook --enforce` blocks denied tool calls in each harness's dialect and records
  a `guard_check` step. `run -- <command>` wraps an agent process, records it,
  and propagates its exit status. `check --golden` compares runs against a golden
  dataset on a structural field allowlist and exits non-zero on regression.
- **OpenTelemetry ingest.** `otel serve` runs a local OTLP/HTTP receiver
  (`/v1/traces` in JSON and protobuf, `/v1/logs` in JSON, gzip), mapping the
  GenAI semantic conventions onto the trace model with OpenInference and
  OpenLLMetry fallbacks, drift-tolerant attribute aliasing, and Gemini CLI /
  Claude Code log-event enrichment (including tool-decision records).

### Changed

- Default eval models refreshed to the current cheapest tier: Google
  `gemini-2.5-flash-lite`, OpenAI `gpt-5.4-nano` (Anthropic
  `claude-haiku-4-5-20251001` unchanged).

## [0.1.0]

- Initial build: local SQLite trace store; `ingest`, `list`, `show`, `replay`,
  `diff`, `fork`, `eval`, `guard`, `export`, `dashboard`, and `config` commands;
  AI-powered evaluation with bring-your-own-key.
