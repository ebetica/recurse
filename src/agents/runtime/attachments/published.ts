// Read-side published references, listings and download headers; the
// collection's identity is checked before every scan.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readdirAt } from "../../../utils/dir_fd";
import {
  AttachmentError,
  ATTACHMENT_REFERENCE_REGEX,
  DRAFT_ATTACHMENT_REGEX,
  FILE_ID_REGEX,
  RUN_ID_REGEX,
  CALL_ID_REGEX,
  type Manifest,
  displayName,
} from "./base";
import { describe, publicMetadata, readDownload } from "./preview";
import {
  collectionIdentityMatches,
  existingForCall,
  iterManifests,
  openCollection,
  readManifest,
} from "./store";

const MAX_PROMPT_IMAGE_BASE64_BYTES = Math.trunc(4.5 * 1024 * 1024);
function textUploadIds(text: string, ...patterns: RegExp[]): string[] {
  if (typeof text !== "string") return [];
  const names: string[] = [];
  for (const pattern of patterns) {
    const regex = new RegExp(
      pattern.source,
      `${pattern.flags.replaceAll("g", "")}g`,
    );
    for (const match of text.matchAll(regex))
      if (match[1] && FILE_ID_REGEX.test(match[1]) && !names.includes(match[1]))
        names.push(match[1]);
  }
  return names;
}
async function resolvedUploads(
  text: string,
  collection: string,
  owner: string,
  attachmentIds: readonly string[] = [],
): Promise<Array<[string, string, Manifest]>> {
  if (typeof collection !== "string") return [];
  const result: Array<[string, string, Manifest]> = [];
  for (const id of new Set([
    ...textUploadIds(text, ATTACHMENT_REFERENCE_REGEX, DRAFT_ATTACHMENT_REGEX),
    ...attachmentIds.filter((id) => FILE_ID_REGEX.test(id)),
  ])) {
    let manifest: Manifest | null;
    try {
      manifest = await describe(collection, owner, id);
    } catch (error) {
      if (error instanceof AttachmentError) continue;
      throw error;
    }
    if (!manifest) continue;
    const blob = join(collection, `${id}.blob`);
    try {
      if ((await lstat(blob)).isFile()) result.push([id, blob, manifest]);
    } catch {}
  }
  return result;
}
export async function uploadDiskPaths(
  text: string,
  collection: string,
  owner: string,
): Promise<string[]> {
  return (await resolvedUploads(text, collection, owner)).map(
    ([, path]) => path,
  );
}
export async function uploadPromptParts(
  text: string,
  collection: string,
  owner: string,
  attachmentIds: readonly string[] = [],
): Promise<
  [string[], Array<{ type: "image"; data: string; mimeType: string }>]
> {
  const paths: string[] = [],
    images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  let encodedBytes = 0;
  for (const [id, path, manifest] of await resolvedUploads(
    text,
    collection,
    owner,
    attachmentIds,
  )) {
    paths.push(path);
    const media = manifest.inline_media_type;
    if (typeof media !== "string") continue;
    try {
      // Invariant: An image too large for the prompt budget is skipped unread.
      const [stored, data] = await readDownload(
        collection,
        owner,
        id,
        Math.floor((MAX_PROMPT_IMAGE_BASE64_BYTES * 3) / 4),
      );
      if (stored.inline_media_type !== media) continue;
      const encoded = Math.floor((data.length + 2) / 3) * 4;
      if (encodedBytes + encoded >= MAX_PROMPT_IMAGE_BASE64_BYTES) continue;
      encodedBytes += encoded;
      images.push({
        type: "image",
        data: Buffer.from(data).toString("base64"),
        mimeType: media,
      });
    } catch {}
  }
  return [paths, images];
}
export async function rewriteUploadUrls(
  text: string,
  collection: string,
  owner: string,
  baseUrl: string,
): Promise<string> {
  if (typeof collection !== "string") return text;
  for (const id of textUploadIds(text, ATTACHMENT_REFERENCE_REGEX)) {
    try {
      if (await describe(collection, owner, id))
        text = text.replaceAll(
          `/api/attachments/${id}`,
          () => `${baseUrl}/${id}`,
        );
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
    }
  }
  for (const id of textUploadIds(text, DRAFT_ATTACHMENT_REGEX)) {
    try {
      if (await describe(collection, owner, id))
        text = text.replace(
          new RegExp(
            `/api/attachment-drafts/[a-f0-9]{32}/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            "g",
          ),
          () => `${baseUrl}/${id}`,
        );
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
    }
  }
  return text;
}
export async function forCall(
  collection: string,
  owner: string,
  runId: string,
  toolCallId: string,
): Promise<Manifest | null> {
  if (!RUN_ID_REGEX.test(runId || "") || !CALL_ID_REGEX.test(toolCallId || ""))
    return null;
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd))) return null;
      const manifest = await existingForCall(
        fd,
        owner,
        runId,
        toolCallId,
        true,
      );
      return manifest ? publicMetadata(manifest) : null;
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error instanceof AttachmentError) return null;
    throw error;
  }
}
export async function lookupByCall(
  collection: string,
  owner: string,
  toolCallId: string,
): Promise<Manifest | null> {
  if (!CALL_ID_REGEX.test(toolCallId || "")) return null;
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd))) return null;
      for (const [, manifest] of await iterManifests(fd, owner))
        if (manifest.tool_call_id === toolCallId && manifest.published === true)
          return publicMetadata(manifest);
      return null;
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error instanceof AttachmentError) return null;
    throw error;
  }
}
export async function publishedCallIndex(
  collection: string,
  owner: string,
): Promise<Record<string, Manifest>> {
  const index: Record<string, Manifest> = Object.create(null);
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd))) return index;
      for (const [, manifest] of await iterManifests(fd, owner)) {
        const call = manifest.tool_call_id;
        if (
          manifest.published === true &&
          typeof call === "string" &&
          !Object.hasOwn(index, call)
        )
          index[call] = publicMetadata(manifest);
      }
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (!(error instanceof AttachmentError)) throw error;
  }
  return index;
}
// Every published file per tool call, oldest first: a bash call may publish
// many.
export async function publishedCallFiles(
  collection: string,
  owner: string,
): Promise<Record<string, Manifest[]>> {
  const index: Record<string, Manifest[]> = Object.create(null);
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd))) return index;
      const manifests = (await iterManifests(fd, owner))
        .map(([, manifest]) => manifest)
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));
      for (const manifest of manifests) {
        const call = manifest.tool_call_id;
        if (manifest.published === true && typeof call === "string")
          (index[call] ??= []).push(publicMetadata(manifest));
      }
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (!(error instanceof AttachmentError)) throw error;
  }
  return index;
}
export async function publishedFiles(
  collection: string,
  owner: string,
  source?: string | null,
): Promise<Manifest[]> {
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd))) return [];
      return (await iterManifests(fd, owner))
        .filter(
          ([, manifest]) =>
            manifest.published === true &&
            (source == null || manifest.source === source),
        )
        .map(([, manifest]) => publicMetadata(manifest));
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error instanceof AttachmentError) return [];
    throw error;
  }
}
const PAGE_DEBRIS_SLACK = 64;
// Bounded manifest attempts, with honest truncation for debris/foreign rows.
export async function publishedPage(
  collection: string,
  owner: string,
  limit: number,
): Promise<[Manifest[], boolean]> {
  const rows: Manifest[] = [];
  try {
    const fd = await openCollection(collection);
    try {
      if (!(await collectionIdentityMatches(collection, fd)))
        return [rows, false];
      let names: string[];
      try {
        names = await readdirAt(fd.fd);
      } catch {
        return [rows, false];
      }
      let reads = 0;
      for (const name of names) {
        if (rows.length >= limit || reads >= limit + PAGE_DEBRIS_SLACK)
          return [rows, true];
        if (!name.endsWith(".json") || !FILE_ID_REGEX.test(name.slice(0, -5)))
          continue;
        reads++;
        const manifest = await readManifest(fd, owner, name.slice(0, -5));
        if (manifest?.published === true) rows.push(publicMetadata(manifest));
      }
      return [rows, false];
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error instanceof AttachmentError) return [rows, false];
    throw error;
  }
}
// RFC 6266 fallback plus UTF-8 filename* (Python urllib.parse.quote safe set).
export function contentDisposition(name: string): string {
  const safe = displayName(name);
  let ascii =
    safe
      .normalize("NFKD")
      .replace(/[^\x00-\x7f]/g, "")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .replace(/^[ .]+|[ .]+$/g, "") || "download";
  ascii = Array.from(ascii).slice(0, 100).join("").replaceAll('"', "_");
  const quoted = encodeURIComponent(safe)
    .replace(
      /[!'()*]/g,
      (char) => `\x25${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%([0-9a-f]{2})/g, (_, code: string) => `%${code.toUpperCase()}`)
    .replace(/%(21|23|24|26|2B|2D|2E|5E|5F|60|7C|7E)/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${quoted}`;
}
