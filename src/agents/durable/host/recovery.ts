// Startup inspects persisted live work without constructing a Harness. Reads
// share the storage fence with history pages; uncertain stores open normally.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createSession,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Cursor,
} from "@earendil-works/pi-durable";
import type { DurableHost } from "../host";
import { ReportDoc } from "../report";
import { ReviveDoc } from "../revive_doc";
import { SideDoc } from "../side_conversations";
import { runtime } from "./load";
import { awaitedSpan, slowSpan } from "../../../observability/slow_span";

/** True only when stored tasks, input or lifecycle work need an open. */
export async function needsRecovery(
  host: DurableHost,
  cid: string,
): Promise<boolean> {
  return awaitedSpan("needs_recovery", cid, () => inspectRecovery(host, cid));
}

async function inspectRecovery(
  host: DurableHost,
  cid: string,
): Promise<boolean> {
  const conv = slowSpan("recovery_load_record", cid, () => host.deps.load(cid));
  if (!conv || host.deleting(cid)) return false;
  if (conv.promoting || host.clears.has(cid)) return true;
  if (typeof conv.side_of === "string") return false;
  if (host.opened.has(cid) || host.rotating.has(cid)) return false;
  const path = host.storagePath(cid);
  const finished = Promise.withResolvers<void>();
  const readers = host.storageReads.get(path) ?? new Set();
  const read = {
    done: finished.promise,
    cid,
    page: "recovery",
    started: performance.now(),
  };
  host.storageReads.set(path, readers);
  readers.add(read);
  try {
    const exists = async (path: string) =>
      stat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (await exists(join(path, "..", "..", "clear.json"))) return true;
    if (!(await exists(path))) return false;
    const rt = await runtime();
    const storage = await host.messageSearch.withStores([path], () =>
      rt.openWorkerSqliteStorage(
        host.sqlite(rt),
        path,
        undefined,
        undefined,
        true,
        false,
        cid,
      ),
    );
    const session = createSession(storage);
    try {
      for (const status of [
        "pending",
        "running",
        "waiting",
        "sleeping",
        "completing",
      ] as const)
        if (
          (await storage.scanTasks({ status }, 1, undefined, context)).items
            .length
        )
          return true;
      const root = ROOT_CONVERSATION_ID;
      const sides =
        (
          await awaitedSpan("pi_side_snapshot", cid, () =>
            session.snapshot(SideDoc, root, context),
          )
        )?.sides ?? {};
      const ids = [
        root,
        ...Object.entries(sides)
          .filter(
            ([side]) =>
              !host.deleting(side) && host.deps.load(side)?.side_of === cid,
          )
          .map(([, side]) => side.conversation as ConversationId),
      ];
      for (const id of ids) {
        if (
          (
            await awaitedSpan("pi_live_snapshot", cid, () =>
              session.snapshot(LiveDoc, id, context),
            )
          )?.run
        )
          return true;
        if (
          (
            await awaitedSpan("pi_inbox_snapshot", cid, () =>
              session.snapshot(InboxDoc, id, context),
            )
          )?.items.length
        )
          return true;
      }
      if (
        typeof conv.revived_from === "string" &&
        !(
          await awaitedSpan("pi_revive_snapshot", cid, () =>
            session.snapshot(ReviveDoc, root, context),
          )
        )?.settled
      )
        return true;
      if (host.deps.report) {
        const report = await awaitedSpan("pi_report_snapshot", cid, () =>
          session.snapshot(ReportDoc, root, context),
        );
        let cursor: Cursor | undefined = { after: report?.after ?? -1 };
        do {
          const page = await storage.scanSubmissions(
            { conversationId: root },
            100,
            cursor,
            context,
          );
          if (page.items.some((record) => record.type === "input")) return true;
          cursor = page.next;
        } while (cursor);
      }
      return false;
    } finally {
      await session.close(context);
    }
  } catch (error) {
    host.deps.log("durable_recovery_inspection_failed", {
      cid,
      error: String(error),
    });
    return true;
  } finally {
    readers.delete(read);
    if (!readers.size) host.storageReads.delete(path);
    finished.resolve();
  }
}
