import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context as FauxContext,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { buildApp, WebLogSink } from "../../src/web/app";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { appWorld } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

type Rec = Record<string, any>;

// Feature: #2962 sidebar scripts: agent tool with dry run, history, operator undo and reset.
test("agents save checked sidebar scripts and the operator undoes and resets them", async () => {
  const { root, env } = appWorld();
  const fixture = fauxHost(join(root, "faux"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  Object.assign(
    (app.instance.durable as unknown as { deps: DurableHostDeps }).deps,
    {
      models: fake.models,
      settings: fake.settings,
      agentEnv: fake.agentEnv,
      promptSnapshot: fake.promptSnapshot,
      titleSettings: () => ["faux/faux-1", "off"],
    },
  );
  const running = await app.serve({ port: 0 });
  const url = (path: string) => `${running.url}${path}`;
  const post = (path: string, body: object, headers: Rec = {}) =>
    fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const state = async () =>
    (await (await fetch(url("/api/sidebar/script"))).json()) as Rec;
  const file = join(env.CHAT_DATA_DIR!, "config", "sidebar.js");
  let script = "";
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const create = async () =>
      String(((await (await post("/api/conversations", {})).json()) as Rec).id);
    const agent = await create();
    await create();
    const child = String(
      (
        await app.instance.create.create({
          title: "PR child",
          parent: agent,
        })
      ).id,
    );
    await app.instance.conversations.updatePrs(child, () => [
      {
        repo: "ebetica/recurse-dev",
        number: 42,
        url: "https://github.com/ebetica/recurse-dev/pull/42",
        title: "Sidebar fixture",
        state: "merged",
        checks: "pass",
        source: "created",
        detected_at: Date.now() / 1000,
      },
    ]);
    const apiAgent = (await (
      await fetch(url(`/api/v1/agents/${child}`))
    ).json()) as Rec;
    const { shells: _shells, ...stable } = apiAgent;
    script = `export default (rows) => {
      const child = rows.find((r) => r.id === "${child}");
      const expected = ${JSON.stringify(stable)};
      for (const key of Object.keys(expected)) {
        if (JSON.stringify(child[key]) !== JSON.stringify(expected[key]))
          throw new Error("Agent field mismatch: " + key);
      }
      if (child.depth !== 1 || child.remote !== false || !child.prs[0].merged)
        throw new Error("Missing sidebar extras");
      return [
        { title: "All", rows: rows.filter((r) => r.depth === 0) },
        { title: "Has PR", rows: rows.filter((r) => r.parent && r.prs.some((pr) => pr.number === 42 && pr.checks === "pass")) },
      ];
    };`;
    const initialResponse = await fetch(url("/api/sidebar/script"));
    const initial = (await initialResponse.json()) as Rec;
    const etag = initialResponse.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(initialResponse.headers.get("cache-control")).toBe(
      "private, no-cache",
    );
    expect(initial.script).toBeNull();
    expect(initial.default).toContain("export default function sidebar");
    expect(initial.history).toEqual([]);
    const unchanged = await fetch(url("/api/sidebar/script"), {
      headers: { "if-none-match": etag! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(
      (
        await fetch(url("/api/sidebar/script"), {
          headers: { "if-none-match": etag!, "x-recurse-agent": agent },
        })
      ).status,
    ).toBe(403);

    const call = (args: object) =>
      `try { text(await tools.recurse_settings(${JSON.stringify(args)})); } catch (e) { text("ERROR " + e.message); }`;
    let output = "";
    const reply = (request: FauxContext) => {
      fixture.faux.appendResponses([reply]);
      const results = request.messages.filter(
        (message) => message.role === "toolResult",
      ) as { content: { text: string }[] }[];
      if (results.length) {
        output = results[0]!.content.map((part) => part.text).join("\n");
        return fauxAssistantMessage("done");
      }
      if (JSON.stringify(request.messages).includes("<message>"))
        return fauxAssistantMessage("Title");
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "codemode",
            {
              code: [
                call({ action: "set_sidebar_script", script }),
                call({
                  action: "set_sidebar_script",
                  script: "export default () => {\n  let x = ;\n}",
                }),
                call({
                  action: "set_sidebar_script",
                  script: "export default () => { while (true) {} }",
                }),
                call({
                  action: "set_sidebar_script",
                  script: "export default () => [{ title: '' }]",
                }),
                call({
                  action: "set_sidebar_script",
                  script: `// ${"x".repeat(16 * 1024)}`,
                }),
                call({ action: "sidebar_script" }),
              ].join("\n"),
            },
            { id: "sidebar" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    };
    fixture.faux.setResponses([reply]);
    const opened = await app.instance.durable.open(agent);
    await setSafetyReviewOff(opened.conversation, true, context);
    expect(
      (await post(`/api/conversations/${agent}/deliver`, { content: "go" }))
        .status,
    ).toBe(200);
    await until(() => output !== "", 30_000);
    const parts = output.split("==> text ").slice(1);
    expect(parts[0]).toContain('"title": "All",\n      "rows": 2');
    expect(parts[0]).toContain('"title": "Has PR",\n      "rows": 1');
    expect(parts[1]).toContain(
      "ERROR SyntaxError: unexpected token in expression: ';' (line 2)",
    );
    expect(parts[2]).toContain("ERROR The script ran longer than 50 ms");
    expect(parts[3]).toContain("ERROR A section title must be non-empty text");
    expect(parts[4]).toContain("ERROR The script is over 16 KB.");
    expect(parts[5]).toContain('"custom": true');
    expect(parts[5]).toContain(`"by": "${agent}"`);

    const changed = await fetch(url("/api/sidebar/script"), {
      headers: { "if-none-match": etag! },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    const saved = (await changed.json()) as Rec;
    expect(saved.script).toBe(script);
    expect(saved.history).toMatchObject([{ by: agent, script }]);
    expect(
      (
        await post(
          "/api/sidebar/script",
          { action: "reset" },
          { "x-recurse-agent": agent },
        )
      ).status,
    ).toBe(403);
    expect((await post("/api/sidebar/script", { action: "x" })).status).toBe(
      422,
    );

    const undone = (await (
      await post("/api/sidebar/script", { action: "undo" })
    ).json()) as Rec;
    expect(undone.script).toBeNull();
    expect(undone.history.map((v: Rec) => [v.by, v.script])).toEqual([
      ["operator", null],
    ]);
    expect(existsSync(file)).toBe(false);
    expect(
      (await post("/api/sidebar/script", { action: "reset" })).status,
    ).toBe(200);
    expect((await state()).history.map((v: Rec) => v.by)).toEqual([
      "operator",
      "operator",
    ]);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    await fixture.host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
