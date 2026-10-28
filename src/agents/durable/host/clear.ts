// Clear a conversation: a request waits until queued input has run, the queue
// is empty and reports are delivered; then the host rotates its storage
// (DurableHost.maybeRotate). Sends meanwhile are held, mirrored in
// conversations/<cid>/clear.json, and submitted in order to the fresh storage.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import * as trash from "../../../utils/trash";
import { isDirectory } from "../archive.ts";
import type { DurableHost } from "../host.ts";
import { draft, type Held } from "./send.ts";

export interface ClearState {
  held: Held[];
  /** The old storage is retired; only the held input remains to submit. */
  rotated: boolean;
  /** Archive key of the old storage (archive id "<cid>.clear-<key>"). */
  archive?: string;
}

/** Request a clear; null when the conversation is being deleted. */
export async function requestClear(
  host: DurableHost,
  cid: string,
): Promise<Record<string, unknown> | null> {
  if (host.deleting(cid)) return null;
  if (typeof host.deps.load(cid, ["side_of"])?.side_of === "string")
    throw new Error("a side conversation cannot be cleared");
  await host.serial(cid, async () => {
    await host.open(cid);
    if (host.clears.has(cid)) return;
    const state = {
      held: [],
      rotated: false,
      archive: randomBytes(4).toString("hex"),
    };
    await writeClear(host, cid, state);
    host.clears.set(cid, state);
  });
  void host.maybeRotate(cid);
  return { id: cid, action: "clear", queued: host.isRunning(cid) };
}

function clearPath(host: DurableHost, cid: string): string {
  return join(host.deps.dataDir, "conversations", cid, "clear.json");
}

/** Write clear.json, or remove it for null, after earlier writes. Each write
 * serializes the state it is given when it runs, never a stale copy. */
export function writeClear(
  host: DurableHost,
  cid: string,
  state: ClearState | null,
): Promise<void> {
  const path = clearPath(host, cid);
  const write = async () => {
    if (state === null) return unlink(path).catch(() => undefined);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, path);
  };
  const done = (host.clearWrites.get(cid) ?? Promise.resolve()).then(write);
  const tail = done.catch(() => undefined);
  host.clearWrites.set(cid, tail);
  void tail.then(() => {
    if (host.clearWrites.get(cid) === tail) host.clearWrites.delete(cid);
  });
  return done;
}

/** The conversation's clear state, read from clear.json on first open. */
export async function resumeClear(
  host: DurableHost,
  cid: string,
): Promise<ClearState | undefined> {
  let clear = host.clears.get(cid);
  if (clear === undefined) {
    const text = await readFile(clearPath(host, cid), "utf8").catch(
      () => undefined,
    );
    clear = text === undefined ? undefined : (JSON.parse(text) as ClearState);
    if (clear !== undefined) host.clears.set(cid, clear);
  }
  // Invariant: A clear stopped while archiving (its archive directory exists)
  // is finished before anything opens the partly moved old store.
  const kept = join(host.archive.root, `${cid}.clear-${clear?.archive}`);
  if (clear && !clear.rotated && (await isDirectory(kept)))
    await retireCleared(host, cid, clear);
  return clear;
}

/** Archive, then retire, the closed storage of a clear. */
export async function retireCleared(
  host: DurableHost,
  cid: string,
  clear: ClearState,
): Promise<void> {
  clear.archive ??= randomBytes(4).toString("hex");
  if (!(await host.keepStore(cid, "clear", `clear-${clear.archive}`)))
    throw new Error("the cleared history could not be archived");
  trash.retire(join(host.storagePath(cid), ".."), host.deps.trashDir);
  clear.rotated = true;
  await writeClear(host, cid, clear);
}

/** Submit a rotated clear's held input to the fresh storage, then end it. */
export async function submitHeld(
  host: DurableHost,
  cid: string,
  clear: ClearState,
  conversation: Conversation,
): Promise<void> {
  // Invariant: A cleared conversation's fresh storage receives the input held
  // while the clear waited. A send during this loop joins it; one after the
  // clear ends submits directly. A cancel no longer edits the held list once
  // the old storage is retired (cancel in send.ts).
  while (clear.held.length) {
    const item = clear.held[0]!;
    await conversation.submit(draft(item), context);
    clear.held.splice(clear.held.indexOf(item), 1);
  }
  host.clears.delete(cid);
  await writeClear(host, cid, null);
}
