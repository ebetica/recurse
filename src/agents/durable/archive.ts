// Closed Durable stores archive by same-filesystem rename after Harness close.
// Retry never overwrites stored files; the Worker index upsert publishes last.
// External sources copy through staging; no live store opens or startup scans.
// Search/expiry use the index; revived metadata stays for provenance.
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { retire } from "../../utils/trash";
import type { WorkerSqliteDatabase } from "./sqlite_worker.ts";

export type ArchiveReason = "reap" | "clear" | "import";

export interface ArchivedAgent {
  archive_id: string;
  cid: string;
  reason: ArchiveReason;
  title: string | null;
  parent: string | null;
  parent_title: string | null;
  top_level: boolean;
  model: string | null;
  effort: string | null;
  level: number | null;
  workdir: string | null;
  created: number | null;
  archived: number;
  revived_as?: string | null;
  // External source copied into this instance; never moved or opened writable.
  origin_path?: string;
}

export const PAGE_LIMIT = 50;
const MAX_QUERY = 96;
const STORE_FILES = [
  "session.sqlite",
  "session.sqlite-wal",
  "session.sqlite-shm",
];
const ARCHIVE_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9][A-Za-z0-9_-]{0,170}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS archived_agents (
  archive_id TEXT PRIMARY KEY, cid TEXT NOT NULL, title TEXT,
  top_level INTEGER NOT NULL, archived REAL NOT NULL, revived_as TEXT,
  data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archived_agents_rank
  ON archived_agents (top_level DESC, archived DESC) WHERE revived_as IS NULL;
CREATE INDEX IF NOT EXISTS archived_agents_cid ON archived_agents (cid);
CREATE INDEX IF NOT EXISTS archived_agents_expiry ON archived_agents (archived)
  WHERE revived_as IS NULL;
`;

type Row = { data: string; revived_as: string | null };
const fromRow = ({ data, revived_as }: Row): ArchivedAgent => ({
  ...(JSON.parse(data) as ArchivedAgent),
  revived_as,
});

export function validArchiveId(id: unknown): id is string {
  return typeof id === "string" && ARCHIVE_ID_RE.test(id);
}

// LIKE pattern matching the query's characters in order, case-insensitively.
export function subsequencePattern(query: string): string {
  const chars = Array.from(query.replace(/\s+/g, "").slice(0, MAX_QUERY));
  return `%${chars.map((c) => (/[%_\\]/.test(c) ? `\\${c}` : c)).join("%")}%`;
}

export const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// Move each store file not already at its destination; true if `to` holds a
// store.
export async function moveStore(from: string, to: string): Promise<boolean> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of STORE_FILES) {
    if (await exists(join(to, name))) continue;
    await rename(join(from, name), join(to, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return exists(join(to, STORE_FILES[0]!));
}

export class AgentArchive {
  private index: Promise<WorkerSqliteDatabase> | null = null;
  private readonly held = new Set<string>();

  constructor(
    readonly root: string,
    private readonly openDatabase: (
      path: string,
    ) => Promise<WorkerSqliteDatabase>,
  ) {}

  private db(): Promise<WorkerSqliteDatabase> {
    this.index ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const db = await this.openDatabase(join(this.root, "index.sqlite"));
      await db.exec(SCHEMA);
      return db;
    })();
    this.index.catch(() => (this.index = null));
    return this.index;
  }

  /**
   * Archive the closed store in `storageDir` (conversations/<cid>/durable).
   * False when there is no store to keep (the conversation never opened).
   */
  async keep(storageDir: string, meta: ArchivedAgent): Promise<boolean> {
    if (!validArchiveId(meta.archive_id)) throw new Error("invalid archive id");
    const dir = join(this.root, meta.archive_id);
    if (
      !(await exists(join(storageDir, STORE_FILES[0]!))) &&
      !(await exists(join(dir, STORE_FILES[0]!)))
    )
      return false;
    if (!(await moveStore(storageDir, dir)))
      throw new Error(`archived store missing in ${dir}`);
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), {
      mode: 0o600,
    });
    await (
      await this.db()
    ).run(
      `INSERT INTO archived_agents (archive_id, cid, title, top_level, archived, data)
       VALUES (?,?,?,?,?,?) ON CONFLICT(archive_id) DO NOTHING`,
      meta.archive_id,
      meta.cid,
      meta.title,
      meta.top_level ? 1 : 0,
      meta.archived,
      JSON.stringify(meta),
    );
    return true;
  }

  /** One page of archives not yet revived, best first. */
  async search(
    query: string,
    offset = 0,
    limit = PAGE_LIMIT,
  ): Promise<ArchivedAgent[]> {
    const db = await this.db();
    const rows = await db.all<Row>(
      `SELECT data, revived_as FROM archived_agents
       WHERE revived_as IS NULL
         AND (coalesce(title, '') || ' ' || cid) LIKE ? ESCAPE '\\'
       ORDER BY top_level DESC, archived DESC, archive_id
       LIMIT ? OFFSET ?`,
      subsequencePattern(query),
      Math.min(Math.max(Math.trunc(limit), 1), PAGE_LIMIT),
      Math.max(Math.trunc(offset), 0),
    );
    return rows.map(fromRow);
  }

  /** The archive with this id, or the newest unrevived archive of this cid. */
  async get(target: string): Promise<ArchivedAgent | null> {
    const db = await this.db();
    const row = await db.get<Row>(
      `SELECT data, revived_as FROM archived_agents
       WHERE archive_id = ? OR (cid = ? AND revived_as IS NULL)
       ORDER BY archive_id = ? DESC, archived DESC LIMIT 1`,
      target,
      target,
      target,
    );
    return row === undefined ? null : fromRow(row);
  }

  /** Keep maintenance from retiring a store while revival moves its files. */
  hold(archiveId: string): () => void {
    this.held.add(archiveId);
    return () => {
      this.held.delete(archiveId);
    };
  }

  /** Retire at most one bounded batch outside request handling. */
  async expire(
    retentionDays: number,
    trashDir: string,
    limit = 4,
    now = Date.now() / 1000,
  ): Promise<number> {
    const db = await this.db();
    const rows = await db.all<{ archive_id: string }>(
      "SELECT archive_id FROM archived_agents WHERE revived_as IS NULL AND archived < ? ORDER BY archived LIMIT ?",
      now - retentionDays * 86400,
      Math.min(Math.max(Math.trunc(limit), 1), PAGE_LIMIT),
    );
    let expired = 0;
    for (const { archive_id } of rows) {
      if (this.held.has(archive_id)) continue;
      if (!validArchiveId(archive_id))
        throw new Error("invalid archive id in index");
      retire(join(this.root, archive_id), trashDir);
      await db.run(
        "DELETE FROM archived_agents WHERE archive_id = ? AND revived_as IS NULL",
        archive_id,
      );
      expired++;
    }
    return expired;
  }

  async markRevived(archiveId: string, cid: string): Promise<void> {
    await (
      await this.db()
    ).run(
      "UPDATE archived_agents SET revived_as = ? WHERE archive_id = ?",
      cid,
      archiveId,
    );
  }

  async close(): Promise<void> {
    const index = this.index;
    this.index = null;
    await (await index?.catch(() => null))?.close();
  }
}
