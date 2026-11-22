// File identity, versions, labels and the settled-turn observer.
import type { AgentAttachment } from "../types.js";

interface FileSource {
  offset: number | null;
  message_id?: string | null;
  pending?: boolean;
  turn_id: string;
  role: "operator" | "agent";
  timestamp: number | null;
}

export interface SessionFile {
  key: string;
  storage: "upload" | "published";
  id?: string;
  name: string;
  source_path?: string;
  image_url?: string;
  size: number;
  media_type: string;
  preview?: "image" | "text" | "audio" | "video" | "pdf" | "document" | "none";
  unavailable?: "copied" | "missing";
  /** Upload or publication time in epoch seconds. */
  created_at?: number;
  references: number;
  sources: FileSource[];
}

export type FileSelection = ({ key: string } | { id: string }) & {
  latest?: boolean;
};

export function selectedFile(
  files: Iterable<SessionFile>,
  selection: FileSelection,
): SessionFile | null {
  for (const file of files)
    if (
      "key" in selection ? file.key === selection.key : file.id === selection.id
    )
      return file;
  return null;
}

// Groups same-name published versions newest-first; uploads never group.
const versionName = (file: SessionFile): string | null =>
  file.storage === "published" && file.id ? file.name : null;
const latestOffset = (file: SessionFile): number =>
  Math.max(-1, ...file.sources.map((source) => source.offset ?? -1));
const newestFirst = (a: SessionFile, b: SessionFile): number =>
  (b.created_at ?? latestOffset(b)) - (a.created_at ?? latestOffset(a)) ||
  a.name.localeCompare(b.name) ||
  a.key.localeCompare(b.key);

/** Newest files first, with published names placed by their newest version. */
export function versionGroups(files: SessionFile[]): SessionFile[][] {
  const groups: SessionFile[][] = [];
  const byName = new Map<string, SessionFile[]>();
  for (const file of files) {
    const name = versionName(file);
    const group = name === null ? undefined : byName.get(name);
    if (group) group.push(file);
    else {
      groups.push([file]);
      if (name !== null) byName.set(name, groups.at(-1)!);
    }
  }
  for (const group of groups) group.sort(newestFirst);
  return groups.sort((a, b) => newestFirst(a[0]!, b[0]!));
}

export function versionLabel(
  file: SessionFile,
  number: number,
  latest: boolean,
) {
  const when = file.created_at
    ? new Date(file.created_at * 1000).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return [`Version ${number}`, when, latest ? "latest" : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Markdown files render as formatted text in the detail view. */
export function rendersAsMarkdown(file: SessionFile): boolean {
  return file.preview === "text" && /\.(?:md|markdown)$/i.test(file.name);
}

/** A file's type in users' words, from its extension and media kind ("PNG
 * image", "MD file"); never a MIME type. Empty without an extension. */
export function fileTypeLabel(name: string, mediaType: string): string {
  const extension = /.\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  if (!extension) return "";
  const kind = /^(image|video|audio)\//.exec(mediaType)?.[1] ?? "file";
  return `${extension.toUpperCase()} ${kind}`;
}

export function fileKindLabel(storage: SessionFile["storage"]): string {
  return storage === "upload" ? "Uploaded" : "Published by agent";
}

interface WatchedTurn {
  turn_id: string;
  open: boolean;
  system?: unknown;
  segments: { assistant?: { attachments?: AgentAttachment[] } | null }[];
}

// Auto-opens only one non-image file published by a turn settling this visit.
// Initial/cache/away-settled rows establish the floor, never trigger opening.
export class SettledTurnFile {
  private cid: string | null = null;
  private fresh = false;
  private baseline: string | null | undefined = undefined;
  private file: string | null = null;

  /** A new visit (a conversation, the draft, or nothing selected). */
  beginVisit(cid: string): void {
    if (cid === this.cid) return;
    this.cid = cid;
    this.fresh = false;
    this.baseline = undefined;
    this.file = null;
  }

  /** The server returned rows for this conversation during the visit. */
  rowsRead(cid: string): void {
    if (cid === this.cid) this.fresh = true;
  }

  observe(cid: string, turns: readonly WatchedTurn[]): void {
    if (cid !== this.cid || !this.fresh) return;
    let turn: WatchedTurn | undefined;
    for (let index = turns.length - 1; index >= 0 && !turn; index--)
      if (
        !turns[index]!.system &&
        (this.baseline !== undefined || !turns[index]!.open)
      )
        turn = turns[index];
    const newest = turn?.turn_id ?? null;
    if (this.baseline === undefined) {
      this.baseline = newest;
      return;
    }
    if (turn?.open || newest === this.baseline) return;
    const files = (turn?.segments ?? [])
      .flatMap((segment) => segment.assistant?.attachments ?? [])
      .filter((file) => !file.inline_media_type);
    const only = files.length === 1 ? files[0]! : null;
    this.file = only?.id && !only.unavailable ? only.id : null;
  }

  /** The attachment id to open for this conversation, or null. */
  current(cid: string): string | null {
    return cid === this.cid ? this.file : null;
  }
}
