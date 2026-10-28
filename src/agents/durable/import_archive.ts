// External revive uses bounded async reads and Worker SQL on a staged copy.
// Never inherit foreign process ownership: omit registries, remove launch memos
// and abort copied shell tasks. Publish via AgentArchive.keep; trash failures.
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import type { Models } from "@earendil-works/pi-ai";
import { AsyncJsonlRangeReader } from "../view/session_entries";
import { importPiSession, type PiImportOptions } from "./import_pi_session";
import { openWorkerSqliteStorage, SqliteWorker } from "./sqlite_worker";
import type { AgentArchive, ArchivedAgent } from "./archive";
import { sanitizeImportedProcesses } from "./revive_processes.ts";
import * as trash from "../../utils/trash";

export const MAX_REVIVE_BYTES = 256 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : null);

/** Admission errors are actionable refusals, not an opaque server error. */
export class ArchiveImportRefused extends Error {
  override name = "ArchiveImportRefused";
}
function refuse(message: string): never {
  throw new ArchiveImportRefused(message);
}

// Refuse links/devices and bound both the read and a file growing during it.
async function copyFile(
  from: string,
  to: string,
  budget: number,
): Promise<number> {
  const info = await lstat(from);
  if (!info.isFile()) refuse(`Expected a regular file: ${from}`);
  if (info.size > budget)
    refuse(
      `Revive source exceeds the ${MAX_REVIVE_BYTES / 1024 / 1024} MiB limit.`,
    );
  const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = await open(to, "wx", 0o600);
  try {
    const before = await input.stat();
    if (
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size !== info.size
    )
      refuse("Revive source changed while being copied; use a closed store.");
    const buffer = new Uint8Array(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - position),
        position,
      );
      if (!bytesRead)
        refuse("Revive source changed while being copied; use a closed store.");
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      refuse("Revive source changed while being copied; use a closed store.");
    return info.size;
  } finally {
    await input.close();
    await output.close();
  }
}

export interface ImportArchiveOptions {
  archive: AgentArchive;
  trashDir: string;
  models: Models;
  settings: PiImportOptions["settings"];
  log: PiImportOptions["log"];
}

export async function importArchive(
  path: string,
  options: ImportArchiveOptions,
): Promise<ArchivedAgent> {
  const origin = resolve(path);
  const key = randomBytes(12).toString("hex");
  const cid = randomBytes(6).toString("hex");
  const stage = join(options.archive.root, `${cid}.${key}.staging`);
  const store = join(stage, "store");
  const worker = new SqliteWorker();
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(origin).catch(() =>
      refuse(`Revive source does not exist: ${origin}`),
    );
    if (!info.isFile() && !info.isDirectory())
      refuse(
        "Revive source must be a regular file or archive entry directory (not a link).",
      );
    const legacy = info.isFile() && origin.endsWith(".jsonl");
    if (info.isFile() && !legacy && basename(origin) !== "session.sqlite")
      refuse(
        "Expected session.sqlite, a Pi .jsonl session, or an archive entry directory.",
      );
    let meta: Record<string, unknown> = {};
    if (info.isDirectory()) {
      const copied = join(stage, "meta.json");
      await copyFile(join(origin, "meta.json"), copied, MAX_META_BYTES);
      const handle = await open(copied, "r");
      try {
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (
          !record(value) ||
          typeof value.cid !== "string" ||
          !["reap", "clear", "import"].includes(String(value.reason))
        )
          refuse("Archive meta.json is not valid agent archive metadata.");
        meta = value;
      } finally {
        await handle.close();
      }
    }
    let stored: Record<string, unknown> = {};
    if (legacy) {
      const copied = join(stage, "session.jsonl");
      await copyFile(origin, copied, MAX_REVIVE_BYTES);
      const reader = new AsyncJsonlRangeReader(copied);
      const header = await reader.entryAt(0, MAX_META_BYTES);
      if (
        header?.type !== "session" ||
        header.version !== 3 ||
        typeof header.id !== "string"
      )
        refuse("Expected a supported Pi v3 session .jsonl header.");
      stored.cwd = header.cwd;
      await importPiSession({
        conversationId: cid,
        sessionId: header.id,
        sessionFile: copied,
        destination: store,
        trashDir: options.trashDir,
        models: options.models,
        worker,
        settings: {
          ...options.settings,
          cwd: text(header.cwd) ?? options.settings.cwd,
          safetyOff: false,
        },
        state: () => ({ running: false, queued: 0 }),
        log: options.log,
      });
    } else {
      await mkdir(store, { mode: 0o700 });
      const source = info.isDirectory()
        ? join(origin, "session.sqlite")
        : origin;
      const fingerprint = async () =>
        Promise.all(
          [source, `${source}-wal`].map(async (file) => {
            const stat = await lstat(file).catch(() => null);
            return stat
              ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
              : null;
          }),
        );
      const before = JSON.stringify(await fingerprint());
      let total = await copyFile(
        source,
        join(store, "session.sqlite"),
        MAX_REVIVE_BYTES,
      );
      if (await lstat(`${source}-wal`).catch(() => null))
        total += await copyFile(
          `${source}-wal`,
          join(store, "session.sqlite-wal"),
          MAX_REVIVE_BYTES - total,
        );
      if (JSON.stringify(await fingerprint()) !== before)
        refuse("Revive source changed while being copied; use a closed store.");
      const db = await worker.openDatabase(join(store, "session.sqlite"));
      try {
        const version = await db.get<{ version: number }>(
          "SELECT version FROM durable_schema WHERE singleton = 1",
        );
        if (!version || version.version !== CURRENT_SQLITE_SCHEMA_VERSION)
          refuse(
            `Durable schema version ${version?.version ?? "missing"} cannot be opened by this instance (supported: ${CURRENT_SQLITE_SCHEMA_VERSION}).`,
          );
        const check = await db.get<{ quick_check: string }>(
          "PRAGMA quick_check",
        );
        if (check?.quick_check !== "ok")
          refuse(
            "Revive source is not a complete, valid Durable store; use a closed store.",
          );
        await sanitizeImportedProcesses(db);
      } finally {
        await db.close();
      }
      const storage = await openWorkerSqliteStorage(
        worker,
        join(store, "session.sqlite"),
      );
      let harness: Harness | undefined;
      try {
        harness = await Harness.open(
          storage,
          { models: options.models, registry: createRegistry() },
          context,
        );
        const conversation = await harness.root(context);
        const agent = await harness.snapshot(
          AgentDoc,
          conversation.id,
          context,
        );
        stored = {
          cwd: agent?.cwd,
          model: agent?.model
            ? `${agent.model.provider}/${agent.model.modelId}`
            : null,
          effort: agent?.thinkingLevel,
        };
      } finally {
        if (harness) await harness.close(context);
        else await storage.close(context);
      }
    }
    const metaLevel = meta.level;
    const entry: ArchivedAgent = {
      archive_id: `${cid}.${key}`,
      cid,
      reason: "import",
      origin_path: origin,
      title: text(meta.title) ?? text(stored.title) ?? basename(origin),
      parent: null,
      parent_title: null,
      top_level: true,
      model: text(meta.model) ?? text(stored.model),
      effort: text(meta.effort) ?? text(stored.effort),
      level:
        typeof metaLevel === "number" &&
        Number.isInteger(metaLevel) &&
        metaLevel >= 1 &&
        metaLevel <= 5
          ? metaLevel
          : null,
      workdir: text(meta.workdir) ?? text(stored.cwd),
      created: null,
      archived: Date.now() / 1000,
    };
    if (!(await options.archive.keep(store, entry)))
      refuse("Copied source has no Durable store.");
    return entry;
  } catch (error) {
    if (error instanceof ArchiveImportRefused) throw error;
    throw new ArchiveImportRefused(
      `Cannot import revive source: ${String((error as Error).message ?? error)}`,
    );
  } finally {
    worker.close();
    trash.retire(stage, options.trashDir);
  }
}
