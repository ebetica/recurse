import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import { BackendKeys } from "../../src/auth/backend_keys";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import {
  PROMOTED_INSTRUCTIONS,
  RETURN_TO_MAIN,
  SIDE_INSTRUCTIONS,
  sideForks,
} from "../../src/agents/durable/side_conversations";
import { appWorld } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

type Rec = Record<string, unknown>;

// Feature: #2735 a side conversation is a read-only Durable fork of its parent
test("a side conversation forks its parent's exact prompt and tools, refuses non-read tools, returns to main only through return_to_main, survives restart and goes with a parent clear", async () => {
  const { root, env } = appWorld();
  const fixture = fauxHost(join(root, "faux"), "faux/faux-1", true);
  const touched = join(fixture.work, "touched");
  const promoted = join(fixture.work, "promoted");
  const note = join(fixture.work, "note");
  writeFileSync(note, "note");
  const results: string[] = [];
  const held: string[] = [];
  const sessions: Record<string, unknown> = {};
  const reviews: string[] = [];
  const reply: FauxResponseFactory = (request, options) => {
    fixture.faux.appendResponses([reply]);
    const last = request.messages.findLast(
      (message) => message.role === "user" || message.role === "toolResult",
    )!;
    if (JSON.stringify(last.content).includes("<message>"))
      return fauxAssistantMessage("Side title");
    const all = JSON.stringify(request.messages);
    if (all.includes('\\"tool\\": \\"bash\\"'))
      return fauxAssistantMessage("OK");
    if (all.includes('\\"tool\\": \\"return_to_main\\"')) {
      reviews.push(all);
      return fauxAssistantMessage(
        reviews.length === 1 ? "DENY: not asked for" : "OK",
      );
    }
    if (last.role === "toolResult") {
      results.splice(
        0,
        results.length,
        ...request.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => JSON.stringify(message.content)),
      );
      return fauxAssistantMessage(
        fauxText(
          all.includes("run bash now")
            ? "promoted answer"
            : all.includes("promote question")
              ? "promote answer"
              : "side answer",
        ),
      );
    }
    const text = JSON.stringify(last.content);
    for (const question of ["main question", "side question"])
      if (text.includes(question)) sessions[question] = options?.sessionId;
    const hold = /hold \w+/.exec(text)?.[0];
    if (hold !== undefined && !held.includes(hold)) {
      held.push(hold);
      return new Promise((resolve) =>
        options?.signal?.addEventListener("abort", () =>
          resolve(fauxAssistantMessage(fauxText("aborted"))),
        ),
      );
    }
    if (hold !== undefined)
      return fauxAssistantMessage(fauxText(`${hold} resumed`));
    if (text.includes("run bash now"))
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: `touch ${promoted}` })],
        { stopReason: "toolUse" },
      );
    if (text.includes("promoted after restart"))
      return fauxAssistantMessage(fauxText("restarted answer"));
    if (text.includes("promote question"))
      return fauxAssistantMessage(
        Array.from({ length: 70 }, () => fauxToolCall("read", { path: note })),
        { stopReason: "toolUse" },
      );
    if (text.includes("back to main"))
      return fauxAssistantMessage(
        [fauxToolCall(RETURN_TO_MAIN, { message: "distilled for main" })],
        { stopReason: "toolUse" },
      );
    if (text.includes("side question"))
      return fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: `touch ${touched}` }),
          fauxToolCall("write", { path: touched, content: "x" }),
          fauxToolCall("codemode", {
            code: `await tools.write({path:${JSON.stringify(touched)},content:'nested'});`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (text.includes("main question"))
      return fauxAssistantMessage(fauxText("main answer"));
    return fauxAssistantMessage(fauxText("later answer"));
  };
  fixture.faux.setResponses([reply]);
  const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  const start = async (wallClock?: () => number) => {
    const app = await buildApp({
      env,
      sink: new WebLogSink(() => {}),
    });
    Object.assign(
      (app.instance.durable as unknown as { deps: DurableHostDeps }).deps,
      {
        models: fake.models,
        settings: fake.settings,
        agentEnv: fake.agentEnv,
        promptSnapshot: async (conv: Rec, cwd: string) => ({
          ...(await fake.promptSnapshot(conv, cwd)),
          recurse_agent: `agent ${String(conv.id)}`,
        }),
        titleSettings: () => ["faux/faux-1", "off"],
        captureIdleMs: 200,
        wallClock,
      },
    );
    const running = await app.serve({ port: 0 });
    const url = running.url;
    const api = async (path: string, body?: object, method?: string) =>
      fetch(`${running.url}${path}`, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    await until(
      async () =>
        ((await (await api("/api/status")).json()) as { ready: boolean }).ready,
    );
    const host = app.instance.durable;
    const settled = () => host.runningCount() === 0;
    const stop = async () => {
      await running.close();
      await app.instance.shutdown();
      await Promise.all(app.detached);
    };
    return { app, api, host, settled, stop, url };
  };
  let world = await start();
  try {
    const { api } = world;
    const parent = String(
      ((await (await api("/api/conversations", {})).json()) as Rec).id,
    );
    expect(
      (
        await api(`/api/conversations/${parent}/deliver`, {
          content: "main question",
        })
      ).status,
    ).toBe(200);
    await until(
      async () =>
        world.settled() &&
        (
          await (await api(`/api/conversations/${parent}/view`)).text()
        ).includes("main answer"),
    );
    const parentView = await (
      await api(`/api/conversations/${parent}/view`)
    ).text();
    const parentRequest = (
      (await (await api(`/api/conversations/${parent}/prompt`)).json()) as Rec
    ).request;

    const created = await api(`/api/conversations/${parent}/side`, {
      question: "side question",
    });
    expect(created.status).toBe(201);
    const side = String(((await created.json()) as Rec).id);
    await until(async () => {
      const view = await (await api(`/api/conversations/${side}/view`)).text();
      return world.settled() && view.includes("side answer");
    });

    expect(existsSync(touched)).toBe(false);
    expect(sessions["side question"]).toBe(sessions["main question"]);
    expect(sessions["main question"]).toEqual(expect.any(String));
    expect(results).toEqual([
      expect.stringContaining("bash is refused"),
      expect.stringContaining("write is refused"),
      expect.stringContaining("codemode is refused"),
    ]);
    const prompt = (await (
      await api(`/api/conversations/${side}/prompt`)
    ).json()) as {
      request: { context: { messages: Rec[] } };
      system_messages: {
        toolsAdded?: { name: string }[];
        toolsRemoved?: { name: string }[];
      }[];
    };
    const parentMessages = (parentRequest as typeof prompt.request).context
      .messages;
    expect(
      prompt.request.context.messages
        .slice(0, parentMessages.length)
        .map((message) => JSON.stringify(message)),
    ).toEqual(parentMessages.map((message) => JSON.stringify(message)));
    expect(
      prompt.system_messages.flatMap((message) => message.toolsRemoved ?? []),
    ).toEqual([]);
    const parentTools = (
      await (await world.host.open(parent)).conversation.agent(context)
    ).tools.map((tool) => tool.name);
    expect(parentTools).toContain("codemode");
    expect(
      prompt.system_messages.flatMap((message) =>
        (message.toolsAdded ?? []).map((tool) => tool.name),
      ),
    ).toEqual([...parentTools, RETURN_TO_MAIN]);
    expect(JSON.stringify(prompt)).toContain(`agent ${side}`);
    const sent = JSON.stringify(prompt.request.context.messages);
    expect(sent).toContain(JSON.stringify(SIDE_INSTRUCTIONS).slice(1, -1));
    expect(sent).toContain("main answer");
    const sideFile = join(
      env.CHAT_DATA_DIR,
      "conversations",
      parent,
      "durable",
      `last-request-${side}.json`,
    );
    await until(() => existsSync(sideFile));
    expect(
      ((await (await api(`/api/conversations/${side}/prompt`)).json()) as Rec)
        .request,
    ).toEqual(prompt.request);

    expect(await (await api(`/api/conversations/${parent}/view`)).text()).toBe(
      parentView,
    );
    expect(
      ((await (await api(`/api/conversations/${parent}/prompt`)).json()) as Rec)
        .request,
    ).toEqual(parentRequest);
    const tree = (await (await api("/api/tree")).json()) as Rec[];
    expect(tree.find((row) => row.id === side)).toMatchObject({
      side_of: parent,
    });
    expect(tree.find((row) => row.id === parent)).toMatchObject({
      children: 0,
    });
    expect(
      (await api(`/api/conversations/${side}/model`, { level: 1 })).status,
    ).toBe(409);
    await until(
      () => world.app.instance.conversations.load(side)?.title === "Side title",
    );

    await world.api(`/api/conversations/${side}/deliver`, {
      content: "hold one",
    });
    await until(() => held.includes("hold one"));
    await world.stop();
    world = await start();
    expect(world.app.instance.conversations.load(side)).toMatchObject({
      side_of: parent,
    });
    await until(async () =>
      (
        await (await world.api(`/api/conversations/${side}/view`)).text()
      ).includes("hold one resumed"),
    );
    expect(
      (
        await world.api(`/api/conversations/${side}/deliver`, {
          content: "after restart",
        })
      ).status,
    ).toBe(200);
    await until(async () => {
      const view = await (
        await world.api(`/api/conversations/${side}/view`)
      ).text();
      return (
        world.settled() &&
        view.includes("side answer") &&
        view.includes("later answer")
      );
    });
    expect(
      await (await world.api(`/api/conversations/${parent}/view`)).text(),
    ).not.toContain("later answer");
    await world.api(`/api/conversations/${side}/deliver`, {
      content: "take this back to main",
    });
    await until(
      () =>
        world.settled() &&
        results.some((result) => result.includes("not asked for")),
    );
    expect(
      await (await world.api(`/api/conversations/${parent}/view`)).text(),
    ).not.toContain("distilled for main");
    await world.api(`/api/conversations/${side}/deliver`, {
      content: "take this back to main",
    });
    await until(async () => {
      const view = await (
        await world.api(`/api/conversations/${parent}/view`)
      ).text();
      return (
        world.settled() &&
        view.includes("distilled for main") &&
        view.includes("later answer")
      );
    });
    expect(
      JSON.stringify(
        (
          (await (
            await world.api(`/api/conversations/${parent}/prompt`)
          ).json()) as Rec
        ).request,
      ),
    ).toContain(
      JSON.stringify(
        `[recurse-from: ${side}]\n[recurse-from-name: Side conversation: Side title]`,
      ).slice(1, -1),
    );
    expect(reviews).toEqual([
      expect.stringContaining("distilled for main"),
      expect.stringContaining("distilled for main"),
    ]);

    const load = (cid: string) => world.app.instance.conversations.load(cid);
    const branch = async (cid: string) =>
      String(
        (
          (await (
            await world.api(`/api/conversations/${cid}/side`, {})
          ).json()) as Rec
        ).id,
      );
    const second = await branch(parent);
    expect(load(second)).toMatchObject({ side_of: parent });
    expect(
      (await world.api(`/api/conversations/${parent}`, undefined, "DELETE"))
        .status,
    ).toBe(202);
    await until(
      () =>
        load(parent) === null && load(side) === null && load(second) === null,
      20_000,
    );

    const other = String(
      ((await (await world.api("/api/conversations", {})).json()) as Rec).id,
    );
    await world.api(`/api/conversations/${other}/deliver`, {
      content: "main question",
    });
    await until(async () =>
      (
        await (await world.api(`/api/conversations/${other}/view`)).text()
      ).includes("main answer"),
    );
    const third = await branch(other);
    await world.api(`/api/conversations/${third}/deliver`, {
      content: "hold two",
    });
    await world.api(`/api/conversations/${third}/deliver`, {
      content: "queued behind",
    });
    await until(() => held.includes("hold two"));
    const thirdFile = join(
      env.CHAT_DATA_DIR,
      "conversations",
      other,
      "durable",
      `last-request-${third}.json`,
    );
    await until(() => existsSync(thirdFile));
    const host = await world.host.open(other);
    const forked = (await sideForks(host.harness, host.conversation))[third]!;
    const forkId = forked.conversation as typeof host.conversation.id;
    expect(
      (await host.harness.snapshot(InboxDoc, forkId, context))?.items.length,
    ).toBe(1);
    expect(
      (await world.api(`/api/conversations/${third}`, undefined, "DELETE"))
        .status,
    ).toBe(202);
    await until(() => load(third) === null, 20_000);
    await until(() => !existsSync(thirdFile));
    expect(
      (await sideForks(host.harness, host.conversation))[third],
    ).toBeUndefined();
    await until(
      async () =>
        (await host.harness.snapshot(LiveDoc, forkId, context))?.run ===
        undefined,
    );
    expect(
      (await host.harness.snapshot(InboxDoc, forkId, context))?.items ?? [],
    ).toEqual([]);

    const fourth = await branch(other);
    expect(
      (await world.api(`/api/conversations/${fourth}/clear`, {})).status,
    ).not.toBe(200);
    expect(
      (await world.api(`/api/conversations/${other}/clear`, {})).status,
    ).toBe(200);
    await until(() => load(fourth) === null, 20_000);
    expect(load(other)).not.toBeNull();

    await world.api(`/api/conversations/${other}/deliver`, {
      content: "main question",
    });
    await until(async () =>
      (
        await (await world.api(`/api/conversations/${other}/view`)).text()
      ).includes("main answer"),
    );
    const asked = async (question: string) => {
      const cid = String(
        (
          (await (
            await world.api(`/api/conversations/${other}/side`, { question })
          ).json()) as Rec
        ).id,
      );
      await until(async () =>
        (
          await (await world.api(`/api/conversations/${cid}/view`)).text()
        ).includes("promote answer"),
      );
      return cid;
    };
    const captured = async (cid: string) =>
      (await (await world.api(`/api/conversations/${cid}/prompt`)).json()) as {
        request: {
          model: unknown;
          context: { systemPrompt?: string; messages: Rec[]; tools?: Rec[] };
          options: Rec;
        };
        system_messages: {
          toolsAdded?: { name: string }[];
          toolsRemoved?: { name: string }[];
        }[];
      };
    const fifth = await asked("promote question");
    await world.api(`/api/conversations/${fifth}/deliver`, {
      content: "hold three",
    });
    await until(() => held.includes("hold three"));
    expect(
      (await world.api(`/api/conversations/${fifth}/promote`, {})).status,
    ).toBe(409);
    expect(await world.host.stop(fifth)).toBe(true);
    await until(world.settled);
    const sideRequest = (await captured(fifth)).request;
    const otherSession = (await captured(other)).request.options.sessionId;
    const key = await new BackendKeys(env.CHAT_DATA_DIR!).mint("remote-home");
    for (const marked of [
      [["x-recurse-agent", other]],
      [["x-recurse-agent", "invalid,marker"]],
      [["x-recurse-agent", ""]],
      [
        ["x-recurse-agent", other],
        ["x-recurse-agent", other],
      ],
      [
        ["authorization", `Bearer ${key.key}`],
        ["x-recurse-agent-caller", other],
      ],
    ]) {
      const headers = new Headers({ "content-type": "application/json" });
      for (const [name, value] of marked) headers.append(name!, value!);
      const denied = await fetch(
        `${world.url}/api/conversations/${fifth}/promote`,
        { method: "POST", headers, body: "{}" },
      );
      expect({ marked, status: denied.status }).toEqual({
        marked,
        status: 403,
      });
      expect(load(fifth)).toMatchObject({ side_of: other });
      expect(load(fifth)?.promoting).toBeUndefined();
    }
    expect(
      (await world.api(`/api/conversations/${fifth}/promote`, {})).status,
    ).toBe(202);
    await until(() => load(fifth)?.side_of === undefined, 20_000);
    expect(load(fifth)).toMatchObject({ parent: other });
    const rows = (await (await world.api("/api/tree")).json()) as Rec[];
    expect(rows.find((row) => row.id === fifth)).toMatchObject({
      parent: other,
    });
    expect(rows.find((row) => row.id === fifth)?.side_of).toBeUndefined();
    expect(rows.find((row) => row.id === other)).toMatchObject({
      children: 1,
    });
    await world.api(`/api/conversations/${fifth}/deliver`, {
      content: "run bash now",
    });
    await until(async () =>
      (
        await (await world.api(`/api/conversations/${other}/view`)).text()
      ).includes("promoted answer"),
    );
    expect(existsSync(promoted)).toBe(true);
    const childPrompt = await captured(fifth);
    const childRequest = childPrompt.request;
    expect(childRequest.model).toEqual(sideRequest.model);
    expect(childRequest.context.systemPrompt ?? null).toBe(
      sideRequest.context.systemPrompt ?? null,
    );
    expect(JSON.stringify(childRequest.context.tools)).toBe(
      JSON.stringify(sideRequest.context.tools),
    );
    expect(
      childRequest.context.messages
        .slice(0, sideRequest.context.messages.length)
        .map((message) => JSON.stringify(message)),
    ).toEqual(
      sideRequest.context.messages.map((message) => JSON.stringify(message)),
    );
    expect(childRequest.options.sessionId).toBe(otherSession);
    expect({ ...childRequest.options, sessionId: null }).toEqual({
      ...sideRequest.options,
      sessionId: null,
    });
    expect(
      childPrompt.system_messages.flatMap(
        (message) => message.toolsRemoved ?? [],
      ),
    ).toEqual([]);
    expect(JSON.stringify(childRequest.context.messages)).toContain(
      JSON.stringify(PROMOTED_INSTRUCTIONS).slice(1, -1),
    );
    const copiedTools = [
      ...(
        await (
          await world.api(`/api/conversations/${fifth}/view?limit=500`)
        ).text()
      ).matchAll(/"artifact_id":"(d-[a-f0-9]{8}-r\d+)"/g),
    ].map((match) => match[1]!);
    expect(new Set(copiedTools).size).toBe(70);
    const copiedTool = copiedTools.at(-1);
    const details = await world.api(
      `/api/conversations/${fifth}/tool-details/${copiedTool}`,
    );
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      tool_name: "read",
      status: "finished",
      input: { payload: { value: { path: note } } },
    });

    const sixth = await asked("promote question");
    await until(world.settled);
    const sixthRequest = (await captured(sixth)).request;
    await world.app.instance.durable["deps"].promotion!(sixth, "running");
    const staged = join(
      env.CHAT_DATA_DIR,
      "conversations",
      sixth,
      "durable.promoting",
    );
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "half"), "");
    await world.stop();
    world = await start(() => Date.now() + 10 * 60_000);
    await until(() => load(sixth)?.side_of === undefined, 20_000);
    expect(load(sixth)).toMatchObject({ parent: other });
    await world.api(`/api/conversations/${sixth}/deliver`, {
      content: "promoted after restart",
    });
    await until(async () =>
      (
        await (await world.api(`/api/conversations/${sixth}/view`)).text()
      ).includes("restarted answer"),
    );
    await until(world.settled);
    expect(
      (await captured(sixth)).request.context.messages
        .slice(0, sixthRequest.context.messages.length)
        .map((message) => JSON.stringify(message)),
    ).toEqual(
      sixthRequest.context.messages.map((message) => JSON.stringify(message)),
    );
    expect(existsSync(staged)).toBe(false);
    expect(
      existsSync(
        join(env.CHAT_DATA_DIR, "conversations", sixth, "durable", "half"),
      ),
    ).toBe(false);
  } finally {
    await world.stop();
    await fixture.host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
