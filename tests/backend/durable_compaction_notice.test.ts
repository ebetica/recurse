import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  LiveDoc,
  type Conversation,
  type EntryRecord,
  type Harness,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker";
import { fauxHost, held, idle, until } from "./fixtures/durable_host/host";
import recorded from "./fixtures/durable_compaction/queued-summary.json";

const READY = "Summary ready, applying at the next step";
type Rec = Record<string, unknown>;
const rows = recorded.map((row) => ({
  id: row.id * 1000,
  conversationId: 1,
  kind: row.kind,
  ...("head" in row ? { head: row.head! * 1000 } : {}),
  model: [{ role: "user", content: row.text, timestamp: row.timestamp }],
})) as unknown as EntryRecord[];
const texts = (page: Rec) =>
  ((page.blocks ?? []) as Rec[]).map((row) => row.text);

async function capture(phase: string, page: Rec) {
  const dir = process.env.RECURSE_NOTICE_EVIDENCE_DIR;
  if (dir)
    await Bun.write(
      join(dir, `${phase}.json`),
      JSON.stringify({
        blocks: page.blocks,
        active_run: page.active_run,
        pending: page.pending,
        removed: page.removed,
      }),
    );
}

// Regression: #2287 queued ready summary disappeared on input admission
test("queued recorded compaction summary stays visible through input admission until the next boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-notice-"));
  const dir = join(root, "conversations", "c1", "durable");
  await mkdir(dir, { recursive: true });
  const worker = new SqliteWorker();
  const storage = await openWorkerSqliteStorage(
    worker,
    join(dir, "session.sqlite"),
  );
  const { host, faux } = fauxHost(root);
  const answer = held(fauxAssistantMessage("Step done"));
  faux.setResponses([answer.step, fauxAssistantMessage("Input answered")]);
  try {
    await storage.commit(
      [
        { type: "conversation", value: { id: 1 } } as StorageWrite,
        ...rows.slice(0, 2).map((value) => ({ type: "entry" as const, value })),
      ],
      context,
    );
    await host.send("c1", "Hold", "hold");
    await answer.started;
    const { harness, conversation } = await (
      host as unknown as {
        open(
          cid: string,
        ): Promise<{ harness: Harness; conversation: Conversation }>;
      }
    ).open("c1");
    await host.compact("c1");
    const notice = "Nothing to compact yet.";
    await until(async () => texts(await host.view("c1")).includes(notice));
    const immediate = texts(await host.view("c1"));
    expect(host.runningCount()).toBe(1);
    expect(immediate.indexOf(notice)).toBe(immediate.indexOf("Hold") + 1);
    expect(immediate).not.toContain(READY);
    const summary = rows[2]!;
    const write = await conversation.submit(
      {
        type: "write",
        requestId: "recorded-summary",
        entry: { kind: summary.kind, head: summary.head, model: summary.model },
      },
      context,
    );
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
    expect(
      inbox!.items.some(
        (item) => item.mode === "write" && item.entry.kind === "pi.compaction",
      ),
    ).toBe(true);
    expect(
      (await harness.snapshot(LiveDoc, conversation.id, context))
        ?.compactions ?? [],
    ).toHaveLength(0);
    const queued = await host.view("c1", { limit: 100 });
    await capture("queued", queued);
    expect(texts(queued).filter((text) => text === READY)).toHaveLength(1);
    expect(texts(queued).indexOf(READY)).toBe(
      texts(queued).indexOf(notice) + 1,
    );
    expect(texts(queued)).not.toContain("Compacting…");
    const input = await conversation.submit(
      { type: "input", content: "Queued input", whenBusy: "followUp" },
      context,
    );
    const admitted = texts(await host.view("c1", { limit: 100 }));
    expect(admitted.indexOf(notice)).toBe(admitted.indexOf("Hold") + 1);
    expect(admitted.indexOf(READY)).toBe(admitted.indexOf(notice) + 1);
    answer.release();
    expect((await write.wait(context)).status).toBe("done");
    expect((await input.wait(context)).status).toBe("done");
    await until(idle(host));
    const applied = await host.view("c1", { limit: 100 });
    const updates = await host.view("c1", {
      since: Number(queued.revision),
      instance: String(queued.instance_id),
      limit: 100,
    });
    const readyId = String(
      (queued.blocks as Rec[]).find((row) => row.text === READY)!.id,
    );
    expect(updates.removed as string[]).toContain(readyId);
    await capture("applied", { ...applied, removed: updates.removed });
    expect(texts(applied)).not.toContain(READY);
    expect(
      texts(applied).filter((text) =>
        ["Step done", "Queued input", "Input answered"].includes(String(text)),
      ),
    ).toEqual(["Step done", "Queued input", "Input answered"]);
    const entries = (await conversation.entries({}, 100, undefined, context))
      .items;
    expect(
      entries.filter((entry) => entry.kind === "pi.compaction"),
    ).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === "pi.compaction")!.head).toBe(
      summary.head!,
    );
  } finally {
    answer.release();
    await host.close();
    await storage.close(context);
    worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
