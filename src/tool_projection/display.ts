// Allowlisted tool summaries, owner row detail and bounded turn counters.
// Retain no payload: only counts/enums/redacted text/fixed digests.
// Integral JSON floats pass positiveInt because JS loses their original type.

import { createHash } from "node:crypto";
import {
  bashCommandDetail,
  bashDetail,
  oneLine,
  safeTarget,
  shellSplit,
  truncateToolDetail,
  SAFE_FILE_TOOLS,
  TOOL_COMMAND_MAX,
  type JsonObject,
} from "./redaction";
import { bashReadTarget } from "./shaping";

export type { JsonObject } from "./redaction";
export type ToolStat = Record<string, number | string>;

const TOOL_STAT_KINDS: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  bash: "shell",
  shell: "shell",
  grep: "search",
  find: "search",
  multi_grep: "search",
  ls: "search",
  glob: "search",
  web_search: "web",
  web_fetch: "web",
  publish_attachment: "other",
};
const SHELL_ACTIONS: Record<string, Record<string, string>> = {
  "subagent.ts": {
    create: "subagent_create",
    send: "subagent_send",
    rm: "subagent_rm",
  },
  "worktree.ts": { enter: "worktree_enter" },
  pr: { create: "pr_create", merge: "pr_merge" },
};
const PR_URL_RE =
  /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\p{Nd}{1,9})/gu;
const SUMMARY_PRS_MAX = 4;
const SUMMARY_PATHS_MAX = 512;
const RESULT_SCAN_MAX = 1 << 20;
const CONTINUATION_RE = new RegExp(
  String.raw`^\[(?:\p{Nd}+ more lines in file|Showing lines \p{Nd}+[-]\p{Nd}+ of \p{Nd}+).*Use offset=\p{Nd}+ to continue\.\]$`,
  "u",
);
const PYTHON_DECIMAL_ZEROES = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0,
  0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50,
  0x11d50, 0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1e140, 0x1e2f0, 0x1e4f0,
  0x1e950, 0x1fbf0,
];

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function pythonString(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([k, v]) => `${pythonRepr(k)}: ${pythonRepr(v)}`)
      .join(", ")}}`;
  return String(value);
}

function pythonRepr(value: unknown): string {
  if (typeof value !== "string") return pythonString(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `${quote}${escaped}${quote}`;
}

// Collapse tool names in call order into a first-use-ordered name/count map.
export function toolNameCounts(
  names: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const name of names) {
    const hasName = Object.hasOwn(counts, name);
    const next = (hasName ? counts[name]! : 0) + 1;
    if (!hasName) order.push(name);
    Object.defineProperty(counts, name, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  // Invariant: Ordinary JS objects enumerate integer-looking keys numerically;
  // the Python dict contract is first-use order even for such names, so
  // preserve it here.
  return new Proxy(counts, { ownKeys: () => order });
}

function toolInputObject(raw: unknown): JsonObject | null {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(data) ? data : null;
}

/** Safe one-line detail allowed on every agent surface. */
export function summarizeToolInput(
  raw: unknown,
  toolName: string | null = null,
): string | null {
  const data = toolInputObject(raw);
  if (data === null) return null;
  const name = (toolName ?? "").toLowerCase();
  if (name === "bash" || name === "shell") {
    const target = bashReadTarget(data["command"]);
    if (target !== null) {
      const safe = safeTarget(target);
      if (safe) return safe;
    }
    return bashDetail(data["command"]);
  }
  if (SAFE_FILE_TOOLS.has(name)) {
    for (const key of ["file_path", "path"]) {
      const target = safeTarget(data[key]);
      if (target) return target;
    }
  }
  if (name === "chdir") return safeTarget(data["directory"]);
  // Invariant: Search patterns, prompts/descriptions, URLs, replacement text,
  // and unknown custom arguments may contain private user data. Name-only is
  // still useful.
  return null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 1 << 40
    ? value
    : null;
}

function searchDetail(data: JsonObject): string | null {
  const patterns: string[] = [];
  const raw = data["patterns"];
  let patternValue: unknown;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const pattern = oneLine(pythonString(item));
      if (pattern) patterns.push(pattern);
    }
  } else patternValue = data["pattern"];
  if (typeof patternValue === "string") {
    const pattern = oneLine(patternValue);
    if (pattern) patterns.push(pattern);
  }
  if (!patterns.length) return null;
  let detail = patterns.join(" | ");
  const path = pythonTruthy(data["path"]) ? data["path"] : data["constraints"];
  if (typeof path === "string" && path)
    detail = `${detail} in ${oneLine(path)}`;
  const limit = positiveInt(data["limit"]);
  if (limit !== null) detail = `${detail} limit ${limit}`;
  return truncateToolDetail(detail);
}

/** Return the cross-surface summary and owner-scoped row detail. */
export function toolCallDetails(
  raw: unknown,
  toolName: string | null = null,
): [string | null, string | null] {
  const summary = summarizeToolInput(raw, toolName);
  let detail: string | null = null;
  const name = (toolName ?? "").toLowerCase();
  const data = toolInputObject(raw);
  if (name === "bash" || name === "shell")
    detail = data ? bashCommandDetail(data["command"]) : null;
  else if (["grep", "multi_grep", "find"].includes(name) && data !== null)
    detail = searchDetail(data);
  return [summary, detail && detail !== summary ? detail : null];
}

function resultText(result: unknown): string {
  let text = "";
  if (typeof result === "string") text = result;
  else if (isRecord(result)) {
    let found = false;
    for (const key of ["output", "text", "stdout"]) {
      const value = result[key];
      if (typeof value === "string") {
        text = value;
        found = true;
        break;
      }
    }
    if (!found && Array.isArray(result["content"])) {
      text = result["content"]
        .filter(isRecord)
        .map((block) =>
          typeof block["text"] === "string" ? (block["text"] as string) : "",
        )
        .join("");
    }
  }

  if (text.length <= RESULT_SCAN_MAX) return text;
  let count = 0;
  let end = 0;
  for (const point of text) {
    if (count++ === RESULT_SCAN_MAX) return text.slice(0, end);
    end += point.length;
  }
  return text;
}

function lineCount(text: unknown): number {
  if (typeof text !== "string" || !text) return 0;
  const newlines = text.split("\n").length - 1;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

function readLines(result: unknown): number {
  if (isRecord(result) && pythonTruthy(result["isError"])) return 0;
  const content = isRecord(result) ? result["content"] : result;
  if (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block["type"] === "image")
  )
    return 0;
  const text = resultText(typeof content === "string" ? content : result);
  const splitAt = text.lastIndexOf("\n\n");
  if (splitAt >= 0 && CONTINUATION_RE.test(text.slice(splitAt + 2)))
    return text.slice(0, splitAt).split("\n").length;
  return lineCount(text);
}

function firstString(data: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys)
    if (typeof data[key] === "string") return data[key] as string;
  return null;
}

function editBlocks(data: JsonObject): Array<[string, string]> {
  const edits = data["edits"];
  const candidates: unknown[] = Array.isArray(edits) ? [...edits] : [];
  candidates.push(data);
  const blocks: Array<[string, string]> = [];
  for (const block of candidates) {
    if (!isRecord(block)) continue;
    const old = firstString(block, ["oldText", "old_string", "old"]);
    const next = firstString(block, ["newText", "new_string", "new"]);
    if (old !== null || next !== null) blocks.push([old ?? "", next ?? ""]);
  }
  return blocks;
}

function shellActionLabel(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const tokens = shellSplit(oneLine(command));
  if (tokens === null) return null;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const name = tokens[index]!.replace(/\\/gu, "/").split("/").at(-1)!;
    const action = SHELL_ACTIONS[name]?.[tokens[index + 1]!];
    if (action) return action;
  }
  return null;
}

function backgroundedAction(result: unknown): string | null {
  const firstLine = resultText(result).split("\n", 1)[0]!;
  if (firstLine.includes("— backgrounded as shell")) return "backgrounded";
  if (
    firstLine.includes("Started shell") &&
    firstLine.includes("in the background")
  )
    return "backgrounded";
  return null;
}

/** Closed enum labels and integer counts describing one finished call. */
export function toolStat(
  name: string | null,
  raw: unknown,
  result: unknown,
): ToolStat {
  const kind = TOOL_STAT_KINDS[(name ?? "").toLowerCase()] ?? "other";
  const data = toolInputObject(raw) ?? {};
  if (kind === "read") {
    const lines = readLines(result);
    const from = positiveInt(data["offset"]) ?? 1;
    return { kind: "read", lines, from, to: from + Math.max(lines - 1, 0) };
  }
  if (kind === "edit") {
    let added = 0;
    let removed = 0;
    for (const [old, next] of editBlocks(data)) {
      removed += lineCount(old);
      added += lineCount(next);
    }
    return { kind: "edit", added, removed };
  }
  if (kind === "write")
    return { kind: "write", added: lineCount(data["content"]) };
  if (kind === "shell") {
    if (backgroundedAction(result))
      return { kind: "shell", action: "backgrounded" };
    const target = bashReadTarget(data["command"]);
    if (target !== null && safeTarget(target) !== null) {
      const lines = readLines(result);
      return { kind: "read", lines, from: 1, to: 1 + Math.max(lines - 1, 0) };
    }
    const stat: ToolStat = { kind: "shell" };
    const action = shellActionLabel(data["command"]);
    if (action) stat["action"] = action;
    return stat;
  }
  return { kind };
}

function decimalDigit(char: string): number | null {
  const code = char.codePointAt(0)!;
  for (const zero of PYTHON_DECIMAL_ZEROES)
    if (code >= zero && code < zero + 10) return code - zero;

  for (const zero of [0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6])
    if (code >= zero && code < zero + 10) return code - zero;
  return null;
}

function decimalNumber(text: string): number {
  let value = 0;
  for (const char of text) {
    const digit = decimalDigit(char);
    if (digit === null) return Number.NaN;
    value = value * 10 + digit;
  }
  return value;
}

/** Incremental, payload-free summary for one assistant segment or turn. */
export class TurnStats {
  tools = 0;
  shell = 0;
  added = 0;
  removed = 0;
  agents = 0;
  agentMessages = 0;
  agentReaps = 0;
  searches = 0;
  web = 0;
  prs: number[] = [];
  prLinks: Array<{ number: number; url: string }> = [];
  truncated = false;
  private readonly files: Record<"read" | "edit" | "write", Set<string>> = {
    read: new Set(),
    edit: new Set(),
    write: new Set(),
  };

  private countFile(kind: "read" | "edit" | "write", data: JsonObject): void {
    let path: string | null = null;
    for (const key of ["path", "file_path"]) {
      if (typeof data[key] === "string") {
        path = data[key] as string;
        break;
      }
    }
    if (!path) {
      this.truncated = true;
      return;
    }
    const seen = this.files[kind];
    const digest = createHash("sha256")
      .update(path, "utf8")
      .digest("hex")
      .slice(0, 16);
    if (seen.has(digest)) return;
    if (seen.size >= SUMMARY_PATHS_MAX) {
      this.truncated = true;
      return;
    }
    seen.add(digest);
  }

  private countBashRead(data: JsonObject): void {
    const target = bashReadTarget(data["command"]);
    if (!target) {
      this.truncated = true;
      return;
    }
    const seen = this.files.read;
    const digest = createHash("sha256")
      .update(target, "utf8")
      .digest("hex")
      .slice(0, 16);
    if (seen.has(digest)) return;
    if (seen.size >= SUMMARY_PATHS_MAX) {
      this.truncated = true;
      return;
    }
    seen.add(digest);
  }

  private recordFile(
    kind: "read" | "edit" | "write",
    name: string | null,
    data: JsonObject,
  ): void {
    if (
      kind === "read" &&
      Object.hasOwn(data, "command") &&
      !["path", "file_path"].some((key) => typeof data[key] === "string") &&
      ["bash", "shell"].includes((name ?? "").toLowerCase())
    )
      this.countBashRead(data);
    else this.countFile(kind, data);
  }

  private recordShellAction(action: unknown, result: unknown): void {
    if (action === "subagent_create") this.agents += 1;
    else if (action === "subagent_send") this.agentMessages += 1;
    else if (action === "subagent_rm") this.agentReaps += 1;
    if (action === "pr_create" || action === "pr_merge")
      this.recordPrs(resultText(result));
  }

  /** Fold one finished call in, using the already-computed stat. */
  record(
    name: string | null,
    raw: unknown,
    result: unknown,
    stat: ToolStat,
  ): void {
    this.tools += 1;
    const kind = stat["kind"];
    const data = toolInputObject(raw) ?? {};
    if (kind === "read" || kind === "edit" || kind === "write")
      this.recordFile(kind, name, data);
    if (kind === "edit" || kind === "write") {
      this.added += Number(stat["added"] || 0);
      this.removed += Number(stat["removed"] || 0);
    } else if (kind === "search") this.searches += 1;
    else if (kind === "web") this.web += 1;
    else if (kind === "shell") {
      this.shell += 1;
      this.recordShellAction(stat["action"], result);
    }
  }

  private recordPrs(text: string): void {
    for (const match of text.matchAll(PR_URL_RE)) {
      if (this.prs.length >= SUMMARY_PRS_MAX) {
        this.truncated = true;
        return;
      }
      const number = decimalNumber(match[1]!);
      if (!this.prs.includes(number)) {
        this.prs.push(number);
        this.prLinks.push({ number, url: match[0] });
      }
    }
  }

  /** Stored summary shape: snake_case keys are a wire contract. */
  summary(): Record<string, unknown> {
    return {
      tools: this.tools,
      shell: this.shell,
      read_files: this.files.read.size,
      edit_files: this.files.edit.size,
      added: this.added,
      removed: this.removed,
      write_files: this.files.write.size,
      agents: this.agents,
      agent_messages: this.agentMessages,
      agent_reaps: this.agentReaps,
      searches: this.searches,
      web: this.web,
      prs: [...this.prs],
      pr_links: this.prLinks.map((link) => ({ ...link })),
      truncated: this.truncated,
    };
  }
}

export { TOOL_COMMAND_MAX };
export { readLines, resultText };
