import { expect, test } from "bun:test";
import { agentTempLeaf } from "../../src/state_paths";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { retire } from "../../src/utils/trash";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, runSpec, type TempSpec } from "./fixtures/agent_temp/replay";
import { buildWorld } from "./fixtures/agent_node/world";
import { switchoverWorld } from "./fixtures/durable_host/host";
import { timeoutScheduler } from "../../src/agents/runtime/stall_timer";
import { TreeLifecycleBusy } from "../../src/utils/flock";
import { probeMetadataFlock } from "./fixtures/metadata_flock";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-temp-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Regression: #2609 retired trees must not block requests while maintenance reclaims them.
test("requests stay available while AgentTemp drains retired trees", () =>
  withRoot(async (root) => {
    const { temp } = build(root, {
      name: "drain-requests",
      tree: {},
      conversations: [],
      ops: [],
    });
    const victim = join(root, "retired-tools");
    await mkdir(victim);
    await Promise.all(
      Array.from({ length: 2000 }, (_, n) =>
        writeFile(join(victim, String(n)), "tool payload"),
      ),
    );
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "outside bytes");
    await symlink(outside, join(victim, "escape"));
    retire(victim, temp.paths.TRASH_DIR);
    let finished = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ draining: !finished }),
    });
    let draining: Promise<void> | undefined;
    try {
      await fetch(server.url);
      draining = temp.drainTrash({ force: true }).then(() => {
        finished = true;
      });
      const response = await fetch(server.url);
      expect(await response.json()).toEqual({ draining: true });
      await draining;
      expect(await readdir(temp.paths.TRASH_DIR)).toEqual([]);
      expect(await exists(victim)).toBe(false);
      expect(await readFile(join(outside, "keep"), "utf8")).toBe(
        "outside bytes",
      );
    } finally {
      await draining;
      server.stop(true);
    }
  }));

const sid = (n: number) => n.toString(16).padStart(32, "0");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

// Regression: #2851 migrate agent and draft uploads before adoption.
test("AgentTemp migrates legacy collections and drafts before adoption and retirement", () =>
  withRoot(async (root) => {
    const spec: TempSpec = {
      name: "seam",
      tree: {
        "data/attachment_counters.json": {
          json: { version: 1, files: 0, bytes: 0 },
        },
      },
      conversations: [{ id: "a", tmp_key: "20260925-agent-a" }],
      ops: [],
    };
    await runSpec(root, spec);
    const { temp, drafts, records } = build(root, spec);
    const { id: token } = await drafts.createAttachmentDraft();
    const draftKey = `draft-${temp.utcDay()}-${token}`;
    const staged = temp.uploadsDir(draftKey);
    expect(await exists(staged)).toBe(true);
    const upload = await drafts.addDraftUpload(
      token,
      new TextEncoder().encode("hi"),
      "a.txt",
    );
    const agentKey = "20260925-agent-a";
    await temp.ensureUploadsDir(agentKey);
    const agentUpload = await temp.addConversationUpload(
      "a",
      new TextEncoder().encode("existing"),
      "existing.txt",
    );
    for (const key of [draftKey, agentKey]) {
      const legacy = join(
        temp.paths.AGENT_TEMP_INSTANCE_DIR,
        agentTempLeaf(temp.paths, key),
      );
      await mkdir(legacy, { recursive: true });
      await rename(temp.uploadsDir(key), join(legacy, "uploads"));
    }
    await temp.ensureUploadsDir(agentKey);
    await expect(temp.reconcileAgentTempStartup()).rejects.toThrow(
      "legacy uploads conflict",
    );
    expect(
      await exists(
        join(temp.paths.AGENT_TEMP_INSTANCE_DIR, agentKey, "uploads"),
      ),
    ).toBe(true);
    await cp(
      join(temp.paths.AGENT_TEMP_INSTANCE_DIR, agentKey, "uploads"),
      temp.uploadsDir(agentKey),
      { recursive: true },
    );
    await writeFile(
      join(temp.uploadsDir(agentKey), ".legacy-migration-complete"),
      "1\n",
    );
    await temp.reconcileAgentTempStartup();
    expect(
      await readFile(
        join(temp.uploadsDir(agentKey), `${agentUpload.id}.blob`),
        "utf8",
      ),
    ).toBe("existing");
    expect(
      await readFile(join(temp.paths.DATA_DIR, ".agent-files-v1"), "utf8"),
    ).toBe("1\n");
    expect((await drafts.readDraftFile(token, String(upload.id)))[1]).toEqual(
      new TextEncoder().encode("hi"),
    );
    const conv = { ...records.get("a")!, attachment_draft: token };
    records.set("a", conv);
    await drafts.transferAttachmentDraft(token, conv);
    expect(await exists(join(temp.uploadsDir(draftKey), ".."))).toBe(false);
    const trash = await readdir(temp.paths.TRASH_DIR);
    expect(trash.length).toBe(1);
    const moved = await readdir(temp.uploadsDir("20260925-agent-a"));
    expect(moved.filter((n) => n.endsWith(".blob")).length).toBe(2);
  }));

test("a fenced upload cannot reopen a collection while supervisor reap drains it", async () => {
  const world = await switchoverWorld();
  try {
    const {
      agentTemp: temp,
      conversations,
      create,
      nodes,
      reap,
    } = world.instance;
    const cid = "upload-race";
    const conversation = await create.create({
      cid,
      model: "recurse-test/scripted",
    });
    const collection = temp.uploadsDir(String(conversation.tmp_key));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fenced = Promise.withResolvers<void>();
    const node = nodes.node(cid);
    const lock = node.withLock;
    const withLock = lock.bind(node);
    let locked = 0;
    node.withLock = (work, token) =>
      withLock(async (held) => {
        locked++;
        try {
          return await work(held);
        } finally {
          locked--;
        }
      }, token);
    const assertGuardHeld = async () => {
      expect(nodes.existing(cid)).toBe(node);
      expect(locked).toBeGreaterThan(0);
      for (const dir of [
        conversations.paths.titleLockDir,
        conversations.paths.muteLockDir,
      ]) {
        await expect(probeMetadataFlock(dir, cid)).rejects.toBeInstanceOf(
          TreeLifecycleBusy,
        );
      }
    };
    const ensureUploadsDir = temp.ensureUploadsDir;
    let directoryGuardChecked = false;
    temp.ensureUploadsDir = async (key) => {
      await assertGuardHeld();
      const made = await ensureUploadsDir.call(temp, key);
      directoryGuardChecked = true;
      return made;
    };
    const beginReap = node.beginReap;
    node.beginReap = () => {
      const result = beginReap.call(node);
      fenced.resolve();
      return result;
    };
    const releaseFileOp = node.releaseFileOp;
    const retireCollection = temp.retireMemberCollection;
    let leaseReleased = false;
    let collectionRetired = false;
    node.releaseFileOp = () => {
      releaseFileOp.call(node);
      leaseReleased = true;
    };
    temp.retireMemberCollection = async (...args) => {
      expect(leaseReleased).toBe(true);
      await assertGuardHeld();
      const result = await retireCollection.apply(temp, args);
      collectionRetired = true;
      return result;
    };
    const add = temp.addConversationUpload;
    let upload: Promise<Record<string, unknown>> | undefined;
    let deletion: Promise<string[]> | undefined;
    try {
      expect(await exists(collection)).toBe(false);
      await reap.admitConversationUpload(cid, new Uint8Array(1), "before.bin");
      expect(directoryGuardChecked).toBe(true);
      expect(await exists(collection)).toBe(true);
      leaseReleased = false;
      temp.addConversationUpload = async (...args) => {
        entered.resolve();
        await release.promise;
        return add.apply(temp, args);
      };
      upload = reap.admitConversationUpload(
        cid,
        new Uint8Array(64),
        "racing.bin",
      );
      await Promise.race([
        entered.promise,
        upload.then(() => {
          throw new Error("Upload skipped the real worker");
        }),
      ]);
      deletion = reap.reap(cid, null);
      await Promise.race([
        fenced.promise,
        deletion.then(() => {
          throw new Error("Reap skipped the node fence");
        }),
      ]);
      expect(node.reaping).toBe(true);
      expect(await exists(collection)).toBe(true);
      release.resolve();
      await expect(upload).rejects.toThrow("attachment owner not found");
      expect(await deletion).toEqual([cid]);
      expect(collectionRetired).toBe(true);
      expect(world.load(cid)).toBeNull();
      expect(await exists(collection)).toBe(false);
      await expect(
        reap.admitConversationUpload(cid, new Uint8Array(1), "late.bin"),
      ).rejects.toThrow("attachment owner not found");
      expect(await exists(collection)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([upload, deletion]);
      temp.addConversationUpload = add;
      temp.ensureUploadsDir = ensureUploadsDir;
      temp.retireMemberCollection = retireCollection;
      node.beginReap = beginReap;
      node.releaseFileOp = releaseFileOp;
      node.withLock = lock;
    }
  } finally {
    await world.close();
  }
});

test("fenced owner admission creates nothing", () =>
  withRoot(async (root) => {
    const spec: TempSpec = {
      name: "fence",
      conversations: [{ id: "a", tmp_key: "20260925-agent-a" }],
      fenced: ["a"],
      ops: [],
    };
    const { temp } = build(root, spec);
    await expect(temp.admitUploadsDir("a", "20260925-agent-a")).rejects.toThrow(
      "attachment owner not found",
    );
    expect(await exists(temp.paths.AGENT_TEMP_INSTANCE_DIR)).toBe(false);
  }));

test("trash drain is single-flight and cadenced", () =>
  withRoot(async (root) => {
    const { temp } = build(root, { name: "drain", ops: [] });
    const trashDir = temp.paths.AGENT_TEMP_TRASH_DIR;
    await mkdir(join(trashDir, sid(1)), { recursive: true });
    await Promise.all([
      temp.drainTrash({ force: true }),
      temp.drainTrash({ force: true }),
    ]);
    expect(await readdir(trashDir)).toEqual([]);
  }));

test("legacy row without tmp_key gets one assigned under the real store's guards", () =>
  withRoot(async (root) => {
    const { conversations: store, configActions } = buildWorld({
      root: join(root, "store"),
      sink: { write: () => {} },
      scheduler: timeoutScheduler,
    });
    try {
      const cid = "legacy";
      await store.save({
        id: cid,
        parent: null,
        backend: "pi",
        level: 3,
        model: "anthropic/claude-fable-5-1",
        effort: "high",
        title: "first",
        title_order: "00000000000000000001-a",
        taken_over: false,
        taken_over_order: `00000000000000000001-${"a".repeat(32)}`,
      });
      const spec: TempSpec = { name: "legacy", ops: [] };
      const { temp } = build(root, spec, () => 1, new Set(), {
        conversations: store,
        configActions,
      });
      const conv = store.load(cid, { withPending: false })!;
      expect(conv.tmp_key).toBeUndefined();
      const dir = await temp.ensureAgentTemp(conv);
      const key = store.load(cid, { withPending: false })?.tmp_key;
      expect(typeof key).toBe("string");
      expect(conv.tmp_key).toBe(key);
      expect(dir.endsWith(key as string)).toBe(true);
      expect(await exists(dir)).toBe(true);
    } finally {
      await store.agentStore.dispose();
    }
  }));
