import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { Config } from "../../../src/config";
import { join } from "node:path";
import { FileModelsStore } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import * as modelCatalog from "../../../src/agents/durable/models";
import { createDurableSafety } from "../../../src/extensions/core/safety/durable";
import {
  loadTrustedModelPolicy,
  pickReviewerCandidates,
} from "../../../src/extensions/core/safety/model-policy";
import { reviewAction } from "../../../src/extensions/core/safety/review";

export async function run(input: {
  root: string;
  endpoint: string;
  builtin: { id: string; baseUrl: string };
  hostile: unknown;
  mode?:
    | "remove-active"
    | "no-trusted-reviewer"
    | "file-pin-no-credentials"
    | "downloaded-pin"
    | "file-provider-pin";
  cache?: { provider: string; change: string };
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const request = new Request(...args);
    const url = new URL(request.url);
    if (url.origin !== new URL(input.builtin.baseUrl).origin)
      throw new Error("Unexpected reviewer endpoint");
    return originalFetch(
      new URL(url.pathname + url.search, input.endpoint).href,
      {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
        signal: request.signal,
      },
    );
  }) as typeof fetch;
  const warnings: string[] = [];
  const failureLogs: { event: string; fields: Record<string, unknown> }[] = [];
  const models = modelCatalog.durableModels(input.root, () =>
    warnings.push("pi_model_config_invalid"),
  );
  const provider = input.cache?.provider ?? "anthropic";
  const stock = models.getModel(provider, input.builtin.id)!;
  if (!input.cache)
    await new FileModelsStore(join(input.root, "models-store.json")).write(
      provider,
      {
        lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
        models: [
          { ...stock, id: "downloaded-model", name: "Downloaded model" },
        ],
      },
    );
  const fileProvider =
    input.mode === "file-provider-pin"
      ? {
          "file-only-reviewer": {
            name: "File reviewer",
            api: "anthropic-messages",
            baseUrl: input.endpoint,
            apiKey: "file-reviewer-private-key",
            models: [{ id: "file-reviewer" }],
          },
        }
      : {};
  if (input.mode || input.cache)
    await writeFile(
      join(input.root, "models.json"),
      JSON.stringify({
        providers: {
          ...fileProvider,
          [provider]: {
            models: [
              "file-acting",
              "file-reviewer",
              "file-reviewer-fallback",
            ].map((id) => ({ id })),
          },
        },
      }),
    );
  await models.refresh({ allowNetwork: false });
  const before = models.getModel(provider, stock.id)!;
  const downloaded = models.getModel(provider, "downloaded-model")!;
  if (!input.cache && !downloaded)
    throw new Error("Downloaded catalog was not restored");
  const core = createFauxCore({ tokensPerSecond: 20_000 });
  const fileActor = Boolean(
    input.mode || (input.cache && input.cache.change !== "none"),
  );
  const acting = fileActor
    ? models.getModel(provider, "file-acting")!
    : core.models[0]!;
  if (!acting) throw new Error("File acting model was not loaded");
  models.setProvider(
    createProvider({
      id: acting.provider,
      models: fileActor ? models.getModels(provider) : core.models,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      api: { stream: core.stream, streamSimple: core.streamSimple },
    }),
  );
  const actingProvider = models.getProvider(acting.provider)!;
  const policyConfig = input.cache
    ? new Config({
        env: {
          CHAT_DATA_DIR: join(input.root, "data"),
          HOME: join(input.root, "home"),
        },
        authenticatedProviders: () => [provider],
      })
    : undefined;
  core.setResponses([
    async () => {
      if (input.cache) {
        const list = await Bun.file(
          policyConfig!.paths.PI_MODEL_LIST_FILE,
        ).json();
        if (
          input.cache.change === "false" ||
          input.cache.change === "added-false"
        )
          list.models.find(
            (model: { provider: string; id: string }) =>
              model.provider === provider && model.id === stock.id,
          ).can_review = false;
        if (input.cache.change === "remove")
          list.models = list.models.filter(
            (model: { provider: string; id: string }) =>
              model.provider !== provider || model.id !== stock.id,
          );
        await writeFile(
          policyConfig!.paths.PI_MODEL_LIST_FILE,
          JSON.stringify(list),
        );
        await writeFile(
          policyConfig!.paths.AVAILABLE_MODELS_FILE,
          JSON.stringify({ version: 1, providers: {} }),
        );
        if (input.cache.change === "store")
          await new FileModelsStore(
            join(input.root, "models-store.json"),
          ).write(provider, {
            lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
            models: [
              {
                ...stock,
                ...(provider === "openrouter"
                  ? { id: "cache-only-reviewer" }
                  : {}),
                contextWindow: 1024,
                headers: { "x-store-poison": "untrusted" },
              },
            ],
          });
        await models.refresh({ allowNetwork: false });
        models.setProvider(actingProvider);
        await policyConfig!.refreshSettings();
        policy = await policyConfig!.trustedModelPolicy(
          `${acting.provider}/${acting.id}`,
        );
      }
      if (input.mode) {
        await writeFile(
          join(input.root, "models.json"),
          JSON.stringify({
            providers: {
              ...fileProvider,
              anthropic: {
                models: [
                  ...(input.mode === "file-pin-no-credentials"
                    ? ["file-acting"]
                    : []),
                  "file-reviewer",
                  "file-reviewer-fallback",
                ].map((id) => ({ id })),
              },
            },
          }),
        );
        if (input.mode === "file-pin-no-credentials")
          await writeFile(join(input.root, "auth.json"), "{}");
        await models.refresh({ allowNetwork: false });
      }
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: "printf reviewed > reviewed.txt" },
            { id: "reviewed-tool" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("done"),
  ]);
  const pinned =
    input.mode === "downloaded-pin"
      ? "downloaded-model"
      : input.mode === "no-trusted-reviewer" ||
          input.mode === "file-pin-no-credentials" ||
          input.mode === "file-provider-pin"
        ? "file-reviewer"
        : stock.id;
  const pinnedProvider =
    input.mode === "file-provider-pin" ? "file-only-reviewer" : "anthropic";
  let policy = policyConfig
    ? await policyConfig.trustedModelPolicy(`${acting.provider}/${acting.id}`)
    : JSON.stringify({
        version: 1,
        active: { provider: acting.provider, model: acting.id },
        reviewer_pin: { provider: pinnedProvider, model: pinned },
        reviewer: {
          provider: pinnedProvider,
          model: pinned,
          effort: "low",
          candidates: [
            {
              provider: "anthropic",
              model: "file-reviewer-fallback",
              effort: "low",
            },
            ...(input.mode === "no-trusted-reviewer"
              ? []
              : [{ provider: "anthropic", model: stock.id, effort: "low" }]),
          ],
        },
        summary: { provider: "anthropic", model: stock.id, effort: "low" },
      });
  const registry = createRegistry();
  let executed = false;
  registry.install(
    defineExtension({
      name: "reviewed-bash",
      tools: [
        defineTool({
          name: "bash",
          description: "Run a task-owned command",
          parameters: Type.Object({ command: Type.String() }),
          execute: async ({ command }) => {
            const child = Bun.spawn(["sh", "-c", command], {
              cwd: input.root,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });
            const [code, output] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            if (code !== 0) throw new Error("Reviewed command failed");
            executed = true;
            return { output: [{ type: "text", text: output }], details: {} };
          },
        }),
      ],
    }),
  );
  let harness!: Harness;
  let conversation!: Awaited<ReturnType<Harness["root"]>>;
  let reviewBefore: string | undefined;
  let reviewAfter: string | undefined;
  let sameObjects: unknown;
  const views: string[] = [];
  const selected: string[] = [];
  const trusted =
    Reflect.get(modelCatalog, "trustedModelCatalog")?.(models) ?? models;
  registry.install(
    createDurableSafety({
      models,
      reviewModels: trusted,
      configDir: input.root,
      log: (event, fields) => failureLogs.push({ event, fields }),
      trusted: () => ({
        modelPolicy: policy,
        dataDir: input.root,
        home: join(input.root, "home"),
      }),
      shells: () => [],
      agent: async () => ({
        id: "c1",
        env: {},
        cwd: input.root,
        conversation,
        stopRun: () => undefined,
      }),
      reviewAction: async (...args) => {
        selected.push(args[1].id);
        reviewBefore = JSON.stringify(args[1]);
        const control = await reviewAction(...args);
        views.push(control.decision);
        if (input.mode || input.cache) return control;
        await writeFile(
          join(input.root, "models.json"),
          JSON.stringify(input.hostile),
        );
        await models.refresh({ allowNetwork: false });
        const after = models.getModel("anthropic", stock.id)!;
        sameObjects = {
          model: before === after,
          compat: before.compat === after.compat,
          headers: before.headers === after.headers,
          downloadedExcluded:
            trusted.getModel("anthropic", downloaded.id) === undefined,
          metadata: JSON.stringify(before) === JSON.stringify(after),
          downloadedMetadata:
            JSON.stringify(downloaded) ===
            JSON.stringify(models.getModel("anthropic", downloaded.id)),
        };
        const candidate = pickReviewerCandidates(
          args[0],
          loadTrustedModelPolicy({ RECURSE_MODEL_POLICY: policy }),
          "reviewer",
        )?.[0];
        if (!candidate) throw new Error("No trusted reviewer candidate");
        const changed: Parameters<typeof reviewAction> = [...args];
        changed[1] = candidate.model;
        changed[2] = candidate.effort;
        selected.push(candidate.model.id);
        reviewAfter = JSON.stringify(candidate.model);
        const verdict = await reviewAction(...changed);
        views.push(verdict.decision);
        return verdict;
      },
    }),
  );
  try {
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BG);
    conversation = await harness.root(BG, {
      agent: {
        model: { provider: acting.provider, modelId: acting.id },
        cwd: input.root,
      },
    });
    await (
      await conversation.submit(
        {
          type: "input",
          content: "Write reviewed.txt in this task directory.",
        },
        BG,
      )
    ).wait(BG);
    console.log(
      "MODELS_JSON_RESULT=" +
        JSON.stringify({
          views,
          sameObjects,
          reviewBefore,
          reviewAfter,
          selected,
          executed,
          actingRemoved:
            models.getModel(acting.provider, acting.id) === undefined,
          transcript: JSON.stringify(await conversation.context(BG)),
          warnings,
          failureLogs,
          addedFileModels: ["file-reviewer", "file-reviewer-fallback"].filter(
            (id) => models.getModel("anthropic", id),
          ),
        }),
    );
  } finally {
    await harness?.close(BG);
    globalThis.fetch = originalFetch;
  }
}
