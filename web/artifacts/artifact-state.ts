// Shared Artifacts-pane state and types. This module owns the per-agent list
// caches, the immutable content cache, the mounted pane holder, and the
// shared interfaces; feature modules import from here, never from each other
// through the pane root.
import { ArtifactContentCache } from "./content-cache.js";
import type { ArtifactInfo, ArtifactVersion } from "./model.js";

export interface ListCache {
  list: ArtifactInfo[];
  fetching: boolean;
  invalidated: boolean;
  pending: Promise<void> | null;
  controller: AbortController | null;
  loaded: boolean;
  error: string | null;
  // Retries omitted displayed artifacts without replacing held content.
  selectionStale: boolean;
  // Last settled read time bounds rediscovery of out-of-band changes.
  readAt: number;
}
export interface CommentBox {
  /** One-based PDF page. Coordinates are fractions of the image/page. */
  page?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Comment {
  cid: string;
  agentId: string;
  artifactId: string;
  version: string;
  range: Range;
  quote: string;
  text: string;
  box?: CommentBox;
}
export interface ArtifactState {
  agentId: string | null;
  selId: string | null;
  // Consumes lifecycle attention once this agent's async list is known.
  restoredArtifactId?: string | null;
  linkedArtifactId?: string;
  selectedVersion: string | null;
  shownKey: string | null;
  loadingKey: string | null;
  failedKey: string | null;
  requestSeq: number;
  versionsSeq: number;
  versionsId: string | null;
  versions: ArtifactVersion[];
  versionsLoading: boolean;
  versionsError: boolean;
  sending: boolean;
  sendFailed: boolean;
  sendSeq: number;
  restoring: boolean;
  restoreSeq: number;
  deleting: boolean;
  deleteSeq: number;
  followCurrent: boolean;
  headVersion: string | null;
  justRestored: boolean;
  notice: string;
  noticeError: boolean;
  contentInfo: ArtifactInfo | null;
  versionMenuOpen: boolean;
  imageAbort: AbortController | null;
  refreshKey?: number;
}
export interface CommentDoc {
  id: string;
  owner_agent_id?: string;
  title: string;
  version: string | null;
  noun?: "file";
}
export interface CommentPane extends HTMLElement {
  _rs: Pick<
    ArtifactState,
    "agentId" | "selId" | "deleting" | "sending" | "sendFailed" | "sendSeq"
  > & { contentInfo: CommentDoc | null };
}
export interface ArtifactEl extends HTMLElement {
  _rs: ArtifactState;
}
export const ARTIFACTS_PANE_ID = "report";
export const caches = new Map<string, ListCache>();
// Immutable version/current-revision keys prevent repeat content requests.
export const contentCache = new ArtifactContentCache();
export const artifactMount: { current: ArtifactEl | null } = {
  current: null,
};
/** The pane whose shown document takes the next selection comment. */
export const commentMount: { current: CommentPane | null } = {
  current: null,
};
