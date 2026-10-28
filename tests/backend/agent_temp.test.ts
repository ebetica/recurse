import { expect, test } from "bun:test";
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
import { fixtureStore } from "./fixtures/conversation_store/spec";

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
    retire(victim, temp.config.paths.TRASH_DIR);
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
      expect(await readdir(temp.config.paths.TRASH_DIR)).toEqual([]);
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
        temp.config.paths.AGENT_TEMP_INSTANCE_DIR,
        temp.config.agentTempLeaf(key),
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
        join(temp.config.paths.AGENT_TEMP_INSTANCE_DIR, agentKey, "uploads"),
      ),
    ).toBe(true);
    await cp(
      join(temp.config.paths.AGENT_TEMP_INSTANCE_DIR, agentKey, "uploads"),
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
      await readFile(
        join(temp.config.paths.DATA_DIR, ".agent-files-v1"),
        "utf8",
      ),
    ).toBe("1\n");
    expect((await drafts.readDraftFile(token, String(upload.id)))[1]).toEqual(
      new TextEncoder().encode("hi"),
    );
    const conv = { ...records.get("a")!, attachment_draft: token };
    records.set("a", conv);
    await drafts.transferAttachmentDraft(token, conv);
    expect(await exists(join(temp.uploadsDir(draftKey), ".."))).toBe(false);
    const trash = await readdir(temp.config.paths.TRASH_DIR);
    expect(trash.length).toBe(1);
    const moved = await readdir(temp.uploadsDir("20260925-agent-a"));
    expect(moved.filter((n) => n.endsWith(".blob")).length).toBe(2);
  }));

test("upload racing member retirement stores once or refuses", async () => {
  for (let round = 0; round < 20; round++)
    await withRoot(async (root) => {
      const spec: TempSpec = {
        name: "race",
        tree: {
          "data/attachment_counters.json": {
            json: { version: 1, files: 0, bytes: 0 },
          },
        },
        conversations: [{ id: "a", tmp_key: "20260925-agent-a" }],
        ops: [],
      };
      await runSpec(root, spec);
      const fenced = new Set<string>();
      const { temp, conversations } = build(
        root,
        spec,
        () => round + 1,
        fenced,
      );
      await temp.ensureUploadsDir("20260925-agent-a");
      const upload = temp
        .addConversationUpload("a", new Uint8Array(64), "r.bin")
        .then(
          () => "stored",
          (error: Error) => `${error.name}: ${error.message}`,
        );
      if (round % 2) await Bun.sleep(0);
      fenced.add("a");
      let retired: [boolean, string | null] = [false, null];
      for (let i = 0; i < 200 && !retired[0]; i++) {
        retired = await conversations.withPermanentDeleteStateGuard("a", () =>
          temp.retireMemberCollection("a", "20260925-agent-a"),
        );
        if (!retired[0]) await Bun.sleep(1);
      }
      const outcome = await upload;
      expect(retired).toEqual([true, null]);
      expect(
        await temp
          .addConversationUpload("a", new Uint8Array(1), "late.bin")
          .catch((error: Error) => error.message),
      ).toBe("'attachment owner not found'");
      expect(await exists(temp.uploadsDir("20260925-agent-a"))).toBe(false);
      expect([
        "stored",
        "KeyError: 'attachment owner not found'",
        "AttachmentError: attachment collection was retired",
        "AttachmentError: attachment collection is unavailable",
      ]).toContain(outcome);
    });
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
    expect(await exists(temp.config.paths.AGENT_TEMP_INSTANCE_DIR)).toBe(false);
  }));

test("trash drain is single-flight and cadenced", () =>
  withRoot(async (root) => {
    const { temp } = build(root, { name: "drain", ops: [] });
    const trashDir = temp.config.paths.AGENT_TEMP_TRASH_DIR;
    await mkdir(join(trashDir, sid(1)), { recursive: true });
    await Promise.all([
      temp.drainTrash({ force: true }),
      temp.drainTrash({ force: true }),
    ]);
    expect(await readdir(trashDir)).toEqual([]);
  }));

test("legacy row without tmp_key gets one assigned under the real store's guards", () =>
  withRoot(async (root) => {
    const store = fixtureStore(join(root, "store"));
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
        pinned: false,
        pinned_order: `00000000000000000001-${"a".repeat(32)}`,
      });
      const spec: TempSpec = { name: "legacy", ops: [] };
      const { temp } = build(root, spec, () => 1, new Set(), {
        conversations: store,
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
