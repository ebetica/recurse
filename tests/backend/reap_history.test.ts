import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archive,
  archiveLiveRecord,
  expire,
  type ReapHistoryPaths,
} from "../../src/agents/reap_history";
import type { ExpiryResult } from "../../src/utils/partition_expiry";
import { retire, sweep } from "../../src/utils/trash";
import { Config } from "../../src/config";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

async function withRoot<T>(body: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "recurse-reap-history-"));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function paths(root: string): ReapHistoryPaths {
  return { historyDir: join(root, "history"), trashDir: join(root, "trash") };
}

function sourceFiles(root: string, cid: string): [string, string[]] {
  const live = join(root, "live");
  mkdirSync(live, { recursive: true });
  const conversation = join(live, `${cid}.json`);
  const message = join(live, `${cid}.jsonl`);
  writeFileSync(conversation, `{"id":"${cid}","tmp_key":"key-${cid}"}`);
  writeFileSync(message, "TS-neutral message\n");
  return [conversation, [message]];
}

// Regression: #3069 Reaped-history publication leaves no filesystem work on the main thread.
test("archiveLiveRecord validates and publishes without blocking I/O", async () => {
  await withRoot(async (root) => {
    const policy = paths(root);
    const sentinel = join(root, "sentinel.record.tmp");
    writeFileSync(sentinel, "preserve this file");
    for (const [cid, date, key] of [
      ["../../../../sentinel", "20260821", "key-child"],
      ["child", "../outside", "key-child"],
      ["child", "20260821", "../key-child"],
    ])
      expect(() => archiveLiveRecord(cid, {}, [], date, key, policy)).toThrow(
        TypeError,
      );
    expect(readFileSync(sentinel, "utf8")).toBe("preserve this file");
    expect(existsSync(policy.historyDir)).toBe(false);
    expect(existsSync(join(root, "outside"))).toBe(false);
    if (process.platform !== "linux") return;
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(process.cwd(), "tests/dev/blocking_trace_preload.ts"),
        join(import.meta.dir, "fixtures/reap-history-trace.ts"),
      ],
      {
        env: {
          ...process.env,
          RECURSE_BLOCKING_TRACE: join(root, "trace.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.blocking).toEqual([]);
      expect(result.sameLifetime).toBe(true);
      expect(result.lifetimes).toEqual(["key-child", "key-sibling"]);
      expect(result.linkedMessages).toBe(true);
      expect(result.stagingRetired).toBe(true);
      expect(result.temporaryRemoved).toBe(true);
      expect(result.unrelated).toBe("another publication");
      expect(result.sentinel).toBe("preserve this file");
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

test("archive retries after retiring crash staging without losing linked files", async () => {
  await withRoot(async (root) => {
    const policy = paths(root);
    const [conversation, messages] = sourceFiles(root, "child");
    const staging = join(policy.historyDir, "20260821", ".child.key-child.tmp");
    mkdirSync(staging, { recursive: true });
    linkSync(conversation, join(staging, "conversation.json"));
    const originalInode = statSync(conversation).ino;
    const destination = await archive(
      "child",
      conversation,
      messages,
      "20260821",
      "key-child",
      policy,
    );
    expect(existsSync(staging)).toBe(false);
    expect(statSync(join(destination, "conversation.json")).ino).toBe(
      originalInode,
    );
    expect(statSync(join(destination, "messages", "child.jsonl")).ino).toBe(
      statSync(messages[0]!).ino,
    );
    const stagingTrash = join(
      policy.trashDir,
      readdirSync(policy.trashDir)[0]!,
    );
    expect(statSync(join(stagingTrash, "conversation.json")).ino).toBe(
      originalInode,
    );
    expect(retire(join(root, "live"), policy.trashDir)).toBe(true);
    expect(sweep(policy.trashDir, 10)).toBe(2);
    expect(
      readFileSync(join(destination, "conversation.json"), "utf8"),
    ).toContain("key-child");
  });
});

test("hard-link EXDEV leaves the source and never copies it", async () => {
  const sharedMemory = "/dev/shm";
  if (!existsSync(sharedMemory)) return;
  let external: string;
  try {
    external = mkdtempSync(join(sharedMemory, "recurse-reap-history-"));
  } catch {
    return;
  }
  const local = mkdtempSync(join(tmpdir(), "recurse-reap-history-local-"));
  try {
    if (statSync(external).dev === statSync(local).dev) return;
    const live = join(external, "live");
    mkdirSync(live);
    const conversation = join(live, "foreign.json");
    writeFileSync(conversation, '{"tmp_key":"foreign"}');
    await expect(
      archive("foreign", conversation, [], "20260821", "foreign", paths(local)),
    ).rejects.toThrow(expect.objectContaining({ code: "EXDEV" }));
    expect(readFileSync(conversation, "utf8")).toContain("foreign");
    expect(
      existsSync(join(local, "history", "20260821", "foreign.foreign")),
    ).toBe(false);
    const [localConversation] = sourceFiles(local, "local");
    const policy = { ...paths(local), trashDir: join(external, "trash") };
    const staging = join(policy.historyDir, "20260821", ".local.key-local.tmp");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "unfinished"), "preserve staging");
    await expect(
      archive("local", localConversation, [], "20260821", "key-local", policy),
    ).rejects.toThrow(expect.objectContaining({ code: "EXDEV" }));
    expect(readFileSync(join(staging, "unfinished"), "utf8")).toBe(
      "preserve staging",
    );
  } finally {
    rmSync(external, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

// Feature: #2863 Settings controls bounded archive expiry.
test("retention changes expiry without reopening or migrating archived stores", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-setting-"));
  const config = new Config({
    env: { CHAT_DATA_DIR: root, HOME: root, RECURSE_HOME: root },
  });
  const w = fauxHost(root);
  try {
    w.records.c1!.tmp_key = "retention";
    w.faux.setResponses([fauxAssistantMessage("retained history")]);
    await w.host.send("c1", "retain this", "retention-run");
    await until(() => w.host.runningCount() === 0);
    expect(await w.host.retire("c1")).toBe(true);
    const entry = (await w.host.archive.get("c1"))!;
    const now = entry.archived + 40 * 86400;
    const passes: ExpiryResult[] = [];
    const policy = {
      ...paths(root),
      get retentionDays() {
        return config.deletedAgentHistoryDays();
      },
      expiryLimit: 1,
      logExpiry: (result: ExpiryResult) => passes.push(result),
    };
    const [conversation, messages] = sourceFiles(root, "legacy");
    const date = new Date(entry.archived * 1000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
    const legacy = await archive(
      "legacy",
      conversation,
      messages,
      date,
      "key-legacy",
      policy,
    );
    expect(config.deletedAgentHistoryDays()).toBe(90);
    expect(
      await w.host.archive.expire(
        config.deletedAgentHistoryDays(),
        policy.trashDir,
        1,
        now,
      ),
    ).toBe(0);
    expect(await expire(policy, { now })).toEqual({
      examined: 1,
      retired: 0,
      recent: 1,
      malformed: 0,
      unreadable: 0,
      deferred: 0,
      cursor: date,
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.recent).toBe(1);
    expect(existsSync(legacy)).toBe(true);
    await config.setDeletedAgentHistoryDays(30);
    expect(
      new Config({
        env: { CHAT_DATA_DIR: root, HOME: root, RECURSE_HOME: root },
      }).deletedAgentHistoryDays(),
    ).toBe(30);
    const release = w.host.archive.hold(entry.archive_id);
    expect(
      await w.host.archive.expire(
        config.deletedAgentHistoryDays(),
        policy.trashDir,
        1,
        now,
      ),
    ).toBe(0);
    release();
    expect(
      await w.host.archive.expire(
        config.deletedAgentHistoryDays(),
        policy.trashDir,
        1,
        now,
      ),
    ).toBe(1);
    expect(await w.host.archive.get("c1")).toBeNull();
    expect(existsSync(join(root, "agent-archive", entry.archive_id))).toBe(
      false,
    );
    expect(readdirSync(policy.trashDir).length).toBeGreaterThan(0);
    expect((await expire(policy, { now })).retired).toBe(1);
    expect(passes).toHaveLength(2);
    expect(passes[1]!.retired).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    await expect(config.setDeletedAgentHistoryDays(0)).rejects.toThrow();
    expect(config.deletedAgentHistoryDays()).toBe(30);
  } finally {
    await w.host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
