// Operator-only reads of a conversation's current working folder, and file
// views and saves at any path (absolute, home or folder-relative). Workers pin
// filesystem descriptors; bounded directory pages and text chunks keep first
// paint small. Filename search borrows the agents' fff child.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveRoots } from "../local_roots";
import { contentDisposition } from "../agents/runtime/attachments/published";
import type { FileNameSearch } from "../extensions/extra/fff/fff_worker";
import {
  EXPLORER_EDIT_BYTES,
  ExplorerIO,
  type ExplorerScope,
} from "./explorer_io";
import { agentMarked, isOperator } from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";
import { rangedResponse } from "./static";

interface ExplorerRoutesDeps {
  cwd(cid: string): Promise<string | null>;
  search(
    cid: string,
    cwd: string,
    query: string,
    signal: AbortSignal,
  ): Promise<FileNameSearch>;
  signal?: AbortSignal;
  agentDir?: string;
}
const SAFE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

/**
 * A file path outside the working folder becomes its parent folder and name;
 * inside it, a path relative to the folder.
 */
function locate(root: string, path: string): { root: string; path: string } {
  if (!path || path.includes("\0")) return { root, path };
  const target =
    path === "~" || path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : resolve(root, path);
  const inside = relative(root, target);
  if (inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside))
    return { root, path: inside };
  return { root: dirname(target), path: basename(target) };
}

async function bodyText(ex: Exchange): Promise<string> {
  const declared = Number(ex.request.headers.get("content-length") ?? 0);
  if (declared > EXPLORER_EDIT_BYTES)
    throw new HttpError(413, "the file is too large to save here");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of ex.request.body ?? []) {
    size += chunk.length;
    if (size > EXPLORER_EDIT_BYTES)
      throw new HttpError(413, "the file is too large to save here");
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(Buffer.concat(chunks)),
    );
  } catch {
    throw new HttpError(422, "the file text is not valid UTF-8");
  }
}

/** Register routes without indexing, opening a folder, or starting a Worker. */
export function registerExplorerRoutes(
  router: Router,
  deps: ExplorerRoutesDeps,
): ExplorerIO {
  const io = new ExplorerIO(deps.signal);
  const searches = new Map<string, AbortController>();
  const scope = async (
    ex: Exchange,
    anywhere = false,
  ): Promise<ExplorerScope> => {
    if (agentMarked(ex) || !isOperator(ex, { allowBackendKey: true }))
      throw new HttpError(403, "only the operator can browse files");
    const owner = ex.params.cid!;
    const root = await deps.cwd(owner);
    if (!root) throw new HttpError(404, "conversation not found");
    const path = typeof ex.query.path === "string" ? ex.query.path : "";
    if (path.length > 4096) throw new HttpError(422, "file path is too long");
    return {
      owner,
      contextRoot: root,
      agentDir: deps.agentDir ?? resolveRoots().piAgent,
      ...(anywhere ? locate(root, path) : { root, path }),
    };
  };
  const pathQuery = { path: { type: "str" as const } };
  router.get(
    "/api/conversations/{cid}/tree",
    async (ex) => {
      const folder = await scope(ex);
      const cursor =
        typeof ex.query.cursor === "string" ? ex.query.cursor : undefined;
      return jsonResponse(
        await io.call("list", { ...folder, cursor }, ex.request.signal),
        200,
        SAFE_HEADERS,
      );
    },
    { query: { ...pathQuery, cursor: { type: "str" } } },
  );

  router.get(
    "/api/conversations/{cid}/tree/file",
    async (ex) => {
      const folder = await scope(ex, true);
      const offset = Number(ex.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new HttpError(422, "invalid file offset");
      const version =
        typeof ex.query.version === "string" ? ex.query.version : undefined;
      return jsonResponse(
        await io.call(
          "preview",
          { ...folder, offset, version },
          ex.request.signal,
        ),
        200,
        SAFE_HEADERS,
      );
    },
    {
      query: {
        ...pathQuery,
        offset: { type: "int", default: 0 },
        version: { type: "str" },
      },
    },
  );

  router.put(
    "/api/conversations/{cid}/tree/file",
    async (ex) => {
      const file = await scope(ex, true);
      const version =
        typeof ex.query.version === "string" && ex.query.version
          ? ex.query.version
          : null;
      const canonicalPath = ex.query.canonicalPath;
      if (
        typeof canonicalPath !== "string" ||
        !canonicalPath ||
        canonicalPath.length > 4096
      )
        throw new HttpError(422, "reopen the file before saving");
      const text = await bodyText(ex);
      return jsonResponse(
        await io.call(
          "save",
          {
            ...file,
            text,
            version,
            canonicalPath,
            overwrite: ex.query.overwrite === true,
          },
          ex.request.signal,
        ),
        200,
        SAFE_HEADERS,
      );
    },
    {
      query: {
        ...pathQuery,
        version: { type: "str" },
        overwrite: { type: "bool", default: false },
        canonicalPath: { type: "str" },
      },
    },
  );

  router.get(
    "/api/conversations/{cid}/tree/search",
    async (ex) => {
      const folder = await scope(ex);
      const query = typeof ex.query.q === "string" ? ex.query.q.trim() : "";
      if (query.length > 128) throw new HttpError(422, "search is too long");
      await io.call("admit", folder, ex.request.signal);
      if (!query) return jsonResponse({ results: [] }, 200, SAFE_HEADERS);
      if (searches.size >= 16 && !searches.has(folder.owner))
        throw new HttpError(429, "too many file searches; try again shortly");
      searches.get(folder.owner)?.abort();
      const controller = new AbortController();
      searches.set(folder.owner, controller);
      const abort = () => controller.abort();
      ex.request.signal.addEventListener("abort", abort, { once: true });
      if (ex.request.signal.aborted) controller.abort();
      try {
        const found = await deps.search(
          folder.owner,
          folder.root,
          query,
          controller.signal,
        );
        if (controller.signal.aborted)
          throw new HttpError(499, "request cancelled");
        return jsonResponse({ results: found.paths }, 200, SAFE_HEADERS);
      } catch (error) {
        if (controller.signal.aborted)
          throw new HttpError(499, "request cancelled");
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "file search unavailable; try again");
      } finally {
        ex.request.signal.removeEventListener("abort", abort);
        if (searches.get(folder.owner) === controller)
          searches.delete(folder.owner);
      }
    },
    { query: { q: { type: "str" } } },
  );

  router.add(
    ["GET", "HEAD"],
    "/api/conversations/{cid}/tree/raw",
    async (ex) => {
      const folder = await scope(ex, true);
      const opened = await io.call("download", folder, ex.request.signal);
      let closing: Promise<void> | undefined;
      const handle = {
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) {
          const bytes = await io.call("read", {
            owner: folder.owner,
            token: opened.token,
            offset: position,
            length,
          });
          buffer.set(bytes, offset);
          return { bytesRead: bytes.length };
        },
        close() {
          return (closing ??= io
            .call("release", { owner: folder.owner, token: opened.token })
            .then(() => undefined));
        },
      };
      return rangedResponse(
        ex.request,
        { handle, size: opened.size },
        {
          ...SAFE_HEADERS,
          "accept-ranges": "bytes",
          "content-length": String(opened.size),
          "content-type": "application/octet-stream",
          "content-disposition": contentDisposition(basename(opened.name)),
        },
      );
    },
    { query: pathQuery, longRunning: true },
  );
  return io;
}
