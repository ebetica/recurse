// Validate Artifact repository paths and keep bounded reads and atomic writes in one place.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename as renamePath,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { timed } from "../../observability";

const GIT_TIMEOUT = 30;
const TITLE_MAX = 200;
const MAX_DEPTH = 16;

export const FULL_SHA_RE = /^[0-9a-f]{40}$/u;
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const PYTHON_WHITESPACE =
  /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
export const DIRECTORY_FLAGS = fsConstants.O_RDONLY | DIRECTORY;
export const MAX_MARKER_BYTES = 4 * 1024;

export interface ArtifactContext {
  readonly artifactsDir: string;
  readonly trashDir: string;
  // Return one 32-character hexadecimal id; defaults to a cryptographic UUID.
  readonly ids?: () => string;
  /** Supply the UTC clock used for marker dates and Git commit dates. */
  readonly now?: () => Date;
  // Shorten the Git deadline only; never extend it.
  readonly gitTimeoutMs?: number;
  // Permit legacy tree shapes for replay tests.
  readonly anyKind?: boolean;
}

export type ResolvedContext = ArtifactContext & {
  ids: () => string;
  now: () => Date;
  gitTimeoutMs: number;
};
export type RecordValue = Record<string, unknown>;
type SystemError = Error & { code?: string; path?: string };
type FileBytes = Uint8Array<ArrayBuffer>;

export function ownedBytes(value: ArrayLike<number>): FileBytes {
  return Uint8Array.from(value);
}

/** Base class for safe, user-presentable artifact failures. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class ArtifactNotFound extends ArtifactError {}
export class ArtifactConflict extends ArtifactError {}
export class ArtifactLimit extends ArtifactError {}
export class ArtifactInvalid extends ArtifactError {}
export class ArtifactCorrupt extends ArtifactError {}
/** An app failed to build; the message carries the end of Bun's output. */
export class ArtifactBuild extends ArtifactError {}

export function context(value: ArtifactContext): ResolvedContext {
  const gitTimeoutMs = value.gitTimeoutMs ?? GIT_TIMEOUT * 1000;
  if (
    !Number.isSafeInteger(gitTimeoutMs) ||
    gitTimeoutMs < 1 ||
    gitTimeoutMs > GIT_TIMEOUT * 1000
  ) {
    throw new ArtifactInvalid("invalid artifact Git timeout");
  }
  return {
    ...value,
    ids: value.ids ?? (() => randomUUID().replaceAll("-", "")),
    now: value.now ?? (() => new Date()),
    gitTimeoutMs,
  };
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as SystemError).code;
  return typeof code === "string" ? code : undefined;
}

export function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function isObject(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pythonStrip(value: string): string {
  const points = Array.from(value);
  let start = 0;
  let end = points.length;
  while (start < end && PYTHON_WHITESPACE.test(points[start]!)) start += 1;
  while (end > start && PYTHON_WHITESPACE.test(points[end - 1]!)) end -= 1;
  return points.slice(start, end).join("");
}

function pythonCasefold(value: string): string {
  return value.replaceAll("ı", "i").replaceAll("ſ", "s").toLowerCase();
}

export function normalizedOwner(value: string | null | undefined): string {
  const owner = String(value || "");
  if (!OWNER_RE.test(owner))
    throw new ArtifactInvalid("invalid artifact owner");
  return owner;
}

export function normalizedId(value: string): string {
  const id = String(value || "");
  if (!ID_RE.test(id) || id.startsWith(".") || id.includes("..")) {
    throw new ArtifactInvalid("invalid artifact id");
  }
  return id;
}

export function normalizedTitle(value: string): string {
  const title = pythonStrip(String(value || ""));
  if (
    !title ||
    Array.from(title).length > TITLE_MAX ||
    Array.from(title).some((char) => char.codePointAt(0)! < 32)
  ) {
    throw new ArtifactInvalid(
      `title must be 1-${TITLE_MAX} printable characters`,
    );
  }
  return title;
}

/** Normalize a displayable, non-hidden POSIX file path. */
export function safeRel(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.codePointAt(0)! < 32)
  ) {
    throw new ArtifactInvalid("invalid artifact path");
  }
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (
    value.startsWith("/") ||
    parts.some((part) => part === "..") ||
    parts.length > MAX_DEPTH ||
    Buffer.byteLength(value, "utf8") > 240
  ) {
    throw new ArtifactInvalid(
      parts.length > MAX_DEPTH || Buffer.byteLength(value, "utf8") > 240
        ? "artifact path is too deep"
        : "invalid artifact path",
    );
  }
  for (const part of parts) {
    if (part.startsWith(".") || pythonCasefold(part).startsWith(".git")) {
      throw new ArtifactInvalid("hidden and .git paths are not allowed");
    }
  }
  return parts.length ? parts.join("/") : ".";
}

async function regular(path: string, limit?: number): Promise<Stats> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw new ArtifactInvalid("artifact file is unavailable");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new ArtifactInvalid("artifact file is unsafe");
  }
  if (limit !== undefined && info.size > limit) {
    throw new ArtifactLimit("artifact file is too large");
  }
  return info;
}

export function readFileBounded(path: string, limit: number): Promise<Buffer> {
  return timed("artifact_read_file", () => readStoredFile(path, limit));
}

async function readStoredFile(path: string, limit: number): Promise<Buffer> {
  const before = await regular(path, limit);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const data = new Uint8Array(new ArrayBuffer(before.size));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(
      offset === data.length ? data : data.subarray(0, offset),
    );
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw new ArtifactInvalid("artifact file is unavailable");
  } finally {
    await handle?.close();
  }
}

async function ensureParent(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
  } catch {
    throw new ArtifactCorrupt("artifact directory cannot be created");
  }
}

export async function writeFileAtomic(
  ctx: ResolvedContext,
  path: string,
  data: FileBytes,
): Promise<void> {
  await ensureParent(path);
  try {
    await lstat(path);
    await regular(path);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof ArtifactNotFound)) throw error;
  }
  const temp = join(dirname(path), `.${basename(path)}.${ctx.ids()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o666);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renamePath(temp, path);
    // Invariant: A best-effort parent-directory fsync follows the rename.
    try {
      const directory = await open(dirname(path), DIRECTORY_FLAGS);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Invariant: Directory durability is best effort; failure is ignored.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactCorrupt("artifact file cannot be written");
  }
}

export function ownerRoot(
  ctx: ResolvedContext,
  ownerValue: string,
  create = false,
): Promise<string> {
  return timed("artifact_owner_root", () =>
    resolveOwnerRoot(ctx, ownerValue, create),
  );
}

async function resolveOwnerRoot(
  ctx: ResolvedContext,
  ownerValue: string,
  create = false,
): Promise<string> {
  const owner = normalizedOwner(ownerValue);
  const root = join(ctx.artifactsDir, owner);
  if (create) {
    try {
      await mkdir(ctx.artifactsDir, { recursive: true, mode: 0o777 });
      await mkdir(root, { mode: 0o700, recursive: true });
    } catch {
      throw new ArtifactCorrupt("artifact owner root is invalid");
    }
  }
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw new ArtifactCorrupt("artifact owner root is invalid");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ArtifactCorrupt("artifact owner root is invalid");
  }
  return root;
}

/** Best-effort mutation stamp; malformed storage remains the pane's error. */
export async function revision(
  value: ArtifactContext,
  owner: string,
): Promise<string | null> {
  const ctx = context(value);
  try {
    const root = await ownerRoot(ctx, owner);
    return (await readFileBounded(join(root, ".revision"), 64)).toString(
      "utf8",
    );
  } catch (error) {
    if (error instanceof ArtifactError) return null;
    throw error;
  }
}

export async function changed(
  ctx: ResolvedContext,
  owner: string,
): Promise<void> {
  await writeFileAtomic(
    { ...ctx, ids: () => randomUUID() },
    join(await ownerRoot(ctx, owner), ".revision"),
    ownedBytes(Buffer.from(randomUUID(), "utf8")),
  );
}

export async function markerPath(
  ctx: ResolvedContext,
  owner: string,
  artifactId: string,
): Promise<string> {
  return join(
    await ownerRoot(ctx, owner),
    `.deleted-${normalizedId(artifactId)}.json`,
  );
}

export async function readMarker(
  path: string,
  owner: string,
  artifactId: string,
): Promise<RecordValue | null> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ArtifactCorrupt("artifact deletion marker is unsafe");
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(
      (await readFileBounded(path, MAX_MARKER_BYTES)).toString("utf8"),
    );
  } catch {
    throw new ArtifactCorrupt("artifact deletion marker is unsafe");
  }
  if (!isObject(loaded))
    throw new ArtifactCorrupt("artifact deletion marker is invalid");
  if (
    loaded.owner_agent_id !== owner ||
    loaded.id !== artifactId ||
    !FULL_SHA_RE.test(String(loaded.version ?? "")) ||
    typeof loaded.deletion_id !== "string"
  ) {
    throw new ArtifactCorrupt("artifact deletion marker is invalid");
  }
  return loaded;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
