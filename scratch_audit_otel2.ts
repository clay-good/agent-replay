import Database from 'better-sqlite3';
import { mapOtlpTraces } from './src/services/otel/semconv.js';
import { mapOtlpLogs } from './src/services/otel/log-events.js';
import { handleTracesExport } from './src/services/otel/receiver.js';
import { initSchema } from './src/db/schema.js';
import { validateTraceInput } from './src/utils/validators.js';
import { getTrace } from './src/services/trace-service.js';

const kv = (k: string, v: unknown) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });
const payload = (spans: any[]) => ({ resourceSpans: [{ resource: { attributes: [kv('service.name','svc')] }, scopeSpans: [{ spans }] }] });

// A: equal start times, child listed before parent (BatchSpanProcessor end-order)
const p = payload([
  { traceId:'t1', spanId:'a', name:'invoke_agent', startTimeUnixNano:'1000000000', attributes:[kv('gen_ai.operation.name','invoke_agent')] },
  { traceId:'t1', spanId:'c', parentSpanId:'p', name:'execute_tool', startTimeUnixNano:'1500000000', endTimeUnixNano:'1600000000', attributes:[kv('gen_ai.operation.name','execute_tool')] },
  { traceId:'t1', spanId:'p', parentSpanId:'a', name:'chat', startTimeUnixNano:'1500000000', endTimeUnixNano:'1700000000', attributes:[kv('gen_ai.operation.name','chat')] },
]);
const t = mapOtlpTraces(p as any);
console.log('A EQUAL-START ORDER:', JSON.stringify(t[0].steps!.map(s=>[s.step_number,s.name,s.parent_step])));
const v = validateTraceInput(t[0] as any);
console.log('A VALIDATE ROUNDTRIP:', v.valid, JSON.stringify(v.errors));

// B: persist it and read back
const db = new Database(':memory:');
initSchema(db);
const stats = { acceptedSpans:0, acceptedTraces:0 };
console.log('B HTTP:', JSON.stringify(handleTracesExport(db, JSON.stringify(p), stats)));
const row = db.prepare('SELECT id FROM agent_traces').get() as any;
const stored = getTrace(db, row.id)!;
console.log('B STORED:', JSON.stringify(stored.steps.map(s=>[s.step_number,s.name,s.parent_step_number])));

// C: negative duration persisted?
const negp = payload([{ traceId:'tn', spanId:'b', name:'chat', startTimeUnixNano:'5000000000', endTimeUnixNano:'1000000000', attributes:[kv('gen_ai.operation.name','chat')] }]);
handleTracesExport(db, JSON.stringify(negp), stats);
const nrow = db.prepare("SELECT id,total_duration_ms,started_at,ended_at FROM agent_traces WHERE json_extract(metadata,'$.otel_trace_id')='tn'").get();
console.log('C NEG STORED:', JSON.stringify(nrow));

// D: two batches of trace-id-less spans
const nop = { resourceSpans:[{ resource:{attributes:[kv('service.name','svc')]}, scopeSpans:[{ spans:[{ spanId:'x', name:'chat', startTimeUnixNano:'1000000000', attributes:[kv('gen_ai.operation.name','chat')] }] }] }] };
handleTracesExport(db, JSON.stringify(nop), stats);
handleTracesExport(db, JSON.stringify(nop), stats);
console.log('D NO-TRACEID TRACES:', db.prepare("SELECT count(*) c FROM agent_traces WHERE json_extract(metadata,'$.otel_trace_id')=''").get());

// E: log batch with only errors and no user prompt
const lp = (recs:any[]) => ({ resourceLogs:[{ resource:{attributes:[]}, scopeLogs:[{ logRecords: recs }] }] });
const L = mapOtlpLogs(lp([
  { timeUnixNano:'2000000000', attributes:[kv('event.name','claude_code.api_error'), kv('session.id','s9'), kv('error','500 overloaded')] },
  { timeUnixNano:'2500000000', attributes:[kv('event.name','gemini_cli.api_error'), kv('session.id','s9'), kv('error','quota')] },
]));
console.log('E ERROR-ONLY LOG BATCH -> traces:', L.length);

// F: gemini api_response tokens as doubles / string session ids
const L2 = mapOtlpLogs(lp([
  { timeUnixNano:'1000000000', attributes:[kv('event.name','gemini_cli.user_prompt'), kv('session.id','s3'), kv('prompt_length',42)] },
  { timeUnixNano:'2000000000', attributes:[kv('event.name','gemini_cli.api_response'), kv('session.id','s3'), {key:'input_token_count',value:{intValue:'0'}}, {key:'output_token_count',value:{intValue:'0'}}, kv('model','gemini-2.5-pro'), kv('duration_ms',900)] },
]));
console.log('F REDACTED PROMPT:', JSON.stringify(L2));
