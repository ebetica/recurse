// Bounded redacted diagnostics with one sink writer per persisted path.
// Never render error messages, source text, full paths or locals.
// Native stacks reverse into Python traceback order; oversized records truncate
// to preserve rotating-file bounds.

import {
  appendFile,
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, parse } from "node:path";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUP_COUNT = 4;
export const LOGGER_NAME = "recurse";
export const DEBUG = 10;
export const INFO = 20;
export const WARNING = 30;
export const ERROR = 40;

const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:@/+,-]{1,200}$/;

export interface ExceptionFrame {
  readonly filename: string;
  readonly line: number;
  readonly name: string;
}

export interface ExceptionDiagnostic {
  readonly type_name: string;
  readonly message?: unknown;
  readonly frames?: readonly ExceptionFrame[];
  readonly cause?: ExceptionDiagnostic | null;
  readonly context?: ExceptionDiagnostic | null;
  readonly suppress_context?: boolean;
}

export interface RuntimeLogRecord {
  readonly timestamp: Date;
  readonly level: number;
  readonly name: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly message: string;
  readonly exception?: string;
}

export interface LogSink {
  write(record: RuntimeLogRecord): void;
}

/** Python-compatible safe scalar/container rendering for log fields. */
export function safeValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  if (Array.isArray(value) || value instanceof Set) {
    const rendered = [...value].map(safeValue).join(",");
    return rendered.length > 0 && rendered.length <= 200 ? rendered : "-";
  }
  const text = String(value);
  return SAFE_VALUE_RE.test(text) ? text : "<redacted>";
}

// Build a validated event line, preserving the Python field order and shape.
export function recordMessage(
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): string {
  if (!EVENT_RE.test(event)) throw new Error("invalid log event code");
  const parts = [`event=${event}`];
  for (const key of Object.keys(fields).sort()) {
    if (!FIELD_RE.test(key)) throw new Error("invalid log field name");
    parts.push(`${key}=${safeValue(fields[key])}`);
  }
  return parts.join(" ");
}

// Python exception type-name policy for serializable diagnostic descriptors.
export function typeName(error: unknown): string {
  let name = "unknown_exception";
  if (error instanceof Error) name = error.name || error.constructor.name;
  else if (isObject(error) && typeof error.type_name === "string") {
    name = error.type_name;
  }
  return SAFE_VALUE_RE.test(name) ? name : "unknown_exception";
}

// Render an exception chain without messages, source text, full paths or
// locals. The JSON descriptor form matches Python's recorded traceback input;
// native Error objects use their stack only to extract basename, line and
// function.
export function safeTraceback(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<object>();

  const appendOne = (current: unknown): void => {
    if (seen.size >= 8) {
      lines.push("<additional exception chain redacted>");
      return;
    }
    if (isObject(current) && seen.has(current)) {
      lines.push("<exception chain cycle redacted>");
      return;
    }
    if (isObject(current)) seen.add(current);

    const diagnostic = describeException(current);
    let prior: unknown = diagnostic.cause;
    let separator =
      "The above exception was the direct cause of the following:";
    if (prior === undefined || prior === null) {
      if (!diagnostic.suppress_context) {
        prior = diagnostic.context;
        separator = "During handling of the above exception, another occurred:";
      }
    }
    if (prior !== undefined && prior !== null) {
      appendOne(prior);
      lines.push("", separator, "");
    }

    lines.push("Traceback (runtime values redacted; most recent call last):");
    const frames = [...diagnostic.frames];
    if (frames.length > 80) {
      lines.push(`  ... ${frames.length - 80} older frames omitted`);
      frames.splice(0, frames.length - 80);
    }
    for (const frame of frames) {
      let filename = basename(frame.filename);
      if (!SAFE_VALUE_RE.test(filename)) filename = "<redacted-file>";
      const functionName =
        Array.from(frame.name.replace(/[^A-Za-z0-9_<>.-]+/g, "_"))
          .slice(0, 120)
          .join("") || "?";
      lines.push(
        `  File "${filename}", line ${frame.line}, in ${functionName}`,
      );
    }
    lines.push(`${diagnostic.typeName}: <message redacted>`);
  };

  appendOne(error);
  return lines.join("\n");
}

/** Namespace child configured with an explicit sink and optional clock. */
export class RuntimeLogger {
  constructor(
    readonly name: string,
    private readonly sink: LogSink,
    private readonly minimumLevel = INFO,
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(
    level: number,
    message: string,
    correlation: { conversation_id?: unknown; run_id?: unknown } = {},
    exception?: unknown,
  ): void {
    if (level < this.minimumLevel) return;
    const record: RuntimeLogRecord = {
      timestamp: this.now(),
      level,
      name: this.name,
      conversation_id: safeValue(correlation.conversation_id),
      run_id: safeValue(correlation.run_id),
      message,
      ...(exception === undefined
        ? {}
        : { exception: safeTraceback(exception) }),
    };
    this.sink.write(record);
  }

  info(message: string): void {
    this.log(INFO, message);
  }

  warning(message: string): void {
    this.log(WARNING, message);
  }

  error(message: string): void {
    this.log(ERROR, message);
  }
}

/** Return one child of the non-propagating Recurse namespace. */
export function logger(
  name: string,
  sink: LogSink,
  minimumLevel = INFO,
  now?: () => Date,
): RuntimeLogger {
  return new RuntimeLogger(`${LOGGER_NAME}.${name}`, sink, minimumLevel, now);
}

/** Emit one allow-listed metadata event; invalid events fail closed. */
export function logEvent(
  target: RuntimeLogger,
  level: number,
  event: string,
  options: {
    readonly conversation_id?: unknown;
    readonly run_id?: unknown;
    readonly fields?: Readonly<Record<string, unknown>>;
  } = {},
): void {
  let message: string;
  try {
    message = recordMessage(event, options.fields);
  } catch {
    message = "event=invalid_log_event";
  }
  target.log(level, message, options);
}

/** Emit a redacted traceback; exception messages are never persisted. */
export function logException(
  target: RuntimeLogger,
  event: string,
  error: unknown,
  options: {
    readonly conversation_id?: unknown;
    readonly run_id?: unknown;
    readonly level?: number;
    readonly fields?: Readonly<Record<string, unknown>>;
  } = {},
): void {
  const fields = { ...options.fields, error_type: typeName(error) };
  let message: string;
  try {
    message = recordMessage(event, fields);
  } catch {
    message = `event=invalid_log_event error_type=${safeValue(typeName(error))}`;
  }
  target.log(options.level ?? ERROR, message, options, error);
}

/** Render the Python formatter's UTC, correlation and exception layout. */
export function formatRecord(record: RuntimeLogRecord): string {
  const timestamp = record.timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
  const level = levelName(record.level);
  const head =
    `${timestamp} level=${level} logger=${record.name} ` +
    `conversation_id=${record.conversation_id} run_id=${record.run_id} ${record.message}`;
  return record.exception === undefined ? head : `${head}\n${record.exception}`;
}

/** Queue-backed rotating file sink; one instance serializes its own writes. */
export class RotatingFileSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly maxBytes: number,
    private readonly backupCount: number,
  ) {}

  static async open(
    path: string,
    options: { maxBytes?: number; backupCount?: number } = {},
  ): Promise<RotatingFileSink> {
    const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    const backupCount = options.backupCount ?? LOG_BACKUP_COUNT;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(backupCount) || backupCount < 0) {
      throw new Error("backupCount must be a non-negative safe integer");
    }
    const directory = dirname(path);
    if (directory === "." || directory === parse(path).root) {
      throw new Error("log file must be inside a private directory");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new RotatingFileSink(path, maxBytes, backupCount);
  }

  write(record: RuntimeLogRecord): void {
    if (this.closed) return;
    const bytes = `${formatRecord(record)}\n`;
    this.queue = this.queue.then(async () => {
      if (this.failure !== undefined) return;
      try {
        await this.append(bytes);
      } catch (error) {
        this.failure = error;
      }
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure !== undefined) throw this.failure;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private async append(text: string): Promise<void> {
    const boundedText = boundRecordText(text, this.maxBytes);
    const incomingBytes = Buffer.byteLength(boundedText, "utf8");
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.path)).size;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (currentBytes + incomingBytes >= this.maxBytes) {
      await this.rotate();
    }
    await appendFile(this.path, boundedText, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  private async rotate(): Promise<void> {
    for (let index = this.backupCount; index >= 1; index -= 1) {
      const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
      const destination = `${this.path}.${index}`;
      await removeIfPresent(destination);
      try {
        await rename(source, destination);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    if (this.backupCount === 0) await removeIfPresent(this.path);
  }
}

function boundRecordText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n<log record truncated>\n";
  const suffix = Buffer.byteLength(marker, "utf8") <= maxBytes ? marker : "\n";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    prefix += character;
    bytes += size;
  }
  return prefix + suffix;
}

function levelName(level: number): string {
  switch (level) {
    case 0:
      return "NOTSET";
    case 10:
      return "DEBUG";
    case INFO:
      return "INFO";
    case WARNING:
      return "WARNING";
    case ERROR:
      return "ERROR";
    case 50:
      return "CRITICAL";
    default:
      return `Level ${level}`;
  }
}

function describeException(error: unknown): {
  typeName: string;
  frames: readonly ExceptionFrame[];
  cause?: unknown;
  context?: unknown;
  suppress_context?: boolean;
} {
  if (error instanceof Error) {
    return {
      typeName: typeName(error),
      frames: errorFrames(error),
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    };
  }
  if (!isObject(error)) {
    return { typeName: "unknown_exception", frames: [] };
  }
  const rawFrames = error.frames;
  const frames = Array.isArray(rawFrames)
    ? rawFrames.filter(isFrame).map((frame) => ({
        filename: frame.filename,
        line: frame.line,
        name: frame.name,
      }))
    : [];
  return {
    typeName: typeName(error),
    frames,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    ...(error.context === undefined ? {} : { context: error.context }),
    ...(error.suppress_context === undefined
      ? {}
      : { suppress_context: Boolean(error.suppress_context) }),
  };
}

function errorFrames(error: Error): ExceptionFrame[] {
  const stack = error.stack?.split("\n").slice(1) ?? [];
  const frames: ExceptionFrame[] = [];
  for (const line of stack) {
    const match = /^\s*at (?:(.*?) \()?(.+):(\d+):(\d+)\)?$/.exec(line);
    if (match === null) continue;
    frames.push({
      filename: match[2]!,
      line: Number(match[3]),
      name: match[1] || "?",
    });
  }
  // Invariant: V8 reports the throwing frame first; Python traceback extraction
  // starts with the caller, so reverse to preserve the recorded formatter
  // order.
  return frames.reverse();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFrame(value: unknown): value is ExceptionFrame {
  return (
    isObject(value) &&
    typeof value.filename === "string" &&
    typeof value.line === "number" &&
    typeof value.name === "string"
  );
}

function isMissingFile(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
