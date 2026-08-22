import { resolve } from 'node:path';
import chalk from 'chalk';
import { listDecisions } from '../services/decision-service.js';
import { ensureDatabase } from '../db/index.js';
import { heading, label, safeText, safeLine} from '../ui/theme.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse, openStoreOr } from '../utils/refuse.js';
import { errorMessage, truncate} from '../utils/json.js';

export interface DecisionsOptions {
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay decisions <trace-id>` — list every decision point in a trace
 * with its options, chosen option, confidence, and rationale.
 */
export function runDecisions(traceId: string, opts: DecisionsOptions = {}): void {
  const refuse = makeRefuse(opts.json);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath);
  if (!db) return;

  let result;
  try {
    result = listDecisions(db, traceId);
  } catch (err) {
    refuse(2, errorMessage(err));
    return;
  }
  if (!result) {
    refuse(1, `Trace not found: ${traceId}`, ['Use "agent-replay list" to see available traces.']);
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
    console.log(chalk.dim(`  No decision steps recorded in trace ${safeText(trace.id)}.`));
    console.log('');
    return;
  }

  console.log('');
  console.log(heading(`  ${decisions.length} decision point(s) in ${safeText(trace.id)}`));
  console.log('');

  for (const { step, decision } of decisions) {
    console.log(
      `  ${chalk.whiteBright('◆')} ${chalk.dim(`#${step.step_number}`)} ${chalk.white.bold(`"${safeLine(truncate(step.name, 80))}"`)}`,
    );

    if (!decision) {
      console.log(chalk.dim('      (no structured decision record)'));
      console.log('');
      continue;
    }

    const conf = decision.confidence != null ? chalk.dim(`  confidence ${decision.confidence}`) : '';
    const by = chalk.dim(`  by ${decision.decided_by}`);
    // Escaped, like every sibling view. A lone carriage return in `chosen`
    // overwrites the line on a real terminal, so this command — whose entire job
    // is reporting the choice — could DISPLAY a different option than the one
    // stored, contradicting `why` about the same record.
    console.log(`      ${label('Chose:')} ${chalk.greenBright(safeLine(decision.chosen))}${conf}${by}`);

    if (decision.options.length > 0) {
      console.log(`      ${label('Options:')}`);
      for (const opt of decision.options) {
        const chosen = opt.option === decision.chosen;
        const bullet = chosen ? chalk.greenBright('✔') : chalk.dim('•');
        const score = opt.score != null ? chalk.dim(` [${opt.score}]`) : '';
        const rationale = opt.rationale ? chalk.dim(` — ${safeLine(opt.rationale)}`) : '';
        // Defensive for records stored before options were validated at the
        // boundary: a bare string element made this a TypeError that aborted the
        // command and lost every later decision point in the trace.
        // `String(obj)` yields "[object Object]" for an option that is an object
      // without an `option` key — a shape only a hand-written or legacy store
      // has, but rendering it as that string tells the reader nothing about
      // what is actually stored. Fall back to the JSON.
      const optionText = safeLine(
        typeof opt?.option === 'string'
          ? opt.option
          : opt !== null && typeof opt === 'object'
            ? JSON.stringify(opt)
            : String(opt ?? ''),
      );
        console.log(`        ${bullet} ${chosen ? chalk.white(optionText) : chalk.dim(optionText)}${score}${rationale}`);
      }
    }

    if (decision.rationale) {
      console.log(`      ${label('Rationale:')} ${chalk.white(safeLine(decision.rationale))}`);
    }
    console.log('');
  }
}
