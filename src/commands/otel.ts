import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { startOtelReceiver, type OtelStats } from '../services/otel/receiver.js';
import { heading } from '../ui/theme.js';
import { safeParseInt } from '../utils/json.js';

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
  if (opts.port != null) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(chalk.red(`  Invalid --port: ${opts.port} (must be an integer between 1 and 65535).`));
      process.exitCode = 2;
      return;
    }
  }
  const port = safeParseInt(opts.port, 4318);
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
  const handle = await startOtelReceiver(db, port, stats);

  console.log('');
  console.log(heading(`  OTLP receiver listening on http://localhost:${handle.port}`));
  console.log(chalk.dim('  POST /v1/traces (application/json). Press Ctrl-C to stop.'));
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
