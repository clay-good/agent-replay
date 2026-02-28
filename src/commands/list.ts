import { resolve } from 'node:path';
import chalk from 'chalk';
import type { ListTracesFilter } from '../models/types.js';
import { listTraces } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceTable } from '../ui/table.js';
import { heading } from '../ui/theme.js';
import { parseSinceToIso } from '../utils/time.js';
import { safeParseInt } from '../utils/json.js';

export interface ListOptions {
  status?: string;
  agent?: string;
  tag?: string;
  since?: string;
  sort?: string;
  limit?: string;
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay list` — query traces with filters and display a formatted table.
 */
export function runList(opts: ListOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const filter: ListTracesFilter = {};

  if (opts.status) filter.status = opts.status;
  if (opts.agent) filter.agent_name = opts.agent;
  if (opts.tag) filter.tag = opts.tag;
  if (opts.since) filter.since = parseSinceToIso(opts.since);
  if (opts.sort) {
    const desc = opts.sort.startsWith('-');
    filter.sort_by = desc ? opts.sort.slice(1) : opts.sort;
    filter.sort_order = desc ? 'desc' : 'asc';
  }
  filter.limit = safeParseInt(opts.limit, 25);

  const { items: traces, total } = listTraces(db, filter);

  if (opts.json) {
    console.log(JSON.stringify({ items: traces, total }, null, 2));
    return;
  }

  if (traces.length === 0) {
    console.log('');
    console.log(chalk.dim('  No traces found.'));
    console.log(
      chalk.dim('  Run ') +
        chalk.white('agent-replay demo') +
        chalk.dim(' to load sample data.'),
    );
    console.log('');
    return;
  }

  console.log('');
  console.log(heading(`  ${traces.length} trace(s) found${total > traces.length ? ` (${total} total)` : ''}`));
  console.log('');
  console.log(traceTable(traces));
  console.log('');
}
