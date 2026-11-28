import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileModelsStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { buildApp, WebLogSink } from "../../src/web/app";
import { until } from "./fixtures/durable_host/host";
import { appWorld } from "./web_app_support";

const id = "gemini-4-fixture";
const modelId = `google/${id}`;
const key = "fixture-gemini-api-key-00001";
const signature = "Z2VtaW5pLXRvb2wtc2lnbmF0dXJl";
const auth = "/api/pi/gemini-auth";

async function geminiFixture() {
  const { root, env } = appWorld();
  const piAgent = (env.PI_CODING_AGENT_DIR = join(
    root,
    "settings",
    "pi-agent",
  ));
  env.GEMINI_API_KEY = "ambient-test-key";
  const input = join(root, "tool-input.txt");
  const requests: {
    path: string;
    key: string | null;
    header: string | null;
    body: string;
  }[] = [];
  const warnings: string[] = [];
  const mcpAuth: (string | null)[] = [];
  let held: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    held = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  const google = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/mcp") {
        mcpAuth.push(request.headers.get("authorization"));
        return new Response(null, { status: 401 });
      }
      const body = await request.text();
      const sentKey = request.headers.get("x-goog-api-key");
      requests.push({
        path,
        key: sentKey,
        header: request.headers.get("x-fixture-config"),
        body,
      });
      if (body.includes("Show the fixture HTTP error."))
        return Response.json(
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: `Fixture rejected key ${sentKey}.`,
            },
          },
          { status: 400 },
        );
      const streamedError = body.includes("Show the fixture stream error.");
      const echoed = `Fixture partial echoed ${sentKey}.`;
      const split = echoed.indexOf("-gemini");
      const chunks = streamedError
        ? [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: echoed.slice(0, split) }],
                  },
                },
              ],
            },
            {
              responseId: {
                [`fixture-field-${sentKey}`]: `fixture-response-${sentKey}`,
              },
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: echoed.slice(split) }],
                  },
                  finishReason: `Fixture stream rejected ${sentKey}.`,
                },
              ],
            },
          ]
        : [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      body.includes("Read the supplied file.") &&
                      requests.length === 1
                        ? {
                            functionCall: {
                              name: "read",
                              args: { path: input },
                            },
                            thoughtSignature: signature,
                          }
                        : { text: "NEON_TOOL_TURN_OK" },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          ];
      const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
      const gate = streamedError ? held : undefined;
      return new Response(
        gate
          ? new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode(lines[0]));
                await gate;
                controller.enqueue(new TextEncoder().encode(lines[1]));
                controller.close();
              },
            })
          : lines.join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let server:
    | Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>["serve"]>>
    | undefined;
  const close = async () => {
    await server?.close();
    await app?.instance.shutdown();
    await Promise.all(app?.detached ?? []);
    google.stop(true);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const baseUrl = new URL("v1beta", google.url).href;
    await mkdir(piAgent, { recursive: true, mode: 0o700 });
    await writeFile(input, "GEMINI_READ_THIS\n");
    await new FileModelsStore(join(piAgent, "models-store.json")).write(
      "google",
      {
        lastModified: Date.now(),
        models: [
          {
            id,
            name: "Gemini fixture",
            api: "google-generative-ai",
            provider: "google",
            baseUrl,
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: null,
            },
          },
        ],
      },
    );
    app = await buildApp({
      env,
      sink: new WebLogSink((line) => warnings.push(line)),
    });
    const running = (server = await app.serve({ port: 0 }));
    const { instance } = app;
    await until(() => instance.lifecycle.readinessSnapshot().ready);
    const api = (path: string, body?: object, method = "POST") =>
      fetch(
        `${running.url}${path}`,
        body && {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    const visible = async () => {
      const result = await api("/api/settings/model-list");
      const catalog = (await result.json()) as { models: { id: string }[] };
      return catalog.models;
    };
    const signIn = async () => {
      const response = await api(`${auth}/api-key`, { key: ` ${key} ` });
      if (response.ok)
        await until(async () =>
          (await visible()).some((model) => model.id === modelId),
        );
      return response;
    };
    const start = async () =>
      String(
        (
          await instance.create.create({
            title: "Gemini fixture",
            model: modelId,
            effort: "high",
          })
        ).id,
      );
    const send = async (cid: string, content: string, settledText: string) => {
      const response = await api(`/api/conversations/${cid}/deliver`, {
        content,
      });
      expect(response.status).toBe(200);
      await until(async () => {
        const view = await instance.durable.view(cid);
        return (
          view.turn_status === "idle" &&
          JSON.stringify(view.blocks).includes(settledText)
        );
      });
    };
    const prompt = async (cid: string) =>
      (await api(`/api/conversations/${cid}/prompt`)).text();
    const storage = (cid: string) =>
      join(
        env.CHAT_DATA_DIR!,
        "conversations",
        cid,
        "durable",
        "session.sqlite",
      );
    return {
      instance,
      api,
      signIn,
      visible,
      start,
      send,
      prompt,
      storage,
      requests,
      warnings,
      mcpAuth,
      hold,
      url: google.url,
      baseUrl,
      piAgent,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// Feature: #3696 Gemini sign-in enables native tool calls with thought signatures.
test("a Gemini Settings key runs a Neon tool turn and is removed at logout", async () => {
  const fixture = await geminiFixture();
  const { instance, api, visible, requests } = fixture;
  try {
    expect(await (await api(auth)).json()).toEqual({ configured: false });
    expect(await visible()).not.toContainEqual(
      expect.objectContaining({ id: modelId }),
    );
    expect(
      (await api(`${auth}/api-key`, { key: '{"type":"service_account"}' }))
        .status,
    ).toBe(422);
    expect(
      (await api(`${auth}/api-key`, { key: key.slice(0, 19) })).status,
    ).toBe(422);
    expect(await (await fixture.signIn()).json()).toEqual({ configured: true });
    expect(await visible()).toContainEqual({
      id: modelId,
      label: "Gemini fixture",
      route: "Gemini",
      context_window: 1_048_576,
      reasoning_levels: ["low", "medium", "high", "xhigh"],
    });
    const cid = await fixture.start();
    await fixture.send(cid, "Read the supplied file.", "NEON_TOOL_TURN_OK");
    expect(requests.map(({ path }) => path)).toEqual(
      Array(2).fill(`/v1beta/models/${id}:streamGenerateContent`),
    );
    expect(requests.every((request) => request.key === key)).toBe(true);
    expect(requests[1]!.body).toContain(signature);
    expect(requests[1]!.body).toContain("functionResponse");
    expect(requests[1]!.body).toContain("GEMINI_READ_THIS");
    expect(
      JSON.parse(requests[0]!.body).generationConfig.thinkingConfig,
    ).toMatchObject({ thinkingLevel: "HIGH" });
    const captured = await fixture.prompt(cid);
    expect(JSON.parse(captured)).toMatchObject({
      capture_status: "captured",
      request: {
        model: { provider: "google", modelId: id },
        context: {
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "toolCall",
                  name: "read",
                  thoughtSignature: signature,
                }),
              ]),
            }),
            expect.objectContaining({ role: "toolResult", toolName: "read" }),
          ]),
        },
      },
    });
    expect(captured).toContain("GEMINI_READ_THIS");
    expect(captured).not.toContain(key);
    expect(await (await api(`${auth}/logout`, {})).json()).toEqual({
      configured: false,
    });
    expect(await visible()).not.toContainEqual(
      expect.objectContaining({ id: modelId }),
    );
    expect(
      await (await instance.durable.models()).getAuth("google"),
    ).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

async function checkFailure(kind: "HTTP" | "stream", message: string) {
  const fixture = await geminiFixture();
  try {
    expect((await fixture.signIn()).ok).toBe(true);
    const cid = await fixture.start();
    await fixture.send(cid, `Show the fixture ${kind} error.`, message);
    const view = await fixture.instance.durable.view(cid);
    expect(JSON.stringify(view.blocks)).not.toContain(key);
    expect(await fixture.prompt(cid)).not.toContain(key);
    const db = fixture.storage(cid);
    const wal = Bun.file(`${db}-wal`);
    const stored =
      (await Bun.file(db).text()) +
      ((await wal.exists()) ? await wal.text() : "");
    expect(stored.includes(message)).toBe(true);
    expect(stored.includes(key)).toBe(false);
    if (kind === "stream") {
      expect(stored).toContain(
        '"responseId":{"fixture-field-[redacted]":"fixture-response-[redacted]"}',
      );
      expect(stored).toContain(`"rawStopReason":"${message}"`);
      expect(stored).toContain('"text":"Fixture partial echoed [redacted]."');
    }
    expect(fixture.warnings.join("")).not.toContain(key);
  } finally {
    await fixture.close();
  }
}

test("Gemini redacts credentials from an HTTP error", () =>
  checkFailure("HTTP", "Fixture rejected key [redacted]."));

// Regression: #3696 a credential split across Gemini text deltas cannot be rebuilt from the deltas.
test("Gemini text deltas never spell a key split across chunks", async () => {
  const fixture = await geminiFixture();
  try {
    expect((await fixture.signIn()).ok).toBe(true);
    const models = await fixture.instance.durable.models();
    const raw: unknown[] = [];
    const release = fixture.hold();
    const stream = models.streamSimple(
      models.getModel("google", id)!,
      {
        messages: [
          {
            role: "user",
            content: "Show the fixture stream error.",
            timestamp: Date.now(),
          },
        ],
      },
      { onProviderStreamEvent: (event) => void raw.push(event) },
    );
    let deltas = "";
    const partials: string[] = [];
    for await (const event of stream) {
      if ("partial" in event) partials.push(JSON.stringify(event.partial));
      if (event.type !== "text_delta") continue;
      deltas += event.delta;
      release();
    }
    const reply = await stream.result();
    expect(reply.content).toEqual([
      { type: "text", text: "Fixture partial echoed [redacted]." },
    ]);
    expect(fixture.requests.at(-1)?.body).toContain("stream error");
    expect("Fixture partial echoed [redacted].").toStartWith(deltas);
    expect(deltas).not.toContain(`echoed ${key[0]}`);
    expect(partials.join("")).not.toContain(`echoed ${key[0]}`);
    expect(JSON.stringify(raw)).not.toContain(key.slice(key.indexOf("-")));
  } finally {
    await fixture.close();
  }
});

// Regression: #3696 credentials echoed in failed Gemini response metadata cannot reach Durable storage.
test("Gemini redacts credentials from a streamed failure before persistence", () =>
  checkFailure("stream", "Fixture stream rejected [redacted]."));

test("Gemini sign-in does not set chat, effort, or review defaults", async () => {
  const fixture = await geminiFixture();
  const { instance, api } = fixture;
  const choices = async () => ({
    chat: (
      (await (await api("/api/models")).json()) as { default: string | null }
    ).default,
    levels: (
      (await (await api("/api/settings/effort-levels")).json()) as {
        levels: unknown;
      }
    ).levels,
    review: JSON.parse(
      await instance.config.safetyReview.trustedModelPolicy(modelId),
    ),
  });
  try {
    const signedOut = await choices();
    expect((await fixture.signIn()).ok).toBe(true);
    expect(await choices()).toEqual(signedOut);
    expect(
      (
        await api("/api/pi/openrouter-auth/api-key", {
          key: "fixture-openrouter-key",
        })
      ).status,
    ).toBe(200);
    const withOpenRouter = await choices();
    expect(withOpenRouter.chat).toStartWith("openrouter/");
    expect(withOpenRouter.review.reviewer.provider).toBe("openrouter");
    expect(withOpenRouter.review.summary.provider).not.toBe("google");
    expect((await api(`${auth}/logout`, {})).status).toBe(200);
    expect(await choices()).toEqual(withOpenRouter);
  } finally {
    await fixture.close();
  }
});

test("MCP cannot use the Gemini Settings key", async () => {
  const fixture = await geminiFixture();
  const { api } = fixture;
  try {
    expect((await fixture.signIn()).ok).toBe(true);
    const text = JSON.stringify({
      mcpServers: {
        fixture: {
          url: new URL("mcp", fixture.url).href,
          auth: { provider: "google" },
        },
      },
    });
    expect(
      (await api("/api/settings/mcp-servers", { text }, "PUT")).status,
    ).toBe(200);
    expect(
      (await api("/api/settings/mcp-servers/check", { name: "fixture" }))
        .status,
    ).toBe(202);
    const mcpStatus = async () =>
      (
        (await (await api("/api/settings/mcp-servers/status")).json()) as {
          servers: { state: string; reason?: string }[];
        }
      ).servers[0];
    await until(async () => (await mcpStatus())?.state === "failed");
    expect(await mcpStatus()).toMatchObject({
      reason: "needs a google sign-in in Settings",
    });
    expect(fixture.mcpAuth).not.toContain(`Bearer ${key}`);
  } finally {
    await fixture.close();
  }
});

test("Gemini sends native model headers without replacing its Settings key", async () => {
  const fixture = await geminiFixture();
  const { instance, requests } = fixture;
  try {
    expect((await fixture.signIn()).ok).toBe(true);
    const addedId = "gemini-4-added-fixture";
    await writeFile(
      join(fixture.piAgent, "models.json"),
      JSON.stringify({
        providers: {
          google: {
            models: [
              {
                id: addedId,
                headers: {
                  "x-fixture-config": "from-model-config",
                  "x-goog-api-key": "ignored-model-header",
                },
              },
            ],
          },
        },
      }),
    );
    const models = await instance.durable.models();
    const addedModel = models.getModel("google", addedId)!;
    const reply = await models.completeSimple(
      { ...addedModel, baseUrl: fixture.baseUrl },
      {
        messages: [
          {
            role: "user",
            content: "Check the configured header.",
            timestamp: Date.now(),
          },
        ],
      },
    );
    expect(reply.stopReason).toBe("stop");
    expect(requests.at(-1)).toMatchObject({
      path: `/v1beta/models/${addedId}:streamGenerateContent`,
      key,
      header: "from-model-config",
    });
  } finally {
    await fixture.close();
  }
});

// Regression: #3696 a model kept from a custom Google route cannot receive the Gemini Settings key.
test("a live custom Google route remains separate from the Gemini Settings key", async () => {
  const fixture = await geminiFixture();
  const { api, instance, visible } = fixture;
  try {
    expect((await fixture.signIn()).ok).toBe(true);
    await instance.config.models.upsertCustomProvider("google", {
      base_url: new URL("v1", fixture.url).href,
      env_key: "CUSTOM_GOOGLE_KEY",
      wire_api: "completions",
      models: [{ id: "legacy-custom" }],
    });
    const models = await instance.durable.models();
    const kept = models.getModel("google", "legacy-custom")!;
    expect(await models.getAuth("google")).toBeUndefined();
    const routes = (await (await api("/api/models")).json()) as {
      providers: { id: string; authed: boolean }[];
    };
    expect(
      routes.providers.find((provider) => provider.id === "google"),
    ).toMatchObject({ custom: true, authed: false });
    expect((await fixture.signIn()).status).toBe(409);
    await rm(instance.config.paths.MODEL_PROVIDERS_FILE);
    await instance.config.refreshSettings();
    expect(await visible()).toContainEqual(
      expect.objectContaining({ id: modelId }),
    );
    const current = await instance.durable.models();
    expect(await current.getAuth("google")).toBeDefined();
    const reply = await current.completeSimple(kept, {
      messages: [
        { role: "user", content: "Use the old route.", timestamp: Date.now() },
      ],
    });
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("Choose the model again.");
    expect(fixture.requests).toEqual([]);
  } finally {
    await fixture.close();
  }
});
