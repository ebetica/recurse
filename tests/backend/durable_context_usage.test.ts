import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryRecord, StorageWrite } from "@earendil-works/pi-durable";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker";
import {
  ContextUsage,
  promptTokens,
} from "../../src/agents/runtime/context_usage";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Config } from "../../src/config";
import { fauxHost } from "./fixtures/durable_host/host";
import { entries } from "./fixtures/durable_context_usage/entries";

// Regression: #2281 context occupancy stayed on pre-compaction usage until turn end (also #2281 Durable provider usage lost the estimated category split.)
test("latest committed response replaces pre-compaction usage without a turn-end sample", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-context-"));
  const dir = join(root, "conversations", "c1", "durable");
  await mkdir(dir, { recursive: true });
  const worker = new SqliteWorker();
  const storage = await openWorkerSqliteStorage(
    worker,
    join(dir, "session.sqlite"),
  );
  const { host, faux, records } = fauxHost(root);
  let closed = false;
  const append = (rows: EntryRecord[]) =>
    storage.commit(
      rows.map((value) => ({ type: "entry", value })),
      context,
    );
  try {
    await storage.commit(
      [{ type: "conversation", value: { id: 1 } } as StorageWrite],
      context,
    );
    await append(entries.slice(0, 3));
    expect(promptTokens((await host.contextUsage("c1")).usage)).toBe(348357);
    await append(entries.slice(3, 4));
    expect((await host.contextUsage("c1")).usage).toBeNull();
    await append(entries.slice(4, 5));
    expect(promptTokens((await host.contextUsage("c1")).usage)).toBe(51976);
    await append(entries.slice(5));
    expect(promptTokens((await host.contextUsage("c1")).usage)).toBe(53848);
    const reader = new ContextUsage({
      config: new Config({}),
      boundSessionFile: async () => null,
      staticSystemPrompt: () => "",
      readCapturedSystemPrompt: async () => null,
    });
    const read = async () =>
      reader.readContextUsageValues(
        records.c1!,
        await host.contextUsage("c1"),
        "",
        "",
        "",
      );
    expect((await read()).estimated_tokens).toBeNull();
    const { conversation } = await host.open("c1");
    faux.setResponses([entries.at(-1)!.model![0] as AssistantMessage]);
    const submission = await conversation.submit(
      { type: "input", content: "Placeholder operator input" },
      context,
    );
    await submission.wait(context);
    const view = await read();
    expect(view.used_tokens).toBe(53848);
    const split = view.estimated_tokens as Record<string, number>;
    expect(Object.keys(split).sort()).toEqual(
      ["system", "prompts", "messages", "tool_calls", "tool_outputs"].sort(),
    );
    expect(split.system).toBeGreaterThan(0);
    expect(split.prompts).toBeGreaterThan(0);
    expect(split.messages).toBeGreaterThan(0);
    expect(Object.values(split).reduce((sum, n) => sum + n, 0)).toBe(
      view.used_tokens as number,
    );
    await host.close();
    closed = true;
    const reopened = fauxHost(root).host;
    try {
      expect(promptTokens((await reopened.contextUsage("c1")).usage)).toBe(
        53848,
      );
      expect((await reopened.contextUsage("c1")).estimated_tokens).toBeNull();
      await append(
        Array.from({ length: 64 }, (_, index) => ({
          id: 14000000 + index,
          conversationId: 1,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: "Tail input",
              timestamp: 1791840056000 + index,
            },
          ],
        })) as unknown as EntryRecord[],
      );
      expect((await reopened.contextUsage("c1")).usage).toBeNull();
    } finally {
      await reopened.close();
    }
  } finally {
    if (!closed) await host.close();
    await storage.close(context);
    worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
