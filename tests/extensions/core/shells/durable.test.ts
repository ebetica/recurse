import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type Harness,
  MemoryStorage,
  ToolTask,
  type ToolTaskInput,
  type ToolTaskCheckpoint,
} from "@earendil-works/pi-durable";
import {
  SHELL_TASK,
  stopConversationShells,
} from "../../../../src/extensions/core/shells/shells.ts";
import { procStartTime } from "../../../../src/extensions/core/shells/persist.ts";
import {
  openShellHarness,
  stopGroup,
  userTexts,
} from "./fixtures/durable_harness.ts";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../../../src/agents/durable/sqlite_worker.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-bg-shell-durable-")));
const worker = new SqliteWorker();
afterAll(() => {
  worker.close();
  rmSync(root, { recursive: true, force: true });
});
let dirs = 0;
const config = () => ({
  logDir: join(root, `logs-${dirs++}`),
  foregroundWaitMs: 400,
  killGraceMs: 200,
  scheduleSeconds: [60],
});

function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z" && Number(fields[2]) === pgid)
        members.push(Number(name));
    } catch {}
  }
  return members;
}

async function until<T>(
  read: () => T | Promise<T>,
  what: string,
  ms = 15_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function run(
  conversation: Conversation,
  args: object,
  requestId: string,
) {
  const submission = await conversation.submit(
    { type: "input", content: `RUN ${JSON.stringify(args)}`, requestId },
    context,
  );
  const settled = await submission.wait(context);
  expect(settled.status).toBe("done");
  const result = (await conversation.context(context)).messages.findLast(
    (message) => message.role === "toolResult",
  );
  return (result?.content as Array<{ text: string }>)
    .map((block) => block.text)
    .join("");
}

async function waitToolActive(harness: Harness, conversation: Conversation) {
  await until(async () => {
    for (const { record } of (await harness.inspect(context)).tasks) {
      if (
        record.kind !== ToolTask.definition.name ||
        (record.state.checkpoint as ToolTaskCheckpoint).phase !== "execute"
      )
        continue;
      const input = record.input as ToolTaskInput;
      if (input.kind === "nested") continue;
      const page = await conversation.entries(
        { minEntryId: input.assistant, maxEntryId: input.assistant },
        1,
        undefined,
        context,
      );
      const message = page.items[0]?.model?.[0];
      if (
        message?.role === "assistant" &&
        message.content.some(
          (block) =>
            block.type === "toolCall" &&
            block.id === input.callId &&
            block.name === "wait",
        )
      )
        return true;
    }
    return false;
  }, "wait tool to become active");
}

const pgidOf = (result: string) => Number(/pgid (\d+)/.exec(result)![1]);
const shellTasks = async (harness: Harness) =>
  (await harness.inspect(context)).tasks.filter(
    (task) => task.record.kind === SHELL_TASK,
  );

test("a background completion wakes the idle conversation exactly once", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  const started = await run(
    conversation,
    { command: "sleep 0.5; echo finished", background: true },
    "bg",
  );
  const id = /shell `([^`]+)`/.exec(started)![1];
  expect(started).toContain("in the background");
  const late = await run(
    conversation,
    { command: "sleep 1; echo late" },
    "late",
  );
  expect(late).toContain("backgrounded as shell");
  const lateId = /shell `([^`]+)`/.exec(late)![1];
  await until(
    async () => (await shellTasks(harness)).length === 0,
    "both shell tasks to finish",
  );
  await until(async () => {
    const texts = await userTexts(conversation);
    const last = (await conversation.context(context)).messages.at(-1);
    return (
      texts.some(
        (text) => text.includes(`Shell \`${id}\``) && text.includes("exited 0"),
      ) &&
      texts.some(
        (text) => text.includes(`Shell \`${lateId}\``) && text.includes("late"),
      ) &&
      last?.role === "assistant"
    );
  }, "both completions delivered and answered");
  await harness.waitForIdle(context);
  const texts = await userTexts(conversation);
  const done = texts.filter(
    (text) => text.includes(`Shell \`${id}\``) && text.includes("exited 0"),
  );
  expect(done).toHaveLength(1);
  expect(done[0]).toContain("finished");
  expect(
    texts.filter(
      (text) => text.includes(`Shell \`${lateId}\``) && text.includes("late"),
    ),
  ).toHaveLength(1);
  const last = (await conversation.context(context)).messages.at(-1);
  expect(last?.role).toBe("assistant");
  await harness.close(context);
  await shells.shutdown();
});

// Regression: #2520 wait for real monitor batches before releasing the producer.
test("a monitor delivers output lines, then its completion", async () => {
  const second = join(root, "monitor-second");
  const finish = join(root, "monitor-finish");
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  try {
    const started = await run(
      conversation,
      {
        command: `echo first; while [ ! -f ${JSON.stringify(second)} ]; do sleep 0.01; done; echo second; while [ ! -f ${JSON.stringify(finish)} ]; do sleep 0.01; done`,
        monitor: true,
      },
      "mon",
    );
    const id = /shell `([^`]+)`/.exec(started)![1];
    const delivered = async (line: string) =>
      (await userTexts(conversation)).some(
        (text) => text.startsWith(`[monitor ${id}]`) && text.includes(line),
      );
    await until(() => delivered("first"), "the first monitor batch");
    writeFileSync(second, "");
    await until(() => delivered("second"), "the second monitor batch");
    writeFileSync(finish, "");
    await until(
      async () => (await shellTasks(harness)).length === 0,
      "the monitor to finish",
    );
    await harness.waitForIdle(context);
    const texts = await userTexts(conversation);
    const batches = texts.filter((text) => text.startsWith(`[monitor ${id}]`));
    expect(batches.join("\n")).toContain("first");
    expect(batches.join("\n")).toContain("second");
    expect(
      texts.filter((text) => text.startsWith(`Shell \`${id}\``)),
    ).toHaveLength(1);
  } finally {
    writeFileSync(second, "");
    writeFileSync(finish, "");
    try {
      await harness.close(context);
    } finally {
      await shells.shutdown();
    }
  }
});

async function wait(conversation: Conversation, requestId: string) {
  const submission = await conversation.submit(
    { type: "input", content: "WAIT", requestId },
    context,
  );
  expect((await submission.wait(context)).status).toBe("done");
  const messages = (await conversation.context(context)).messages;
  const index = messages.findLastIndex(
    (message) => message.role === "toolResult",
  );
  return {
    text: (messages[index]!.content as Array<{ text: string }>)
      .map((block) => block.text)
      .join(""),
    next: messages[index + 1],
  };
}

test("wait ends when a shell finishes, and its notice follows the wait result once", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  const id = /shell `([^`]+)`/.exec(
    await run(
      conversation,
      { command: "sleep 0.5; echo finished", background: true },
      "bg",
    ),
  )![1];
  const waited = await wait(conversation, "wait-1");
  expect(waited.text).toBe(
    "A backgrounded shell reported; its notice follows this result.",
  );
  expect(waited.next?.role).toBe("user");
  expect(JSON.stringify(waited.next?.content)).toContain(`Shell \`${id}\``);
  await harness.waitForIdle(context);
  expect(
    (await userTexts(conversation)).filter((text) =>
      text.includes(`Shell \`${id}\``),
    ),
  ).toHaveLength(1);
  expect((await wait(conversation, "wait-2")).text).toBe(
    "No backgrounded shells to wait for.",
  );
  await harness.close(context);
  await shells.shutdown();
});

test("wait ends when a monitor prints a line, and the line follows the wait result", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  const started = await run(
    conversation,
    { command: "sleep 0.5; echo progress; sleep 30", monitor: true },
    "mon",
  );
  const id = /shell `([^`]+)`/.exec(started)![1];
  const waited = await wait(conversation, "wait");
  expect(waited.text).toBe(
    "A backgrounded shell reported; its notice follows this result.",
  );
  expect(JSON.stringify(waited.next?.content)).toContain(`[monitor ${id}]`);
  expect(JSON.stringify(waited.next?.content)).toContain("progress");
  await stopConversationShells(harness, conversation.id, context);
  await harness.close(context);
  await shells.shutdown();
});

test("user input ends a wait at once", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  await run(conversation, { command: "sleep 30", background: true }, "bg");
  const waiting = await conversation.submit(
    { type: "input", content: "WAIT", requestId: "wait" },
    context,
  );
  await waitToolActive(harness, conversation);
  await conversation.submit(
    { type: "input", content: "hello", whenBusy: "steer", requestId: "hello" },
    context,
  );
  expect((await waiting.wait(context)).status).toBe("done");
  const messages = (await conversation.context(context)).messages;
  const result = messages.find(
    (message) =>
      message.role === "toolResult" &&
      JSON.stringify(message.content).includes("ending the wait"),
  );
  expect(JSON.stringify(result?.content)).toContain(
    "User message arrived — ending the wait. 1 backgrounded shell still running; their completion will still notify.",
  );
  await stopConversationShells(harness, conversation.id, context);
  await harness.close(context);
  await shells.shutdown();
});

test("a timed-out wait escalates and moves each shell's next still-running notice one step later", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    {
      cwd: root,
      config: { ...config(), scheduleSeconds: [0.5, 1, 60] },
    },
  );
  await run(conversation, { command: "sleep 30", background: true }, "a");
  const first = await wait(conversation, "wait-1");
  expect(first.text).toStartWith(
    "Waited for 0.5s. Call wait again to wait longer.\n",
  );
  expect(first.text).toContain("still running");
  const id = /shell `([^`]+)`/.exec(
    await run(conversation, { command: "sleep 30", background: true }, "b"),
  )![1];
  expect((await wait(conversation, "wait-2")).text).toStartWith(
    "Waited for 1s.",
  );
  await until(async () => {
    const task = (await shellTasks(harness)).find(
      (entry) => (entry.record.input as { shellId: string }).shellId === id,
    );
    const checkpoint = task?.record.state.checkpoint as
      | { phase?: string; step?: number }
      | undefined;
    return (
      checkpoint?.phase === "watch" &&
      checkpoint.step === 2 &&
      (await userTexts(conversation)).some((text) =>
        text.startsWith(`Shell \`${id}\` (sleep 30) still running`),
      )
    );
  }, "still-running notice and advanced checkpoint");
  const task = (await shellTasks(harness)).find(
    (entry) => (entry.record.input as { shellId: string }).shellId === id,
  )!;
  expect(task.record.state).toMatchObject({
    checkpoint: { phase: "watch", step: 2 },
  });
  const notices = (await userTexts(conversation)).filter((text) =>
    text.startsWith(`Shell \`${id}\` (sleep 30) still running`),
  );
  expect(notices).toHaveLength(1);
  const waiting = await conversation.submit(
    { type: "input", content: "WAIT", requestId: "wait-3" },
    context,
  );
  await waitToolActive(harness, conversation);
  await conversation.submit(
    {
      type: "input",
      content: "stop waiting",
      whenBusy: "steer",
      requestId: "steer",
    },
    context,
  );
  await waiting.wait(context);
  expect((await wait(conversation, "wait-4")).text).toStartWith(
    "Waited for 0.5s.",
  );
  await stopConversationShells(harness, conversation.id, context);
  await harness.close(context);
  await shells.shutdown();
});

test("still-running and inactivity notices come from deadlines in the task checkpoint", async () => {
  const db = join(root, "checkpoint.sqlite");
  const options = {
    cwd: root,
    config: { ...config(), scheduleSeconds: [0.5, 60] },
  };
  const { harness, conversation, shells } = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    options,
  );
  const started = await run(
    conversation,
    { command: "sleep 30", background: true, inactivityReminderSeconds: 1 },
    "quiet",
  );
  const id = /shell `([^`]+)`/.exec(started)![1];
  await until(async () => {
    const texts = await userTexts(conversation);
    return (
      texts.some(
        (text) =>
          text.includes("still running") &&
          text.includes(id) &&
          !text.startsWith("[shell"),
      ) &&
      texts.some((text) =>
        text.startsWith(`[shell ${id}] still running; no new output`),
      ) &&
      ((
        (await shellTasks(harness))[0]?.record.state.checkpoint as
          | { reminders: number }
          | undefined
      )?.reminders ?? 0) >= 1
    );
  }, "a still-running and an inactivity notice counted in the checkpoint");
  await harness.close(context);
  const frozen = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    options,
  );
  const inspection = await frozen.harness.inspect(context);
  const task = inspection.tasks.find(
    (entry) => entry.record.kind === SHELL_TASK,
  )!;
  expect(task.record.state).toMatchObject({
    checkpoint: { phase: "watch", step: 1 },
  });
  const { reminders } = task.record.state.checkpoint as { reminders: number };
  const delivered = (await userTexts(frozen.conversation)).flatMap((text) =>
    text.startsWith(`[shell ${id}] still running; no new output`)
      ? [Number(/\(reminder (\d+)\)/.exec(text)![1])]
      : [],
  );
  const queued = inspection.submissions.flatMap((submission) => {
    const match = new RegExp(`^shell:${id}:idle:(\\d+)$`).exec(
      submission.requestId ?? "",
    );
    return match && submission.status === "queued"
      ? [Number(match[1]) + 1]
      : [];
  });
  const posted = [...delivered, ...queued].sort((a, b) => a - b);
  expect(reminders).toBeGreaterThanOrEqual(1);
  expect(posted).toEqual(
    Array.from({ length: posted.length }, (_, index) => index + 1),
  );
  expect([reminders, reminders + 1]).toContain(posted.length);
  await frozen.harness.close(context);
  await frozen.shells.shutdown();
  await shells.shutdown();
});

test("a run abort keeps background shells; stop processes then stops them without a notice", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: { ...config(), foregroundWaitMs: 60_000 } },
  );
  const background = pgidOf(
    await run(conversation, { command: "sleep 30", background: true }, "bg"),
  );
  const foreground = await conversation.submit(
    {
      type: "input",
      content: `RUN ${JSON.stringify({ command: "echo $$ > fg.pid; exec sleep 30" })}`,
      requestId: "fg",
    },
    context,
  );
  const fgPid = await until(() => {
    try {
      return Number(readFileSync(join(root, "fg.pid"), "utf8"));
    } catch {
      return 0;
    }
  }, "the foreground command");
  await conversation.abort(context);
  expect((await foreground.wait(context)).status).toBe("unanswered");
  await until(
    () => groupMembers(fgPid).length === 0,
    "the foreground group to stop",
  );
  expect(groupMembers(background).length).toBeGreaterThan(0);
  expect(await shellTasks(harness)).toHaveLength(1);

  const before = (await userTexts(conversation)).length;
  expect(
    await stopConversationShells(harness, conversation.id, context),
  ).toEqual({ stopped: 1, pending: [] });
  expect(groupMembers(background)).toEqual([]);
  expect(await shellTasks(harness)).toHaveLength(0);
  await until(
    async () => (await shellTasks(harness)).length === 0,
    "stopped shell tasks to settle",
  );
  await harness.waitForIdle(context);
  expect((await userTexts(conversation)).length).toBe(before);
  await harness.close(context);
  await shells.shutdown();
  rmSync(join(root, "fg.pid"), { force: true });
});

test("a reap-style abort stops background shells", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    { cwd: root, config: config() },
  );
  const pgid = pgidOf(
    await run(
      conversation,
      { command: "sleep 30 & sleep 30", background: true },
      "bg",
    ),
  );
  await until(
    () => groupMembers(pgid).length === 3,
    "the shell and both sleeps",
  );
  await conversation.abort(context, { background: true });
  expect(groupMembers(pgid)).toEqual([]);
  expect(await shellTasks(harness)).toHaveLength(0);
  await harness.close(context);
  await shells.shutdown();
});

test("a resumed shell task verifies the recorded identity: a reused pid is never signaled", async () => {
  const db = join(root, "identity.sqlite");
  const first = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    { cwd: root, config: config() },
  );
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const owned = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await until(
    () => procStartTime(stranger.pid!) && procStartTime(owned.pid!),
    "both processes",
  );
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const record = (pid: number, identity: string, shellId: string) => ({
    shellId,
    pid,
    pgid: pid,
    identity,
    bootId,
    logPath: join(root, `${shellId}.log`),
    command: "sleep 30",
    startedAt: Date.now(),
    key: "agent-1",
    mode: "background" as const,
    noticeAt: null,
    backgroundedAt: Date.now(),
    inactivityMs: 0,
  });
  await first.harness.commit(async (tx) => {
    const options = {
      ownership: { kind: "conversation" as const },
      conversationId: first.conversation.id,
      background: true,
    };
    await tx.createTask(
      first.shells.task,
      record(
        stranger.pid!,
        String(Number(procStartTime(stranger.pid!)) + 1),
        "reused",
      ),
      options,
    );
    await tx.createTask(
      first.shells.task,
      record(owned.pid!, procStartTime(owned.pid!)!, "survivor"),
      options,
    );
  }, context);
  await first.harness.close(context);

  const second = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    { cwd: root, config: config() },
  );
  second.harness.resume();
  await until(
    async () => (await shellTasks(second.harness)).length === 0,
    "both tasks to resume and finish",
  );
  expect(groupMembers(stranger.pid!)).toEqual([stranger.pid!]);
  expect(groupMembers(owned.pid!)).toEqual([]);
  const restarted = async () =>
    (await userTexts(second.conversation)).filter((text) =>
      text.includes("because the server restarted"),
    );
  await until(
    async () => (await restarted()).length === 2,
    "both lost notices",
  );
  const lost = await restarted();
  expect(lost.every((text) => !text.includes("could not be proven gone"))).toBe(
    true,
  );
  stranger.kill("SIGKILL");
  await second.harness.close(context);
  await second.shells.shutdown();
});

function unverifiableAtFirst(refusals: number) {
  return (group: Parameters<typeof stopGroup>[0]) =>
    refusals-- > 0 ? Promise.resolve(false) : stopGroup(group);
}

test("a group an abort cannot prove gone keeps a shell task that retries until it is gone", async () => {
  const { harness, conversation, shells } = await openShellHarness(
    new MemoryStorage(),
    {
      cwd: root,
      config: config(),
      stopGroup: unverifiableAtFirst(2),
    },
  );
  const started = await run(
    conversation,
    { command: "sleep 30", background: true },
    "bg",
  );
  const id = /shell `([^`]+)`/.exec(started)![1];
  expect(
    await stopConversationShells(harness, conversation.id, context),
  ).toEqual({ stopped: 0, pending: [id] });
  expect(groupMembers(pgidOf(started)).length).toBeGreaterThan(0);
  const [successor] = await shellTasks(harness);
  expect(successor!.record.state).toMatchObject({
    checkpoint: { phase: "stop" },
  });
  await until(
    async () => (await shellTasks(harness)).length === 0,
    "the retries to stop the group",
  );
  expect(groupMembers(pgidOf(started))).toEqual([]);
  await harness.close(context);
  await shells.shutdown();
});

test("after a restart, a group not yet proven gone stays owned and gets one lost notice", async () => {
  const db = join(root, "unverified.sqlite");
  const first = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    { cwd: root, config: config() },
  );
  const owned = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const identity = await until(() => procStartTime(owned.pid!), "the process");
  await first.harness.commit(async (tx) => {
    await tx.createTask(
      first.shells.task,
      {
        shellId: "held",
        pid: owned.pid!,
        pgid: owned.pid!,
        identity,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        logPath: join(root, "held.log"),
        command: "sleep 30",
        startedAt: Date.now(),
        key: "agent-1",
        mode: "background",
        noticeAt: null,
        backgroundedAt: Date.now(),
        inactivityMs: 0,
      },
      {
        ownership: { kind: "conversation" },
        conversationId: first.conversation.id,
        background: true,
      },
    );
  }, context);
  await first.harness.close(context);
  const second = await openShellHarness(
    await openWorkerSqliteStorage(worker, db),
    {
      cwd: root,
      config: config(),
      stopGroup: unverifiableAtFirst(1),
    },
  );
  second.harness.resume();
  await until(async () => {
    const state = (await shellTasks(second.harness))[0]?.record.state as
      | { checkpoint?: { phase: string } }
      | undefined;
    return (
      state?.checkpoint?.phase === "stop" && groupMembers(owned.pid!).length > 0
    );
  }, "a failed first stop that keeps the task");
  await until(
    async () => (await shellTasks(second.harness)).length === 0,
    "the retry to stop the group",
  );
  expect(groupMembers(owned.pid!)).toEqual([]);
  const lost = (await userTexts(second.conversation)).filter((text) =>
    text.includes("Shell `held`"),
  );
  expect(lost).toHaveLength(1);
  expect(lost[0]).toContain("could not be proven gone");
  await second.harness.close(context);
  await second.shells.shutdown();
});

const HOST = join(import.meta.dir, "fixtures", "durable_host.ts");

function host(args: string[]): Promise<{
  code: number | null;
  signal: string | null;
  lines: Record<string, unknown>[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({
        code,
        signal,
        lines: out
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      }),
    );
  });
}

for (const killAt of ["exit-committed", "exit-submitted"]) {
  test(`a completion is posted exactly once when the host dies with SIGKILL (${killAt})`, async () => {
    const db = join(root, `${killAt}.sqlite`);
    const first = await host([
      db,
      "complete",
      killAt,
      join(root, `logs-${killAt}`),
    ]);
    expect(first.signal).toBe("SIGKILL");
    const second = await host([
      db,
      "resume",
      "none",
      join(root, `logs-${killAt}`),
    ]);
    expect(second.code).toBe(0);
    const report = second.lines.at(-1)!;
    expect(report.exitNotices).toBe(1);
    expect(report.lostNotices).toBe(0);
    expect(report.answered).toBe(true);
  }, 60_000);
}

for (const [owner, delayed] of [
  ["current-owner", ""],
  ["old-owner", ""],
  ["old-owner", "delayed-setsid"],
] as const) {
  // Regression: #2603 wait for the escaped child's new session, not its launcher PID.
  test(`a group recorded with ${owner}${delayed ? ` (${delayed})` : ""} survives a SIGKILLed host and is recovered with one lost notice`, async () => {
    const db = join(root, `survivor-${owner}-${delayed}.sqlite`);
    const logDir = join(root, `logs-survivor-${owner}-${delayed}`);
    const first = await host([db, "survive", owner, logDir, delayed]);
    expect(first.signal).toBe("SIGKILL");
    const { pgid, fgPgid, escaped } = first.lines.find(
      (line) => "pgid" in line,
    ) as Record<string, number>;
    const survivors = Object.entries({ pgid, fgPgid, escaped }).map(
      ([name, group]) => {
        let identity = "gone";
        try {
          const raw = readFileSync(`/proc/${group}/stat`, "utf8");
          const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          identity = `pid=${group} pgid=${fields[2]} sid=${fields[3]} state=${fields[0]}`;
        } catch {}
        return { name, identity, members: groupMembers(group!) };
      },
    );
    const second = await host([db, "resume", "none", logDir]);
    expect(second.code).toBe(0);
    for (const { name, identity, members } of survivors)
      expect(members.length, `${name}: ${identity}`).toBeGreaterThan(0);
    for (const group of [pgid, fgPgid, escaped])
      expect(groupMembers(group!)).toEqual([]);
    const report = second.lines.at(-1)!;
    expect(report.lostNotices).toBe(1);
    expect(report.recoverPending).toEqual([]);
    expect(readdirSync(join(logDir, "state"))).toEqual([]);
    const third = await host([db, "resume", "none", logDir]);
    expect(third.lines.at(-1)!.lostNotices).toBe(1);
  }, 60_000);
}
