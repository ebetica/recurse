// Indexed archive lookup and bounded transcript reads; never open a Harness.
// Closed archive databases use immutable SQLite opens, without WAL/SHM writes.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT_CONVERSATION_ID,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  subsequencePattern,
  validArchiveId,
} from "../src/agents/durable/archive";
import {
  transcriptEntries,
  type TranscriptQuery,
} from "../src/agents/durable/transcript";

type Match = { archive_id: string; cid: string; title: string | null };

/** Resolve one unrevived archive without scanning archive directories. */
export async function archiveMessages(
  root: string,
  target: string,
  query: TranscriptQuery,
) {
  const indexPath = join(root, "agent-archive", "index.sqlite");
  if (!existsSync(indexPath))
    throw new Error(`no archived agent matches '${target}'`);
  const index = new Database(indexPath, { readonly: true });
  let match: Match | undefined;
  try {
    for (const [where, params] of [
      ["archive_id = ?", [target]],
      ["cid = ?", [target]],
      ["trim(title) = ?", [target]],
      ["substr(cid, -length(?)) = ?", [target, target]],
      [
        "(coalesce(title, '') || ' ' || cid) LIKE ? ESCAPE '\\'",
        [subsequencePattern(target)],
      ],
    ] as const) {
      const rows = index
        .query<
          Match,
          string[]
        >(`SELECT archive_id, cid, title FROM archived_agents WHERE revived_as IS NULL AND (${where}) ORDER BY archived DESC LIMIT 11`)
        .all(...params);
      if (!rows.length) continue;
      if (rows.length > 1 && where !== "cid = ?")
        throw new Error(
          `ambiguous archived agent '${target}': ${rows.map((row) => `${row.cid} (${row.title ?? row.archive_id})`).join(", ")}`,
        );
      match = rows[0];
      break;
    }
  } finally {
    index.close();
  }
  if (!match) throw new Error(`no archived agent matches '${target}'`);
  if (!validArchiveId(match.archive_id))
    throw new Error("invalid archive id in index");
  const path = join(root, "agent-archive", match.archive_id, "session.sqlite");
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0)
    throw new Error(
      "archived store has an uncheckpointed WAL; revive it before reading",
    );
  const SQLITE_OPEN_READONLY = 1;
  const SQLITE_OPEN_URI = 64;
  const db = new Database(
    `${pathToFileURL(path).href}?immutable=1`,
    SQLITE_OPEN_READONLY | SQLITE_OPEN_URI,
  );
  try {
    return await transcriptEntries(
      async (lo, hi, limit) =>
        db
          .query<{ record: string }, number[]>(
            "SELECT record FROM entries WHERE conversation_id = ? AND id >= ? AND id <= ? ORDER BY id DESC LIMIT ?",
          )
          .all(ROOT_CONVERSATION_ID, lo, hi, limit)
          .map((row) => JSON.parse(row.record) as EntryRecord),
      query,
    );
  } finally {
    db.close();
  }
}
