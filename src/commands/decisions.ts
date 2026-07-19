import { resolve } from 'node:path';
import chalk from 'chalk';
import { listDecisions } from '../services/decision-service.js';
import { ensureDatabase } from '../db/index.js';
import { heading, label } from '../ui/theme.js';

export interface DecisionsOptions {
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay decisions <trace-id>` — list every decision point in a trace
 * with its options, chosen option, confidence, and rationale.
 */
export function runDecisions(traceId: string, opts: DecisionsOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const result = listDecisions(db, traceId);
  if (!result) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    console.error(chalk.dim('  Use "agent-replay list" to see available traces.'));
    process.exitCode = 1;
    return;
  }

  const { trace, decisions } = result;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          trace_id: trace.id,
          decisions: decisions.map((d) => ({
            step_number: d.step.step_number,
            name: d.step.name,
            ...(d.decision ?? {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (decisions.length === 0) {
    console.log('');
    console.log(chalk.dim(`  No decision steps recorded in trace ${trace.id}.`));
    console.log('');
    return;
  }

  console.log('');
  console.log(heading(`  ${decisions.length} decision point(s) in ${trace.id}`));
  console.log('');

  for (const { step, decision } of decisions) {
    console.log(
      `  ${chalk.whiteBright('◆')} ${chalk.dim(`#${step.step_number}`)} ${chalk.white.bold(`"${step.name}"`)}`,
    );

    if (!decision) {
      console.log(chalk.dim('      (no structured decision record)'));
      console.log('');
      continue;
    }

    const conf = decision.confidence != null ? chalk.dim(`  confidence ${decision.confidence}`) : '';
    const by = chalk.dim(`  by ${decision.decided_by}`);
    console.log(`      ${label('Chose:')} ${chalk.greenBright(decision.chosen)}${conf}${by}`);

    if (decision.options.length > 0) {
      console.log(`      ${label('Options:')}`);
      for (const opt of decision.options) {
        const chosen = opt.option === decision.chosen;
        const bullet = chosen ? chalk.greenBright('✔') : chalk.dim('•');
        const score = opt.score != null ? chalk.dim(` [${opt.score}]`) : '';
        const rationale = opt.rationale ? chalk.dim(` — ${opt.rationale}`) : '';
        console.log(`        ${bullet} ${chosen ? chalk.white(opt.option) : chalk.dim(opt.option)}${score}${rationale}`);
      }
    }

    if (decision.rationale) {
      console.log(`      ${label('Rationale:')} ${chalk.white(decision.rationale)}`);
    }
    console.log('');
  }
}
