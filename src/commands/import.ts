import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { deleteTrace } from '../services/trace-service.js';
import { importClaudeTranscript } from '../services/importers/claude-transcript.js';
import { importCodexRollout } from '../services/importers/codex-rollout.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';
import { julianDayExpr } from '../utils/time.js';
import { readJsonlLines } from '../services/importers/jsonl-reader.js';
import { resolveDataDir, storeSplitNote } from '../utils/paths.js';

export interface ImportOptions {
  format?: string;
  tags?: string;
  dir?: string;
  replace?: boolean;
}

const SUPPORTED = ['claude-transcript', 'codex-rollout'];

/** How many records the format sniffer reads before answering. */
const SNIFF_RECORDS = 50;

/**
 * `agent-replay import <path> --format <fmt>` — best-effort conversion of an
 * on-disk session log into a trace. Unrecognized records are skipped and
 * counted; the imported/skipped tally is reported.
 *
 * Importing the same session twice does NOT create a second trace. Nothing
 * checked, so a re-run after a crash — or the obvious shell loop over a
 * session directory, on a schedule —
 * silently doubled every store-wide number (`stats`, the dashboard totals, any
 * eval over the store) and left N indistinguishable rows in `list` with no way
 * to tell the copies apart or clean them up. A session already in the store is
 * reported and left alone; `--replace` re-imports it, which is also how a
 * transcript that has GROWN since the last import is refreshed.
 */
/**
 * The `--format` that reads this file, or null when its records do not clearly
 * belong to one.
 *
 * Keyed on record shapes that are UNAMBIGUOUS between the two formats, taken
 * from real files of each: a Codex rollout wraps everything as
 * `{type: session_meta|response_item|event_msg|turn_context, payload}`, while a
 * Claude transcript's records are `{type: user|assistant, message, sessionId}`.
 * Neither vocabulary appears in the other.
 *
 * Only the head of the file is read — the answer is in the first records, and a
 * failed import must not pay for a second full pass over a 600 MB transcript.
 * Silence is the right answer when nothing is distinctive: sending the reader
 * to a second format that also imports nothing is worse than saying nothing.
 */
function formatForFile(absPath: string, current: string): string | null {
  const votes = new Map<string, number>();
  const vote = (fmt: string) => votes.set(fmt, (votes.get(fmt) ?? 0) + 1);
  let read = 0;
  try {
    for (const line of readJsonlLines(absPath)) {
      if (read >= SNIFF_RECORDS) break;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
      read++;
      const r = rec as Record<string, unknown>;
      const type = typeof r.type === 'string' ? r.type : '';
      if (type === 'session_meta' || type === 'response_item' || type === 'event_msg' || type === 'turn_context') {
        vote('codex-rollout');
      } else if ((type === 'user' || type === 'assistant') && r.message != null) {
        vote('claude-transcript');
      }
    }
  } catch {
    // Unreadable now for the same reason the import failed; nothing to add.
    return null;
  }
  // A single winner only: a file that voted for both is telling us the shapes
  // are shared, not that one of them is right.
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length !== 1) return null;
  const [best] = ranked[0];
  return best === current ? null : best;
}

export function runImport(filePath: string, opts: ImportOptions = {}): void {
  const format = opts.format ?? 'claude-transcript';
  if (!SUPPORTED.includes(format)) {
    console.error(chalk.red(`  Unsupported --format "${format}". Supported: ${SUPPORTED.join(', ')}.`));
    process.exitCode = 2;
    return;
  }

  const absPath = resolve(filePath);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Record, but say where: creating a store here while a project above has
  // one splits the capture in two, and the half written here is invisible to a
  // command run from the project root. Never a refusal — losing the run is
  // worse than recording it somewhere unexpected.
  const splitNote = storeSplitNote(opts.dir, dbPath);
  if (splitNote) console.error(chalk.yellow(`  ⚠ ${splitNote}`));
  const db = ensureDatabase(dbPath);

  const tags = (opts.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let report;
  try {
    const importer = format === 'codex-rollout' ? importCodexRollout : importClaudeTranscript;
    report = importer(db, absPath, { tags: tags.length ? tags : undefined });
  } catch (err) {
    console.error(chalk.red(`  Import failed: ${errorMessage(err)}`));
    process.exitCode = 1;
    return;
  }

  if (!report.trace) {
    // Producing no trace is a failed import (wrong/corrupt/empty file), not a
    // no-op success — exit non-zero so `import X && use-trace` doesn't proceed.
    console.error(chalk.yellow(`  Nothing importable found in ${absPath} (${report.skipped} record(s) skipped).`));
    // ...and say when the file is plainly the OTHER supported format.
    //
    // `--format` defaults to `claude-transcript`, so pointing `import` at a
    // Codex rollout without the flag runs the Claude parser over it: every
    // record is skipped and the reader is told nothing is importable about a
    // file that imports 2,452 steps with the right flag. That refusal names a
    // cause the reader can disprove with the file in their hand. Same remedy
    // `record` already gives for its four stream formats: suggest, only on a
    // run that already failed, and only on unambiguous evidence.
    const suggestion = formatForFile(absPath, format);
    if (suggestion) {
      console.error(chalk.yellow(`  These records look like the ${suggestion} format — try --format ${suggestion}.`));
    }
    process.exitCode = 1;
    return;
  }

  // Identity is the session id, the source format AND the source file.
  //
  // Session id alone is NOT an identity: a Claude Code subagent sidecar
  // (`<session>/subagents/agent-*.jsonl`) carries the same `sessionId` as its
  // parent transcript, so keying on it collapsed two different files with
  // different content — importing a sidecar reported "already imported" and
  // dropped it, and `--replace` DELETED the parent session's trace (steps,
  // evals and all) in favour of the much smaller sidecar. The source format is
  // in the key too because two tools can number their sessions however they
  // like. The file is matched by BASENAME so moving the directory does not make
  // the same session look new.
  //
  // A trace imported before this field existed carries no `source_file`, and is
  // deliberately NOT matched: re-importing such a file produces one duplicate,
  // which the user can see and delete, whereas matching on the older, weaker key
  // risks replacing a trace that merely shares a session id. A file with no
  // session id at all cannot be identified either, and is imported as before.
  const sessionId = report.trace.session_id;
  const meta = report.trace.metadata as { source_format?: unknown; source_file?: unknown } | null;
  const sourceFormat = meta?.source_format;
  const sourceFile = meta?.source_file;
  const priors = sessionId
    ? (db
        .prepare(
          `SELECT id FROM agent_traces
            WHERE session_id = ?
              AND id != ?
              AND parent_trace_id IS NULL
              AND json_extract(metadata, '$.source_format') IS ?
              AND json_extract(metadata, '$.source_file') IS ?
            ORDER BY ${julianDayExpr('started_at')} ASC, started_at ASC`,
        )
        .all(sessionId, report.trace.id, sourceFormat ?? null, sourceFile ?? null) as Array<{ id: string }>)
    : [];

  if (priors.length > 0) {
    if (!opts.replace) {
      // Drop the copy we just made rather than leaving the store with two. This
      // is not an error — a loop over a session directory re-running after a
      // crash is the normal case — so it exits 0 and says what to pass to
      // actually re-import.
      deleteTrace(db, report.trace.id);
      console.error(
        chalk.yellow(`  Session already imported as ${priors[0].id} — nothing changed.`),
      );
      console.error(chalk.dim('  Pass --replace to import it again (use this when the transcript has grown since).'));
      return;
    }
    // Refuse rather than take a fork down with the trace it came from.
    //
    // A fork inherits its parent's `session_id` AND its `source_format` /
    // `source_file` metadata, so before the `parent_trace_id IS NULL` clause
    // above every fork of the session matched the priors key and was deleted
    // alongside the parent — `--replace` is the documented way to refresh a
    // transcript that has grown, so the routine refresh destroyed the user's
    // what-if sandboxes.
    //
    // Excluding forks from the query is necessary but not sufficient: the
    // parent row is still deleted, and `parent_trace_id` is declared
    // `ON DELETE SET NULL`, so a surviving fork would be silently PROMOTED to
    // a real run. `parent_trace_id IS NULL` is the only thing that marks a fork
    // as never-executed, and golden export, `check`, `stats` and `watch` all
    // rely on it — so the fork would start counting as a real trace, and as
    // spend that never happened.
    //
    // Re-pointing the fork at the new trace is not available either: the
    // refreshed transcript may have different steps, so `forked_from_step`
    // would no longer mean what it meant. Which of the two the user wants is a
    // real decision, so ask for it instead of guessing.
    const forks = db
      .prepare(
        `SELECT id, parent_trace_id FROM agent_traces
          WHERE parent_trace_id IN (${priors.map(() => '?').join(', ')})`,
      )
      .all(...priors.map((p) => p.id)) as Array<{ id: string; parent_trace_id: string }>;

    if (forks.length > 0) {
      deleteTrace(db, report.trace.id); // drop the copy we just made
      console.error(
        chalk.red(`  Refusing to replace ${priors.map((p) => p.id).join(', ')}: ${forks.length} fork(s) derive from it.`),
      );
      console.error(chalk.dim(`  Forks: ${forks.map((f) => f.id).join(', ')}`));
      console.error(chalk.dim('  Deleting the parent would leave each fork looking like a real run.'));
      console.error(chalk.dim('  Delete the forks first, or import without --replace to keep both copies.'));
      process.exitCode = 1;
      return;
    }

    // Say what else goes with the trace, before it goes.
    //
    // The fork branch above refuses precisely because deleting the parent would
    // damage something derived from it. EVALUATIONS are the other thing that
    // hangs off a trace, they cascade with it, and `--replace` is the
    // documented way to refresh a transcript that has grown — so the routine
    // refresh silently threw away every stored verdict, including the paid AI
    // ones. It is a note and not a refusal because an evaluation is
    // re-derivable (re-run `eval`) where a fork's what-if is not, and because
    // carrying old verdicts onto a trace whose steps have changed would attach
    // a score to a run it never measured.
    const lostEvals = priors.reduce(
      (n, p) =>
        n +
        (db.prepare('SELECT COUNT(*) AS n FROM agent_trace_evals WHERE trace_id = ?').get(p.id) as { n: number }).n,
      0,
    );

    for (const prior of priors) deleteTrace(db, prior.id);

    if (lostEvals > 0) {
      console.error(
        chalk.yellow(
          `  Note: ${lostEvals} stored evaluation result(s) were attached to the replaced trace and are gone with it.`,
        ),
      );
      console.error(chalk.dim(`  Re-run "agent-replay eval ${report.trace.id}" to evaluate the refreshed trace.`));
    }
  }

  // Say when this session is ALREADY in the store from another capture path.
  //
  // The identity check above keys on session id AND source format AND source
  // file, so it can only recognize a previous IMPORT. A live capture of the same
  // session — the hook adapter, or the OTel receiver — carries no source_format
  // and never matches, so importing the transcript of a session you also
  // captured live adds a second trace with the same agent and session id, and
  // every store-wide count doubles: `stats` reports two runs, `list` shows two
  // rows, a golden baseline holds two shapes of one session. The receiver says
  // this on its console for its own half of the problem; the import path said
  // nothing at all.
  //
  // A note and not a refusal: both traces are legitimate and hold different
  // things — the transcript has the full turn-by-turn record, the live capture
  // has decisions and guard checks the file never sees.
  const liveCaptures = sessionId
    ? (db
        .prepare(
          `SELECT id FROM agent_traces
            WHERE session_id = ? AND id != ? AND parent_trace_id IS NULL
              AND json_extract(metadata, '$.source_format') IS NULL
            ORDER BY ${julianDayExpr('started_at')} ASC, started_at ASC`,
        )
        .all(sessionId, report.trace.id) as Array<{ id: string }>)
    : [];
  if (liveCaptures.length > 0) {
    console.error(
      chalk.yellow(
        `  Note: this session was already captured live as ${liveCaptures.map((t) => t.id).join(', ')} — the store now holds ${liveCaptures.length + 1} traces for it.`,
      ),
    );
    console.error(chalk.dim('  Both are kept (a transcript and a live capture record different things), but every store-wide count includes both.'));
  }

  console.log('');
  console.log(
    summaryPanel('Import Summary', {
      ...(priors.length > 0 ? { Replaced: priors.map((p) => p.id).join(', ') } : {}),
      'Trace ID': report.trace.id,
      'Session': report.trace.session_id ?? '(none)',
      'Steps': report.steps,
      // The token total, WHERE IT IS MADE, with what it counts.
      //
      // A Claude transcript's usage blocks are dominated by
      // `cache_read_input_tokens` — the importer sums all four fields on
      // purpose, since that is what the session actually consumed — and the
      // result is startling out of context: one real session on this machine
      // imports as 1,089,468,689 tokens. The number first met the reader in
      // `stats` ("Total tokens: 1,089,468,689") with nothing to explain it, and
      // a figure a user cannot account for reads as a bug in the tool.
      ...(report.trace.total_tokens != null
        ? {
            'Tokens': `${report.trace.total_tokens.toLocaleString('en-US')}${
              format === 'claude-transcript' ? ' (prompt, completion and cache)' : ''
            }`,
          }
        : {}),
      'Records imported': report.imported,
      'Records skipped': report.skipped,
    }),
  );
  console.log('');
}
