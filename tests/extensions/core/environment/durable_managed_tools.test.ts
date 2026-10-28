import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import { FffWorker } from "../../../../src/extensions/extra/fff/fff_worker.ts";
import { readDownload } from "../../../../src/agents/runtime/attachments/preview.ts";
import { tmpdir } from "node:os";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxHost } from "../../../backend/fixtures/durable_host/host.ts";
import { buildConversationsApp } from "../../../backend/http_conversations_app.ts";
import { registerFile } from "../../../../src/agents/runtime/attachments/publish.ts";
import { lookupByCall } from "../../../../src/agents/runtime/attachments/published.ts";
import { readThemeSettings, themePalettes } from "../../../../src/themes.ts";
import { Config } from "../../../../src/config.ts";

type Rec = Record<string, any>;
test("host tools match Pi results; later calls and restart use committed cwd/env", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-managed-"));
  const { host, faux, work, records } = fauxHost(root);
  const target = join(work, "target");
  const collection = join(root, "conversations", "c1", "files");
  await mkdir(target);
  await mkdir(collection, { recursive: true, mode: 0o700 });
  await writeFile(join(target, "fixture.txt"), "managed needle\n");
  await writeFile(join(target, "legacy.txt"), "legacy publication\n");
  const palette = themePalettes[0]!;
  await writeFile(
    join(target, "palette.ghostty"),
    [
      `background = ${palette.background}`,
      `foreground = ${palette.foreground}`,
      ...palette.palette.map((colour, index) => `palette = ${index}=${colour}`),
    ].join("\n"),
  );
  const calls = [["chdir", { directory: "target" }]] as const;
  const recorded = JSON.parse(
    (
      await readFile(
        new URL(
          "./fixtures/durable_managed_tools/pi-tools.json",
          import.meta.url,
        ),
        "utf8",
      )
    ).replaceAll("<ROOT>", root),
  ) as { expected: Rec[]; tools: Rec[] };
  const expected = recorded.expected;
  let observed: Rec[] = [];
  let followup: Rec[] = [];
  const laterCalls = [
    ["bash", { command: 'printf \'%s:%s\' "$PWD" "$DURABLE_PARITY"' }, "bash"],
    ["grep", { pattern: "needle", path: "fixture.txt" }, "grep"],
    [
      "bash",
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`import { registerFile } from ${JSON.stringify(new URL("../../../../src/agents/runtime/attachments/publish.ts", import.meta.url).pathname)}; await registerFile(process.env.RECURSE_COLLECTION_DIR, process.env.RECURSE_AGENT_ID, process.env.RECURSE_RUN_ID, process.env.RECURSE_TOOL_CALL_ID, "legacy.txt", process.cwd(), { manyPerCall: true });`)} # tools/publish.ts`,
      },
      "legacy-publish",
    ],
    ["publish", { paths: ["fixture.txt"] }, "publish"],
    ["recurse_settings", { action: "levels" }, "levels"],
    [
      "recurse_settings",
      {
        action: "share_link",
        conversations: ["child", "c1", "other", "child", "side"],
      },
      "share-link",
    ],
    [
      "recurse_settings",
      { action: "share_link", conversations: ["missing"] },
      "share-missing",
    ],
    [
      "recurse_settings",
      { action: "share_link", conversations: ["c1@remote"] },
      "share-remote",
    ],
    ["recurse_settings", { action: "themes" }, "themes"],
    [
      "recurse_settings",
      { action: "add_theme", name: "Imported", path: "palette.ghostty" },
      "add-theme",
    ],
    [
      "recurse_settings",
      { action: "select_theme", name: "Imported" },
      "select-theme",
    ],
    [
      "recurse_settings",
      { action: "remove_theme", name: "Imported" },
      "remove-theme",
    ],
    [
      "recurse_settings",
      { action: "set_level", level: 3, model: "faux/faux-1", reasoning: "off" },
      "set-level",
    ],
  ] as const;
  records.child = { id: "child", parent: "c1" };
  records.other = { id: "other" };
  records.side = { id: "side", side_of: "child" };
  faux.setResponses([
    fauxAssistantMessage(
      calls.map(([name, args], index) =>
        fauxToolCall(name, args, { id: `call-${index}` }),
      ),
      { stopReason: "toolUse" },
    ),
    (request) => {
      observed = request.messages.filter(
        (message) => message.role === "toolResult",
      ) as Rec[];
      return fauxAssistantMessage(
        laterCalls.map(([name, args, id]) => fauxToolCall(name, args, { id })),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      followup = request.messages.filter(
        (message) => message.role === "toolResult",
      ) as Rec[];
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  try {
    const opened = await host.open("c1");
    await opened.conversation.configure(
      {
        modelTools: {
          add: [
            (await opened.conversation.agent(context)).callable.find(
              (tool) => tool.name === "recurse_settings",
            )!,
          ],
        },
      },
      context,
    );
    const safety = await import(
      new URL(
        "../../../../src/extensions/core/safety/durable.ts",
        import.meta.url,
      ).href
    );
    await safety.setSafetyReviewOff(opened.conversation, true, context);
    await host.changeEnvironment("c1", {
      set: { DURABLE_PARITY: "quoted ' value" },
      unset: [],
    });
    await host.send("c1", "exercise tools", "parity");
    await opened.conversation.waitForIdle(context);
    expect(
      observed.map((result) => {
        const { recurseToolTiming, ...details } = result.details;
        expect(recurseToolTiming.version).toBe(1);
        expect(recurseToolTiming.totalMs).toBeGreaterThanOrEqual(0);
        return { content: result.content, details };
      }),
    ).toEqual(
      expected.map((result) => ({
        content: result.content,
        details: result.details,
      })),
    );
    expect(
      followup.find((result) => result.toolCallId === "bash")!.content[0].text,
    ).toContain(`${target}:quoted ' value`);
    expect(
      followup.find((result) => result.toolCallId === "grep")!.content[0].text,
    ).toContain("managed needle");
    const tools = ((await host.view("c1")).blocks as Rec[]).filter(
      (block) => block.kind === "tool_call",
    );
    expect(
      followup.find((result) => result.toolCallId === "publish")!.content[0]
        .text,
    ).toContain("Published fixture.txt (15 bytes).");
    expect(tools).toHaveLength(calls.length + laterCalls.length);
    const shared = followup.find(
      (result) => result.toolCallId === "share-link",
    )!;
    expect(shared.isError).not.toBe(true);
    expect(JSON.parse(shared.content[0].text)).toEqual({
      url: "#trees=c1,other",
      note: "Append this fragment to this instance's public URL; existing sign-in is required.",
    });
    for (const id of ["share-missing", "share-remote"]) {
      expect(followup.find((result) => result.toolCallId === id)!.isError).toBe(
        true,
      );
    }
    const settings = new Config({
      env: { ...process.env, CHAT_DATA_DIR: root },
    });
    expect(settings.effortLevels()[3]).toEqual({
      model: "faux/faux-1",
      reasoning: "off",
    });
    expect(
      (await readThemeSettings(settings.paths.THEMES_FILE)).custom,
    ).toEqual([]);
    const selected = followup.find(
      (result) => result.toolCallId === "select-theme",
    )!;
    expect(selected.isError).not.toBe(true);
    expect(JSON.parse(selected.content[0].text).theme).toBe("Imported");
    expect(
      JSON.parse(
        followup.find((result) => result.toolCallId === "levels")!.content[0]
          .text,
      ).default_level,
    ).toBeNumber();
    const published = tools.find((block) => block.id.endsWith("#publish"))!;
    expect(published.id).toEndWith("#publish");
    expect(published.files.map((file: Rec) => file.name)).toEqual([
      "fixture.txt",
    ]);
    const legacy = tools.find((block) => block.id.endsWith("#legacy-publish"))!;
    expect(legacy.files.map((file: Rec) => file.name)).toEqual(["legacy.txt"]);
    for (const [index, block] of tools.entries()) {
      const detail = await host.toolDetails("c1", block.artifact_id);
      expect(detail!.status).toBe(
        /#share-(missing|remote)$/.test(block.id) ? "error" : "finished",
      );
      expect((detail!.input as Rec).payload.value).toEqual(
        [...calls, ...laterCalls][index]![1],
      );
      expect((detail!.result as Rec).payload.value.content).toBeDefined();
    }
    const server = await buildConversationsApp(join(root, "http"), {
      patch: (deps) => {
        Object.assign(deps, { durable: host });
        deps.store.load = (cid) => records[cid] ?? null;
      },
    });
    try {
      const url = `http://127.0.0.1:${server.running.port}/api/conversations/c1/tool-details/${tools[0]!.artifact_id}`;
      const detail = await fetch(url);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as Rec).input.payload.value).toEqual(
        calls[0][1],
      );
      const events = await fetch(`${url}/events?cursor=0&limit=1`);
      expect(((await events.json()) as Rec).events).toHaveLength(1);
      const raw = await fetch(`${url}/raw`);
      expect(raw.headers.get("content-type")).toBe("application/x-ndjson");
      expect(
        (await raw.text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toHaveLength(2);
      expect((await fetch(url.replace("c1/tool", "absent/tool"))).status).toBe(
        404,
      );
      expect(
        (
          await fetch(url, {
            headers: { Authorization: "Bearer recurse_alpha_alpha-secret" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await server.running.close();
    }
    expect(await host.toolDetails("c1", "d-999999")).toBeNull();
    expect(await lookupByCall(collection, "c1", "publish")).not.toBeNull();
    expect(await lookupByCall(collection, "other-owner", "publish")).toBeNull();
    await host.close();
    const resumed = fauxHost(root);
    resumed.records.c1 = records.c1!;
    let resumedOutput = "";
    resumed.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", laterCalls[0][1], { id: "resumed" })],
        { stopReason: "toolUse" },
      ),
      (request) => {
        resumedOutput = JSON.stringify(request.messages.at(-1));
        return fauxAssistantMessage([fauxText("resumed")]);
      },
    ]);
    try {
      await resumed.host.send("c1", "after restart", "restart");
      await (await resumed.host.open("c1")).conversation.waitForIdle(context);
      expect(resumedOutput).toContain(`${target}:quoted ' value`);
      const resumedPublish = (
        (await resumed.host.view("c1")).blocks as Rec[]
      ).find(
        (block) => block.kind === "tool_call" && block.id.endsWith("#publish"),
      )!;
      expect(resumedPublish.files.map((file: Rec) => file.name)).toEqual([
        "fixture.txt",
      ]);
      const resumedLegacy = (
        (await resumed.host.view("c1")).blocks as Rec[]
      ).find((block) => block.id.endsWith("#legacy-publish"))!;
      expect(resumedLegacy.files.map((file: Rec) => file.name)).toEqual([
        "legacy.txt",
      ]);
    } finally {
      await resumed.host.close();
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Feature: #2502 clear coverage waits for the full rotation to settle.
test("clear salts tool details; a failed fresh open drains its search connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-clear-tools-"));
  const { host, faux, work } = fauxHost(root);
  const collection = join(root, "conversations", "c1", "files");
  await mkdir(collection, { recursive: true, mode: 0o700 });
  const connections: Awaited<ReturnType<FffWorker["open"]>>[] = [];
  const openSearch = FffWorker.prototype.open;
  // test-check-allow: T3 Records real search connections to prove native close.
  const search = spyOn(FffWorker.prototype, "open").mockImplementation(
    async function (this: FffWorker, ...args) {
      const bundle = await openSearch.apply(this, args);
      connections.push(bundle);
      return bundle;
    },
  );
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  };
  const publish = async (bytes: string, id: string) => {
    await writeFile(join(work, "result.txt"), bytes);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("publish", { paths: ["result.txt"] }, { id }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const opened = await host.open("c1");
    const safety = await import(
      new URL(
        "../../../../src/extensions/core/safety/durable.ts",
        import.meta.url,
      ).href
    );
    await safety.setSafetyReviewOff(opened.conversation, true, context);
    await host.send("c1", "publish", "publish");
    await opened.conversation.waitForIdle(context);
    return ((await host.view("c1")).blocks as Rec[]).find((row) =>
      String(row.id).endsWith(`#${id}`),
    )!;
  };
  try {
    const first = await publish("FIRST", "first-publish");
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    // test-check-allow: T3 Failed open must close the real search connection.
    const failOpen = spyOn(Harness, "open").mockImplementationOnce(async () => {
      await failureGate;
      throw new Error("injected fresh-open failure");
    });
    try {
      await host.clear("c1");
      await until(() => connections.length === 2);
      const rotation = host.open("c1");
      releaseFailure();
      await expect(rotation).rejects.toThrow("injected fresh-open failure");
      const grep = connections[1]!.definitions.find(
        (tool) => tool.name === "grep",
      )!;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          await grep.execute(
            "closed",
            { pattern: "needle", path: "result.txt" },
            undefined,
            undefined,
            { cwd: work } as ExtensionToolContext,
          );
        } catch (error) {
          if (String(error).includes("Search connection closed")) break;
          throw error;
        }
        if (Date.now() > deadline)
          throw new Error("search connection did not close");
        await Bun.sleep(10);
      }
      await expect(
        grep.execute(
          "closed",
          { pattern: "needle", path: "result.txt" },
          undefined,
          undefined,
          { cwd: work } as ExtensionToolContext,
        ),
      ).rejects.toThrow("Search connection closed");
    } finally {
      releaseFailure();
      failOpen.mockRestore();
    }
    const second = await publish("SECOND", "second-publish");
    expect(second.artifact_id).not.toBe(first.artifact_id);
    expect(second.files).toHaveLength(1);
    expect(second.files[0].id).not.toBe(first.files[0].id);
    expect(await host.toolDetails("c1", first.artifact_id)).toBeNull();
    const [, bytes] = await readDownload(collection, "c1", second.files[0].id);
    expect(new TextDecoder().decode(bytes)).toBe("SECOND");
  } finally {
    search.mockRestore();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a publish_attachment row recorded before the tool was retired keeps its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-old-publish-"));
  const { host, faux, work } = fauxHost(root);
  const collection = join(root, "conversations", "c1", "files");
  await mkdir(collection, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "old.txt"), "OLD");
  await registerFile(
    collection,
    "c1",
    "b".repeat(32),
    "old-call",
    "old.txt",
    work,
  );
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "publish_attachment",
        { path: "old.txt" },
        { id: "old-call" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  try {
    const opened = await host.open("c1");
    const safety = await import(
      new URL(
        "../../../../src/extensions/core/safety/durable.ts",
        import.meta.url,
      ).href
    );
    await safety.setSafetyReviewOff(opened.conversation, true, context);
    await host.send("c1", "publish", "publish");
    await opened.conversation.waitForIdle(context);
    const row = ((await host.view("c1")).blocks as Rec[]).find((block) =>
      String(block.id).endsWith("#old-call"),
    )!;
    expect(row.name).toBe("publish_attachment");
    expect(row.attachment.name).toBe("old.txt");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
