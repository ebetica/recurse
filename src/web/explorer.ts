// Operator-only reads of a conversation's current working folder.
// Workers pin filesystem descriptors; bounded directory pages and text chunks
// keep first paint small. Filename search borrows the agents' fff child.
import { basename } from "node:path";
import { contentDisposition } from "../agents/runtime/attachments/published";
import type { FileNameSearch } from "../extensions/extra/fff/fff_worker";
import { ExplorerIO, type ExplorerScope } from "./explorer_io";
import { agentMarked } from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";
import { rangedResponse } from "./static";

export interface ExplorerRoutesDeps {
  cwd(cid: string): Promise<string | null>;
  search(
    cid: string,
    cwd: string,
    query: string,
    signal: AbortSignal,
  ): Promise<FileNameSearch>;
  dataDir: string;
  privateRoots: readonly string[];
  signal?: AbortSignal;
}
const SAFE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

/** Register routes without indexing, opening a folder, or starting a Worker. */
export function registerExplorerRoutes(
  router: Router,
  deps: ExplorerRoutesDeps,
): ExplorerIO {
  const io = new ExplorerIO(deps.signal);
  const searches = new Map<string, AbortController>();
  const scope = async (ex: Exchange): Promise<ExplorerScope> => {
    if (
      agentMarked(ex) ||
      !["cookie", "local", "tailscale"].includes(String(ex.state.auth_method))
    )
      throw new HttpError(403, "only the operator can browse files");
    const owner = ex.params.cid!;
    const root = await deps.cwd(owner);
    if (!root) throw new HttpError(404, "conversation not found");
    const path = typeof ex.query.path === "string" ? ex.query.path : "";
    if (path.length > 4096) throw new HttpError(422, "file path is too long");
    return {
      owner,
      root,
      path,
      dataDir: deps.dataDir,
      privateRoots: deps.privateRoots,
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
      const folder = await scope(ex);
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
      const folder = await scope(ex);
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
