import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
export function resolveDataDir(dir?: string): string {
  // An EMPTY value is not a directory. `resolve('')` is the CWD, so
  // `AGENT_REPLAY_DIR= agent-replay init` wrote the store loose into the working
  // directory — and `demo --reset` then passed its "is this an agent-replay
  // directory?" name check for anyone standing in a checkout named agent-replay,
  // and rm -r'd their working tree. Treat empty as unset, everywhere.
  if (dir != null && dir !== '') return dir;
  const fromEnv = process.env.AGENT_REPLAY_DIR;
  return fromEnv != null && fromEnv !== '' ? fromEnv : '.agent-replay';
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
