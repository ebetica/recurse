import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  SqliteWorker,
  openWorkerSqliteStorage,
} from "../../src/agents/durable/sqlite_worker";
import { switchoverWorld, until } from "./fixtures/durable_host/host";
const worlds: Awaited<ReturnType<typeof switchoverWorld>>[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});
async function world() {
  const w = await switchoverWorld();
  worlds.push(w);
  return w;
}
const signal = () => new AbortController().signal;

test("maintenance imports children before roots, including Settings custom providers; next turns are native", async () => {
  const w = await world();
  const root = "aaaaaaaaaaaa",
    child = "bbbbbbbbbbbb",
    custom = "cccccccccccc";
  const file = await w.row(root);
  const original = await readFile(file);
  await w.row(child, root);
  await w.row(custom, root, "recurse-test/scripted");
  w.instance.lifecycle.launchMaintenanceJob("pi_switchover", (s) =>
    w.move.run(s),
  );
  await w.instance.lifecycle.settleMaintenanceJobs();
  expect(w.events).toEqual([
    `pi_switchover_complete:${child}`,
    `pi_switchover_complete:${custom}`,
    `pi_switchover_complete:${root}`,
  ]);
  expect(w.load(custom)?.backend).toBe("durable");
  expect(w.load(root)?.backend).toBe("durable");
  expect(await readFile(file)).toEqual(original);
  const marker = JSON.parse(
    await readFile(join(w.host.storagePath(root), "../import.json"), "utf8"),
  );
  expect(marker.backend).toBe("durable");
  w.faux.setResponses([fauxAssistantMessage([fauxText("SWITCHED")])]);
  await w.host.send(root, "Continue.", "next");
  await until(() => w.host.runningCount() === 0);
  expect(JSON.stringify(await w.host.view(root))).toContain("SWITCHED");
  await w.host.send(custom, "Continue.", "custom-next");
  await until(() => w.host.runningCount() === 0);
  expect(JSON.stringify(await w.host.view(custom))).toContain(
    "CUSTOM-SWITCHED",
  );
  expect(w.requests).toHaveLength(1);
});

async function trashed(w: { root: string }, text: string) {
  const trash = join(w.root, "data/trash");
  const names = await readdir(trash, { recursive: true }).catch(() => []);
  for (const name of names)
    if ((await readFile(join(trash, name), "utf8").catch(() => null)) === text)
      return true;
  return false;
}

test("reaping an imported legacy conversation retires its original session file and owner sidecar", async () => {
  const w = await world();
  const cid = "aaaaaaaaaaaa";
  const file = await w.row(cid);
  const original = await readFile(file, "utf8");
  await writeFile(`${file}.owner.json`, '{"sidecar":1}');
  w.instance.lifecycle.launchMaintenanceJob("pi_switchover", (s) =>
    w.move.run(s),
  );
  await w.instance.lifecycle.settleMaintenanceJobs();
  expect(w.load(cid)?.backend).toBe("durable");
  expect(await w.instance.reap.reap(cid)).toContain(cid);
  expect(await readdir(join(w.root, "data/pi_sessions"))).toEqual([]);
  expect(await trashed(w, original)).toBe(true);
  expect(await trashed(w, '{"sidecar":1}')).toBe(true);
});

for (const reject of [false, true, "before", "during"] as const)
  test(`verified history before queued replay; rejecting send=${reject}`, async () => {
    const w = await world(),
      cid = "dddddddddddd";
    const file = await w.row(cid),
      original = await readFile(file);
    const { conversations, agentStore: store } = w.instance;
    const node = w.instance.nodes.node(cid, conversations.agentStore);
    const uncertain = node.submit("submission", {
      id: "uncertain",
      content: "UNKNOWN-ACCEPTANCE",
      origin: "operator",
    })!;
    store.noteDispatched(cid, uncertain);
    node.markUncertain(uncertain, "Restart interrupted acceptance");
    node.submit("submission", {
      id: "queued",
      content: "FIRST-QUEUED",
      origin: "operator",
    });
    let release!: () => void,
      entered = false;
    const mark = store.noteDispatched.bind(store);
    // test-check-allow: T3 Records real dispatch before native cancellation.
    spyOn(store, "noteDispatched").mockImplementationOnce((c, id) => {
      mark(c, id);
      if (reject === "before") node.cancelDrive();
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const importPi = w.host.importPi.bind(w.host);
    // test-check-allow: T3 Gate delays real Pi import; its result is unchanged.
    spyOn(w.host, "importPi").mockImplementation(async (...args) => {
      entered = true;
      await barrier;
      return importPi(...args);
    });
    // test-check-allow: T3 Delegates to the real private-root switchover owner.
    spyOn(w.instance.switchover, "attempt").mockImplementation((conv, s) =>
      w.move.attempt(conv, s),
    );
    const admitted: string[] = [];
    // test-check-allow: T3 Real sends; faults bracket actual native acceptance.
    spyOn(w.instance.durable, "send").mockImplementation(async (...args) => {
      expect(w.load(cid)?.backend).toBe("durable");
      const marker = await Bun.file(
        join(w.host.storagePath(cid), "../import.json"),
      ).json();
      expect(marker.backend).toBe("durable");
      admitted.push(args[2]);
      if (reject && reject !== "before" && admitted.length === 1) {
        if (reject === "during") {
          await w.host.send(...args);
          node.cancelDrive();
        }
        throw new Error("send rejected");
      }
      return w.host.send(...args);
    });
    w.faux.setResponses([
      fauxAssistantMessage([fauxText("REPLAYED")]),
      fauxAssistantMessage([fauxText("REPLAYED-LATER")]),
    ]);
    w.instance.delivery.requestRun(cid);
    await until(() => entered);
    await w.instance.delivery.deliver(cid, "SECOND-QUEUED", {
      origin: "operator",
      messageId: "later",
    });
    expect(admitted).toEqual([]);
    expect(w.load(cid)?.backend).toBe("pi");
    release();
    if (reject) {
      await until(() => node.turnTask === null);
      expect(node.oldestSendable()?.id).toBe("later");
      const queued = node.pendingIntents().find((row) => row.id === "queued")!;
      expect(queued.error_detail).toContain(
        reject === "before" ? "Cancelled" : "send rejected",
      );
      await store.flush(cid);
      const [, intents] = await store.loadPersistedAgent(cid);
      expect(intents[1]!.dispatched).toBe(true);
      expect(node.retryQueued("queued")).toBe(true);
      w.instance.delivery.requestRun(cid);
    }
    await until(() => node.turnTask === null && w.host.runningCount() === 0);
    if (reject && reject !== "before")
      expect(admitted.shift()).toBe("op:operator::queued");
    expect(admitted).toEqual(["op:operator::queued", "op:operator::later"]);
    expect(node.pendingIntents().map((row) => row.id)).toEqual(["uncertain"]);
    expect(node.oldestSendable()).toBeNull();
    const view = JSON.stringify(await w.host.view(cid));
    expect(view).toContain("FIRST-QUEUED");
    expect(view).toContain("SECOND-QUEUED");
    expect(view).toContain("REPLAYED");
    expect(view).not.toContain("UNKNOWN-ACCEPTANCE");
    expect(await readFile(file)).toEqual(original);
  });

test("missing bindings expose failure without replacing original history with an empty session", async () => {
  const w = await world(),
    cid = "999999999999";
  const file = await w.row(cid),
    original = await readFile(file);
  await w.instance.conversations.save({ ...w.load(cid)!, session_file: null });
  await w.move.run(signal());
  expect(w.load(cid)?.backend).toBe("pi");
  expect((w.load(cid)?.backend_change as { reason: string }).reason).toContain(
    "original session binding is missing",
  );
  expect(
    await Bun.file(join(w.host.storagePath(cid), "../import.json")).exists(),
  ).toBe(false);
  expect(await readFile(file)).toEqual(original);
});

test("a failed import remains Pi, exposes a reason, backs off and successfully retries", async () => {
  const w = await world(),
    cid = "eeeeeeeeeeee";
  const file = await w.row(cid),
    original = await readFile(file);
  await writeFile(file, "not a session\n");
  await w.move.run(signal());
  expect(w.load(cid)?.backend).toBe("pi");
  expect((w.load(cid)?.backend_change as { state: string }).state).toBe(
    "failed",
  );
  const failures = w.events.length;
  await writeFile(file, new Uint8Array(original));
  await w.move.run(signal());
  expect(w.events.length).toBe(failures);
  w.advance();
  await w.move.run(signal());
  expect(w.load(cid)?.backend).toBe("durable");
});

for (const change of ["settings", "source"] as const)
  test(`a ${change} race during cloning defers publication and safely retries`, async () => {
    const w = await world(),
      cid = "111111111111";
    const file = await w.row(cid);
    const importPi = w.host.importPi.bind(w.host);
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // test-check-allow: T3 Gate pauses real import publication, not its result.
    const hold = spyOn(w.host, "importPi").mockImplementation(
      (conv, options, signal) =>
        importPi(
          conv,
          {
            ...options,
            publish: async (commit) => {
              reached();
              await gate;
              return options.publish!(commit);
            },
          },
          signal,
        ),
    );
    const pending = w.move.run(signal());
    await started;
    if (change === "settings")
      await w.instance.conversations.save({
        ...w.load(cid)!,
        title: "changed while cloning",
      });
    if (change === "source")
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    release();
    await pending;
    hold.mockRestore();
    expect(w.load(cid)?.backend).toBe("pi");
    expect(
      await Bun.file(join(w.host.storagePath(cid), "../import.json")).exists(),
    ).toBe(false);
    await w.move.run(signal());
    expect(w.load(cid)?.backend).toBe("durable");
  });

test("failed group proof retains ownership; retry proves an exited leader's surviving group absent before switching", async () => {
  const w = await world(),
    cid = "222222222222";
  await w.row(cid);
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      "Bun.spawn([process.execPath,'-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"]);setTimeout(()=>process.exit(0),500)",
    ],
    { detached: true, stdout: "ignore", stderr: "ignore" },
  );
  const handle = await w.instance.processes.registerProcess(
    proc,
    "pi-rpc",
    cid,
  );
  const row = { ...w.instance.processes.rows.get(handle.recordId)! };
  try {
    await proc.exited;
    expect(await w.instance.processes.sessionMemberState(row)).toBe("present");
    // test-check-allow: T3 Fault keeps real group owned until native stop.
    const unverified = spyOn(
      w.instance.processes,
      "stopGroup",
    ).mockResolvedValue(false);
    await w.move.run(signal());
    unverified.mockRestore();
    expect(w.load(cid)?.backend).toBe("pi");
    expect(w.instance.processes.owned.has(handle.recordId)).toBe(true);
    expect(w.instance.processes.rows.has(handle.recordId)).toBe(true);
    w.advance();
    await w.move.run(signal());
    expect(w.load(cid)?.backend).toBe("durable");
    expect(await w.instance.processes.sessionMemberState(row)).toBe("absent");
  } finally {
    await w.instance.processes.stopGroup(row);
  }
});

test("an untagged import is retired recoverably and replaced from the current authoritative Pi session", async () => {
  const w = await world(),
    cid = "333333333333",
    file = await w.row(cid);
  await w.host.importPi(
    w.load(cid)!,
    { state: () => ({ running: false, queued: 0 }) },
    signal(),
  );
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const next = { ...JSON.parse(lines[1]!), id: "e8", parentId: "e7" };
  await writeFile(file, lines.join("\n") + "\n" + JSON.stringify(next) + "\n");
  await w.move.run(signal());
  const marker = JSON.parse(
    await readFile(join(w.host.storagePath(cid), "../import.json"), "utf8"),
  );
  expect([w.load(cid)?.backend, marker.entries]).toEqual(["durable", 2]);
  const trash = join(w.root, "data/trash"),
    retired = await readdir(trash);
  expect(retired.length).toBeGreaterThan(0);
  expect(
    JSON.parse(await readFile(join(trash, retired[0]!, "import.json"), "utf8"))
      .backend,
  ).toBeUndefined();
});

for (const action of ["input", "clear", "compact"] as const)
  test(`foreground ${action} waits during group close without resurrecting Pi`, async () => {
    const w = await world(),
      cid = "444444444444";
    await w.row(cid);
    const proc = Bun.spawn(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const handle = await w.instance.processes.registerProcess(
      proc,
      "pi-rpc",
      cid,
    );
    const row = { ...w.instance.processes.rows.get(handle.recordId)! };
    const stopGroup = w.instance.processes.stopGroup.bind(w.instance.processes);
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        reached = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    // test-check-allow: T3 Gate delays native stop; real absence is asserted.
    const hold = spyOn(w.instance.processes, "stopGroup").mockImplementation(
      async (group) => {
        reached();
        await gate;
        return stopGroup(group);
      },
    );
    // test-check-allow: T3 Delegates sends to the real Durable host.
    const route = spyOn(w.instance.durable, "send").mockImplementation(
      w.host.send.bind(w.host),
    );
    // test-check-allow: T3 Delegates clearing to the real Durable host.
    const clear = spyOn(w.instance.durable, "clear").mockImplementation(
      w.host.clear.bind(w.host),
    );
    // test-check-allow: T3 Runs the real safety guard and host compaction.
    const compact = spyOn(w.instance.durable, "compact").mockImplementation(
      async (cid) => {
        await w.instance.conversations.withSafetyGuard(cid, async () => {});
        return w.host.compact(cid);
      },
    );
    try {
      const move = w.move.run(signal());
      await started;
      w.faux.setResponses([
        fauxAssistantMessage([fauxText("ADMITTED-DURABLE")]),
      ]);
      let admitted = false;
      const admission = Promise.withResolvers<void>();
      const guard = w.instance.conversations.withSafetyGuard.bind(
        w.instance.conversations,
      );
      // test-check-allow: T3 Observes the real guard's pending promise.
      const waiting = spyOn(
        w.instance.conversations,
        "withSafetyGuard",
      ).mockImplementation(
        <T>(cid: string, fn: () => Promise<T>, nodeToken?: object) => {
          const pending = guard(cid, fn, nodeToken);
          admission.resolve();
          return pending;
        },
      );
      const pending =
        action === "input"
          ? w.instance.delivery.deliver(cid, "Continue.")
          : action === "clear"
            ? w.instance.parked.requestClear(cid)
            : w.instance.parked.requestCompact(cid);
      const send = pending.then(() => {
        admitted = true;
      });
      await admission.promise;
      waiting.mockRestore();
      expect(admitted).toBe(false);
      expect(w.instance.nodes.node(cid).pendingIntents()).toEqual([]);
      release();
      await move;
      await send;
      await until(() => w.host.runningCount() === 0);
      if (action === "input")
        expect(JSON.stringify(await w.host.view(cid))).toContain(
          "ADMITTED-DURABLE",
        );
      expect(w.instance.parked.pendingActions(cid)).toEqual([]);
      expect(await w.instance.processes.sessionMemberState(row)).toBe("absent");
    } finally {
      release();
      hold.mockRestore();
      route.mockRestore();
      clear.mockRestore();
      compact.mockRestore();
      await stopGroup(row);
    }
  });

for (const workdir of [null, ""])
  test(`legacy ${workdir === null ? "missing" : "empty"} workdir keeps Pi's effective cwd`, async () => {
    const w = await world(),
      cid = "555555555555";
    await w.row(cid);
    await w.instance.conversations.save({
      ...w.load(cid)!,
      workdir,
      session_cwd: "/stale-session-cwd",
    });
    const expected = w.instance.conversations.effectiveWorkdir(w.load(cid)!);
    await w.move.run(signal());
    const worker = new SqliteWorker();
    const harness = await Harness.open(
      await openWorkerSqliteStorage(worker, w.host.storagePath(cid)),
      { models: createModels(), registry: createRegistry() },
      context,
    );
    try {
      expect((await (await harness.root(context)).agent(context)).cwd).toBe(
        expected,
      );
    } finally {
      await harness.close(context);
      worker.close();
    }
  });

test("committed marker restores Durable after a metadata failure, without letting Pi resume", async () => {
  const w = await world(),
    cid = "ffffffffffff";
  await w.row(cid);
  await w.instance.agentStore.flush(cid);
  // test-check-allow: T3 Fails metadata write after a real import commit.
  const enqueue = spyOn(
    w.instance.agentStore,
    "enqueueMetadata",
  ).mockImplementation(() => {
    throw new Error("metadata fault");
  });
  await w.move.run(signal());
  enqueue.mockRestore();
  expect(w.load(cid)?.backend).toBe("durable");
  expect(
    (await w.instance.conversations.collectAgentMetadata())[cid]?.backend,
  ).toBe("durable");
});

test("an import does not queue behind a live conversation's SQLite statements", async () => {
  const w = await world();
  const live = "555555555555";
  await w.instance.conversations.save({
    id: live,
    parent: null,
    backend: "durable",
    model: "faux/faux-1",
    effort: "off",
    workdir: w.root,
    title: live,
    status: "idle",
  });
  w.faux.setResponses([
    fauxAssistantMessage([fauxText("one")]),
    fauxAssistantMessage([fauxText("two")]),
  ]);
  await w.host.send(live, "hello", "op:operator::busy-1");
  await until(
    () =>
      w.host.runningCount() === 0 && w.host.metadata(live).pending.length === 0,
  );
  const imported = "666666666666";
  await w.row(imported);
  const foreign = new Database(w.host.storagePath(live));
  const order: string[] = [];
  const posted = Promise.withResolvers<void>();
  const request = SqliteWorker.prototype.request;
  // test-check-allow: T3 Real SQLite request and foreign lock prove isolation.
  const spy = spyOn(SqliteWorker.prototype, "request").mockImplementation(
    function (this: SqliteWorker, ...args: Parameters<typeof request>) {
      if (args[1].op === "exec" && args[1].sql === "BEGIN IMMEDIATE") {
        foreign.exec("BEGIN IMMEDIATE");
        const reply = request.apply(this, args);
        posted.resolve();
        return reply;
      }
      return request.apply(this, args);
    },
  );
  const blocked = w.host
    .send(live, "second", "op:operator::busy-2")
    .then(
      () => "accepted",
      (error: unknown) => String(error),
    )
    .then((outcome) => order.push(`live send ${outcome}`));
  try {
    await posted.promise;
    spy.mockRestore();
    const result = await w.host.importPi(
      w.load(imported)!,
      { state: () => ({ running: false, queued: 0 }) },
      signal(),
    );
    order.push(`import ${result.status}`);
  } finally {
    spy.mockRestore();
    foreign.exec("ROLLBACK");
    foreign.close();
  }
  await blocked;
  expect(order).toEqual(["import imported", "live send accepted"]);
  await until(
    () =>
      w.host.runningCount() === 0 && w.host.metadata(live).pending.length === 0,
  );
}, 30_000);
