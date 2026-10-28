// Import idle Pi history in yielding batches without modifying its source.
// Admission exclusion covers validation/publication; busy conversations defer.
// Rename only closed complete staging; its marker makes retries idempotent.
// Keep orphan results in history, but Durable orders/filters them for requests.
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  Models,
  ModelThinkingLevel,
  Message,
  Model,
  Api,
  Usage,
} from "@earendil-works/pi-ai";
import { recordUsage } from "../../../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";
import { orderToolResults } from "../../../node_modules/@earendil-works/pi-durable/dist/harness/context.js";
import { WARNING } from "../../observability/runtime_logging";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  buildSessionProjection,
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  Harness,
  createRegistry,
  type Conversation,
  type EntryDraft,
  type EntryId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { AsyncJsonlRangeReader } from "../view/session_entries";
import {
  EnvironmentDoc,
  recurseOwnedName,
  unprotectedOverrides,
} from "../../extensions/core/environment/managed_tools";
import { openWorkerSqliteStorage, SqliteWorker } from "./sqlite_worker";
import { recordReplyTimes } from "./reply_times";
import * as trash from "../../utils/trash";

type Rec = Record<string, unknown>;
type Draft = { -readonly [K in keyof EntryDraft]: EntryDraft[K] };
const messageKinds: Record<string, string> = {
  user: "pi.user",
  assistant: "pi.assistant",
  toolResult: "pi.tool-result",
  system: "pi.system",
};
const record = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const PAGE_ENTRIES = 64;
const SAFETY_MODULE = new URL(
  "../../extensions/core/safety/durable.ts",
  import.meta.url,
).href;

export interface PiImportOptions {
  conversationId: string;
  sessionFile: string;
  sessionId: string;
  /** Supply Pi's selected leaf when it differs from the last file entry. */
  leafId?: string | null;
  destination: string;
  trashDir: string;
  models: Models;
  worker: SqliteWorker;
  settings: {
    model: ModelRef;
    thinkingLevel: ModelThinkingLevel;
    cwd: string;
    environment: Record<string, string>;
    /** The existing authenticated escape-hatch state, never a new toggle. */
    safetyOff: boolean;
  };
  state():
    | { running: boolean; queued: number }
    | Promise<{ running: boolean; queued: number }>;
  log(event: string, fields: Rec, level?: number): void;
  /** Switchover holds its existing guards while invoking this commit. */
  publish?(commit: () => Promise<void>): Promise<void>;
}

export type PiImportResult =
  | { status: "imported" | "already-imported"; entries: number }
  | { status: "deferred"; reason: string };

class Deferred extends Error {}
function refuse(reason: string): never {
  throw new Error(reason);
}
const code = (error: unknown): unknown =>
  record(error) ? error.code : undefined;

async function idle(options: PiImportOptions): Promise<void> {
  const state = await options.state();
  if (state.running || state.queued !== 0)
    throw new Deferred("The Pi conversation is running or has queued input.");
}

/** Split only LF, like Pi; readline also splits CR inside accepted JSON. */
async function* newlineLines(stream: AsyncIterable<string | Buffer>) {
  let pending = "";
  for await (const chunk of stream) {
    pending += String(chunk);
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  if (pending) yield pending;
}

/** Stream whole entries without a line cap, then select Pi's parent chain. */
async function branch(
  path: string,
  info: { size: number; identity: readonly bigint[] },
  leaf: string | null | undefined,
  context: Context,
): Promise<SessionEntry[]> {
  if (leaf === null) return [];
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const byId = new Map<string, SessionEntry>();
  let wanted = leaf;
  try {
    const identity = await handle.stat({ bigint: true });
    if (identity.dev !== info.identity[0] || identity.ino !== info.identity[1])
      throw new Deferred("The Pi session changed during import.");
    const lines = newlineLines(
      handle.createReadStream({
        encoding: "utf8",
        end: info.size - 1,
        autoClose: false,
      }),
    );
    let count = 0;
    for await (const line of lines) {
      context.abortSignal?.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record(value) || value.type === "session") continue;
      if (
        typeof value.id !== "string" ||
        !(value.parentId === null || typeof value.parentId === "string")
      )
        refuse("The Pi session contains an invalid parent chain.");
      byId.set(value.id, value as unknown as SessionEntry);
      if (leaf === undefined) wanted = value.id;
      if (++count % PAGE_ENTRIES === 0) await setImmediate();
    }
  } finally {
    await handle.close();
  }
  const entries: SessionEntry[] = [];
  const seen = new Set<string>();
  while (wanted != null) {
    const entry = byId.get(wanted);
    if (!entry) break; // Invariant: Pi's loader stops at an absent parent too.
    if (seen.has(wanted)) refuse("The selected Pi branch contains a cycle.");
    seen.add(wanted);
    entries.push(entry);
    wanted = entry.parentId ?? undefined;
  }
  return entries.reverse();
}

/** Only entry references change; transcript text and tool call ids do not. */
function references(value: unknown, ids: Map<string, EntryId>): unknown {
  if (Array.isArray(value)) return value.map((part) => references(part, ids));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [
      key,
      ["firstKeptEntryId", "pointId", "fromId", "targetId"].includes(key) &&
      typeof part === "string"
        ? String(ids.get(part) ?? part)
        : key === "anchorIds" && Array.isArray(part)
          ? part.map((id) => String(ids.get(String(id)) ?? id))
          : references(part, ids),
    ]),
  );
}

function messages(entry: SessionEntry): Message[] {
  return convertToLlm(sessionEntryToContextMessages(entry));
}

// Store Pi's own orphan results explicitly; they have no operator-visible row.
function orphanResults(
  source: SessionEntry[],
  model: Model<Api>,
): Map<string | null, Message[]> {
  const before = new Map<string | null, Message[]>();
  let group: Message[] = [];
  const close = (id: string | null) => {
    const normalized = normalizeContext({ messages: group }).messages;
    const answered = new Set(
      normalized
        .filter((m) => m.role === "toolResult")
        .map((m) => m.toolCallId),
    );
    const missing = transformMessages(normalized, model).filter(
      (m) => m.role === "toolResult" && !answered.has(m.toolCallId),
    );
    if (missing.length) before.set(id, [...(before.get(id) ?? []), ...missing]);
    group = [];
  };
  for (const entry of buildSessionProjection(source).entries) {
    for (const message of convertToLlm(entry.messages)) {
      if (message.role === "assistant" || message.role === "user")
        close(entry.sourceEntry.id);
      group.push(message);
    }
  }
  close(null);
  return before;
}

type Dropped = {
  missing: number;
  unknown: number;
  duplicate: number;
  reordered: boolean;
};

// SDK request messages, with non-wire timestamps and system placement ignored.
// With `dropped`, Durable's orderToolResults applies and counts what it drops.
async function requestFrames(
  messages: readonly Message[],
  model: Model<Api>,
  dropped?: Dropped,
): Promise<string[]> {
  let frames = transformMessages(
    normalizeContext({ messages: [...messages] }).messages,
    model,
  );
  if (dropped) {
    const kept = orderToolResults(frames);
    const keep = new Set(kept);
    const answered = new Set(
      kept.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
    );
    for (const message of frames)
      if (message.role === "toolResult" && !keep.has(message))
        dropped[
          !message.toolCallId
            ? "missing"
            : answered.has(message.toolCallId)
              ? "duplicate"
              : "unknown"
        ]++;
    const remaining = frames.filter((message) => keep.has(message));
    dropped.reordered ||=
      remaining.length !== kept.length ||
      remaining.some((message, index) => message !== kept[index]);
    frames = kept;
  }
  const ordered = [
    ...frames.filter((m) => m.role === "system"),
    ...frames.filter((m) => m.role !== "system"),
  ];
  const out: string[] = [];
  for (const [index, message] of ordered.entries()) {
    const { timestamp: _timestamp, ...frame } = message as unknown as Rec;
    out.push(
      JSON.stringify(frame, (_key, value: unknown) =>
        record(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    if (index % PAGE_ENTRIES === 0) await setImmediate();
  }
  return out;
}

/** Import is not called by the turn path; switchover owns its invocation. */
export async function importPiSession(
  options: PiImportOptions,
  context: Context = background,
): Promise<PiImportResult> {
  const started = performance.now();
  const stage = `${options.destination}.import`;
  let harness: Harness | undefined;
  let entries = 0;
  let result: PiImportResult;
  options.log("pi_import_started", { conversation_id: options.conversationId });
  try {
    await idle(options);
    const sourceStat = await lstat(options.sessionFile, { bigint: true });
    const discovery = new AsyncJsonlRangeReader(options.sessionFile);
    const info = await discovery.sessionInfo();
    const reader = new AsyncJsonlRangeReader(
      options.sessionFile,
      info.identity,
    );
    const header = await reader.entryAt(0, 64 << 10);
    if (
      header?.type !== "session" ||
      header.version !== 3 ||
      header.id !== options.sessionId
    )
      refuse("The Pi session binding or version cannot be imported.");
    try {
      await stat(options.destination);
      const marker = JSON.parse(
        await readFile(join(options.destination, "import.json"), "utf8"),
      ) as Rec;
      if (
        marker.version !== 1 ||
        marker.sessionId !== options.sessionId ||
        (options.leafId !== undefined && marker.leafId !== options.leafId)
      )
        refuse("The destination already belongs to another import.");
      if (options.publish && marker.backend !== "durable") {
        trash.retire(options.destination, options.trashDir);
        options.log("pi_import_uncommitted_retired", {
          conversation_id: options.conversationId,
        });
      } else {
        entries = Number(marker.entries);
        if (options.publish) await options.publish(() => idle(options));
        result = { status: "already-imported", entries };
        return result;
      }
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      // Invariant: A destination without its completion marker is never
      // overwritten.
      if (
        await stat(options.destination).then(
          () => true,
          (error) => {
            if (code(error) === "ENOENT") return false;
            throw error;
          },
        )
      )
        refuse("The Durable destination exists without an import marker.");
    }
    const source = await branch(
      options.sessionFile,
      info,
      options.leafId,
      context,
    );
    const byId = new Map(source.map((entry) => [entry.id, entry]));
    const compaction = source.findLast((entry) => entry.type === "compaction");
    const compactAt = compaction ? source.indexOf(compaction) : -1;
    if (
      compaction?.type === "compaction" &&
      !byId.has(compaction.firstKeptEntryId)
    )
      refuse("The Pi compaction points outside the selected branch.");
    const model = options.settings.model;
    const selectedModel = options.models.getModel(
      model.provider,
      model.modelId,
    );
    if (!selectedModel)
      refuse("The conversation's model is not available on Durable.");
    await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
    trash.retire(stage, options.trashDir);
    await mkdir(stage, { mode: 0o700 });
    const storage = await openWorkerSqliteStorage(
      options.worker,
      join(stage, "session.sqlite"),
    );
    try {
      harness = await Harness.open(
        storage,
        { models: options.models, registry: createRegistry() },
        context,
      );
    } catch (error) {
      await storage.close(background);
      throw error;
    }
    const conversation = await harness.root(context, {
      agent: {
        model,
        thinkingLevel: options.settings.thinkingLevel,
        cwd: options.settings.cwd,
      },
    });
    const droppedNames = Object.keys(options.settings.environment).filter(
      recurseOwnedName,
    );
    if (droppedNames.length)
      options.log(
        "pi_import_environment_dropped",
        { names: droppedNames },
        WARNING,
      );
    await conversation.commit(async (tx) => {
      (await tx.doc(EnvironmentDoc, conversation.id)).overrides =
        unprotectedOverrides(options.settings.environment);
    }, context);
    const safety = (await import(SAFETY_MODULE)) as {
      setSafetyReviewOff: (
        conversation: Conversation,
        off: boolean,
        context: Context,
      ) => Promise<void>;
    };
    await safety.setSafetyReviewOff(
      conversation,
      options.settings.safetyOff,
      context,
    );
    const orphans = orphanResults(source, selectedModel);
    const ids = new Map<string, EntryId>();
    let spendModel = `${model.provider}/${model.modelId}`;
    for (let offset = 0; offset < source.length; offset += PAGE_ENTRIES) {
      await conversation.commit(async (tx) => {
        const replies: [number, number][] = [];
        for (const [index, entry] of source
          .slice(offset, offset + PAGE_ENTRIES)
          .entries()) {
          if (entry.type === "model_change")
            spendModel = `${entry.provider}/${entry.modelId}`;
          const missing = orphans.get(entry.id);
          if (missing)
            await tx.appendEntry(conversation.id, {
              kind: "recurse.pi-synthetic",
              model: missing,
            });
          if (entry.type === "message" && entry.message.role === "assistant") {
            const finished = Date.parse(entry.timestamp);
            if (
              Number.isFinite(entry.message.timestamp) &&
              Number.isFinite(finished)
            )
              replies.push([entry.message.timestamp, finished]);
          }
          const raw = entry as unknown as Rec;
          const {
            id: _id,
            parentId: _parent,
            message: original,
            ...display
          } = raw;
          let modelMessages = messages(entry);
          let kind = "recurse.pi-entry";
          const draft: Draft = { kind };
          if (entry.type === "message") {
            kind = messageKinds[entry.message.role] ?? kind;
            if (!messageKinds[entry.message.role]) display.message = original;
            if (entry.message.role === "system" && offset + index < compactAt)
              modelMessages = [];
          } else if (entry.type === "compaction") {
            if (entry === compaction) {
              kind = "pi.compaction";
              draft.head = ids.get(entry.firstKeptEntryId);
              if (draft.head === undefined)
                refuse("The Pi compaction has an invalid retained range.");
            } else modelMessages = [];
          } else if (entry.type === "context_edit") {
            const target = ids.get(entry.targetId);
            const original = byId.get(entry.targetId);
            if (target === undefined || original === undefined)
              refuse("The Pi context edit points outside the selected branch.");
            const projected = buildSessionProjection([
              { ...original, parentId: null },
              { ...entry, parentId: original.id },
            ]).entries[0]!.messages;
            draft.edits = [
              entry.replacement === null
                ? { target, action: "omit" }
                : {
                    target,
                    action: "replace",
                    messages: convertToLlm(projected),
                  },
            ];
          }
          draft.kind = kind;
          if (modelMessages.length) draft.model = modelMessages;
          draft.data = { piEntry: references(display, ids) } as JsonValue;
          const imported = await tx.appendEntry(conversation.id, draft);
          ids.set(entry.id, imported.id);
          entries++;
          for (const message of modelMessages) {
            if (message.role !== "assistant" && message.role !== "toolResult")
              continue;
            const usage = (message as unknown as Rec).usage;
            if (!record(usage)) continue;
            const bucket = message.role === "assistant" ? "models" : "tools";
            const key =
              message.role === "assistant"
                ? (spendModel = `${message.provider}/${message.model}`)
                : message.toolName;
            await recordUsage(
              tx,
              conversation.id,
              bucket,
              key,
              usage as unknown as Usage,
            );
          }
          if (record(raw.usage)) {
            const key =
              entry.type === "usage"
                ? `${entry.provider}/${entry.model}`
                : spendModel;
            await recordUsage(
              tx,
              conversation.id,
              "models",
              key,
              raw.usage as unknown as Usage,
            );
          }
        }
        if (replies.length)
          await recordReplyTimes(tx, conversation.id, replies);
      }, context);
      await setImmediate();
    }
    const trailing = orphans.get(null);
    if (trailing)
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: "recurse.pi-synthetic",
          model: trailing,
        });
      }, context);
    const retained =
      compaction?.type === "compaction"
        ? source.slice(source.indexOf(byId.get(compaction.firstKeptEntryId)!))
        : source;
    const dropped: Dropped = {
      missing: 0,
      unknown: 0,
      duplicate: 0,
      reordered: false,
    };
    const piFrames = await requestFrames(
      convertToLlm(buildSessionContext(retained).messages),
      selectedModel,
      dropped,
    );
    const durableFrames = await requestFrames(
      (await conversation.context(context)).messages,
      selectedModel,
    );
    if (
      piFrames.length !== durableFrames.length ||
      piFrames.some((frame, index) => frame !== durableFrames[index])
    )
      refuse("The Pi session's next request cannot be preserved on Durable.");
    if (
      dropped.missing + dropped.unknown + dropped.duplicate ||
      dropped.reordered
    )
      options.log(
        "durable_import_repaired_tool_results",
        {
          cid: options.conversationId,
          missing_id: dropped.missing,
          unknown_id: dropped.unknown,
          duplicate: dropped.duplicate,
          reordered: dropped.reordered,
        },
        WARNING,
      );
    await harness.close(background);
    harness = undefined;
    await writeFile(
      join(stage, "import.json"),
      JSON.stringify({
        version: 1,
        // Invariant: A switchover marker is the backend commit, including
        // across a crash before the conversation metadata writer catches up.
        ...(options.publish ? { backend: "durable" } : {}),
        sessionId: options.sessionId,
        leafId: source.at(-1)?.id ?? null,
        entries,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const publish = async () => {
      await idle(options);
      const after = await lstat(options.sessionFile, { bigint: true });
      if (
        after.size !== BigInt(info.size) ||
        after.dev !== info.identity[0] ||
        after.ino !== info.identity[1] ||
        after.mtimeNs !== sourceStat.mtimeNs ||
        after.ctimeNs !== sourceStat.ctimeNs
      )
        throw new Deferred(
          "The Pi session changed during import; retry when it is idle.",
        );
      context.abortSignal?.throwIfAborted();
      await rename(stage, options.destination);
    };
    if (options.publish) await options.publish(publish);
    else await publish();
    result = { status: "imported", entries };
  } catch (error) {
    try {
      if (harness) await harness.close(background);
    } finally {
      trash.retire(stage, options.trashDir);
    }
    if (!(error instanceof Deferred)) throw error;
    result = { status: "deferred", reason: error.message };
  } finally {
    options.log("pi_import_finished", {
      conversation_id: options.conversationId,
      duration_seconds: (performance.now() - started) / 1000,
      entries,
    });
  }
  return result;
}
