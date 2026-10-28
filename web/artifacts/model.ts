// Pure immutable-version, URL and sandbox helpers for Artifact panes.
// HTML has an opaque origin: scripts cannot reach the app session, and CSP
// blocks network, navigation and embedding. Untrusted error relays are text.

import { backendFor, parseConversationId } from "../backends/backend.js";
import { ARTIFACT_KEY_RELAY } from "../../src/artifacts/key_relay.js";
import { artifactWorkingPath } from "../../src/artifacts/working_path.js";

export type ArtifactStatus = "draft" | "ready" | "error";
export type ArtifactFormat =
  | "markdown"
  | "html"
  | "text"
  | "code"
  | "image"
  | "pdf"
  | "file";

export interface ArtifactInfo {
  id: string;
  owner_agent_id?: string;
  title: string;
  kind: string;
  format: ArtifactFormat;
  status: ArtifactStatus;
  entry: string | null;
  filename: string;
  version: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersion {
  version: string;
  created_at: string;
  message: string;
  status: ArtifactStatus;
}

// Iframe event targets cross realms; parent-window instanceof is unsafe.
export const COMMENT_ELEMENT_SELECTOR =
  ".artifact-file-card, img, figure, article, section, [role], h1, h2, h3, h4, h5, h6";

type CommentTargetLike = {
  nodeType?: unknown;
  parentElement?: CommentTargetLike | null;
  parentNode?: CommentTargetLike | null;
  closest?: (selectors: string) => CommentTargetLike | null;
};

export function closestCommentElement<T = CommentTargetLike>(
  target: unknown,
  selectors = COMMENT_ELEMENT_SELECTOR,
): T | null {
  let value = target as CommentTargetLike | null;
  if (value?.nodeType === 3)
    value = value.parentElement || value.parentNode || null;
  if (!value || value.nodeType !== 1 || typeof value.closest !== "function")
    return null;
  return value.closest(selectors) as T | null;
}

const FORMATS = new Set<ArtifactFormat>([
  "markdown",
  "html",
  "text",
  "code",
  "image",
  "pdf",
  "file",
]);
const STATUSES = new Set<ArtifactStatus>(["draft", "ready", "error"]);
const SHA_RE = /^[0-9a-f]{40}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

export function normalizeArtifactInfo(value: unknown): ArtifactInfo | null {
  const obj = record(value);
  if (
    !obj ||
    typeof obj.id !== "string" ||
    !obj.id ||
    typeof obj.title !== "string"
  )
    return null;
  return {
    id: obj.id,
    ...(typeof obj.owner_agent_id === "string"
      ? { owner_agent_id: obj.owner_agent_id }
      : {}),
    title: obj.title,
    kind: typeof obj.kind === "string" && obj.kind ? obj.kind : "artifact",
    format: FORMATS.has(obj.format as ArtifactFormat)
      ? (obj.format as ArtifactFormat)
      : "file",
    status: STATUSES.has(obj.status as ArtifactStatus)
      ? (obj.status as ArtifactStatus)
      : "error",
    entry: typeof obj.entry === "string" && obj.entry ? obj.entry : null,
    filename:
      typeof obj.filename === "string" && obj.filename
        ? obj.filename
        : "artifact",
    version:
      typeof obj.version === "string" && SHA_RE.test(obj.version)
        ? obj.version.toLowerCase()
        : null,
    created_at: isoTime(obj.created_at),
    updated_at: isoTime(obj.updated_at),
  };
}

export function normalizeArtifactList(payload: unknown): ArtifactInfo[] {
  const wrapped = record(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(wrapped?.artifacts)
      ? wrapped.artifacts
      : [];
  const list = raw
    .map(normalizeArtifactInfo)
    .filter((item): item is ArtifactInfo => !!item);
  return list.sort(
    (a, b) =>
      Date.parse(b.updated_at || b.created_at || "1970-01-01") -
      Date.parse(a.updated_at || a.created_at || "1970-01-01"),
  );
}

export function normalizeArtifactVersions(payload: unknown): ArtifactVersion[] {
  const wrapped = record(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(wrapped?.versions)
      ? wrapped.versions
      : [];
  const versions: ArtifactVersion[] = [];
  for (const item of raw) {
    const obj = record(item);
    const version =
      typeof obj?.version === "string" && SHA_RE.test(obj.version)
        ? obj.version.toLowerCase()
        : null;
    if (!version) continue;
    const status = STATUSES.has(obj?.status as ArtifactStatus)
      ? (obj!.status as ArtifactStatus)
      : "ready";
    const message = typeof obj?.message === "string" ? obj.message : "";
    versions.push({
      version,
      created_at: isoTime(obj?.created_at || obj?.updated_at),
      message,
      status,
    });
  }
  versions.sort(
    (a, b) =>
      Date.parse(b.created_at || "1970-01-01") -
      Date.parse(a.created_at || "1970-01-01"),
  );
  return versions.filter(
    (item, index) =>
      versions.findIndex((v) => v.version === item.version) === index,
  );
}

function artifactPath(id: string, suffix = ""): string {
  return `/api/artifacts/${encodeURIComponent(id)}${suffix}`;
}

function query(
  agentId: string,
  version?: string | null,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams({
    agent: parseConversationId(agentId).cid,
  });
  if (version) params.set("version", version);
  for (const [key, value] of Object.entries(extra || {}))
    params.set(key, value);
  return `?${params.toString()}`;
}

export const artifactListUrl = (agentId: string): string =>
  backendFor(agentId).url(
    `/api/artifacts?agent=${encodeURIComponent(parseConversationId(agentId).cid)}`,
  );
export const artifactFileUrl = (
  agentId: string,
  id: string,
  path: string,
  version?: string | null,
  download = false,
): string =>
  backendFor(agentId).url(
    artifactPath(id, "/file") +
      query(agentId, version, { path, ...(download ? { download: "1" } : {}) }),
  );
/** The running page of an HTML Artifact, as built at publish. */
export const artifactPageUrl = (
  agentId: string,
  id: string,
  version?: string | null,
): string =>
  backendFor(agentId).url(artifactPath(id, "/page") + query(agentId, version));
export const artifactVersionsUrl = (agentId: string, id: string): string =>
  backendFor(agentId).url(artifactPath(id, "/versions") + query(agentId));
export const artifactRestoreUrl = (id: string): string =>
  artifactPath(id, "/restore");
export const artifactDeleteUrl = (id: string): string => artifactPath(id);

export function selectedVersion(
  info: ArtifactInfo,
  requested: string | null,
): string | null {
  return requested && SHA_RE.test(requested)
    ? requested.toLowerCase()
    : info.version;
}

export function isFullVersion(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

export function isSafeRasterFilename(filename: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(filename);
}

export interface ArtifactImagePreviewTarget {
  url: string;
  alt: string;
}

export function artifactImagePreviewTarget(
  agentId: string | null,
  selectedId: string | null,
  info: Pick<ArtifactInfo, "id" | "title" | "format" | "filename" | "version">,
  selectedVersion: string | null,
): ArtifactImagePreviewTarget | null {
  if (
    !agentId ||
    selectedId !== info.id ||
    selectedVersion !== info.version ||
    info.format !== "image" ||
    !isSafeRasterFilename(info.filename)
  )
    return null;
  return {
    url: artifactFileUrl(agentId, info.id, info.filename, selectedVersion),
    alt: info.title.trim() || info.filename || "Artifact image",
  };
}

export function externalHttpHostname(value: string | null): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

// Opaque-origin sandbox CSP blocks network, navigation and embedding.
export const URL_ATTRIBUTES = new Set([
  "action",
  "archive",
  "attributionsrc",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);

export const STATIC_EMBED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'none'; media-src 'none'; connect-src 'none'; font-src 'none'; " +
  "frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'; " +
  "base-uri 'none'; form-action 'none'; navigate-to 'none'";

export function htmlPreviewSrcdoc(source: string): string {
  // Invariant: This CSP is the first parsed element; a document cannot weaken
  // it.
  return (
    `<meta http-equiv="Content-Security-Policy" content="${STATIC_EMBED_CSP}">` +
    `<meta name="color-scheme" content="dark light">` +
    `<style>html,body{margin:0;max-width:100%;overflow-wrap:anywhere}` +
    `body{box-sizing:border-box;padding:8px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}` + // font-check: allow Artifact document text, not UI; space-check: allow no theme tokens in the iframe
    `pre,table{display:block;max-width:100%;overflow:auto}</style>` +
    ARTIFACT_KEY_RELAY +
    source
  );
}

export function versionLabel(
  item: ArtifactVersion,
  current: string | null,
): string {
  const stamp = item.created_at
    ? new Date(item.created_at).toLocaleString()
    : "Unknown time";
  const message = item.message.trim();
  return `${item.version.slice(0, 8)} · ${stamp}${message ? ` · ${message}` : ""}${item.version === current ? " · current" : ""}`;
}

// Untrusted page-error relays keep only a short string displayed as text.
export const MAX_PAGE_ERRORS = 20;
const MAX_PAGE_ERROR_CHARS = 300;

export function pageErrorText(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { recurseArtifactError?: unknown })
    .recurseArtifactError;
  if (typeof value !== "string") return null;
  const line = value.trim().split("\n", 1)[0].trim();
  if (!line) return null;
  return line.length > MAX_PAGE_ERROR_CHARS
    ? `${line.slice(0, MAX_PAGE_ERROR_CHARS - 1)}…`
    : line;
}

/** The message "Send to agent" delivers for a page's errors. */
export function pageErrorReport(
  info: Pick<ArtifactInfo, "id" | "title" | "owner_agent_id">,
  version: string,
  errors: readonly string[],
): string {
  return [
    `The app Artifact "${info.title}" (id: ${info.id}, version: ${version}) raised errors in the Artifacts pane:`,
    ...errors.map((error) => `- ${error}`),
    "",
    info.owner_agent_id
      ? `Edit the files at ${artifactWorkingPath(info.owner_agent_id, info.id)} and git commit to publish and rerun the app check. Read the hook's check output and screenshots.`
      : "Use artifact list to find the working path, edit its files and git commit to publish and rerun the app check.",
  ].join("\n");
}
