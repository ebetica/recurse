import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { DurableHost } from "../../src/agents/durable/host";
import { DurableViews } from "../../src/agents/durable/durable_rows";
import { captureFixture } from "./fixture_subprocess";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ExternalKeyConflict } from "../../src/agents/storage";
import { Cancelled } from "../../src/utils/tasks";
import {
  markerRecord,
  rootFromEnv,
  withCleanerLock,
} from "../../tools/worktree";
import { buildApp, WebLogSink } from "../../src/web/app";
import { appWorld } from "./web_app_support";
import { logger } from "../../src/observability/runtime_logging";
import { exchange, normalise, requestBytes } from "./http_corpus";

import {
  buildConversationsApp,
  type ConversationsApp,
} from "./http_conversations_app";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function app(
  options: Parameters<typeof buildConversationsApp>[1] = {},
): Promise<ConversationsApp> {
  const dir = await mkdtemp(join(tmpdir(), "http-conv-"));
  dirs.push(dir);
  return buildConversationsApp(dir, options);
}

const ALPHA = ["Authorization", "Bearer recurse_alpha_alpha-secret"] as const;
const BETA = ["Authorization", "Bearer recurse_beta_beta-secret"] as const;
const send = async (
  port: number,
  method: string,
  path: string,
  headers: (readonly [string, string])[] = [],
  text?: string,
) =>
  normalise(
    await exchange(
      port,
      requestBytes({
        method,
        path,
        headers,
        ...(text === undefined ? {} : { body: { text } }),
      }),
    ),
    method,
  );

// Regression: #2800 Changes follows the cwd committed by Durable's chdir tool.
test("diff follows an agent chdir into another worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diff-chdir-"));
  dirs.push(dir);
  const { host, faux, records } = fauxHost(dir);
  const built = await app({
    patch: (deps, world) => {
      const conv = { ...world.load("conv-a")!, backend: "durable" };
      world.convs.set("conv-a", conv);
      records["conv-a"] = conv;
      Object.assign(deps, { durable: host });
    },
  });
  const original = String(records["conv-a"]!.workdir);
  const target = join(dir, "other-worktree");
  try {
    const result = await captureFixture(
      ["git", "worktree", "add", "--detach", target, "HEAD"],
      { cwd: original },
    );
    expect(result.exitCode).toBe(0);
    await writeFile(join(target, "chdir-only.txt"), "target worktree change\n");
    expect(
      (await captureFixture(["git", "add", "chdir-only.txt"], { cwd: target }))
        .exitCode,
    ).toBe(0);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("chdir", { directory: target }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("changed directory"),
    ]);
    await host.send("conv-a", "Change into the other worktree", "chdir-diff");
    await until(
      () =>
        host.runningCount() === 0 &&
        host.metadata("conv-a").pending.length === 0,
    );
    for (const suffix of ["/diff", "/diff/files?path=chdir-only.txt"]) {
      const got = await send(
        built.running.port,
        "GET",
        `/api/conversations/conv-a${suffix}`,
      );
      expect(got.status).toBe(200);
      expect(JSON.stringify(got.body)).toContain("chdir-only.txt");
      expect(JSON.stringify(got.body)).toContain("target worktree change");
    }
  } finally {
    await built.running.close();
    await host.close();
  }
});

test("Changes deadlines respond while Durable is still opening its working directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diff-cwd-deadline-"));
  dirs.push(dir);
  const seeded = fauxHost(dir);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = new DurableHost({
    ...seeded.host.deps,
    agentEnv: async (record) => {
      reached.resolve();
      await release.promise;
      return seeded.host.deps.agentEnv(record);
    },
  });
  const built = await app({
    patch: (deps, world) => {
      const conv = { ...world.load("conv-a")!, backend: "durable" };
      world.convs.set("conv-a", conv);
      seeded.records["conv-a"] = conv;
      Object.assign(deps, { durable: host });
    },
  });
  const responses = Promise.all(
    ["/diff", "/diff/candidates"].map((path) =>
      send(built.running.port, "GET", `/api/conversations/conv-a${path}`),
    ),
  );
  try {
    await Promise.race([
      reached.promise,
      responses.then(() => {
        throw new Error("Changes did not open Durable state");
      }),
    ]);
    const [summary, candidates] = await responses;
    expect(summary!.status).toBe(200);
    expect(summary!.body).toMatchObject({
      json: { available: false, reason: "diff-failed" },
    });
    expect(candidates!.status).toBe(200);
    expect(candidates!.body).toEqual({
      json: { branches: [], commits: [], tags: [] },
    });
  } finally {
    release.resolve();
    await responses.catch(() => undefined);
    await built.running.close();
    await host.close();
    await seeded.host.close();
  }
}, 30_000);

test("idle history loads over HTTP without opening a runtime, then a message runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "http-cold-view-"));
  dirs.push(dir);
  const seeded = fauxHost(dir);
  const conv = { ...seeded.records.c1, id: "conv-a" };
  seeded.records["conv-a"] = conv;
  const path = seeded.host.storagePath("conv-a");
  await mkdir(dirname(path), { recursive: true });
  new Database(path, { create: true }).close();
  expect((await seeded.host.view("conv-a")).blocks).toEqual([]);
  seeded.faux.setResponses([fauxAssistantMessage("stored reply")]);
  await seeded.host.send("conv-a", "old question", "old-message");
  await until(
    async () =>
      seeded.host.runningCount() === 0 &&
      seeded.host.metadata("conv-a").pending.length === 0 &&
      JSON.stringify(await seeded.host.view("conv-a")).includes("stored reply"),
  );
  await seeded.host.close();
  const events: string[] = [];
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let environments = 0;
  const host = new DurableHost({
    ...seeded.host.deps,
    agentEnv: async (record) => {
      environments += 1;
      reached.resolve();
      await release.promise;
      return seeded.host.deps.agentEnv(record);
    },
    log: (event) => events.push(event),
  });
  const built = await app({
    patch: (deps, world) => {
      world.convs.set("conv-a", conv);
      Object.assign(deps, { durable: host });
      deps.reads.readViewWindow = (cid, options) => host.view(cid, options);
      deps.delivery.deliver = (cid, content) =>
        host.send(cid, content, "new-message");
    },
  });
  try {
    const first = await send(
      built.running.port,
      "GET",
      "/api/conversations/conv-a/view",
    );
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toContain("stored reply");
    expect(host.opened.has("conv-a")).toBe(false);
    expect(environments).toBe(0);
    expect(events).toEqual(["durable_view_storage"]);
    seeded.faux.setResponses([fauxAssistantMessage("new reply")]);
    const delivered = send(
      built.running.port,
      "POST",
      "/api/conversations/conv-a/deliver",
      [["Content-Type", "application/json"]],
      JSON.stringify({ content: "new question" }),
    );
    await reached.promise;
    const during = await send(
      built.running.port,
      "GET",
      "/api/conversations/conv-a/view",
    );
    expect(during.status).toBe(200);
    expect(JSON.stringify(during.body)).toContain("stored reply");
    expect(events).not.toContain("durable_open");
    release.resolve();
    expect((await delivered).status).toBe(200);
    await until(async () =>
      JSON.stringify(await host.view("conv-a")).includes("new reply"),
    );
    expect(host.opened.has("conv-a")).toBe(true);
    expect(environments).toBe(1);
    expect(events).toContain("durable_open");
  } finally {
    release.resolve();
    await built.running.close();
    await host.close();
  }
});

// Regression: #3005 paging older rows must not turn the next live poll into a reset.
test("view polls exclude paged history and still deliver live rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "view-history-"));
  dirs.push(dir);
  const { host, faux, records } = fauxHost(dir);
  const pageSize = 2;
  const historyTurns = 4;
  host.views = new DurableViews(undefined, pageSize);
  const built = await app({
    patch: (deps, world) => {
      records["conv-a"] = { ...world.load("conv-a")!, backend: "durable" };
      deps.reads.readViewWindow = (cid, options) => host.view(cid, options);
    },
  });
  const read = async (query: string) => {
    const response = await fetch(
      `http://127.0.0.1:${built.running.port}/api/conversations/conv-a/view?limit=${pageSize}&${query}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      revision: number;
      instance_id: string;
      blocks: { id: string; text: string }[];
      older: boolean;
      reset: boolean;
    };
  };
  const say = async (n: number) => {
    faux.setResponses([fauxAssistantMessage(`Answer ${n}`)]);
    await host.send("conv-a", `Question ${n}`, `history-${n}`);
    await until(
      () =>
        host.runningCount() === 0 &&
        host.metadata("conv-a").pending.length === 0,
    );
  };
  try {
    for (let n = 0; n < historyTurns; n++) await say(n);
    const initial = await read("");
    let older = initial;
    for (let n = 0; n < 2; n++) {
      expect(older.older).toBe(true);
      older = await read(`before=${encodeURIComponent(older.blocks[0].id)}`);
    }
    const query = `since=${initial.revision}&instance=${initial.instance_id}`;
    const quiet = await read(query);
    expect(quiet.reset).toBe(false);
    expect(quiet.revision).toBe(initial.revision);
    expect(quiet.blocks).toEqual([]);
    await say(historyTurns);
    const live = await read(query);
    expect(live.reset).toBe(false);
    expect(live.blocks.map((row) => row.text)).toEqual([
      `Question ${historyTurns}`,
      `Answer ${historyTurns}`,
    ]);
  } finally {
    await built.running.close();
    await host.close();
  }
});

describe("thinking disclosure", () => {
  test("serves the bounded read and returns 404 for an unavailable entry", async () => {
    const built = await app({
      patch: (deps) => {
        deps.reads.readThinkingText = async (_cid, offset) => {
          return offset === 7 ? { text: "private thought" } : null;
        };
      },
    });
    try {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/thinking?offset=7",
      );
      expect(got.status).toBe(200);
      const missing = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/thinking?offset=8",
      );
      expect([missing.status, missing.body]).toEqual([
        404,
        { json: { detail: "Not Found" } },
      ]);
    } finally {
      await built.running.close();
    }
  });
});

let closeServiceApp: (() => Promise<void>) | undefined;

async function withCleanup(
  run: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (failure) {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      console.error("Service test cleanup failed", cleanupFailure);
    }
    throw failure;
  }
  await cleanup();
}

async function bindingLeaves(paths: {
  EXTERNAL_KEY_DIR: string;
  SERVICE_BINDINGS_DIR: string;
}): Promise<Record<string, string>> {
  const leaves: Record<string, string> = {};
  for (const dir of [paths.EXTERNAL_KEY_DIR, paths.SERVICE_BINDINGS_DIR])
    for (const name of await readdir(dir).catch(() => []))
      leaves[join(dir, name)] = await readFile(join(dir, name), "utf8");
  return leaves;
}

async function serviceApp(
  ownedLimit = 5,
  managed = false,
  seed?: (env: Record<string, string>) => Promise<void>,
) {
  const { root, env } = appWorld();
  dirs.push(root);
  env.RECURSE_TEMP_ROOT = join(root, "tmp");
  const worktrees = rootFromEnv(env.CHAT_DATA_DIR!);
  if (managed) {
    const path = join(worktrees.worktrees, "target");
    await mkdir(path, { recursive: true });
    await mkdir(worktrees.markers, { recursive: true });
    await writeFile(
      join(worktrees.markers, "target.json"),
      JSON.stringify({ version: 1, name: "target", path, holders: {} }),
    );
    env.CHAT_REPO_URL = path;
  }
  const principals = Object.fromEntries(
    await Promise.all(
      ["alpha", "beta"].map(async (id) => {
        const tokenFile = join(env.CHAT_DATA_DIR!, `${id}-token`);
        await writeFile(tokenFile, `${id}-secret`);
        return [
          id,
          {
            token_file: tokenFile,
            scopes: ["conversation.create", "conversation.read"],
            quotas: { max_owned_conversations: ownedLimit },
          },
        ];
      }),
    ),
  );
  env.RECURSE_SERVICE_PRINCIPALS_FILE = join(
    env.CHAT_DATA_DIR!,
    "principals.json",
  );
  await writeFile(
    env.RECURSE_SERVICE_PRINCIPALS_FILE,
    JSON.stringify({ principals }),
  );
  await seed?.(env);
  const built = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const running = await built.serve({ port: 0 });
  closeServiceApp = running.close;
  await until(() => built.instance.lifecycle.readinessSnapshot().ready);
  const create = async (
    body: Record<string, string> = {},
    principal: readonly [string, string] = ALPHA,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${running.port}/api/service/conversations`,
      {
        method: "POST",
        headers: {
          [principal[0]]: principal[1],
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    const json = response.headers
      .get("Content-Type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, body: { json } };
  };
  const keyed = (key: string, principal: readonly [string, string] = ALPHA) =>
    create({ external_key: key }, principal);
  const replies = (cid: string, principal: readonly [string, string]) =>
    send(running.port, "GET", `/api/service/conversations/${cid}/replies`, [
      principal,
    ]);
  const view = (cid: string) =>
    send(running.port, "GET", `/api/conversations/${cid}/view`);
  return { instance: built.instance, worktrees, create, keyed, replies, view };
}

describe("service create", () => {
  afterEach(async () => {
    const close = closeServiceApp;
    closeServiceApp = undefined;
    await close?.();
  });

  test("two creates hold the slots; a third waits, then 429", async () => {
    const { create, instance } = await serviceApp();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    const { lease } = instance;
    const admit = lease.guardAsync.bind(lease);
    lease.guardAsync = async (site, cid, work, token, options) => {
      if (site === "create") {
        if (++active === 2) entered.resolve();
        await release.promise;
      }
      return admit(site, cid, work, token, options);
    };
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const pending = [create({}, ALPHA, signal), create({}, ALPHA, signal)];
    try {
      await Promise.race([
        entered.promise,
        ...pending.map((request) =>
          request.then(({ status }) => {
            throw new Error(
              `Create settled before both slots were held: ${status}`,
            );
          }),
        ),
      ]);
      const third = await create({}, ALPHA, signal);
      expect([third.status, third.body]).toEqual([
        429,
        { json: { detail: "service create is busy" } },
      ]);
      release.resolve();
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([
        200, 200,
      ]);
    } finally {
      release.resolve();
      cancellation.abort();
      await Promise.allSettled(pending);
    }
  }, 20_000);

  // Regression: #3662 A second lease admission failure left a published service conversation unbound.
  test("service create binds before releasing its creation lease", async () => {
    const { keyed, instance, worktrees } = await serviceApp(5, true);
    const { lease, config, serviceBindings } = instance;
    const lock = join(config.paths.MUTE_LOCK_DIR, ".tree-lifecycle.lock");
    const parked = `${lock}.parked`;
    const { request, obstruction } = await withCleanerLock(
      worktrees,
      async () => {
        const request = keyed("no-second-lease");
        await until(() => lease.currentHolder()?.site === "create");
        const obstruction = lease
          .guardAsync("obstruct_next_lease", null, async () => {
            await rename(lock, parked);
            await mkdir(lock);
          })
          .catch((error: unknown) => error);
        return { request, obstruction };
      },
    );
    await withCleanup(
      async () => {
        const got = await request;
        expect(await obstruction).toBeInstanceOf(Error);
        expect(got.status).toBe(200);
        const bound = await serviceBindings.lookupExternalKey(
          "alpha",
          "no-second-lease",
        );
        expect(got.body.json).toMatchObject({ id: bound?.id });
      },
      async () => {
        await obstruction;
        await rm(lock, { recursive: true, force: true });
        await rename(parked, lock);
      },
    );
  });

  // Regression: #3662 Failed scratch setup left the conversation row and checkout hold behind, and rollback unlinked bindings it had not written.
  test("a failed service attempt rolls back its own state and keeps another attempt's bindings", async () => {
    const { keyed, instance, worktrees } = await serviceApp(5, true);
    const { agentStore, conversations, config, lease, nodes, serviceBindings } =
      instance;
    const temp = config.paths.AGENT_TEMP_ROOT;
    const parked = `${temp}.parked`;
    const staged = async (key: string) =>
      withCleanerLock(worktrees, async () => {
        const request = keyed(key);
        await until(() => lease.currentHolder()?.site === "create");
        const cid = lease.currentHolder()!.conversationId!;
        await until(() => nodes.existing(cid) !== null);
        await serviceBindings.bindServiceConversation("alpha", cid, "other");
        await serviceBindings.bindExternalKey("alpha", key, cid, "other");
        return { request, cid, leaves: await bindingLeaves(config.paths) };
      });
    const rolledBack = async (attempt: Awaited<ReturnType<typeof staged>>) => {
      const got = await attempt.request;
      expect([got.status, got.body]).toEqual([
        503,
        { json: { detail: "service_storage_unavailable" } },
      ]);
      expect(await bindingLeaves(config.paths)).toEqual(attempt.leaves);
      expect(conversations.load(attempt.cid)).toBeNull();
      expect((await agentStore.loadPersistedAgent(attempt.cid))[0]).toBeNull();
      expect(markerRecord(worktrees, "target")?.holders).toEqual({});
      expect(nodes.existing(attempt.cid)).toBeNull();
    };
    await mkdir(temp, { recursive: true });
    await rename(temp, parked);
    await writeFile(temp, "obstruct scratch setup");
    await withCleanup(
      async () => rolledBack(await staged("failed-temp")),
      async () => {
        await rm(temp);
        await rename(parked, temp);
      },
    );
    await rolledBack(await staged("reused-binding"));
    expect((await keyed("after-rollback")).status).toBe(200);
  });

  // Regression: #3662 Rejected row admission left the service and external-key bindings behind.
  test("rejected row admission removes both staged bindings and the worktree hold", async () => {
    const { keyed, instance, worktrees } = await serviceApp(5, true);
    const { agentStore, conversations, lease, serviceBindings } = instance;
    const { request, cid } = await withCleanerLock(worktrees, async () => {
      const request = keyed("closed-store");
      await until(() => lease.currentHolder()?.site === "create");
      const cid = lease.currentHolder()!.conversationId!;
      expect(await agentStore.close(cid)).toBe(true);
      return { request, cid };
    });
    expect((await request).status).toBe(503);
    expect(conversations.load(cid)).toBeNull();
    expect((await agentStore.loadPersistedAgent(cid))[0]).toBeNull();
    expect(markerRecord(worktrees, "target")?.holders).toEqual({});
    expect(await serviceBindings.serviceOwnedConversationCount("alpha")).toBe(
      0,
    );
    expect(
      await serviceBindings.lookupExternalKey("alpha", "closed-store"),
    ).toBeNull();
  });

  // Regression: #3662 A service row was visible before its first commit, so a reader could open it while the write could still be lost.
  test("a service row stays hidden until its first commit", async () => {
    const { create, keyed, instance, view } = await serviceApp();
    const { agentStore, conversations, durable, lease } = instance;
    const first = await create();
    const other = (first.body.json as { id: string }).id;
    expect(await agentStore.flush(other)).toBe(true);
    const lock = new Database(agentStore.dbPath(other));
    const pending: Promise<unknown>[] = [];
    let request: ReturnType<typeof keyed> | undefined;
    let cid = "";
    try {
      lock.run("BEGIN EXCLUSIVE;");
      for (let n = 0; n < 16; n++)
        pending.push(agentStore.loadPersistedAgent(other).catch(() => null));
      request = keyed("held-commit");
      pending.push(request);
      await until(() => lease.currentHolder()?.site === "create");
      cid = lease.currentHolder()!.conversationId!;
      await until(() => agentStore.status(cid).in_flight === true);
      expect((await view(cid)).status).toBe(404);
      expect(await Bun.file(durable.storagePath(cid)).exists()).toBe(false);
      expect(conversations.load(cid)).toBeNull();
    } finally {
      try {
        try {
          if (lock.inTransaction) lock.run("ROLLBACK;");
        } finally {
          lock.close();
        }
      } finally {
        await Promise.allSettled(pending);
      }
    }
    expect((await request).body.json).toMatchObject({ id: cid, created: true });
    expect((await view(cid)).status).toBe(200);
    expect(await Bun.file(durable.storagePath(cid)).exists()).toBe(true);
  });

  // Regression: #3662 Rollback trashed agent storage that existed before the attempt.
  test("existing agent storage is refused and kept", async () => {
    const { keyed, instance, worktrees } = await serviceApp(5, true);
    const { agentStore, conversations, lease, nodes, serviceBindings } =
      instance;
    const { request, cid, database } = await withCleanerLock(
      worktrees,
      async () => {
        const request = keyed("existing-storage");
        await until(() => lease.currentHolder()?.site === "create");
        const cid = lease.currentHolder()!.conversationId!;
        const database = agentStore.dbPath(cid);
        await mkdir(dirname(database), { recursive: true });
        await writeFile(database, "skipped by startup import");
        return { request, cid, database };
      },
    );
    expect(await request).toEqual({
      status: 503,
      body: { json: { detail: "service_storage_unavailable" } },
    });
    expect(await Bun.file(database).text()).toBe("skipped by startup import");
    expect(conversations.load(cid)).toBeNull();
    expect(nodes.existing(cid)).toBeNull();
    expect(markerRecord(worktrees, "target")?.holders).toEqual({});
    expect(
      await serviceBindings.lookupExternalKey("alpha", "existing-storage"),
    ).toBeNull();
    expect((await keyed("existing-storage")).body.json).toMatchObject({
      created: true,
    });
  });

  // Regression: #3662 Cancelling the caller skipped binding even though creation completed.
  test("aborting an internal service create wait still binds the conversation", async () => {
    const { instance, worktrees, keyed } = await serviceApp(5, true);
    const { create, createTasks, lease, serviceBindings } = instance;
    const abort = new AbortController();
    const cid = await withCleanerLock(worktrees, async () => {
      const pending = create.createOrRejoinServiceConversation(
        {
          title: null,
          servicePrincipal: "alpha",
          externalKey: "internal-abort",
          allowedModels: null,
          ownedLimit: null,
        },
        abort.signal,
      );
      await until(() => lease.currentHolder()?.site === "create");
      const cid = lease.currentHolder()!.conversationId;
      abort.abort();
      await expect(pending).rejects.toBeInstanceOf(Cancelled);
      return cid;
    });
    await createTasks.drain();
    expect(
      (await serviceBindings.lookupExternalKey("alpha", "internal-abort"))?.id,
    ).toBe(cid);
    expect((await keyed("internal-abort")).body.json).toMatchObject({
      id: cid,
      created: false,
    });
  });

  // Regression: #3662 Losing a bind race removed the projection but left SQLite and checkout state.
  test("a lost bind race rolls back, rejoins its owner, and refuses a dangling leaf", async () => {
    const { create, keyed, instance, replies, worktrees } = await serviceApp(
      5,
      true,
    );
    const { agentStore, conversations, lease, nodes, serviceBindings } =
      instance;
    const betaFirst = await keyed("late", BETA);
    expect(betaFirst.body.json).toMatchObject({ created: true });
    const winnerResponse = await create();
    expect(winnerResponse.status).toBe(200);
    const winner = (winnerResponse.body as { json: { id: string } }).json.id;
    await conversations.save({
      ...conversations.load(winner)!,
      external_key: "late",
    });
    const race = (key: string, target: string) =>
      withCleanerLock(worktrees, async () => {
        const request = keyed(key);
        await until(() => lease.currentHolder()?.site === "create");
        const cid = lease.currentHolder()!.conversationId!;
        await until(() => nodes.existing(cid) !== null);
        await serviceBindings.bindExternalKey("alpha", key, target);
        return { request, cid };
      });
    const lost = await race("late", winner);
    const got = await lost.request;
    const reused = {
      json: { id: winner, status: "idle", title: null, created: false },
    };
    expect([got.status, got.body]).toEqual([200, reused]);
    expect(conversations.load(lost.cid)).toBeNull();
    expect((await agentStore.loadPersistedAgent(lost.cid))[0]).toBeNull();
    expect(markerRecord(worktrees, "target")?.holders).toEqual({
      [(betaFirst.body.json as { id: string }).id]: expect.any(Number),
      [winner]: expect.any(Number),
    });
    expect(await serviceBindings.serviceOwnedConversationCount("alpha")).toBe(
      1,
    );
    expect((await serviceBindings.lookupExternalKey("alpha", "late"))?.id).toBe(
      winner,
    );

    const dangling = await race("dangling", "missing-row");
    expect(await dangling.request).toEqual({
      status: 409,
      body: { json: { detail: "external_key binding is unavailable" } },
    });
    expect(conversations.load(dangling.cid)).toBeNull();
    expect(await serviceBindings.serviceOwnedConversationCount("alpha")).toBe(
      1,
    );
    await expect(
      serviceBindings.lookupExternalKey("alpha", "dangling"),
    ).rejects.toBeInstanceOf(ExternalKeyConflict);

    const repeat = await keyed("late");
    expect([repeat.status, repeat.body]).toEqual([200, reused]);
    const targeted = await create({ id: winner, external_key: "late" }, BETA);
    expect([targeted.status, targeted.body]).toEqual([
      422,
      { json: { detail: "unsupported service create field" } },
    ]);
    expect(await serviceBindings.serviceOwnsConversation("alpha", winner)).toBe(
      true,
    );
    expect(await serviceBindings.serviceOwnsConversation("beta", winner)).toBe(
      false,
    );
    expect((await replies(winner, ALPHA)).status).toBe(200);
    expect((await replies(winner, BETA)).status).toBe(404);

    const beta = await keyed("late", BETA);
    expect(beta.body.json).toEqual({
      ...(betaFirst.body.json as object),
      created: false,
    });
    expect((beta.body as { json: { id: string } }).json.id).not.toBe(winner);
  });

  test("concurrent creates with distinct keys cannot exceed the service quota", async () => {
    const { keyed, instance } = await serviceApp(1);
    const results = await Promise.all([keyed("first"), keyed("second")]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 429]);
    const index = results.findIndex(({ status }) => status === 200);
    const { id } = results[index]!.body.json as { id: string };
    expect(results[1 - index]!.body.json).toEqual({
      detail: "max_owned_conversations exceeded",
    });
    expect(instance.conversations.allConvs().map((row) => row.id)).toEqual([
      id,
    ]);
    expect(
      await instance.serviceBindings.serviceOwnedConversationCount("alpha"),
    ).toBe(1);
    expect(
      (await keyed(index === 0 ? "first" : "second")).body.json,
    ).toMatchObject({ id, created: false });
  });

  test("a busy lease is 429 and an obstructed ownership scan is 503", async () => {
    const { create, instance } = await serviceApp();
    const { config, conversations, lease } = instance;
    const admit = lease.guardAsync.bind(lease);
    let createAttempts = 0;
    let holdLease = true;
    lease.guardAsync = (site, cid, work, token, options) => {
      if (site === "create") {
        createAttempts++;
        if (holdLease) {
          return lease.guard(
            "hold_service_create",
            null,
            async (_token, held) => {
              expect(held).not.toBeNull();
              return admit(site, cid, work, token, { timeoutSeconds: 0 });
            },
          );
        }
      }
      return admit(site, cid, work, token, options);
    };
    const busy = await create();
    expect([busy.status, busy.body]).toEqual([
      429,
      { json: { detail: "service create is busy" } },
    ]);
    expect(createAttempts).toBeGreaterThan(0);
    holdLease = false;

    const bindingDir = config.paths.SERVICE_BINDINGS_DIR;
    await writeFile(bindingDir, "obstruct the ownership quota scan");
    await withCleanup(
      async () => {
        const broken = await create();
        expect([broken.status, broken.body]).toEqual([
          503,
          { json: { detail: "service_storage_unavailable" } },
        ]);
        expect(conversations.allConvs()).toEqual([]);
      },
      () => rm(bindingDir),
    );
  });
});

describe("events", () => {
  test("SSE is gzip-compressed and lifts the idle timeout", async () => {
    const built = await app();
    try {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/events",
        [
          ["Accept-Encoding", "gzip"],
          ["Last-Event-ID", "big"],
        ],
      );
      expect(got.headers["content-encoding"]).toBe("gzip");
      expect(got.headers["content-type"]).toBe(
        "text/event-stream; charset=utf-8",
      );
    } finally {
      await built.running.close();
    }
  });
});

// Regression: #2989 a per-switch query string made every revisit a full read.
test("a timed switch read logs its trace and revalidates on a revisit", async () => {
  const messages: string[] = [];
  const built = await app({
    patch: (deps) =>
      Object.assign(deps, {
        log: logger("web", {
          write: (record) => messages.push(record.message),
        }),
      }),
  });
  try {
    const url = `http://127.0.0.1:${built.running.port}/api/conversations/conv-a?focused=1`;
    const trace = "0123456789abcdef0123456789abcdef";
    const timed = {
      "x-recurse-trace": trace,
      "x-recurse-client-dispatch-ms": "4.500",
    };
    const first = await fetch(url, { headers: timed });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-recurse-switch-trace")).toBe(trace);
    await first.arrayBuffer();
    const revisit = await fetch(url, {
      headers: { ...timed, "if-none-match": first.headers.get("etag")! },
    });
    expect(revisit.status).toBe(304);
    const untimed = await fetch(url, {
      headers: { "x-recurse-trace": trace },
    });
    expect(untimed.headers.get("x-recurse-switch-trace")).toBeNull();
    await untimed.arrayBuffer();
    expect(
      messages.filter((m) => m.includes("switch_request_started")),
    ).toEqual(
      Array(2).fill(
        `event=conversation_switch_request_started client_dispatch_ms=4.500 trace_id=${trace}`,
      ),
    );
  } finally {
    await built.running.close();
  }
});

test("the safety toggle leaves the running turn's state alone", async () => {
  const built = await app();
  try {
    const got = await send(
      built.running.port,
      "POST",
      "/api/conversations/conv-run/safety",
      [["Content-Type", "application/json"]],
      '{"off": true}',
    );
    expect(got.body).toEqual({
      json: { id: "conv-run", safety_off: true, safety_off_active: false },
    });
    expect(built.world.drain()).toEqual([
      ["set_safety", "conv-run", true],
      ["request_run", "conv-run"],
    ]);
  } finally {
    await built.running.close();
  }
});

test("every conversation route refuses an unauthenticated caller", async () => {
  const locked = await app({
    authEnv: { CHAT_AUTH_SALT: "00", CHAT_AUTH_HASH: "00".repeat(32) },
  });
  try {
    for (const route of locked.router.routes()) {
      const path = route.path.replace(/\{[^}]+\}/g, "x");
      for (const method of route.methods) {
        const got = await send(locked.running.port, method, path);
        expect([method, path, got.status]).toEqual([method, path, 401]);
      }
    }
    expect(locked.world.drain()).toEqual([]);
  } finally {
    await locked.running.close();
  }
});

test("a working-tree edit after a Changes read shows in the next read", async () => {
  const built = await app();
  try {
    const repo = String(built.world.convs.get("conv-a")!.workdir);
    const read = async () => {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/diff",
      );
      expect(got.status).toBe(200);
      return (got.body as { json: { diff: string } }).json.diff;
    };
    expect(await read()).not.toContain("+four");
    await Bun.write(join(repo, "src/app.txt"), "one\ntwo\nthree\nfour\n");
    expect(await read()).toContain("+four");
  } finally {
    await built.running.close();
  }
});
