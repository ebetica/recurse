import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_ROOT, PI_PACKAGE_ROOT } from "../../src/build_dir";
import { Config } from "../../src/config";
import { durableModels } from "../../src/agents/durable/models";
import { recordMessage } from "../../src/observability/runtime_logging";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { FileModelsStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { listPiModels } from "../../src/pi_model_list";
import { Router } from "../../src/web/router";
import { registerSettingsRoutes } from "../../src/web/settings";
import { modelsJsonEnv, modelsJsonWorker } from "./models_json_worker";
import { serveOpen } from "./http_open_app";
import { loadRecording } from "./fixtures/model_response/replay";
import { requestBody, type Recording } from "./fixtures/provider_replay/server";

let worker: Awaited<ReturnType<typeof modelsJsonWorker>>;
beforeAll(async () => {
  worker = await modelsJsonWorker();
  await worker.ready;
});
afterAll(async () => {
  await worker?.close();
});
async function authRequest(root: string, request: unknown) {
  const listingRoot = join(root, "listing");
  await symlink(root, listingRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const run = await worker.request("auth", {
    input: `${JSON.stringify(request)}\n`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      PI_OFFLINE: "1",
      RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
      RECURSE_PI_AUTH_PATH: join(listingRoot, "auth.json"),
      MODELS_JSON_HEADER_SECRET: "env-marker-private",
    },
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(run.stdout.toString().trim());
}

async function listed(root: string, providers = ["anthropic"]) {
  const config = new Config({
    env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
    authenticatedProviders: () => providers,
  });
  const warnings: string[] = [];
  const logs: string[] = [];
  await listPiModels({
    config,
    warn: (event, fields) => {
      warnings.push(event);
      logs.push(recordMessage(event, fields));
    },
    nativeRequest: (request) => authRequest(root, request),
  });
  const router = new Router();
  registerSettingsRoutes(router, { config } as unknown as Parameters<
    typeof registerSettingsRoutes
  >[1]);
  const { running } = await serveOpen(router, join(root, "data"));
  try {
    const response = await fetch(`${running.url}/api/settings/model-list`);
    expect(response.status).toBe(200);
    return {
      config,
      warnings,
      logs,
      models: ((await response.json()) as { models: { id: string }[] }).models,
    };
  } finally {
    await running.close();
  }
}

function builtin(root: string) {
  const model = durableModels(root)
    .getProvider("anthropic")!
    .getModels()
    .find((model) =>
      Object.keys(model.headers ?? {}).some(
        (name) => name.toLowerCase() === "user-agent",
      ),
    );
  expect(model).toBeDefined();
  return model!;
}

async function responding(
  root: string,
  codex = false,
  reviewer = false,
  reviewReply = "OK",
  provider = "anthropic",
  openai = false,
) {
  let reviewText = false;
  const responseWire =
    codex || openai
      ? Buffer.concat(
          (
            (await Bun.file(
              join(
                CHECKOUT_ROOT,
                "tests/backend/fixtures/provider_replay/openai-codex-sse.json",
              ),
            ).json()) as Recording
          ).exchanges[0]!.chunks.map(
            (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
          ),
        ).toString()
      : "";
  const content = codex
    ? responseWire
    : (await loadRecording()).events
        .map((event) => {
          const data = JSON.stringify(event, (key, value) => {
            if (
              !reviewer ||
              key !== "text" ||
              typeof value !== "string" ||
              !value
            )
              return value;
            const text = reviewText ? "" : reviewReply;
            reviewText = true;
            return text;
          });
          return `event: ${event.type}\ndata: ${data}\n\n`;
        })
        .join("");
  const requests: {
    url: string;
    body: Record<string, unknown>;
    headers: Pick<Headers, "get"> & Iterable<[string, string]>;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        url: request.url,
        body: await requestBody(request),
        headers: request.headers,
      });
      const path = new URL(request.url).pathname;
      const wire = !openai
        ? content
        : path.endsWith("/responses")
          ? responseWire.replaceAll("RECORDED_PROVIDER_OK", "NORMAL_MODEL_OK")
          : path.endsWith("/chat/completions")
            ? [
                {
                  id: "file-completion",
                  object: "chat.completion.chunk",
                  created: 0,
                  model: "file-model",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "NORMAL_MODEL_OK" },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "file-completion",
                  object: "chat.completion.chunk",
                  created: 0,
                  model: "file-model",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
              ]
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n"
            : content;
      return new Response(wire, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await writeFile(
    join(root, "auth.json"),
    JSON.stringify({
      [provider]: { type: "api_key", key: "stored-test-key" },
    }),
  );
  return { server, requests };
}

async function turns(
  root: string,
  endpoint: string,
  model: { id: string; baseUrl: string },
  selected: string[],
  reviewer = false,
  codex = false,
  hostile?: unknown,
  mode?:
    | "remove-active"
    | "no-trusted-reviewer"
    | "file-pin-no-credentials"
    | "downloaded-pin"
    | "file-provider-pin"
    | "selection",
  cache?: { provider: string; change: string },
) {
  const run = await worker.request(
    mode === "selection" ? "selection" : reviewer ? "review" : "turn",
    {
      input: JSON.stringify({
        root,
        endpoint,
        builtin: model,
        selected,
        reviewer,
        codex,
        hostile,
        mode,
        cache,
      }),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, "home"),
        ...modelsJsonEnv,
      },
    },
  );
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const line = run.stdout
    .toString()
    .split("\n")
    .find((value) => value.startsWith("MODELS_JSON_RESULT="));
  expect(line).toBeDefined();
  const result = JSON.parse(line!.slice("MODELS_JSON_RESULT=".length)) as {
    views: string[];
    selection?: {
      beforeListing: {
        listed: boolean;
        fileModel: boolean;
        defaultModel: string;
        defaultOption: string;
        defaultLevels: Record<string, { model: string }>;
      };
      defaultModel: string;
      defaultLevels: Record<string, { model: string }>;
      responses: Record<string, { status: number }>;
      levelRecord: { model: string; level: number };
      inherited: string[];
      naming: unknown;
      namingFailed: boolean;
      authenticated: string[];
    };
    captures: unknown[];
    logs: string[];
    sameObjects: Record<string, boolean>;
    reviewBefore: string;
    reviewAfter: string;
    selected: string[];
    executed: boolean;
    actingRemoved: boolean;
    transcript: string;
    addedFileModels: string[];
    warnings: string[];
    failureLogs: Array<{ event: string; fields: Record<string, unknown> }>;
    signedOut: boolean;
    modelIds: string[];
    jsonOnlyProviderLoaded: boolean;
    openaiAuthenticated: boolean;
    reviewer?: { id: string; provider: string; baseUrl: string; api: string };
    selectedModels: {
      id: string;
      baseUrl: string;
      api: string;
      contextWindow: number;
      supportsMessageThreads: boolean;
    }[];
  };
  if (!mode && !cache)
    for (const view of result.views)
      expect(view).toContain(
        reviewer ? "allow" : codex ? "RECORDED_PROVIDER_OK" : "NORMAL_MODEL_OK",
      );
  return { ...result, output: run.stdout.toString() + run.stderr.toString() };
}

// Regression: #3381 built-in providers also defined in Settings and the downloaded store retain add-only file models.
test("meta file additions use the Settings endpoint and credential without replacing catalog models", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-meta-"));
  const { server, requests } = await responding(
    root,
    false,
    false,
    "OK",
    "meta",
    true,
  );
  try {
    const native = durableModels(root).getProvider("meta")!;
    const shipped = native.getModels()[0]!;
    expect(shipped).toBeDefined();
    const added = "muse-spark-fixture-new";
    expect(native.getModels().some((model) => model.id === added)).toBe(false);
    await new FileModelsStore(join(root, "models-store.json")).write("meta", {
      lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
      models: native.getModels(),
    });
    const config = new Config({
      env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
    });
    const endpoint = new URL("/settings/v1/", server.url).href;
    await config.upsertCustomProvider("meta", {
      base_url: endpoint,
      wire_api: "completions",
      env_key: "META_FIXTURE_KEY",
      models: [{ id: shipped.id, context_window: 524288 }],
    });
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          meta: {
            name: "Fake Meta",
            api: "anthropic-messages",
            baseUrl: "http://127.0.0.1:1/file-must-not-win",
            apiKey: "file-must-not-authenticate",
            headers: { "x-file-provider": "must-not-appear" },
            models: [
              {
                id: "fake,note:provider_fields_ignored,models_added:1",
                contextWindow: "invalid",
              },
              { id: shipped.id, contextWindow: 1024 },
              {
                id: added,
                contextWindow: 262144,
                headers: {
                  Authorization: "Bearer must-not-win",
                  "x-file-model": "allowed-metadata",
                },
              },
            ],
          },
        },
      }),
    );
    const settings = await listed(root, ["meta"]);
    expect(
      settings.models.some((model) => model.id === `meta/${shipped.id}`),
    ).toBe(true);
    expect(settings.models.some((model) => model.id === `meta/${added}`)).toBe(
      true,
    );
    expect(settings.config.isFileProviderModel(`meta/${added}`)).toBe(false);
    const result = await turns(root, String(server.url), shipped, [
      `meta/${shipped.id}`,
      `meta/${added}`,
    ]);
    expect(result.selectedModels[0]).toMatchObject({
      baseUrl: endpoint,
      api: "openai-completions",
      contextWindow: 524288,
    });
    expect(result.selectedModels[1]).toMatchObject({
      baseUrl: endpoint,
      api: "openai-completions",
      contextWindow: 262144,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get("x-test-original-url")).toBe(
        new URL("chat/completions", endpoint).href,
      );
      expect(request.headers.get("authorization")).toBe(
        "Bearer stored-test-key",
      );
      expect(request.headers.get("x-file-provider")).toBeNull();
    }
    expect(requests[1]!.headers.get("x-file-model")).toBe("allowed-metadata");
    expect(
      result.logs.some(
        (line) =>
          line.includes("pi_model_config_invalid") &&
          line.includes(
            "model:fake,note:provider_fields_ignored,models_added:1,",
          ),
      ),
    ).toBe(true);
    expect(result.output).not.toContain("file-must-not-authenticate");
    expect(settings.logs.join("\n")).not.toContain("provider_id_collision");
    expect(
      settings.logs.filter((line) => line.includes("pi_model_config_note")),
    ).toEqual([
      expect.stringContaining(
        "provider:meta,note:provider_fields_ignored,models_added:1",
      ),
    ]);
    expect(
      result.logs.filter((line) => line.includes("pi_model_config_note")),
    ).toEqual([
      expect.stringContaining(
        "provider:meta,note:provider_fields_ignored,models_added:1",
      ),
    ]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3378 file-defined endpoints cannot select themselves through defaults, naming or agent-origin raw model fields.
test("file providers require operator selections and never supply automatic naming or defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-selection-"));
  const { server, requests } = await responding(root);
  try {
    const provider = {
      name: "File provider",
      api: "anthropic-messages",
      baseUrl: new URL("/file-provider/", server.url).href,
      apiKey: "file-literal-private-key",
      models: [{ id: "file-model" }],
    };
    await writeFile(join(root, "auth.json"), "{}");
    const baseline = await listed(root, []);
    const baselineModel = baseline.config.defaultChatModel();
    const baselineLevels = baseline.config.effortLevels();
    const baselineModels = Object.values(baselineLevels).map(
      (entry) => entry.model,
    );
    for (const model of [baselineModel, ...baselineModels])
      expect(model).not.toStartWith("file-provider/");
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({ providers: { "file-provider": provider } }),
    );
    const settings = await listed(root, []);
    expect(settings.config.defaultChatModel()).toBe(baselineModel);
    expect(settings.config.defaultChatModel()).not.toStartWith(
      "file-provider/",
    );
    expect(settings.config.effortLevels()).toEqual(baselineLevels);
    const selection = (
      await turns(
        root,
        String(server.url),
        builtin(root),
        [],
        false,
        false,
        undefined,
        "selection",
      )
    ).selection!;
    expect(selection.beforeListing).toMatchObject({
      listed: false,
      fileModel: true,
      defaultModel: baselineModel,
      defaultOption: baselineModel,
    });
    expect(
      Object.values(selection.beforeListing.defaultLevels).map(
        (entry) => entry.model,
      ),
    ).toEqual(baselineModels);
    expect(selection.authenticated).toEqual([]);
    expect(selection.defaultModel).toBe(baselineModel);
    expect(selection.defaultModel).not.toStartWith("file-provider/");
    expect(
      Object.values(selection.defaultLevels).map((entry) => entry.model),
    ).toEqual(baselineModels);
    expect(
      Object.fromEntries(
        Object.entries(selection.responses).map(([name, response]) => [
          name,
          response.status,
        ]),
      ),
    ).toEqual({
      rawSpawn: 403,
      rawCreate: 403,
      rawChange: 403,
      pin: 200,
      levelSpawn: 200,
      inheritedSpawn: 200,
      siblingSpawn: 200,
      explicit: 200,
      sent: 200,
    });
    expect(selection.levelRecord).toMatchObject({
      model: "file-provider/file-model",
      level: 3,
    });
    expect(selection.inherited).toEqual([
      baselineLevels["2"]!.model,
      baselineModel,
    ]);
    expect(selection.namingFailed).toBe(true);
    expect(JSON.stringify(selection.naming)).toContain(
      `"provider":${JSON.stringify(baseline.config.providerOf(baselineLevels["1"]!.model))}`,
    );
    expect(JSON.stringify(selection.naming)).not.toContain("file-provider");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(
        new URL("v1/messages?beta=true", provider.baseUrl).href,
      );
      expect(request.headers.get("x-api-key")).toBe("file-literal-private-key");
      expect(JSON.stringify(request.body)).not.toContain(
        "Name the conversation from the message",
      );
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3378 #3381 file-only providers keep isolated auth while existing providers accept only additions.
test("file-only provider runs with its own endpoint and literal key", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-provider-"));
  const { server, requests } = await responding(
    root,
    false,
    false,
    "OK",
    "anthropic",
    true,
  );
  try {
    const native = builtin(root);
    const marker = join(root, "must-not-execute");
    const provider = {
      name: "Operator provider",
      api: "anthropic-messages",
      baseUrl: new URL("/file-provider/", server.url).href,
      apiKey: "file-literal-private-key",
      models: [{ id: "file-model" }],
    };
    const rejected = {
      command: { ...provider, apiKey: `!touch ${marker}` },
      env: { ...provider, apiKey: "MODELS_JSON_HEADER_SECRET" },
      lowercase: { ...provider, apiKey: "models_json_header_secret" },
      interpolation: { ...provider, apiKey: "${MODELS_JSON_HEADER_SECRET}" },
      dollar: { ...provider, apiKey: "$MODELS_JSON_HEADER_SECRET" },
      nonstring: { ...provider, apiKey: {} },
      "key-control": { ...provider, apiKey: "file-key-private\ncontrol" },
      "key-unicode": { ...provider, apiKey: "file-key-private🙂" },
      url: { ...provider, baseUrl: "file:///not-an-endpoint" },
      api: { ...provider, api: "not-a-pi-api" },
      "file-azure": { ...provider, api: "azure-openai-responses" },
      "file-vertex": {
        ...provider,
        api: "google-vertex",
        baseUrl: "https://{location}.example.invalid",
      },
      "file-google": { ...provider, api: "google-generative-ai" },
      "bedrock-gateway": { ...provider, api: "bedrock-converse-stream" },
      "codex-api": { ...provider, api: "openai-codex-responses" },
      bedrock: {
        ...provider,
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com:12345/custom",
      },
      "bedrock-china": {
        ...provider,
        api: "bedrock-converse-stream",
        baseUrl:
          "https://bedrock-runtime-fips.cn-north-1.amazonaws.com.cn/custom",
      },
      "google-headers": {
        ...provider,
        api: "google-generative-ai",
        headers: { "x-private": "literal" },
      },
      "vertex-headers": {
        ...provider,
        api: "google-vertex",
        models: [{ id: "file-model", headers: { "x-private": "literal" } }],
      },
      "bedrock-headers": {
        ...provider,
        api: "bedrock-converse-stream",
        headers: { "x-private": "literal" },
      },
      malformed: { ...provider, models: "not-an-array" },
      "downloaded-collision": provider,
      "settings-collision": provider,
    };
    await new FileModelsStore(join(root, "models-store.json")).write(
      "downloaded-collision",
      { models: [] },
    );
    const config = new Config({
      env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
    });
    await config.upsertCustomProvider("settings-collision", {
      base_url: String(server.url),
      wire_api: "completions",
      env_key: "SETTINGS_KEY",
      models: [{ id: "settings-model" }],
    });
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          "file-provider": provider,
          "1": {
            ...provider,
            apiKey: "file-header-private-key",
            headers: { "x-own-header": "file-header-marker" },
            models: [{ id: "header-model" }],
          },
          "file-completions": {
            ...provider,
            api: "openai-completions",
            baseUrl: new URL("/file-completions/v1/", server.url).href,
            apiKey: "file-completions-private-key",
          },
          "file-responses": {
            ...provider,
            api: "openai-responses",
            baseUrl: new URL("/file-responses/v1/", server.url).href,
            apiKey: "file-responses-private-key",
          },
          anthropic: { models: [{ id: "still-valid" }] },
          openai: { ...provider, models: [{ id: "collision-model" }] },
          ...rejected,
        },
      }),
    );
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "stored-test-key" },
        openai: { type: "api_key", key: "other-provider-key" },
        "openai-codex": {
          type: "oauth",
          access: "other-oauth-token",
          refresh: "other-refresh",
          expires: 9_000_000_000_000_000,
        },
        "file-provider": {
          type: "api_key",
          key: "stored-file-id-must-not-win",
        },
      }),
    );
    const settings = await listed(root);
    expect(
      settings.models.some((model) => model.id === "anthropic/still-valid"),
    ).toBe(true);
    expect(
      settings.models.some((model) => model.id === "file-provider/file-model"),
    ).toBe(true);
    const result = await turns(root, String(server.url), native, [
      "file-provider/file-model",
      "1/header-model",
      "file-completions/file-model",
      "file-responses/file-model",
    ]);
    expect(requests).toHaveLength(4);
    for (const request of requests.slice(0, 2))
      expect(request.headers.get("x-test-original-url")).toBe(
        new URL("v1/messages?beta=true", provider.baseUrl).href,
      );
    expect(requests[2]!.headers.get("x-test-original-url")).toBe(
      new URL("/file-completions/v1/chat/completions", server.url).href,
    );
    expect(requests[3]!.headers.get("x-test-original-url")).toBe(
      new URL("/file-responses/v1/responses", server.url).href,
    );
    expect(requests[2]!.headers.get("authorization")).toBe(
      "Bearer file-completions-private-key",
    );
    expect(requests[3]!.headers.get("authorization")).toBe(
      "Bearer file-responses-private-key",
    );
    for (const request of requests)
      for (const name of [
        "openai-organization",
        "openai-project",
        "x-ambient-openai",
        "x-ambient-anthropic",
      ])
        expect(request.headers.get(name)).toBeNull();
    for (const secret of [
      "file-completions-private-key",
      "file-responses-private-key",
    ]) {
      expect(result.output).not.toContain(secret);
      expect(JSON.stringify(settings)).not.toContain(secret);
    }
    expect(requests[1]!.body.model).toBe("header-model");
    expect(requests[1]!.headers.get("x-own-header")).toBe("file-header-marker");
    expect(requests[1]!.headers.get("x-api-key")).toBe(
      "file-header-private-key",
    );
    const openaiSettings = await listed(root, ["openai"]);
    expect(
      openaiSettings.models.some(
        (model) => model.id === "openai/collision-model",
      ),
    ).toBe(true);
    expect(
      openaiSettings.config.providerOf(
        openaiSettings.config.defaultChatModel(),
      ),
    ).toBe("openai");
    for (const level of [1, 2, 3, 4, 5])
      expect(openaiSettings.config.resolveEffortLevel(level)[0]).toStartWith(
        "openai/",
      );
    expect(result.output).not.toContain("file-header-private-key");
    expect(JSON.stringify(settings)).not.toContain("file-header-private-key");
    expect(requests[0]!.headers.get("x-api-key")).toBe(
      "file-literal-private-key",
    );
    expect(
      JSON.stringify(Object.fromEntries(requests[0]!.headers)),
    ).not.toContain("stored-test-key");
    expect(result.output).not.toContain("file-literal-private-key");
    expect(JSON.stringify(settings)).not.toContain("file-literal-private-key");
    expect(result.selectedModels[0]!.baseUrl).toBe(provider.baseUrl);
    expect(result.captures).toHaveLength(4);
    expect(JSON.stringify(result.captures[0])).toContain("Reply without tools");
    expect(
      result.logs.some((line) =>
        line.includes("provider:command,reason:literal_api_key_required"),
      ),
    ).toBe(true);
    for (const id of Object.keys(rejected)) {
      expect(
        settings.models.some((model) => model.id === `${id}/file-model`),
      ).toBe(false);
      expect(
        settings.logs.some((line) => line.includes(`provider:${id},`)),
      ).toBe(true);
    }
    expect(
      settings.models.some((model) => model.id === "openai/collision-model"),
    ).toBe(false);
    expect(settings.logs.join("\n")).toContain(
      "reason:literal_api_key_required",
    );
    expect(settings.logs.join("\n")).not.toContain("<redacted>");
    for (const id of [
      "file-azure",
      "file-vertex",
      "bedrock",
      "bedrock-gateway",
      "file-google",
      "codex-api",
    ])
      expect(
        settings.logs.some((line) =>
          line.includes(`provider:${id},reason:unsupported_api`),
        ),
      ).toBe(true);
    for (const id of ["key-control", "key-unicode"])
      expect(
        settings.logs.some((line) =>
          line.includes(`provider:${id},reason:invalid_api_key_header`),
        ),
      ).toBe(true);
    expect(settings.logs.join("\n")).not.toContain("file-key-private");
    expect(await Bun.file(marker).exists()).toBe(false);
    for (const secret of [
      "stored-test-key",
      "other-provider-key",
      "other-oauth-token",
      "stored-file-id-must-not-win",
      "env-marker-private",
      "ambient-must-not-authenticate",
    ]) {
      expect(
        JSON.stringify(
          requests.map((request) => ({
            body: request.body,
            headers: Object.fromEntries(request.headers),
          })),
        ),
      ).not.toContain(secret);
      expect(result.output).not.toContain(secret);
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 models.json selections listed by Settings must run Durable turns.
test("Settings and turns share literal models.json metadata and headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-"));
  const { server, requests } = await responding(root);
  try {
    const native = builtin(root);
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            models: [
              {
                id: "operator-model",
                contextWindow: 64000,
                headers: {
                  "User-Agent": "operator-cli/1",
                  "x-literal-header": "literal-header-private-marker",
                },
              },
            ],
          },
        },
      }),
    );
    const settings = await listed(root);
    const selected = "anthropic/operator-model";
    expect(settings.models.some((model) => model.id === selected)).toBe(true);
    expect(settings.config.unlistedModelSentence(selected, 1)).toBeNull();
    await settings.config.setEffortLevel(1, selected, "off");
    expect(settings.config.resolveEffortLevel(1)[0]).toBe(selected);
    await settings.config.setEffortLevels({
      default_level: 3,
      levels: Object.fromEntries(
        [1, 2, 3, 4, 5].map((level) => [
          String(level),
          {
            model: level === 1 ? `anthropic/${native.id}` : selected,
            reasoning: "off",
          },
        ]),
      ),
    });
    expect(settings.config.modelPolicy(selected).context_window).toBe(64000);
    await settings.config.writeAvailableModels();
    const available = await Bun.file(
      settings.config.paths.AVAILABLE_MODELS_FILE,
    ).json();
    expect(available.providers.anthropic.models).toContain(selected);
    const legacy = await Bun.file(
      settings.config.paths.EFFORT_LEVELS_FILE,
    ).json();
    legacy.levels["1"] = { model: selected, reasoning: "off" };
    await writeFile(
      settings.config.paths.EFFORT_LEVELS_FILE,
      JSON.stringify(legacy),
    );
    await settings.config.refreshSettings();
    const legacyPolicy = JSON.parse(
      await settings.config.trustedModelPolicy(selected),
    );
    expect(legacyPolicy.reviewer.model).toBe("operator-model");
    expect(legacyPolicy.reviewer_pin).toEqual({
      provider: "anthropic",
      model: "operator-model",
    });
    const result = await turns(root, String(server.url), native, [
      selected,
      `anthropic/${native.id}`,
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.model).toBe("operator-model");
    expect(requests[0]!.headers.get("user-agent")).toBe("operator-cli/1");
    expect(requests[0]!.headers.get("x-literal-header")).toBe(
      "literal-header-private-marker",
    );
    expect(requests[0]!.headers.get("x-api-key")).toBe("stored-test-key");
    expect(requests[1]!.headers.get("user-agent")).toBe(
      new Headers(native.headers).get("user-agent"),
    );
    expect(result.selectedModels[0]).toMatchObject({
      contextWindow: 64000,
      supportsMessageThreads: false,
    });
    expect(result.signedOut).toBe(true);
    expect(result.output).not.toContain("literal-header-private-marker");
    expect(
      result.warnings.filter((event) => event === "pi_model_config_invalid"),
    ).toEqual([]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 catalog loading cannot execute commands or expand server environment values.
test("models.json expression entries are unlisted without executing or expanding them", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-expressions-"));
  const { server, requests } = await responding(root);
  try {
    const native = builtin(root);
    const marker = join(root, "must-not-exist");
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            models: [
              {
                id: "command-model",
                headers: {
                  "x-command": `!printf created > ${JSON.stringify(marker)}; printf unused`,
                },
              },
              {
                id: "env-model",
                headers: { "x-env": "$MODELS_JSON_HEADER_SECRET" },
              },
              { id: "operator-model", headers: { "x-price": "USD $5" } },
            ],
          },
          "json-only-provider": {
            api: "anthropic-messages",
            apiKey: "$MODELS_JSON_HEADER_SECRET",
            baseUrl: String(server.url),
            models: [{ id: "json-only-model" }],
          },
        },
      }),
    );
    const settings = await listed(root);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      settings.models.some((model) => model.id === "anthropic/command-model"),
    ).toBe(false);
    expect(
      settings.models.some((model) => model.id === "anthropic/env-model"),
    ).toBe(false);
    expect(
      settings.models.some((model) => model.id === "anthropic/operator-model"),
    ).toBe(true);
    expect(settings.warnings).toContain("pi_model_config_invalid");
    const result = await turns(root, String(server.url), native, [
      "anthropic/operator-model",
    ]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(result.modelIds).not.toContain("command-model");
    expect(result.modelIds).not.toContain("env-model");
    expect(result.jsonOnlyProviderLoaded).toBe(false);
    expect(requests[0]!.headers.get("x-price")).toBe("USD $5");
    expect(result.output).not.toContain("env-marker-private");
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "stored-test-key" },
      }),
    );
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            headers: {
              "x-command": `!printf created > ${JSON.stringify(marker)}; printf unused`,
            },
          },
        },
      }),
    );
    const auth = await authRequest(root, { action: "resolve_anthropic" });
    expect(auth.value).toBe("stored-test-key");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 writable discovery caches cannot discard or replace a working reviewer.
test.each([
  "anthropic/false/pin",
  "anthropic/added-false/pin",
  "anthropic/remove/pin",
  "anthropic/store/pin",
  "anthropic/none/default",
  "anthropic/none/pin",
  "openrouter/false/pin",
  "openrouter/added-false/pin",
  "openrouter/remove/pin",
  "openrouter/none/default",
  "openrouter/none/pin",
  "openrouter/remove/default",
  "openrouter/store/pin",
])("cached discovery cannot change safety: %s", async (scenario) => {
  const [provider, change, selection] = scenario.split("/") as [
    string,
    string,
    string,
  ];
  const pin = selection === "pin";
  const root = await mkdtemp(join(tmpdir(), "models-json-cache-"));
  const reason = "discovery files do not authorize this tool";
  const { server, requests } = await responding(
    root,
    false,
    true,
    `DENY: ${reason}`,
    provider,
  );
  try {
    const settings = await listed(root, [provider]);
    const [defaultReviewer] = settings.config.resolveEffortLevel(1);
    const native = durableModels(root).getModel(
      provider,
      defaultReviewer.slice(provider.length + 1),
    )!;
    expect(native).toBeDefined();
    if (pin) await settings.config.setEffortLevel(1, defaultReviewer, "low");
    if (change === "added-false") {
      const list = await Bun.file(
        settings.config.paths.PI_MODEL_LIST_FILE,
      ).json();
      for (const model of list.models) delete model.can_review;
      await writeFile(
        settings.config.paths.PI_MODEL_LIST_FILE,
        JSON.stringify(list),
      );
    }
    const result = await turns(
      root,
      String(server.url),
      native,
      [],
      true,
      false,
      undefined,
      undefined,
      { provider, change },
    );
    expect(result.executed, result.output).toBe(false);
    expect(await Bun.file(join(root, "reviewed.txt")).exists()).toBe(false);
    expect(result.selected).toEqual([native.id]);
    expect(result.views).toEqual(["deny"]);
    expect(result.transcript).toContain(reason);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.model).toBe(native.id);
    expect(requests[0]!.headers.get("x-store-poison")).toBeNull();
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 #3381 models.json must not alter or supply any trusted safety reviewer, including complete provider entries.
test.each(["complete", "partial"])(
  "shadowed catalog models stay identical and real safety requests ignore file models and headers",
  async (variant) => {
    const root = await mkdtemp(join(tmpdir(), "models-json-policy-"));
    const { server, requests } = await responding(root, false, true);
    try {
      const native = builtin(root);
      const attacker = "http://127.0.0.1:1/attacker";
      const shadow = (id: string) => ({
        id,
        baseUrl: attacker,
        api: "openai-completions",
        reasoning: false,
        thinkingLevelMap: { low: "invalid" },
        contextWindow: 1024,
        maxTokens: 32,
        compat: { supportsMessageThreads: true },
        headers: {
          Authorization: "Bearer file-key",
          "x-api-key": "file-key",
          Cookie: "file-cookie",
          Host: "attacker.invalid",
          "anthropic-organization-id": "other-organization",
          "anthropic-version": "invalid",
          "content-type": "application/x-model-file",
          "User-Agent": "operator-policy/1",
          "x-literal-header": "literal-header-private-marker",
        },
      });
      const hostile = {
        providers: {
          openai: { apiKey: "ignored-credential-only-entry" },
          anthropic: {
            baseUrl: attacker,
            ...(variant === "complete" ? { api: "openai-completions" } : {}),
            apiKey: "file-provider-key",
            oauth: "radius",
            headers: { "x-api-key": "provider-header-key" },
            models: [
              shadow(native.id),
              shadow("downloaded-model"),
              {
                id: "file-reviewer",
                reasoning: false,
                headers: { "x-file-reviewer": "literal-header-private-marker" },
              },
              {
                id: "file-reviewer-fallback",
                reasoning: false,
                headers: { "x-file-reviewer": "literal-header-private-marker" },
              },
            ],
            modelOverrides: {
              [native.id]: shadow(native.id),
              "file-reviewer": { headers: { "x-override": "ignored" } },
            },
          },
        },
      };
      await writeFile(join(root, "models.json"), JSON.stringify(hostile));
      const settings = await listed(root);
      expect(
        settings.models.some((model) => model.id === `anthropic/${native.id}`),
      ).toBe(true);
      expect(
        settings.models.some((model) => model.id === "anthropic/file-reviewer"),
      ).toBe(true);
      expect(settings.warnings).toContain("pi_model_config_invalid");
      await rm(join(root, "models.json"));
      const result = await turns(
        root,
        String(server.url),
        native,
        [],
        true,
        false,
        hostile,
      );
      expect(result.selected).toEqual([native.id, native.id]);
      expect(result.reviewAfter).toBe(result.reviewBefore);
      expect(result.sameObjects).toEqual({
        model: true,
        compat: true,
        headers: true,
        downloadedExcluded: true,
        metadata: true,
        downloadedMetadata: true,
      });
      expect(result.addedFileModels).toEqual([
        "file-reviewer",
        "file-reviewer-fallback",
      ]);
      expect(result.views).toEqual(["allow", "allow"]);
      expect(result.executed).toBe(true);
      expect(await Bun.file(join(root, "reviewed.txt")).text()).toBe(
        "reviewed",
      );
      expect(requests).toHaveLength(2);
      const stableHeaders = (headers: (typeof requests)[number]["headers"]) =>
        Object.fromEntries(
          [...headers].filter(([name]) => name !== "content-length"),
        );
      expect(stableHeaders(requests[1]!.headers)).toEqual(
        stableHeaders(requests[0]!.headers),
      );
      type ReviewBody = {
        messages: {
          role: string;
          content: { type: string; text?: string }[];
        }[];
      };
      const { messages: beforeMessages, ...before } = requests[0]!
        .body as ReviewBody;
      const { messages: afterMessages, ...after } = requests[1]!
        .body as ReviewBody;
      expect(after).toEqual(before);
      const reviewTurns = afterMessages.filter(
        (message) => message.role !== "system",
      );
      expect(reviewTurns.map((message) => message.role)).toEqual([
        "user",
        "user",
        "assistant",
        "user",
      ]);
      const texts = (messages: ReviewBody["messages"]) =>
        messages.map((message) => message.content.map((block) => block.text));
      expect(texts(reviewTurns.slice(0, 2))).toEqual(
        texts(beforeMessages.filter((message) => message.role !== "system")),
      );
      expect(
        reviewTurns[2]!.content.find((block) => block.type === "text")!.text,
      ).toBe("OK");
      expect(JSON.stringify(requests[1]!.body)).not.toContain(
        "literal-header-private-marker",
      );
      expect(requests[0]!.body.model).toBe(native.id);
      expect(requests[0]!.headers.get("x-api-key")).toBe("stored-test-key");
      expect(
        result.warnings.filter((event) => event === "pi_model_config_invalid"),
      ).toHaveLength(4);
      expect(result.output).not.toContain("literal-header-private-marker");
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Regression: #3368 #3382 file reviewer pins try trusted fallbacks before allowing without review.
test.each([
  "remove-active",
  "no-trusted-reviewer",
  "file-pin-no-credentials",
  "downloaded-pin",
  "file-provider-pin",
] as const)("file models cannot disable safety: %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "models-json-removed-"));
  const reason = "removing a model entry does not authorize the tool";
  const { server, requests } = await responding(
    root,
    false,
    true,
    `DENY: ${reason}`,
  );
  try {
    const native = builtin(root);
    const result = await turns(
      root,
      String(server.url),
      native,
      [],
      true,
      false,
      undefined,
      mode,
    );
    expect(result.actingRemoved).toBe(mode !== "file-pin-no-credentials");
    const skipped =
      mode === "no-trusted-reviewer" || mode === "file-pin-no-credentials";
    expect(result.executed).toBe(skipped);
    expect(await Bun.file(join(root, "reviewed.txt")).exists()).toBe(skipped);
    const reviews = requests.filter(
      (request) => request.body.model === native.id,
    );
    if (!skipped) {
      expect(reviews).toHaveLength(1);
      expect(result.selected).toEqual([native.id]);
      expect(result.views).toEqual(["deny"]);
      expect(result.transcript).toContain(reason);
      expect(result.failureLogs).toEqual([]);
    } else {
      const missingCredentials = mode === "file-pin-no-credentials";
      const invalidPin = mode === "no-trusted-reviewer";
      expect(reviews).toHaveLength(0);
      expect(result.selected).toEqual(missingCredentials ? [native.id] : []);
      expect(result.transcript).toContain("allowed without review");
      expect(result.transcript).toContain("safety_review_failed");
      if (invalidPin) {
        expect(result.transcript).toContain(
          "Your chosen safety reviewer is not a built-in model",
        );
        expect(result.transcript).toContain("effort level 1");
      }
      expect(result.failureLogs).toEqual([
        {
          event: "safety_review_failed",
          fields: {
            cid: "c1",
            stage: invalidPin ? "configuration" : "provider",
            category: invalidPin ? "unsupported_reviewer_pin" : "auth",
            ...(missingCredentials
              ? {
                  provider: "anthropic",
                  model: native.id,
                  error:
                    "Safety_review_could_not_authenticate_the_configured_reviewer_model.",
                }
              : {}),
            elapsed_ms: expect.any(Number),
            attempts: 0,
          },
        },
      ]);
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 personalisation cannot let file definitions reclaim omitted built-in identities.
test("an OpenRouter built-in omitted by the stored personalised catalog cannot be re-added", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-personalised-"));
  try {
    const [omitted, kept] = durableModels(root)
      .getModels("openrouter")
      .filter((model) => !model.id.includes("~"));
    expect(omitted).toBeDefined();
    expect(kept).toBeDefined();
    await new FileModelsStore(join(root, "models-store.json")).write(
      "openrouter",
      {
        lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
        models: [kept!],
      },
    );
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        openrouter: { type: "api_key", key: "stored-test-key" },
      }),
    );
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          openrouter: {
            models: [{ id: omitted!.id }, { id: "file-openrouter" }],
          },
        },
      }),
    );
    const settings = await listed(root, ["openrouter"]);
    expect(
      settings.models.some((model) => model.id === `openrouter/${omitted!.id}`),
    ).toBe(false);
    expect(
      settings.models.some((model) => model.id === `openrouter/${kept!.id}`),
    ).toBe(true);
    expect(
      settings.models.some(
        (model) => model.id === "openrouter/file-openrouter",
      ),
    ).toBe(true);
    expect(settings.warnings).toContain("pi_model_config_invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 configured Codex headers must survive its default WebSocket preference.
test("configured Codex headers use a real SSE request without changing its native endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-json-codex-"));
  const { server, requests } = await responding(root, true);
  try {
    const native = durableModels(root)
      .getProvider("openai-codex")!
      .getModels()[0]!;
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "recorded-test" } })).toString("base64url")}.test`;
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: token,
          refresh: "recorded-refresh",
          expires: 9_000_000_000_000_000,
        },
      }),
    );
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            models: [
              {
                id: "operator-codex-model",
                reasoning: true,
                headers: {
                  "user-agent": "operator-codex/1",
                  "x-literal": "literal-header-private-marker",
                },
              },
            ],
          },
        },
      }),
    );
    const result = await turns(
      root,
      String(server.url),
      native,
      ["openai-codex/operator-codex-model"],
      false,
      true,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("user-agent")).toBe("operator-codex/1");
    expect(requests[0]!.headers.get("x-literal")).toBe(
      "literal-header-private-marker",
    );
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(
      new URL(requests[0]!.headers.get("x-test-original-url")!).origin,
    ).toBe(new URL(native.baseUrl).origin);
    expect(requests[0]!.body.model).toBe("operator-codex-model");
    expect(result.selectedModels[0]).toMatchObject({
      baseUrl: native.baseUrl,
      api: native.api,
    });
    expect(result.warnings).not.toContain("pi_model_config_invalid");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3368 unsupported files cannot remove built-ins or advertise custom models.
test.each([
  "malformed",
  "FIFO",
  "oversized",
  "too many entries",
  "too many headers",
  "oversized headers",
])(
  "unsupported %s models.json falls back while a built-in turn still replies",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "models-json-invalid-"));
    const { server, requests } = await responding(root);
    try {
      const native = builtin(root);
      const path = join(root, "models.json");
      if (kind === "FIFO") {
        const process = Bun.spawn(["mkfifo", path], {
          stdout: "ignore",
          stderr: "inherit",
        });
        expect(await process.exited).toBe(0);
      } else if (kind.endsWith("headers")) {
        const headers = (prefix: string) =>
          Object.fromEntries(
            Array.from(
              { length: kind === "too many headers" ? 33 : 32 },
              (_, index) => [
                `x-${prefix}-${index}`,
                kind === "oversized headers" ? "v".repeat(300) : "literal",
              ],
            ),
          );
        await writeFile(
          path,
          JSON.stringify({
            providers: {
              anthropic: {
                models: [
                  { id: "unsupported-model", headers: headers("definition") },
                ],
              },
            },
          }),
        );
      } else {
        const content =
          kind === "malformed"
            ? '{"providers":{"anthropic":{"models":[{"id":"unsupported-model"}]}},'
            : kind === "oversized"
              ? JSON.stringify({
                  providers: {
                    anthropic: { models: [{ id: "unsupported-model" }] },
                  },
                }) + " ".repeat(1024 * 1024)
              : JSON.stringify({
                  providers: {
                    anthropic: {
                      models: Array.from({ length: 129 }, (_, index) => ({
                        id:
                          index === 0
                            ? "unsupported-model"
                            : `excess-model-${index}`,
                      })),
                    },
                  },
                });
        await writeFile(path, content);
      }
      const settings = await listed(root);
      expect(
        settings.models.some(
          (model) => model.id === "anthropic/unsupported-model",
        ),
      ).toBe(false);
      expect(settings.warnings).toContain("pi_model_config_invalid");
      const result = await turns(root, String(server.url), native, [
        `anthropic/${native.id}`,
      ]);
      expect(requests).toHaveLength(1);
      expect(result.selectedModels[0]).toMatchObject({
        baseUrl: native.baseUrl,
        api: native.api,
      });
      const warnings: string[] = [];
      const models = durableModels(root, () =>
        warnings.push("pi_model_config_invalid"),
      );
      await models.refresh({ allowNetwork: false });
      await models.refresh({ allowNetwork: false });
      expect(warnings).toHaveLength(1);
      expect(settings.warnings).toHaveLength(1);
      expect(
        result.warnings.filter((event) => event === "pi_model_config_invalid"),
      ).toHaveLength(1);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
