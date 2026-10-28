// Legacy shell liveness requires running state and verified process identity,
// or a non-zombie member of the exact recorded group after its leader exits.
// Failures return not-live; never signal/write (retirement only unlinks).
// Cache directory identity stamps; DurableHost owns current shells.
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { escapeReminderMarkers, wrapSystemReminder } from "./reminder_text";
import { lstatAt, openAt, readdirAt } from "./utils/dir_fd";
import { groupSnapshot, procFields } from "./utils/proc_stat";
import {
  HAS_PROCESS_TABLE,
  PROC,
  procEntry,
  procText,
} from "./utils/process_table";
import { parsePythonJson } from "./utils/py_compact_json";

export type ShellRecord = Record<string, unknown>;
type Groups = Map<
  number,
  { count: number; leaderStart: string | null; uncertain: boolean }
>;

export interface ShellRegistryOptions {
  enabled: boolean;
  stateDir: string;
  procRoot?: string;
  hasProc?: boolean;
  processStartedMs: number;
}

export interface ShellLiveness {
  status: "disabled" | "unavailable" | "ready";
  shell_count: number;
  shell_ids?: unknown[];
  shell_pids?: unknown[];
}

const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_RECORDS = 1000;
const MAX_VIEW_ITEMS = 100;
const RECORD_CACHE_MAX = 4096;
const SCAN_CACHE_MAX = 1024;
const REMINDER_MAX_COMMAND_CHARS = 240;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIR_FLAGS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW | CLOEXEC;
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
const FORMAT_CHAR = /^\p{Cf}$/u;
const CONTROL_OR_FORMAT = /^[\p{Cc}\p{Cf}]$/u;
const code = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/** Python `isinstance(v, int) and not isinstance(v, bool)` over parsed JSON. */
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/** Python `str(identity) == start` for a digits-only /proc start token. */
function identityMatches(identity: unknown, start: string | null): boolean {
  if (start === null) return false;
  if (typeof identity === "string") return identity === start;
  return isInt(identity) && Number.isSafeInteger(identity)
    ? String(identity) === start
    : false;
}

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sessionSegment(sessionId: string): string {
  const segment =
    String(sessionId)
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "_";
  return segment === "." || segment === ".." ? "_" : segment;
}

/** Complete command for authenticated display, minus terminal controls. */
export function displayCommand(command: string): string {
  const text = command
    .replace(ANSI_ESCAPE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  let out = "";
  for (const ch of text)
    out +=
      ch === "\n" ||
      ch === "\t" ||
      (!"\r\u2028\u2029".includes(ch) && !CONTROL_OR_FORMAT.test(ch))
        ? ch
        : "\ufffd";
  return out;
}

export function middleElide(value: string, limit: number): string {
  const chars = [...value];
  if (chars.length <= limit) return value;
  const bound = Math.max(3, limit);
  const head = Math.max(1, Math.floor(bound / 2));
  const tail = Math.max(1, bound - 1 - head);
  return (
    chars.slice(0, head).join("") +
    "…" +
    chars.slice(chars.length - tail).join("")
  );
}

/** Python json.dumps(value, ensure_ascii=True) for a string. */
function asciiJson(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One-line, bounded, marker-escaped command for model context. */
export function escapedReminderCommand(command: string): string {
  let escaped = "";
  for (const ch of command.replace(ANSI_ESCAPE, "")) {
    const point = ch.codePointAt(0)!;
    if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else if (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      FORMAT_CHAR.test(ch)
    )
      escaped += `\\u${point.toString(16).padStart(4, "0")}`;
    else escaped += ch;
  }
  return escapeReminderMarkers(
    asciiJson(middleElide(escaped, REMINDER_MAX_COMMAND_CHARS)),
  );
}

function decodeRecord(raw: Uint8Array): ShellRecord | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const rec = parsePythonJson(text);
    return rec !== null && typeof rec === "object" && !Array.isArray(rec)
      ? (rec as ShellRecord)
      : null;
  } catch {
    return null;
  }
}

/** Read one small regular registry file without following a final symlink. */
async function readRecord(
  openRecord: (flags: number) => Promise<FileHandle>,
): Promise<ShellRecord | null> {
  let handle;
  try {
    handle = await openRecord(constants.O_RDONLY | NOFOLLOW | CLOEXEC);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    const buffer = new Uint8Array(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES) return null;
    return decodeRecord(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class ShellRegistry {
  private readonly procRoot: string;
  private readonly hasProc: boolean;
  private readonly recordCache = new Map<string, ShellRecord>();
  private readonly scanCache = new Map<
    string,
    { sig: string; records: ShellRecord[]; readable: boolean }
  >();

  constructor(private readonly options: ShellRegistryOptions) {
    this.procRoot = options.procRoot ?? PROC;
    this.hasProc = options.hasProc ?? HAS_PROCESS_TABLE;
  }

  /** Drop all cached registry state (cold reads). */
  invalidateCaches(): void {
    this.recordCache.clear();
    this.scanCache.clear();
  }

  sessionDir(sessionId: string): string {
    return join(this.options.stateDir, sessionSegment(sessionId));
  }

  private async pidAlive(pid: number): Promise<boolean> {
    if (this.hasProc) {
      try {
        await procEntry(this.procRoot, pid);
        return true;
      } catch (error) {
        return code(error) === "EACCES" || code(error) === "EPERM";
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return code(error) === "EPERM";
    }
  }

  private async statFields(pid: number) {
    try {
      return procFields(await procText(pid, "stat", this.procRoot));
    } catch {
      return { state: null, startTime: null };
    }
  }

  private async recordLive(rec: unknown, groups?: Groups): Promise<boolean> {
    if (!rec || typeof rec !== "object") return false;
    const record = rec as ShellRecord;
    if (record.status !== "running") return false;
    const pid = record.pid;
    if (!isInt(pid) || pid <= 0) return false;
    if (!this.hasProc) return this.pidAlive(pid);
    const identity = record.identity;
    if (identity === null || identity === undefined) return false;
    const pgid = record.pgid;
    if (groups && isInt(pgid) && pgid > 1 && groups.has(pgid)) {
      const { count, leaderStart, uncertain } = groups.get(pgid)!;
      return !(
        uncertain ||
        count <= 0 ||
        (leaderStart !== null && !identityMatches(identity, leaderStart))
      );
    }
    if (!(await this.pidAlive(pid))) return false;
    return identityMatches(identity, (await this.statFields(pid)).startTime);
  }

  private async cachedRecord(
    name: string,
    directoryFd: number,
    directoryInfo: BigIntStats,
  ): Promise<ShellRecord | null> {
    let info: BigIntStats;
    try {
      info = await lstatAt(directoryFd, name, { bigint: true });
    } catch {
      return null;
    }
    if (!info.isFile() || info.size > BigInt(MAX_RECORD_BYTES)) return null;
    const key = JSON.stringify([
      String(directoryInfo.dev),
      String(directoryInfo.ino),
      name,
      String(info.dev),
      String(info.ino),
      String(info.size),
      String(info.mtimeNs),
    ]);
    const cached = this.recordCache.get(key);
    if (cached) return cached;
    const rec = await readRecord((flags) => openAt(directoryFd, name, flags));
    if (rec) {
      if (this.recordCache.size >= RECORD_CACHE_MAX) this.recordCache.clear();
      this.recordCache.set(key, rec);
    }
    return rec;
  }

  /** `[records, readable]`; a missing session is a healthy empty set. */
  async scanRecords(
    sessionId: string | null | undefined,
    recordLimit: number | null = MAX_RECORDS,
    strict = false,
  ): Promise<[ShellRecord[], boolean]> {
    if (!sessionId) return [[], true];
    const directoryPath = this.sessionDir(sessionId);
    const cacheKey = JSON.stringify([directoryPath, recordLimit, strict]);
    let pathInfo: BigIntStats;
    try {
      pathInfo = await lstat(directoryPath, { bigint: true });
    } catch (error) {
      return [[], code(error) === "ENOENT"];
    }
    if (!pathInfo.isDirectory()) {
      this.scanCache.delete(cacheKey);
      return [[], false];
    }
    const sig = `${pathInfo.dev}:${pathInfo.ino}:${pathInfo.mtimeNs}`;
    const hit = this.scanCache.get(cacheKey);
    if (hit && hit.sig === sig) return [[...hit.records], hit.readable];
    let handle;
    try {
      handle = await open(directoryPath, DIR_FLAGS);
      const directoryInfo = await handle.stat({ bigint: true });
      if (
        pathInfo.dev !== directoryInfo.dev ||
        pathInfo.ino !== directoryInfo.ino
      ) {
        this.scanCache.delete(cacheKey);
        return [[], false];
      }
      const records: ShellRecord[] = [];
      let invalid = false;
      let truncated = false;
      let seen = 0;
      // Invariant: Name order, so a record limit keeps the same records on
      // every filesystem.
      const names = (await readdirAt(handle.fd)).sort();
      for (const name of names) {
        if (recordLimit !== null && seen >= recordLimit) {
          truncated = true;
          break;
        }
        seen += 1;
        if (!name.endsWith(".json")) continue;
        const rec = await this.cachedRecord(name, handle.fd, directoryInfo);
        if (rec) records.push(rec);
        else if (strict && !name.startsWith("_")) invalid = true;
      }
      const readable = !invalid && !truncated;
      if (this.scanCache.size >= SCAN_CACHE_MAX) this.scanCache.clear();
      this.scanCache.set(cacheKey, { sig, records: [...records], readable });
      return [records, readable];
    } catch (error) {
      this.scanCache.delete(cacheKey);
      return [[], code(error) === "ENOENT"];
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async liveRecords(
    records: ShellRecord[],
  ): Promise<[ShellRecord[], Groups]> {
    const live: ShellRecord[] = [];
    const leaderDead: ShellRecord[] = [];
    for (const rec of records) {
      if (!rec || typeof rec !== "object" || rec.status !== "running") continue;
      try {
        const pid = rec.pid;
        if (!isInt(pid) || pid <= 0) continue;
        if (!this.hasProc) {
          if (await this.recordLive(rec)) live.push(rec);
          continue;
        }
        if (rec.identity === null || rec.identity === undefined) continue;
        if (!(await this.pidAlive(pid))) {
          if (isInt(rec.pgid) && rec.pgid === pid && rec.pgid > 1)
            leaderDead.push(rec);
          continue;
        }
        if (
          identityMatches(rec.identity, (await this.statFields(pid)).startTime)
        )
          live.push(rec);
      } catch {
        continue;
      }
    }
    const wanted = new Set<number>();
    for (const rec of leaderDead) wanted.add(rec.pgid as number);
    const groups: Groups =
      this.hasProc && wanted.size
        ? await groupSnapshot(wanted, this.procRoot)
        : new Map();
    for (const rec of leaderDead) {
      try {
        if (await this.recordLive(rec, groups)) live.push(rec);
      } catch {
        continue;
      }
    }
    return [live, groups];
  }

  /** Identity-bearing records for one Pi launch owner (hardened scan). */
  async lifecycleRecords(
    sessionId: string | null | undefined,
    ownerId: string | null | undefined,
  ): Promise<[ShellRecord[], boolean]> {
    if (!sessionId || !ownerId) return [[], true];
    const [records, readable] = await this.scanRecords(
      sessionId,
      MAX_RECORDS,
      true,
    );
    return [
      records.filter(
        (rec) =>
          rec.ownerId === ownerId &&
          typeof rec.id === "string" &&
          SAFE_ID.test(rec.id) &&
          rec.id !== "." &&
          rec.id !== "..",
      ),
      readable,
    ];
  }

  async shellRecords(sessionId: string | null | undefined) {
    return (await this.scanRecords(sessionId))[0];
  }

  private restartNotice(rec: ShellRecord, isLive: boolean): string | null {
    if (rec.mode !== "background" && rec.mode !== "monitor") return null;
    const command = rec.command;
    const started = number(rec.startedAt);
    const updated = number(rec.updatedAt);
    if (
      typeof command !== "string" ||
      typeof rec.id !== "string" ||
      pyTruthy(rec.recurseNotice) ||
      started === null ||
      updated === null ||
      started >= this.options.processStartedMs
    )
      return null;
    const shown = escapedReminderCommand(command);
    const completion = rec.completion;
    if (
      completion &&
      typeof completion === "object" &&
      !Array.isArray(completion) &&
      typeof (completion as ShellRecord).message === "string"
    )
      return wrapSystemReminder(
        `Background command ${shown} finished while Recurse was restarting; ` +
          "its completion details are in this session.",
      );
    const lost =
      `Background command ${shown} did not finish before Recurse restarted ` +
      "and is no longer running.";
    if (rec.status !== "lost")
      // Invariant: This notice is returned without a reminder wrapper.
      return rec.status === "running" && !isLive ? lost : null;
    return wrapSystemReminder(lost);
  }

  /** Unreported terminal shell work, bounded to one readable session. */
  async restartNotices(
    sessionId: string | null | undefined,
  ): Promise<{ id: string; message: string; updatedAt: unknown }[]> {
    if (!this.options.enabled) return [];
    try {
      const [records, readable] = await this.scanRecords(
        sessionId,
        MAX_RECORDS,
        true,
      );
      if (!readable) return [];
      let liveIds: Set<unknown>;
      try {
        liveIds = new Set(
          (await this.liveRecords(records))[0]
            .map((rec) => rec.id)
            .filter((id) => typeof id === "string"),
        );
      } catch {
        liveIds = new Set(
          records
            .filter(
              (rec) => typeof rec.id === "string" && rec.status === "running",
            )
            .map((rec) => rec.id),
        );
      }
      const notices = [];
      for (const rec of records) {
        const isLive = typeof rec.id === "string" && liveIds.has(rec.id);
        const message = this.restartNotice(rec, isLive);
        if (message !== null)
          notices.push({
            id: rec.id as string,
            message,
            updatedAt: rec.updatedAt ?? null,
          });
      }
      return notices;
    } catch {
      return [];
    }
  }

  /** Delete every record whose process is gone; run once per server start. */
  async retireFinishedRecords(): Promise<{ removed: number; kept: number }> {
    let removed = 0;
    let kept = 0;
    const sessions: string[] = [];
    try {
      for (const name of await readdir(this.options.stateDir)) {
        const path = join(this.options.stateDir, name);
        // Invariant: Python's DirEntry.is_dir() follows symlinks.
        if (
          await stat(path).then(
            (s) => s.isDirectory(),
            () => false,
          )
        )
          sessions.push(path);
      }
    } catch {
      return { removed: 0, kept: 0 };
    }
    for (const session of sessions) {
      let names: string[];
      try {
        names = (await readdir(session)).filter((name) =>
          name.endsWith(".json"),
        );
      } catch {
        continue;
      }
      const records = new Map<string, ShellRecord | null>();
      for (const name of names)
        records.set(
          join(session, name),
          await readRecord((flags) => open(join(session, name), flags)),
        );
      const valid = [...records.values()].filter(
        (rec): rec is ShellRecord => rec !== null,
      );
      const liveIds = new Set(
        (await this.liveRecords(valid))[0].map((rec) => rec.id ?? null),
      );
      for (const [path, rec] of records) {
        if (rec && liveIds.has(rec.id ?? null)) {
          kept += 1;
          continue;
        }
        try {
          await unlink(path);
          removed += 1;
        } catch {
          continue;
        }
      }
      await rmdir(session).catch(() => undefined);
    }
    this.invalidateCaches();
    return { removed, kept };
  }

  /** One bounded registry/process liveness decision. */
  async shellLiveness(
    sessionId: string | null | undefined,
  ): Promise<ShellLiveness> {
    if (!this.options.enabled) return { status: "disabled", shell_count: 0 };
    try {
      const [records, readable] = await this.scanRecords(sessionId);
      if (!readable) return { status: "unavailable", shell_count: 0 };
      const [live] = await this.liveRecords(records);
      const shown = live.slice(0, MAX_VIEW_ITEMS);
      return {
        status: "ready",
        shell_count: live.length,
        shell_ids: shown.map((rec) => rec.id).filter(pyTruthy),
        shell_pids: shown.map((rec) => rec.pid).filter(pyTruthy),
      };
    } catch {
      return { status: "unavailable", shell_count: 0 };
    }
  }

  /** Whether ANY live shell exists; the gated keepalive/orphan entry point.
   * `snapshot` receives safe identity metadata from this same scan. */
  async hasLiveShell(
    sessionId: string | null | undefined,
    snapshot?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.options.enabled) return false;
    const liveness = await this.shellLiveness(sessionId);
    if (snapshot) {
      for (const key of Object.keys(snapshot)) delete snapshot[key];
      Object.assign(snapshot, {
        shell_status: liveness.status,
        shell_count: liveness.shell_count ?? 0,
        shell_ids: liveness.shell_ids ?? [],
        shell_pids: liveness.shell_pids ?? [],
      });
    }
    return liveness.status === "ready" && liveness.shell_count > 0;
  }
}

/** Python truthiness for parsed JSON values. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
