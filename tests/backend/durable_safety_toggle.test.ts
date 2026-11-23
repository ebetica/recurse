import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { BackendKeys } from "../../src/auth/backend_keys";
import { OperatorAuth } from "../../src/auth/session";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  SqliteWorker,
  openWorkerSqliteStorage,
} from "../../src/agents/durable/sqlite_worker";
import {
  safetyOffRevision,
  safetyReviewOff,
} from "../../src/extensions/core/safety/durable";
import { buildApp, WebLogSink } from "../../src/web/app";
import {
  MAX_PER_AGENT_OPS,
  MailboxFull,
} from "../../src/agents/storage/agent_store";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { appWorld } from "./web_app_support";
import { fauxHost, switchoverWorld, until } from "./fixtures/durable_host/host";
import type {
  ConversationGuardToken,
  ConversationRecord,
  ConversationStore,
} from "../../src/agents/storage";

// Regression: #2912 conversation operator actions reject agent and loopback credentials.
test("operator conversation actions require operator authentication", async () => {
  const { root, env } = appWorld({ password: true });
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const running = await app.serve({ port: 0 });
  const operator = new OperatorAuth({
    authFile: join(env.CHAT_DATA_DIR!, "auth.json"),
    env,
    displayName: "Recurse",
  });
  const cookie = `chat_auth=${await operator.makeToken()}`;
  const token = JSON.parse(
    readFileSync(join(env.CHAT_DATA_DIR!, "server.json"), "utf8"),
  ).token as string;
  const key = await new BackendKeys(env.CHAT_DATA_DIR!).mint("home");
  const call = (
    path: string,
    body: object,
    headers: Record<string, string> | [string, string][],
  ) =>
    fetch(`${running.url}${path}`, {
      method: "POST",
      headers: new Headers([
        ["content-type", "application/json"],
        ...(Array.isArray(headers) ? headers : Object.entries(headers)),
      ]),
      body: JSON.stringify(body),
    });
  try {
    await until(
      async () =>
        (
          (await (
            await fetch(`${running.url}/api/status`, { headers: { cookie } })
          ).json()) as { ready: boolean }
        ).ready,
    );
    const created = await call("/api/conversations", {}, { cookie });
    expect(created.status).toBe(200);
    const cid = String(((await created.json()) as { id: string }).id);
    const path = `/api/conversations/${cid}/safety`;
    const loopback = { "x-loopback-token": token };
    const bearer = { authorization: `Bearer ${key.key}` };
    const settingsPath = "/api/settings/effort-levels";
    const readSettings = async (headers: Record<string, string>) => {
      const response = await fetch(`${running.url}${settingsPath}`, {
        headers,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        default_level: number;
        levels: object;
      };
    };
    const settings = await readSettings({ cookie });
    const changed = {
      ...settings,
      default_level: settings.default_level === 1 ? 2 : 1,
    };
    expect((await call(settingsPath, changed, loopback)).status).toBe(403);
    expect(await readSettings({ cookie })).toEqual(settings);
    expect(await readSettings({ cookie, ...loopback })).toEqual(settings);
    for (const target of ["/api/pi/auth", "/api/password"])
      expect((await call(target, {}, loopback)).status).toBe(403);
    for (const headers of [
      loopback,
      { ...loopback, "x-recurse-agent": cid },
      { cookie, "x-recurse-agent": "" },
      { ...bearer, "x-recurse-agent-caller": "" },
      { ...bearer, "x-recurse-agent": cid },
      { cookie, "x-recurse-agent-caller": cid },
      [
        ["cookie", cookie],
        ["x-recurse-agent", ""],
        ["x-recurse-agent", cid],
      ],
    ] as (Record<string, string> | [string, string][])[]) {
      expect((await call(path, { off: true }, headers)).status).toBe(403);
      expect(app.instance.conversations.load(cid)?.safety_off).not.toBe(true);
    }
    for (const action of ["take-over", "promote"]) {
      const target = `/api/conversations/${cid}/${action}`;
      for (const headers of [
        loopback,
        { ...loopback, "x-recurse-agent": cid },
        { ...bearer, "x-recurse-agent-caller": cid },
      ])
        expect((await call(target, {}, headers)).status).toBe(403);
    }
    expect(
      (
        await call(
          path,
          { off: true },
          { cookie, origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect((await call(path, { off: true }, { cookie })).status).toBe(200);
    expect(app.instance.durable.safetyOffActive(cid)).toBe(true);
    expect((await call(path, { off: false }, bearer)).status).toBe(200);
    expect(app.instance.durable.safetyReviewOff(cid)).toBe(false);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// Regression: #3665 an OFF whose record flush failed paired with an older OFF document and skipped review, and overlapping toggles replied without the current state.
test("the operator safety route controls the next Durable bash review", async () => {
  const { root, env } = appWorld();
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const fixture = fauxHost(join(root, "faux"), "faux/faux-1", true);
  const deps = (app.instance.durable as unknown as { deps: DurableHostDeps })
    .deps;
  const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  Object.assign(deps, {
    models: fake.models,
    settings: fake.settings,
    agentEnv: fake.agentEnv,
    promptSnapshot: fake.promptSnapshot,
  });
  const running = await app.serve({ port: 0 });
  const api = (path: string, body?: object) =>
    fetch(`${running.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  const host = app.instance.durable;
  const { conversations, delivery } = app.instance;
  const setter = host.setSafetyReviewOff;
  const runRequests = delivery.requestRun;
  const flush = conversations.agentStore.flush;
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const started: Promise<unknown>[] = [];
  try {
    await until(
      async () =>
        ((await (await api("/api/status")).json()) as { ready: boolean }).ready,
    );
    const created = await api("/api/conversations", {});
    expect(created.status).toBe(200);
    const cid = String(((await created.json()) as { id: string }).id);
    const path = `/api/conversations/${cid}/safety`;
    conversations.noteProjectionStale();
    const early = await api(path, { off: true });
    conversations.noteProjectionReady();
    expect(early.status).toBe(503);
    expect(conversations.load(cid)?.safety_off).toBe(false);
    const idle = async () =>
      (await host.open(cid)).conversation.waitForIdle(context);
    const noticeRuns = () => {
      const ran = Promise.withResolvers<void>();
      const requestRun = delivery.requestRun;
      delivery.requestRun = (id: string) => {
        requestRun.call(delivery, id);
        if (id !== cid) return;
        delivery.requestRun = requestRun;
        ran.resolve();
      };
      return ran.promise.then(async () => {
        await app.instance.nodes.node(cid).turnTask;
        await idle();
      });
    };
    const rollBackNextCommit = async () => {
      const { conversation } = await host.open(cid);
      const commit = conversation.commit;
      conversation.commit = ((...args: Parameters<typeof commit>) => {
        conversation.commit = commit;
        const [change, ...rest] = args;
        return commit.call(
          conversation,
          async (tx) => {
            await change(tx);
            throw new Error("safety commit rolled back");
          },
          ...rest,
        );
      }) as typeof commit;
      return () => (conversation.commit = commit);
    };
    const stored = async () => {
      expect(await conversations.agentStore.flush(cid)).toBe(true);
      return conversations.loadCanonicalMetadata(cid);
    };
    const documentOff = async () => {
      const { harness, conversation } = await host.open(cid);
      return safetyReviewOff(harness, conversation, context);
    };
    const service = () =>
      delivery.deliver(cid, "service input", {
        start: false,
        origin: "service",
      });
    const { faux } = fixture;
    const runsUnreviewed = async (name: string) => {
      const file = join(fixture.work, name);
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("DENY: test refusal"),
        fauxAssistantMessage("done"),
      ]);
      await host.send(cid, "create the file", `call-${name}`);
      await idle();
      return existsSync(file);
    };
    for (const off of [true, false]) {
      faux.setResponses([fauxAssistantMessage("ack")]);
      const noticed = noticeRuns();
      const response = await api(path, { off });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: cid,
        safety_off: off,
        safety_off_active: off,
        safety_rev: conversations.load(cid)?.safety_rev,
      });
      await noticed;
      const before = faux.state.callCount;
      const file = join(fixture.work, String(off));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        ...(!off ? [fauxAssistantMessage("DENY: test refusal")] : []),
        fauxAssistantMessage("done"),
      ]);
      await host.send(cid, "create the file", `call-${off}`);
      await idle();
      expect(existsSync(file)).toBe(off);
      expect(faux.state.callCount - before).toBe(off ? 2 : 3);
    }
    const calls = faux.state.callCount;
    const restoreFailed = await rollBackNextCommit();
    const failed = await api(path, { off: true }).finally(restoreFailed);
    expect(failed.status).toBe(500);
    expect((await stored())?.safety_off).toBe(true);
    expect(await documentOff()).toBe(false);
    expect(host.metadata(cid).safety_off_active).toBe(false);
    expect(await service()).toBe(null);
    expect(app.instance.nodes.node(cid).pendingIntents()).toEqual([]);
    expect(faux.state.callCount).toBe(calls);
    expect((await api(path, { off: true })).status).toBe(200);
    expect((await stored())?.safety_off).toBe(true);
    expect(await documentOff()).toBe(true);
    const restoreRolledBack = await rollBackNextCommit();
    const rolledBack = await api(path, { off: false }).finally(
      restoreRolledBack,
    );
    expect(rolledBack.status).toBe(500);
    expect((await stored())?.safety_off).toBe(false);
    expect(await documentOff()).toBe(true);
    expect(host.metadata(cid).safety_off_active).toBe(false);
    expect(await service()).toBe(null);
    expect(await runsUnreviewed("rolled-back")).toBe(false);
    conversations.agentStore.flush = (async (
      ...args: Parameters<typeof flush>
    ) =>
      args[0] !== cid &&
      flush.apply(conversations.agentStore, args)) as typeof flush;
    const unflushed = await api(path, { off: true }).finally(
      () => (conversations.agentStore.flush = flush),
    );
    expect(unflushed.status).toBe(500);
    expect(conversations.load(cid)?.safety_off).toBe(true);
    expect(await documentOff()).toBe(true);
    expect(host.metadata(cid).safety_off_active).toBe(false);
    expect(await service()).toBe(null);
    expect(await runsUnreviewed("unflushed")).toBe(false);
    const reached = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let commits = 0;
    host.setSafetyReviewOff = (async (...args: Parameters<typeof setter>) => {
      const index = commits++;
      reached[index]?.resolve();
      await gates[index]?.promise;
      return setter.apply(host, args);
    }) as typeof setter;
    const on = api(path, { off: false });
    started.push(on);
    await reach(reached[0]!.promise, on);
    const off = api(path, { off: true });
    started.push(off);
    await reach(reached[1]!.promise, off);
    const rev = conversations.load(cid)?.safety_rev;
    faux.setResponses([fauxAssistantMessage("ack")]);
    const offNoticed = noticeRuns();
    gates[0]!.resolve();
    const superseded = await on;
    expect([superseded.status, await superseded.json()]).toEqual([
      409,
      {
        error: "a newer safety request for this conversation replaced this one",
        id: cid,
        safety_off: true,
        safety_off_active: false,
        safety_rev: rev,
      },
    ]);
    gates[1]!.resolve();
    const applied = await off;
    expect([applied.status, await applied.json()]).toEqual([
      200,
      { id: cid, safety_off: true, safety_off_active: true, safety_rev: rev },
    ]);
    await offNoticed;
    expect(await runsUnreviewed("applied")).toBe(true);
    host.setSafetyReviewOff = setter;
    const { harness, conversation } = await host.open(cid);
    started.push(
      app.instance.nodes.node(cid).withLock(() => gates[2]!.promise),
    );
    faux.setResponses([fauxAssistantMessage("ack")]);
    const onNoticed = noticeRuns();
    const turnedOn = await api(path, { off: false });
    expect(turnedOn.status).toBe(200);
    expect(await safetyReviewOff(harness, conversation, context)).toBe(false);
    expect(
      JSON.stringify(app.instance.nodes.node(cid).pendingIntents()),
    ).not.toContain("Safety review turned ON");
    gates[2]!.resolve();
    await onNoticed;
    expect(await runsUnreviewed("turned-on")).toBe(false);
    const commit = conversation.commit;
    const queued = Promise.withResolvers<void>();
    const line = Promise.withResolvers<void>();
    conversation.commit = ((...args: Parameters<typeof commit>) => {
      conversation.commit = commit;
      started.push(
        commit.call(
          conversation,
          async () => {
            line.resolve();
            await gates[3]!.promise;
          },
          context,
        ),
      );
      const [change, ...rest] = args;
      const result = commit.call(
        conversation,
        async (tx) => {
          await change(tx);
          throw new Error("safety commit rolled back");
        },
        ...rest,
      );
      queued.resolve();
      return result;
    }) as typeof commit;
    const heldOff = api(path, { off: true });
    started.push(heldOff);
    await reach(queued.promise, heldOff);
    await reach(line.promise, heldOff);
    gates[3]!.resolve();
    expect((await heldOff).status).toBe(500);
    expect(await safetyReviewOff(harness, conversation, context)).toBe(false);
    expect(host.metadata(cid).safety_off_active).toBe(false);
  } finally {
    host.setSafetyReviewOff = setter;
    delivery.requestRun = runRequests;
    conversations.agentStore.flush = flush;
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(started);
    await running.close();
    await app.instance.shutdown();
    await fixture.host.close();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

const reach = <T>(checkpoint: Promise<T>, operation: Promise<unknown>) =>
  Promise.race([
    checkpoint,
    operation.then(() => {
      throw new Error("the operation settled before its checkpoint");
    }),
  ]);

const settled = async (
  reply: Promise<[ConversationRecord, Promise<boolean>]>,
) => {
  const [conv, admitted] = await reply;
  await admitted;
  return conv;
};

const outcome = (reply: Promise<[ConversationRecord, Promise<boolean>]>) =>
  settled(reply).then(
    (conv) => Boolean(conv.safety_off),
    (error: Error) => {
      if (error.message.includes("replaced this one")) return "superseded";
      throw error;
    },
  );

const model = "recurse-test/scripted";

// Regression: #3665 an older request's Durable commit could overwrite a newer request.
test("an older request's Durable commit writes nothing once a newer request is accepted", async () => {
  const world = await switchoverWorld();
  const started: Promise<unknown>[] = [];
  const gates: PromiseWithResolvers<void>[] = [];
  const { conversations, create, durable, nodes } = world.instance;
  let restore = () => {};
  try {
    await create.create({ cid: "held", model });
    const { harness, conversation } = await durable.open("held");
    const commit = conversation.commit;
    restore = () => (conversation.commit = commit);
    for (const older of [true, false]) {
      await settled(nodes.node("held").setSafety(!older));
      const line = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      const queued = Promise.withResolvers<{ result: Promise<unknown> }>();
      let holding: Promise<unknown> = Promise.resolve();
      conversation.commit = ((...args: Parameters<typeof commit>) => {
        conversation.commit = commit;
        holding = commit.call(
          conversation,
          async () => {
            line.resolve();
            await gate.promise;
          },
          context,
        );
        started.push(holding);
        const result = commit.apply(conversation, args);
        queued.resolve({ result });
        return result;
      }) as typeof commit;
      const first = outcome(nodes.node("held").setSafety(older));
      started.push(first);
      const { result: written } = await reach(queued.promise, first);
      await reach(line.promise, holding);
      const accepted = conversations.newestSafety("held");
      const second = outcome(nodes.node("held").setSafety(!older));
      started.push(second);
      expect(conversations.newestSafety("held")).not.toBe(accepted);
      gate.resolve();
      await holding;
      expect(await written).toBe(!older);
      expect(await first).toBe("superseded");
      expect(await second).toBe(!older);
      expect(await safetyReviewOff(harness, conversation, context)).toBe(
        !older,
      );
      expect(durable.safetyOffActive("held")).toBe(!older);
    }
  } finally {
    restore();
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 a record OFF whose Durable commit failed paired with an older OFF document after a restart.
test("review stays ON after a restart between an OFF's record flush and its Durable commit", async () => {
  const world = await switchoverWorld();
  const { conversations, create, durable, nodes } = world.instance;
  let restore = () => {};
  try {
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    expect(durable.safetyOffActive("held")).toBe(true);
    const { conversation } = await durable.open("held");
    const commit = conversation.commit;
    restore = () => (conversation.commit = commit);
    conversation.commit = ((...args: Parameters<typeof commit>) => {
      const [change, ...rest] = args;
      return commit.call(
        conversation,
        async (tx) => {
          await change(tx);
          throw new Error("safety commit rolled back");
        },
        ...rest,
      );
    }) as typeof commit;
    for (const off of [false, true])
      expect(
        String(
          await nodes
            .node("held")
            .setSafety(off)
            .then(
              () => null,
              (error: unknown) => error,
            ),
        ),
      ).toContain("safety commit rolled back");
    restore();
    expect(await conversations.agentStore.flush("held")).toBe(true);
    expect(await conversations.loadCanonicalMetadata("held")).toMatchObject({
      safety_off: true,
      safety_rev: conversations.load("held")?.safety_rev,
    });
    expect(durable.safetyReviewOff("held")).toBe(true);
    expect(durable.safetyOffActive("held")).toBe(false);
    await durable.close();
    await world.host.open("held");
    expect(world.host.safetyReviewOff("held")).toBe(true);
    expect(world.host.safetyOffActive("held")).toBe(false);
  } finally {
    restore();
    await world.close();
  }
});

// Regression: #3665 an accepted ON was lost when the server stopped before Durable committed it.
test("an accepted ON is restored when the server stops before Durable commits it", async () => {
  const world = await switchoverWorld();
  try {
    const { conversations, create, durable, nodes } = world.instance;
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    expect(durable.safetyReviewOff("held")).toBe(true);
    await durable.close();
    await expect(nodes.node("held").setSafety(false)).rejects.toThrow(
      "server is stopping",
    );
    expect(await conversations.agentStore.flush("held")).toBe(true);
    const stored = await conversations.loadCanonicalMetadata("held");
    expect(Boolean(stored?.safety_off)).toBe(false);
    await world.host.open("held");
    expect(world.host.safetyReviewOff("held")).toBe(false);
  } finally {
    await world.close();
  }
});

// Regression: #3665 service input was checked before its admission commit, so an OFF requested in between let it in, and a refused queued intent held later input.
test("service input is refused in its admission commit once an OFF is requested, and a refused queued intent is dropped", async () => {
  const world = await switchoverWorld();
  const gate = Promise.withResolvers<void>();
  const started: Promise<unknown>[] = [];
  const { create, delivery, durable, nodes } = world.instance;
  const send = durable.send;
  try {
    await create.create({ cid: "held", model });
    const { harness, conversation } = await durable.open("held");
    const submit = conversation.submit;
    const admitting =
      Promise.withResolvers<Awaited<ReturnType<typeof submit>>>();
    conversation.submit = (async (...args: Parameters<typeof submit>) => {
      conversation.submit = submit;
      const id = await submit.apply(conversation, args);
      admitting.resolve(id);
      await gate.promise;
      return id;
    }) as typeof submit;
    const service = { start: false, origin: "service" } as const;
    const late = delivery.deliver("held", "checked at admission", service);
    started.push(late);
    const provisional = await reach(admitting.promise, late);
    const off = outcome(nodes.node("held").setSafety(true));
    started.push(off);
    gate.resolve();
    expect(await late).toBe(null);
    expect(await harness.submission(provisional, context)).toBeUndefined();
    expect(await off).toBe(true);
    expect(await outcome(nodes.node("held").setSafety(false))).toBe(false);
    const queued = await delivery.deliver("held", "queued", service);
    expect(queued).toEqual(expect.any(String));
    const refused = Promise.withResolvers<string | null>();
    durable.send = (async (...args: Parameters<typeof send>) => {
      const accepted = await send.apply(durable, args);
      if (args[2].endsWith(`:${queued}`)) refused.resolve(accepted);
      return accepted;
    }) as typeof send;
    expect(await outcome(nodes.node("held").setSafety(true))).toBe(true);
    delivery.requestRun("held");
    const driver = nodes.node("held").turnTask!;
    expect(await reach(refused.promise, driver)).toBe(null);
    await driver;
    expect(
      nodes
        .node("held")
        .pendingIntents()
        .map((intent) => intent.id),
    ).not.toContain(queued);
  } finally {
    durable.send = send;
    gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 an ON whose record write was refused left Durable review OFF, an older OFF could still commit after it, a newer refused OFF cancelled it, it could overwrite a newer committed OFF, and a reopen restored the OFF.
test("an ON whose record write is refused still turns Durable review ON and supersedes an older OFF", async () => {
  const world = await switchoverWorld();
  const { conversations, create, durable, nodes } = world.instance;
  const setter = durable.setSafetyReviewOff;
  const releases: (() => void)[] = [];
  const started: Promise<unknown>[] = [];
  const hold = () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(() => release.resolve());
    durable.setSafetyReviewOff = (async (
      ...args: Parameters<typeof setter>
    ) => {
      durable.setSafetyReviewOff = setter;
      reached.resolve();
      await release.promise;
      return setter.apply(durable, args);
    }) as typeof setter;
    return { reached: reached.promise, release: () => release.resolve() };
  };
  const fill = () =>
    expect(() => {
      for (let i = 0; i <= MAX_PER_AGENT_OPS; i++)
        conversations.agentStore.retire("held", `absent-${i}`);
    }).toThrow(MailboxFull);
  const refuseOn = () =>
    nodes
      .node("held")
      .setSafety(false)
      .then(
        () => "applied",
        (error: unknown) => String(error),
      );
  try {
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    expect(durable.safetyOffActive("held")).toBe(true);
    const fallback = hold();
    fill();
    const refused = refuseOn();
    started.push(refused);
    await reach(fallback.reached, refused);
    expect(durable.safetyReviewOff("held")).toBe(true);
    expect(durable.safetyOffActive("held")).toBe(false);
    fallback.release();
    expect(await refused).toContain("safety record write refused");
    expect(conversations.load("held")?.safety_off).toBe(true);
    expect(durable.safetyReviewOff("held")).toBe(false);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    const commit = hold();
    const older = outcome(nodes.node("held").setSafety(true));
    started.push(older);
    await reach(commit.reached, older);
    fill();
    expect(await refuseOn()).toContain("safety record write refused");
    commit.release();
    expect(await older).toBe("superseded");
    expect(durable.safetyReviewOff("held")).toBe(false);
    expect(durable.safetyOffActive("held")).toBe(false);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    await settled(nodes.node("held").setSafety(true));
    expect(durable.safetyOffActive("held")).toBe(true);
    const overtaken = hold();
    fill();
    const on = refuseOn();
    started.push(on);
    await reach(overtaken.reached, on);
    fill();
    expect(
      String(
        await nodes
          .node("held")
          .setSafety(true)
          .then(
            () => null,
            (error: unknown) => error,
          ),
      ),
    ).toContain("safety record write refused");
    overtaken.release();
    expect(await on).toContain("safety record write refused");
    expect(durable.safetyReviewOff("held")).toBe(false);
    expect(durable.safetyOffActive("held")).toBe(false);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    await settled(nodes.node("held").setSafety(true));
    const late = hold();
    fill();
    const lateOn = refuseOn();
    started.push(lateOn);
    await reach(late.reached, lateOn);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    await settled(nodes.node("held").setSafety(true));
    late.release();
    expect(await lateOn).toContain("safety record write refused");
    expect(durable.safetyOffActive("held")).toBe(true);
    fill();
    expect(await refuseOn()).toContain("safety record write refused");
    expect(await conversations.agentStore.flush("held")).toBe(true);
    const canonical = await conversations.loadCanonicalMetadata("held");
    expect(canonical?.safety_off).toBe(true);
    await durable.close();
    const reopened = world.hostOver((cid) =>
      cid === "held" ? canonical : null,
    );
    await reopened.open("held");
    expect(reopened.safetyReviewOff("held")).toBe(false);
    expect(reopened.safetyOffActive("held")).toBe(false);
  } finally {
    durable.setSafetyReviewOff = setter;
    for (const release of releases) release();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 a newer OFF whose flush failed stopped an earlier ON whose flush failed from turning Durable review ON.
test("an ON whose flush failed still turns Durable review ON after a newer failed OFF, also after reopening", async () => {
  const world = await switchoverWorld();
  const { conversations, create, durable, nodes } = world.instance;
  const { agentStore } = conversations;
  const flush = agentStore.flush;
  const started: Promise<unknown>[] = [];
  let writer: Database | undefined;
  try {
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    expect(durable.safetyOffActive("held")).toBe(true);
    const { harness, conversation } = await durable.open("held");
    writer = new Database(agentStore.dbPath("held"));
    writer.run("PRAGMA busy_timeout=5000");
    writer.run("BEGIN IMMEDIATE");
    const flushing = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let calls = 0;
    agentStore.flush = ((...args: Parameters<typeof flush>) => {
      if (args[0] === "held") flushing[calls++]?.resolve();
      return flush.apply(agentStore, args);
    }) as typeof flush;
    const failure = (off: boolean) =>
      nodes
        .node("held")
        .setSafety(off)
        .then(
          () => "applied",
          (error: unknown) => String(error),
        );
    const on = failure(false);
    started.push(on);
    await reach(flushing[0]!.promise, on);
    const off = failure(true);
    started.push(off);
    await reach(flushing[1]!.promise, off);
    expect(await on).toContain("safety record flush failed");
    expect(await off).toContain("safety record flush failed");
    expect(await safetyReviewOff(harness, conversation, context)).toBe(false);
    expect(durable.safetyOffActive("held")).toBe(false);
    agentStore.flush = flush;
    writer.run("ROLLBACK");
    writer.close();
    writer = undefined;
    expect(await agentStore.flush("held")).toBe(true);
    const canonical = await conversations.loadCanonicalMetadata("held");
    expect(canonical).toMatchObject({
      safety_off: true,
      safety_rev: conversations.newestSafety("held")?.rev,
    });
    await durable.close();
    const reopened = world.hostOver((cid) =>
      cid === "held" ? canonical : null,
    );
    await reopened.open("held");
    expect(reopened.safetyReviewOff("held")).toBe(false);
    expect(reopened.safetyOffActive("held")).toBe(false);
  } finally {
    agentStore.flush = flush;
    if (writer?.inTransaction) writer.run("ROLLBACK");
    writer?.close();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 a safety notice could be admitted while only a replaced node's lock was held.
test("a safety notice waiting on a replaced node's lock is admitted once, under the current node's lock", async () => {
  const world = await switchoverWorld();
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started: Promise<unknown>[] = [];
  const { configActions, create, durable, nodes } = world.instance;
  const guard = configActions.withNodeGuard;
  try {
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    await durable.open("held");
    const replaced = nodes.node("held");
    started.push(replaced.withLock(() => gates[0]!.promise));
    const calls = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let count = 0;
    configActions.withNodeGuard = ((...args: Parameters<typeof guard>) => {
      if (args[0] === "held" && args[2] === undefined)
        calls[count++]?.resolve();
      return guard.apply(configActions, args);
    }) as typeof guard;
    const on = nodes.node("held").setSafety(false);
    started.push(on);
    await reach(calls[0]!.promise, on);
    const [reply, noticed] = await on;
    started.push(noticed);
    expect(reply.safety_off).toBe(false);
    nodes.dropNode("held");
    const current = nodes.node("held");
    started.push(current.withLock(() => gates[1]!.promise));
    gates[0]!.resolve();
    await reach(calls[1]!.promise, noticed);
    expect(current.pendingIntents()).toEqual([]);
    gates[1]!.resolve();
    expect(await noticed).toBe(true);
    const notices = current
      .pendingIntents()
      .filter((intent) =>
        JSON.stringify(intent).includes("Safety review turned ON"),
      );
    expect(notices.length).toBe(1);
  } finally {
    configActions.withNodeGuard = guard;
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 an ON waited for a held node lock to admit its notice before replying, and a reply could precede its Durable commit.
test("an ON replies once committed while its notice waits on a held node lock, and a newer OFF drops the notice and wins", async () => {
  const world = await switchoverWorld();
  const gate = Promise.withResolvers<void>();
  const started: Promise<unknown>[] = [];
  try {
    const { create, durable, nodes } = world.instance;
    await create.create({ cid: "held", model });
    await settled(nodes.node("held").setSafety(true));
    const { harness, conversation } = await durable.open("held");
    started.push(nodes.node("held").withLock(() => gate.promise));
    const on = nodes.node("held").setSafety(false);
    started.push(on);
    const [reply, noticed] = await on;
    started.push(noticed);
    expect(await safetyReviewOff(harness, conversation, context)).toBe(false);
    expect(reply).toMatchObject({
      safety_off: false,
      safety_off_active: false,
    });
    const off = outcome(nodes.node("held").setSafety(true));
    started.push(off);
    gate.resolve();
    expect([await noticed, await off]).toEqual([false, true]);
    expect(durable.safetyOffActive("held")).toBe(true);
  } finally {
    gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 the startup model-choice migration replaced a record with its copy from before a flush, undoing a newer safety request.
test("the model-choice migration keeps a safety request made while it flushes", async () => {
  const world = await switchoverWorld();
  const flushed = Promise.withResolvers<void>();
  const started: Promise<unknown>[] = [];
  const { conversations, create } = world.instance;
  const flush = conversations.agentStore.flush;
  try {
    await create.create({ cid: "held", model });
    conversations.writeSafety("held", true, Date.now() / 1000);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    const legacy = await conversations.loadCanonicalMetadata("held");
    delete legacy!.model_choice_version;
    conversations.agentStore.enqueueMetadata("held", legacy!);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    await conversations.refreshProjection();
    expect(conversations.load("held")?.model_choice_version).toBeUndefined();
    const reached = Promise.withResolvers<void>();
    conversations.agentStore.flush = (async (
      ...args: Parameters<typeof flush>
    ) => {
      conversations.agentStore.flush = flush;
      reached.resolve();
      await flushed.promise;
      return flush.apply(conversations.agentStore, args);
    }) as typeof flush;
    const migrated = conversations.migrateModelChoices();
    started.push(migrated);
    await reach(reached.promise, migrated);
    const { rev } = conversations.writeSafety(
      "held",
      false,
      Date.now() / 1000,
    )!;
    flushed.resolve();
    expect(await migrated).toBe(1);
    const expected = {
      safety_off: false,
      safety_rev: rev,
      model_choice_version: 1,
    };
    expect(conversations.load("held")).toMatchObject(expected);
    expect(await conversations.agentStore.flush("held")).toBe(true);
    expect(await conversations.loadCanonicalMetadata("held")).toMatchObject(
      expected,
    );
  } finally {
    conversations.agentStore.flush = flush;
    flushed.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #2217 safety toggle deadlocked minting imported conversation temp key
test("a safety toggle completes on the first open of an imported conversation with no temp key", async () => {
  const world = await switchoverWorld();
  try {
    await world.row("legacy", null, model);
    await world.move.attempt(
      world.load("legacy")!,
      new AbortController().signal,
    );
    expect(world.load("legacy")).toMatchObject({ backend: "durable" });
    expect(world.load("legacy")!.tmp_key).toBeUndefined();
    const [conv] = await world.instance.nodes.node("legacy").setSafety(true);
    expect(conv.safety_off).toBe(true);
    expect(world.instance.durable.safetyOffActive("legacy")).toBe(true);
    expect(typeof world.load("legacy")!.tmp_key).toBe("string");
  } finally {
    await world.close();
  }
});

// Regression: #3665 a Pi import could publish a Durable store whose OFF document skipped review.
test("a Pi import of a conversation with review OFF publishes a store that still reviews tools", async () => {
  const world = await switchoverWorld();
  const { conversations, durable, nodes } = world.instance;
  const importPi = world.host.importPi;
  try {
    await world.row("legacy", null, model);
    await settled(nodes.node("legacy").setSafety(true));
    const atMarker: unknown[] = [];
    world.host.importPi = (conv, options, signal) =>
      importPi.call(
        world.host,
        conv,
        {
          ...options,
          publish: (commit) =>
            options.publish!(async () => {
              await commit();
              const stored =
                await conversations.loadCanonicalMetadata("legacy");
              const worker = new SqliteWorker();
              try {
                const raw = await Harness.open(
                  await openWorkerSqliteStorage(
                    worker,
                    world.host.storagePath("legacy"),
                  ),
                  { models: createModels(), registry: createRegistry() },
                  context,
                );
                try {
                  atMarker.push([
                    stored?.backend,
                    stored?.safety_off,
                    await safetyOffRevision(
                      raw,
                      await raw.root(context),
                      context,
                    ),
                  ]);
                } finally {
                  await raw.close(context);
                }
              } finally {
                await worker.close();
              }
            }),
        },
        signal,
      );
    await world.move.attempt(
      world.load("legacy")!,
      new AbortController().signal,
    );
    expect(atMarker).toEqual([["pi", true, undefined]]);
    expect(world.load("legacy")).toMatchObject({
      backend: "durable",
      safety_off: true,
    });
    await durable.open("legacy");
    expect(durable.safetyOffActive("legacy")).toBe(false);
    const file = join(world.root, "created");
    const before = world.requests.length;
    world
      .holdNextRequest({
        name: "bash",
        args: { command: `touch ${file}` },
      })
      .release();
    await world.instance.delivery.deliver("legacy", "create the file", {
      origin: "operator",
    });
    await nodes.node("legacy").turnTask;
    await (await durable.open("legacy")).conversation.waitForIdle(context);
    expect(
      world.requests
        .slice(before)
        .map((request) => JSON.stringify(request))
        .filter(
          (request) =>
            request.includes("You are pi-safety") && request.includes(file),
        ),
    ).not.toEqual([]);
  } finally {
    world.host.importPi = importPi;
    await world.close();
  }
});

const titleAcquired = (store: ConversationStore, cid: string) => {
  const acquired = Promise.withResolvers<void>();
  const original = store.withTitleGuard;
  store.withTitleGuard = ((
    id: string,
    fn: (token: ConversationGuardToken) => Promise<unknown>,
    token?: ConversationGuardToken,
  ) =>
    original.call(
      store,
      id,
      id === cid
        ? (held) => {
            store.withTitleGuard = original;
            acquired.resolve();
            return fn(held);
          }
        : fn,
      token,
    )) as typeof original;
  return acquired.promise;
};

// Regression: #3665 a takeover write stalled when its node was replaced while it waited for the lock, and a replaced node cancelled queued input.
test("a takeover finishes when the node is replaced while it waits for the node lock, and a replaced node cancels nothing", async () => {
  const world = await switchoverWorld();
  const gate = Promise.withResolvers<void>();
  const started: Promise<unknown>[] = [];
  try {
    const { conversations, create, nodes } = world.instance;
    await create.create({ cid: "held", model });
    started.push(nodes.node("held").withLock(() => gate.promise));
    const acquired = titleAcquired(conversations, "held");
    const write = create.setTakenOver("held", true);
    started.push(write);
    await reach(acquired, write);
    nodes.dropNode("held");
    nodes.node("held");
    gate.resolve();
    await write;
    expect(await conversations.agentStore.flush("held")).toBe(true);
    expect(await conversations.loadCanonicalMetadata("held")).toMatchObject({
      taken_over: true,
      muted: true,
    });
    const stale = nodes.node("held");
    expect(await (await stale.setSafety(true))[1]).toBe(true);
    const queued = stale.pendingIntents();
    nodes.dropNode("held");
    nodes.node("held");
    expect(await stale.cancelQueued(String(queued.at(-1)!.id))).toBe(false);
    expect(stale.pendingIntents()).toEqual(queued);
  } finally {
    gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});

// Regression: #3665 model admission took node then title locks and deadlocked with a takeover.
test("model admission and a takeover take conversation locks in one order", async () => {
  const world = await switchoverWorld();
  const gate = Promise.withResolvers<void>();
  const started: Promise<unknown>[] = [];
  try {
    const { configActions, conversations, create, nodes } = world.instance;
    await create.create({ cid: "held", model });
    expect(
      await configActions.requestModelChange("held", model, "high", null, true),
    ).not.toBeNull();
    started.push(nodes.node("held").withLock(() => gate.promise));
    const acquired = titleAcquired(conversations, "held");
    const admitted = configActions.applyPendingModelAtAdmission("held");
    const toggled = create.setTakenOver("held", true);
    started.push(admitted, toggled);
    await reach(acquired, Promise.all([admitted, toggled]));
    gate.resolve();
    expect(await admitted).toBe(true);
    expect((await toggled).taken_over).toBe(true);
    expect(world.load("held")).toMatchObject({ effort: "high" });
    expect(world.load("held")?.pending_model).toBeUndefined();
  } finally {
    gate.resolve();
    await Promise.allSettled(started);
    await world.close();
  }
});
