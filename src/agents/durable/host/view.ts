// Unopened history uses Pi's storage and document reader, without a Harness.
// Read-only handles live for one page; missing or older stores open normally.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createSession,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { DurableHost } from "../host";
import {
  DurableViews,
  type PageOptions,
  type PublishedFiles,
  type ViewConversation,
  type ViewSession,
} from "../durable_rows";
import { ReportDoc } from "../report";
import { SideDoc } from "../side_conversations";
import { runtime } from "./load";

/** A bounded history page, or null when runtime initialization is required. */
export async function storageView(
  host: DurableHost,
  cid: string,
  options: PageOptions,
  files: PublishedFiles,
): Promise<Record<string, unknown> | null> {
  const started = performance.now();
  const conv = host.deps.load(cid);
  if (conv === null || !host.owns(conv) || host.deleting(cid))
    throw new Error(`not a durable conversation: ${cid}`);
  if (host.closing || host.rotating.has(cid) || host.clears.has(cid))
    return null;
  const parent = typeof conv.side_of === "string" ? conv.side_of : cid;
  if (
    host.rotating.has(parent) ||
    host.clears.has(parent) ||
    host.deleting(parent)
  )
    return null;
  const path = host.storagePath(parent);
  const finished = Promise.withResolvers<void>();
  const readers = host.storageReads.get(path) ?? new Set();
  const read = {
    done: finished.promise,
    cid,
    page: options.before ?? options.after ?? "latest",
    started,
  };
  host.storageReads.set(path, readers);
  readers.add(read);
  // Spec: @tla admit {p:path, id:tlaId(read), k:"page"}
  try {
    const exists = (path: string) =>
      stat(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    const [store, clear] = await Promise.all([
      exists(path),
      exists(join(path, "..", "..", "clear.json")),
    ]);
    if (store === null || clear !== null) return null;
    const rt = await runtime();
    let costs: Record<string, number | undefined> = {};
    const storage = await host.messageSearch
      .withStores([path], () =>
        rt.openWorkerSqliteStorage(
          host.sqlite(rt),
          path,
          undefined,
          (value) => (costs = value),
          true,
          false,
        ),
      )
      .catch((error) => {
        if (
          error.code === "PI_SQLITE_MIGRATION_REQUIRED" ||
          (error.code === "SQLITE_ERROR" &&
            error.message === "no such table: durable_schema")
        )
          return null;
        throw error;
      });
    if (storage === null) return null;
    const session = createSession(storage);
    try {
      const id =
        parent === cid
          ? ROOT_CONVERSATION_ID
          : ((await session.snapshot(SideDoc, ROOT_CONVERSATION_ID, context))
              ?.sides[cid]?.conversation as ConversationId | undefined);
      if (id === undefined) return null;
      if (!(await storage.conversation(id, context))) return null;
      if (!(await session.snapshot(ReportDoc, id, context))?.generation)
        return null;
      const live = await session.snapshot(LiveDoc, id, context);
      const inbox = await session.snapshot(InboxDoc, id, context);
      if (live?.run || inbox?.items.length) return null;
      const conversation: ViewConversation = {
        id,
        entries: (query, limit, cursor, ctx) =>
          storage.scanEntries(
            { ...query, conversationId: id },
            limit,
            cursor,
            ctx,
          ),
      };
      const page = await (host.views ??= new DurableViews()).page(
        cid,
        {
          snapshot: session.snapshot.bind(session),
          getTask: storage.task.bind(storage) as ViewSession["getTask"],
        },
        conversation,
        context,
        {
          pending: host.pendingRows(cid),
          pending_actions: host.pendingActions(cid),
        },
        options,
        files,
      );
      host.deps.log("durable_view_storage", {
        cid,
        ...costs,
        total_ms: Math.round(performance.now() - started),
      });
      return page;
    } finally {
      await session.close(context);
    }
  } finally {
    readers.delete(read);
    // Spec: @tla close {p:path, id:tlaId(read), k:"page"}
    if (!readers.size) host.storageReads.delete(path);
    finished.resolve();
  }
}
