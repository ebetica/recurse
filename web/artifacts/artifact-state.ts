// Shared Artifact state, document checks and pane contracts. Owns per-agent
// lists, the immutable content cache and mounted pane holders. State changes
// ask the pane owner to render; features never import through the pane root.
// App startup supplies content rendering before conversation discovery.
import { ArtifactContentCache } from "./content-cache.js";
import {
  isFullVersion,
  type ArtifactInfo,
  type ArtifactVersion,
} from "./model.js";
import type { PreparedCrop } from "./comment-crops.js";
import type { DocumentChanges } from "../document-review.js";

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
  crop?: PreparedCrop;
}
export interface ArtifactState {
  agentId: string | null;
  browsing: boolean;
  filter: string;
  selId: string | null;
  // Consumes lifecycle attention once this agent's async list is known.
  restoredArtifactId?: string | null;
  linkedArtifactId?: string;
  linkedSection?: { artifact: string; fragment: string };
  linkedScrollTop?: number;
  linkedDepth?: number;
  linkedVisit?: number;
  returningVersion?: { version: string | null; followCurrent: boolean };
  selectedVersion: string | null;
  shownKey: string | null;
  loadingKey: string | null;
  failedKey: string | null;
  requestSeq: number;
  revalidationSeq: number;
  revalidating: boolean;
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
  /** Set while the shown document highlights what is new. */
  changes?: DocumentChanges | null;
}
interface CommentDoc {
  id: string;
  owner_agent_id?: string;
  title: string;
  version: string | null;
  noun?: "file";
  path?: string;
}
export interface CommentPane extends HTMLElement {
  _rs: Pick<
    ArtifactState,
    "agentId" | "selId" | "deleting" | "sending" | "sendFailed" | "sendSeq"
  > & { contentInfo: CommentDoc | null };
}
export interface CommentRendering {
  renderBar(pane: CommentPane): void;
  renderComments(pane: CommentPane): void;
}
export function createCommentState(agentId: string): CommentPane["_rs"] {
  return {
    deleting: false,
    sending: false,
    sendFailed: false,
    sendSeq: 0,
    agentId,
    selId: null,
    contentInfo: null,
  };
}
export function displayedInfo(pane: CommentPane): CommentDoc | null {
  const info = pane._rs.contentInfo;
  return info?.id === pane._rs.selId &&
    (info.noun === "file" || isFullVersion(info.version))
    ? info
    : null;
}
export interface ArtifactEl extends HTMLElement {
  _rs: ArtifactState;
  /** Refresh this pane's controls after an action changes its state. */
  renderShell(): void;
  /** Show the selected revision after a list or comment action. */
  showArtifact(): Promise<void>;
}
type ArtifactContentRenderer = (
  pane: ArtifactEl,
  info: ArtifactInfo,
  content: string | null,
  changes: { changes: DocumentChanges; previous: string } | null,
) => Promise<boolean>;
export let renderArtifactContent: ArtifactContentRenderer;
export function configureArtifactRendering(
  render: ArtifactContentRenderer,
): void {
  renderArtifactContent = render;
}
export function setNotice(
  pane: ArtifactEl,
  text: string,
  error: boolean,
): void {
  // Invariant: artifact-shell is wholly owned by Lit. Mutating its rendered
  // notice node destroys Lit's ChildPart markers and makes the next poll crash
  // while patching missing siblings; update state and let the single owner
  // render.
  pane._rs.notice = text;
  pane._rs.noticeError = error;
  pane.renderShell();
}
export const ARTIFACTS_PANE_ID = "report";
export const caches = new Map<string, ListCache>();
// Immutable version/current-revision keys prevent repeat content requests.
export const contentCache = new ArtifactContentCache();
export const artifactMount: { current: ArtifactEl | null } = {
  current: null,
};
