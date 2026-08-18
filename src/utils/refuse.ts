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
