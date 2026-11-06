// Operator-only local images are bounded snapshots, never live file streams.
// Sniff the returned bytes, not filenames; SVG requires a recognizable XML root
// and is served only with the existing scriptless SVG sandbox policy.

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { inlineRasterMediaType } from "../agents/runtime/attachments/base";
import { HttpError } from "./router";

/** Expand only the current user's home shorthand; other paths use the cwd. */
function imagePath(cwd: string, path: string): string {
  if (!path || path.includes("\0")) throw new HttpError(404, "image not found");
  return path === "~" || path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : resolve(cwd, path);
}

/** Recognize an SVG root, refusing document types and entity declarations. */
function svgSnapshot(data: Uint8Array, location: string): boolean {
  if (extname(location).toLowerCase() !== ".svg") return false;
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(data).trim();
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return false;
    if (/^<\?xml[\t\n\r ]/.test(text)) {
      const declaration = text.indexOf("?>");
      if (declaration < 0) return false;
      text = text.slice(declaration + 2).trimStart();
    }
    if (!/^<svg[\t\n\r />]/.test(text)) return false;
    const end = text.indexOf(">");
    if (end < 0) return false;
    return text[end - 1] === "/"
      ? text.slice(end + 1).trim() === ""
      : /<\/svg[\t\n\r ]*>$/.test(text);
  } catch {
    return false;
  }
}

/** Read a regular file through a nonblocking handle and validate its bytes. */
export async function readPathImage(
  cwd: string,
  path: string,
  document: string | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; media: string; name: string }> {
  const location = imagePath(
    document ? dirname(imagePath(cwd, document)) : cwd,
    path,
  );
  let handle;
  try {
    handle = await open(
      location,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile()) throw new HttpError(404, "image not found");
    if (before.size > maxBytes)
      throw new HttpError(413, "image too large (max 25 MB)");
    const buffer = new Uint8Array(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      if (signal.aborted) throw new HttpError(499, "request cancelled");
      const { bytesRead } = await handle.read(
        buffer,
        length,
        Math.min(64 * 1024, buffer.length - length),
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new HttpError(404, "image changed while reading; retry");
    const data = buffer.subarray(0, length);
    const media =
      inlineRasterMediaType(data) ??
      (svgSnapshot(data, location) ? "image/svg+xml" : null);
    if (!media)
      throw new HttpError(
        415,
        "Only PNG, JPEG, GIF, WebP and recognizable SVG images are supported.",
      );
    return { data, media, name: basename(location) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "image not found");
  } finally {
    await handle?.close().catch(() => {});
  }
}
