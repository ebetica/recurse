// Asynchronously hard-link/rename reaped records and transcripts; expire whole
// day partitions. Never open live files, especially SQLite; refuse EXDEV.
// Validate before paths change. Publication adds no file or directory fsync.
// Serialize each conversation's publication; recover only its temporary files.
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import {
  expire as expirePartitions,
  type ExpiryResult,
} from "../utils/partition_expiry";
import { retirePath } from "../utils/trash_sweep";
import { parsePythonJson, pyCompactJson } from "../utils/py_compact_json";

export interface ReapHistoryPaths {
  historyDir: string;
  trashDir: string;
}

export interface ReapHistoryExpiryPolicy extends ReapHistoryPaths {
  retentionDays: number;
  expiryLimit: number;
  logExpiry: (result: ExpiryResult) => void;
}

async function ensureDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

function validateArchiveInputs(
  cid: string,
  archiveDate: string,
  conversationKey: string,
): void {
  const first = Array.from(cid)[0];
  if (
    !cid ||
    Array.from(cid).length > 128 ||
    first === undefined ||
    !/^[\p{L}\p{N}]$/u.test(first) ||
    !Array.from(cid).every((character) => /^[A-Za-z0-9_-]$/u.test(character))
  )
    throw new TypeError("invalid conversation id");
  if (archiveDate.length !== 8 || !/^[0-9]{8}$/u.test(archiveDate))
    throw new TypeError("invalid archive date");
  const keyChars = Array.from(conversationKey);
  if (
    !conversationKey ||
    keyChars.length > 128 ||
    !keyChars.every((character) => /^[A-Za-z0-9_.-]$/u.test(character)) ||
    conversationKey === "." ||
    conversationKey === ".." ||
    conversationKey.startsWith(".")
  )
    throw new TypeError("invalid conversation lifetime key");
}

async function matchesLifetime(
  destination: string,
  conversationKey: string,
): Promise<boolean> {
  try {
    const value = parsePythonJson(
      await fs.readFile(join(destination, "conversation.json"), "utf8"),
    );
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).tmp_key === conversationKey
    );
  } catch {
    return false;
  }
}

// Publish one conversation archive, or return its existing same-lifetime
// archive.
export function archive(
  cid: string,
  conversationPath: string,
  messagePaths: readonly string[],
  archiveDate: string,
  conversationKey: string,
  paths: ReapHistoryPaths,
): Promise<string> {
  validateArchiveInputs(cid, archiveDate, conversationKey);
  const publication = join(paths.historyDir, archiveDate, cid);
  return serialize(publication, () =>
    publish(
      cid,
      conversationPath,
      messagePaths,
      archiveDate,
      conversationKey,
      paths,
    ),
  );
}

async function publish(
  cid: string,
  conversationPath: string,
  messagePaths: readonly string[],
  archiveDate: string,
  conversationKey: string,
  paths: ReapHistoryPaths,
): Promise<string> {
  const partition = join(paths.historyDir, archiveDate);
  const destination = join(partition, `${cid}.${conversationKey}`);
  const staging = join(partition, `.${cid}.${conversationKey}.tmp`);
  await ensureDirectory(partition);
  await retirePath(staging, paths.trashDir);

  if (await statIsDirectory(destination)) {
    if (await matchesLifetime(destination, conversationKey)) return destination;
    const error = new Error("archive belongs to another conversation lifetime");
    error.name = "FileExistsError";
    throw error;
  }

  await fs.mkdir(staging, { mode: 0o700 });
  try {
    // Invariant: link(2) leaves the source inode in place and never opens a
    // live SQLite file.
    await fs.link(conversationPath, join(staging, "conversation.json"));
    const messages = join(staging, "messages");
    await fs.mkdir(messages, { mode: 0o700 });
    for (const source of messagePaths)
      await fs.link(source, join(messages, basename(source)));
    await fs.rename(staging, destination);
    return destination;
  } finally {
    await retirePath(staging, paths.trashDir);
  }
}

async function statIsDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}

function isSystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string"
  );
}

// Archive a live projected record using a same-partition temporary hard-link
// source.
export function archiveLiveRecord(
  cid: string,
  record: Record<string, unknown>,
  messagePaths: readonly string[],
  archiveDate: string,
  conversationKey: string,
  paths: ReapHistoryPaths,
): Promise<string> {
  validateArchiveInputs(cid, archiveDate, conversationKey);
  const partition = join(paths.historyDir, archiveDate);
  return serialize(join(partition, cid), async () => {
    await ensureDirectory(partition);
    // Invariant: Another archive may be materializing in this partition.
    // Recover this conversation's residue only; others expire with the day.
    const temporary = join(partition, `.${cid}.record.tmp`);
    await removeTemporary(temporary);
    await fs.writeFile(temporary, pyCompactJson(record, { indent: 1 }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      return await publish(
        cid,
        temporary,
        messagePaths,
        archiveDate,
        conversationKey,
        paths,
      );
    } finally {
      await removeTemporary(temporary);
    }
  });
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

// Keep only queued publications, never a cache proportional to past archives.
const publications = new Map<string, Promise<string>>();
function serialize(path: string, run: () => Promise<string>): Promise<string> {
  const work = (publications.get(path) ?? Promise.resolve("")).then(run, run);
  publications.set(path, work);
  const settled = () => {
    if (publications.get(path) === work) publications.delete(path);
  };
  void work.then(settled, settled);
  return work;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

/** Retire expired archive partitions and report the bounded pass. */
export async function expire(
  policy: ReapHistoryExpiryPolicy,
  options: { now?: number; limit?: number } = {},
): Promise<ExpiryResult> {
  const result = await expirePartitions(policy.historyDir, policy.trashDir, {
    retentionDays: policy.retentionDays,
    limit: options.limit ?? policy.expiryLimit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  policy.logExpiry(result);
  return result;
}
