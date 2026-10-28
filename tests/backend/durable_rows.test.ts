import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Conversation,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";
import {
  DurableRows,
  pendingRows,
} from "../../src/agents/durable/durable_rows.ts";
import { ConversationView } from "../../src/agents/view/conversation.ts";
import {
  applyBatch,
  readBatch,
  ViewEntry,
  window,
} from "../../src/agents/view/reader.ts";

type Rec = Record<string, unknown>;
const recorded = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/durable_rows/recorded.json"), {
    encoding: "utf8",
  }),
) as { entries: EntryRecord[]; live: Record<string, Rec> };
const live = recorded.live as Record<string, LiveState>;
const root = mkdtempSync(join(tmpdir(), "durable-rows-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function conversation(
  bound = Infinity,
  calls: Rec[] = [],
  entries = recorded.entries,
): Conversation {
  return {
    entries: async (query: Rec, limit: number, cursor?: { at: number }) => {
      calls.push({ ...query, limit });
      const items = entries
        .filter(
          (entry) =>
            entry.id < bound &&
            entry.id >= Number(query.minEntryId ?? 0) &&
            entry.id <= Number(query.maxEntryId ?? Infinity),
        )
        .reverse();
      const at = cursor?.at ?? 0;
      const next = at + limit < items.length ? { at: at + limit } : undefined;
      return { items: items.slice(at, at + limit), next };
    },
  } as unknown as Conversation;
}

const page = (
  rows: DurableRows,
  options: Rec = {},
  bound = Infinity,
  state?: LiveState,
) =>
  rows.page(
    conversation(bound),
    {} as never,
    state,
    {},
    { limit: 100, ...options },
  );

function shape(blocks: Rec[]): Rec[] {
  const at = new Map(blocks.map((block, index) => [block.id, index]));
  const ref = (value: unknown) => at.get(value) ?? "missing";
  return blocks.map(
    ({
      id: _id,
      offset: _o,
      order: _r,
      call_id: _c,
      artifact_id: _a,
      ...b
    }) => {
      const meta = b.meta as Rec | null;
      if (!meta) return b;
      const linked = { ...meta };
      for (const key of ["firstKeptEntryId", "summaryEntryId", "jumpEntryId"])
        if (key in linked) linked[key] = ref(linked[key]);
      return { ...b, meta: linked };
    },
  );
}

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

function piSession(): string {
  const lines: Rec[] = [
    { type: "session", version: 3, id: "pi", timestamp: "", cwd: "/work" },
  ];
  let parentId: string | null = null;
  for (const entry of recorded.entries) {
    const id = `e${entry.id}`;
    const message = entry.model?.[0] as Rec | undefined;
    if (entry.kind === "pi.compaction") {
      const text = String((message!.content as Rec[])[0]!.text);
      const summary = text.slice(SUMMARY_PREFIX.length, -"\n</summary>".length);
      const pointId = `e${entry.head}`;
      lines.push(
        {
          type: "compaction",
          id,
          parentId,
          summary,
          firstKeptEntryId: pointId,
        },
        {
          type: "custom_message",
          id: `${id}n`,
          parentId: id,
          customType: "recurse.compaction-notice",
          content: "Context compacted at 2k tokens.",
          display: true,
          details: { pointId },
        },
      );
      parentId = `${id}n`;
    } else if (message && entry.kind !== "pi.system") {
      lines.push({ type: "message", id, parentId, message });
      parentId = id;
    }
  }
  return lines.map((line) => JSON.stringify(line) + "\n").join("");
}

test("a recorded transcript shows the rows of a Pi session with the same messages", async () => {
  const durable = (await page(new DurableRows("c1"))).blocks as Rec[];
  const path = join(root, "pi.jsonl");
  writeFileSync(path, piSession());
  const inputs = {
    cid: "c1",
    sessionId: "pi",
    sessionFile: path,
    sessionCwd: "/work",
    live: "[]",
    envelope: "{}",
    files: "{}",
    maxSessionBytes: 1 << 30,
  };
  const view = new ViewEntry(new ConversationView("c1", ""));
  const batch = await readBatch(inputs, view.feed);
  applyBatch(view, view.instanceId, batch);
  const pi = window(view, inputs, { caughtUp: true, limit: 100 }).blocks;
  expect(shape(durable)).toEqual(shape(pi as Rec[]));
  expect(
    durable
      .filter((block) => block.kind === "tool_call")
      .map((block) => block.artifact_id)
      .sort(),
  ).toEqual(
    recorded.entries
      .filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => `d-${entry.byTaskId}`)
      .sort(),
  );
  expect(
    durable.map((b) => [
      b.kind === "marker" ? b.role : `${b.role}:${b.origin}`,
      b.name ?? b.stop_reason,
    ]),
  ).toEqual([
    ["user:operator", null],
    ["assistant:assistant", "toolUse"],
    ["tool:user", "bash"],
    ["tool:user", "read"],
    ["assistant:assistant", "stop"],
    ["compaction", null],
    ["user:operator", null],
    ["assistant:assistant", "stop"],
    ["user:agent", null],
    ["assistant:assistant", "stop"],
    ["compaction-notice", null],
    ["user:operator", null],
    ["assistant:assistant", "stop"],
    ["user:operator", null],
    ["assistant:assistant", "toolUse"],
    ["tool:user", "bash"],
    ["assistant:assistant", "aborted"],
  ]);
  expect(durable[2]!.result).toBe("one\ntwo\nthree\n");
  expect(durable[1]!.has_thinking).toBe(true);
  expect(durable[1]!.usage).toMatchObject({ input: 2, cacheRead: 1388 });
  expect(String(durable[5]!.text)).toStartWith("## Goal");
  expect(durable[5]!.offset).toBe(27);
  expect(durable[10]).toMatchObject({
    text: "Context compacted at 2k tokens.",
    meta: { summaryEntryId: "27" },
  });
});

test("live documents show the partial answer, running tool output, and Compacting", async () => {
  const last = async (state: LiveState, bound: number) =>
    ((await page(new DurableRows("c1"), {}, bound, state)).blocks as Rec[]).at(
      -1,
    )!;
  expect(await last(live.thinking!, 9)).toMatchObject({
    role: "assistant",
    live: true,
    text: "",
  });
  expect(
    (await last(live.thinking!, 9)).thinking_elapsed_ms,
  ).toBeGreaterThanOrEqual(0);
  const tool = (
    (await page(new DurableRows("c1"), {}, 13, live.tool!)).blocks as Rec[]
  ).find((b) => b.name === "bash")!;
  expect(tool).toMatchObject({ running: true, result: "one\ntwo\n" });
  expect(await last(live.streaming!, 17)).toMatchObject({
    live: true,
    text: 'The bash command printed "one',
  });
  expect(await last(live.compacting!, 26)).toMatchObject({
    kind: "marker",
    text: "Compacting…",
    live: true,
  });
});

test("queued input is a pending row named by its request id, without its stamp", () => {
  const { inbox } = recorded.live.queued as { inbox: InboxState };
  expect(pendingRows(inbox, new Map([["11", "op:operator::second"]]))).toEqual([
    {
      id: "op:operator::second",
      role: "user",
      origin: "operator",
      content: "Also tell me how many lines notes.txt has.",
    },
  ]);
});

test("an interrupted provider entry without text gains no fabricated reply", async () => {
  const entry = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/durable_rows/interrupted-empty.json"),
      "utf8",
    ),
  ) as EntryRecord;
  const view = await new DurableRows("interrupted").page(
    conversation(Infinity, [], [entry]),
    {} as never,
    undefined,
    {},
    { limit: 100 },
  );
  expect(
    (view.blocks as Rec[]).filter(
      (row) => row.role === "assistant" && row.text,
    ),
  ).toEqual([]);
});

test("an interrupted provider reply keeps exactly its recorded partial text", async () => {
  const entry = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/durable_rows/interrupted-partial.json"),
      "utf8",
    ),
  ) as EntryRecord;
  const view = await new DurableRows("interrupted-partial").page(
    conversation(Infinity, [], [entry]),
    {} as never,
    undefined,
    {},
    { limit: 100 },
  );
  expect(
    (view.blocks as Rec[])
      .filter((row) => row.role === "assistant")
      .map((row) => row.text),
  ).toEqual([
    "1. Trees give us oxygen.\n2. Oak trees can live for hundreds of years.\n3. Pine trees keep their needles all winter.\n4. Maple trees turn red in autumn.\n5. Birch bark peels in thin layers.\n6. Willows often grow near water.\n7. Redwoods are among the tallest trees on Earth.\n8.",
  ]);
});

test("a recorded agent steer retains its provenance while awaiting a boundary", () => {
  const inbox = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/durable_rows/queued-agent.json"),
      "utf8",
    ),
  ) as InboxState;
  expect(pendingRows(inbox, new Map())).toEqual([
    {
      id: "durable-19",
      role: "user",
      origin: "agent",
      from: "def456def456",
      from_name: "Reporting child",
      content:
        "(turn started by your message)\nCHILD_REPORT: the requested checks passed.",
      steer: true,
    },
  ]);
});

test("older pages follow the entries() cursor past the compaction", async () => {
  const rows = new DurableRows("c1", 4);
  const read = (options: Rec) =>
    rows.page(
      conversation(),
      {} as never,
      undefined,
      {},
      {
        limit: 3,
        ...options,
      },
    );
  const shown = new Map<unknown, Rec>();
  const sorted = () =>
    [...shown.values()].sort((a, b) => Number(a.order) - Number(b.order));
  let served = await read({});
  for (let n = 0; n < 20; n += 1) {
    for (const block of served.blocks as Rec[]) shown.set(block.id, block);
    if (!served.older) break;
    served = await read({ before: sorted()[0]!.id });
  }
  const whole = (await page(new DurableRows("c1"))).blocks as Rec[];
  expect(sorted().map((b) => b.id)).toEqual(whole.map((b) => b.id));
  expect(whole[5]).toMatchObject({ role: "compaction", offset: 27 });
});

test("a reader fetches only rows that changed since its revision", async () => {
  const rows = new DurableRows("c1");
  const first = await page(rows, {}, 22);
  const rest = await page(rows, {
    since: first.revision,
    instance: first.instance_id,
  });
  expect(rest.reset).toBe(false);
  expect(rest.revision).toBeGreaterThan(first.revision as number);
  expect((rest.blocks as Rec[]).map((b) => b.id)).toContain("41");
  expect((rest.blocks as Rec[]).map((b) => b.id)).not.toContain("7");
  const stale = await page(rows, { since: 3, instance: "another" });
  expect((stale.blocks as Rec[]).length).toBe(17);
});

// Regression: #2139 lost task error was demoted to a retry notice
test("a lost task's error row stays an error when a later reply follows in its turn", async () => {
  const lost = {
    id: 11,
    kind: "recurse.task-failure",
    conversationId: recorded.entries[0]!.conversationId,
    data: {
      text: "The compaction could not finish; retry with /compact.\n\nrequest timeout",
      at: 0,
    },
  } as unknown as EntryRecord;
  const entries = [...recorded.entries, lost].sort((a, b) => a.id - b.id);
  const blocks = (
    await new DurableRows("c1", 100).page(
      conversation(Infinity, [], entries),
      {} as never,
      undefined,
      {},
      { limit: 100 },
    )
  ).blocks as Rec[];
  const row = blocks.find((b) => b.id === "11")!;
  expect([row.kind, row.role, row.error]).toEqual([
    "text",
    "assistant",
    "The compaction could not finish; retry with /compact.",
  ]);
  expect(String(row.error_detail)).toContain("request timeout");
  expect(
    blocks.some(
      (b) => b.role === "assistant" && Number(b.order) > Number(row.order),
    ),
  ).toBe(true);
});
