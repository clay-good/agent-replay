import type Database from 'better-sqlite3';
import chalk from 'chalk';

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
 * Open the store, answering a failure in the caller's requested shape.
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
): Database.Database | undefined {
  try {
    return open();
  } catch (err) {
    refuse(2, `Could not open the store: ${err instanceof Error ? err.message : String(err)}`, [
      `Store path: ${dbPath}`,
    ]);
    return undefined;
  }
}
