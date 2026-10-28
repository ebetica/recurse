import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { liveModel } from "../live_e2e_helpers.ts";

const source = process.env.PI_CODING_AGENT_DIR;
if (!source) throw new Error("PI_CODING_AGENT_DIR is required");
const credential = JSON.parse(
  await readFile(join(source, "auth.json"), "utf8"),
).anthropic;
if (credential?.type === "oauth" && !(credential.expires > Date.now() + 3.6e6))
  throw new Error("the anthropic OAuth credential has less than one hour left");
const model = liveModel("anthropic").route;
const root = await mkdtemp(join(tmpdir(), "durable-rows-record-"));
try {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => credential);
  const models = createModels({ credentials });
  models.setProvider(anthropicProvider());
  await writeFile(join(root, "notes.txt"), "alpha\nbeta\n");
  const registry = createRegistry();
  registry.install(CodingTools);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: root }),
      settings: {
        progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
        compaction: { keepRecentTokens: 100 },
      },
    },
    BG,
  );
  const conversation = await harness.root(BG, {
    agent: {
      model,
      thinkingLevel: "medium",
      cwd: root,
    },
  });
  const live: Record<string, unknown> = {};
  const seen = async () => {
    const doc = await harness.snapshot(LiveDoc, conversation.id, BG);
    const inbox = await harness.snapshot(InboxDoc, conversation.id, BG);
    const message = doc?.generation?.message as
      | { content?: Array<{ type: string }> }
      | undefined;
    const types = (message?.content ?? []).map((part) => part.type);
    if (types.includes("thinking") && !types.includes("text"))
      live.thinking ??= doc;
    if (types.includes("text")) live.streaming ??= doc;
    if (doc?.tools?.some((slot) => slot.status === "running" && slot.output))
      live.tool ??= doc;
    if (doc?.compactions?.length) live.compacting ??= doc;
    if (inbox?.items.length) live.queued ??= { live: doc, inbox: inbox };
  };
  harness.subscribeCommits(() => queueMicrotask(() => void seen()));
  const say = (content: string, requestId: string) =>
    conversation.submit(
      { type: "input", content, requestId, whenBusy: "followUp" },
      BG,
    );
  const first = await say(
    "## Message\n[recurse-origin: operator]\nRun `printf 'one\\ntwo\\n'; sleep 2; echo three` with bash, then read notes.txt, then answer in one sentence.",
    "op:operator::first",
  );
  await Bun.sleep(1500);
  const queued = await say(
    "## Message\n[recurse-origin: operator]\nAlso tell me how many lines notes.txt has.",
    "op:operator::second",
  );
  await first.wait(BG);
  await queued.wait(BG);
  await (
    await say(
      "[recurse-origin: agent]\n[recurse-from: kid123]\n[recurse-from-name: Kid]\nChild report: tests pass. Reply with one word.",
      "op:agent:kid123:third",
    )
  ).wait(BG);
  await harness.waitForTask(await conversation.compact(undefined, BG), BG);
  await (
    await say(
      "## Message\n[recurse-origin: operator]\nSay hello in five words.",
      "op:operator::fourth",
    )
  ).wait(BG);
  const stopped = await say(
    "## Message\n[recurse-origin: operator]\nCount from 1 to 300, one number per line.",
    "op:operator::fifth",
  );
  for (;;) {
    const doc = await harness.snapshot(LiveDoc, conversation.id, BG);
    const text = JSON.stringify(doc?.generation?.message ?? "");
    if (text.includes("\\n5")) {
      await harness.abortTask(doc!.run!.taskId, BG);
      break;
    }
    await Bun.sleep(50);
  }
  await stopped.wait(BG);
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await conversation.entries({}, 100, cursor, BG);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  entries.reverse();
  await harness.close(BG);
  const text = JSON.stringify({ entries, live }, null, 1);
  process.stdout.write(text.replaceAll(root, "/work") + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
