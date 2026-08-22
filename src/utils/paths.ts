import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Expand a leading `~` to the user's home directory.
 *
 * A shell expands `~` before the CLI ever sees it, so this only matters where
 * nothing does: a quoted `--dir '~/traces'`, a hook or settings JSON file, a
 * Docker or systemd `Environment=`, a CI `env:` block. There the tilde arrived
 * as a literal character and `resolve()` made a directory actually NAMED `~`
 * under the CWD — so the store was created at a path the user never meant,
 * and a read command against it reported an empty store at exit 0 rather than
 * saying it could not find the one they asked for.
 *
 * Only `~` and `~/...` are expanded. `~otheruser/...` is left alone: resolving
 * another account's home needs a password-database lookup that is not portable,
 * and guessing at it would be worse than the literal path.
 */
function expandTilde(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return resolve(homedir(), dir.slice(2));
  return dir;
}

/**
 * The data directory a command should use: an explicit `--dir`, else the
 * `AGENT_REPLAY_DIR` handed down by `agent-replay run`, else the default.
 *
 * `run` sets that variable for its child (alongside AGENT_REPLAY_TRACE_ID and
 * AGENT_REPLAY_EVENTS) and the README documents it as how the wrapper hands the
 * child its store — but nothing read it back, so a child that is itself an
 * agent-replay invocation (`run -- sh -c 'agent | agent-replay record'`) wrote
 * to `./.agent-replay` instead of the store the wrapper had just opened a trace
 * in. An explicit --dir always wins.
 */
/**
 * Whether `--dir` actually names a directory.
 *
 * The same blank test {@link resolveDataDir} applies, exported so a caller can
 * ask the question rather than re-derive it. A destructive command must gate on
 * the DECISION, not on the raw option: `--dir "   "` is truthy, so a plain
 * `if (!opts.dir)` concluded the user had named a target while `resolveDataDir`
 * had already fallen through to `AGENT_REPLAY_DIR` — and `demo --reset` then
 * cleared the store named only by the environment, which is exactly what its
 * guard exists to prevent.
 */
export function dirWasNamed(dir?: string): boolean {
  return dir != null && dir.trim() !== '';
}

export function resolveDataDir(dir?: string): string {
  // A BLANK value is not a directory. `resolve('')` is the CWD, so
  // `AGENT_REPLAY_DIR= agent-replay init` wrote the store loose into the working
  // directory — and `demo --reset` then passed its "is this an agent-replay
  // directory?" name check for anyone standing in a checkout named agent-replay,
  // and rm -r'd their working tree. Treat blank as unset, everywhere.
  //
  // The test is on the TRIMMED value, not `!== ''`: `AGENT_REPLAY_DIR="   "`
  // slipped through the old check and created a directory literally named three
  // spaces, which is the same hazard wearing a name that is nearly invisible in
  // `ls`. The value itself is passed through untrimmed, since a path may
  // legitimately end in a space on these filesystems — only the "is this set at
  // all?" decision uses the trimmed form.
  if (dir != null && dir.trim() !== '') return expandTilde(dir);
  const fromEnv = process.env.AGENT_REPLAY_DIR;
  return fromEnv != null && fromEnv.trim() !== '' ? expandTilde(fromEnv) : '.agent-replay';
}

/**
 * Whether a trace store already exists at `dir`.
 *
 * Enforcement must never CREATE one. `ensureDatabase` makes what it does not
 * find, so a gate pointed at the wrong directory silently got a brand-new store
 * with zero policies and allowed everything — and once created, every later
 * check passed the existence test while the policy set was still empty. So the
 * rule is not "did `init` make this" (a store created implicitly by `ingest` or
 * `record` is perfectly legitimate) but "does the gate have to conjure one" —
 * which is always a misconfiguration, and is what `agent-replay init` is for.
 */
export function storeExists(dir: string): boolean {
  return existsSync(resolve(dir, 'traces.db'));
}
