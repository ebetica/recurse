// Stable foreword plus mutable Recurse sections at authenticated turn boundary.
// Durable owns live capture; legacy readers remain bounded and O_NOFOLLOW.
// Prompt tree/queue/collection inputs are detached snapshots from callers.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { escapeReminderMarkers, wrapSystemReminder } from "../../reminder_text";
import {
  normalizePiUsage,
  providerUsage,
} from "../../tool_projection/__init__";
import {
  LINE_BYTES,
  assistantText,
  boundaryKind,
  contentText,
  groupPiTurns,
  scanSessionTurns,
  splitPiUserText,
  type JsonObject,
} from "../view/session_entries";
import { entryAtOffset } from "./pi_detail_reader";
import { escapeOriginMarkers, formatHiddenMessages } from "./prompt_stamp";
import { uploadDiskPaths } from "./attachments/published";

export type Conv = Record<string, unknown>;
export const DIGEST_MAX_CHILDREN = 100;
export const CAPTURED_PROMPT_VERSION = 1;
export const CAPTURED_PROMPT_MAX_BYTES = 8 * 1024 * 1024;
export const INSPECT_ENTRY_BYTES = 64 << 10;

export interface DigestInputs {
  convs: Conv[];
  live: Record<string, { queued: number }>;
}

export interface CollectionSnapshot {
  collection: string;
  owner: string;
}

export interface PromptsDeps {
  displayName: string;
  dataDir: string;
  turnPromptDir: string;
  toolsDir: string | null;
  /** agentTools._tools_section, regenerated on every compose. */
  toolsSection(): string;
  /** agentTools.conversation_effort_line. */
  conversationEffortLine(conv: Conv): string | null;
  /** tree_view.project_statuses over detached inputs. */
  projectStatuses(
    convs: Conv[],
    live: DigestInputs["live"],
  ): Record<string, string>;
  effectiveWorkdir(conv: Conv): string;
  chatSettings(model: string | null): [model: string, effort: string];
  /** Memory snapshot + render for one conversation id. */
  memoryPrompt(cid: string): Promise<string>;
  boundSessionFile(
    sessionId: unknown,
    recordedFile: unknown,
    recordedCwd: unknown,
  ): Promise<string | null>;
  /** Wall clock in seconds. */
  now(): number;
}

const PY_SPACE_RE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const pyStrip = (value: string) => value.replace(PY_SPACE_RE, "");
const PY_FLOAT_RE =
  /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.|inf(?:inity)?|nan)$/iu;

/** Python `float(str)` for finite-or-not parsing; null where Python raises. */
function pyFloat(raw: string): number | null {
  const text = pyStrip(raw);
  if (!PY_FLOAT_RE.test(text)) return null;
  const lower = text.toLowerCase().replace(/^[+-]/u, "");
  if (lower.startsWith("inf") || lower === "nan") return Number.NaN;
  return Number(text.replaceAll("_", ""));
}

/** Python `str.splitlines()` without keepends. */
function pySplitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python `str()` for record scalars. JSON 7.0 parses as 7 in JS, so a
 * float with a zero fraction spells "7" where Python spells "7.0". */
function pyStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  return Array.isArray(value) ? "list" : "dict";
}

const isMapping = (value: unknown): value is Conv =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const truthy = (value: unknown): boolean =>
  !(
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isMapping(value) && Object.keys(value).length === 0)
  );
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

function activeTurn(conv: Conv): Conv | null {
  const active = conv.active_turn;
  if (active === undefined || active === null) return null;
  if (!isMapping(active))
    throw new Error(`active_turn must be a mapping, got ${pyTypeName(active)}`);
  return active;
}

function recordId(c: Conv): string {
  const id = c.id;
  if (typeof id !== "string")
    throw new Error(`digest record id must be a string, got ${pyTypeName(id)}`);
  return id;
}

function checkedParent(value: unknown): string | null {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw new Error(
      `digest record parent must be a string, got ${pyTypeName(value)}`,
    );
  return (value as string | undefined) ?? null;
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}

export class Prompts {
  constructor(private readonly deps: PromptsDeps) {}

  foreword(): string {
    return `You are "${this.deps.displayName}", a coding assistant working with a tree of agents.

- Prefer chdir and relative paths
- For searching, use the built-in \`grep\`/\`find\` tools; for multiple OR terms, use \`multi_grep\` once; use \`rg\` when bash is required, not \`grep\`
- Read files with \`read\`, not cat/sed; use offset/limit around search hits, but read known external paths directly.
- Combine a file's changes in one edit call; keep oldText regions minimal and unique. Use write only for new files or complete rewrites.
- Share generated files with the native \`publish\` tool.
- For diagrams use \`\`\`mermaid fences; for math use \\(...\\) inline and \\[...\\] display math.
- Summarize results concisely in your final message; show file paths clearly.

Finishing work:
- Requests like "can you…" or "fix…" are work to do, not questions. Don't stop at agreeing, explaining, planning or a partial result.
- A correction or message that arrives while you work updates the current task: apply it in the same turn, answer briefly, and keep going.
- Never end a turn by saying you'll do something. Either do it now, or say what blocks you.
- End a turn only when the work is done, you're blocked (name the blocker, after finishing everything that doesn't depend on it), or you're waiting for a background shell or agent to notify you.

When a run ends, your final message is automatically relayed to your parent (if you have one), after a line saying what started the run. Do not send messages manually unless there's an urgent question.

Settings JSON lives in \`$CHAT_DATA_DIR/config\`.
Only with operator authorization, edit \`$PI_CODING_AGENT_DIR/pi-safety.md\` to override the safety reviewer's built-in instructions across every instance.`;
  }

  /** Stable instructions loaded when a Pi process starts. */
  staticSystemPrompt(): string {
    return this.foreword();
  }

  /** Generated Recurse CLI help and effort ladder for the current boundary. */
  recurseToolsSection(): string {
    return this.deps.toolsSection();
  }

  buildContextBlock(conv: Conv): string {
    const cid = conv.id;
    return [
      "# Agent context",
      `- Full history, including compacted parts: \`bun $RECURSE_SRC/tools/subagent.ts messages ${String(cid)}\`.`,
      "- Put disposable files in $RECURSE_AGENT_TMPDIR, your scratch space, cleared when the agent is deleted; TMPDIR/TMP/TEMP is fast local scratch that a restart may clear. Keep durable work in your worktree or memory.",
      `- Your agent id ($RECURSE_AGENT_ID): ${String(cid)}`,
    ].join("\n");
  }

  runtimeContextBlock(conv: Conv, workdir?: string | null): string {
    const wd = workdir ?? this.deps.effectiveWorkdir(conv);
    const lines = ["## Runtime context", `- Working directory: ${wd}`];
    const effort = this.deps.conversationEffortLine(conv);
    if (effort !== null) lines.push(`- ${effort}`);
    if (truthy(conv.parent)) {
      const parent = String(conv.parent);
      const send =
        this.deps.toolsDir !== null
          ? `bun $RECURSE_SRC/tools/subagent.ts send ${parent} "<message>"`
          : `subagent send ${parent} "<message>"`;
      lines.push(`- Report to your parent with \`${send}\`.`);
    }
    return lines.join("\n");
  }

  treeDigestSnapshot(
    conv: Conv,
    inputs: DigestInputs,
    includeIdleAge = true,
  ): string {
    const cid = conv.id;
    return escapeOriginMarkers(
      this.buildDigest(
        typeof cid === "string" ? cid : null,
        inputs,
        DIGEST_MAX_CHILDREN,
        includeIdleAge,
      ),
    );
  }

  turnContextSnapshot(
    conv: Conv,
    options: {
      workdir?: string | null;
      digestInputs: DigestInputs;
      includeDigest?: boolean;
    },
  ): string {
    const runtime = escapeOriginMarkers(
      this.runtimeContextBlock(conv, options.workdir),
    );
    if (options.includeDigest === false) return runtime;
    return `${runtime}\n\n${this.treeDigestSnapshot(conv, options.digestInputs)}`;
  }

  buildDigest(
    cid: string | null,
    inputs: DigestInputs,
    maxChildren = DIGEST_MAX_CHILDREN,
    includeIdleAge = true,
  ): string {
    // Invariant: Side conversations are the operator's, never agents' tree.
    const convs = inputs.convs.filter((c) => typeof c.side_of !== "string");
    const now = includeIdleAge ? this.deps.now() : 0;
    const updated = (c: Conv): number => {
      const raw = truthy(c.updated) ? c.updated : 0;
      let value = 0;
      if (typeof raw === "boolean") value = raw ? 1 : 0;
      else if (typeof raw === "number") value = raw;
      else if (typeof raw === "string") {
        const parsed = pyFloat(raw);
        if (parsed === null) return 0;
        value = parsed;
      }
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const age = (c: Conv, status: string): string => {
      const stamp = updated(c);
      if (!includeIdleAge || status !== "idle" || !stamp) return "";
      const secs = now - stamp;
      if (secs < 0) return "";
      for (const [unit, div] of [
        ["d", 86400],
        ["h", 3600],
        ["m", 60],
      ] as const)
        if (secs >= div) return ` (idle ${Math.floor(secs / div)}${unit})`;
      return ` (idle ${Math.trunc(secs)}s)`;
    };
    const byId = new Map<string, Conv>();
    const statuses = this.deps.projectStatuses(convs, inputs.live);
    const kids = new Map<string | null, Conv[]>();
    for (const c of convs) {
      byId.set(recordId(c), c);
      const parent = checkedParent(c.parent);
      const list = kids.get(parent) ?? [];
      list.push(c);
      kids.set(parent, list);
    }
    for (const list of kids.values())
      list.sort((a, b) => updated(b) - updated(a));
    const status = (id: string): string => {
      const value = statuses[id];
      if (value === undefined) throw new Error(`KeyError: ${id}`);
      return value;
    };
    const short = (c: Conv): string => {
      const title = truthy(c.title) ? c.title : "untitled";
      const text = pyStrip(pyStr(title).replaceAll("\n", " "));
      return (
        escapeReminderMarkers(Array.from(text).slice(0, 60).join("")) ||
        "untitled"
      );
    };
    const countUnder = (rootId: string): number => {
      const seen = new Set([rootId]);
      const stack = (kids.get(rootId) ?? []).map(recordId);
      let n = 0;
      while (stack.length) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        n += 1;
        stack.push(...(kids.get(x) ?? []).map(recordId));
      }
      return n;
    };
    const row = (c: Conv, depth: number, mark = ""): string => {
      const id = recordId(c);
      const projected = status(id);
      const shown = projected + (truthy(c.pinned) ? ", taken over" : "");
      const under = countUnder(id);
      const queued = inputs.live[id]?.queued ?? 0;
      return (
        `${"  ".repeat(depth)}${id} [${shown}] - ${short(c)}${mark}` +
        `${age(c, projected)}${queued ? ` (${queued} queued)` : ""}` +
        `${under ? ` (+${under} under)` : ""}${truthy(c.reap_deferred) ? " (reaped)" : ""}`
      );
    };
    const lines = ["## Digest: agent tree"];
    const emit = (children: Conv[], depth: number): void => {
      if (children.length > maxChildren) {
        const counts = new Map<string, number>();
        for (const c of children) {
          const s = status(recordId(c));
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const breakdown = [...counts.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([s, n]) => `${n} ${s}`)
          .join(", ");
        lines.push(
          `${"  ".repeat(depth)}${children.length} children (${breakdown})`,
        );
      } else lines.push(...children.map((c) => row(c, depth)));
    };
    const node = cid ? byId.get(cid) : undefined;
    if (node && truthy(node)) {
      const parentId = checkedParent(node.parent);
      const parent = parentId !== null ? byId.get(parentId) : undefined;
      if (parent && truthy(parent))
        lines.push(
          `Parent: ${String(parent.id)} - ${short(parent)}${truthy(parent.reap_deferred) ? " (reaped)" : ""}`,
        );
      lines.push(row(node, 0, " (you)"));
      emit(kids.get(recordId(node)) ?? [], 1);
    } else {
      const roots = convs.filter(
        (c) => !truthy(c.parent) || !byId.has(c.parent as string),
      );
      roots.sort((a, b) => updated(b) - updated(a));
      emit(roots, 0);
    }
    lines.push(
      wrapSystemReminder(
        "Reap finished/stale agents you no longer need; do not stop work you were not asked to, including operator-started agents.",
      ),
    );
    return lines.join("\n");
  }

  captureMemoryPrompt(conv: Conv): Promise<string> {
    return this.deps.memoryPrompt(String(conv.id));
  }

  needsFirstMessageBlock(conv: Conv): boolean {
    return (
      conv.session_id === undefined ||
      conv.session_id === null ||
      truthy(conv.identity_block_pending)
    );
  }

  turnPromptSnapshotPath(conv: Conv): string | null {
    if (!truthy(conv.active_turn)) return null;
    return join(
      this.deps.turnPromptDir,
      `${sha256(String(conv.id ?? ""))}.txt`,
    );
  }

  turnTransportPromptPath(conv: Conv): string | null {
    const snapshot = this.turnPromptSnapshotPath(conv);
    return snapshot === null ? null : snapshot.replace(/\.txt$/u, ".rpc.txt");
  }

  capturedSystemPromptPath(conv: Conv): string {
    return join(
      this.deps.turnPromptDir,
      `${sha256(String(conv.id ?? ""))}.effective.txt`,
    );
  }

  captureRunId(conv: Conv): string | null {
    const active = activeTurn(conv);
    if (active === null) return null;
    const value = truthy(active.run_id) ? active.run_id : active.started_at;
    return value === undefined || value === null ? null : pyStr(value);
  }

  async readCapturedSystemPrompt(
    conv: Conv,
    currentTurn = false,
  ): Promise<string | null> {
    const meta = conv.system_prompt_capture;
    if (meta === undefined || meta === null) return null;
    if (!isMapping(meta))
      throw new Error(
        `system_prompt_capture must be a mapping, got ${pyTypeName(meta)}`,
      );
    if (meta.version !== CAPTURED_PROMPT_VERSION) return null;
    const expected = meta.hash;
    if (!(typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected)))
      return null;
    if (currentTurn && meta.run_id !== this.captureRunId(conv)) return null;
    let raw: Uint8Array;
    try {
      const handle = await open(
        this.capturedSystemPromptPath(conv),
        constants.O_RDONLY | CLOEXEC | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > CAPTURED_PROMPT_MAX_BYTES)
          return null;
        const chunks: Uint8Array[] = [];
        let remaining = CAPTURED_PROMPT_MAX_BYTES + 1;
        while (remaining > 0) {
          const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          chunks.push(chunk.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
        raw = new Uint8Array(Buffer.concat(chunks));
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    if (raw.length > CAPTURED_PROMPT_MAX_BYTES) return null;
    let prompt: string;
    try {
      prompt = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(raw);
    } catch {
      return null;
    }
    return sha256(prompt) === expected ? prompt : null;
  }

  async clearCapturedSystemPrompt(conv: Conv): Promise<boolean> {
    let changed =
      conv.system_prompt_capture !== undefined &&
      conv.system_prompt_capture !== null;
    delete conv.system_prompt_capture;
    const path = this.capturedSystemPromptPath(conv);
    try {
      let present = false;
      try {
        await stat(path);
        present = true;
      } catch {
        try {
          present = (await lstat(path)).isSymbolicLink();
        } catch {
          present = false;
        }
      }
      if (present) {
        await unlink(path);
        changed = true;
      }
    } catch {}
    return changed;
  }

  async dropTurnSystemPrompt(conv: Conv, dropCapture = false): Promise<void> {
    const paths = [
      this.turnPromptSnapshotPath(conv),
      this.turnTransportPromptPath(conv),
    ];
    if (dropCapture) paths.push(this.capturedSystemPromptPath(conv));
    for (const path of paths) if (path !== null) await unlinkQuiet(path);
  }

  async inspectableSystemPrompt(conv: Conv): Promise<string> {
    return (
      (await this.readCapturedSystemPrompt(conv, truthy(conv.active_turn))) ||
      ""
    );
  }

  async readPromptValues(conv: Conv): Promise<Record<string, string>> {
    const modelValue = conv.model;
    if (
      modelValue !== undefined &&
      modelValue !== null &&
      typeof modelValue !== "string"
    )
      throw new Error(`model must be a string, got ${pyTypeName(modelValue)}`);
    const [model] = this.deps.chatSettings(
      (modelValue as string | undefined) ?? null,
    );
    const active = truthy(conv.active_turn);
    const system = await this.readCapturedSystemPrompt(conv, active);
    let meta = conv.system_prompt_capture;
    if (meta === undefined || meta === null) meta = {};
    else if (!isMapping(meta))
      throw new Error(
        `system_prompt_capture must be a mapping, got ${pyTypeName(meta)}`,
      );
    const m = meta as Conv;
    const finishedCurrent =
      m.version === CAPTURED_PROMPT_VERSION &&
      m.run_id === this.captureRunId(conv) &&
      (m.status === "captured" ||
        m.status === "unavailable" ||
        typeof m.hash === "string");
    const status =
      system !== null
        ? "captured"
        : finishedCurrent || !active
          ? "unavailable"
          : "pending";
    return {
      system: system || "",
      capture_status: status,
      backend: "pi",
      model,
    };
  }

  private activeString(
    conv: Conv,
    key: string,
    nonEmpty: boolean,
  ): string | null {
    const active = activeTurn(conv);
    if (active === null) return null;
    const value = active[key];
    return typeof value === "string" && (!nonEmpty || value) ? value : null;
  }

  async turnInputTexts(
    sessionId: string,
    sessionFile: string,
    sessionCwd: string,
    offset: number,
    maxSessionBytes: number,
    rawFrames: string[] | null = null,
  ): Promise<Array<[string, unknown]> | null> {
    let size: number;
    try {
      size = (await lstat(sessionFile)).size;
    } catch {
      return null;
    }
    const end = Math.min(Math.max(Math.trunc(offset), 0) + LINE_BYTES, size);
    const [rows, , , ok] = scanSessionTurns(
      sessionId,
      sessionFile,
      sessionCwd,
      end,
      3,
      {
        maxSessionBytes,
        mustInclude: Math.trunc(offset),
      },
    );
    if (!ok || !rows.length) return null;
    const ordered = [...rows].sort((a, b) => a[0] - b[0]);
    if (!ordered.some(([off]) => off === offset)) return null;
    for (const group of groupPiTurns(ordered)) {
      if (!group.rows.some(([off]) => off === offset)) continue;
      const pairs: Array<[string, unknown]> = [];
      for (const [, , entry] of [...group.rows].sort((a, b) => a[0] - b[0])) {
        if (boundaryKind(entry) !== "user") continue;
        const message = entry.message;
        const content = isMapping(message) ? message.content : null;
        const rendered = contentText(content);
        if (rendered === null) continue;
        const frame = rendered[0];
        const stripped = splitPiUserText(frame)[3];
        pairs.push([stripped, isMapping(message) ? message.timestamp : null]);
        rawFrames?.push(frame);
      }
      return pairs;
    }
    return null;
  }

  async annotateUploads(
    text: string,
    snap: CollectionSnapshot | null,
  ): Promise<string> {
    if (snap === null) return text;
    const paths = await uploadDiskPaths(text, snap.collection, snap.owner);
    if (!paths.length) return text;
    const block =
      "[Attached image(s) are on disk — open them with your Read tool to view:\n" +
      paths.map((p) => `- ${p}`).join("\n") +
      "]";
    return formatHiddenMessages(text, block);
  }

  isDeliveryFrame(text: string): boolean {
    const lines = pySplitlines(text);
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (pyStrip(lines[index]!) !== "## Message") continue;
      const origin = pyStrip(lines[index + 1]!);
      if (
        (origin.startsWith("[recurse-origin: ") ||
          origin.startsWith("[recurse-origin-quoted: ")) &&
        origin.endsWith("]")
      )
        return true;
    }
    return false;
  }

  capturedDrivingText(
    text: string,
    timestamp: unknown,
    liveMessages: unknown,
    storedFrame: string,
  ): string {
    if (Array.isArray(liveMessages) && typeof timestamp === "number") {
      const matches = liveMessages.filter(
        (m) => isMapping(m) && m.role === "user" && m.timestamp === timestamp,
      ) as Conv[];
      if (matches.length === 1) {
        const rendered = contentText(matches[0]!.content);
        if (rendered !== null) {
          if (this.isDeliveryFrame(rendered[0])) return rendered[0];
          return splitPiUserText(rendered[0])[3] || text;
        }
      }
    }
    return this.isDeliveryFrame(storedFrame) ? storedFrame : text;
  }

  async readTurnPromptValues(input: {
    sessionId: string;
    recordedFile: string;
    recordedCwd: string;
    offset: number;
    conv: Conv;
    snap: CollectionSnapshot | null;
    maxSessionBytes: number;
    liveContextMessages?: unknown;
  }): Promise<Record<string, unknown> | null> {
    const { conv } = input;
    const path = await this.deps.boundSessionFile(
      input.sessionId,
      input.recordedFile,
      input.recordedCwd,
    );
    if (path === null) return null;
    const raw = await entryAtOffset(path, input.offset, INSPECT_ENTRY_BYTES);
    if (!isMapping(raw)) return null;
    const message = isMapping(raw.message) ? (raw.message as JsonObject) : null;
    if (
      message === null ||
      (message.role !== "user" && message.role !== "assistant")
    )
      return null;
    if (message.role === "assistant") {
      const content = assistantText(raw) || "";
      const usage = providerUsage(message) ?? normalizePiUsage(message);
      return {
        driving: "",
        message: content,
        system: await this.inspectableSystemPrompt(conv),
        role: "assistant",
        steering: false,
        empty: !content,
        usage,
      };
    }
    const rawFrames: string[] = [];
    const batch = await this.turnInputTexts(
      input.sessionId,
      path,
      input.recordedCwd,
      input.offset,
      input.maxSessionBytes,
      rawFrames,
    );
    if (batch === null || batch.length !== rawFrames.length) return null;
    const drivingTexts = batch.map(([text, timestamp], i) =>
      this.capturedDrivingText(
        text,
        timestamp,
        input.liveContextMessages,
        rawFrames[i]!,
      ),
    );
    const context = this.activeString(conv, "runtime_context", true);
    const reminder = this.activeString(conv, "background_reminder", false);
    let driving = "";
    if (drivingTexts.length) {
      driving = drivingTexts.join("\n\n");
      if (!drivingTexts.every((text) => this.isDeliveryFrame(text))) {
        driving = await this.annotateUploads(driving, input.snap);
        driving = formatHiddenMessages(driving, context, reminder);
      }
    }
    return {
      driving,
      message: batch.length ? batch[0]![0] : "",
      system: await this.inspectableSystemPrompt(conv),
      role: "user",
      steering: false,
      empty: !batch.length,
    };
  }
}
