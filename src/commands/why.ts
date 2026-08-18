import { resolve } from 'node:path';
import chalk from 'chalk';
import type { CausalHop } from '../services/decision-service.js';
import { causalWalk } from '../services/decision-service.js';
import { ensureDatabase } from '../db/index.js';
import { stepIcon, stepLabel, heading, label, safeText } from '../ui/theme.js';
import type { StepType } from '../models/enums.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse } from '../utils/refuse.js';
import { errorMessage } from '../utils/json.js';

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
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  // Parse with Number, not parseInt: `--step 1e2` must mean 100 (or be a usage
  // error), not a silently-truncated 1 that explains the wrong step. Matches
  // show/replay/fork's step-number flags. A missing flag is NaN → the required
  // error below; a non-integer or < 1 is a usage error.
  const refuse = makeRefuse(opts.json);
  const stepNumber = Number(opts.step);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) {
    refuse(2, '--step <N> is required and must be a positive integer.');
    return;
  }

  let result;
  try {
    result = causalWalk(db, traceId, stepNumber);
  } catch (err) {
    refuse(2, errorMessage(err));
    return;
  }
  if (!result) {
    refuse(1, `Trace not found: ${traceId}`, ['Use "agent-replay list" to see available traces.']);
    return;
  }

  const { trace, chain } = result;

  // A real step always yields at least its own origin hop, so an empty chain
  // means the requested step number doesn't exist. Treat it like trace-not-found
  // above (stderr + exit 1) rather than printing to stdout and succeeding.
  if (chain.length === 0) {
    refuse(1, `Step ${stepNumber} not found in trace ${safeText(trace.id)}.`, [
      `This trace has ${trace.steps.length} step(s).`,
    ]);
    return;
  }

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

  console.log('');
  // Count STEPS, not "hops": a one-step chain has no traversal at all, and a
  // three-step chain has two links — the label named the wrong quantity.
  console.log(heading(`  Why step ${stepNumber}? — causal chain (${chain.length} step${chain.length === 1 ? '' : 's'})`));
  console.log('');

  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    const isLast = i === chain.length - 1;
    const arrow = i === 0 ? ' ' : chalk.dim('←');
    const via = i === 0 ? '' : chalk.dim(` (${LINK_LABELS[hop.link]})`);

    console.log(
      `  ${arrow} ${chalk.dim(`#${hop.step.step_number}`)} ` +
        `${stepIcon(hop.step.step_type as StepType)} ${stepLabel(hop.step.step_type as StepType)} ` +
        `${chalk.white.bold(`"${safeText(hop.step.name)}"`)}${via}`,
    );

    if (hop.decision) {
      const d = hop.decision;
      console.log(`      ${label('Chose:')} ${chalk.greenBright(safeText(d.chosen))}` + (d.confidence != null ? chalk.dim(`  (confidence ${d.confidence})`) : ''));
      if (d.rationale) {
        console.log(`      ${label('Because:')} ${chalk.white(safeText(d.rationale))}`);
      }
    }

    if (!isLast) console.log(`  ${chalk.dim('  │')}`);
  }

  console.log('');
  const root = chain[chain.length - 1];
  console.log(chalk.dim(`  Chain terminates at step ${root.step.step_number} ("${safeText(root.step.name)}").`));
  console.log('');
}
