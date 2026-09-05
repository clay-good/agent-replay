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
import { listTraces, getTrace, ingestTrace, mergeBatchIntoTrace } from '../src/services/trace-service.js';

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

describe('concurrent redelivery', () => {
  // The dedupe is a CHECK-THEN-ACT — it reads the trace's stored span ids, then
  // writes — so concurrency is where it would fail if it were going to. Ten
  // identical batches applied back to back through the same path must leave one
  // batch's worth of steps and tokens, not ten. (Measured against a live
  // receiver with ten simultaneous HTTP posts as well: 200 steps and 1000
  // tokens, not 2000 and 10000.)
  it('applies the same batch ten times without inflating anything', () => {
    const batch = B([ROOT(), CHAT(), TOOL()]);
    for (let i = 0; i < 10; i++) handleTracesExport(db, batch, stats);
    expect(state()).toEqual({ tokens: 170, steps: 2, synthetic: false });
  });
});

describe('assembling a long session does not cost more per batch as it grows', () => {
  // A `BatchSpanProcessor` flushes many batches into one trace — the pattern
  // the cross-batch assembly exists to serve — and each merge used to read
  // every step the trace had so far, JSON-parsing each one's metadata, to
  // recover three things it can get directly: the highest step number, the
  // span-id map, and the orphans. So the cost of a session grew with the square
  // of its length. Measured over 1,000 ten-span batches: 2.32 ms/batch at 4,000
  // steps and 6.68 ms/batch at 10,000, 4.47s in total. Reading only what the
  // batch needs — and indexing the two lookups (schema v6) — brings that to
  // 0.40 and 0.81 ms/batch, 1.44s.
  function merged(db: Database.Database, batches: number, perBatch: number): { id: string; msPerBatch: number[] } {
    let seq = 0;
    const steps = (n: number) =>
      Array.from({ length: n }, () => {
        const i = seq++;
        return {
          step_number: i + 1, step_type: 'tool_call' as const, name: `t${i}`,
          started_at: new Date(1700000000000 + i * 100).toISOString(),
          metadata: { otel_span_id: String(i).padStart(16, '0'), otel_parent_span_id: '0'.padStart(16, '0') },
        };
      });
    const trace = ingestTrace(db, { agent_name: 'long', status: 'running', input: {}, steps: steps(perBatch) } as never);
    const msPerBatch: number[] = [];
    for (let b = 0; b < batches; b++) {
      const t = performance.now();
      mergeBatchIntoTrace(db, trace.id, { agent_name: 'long', status: 'running', input: {}, steps: steps(perBatch) } as never);
      msPerBatch.push(performance.now() - t);
    }
    return { id: trace.id, msPerBatch };
  }

  it('costs about the same per batch early and late in a long session', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      // Start above the renumber bound, so this measures the merge itself
      // rather than the (deliberately bounded) renumbering below it.
      const { id, msPerBatch } = merged(db, 1500, 10);
      const early = msPerBatch.slice(100, 300).reduce((a, c) => a + c, 0) / 200;
      const late = msPerBatch.slice(-200).reduce((a, c) => a + c, 0) / 200;

      // A ratio, so it means the same on any machine. The trace roughly triples
      // between the two windows; before this it cost ~3x more per batch at the
      // end, and now it is close to flat. 2.5x leaves room on both sides.
      // Measured here: 3.12 before, 0.33 after (the late window is actually
      // cheaper, because the early one still includes the sub-2,000-step
      // renumbering this path deliberately bounds). 2.5 sits between them with
      // room on both sides.
      expect(late).toBeLessThan(early * 2.5 + 0.2);

      // ...and the assembly is still correct: one trace, every span a step.
      const steps = db.prepare('SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id = ?').get(id) as { c: number };
      expect(steps.c).toBe(10 + 1500 * 10);
      expect((db.prepare('SELECT COUNT(*) c FROM agent_traces').get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  }, 120_000);

  it('indexes the two lookups the merge makes', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const idx = (db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_trace_steps_%'")
        .all() as { name: string }[]).map((r) => r.name).sort();
      expect(idx).toContain('idx_agent_trace_steps_otel_span');
      expect(idx).toContain('idx_agent_trace_steps_unparented');
    } finally {
      db.close();
    }
  });
});
