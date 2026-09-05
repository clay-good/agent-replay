import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, mergeBatchIntoTrace } from '../src/services/trace-service.js';

describe('merge cost', () => {
  it('per-batch cost as the trace grows', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    let seq = 0;
    const mkSteps = (n: number) => Array.from({ length: n }, () => {
      const i = seq++;
      return {
        step_number: i + 1, step_type: 'tool_call' as const, name: `t${i}`,
        started_at: new Date(1700000000000 + i * 100).toISOString(),
        metadata: { otel_span_id: String(i).padStart(16, '0'), otel_parent_span_id: '0'.padStart(16, '0') },
      };
    });
    const t = ingestTrace(db, { agent_name: 'm', status: 'running', input: {}, steps: mkSteps(10) } as never);
    const marks: number[] = [];
    for (let b = 0; b < 1000; b++) {
      const a = performance.now();
      mergeBatchIntoTrace(db, t.id, { agent_name: 'm', status: 'running', input: {}, steps: mkSteps(10) } as never);
      marks.push(performance.now() - a);
      if ((b + 1) % 200 === 0) {
        const w = marks.slice(-200);
        console.log(`at ${(b + 1) * 10 + 10} steps: ${(w.reduce((x, y) => x + y, 0) / 200).toFixed(2)}ms/batch`);
      }
    }
    console.log(`total ${(marks.reduce((x, y) => x + y, 0) / 1000).toFixed(2)}s`);
    expect(true).toBe(true);
  }, 600000);
});
