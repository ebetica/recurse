/**
 * A host process for SIGKILL tests of the Durable shell extension, on Worker
 * SQLite: bun durable_host.ts DB MODE KILL_AT LOG_DIR [DELAY_SETSID].
 *
 * complete: run a background command and SIGKILL this process when its exit
 *   is committed into the task (KILL_AT exit-committed) or when its notice is
 *   submitted (exit-submitted).
 * survive: start a background `sleep 60` and a foreground command that also
 *   starts a setsid `sleep 60`, print their pgids once they run, then SIGKILL.
 *   DELAY_SETSID gates the child until the host waits for its session readiness.
 * resume: recover interrupted commands, resume, wait for the shell tasks and
 *   the conversation to settle, and print what the transcript holds.
 */
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  recoverInterruptedCommands,
  SHELL_TASK,
} from "../../../../../src/extensions/core/shells/shells.ts";
import { RegistryStore } from "../../../../../src/extensions/core/shells/persist.ts";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../../../../src/agents/durable/sqlite_worker.ts";
import {
  openShellHarness,
  stopGroup,
  text,
  userTexts,
} from "./durable_harness.ts";

const [db, mode, killAt, logDir, delaySetsid] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string?,
];
const print = (value: object) => writeSync(1, `${JSON.stringify(value)}\n`);
const stateDir = join(logDir, "state");
const die = () => process.kill(process.pid, "SIGKILL");
const worker = new SqliteWorker();
const { harness, conversation, shells } = await openShellHarness(
  await openWorkerSqliteStorage(worker, db),
  {
    cwd: logDir,
    stateDir,
    config: {
      logDir,
      foregroundWaitMs: 30_000,
      killGraceMs: 200,
      scheduleSeconds: [60],
    },
  },
);
const run = (args: object, requestId: string) =>
  conversation.submit(
    { type: "input", content: `RUN ${JSON.stringify(args)}`, requestId },
    context,
  );

if (mode === "complete") {
  harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      const value = (change as { value?: Record<string, any> }).value;
      if (
        killAt === "exit-committed" &&
        change.type === "task" &&
        value?.kind === SHELL_TASK &&
        value.state?.checkpoint?.phase === "notify"
      )
        die();
      if (
        killAt === "exit-submitted" &&
        change.type === "submission" &&
        String(value?.requestId).endsWith(":exit")
      )
        die();
    }
  });
  await (
    await run({ command: "sleep 0.5; echo finished", background: true }, "bg")
  ).wait(context);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  throw new Error("the host was not killed");
}

if (mode === "survive") {
  await (
    await run({ command: "sleep 60", background: true }, "bg")
  ).wait(context);
  const result = (await conversation.context(context)).messages.findLast(
    (message) => message.role === "toolResult",
  );
  const pgid = Number(/pgid (\d+)/.exec(text(result?.content))![1]);
  // Killed as soon as the command runs, before the call commits anything after the
  // spawn: the setsid process is found by its launch id, and the leader, which drops
  // its environment, by the registry's on-disk record.
  const escaped = "setsid sh -c 'echo $$ > escaped.pid; exec sleep 60'";
  const launch = delaySetsid
    ? `(while [ ! -f release ]; do sleep 0.01; done; exec ${escaped})`
    : escaped;
  await run(
    {
      command: `${launch} & echo $$ > fg.pid; exec env -i sleep 60`,
    },
    "fg",
  );
  const read = (name: string) => {
    try {
      return Number(readFileSync(join(logDir, name), "utf8").trim() || 0);
    } catch {
      return 0;
    }
  };
  const deadline = Date.now() + 10_000;
  while (!read("fg.pid") || !read("escaped.pid")) {
    if (delaySetsid && read("fg.pid") && !read("escaped.pid"))
      writeFileSync(join(logDir, "release"), "");
    if (Date.now() > deadline)
      throw new Error("the foreground command did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (killAt === "old-owner") {
    const store = new RegistryStore(stateDir, "agent-1");
    for (const record of store.readAll()) {
      if (
        !store.write({ ...record, ownerId: "legacy-opaque-owner-capability" })
      )
        throw new Error("could not persist the legacy owner record");
    }
    if (
      !store
        .readAll()
        .every((record) => record.ownerId === "legacy-opaque-owner-capability")
    )
      throw new Error("legacy owner record was not retained");
  }
  print({ pgid, fgPgid: read("fg.pid"), escaped: read("escaped.pid") });
  die();
}

const recoverPending = await recoverInterruptedCommands(
  harness,
  { stopGroup, stateDir },
  context,
);
harness.resume();
const deadline = Date.now() + 30_000;
while (
  (await harness.inspect(context)).tasks.some(
    (task) => task.record.kind === SHELL_TASK,
  )
) {
  if (Date.now() > deadline) throw new Error("shell tasks did not finish");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
await harness.waitForIdle(context);
await new Promise((resolve) => setTimeout(resolve, 300));
await harness.waitForIdle(context);
const texts = await userTexts(conversation);
print({
  recoverPending,
  exitNotices: texts.filter(
    (entry) => entry.includes("exited 0") && entry.includes("finished"),
  ).length,
  lostNotices: texts.filter((entry) =>
    entry.includes("because the server restarted"),
  ).length,
  answered:
    (await conversation.context(context)).messages.at(-1)?.role === "assistant",
});
await harness.close(context);
await shells.shutdown();
worker.close();
process.exit(0);
