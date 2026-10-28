// Hard-link/rename reaped records and transcripts; expire whole day partitions.
// Never open live files, especially SQLite; refuse EXDEV. Validate before paths
// change. Publication adds no file or directory fsync.
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  expire as expirePartitions,
  type ExpiryResult,
} from "../utils/partition_expiry";
import { retire } from "../utils/trash";
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

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
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

function matchesLifetime(
  destination: string,
  conversationKey: string,
): boolean {
  try {
    const value = parsePythonJson(
      readFileSync(join(destination, "conversation.json"), "utf8"),
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
): string {
  validateArchiveInputs(cid, archiveDate, conversationKey);
  const partition = join(paths.historyDir, archiveDate);
  const destination = join(partition, `${cid}.${conversationKey}`);
  const staging = join(partition, `.${cid}.${conversationKey}.tmp`);
  ensureDirectory(partition);
  retire(staging, paths.trashDir);

  if (statIsDirectory(destination)) {
    if (matchesLifetime(destination, conversationKey)) return destination;
    const error = new Error("archive belongs to another conversation lifetime");
    error.name = "FileExistsError";
    throw error;
  }

  mkdirSync(staging, { mode: 0o700 });
  try {
    // Invariant: link(2) leaves the source inode in place and never opens a
    // live SQLite file.
    linkSync(conversationPath, join(staging, "conversation.json"));
    const messages = join(staging, "messages");
    mkdirSync(messages, { mode: 0o700 });
    for (const source of messagePaths)
      linkSync(source, join(messages, basename(source)));
    renameSync(staging, destination);
    return destination;
  } finally {
    if (existsSync(staging)) retire(staging, paths.trashDir);
  }
}

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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
): string {
  validateArchiveInputs(cid, archiveDate, conversationKey);
  const partition = join(paths.historyDir, archiveDate);
  ensureDirectory(partition);
  // Invariant: Recover residue from a kill between materialization and archive
  // publication.
  for (const name of readdirSync(partition)) {
    if (!/^\..*\.record\.tmp$/u.test(name)) continue;
    try {
      unlinkSync(join(partition, name));
    } catch (error) {
      if (!isSystemError(error)) throw error;
    }
  }
  const temporary = join(partition, `.${cid}.record.tmp`);
  writeFileSync(temporary, pyCompactJson(record, { indent: 1 }), "utf8");
  try {
    return archive(
      cid,
      temporary,
      messagePaths,
      archiveDate,
      conversationKey,
      paths,
    );
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

/** Retire expired archive partitions and report the bounded pass. */
export function expire(
  policy: ReapHistoryExpiryPolicy,
  options: { now?: number; limit?: number } = {},
): ExpiryResult {
  const result = expirePartitions(policy.historyDir, policy.trashDir, {
    retentionDays: policy.retentionDays,
    limit: options.limit ?? policy.expiryLimit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  policy.logExpiry(result);
  return result;
}
