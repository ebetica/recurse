// Provider usage, text/image-estimated split; bounded reads, no text escapes.
// No-follow reads require regular single-link files, unchanged dev/ino/size/
// mtime/ctime; tail usage follows links. Exact BigInt largest-remainder splits
// prefer earlier keys on ties; JS normalizes integral floats.
import { constants } from "node:fs";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { open, type FileHandle } from "node:fs/promises";
import type { Config } from "../../config";
import { parsePythonJson, pyCompactJson } from "../../utils/py_compact_json";

export type JsonObject = Record<string, unknown>;
type Conv = Record<string, unknown>;
type Bytes = Buffer;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;

const TAIL_SCAN_BYTES = 64 * 1024;
const TAIL_SCAN_LINES = 400;
/** Largest tail window the usage estimate ever reads from one session. */
export const ESTIMATE_TAIL_BYTES = 4 << 20;
/** Bounded offset-zero read that validates an oversized session's header. */
const HEADER_PROBE_BYTES = 64 << 10;
const MAX_SAFE_INTEGER = 2 ** 53 - 1;
export const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_ENTRIES = 200_000;
const ESTIMATED_IMAGE_CHARS = 4_800;
const COUNT_KEYS = [
  "system",
  "prompts",
  "messages",
  "tool_calls",
  "tool_outputs",
] as const;
const NL = 0x0a;
const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export interface ContextUsageDeps {
  boundSessionFile(
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<string | null>;
  staticSystemPrompt(): string;
  readCapturedSystemPrompt(
    conv: Conv,
    currentTurn: boolean,
  ): Promise<string | null>;
  config: Pick<Config, "chatSettings" | "contextBarWindow" | "modelPolicy">;
}

const isDict = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** An errno-carrying filesystem error: Python's OSError. */
const isOsError = (error: unknown): boolean => {
  // Invariant: errno codes only: Node's ERR_* codes are programming errors.
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E(?!RR_)/u.test(code);
};
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/** Python truthiness over JSON values. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `==` over JSON values: bools are ints, containers compare deeply. */
export function pyEq(a: unknown, b: unknown): boolean {
  const num = (v: unknown) => (typeof v === "boolean" ? Number(v) : v);
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => pyEq(item, b[index]))
    );
  if (isDict(a) || isDict(b)) {
    if (!isDict(a) || !isDict(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && pyEq(a[key], b[key]))
    );
  }
  return num(a) === num(b);
}

/** Python `str()` of a JSON scalar, as an f-string renders it. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  // Invariant: Floats spell like Python repr; containers never equal a selector
  // string.
  return pyCompactJson(value);
}

/** Match JavaScript string.length (Python counts UTF-16 code units). */
const jsChars = (text: string): number => text.length;

/** `json.dumps(value, ensure_ascii=False, separators=(",", ":"))` length. */
function jsonCharsNoAscii(value: unknown): number {
  const ascii = pyCompactJson(value);
  let chars = 0;
  for (const match of ascii.matchAll(/\\(?:u([0-9a-f]{4})|.)|[^\\]+/gsu)) {
    const unit = match[1];
    chars +=
      unit !== undefined && parseInt(unit, 16) >= 0x7f ? 1 : match[0].length;
  }
  return chars;
}

export function promptTokens(usage: unknown): number | null {
  if (!isDict(usage)) return null;
  let total = 0;
  for (const key of ["input", "cacheRead", "cacheWrite"]) {
    const value = usage[key];
    if (!isInt(value) || value < 0 || value > MAX_SAFE_INTEGER) return null;
    total += value;
  }
  return total <= MAX_SAFE_INTEGER ? total : null;
}

export function usageSelector(usage: unknown): string | null {
  if (!isDict(usage) || usage.selectorPartial !== false) return null;
  const selectors = usage.selectors;
  if (
    !Array.isArray(selectors) ||
    selectors.length !== 1 ||
    typeof selectors[0] !== "string"
  )
    return null;
  return selectors[0];
}

const unusedCapacity = (used: number | null, capacity: number | null) =>
  capacity !== null && used !== null ? Math.max(0, capacity - used) : null;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** One guarded session line (with its newline), or null to fail the read. */
export function parseEntryLine(raw: Bytes): JsonObject | null {
  if (raw.length > MAX_SESSION_LINE_BYTES || raw.at(-1) !== NL) return null;
  let entry: unknown;
  try {
    entry = parsePythonJson(UTF8.decode(raw as unknown as Uint8Array));
  } catch {
    return null;
  }
  return isDict(entry) ? entry : null;
}

function checkSessionHeader(
  entry: JsonObject | null,
  sessionId: string,
  recordedCwd: string,
): boolean {
  return (
    entry !== null &&
    entry.type === "session" &&
    entry.id === sessionId &&
    entry.cwd === recordedCwd
  );
}

async function pread(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Bytes> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer as unknown as Uint8Array,
      total,
      length - total,
      position + total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function withNewline(line: Bytes): Bytes {
  const out = Buffer.alloc(line.length + 1);
  out.set(line);
  out[line.length] = NL;
  return out;
}

/** Split on newlines like `bytes.split(b"\n")`. */
function splitLines(chunk: Bytes): Bytes[] {
  const lines: Bytes[] = [];
  let start = 0;
  for (let index = 0; index < chunk.length; index += 1)
    if (chunk[index] === NL) {
      lines.push(chunk.subarray(start, index));
      start = index + 1;
    }
  lines.push(chunk.subarray(start));
  return lines;
}

async function readHeaderEntry(handle: FileHandle): Promise<JsonObject | null> {
  let probe: Bytes;
  try {
    probe = await pread(handle, HEADER_PROBE_BYTES, 0);
  } catch {
    return null;
  }
  const end = probe.indexOf(NL);
  if (end < 0) return null;
  return parseEntryLine(probe.subarray(0, end + 1));
}

async function readTailEntries(
  handle: FileHandle,
  size: number,
): Promise<JsonObject[] | null> {
  let chunk: Bytes;
  try {
    chunk = await pread(
      handle,
      ESTIMATE_TAIL_BYTES,
      size - ESTIMATE_TAIL_BYTES,
    );
  } catch {
    return null;
  }
  // Invariant: The first line started before the window; the last is empty on a
  // clean newline ending or a torn concurrent append otherwise. Drop both.
  const lines = splitLines(chunk).slice(1, -1);
  const entries: JsonObject[] = [];
  for (const line of lines) {
    if (entries.length >= MAX_SESSION_ENTRIES) return null;
    const entry = parseEntryLine(withNewline(line));
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

function identity(value: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
    ":",
  );
}

export class ContextUsage {
  constructor(private readonly deps: ContextUsageDeps) {}

  /** Bounded session read over a supervisor-supplied binding. */
  async loadSessionValues(
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<[JsonObject[], boolean] | null> {
    if (!sessionId) return null;
    const path = await this.deps.boundSessionFile(
      sessionId,
      recordedFile,
      recordedCwd,
    );
    if (path === null) return null;
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | CLOEXEC | constants.O_NOFOLLOW,
      );
    } catch {
      return null;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_SESSION_BYTES)
      )
        return null;
      const size = Number(before.size);
      if (size <= ESTIMATE_TAIL_BYTES) {
        // Invariant: Python iterates the stream, which reads to EOF, not to
        // st_size.
        const chunks: Bytes[] = [];
        let position = 0;
        for (;;) {
          const chunk = await pread(handle, 1 << 20, position);
          if (chunk.length === 0) break;
          chunks.push(chunk);
          position += chunk.length;
        }
        const data = Buffer.concat(chunks as unknown as Uint8Array[]);
        const entries: JsonObject[] = [];
        let start = 0;
        let index = 0;
        while (start < data.length) {
          const end = data.indexOf(NL, start);
          const stop = end < 0 ? data.length : end + 1;
          if (index >= MAX_SESSION_ENTRIES) return null;
          const entry = parseEntryLine(data.subarray(start, stop));
          if (entry === null) return null;
          entries.push(entry);
          start = stop;
          index += 1;
        }
        const after = await handle.stat({ bigint: true });
        if (identity(before) !== identity(after) || entries.length === 0)
          return null;
        const [header, ...branch] = entries;
        if (!checkSessionHeader(header!, sessionId, recordedCwd)) return null;
        return [branch, false];
      }
      if (identity(before) !== identity(await handle.stat({ bigint: true })))
        return null;
      if (
        !checkSessionHeader(
          await readHeaderEntry(handle),
          sessionId,
          recordedCwd,
        )
      )
        return null;
      const tail = await readTailEntries(handle, size);
      if (tail === null || tail.length === 0) return null;
      if (identity(before) !== identity(await handle.stat({ bigint: true })))
        return null;
      return [tail, true];
    } catch (error) {
      // Invariant: Python catches only OSError; any other error is a bug and
      // raises.
      if (isOsError(error)) return null;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async bindLatestContextPrompt(conv: Conv): Promise<void> {
    const meta = conv.system_prompt_capture;
    const active = conv.active_turn;
    const runId = isDict(active) ? active.run_id : undefined;
    const prompt = await this.deps.readCapturedSystemPrompt(conv, true);
    if (
      isDict(meta) &&
      meta.status === "captured" &&
      typeof runId === "string" &&
      meta.run_id === runId &&
      typeof meta.hash === "string"
    ) {
      const binding: JsonObject = {
        version: meta.version ?? null,
        run_id: runId,
        hash: meta.hash,
      };
      if (prompt !== null) binding.system_chars = jsChars(prompt);
      conv.latest_context_prompt_capture = binding;
    } else delete conv.latest_context_prompt_capture;
  }

  async estimatedSplit(
    usage: unknown,
    used: number | null,
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<Counts | null> {
    if (used === null) return null;
    const systemChars = jsChars(this.deps.staticSystemPrompt());
    const loaded = await this.loadSessionValues(
      sessionId,
      recordedFile,
      recordedCwd,
    );
    if (loaded === null) return null;
    const [branch, truncated] = loaded;
    const active = activeContextEntries(branch, truncated);
    const measured =
      active !== null ? usageContextEntries(active, usage) : null;
    if (measured === null) return null;
    const counts = estimateContextChars(measured, systemChars);
    return counts !== null ? scaleEstimate(counts, used) : null;
  }

  /** Last measured assistant usage from the session tail. */
  async deriveTailUsage(
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<JsonObject | null> {
    const path = await this.deps.boundSessionFile(
      sessionId,
      recordedFile,
      recordedCwd,
    );
    if (path === null) return null;
    let chunk: Bytes;
    try {
      const handle = await open(path, constants.O_RDONLY);
      try {
        const { size } = await handle.stat();
        chunk = await pread(
          handle,
          TAIL_SCAN_BYTES + 1,
          Math.max(0, size - TAIL_SCAN_BYTES),
        );
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    const lines = splitLines(chunk).slice(-TAIL_SCAN_LINES).reverse();
    for (const raw of lines) {
      const entry = parseEntryLine(withNewline(raw));
      if (entry === null) continue;
      if (entry.type === "compaction") return null;
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!isDict(message) || message.role !== "assistant") continue;
      const reported = message.usage;
      if (!isDict(reported) || promptTokens(reported) === null) continue;
      return { ...reported };
    }
    return null;
  }

  /** Full usage view over supervisor-supplied inputs; mutates `conv`. */
  async readContextUsageValues(
    conv: Conv,
    liveSample: JsonObject | null,
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<JsonObject> {
    projectLiveSample(conv, liveSample);
    const rawModel = conv.model ?? null;
    if (rawModel !== null && typeof rawModel !== "string")
      throw new Error(`unsupported chat model: ${pyStr(rawModel)}`);
    const { config } = this.deps;
    const [model] = config.chatSettings(rawModel);
    let usage = conv.latest_context_usage;
    let used = promptTokens(usage);
    const durable = conv.backend === "durable";
    if (used === null && !durable) {
      const tail = await this.deriveTailUsage(
        sessionId,
        recordedFile,
        recordedCwd,
      );
      if (tail !== null) {
        usage = tail;
        used = promptTokens(tail);
      }
    }
    const usageModel = usageSelector(usage);
    let capacity: number | null =
      usageModel === model ? config.contextBarWindow(model) : null;
    if (!isInt(capacity) || capacity <= 0 || capacity > MAX_SAFE_INTEGER)
      capacity = null;
    return {
      model,
      model_label: config.modelPolicy(model).label,
      used_tokens: used,
      usage_model: usageModel,
      context_window: capacity,
      unused_tokens: unusedCapacity(used, capacity),
      estimated_tokens: durable
        ? (liveSample?.estimated_tokens ?? null)
        : await this.estimatedSplit(
            usage,
            used,
            sessionId,
            recordedFile,
            recordedCwd,
          ),
    };
  }
}

/** Mirror Pi's branch walk and latest-compaction projection. */
export function activeContextEntries(
  entries: readonly JsonObject[],
  danglingRoot = false,
): JsonObject[] | null {
  if (entries.length === 0) return [];
  const byId = new Map<string, JsonObject>();
  for (const entry of entries) {
    const entryId = entry.id;
    const parentId = entry.parentId ?? null;
    if (
      typeof entryId !== "string" ||
      !entryId ||
      byId.has(entryId) ||
      (parentId !== null && typeof parentId !== "string")
    )
      return null;
    byId.set(entryId, entry);
  }
  const path: JsonObject[] = [];
  const seen = new Set<string>();
  let current: JsonObject | undefined = entries.at(-1);
  while (current !== undefined) {
    const entryId = current.id as string;
    if (seen.has(entryId)) return null;
    seen.add(entryId);
    path.push(current);
    const parentId = (current.parentId ?? null) as string | null;
    if (parentId === null) break;
    current = byId.get(parentId);
    if (current === undefined) {
      if (danglingRoot && path.at(-1) === entries[0]) break;
      return null;
    }
  }
  path.reverse();
  let compactionIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1)
    if (path[index]!.type === "compaction") {
      compactionIndex = index;
      break;
    }
  if (compactionIndex < 0) return path;
  const compaction = path[compactionIndex]!;
  const firstKept = compaction.firstKeptEntryId ?? null;
  const projected = [compaction];
  let keeping = false;
  for (const entry of path.slice(0, compactionIndex)) {
    if (pyEq(entry.id, firstKept)) keeping = true;
    if (keeping) projected.push(entry);
  }
  projected.push(...path.slice(compactionIndex + 1));
  return projected;
}

function contentChars(content: unknown): number | null {
  if (typeof content === "string") return jsChars(content);
  if (content === null || content === undefined) return 0;
  if (!Array.isArray(content)) return null;
  let chars = 0;
  for (const block of content) {
    if (!isDict(block)) return null;
    if (block.type === "text" && truthy(block.text)) {
      if (typeof block.text !== "string") return null;
      chars += jsChars(block.text);
    } else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Separate Recurse's per-turn injected prefix from the authored payload. */
function splitUserText(text: string): [number, number] {
  const contextStart = text.indexOf("## Runtime context");
  if (contextStart < 0) return [0, jsChars(text)];
  const marker = "\n\n## Message\n";
  const boundary = text.indexOf(marker, contextStart);
  if (boundary < 0) return [0, jsChars(text)];
  const system = boundary + marker.length - contextStart;
  return [system, jsChars(text) - system];
}

const getOr = (record: JsonObject, key: string, fallback: unknown) =>
  key in record ? record[key] : fallback;

export function estimateContextChars(
  entries: readonly JsonObject[],
  systemChars: number,
): Counts | null {
  const counts: Counts = {
    system: systemChars,
    prompts: 0,
    messages: 0,
    tool_calls: 0,
    tool_outputs: 0,
  };
  for (const entry of entries) {
    const kind = entry.type;
    if (kind === "message") {
      const message = entry.message;
      if (!isDict(message)) return null;
      const role = message.role;
      let content = message.content ?? null;
      if (role === "user") {
        if (typeof content === "string") {
          const [system, prompt] = splitUserText(content);
          counts.system += system;
          counts.prompts += prompt;
        } else {
          const chars = contentChars(content);
          if (chars === null) return null;
          counts.prompts += chars;
        }
      } else if (role === "assistant") {
        if (content === null) content = [];
        if (!Array.isArray(content)) return null;
        for (const block of content) {
          if (!isDict(block)) return null;
          const blockType = block.type;
          if (blockType === "text") {
            const text = getOr(block, "text", "");
            if (typeof text !== "string") return null;
            counts.messages += jsChars(text);
          } else if (blockType === "thinking") {
            const thinking = getOr(block, "thinking", "");
            if (typeof thinking !== "string") return null;
            counts.messages += jsChars(thinking);
          } else if (blockType === "toolCall") {
            const name = block.name;
            if (typeof name !== "string" || !("arguments" in block))
              return null;
            let argumentsChars: number;
            try {
              argumentsChars = jsonCharsNoAscii(block.arguments);
            } catch {
              return null;
            }
            counts.tool_calls += jsChars(name) + argumentsChars;
          }
        }
      } else if (role === "toolResult") {
        const chars = contentChars(content);
        if (chars === null) return null;
        counts.tool_outputs += chars;
      } else if (role === "custom") {
        const chars = contentChars(content);
        if (chars === null) return null;
        counts.system += chars;
      } else if (role === "bashExecution") {
        const { command, output } = message;
        if (typeof command !== "string" || typeof output !== "string")
          return null;
        counts.tool_calls += jsChars(command);
        counts.tool_outputs += jsChars(output);
      } else return null;
    } else if (kind === "custom_message") {
      const chars = contentChars(getOr(entry, "content", []));
      if (chars === null) return null;
      counts.system += chars;
    } else if (kind === "branch_summary" && truthy(entry.summary)) {
      if (typeof entry.summary !== "string") return null;
      counts.system += jsChars(entry.summary);
    } else if (kind === "compaction") {
      const summary = entry.summary;
      if (typeof summary !== "string") return null;
      counts.system += jsChars(summary);
    }
  }
  return counts;
}

/** Estimate the exact captured Pi request, including tool definitions. */
export function estimateRequestTokens(
  json: string,
  used: number,
): Counts | null {
  const request = JSON.parse(json) as { context?: JsonObject };
  const context = request.context;
  if (!isDict(context) || !Array.isArray(context.messages)) return null;
  const system = context.systemPrompt ?? "";
  if (typeof system !== "string") return null;
  const entries = context.messages.map((message: unknown) => ({
    type: "message",
    message:
      isDict(message) && message.role === "system"
        ? {
            ...message,
            role: "custom",
            content: getSystemMessageText(message as unknown as SystemMessage),
          }
        : message,
  }));
  const counts = estimateContextChars(entries, system.length);
  if (counts === null) return null;
  const tools = getCurrentTools(context.messages as Message[]);
  if (tools.length) counts.system += jsonCharsNoAscii(tools);
  if (Array.isArray(context.tools))
    counts.system += jsonCharsNoAscii(context.tools);
  return scaleEstimate(counts, used);
}

export function scaleEstimate(counts: Counts, used: number): Counts | null {
  const total = COUNT_KEYS.reduce((sum, key) => sum + BigInt(counts[key]), 0n);
  if (total <= 0n)
    return used === 0
      ? (Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Counts)
      : null;
  const scaled = {} as Counts;
  const remainders: [bigint, number, (typeof COUNT_KEYS)[number]][] = [];
  let assigned = 0;
  const big = BigInt(used);
  COUNT_KEYS.forEach((key, order) => {
    const product = big * BigInt(counts[key]);
    const value = Number(product / total);
    scaled[key] = value;
    assigned += value;
    remainders.push([product % total, order, key]);
  });
  remainders.sort((a, b) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1,
  );
  for (const [, , key] of remainders.slice(0, Math.max(0, used - assigned)))
    scaled[key] += 1;
  return scaled;
}

/** Only context preceding the uniquely measured assistant response. */
export function usageContextEntries(
  entries: readonly JsonObject[],
  usage: unknown,
): JsonObject[] | null {
  if (!isDict(usage)) return null;
  const selector = usageSelector(usage);
  if (selector === null) return null;
  const matches: number[] = [];
  entries.forEach((entry, index) => {
    const message = entry.type === "message" ? entry.message : undefined;
    if (!isDict(message)) return;
    const reported = message.usage;
    const id = `${pyStr(message.provider)}/${pyStr(message.model)}`;
    if (
      isDict(reported) &&
      message.role === "assistant" &&
      id === selector &&
      ["input", "output", "cacheRead", "cacheWrite"].every((key) =>
        pyEq(reported[key], usage[key]),
      )
    )
      matches.push(index);
  });
  return matches.length === 1 ? entries.slice(0, matches[0]) : null;
}

/** Apply one captured live sample: the single usage projection. */
export function projectLiveSample(
  conv: Conv,
  snapshot: JsonObject | null,
): void {
  if (snapshot !== null) {
    if (!("usage" in snapshot)) throw new Error("KeyError: 'usage'");
    conv.latest_context_usage = snapshot.usage;
    // Invariant: The prior settled prompt capture does not describe this live
    // report.
    delete conv.latest_context_prompt_capture;
  }
}
