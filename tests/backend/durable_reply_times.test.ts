import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  MAX_REPLIES,
  recordReplyTimes,
  ReplyTimesDoc,
} from "../../src/agents/durable/reply_times.ts";
import { fauxHost, idle, until } from "./fixtures/durable_host/host.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a reply's model time is its finish minus its request start", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-reply-times-"));
  roots.push(root);
  const { host, faux } = fauxHost(root);
  faux.setResponses([fauxAssistantMessage("slow answer")]);
  try {
    await host.send("c1", "go", "r1");
    const { harness, conversation } = await host.open("c1");
    const reply = async () =>
      (await conversation.entries({}, 10, undefined, context)).items.find(
        (entry) => entry.kind === "pi.assistant",
      );
    await until(async () => (await reply()) !== undefined);
    await until(idle(host));
    const start = ((await reply())!.model![0] as { timestamp: number })
      .timestamp;
    const finish = (await harness.snapshot(
      ReplyTimesDoc,
      conversation.id,
      context,
    ))!.finished[String(start)]!;
    console.log("reply model time ms", finish - start);
    const row = (
      (await host.view("c1")).blocks as Record<string, unknown>[]
    ).find((block) => block.role === "assistant" && block.kind === "text")!;
    expect(row.text).toBe("slow answer");
    expect(row.model_time_ms).toBe(finish - start);
  } finally {
    await host.close();
  }
}, 30_000);

test("the newest replies are kept, up to the cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-reply-times-"));
  roots.push(root);
  const { host } = fauxHost(root);
  try {
    const { harness, conversation } = await host.open("c1");
    const record = (from: number, count: number) =>
      conversation.commit(
        (tx) =>
          recordReplyTimes(
            tx,
            conversation.id,
            Array.from({ length: count }, (_, i) => [from + i, from + i + 1]),
          ),
        context,
      );
    const kept = async () =>
      Object.keys(
        (await harness.snapshot(ReplyTimesDoc, conversation.id, context))!
          .finished,
      ).map(Number);
    for (let n = 1; n <= MAX_REPLIES + 1; n++) {
      await record(n, 1);
      if ([251, MAX_REPLIES, MAX_REPLIES + 1].includes(n)) {
        const now = await kept();
        expect(now).toHaveLength(Math.min(n, MAX_REPLIES));
        expect(Math.min(...now)).toBe(Math.max(1, n - MAX_REPLIES + 1));
      }
    }
  } finally {
    await host.close();
  }
}, 30_000);
