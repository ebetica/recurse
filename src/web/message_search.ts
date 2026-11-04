// Authenticated bundled-tool search and bounded plain-text transcript reads.
// Targets come from live records or the archive index, never caller file paths.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SearchBusyError, type MessageSearch } from "../search/index";
import { TimeoutError, withTimeout } from "../utils/tasks";
import {
  SearchScopeError,
  selectSearchTargets,
  type SearchSelection,
} from "../search/targets";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

interface SearchDeps extends SearchSelection {
  requireReady(): void;
  loopbackAuthenticated(ex: Exchange): boolean;
  search: MessageSearch;
}

function authorize(ex: Exchange, deps: SearchDeps): void {
  if (
    !deps.loopbackAuthenticated(ex) &&
    !["backend-key", "cookie", "tailscale", "local"].includes(
      String(ex.state.auth_method),
    )
  )
    throw new HttpError(403);
  deps.requireReady();
}

async function boundary(
  ex: Exchange,
  work: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs?: number,
): Promise<Response> {
  try {
    const result = await (timeoutMs === undefined
      ? work(ex.request.signal)
      : withTimeout(work, timeoutMs, ex.request.signal));
    return jsonResponse(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (error instanceof SearchBusyError)
      throw new HttpError(429, error.message);
    if (error instanceof TimeoutError)
      throw new HttpError(
        504,
        "Transcript request timed out; select fewer agents or a smaller range",
      );
    if (ex.request.signal.aborted)
      throw new HttpError(499, "Transcript request cancelled");
    if (error instanceof SearchScopeError)
      throw new HttpError(error.status, error.message);
    throw error;
  }
}

async function readLines(
  path: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HttpError(
        404,
        "Transcript not indexed yet; try again after indexing completes",
      );
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new HttpError(422, "Transcript is not a regular file");
    signal.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: false });
    const abort = () =>
      stream.destroy(new Error("Transcript request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let line = 1;
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const buffer = chunk as Buffer;
        let start = 0;
        while (start < buffer.length && line < offset + limit) {
          const newline = buffer.indexOf(10, start);
          const end = newline < 0 ? buffer.length : newline + 1;
          if (line >= offset) {
            bytes += end - start;
            if (bytes > 256 * 1024)
              throw new HttpError(
                413,
                "Transcript range is too large; use a smaller --limit",
              );
            chunks.push(new Uint8Array(buffer.subarray(start, end)));
          }
          if (newline >= 0) line++;
          start = end;
        }
        if (line >= offset + limit) break;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      stream.destroy();
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function registerMessageSearch(router: Router, deps: SearchDeps): void {
  router.get("/api/subagent-tool/read", async (ex) => {
    authorize(ex, deps);
    const query = ex.url.searchParams;
    const target = query.get("target") ?? "";
    const offset = query.get("offset") ?? "1";
    const limit = query.get("limit") ?? "200";
    if (
      !target ||
      target.length > 256 ||
      !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(Number(offset)) ||
      Number(offset) < 1 ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 2000 ||
      !Number.isSafeInteger(Number(offset) + Number(limit))
    )
      throw new HttpError(
        422,
        "choose a target, positive line offset and limit 1-2000",
      );
    return boundary(
      ex,
      async (signal) => {
        const targets = await selectSearchTargets(
          deps,
          { target, tree: false, all: false, deleted: false },
          signal,
        );
        const path = join(dirname(targets[0]!.path), "transcript.txt");
        return {
          path,
          offset: Number(offset),
          text: await readLines(path, Number(offset), Number(limit), signal),
        };
      },
      15000,
    );
  });
  router.get(
    "/api/subagent-tool/search",
    async (ex) => {
      authorize(ex, deps);
      const query = ex.url.searchParams;
      const text = query.get("q") ?? "";
      const role = query.get("role") ?? undefined;
      const limit = Number(query.get("limit") ?? 20);
      if (
        !text.trim() ||
        text.length > 4096 ||
        /[\r\n\u0000]/.test(text) ||
        (role !== undefined &&
          !["user", "assistant", "agent", "tool", "tool-result"].includes(
            role,
          )) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new HttpError(
          422,
          "use a single-line query, a transcript role, and limit 1-100",
        );
      for (const name of ["tree", "all", "deleted"])
        if (query.has(name) && !["true", "false"].includes(query.get(name)!))
          throw new HttpError(422, `invalid ${name}`);
      const all = query.get("all") === "true";
      const tree = query.get("tree") === "true";
      const deleted = query.get("deleted") === "true";
      const target =
        query.get("target") ??
        (deps.loopbackAuthenticated(ex)
          ? (ex.request.headers.get("x-recurse-agent") ?? "")
          : "");
      if ((all && (tree || query.has("target"))) || (!all && !target))
        throw new HttpError(422, "choose an agent or --all, not both");
      return boundary(ex, async (signal) => {
        const targets = await selectSearchTargets(
          deps,
          { target, tree, all, deleted },
          signal,
        );
        return deps.search.search(targets, {
          query: text,
          role: role as Parameters<MessageSearch["search"]>[1]["role"],
          limit,
          scope: all
            ? deleted
              ? "all+deleted"
              : "all"
            : tree
              ? "tree"
              : "agent",
          signal,
        });
      });
    },
    { longRunning: true },
  );
}
