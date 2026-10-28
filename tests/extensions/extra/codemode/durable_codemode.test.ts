import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { DurableHost } from "../../../../src/agents/durable/host.ts";
import { McpServers } from "../../../../src/extensions/extra/mcp/mcp.ts";
import { mcpStatuses } from "../../../../src/extensions/extra/mcp/status.ts";
import {
  fauxHost,
  held,
  idle,
  lifecycle,
  until,
} from "../../../backend/fixtures/durable_host/host.ts";

const FIXTURE = join(
  import.meta.dir,
  "../../../backend/fixtures/mcp_probe_server.mjs",
);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
type Rec = Record<string, any>;
const RUN = crypto.randomUUID().slice(0, 8);

function setup(marker: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "durable-codemode-"));
  roots.push(root);
  const args = [
    FIXTURE,
    `--marker=${marker}-${RUN}`,
    "--stubborn",
    "--spawn-child",
  ];
  writeFileSync(
    join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: { probe: { command: process.execPath, args, env } },
    }),
  );
  return { root, ...fauxHost(root, undefined, true) };
}

function script(
  faux: ReturnType<typeof setup>["faux"],
  main: FauxResponseStep[],
  verdict = (_action: string) => "OK",
) {
  const reviews: string[] = [];
  const requests: string[] = [];
  let next = 0;
  const step: FauxResponseStep = async (request, ...rest) => {
    if (JSON.stringify(request).includes("untrusted record of a user's")) {
      const action = JSON.stringify(request.messages.at(-1)?.content);
      reviews.push(action);
      return fauxAssistantMessage(verdict(action));
    }
    requests.push(JSON.stringify(request));
    const answer = main[next++] ?? fauxAssistantMessage("done");
    return typeof answer === "function" ? answer(request, ...rest) : answer;
  };
  faux.setResponses(Array(60).fill(step));
  return { reviews, requests };
}

const codemode = (code: string) =>
  fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "cm" })], {
    stopReason: "toolUse",
  });

async function markerProcesses(marker: string): Promise<number[][]> {
  const found: number[][] = [];
  for (const name of await readdir("/proc")) {
    try {
      const cmdline = await readFile(`/proc/${name}/cmdline`, "utf8");
      if (!cmdline.includes(`--marker=${marker}-${RUN}`)) continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z") found.push([Number(name), Number(fields[2])]);
    } catch {}
  }
  return found;
}

async function ownGroup(marker: string) {
  await until(async () => (await markerProcesses(marker)).length === 2);
  const groups = new Set((await markerProcesses(marker)).map(([, g]) => g));
  const own = (await readFile("/proc/self/stat", "utf8")).split(") ")[1]!;
  expect([...groups]).toHaveLength(1);
  expect([...groups][0]).not.toBe(Number(own.split(" ")[2]));
}

async function latest(host: DurableHost, kind: string, callId?: string) {
  const view = await (await host.open("c1")).conversation.context(context);
  const entry = view.entries.findLast(
    (each) =>
      each.kind === kind &&
      (callId === undefined || (each.model![0] as Rec).toolCallId === callId),
  );
  const content = (entry?.model![0] as Rec | undefined)?.content;
  return content?.map((part: Rec) => part.text ?? "").join("") as
    | string
    | undefined;
}

describe("codemode on Durable", () => {
  // Regression: #2856 native read images must reach the next model request from scripts.
  test("read returns image blocks and text to a script", async () => {
    const { host, faux, root, work } = setup("cm-read-image");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      join(work, "pixel.png"),
      Uint8Array.from(Buffer.from(png, "base64")),
    );
    writeFileSync(join(work, "note.txt"), "read text unchanged");
    const { requests } = script(faux, [
      codemode(
        "const note = await tools.read({path:'note.txt'}); text({kind:typeof note,note}); image(await tools.read({path:'pixel.png'}));",
      ),
      fauxAssistantMessage("saw image and text"),
    ]);
    try {
      await host.send("c1", "read the text and show the PNG", "read-image");
      await until(idle(host));
      const result = await latest(host, "pi.tool-result", "cm");
      expect(result).not.toContain("TypeError");
      expect(result).toContain('"kind":"string"');
      expect(result).toContain("read text unchanged");
      const next = JSON.parse(requests[1]!);
      const content = next.messages.flatMap((message: Rec) =>
        Array.isArray(message.content) ? message.content : [],
      );
      expect(content).toContainEqual(
        expect.objectContaining({
          type: "image",
          data: png,
          mimeType: "image/png",
        }),
      );
    } finally {
      await host.close();
    }
  });

  test("only Settings servers referenced by a script start, never before the first script or while idle", async () => {
    const { host, faux, root, work } = setup("cm-lazy");
    const config = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
    const attempts = join(root, "hanging-attempts");
    config.mcpServers.invalid = { unexpected: true };
    config.mcpServers.hanging = {
      command: "/bin/sh",
      args: ["-c", `echo started > ${attempts}; sleep 60`],
    };
    writeFileSync(join(root, "mcp.json"), JSON.stringify(config));
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(work, ".pi")),
    );
    writeFileSync(
      join(work, ".pi/mcp.json"),
      JSON.stringify({
        mcpServers: { rogue: { command: process.execPath, args: [FIXTURE] } },
      }),
    );
    const first = held(
      codemode(
        "try { await tools.mcp__probe__write_note({path:'denied-live.txt',text:'x'}); } catch(error) { text(error.message); } text(await tools.mcp__probe__echo({text:'lazy'})); await tools.mcp__probe__sleep({ms:3000});",
      ),
    );
    const last = held(fauxAssistantMessage("done"));
    const { requests } = script(faux, [first.step, last.step], (action) =>
      action.includes("write_note") ? "DENY: not allowed here" : "OK",
    );
    try {
      const { harness, conversation } = await host.open("c1");
      expect(await markerProcesses("cm-lazy")).toEqual([]);
      await host.send("c1", "run only the probe", "lazy");
      await first.started;
      expect(await markerProcesses("cm-lazy")).toEqual([]);
      expect(requests[0]).toContain("mcp__probe");
      expect(requests[0]).not.toContain("mcp__rogue");
      first.release();
      await until(
        async () =>
          (
            await harness.snapshot(LiveDoc, conversation.id, context)
          )?.nestedTools?.some(
            (call) =>
              call.name === "mcp__probe__sleep" && call.status === "running",
          ) ?? false,
      );
      const live = ((await host.view("c1")).blocks as Rec[]).find(
        (block) => block.name === "codemode",
      )!;
      expect(live.calls).toContainEqual(
        expect.objectContaining({
          name: "mcp__probe__sleep",
          status: "running",
        }),
      );
      expect(live.calls[0].error).toStartWith("[pi-safety]");
      await ownGroup("cm-lazy");
      await last.started;
      const finished = ((await host.view("c1")).blocks as Rec[]).find(
        (block) => block.name === "codemode",
      )!;
      expect(finished.calls[0].error).toStartWith("[pi-safety]");
      expect(existsSync(join(work, "denied-live.txt"))).toBe(false);
      expect(await latest(host, "pi.tool-result")).toContain("echo:lazy");
      expect(existsSync(attempts)).toBe(false);
      last.release();
      await until(idle(host));
      await until(async () => (await markerProcesses("cm-lazy")).length === 0);
    } finally {
      first.release();
      last.release();
      await host.close();
    }
  });

  test("parallel servers complete long calls and invalid arguments produce an error row", async () => {
    const { host, faux, root } = setup("cm-parallel");
    const probe = { command: process.execPath, args: [FIXTURE] };
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({ mcpServers: { a: probe, b: probe } }),
    );
    script(faux, [
      codemode(
        "text(await Promise.all([tools.mcp__a__sleep({ms:3000}), tools.mcp__b__sleep({ms:3000})])); try { await tools.mcp__a__echo({}); } catch (error) { text(error.message); }",
      ),
      fauxAssistantMessage("done"),
    ]);
    try {
      await host.setSafetyReviewOff("c1", true);
      await host.send("c1", "parallel calls", "parallel");
      await until(idle(host));
      expect(await latest(host, "pi.tool-result")).toContain("slept");
      const block = ((await host.view("c1")).blocks as Rec[]).find(
        (block) => block.name === "codemode",
      )!;
      expect(block.calls.map((call: Rec) => call.status)).toEqual([
        "ok",
        "ok",
        "error",
      ]);
    } finally {
      await host.close();
    }
  });

  test("a restarted script reconnects MCP before making a new call", async () => {
    const { root, host, faux } = setup("cm-restart");
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: process.execPath,
            args: [FIXTURE, `--attempts=${join(root, "restart-attempts")}`],
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(
          import.meta.dir,
          "../../../backend/fixtures/durable_host/codemode_child.ts",
        ),
        root,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("running")) {
        const next = await reader.read();
        if (next.done) throw new Error(`crash fixture exited: ${output}`);
        output += new TextDecoder().decode(next.value);
      }
      child.kill("SIGKILL");
      await child.exited;
      faux.setResponses([fauxAssistantMessage("recovered")]);
      await host.openLive();
      await until(idle(host));
      const result = await latest(host, "pi.tool-result", "cm");
      expect(result).toContain("echo:before restart");
      expect(result).toContain("interrupted");
      expect(result).toContain("echo:new call after restart");
      expect(result).not.toContain("Tool not found");
      expect(await readFile(join(root, "restart-attempts"), "utf8")).toBe(
        "start\nstart\n",
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await host.close();
    }
  }, 30_000);

  // Regression: #2641 shutdown cancellation must not record an initialization failure.
  test("host shutdown aborts an initializing server and proves its group gone", async () => {
    const { host, faux, root } = setup("cm-initialize");
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          hanging: {
            command: "/bin/sh",
            args: ["-c", "sleep 60", `--marker=cm-initialize-${RUN}`],
          },
        },
      }),
    );
    script(faux, [
      codemode("await tools.mcp__hanging__echo({text:'waiting'})"),
    ]);
    try {
      await host.send("c1", "start initialization", "initialize");
      await until(
        async () => (await markerProcesses("cm-initialize")).length === 1,
      );
      const group = (await markerProcesses("cm-initialize"))[0]![1]!;
      await host.close();
      expect((await mcpStatuses(join(root, "mcp.json")))[0]!.state).toBe(
        "not-used",
      );
      expect(await markerProcesses("cm-initialize")).toEqual([]);
      expect(() => process.kill(-group, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      await host.close();
    }
  }, 10_000);

  test("HTTP unauthorized needs sign-in, but stays failed with a static Authorization header", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("private diagnostic", { status: 401 }),
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const mcp = servers({
      signin: { url, timeout: 1 },
      header: { url, timeout: 1, headers: { Authorization: "Bearer static" } },
    });
    try {
      expect(await mcp.tools()).toEqual([]);
      const unavailable = await mcp.unavailable();
      expect(unavailable).toContain("MCP server signin needs sign-in");
      expect(unavailable).toContain("MCP server header unavailable: HTTP 401");
      expect(unavailable).not.toContain("private diagnostic");
      expect(unavailable).not.toContain("Bearer static");
    } finally {
      await mcp.close();
      await server.stop(true);
    }
  });

  // Regression: #2850 codemode works without MCP and preserves the cached prefix across server changes.
  test("native store survives turns, models and model-only tools are absent, direct MCP calls are unavailable", async () => {
    const { host, faux, root, work } = setup("cm-capabilities");
    const config = await readFile(join(root, "mcp.json"), "utf8");
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    writeFileSync(join(work, "note"), "normal tool result");
    const initial = script(
      faux,
      [
        codemode(
          "text(await tools.read({path:'note'})); await tools.write({path:'denied',content:'x'});",
        ),
        fauxAssistantMessage("done"),
      ],
      () => "DENY: nested write denied",
    );
    try {
      await host.send("c1", "normal tools without MCP", "caps0");
      await until(idle(host));
      const before = JSON.parse(
        (await (await host.open("c1")).captures.latest("c1"))!.json,
      );
      expect(
        before.context.messages[0].toolsAdded.map((tool: Rec) => tool.name),
      ).toContain("codemode");
      expect(initial.requests.join("\n")).toContain("normal tool result");
      expect(initial.reviews).toHaveLength(1);
      expect(initial.reviews[0]).toContain("codemode");
      expect(initial.reviews[0]).toContain("write");
      expect(existsSync(join(work, "denied"))).toBe(false);
      const deferredConfig = JSON.parse(config);
      deferredConfig.mcpServers.probe.loadToolsOnDemand = true;
      deferredConfig.mcpServers.inline = {
        ...deferredConfig.mcpServers.probe,
        loadToolsOnDemand: false,
      };
      writeFileSync(join(root, "mcp.json"), JSON.stringify(deferredConfig));
      script(faux, [
        codemode(
          "text(await searchTools('probe echo')); text(await describeTool('mcp__probe__echo')); text(await tools.mcp__probe__echo({text:'connected'}));",
        ),
        fauxAssistantMessage("done"),
      ]);
      await host.send("c1", "enable MCP", "caps-enable");
      await until(idle(host));
      const after = JSON.parse(
        (await (await host.open("c1")).captures.latest("c1"))!.json,
      );
      expect(after.context.messages[0]).toEqual(before.context.messages[0]);
      expect(
        after.context.messages.flatMap(
          (message: Rec) => message.toolsRemoved ?? [],
        ),
      ).toEqual([]);
      expect(
        after.context.messages
          .slice(1)
          .flatMap((message: Rec) => message.toolsAdded ?? []),
      ).toEqual([]);
      expect(
        after.context.messages.slice(0, before.context.messages.length),
      ).toEqual(before.context.messages);
      const codemodeSections = after.context.messages.flatMap((message: Rec) =>
        message.sections?.codemode ? [message.sections.codemode] : [],
      );
      expect(codemodeSections.join("\n")).not.toContain(
        "### `mcp__probe__echo`",
      );
      expect(codemodeSections.join("\n")).toContain("### `mcp__inline__echo`");
      const callable = (
        await (await host.open("c1")).conversation.agent(context)
      ).callable;
      expect(
        callable.find((tool) => tool.name === "mcp__probe__echo")?.deferred,
      ).toBe(true);
      expect(
        callable.find((tool) => tool.name === "mcp__inline__echo")?.deferred,
      ).toBeUndefined();
      expect(await latest(host, "pi.tool-result")).toContain(
        "mcp__probe__echo",
      );
      expect(await latest(host, "pi.tool-result")).toContain("echo:connected");
      writeFileSync(join(root, "mcp.json"), config);
    } catch (error) {
      await host.close();
      throw error;
    }
    const { requests } = script(faux, [
      codemode(
        "store('kept', 'native-store'); text(typeof models); text(ALL_TOOLS);",
      ),
      fauxAssistantMessage(
        [fauxToolCall("mcp__probe__echo", { text: "direct" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    try {
      await host.setSafetyReviewOff("c1", true);
      await host.send("c1", "inspect capabilities", "caps1");
      await until(idle(host));
      expect(await latest(host, "pi.tool-result")).toContain(
        "is not available",
      );
      const agent = await (await host.open("c1")).conversation.agent(context);
      expect(agent.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(
        false,
      );
      expect(
        agent.callable.find((tool) => tool.name === "mcp__probe__echo")
          ?.deferred,
      ).toBeUndefined();
      expect(agent.callable.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["wait", "chdir", "compact"]),
      );
      for (const name of ["wait", "chdir", "compact"])
        expect(agent.callable.map((tool) => tool.name)).not.toContain(name);
      script(faux, [
        codemode("text(load('kept')); text(typeof models);"),
        fauxAssistantMessage("done"),
      ]);
      await host.send("c1", "read the store", "caps2");
      await until(idle(host));
      expect(await latest(host, "pi.tool-result")).toContain("native-store");
      expect(await latest(host, "pi.tool-result")).toContain("undefined");
      writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      const final = script(faux, [fauxAssistantMessage("disabled")]);
      await host.send("c1", "MCP disabled", "caps3");
      await until(idle(host));
      expect(
        (await (await host.open("c1")).conversation.agent(context)).tools.some(
          (tool) => tool.name === "codemode",
        ),
      ).toBe(true);
      const disabled = JSON.parse(
        (await (await host.open("c1")).captures.latest("c1"))!.json,
      );
      expect(disabled.context.messages[0]).toEqual(
        JSON.parse(requests[0]!).messages[0],
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(final.requests.length).toBe(1);
    } finally {
      await host.close();
    }
  });
  test("native nested calls retain the complete result and bound displayed rows", async () => {
    const { host, faux } = setup("cm-progress");
    const last = held(fauxAssistantMessage("done"));
    const count = 105;
    script(faux, [
      codemode(
        `for (let i = 0; i < ${count}; i++) await tools.mcp__probe__echo({ text: 'progress' });`,
      ),
      last.step,
    ]);
    const { conversation } = await host.open("c1");
    await host.setSafetyReviewOff("c1", true);
    try {
      await host.send("c1", "go", "r1");
      await last.started;
      const block = ((await host.view("c1")).blocks as Rec[]).find(
        (each) => each.name === "codemode",
      )!;
      expect(block.calls).toHaveLength(101);
      expect(
        block.calls.slice(0, 100).every((call: Rec) => call.status === "ok"),
      ).toBeTrue();
      expect(block.calls[100]).toMatchObject({ status: "omitted", omitted: 5 });
      const result = (await conversation.context(context)).entries.findLast(
        (entry) => entry.kind === "pi.tool-result",
      );
      expect((result?.model?.[0] as Rec).details.calls).toHaveLength(count);
    } finally {
      last.release();
      await host.close();
    }
  });
  // Regression: #2650 codemode MCP notice starts on its own line. (also Feature #2625 broken servers remain visible with at most one attempt per run and no secret diagnostics.)
  test("failed servers stay visible with one attempt per run and no secret diagnostics", async () => {
    const { host, faux, root } = setup("cm-failed");
    const attempts = join(root, "attempts");
    const config = join(root, "mcp.json");
    const broken = {
      broken: {
        command: process.execPath,
        args: [FIXTURE, "--exit-17", `--attempts=${attempts}`],
      },
      closed_http: {
        url: "http://secret-looking-user:secret-looking-password@127.0.0.1:0/",
        timeout: 1,
      },
      disabled: { command: "unused", enabled: false },
    };
    writeFileSync(config, JSON.stringify({ mcpServers: broken }));
    const { requests } = script(faux, [
      codemode('return await searchTools("echo")'),
      codemode('return await describeNamespace("mcp__broken")'),
      codemode('return await tools.mcp__broken__echo({text:"hello"})'),
      fauxAssistantMessage("done"),
    ]);
    try {
      await host.send("c1", "discover broken MCP servers", "r1");
      await until(idle(host));
      const statuses = await mcpStatuses(config);
      expect(statuses.find((each) => each.name === "broken")).toMatchObject({
        state: "failed",
        reason: "exited with code 17",
      });
      expect(
        statuses.find((each) => each.name === "closed_http"),
      ).toMatchObject({ state: "failed", reason: "connection refused" });
      expect(statuses.find((each) => each.name === "disabled")).toMatchObject({
        state: "disabled",
        checkedAt: null,
      });
      expect(await readFile(attempts, "utf8")).toBe("start\n");
      const result = await latest(host, "pi.tool-result");
      expect(result).toContain(
        "\nMCP server broken unavailable: exited with code 17",
      );
      expect(result).toContain(
        "MCP server closed_http unavailable: connection refused",
      );
      expect(requests.at(-1)).toContain("\\nMCP server broken unavailable");
      expect(JSON.stringify({ statuses, result, requests })).not.toContain(
        "secret-looking",
      );
      script(faux, [
        codemode('return await searchTools("echo")'),
        fauxAssistantMessage("done"),
      ]);
      await host.send("c1", "check discovery again", "r2");
      await until(idle(host));
      expect(await readFile(attempts, "utf8")).toBe("start\nstart\n");
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            ...broken,
            broken: { command: process.execPath, args: [FIXTURE] },
          },
        }),
      );
      script(faux, [
        codemode('return await searchTools("echo")'),
        fauxAssistantMessage("done"),
      ]);
      await host.send("c1", "discover after config change", "r3");
      await until(idle(host));
      expect(
        (await mcpStatuses(config)).find((each) => each.name === "broken"),
      ).toMatchObject({ state: "connected", toolCount: 5 });
    } finally {
      await host.close();
    }
  }, 60_000);

  test("a crashed server reconnects on its next call and exposes only safe failures", async () => {
    const { host, faux, root } = setup("cm-call-failed");
    const attempts = join(root, "attempts");
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: process.execPath,
            args: [
              FIXTURE,
              "--exit-on-echo",
              "--spawn-child",
              `--marker=cm-call-failed-${RUN}`,
              `--attempts=${attempts}`,
            ],
          },
        },
      }),
    );
    let oldGroup = 0;
    const last = held(fauxAssistantMessage("done"));
    const { requests } = script(faux, [
      codemode('return await tools.mcp__probe__echo({text:"hello"})'),
      async () => {
        await until(
          async () => (await markerProcesses("cm-call-failed")).length === 1,
        );
        oldGroup = (await markerProcesses("cm-call-failed"))[0]![1]!;
        return codemode('return await tools.mcp__probe__echo({text:"again"})');
      },
      last.step,
    ]);
    try {
      await host.send("c1", "call the probe", "r1");
      await last.started;
      await until(async () => {
        const procs = await markerProcesses("cm-call-failed");
        return procs.length === 1 && procs[0]![1] !== oldGroup;
      });
      expect(() => process.kill(-oldGroup, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      expect(await latest(host, "pi.tool-result")).toContain(
        "MCP server probe unavailable: exited with code 17",
      );
      expect(requests.at(-1)).toContain(
        "MCP server probe unavailable: exited with code 17",
      );
      expect(JSON.stringify(requests)).not.toContain("secret-looking");
      expect(await readFile(attempts, "utf8")).toBe("start\nstart\n");
      last.release();
      await until(idle(host));
      await until(
        async () => (await markerProcesses("cm-call-failed")).length === 0,
      );
    } finally {
      last.release();
      await host.close();
    }
  }, 60_000);

  test("scripts reach MCP tools and bash; configured env resolves against the agent env; its group ends with the run", async () => {
    process.env.RECURSE_TEST_SERVER_ONLY = "server-secret";
    const { host, faux, root } = setup("cm-run", {
      FROM_COMMAND: `!${process.execPath} ${FIXTURE} --grandchild --marker=cm-command-${RUN} >/dev/null 2>&1 & printf from-command`,
      FROM_AGENT: "${TMPDIR}",
    });
    const last = held(fauxAssistantMessage("done"));
    const { reviews } = script(faux, [
      codemode(
        [
          'const out = [await tools.mcp__probe__echo({ text: "hi" })];',
          'for (const name of ["RECURSE_TEST_SERVER_ONLY", "FROM_COMMAND", "FROM_AGENT"])',
          "  out.push(await tools.mcp__probe__env({ name }));",
          'out.push(await tools.mcp__probe__write_note({ path: "/dev/null", text: "x" }));',
          'out.push(await tools.bash({ command: "echo nested-bash" }));',
          'return out.map((r) => typeof r === "string" ? r : r.content ? r.content[0].text : r.output).join("|");',
        ].join("\n"),
      ),
      last.step,
    ]);
    try {
      await host.send("c1", "go", "r1");
      await last.started;
      await ownGroup("cm-run");
      expect(await markerProcesses("cm-command")).toEqual([]);
      const text = await latest(host, "pi.tool-result", "cm");
      expect(text).toContain(
        `echo:hi|env:(unset)|env:from-command|env:${join(root, "tmp")}|wrote /dev/null|nested-bash`,
      );
      expect(reviews).toHaveLength(5);
      expect(reviews.at(-1)).toContain("mcp__probe__write_note");
      expect(reviews.at(-1)).toContain("calledBy");
      expect(JSON.parse(reviews.at(-1)!)[0].text).toContain(
        '"mcpServer": "probe"',
      );
      const block = ((await host.view("c1")).blocks as Rec[]).find(
        (each) => each.name === "codemode",
      )!;
      expect(
        block.calls.map((call: Rec) => `${call.name}:${call.status}`),
      ).toEqual([
        "mcp__probe__echo:ok",
        ...Array(3).fill("mcp__probe__env:ok"),
        "mcp__probe__write_note:ok",
        "bash:ok",
      ]);
      last.release();
      await until(idle(host));
      await until(async () => (await markerProcesses("cm-run")).length === 0);
    } finally {
      delete process.env.RECURSE_TEST_SERVER_ONLY;
      await host.close();
    }
  }, 60_000);

  test("a nested review sees the same evidence as a direct review of the same round", async () => {
    const { host, faux, work } = setup("cm-evidence");
    const { reviews } = script(faux, [
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo earlier" }, { id: "b0" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 2; touch direct.txt" }),
          fauxToolCall("codemode", {
            code: 'await tools.bash({ command: "touch nested.txt" })',
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      await host.send("c1", "first", "r1");
      await until(
        async () => (await latest(host, "pi.assistant")) === "first done",
      );
      await until(idle(host));
      await host.send("c1", "second", "r2");
      await until(() => existsSync(join(work, "nested.txt")));
      await until(idle(host));
      expect(existsSync(join(work, "direct.txt"))).toBe(true);
      const evidence = (review: string) =>
        /CONVERSATION EVIDENCE START([\s\S]*)CONVERSATION EVIDENCE END/.exec(
          review,
        )![1];
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).not.toContain("calledBy");
      expect(evidence(reviews[1]!)).toBe(evidence(reviews[0]!));
      expect(evidence(reviews[0]!)).toContain("first done");
      expect(evidence(reviews[0]!)).toContain("echo earlier");
    } finally {
      await host.close();
    }
  }, 60_000);

  test("a denied nested call never runs, and nested and direct denials share the run's breaker", async () => {
    const { host, faux, work } = setup("cm-deny");
    const push = (n: number) =>
      fauxToolCall("bash", { command: `git push origin b${n}` });
    const { reviews } = script(
      faux,
      [
        fauxAssistantMessage(
          [
            fauxToolCall(
              "codemode",
              { code: "await tools.bash({command:'touch denied-bash.txt'})" },
              { id: "denied-bash" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([push(1)], { stopReason: "toolUse" }),
        codemode(
          [
            "const out = [];",
            "for (const n of [1, 2, 3, 4])",
            "  await tools.mcp__probe__write_note({ path: `note${n}.txt`, text: 'x' })",
            "    .then(() => out.push(`ran ${n}`), (error) => out.push(`blocked ${n}: ${error.message}`));",
            "return out.join('\\n');",
          ].join("\n"),
        ),
      ],
      () => "DENY: not allowed here",
    );
    try {
      await host.send("c1", "go", "r1");
      await until(
        async () => (await latest(host, "pi.tool-result", "cm")) !== undefined,
      );
      await until(idle(host));
      const text = await latest(host, "pi.tool-result", "cm");
      expect(text).toContain("blocked 1: Tool call blocked: [pi-safety]");
      expect(text).toContain("not allowed here");
      for (const n of [2, 3, 4])
        expect(text).toContain(
          `blocked ${n}: Tool call blocked: [pi-safety] Tool call blocked because the circuit breaker opened`,
        );
      for (const n of [1, 2, 3, 4])
        expect(existsSync(join(work, `note${n}.txt`))).toBe(false);
      expect(existsSync(join(work, "denied-bash.txt"))).toBe(false);
      const blocked = ((await host.view("c1")).blocks as Rec[]).find(
        (block) =>
          block.toolCallId === "denied-bash" ||
          block.calls?.some((call: Rec) => call.name === "bash"),
      );
      expect(blocked?.calls[0].error).toStartWith("[pi-safety]");
      expect(reviews).toHaveLength(3);
      const { harness, conversation } = await host.open("c1");
      const safety = await import(
        new URL(
          "../../../../src/extensions/core/safety/durable.ts",
          import.meta.url,
        ).href
      );
      const denied = (await harness.snapshot(
        safety.DeniedReviewDoc,
        conversation.id,
        context,
      )) as Rec;
      expect(denied.calls).toBe(3);
      expect(denied.run.denied).toHaveLength(3);
      expect(denied.run.denied[2]).toMatch(/^\d+$/);
    } finally {
      await host.close();
    }
  }, 60_000);

  function servers(
    mcpServers: Rec,
    ownDelayMs = 0,
    env: Record<string, string> = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "durable-mcp-"));
    roots.push(root);
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers }));
    return new McpServers({
      configPath: join(root, "mcp.json"),
      scope: async () => ({
        cwd: root,
        env: { PATH: process.env.PATH!, ...env },
      }),
      own: async (proc) => {
        await Bun.sleep(ownDelayMs);
        await lifecycle.registerProcess(proc, "mcp", "c1");
      },
      release: async (proc) =>
        (await lifecycle.cleanupProcessObject(proc)) !== false,
      report: () => undefined,
    });
  }

  // Regression: #2641 an async config read must not start a server after close.
  test("closing during the Settings read prevents a later server start", async () => {
    const mcp = servers({
      probe: {
        command: process.execPath,
        args: [FIXTURE, `--marker=cm-late-close-${RUN}`],
      },
    });
    const pending = mcp.tools();
    const closed = mcp.close();
    try {
      await expect(pending).rejects.toThrow();
      expect(await closed).toBe(true);
      expect(await markerProcesses("cm-late-close")).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  // Feature: #2625 cancellation must not mark a healthy server unavailable.
  test("cancelling an MCP call does not mark its healthy server unavailable", async () => {
    const mcp = servers({
      probe: { command: process.execPath, args: [FIXTURE] },
    });
    try {
      const tools = await mcp.tools();
      const abort = new AbortController();
      const sleep = tools.find((tool) => tool.name === "mcp__probe__sleep")!;
      const pending = sleep.execute(
        { ms: 60000 },
        undefined!,
        withAbortSignal(abort.signal, context),
      );
      abort.abort();
      await expect(pending).rejects.toThrow("MCP request cancelled");
      expect(await mcp.unavailable()).toBe("");
      const echo = tools.find((tool) => tool.name === "mcp__probe__echo")!;
      const result = await echo.execute(
        { text: "still connected" },
        undefined!,
        context,
      );
      expect(JSON.stringify(result.output)).toContain("echo:still connected");
    } finally {
      await mcp.close();
    }
  }, 60_000);

  // Regression: #2620 stdio MCP servers must not inherit agent credentials.
  test("stdio servers receive only base env and their configured variables", async () => {
    const credentials = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "MODAL_IDENTITY_TOKEN",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "RECURSE_MODAL_AUTH_SECRET",
      "CHAT_AUTH_HASH",
      "CHAT_AUTH_SALT",
    ];
    const mcp = servers(
      {
        probe: {
          command: process.execPath,
          args: [FIXTURE],
          env: {
            CONFIGURED: "configured",
            OPTED_IN: "${GH_TOKEN}",
            FROM_COMMAND: '!printf "%s" "$GH_TOKEN"',
          },
        },
      },
      0,
      {
        ...Object.fromEntries(credentials.map((name) => [name, "test-only"])),
        UNRELATED_AGENT_VARIABLE: "private",
      },
    );
    try {
      const tools = await mcp.tools();
      const call = async (name: string, params: Rec = {}) => {
        const result = await tools
          .find((tool) => tool.name === `mcp__probe__${name}`)!
          .execute(params, undefined!, context);
        return (result.output ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      };
      const names = JSON.parse(await call("env_names")) as string[];
      expect(names).not.toContain("UNRELATED_AGENT_VARIABLE");
      for (const name of credentials) expect(names).not.toContain(name);
      expect(await call("env", { name: "CONFIGURED" })).toBe("env:configured");
      expect(await call("env", { name: "OPTED_IN" })).toBe("env:test-only");
      expect(await call("env", { name: "FROM_COMMAND" })).toBe("env:test-only");
    } finally {
      expect(await mcp.close()).toBe(true);
    }
  }, 60_000);

  test("concurrent closes each resolve only once the server's group is gone", async () => {
    const args = [
      FIXTURE,
      `--marker=cm-twice-${RUN}`,
      "--stubborn",
      "--spawn-child",
    ];
    const mcp = servers({ probe: { command: process.execPath, args } });
    try {
      expect((await mcp.tools()).length).toBeGreaterThan(0);
      await ownGroup("cm-twice");
      const closes = [mcp.close(), mcp.close()].map(async (closed) => [
        await closed,
        await markerProcesses("cm-twice"),
      ]);
      expect(await Promise.all(closes)).toEqual([
        [true, []],
        [true, []],
      ]);
    } finally {
      await mcp.close();
    }
  }, 60_000);

  test("a server that exits at once leaves no child of its group behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-fast-child-"));
    roots.push(root);
    const started = join(root, "started");
    const child = `${process.execPath} ${FIXTURE} --grandchild --marker=cm-fast-${RUN} --started-file=${started}`;
    const mcp = servers(
      {
        fast: {
          command: "/bin/sh",
          args: [
            "-c",
            `${child} </dev/null >/dev/null 2>&1 & while [ ! -e ${started} ]; do sleep 0.01; done; exit 0`,
          ],
        },
      },
      300,
    );
    try {
      expect(await mcp.tools()).toEqual([]);
      expect(await readFile(started, "utf8")).toBe("started\n");
      expect(await mcp.close()).toBe(true);
      expect(await markerProcesses("cm-fast")).toEqual([]);
    } finally {
      for (const [pid] of await markerProcesses("cm-fast"))
        process.kill(pid!, "SIGKILL");
    }
  }, 60_000);

  for (const how of ["stop", "reap", "shutdown"] as const)
    test(`a ${how} leaves no server process`, async () => {
      const marker = `cm-${how}`;
      const { host, faux, records } = setup(marker);
      script(faux, [codemode("await tools.mcp__probe__sleep({ ms: 60000 })")]);
      try {
        await host.send("c1", "go", "r1");
        await ownGroup(marker);
        if (how === "stop") {
          await host.stop("c1");
          await until(idle(host));
          await until(async () => (await markerProcesses(marker)).length === 0);
          return;
        }
        if (how === "reap") {
          records.c1!.reap_deferred = true;
          expect(await host.retire("c1")).toBe(true);
        } else await host.close();
        expect(await markerProcesses(marker)).toEqual([]);
      } finally {
        await host.close().catch(() => undefined);
      }
    }, 60_000);
});
