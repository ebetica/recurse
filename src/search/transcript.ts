// Readable, bounded transcript bodies with SQLite cursor headers.
export const BODY_BYTES = 256 * 1024;
export const HEADER_BYTES = 1024;
export type TranscriptRole =
  | "user"
  | "assistant"
  | "agent"
  | "tool"
  | "tool-result";
export interface TranscriptHeader {
  seq: number;
  time: number;
  role: TranscriptRole | "checkpoint";
  entry: number;
  conversation: number;
  part: number;
  parts: number;
  bytes: number;
}
interface Segment {
  role: TranscriptHeader["role"];
  name?: string;
  time: number;
  text: string;
}
interface Block {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
interface Message {
  role?: string;
  timestamp?: number;
  toolName?: string;
  content?: string | Block[];
}
export interface TranscriptRow {
  id: number;
  conversation_id: number;
  commit_seq: number;
  record: string | null;
}

export function parseHeader(line: string): TranscriptHeader | undefined {
  const match =
    /^--- #(\d+) (\S+) (user|assistant|agent|tool result|tool|checkpoint)(?: [^\[\r\n]*)? \[entry=(\d+) conversation=(\d+) part=(\d+)\/(\d+) bytes=(\d+)\]$/.exec(
      line,
    );
  if (!match) return;
  const role =
    match[3] === "tool result"
      ? "tool-result"
      : (match[3] as TranscriptHeader["role"]);
  return {
    seq: Number(match[1]),
    time: match[2] === "-" ? 0 : Date.parse(match[2]!),
    role,
    entry: Number(match[4]),
    conversation: Number(match[5]),
    part: Number(match[6]),
    parts: Number(match[7]),
    bytes: Number(match[8]),
  };
}

function body(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "\\0")
    .replace(/^--- #/gm, " --- #");
  const size = Buffer.byteLength(normalized);
  if (size <= BODY_BYTES - 1) return normalized + "\n";
  const prefix = new TextEncoder().encode(normalized.slice(0, BODY_BYTES));
  const kept = new TextDecoder().decode(prefix.subarray(0, BODY_BYTES - 64), {
    stream: true,
  });
  return `${kept}\n[… ${size - Buffer.byteLength(kept)} bytes omitted]\n`;
}

function argumentsText(args: Record<string, unknown> | undefined): string {
  if (!args) return "{}";
  const key =
    typeof args.command === "string"
      ? "command"
      : typeof args.code === "string"
        ? "code"
        : undefined;
  if (!key) return JSON.stringify(args, null, 2);
  const { [key]: raw, ...rest } = args;
  return (
    String(raw) +
    (Object.keys(rest).length ? `\n${JSON.stringify(rest, null, 2)}` : "")
  );
}

function segments(row: TranscriptRow): Segment[] {
  const parts: Segment[] = [];
  const entry: { kind: string; model?: Message[] } = row.record
    ? JSON.parse(row.record)
    : { kind: "checkpoint" };
  const models = ["pi.user", "pi.assistant", "pi.tool-result"].includes(
    entry.kind,
  )
    ? entry.model
    : [];
  for (const message of Array.isArray(models) ? models : []) {
    const role = message.role === "toolResult" ? "tool-result" : message.role;
    if (role !== "user" && role !== "assistant" && role !== "tool-result")
      continue;
    const time =
      typeof message.timestamp === "number" &&
      Number.isFinite(message.timestamp)
        ? message.timestamp
        : 0;
    let text: string[] = [];
    const flush = () => {
      if (!text.length) return;
      const value = text.join("\n");
      const sender =
        role === "user"
          ? /^\[recurse-origin: agent\]\n\[recurse-from: ([A-Za-z0-9_@.:-]+)\]/m.exec(
              value,
            )?.[1]
          : undefined;
      parts.push({
        role: sender ? "agent" : role,
        name: sender ?? message.toolName,
        time,
        text: value,
      });
      text = [];
    };
    if (typeof message.content === "string") text.push(message.content);
    else
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block.type === "text" && typeof block.text === "string")
          text.push(block.text);
        else if (block.type === "toolCall") {
          flush();
          parts.push({
            role: "tool",
            name: block.name,
            time,
            text: argumentsText(block.arguments),
          });
        } else
          text.push(
            `[${block.type === "thinking" ? "thinking" : block.type === "image" ? "image" : "binary or non-text content"} omitted]`,
          );
      }
    flush();
  }
  return parts.length
    ? parts
    : [
        {
          role: "checkpoint",
          name: entry.kind,
          time: 0,
          text: `[${entry.kind} entry; no transcript text]`,
        },
      ];
}

export function formatEntry(row: TranscriptRow): string {
  const parts = segments(row);
  return parts
    .map((part, index) => {
      const text = body(part.text);
      const time =
        part.time > 0 && part.time < 8640000000000000
          ? new Date(part.time).toISOString()
          : "-";
      const role = part.role === "tool-result" ? "tool result" : part.role;
      const name = part.name
        ? ` ${part.name.replace(/[^A-Za-z0-9_@.:-]/g, "_").slice(0, 128)}`
        : "";
      return `--- #${row.commit_seq} ${time} ${role}${name} [entry=${row.id} conversation=${row.conversation_id} part=${index + 1}/${parts.length} bytes=${Buffer.byteLength(text)}]\n${text}`;
    })
    .join("");
}
