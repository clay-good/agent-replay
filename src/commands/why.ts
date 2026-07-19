import { resolve } from 'node:path';
import chalk from 'chalk';
import type { CausalHop } from '../services/decision-service.js';
import { causalWalk } from '../services/decision-service.js';
import { ensureDatabase } from '../db/index.js';
import { stepIcon, stepLabel, heading, label } from '../ui/theme.js';
import { safeParseInt } from '../utils/json.js';
import type { StepType } from '../models/enums.js';

export interface WhyOptions {
  step?: string;
  json?: boolean;
  dir?: string;
}

const LINK_LABELS: Record<CausalHop['link'], string> = {
  origin: 'queried step',
  caused_by: 'caused by',
  parent: 'parent of',
  prior_decision: 'prior decision',
};

/**
 * `agent-replay why <trace-id> --step N` — walk the causal chain backward
 * from step N and explain how the agent got there.
 */
export function runWhy(traceId: string, opts: WhyOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const stepNumber = safeParseInt(opts.step, 0);
  if (!stepNumber || stepNumber < 1) {
    console.error(chalk.red('  --step <N> is required and must be a positive integer.'));
    process.exitCode = 2;
    return;
  }

  const result = causalWalk(db, traceId, stepNumber);
  if (!result) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    console.error(chalk.dim('  Use "agent-replay list" to see available traces.'));
    process.exitCode = 1;
    return;
  }

  const { trace, chain } = result;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          trace_id: trace.id,
          step: stepNumber,
          chain: chain.map((h) => ({
            step_number: h.step.step_number,
            step_type: h.step.step_type,
            name: h.step.name,
            link: h.link,
            decision: h.decision,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (chain.length === 0) {
    console.log('');
    console.log(chalk.yellow(`  Step ${stepNumber} not found in trace ${trace.id}.`));
    console.log('');
    return;
  }

  console.log('');
  console.log(heading(`  Why step ${stepNumber}? — causal chain (${chain.length} hop${chain.length === 1 ? '' : 's'})`));
  console.log('');

  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    const isLast = i === chain.length - 1;
    const arrow = i === 0 ? ' ' : chalk.dim('←');
    const via = i === 0 ? '' : chalk.dim(` (${LINK_LABELS[hop.link]})`);

    console.log(
      `  ${arrow} ${chalk.dim(`#${hop.step.step_number}`)} ` +
        `${stepIcon(hop.step.step_type as StepType)} ${stepLabel(hop.step.step_type as StepType)} ` +
        `${chalk.white.bold(`"${hop.step.name}"`)}${via}`,
    );

    if (hop.decision) {
      const d = hop.decision;
      console.log(`      ${label('Chose:')} ${chalk.greenBright(d.chosen)}` + (d.confidence != null ? chalk.dim(`  (confidence ${d.confidence})`) : ''));
      if (d.rationale) {
        console.log(`      ${label('Because:')} ${chalk.white(d.rationale)}`);
      }
    }

    if (!isLast) console.log(`  ${chalk.dim('  │')}`);
  }

  console.log('');
  const root = chain[chain.length - 1];
  console.log(chalk.dim(`  Chain terminates at step ${root.step.step_number} ("${root.step.name}").`));
  console.log('');
}
