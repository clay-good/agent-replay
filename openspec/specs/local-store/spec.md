# local-store Specification

## Purpose
Every command reads or writes one local SQLite store, and most of them read a config file beside it that holds API keys in plaintext. Where that store lives, who may read it, and what happens when the config file is damaged are user-visible behaviors that decide whether data is found, protected, and reported honestly — but nothing had written them down, so four separate defects in this area passed `openspec validate` untouched.

## Requirements

### Requirement: Store location resolution

The system SHALL resolve the store directory in this order: an explicit `--dir`, else the `AGENT_REPLAY_DIR` environment variable, else `.agent-replay` in the working directory.

A BLANK value at either rung — empty or whitespace-only — SHALL be treated as unset rather than as a directory. `resolve('')` is the working directory, so honoring a blank value wrote the store loose into the user's project, and a whitespace-only one created a directory whose name is nearly invisible in a listing.

A leading `~` or `~/` SHALL be expanded to the user's home directory. A shell expands the tilde before the CLI sees it, so this governs the cases where nothing does: a quoted `--dir`, a hook or settings JSON file, a container or service `Environment=`, a CI `env:` block. `~otheruser/` SHALL be left literal, since resolving another account's home is not portable.

A destructive command SHALL gate on the same decision, not on the raw option: a blank `--dir` does not name a target, so `demo --reset` must still refuse to inherit its target from the environment.

#### Scenario: Blank value falls through

- **WHEN** `AGENT_REPLAY_DIR` is set and a user runs a command with `--dir "   "`
- **THEN** the store named by `AGENT_REPLAY_DIR` is used, and `demo --reset` refuses because no target was named

#### Scenario: Tilde with no shell to expand it

- **WHEN** a hook config passes `--dir '~/traces'`
- **THEN** the store resolves under the user's home directory, not a directory named `~` in the working directory

### Requirement: Store confidentiality

The system SHALL create `traces.db` and `config.json` owner-only (`0600`), because a trace holds prompts, tool inputs and tool outputs, and the config holds API keys in plaintext. A directory the system creates for itself SHALL be `0700`.

The system SHALL NOT change the permissions of a directory it did not create — the mode of a directory the user made is the user's decision, and a read-only command must never rewrite one. File modes SHALL be set at creation only, so a store an operator deliberately opened up stays open.

#### Scenario: Store created in a directory the user made

- **WHEN** a user runs `mkdir -p /srv/store && agent-replay init --dir /srv/store`
- **THEN** `traces.db` and `config.json` are `0600` and the mode of `/srv/store` is unchanged

#### Scenario: Read-only command

- **WHEN** a user runs `agent-replay list` against an existing store
- **THEN** no file or directory permission is modified

### Requirement: Configuration loading

The system SHALL distinguish a config file that is ABSENT from one that exists but cannot be used. A file that cannot be read or parsed SHALL be reported as its own error, naming the file and the failure, and SHALL NOT be reported as "no configuration found" — that sends the user to `init`, which then reports the store is already initialized, while the key they are looking for sits in the file.

Unusable values SHALL be dropped on READ so that one bad key cannot make the whole config unreadable, and SHALL be reported by the diagnostic commands. A WRITER SHALL start from the file as it actually is: `config set` must change only the named key and must not persist the sanitized copy, which would destroy the very value the user is being warned about.

The config's `database` field SHALL be reported as the store the data directory resolves to, not as whatever the file records. `init` writes an absolute path there and no command opens the store through it, so a copied, moved, or cloned project keeps naming the store it was created beside — and a stored path that still EXISTS answers "which database am I looking at" with a real, wrong file. A stored value that disagrees SHALL be reported as ignored, with how to stop it being reported, rather than silently replaced.

`config set` SHALL refuse an empty value. A blank stored value looks set — a blank API key renders as `***` — while every check downstream treats it as absent.

#### Scenario: Damaged config file

- **WHEN** `config.json` contains a trailing comma and a user runs `agent-replay config list`
- **THEN** the command reports that the file is not valid JSON, names it, and exits 2

#### Scenario: A config file copied from another project

- **WHEN** a project directory is copied and `agent-replay config get database` is run in the copy
- **THEN** the answer is the copy's own `traces.db` — the store every command in that directory reads — and `config list` reports that the stored path is not used and how to stop reporting it

#### Scenario: Setting one key preserves another

- **WHEN** `ai.max_tokens` holds an unusable value and a user runs `agent-replay config set ai.provider anthropic`
- **THEN** only `ai.provider` changes and `ai.max_tokens` is still on disk, still reported as a problem

### Requirement: Independent store handles

The system SHALL allow more than one store to be open at a time in a single process. `ensureDatabase` is a documented library export; opening a second path SHALL NOT close the connection behind the first, and the same path SHALL return the same connection.

#### Scenario: Two stores in one process

- **WHEN** a library caller opens store A and then store B
- **THEN** both handles remain usable and queries against A are unaffected
