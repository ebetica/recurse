import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "../../src/config";
import { EFFORT_LEVELS } from "../../src/effort_levels";
import { durableModels } from "../../src/agents/durable/models";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { FileModelsStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { modelsJsonWorld } from "./fixtures/models_json_world";

const {
  authRequest,
  builtin,
  cleanupModelRoot,
  listed,
  modelRoot,
  responding,
  turns,
} = modelsJsonWorld();

// Regression: #3381 built-in providers also defined in Settings and the downloaded store retain add-only file models.
test("meta file additions use the Settings endpoint and credential without replacing catalog models", async () => {
  const root = await modelRoot("models-json-meta-");
  try {
    const { server, requests } = await responding(root, {
      provider: "meta",
      openai: true,
    });
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
    await config.models.upsertCustomProvider("meta", {
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
    expect(settings.config.models.isFileProviderModel(`meta/${added}`)).toBe(
      false,
    );
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
    await cleanupModelRoot(root);
  }
});

// Regression: #3378 file-defined endpoints cannot select themselves through defaults, naming or agent-origin raw model fields.
test("file providers require operator selections and never supply automatic naming or defaults", async () => {
  const root = await modelRoot("models-json-selection-");
  try {
    const { server, requests } = await responding(root);
    const provider = {
      name: "File provider",
      api: "anthropic-messages",
      baseUrl: new URL("/file-provider/", server.url).href,
      apiKey: "file-literal-private-key",
      models: [{ id: "file-model" }],
    };
    await writeFile(join(root, "auth.json"), "{}");
    const baseline = await listed(root, []);
    const baselineModel = baseline.config.models.defaultChatModel();
    const baselineLevels = baseline.config.levels.effortLevels();
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
    expect(settings.config.models.defaultChatModel()).toBe(baselineModel);
    expect(settings.config.models.defaultChatModel()).not.toStartWith(
      "file-provider/",
    );
    expect(settings.config.levels.effortLevels()).toEqual(baselineLevels);
    const selection = (
      await turns(root, String(server.url), builtin(root), [], {
        mode: "selection",
      })
    ).selection;
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
      `"provider":${JSON.stringify(baseline.config.models.providerOf(baselineLevels["1"]!.model))}`,
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
    await cleanupModelRoot(root);
  }
});

// Regression: #3378 #3381 file-only providers keep isolated auth while existing providers accept only additions.
test("file-only provider runs with its own endpoint and literal key", async () => {
  const root = await modelRoot("models-json-provider-");
  try {
    const { server, requests } = await responding(root, { openai: true });
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
    await config.models.upsertCustomProvider("settings-collision", {
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
      openaiSettings.config.models.providerOf(
        openaiSettings.config.models.defaultChatModel(),
      ),
    ).toBe("openai");
    for (const level of EFFORT_LEVELS)
      expect(
        openaiSettings.config.levels.resolveEffortLevel(level)[0],
      ).toStartWith("openai/");
    expect(requests[0]!.headers.get("x-api-key")).toBe(
      "file-literal-private-key",
    );
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
    const hiddenFromRequests = [
      "stored-test-key",
      "other-provider-key",
      "other-oauth-token",
      "stored-file-id-must-not-win",
      "env-marker-private",
      "ambient-must-not-authenticate",
    ];
    const fileKeys = [
      "file-completions-private-key",
      "file-responses-private-key",
      "file-header-private-key",
      "file-literal-private-key",
    ];
    const wires = requests.map((request) => ({
      body: request.body,
      headers: Object.fromEntries(request.headers),
    }));
    for (const [surface, secrets] of [
      [JSON.stringify(wires), hiddenFromRequests],
      [result.output, [...hiddenFromRequests, ...fileKeys]],
      [JSON.stringify(settings), fileKeys],
      [JSON.stringify(wires[0]!.headers), ["stored-test-key"]],
    ] as const)
      for (const secret of secrets) expect(surface).not.toContain(secret);
  } finally {
    await cleanupModelRoot(root);
  }
});

// Regression: #3368 models.json selections listed by Settings must run Durable turns.
test("Settings and turns share literal models.json metadata and headers", async () => {
  const root = await modelRoot("models-json-");
  try {
    const { server, requests } = await responding(root);
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
    expect(
      settings.config.models.unlistedModelSentence(selected, 1),
    ).toBeNull();
    await settings.config.levels.setEffortLevel(1, selected, "off");
    expect(settings.config.levels.resolveEffortLevel(1)[0]).toBe(selected);
    await settings.config.levels.setEffortLevels({
      default_level: 3,
      levels: Object.fromEntries(
        EFFORT_LEVELS.map((level) => [
          String(level),
          {
            model: level === 1 ? `anthropic/${native.id}` : selected,
            reasoning: "off",
          },
        ]),
      ),
    });
    expect(settings.config.models.modelPolicy(selected).context_window).toBe(
      64000,
    );
    await settings.config.levels.writeAvailableModels();
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
    await cleanupModelRoot(root);
  }
});

// Regression: #3368 catalog loading cannot execute commands or expand server environment values.
test("models.json expression entries are unlisted without executing or expanding them", async () => {
  const root = await modelRoot("models-json-expressions-");
  try {
    const { server, requests } = await responding(root);
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
    await cleanupModelRoot(root);
  }
});

// Regression: #3368 personalisation cannot let file definitions reclaim omitted built-in identities.
test("an OpenRouter built-in omitted by the stored personalised catalog cannot be re-added", async () => {
  const root = await modelRoot("models-json-personalised-");
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
    await cleanupModelRoot(root);
  }
});

// Regression: #3368 configured Codex headers must survive its default WebSocket preference.
test("configured Codex headers use a real SSE request without changing its native endpoint", async () => {
  const root = await modelRoot("models-json-codex-");
  try {
    const { server, requests } = await responding(root, { codex: true });
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
      { codex: true },
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
    await cleanupModelRoot(root);
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
    const root = await modelRoot("models-json-invalid-");
    try {
      const { server, requests } = await responding(root);
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
      await cleanupModelRoot(root);
    }
  },
);
