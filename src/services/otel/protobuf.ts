/**
 * Minimal decoder for OTLP/protobuf `TracesData` (opentelemetry-proto v1, the
 * field numbers frozen since the 1.0 release). It decodes only the fields the
 * GenAI mapping needs and emits the exact OTLP/JSON-equivalent object shape that
 * {@link mapOtlpTraces} already consumes — so the protobuf and JSON paths share
 * one mapping. Unknown fields are skipped by wire type, per protobuf's own
 * forward-compatibility rules.
 */

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  private varint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: t >>> 3, wire: t & 7 };
  }
  bytes(): Buffer {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error('truncated length-delimited field');
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  string(): string {
    return this.bytes().toString('utf-8');
  }
  fixed64Str(): string {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v.toString();
  }
  double(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  varintNum(): number {
    return this.varint();
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

function eachField(buf: Buffer, fn: (field: number, wire: number, r: Reader) => boolean): void {
  const r = new Reader(buf);
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (!fn(field, wire, r)) r.skip(wire);
  }
}

// AnyValue: string=1, bool=2, int=3, double=4, array=5, kvlist=6, bytes=7
function decodeAnyValue(buf: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  eachField(buf, (field, wire, r) => {
    switch (field) {
      case 1: out.stringValue = r.string(); return true;
      case 2: out.boolValue = r.varintNum() !== 0; return true;
      case 3: out.intValue = String(r.varintNum()); return true;
      case 4: out.doubleValue = r.double(); return true;
      case 5: out.arrayValue = { values: decodeValues(r.bytes()) }; return true;
      case 6: out.kvlistValue = { values: decodeKeyValues(r.bytes()) }; return true;
      case 7: out.bytesValue = r.bytes().toString('base64'); return true;
      default: return false;
    }
  });
  return out;
}

// ArrayValue.values = 1 (repeated AnyValue)
function decodeValues(buf: Buffer): unknown[] {
  const vals: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 1) { vals.push(decodeAnyValue(r.bytes())); return true; }
    return false;
  });
  return vals;
}

// KeyValue: key=1, value=2
function decodeKeyValue(buf: Buffer): { key: string; value: unknown } {
  let key = '';
  let value: unknown = {};
  eachField(buf, (field, wire, r) => {
    if (field === 1) { key = r.string(); return true; }
    if (field === 2) { value = decodeAnyValue(r.bytes()); return true; }
    return false;
  });
  return { key, value };
}
function decodeKeyValues(buf: Buffer): unknown[] {
  const kvs: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 1) { kvs.push(decodeKeyValue(r.bytes())); return true; }
    return false;
  });
  return kvs;
}

// Span: trace_id=1, span_id=2, parent_span_id=4, name=5, start=7 (fixed64),
// end=8 (fixed64), attributes=9, status=15
function decodeSpan(buf: Buffer): Record<string, unknown> {
  const span: Record<string, unknown> = {};
  const attributes: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    switch (field) {
      case 1: span.traceId = r.bytes().toString('hex'); return true;
      case 2: span.spanId = r.bytes().toString('hex'); return true;
      case 4: span.parentSpanId = r.bytes().toString('hex'); return true;
      case 5: span.name = r.string(); return true;
      case 7: span.startTimeUnixNano = r.fixed64Str(); return true;
      case 8: span.endTimeUnixNano = r.fixed64Str(); return true;
      case 9: attributes.push(decodeKeyValue(r.bytes())); return true;
      case 15: span.status = decodeStatus(r.bytes()); return true;
      default: return false;
    }
  });
  span.attributes = attributes;
  return span;
}

// Status: message=2, code=3
function decodeStatus(buf: Buffer): Record<string, unknown> {
  const status: Record<string, unknown> = {};
  eachField(buf, (field, wire, r) => {
    if (field === 2) { status.message = r.string(); return true; }
    if (field === 3) { status.code = r.varintNum(); return true; }
    return false;
  });
  return status;
}

// Resource: attributes=1
function decodeResource(buf: Buffer): Record<string, unknown> {
  const attributes: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 1) { attributes.push(decodeKeyValue(r.bytes())); return true; }
    return false;
  });
  return { attributes };
}

// ScopeSpans: spans=2
function decodeScopeSpans(buf: Buffer): Record<string, unknown> {
  const spans: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 2) { spans.push(decodeSpan(r.bytes())); return true; }
    return false;
  });
  return { spans };
}

// ResourceSpans: resource=1, scope_spans=2
function decodeResourceSpans(buf: Buffer): Record<string, unknown> {
  let resource: Record<string, unknown> = { attributes: [] };
  const scopeSpans: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 1) { resource = decodeResource(r.bytes()); return true; }
    if (field === 2) { scopeSpans.push(decodeScopeSpans(r.bytes())); return true; }
    return false;
  });
  return { resource, scopeSpans };
}

/** Decode an OTLP/protobuf TracesData message (resource_spans = 1). */
export function decodeTracesData(buf: Buffer): Record<string, unknown> {
  const resourceSpans: unknown[] = [];
  eachField(buf, (field, wire, r) => {
    if (field === 1) { resourceSpans.push(decodeResourceSpans(r.bytes())); return true; }
    return false;
  });
  return { resourceSpans };
}
