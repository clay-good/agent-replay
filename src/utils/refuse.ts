import type Database from 'better-sqlite3';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { storeAboveNote } from './paths.js';

/**
 * A refusal answered in the shape the caller asked for.
 *
 * `--json` is a contract: a caller piping into `jq` expects a document it can
 * read a verdict from, on every outcome. Commands that printed a bare red line
 * on stderr and nothing on stdout broke that contract exactly when the pipeline
 * most needed an answer — `show nosuchtrace --json | jq .` died on a parse
 * error rather than reporting a missing trace. `eval` and `check` each grew
 * their own copy of this; this is that helper, extracted, so the six commands
 * that were still writing bare text share one definition rather than a seventh
 * and eighth copy that can drift.
 *
 * The exit code is the caller's to choose and is unchanged by the output shape:
 * 2 for a usage error, 1 for a runtime one.
 */
export function makeRefuse(json: boolean | undefined) {
  return function refuse(code: number, message: string, hints: string[] = []): void {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message, ...(hints.length ? { hints } : {}) }, null, 2));
    } else {
      console.error(chalk.red(`  ${message}`));
      for (const h of hints) console.error(chalk.dim(`  ${h}`));
    }
    process.exitCode = code;
  };
}

/**
 * Open the store for READING, answering a failure in the caller's shape.
 *
 * Opening happens before any command's own try block, so an unopenable store —
 * a corrupt file, a permissions problem, or a schema written by a NEWER build
 * than this one — escaped to the CLI's top-level handler: a bare stderr line,
 * exit 1, and NOTHING on stdout for a `--json` caller. That broke the same
 * contract the refusal helper above exists to keep, on the one code path where
 * a pipeline most needs a document it can read. `check` already handled it this
 * way; this is that handling, shared, rather than a copy per command.
 *
 * Exit 2, not 1: "the store cannot be opened" is a broken setup, not a runtime
 * failure of the thing being asked for — the same split `check` documents
 * between a regression (1) and a gate that could not run (2).
 */
export function openStoreOr(
  refuse: ReturnType<typeof makeRefuse>,
  open: () => Database.Database,
  dbPath: string,
  /** The `--dir` the caller was given, so the hint can tell "wrong cwd" from "wrong --dir". */
  dirOpt?: string,
): Database.Database | undefined {
  // A store that is not there is refused, not created. Every caller of this
  // helper only READS, but they all open with `ensureDatabase`, which CREATES
  // what it does not find — so running any of them from a directory without a
  // store wrote a 143 KB SQLite file that nobody asked for and then answered
  // from it: `list` printed "No traces found" at exit 0, and `show`/`why`
  // reported "Trace not found". Both name the wrong problem. The real one is
  // almost always a wrong working directory or a missing `--dir`, and the
  // answer conceals it — worse, it conceals it permanently, because the second
  // run finds a store that now genuinely exists and is genuinely empty.
  //
  // This is the rule `guard check` and `hook --enforce` already apply, for the
  // same reason and in the same words; creating a store is what `init` is for.
  if (!existsSync(dbPath)) {
    // Name the store the user probably meant, when they are standing in a
    // subdirectory of a project that has one: the generic advice below tells
    // them to run `init`, which would create a second store beside their
    // source and split their traces in two.
    const above = storeAboveNote(dirOpt);
    refuse(2, `No trace store at ${dbPath}.`, [
      'Run "agent-replay init" in the project directory to create one,',
      'or point this command at an existing store with --dir <path>.',
      ...(above ? [above] : []),
    ]);
    return undefined;
  }
  try {
    return open();
  } catch (err) {
    refuse(2, `Could not open the store: ${err instanceof Error ? err.message : String(err)}`, [
      `Store path: ${dbPath}`,
    ]);
    return undefined;
  }
}
