// Startup catches up missing/stale projections, without reading current files.
// Immutable archive files are projection done-markers, not a separate index.
import { join } from "node:path";
import { slowSpan } from "../observability/slow_span";
import type { AgentArchive } from "../agents/durable/archive";
import type { ProcessLifecycle } from "../process_lifecycle";
import { BackfillProcess } from "./backfill_process";
import type { MessageSearch, SearchTarget } from "./index";

export async function backfillMessageSearch(options: {
  processes: ProcessLifecycle;
  search: MessageSearch;
  archive: AgentArchive;
  live(): SearchTarget[];
  yieldToFocus(): Promise<boolean>;
  signal: AbortSignal;
  log(event: string, fields: Record<string, unknown>): void;
}): Promise<void> {
  const finish = options.search.backfillStarted();
  const child = new BackfillProcess(options.processes);
  const abort = () => void child.close().catch(() => {});
  options.signal.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    if (options.signal.aborted) return;
    await child.start();
    const yieldToFocus = async () => {
      while (!options.signal.aborted) {
        if (
          !options.search.hasQueries &&
          (await options.yieldToFocus()) &&
          !options.search.hasQueries
        )
          return !options.signal.aborted;
        await Bun.sleep(100);
      }
      return false;
    };
    let phase: "live" | "archive" | "done" = "live";
    let after = "";
    let done = 0;
    while (phase !== "done" && !options.signal.aborted) {
      if (!(await yieldToFocus())) return;
      const started = performance.now();
      const live = slowSpan("search_backfill_targets", undefined, () =>
        options.live().sort((a, b) => a.cid.localeCompare(b.cid)),
      );
      const targets: SearchTarget[] =
        phase === "live"
          ? slowSpan("search_backfill_page", undefined, () =>
              live.filter((target) => target.cid > after).slice(0, 16),
            )
          : (await options.archive.page(after, 16)).map((row) => ({
              cid: row.cid,
              agent: row.archive_id,
              archived: true,
              path: join(
                options.archive.root,
                row.archive_id,
                "session.sqlite",
              ),
            }));
      let bytes = 0;
      for (const target of targets) {
        if (!(await yieldToFocus())) return;
        const stats = await options.search.sync(
          target,
          async (target, owned) => owned ?? child.sync(target),
        );
        if (options.signal.aborted) return;
        bytes += stats.bytes;
        done++;
        after = phase === "live" ? target.cid : target.agent!;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (options.signal.aborted) return;
      if (targets.length < 16) {
        phase = phase === "live" ? "archive" : "done";
        after = "";
      }
      const remaining =
        (phase === "live"
          ? live.filter((target) => target.cid > after).length
          : 0) +
        (phase === "done"
          ? 0
          : await options.archive.count(phase === "archive" ? after : ""));
      options.log("search_backfill", {
        done,
        remaining,
        bytes,
        page_ms: performance.now() - started,
      });
    }
    complete = !options.signal.aborted;
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    try {
      await child.close();
    } finally {
      finish(complete);
    }
  }
}
