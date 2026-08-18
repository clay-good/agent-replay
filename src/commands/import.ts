import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { deleteTrace } from '../services/trace-service.js';
import { importClaudeTranscript } from '../services/importers/claude-transcript.js';
import { importCodexRollout } from '../services/importers/codex-rollout.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';

export interface ImportOptions {
  format?: string;
  tags?: string;
  dir?: string;
  replace?: boolean;
}

const SUPPORTED = ['claude-transcript', 'codex-rollout'];

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
export function runImport(filePath: string, opts: ImportOptions = {}): void {
  const format = opts.format ?? 'claude-transcript';
  if (!SUPPORTED.includes(format)) {
    console.error(chalk.red(`  Unsupported --format "${format}". Supported: ${SUPPORTED.join(', ')}.`));
    process.exitCode = 2;
    return;
  }

  const absPath = resolve(filePath);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
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
              AND json_extract(metadata, '$.source_format') IS ?
              AND json_extract(metadata, '$.source_file') IS ?
            ORDER BY started_at ASC`,
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
    for (const prior of priors) deleteTrace(db, prior.id);
  }

  console.log('');
  console.log(
    summaryPanel('Import Summary', {
      ...(priors.length > 0 ? { Replaced: priors.map((p) => p.id).join(', ') } : {}),
      'Trace ID': report.trace.id,
      'Session': report.trace.session_id ?? '(none)',
      'Steps': report.steps,
      'Records imported': report.imported,
      'Records skipped': report.skipped,
    }),
  );
  console.log('');
}
