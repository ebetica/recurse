import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineDoc } from "@earendil-works/pi-durable";
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

function revisions(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM document_revisions
         WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)`,
      )
      .get(JSON.stringify("recurse.reply-times"))!.count;
  } finally {
    db.close();
  }
}

// Regression: #3169 reply writes must not retain an ever-growing delta chain.
test("the newest replies are kept with one persisted checkpoint", async () => {
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
  expect(revisions(host.storagePath("c1"))).toBe(1);
}, 30_000);

// Regression: #3169 the next reply replaces legacy deltas for later opens.
test("a reply checkpoints legacy history for the next open", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-reply-times-"));
  roots.push(root);
  const legacy = defineDoc({
    ...ReplyTimesDoc.definition,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    checkpointWhen: () => false,
  });
  const first = fauxHost(root).host;
  let expected: Readonly<{ finished: Record<string, number> }>;
  try {
    const { harness, conversation } = await first.open("c1");
    for (let n = 1; n <= MAX_REPLIES; n++)
      await conversation.commit(async (tx) => {
        (await tx.doc(legacy, conversation.id)).finished[String(n)] = n + 1;
      }, context);
    expected = (await harness.snapshot(legacy, conversation.id, context))!;
  } finally {
    await first.close();
  }
  const path = first.storagePath("c1");
  expect(revisions(path)).toBeGreaterThan(1);
  const resumed = fauxHost(root).host;
  try {
    const { harness, conversation } = await resumed.open("c1");
    expect(
      await harness.snapshot(ReplyTimesDoc, conversation.id, context),
    ).toEqual(expected);
    await conversation.commit(
      (tx) =>
        recordReplyTimes(tx, conversation.id, [
          [MAX_REPLIES + 1, MAX_REPLIES + 2],
        ]),
      context,
    );
    expected = {
      finished: { ...expected.finished, [MAX_REPLIES + 1]: MAX_REPLIES + 2 },
    };
    delete expected.finished["1"];
  } finally {
    await resumed.close();
  }
  expect(revisions(path)).toBe(1);
  const reopened = fauxHost(root).host;
  try {
    const { harness, conversation } = await reopened.open("c1");
    expect(
      await harness.snapshot(ReplyTimesDoc, conversation.id, context),
    ).toEqual(expected);
  } finally {
    await reopened.close();
  }
  expect(revisions(path)).toBe(1);
}, 30_000);
