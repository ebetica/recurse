import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { AgentStore } from "../../src/agents/agent_store";
import { Config } from "../../src/config";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  ConversationStore,
  ExternalKeyConflict,
  ServiceStorageUnavailable,
  SET_PENDING_MODEL_MARKER,
  assertNoUnimportedLegacyState,
  TITLE_ORDER_RE,
  cleanTitleOrder,
  freshPinnedOrder,
  validateExternalKey,
  LEGACY_BACKEND,
} from "../../src/agents/conversation_store";
import {
  fixtureStore,
  fixtureHooks,
  paths,
  type ConversationCase,
} from "./fixtures/conversation_store/spec";
import fixture from "./fixtures/conversation_store/cases.json";

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conversation-store-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
function instance(root: string) {
  const store = fixtureStore(root);
  store.applyAgentMetadata({
    agent1: {
      id: "agent1",
      external_key: "slack:C1",
      service_principal: "service",
    },
  });
  return { store };
}

test("external keys and title orders enforce current input policy", () => {
  const item = fixture.cases[2] as ConversationCase;
  for (const key of item.external_keys!) {
    if (
      typeof key === "string" &&
      /[\/\\\u0000-\u001f\u007f\u2028\u2029]/.test(key)
    )
      expect(() => validateExternalKey(key)).toThrow();
    else expect(validateExternalKey(key)).toBe(key);
  }
  for (const order of item.title_orders!) {
    if (order.includes("\n")) expect(TITLE_ORDER_RE.test(order)).toBe(false);
    else expect(TITLE_ORDER_RE.test(order)).toBe(true);
  }
});

describe("metadata policy", () => {
  test("external key and title/pin order validation", () => {
    expect(validateExternalKey(null)).toBeNull();
    for (const key of [
      "",
      "bad/path",
      "x".repeat(257),
      "x\n",
      "x\r",
      "x\u2028",
      17,
    ])
      expect(() => validateExternalKey(key)).toThrow();
    expect(validateExternalKey("slack:C1.2-foo_bar")).toBe(
      "slack:C1.2-foo_bar",
    );
    expect(cleanTitleOrder("bad", () => "00000000000000000001-abc")).toBe(
      "00000000000000000001-abc",
    );
    expect(
      freshPinnedOrder(
        () => 2n,
        () => "a".repeat(32),
      ),
    ).toBe(`00000000000000000002-${"a".repeat(32)}`);
    expect(
      cleanTitleOrder("00000000000000000001-abc\n", () => "new-order"),
    ).toBe("new-order");
    expect(cleanTitleOrder(`${"١".repeat(20)}-abc`, () => "new-order")).toBe(
      `${"١".repeat(20)}-abc`,
    );
    const stamps = Array.from({ length: 32 }, () => freshPinnedOrder());
    for (let i = 1; i < stamps.length; i++)
      expect(stamps[i]! > stamps[i - 1]!).toBe(true);
  });
});

test("legacy startup check refuses unimported tree.db and cid JSON, but accepts marker", async () => {
  const root = await temp();
  await assertNoUnimportedLegacyState(root);
  await writeFile(join(root, "tree.db"), "old");
  await expect(assertNoUnimportedLegacyState(root)).rejects.toThrow("tree.db");
  await writeFile(join(root, "agents-import-v2.json"), "{}");
  await assertNoUnimportedLegacyState(root);
  const other = await temp();
  await mkdir(join(other, "conversations"));
  await writeFile(join(other, "conversations", "agent1.json"), "{}");
  await expect(assertNoUnimportedLegacyState(other)).rejects.toThrow(
    "legacy conversation records",
  );
  await writeFile(join(other, "conversations", "-unsafe.json"), "{}");
  await writeFile(join(other, "agents-import-v2.json"), "{bad");
  await expect(assertNoUnimportedLegacyState(other)).rejects.toThrow(
    "Invalid agents-import-v2.json marker",
  );
  await writeFile(join(other, "agents-import-v2.json"), "{}");
  await assertNoUnimportedLegacyState(other);
  const incompatible = await temp();
  await mkdir(join(incompatible, "conversations"));
  await writeFile(join(incompatible, "conversations", "-unsafe.json"), "{}");
  await expect(assertNoUnimportedLegacyState(incompatible)).rejects.toThrow(
    "legacy conversation records",
  );
});

test("refresh refuses legacy JSON even for an invalid conversation id", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  await mkdir(join(root, "conversations"));
  await writeFile(join(root, "conversations", "-unsafe.json"), "{}");
  await expect(store.refreshProjection()).rejects.toThrow(
    "Unimported legacy conversation records",
  );
  expect(store.allConvs()).toEqual([]);
  await writeFile(join(root, "agents-import-v2.json"), "{}");
  expect(await store.refreshProjection()).toEqual({});
  await store.agentStore.dispose();
});

test("external-key conflicts fail closed on malformed, symlink, dangling and occupied leaves", async () => {
  const root = await temp();
  const { store } = instance(root);
  await store.bindExternalKey("service", "slack:C1", "agent1");
  const digest = createHash("sha256")
    .update("recurse-external-key-v1\0service\0slack:C1")
    .digest("hex");
  const leaf = join(root, "external-keys", `${digest}.json`);
  const original = await readFile(leaf);
  await expect(
    store.bindExternalKey("service", "slack:C1", "agent2"),
  ).rejects.toBeInstanceOf(ExternalKeyConflict);
  expect(await readFile(leaf)).toEqual(original);
  store.discardConvProjection("agent1");
  await expect(
    store.lookupExternalKey("service", "slack:C1"),
  ).rejects.toBeInstanceOf(ExternalKeyConflict);
  await writeFile(leaf, "{bad");
  await expect(
    store.lookupExternalKey("service", "slack:C1"),
  ).rejects.toBeInstanceOf(ExternalKeyConflict);
  await store.unbindExternalKey("service", "slack:C1", "agent1");
  await symlink("missing.json", leaf);
  await expect(
    store.lookupExternalKey("service", "slack:C1"),
  ).rejects.toBeInstanceOf(ExternalKeyConflict);
  await expect(
    store.unbindExternalKey("service", "slack:C1", "agent1"),
  ).rejects.toBeInstanceOf(ServiceStorageUnavailable);
});

test("a detached task cannot reuse a guard context after release", async () => {
  const root = await temp();
  const { store } = instance(root);
  let complete!: () => void;
  const barrier = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let holderReady!: () => void;
  const acquired = new Promise<void>((resolve) => {
    holderReady = resolve;
  });
  let detached!: Promise<void>;
  let startDetached!: () => void;
  const ready = new Promise<void>((resolve) => {
    startDetached = resolve;
  });
  let entered = false;
  await store.withMuteGuard("agent1", async () => {
    detached = ready.then(() => {
      const acquisition = store.withMuteGuard("agent1", async () => {
        entered = true;
      });
      return acquisition;
    });
  });
  const holder = store.withMuteGuard("agent1", async () => {
    holderReady();
    await barrier;
  });
  await acquired;
  const tails = (
    store as unknown as { mutex: { tails: Map<string, Promise<void>> } }
  ).mutex.tails;
  const holderTail = tails.get("mute:agent1");
  if (!holderTail) throw new Error("mute holder did not register its queue");
  startDetached();
  const deadline = Date.now() + 5000;
  while (!tails.get("mute:agent1") || tails.get("mute:agent1") === holderTail) {
    if (Date.now() > deadline)
      throw new Error("detached mute contender did not queue");
    await Bun.sleep(5);
  }
  expect(entered).toBe(false);
  complete();
  await Promise.all([holder, detached]);
  expect(entered).toBe(true);
});

test("identifiers with a final newline cannot reach a binding or lock path", async () => {
  const root = await temp();
  const { store } = instance(root);
  await expect(
    store.bindExternalKey("service", "x\n", "agent1"),
  ).rejects.toThrow();
  await expect(
    store.bindServiceConversation("service\n", "agent1"),
  ).rejects.toThrow();
  await expect(
    store.withTitleGuard("agent1\n", async () => {}),
  ).rejects.toThrow();
  expect(await store.serviceOwnsConversation("service", "agent1\n")).toBe(
    false,
  );
});

test("lock-file symlinks are refused rather than followed", async () => {
  const root = await temp();
  const { store } = instance(root);
  await mkdir(join(root, "mute-locks"));
  const target = join(root, "private");
  await writeFile(target, "secret");
  await symlink(target, join(root, "mute-locks", "agent1.lock"));
  await expect(store.withMuteGuard("agent1", async () => {})).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("secret");
});

test("service ownership counts only live rows for direct reads, refuses malformed leaves on scans", async () => {
  const root = await temp();
  const { store } = instance(root);
  await store.bindServiceConversation("service", "agent1");
  expect(await store.serviceOwnedConversationCount("service")).toBe(1);
  store.discardConvProjection("agent1");
  expect(await store.serviceOwnsConversation("service", "agent1")).toBe(false);
  await writeFile(join(root, "service-bindings", "invalid.json"), "{");
  await expect(
    store.serviceOwnedConversationCount("service"),
  ).rejects.toBeInstanceOf(ServiceStorageUnavailable);
});

test("title and mute guards exclude another task and external flock holders", async () => {
  const root = await temp();
  const { store } = instance(root);
  const entered: string[] = [];
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let holding!: () => void;
  const held = new Promise<void>((resolve) => {
    holding = resolve;
  });
  let child!: Promise<void>;
  let lease!: object;
  const first = store.withTitleGuard("agent1", async (token) => {
    lease = token;
    entered.push("first");
    await store.withTitleGuard(
      "agent1",
      async () => {
        entered.push("nested");
      },
      token,
    );
    await expect(
      store.withTitleGuard("other", async () => {}, token),
    ).rejects.toThrow("mismatched");
    await expect(
      store.withMuteGuard("agent1", async () => {}, token),
    ).rejects.toThrow("mismatched");
    child = store.withTitleGuard("agent1", async () => {
      entered.push("child");
    });
    holding();
    await barrier;
  });
  await held;
  const tails = (
    store as unknown as { mutex: { tails: Map<string, Promise<void>> } }
  ).mutex.tails;
  const priorTail = tails.get("title:agent1");
  if (!priorTail) throw new Error("title holder did not register its queue");
  const second = store.withTitleGuard("agent1", async () => {
    entered.push("second");
  });
  const queuedDeadline = Date.now() + 5000;
  while (
    !tails.get("title:agent1") ||
    tails.get("title:agent1") === priorTail
  ) {
    if (Date.now() > queuedDeadline)
      throw new Error("second title contender did not queue");
    await Bun.sleep(5);
  }
  expect(entered).toEqual(["first", "nested"]);
  resume();
  await Promise.all([first, child, second]);
  expect(entered).toEqual(["first", "nested", "child", "second"]);
  await expect(
    store.withTitleGuard("agent1", async () => {}, lease),
  ).rejects.toThrow("inactive");
  const path = join(root, "title-locks", "agent1.lock");
  const proc = spawn(
    "flock",
    ["-x", path, "sh", "-c", "printf acquired; read release"],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const exited = new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`flock exit ${code}`)),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proc.stdout!.once("data", () => resolve());
      proc.once("error", reject);
    });
    let acquired = false;
    const contender = store.withTitleGuard("agent1", async () => {
      acquired = true;
    });
    const deadline = Date.now() + 5000;
    while (
      !(
        await Promise.all(
          (await readdir("/proc/self/fd")).map(
            async (fd) =>
              (await readlink(`/proc/self/fd/${fd}`).catch(() => "")) === path,
          ),
        )
      ).some(Boolean)
    ) {
      if (Date.now() > deadline)
        throw new Error("title contender did not open its pinned lock");
      await Bun.sleep(5);
    }
    expect(acquired).toBe(false);
    proc.stdin!.end("release\n");
    await exited;
    await contender;
    expect(acquired).toBe(true);
  } finally {
    if (proc.exitCode === null) {
      proc.stdin!.end("release\n");
      await exited;
    }
  }
});

function currentRow(cid: string) {
  return {
    id: cid,
    parent: null,
    backend: "pi",
    level: 3,
    model: "anthropic/claude-fable-5-1",
    effort: "high",
    title: "first",
    title_order: "00000000000000000001-a",
    pinned: false,
    pinned_order: `00000000000000000001-${"a".repeat(32)}`,
  };
}

test("failed durable admission leaves projection intact and next save retries", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  const cid = "admission";
  try {
    await store.save(currentRow(cid));
    expect(await store.agentStore.flush(cid)).toBe(true);
    const before = store.metadataSnapshot(cid);
    const digest = store.captureDigestInputs();
    expect(digest.convs).toContainEqual(
      expect.objectContaining({ id: cid, title: before!.title }),
    );
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;
    await expect(
      store.save({
        ...currentRow(cid),
        pending_model: cycle,
        [SET_PENDING_MODEL_MARKER]: true,
      }),
    ).rejects.toThrow();
    expect(store.metadataSnapshot(cid)).toEqual(before);
    await store.save({
      ...currentRow(cid),
      title: "recovered",
      title_order: "00000000000000000002-b",
    });
    expect(await store.agentStore.flush(cid)).toBe(true);
    expect((await store.loadCanonicalMetadata(cid))?.title).toBe("recovered");
    expect(digest.convs.find((row) => row.id === cid)?.title).toBe(
      before!.title,
    );
    const freshDigest = store.captureDigestInputs();
    const freshRow = freshDigest.convs.find((row) => row.id === cid)!;
    expect(freshRow.title).toBe("recovered");
    freshRow.title = "reader mutation";
    expect(store.metadataSnapshot(cid)?.title).toBe("recovered");

    const metadata = (fixture.cases[0] as ConversationCase).record!;
    const privateFields = (fixture.cases[1] as ConversationCase).record!;
    const metadataId = metadata.id;
    if (typeof metadataId !== "string")
      throw new Error("metadata input lacks id");
    await store.save({
      ...currentRow(metadataId),
      ...metadata,
      ...privateFields,
      [SET_PENDING_MODEL_MARKER]: true,
    });
    expect(await store.agentStore.flush(metadataId)).toBe(true);
    const persisted = await store.loadCanonicalMetadata(metadataId);
    expect(persisted).toMatchObject({
      title: metadata.title,
      pending_model: metadata.pending_model,
      settled_attachment_ids: metadata.settled_attachment_ids,
      muted: privateFields.muted,
      level: privateFields.level,
      reap_deferred: privateFields.reap_deferred,
      updated: metadata.updated,
      last_interaction: privateFields.last_interaction,
    });
    expect(persisted).not.toHaveProperty("messages");
    expect(persisted).not.toHaveProperty("status");
    expect(store.metadataSnapshot(metadataId)).toMatchObject({
      status: metadata.status,
      updated: metadata.updated,
      last_interaction: privateFields.last_interaction,
    });
    expect(store.load(metadataId)).not.toHaveProperty("messages");

    const choices = fixture.cases[3] as ConversationCase;
    const choiceId = choices.cid!;
    await store.save({ ...choices.record! });
    const stale = store.load(choiceId, { withPending: false })!;
    expect(
      store.publishTitle(choiceId, choices.title!, choices.title_order!),
    ).toBe(true);
    await store.save({ ...stale, ...choices.pinned_update });
    await store.save({ ...stale, ...choices.stale_pinned });
    await store.save({ ...stale, ...choices.model_update });
    expect(await store.agentStore.flush(choiceId)).toBe(true);
    expect(await store.loadCanonicalMetadata(choiceId)).toMatchObject({
      title: choices.title,
      title_order: choices.title_order,
      pinned: choices.pinned_update!.pinned,
      pinned_order: choices.pinned_update!.pinned_order,
      model: choices.model_update!.model,
      effort: choices.model_update!.effort,
      level: choices.model_update!.level,
    });
    await store.save({ ...stale, ...choices.volatile });
    expect(store.metadataSnapshot(choiceId)).toMatchObject(choices.volatile!);
    expect(await store.agentStore.flush(choiceId)).toBe(true);
    const afterVolatile = await store.loadCanonicalMetadata(choiceId);
    expect(afterVolatile).not.toHaveProperty("status");
    expect(afterVolatile).not.toHaveProperty("updated");
    await store.save({ ...stale, ...choices.pending_update });
    expect(await store.agentStore.flush(choiceId)).toBe(true);
    expect(
      (await store.loadCanonicalMetadata(choiceId))?.pending_model,
    ).toEqual(choices.pending_update!.pending_model);
    await store.save({ ...stale, ...choices.interaction });
    expect(store.metadataSnapshot(choiceId)).toMatchObject(
      choices.interaction!,
    );
    expect(await store.agentStore.flush(choiceId)).toBe(true);
    expect(await store.loadCanonicalMetadata(choiceId)).not.toHaveProperty(
      "last_interaction",
    );
    await store.save({ ...stale, ...choices.clear_pending });
    expect(await store.agentStore.flush(choiceId)).toBe(true);
    expect(await store.loadCanonicalMetadata(choiceId)).not.toHaveProperty(
      "pending_model",
    );
    expect(await store.refreshProjection()).not.toBeNull();
    expect(store.load(choiceId, { withPending: false })).toMatchObject({
      title: choices.title,
      title_order: choices.title_order,
      pinned: choices.pinned_update!.pinned,
      pinned_order: choices.pinned_update!.pinned_order,
      model: choices.model_update!.model,
      effort: choices.model_update!.effort,
      level: choices.model_update!.level,
      created: choices.record!.created,
      workdir: choices.record!.workdir,
      status: "idle",
    });
    expect(store.load(choiceId)).not.toHaveProperty("pending_model");

    const bridge = fixture.cases[5] as ConversationCase;
    await store.save({ ...bridge.record! });
    expect(await store.agentStore.flush(bridge.cid!)).toBe(true);
    expect(store.load(bridge.cid!)?.model).toBe("anthropic/claude-fable-5-1");
    expect((await store.loadCanonicalMetadata(bridge.cid!))?.model).toBe(
      bridge.record!.model,
    );
  } finally {
    await store.agentStore.dispose();
  }
});

test("tree-refresh failure cannot cancel an admitted metadata commit", async () => {
  const root = await temp();
  const hooks = fixtureHooks(root);
  const events: string[] = [];
  hooks.treeRefresh = () => {
    throw new Error("injected tree failure");
  };
  hooks.log = (event) => {
    events.push(event);
  };
  const store = new ConversationStore(
    paths(root),
    new AgentStore(join(root, "agents")),
    hooks,
    new Config({
      env: {
        CHAT_DATA_DIR: root,
        HOME: root,
        RECURSE_HOME: join(root, "settings"),
      },
    }),
  );
  try {
    await store.save(currentRow("tree-fault"));
    expect(events).toContain("tree_view_refresh_failed");
    expect(store.load("tree-fault", { withPending: false })?.title).toBe(
      "first",
    );
    expect(await store.agentStore.flush("tree-fault")).toBe(true);
    expect((await store.loadCanonicalMetadata("tree-fault"))?.title).toBe(
      "first",
    );
  } finally {
    await store.agentStore.dispose();
  }
});

test("closed owner cannot publish a volatile save, a title, or a stale durable save", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  const cid = "owner-gone";
  try {
    await store.save(currentRow(cid));
    expect(await store.agentStore.close(cid)).toBe(true);
    const before = store.metadataSnapshot(cid);
    await store.save({ ...currentRow(cid), status: "running" });
    expect(store.metadataSnapshot(cid)).toEqual(before);
    expect(store.publishTitle(cid, "gone", "00000000000000000003-c")).toBe(
      false,
    );
    store.discardConvProjection(cid);
    await store.save({
      ...currentRow(cid),
      title: "late",
      title_order: "00000000000000000004-d",
    });
    expect(store.load(cid, { withPending: false })).toBeNull();
  } finally {
    await store.agentStore.dispose();
  }
});

test("failed refresh leaves admitted in-memory rows and readiness closed", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  try {
    await store.save({ ...currentRow("refresh"), status: "running" });
    store.noteProjectionStale();
    const flush = store.agentStore.flushAll.bind(store.agentStore);
    store.agentStore.flushAll = async () => false;
    expect(await store.refreshProjection()).toBeNull();
    expect(store.projectionReady()).toBe(false);
    expect(store.load("refresh", { withPending: false })?.status).toBe(
      "running",
    );
    store.agentStore.flushAll = flush;
    expect(await store.refreshProjection()).not.toBeNull();
    expect(store.load("refresh", { withPending: false })?.status).toBe("idle");
    store.noteProjectionReady();
    expect(store.projectionReady()).toBe(true);
  } finally {
    await store.agentStore.dispose();
  }
});

test("configuration guard permits awaited save without bypassing title/mute exclusion", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  try {
    await store.withConfigurationMetadataGuard("config", async (titleToken) => {
      await store.save(currentRow("config"), titleToken);
    });
    expect(await store.agentStore.flush("config")).toBe(true);
    expect((await store.loadCanonicalMetadata("config"))?.title).toBe("first");
  } finally {
    await store.agentStore.dispose();
  }
});

test("session binding read cannot overwrite a title admitted while SQLite was loading", async () => {
  const root = await temp();
  const store = fixtureStore(root);
  const cid = "binding-race";
  try {
    await store.save(currentRow(cid));
    expect(await store.agentStore.flush(cid)).toBe(true);
    const readDisk = store.loadCanonicalMetadata.bind(store);
    let entered!: () => void;
    const loaded = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    store.loadCanonicalMetadata = async (id) => {
      const stale = await readDisk(id);
      entered();
      await held;
      return stale;
    };
    const update = store.updateSessionBinding(cid, { session_id: "session-1" });
    await loaded;
    expect(store.publishTitle(cid, "new title", "00000000000000000002-b")).toBe(
      true,
    );
    resume();
    await update;
    expect(await store.agentStore.flush(cid)).toBe(true);
    const durable = await readDisk(cid);
    expect(durable?.title).toBe("new title");
    expect(durable?.session_id).toBe("session-1");
    expect(store.metadataSnapshot(cid)?.title).toBe("new title");

    store.loadCanonicalMetadata = readDisk;
    const session = fixture.cases[4] as ConversationCase;
    const sessionId = session.cid!;
    await store.save({ ...session.record! });
    await store.updateSessionBinding(sessionId, session.session!);
    expect(await store.agentStore.flush(sessionId)).toBe(true);
    expect(await readDisk(sessionId)).toMatchObject(session.session!);
    await store.save({
      ...store.load(sessionId, { withPending: false })!,
      ...session.draft,
    });
    if (session.unbound !== null)
      throw new Error("session clear input must be null");
    await store.updateSessionBinding(sessionId, session.unbound);
    expect(await store.agentStore.flush(sessionId)).toBe(true);
    const unbound = await readDisk(sessionId);
    for (const key of ["session_id", "session_file", "session_cwd", "draft"])
      expect(unbound).not.toHaveProperty(key);
    expect(store.metadataSnapshot(sessionId)?.draft).toBe(session.draft!.draft);
    expect(await store.refreshProjection()).not.toBeNull();
    expect(store.load(sessionId, { withPending: false })).toMatchObject({
      title: session.record!.title,
      parent: session.record!.parent,
      muted: session.record!.muted,
      workdir: session.record!.workdir,
      draft: null,
    });
    for (const key of ["session_id", "session_file", "session_cwd"])
      expect(store.load(sessionId)).not.toHaveProperty(key);
  } finally {
    await store.agentStore.dispose();
  }
});

test("rollback attempts every cleanup despite an incomplete temp removal", async () => {
  const root = await temp();
  const hooks = fixtureHooks(root);
  hooks.safeRemoveTempKey = () => false;
  const store = new ConversationStore(
    paths(root),
    new AgentStore(join(root, "agents")),
    hooks,
    new Config({
      env: {
        CHAT_DATA_DIR: root,
        HOME: root,
        RECURSE_HOME: join(root, "settings"),
      },
    }),
  );
  const conv = {
    ...currentRow("rollback"),
    external_key: "service:key",
    service_principal: "service",
    tmp_key: "scratch",
  };
  store.applyAgentMetadata({ rollback: conv });
  await store.bindServiceConversation("service", "rollback");
  await store.bindExternalKey("service", "service:key", "rollback");
  await store.rollbackServiceConversation(conv);
  expect(store.load("rollback", { withPending: false })).toBeNull();
  expect(await store.serviceOwnedConversationCount("service")).toBe(0);
  expect(await store.lookupExternalKey("service", "service:key")).toBeNull();
});

test("a record without a backend retains its legacy provenance", async () => {
  const store = fixtureStore(await temp());
  const row: Record<string, unknown> = {
    ...currentRow("legacy"),
    session_id: "claude-session",
  };
  delete row.backend;
  await store.save(row);
  expect(store.load("legacy")!.backend).toBe(LEGACY_BACKEND);
  expect(store.load("legacy")!.session_id).toBe("claude-session");
});
