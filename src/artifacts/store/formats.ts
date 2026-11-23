// Artifact entry conventions and response formats for committed files.
import { basename, extname } from "node:path";
import { ArtifactInvalid, type ResolvedContext } from "./layout";
import type { TreeRow } from "./refs";

export const APP_ENTRY = "index.html";
export const DOCUMENT_ENTRY = "index.md";
export const SVG_MEDIA_TYPE = "image/svg+xml";

export function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** A document (index.md) or an app (index.html, which wins), or neither. */
export function artifactKind(
  rows: readonly TreeRow[],
): "document" | "app" | null {
  const roots = new Set(rows.map(([name]) => name));
  if (roots.has(APP_ENTRY)) return "app";
  if (roots.has(DOCUMENT_ENTRY)) return "document";
  return null;
}

// Derive the primary file: index conventions, then a lone file, then a root
// file.
export function detectEntry(rows: readonly TreeRow[]): string | null {
  const blobs = rows
    .filter(([name]) => name !== ".artifact.json")
    .map(([name]) => name);
  const roots = blobs.filter((name) => !name.includes("/"));
  for (const candidate of ["index.html", "index.md"]) {
    if (roots.includes(candidate)) return candidate;
  }
  if (blobs.length === 1) return blobs[0]!;
  if (roots.length) return roots.slice().sort(codePointCompare)[0]!;
  return null;
}

const FORMAT_SUFFIXES: Readonly<Record<string, string>> = {
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
};
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mjs": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".py": "text/x-python",
  ".png": "image/png",
  ".sh": "application/x-sh",
  ".svg": SVG_MEDIA_TYPE,
  ".tar": "application/x-tar",
  ".text": "text/plain",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".xml": "text/xml",
  ".zip": "application/zip",
};

export function mediaForName(name: string, inline = false): string {
  const extension = extname(name).toLowerCase();
  if (inline) {
    const images: Readonly<Record<string, string>> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": SVG_MEDIA_TYPE,
    };
    const safeImage = images[extension];
    if (safeImage) return safeImage;
  }
  const guessed = MIME_TYPES[extension] ?? "";
  if (
    guessed &&
    !guessed.startsWith("text/html") &&
    !guessed.startsWith("image/svg") &&
    !guessed.startsWith("application/javascript")
  ) {
    return guessed;
  }
  if (extension === ".svg") return SVG_MEDIA_TYPE;
  if ([".html", ".htm", ".xhtml"].includes(extension)) return "text/html";
  return guessed || "application/octet-stream";
}

export function formatFor(name: string): string {
  const suffix = extname(name).toLowerCase();
  const mapped = FORMAT_SUFFIXES[suffix];
  if (mapped) return mapped;
  if (mediaForName(name, true).startsWith("image/")) return "image";
  return suffix ? "code" : "file";
}

/**
 * The name a create source is stored under: index.md for Markdown and
 * index.html for HTML, so the new Artifact is a document or an app.
 */
export function sourceEntry(ctx: ResolvedContext, source: string): string {
  const name = basename(source);
  if (ctx.anyKind) return name;
  const format = FORMAT_SUFFIXES[extname(name).toLowerCase()];
  if (format === "markdown") return DOCUMENT_ENTRY;
  if (format === "html") return APP_ENTRY;
  throw new ArtifactInvalid(
    `a new Artifact starts from a Markdown (.md) or HTML (.html) file, not ${JSON.stringify(name)}`,
  );
}
