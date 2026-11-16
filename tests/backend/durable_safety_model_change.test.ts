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
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { buildApp, WebLogSink } from "../../src/web/app";
import { appWorld } from "./web_app_support";
import { held, until } from "./fixtures/durable_host/host";

// Regression: #3382 #3396 model changes and invalid reviewer choices preserve routing.
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
  const models = createModels();
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
    expect(failures).toHaveLength(2);
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
      const settings = (await (
        await fetch(`${running.url}/api/settings/safety-review-model`)
      ).json()) as { invalid: boolean };
      expect(settings.invalid).toBe(saved.invalid);
    }
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
