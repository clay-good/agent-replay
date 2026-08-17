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
  return dir ?? process.env.AGENT_REPLAY_DIR ?? '.agent-replay';
}
