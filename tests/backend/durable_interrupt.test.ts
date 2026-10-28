import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import {
  registerConversationRoutes,
  type ConversationsRoutesDeps,
} from "../../src/web/conversations";
import { Router, type Exchange } from "../../src/web/router";
import { held, idle, testDeps, until } from "./fixtures/durable_host/host";

const root = mkdtempSync(join(tmpdir(), "durable-interrupt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function world() {
  const dir = mkdtempSync(join(root, "host-"));
  const record = {
    id: "c1",
    backend: "durable",
    workdir: dir,
    model: "faux/faux-1",
  };
  const faux = fauxProvider({
    tokensPerSecond: 20_000,
    models: [{ id: "faux-1" }, { id: "faux-2" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const host = new DurableHost({
    ...testDeps(
      dir,
      () => record,
      () => ["c1"],
    ),
    settings: () => [record.model, "off"],
    models,
  });
  const router = new Router();
  registerConversationRoutes(router, {
    store: { load: () => record },
    durable: host,
    delivery: {
      deliver: (cid: string, text: string) =>
        host.send(cid, text, crypto.randomUUID()),
      requestRun: () => undefined,
    },
  } as unknown as ConversationsRoutesDeps);
  const deliver = async (content: string) => {
    const url = new URL("http://localhost/api/conversations/c1/deliver");
    return router.handle({
      request: new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, interrupt: true }),
      }),
      url,
      path: url.pathname,
      params: {},
      query: {},
      state: {},
      bodyLimit: null,
      route: null,
      client: null,
      scheme: "http",
      disableTimeout() {},
    } satisfies Exchange);
  };
  return { host, faux, record, deliver, router, dir };
}

// Regression: #2249 idle interrupt falsely reported a stopped turn
test("idle interrupt delivers the message but reports no running turn stopped", async () => {
  const { host, faux, deliver } = world();
  faux.setResponses([fauxAssistantMessage("fresh reply")]);
  try {
    const response = await deliver("start fresh");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      interrupted: false,
      message_id: expect.any(String),
    });
    await until(async () =>
      JSON.stringify((await host.view("c1")).blocks).includes("fresh reply"),
    );
    await until(idle(host));
    const view = await host.view("c1");
    expect(JSON.stringify(view.blocks)).toContain("start fresh");
    expect(JSON.stringify(view.blocks)).toContain("fresh reply");
  } finally {
    await host.close();
  }
});

test("model change preserves the live Stop identity and queued input uses the new model", async () => {
  const { host, faux, record } = world();
  const first = held(fauxAssistantMessage("aborted reply"));
  const second = held(fauxAssistantMessage("new model reply"));
  let servedModel: string | undefined;
  faux.setResponses([
    first.step,
    (request, options, state, model) => {
      servedModel = model.id;
      return typeof second.step === "function"
        ? second.step(request, options, state, model)
        : second.step;
    },
  ]);
  try {
    await host.send("c1", "first", "r1");
    await first.started;
    const run = host.liveStatus("c1")[1]!;
    expect(run).toBeString();
    record.model = "faux/faux-2";
    await host.send("c1", "queued", "r2");
    expect(host.liveStatus("c1")[1]).toBe(run);
    expect(await host.stop("c1", run)).toBe(true);
    await second.started;
    expect(servedModel).toBe("faux-2");
    second.release();
    await until(async () =>
      JSON.stringify((await host.view("c1")).blocks).includes(
        "new model reply",
      ),
    );
    await until(idle(host));
    const view = JSON.stringify((await host.view("c1")).blocks);
    expect(view).toContain("queued");
    expect(view).toContain("new model reply");
    expect(view).not.toContain("aborted reply");
    expect(faux.state.callCount).toBe(2);
  } finally {
    first.release();
    second.release();
    await host.close();
  }
});

// Regression: #2249 interrupt CLI inferred result from stale status
test("CLI reports the delivery result rather than its earlier status read", async () => {
  const { host, faux, router, dir } = world();
  mkdirSync(join(dir, "conversations"), { recursive: true });
  writeFileSync(
    join(dir, "conversations", "c1.json"),
    JSON.stringify({ id: "c1", status: "running", active_run: "stale" }),
  );
  router.get("/api/subagent-tool/conversations", async () =>
    Response.json({ conversations: [{ id: "c1" }], complete: true }),
  );
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      return router.handle({
        request,
        url,
        path: url.pathname,
        params: {},
        query: {},
        state: {},
        bodyLimit: null,
        route: null,
        client: null,
        scheme: "http",
        disableTimeout() {},
      });
    },
  });
  writeFileSync(
    join(dir, "server.json"),
    JSON.stringify({ port: server.port, token: "test-token" }),
  );
  const first = held(fauxAssistantMessage("aborted"));
  faux.setResponses([
    fauxAssistantMessage("fresh"),
    first.step,
    fauxAssistantMessage("replacement"),
  ]);
  const send = async () => {
    const proc = Bun.spawn(
      [
        "bun",
        resolve(import.meta.dir, "../../tools/subagent.ts"),
        "send",
        "c1",
        "replacement",
        "--interrupt",
      ],
      {
        env: { ...process.env, CHAT_DATA_DIR: dir, RECURSE_AGENT_ID: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(err).toBe("");
    expect(await proc.exited).toBe(0);
    return out;
  };
  try {
    expect(await send()).toContain(
      "There was no running turn to stop; the message will start fresh.",
    );
    await until(async () =>
      JSON.stringify((await host.view("c1")).blocks).includes("fresh"),
    );
    await until(idle(host));
    await host.send("c1", "block", "blocked");
    await first.started;
    expect(await send()).toContain(
      "Stopped the running turn; the message will run next.",
    );
    await until(idle(host));
  } finally {
    first.release();
    server.stop(true);
    await host.close();
  }
});
