# terminal-output Specification

## Purpose
A trace is written by the agent under test, so every string a command prints is untrusted input that arrives at the operator's terminal. Escaping, bounding and width are therefore correctness concerns, not cosmetics — and the same defect kept reappearing in whichever renderer the last fix had not reached, because nothing said what the rule was.

## Requirements

### Requirement: Producer text cannot address the terminal

The system SHALL escape control characters in every producer-controlled value it prints — C0, DEL and C1 (U+0080–U+009F) — because terminals decode U+009B as CSI, so an escape sequence in a tool result could re-colour, reposition or retitle the terminal of whoever ran the command.

#### Scenario: Escape sequence in a tool result

- **WHEN** a trace's step output contains an ANSI or OSC sequence and a user runs `agent-replay show`
- **THEN** the sequence is rendered visibly as text and the terminal state is unchanged

### Requirement: Producer text cannot forge a line

The system SHALL additionally escape NEWLINE in any value rendered on a SINGLE-LINE row — a step name, an agent name, a model, a decision, an evaluator or policy name. On such a row a newline emits a line the renderer never accounted for: it can draw a fabricated step row, or a line at column 0 with no gutter that reads as agent-replay's own output.

A multi-line ERROR SHALL instead keep its line breaks, since a stack trace or a Windows child's CRLF output is shaped information — but every continuation line SHALL be drawn inside the row's gutter, so it is visibly trace content rather than tool output. Payload blocks (`input`, `output`, JSON) SHALL stay lenient, since there a newline is content rather than structure.

This applies to EVERY command that renders a trace, not only the one a defect was last reported against.

#### Scenario: Newline in a step name

- **WHEN** a step is named `safe\n  ├─ 99  ➡ Output  "..."` and a user runs `show`, `replay`, `why`, `decisions`, `watch`, `stats` or `guard test`
- **THEN** no rendered line begins with `agent-replay:` and no fabricated step row appears

### Requirement: One trace cannot destroy the view

The system SHALL bound producer-controlled names when rendering them. A table column is sized to its widest cell, so a single trace with a very long agent name otherwise widens every other row and makes the listing unreadable; an unbounded step name emits a line no terminal can wrap usefully.

Truncation SHALL be budgeted in terminal COLUMNS, not UTF-16 code units — a CJK character is one code unit and two columns — and SHALL NOT split a surrogate pair, which would render as a replacement character at some widths and not others.

#### Scenario: A hostile name among ordinary traces

- **WHEN** one trace has a 5,000-character agent name and a user runs `list`
- **THEN** every row stays within a readable width and the other traces are still legible

### Requirement: Interactive commands refuse a non-interactive environment

The system SHALL refuse, with exit 2 and nothing written to stdout, to start a full-screen interactive view when stdout or stdin is not a TTY, and SHALL point the caller at a scriptable alternative. Otherwise it emits alt-screen and mouse-tracking escape sequences into the redirected stream and then waits forever for a keypress that cannot arrive.

Argument validation SHALL run BEFORE the environment check, so a typo is reported to the script that made it.

Any interval or refresh option SHALL refuse a value above what a timer can hold. Node clamps a delay beyond 32 bits to 1 ms, so "refresh almost never" would otherwise become "refresh a thousand times a second" — the inverse of the request.

#### Scenario: Dashboard in CI

- **WHEN** `agent-replay dashboard` runs with stdout redirected
- **THEN** it exits 2 immediately, writes nothing to stdout, and names `stats --json` as the alternative

### Requirement: Rendering degrades rather than crashes

The system SHALL NOT fail a command because of a drawing problem. A reported terminal width is whatever the environment says it is, not necessarily a real one, so a width too small to draw a border SHALL fall back to plain output — the content is what the user asked for.

#### Scenario: Absurd terminal width

- **WHEN** `process.stdout.columns` reports 1 and a user runs `show`
- **THEN** the trace is printed without a border rather than the command aborting
