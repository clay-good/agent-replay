import { mapOtlpTraces } from './src/services/otel/semconv.js';
import { mapOtlpLogs } from './src/services/otel/log-events.js';

const kv = (k: string, v: unknown) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });
const span = (o: any) => ({ traceId: 't1', ...o });
const payload = (spans: any[]) => ({ resourceSpans: [{ resource: { attributes: [kv('service.name', 'svc')] }, scopeSpans: [{ spans }] }] });

// 1. root span carrying tokens/model/provider
let t = mapOtlpTraces(payload([
  span({ spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
    attributes: [kv('gen_ai.operation.name','invoke_agent'), kv('gen_ai.usage.input_tokens',100), kv('gen_ai.usage.output_tokens',50), kv('gen_ai.request.model','claude-opus-5'), kv('gen_ai.provider.name','anthropic'), kv('gen_ai.request.temperature','0.7')] }),
]));
console.log('1 ROOT-ONLY:', JSON.stringify({tokens: t[0].total_tokens, meta: t[0].metadata, steps: t[0].steps?.length}));

// 2. exception event, status UNSET
t = mapOtlpTraces(payload([
  span({ spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1000000000', endTimeUnixNano: '3000000000', attributes:[kv('gen_ai.operation.name','invoke_agent')] }),
  span({ spanId: 'b', parentSpanId: 'a', name: 'execute_tool', startTimeUnixNano: '1500000000', endTimeUnixNano: '2000000000',
    attributes: [kv('gen_ai.operation.name','execute_tool')],
    events: [{ name: 'exception', attributes: [kv('exception.type','ValueError'), kv('exception.message','boom')] }] }),
]));
console.log('2 EXCEPTION EVENT:', JSON.stringify({status: t[0].status, stepErr: t[0].steps![0].error}));

// 3. duplicate span ids
t = mapOtlpTraces(payload([
  span({ spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1000000000', attributes:[kv('gen_ai.operation.name','invoke_agent')] }),
  span({ spanId: 'b', parentSpanId: 'a', name: 'chat', startTimeUnixNano: '1100000000', attributes:[kv('gen_ai.operation.name','chat')] }),
  span({ spanId: 'b', parentSpanId: 'a', name: 'chat-dup', startTimeUnixNano: '1200000000', attributes:[kv('gen_ai.operation.name','chat')] }),
  span({ spanId: 'c', parentSpanId: 'b', name: 'execute_tool', startTimeUnixNano: '1300000000', attributes:[kv('gen_ai.operation.name','execute_tool')] }),
]));
console.log('3 DUP SPANID:', JSON.stringify(t[0].steps!.map(s=>[s.step_number,s.name,s.parent_step])));

// 4. self-parent
t = mapOtlpTraces(payload([
  span({ spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1000000000', attributes:[kv('gen_ai.operation.name','invoke_agent')] }),
  span({ spanId: 'b', parentSpanId: 'b', name: 'chat', startTimeUnixNano: '1100000000', attributes:[kv('gen_ai.operation.name','chat')] }),
]));
console.log('4 SELF-PARENT:', JSON.stringify(t[0].steps!.map(s=>[s.step_number,s.parent_step])));

// 5. child starts before parent (out of order timestamps)
t = mapOtlpTraces(payload([
  span({ spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1000000000', attributes:[kv('gen_ai.operation.name','invoke_agent')] }),
  span({ spanId: 'p', parentSpanId: 'a', name: 'chat', startTimeUnixNano: '1500000000', attributes:[kv('gen_ai.operation.name','chat')] }),
  span({ spanId: 'c', parentSpanId: 'p', name: 'execute_tool', startTimeUnixNano: '1400000000', attributes:[kv('gen_ai.operation.name','execute_tool')] }),
]));
console.log('5 OUT-OF-ORDER:', JSON.stringify(t[0].steps!.map(s=>[s.step_number,s.name,s.parent_step])));

// 6. token attrs with wrong types
t = mapOtlpTraces(payload([
  span({ spanId: 'b', name: 'chat', startTimeUnixNano: '1000000000', endTimeUnixNano: '1000000000',
    attributes:[kv('gen_ai.operation.name','chat'), {key:'gen_ai.usage.input_tokens', value:{stringValue:'not-a-number'}}, {key:'gen_ai.usage.output_tokens', value:{arrayValue:{values:[{intValue:'5'}]}}}] }),
]));
console.log('6 BAD TOKEN TYPES:', JSON.stringify({tok: t[0].steps![0].tokens_used, total: t[0].total_tokens, dur: t[0].steps![0].duration_ms}));

// 6b. negative duration / end before start
t = mapOtlpTraces(payload([
  span({ spanId: 'b', name: 'chat', startTimeUnixNano: '5000000000', endTimeUnixNano: '1000000000', attributes:[kv('gen_ai.operation.name','chat')] }),
]));
console.log('6b NEG DURATION:', JSON.stringify({stepDur: t[0].steps![0].duration_ms, traceDur: t[0].total_duration_ms}));

// 7. missing traceId across unrelated services
const multi = { resourceSpans: [
  { resource:{attributes:[kv('service.name','svc-a')]}, scopeSpans:[{spans:[{ spanId:'a', name:'chat', startTimeUnixNano:'1000000000', attributes:[kv('gen_ai.operation.name','chat')] }]}] },
  { resource:{attributes:[kv('service.name','svc-b')]}, scopeSpans:[{spans:[{ spanId:'z', name:'chat', startTimeUnixNano:'2000000000', attributes:[kv('gen_ai.operation.name','chat')] }]}] },
]};
t = mapOtlpTraces(multi as any);
console.log('7 NO TRACEID:', JSON.stringify({traces: t.length, agent: t[0].agent_name, steps: t[0].steps!.length, meta: t[0].metadata}));

// 8. gen_ai.request.model absent but response.model present + llm.* openinference tokens
t = mapOtlpTraces(payload([
  span({ spanId:'b', name:'chat', startTimeUnixNano:'1000000000', attributes:[kv('gen_ai.operation.name','chat'), kv('gen_ai.response.model','claude-opus-5-20260101'), kv('gen_ai.usage.input_tokens',10), kv('gen_ai.usage.cost',0.02)] }),
]));
console.log('8 MODEL/COST:', JSON.stringify(t[0].steps![0]));

// 9. gemini failed tool call
const lp = (recs: any[]) => ({ resourceLogs: [{ resource:{attributes:[]}, scopeLogs:[{ logRecords: recs }] }] });
let L = mapOtlpLogs(lp([
  { timeUnixNano:'1000000000', attributes:[kv('event.name','gemini_cli.user_prompt'), kv('session.id','s1'), kv('prompt','hi')] },
  { timeUnixNano:'2000000000', attributes:[kv('event.name','gemini_cli.tool_call'), kv('session.id','s1'), kv('function_name','write'), {key:'success',value:{boolValue:false}}, kv('error','disk full'), kv('error_type','FileError')] },
]));
console.log('9 GEMINI FAILED TOOL:', JSON.stringify({status: L[0].status, step: L[0].steps![0]}));

// 10. claude code api_error + tool_result error
L = mapOtlpLogs(lp([
  { timeUnixNano:'1000000000', attributes:[kv('event.name','claude_code.user_prompt'), kv('session.id','s2'), kv('prompt','hi')] },
  { timeUnixNano:'2000000000', attributes:[kv('event.name','claude_code.api_error'), kv('session.id','s2'), kv('error','429 rate limit'), kv('model','claude-opus-5'), kv('status_code','429')] },
  { timeUnixNano:'3000000000', attributes:[kv('event.name','claude_code.tool_result'), kv('session.id','s2'), kv('tool_name','Bash'), {key:'success',value:{boolValue:false}}, kv('error','exit 1'), kv('duration_ms',1200)] },
  { timeUnixNano:'4000000000', attributes:[kv('event.name','claude_code.api_request'), kv('session.id','s2'), kv('input_tokens',100), kv('output_tokens',20), kv('cost_usd','0.05'), kv('model','claude-opus-5')] },
]));
console.log('10 CC:', JSON.stringify({status:L[0].status, tokens:L[0].total_tokens, cost:(L[0] as any).total_cost_usd, steps:L[0].steps}));
