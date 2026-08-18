/**
 * Token totals across OTLP export batches.
 *
 * Every one of these three shapes has been wrong at some point in the same
 * week, in both directions: a redelivered batch re-added the tokens of spans it
 * had just dropped (over-count), and then the fix for that dropped the root's
 * own usage when a rootless synthetic trace was upgraded (under-count), because
 * the redelivery guard treated "no new child steps" as "nothing new" even when
 * the batch carried a first-time root. They are asserted together so a fix to
 * one cannot silently break another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { handleTracesExport } from '../src/services/otel/receiver.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db); });
afterEach(() => db.close());

function span(id: string, name: string, op: string, parent?: string, tok?: number) {
  const attrs: unknown[] = [{ key: 'gen_ai.operation.name', value: { stringValue: op } }];
  if (tok != null) attrs.push({ key: 'gen_ai.usage.input_tokens', value: { intValue: String(tok) } });
  return { traceId: 'zz', spanId: id, ...(parent ? { parentSpanId: parent } : {}), name,
    startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000', attributes: attrs };
}
function batch(spans: unknown[]) {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] }, scopeSpans: [{ spans }] }] });
}
function tokens(): number | null {
  const items = listTraces(db, {}).items;
  return getTrace(db, items[0].id)!.total_tokens;
}

describe('otel token totals across batches', () => {
  const stats = { acceptedSpans: 0, acceptedTraces: 0 };
  it('child then root+child (synthetic upgrade + redelivery) = 170', () => {
    handleTracesExport(db, batch([span('c1', 'chat', 'chat', 'r1', 120)]), stats);
    handleTracesExport(db, batch([span('r1', 'invoke_agent', 'invoke_agent', undefined, 50), span('c1', 'chat', 'chat', 'r1', 120)]), stats);
    expect(tokens()).toBe(170);
  });
  it('child then root alone = 170', () => {
    handleTracesExport(db, batch([span('c1', 'chat', 'chat', 'r1', 120)]), stats);
    handleTracesExport(db, batch([span('r1', 'invoke_agent', 'invoke_agent', undefined, 50)]), stats);
    expect(tokens()).toBe(170);
  });
  it('root+child then child+tool (mixed redelivery) = 120', () => {
    handleTracesExport(db, batch([span('r1', 'invoke_agent', 'invoke_agent'), span('c1', 'chat', 'chat', 'r1', 120)]), stats);
    handleTracesExport(db, batch([span('c1', 'chat', 'chat', 'r1', 120), span('t1', 'execute_tool', 'execute_tool', 'r1')]), stats);
    expect(tokens()).toBe(120);
  });
});
