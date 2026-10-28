// Copied stores never recover or signal the source instance's processes.
// Match logical kinds, not encoded indexes, before Harness.open.
import type { WorkerSqliteDatabase } from "./sqlite_worker.ts";

export async function sanitizeImportedProcesses(
  db: WorkerSqliteDatabase,
): Promise<void> {
  await db.run(
    `UPDATE tasks SET record = json_remove(record, '$.memos."recurse.shell"')
     WHERE json_extract(record, '$.kind') = 'pi.tool'`,
  );
  await db.run(
    `UPDATE tasks SET status = 'terminal', abort_requested = 0,
    record = json_set(json_remove(record, '$.memos'), '$.abortRequested', json('false'),
    '$.state', json(?)) WHERE json_extract(record, '$.kind') = 'recurse.shell' AND status != 'terminal'`,
    JSON.stringify({
      status: "terminal",
      outcome: {
        status: "aborted",
        reason: "imported without source processes",
        result: { event: "stopped", gone: true },
      },
    }),
  );
}
