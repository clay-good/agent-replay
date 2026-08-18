/**
 * Token totals across OTLP export batches, as a MATRIX.
 *
 * This one expression has been wrong twice in a week, in opposite directions: a
 * redelivered batch re-added the tokens of spans it had just dropped
 * (over-count), and the fix for that then dropped a first-time root's own usage
 * when it upgraded a rootless synthetic trace (under-count) — because the
 * redelivery guard read "no new child steps" as "nothing new". Three ad-hoc
 * cases were not enough to catch the second one, so every combination of
 * (root present / absent) x (already stored / new) x (synthetic target / real)
 * x (new child spans / all duplicates) is enumerated here and asserted
 * together. A fix to one row cannot silently break another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { handleTracesExport } from '../src/services/otel/receiver.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db); });
afterEach(() => db.close());

function span(id: string, op: string, parent?: string, tok?: number) {
  const attrs: unknown[] = [{ key: 'gen_ai.operation.name', value: { stringValue: op } }];
  if (tok != null) attrs.push({ key: 'gen_ai.usage.input_tokens', value: { intValue: String(tok) } });
  return { traceId: 'zz', spanId: id, ...(parent ? { parentSpanId: parent } : {}), name: op,
    startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000', attributes: attrs };
}
const B = (spans: unknown[]) => JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] }, scopeSpans: [{ spans }] }] });
const stats = { acceptedSpans: 0, acceptedTraces: 0 };
function state() {
  const t = listTraces(db, {}).items[0];
  const full = getTrace(db, t.id)!;
  return { tokens: full.total_tokens, steps: full.steps.length, synthetic: !!(full.metadata as Record<string, unknown>).synthetic_trace };
}

const ROOT = () => span('r1', 'invoke_agent', undefined, 50);
const CHAT = () => span('c1', 'chat', 'r1', 120);
const TOOL = () => span('t1', 'execute_tool', 'r1');

describe('receiver batch matrix — expected totals', () => {
  // Asserted as a TUPLE. An earlier version checked only the token total and
  // computed `steps`/`synthetic` for the failure message alone — so every row
  // still passed with the synthetic-trace upgrade disabled outright, which is
  // precisely the harm the round-7 fix was about. A number that happens to be
  // right is not evidence the trace is right.
  it.each([
    ['root+chat, then identical redelivery', [[ROOT(), CHAT()], [ROOT(), CHAT()]], 170, 1, false],
    ['root+chat, then root only (retry)', [[ROOT(), CHAT()], [ROOT()]], 170, 1, false],
    ['root+chat, then chat+tool', [[ROOT(), CHAT()], [CHAT(), TOOL()]], 170, 2, false],
    ['chat, then root+chat (synthetic upgrade)', [[CHAT()], [ROOT(), CHAT()]], 170, 1, false],
    ['chat, then root only', [[CHAT()], [ROOT()]], 170, 1, false],
    ['chat, then tool (no root at all)', [[CHAT()], [TOOL()]], 120, 2, true],
    ['root+chat, then a NEW chat span', [[ROOT(), CHAT()], [span('c2', 'chat', 'r1', 7)]], 177, 2, false],
    ['three identical deliveries', [[ROOT(), CHAT()], [ROOT(), CHAT()], [ROOT(), CHAT()]], 170, 1, false],
  ])('%s', (_label, batches, tokens, steps, synthetic) => {
    for (const b of batches as unknown[][]) handleTracesExport(db, B(b), stats);
    expect(state()).toEqual({ tokens, steps, synthetic });
  });
});
