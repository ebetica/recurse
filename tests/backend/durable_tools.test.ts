import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
  type ToolCall,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import {
  createReadTool as createPiReadTool,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineExtension,
  Harness,
  LiveDoc,
  MemoryStorage,
  type Conversation,
  type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  CodingTools,
  createCodingTools,
  DEFAULT_IMAGE_LIMITS,
} from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { randomFillSync } from "node:crypto";
import { createFffExtension as createWorkerExtension } from "../../src/extensions/extra/fff/fff.ts";
import {
  loadFffTools,
  type FffFlags,
} from "../../src/extensions/extra/fff/fff_tools.ts";
import { FffWorker } from "../../src/extensions/extra/fff/fff_worker.ts";
import { adaptPiTool } from "../../src/extensions/extra/fff/pi_tool_adapter.ts";
import { trimSearchResult } from "../../src/extensions/core/context/search-results.ts";
import {
  projectionEntries,
  rowState,
} from "../../src/agents/durable/durable_rows.ts";
import { ConversationView } from "../../src/agents/view/conversation.ts";

const images = createNodePhotonImages();
const imageTools = async () => createCodingTools({ images: await images });
const searchWorker = new FffWorker();
afterAll(() => searchWorker.close());

async function createFffExtension(cwd: string, flags: FffFlags) {
  const previous = process.env.PI_FFF_MULTIGREP;
  process.env.PI_FFF_MULTIGREP = "1";
  let native: Awaited<ReturnType<typeof loadFffTools>>;
  try {
    native = await loadFffTools(cwd, flags);
  } finally {
    if (previous === undefined) delete process.env.PI_FFF_MULTIGREP;
    else process.env.PI_FFF_MULTIGREP = previous;
  }
  try {
    const durable = await createWorkerExtension(searchWorker, cwd, flags);
    return {
      ...durable,
      durableNames: durable.definitions.map((tool) => tool.name).sort(),
      definitions: native.definitions,
      async close() {
        try {
          await durable.close();
        } finally {
          await native.close();
        }
      },
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}

test(
  "a failed native database falls back to working search and closes its finder",
  () =>
    fixture(async (cwd) => {
      await writeFile(path.join(cwd, "sample.txt"), "needle in real file\n");
      const sharedDb = path.join(cwd, "conflicting-db");
      await mkdir(sharedDb);
      const { loadSdk } = (await import(
        import.meta.resolve("@ff-labs/pi-fff/src/sdk.ts")
      )) as {
        loadSdk(): Promise<{
          FileFinder: {
            create(options: unknown): {
              ok: boolean;
              value?: { isDestroyed: boolean; destroy(): void };
            };
          };
        }>;
      };
      const { FileFinder } = await loadSdk();
      // test-check-allow: T3 Call-through observes real fallback handle destruction.
      const create = spyOn(FileFinder, "create");
      const fff = await createFffExtension(cwd, {
        "fff-frecency-db": sharedDb,
        "fff-history-db": sharedDb,
      });
      try {
        const call = {
          name: "grep",
          args: { pattern: "needle", path: "sample.txt" },
        };
        const original = await fff.definitions
          .find((tool) => tool.name === "grep")!
          .execute("pi", call.args, undefined, undefined, {
            cwd,
          } as ExtensionToolContext);
        const [result] = await callTools(cwd, [fff.extension], [call]);
        expect(result!.isError).toBe(false);
        expect(result!.content).toEqual(original.content);
        expect(result!.details).toEqual(original.details);
        await fff.close();
        const results = create.mock.results
          .filter((result) => result.type === "return")
          .map(
            (result) => result.value as ReturnType<typeof FileFinder.create>,
          );
        expect(results.some((result) => !result.ok)).toBe(true);
        const handles = results.flatMap((result) =>
          result.ok && result.value ? [result.value] : [],
        );
        expect(handles.length).toBeGreaterThan(0);
        expect(handles.every((handle) => handle.isDestroyed)).toBe(true);
      } finally {
        await fff.close();
        for (const result of create.mock.results) {
          if (result.type !== "return") continue;
          const native = result.value as ReturnType<typeof FileFinder.create>;
          if (native.ok) native.value?.destroy();
        }
        create.mockRestore();
      }
    }),
  60000,
);

type Call = { name: string; args: ToolCall["arguments"] };

async function callTools(
  cwd: string,
  extensions: Extension[],
  calls: Call[],
  onLive?: (harness: Harness, conversation: Conversation) => Promise<void>,
  onSettled?: (conversation: Conversation) => Promise<void>,
) {
  const faux = fauxProvider({ models: [{ id: "faux" }] });
  const results: ToolResultMessage[] = [];
  faux.setResponses(
    calls.flatMap((call, index) => [
      fauxAssistantMessage(
        fauxToolCall(call.name, call.args, { id: `call-${index}` }),
        { stopReason: "toolUse" },
      ),
      (request: ModelContext) => {
        const result = request.messages
          .filter((message) => message.role === "toolResult")
          .at(-1);
        if (result?.role !== "toolResult")
          throw new Error("Expected a tool result");
        results.push(result);
        return fauxAssistantMessage(fauxText("ok"));
      },
    ]),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  extensions.forEach((extension) => registry.install(extension));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false },
        progress: { outputIntervalMs: 1 },
      },
      env: () => new NodeExecutionEnv({ cwd }),
    },
    context,
  );
  try {
    const model = faux.getModel();
    const conversation = await harness.root(context, {
      agent: { cwd, model: { provider: model.provider, modelId: model.id } },
    });
    for (const [index] of calls.entries()) {
      const submission = await conversation.submit(
        { type: "input", content: `call ${index}` },
        context,
      );
      await onLive?.(harness, conversation);
      expect((await submission.wait(context)).status).toBe("done");
      await onSettled?.(conversation);
    }
  } finally {
    await harness.close(context);
  }
  return results;
}

function png(width: number, height: number, noisy = false): Uint8Array {
  const concat = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, data.length);
    const body = concat(new TextEncoder().encode(type), data);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, Bun.hash.crc32(body));
    return concat(size, body, crc);
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array((width * 3 + 1) * height).fill(0x80);
  if (noisy) randomFillSync(rows);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(zlib.deflateSync(rows))),
    chunk("IEND", new Uint8Array()),
  );
}

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "durable-tools-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Regression: #2341 Durable read diagnostics leaked harness tags into tool rows.
test("Durable read diagnostics are plain text in the view, not model content", () =>
  fixture(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "first\nsecond\nthird\n");
    await writeFile(path.join(cwd, "pixel.png"), png(1, 1));
    let imageText: unknown;
    const results = await callTools(
      cwd,
      [await imageTools()],
      [
        { name: "read", args: { path: "note.txt", limit: 1 } },
        { name: "read", args: { path: "pixel.png" } },
      ],
      undefined,
      async (conversation) => {
        const records = await conversation.entries({}, 100, undefined, context);
        const view = new ConversationView("diagnostics", "test");
        view.ingest(
          projectionEntries([...records.items].reverse(), rowState()),
        );
        const rows = view
          .window()
          .blocks.filter((row) => row.kind === "tool_call");
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.result).toContain("more lines");
        for (const row of rows) {
          expect(row.result).not.toContain("<harness>");
          expect(row.result).not.toContain("[info]");
        }
        imageText = rows.at(-1)!.result;
      },
    );
    expect(imageText).toContain("Read image file");
    expect(JSON.stringify(results[0]!.content)).toContain("<harness>");
  }));

test("Durable display preserves harness text authored in a file", () =>
  fixture(async (cwd) => {
    const authored = "<harness>\n[info] written by the operator\n</harness>";
    await writeFile(path.join(cwd, "authored.txt"), authored);
    await callTools(
      cwd,
      [CodingTools],
      [{ name: "read", args: { path: "authored.txt" } }],
      undefined,
      async (conversation) => {
        const records = await conversation.entries({}, 100, undefined, context);
        const view = new ConversationView("authored", "test");
        view.ingest(
          projectionEntries([...records.items].reverse(), rowState()),
        );
        expect(
          view.window().blocks.find((row) => row.kind === "tool_call")!.result,
        ).toBe(authored);
      },
    );
  }));

describe("Durable image read", () => {
  test("Photon prepares off-loop and its idle worker actually terminates", async () => {
    // test-check-allow: T3 Call-through observes the real worker termination and exit code.
    const terminate = spyOn(Worker.prototype, "terminate");
    try {
      const processor = await createNodePhotonImages({ idleMs: 1 });
      let yielded = false;
      const prepared = processor.prepare(
        png(1008, 2244),
        "image/png",
        DEFAULT_IMAGE_LIMITS,
      );
      setImmediate(() => {
        yielded = true;
      });
      expect(await prepared).toBeDefined();
      expect(yielded).toBe(true);
      while (terminate.mock.results.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const result = terminate.mock.results[0]!;
      expect(result.type).toBe("return");
      if (result.type !== "return")
        throw new Error("Worker termination failed");
      expect(typeof (await result.value)).toBe("number");
    } finally {
      terminate.mockRestore();
    }
  }, 60000);

  test("an idle default Photon worker does not keep a process alive", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
      import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
      const images = await createNodePhotonImages();
      const image = await images.prepare(Buffer.from(${JSON.stringify(Buffer.from(png(16, 8)).toString("base64"))}, "base64"), "image/png", DEFAULT_IMAGE_LIMITS);
      if (!image) throw new Error("Image preparation failed");
      console.log("prepared");
    `,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("prepared\n");
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      child.kill();
    }
  }, 10000);
  test("JPEG, GIF and WebP preserve the same inline image bytes as Pi", () =>
    fixture(async (cwd) => {
      for (const format of ["jpg", "gif", "webp"]) {
        const bytes = await readFile(
          new URL(`./fixtures/durable_images/pixel.${format}`, import.meta.url),
        );
        await writeFile(
          path.join(cwd, `pixel.${format}`),
          new Uint8Array(bytes),
        );
        const args = { path: `pixel.${format}` };
        const pi = await createPiReadTool(cwd).execute("pi", args, undefined);
        const [result] = await callTools(
          cwd,
          [await imageTools()],
          [{ name: "read", args }],
        );
        expect(result!.isError).toBe(false);
        expect(
          result!.content.filter((block) => block.type === "image"),
        ).toEqual(pi.content.filter((block) => block.type === "image"));
        expect(
          result!.content.filter((block) => block.type === "image"),
        ).toHaveLength(1);
      }
    }));
  test(
    "BMP conversion preserves Pi's image bytes in a bare image block",
    () =>
      fixture(async (cwd) => {
        const bmp = new Uint8Array(62);
        const view = new DataView(bmp.buffer);
        bmp.set([66, 77]);
        for (const [offset, value] of [
          [2, 62],
          [10, 54],
          [14, 40],
          [18, 2],
          [22, 1],
          [34, 8],
        ])
          view.setUint32(offset!, value!, true);
        view.setUint16(26, 1, true);
        view.setUint16(28, 24, true);
        bmp.set([0, 0, 255, 0, 255, 0], 54);
        await writeFile(path.join(cwd, "colors.bmp"), bmp);
        const [result] = await callTools(
          cwd,
          [await imageTools()],
          [{ name: "read", args: { path: "colors.bmp" } }],
        );
        const pi = await createPiReadTool(cwd, {
          resizeOptions: {
            maxWidth: DEFAULT_IMAGE_LIMITS.maxWidth,
            maxHeight: DEFAULT_IMAGE_LIMITS.maxHeight,
          },
        }).execute("pi", { path: "colors.bmp" }, undefined);
        expect(result!.isError).toBe(false);
        expect(
          result!.content.filter((block) => block.type === "image"),
        ).toEqual(pi.content.filter((block) => block.type === "image"));
        expect(
          result!.content.some(
            (block) => block.type === "image" && block.mimeType === "image/png",
          ),
        ).toBe(true);
      }),
    60000,
  );
  test(
    "PNG paths preserve bytes, oversized screenshots shrink and broken images are omitted",
    () =>
      fixture(async (cwd) => {
        await writeFile(path.join(cwd, "small.png"), png(16, 8));
        await writeFile(path.join(cwd, "phone.png"), png(1008, 2244));
        await writeFile(
          path.join(cwd, "café.png".normalize("NFD")),
          png(16, 8),
        );
        await writeFile(
          path.join(cwd, "broken.png"),
          png(16, 8).subarray(0, 40),
        );
        const pi = createPiReadTool(cwd, {
          resizeOptions: {
            maxWidth: DEFAULT_IMAGE_LIMITS.maxWidth,
            maxHeight: DEFAULT_IMAGE_LIMITS.maxHeight,
          },
        });
        const calls = [
          "small.png",
          "phone.png",
          "broken.png",
          "@small.png",
          "@café.png",
        ].map((file) => ({
          name: "read",
          args: { path: file },
        }));
        const durable = await callTools(cwd, [await imageTools()], calls);
        for (const index of [0, 3, 4]) {
          const original = await pi.execute(
            `pi-${index}`,
            calls[index]!.args,
            undefined,
          );
          expect(durable[index]!.isError).toBe(false);
          expect(
            durable[index]!.content.filter((block) => block.type === "image"),
          ).toEqual(original.content.filter((block) => block.type === "image"));
        }
        expect(durable[1]!.isError).toBe(false);
        expect(durable[2]!.isError).toBe(true);
        const resized = durable[1]!.content.find(
          (block) => block.type === "image",
        );
        expect(resized?.type).toBe("image");
        if (resized?.type === "image") {
          expect(resized.mimeType).toBe("image/png");
          const bytes = Buffer.from(resized.data, "base64");
          expect(
            Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)),
          ).toBeLessThanOrEqual(2000);
          expect(resized.data.length).toBeLessThanOrEqual(
            DEFAULT_IMAGE_LIMITS.maxBytes,
          );
        }
        expect(
          durable[2]!.content.some((block) => block.type === "image"),
        ).toBe(false);
      }),
    60000,
  );

  test("a dimension-bounded PNG exceeding the byte limit is re-encoded", () =>
    fixture(async (cwd) => {
      const bytes = png(1800, 1800, true);
      expect(Buffer.from(bytes).toString("base64").length).toBeGreaterThan(
        DEFAULT_IMAGE_LIMITS.maxBytes,
      );
      await writeFile(path.join(cwd, "dense.png"), bytes);
      const [result] = await callTools(
        cwd,
        [await imageTools()],
        [{ name: "read", args: { path: "dense.png" } }],
      );
      expect(result!.isError).toBe(false);
      const blocks = result!.content.filter((block) => block.type === "image");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.data.length).toBeLessThanOrEqual(
        DEFAULT_IMAGE_LIMITS.maxBytes,
      );
      expect(blocks[0]!.mimeType).toBe("image/jpeg");
    }));

  test("text read remains Durable's read with offset/limit and errors", () =>
    fixture(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "first\nsecond\nthird\n");
      const calls: Call[] = [
        { name: "read", args: { path: "note.txt", offset: 2, limit: 1 } },
        { name: "read", args: { path: "missing" } },
      ];
      const plain = await callTools(cwd, [CodingTools], calls);
      const wrapped = await callTools(cwd, [await imageTools()], calls);
      expect(
        wrapped.map(({ content, details, isError }) => ({
          content,
          details,
          isError,
        })),
      ).toEqual(
        plain.map(({ content, details, isError }) => ({
          content,
          details,
          isError,
        })),
      );
    }));
});

test(
  "all patched pi-fff definitions keep content/details and use each call's cwd",
  () =>
    fixture(async (cwd) => {
      await mkdir(path.join(cwd, "src"));
      await writeFile(
        path.join(cwd, "src", "alpha.ts"),
        "export const Alpha = 1;\nexport const beta = Alpha;\n",
      );
      await writeFile(
        path.join(cwd, "src", "beta.ts"),
        "export const beta = 2;\n",
      );
      const other = path.join(cwd, "other");
      await mkdir(other);
      await writeFile(path.join(other, "only.txt"), "Different needle\n");
      const fff = await createFffExtension(cwd, {
        "fff-frecency-db": path.join(cwd, "frecency.sqlite"),
        "fff-history-db": path.join(cwd, "history.sqlite"),
      });
      try {
        expect(fff.definitions.map((tool) => tool.name).sort()).toEqual([
          "find",
          "grep",
          "multi_grep",
        ]);
        expect(fff.durableNames).toEqual(["find", "grep", "multi_grep"]);
        const calls: Call[] = [
          {
            name: "grep",
            args: { pattern: "Alpha", path: "src/", context: 1 },
          },
          { name: "find", args: { pattern: "alpha", path: "src/" } },
          {
            name: "multi_grep",
            args: {
              patterns: ["Alpha", "beta"],
              constraints: "src/",
              context: 1,
            },
          },
          { name: "grep", args: { pattern: ".*" } },
        ];
        for (const root of [cwd, other]) {
          const durable = await callTools(root, [fff.extension], calls);
          for (const [index, call] of calls.entries()) {
            const definition = fff.definitions.find(
              (tool) => tool.name === call.name,
            )!;
            const original = await definition.execute(
              `pi-${index}`,
              call.args,
              undefined,
              undefined,
              { cwd: root } as ExtensionToolContext,
            );
            const patch = trimSearchResult({
              type: "tool_result",
              toolName: call.name,
              toolCallId: `pi-${index}`,
              input: call.args,
              isError: false,
              ...original,
            });
            expect(durable[index]!.isError).toBe(false);
            expect(durable[index]!.content).toEqual(
              patch?.content ?? original.content,
            );
            expect(durable[index]!.details).toEqual(original.details);
          }
        }
      } finally {
        await fff.close();
      }
    }),
  60000,
);

test(
  "search cap keeps metadata on a real oversized pi-fff result",
  () =>
    fixture(async (cwd) => {
      await writeFile(
        path.join(cwd, "many.txt"),
        Array.from(
          { length: 80 },
          (_, index) => `needle ${index} ${"x".repeat(1500)}`,
        ).join("\n"),
      );
      const fff = await createFffExtension(cwd, {
        "fff-frecency-db": path.join(cwd, "f.sqlite"),
        "fff-history-db": path.join(cwd, "h.sqlite"),
      });
      try {
        const call = { name: "grep", args: { pattern: "needle", limit: 200 } };
        const original = await fff.definitions
          .find((tool) => tool.name === "grep")!
          .execute("pi", call.args, undefined, undefined, {
            cwd,
          } as ExtensionToolContext);
        const patch = trimSearchResult({
          type: "tool_result",
          toolName: "grep",
          toolCallId: "pi",
          input: call.args,
          isError: false,
          ...original,
        });
        expect(patch).toBeDefined();
        const [durable] = await callTools(cwd, [fff.extension], [call]);
        expect(durable!.content).toEqual(patch!.content!);
        expect(durable!.details).toEqual(original.details);
      } finally {
        await fff.close();
      }
    }),
  60000,
);

test(
  "Pi updates reach Durable live output/details without duplicating cumulative text",
  () =>
    fixture(async (cwd) => {
      await writeFile(path.join(cwd, "sample.txt"), "needle in real file\n");
      const fff = await createFffExtension(cwd, {
        "fff-frecency-db": path.join(cwd, "f.sqlite"),
        "fff-history-db": path.join(cwd, "h.sqlite"),
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted!: () => void;
      const updated = new Promise<void>((resolve) => {
        posted = resolve;
      });
      let expected: Awaited<
        ReturnType<(typeof fff.definitions)[number]["execute"]>
      >;
      const grep = fff.definitions.find((tool) => tool.name === "grep")!;
      const streamed = adaptPiTool({
        ...grep,
        async execute(id, args, signal, onUpdate, ctx) {
          const result = (expected = await grep.execute(
            id,
            args,
            signal,
            undefined,
            ctx,
          ));
          const text = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          onUpdate?.({
            ...result,
            content: [{ type: "text", text: text.slice(0, 4) }],
          });
          onUpdate?.(result);
          posted();
          await gate;
          return result;
        },
      });
      try {
        const [result] = await callTools(
          cwd,
          [defineExtension({ name: "streamed-search", tools: [streamed] })],
          [{ name: "grep", args: { pattern: "needle" } }],
          async (harness, conversation) => {
            try {
              await updated;
              const text = expected.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
              let slot;
              for (let attempt = 0; attempt < 100; attempt++) {
                slot = (
                  await harness.snapshot(LiveDoc, conversation.id, context)
                )?.tools?.[0];
                if (
                  slot?.output === text &&
                  JSON.stringify(slot.details) ===
                    JSON.stringify(expected.details)
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              expect(slot?.output).toBe(text);
              expect(slot?.details).toEqual(expected.details);
            } finally {
              release();
            }
          },
        );
        expect(result!.content).toEqual(expected!.content);
        expect(result!.details).toEqual(expected!.details);
      } finally {
        release();
        await fff.close();
      }
    }),
  60000,
);
