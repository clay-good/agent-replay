/**
 * Minimal, dependency-free OTLP/protobuf encoder for tests — just enough of the
 * wire format (varints, length-delimited fields, fixed64) to build a
 * TracesData message with the OTLP field numbers. Used by the protobuf decoder
 * unit tests and the receiver's protobuf-over-HTTP end-to-end test.
 */

export function varint(n: number): Buffer {
  const b: number[] = [];
  while (n > 0x7f) {
    b.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  b.push(n);
  return Buffer.from(b);
}

export const tag = (field: number, wire: number) => varint((field << 3) | wire);
export const lenField = (field: number, buf: Buffer) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
export const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
export const varintField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);

export function fixed64Field(field: number, n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return Buffer.concat([tag(field, 1), b]);
}

export const anyStr = (s: string) => strField(1, s); // AnyValue.string_value = 1
export const anyInt = (n: number) => varintField(3, n); // AnyValue.int_value = 3
export const keyValue = (key: string, value: Buffer) => Buffer.concat([strField(1, key), lenField(2, value)]);

export function span(opts: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  end: bigint;
  attrs: Buffer[];
  error?: string;
}): Buffer {
  const parts = [
    lenField(1, Buffer.from(opts.traceId, 'hex')),
    lenField(2, Buffer.from(opts.spanId, 'hex')),
    ...(opts.parentSpanId ? [lenField(4, Buffer.from(opts.parentSpanId, 'hex'))] : []),
    strField(5, opts.name),
    fixed64Field(7, opts.start),
    fixed64Field(8, opts.end),
    ...opts.attrs.map((a) => lenField(9, a)),
    ...(opts.error ? [lenField(15, Buffer.concat([strField(2, opts.error), varintField(3, 2)]))] : []),
  ];
  return Buffer.concat(parts);
}

export function tracesData(spans: Buffer[]): Buffer {
  const scopeSpans = Buffer.concat(spans.map((s) => lenField(2, s)));
  const resourceSpans = lenField(2, scopeSpans);
  return lenField(1, resourceSpans);
}
