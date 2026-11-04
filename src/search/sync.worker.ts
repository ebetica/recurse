// Startup catch-up and live appends project immutable SQLite entries.
// Synchronization repairs damaged files; readiness shares only saved cookies.
import { Database } from "bun:sqlite";
import {
  closeSync,
  openSync,
  renameSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SearchTarget, SyncStats } from "./index";
import {
  BODY_BYTES,
  HEADER_BYTES,
  formatEntry,
  parseHeader,
  type TranscriptRow,
} from "./transcript";

import {
  STATE_FILE,
  databaseIdentity,
  identity,
  readProjectionState,
  searchFile,
  type ProjectionState,
} from "./projection_state.worker";
export { SEARCH_FILE, identity, searchFile } from "./projection_state.worker";

const PAGE = 256;
const DIFFERENT = Symbol("projection differs");
interface State extends ProjectionState {
  inode: number | null;
  tail?: { entry: number; seq: number };
}
const states = new Map<string, State>();

function remember(path: string, state: State): void {
  if (states.size >= 4096) states.delete(states.keys().next().value!);
  states.set(path, state);
}

function persist(
  path: string,
  state: Pick<State, "version" | "file" | "database" | "prefix">,
): void {
  const saved = join(dirname(path), STATE_FILE);
  const { version, file, database, prefix } = state;
  writeFileSync(
    `${saved}.tmp`,
    JSON.stringify({ version, file, database, prefix }),
    { mode: 0o600 },
  );
  renameSync(`${saved}.tmp`, saved);
}

/**
 * Preserve current search state across a source close that only checkpoints.
 */
export function closeWithSearchState(path: string, close: () => void): void {
  const state = states.get(path);
  if (!state) return close();
  let current = false;
  try {
    const source = statSync(path);
    current =
      state.inode === source.ino &&
      state.database === databaseIdentity(path, source) &&
      state.file ===
        identity(statSync(searchFile(path), { throwIfNoEntry: false }));
  } finally {
    close();
  }
  if (!current) return;
  const source = statSync(path);
  if (
    state.inode !== source.ino ||
    state.file !==
      identity(statSync(searchFile(path), { throwIfNoEntry: false }))
  )
    return;
  const database = databaseIdentity(path, source);
  if (state.database === database) return;
  const updated = { ...state, database };
  persist(path, updated);
  remember(path, updated);
}

function stateFor(path: string, source: Stats): State | undefined {
  const cached = states.get(path);
  if (cached) return cached;
  const saved = readProjectionState(path);
  if (!saved) return undefined;
  const state: State = {
    ...saved,
    inode:
      saved.database.split("/")[0] === identity(source) ? source.ino : null,
  };
  remember(path, state);
  return state;
}

function cursor(
  file: string,
  size: number,
): { entry: number; seq: number } | undefined {
  if (!size) return { entry: -1, seq: -1 };
  const fd = openSync(file, "r");
  try {
    for (const length of [4096, BODY_BYTES + HEADER_BYTES]) {
      const start = Math.max(0, size - length);
      const storage = new Uint8Array(size - start);
      const bytes = Buffer.from(storage.buffer);
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(
          fd,
          storage,
          read,
          bytes.length - read,
          start + read,
        );
        if (!count) return;
        read += count;
      }
      const index = bytes.lastIndexOf("\n--- #");
      const at = index >= 0 ? index + 1 : start === 0 ? 0 : -1;
      if (at < 0) continue;
      const end = bytes.indexOf(10, at);
      if (end < 0) return;
      const header = parseHeader(bytes.subarray(at, end).toString("utf8"));
      if (
        header &&
        header.part === header.parts &&
        start + end + 1 + header.bytes === size
      )
        return { entry: header.entry, seq: header.seq };
      return;
    }
  } finally {
    closeSync(fd);
  }
  return undefined;
}

const excluded = ["recurse.pi-entry", "pi.system", "checkpoint"]
  .map((kind) => {
    const prefix = `{"kind":"${kind}",`;
    return `substr(record,1,${prefix.length}) = '${prefix}'`;
  })
  .join(" OR ");

function matches(fd: number, expected: Uint8Array): boolean {
  const buffer = new Uint8Array(Math.min(65536, expected.length));
  for (let offset = 0; offset < expected.length; ) {
    const read = readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, expected.length - offset),
      null,
    );
    if (
      !read ||
      Buffer.compare(
        buffer.subarray(0, read),
        expected.subarray(offset, offset + read),
      )
    )
      return false;
    offset += read;
  }
  return true;
}

export function sync(
  target: SearchTarget,
  force = false,
  owner?: Database,
): SyncStats {
  const start = performance.now();
  const profile = {
    open_ms: 0,
    sqlite_ms: 0,
    decode_ms: 0,
    write_ms: 0,
    verify_ms: 0,
  };
  const file = searchFile(target.path);
  const source = statSync(target.path, { throwIfNoEntry: false });
  if (!source)
    return { entries: 0, bytes: 0, ms: performance.now() - start, profile };
  const before = databaseIdentity(target.path, source);
  const previous = stateFor(target.path, source);
  const existing = statSync(file, { throwIfNoEntry: false });
  let rebuild =
    force ||
    !previous ||
    previous.inode !== source.ino ||
    previous.file !== identity(existing);
  if (!rebuild && previous!.database === before) {
    profile.open_ms = performance.now() - start;
    return {
      entries: 0,
      bytes: 0,
      ms: performance.now() - start,
      profile,
      file: {
        path: file,
        bytes: existing!.size,
        identity: identity(existing),
        inode: source.ino,
      },
    };
  }
  states.delete(target.path);
  // Spec: @tla admit tlaNative(target,profile,owner)
  const db =
    owner ?? new Database(target.path, { readonly: true, strict: true });
  // Spec: @tla open tlaNative(target,profile,owner)
  db.exec(owner ? "BEGIN" : "PRAGMA busy_timeout = 100; BEGIN");
  let fd: number | undefined;
  const temporary = `${file}.tmp`;
  let renamed = false;
  let verify = false;
  let verifiedBytes = 0;
  let retry = false;
  let entries = 0,
    bytes = 0;
  const tail = rebuild
    ? undefined
    : (previous!.tail ?? cursor(file, existing!.size));
  if (!rebuild && !tail) rebuild = true;
  let entry = rebuild ? -1 : tail!.entry;
  let seq = rebuild ? -1 : tail!.seq;
  let prefix = rebuild ? "" : previous!.prefix;
  try {
    if (!rebuild && previous!.database !== before) {
      const last = db
        .query<
          { id: number },
          []
        >("SELECT id FROM entries ORDER BY id DESC LIMIT 1")
        .get();
      const anchor = db
        .query<
          { commit_seq: number; prefix: string },
          [number]
        >("SELECT commit_seq, substr(record,1,512) AS prefix FROM entries WHERE id = ?")
        .get(entry);
      if (
        (last?.id ?? -1) < entry ||
        (entry >= 0 &&
          (!anchor || anchor.commit_seq !== seq || anchor.prefix !== prefix))
      ) {
        rebuild = true;
        entry = seq = -1;
        prefix = "";
      }
    }
    verify =
      rebuild &&
      !force &&
      !!existing?.isFile() &&
      (existing.mode & 0o7777) === 0o600;
    fd = openSync(
      verify ? file : rebuild ? temporary : file,
      verify ? "r" : rebuild ? "w" : "a",
      0o600,
    );
    profile.open_ms = performance.now() - start;
    const query = db.query<TranscriptRow, [number, number]>(
      `SELECT id, conversation_id, commit_seq,
       CASE WHEN ${excluded} THEN NULL ELSE record END AS record
       FROM entries WHERE id > ? ORDER BY id LIMIT ?`,
    );
    for (;;) {
      let at = performance.now();
      const rows = query.all(entry, PAGE);
      profile.sqlite_ms += performance.now() - at;
      if (!rows.length) break;
      const lines: string[] = [];
      for (const row of rows) {
        at = performance.now();
        lines.push(formatEntry(row));
        entry = row.id;
        seq = row.commit_seq;
        profile.decode_ms += performance.now() - at;
      }
      at = performance.now();
      const data = new TextEncoder().encode(lines.join(""));
      profile.decode_ms += performance.now() - at;
      at = performance.now();
      if (verify) {
        if (!matches(fd, data)) throw DIFFERENT;
        verifiedBytes += data.length;
        profile.verify_ms += performance.now() - at;
      } else {
        let written = 0;
        while (written < data.length)
          written += writeSync(fd, data, written, data.length - written);
        profile.write_ms += performance.now() - at;
        bytes += data.length;
      }
      entries += rows.length;
      if (rows.length < PAGE) break;
    }
    if (
      verify &&
      (verifiedBytes !== existing!.size ||
        identity(statSync(file)) !== identity(existing))
    )
      throw DIFFERENT;
    let at = performance.now();
    if (entries) {
      prefix =
        db
          .query<
            { prefix: string },
            [number]
          >("SELECT substr(record,1,512) AS prefix FROM entries WHERE id = ?")
          .get(entry)?.prefix ?? "";
      profile.sqlite_ms += performance.now() - at;
    }
    at = performance.now();
    closeSync(fd);
    fd = undefined;
    if (rebuild && !verify) {
      renameSync(temporary, file);
      renamed = true;
    }
    profile.write_ms += performance.now() - at;
    const state = {
      version: 2,
      file: identity(statSync(file)),
      database: before,
      prefix,
    };
    persist(target.path, state);
    remember(target.path, {
      ...state,
      inode: source.ino,
      tail: { entry, seq },
    });
    rmSync(join(dirname(target.path), "message-search.tsv"), { force: true });
  } catch (error) {
    if (error !== DIFFERENT) throw error;
    retry = true;
  } finally {
    if (owner) db.exec("ROLLBACK");
    else db.close();
    // Spec: @tla close tlaNative(target,profile,owner)
    if (fd !== undefined) closeSync(fd);
    if (rebuild && !verify && !renamed) rmSync(temporary, { force: true });
  }
  if (retry) {
    const result = sync(target, true, owner);
    result.ms = performance.now() - start;
    for (const key of [
      "open_ms",
      "sqlite_ms",
      "decode_ms",
      "write_ms",
      "verify_ms",
    ] as const)
      result.profile![key] = (result.profile![key] ?? 0) + profile[key];
    return result;
  }
  const projected = statSync(file);
  return {
    entries,
    bytes,
    ms: performance.now() - start,
    profile,
    file: {
      path: file,
      bytes: projected.size,
      identity: identity(projected),
      inode: source.ino,
    },
  };
}
