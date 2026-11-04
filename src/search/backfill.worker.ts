// Startup catches up missing/stale projections without warming transcript data.
// Immutable archive files are done-markers; IPC loss closes this process.
import { statSync } from "node:fs";
import { searchFile, sync } from "./sync.worker";
import type { BackfillReply, BackfillWork } from "./backfill_process";
import type { SyncStats } from "./index";

if (!process.send)
  throw new Error("Message search startup requires parent IPC");
process.on("disconnect", () => process.exit(0));

process.on("message", (request: BackfillWork & { id: number }) => {
  try {
    let value: SyncStats | undefined;
    if (request.op === "sync") {
      const started = performance.now();
      const file = searchFile(request.target.path);
      const existing = statSync(file, { throwIfNoEntry: false });
      value =
        request.target.archived && existing?.isFile()
          ? {
              entries: 0,
              bytes: 0,
              ms: 0,
              file: { path: file, bytes: existing.size },
            }
          : sync(request.target);
      value.ms = performance.now() - started;
    }
    process.send!({ id: request.id, value } satisfies BackfillReply);
  } catch (error) {
    process.send!({
      id: request.id,
      error: (error as Error).message,
    } satisfies BackfillReply);
  }
});
