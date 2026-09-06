import { resolve } from 'node:path';
import chalk from 'chalk';
import type { ListTracesFilter } from '../models/types.js';
import { isPossiblyAbandoned, listTraces } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceTable } from '../ui/table.js';
import { heading } from '../ui/theme.js';
import { parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse, openStoreOr } from '../utils/refuse.js';

export interface ListOptions {
  status?: string;
  agent?: string;
  source?: string;
  tag?: string;
  session?: string;
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
  const refuse = makeRefuse(opts.json);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath, opts.dir);
  if (!db) return;

  // An EMPTY value is a usage error, not "no filter". `--agent "$AGENT"` with an
  // unset shell variable would otherwise silently widen the query from one agent
  // to every trace in the store and exit 0 — the same silent scope-widening
  // `check` refuses for `--agent`/`--agent-exact` and for an empty `--fields`
  // list, and `stats` already refuses for `--since`. `list` is where a script
  // most often builds a filter from a variable, so it is the likeliest place for
  // the mistake, and a widened list reads exactly like a correct one.
  for (const [flag, value] of [
    ['--status', opts.status],
    ['--agent', opts.agent],
    ['--tag', opts.tag],
    ['--session', opts.session],
    ['--source', opts.source],
    ['--since', opts.since],
  ] as const) {
    if (value != null && value.trim() === '') {
      refuse(2, `${flag} was given an empty value.`, [`Pass a value, or omit ${flag} to list every trace.`]);
      return;
    }
  }

  const filter: ListTracesFilter = {};

  if (opts.status) filter.status = opts.status;
  if (opts.source) filter.source_format = opts.source;
  if (opts.agent) filter.agent_name = opts.agent;
  if (opts.tag) filter.tag = opts.tag;
  if (opts.session) filter.session_id = opts.session;
  // `--sort ""` is a usage error for the same reason `--sort bogus` is, and it
  // was reaching the opposite answer. `listTraces` deliberately rejects an
  // unknown sort field "rather than silently falling back to the default order
  // (which would hide the user's mistake)" — but the guard below is a bare
  // truthiness test, so `""` never reached that check at all and did exactly the
  // silent fall-back the check exists to prevent. A listing ordered by
  // `started_at` is indistinguishable from one ordered as asked.
  if (opts.sort != null && opts.sort.trim() === '') {
    refuse(2, '--sort was given an empty value.', [
      'Pass a field, or omit --sort to order by start time.',
    ]);
    return;
  }
  if (opts.sort) {
    const desc = opts.sort.startsWith('-');
    filter.sort_by = desc ? opts.sort.slice(1) : opts.sort;
    filter.sort_order = desc ? 'desc' : 'asc';
  }
  // A malformed --limit must be a usage error, not a silent fall-back to the
  // default (which would hide a typo) or a negative passed through to SQL
  // `LIMIT` (which SQLite reads as "no limit" — the opposite of the intent).
  if (opts.limit != null) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1) {
      refuse(2, `Invalid --limit: ${opts.limit} (must be a positive integer).`);
      return;
    }
    // Consume the value we validated. A second parse (parseInt) would disagree
    // on strings like "0x20" (Number → 32 but parseInt → 0, i.e. SQL LIMIT 0 →
    // zero rows → a false "No traces found") or "1e2" (100 vs 1).
    filter.limit = n;
  } else {
    filter.limit = 25;
  }

  let traces, total;
  try {
    if (opts.since) filter.since = parseSinceToIso(opts.since);
    ({ items: traces, total } = listTraces(db, filter));
  } catch (err) {
    refuse(2, errorMessage(err));
    return;
  }

  if (opts.json) {
    // `possibly_abandoned`, the same derived field `show --json` carries.
    //
    // The TABLE marks a stalled run "⚠ abandoned?" and the document said
    // nothing, so a script scanning the store for stuck runs — the natural
    // reader of `list --json`, and the one that cannot see a glyph — had to
    // re-implement the threshold. `show --json` was given this field for
    // exactly that reason; `list` is where it is actually needed.
    //
    // Derived on the display path only, never stored: same rule as
    // `effective_tokens` beside it.
    const items = traces.map((t) => ({ ...t, possibly_abandoned: isPossiblyAbandoned(t) }));
    console.log(JSON.stringify({ items, total }, null, 2));
    return;
  }

  if (traces.length === 0) {
    console.log('');
    console.log(chalk.dim('  No traces found.'));
    // Name the sources the store actually holds. A capture path is a value the
    // user has to spell exactly (`record:codex-exec`, not `record`), and the
    // difference between "nothing was captured that way" and "I typed it wrong"
    // is one line the store can answer.
    if (opts.source) {
      const present = (db
        .prepare(
          `SELECT DISTINCT json_extract(metadata, '$.source_format') AS source FROM agent_traces
            WHERE json_extract(metadata, '$.source_format') IS NOT NULL ORDER BY source`,
        )
        .all() as Array<{ source: string }>).map((r) => r.source);
      console.log(
        chalk.dim(
          present.length > 0
            ? `  This store holds: ${present.join(', ')}.`
            : '  No trace in this store records which capture path produced it.',
        ),
      );
    }
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
  // Bound what gets DRAWN. The query is flat — `--json --limit 10000` returns
  // in ~0.13s — but cli-table3's rendering is quadratic in row count (measured
  // on a bare table with no options and no styling: 1,000 rows 123ms, 8,000
  // rows 3.9s), so `list --limit 10000` spent about 7 seconds building an 11 MB
  // string for a table no one reads. 1,000 rows is already some forty
  // screenfuls and renders in a tenth of a second.
  //
  // Bounded and SAID, like the agent-name column above it and `show`'s step
  // window: the note names the cap and points at the path that has no cap at
  // all. `--json` is untouched — it returns every row the query matched.
  const RENDER_MAX = 1000;
  const drawn = traces.length > RENDER_MAX ? traces.slice(0, RENDER_MAX) : traces;
  console.log(traceTable(drawn));
  if (drawn.length < traces.length) {
    console.log('');
    console.log(
      chalk.dim(`  Drawing the first ${RENDER_MAX} of ${traces.length} matching traces. `) +
        chalk.white('--json') +
        chalk.dim(' returns them all.'),
    );
  }
  console.log('');
}
