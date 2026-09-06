import { Command } from 'commander';
import { VERSION } from './utils/version.js';

const program = new Command();

program
  .name('agent-replay')
  .version(VERSION)
  .description('Agent Flight Data Recorder & Replay Engine — time-travel debugging, auto-eval, and what-if sandboxing for AI agents');

// Map every commander parse error (unknown option, missing/excess argument,
// unknown command) to exit code 2 — the documented "usage error" signal — so it
// lines up with the runtime failures (exit 1) that command actions raise.
// Commander's own default is 1 for all of these, which contradicts the README's
// exit-code table. help/version still exit 0. Must be set BEFORE any .command()
// so subcommands inherit the callback (commander copies it at creation time).
program.exitOverride((err) => {
  if (err.exitCode === 0) process.exit(0);
  // Exception: a usage error on `hook` in CAPTURE mode must still exit 0. In
  // every supported harness exit 2 blocks the pending tool call, so a single
  // typo'd hook line in settings.json would block every tool call in the
  // session — from a capture-only hook that is documented never to affect the
  // host agent. `runHook` guarantees exit 0, but commander's error handling
  // runs before the action ever executes. `--enforce` is deliberately excluded:
  // there, blocking is the correct fail-closed answer when we can't evaluate.
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook' && !argv.includes('--enforce')) process.exit(0);
  process.exit(2);
});

// `--dir` NAMES a store, so an empty value is a usage error — the rule the
// exit-code table already states for "every flag that names something", and the
// one place it was not enforced. `resolveDataDir` deliberately treats a blank
// as UNSET, because an exported-but-empty `AGENT_REPLAY_DIR` is a normal shell
// accident and resolving it to the CWD once let `demo --reset` rm -r a working
// tree. That reading is right for the environment and wrong for an explicit
// flag: `--dir "$STORE"` with STORE unset does not mean "use the default", it
// means the caller named a store and got a different one. Reads then answer
// from the wrong store (`list` → "No traces found", exit 0) and writes land in
// it — the same concealed-wrong-store failure `openStoreOr` exists to prevent,
// arriving through the flag instead of the working directory.
//
// One hook rather than a check per command: `--dir` is on every command, this
// is the only place all of them pass through, and a per-site copy is what the
// shared refusal helper was extracted to stop.
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const dir: unknown = actionCommand.opts().dir;
  // Whitespace-only too: `resolveDataDir` already treats "   " as unset, so it
  // reaches the same wrong store while looking like a path in a shell history.
  if (typeof dir !== 'string' || dir.trim() !== '') return;

  // Capture-mode `hook` is exempt, for the reason the exit override above is:
  // in every supported harness a non-zero hook exit blocks the pending tool
  // call, and a capture-only hook must never affect the host agent. Refusing
  // would also DROP the event, which is worse than recording it in the default
  // store — so warn on stderr (never stdout, which is the harness's channel)
  // and continue. `--enforce` is excluded, as it is there: a gate pointed at
  // the wrong store has no policies and would allow everything, so blocking is
  // the fail-closed answer.
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook' && !argv.includes('--enforce')) {
    process.stderr.write('  agent-replay: --dir was given an empty value; using the default store.\n');
    return;
  }

  // Imported here, not at the top, so the refusal path costs nothing on the
  // startup of every other invocation — the same reason the command modules
  // below are loaded lazily. It answers in the caller's shape, so a `--json`
  // pipeline still gets the documented `{ ok: false }` document.
  const { makeRefuse } = await import('./utils/refuse.js');
  makeRefuse(actionCommand.opts().json as boolean | undefined)(2, '--dir was given an empty value.', [
    'Pass a directory path, or omit --dir to use $AGENT_REPLAY_DIR or ./.agent-replay.',
  ]);
  process.exit(2);
});

// --- init ---
program
  .command('init')
  .description('Initialize a new agent-replay project in the current directory')
  .option('--force', 'Overwrite existing configuration')
  .option('--dir <path>', 'Custom directory instead of .agent-replay/')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(opts);
  });

// --- demo ---
program
  .command('demo')
  .description('Load sample data and run an interactive feature walkthrough')
  .option('--no-interactive', 'Just load data, skip walkthrough')
  .option('--reset', 'Clear existing data first')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runDemo } = await import('./commands/demo.js');
    await runDemo(opts);
  });

// --- ingest ---
program
  .command('ingest <file>')
  .description('Ingest traces from a JSON or JSONL file')
  .option('--format <format>', 'File format: json or jsonl (auto-detected if omitted)')
  .option('--tags <tags>', 'Comma-separated tags to add to all ingested traces')
  .option('--dry-run', 'Validate without inserting')
  .option('--dir <path>', 'Custom data directory')
  .action(async (file, opts) => {
    const { runIngest } = await import('./commands/ingest.js');
    await runIngest(file, opts);
  });

// --- record ---
program
  .command('record')
  .description('Record a trace incrementally from an event stream on stdin')
  .option('--format <format>', 'Stream format: native (default), codex-exec, gemini-stream, claude-stream', 'native')
  .option('--agent-name <name>', 'Name to record for traces this stream opens (overrides the stream)')
  .option('--input <text>', 'Prompt to record for a trace the stream opens without one')
  .option('--tags <tags>', 'Comma-separated tags to add to recorded traces')
  .option('--leave-open', 'Do not finalize still-running traces as timeout on EOF')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runRecord } = await import('./commands/record.js');
    await runRecord(opts);
  });

// --- import ---
program
  .command('import <path>')
  .description('Import an on-disk session log (Claude Code transcript or Codex rollout JSONL) as a trace')
  .option('--format <format>', 'Log format: claude-transcript (default), codex-rollout', 'claude-transcript')
  .option('--tags <tags>', 'Comma-separated tags to add to the imported trace')
  .option('--replace', 'Re-import a session already in the store (use when the transcript has grown)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (path, opts) => {
    const { runImport } = await import('./commands/import.js');
    await runImport(path, opts);
  });

// --- hook ---
program
  .command('hook [event]')
  .description('Capture adapter for the stdin-JSON hook convention (Claude Code / Codex / Gemini)')
  .option('--no-input', 'Drop prompt text and tool inputs before storing')
  .option('--enforce', 'Evaluate pre-tool events against policies and block denied calls (guardrail, not a boundary)')
  .option('--dialect <name>', 'Force the harness dialect for --enforce replies: claude-code, codex, gemini, other')
  .option('--allow-empty', 'Let --enforce run against a store with no enabled policies (default: block, since such a gate can never fire)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (event, opts) => {
    const { runHook } = await import('./commands/hook.js');
    await runHook(event, { noInput: opts.input === false, enforce: opts.enforce === true, allowEmpty: opts.allowEmpty === true, dialect: opts.dialect, dir: opts.dir });
  });

// --- list ---
program
  .command('list')
  .description('List all traces with filtering and sorting')
  .option('--status <status>', 'Filter by status: running, completed, failed, timeout')
  .option('--agent <name>', 'Filter by agent name')
  .option('--tag <tag>', 'Filter by tag')
  .option('--session <id>', 'Filter by session ID (prefix matching)')
  .option('--since <duration>', 'Filter by time window (e.g. 1h, 7d, 30m)')
  .option('--sort <field>', 'Sort by: started_at, duration, tokens, cost, agent_name (ascending; prefix with - for descending)')
  .option('--limit <n>', 'Max results (default 25)', '25')
  .option('--json', 'Output raw JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runList } = await import('./commands/list.js');
    await runList(opts);
  });

// --- show ---
program
  .command('show <trace-id>')
  .description('Show detailed view of a trace with steps, evals, and snapshots')
  .option('--json', 'Output raw JSON')
  .option('--steps-only', 'Only show the step timeline')
  .option('--tree', 'Render steps as a hierarchy (parent/child + causal links)')
  .option('--from-step <n>', 'Only show steps from this step number (for large traces)')
  .option('--to-step <n>', 'Only show steps up to this step number')
  .option('--evals', 'Show the evaluations section even when the trace has none (they are shown whenever present)')
  .option('--snapshots', 'Show full snapshot data for each step')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runShow } = await import('./commands/show.js');
    await runShow(traceId, opts);
  });

// --- why ---
program
  .command('why <trace-id>')
  .description('Explain a step by walking its causal chain back to the root')
  .requiredOption('--step <n>', 'Step number to explain (required)')
  .option('--json', 'Output raw JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runWhy } = await import('./commands/why.js');
    await runWhy(traceId, opts);
  });

// --- decisions ---
program
  .command('decisions <trace-id>')
  .description('List every decision point in a trace with its options and rationale')
  .option('--json', 'Output raw JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runDecisions } = await import('./commands/decisions.js');
    await runDecisions(traceId, opts);
  });

// --- watch ---
program
  .command('watch [trace-id]')
  .description('Live-tail a running trace (defaults to the most recent running trace)')
  .option('--interval <ms>', 'Poll interval in milliseconds (default 500)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runWatch } = await import('./commands/watch.js');
    await runWatch(traceId, opts);
  });

// --- replay ---
program
  .command('replay <trace-id>')
  .description('Replay a trace step-by-step with simulated timing')
  .option('--speed <multiplier>', 'Speed multiplier (0=instant, 1=realtime, 10=10x)', '5')
  .option('--pause', 'Pause after each step')
  .option('--from-step <n>', 'Start replay from step N')
  .option('--to-step <n>', 'Stop at step N')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runReplay } = await import('./commands/replay.js');
    await runReplay(traceId, opts);
  });

// --- diff ---
program
  .command('diff <trace-a> <trace-b>')
  .description('Side-by-side comparison of two traces')
  .option('--compact', 'Summary only, no step details')
  .option('--json', 'Output raw JSON diff')
  .option('--fields <fields>', 'Only compare specific fields (comma-separated)')
  .option('--ai', 'Include AI-powered analysis of why traces diverged')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceA, traceB, opts) => {
    const { runDiff } = await import('./commands/diff.js');
    await runDiff(traceA, traceB, opts);
  });

// --- fork ---
program
  .command('fork <trace-id>')
  .description('Fork a trace at a specific step')
  .requiredOption('--from-step <n>', 'Fork from this step number')
  .option('--modify-input <json>', 'Modified input JSON for the forked trace')
  .option('--modify-context <json>', 'Modified context JSON at the fork point')
  .option('--tag <tag>', 'Tag the forked trace')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runFork } = await import('./commands/fork.js');
    await runFork(traceId, opts);
  });

// --- eval ---
program
  .command('eval <trace-id>')
  .description('Run evaluations against a trace')
  .option('--rubric <file>', 'Path to a YAML/JSON rubric file')
  .option('--preset <name>', 'Use a preset (deterministic or AI: ai-root-cause, ai-quality-review, ai-security-audit, ai-optimization)')
  .option('--all', 'Run all built-in deterministic presets')
  .option('--ai', 'Run all AI-powered evaluation presets')
  .option('--max-cost <usd>', 'Maximum cost budget for AI evals in USD (e.g. 0.05)')
  .option('--json', 'Output raw JSON results')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runEvalCommand } = await import('./commands/eval.js');
    await runEvalCommand(traceId, opts);
  });

// --- guard ---
const guardCmd = program
  .command('guard')
  .description('Manage guardrail policies');

guardCmd
  .command('list')
  .description('Show all guardrail policies (scriptable, --json)')
  .option('--json', 'Output raw JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runGuardList } = await import('./commands/guard.js');
    await runGuardList(opts);
  });

guardCmd
  .command('add')
  .description('Add a guardrail policy')
  .requiredOption('--name <name>', 'Policy name')
  .requiredOption('--pattern <json>', 'Match pattern as JSON')
  .requiredOption('--action <action>', 'Action: allow, deny, warn, require_review')
  .option('--description <text>', 'Policy description')
  .option('--priority <n>', 'Priority (default 0)', '0')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runGuardAdd } = await import('./commands/guard.js');
    await runGuardAdd(opts);
  });

guardCmd
  .command('remove <policy-id>')
  .description('Remove a guardrail policy')
  .option('--dir <path>', 'Custom data directory')
  .action(async (policyId, opts) => {
    const { runGuardRemove } = await import('./commands/guard.js');
    await runGuardRemove(policyId, opts);
  });

guardCmd
  .command('disable <policy>')
  .description('Turn a policy off without deleting it (by id or name)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (policy, opts) => {
    const { runGuardToggle } = await import('./commands/guard.js');
    runGuardToggle(policy, false, opts);
  });

guardCmd
  .command('enable <policy>')
  .description('Turn a disabled policy back on (by id or name)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (policy, opts) => {
    const { runGuardToggle } = await import('./commands/guard.js');
    runGuardToggle(policy, true, opts);
  });

guardCmd
  .command('test <trace-id>')
  .description('Run all policies against a trace')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runGuardTest } = await import('./commands/guard.js');
    await runGuardTest(traceId, opts);
  });

guardCmd
  .command('check')
  .description(
    'Evaluate one proposed step (JSON on stdin) against policies; exit 0 allow/warn, 2 deny. ' +
      'A guardrail, not a complete boundary — use OS sandboxing for hard isolation.',
  )
  .option('--dir <path>', 'Custom data directory')
  .option('--allow-empty', 'Answer allow against a store with no enabled policies (default: deny, since such a gate can never fire)')
  .action(async (opts) => {
    const { runGuardCheck } = await import('./commands/guard.js');
    await runGuardCheck(opts);
  });

// --- export ---
program
  .command('export')
  .description('Export traces and evaluation results')
  .argument('[trace-id]', 'Export only this trace (mutually exclusive with the filter flags)')
  .option('--format <format>', 'Export format: json, jsonl, golden', 'json')
  .option('--status <status>', 'Filter by status')
  .option('--tag <tag>', 'Filter by tag')
  .option('--agent <name>', 'Filter by agent name')
  .option('--since <duration>', 'Filter by time window')
  .option('--with-evals', 'Include evaluation results')
  .option('--with-snapshots', 'Include full snapshots')
  .option('--output <file>', 'Output file path (default: stdout)')
  .option('--dir <path>', 'Custom data directory')
  .action(async (traceId, opts) => {
    const { runExport } = await import('./commands/export.js');
    await runExport(traceId, opts);
  });

// --- check ---
program
  .command('check')
  .description('Compare traces against a golden dataset; exits non-zero on regression (CI-ready)')
  // `option`, not `requiredOption`: commander enforces a required option BEFORE
  // the command body runs, printing a bare usage line to stderr and exiting 2 —
  // which breaks the `--json` contract this repo documents ("a refusal is
  // reported as {"ok": false, "error": ...} so a `check --json | jq -r .ok`
  // pipeline still reads a verdict"). `runCheck` has always carried its own
  // guard for a missing --golden; it just never got to run. It does now.
  .option('--golden <file>', 'Golden dataset file (from "export --format golden")')
  .option('--trace <id>', 'Check a single trace by ID')
  .option('--agent <name>', 'Check traces from this agent (substring match)')
  .option('--agent-exact <name>', 'Check traces from exactly this agent (a gate should name one agent)')
  .option('--since <duration>', 'Only check traces since this window (e.g. 1d)')
  .option('--fields <list>', 'Comma-separated field allowlist (default: step_count,step_types,step_names,tool_inputs,step_errors,status)')
  .option('--strict', 'Treat unmatched candidate traces, and baselines no candidate exercised, as failures')
  .option('--allow-empty', 'Pass when no candidate trace matched, instead of failing (a quiet window)')
  .option('--json', 'Output the report as JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runCheck } = await import('./commands/check.js');
    await runCheck(opts);
  });

// --- run ---
program
  .command('run')
  .description('Run a child process under supervision, recording it as a trace (use: run [opts] -- <command>)')
  .argument('[command...]', 'command and args to run (after --)')
  .option('--agent-name <name>', 'Agent name for the recorded trace')
  .option('--tags <tags>', 'Comma-separated tags for the trace')
  .option('--dir <path>', 'Custom data directory')
  .action(async (command, opts) => {
    const { runRun } = await import('./commands/run.js');
    await runRun(command, opts);
  });

// --- otel ---
const otelCmd = program
  .command('otel')
  .description('OpenTelemetry ingest');

otelCmd
  .command('serve')
  .description('Run a local OTLP/HTTP receiver: /v1/traces and /v1/logs, JSON or protobuf, into traces')
  .option('--port <port>', 'Port to listen on (default 4318)', '4318')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runOtelServe } = await import('./commands/otel.js');
    await runOtelServe(opts);
  });

// --- dashboard ---
program
  .command('dashboard')
  .description('Launch an interactive terminal dashboard')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', '5')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runDashboard } = await import('./commands/dashboard.js');
    await runDashboard(opts);
  });

// --- stats ---
program
  .command('stats')
  .description('Print a non-interactive summary of the trace store (scriptable, --json)')
  .option('--since <window>', 'Only count traces since a time (e.g. 7d, 24h, or an ISO date)')
  .option('--json', 'Output as JSON')
  .option('--dir <path>', 'Custom data directory')
  .action(async (opts) => {
    const { runStats } = await import('./commands/stats.js');
    await runStats(opts);
  });

// --- config ---
const configCmd = program
  .command('config')
  .description('Manage agent-replay configuration and AI provider settings');

configCmd
  .command('list')
  .description('Show all configuration')
  .option('--dir <path>', 'Custom directory')
  .action(async (opts) => {
    const { runConfigList } = await import('./commands/config.js');
    await runConfigList(opts);
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value (e.g. ai.provider)')
  .option('--dir <path>', 'Custom directory')
  .action(async (key, opts) => {
    const { runConfigGet } = await import('./commands/config.js');
    await runConfigGet(key, opts);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value (e.g. ai.api_keys.anthropic <key>)')
  .option('--dir <path>', 'Custom directory')
  .action(async (key, value, opts) => {
    const { runConfigSet } = await import('./commands/config.js');
    await runConfigSet(key, value, opts);
  });

configCmd
  .command('test-ai')
  .description('Test AI provider connectivity')
  .option('--dir <path>', 'Custom directory')
  .action(async (opts) => {
    const { runConfigTestAi } = await import('./commands/config.js');
    await runConfigTestAi(opts);
  });

// Reject unexpected extra positional arguments across every command instead of
// silently ignoring them — e.g. `show <id> <typo>` or `list production` (meant
// as `--tag production`) should fail loudly, not quietly run on the first arg.
// There's no program-wide switch, so apply it to each registered command (and
// nested subcommands like `config`/`otel`). Variadic args (e.g. `run
// [command...]`) absorb their trailing args, so this never trips them.
function rejectExcessArguments(cmd: Command): void {
  cmd.allowExcessArguments(false);
  cmd.commands.forEach(rejectExcessArguments);
}
rejectExcessArguments(program);

// Parse asynchronously so a rejected command action (e.g. an unopenable/corrupt
// database) is reported as a clean one-line error and a non-zero exit, rather
// than an unhandled-rejection stack trace.
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n  ${message}\n\n`);
  // An ambiguous trace id is the caller naming something imprecisely — a usage
  // error, like an unknown flag — not a runtime failure. Reporting it as 1 put
  // it in the same bucket a CI script reads as "the check regressed".
  // Matched by NAME, not `instanceof`: every command module in this file is
  // imported lazily, so a static import of the error class here would pull the
  // whole service layer into startup for every invocation.
  process.exitCode = (err as { name?: string } | null)?.name === 'AmbiguousTraceIdError' ? 2 : 1;
});
