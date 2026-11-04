// Search scopes resolve from live records and bounded archive-index pages.
// Selection never opens a Harness or enumerates archive directories.
import { join } from "node:path";
import type { AgentArchive, ArchivedAgent } from "../agents/durable/archive";
import type { SearchTarget } from "./index";

export interface SearchAgent {
  id: string;
  title?: unknown;
  parent?: unknown;
  side_of?: unknown;
}
export interface SearchSelection {
  live(): SearchAgent[];
  target(cid: string): SearchTarget;
  archive: AgentArchive;
}

export class SearchScopeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const archiveTarget = (
  archive: AgentArchive,
  row: ArchivedAgent,
): SearchTarget => ({
  cid: row.cid,
  agent: row.archive_id,
  archived: true,
  path: join(archive.root, row.archive_id, "session.sqlite"),
});

const newest = (a: ArchivedAgent, b: ArchivedAgent) =>
  b.archived - a.archived || a.archive_id.localeCompare(b.archive_id);

async function retained(archive: AgentArchive, signal: AbortSignal) {
  const rows: ArchivedAgent[] = [];
  let after = "";
  for (;;) {
    signal.throwIfAborted();
    const page = await archive.page(after);
    rows.push(...page);
    if (page.length < 50) return rows;
    after = page.at(-1)!.archive_id;
  }
}

function selected(
  rows: SearchAgent[],
  target: string,
): SearchAgent | undefined {
  const exact = rows.find((row) => row.id === target);
  if (exact) return exact;
  const matches = rows.filter((row) => row.title === target);
  const suffixes = matches.length
    ? matches
    : rows.filter((row) => row.id.endsWith(target));
  if (suffixes.length > 1)
    throw new SearchScopeError(422, "ambiguous agent; use its full id");
  return suffixes[0];
}

export async function selectSearchTargets(
  deps: SearchSelection,
  options: { target: string; tree: boolean; all: boolean; deleted: boolean },
  signal: AbortSignal,
): Promise<SearchTarget[]> {
  const live = deps.live();
  if (options.all) {
    const result = live
      .filter((row) => !row.side_of)
      .map((row) => deps.target(row.id));
    if (options.deleted)
      result.push(
        ...(await retained(deps.archive, signal))
          .filter((row) => row.reason === "reap" || row.reason === "clear")
          .sort(newest)
          .map((row) => archiveTarget(deps.archive, row)),
      );
    return result;
  }
  const root = selected(live, options.target);
  if (root?.side_of)
    throw new SearchScopeError(
      422,
      "side conversation search is not available; search its main conversation",
    );
  const archived = root ? null : await deps.archive.get(options.target);
  if (!root && !archived) throw new SearchScopeError(404, "agent not found");
  const rootId = root?.id ?? archived!.cid;
  const archives = options.deleted ? await retained(deps.archive, signal) : [];
  const ids = new Set([rootId]);
  if (options.tree) {
    const children = new Map<string, string[]>();
    for (const row of [
      ...live
        .filter((row) => !row.side_of)
        .map((row) => ({ id: row.id, parent: row.parent })),
      ...archives
        .filter((row) => row.reason === "reap" || row.reason === "clear")
        .map((row) => ({ id: row.cid, parent: row.parent })),
    ]) {
      if (typeof row.parent !== "string") continue;
      const siblings = children.get(row.parent) ?? [];
      siblings.push(row.id);
      children.set(row.parent, siblings);
    }
    const pending = [rootId];
    while (pending.length)
      for (const cid of children.get(pending.pop()!) ?? []) {
        if (ids.has(cid)) continue;
        ids.add(cid);
        pending.push(cid);
      }
  }
  const result = live
    .filter((row) => !row.side_of && ids.has(row.id))
    .map((row) => deps.target(row.id));
  const retainedRows = archived ? [archived] : [];
  for (const row of archives)
    if (
      (row.reason === "reap" || row.reason === "clear") &&
      ids.has(row.cid) &&
      row.archive_id !== archived?.archive_id
    )
      retainedRows.push(row);
  result.push(
    ...retainedRows.sort(newest).map((row) => archiveTarget(deps.archive, row)),
  );
  return result;
}
