import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { startOtelReceiver, type OtelStats } from '../services/otel/receiver.js';
import { heading } from '../ui/theme.js';
import { resolveDataDir, storeSplitNote } from '../utils/paths.js';

export interface OtelServeOptions {
  port?: string;
  dir?: string;
}

/**
 * `agent-replay otel serve` — run a local OTLP/HTTP receiver that maps GenAI
 * semconv spans (OTLP/JSON) into the trace store live. Point any OTel exporter
 * at http://localhost:<port> with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
 * switched to http/json.
 */
export async function runOtelServe(opts: OtelServeOptions = {}): Promise<void> {
  // A malformed --port must be a usage error, not a silent fall-back to 4318 —
  // otherwise a typo'd port binds the default and the user's exporter, pointed
  // at the intended port, silently connects to nothing.
  let port = 4318;
  if (opts.port != null) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(chalk.red(`  Invalid --port: ${opts.port} (must be an integer between 1 and 65535).`));
      process.exitCode = 2;
      return;
    }
    // Bind the value we validated. A second parse (parseInt) would disagree on
    // strings like "0x20" (Number → 32 but parseInt → 0, binding a random OS
    // port) or "1e2" (100 vs 1) — the exporter would then hit the wrong port.
    port = p;
  }
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Record, but say where: creating a store here while a project above has
  // one splits the capture in two, and the half written here is invisible to a
  // command run from the project root. Never a refusal — losing the run is
  // worse than recording it somewhere unexpected.
  const splitNote = storeSplitNote(opts.dir, dbPath);
  if (splitNote) console.error(chalk.yellow(`  ⚠ ${splitNote}`));
  const db = ensureDatabase(dbPath);

  const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
  const handle = await startOtelReceiver(db, port, stats);

  console.log('');
  console.log(heading(`  OTLP receiver listening on http://localhost:${handle.port}`));
  console.log(chalk.dim('  POST /v1/traces and /v1/logs — OTLP/JSON or OTLP/protobuf, gzip accepted.'));
  console.log(chalk.dim('  Press Ctrl-C to stop.'));
  console.log('');

  const shutdown = async (): Promise<void> => {
    await handle.close();
    console.log('');
    console.log(chalk.dim(`  Stopped. Accepted ${stats.acceptedTraces} trace(s), ${stats.acceptedSpans} step(s).`));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
