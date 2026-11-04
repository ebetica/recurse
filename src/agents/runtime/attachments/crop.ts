// Owner-scoped crop operation identity and bounded cancellation records.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { openAt, readdirAt, renameAt, unlinkAt } from "../../../utils/dir_fd";
import { AttachmentError } from "./base";

export interface CropOperation {
  key: string;
  expires: number;
}
const MAX_LIFETIME_MS = 60 * 60 * 1000;
export const MAX_CROP_OPERATIONS = 256;
const MARKER = /^\.crop-([0-9a-f]{32})-([0-9]{13})$/;

export class CropConflict extends AttachmentError {}

export function cropOperation(
  key: unknown,
  expiry: unknown,
  now = Date.now(),
): CropOperation {
  if (
    typeof key !== "string" ||
    !/^[0-9a-f]{32}$/.test(key) ||
    typeof expiry !== "string" ||
    !/^[0-9]{13}$/.test(expiry)
  )
    throw new AttachmentError("invalid crop operation");
  const expires = Number(expiry);
  if (!Number.isSafeInteger(expires) || expires > now + MAX_LIFETIME_MS)
    throw new AttachmentError("invalid crop operation expiry");
  return { key, expires };
}

export function cropId(owner: string, operation: CropOperation): string {
  return createHash("sha256")
    .update(JSON.stringify(["crop", owner, operation.key, operation.expires]))
    .digest("hex")
    .slice(0, 32);
}

/** Prune expired records during existing collection maintenance. */
export async function cropMarkers(
  fd: FileHandle,
  now = Date.now(),
): Promise<Map<string, number>> {
  const markers = new Map<string, number>();
  for (const name of await readdirAt(fd.fd)) {
    const match = MARKER.exec(name);
    if (!match) continue;
    const expires = Number(match[2]);
    if (expires <= now)
      await unlinkAt(fd.fd, name).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    else markers.set(match[1]!, expires);
  }
  return markers;
}

export async function cropBarrier(fd: FileHandle): Promise<number> {
  let handle: FileHandle;
  try {
    handle = await openAt(
      fd.fd,
      ".crop-barrier",
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new AttachmentError("crop cancellation unavailable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 13)
      throw new AttachmentError("crop cancellation unavailable");
    const bytes = new Uint8Array(13);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const text = new TextDecoder().decode(bytes);
    if (bytesRead !== 13 || !/^[0-9]{13}$/.test(text))
      throw new AttachmentError("crop cancellation unavailable");
    const expires = Number(text);
    if (expires <= Date.now()) {
      await unlinkAt(fd.fd, ".crop-barrier");
      return 0;
    }
    return expires;
  } finally {
    await handle.close();
  }
}

async function extendCropBarrier(
  fd: FileHandle,
  expires: number,
): Promise<void> {
  if ((await cropBarrier(fd)) >= expires) {
    await fd.sync();
    return;
  }
  const tmp = `.crop-barrier.${randomUUID()}.tmp`;
  const handle = await openAt(
    fd.fd,
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(String(expires));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameAt(fd.fd, tmp, fd.fd, ".crop-barrier");
    await fd.sync();
  } catch (error) {
    await unlinkAt(fd.fd, tmp).catch(() => {});
    throw error;
  }
}

export async function recordCropCancellation(
  fd: FileHandle,
  id: string,
  expires: number,
  reserved = 0,
  allowBarrier = false,
): Promise<void> {
  if (
    !Number.isSafeInteger(expires) ||
    !/^[0-9]{13}$/.test(String(expires)) ||
    expires > Date.now() + MAX_LIFETIME_MS
  )
    throw new AttachmentError("invalid crop operation expiry");
  const markers = await cropMarkers(fd);
  if (expires <= Date.now()) return;
  const existing = markers.get(id);
  if (existing !== undefined) {
    if (existing !== expires)
      throw new CropConflict("crop operation expiry conflicts");
    await fd.sync();
    return;
  }
  if (markers.size + reserved >= MAX_CROP_OPERATIONS) {
    if (!allowBarrier)
      throw new AttachmentError("crop cancellation limit reached");
    await extendCropBarrier(fd, expires);
    return;
  }
  const handle = await openAt(
    fd.fd,
    `.crop-${id}-${expires}`,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fd.sync();
}
