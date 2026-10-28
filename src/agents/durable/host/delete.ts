// Delete a conversation's Durable state when it is reaped. A main
// conversation's Harness closes with verified cleanup before its storage is
// archived and retired; a failed or slow close defers retirement to a retry.
// A side conversation's fork is withdrawn from its parent's Harness.
import { join } from "node:path";
import * as trash from "../../../utils/trash";
import type { DurableHost } from "../host.ts";
import { closeHarness } from "./close.ts";
import type { Opened } from "./open.ts";
import { runtime } from "./load.ts";

/** Reap refuses new opens and sends, aborts the run and retires closed
 * storage; false defers retirement for a later retry. */
export async function retire(
  host: DurableHost,
  cid: string,
  timeoutMs: number,
): Promise<boolean> {
  const parent = host.deps.load(cid, ["side_of"])?.side_of;
  if (typeof parent === "string") return retireSide(host, cid, parent);
  const opened = host.opened.get(cid);
  if (opened === undefined && !host.owns(host.deps.load(cid, ["backend"])))
    return true;
  let closing = host.retiring.get(cid);
  if (closing === undefined) {
    const started = closeHarness(host, cid, opened);
    closing = started;
    host.retiring.set(cid, started);
    // Invariant: A failed close leaves the handle for the next retire to
    // close again.
    started.catch(() => {
      if (host.retiring.get(cid) === started) host.retiring.delete(cid);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    closing.then(
      () => true,
      (error) => {
        host.deps.log("durable_close_failed", { cid, error: String(error) });
        return false;
      },
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  // Invariant: Storage retires only after the Harness verifiably closed.
  if (!closed) return false;
  host.opened.delete(cid);
  host.retiring.delete(cid);
  host.clears.delete(cid);
  const key = host.deps.load(cid, ["tmp_key"])?.tmp_key;
  if (typeof key === "string" && !(await host.keepStore(cid, "reap", key)))
    return false;
  return retireStore(host, cid);
}

/** Delete a side conversation: withdraw its fork's input, stop its run and
 * forget it. A parent being deleted is used only if open; otherwise its next
 * open drops the fork. */
async function retireSide(
  host: DurableHost,
  cid: string,
  parent: string,
): Promise<boolean> {
  host.titleTasks.get(cid)?.scope.abort();
  await host.titleTasks.get(cid)?.done;
  const opened = host.opened.get(cid);
  host.opened.delete(cid);
  await (await opened?.catch(() => null))?.close();
  try {
    const main =
      host.deleting(parent) || host.closing
        ? await host.opened.get(parent)?.catch(() => undefined)
        : await host.open(parent);
    if (main !== undefined) await forgetFork(host, main, cid);
  } catch (error) {
    host.deps.log("durable_side_retire_failed", {
      cid,
      error: String(error),
    });
    return false;
  }
  return retireStore(host, cid);
}

function retireStore(host: DurableHost, cid: string): boolean {
  try {
    trash.retire(
      join(host.deps.dataDir, "conversations", cid),
      host.deps.trashDir,
    );
  } catch (error) {
    host.deps.log("durable_retire_failed", { cid, error: String(error) });
    return false;
  }
  return true;
}

/** Stop following side conversation `cid` in `main` and drop its fork. */
export async function forgetFork(
  host: DurableHost,
  main: Opened,
  cid: string,
): Promise<void> {
  host.opened.delete(cid);
  await (await main.attached.get(cid)?.catch(() => null))?.close();
  main.attached.delete(cid);
  const { dropFork } = await runtime();
  const fork = await dropFork(main.harness, main.conversation, cid);
  if (fork !== undefined) {
    main.sessions.delete(fork.sessionId);
    main.parentSessions.delete(fork.sessionId);
    main.followed.delete(String(fork.conversation));
    main.owners.delete(String(fork.conversation));
  }
  main.captures.forget(cid);
}
