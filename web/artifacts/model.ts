// Immutable-version and URL helpers for Artifact panes.
// Untrusted error relays are displayed as text.

import { backendFor } from "../backends/backend.js";
import { parseConversationId } from "../backends/conversation-id/index.js";
import { artifactWorkingPath } from "../../src/artifacts/working_path.js";

type ArtifactStatus = "draft" | "ready" | "error";
type ArtifactFormat =
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

function normalizeArtifactInfo(value: unknown): ArtifactInfo | null {
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

export const isMarkdownPath = (path: string): boolean =>
  /\.(md|markdown)$/i.test(path);

export function artifactRelativePath(
  entry: string,
  path: string,
): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(path.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  if (!pathname || pathname.startsWith("/") || pathname.includes("\\"))
    return null;
  const parts = entry.split("/").slice(0, -1);
  for (const part of pathname.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || null;
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

export const artifactListUrl = (
  agentId: string,
  selected?: string | null,
): string =>
  backendFor(agentId).url(
    `/api/artifacts?agent=${encodeURIComponent(parseConversationId(agentId).cid)}` +
      (selected ? `&selected=${encodeURIComponent(selected)}` : ""),
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
export const artifactAppStatePath = (agentId: string, id: string): string =>
  artifactPath(id, "/app-state") + query(agentId);
export const artifactVersionsUrl = (agentId: string, id: string): string =>
  backendFor(agentId).url(artifactPath(id, "/versions") + query(agentId));
export const artifactRestoreUrl = (id: string): string =>
  artifactPath(id, "/restore");
export const artifactDeleteUrl = (id: string): string => artifactPath(id);

export function isFullVersion(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

export function isSafeRasterFilename(filename: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(filename);
}

interface ArtifactImagePreviewTarget {
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
