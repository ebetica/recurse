// Server-only markers retain a history boundary for lazy readable summaries.
import type { EntryId } from "@earendil-works/pi-durable";

export const SERVER_COMPACTION_MARKER = "Conversation compacted on the server.";

/** A unique summary marker referencing the last compacted entry. */
export function serverCompactionSummary(through: EntryId, at: EntryId): string {
  return `${SERVER_COMPACTION_MARKER}\n<recurse-server-compaction through="${through}" at="${at}" />`;
}

/** The retained-history boundary of a server-only summary, if present. */
export function serverCompactionSource(
  text: string,
): { through: EntryId; at: EntryId } | undefined {
  const match =
    /^Conversation compacted on the server\.\n<recurse-server-compaction through="(\d+)" at="(\d+)" \/>$/.exec(
      text,
    );
  return match
    ? { through: Number(match[1]) as EntryId, at: Number(match[2]) as EntryId }
    : undefined;
}

/** Remap server-marker boundaries when copying history. */
export function remapServerCompaction(
  text: string,
  copied: (id: EntryId) => EntryId,
): string {
  const open = text.indexOf("<summary>\n");
  const close = text.lastIndexOf("\n</summary>");
  if (open < 0 || close < open) return text;
  const start = open + "<summary>\n".length;
  const source = serverCompactionSource(text.slice(start, close));
  return source
    ? text.slice(0, start) +
        serverCompactionSummary(copied(source.through), copied(source.at)) +
        text.slice(close)
    : text;
}
