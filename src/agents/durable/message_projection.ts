// Transcript rendering shared by the subagent CLI and API.
import { slowSpan } from "../../observability/slow_span";

type JsonObject = Record<string, unknown>;

const MSG_TEXT_CHARS = 1000;
const MSG_LINE_CHARS = 500;
const MSG_ARGS_CHARS = 200;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyTruthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === ""
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

const JSON_NUMBER_LEXEMES = new WeakMap<object, Map<string, string>>();

function numberLexeme(
  parent: object | undefined,
  key: string | undefined,
): string | undefined {
  if (!parent || key === undefined) return undefined;
  return JSON_NUMBER_LEXEMES.get(parent)?.get(key);
}

function pythonFloatText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    const [mantissa, exponentText] = value.toExponential().split("e");
    const exponent = Number(exponentText);
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const rendered = String(value);
  return rendered.includes(".") ? rendered : `${rendered}.0`;
}

function pythonNumberText(
  value: number,
  parent?: object,
  key?: string,
): string {
  const source = numberLexeme(parent, key);
  if (source !== undefined && !/[.eE]/.test(source))
    return source === "-0" ? "0" : source;
  if (
    source !== undefined ||
    !Number.isInteger(value) ||
    Object.is(value, -0)
  ) {
    return pythonFloatText(value);
  }
  return String(value);
}

function pythonStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let rendered = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (char === "\\") rendered += "\\\\";
    else if (char === quote) rendered += `\\${char}`;
    else if (char === "\n") rendered += "\\n";
    else if (char === "\r") rendered += "\\r";
    else if (char === "\t") rendered += "\\t";
    else if (codePoint < 0x20 || codePoint === 0x7f)
      rendered += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else rendered += char;
  }
  return `${quote}${rendered}${quote}`;
}

function pythonStr(value: unknown, parent?: object, key?: string): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pythonNumberText(value, parent, key);
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return `[${value.map((item, index) => pythonRepr(item, value, String(index))).join(", ")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .map(
        (name) =>
          `${pythonStringRepr(name)}: ${pythonRepr(value[name], value, name)}`,
      )
      .join(", ")}}`;
  }
  return String(value);
}

function pythonRepr(value: unknown, parent?: object, key?: string): string {
  if (typeof value === "string") return pythonStringRepr(value);
  return pythonStr(value, parent, key);
}

const PYTHON_SPACE =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
function pythonStrip(value: string): string {
  const points = Array.from(value);
  let first = 0;
  let last = points.length;
  while (first < last && PYTHON_SPACE.test(points[first]!)) first++;
  while (last > first && PYTHON_SPACE.test(points[last - 1]!)) last--;
  return points.slice(first, last).join("");
}

function codePointSlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

function jsonLine(value: unknown): string {
  return `${slowSpan("transcript_json_encode", undefined, () => JSON.stringify(value))}\n`;
}

function jsonParse(text: string): unknown {
  return slowSpan("transcript_json_decode", undefined, () =>
    JSON.parse(
      text,
      function (
        this: object,
        key: string,
        value: unknown,
        context?: { source?: string },
      ): unknown {
        if (typeof value === "number" && context?.source !== undefined) {
          let fields = JSON_NUMBER_LEXEMES.get(this);
          if (!fields) {
            fields = new Map();
            JSON_NUMBER_LEXEMES.set(this, fields);
          }
          fields.set(key, context.source);
        }
        return value;
      },
    ),
  );
}

function clip(text: string, limit: number): [string, boolean] {
  const points = Array.from(text);
  return points.length <= limit
    ? [text, false]
    : [points.slice(0, limit).join(""), true];
}

function oneLine(value: string, limit: number): string {
  return codePointSlice(pythonStrip(value.split("\n", 1)[0]!), limit);
}

function textBlocks(content: unknown): string[] | null {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) return null;
    if (block.type === "text") {
      const text = block.text ?? "";
      if (typeof text !== "string") return null;
      parts.push(text);
    }
  }
  return parts;
}

function toolCalls(content: unknown): JsonObject[] | null {
  if (content === null || content === undefined || !Array.isArray(content))
    return [];
  const calls: JsonObject[] = [];
  for (const block of content) {
    if (!isObject(block)) return null;
    if (block.type === "toolCall") calls.push(block);
  }
  return calls;
}

function comparePythonStrings(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function pythonJsonDumps(
  value: unknown,
  parent?: object,
  key?: string,
): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return pythonNumberText(value, parent, key);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => pythonJsonDumps(item, value, String(index)))
      .join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(comparePythonStrings)
      .map(
        (name) =>
          `${JSON.stringify(name)}:${pythonJsonDumps(value[name], value, name)}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("value is not JSON serializable");
}

function shortValue(
  value: unknown,
  limit = 60,
  parent?: object,
  key?: string,
): string {
  if (typeof value === "string") return oneLine(value, limit);
  let rendered: string;
  try {
    rendered = pythonJsonDumps(value, parent, key);
  } catch {
    rendered = pythonStr(value, parent, key);
  }
  return oneLine(rendered, limit);
}

function summarizeArgs(
  argumentsValue: unknown,
  parent?: object,
  key?: string,
): string {
  if (argumentsValue === null || argumentsValue === undefined) return "";
  if (typeof argumentsValue === "string") {
    const stripped = pythonStrip(argumentsValue);
    if (stripped.startsWith("{")) {
      try {
        const parsed: unknown = jsonParse(stripped);
        if (isObject(parsed)) return summarizeArgs(parsed);
      } catch {}
    }
    return oneLine(stripped, MSG_ARGS_CHARS);
  }
  if (isObject(argumentsValue)) {
    const command = argumentsValue.command;
    if (typeof command === "string" && pythonStrip(command))
      return oneLine(command, MSG_ARGS_CHARS);
    const pairs = Object.keys(argumentsValue)
      .slice(0, 6)
      .map(
        (name) =>
          `${name}=${shortValue(argumentsValue[name], 60, argumentsValue, name)}`,
      );
    return oneLine(pairs.join(", "), MSG_ARGS_CHARS);
  }
  return oneLine(pythonStr(argumentsValue, parent, key), MSG_ARGS_CHARS);
}

function entryTimestamp(entry: JsonObject): unknown {
  const ts = entry.timestamp;
  if (typeof ts === "string") return Array.from(ts).length <= 128 ? ts : null;
  if (typeof ts === "boolean" || typeof ts !== "number" || !Number.isFinite(ts))
    return null;
  return Math.abs(ts) <= 10 ** 15 ? ts : null;
}

function assistantCallBlocks(entry: JsonObject): JsonObject[] {
  if (
    entry.type !== "message" ||
    !isObject(entry.message) ||
    entry.message.role !== "assistant"
  )
    return [];
  const calls = toolCalls(entry.message.content);
  return calls ?? [];
}

type Row = [number, JsonObject];
function resultName(
  message: JsonObject,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  idx: number,
): string {
  const callId = message.toolCallId;
  if (typeof callId === "string" && callNames.has(callId))
    return callNames.get(callId)!;
  let name = "unknown";
  for (const [callIdx, callName] of callOrder) {
    if (callIdx < idx) name = callName;
    else break;
  }
  return name;
}

function renderUser(
  message: JsonObject,
  off: number,
  ts: unknown,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  if (texts === null) return [];
  const [text, cut] = clip(texts.join(""), full ? Infinity : MSG_TEXT_CHARS);
  const line: JsonObject = { off, ts, role: "user", text };
  if (cut) line.truncated = true;
  return [line];
}

function renderAssistant(
  message: JsonObject,
  off: number,
  ts: unknown,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  const calls = toolCalls(message.content);
  if (texts === null || calls === null) return [];
  const out: JsonObject[] = [];
  const [text, cut] = clip(texts.join(""), full ? Infinity : MSG_TEXT_CHARS);
  if (text) {
    const line: JsonObject = { off, ts, role: "assistant", text };
    if (cut) line.truncated = true;
    out.push(line);
  }
  for (const call of calls) {
    const name = call.name;
    out.push({
      off,
      ts,
      role: "tool",
      tool: typeof name === "string" && name ? name : "unknown",
      args: full
        ? pythonJsonDumps(call.arguments ?? null, call, "arguments")
        : summarizeArgs(call.arguments, call, "arguments"),
    });
  }
  return out;
}

function renderResult(
  message: JsonObject,
  off: number,
  ts: unknown,
  idx: number,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  if (texts === null) return [];
  return [
    {
      off,
      ts,
      role: "tool",
      tool: resultName(message, callNames, callOrder, idx),
      text: full ? texts.join("") : oneLine(texts.join(""), MSG_LINE_CHARS),
    },
  ];
}

function renderEntry(
  entry: JsonObject,
  off: number,
  idx: number,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  results: boolean,
  full = false,
): JsonObject[] {
  const ts = entryTimestamp(entry);
  if (!isObject(entry.message)) return [];
  const message = entry.message;
  if (message.role === "user") return renderUser(message, off, ts, full);
  if (message.role === "assistant")
    return renderAssistant(message, off, ts, full);
  if (message.role === "toolResult" && results)
    return renderResult(message, off, ts, idx, callNames, callOrder, full);
  return [];
}

function renderWindow(rows: Row[], results = true, full = false): JsonObject[] {
  const callNames = new Map<string, string>();
  const callOrder: Array<[number, string]> = [];
  rows.forEach(([, entry], idx) => {
    for (const call of assistantCallBlocks(entry)) {
      if (typeof call.name !== "string" || !call.name) continue;
      callOrder.push([idx, call.name]);
      if (typeof call.id === "string" && call.id && !callNames.has(call.id))
        callNames.set(call.id, call.name);
    }
  });
  const out: JsonObject[] = [];
  rows.forEach(([off, entry], idx) =>
    out.push(
      ...renderEntry(entry, off, idx, callNames, callOrder, results, full),
    ),
  );
  return out;
}

/** Project one bounded transcript page to v1 messages. */
export function projectV1Messages(
  entries: Row[],
  isFull: boolean,
): JsonObject[] {
  const source = new Map(entries);
  const calls = new Map<string, string>();
  for (const [, entry] of entries) {
    const message = entry.message;
    if (
      !isObject(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      continue;
    for (const call of message.content)
      if (
        isObject(call) &&
        call.type === "toolCall" &&
        typeof call.id === "string" &&
        typeof call.name === "string"
      )
        calls.set(call.id, call.name);
  }
  const callIndexes = new Map<number, number>();
  return renderWindow(entries, true, isFull).map((row) => {
    const entry = source.get(Number(row.off));
    const message = isObject(entry?.message) ? entry.message : {};
    const toolResult = row.role === "tool" && !("args" in row);
    let tool = row.tool;
    let truncated = row.truncated === true;
    if (toolResult) {
      tool =
        typeof message.toolName === "string" && message.toolName
          ? message.toolName
          : typeof message.toolCallId === "string"
            ? (calls.get(message.toolCallId) ?? "unknown")
            : "unknown";
      const text = textBlocks(message.content);
      if (!isFull && text !== null && text.join("") !== row.text)
        truncated = true;
    } else if (
      row.role === "tool" &&
      !isFull &&
      Array.isArray(message.content)
    ) {
      const toolCalls = message.content.filter(
        (item) => isObject(item) && item.type === "toolCall",
      );
      const cursor = Number(row.off);
      const index = callIndexes.get(cursor) ?? 0;
      callIndexes.set(cursor, index + 1);
      const call = toolCalls[index];
      const args = isObject(call) ? call.arguments : null;
      if (
        args !== null &&
        args !== undefined &&
        (typeof args !== "string" || args !== row.args)
      )
        truncated = true;
    }
    const ts =
      typeof row.ts === "string"
        ? Date.parse(row.ts) / 1000
        : typeof row.ts === "number"
          ? Math.abs(row.ts) >= 1e11
            ? row.ts / 1000
            : row.ts
          : NaN;
    return {
      cursor: row.off,
      at: Number.isFinite(ts) ? ts : null,
      kind:
        row.role === "tool"
          ? "args" in row
            ? "tool_call"
            : "tool_result"
          : row.role,
      ...(typeof row.text === "string" ? { text: row.text } : {}),
      ...(typeof tool === "string" ? { tool } : {}),
      ...(typeof row.args === "string" ? { args: row.args } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  });
}

export {
  codePointSlice,
  isObject,
  jsonLine,
  jsonParse,
  oneLine,
  pyTruthy,
  pythonStrip,
  renderWindow,
  summarizeArgs,
  textBlocks,
};
export type { JsonObject, Row };
