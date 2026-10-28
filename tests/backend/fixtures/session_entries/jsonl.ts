export interface JsonlTextSegment {
  text: string;
}

export interface JsonlFillSegment {
  fill_byte: number;
  count: number;
}

export interface GeneratedJsonl {
  segments: Array<JsonlTextSegment | JsonlFillSegment>;
}

export type JsonlFixture = string | GeneratedJsonl;

type EncodedSegment =
  | { kind: "text"; bytes: Uint8Array }
  | { kind: "fill"; fill_byte: number; count: number };

export function jsonlBytes(fixture: JsonlFixture): Uint8Array {
  const encoder = new TextEncoder();
  if (typeof fixture === "string") return encoder.encode(fixture);

  const segments: EncodedSegment[] = fixture.segments.map((segment) => {
    if ("text" in segment) {
      return { kind: "text", bytes: encoder.encode(segment.text) };
    }
    if (
      !Number.isInteger(segment.fill_byte) ||
      segment.fill_byte < 0 ||
      segment.fill_byte > 255 ||
      !Number.isSafeInteger(segment.count) ||
      segment.count < 0
    ) {
      throw new Error("invalid generated JSONL fill segment");
    }
    return { kind: "fill", fill_byte: segment.fill_byte, count: segment.count };
  });
  const length = segments.reduce(
    (total, segment) =>
      total + (segment.kind === "text" ? segment.bytes.length : segment.count),
    0,
  );
  const result = new Uint8Array(length);
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === "text") {
      result.set(segment.bytes, offset);
      offset += segment.bytes.length;
    } else {
      result.fill(segment.fill_byte, offset, offset + segment.count);
      offset += segment.count;
    }
  }
  return result;
}
