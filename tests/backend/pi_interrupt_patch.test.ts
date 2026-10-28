import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteWorker,
  openWorkerSqliteStorage,
} from "../../src/agents/durable/sqlite_worker.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for Pi boundary");
    await Bun.sleep(5);
  }
}
const signature = JSON.stringify({
  type: "reasoning",
  id: "rs_fixture",
  summary: [{ type: "summary_text", text: "signed thought" }],
  encrypted_content: "opaque",
});

async function fixture(
  api = "anthropic-messages",
  signed = false,
  root?: string,
) {
  const faux = fauxProvider({
    api,
    provider: "fixture",
    tokensPerSecond: 500,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  const original = faux.provider.streamSimple;
  const provider = {
    ...faux.provider,
    streamSimple: (...args: Parameters<typeof original>) => {
      const stream = new AssistantMessageEventStream();
      const source = original(...args);
      void (async () => {
        for await (const event of source) {
          if (signed && event.type === "thinking_end") {
            const block = event.partial.content[event.contentIndex];
            if (block.type === "thinking")
              block.thinkingSignature =
                api === "anthropic-messages" ? "signed-complete" : signature;
          }
          stream.push(event);
        }
        stream.end(await source.result());
      })();
      return stream;
    },
  };
  models.setProvider(provider);
  const seen: Context[] = [];
  const registry = createRegistry();
  let tools = 0;
  let release = () => {};
  let started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.install(
    defineExtension({
      name: "fixture",
      tools: [
        defineTool({
          name: "probe",
          description: "boundary probe",
          parameters: Type.Object({ text: Type.String() }),
          execute: async () => {
            tools++;
            started = true;
            await gate;
            return { output: [{ type: "text", text: "tool finished" }] };
          },
        }),
      ],
    }),
  );
  const worker = root ? new SqliteWorker() : undefined;
  const storage = worker
    ? await openWorkerSqliteStorage(worker, join(root!, "session.sqlite"))
    : new MemoryStorage();
  const options = {
    models,
    registry,
    settings: {
      compaction: { enabled: false },
      progress: { partialIntervalMs: 1 },
      steeringMode: "all" as const,
    },
  };
  const harness = await Harness.open(storage, options, context);
  const conversation = await harness.root(context, {
    agent: {
      model: {
        provider: faux.getModel().provider,
        modelId: faux.getModel().id,
      },
    },
  });
  const capture = (request: Context) => {
    seen.push(structuredClone(request));
    return fauxAssistantMessage("continued");
  };
  return {
    faux,
    seen,
    harness,
    conversation,
    model: faux.getModel(),
    capture,
    get tools() {
      return tools;
    },
    get started() {
      return started;
    },
    release,
    async partial(check: (message: AssistantMessage) => boolean) {
      let message: AssistantMessage | undefined;
      await until(async () => {
        message = (await harness.snapshot(LiveDoc, conversation.id, context))
          ?.generation?.message;
        return !!message && check(message);
      });
      return structuredClone(message!);
    },
    async close() {
      release();
      await harness.close(context);
      await worker?.close();
      if (root) await rm(root, { recursive: true, force: true });
    },
  };
}

if (process.env.PI_INTERRUPT_CRASH_ROOT) {
  const f = await fixture(
    "anthropic-messages",
    false,
    process.env.PI_INTERRUPT_CRASH_ROOT,
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxText("partial before crash ".repeat(300))),
    () => {
      process.exit(77);
    },
  ]);
  await f.conversation.submit({ type: "input", content: "first" }, context);
  await f.partial((message) =>
    message.content.some(
      (block) => block.type === "text" && block.text.length > 8,
    ),
  );
  await f.conversation.submit(
    { type: "input", content: "operator before crash", whenBusy: "interrupt" },
    context,
  );
  await f.conversation.waitForIdle(context);
  throw new Error("Crash fixture failed to exit at the request boundary");
}

describe("Pi interrupt patch", () => {
  test("abrupt crash after cut before next commit preserves context and inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-interrupt-crash-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, PI_INTERRUPT_CRASH_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(77);
    await output;
    const f = await fixture("anthropic-messages", false, root);
    try {
      f.faux.setResponses([f.capture]);
      f.harness.resume();
      await f.conversation.waitForIdle(context);
      const request = f.seen[0].messages.filter(
        (message) => message.role !== "system",
      );
      expect(request.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(JSON.stringify(request)).toContain("interrupted");
      expect(JSON.stringify(request)).toContain("operator before crash");
      expect(JSON.stringify(request)).toContain("partial");
      const entries = await f.conversation.entries({}, 100, undefined, context);
      expect(
        entries.items.filter((entry) => entry.kind === "pi.assistant"),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
});
