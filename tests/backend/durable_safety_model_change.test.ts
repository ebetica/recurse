import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
  type ClassifierResult,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { buildApp, WebLogSink } from "../../src/web/app";
import {
  durableModels,
  STORED_CREDENTIALS_ONLY,
  trustedModelCatalog,
} from "../../src/agents/durable/models";
import { appWorld } from "./web_app_support";
import { held, until } from "./fixtures/durable_host/host";

// Regression: #3382 #3396 #3500 reviewer changes keep routing and categories
test("model changes rebuild trusted safety policy and apply reviewer verdicts", async () => {
  const { root, env } = appWorld();
  env.CHAT_MODEL = "faux/vendor/model";
  const logs: string[] = [];
  const app = await buildApp({
    env,
    sink: new WebLogSink((line) => logs.push(line)),
  });
  const faux = createFauxCore({
    tokensPerSecond: 20_000,
    models: [{ id: "faux-1" }, { id: "vendor/model" }, { id: "faux-reviewer" }],
  });
  const authDir = await app.instance.oauth.agentDir();
  const installed = durableModels(authDir);
  const trusted = trustedModelCatalog(installed);
  const models = createModels({
    credentials: AuthStorage.createLazy(join(authDir, "auth.json")),
    authContext: STORED_CREDENTIALS_ONLY,
  });
  const fakeTransport = (provider: Provider) =>
    new Proxy(provider, {
      get(target, key) {
        if (key === "stream") return faux.stream;
        if (key === "streamSimple") return faux.streamSimple;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  models.setProvider(
    createProvider({
      id: faux.provider,
      models: faux.models,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  const classifier = builtinProviders()
    .flatMap((provider) => provider.getAllModels?.() ?? [])
    .find((model) => model.type === "classifier")!;
  const classifierId = `${classifier.provider}/${classifier.id}`;
  const codex = trusted.getProvider("openai-codex")!;
  const platform = trusted.getProvider("openai")!;
  const luna = codex.getModels().find((model) => model.name === "GPT-6 Luna")!;
  const openai = platform.getModels()[0]!;
  const openaiId = `${openai.provider}/${openai.id}`;
  const lunaId = `${luna.provider}/${luna.id}`;
  models.setProvider(fakeTransport(codex));
  let choice = "allow";
  const decisions: unknown[] = [];
  models.setProvider(
    createProvider({
      id: classifier.provider,
      models: [classifier],
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      classifiers: {
        [classifier.api]: {
          classify: async (model, context): Promise<ClassifierResult> => {
            decisions.push(context);
            return {
              api: model.api,
              provider: model.provider,
              model: model.id,
              answers:
                choice === "error" || choice === "missing"
                  ? {}
                  : {
                      safety: {
                        type: "choice",
                        choice,
                        probabilities: { [choice]: 1 },
                        confidence: 1,
                      },
                    },
              usage: fauxAssistantMessage("").usage,
              stopReason: choice === "error" ? "error" : "stop",
              ...(choice === "error"
                ? { errorMessage: "System One API error (401): no such user" }
                : {}),
              timestamp: Date.now(),
            };
          },
        },
      },
    }),
  );
  app.instance.durable.deps.models = models;
  const running = await app.serve({ port: 0 });
  const api = (path: string, body: object) =>
    fetch(`${running.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    await until(() => app.instance.config.piModelListState().count !== null);
    await app.instance.config.setPiModelList([
      ...faux.models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        context_window: model.contextWindow,
        file_provider: true,
      })),
      {
        provider: "faux",
        id: "faux-missing",
        name: "Missing reviewer",
        context_window: 100_000,
        file_provider: true,
      },
    ]);
    const ladder = app.instance.config.effortLevels();
    expect(
      (
        await api("/api/settings/effort-levels", {
          default_level: 3,
          levels: {
            ...ladder,
            "1": { model: "faux/faux-1", reasoning: "low" },
            "3": { model: "faux/faux-1", reasoning: "off" },
            "4": { model: env.CHAT_MODEL, reasoning: "off" },
          },
        })
      ).status,
    ).toBe(200);
    const created = await api("/api/conversations", { level: 3 });
    expect(created.status).toBe(200);
    const cid = String(((await created.json()) as { id: string }).id);
    const host = app.instance.durable;
    const settled = () =>
      host.runningCount() === 0 && host.metadata(cid).pending.length === 0;
    const opening = held(fauxAssistantMessage("opened on first model"));
    faux.setResponses([opening.step]);
    expect(
      (await api(`/api/conversations/${cid}/deliver`, { content: "hello" }))
        .status,
    ).toBe(200);
    await opening.started;
    expect(
      (
        await api("/api/settings/effort-levels", {
          default_level: 3,
          levels: {
            ...app.instance.config.effortLevels(),
            "1": { model: "faux/faux-reviewer", reasoning: "low" },
          },
        })
      ).status,
    ).toBe(200);
    const changed = await api(`/api/conversations/${cid}/model`, { level: 4 });
    expect(changed.status, await changed.text()).toBe(200);
    opening.release();
    await until(settled);
    for (const cacheMode of ["normal", "collision", "oversized"]) {
      if (cacheMode === "collision") {
        expect(
          (
            await api("/api/settings/effort-levels", {
              default_level: 3,
              levels: {
                ...app.instance.config.effortLevels(),
                "1": { model: "faux/faux-missing", reasoning: "low" },
              },
            })
          ).status,
        ).toBe(200);
        const cache = await Bun.file(
          app.instance.config.paths.PI_MODEL_LIST_FILE,
        ).json();
        cache.models.push({
          provider: "faux/vendor",
          id: "model",
          name: "Hostile cached row",
          context_window: 100_000,
          file_provider: true,
        });
        await writeFile(
          app.instance.config.paths.PI_MODEL_LIST_FILE,
          JSON.stringify(cache),
        );
        await app.instance.config.refreshSettings();
      } else if (cacheMode === "oversized") {
        const config = app.instance.config;
        const cache = await Bun.file(config.paths.PI_MODEL_LIST_FILE).json();
        cache.models = Array.from({ length: 2_001 }, (_, index) => ({
          provider: "faux",
          id: index === 0 ? "vendor/model" : `overflow-${index}`,
          name: `Cached model ${index}`,
          context_window: 100_000,
          file_provider: true,
        }));
        const efforts = await Bun.file(config.paths.EFFORT_LEVELS_FILE).json();
        delete efforts.levels["1"];
        await writeFile(config.paths.PI_MODEL_LIST_FILE, JSON.stringify(cache));
        await writeFile(
          config.paths.EFFORT_LEVELS_FILE,
          JSON.stringify(efforts),
        );
        await config.refreshSettings();
      }
      for (const verdict of ["OK", "DENY: test refusal"]) {
        const file = join(
          root,
          `${cacheMode}-${verdict === "OK" ? "allowed" : "denied"}`,
        );
        const main = [
          fauxAssistantMessage(
            fauxToolCall("bash", { command: `touch ${file}` }),
            {
              stopReason: "toolUse",
            },
          ),
          fauxAssistantMessage("done"),
        ];
        const reviewers: string[] = [];
        const actors: string[] = [];
        const step: FauxResponseStep = (request, _options, _state, model) => {
          if (
            JSON.stringify(request).includes("untrusted record of a user's")
          ) {
            reviewers.push(model.id);
            return fauxAssistantMessage(verdict);
          }
          actors.push(model.id);
          return main.shift() ?? fauxAssistantMessage("done");
        };
        faux.setResponses(Array(6).fill(step));
        expect(
          (
            await api(`/api/conversations/${cid}/deliver`, {
              content: "create the task-owned file",
            })
          ).status,
        ).toBe(200);
        await until(settled);
        const view = JSON.stringify((await host.view(cid)).blocks);
        expect(
          view.match(/Safety review configuration is invalid[^"]*/)?.[0],
        ).toBeUndefined();
        expect(reviewers).toEqual([
          cacheMode === "normal" ? "faux-reviewer" : "vendor/model",
        ]);
        expect(actors).toEqual(["vendor/model", "vendor/model"]);
        expect(existsSync(file)).toBe(verdict === "OK");
        if (verdict !== "OK") expect(view).toContain("test refusal");
      }
      if (cacheMode === "oversized") {
        expect(app.instance.config.piModelListState().count).toBe(2_000);
        const warnings = logs.filter((line) =>
          line.includes("event=pi_model_list_truncated"),
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("accepted=2000");
        expect(warnings[0]).toContain("ignored=1");
      }
    }
    const config = app.instance.config;
    const choicePath = join(
      config.paths.CONFIG_DIR,
      "safety-review-model.json",
    );
    await writeFile(choicePath, JSON.stringify({ model: classifierId }));
    await config.refreshSettings();
    for (const label of ["allow", "credential_exposure", "error", "missing"]) {
      choice = label;
      const file = join(root, `decision-${label}`);
      const main = [
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("decision done"),
      ];
      faux.setResponses(main);
      expect(
        (
          await api(`/api/conversations/${cid}/deliver`, {
            content: `create decision-${label}`,
          })
        ).status,
      ).toBe(200);
      await until(settled);
      expect(existsSync(file)).toBe(label !== "credential_exposure");
      const view = JSON.stringify((await host.view(cid)).blocks);
      if (label === "credential_exposure")
        expect(view).toContain("credential_exposure");
      if (label === "error" || label === "missing")
        expect(view).toContain("allowed without review");
      const captured = (await host.prompt(cid, true)).safety_review as {
        method: string;
        reply: { stopReason: string };
        context: unknown;
      };
      expect(captured).toBeDefined();
      expect(captured.reply.stopReason, JSON.stringify(captured.reply)).toBe(
        label === "error" ? "error" : "stop",
      );
      expect(JSON.stringify(captured.context)).toContain(
        "Typed-output adaptation",
      );
    }
    expect(decisions).toHaveLength(4);
    for (const request of decisions) {
      const serialized = JSON.stringify(request);
      expect(serialized).toContain("Typed-output adaptation");
      expect(serialized).toContain("Trusted acting agent");
      expect(serialized).not.toContain('"role":"assistant"');
    }
    const failures = logs.filter(
      (line) =>
        line.includes("event=safety_review_failed") &&
        line.includes(`provider=${classifier.provider}`),
    );
    expect(failures.map((line) => line.match(/category=(\w+)/)?.[1])).toEqual([
      "auth",
      "invalid",
    ]);
    expect(logs.join("\n")).not.toContain("no such user");
    expect(JSON.stringify((await host.view(cid)).blocks)).not.toContain(
      "no such user",
    );
    await writeFile(
      choicePath,
      JSON.stringify({ model: `${classifier.provider}/gone` }),
    );
    await config.refreshSettings();
    const absent = join(root, "decision-unavailable");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `touch ${absent}` }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    await api(`/api/conversations/${cid}/deliver`, {
      content: "create decision-unavailable",
    });
    await until(settled);
    expect(existsSync(absent)).toBe(true);
    expect(decisions).toHaveLength(4);
    expect(
      logs.some(
        (line) =>
          line.includes("event=safety_review_failed") &&
          line.includes("category=unsupported_reviewer_pin"),
      ),
    ).toBe(true);
    const savedChoices = [
      { text: "{not json", invalid: true },
      { text: "[]", invalid: true },
      { text: JSON.stringify({ model: 123 }), invalid: true },
      { text: JSON.stringify({ model: "" }), invalid: true },
      { text: "{}", invalid: false },
    ];
    for (const [index, saved] of savedChoices.entries()) {
      await writeFile(choicePath, JSON.stringify({ model: classifierId }));
      await config.refreshSettings();
      await writeFile(choicePath, saved.text);
      await config.refreshSettings();
      const file = join(root, `decision-invalid-${index}`);
      const main = [
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ];
      let chatReviews = 0;
      const step: FauxResponseStep = (request) => {
        if (JSON.stringify(request).includes("untrusted record of a user's")) {
          chatReviews += 1;
          return fauxAssistantMessage("OK");
        }
        return main.shift() ?? fauxAssistantMessage("done");
      };
      faux.setResponses(Array(6).fill(step));
      const logStart = logs.length;
      expect(
        (
          await api(`/api/conversations/${cid}/deliver`, {
            content: `create decision-invalid-${index}`,
          })
        ).status,
      ).toBe(200);
      await until(settled);
      expect(existsSync(file)).toBe(true);
      expect(chatReviews).toBe(saved.invalid ? 0 : 1);
      expect(decisions).toHaveLength(4);
      const warnings = logs
        .slice(logStart)
        .filter((line) => line.includes("event=safety_review_failed"));
      expect(warnings).toHaveLength(saved.invalid ? 1 : 0);
      if (saved.invalid) {
        expect(warnings[0]).toContain("category=invalid_policy");
        expect(warnings[0]).toContain("attempts=0");
        const blocks = (await host.view(cid)).blocks as unknown[];
        const action = blocks.findLast((block) =>
          JSON.stringify(block).includes(`decision-invalid-${index}`),
        );
        expect(JSON.stringify(action)).toContain(
          "Safety review was skipped, so this action was allowed without review.",
        );
      }
      const settings: unknown = await (
        await fetch(`${running.url}/api/settings/safety-review-model`)
      ).json();
      expect(settings).toEqual({
        model: null,
        invalid: saved.invalid,
        models: [],
      });
    }
    const endpoint = "/api/settings/safety-review-model";
    expect((await api(endpoint, { model: lunaId })).status).toBe(422);
    env.OPENAI_API_KEY = "ambient-test-key";
    expect(
      (await api("/api/pi/openrouter-auth/api-key", { key: "test-key" }))
        .status,
    ).toBe(200);
    expect(app.instance.config.authedModelProviders().has("openai")).toBe(true);
    const reviewOptions = async () =>
      (await (await fetch(`${running.url}${endpoint}`)).json()) as {
        models: unknown[];
      };
    expect((await reviewOptions()).models).not.toContainEqual(
      expect.objectContaining({ route: "OpenAI API key" }),
    );
    expect((await api(endpoint, { model: openaiId })).status).toBe(422);
    const subscription = {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3600_000,
      accountId: "test-subscription",
    };
    await app.instance.oauth.replaceCredentials("openai", subscription);
    const expectRouteAuth = async (
      key: string | undefined,
      access: string | undefined,
    ) => {
      for (const registry of [installed, trusted]) {
        for (const [route, want] of [
          ["openai", key],
          ["openai-codex", access],
        ] as const) {
          const auth = await registry.getAuth(route);
          if (want === undefined) {
            expect(auth === undefined, `${route}: no auth`).toBe(true);
          } else {
            expect(auth?.auth.apiKey === want, `${route}: own auth`).toBe(true);
          }
        }
      }
    };
    await expectRouteAuth(undefined, undefined);
    expect((await api(endpoint, { model: openaiId })).status).toBe(422);
    await app.instance.oauth.removeCredentials(["openai"]);
    const subscriptionProvider = "openai-codex";
    const platformKey = "test-openai-key";
    const saveKey = () =>
      api("/api/pi/codex-auth/api-key", { key: platformKey });
    expect((await saveKey()).status).toBe(200);
    await expectRouteAuth(platformKey, undefined);
    expect((await api("/api/pi/codex-auth/api-key/remove", {})).status).toBe(
      200,
    );
    await app.instance.oauth.replaceCredentials(
      subscriptionProvider,
      subscription,
    );
    await expectRouteAuth(undefined, subscription.access);
    expect((await saveKey()).status).toBe(200);
    await expectRouteAuth(platformKey, subscription.access);
    expect([...config.authedModelProviders()]).toEqual(
      expect.arrayContaining(["openai-codex", "openai"]),
    );
    expect((await reviewOptions()).models).toEqual(
      expect.arrayContaining([
        { id: lunaId, label: luna.name, route: "ChatGPT subscription" },
        { id: openaiId, label: openai.name, route: "OpenAI API key" },
      ]),
    );
    const saved = await api(endpoint, { model: lunaId });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ model: lunaId });
    const fileOnly = "file-only-reviewer";
    await config.setPiModelList([
      {
        provider: "faux",
        id: "vendor/model",
        name: "Acting model",
        context_window: 100_000,
        file_provider: true,
      },
      {
        provider: luna.provider,
        id: fileOnly,
        name: "File-only reviewer",
        context_window: luna.contextWindow,
        file_provider: true,
      },
    ]);
    expect(config.chatModels().map((item) => item.id)).toContain(
      `${luna.provider}/${fileOnly}`,
    );
    expect(
      (await api(endpoint, { model: `${luna.provider}/${fileOnly}` })).status,
    ).toBe(422);
    const reviews: { model: string; priorReplies: string[] }[] = [];
    const reviewedWrite = async (
      name: string,
      response: string,
      executes: boolean,
    ) => {
      const file = join(root, name);
      const work = [
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ];
      const step: FauxResponseStep = (request, _options, _state, model) => {
        if (JSON.stringify(request).includes("untrusted record of a user's")) {
          reviews.push({
            model: `${model.provider}/${model.id}`,
            priorReplies: request.messages.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((content) =>
                    content.type === "text" ? [content.text] : [],
                  )
                : [],
            ),
          });
          return fauxAssistantMessage(response);
        }
        return work.shift() ?? fauxAssistantMessage("done");
      };
      faux.setResponses(Array(6).fill(step));
      const delivered = await api(`/api/conversations/${cid}/deliver`, {
        content: `create ${name}`,
      });
      expect(delivered.status, await delivered.text()).toBe(200);
      await until(settled);
      expect(existsSync(file)).toBe(executes);
    };
    await reviewedWrite("first-reviewed-write", "OK", true);
    await reviewedWrite("second-reviewed-write", "OK", true);
    expect(reviews).toEqual([
      { model: lunaId, priorReplies: [] },
      { model: lunaId, priorReplies: ["OK"] },
    ]);
    expect((await api(endpoint, { model: null })).status).toBe(200);
    expect((await api(endpoint, { model: lunaId })).status).toBe(200);
    await reviewedWrite("after-reviewer-change", "DENY: test refusal", false);
    expect(reviews.slice(2)).toEqual([{ model: lunaId, priorReplies: [] }]);

    const [anthropic, azure] = ["anthropic", "azure"].map(
      (id) =>
        builtinProviders()
          .find((provider) => provider.id === id)!
          .getModels()[0]!,
    );
    for (const model of [anthropic, azure]) {
      models.setProvider(
        createProvider({
          id: model.provider,
          models: [model],
          auth: {
            apiKey: {
              name: "Test",
              resolve: async () => ({ auth: { apiKey: "test-key" } }),
            },
          },
          api: { stream: faux.stream, streamSimple: faux.streamSimple },
        }),
      );
    }
    await writeFile(
      join(await app.instance.oauth.agentDir(), "auth.json"),
      JSON.stringify({
        ...(await app.instance.oauth.readAuth()),
        [anthropic.provider]: { type: "api_key", key: "test-key" },
        [azure.provider]: {
          type: "api_key",
          key: "test-key",
          env: { AZURE_OPENAI_BASE_URL: "http://127.0.0.1:1/azure" },
        },
      }),
      { mode: 0o600 },
    );
    const anthropicId = `${anthropic.provider}/${anthropic.id}`;
    const azureId = `${azure.provider}/${azure.id}`;
    expect((await api(endpoint, { model: anthropicId })).status).toBe(200);
    await reviewedWrite("canonical-reviewer", "OK", true);
    expect(reviews.slice(3)).toEqual([
      { model: anthropicId, priorReplies: [] },
    ]);
    expect((await reviewOptions()).models).not.toContainEqual(
      expect.objectContaining({ id: azureId }),
    );
    expect((await api(endpoint, { model: azureId })).status).toBe(422);
    for (const [name, model] of [
      ["alias-not-routed", `claude-bridge/${anthropic.id}`],
      ["configurable-endpoint-not-routed", azureId],
    ] as const) {
      await writeFile(choicePath, JSON.stringify({ model }));
      await config.refreshSettings();
      const logStart = logs.length;
      await reviewedWrite(name, "DENY: test refusal", true);
      expect(reviews).toHaveLength(4);
      expect(
        logs
          .slice(logStart)
          .filter((line) => line.includes("event=safety_review_failed")),
      ).toEqual([expect.stringContaining("category=unsupported_reviewer_pin")]);
    }
    expect((await api(endpoint, { model: null })).status).toBe(200);
    const setReviewerLevel = async (model: string, levelFour?: string) => {
      const levels = {
        ...config.effortLevels(),
        "1": { model, reasoning: "low" },
        ...(levelFour && { "4": { model: levelFour, reasoning: "off" } }),
      };
      await writeFile(
        config.paths.EFFORT_LEVELS_FILE,
        JSON.stringify({ levels, default_level: 3 }),
      );
      await config.refreshSettings();
    };
    models.setProvider(fakeTransport(platform));
    expect((await api("/api/pi/codex-auth/api-key/remove", {})).status).toBe(
      200,
    );
    expect((await models.getAuth("openai")) === undefined).toBe(true);
    expect(
      (await models.getAuth("openai-codex"))?.auth.apiKey ===
        subscription.access,
    ).toBe(true);
    await setReviewerLevel(openaiId);
    await reviewedWrite("keep-platform-review-billing", "OK", true);
    expect(reviews.at(-1)?.model).toBe("faux/vendor/model");

    expect((await saveKey()).status).toBe(200);
    await config.setPiModelList(
      [openai, luna].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        context_window: model.contextWindow,
      })),
    );
    await setReviewerLevel(lunaId, openaiId);
    expect(
      (await api(`/api/conversations/${cid}/model`, { level: 4 })).status,
    ).toBe(200);
    expect((await api("/api/pi/codex-auth/logout", {})).status).toBe(200);
    expect((await models.getAuth("openai-codex")) === undefined).toBe(true);
    expect((await models.getAuth("openai"))?.auth.apiKey === platformKey).toBe(
      true,
    );
    const beforeMissingSubscription = reviews.length;
    const warningStart = logs.length;
    await reviewedWrite(
      "keep-subscription-review-billing",
      "DENY: wrong billing route",
      true,
    );
    expect(reviews).toHaveLength(beforeMissingSubscription);
    expect(logs.slice(warningStart)).toContainEqual(
      expect.stringContaining("event=safety_review_failed"),
    );
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
