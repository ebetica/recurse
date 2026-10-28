// Owner-scoped files: foreign owner is 404; draft tokens scope staged uploads.
// Inert downloads; raster/media previews use a scriptless sandbox.
// Active HTML/SVG Artifacts use sandbox CSP; relays never change stored bytes.
// Bound upload bodies before multipart parsing; routes only delegate storage.

import { basename, extname } from "node:path";
import { timingDetail, timingFailure } from "../observability/request_timing";

import * as artifacts from "../artifacts";
import { artifactPreview } from "../artifacts/preview";
import { themedHtml } from "../artifacts/theme";
import { readTheme } from "../themes";
import type { ArtifactContext } from "../artifacts";
import {
  AttachmentError,
  inlineMediaType,
  inlineRasterMediaType,
  type Manifest,
} from "../agents/runtime/attachments/base";
import type { OpenedDownload } from "../agents/runtime/attachments/preview";
import { contentDisposition } from "../agents/runtime/attachments/published";
import { parsePythonJson } from "../utils/py_compact_json";
import { parseUrlencoded } from "./login";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";
import { rangedResponse, type OpenedFile } from "./static";

/** Image extensions render inline; any other upload is a download. */
export const ATTACH_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** Previews run no script; an SVG may also use inline styles and data: URLs. */
const PREVIEW_CSP = "default-src 'none'; sandbox";
const SVG_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
// Owner-bound, attacker-influenced bytes: never shared-cached or re-sniffed.
export const ARTIFACT_SAFE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
export const ARTIFACT_INLINE_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/markdown",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
]);
/** Opaque-origin sandbox: live scripts never reach the app session. */
export const ARTIFACT_AGENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Starlette's MultiPartParser max_part_size for non-file fields. */
export const MULTIPART_FIELD_MAX_BYTES = 1024 * 1024;
/** Starlette's max_files and max_fields. */
export const MULTIPART_MAX_ITEMS = 1000;
/** Upload bodies past one maximal file plus 1 MiB of form are refused. */
export const UPLOAD_BODY_MAX_BYTES = ATTACH_MAX_BYTES + 1024 * 1024;

type Status<T> = readonly [number, T];
type Rec = Record<string, unknown>;

export interface FilesRoutesDeps {
  readonly themesFile: string;
  /** 503 `service_storage_unavailable` + Retry-After until action-ready. */
  requireActionReady(): void;
  readonly drafts: {
    createAttachmentDraft(): Promise<{ id: string }>;
    abandonAttachmentDraft(token: unknown): Promise<boolean>;
    readDraftFile(token: unknown, aid: string): Promise<[Manifest, Uint8Array]>;
    addDraftUpload(
      token: unknown,
      data: Uint8Array,
      filename: string,
    ): Promise<Manifest>;
    releaseDraftFile(token: unknown, aid: string): Promise<boolean>;
  };
  /** SupervisorReads file composition and supervisor upload admission. */
  readonly files: {
    admitConversationUpload(
      owner: string | null,
      data: Uint8Array,
      filename: string,
    ): Promise<Record<string, unknown>>;
    /** The caller closes the returned blob. */
    composeFileDownload(
      cid: string,
      aid: string,
    ): Promise<Status<OpenedDownload | null>>;
    composeFileDelete(cid: string, aid: string): Promise<Status<boolean>>;
  };
  readonly nodes: {
    existing(
      cid: string,
    ): { releaseAttachment(aid: string): Promise<boolean> } | null;
  };
  readonly artifacts: ArtifactContext;
  /** mutation_guard.mutate_external_storage: run under the lifecycle lease. */
  mutateExternalStorage<T>(work: () => Promise<T>): Promise<T>;
  /** mutation_guard._to_thread_fenced. */
  fenced<T>(work: () => Promise<T>): Promise<T>;
  /** supervisor.deliver(owner, text, start=False, source/origin=platform). */
  deliverPlatformNote(owner: string, text: string): Promise<unknown>;
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";
/** Python str(KeyError(message)). */
const keyErrorText = (error: Error) =>
  /^'.*'$/s.test(error.message) ? error.message : `'${error.message}'`;

/** Map a store AttachmentError to its honest HTTP status. */
export function attachmentErrorResponse(error: Error): HttpError {
  const text = error.message;
  if (text.includes("unavailable"))
    return new HttpError(503, "service_storage_unavailable");
  if (
    text.includes("too large") ||
    text.includes("instance") ||
    text.includes("limit")
  )
    return new HttpError(413, text);
  return new HttpError(422, text);
}

/** Translate storage failures without leaking repositories or paths. */
export function artifactFailure(error: unknown): never {
  if (error instanceof artifacts.ArtifactError) {
    timingFailure(error);
    timingDetail("artifact_error", error.name);
    timingDetail(
      "artifact_reason",
      error.message.includes("timed out")
        ? "git_timeout"
        : error.message.includes("hook already exists")
          ? "existing_hook"
          : error.message.includes("Git operation failed")
            ? "git_failed"
            : "storage_or_validation",
    );
  }
  if (error instanceof artifacts.ArtifactNotFound)
    throw new HttpError(404, "artifact not found");
  if (error instanceof artifacts.ArtifactConflict)
    throw new HttpError(409, error.message);
  if (error instanceof artifacts.ArtifactLimit)
    throw new HttpError(413, error.message);
  if (error instanceof artifacts.ArtifactInvalid)
    throw new HttpError(400, error.message);
  if (error instanceof artifacts.ArtifactCorrupt)
    throw new HttpError(409, "artifact is corrupt or unavailable");
  throw error;
}

export function artifactOwner(agent: unknown): string {
  if (typeof agent !== "string" || !ARTIFACT_AGENT_RE.test(agent))
    throw new HttpError(404, "artifact owner not found");
  return agent;
}

/** Conservative ASCII attachment filename; never an internal storage path. */
export function artifactFilename(name: string): string {
  const base = basename(name || "artifact");
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 180);
  return safe || "artifact";
}

export function artifactDeletionMessage(result: Rec): string {
  return (
    `[Artifact deleted] “${String(result.title)}” ` +
    `(id: ${String(result.id)}, version: ${String(result.version)}) was deleted. ` +
    "Do not recreate it unless the operator explicitly asks."
  );
}

/** Durably notify, then retire the tombstone for background sweeping. */
export async function finishArtifactDeletion(
  deps: Pick<
    FilesRoutesDeps,
    "artifacts" | "mutateExternalStorage" | "deliverPlatformNote"
  >,
  result: Rec,
): Promise<boolean> {
  const owner = String(result.owner_agent_id);
  if (result.notification_pending)
    await deps.mutateExternalStorage(() =>
      deps.deliverPlatformNote(owner, artifactDeletionMessage(result)),
    );
  return deps.mutateExternalStorage(() =>
    artifacts.finalizeDelete(
      deps.artifacts,
      owner,
      String(result.id),
      String(result.deletion_id),
    ),
  );
}

/** Starlette Response: text/* media types gain `; charset=utf-8`. */
function mediaHeader(media: string): string {
  return media.startsWith("text/") && !media.includes("charset=")
    ? `${media}; charset=utf-8`
    : media;
}

function bytesResponse(
  data: Uint8Array,
  media: string,
  headers: Record<string, string>,
): Response {
  return new Response(data as Uint8Array<ArrayBuffer>, {
    headers: {
      ...headers,
      "content-length": String(data.byteLength),
      "content-type": mediaHeader(media),
    },
  });
}

/** Files up to this size are answered from memory, keeping Content-Length. */
export const BUFFERED_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A checked download's body: small files are read whole and closed; larger
 * ones are streamed from the open blob, which the response then closes.
 */
async function servedBody(
  opened: OpenedDownload,
): Promise<Uint8Array | OpenedFile> {
  if (opened.size > BUFFERED_DOWNLOAD_MAX_BYTES)
    return { handle: opened.blob, size: opened.size };
  try {
    const data = new Uint8Array(opened.size);
    for (let at = 0; at < data.length; ) {
      const { bytesRead } = await opened.blob.read(
        data,
        at,
        data.length - at,
        at,
      );
      if (!bytesRead) throw new HttpError(404, "attachment not found");
      at += bytesRead;
    }
    return data;
  } finally {
    await opened.blob.close();
  }
}

/** Python urllib.parse.quote(text, safe=""). */
function quoteAll(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface FormFile {
  readonly filename: string;
  readonly data: Uint8Array;
}
export type FormValue = string | FormFile;

/** python-multipart parse_options_header for one header value. */
function headerOptions(value: string): [string, Map<string, string>] {
  const options = new Map<string, string>();
  const parts = value.match(/(?:[^;"]|"(?:\\.|[^"\\])*")+/g) ?? [];
  const main = (parts.shift() ?? "").trim().toLowerCase();
  for (const raw of parts) {
    const at = raw.indexOf("=");
    if (at === -1) continue;
    const key = raw.slice(0, at).trim().toLowerCase();
    let item = raw.slice(at + 1).trim();
    if (item.length >= 2 && item.startsWith('"') && item.endsWith('"'))
      item = item.slice(1, -1).replace(/\\(.)/g, "$1");
    options.set(key, item);
  }
  return [main, options];
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number) {
  const buffer = Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.length,
  );
  return buffer.indexOf(needle as Uint8Array<ArrayBuffer>, from);
}

/** Starlette `_user_safe_decode`: UTF-8, else latin-1. */
function fieldText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return Buffer.from(data).toString("latin1");
  }
}

/** Read a body, refusing with 413 once it passes `max` bytes. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "file too large (max 25 MB)");
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Starlette's form for one request body, as FastAPI saw it. */
export async function parseForm(
  ex: Exchange,
  maxBytes = UPLOAD_BODY_MAX_BYTES,
): Promise<Map<string, FormValue[]>> {
  const header = ex.request.headers.get("content-type") ?? "";
  const [type, options] = headerOptions(header);
  const body = await readCapped(ex.request, maxBytes);
  const form = new Map<string, FormValue[]>();
  const add = (name: string, value: FormValue) =>
    form.set(name, [...(form.get(name) ?? []), value]);
  if (type === "application/x-www-form-urlencoded") {
    for (const [name, value] of parseUrlencoded(body)) add(name, value);
    return form;
  }
  if (type !== "multipart/form-data") return form;
  const boundary = options.get("boundary");
  if (!boundary) throw new HttpError(400, "Missing boundary in multipart.");
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const encoder = new TextEncoder();
  let at = indexOf(body, delimiter, 0);
  let files = 0;
  let fields = 0;
  while (at !== -1) {
    let start = at + delimiter.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const next = indexOf(body, encoder.encode(`\r\n--${boundary}`), start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    const split = indexOf(part, encoder.encode("\r\n\r\n"), 0);
    const head =
      split === -1 ? "" : Buffer.from(part.subarray(0, split)).toString("utf8");
    const data = split === -1 ? new Uint8Array() : part.subarray(split + 4);
    let disposition = "";
    for (const line of head.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      if (line.slice(0, colon).trim().toLowerCase() === "content-disposition")
        disposition = line.slice(colon + 1).trim();
    }
    const [, params] = headerOptions(disposition);
    const name = params.get("name");
    if (name !== undefined) {
      const filename = params.get("filename");
      if (filename !== undefined) {
        if (++files > MULTIPART_MAX_ITEMS)
          throw new HttpError(
            400,
            `Too many files. Maximum number of files is ${MULTIPART_MAX_ITEMS}.`,
          );
        add(name, { filename, data: data.slice() });
      } else {
        if (++fields > MULTIPART_MAX_ITEMS)
          throw new HttpError(
            400,
            `Too many fields. Maximum number of fields is ${MULTIPART_MAX_ITEMS}.`,
          );
        if (data.length > MULTIPART_FIELD_MAX_BYTES)
          throw new HttpError(400, "Part exceeded maximum size of 1024KB.");
        add(name, fieldText(data));
      }
    }
    at = next + 2;
  }
  return form;
}

/** FastAPI `file: UploadFile = File(...)`. */
function formFile(form: Map<string, FormValue[]>): FormFile {
  const value = form.get("file")?.at(-1);
  if (value === undefined)
    throw new HttpError(422, [
      {
        type: "missing",
        loc: ["body", "file"],
        msg: "Field required",
        input: null,
      },
    ]);
  if (typeof value === "string")
    throw new HttpError(422, [
      {
        type: "value_error",
        loc: ["body", "file"],
        msg: "Value error, Expected UploadFile, received: <class 'str'>",
        input: value,
        ctx: { error: {} },
      },
    ]);
  return value;
}

/** FastAPI `name: str | None = Form(None)`; an uploaded file is not a str. */
function formString(form: Map<string, FormValue[]>, name: string) {
  const value = form.get(name)?.at(-1);
  return typeof value === "string" ? value : null;
}

/** Starlette `await request.json()`; any failure is the caller's answer. */
async function requestJson(ex: Exchange, failure: HttpError): Promise<Rec> {
  let payload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await ex.request.arrayBuffer(),
    );
    payload = parsePythonJson(text);
  } catch {
    throw failure;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw failure;
  return payload as Rec;
}

const str = (ex: Exchange, name: string) => {
  const value = ex.query[name];
  return value === null || value === undefined ? null : String(value);
};

export function registerFileRoutes(
  router: Router,
  deps: FilesRoutesDeps,
): void {
  const ok = () => jsonResponse({ ok: true });

  router.post("/api/attachment-drafts", async () => {
    // Invariant: Staging for uploads made before the frontend draft has a
    // conversation id; gated so staging never races the startup scratch sweep.
    deps.requireActionReady();
    try {
      return jsonResponse(
        await deps.mutateExternalStorage(() =>
          deps.drafts.createAttachmentDraft(),
        ),
      );
    } catch (error) {
      if (error instanceof AttachmentError)
        throw new HttpError(413, error.message);
      throw error;
    }
  });

  router.delete("/api/attachment-drafts/{token}", async (ex) => {
    let removed: boolean;
    try {
      removed = await deps.mutateExternalStorage(() =>
        deps.drafts.abandonAttachmentDraft(ex.params.token),
      );
    } catch (error) {
      if (errorName(error) === "ValueError")
        throw new HttpError(400, "bad attachment draft");
      throw error;
    }
    if (!removed) throw new HttpError(404);
    return ok();
  });

  router.add(
    ["GET", "HEAD"],
    "/api/attachment-drafts/{token}/{aid}",
    async (ex) => {
      // Invariant: Staged files render from their draft until transfer adopts
      // them.
      const { token, aid } = ex.params as { token: string; aid: string };
      let manifest: Manifest;
      let data: Uint8Array;
      try {
        [manifest, data] = await deps.drafts.readDraftFile(token, aid);
      } catch (error) {
        if (["KeyError", "ValueError"].includes(errorName(error)))
          throw new HttpError(404, "attachment not found");
        throw error;
      }
      const name = String(manifest.name || aid);
      const ext = extname(name).replace(/^\./, "").toLowerCase();
      const headers: Record<string, string> = {
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      };
      if (ext && Object.hasOwn(ATTACH_TYPES, ext))
        return bytesResponse(data, ATTACH_TYPES[ext]!, headers);
      const filename = basename(name) || aid;
      headers["content-disposition"] =
        `attachment; filename*=utf-8''${quoteAll(filename)}`;
      return bytesResponse(data, "application/octet-stream", headers);
    },
  );

  router.post(
    "/api/attachments",
    async (ex) => {
      const form = await parseForm(ex);
      const file = formFile(form);
      const owner = formString(form, "owner");
      const draft = formString(form, "draft");
      const data = file.data;
      if (data.length > ATTACH_MAX_BYTES)
        throw new HttpError(413, "file too large (max 25 MB)");
      if (!data.length) throw new HttpError(400, "empty file");
      if (Boolean(owner) === Boolean(draft))
        throw new HttpError(422, "exactly one attachment owner is required");
      // Invariant: Refuse while the startup projection is not finalized, before
      // any work.
      deps.requireActionReady();
      let saved: Rec;
      let url: string;
      try {
        if (draft) {
          saved = await deps.fenced(() =>
            deps.drafts.addDraftUpload(draft, data, file.filename),
          );
          url = `/api/attachment-drafts/${draft}/${String(saved.id)}`;
        } else {
          saved = await deps.files.admitConversationUpload(
            owner,
            data,
            file.filename,
          );
          url = `/api/conversations/${owner}/attachments/${String(saved.id)}`;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "KeyError")
          throw new HttpError(404, keyErrorText(error));
        if (error instanceof AttachmentError)
          throw attachmentErrorResponse(error);
        throw error;
      }
      return jsonResponse({
        id: saved.id,
        url,
        filename: saved.name,
        is_image: Object.hasOwn(ATTACH_TYPES, String(saved.ext)),
      });
    },
    { longRunning: true },
  );

  router.delete(
    "/api/attachments/{name}",
    async (ex) => {
      const owner = str(ex, "owner");
      const draft = str(ex, "draft");
      if (Boolean(owner) === Boolean(draft))
        throw new HttpError(400, "exactly one attachment owner is required");
      const name = ex.params.name!;
      let removed: boolean;
      try {
        if (draft)
          removed = await deps.mutateExternalStorage(() =>
            deps.drafts.releaseDraftFile(draft, name),
          );
        else {
          const node = deps.nodes.existing(owner!);
          removed =
            node !== null &&
            (await deps.mutateExternalStorage(() =>
              node.releaseAttachment(name),
            ));
        }
      } catch (error) {
        if (errorName(error) === "ValueError")
          throw new HttpError(400, "bad attachment id");
        throw error;
      }
      if (!removed) throw new HttpError(404);
      return ok();
    },
    { query: { owner: { type: "str" }, draft: { type: "str" } } },
  );

  const download = async (ex: Exchange): Promise<OpenedDownload> => {
    const [status, value] = await deps.files.composeFileDownload(
      ex.params.cid!,
      ex.params.attachment_id!,
    );
    if (status !== 200 || value === null) {
      if (status === 404) throw new HttpError(404, "attachment not found");
      throw new HttpError(status);
    }
    return value;
  };

  router.add(
    ["GET", "HEAD"],
    "/api/conversations/{cid}/attachments/{attachment_id}",
    async (ex) => {
      // Invariant: Resolve an opaque id only in the owner's admitted
      // collection; always download as inert bytes, whatever the manifest's
      // guessed type.
      const opened = await download(ex);
      const headers = {
        "content-disposition": contentDisposition(String(opened.manifest.name)),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      };
      const body = await servedBody(opened);
      if (body instanceof Uint8Array)
        return bytesResponse(body, "application/octet-stream", headers);

      const plain = new Request(ex.request.url, { method: ex.request.method });
      return rangedResponse(plain, body, {
        ...headers,
        "content-type": "application/octet-stream",
      });
    },
  );

  router.delete(
    "/api/conversations/{cid}/attachments/{attachment_id}",
    async (ex) => {
      const [status, removed] = await deps.files.composeFileDelete(
        ex.params.cid!,
        ex.params.attachment_id!,
      );
      if (status !== 200 || !removed) {
        if (status === 404) throw new HttpError(404, "attachment not found");
        throw new HttpError(status);
      }
      return ok();
    },
  );

  router.add(
    ["GET", "HEAD"],
    "/api/conversations/{cid}/attachments/{attachment_id}/preview",
    async (ex) => {
      // Invariant: Inline only when the immutable bytes match the raster
      // allowlist, or the filename names an SVG, audio, or video format. Media
      // answers Range requests so players can seek.
      const opened = await download(ex);
      const { manifest } = opened;
      let media: string | null = null;
      let body: Uint8Array | OpenedFile | null = null;
      try {
        const head = new Uint8Array(16);
        const { bytesRead } = await opened.blob.read(head, 0, 16, 0);
        const raster = inlineRasterMediaType(head.subarray(0, bytesRead));
        media =
          raster !== null && raster === manifest.inline_media_type
            ? raster
            : inlineMediaType(String(manifest.name));
        if (!media) throw new HttpError(404, "preview not available");
        body = await servedBody(opened);
      } finally {
        if (body === null) await opened.blob.close().catch(() => {});
      }
      return rangedResponse(ex.request, body, {
        "cache-control": "private, max-age=31536000, immutable",
        "content-security-policy":
          media === "image/svg+xml" ? SVG_PREVIEW_CSP : PREVIEW_CSP,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "content-length": String(opened.size),
        "content-type": mediaHeader(media),
      });
    },
  );

  router.get("/api/attachments/{name}", async () => {
    // Invariant: Pre-cut global capability URLs are gone, not moved.
    throw new HttpError(410, "attachment URLs are conversation-scoped");
  });

  router.get(
    "/api/artifacts",
    async (ex) => {
      try {
        return jsonResponse(
          await artifacts.listArtifacts(
            deps.artifacts,
            artifactOwner(ex.query.agent),
            {
              status: str(ex, "status"),
              limit: ex.query.limit as number,
            },
          ),
        );
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
    },
    {
      query: {
        agent: { type: "str", required: true },
        status: { type: "str" },
        limit: { type: "int", default: 100 },
      },
    },
  );

  router.get(
    "/api/artifacts/revision",
    async (ex) =>
      jsonResponse(
        {
          revision: await artifacts.revision(
            deps.artifacts,
            artifactOwner(ex.query.agent),
          ),
        },
        200,
        { "cache-control": "private, no-store" },
      ),
    { query: { agent: { type: "str", required: true } } },
  );

  router.get(
    "/api/artifacts/{artifact_id}/file",
    async (ex) => {
      // Invariant: Active documents (html, svg) get a sandboxing CSP wherever
      // they land.
      const download = Boolean(ex.query.download);
      try {
        const [meta, raw] = await artifacts.fileBytes(
          deps.artifacts,
          artifactOwner(ex.query.agent),
          ex.params.artifact_id!,
          String(ex.query.path),
          { version: str(ex, "version"), download },
        );
        if (typeof meta.filename !== "string")
          throw new artifacts.ArtifactCorrupt(
            "artifact file metadata is invalid",
          );
        const filename = artifactFilename(meta.filename);
        const media = artifacts.mediaType(meta, download);
        const disposition =
          download || !ARTIFACT_INLINE_TYPES.has(media)
            ? "attachment"
            : "inline";
        const headers: Record<string, string> = {
          ...ARTIFACT_SAFE_HEADERS,
          "content-disposition": `${disposition}; filename="${filename}"`,
        };
        if (media.startsWith("text/html") || media === artifacts.SVG_MEDIA_TYPE)
          headers["content-security-policy"] = artifacts.ARTIFACT_ACTIVE_CSP;
        const served =
          !download && media.startsWith("text/html")
            ? Buffer.from(
                themedHtml(
                  raw.toString("utf8"),
                  (await readTheme(deps.themesFile)).css,
                ),
              )
            : raw;
        return bytesResponse(new Uint8Array(served), media, headers);
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
    },
    {
      query: {
        agent: { type: "str", required: true },
        path: { type: "str", required: true },
        version: { type: "str" },
        download: { type: "int", default: 0 },
      },
    },
  );

  router.get(
    "/api/artifacts/{artifact_id}/page",
    async (ex) => {
      // Invariant: The running page of an HTML Artifact: always inline, always
      // sandboxed.
      try {
        const raw = await artifacts.pageBytes(
          deps.artifacts,
          artifactOwner(ex.query.agent),
          ex.params.artifact_id!,
          { version: str(ex, "version") },
        );
        return bytesResponse(
          new TextEncoder().encode(
            artifactPreview(
              raw.toString("utf8"),
              (await readTheme(deps.themesFile)).css,
            ),
          ),
          "text/html",
          {
            ...ARTIFACT_SAFE_HEADERS,
            "content-disposition": 'inline; filename="index.html"',
            "content-security-policy": artifacts.ARTIFACT_ACTIVE_CSP,
          },
        );
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
    },
    {
      query: {
        agent: { type: "str", required: true },
        version: { type: "str" },
      },
    },
  );

  router.get(
    "/api/artifacts/{artifact_id}/versions",
    async (ex) => {
      try {
        return jsonResponse(
          await artifacts.versions(
            deps.artifacts,
            artifactOwner(ex.query.agent),
            ex.params.artifact_id!,
            ex.query.limit as number,
          ),
        );
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
    },
    {
      query: {
        agent: { type: "str", required: true },
        limit: { type: "int", default: 100 },
      },
    },
  );

  router.post(
    "/api/artifacts/{artifact_id}/restore",
    async (ex) => {
      const invalid = new HttpError(400, "invalid restore request");
      const payload = await requestJson(ex, invalid);
      const { agent, version, expected_version: expected } = payload;
      if (
        typeof agent !== "string" ||
        typeof version !== "string" ||
        (expected !== undefined &&
          expected !== null &&
          typeof expected !== "string")
      )
        throw invalid;
      try {
        const owner = artifactOwner(agent);
        return jsonResponse(
          await deps.mutateExternalStorage(() =>
            artifacts.restore(
              deps.artifacts,
              owner,
              ex.params.artifact_id!,
              version,
              (expected as string | null | undefined) ?? null,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
    },
    { longRunning: true },
  );

  router.delete(
    "/api/artifacts/{artifact_id}",
    async (ex) => {
      const payload = await requestJson(
        ex,
        new HttpError(422, "invalid artifact deletion request"),
      );
      const { agent, expected_version: expected } = payload;
      if (typeof agent !== "string" || typeof expected !== "string")
        throw new HttpError(422, "agent and expected_version are required");
      const owner = artifactOwner(agent);
      let result: Rec;
      try {
        result = await deps.mutateExternalStorage(() =>
          artifacts.deleteArtifact(
            deps.artifacts,
            owner,
            ex.params.artifact_id!,
            expected,
          ),
        );
      } catch (error) {
        if (error instanceof artifacts.ArtifactError) artifactFailure(error);
        throw error;
      }
      let complete: boolean;
      try {
        complete = await finishArtifactDeletion(deps, result);
      } catch (error) {
        if (!(error instanceof artifacts.ArtifactError)) throw error;
        complete = false;
      }
      if (!complete)
        throw new HttpError(
          503,
          "Artifact was deleted, but cleanup is pending; retry",
        );
      return jsonResponse(result);
    },
    { longRunning: true },
  );
}
