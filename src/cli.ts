import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  version = pkg.version;
} catch {
  // fallback to hardcoded version
}

const program = new Command();

program
  .name('agent-replay')
  .version(version)
  .description('Agent Flight Data Recorder & Replay Engine — time-travel debugging, auto-eval, and what-if sandboxing for AI agents');

// --- init ---
program
  .command('init')
  .description('Initialize a new agent-replay project in the current directory')
  .option('--force', 'Overwrite existing configuration')
  .option('--dir <path>', 'Custom directory instead of .agent-replay/')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    runInit(opts);
  });

// --- demo ---
program
  .command('demo')
  .description('Load sample data and run an interactive feature walkthrough')
  .option('--no-interactive', 'Just load data, skip walkthrough')
  .option('--reset', 'Clear existing data first')
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
  .action(async (file, opts) => {
    const { runIngest } = await import('./commands/ingest.js');
    runIngest(file, opts);
  });

// --- list ---
program
  .command('list')
  .description('List all traces with filtering and sorting')
  .option('--status <status>', 'Filter by status: running, completed, failed, timeout')
  .option('--agent <name>', 'Filter by agent name')
  .option('--tag <tag>', 'Filter by tag')
  .option('--since <duration>', 'Filter by time window (e.g. 1h, 7d, 30m)')
  .option('--sort <field>', 'Sort by: started_at, duration, tokens, cost')
  .option('--limit <n>', 'Max results (default 25)', '25')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const { runList } = await import('./commands/list.js');
    runList(opts);
  });

// --- show ---
program
  .command('show <trace-id>')
  .description('Show detailed view of a trace with steps, evals, and snapshots')
  .option('--json', 'Output raw JSON')
  .option('--steps-only', 'Only show the step timeline')
  .option('--evals', 'Include evaluation results')
  .option('--snapshots', 'Show full snapshot data for each step')
  .action(async (traceId, opts) => {
    const { runShow } = await import('./commands/show.js');
    runShow(traceId, opts);
  });

// --- replay ---
program
  .command('replay <trace-id>')
  .description('Replay a trace step-by-step with simulated timing')
  .option('--speed <multiplier>', 'Speed multiplier (0=instant, 1=realtime, 10=10x)', '5')
  .option('--pause', 'Pause after each step')
  .option('--from-step <n>', 'Start replay from step N')
  .option('--to-step <n>', 'Stop at step N')
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
  .action(async (traceId, opts) => {
    const { runFork } = await import('./commands/fork.js');
    runFork(traceId, opts);
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
  .description('Show all guardrail policies')
  .action(async () => {
    const { runGuardList } = await import('./commands/guard.js');
    runGuardList();
  });

guardCmd
  .command('add')
  .description('Add a guardrail policy')
  .requiredOption('--name <name>', 'Policy name')
  .requiredOption('--pattern <json>', 'Match pattern as JSON')
  .requiredOption('--action <action>', 'Action: allow, deny, warn, require_review')
  .option('--description <text>', 'Policy description')
  .option('--priority <n>', 'Priority (default 0)', '0')
  .action(async (opts) => {
    const { runGuardAdd } = await import('./commands/guard.js');
    runGuardAdd(opts);
  });

guardCmd
  .command('remove <policy-id>')
  .description('Remove a guardrail policy')
  .action(async (policyId) => {
    const { runGuardRemove } = await import('./commands/guard.js');
    runGuardRemove(policyId);
  });

guardCmd
  .command('test <trace-id>')
  .description('Run all policies against a trace')
  .action(async (traceId) => {
    const { runGuardTest } = await import('./commands/guard.js');
    runGuardTest(traceId);
  });

// --- export ---
program
  .command('export')
  .description('Export traces and evaluation results')
  .option('--format <format>', 'Export format: json, jsonl, golden', 'json')
  .option('--status <status>', 'Filter by status')
  .option('--tag <tag>', 'Filter by tag')
  .option('--agent <name>', 'Filter by agent name')
  .option('--since <duration>', 'Filter by time window')
  .option('--with-evals', 'Include evaluation results')
  .option('--with-snapshots', 'Include full snapshots')
  .option('--output <file>', 'Output file path (default: stdout)')
  .action(async (opts) => {
    const { runExport } = await import('./commands/export.js');
    runExport(opts);
  });

// --- dashboard ---
program
  .command('dashboard')
  .description('Launch an interactive terminal dashboard')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', '5')
  .action(async (opts) => {
    const { runDashboard } = await import('./commands/dashboard.js');
    runDashboard(opts);
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
    runConfigList(opts);
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value (e.g. ai.provider)')
  .option('--dir <path>', 'Custom directory')
  .action(async (key, opts) => {
    const { runConfigGet } = await import('./commands/config.js');
    runConfigGet(key, opts);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value (e.g. ai.api_keys.anthropic <key>)')
  .option('--dir <path>', 'Custom directory')
  .action(async (key, value, opts) => {
    const { runConfigSet } = await import('./commands/config.js');
    runConfigSet(key, value, opts);
  });

configCmd
  .command('test-ai')
  .description('Test AI provider connectivity')
  .option('--dir <path>', 'Custom directory')
  .action(async (opts) => {
    const { runConfigTestAi } = await import('./commands/config.js');
    await runConfigTestAi(opts);
  });

program.parse(process.argv);
