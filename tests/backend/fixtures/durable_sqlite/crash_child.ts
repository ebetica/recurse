/**
 * Commits Durable turns on Worker SQLite, then kills itself with SIGKILL
 * inside a transaction: bun crash_child.ts DB_PATH FIRST_TURN KILL_AT.
 * The KILL_AT-th transaction of this process has run its writes in the Worker
 * but has not sent COMMIT when the process dies. Prints {"done":N} after each
 * settled turn.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { SqliteWorker } from "../../../../src/agents/durable/sqlite_worker.ts";
import { openFauxHarness } from "./harness.ts";

const [path, first, killAt] = process.argv.slice(2);
const database = await new SqliteWorker().openDatabase(path!);
let transactions = 0;
const dying: SqliteDatabase = {
  exec: database.exec.bind(database),
  run: database.run.bind(database),
  get: database.get.bind(database),
  all: database.all.bind(database),
  close: database.close.bind(database),
  transaction: (callback) =>
    database.transaction(async (transaction) => {
      const result = await callback(transaction);
      if (++transactions === Number(killAt))
        process.kill(process.pid, "SIGKILL");
      return result;
    }),
};
const { conversation } = await openFauxHarness(dying);
for (let turn = Number(first); ; turn++) {
  const run = await conversation.submit(
    { type: "input", content: `turn ${turn}`, requestId: `turn-${turn}` },
    context,
  );
  const settled = await run.wait(context);
  if (settled.status !== "done")
    throw new Error(`turn ${turn}: ${settled.status}`);
  console.log(JSON.stringify({ done: turn }));
}
