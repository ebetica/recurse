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
import { retire, sweep } from "../../src/utils/trash";
import { Config } from "../../src/config";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

function withRoot<T>(body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "recurse-reap-history-"));
  try {
    return body(root);
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

test("archiveLiveRecord validates before touching filesystem paths", () => {
  withRoot((root) => {
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
  });
});

test("archive retries after retiring crash staging without losing linked files", () => {
  withRoot((root) => {
    const policy = paths(root);
    const [conversation, messages] = sourceFiles(root, "child");
    const staging = join(policy.historyDir, "20260821", ".child.key-child.tmp");
    mkdirSync(staging, { recursive: true });
    linkSync(conversation, join(staging, "conversation.json"));
    const originalInode = statSync(conversation).ino;
    const destination = archive(
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

test("hard-link EXDEV leaves the source and never copies it", () => {
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
    expect(() =>
      archive("foreign", conversation, [], "20260821", "foreign", paths(local)),
    ).toThrow(expect.objectContaining({ code: "EXDEV" }));
    expect(readFileSync(conversation, "utf8")).toContain("foreign");
    expect(
      existsSync(join(local, "history", "20260821", "foreign.foreign")),
    ).toBe(false);
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
    const policy = {
      ...paths(root),
      get retentionDays() {
        return config.deletedAgentHistoryDays();
      },
      expiryLimit: 1,
      logExpiry: () => {},
    };
    const [conversation, messages] = sourceFiles(root, "legacy");
    const date = new Date(entry.archived * 1000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
    const legacy = archive(
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
    expire(policy, { now });
    expect(existsSync(legacy)).toBe(true);
    config.setDeletedAgentHistoryDays(30);
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
    expire(policy, { now });
    expect(existsSync(legacy)).toBe(false);
    expect(() => config.setDeletedAgentHistoryDays(0)).toThrow();
    expect(config.deletedAgentHistoryDays()).toBe(30);
  } finally {
    await w.host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
