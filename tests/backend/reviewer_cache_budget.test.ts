import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { buildApp } from "../../src/web/app";
import { finishReviewCheck } from "../live/reviewer_cache";
import { killDataDirGroups } from "../dev/private_server";
import { appWorld } from "./web_app_support";
import { held, until } from "./fixtures/durable_host/host";

// Regression: #3386 the live check trusted a natural-language tool limit and could keep spending.
test.skipIf(process.platform !== "linux")(
  "the live check shuts down all work at a threshold and checks final usage",
  async () => {
    for (const limit of [
      "reviews",
      "acting_requests",
      "input_tokens",
      "all_conversations",
    ] as const) {
      const { root, env } = appWorld();
      env.CHAT_MODEL = "faux/faux-1";
      const app = await buildApp({ env });
      const faux = createFauxCore({ tokensPerSecond: 20_000 });
      const models = createModels();
      models.setProvider(
        createProvider({
          id: faux.provider,
          models: faux.models,
          auth: {
            apiKey: {
              name: "Fixture",
              resolve: async () => ({ auth: { apiKey: "fixture" } }),
            },
          },
          api: {
            stream: faux.stream,
            streamSimple: (model, context, options) =>
              faux.streamSimple(model, context, {
                ...options,
                cacheRetention: "none",
              }),
          },
        }),
      );
      app.instance.durable.deps.models = models;
      const running = await app.serve({ port: 0 });
      const api = async (route: string, body?: unknown, sender?: string) => {
        const response = await fetch(`${running.url}/api/${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            ...(sender ? { "x-recurse-agent": sender } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok)
          throw new Error(`HTTP ${response.status} from ${route}`);
        return response.json() as Promise<Record<string, any>>;
      };
      try {
        await until(() => app.instance.lifecycle.readinessSnapshot().ready);
        await until(
          () => app.instance.config.piModelListState().count !== null,
        );
        await app.instance.config.setPiModelList(
          faux.models.map((model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            context_window: model.contextWindow,
            file_provider: true,
          })),
        );
        await api("settings/effort-levels", {
          default_level: 3,
          levels: Object.fromEntries(
            [1, 2, 3, 4, 5].map((level) => [
              level,
              { model: "faux/faux-1", reasoning: "off" },
            ]),
          ),
        });
        const seed = join(root, "seed");
        await Bun.write(seed, "public fixture");
        const cid = String((await api("conversations", { level: 3 })).id);
        if (limit === "all_conversations") {
          const child = String(
            (await api("conversations", { level: 3, parent: cid })).id,
          );
          faux.setResponses(
            Array(10).fill(fauxAssistantMessage("Child fixture done")),
          );
          await api(`conversations/${child}/deliver`, {
            content: "Finish the child fixture.",
          });
          await until(
            async () => (await api(`conversations/${child}`)).status === "idle",
          );
        }
        const pending = held(fauxAssistantMessage("must be shut down"));
        const reviewed = limit === "reviews" || limit === "all_conversations";
        const readCount =
          limit === "all_conversations"
            ? 2
            : limit === "acting_requests"
              ? 6
              : limit === "input_tokens"
                ? 1
                : 0;
        const tools = [
          ...Array.from({ length: readCount }, () =>
            fauxToolCall("read", { path: seed }),
          ),
          ...Array.from({ length: reviewed ? 3 : 0 }, (_, index) =>
            fauxToolCall(
              "bash",
              index === 0
                ? {
                    command: `printf started > '${join(root, "background-started")}'; sleep 300`,
                    background: true,
                  }
                : {
                    command: `printf '${index}' > '${join(root, `reviewed-${index}`)}'`,
                  },
            ),
          ),
        ].map((call) => fauxAssistantMessage(call, { stopReason: "toolUse" }));
        let threshold = false;
        let requestsAfterThreshold = 0;
        const step: FauxResponseStep = (...args) => {
          if (threshold) requestsAfterThreshold++;
          if (JSON.stringify(args[0]).includes("untrusted record of a user's"))
            return fauxAssistantMessage("OK");
          if (
            !args[0].messages.some(
              (message) =>
                message.role === "system" &&
                (message.toolsAdded?.length ?? 0) > 0,
            )
          )
            return fauxAssistantMessage("Fixture conversation");
          return tools.shift() ?? pending.step(...args);
        };
        faux.setResponses(Array(30).fill(step));
        await api(`conversations/${cid}/deliver`, {
          content:
            limit === "input_tokens"
              ? "public budget fixture ".repeat(15000)
              : "Run the task-owned fixture tools.",
        });
        await pending.started;
        await api(
          `conversations/${cid}/deliver`,
          {
            content: "Queued successor must never reach the provider.",
          },
          cid,
        );
        expect((await api(`conversations/${cid}`)).pending).toHaveLength(1);
        const shells = app.instance.durable.shells(cid, Date.now()).items;
        expect(shells).toHaveLength(reviewed ? 1 : 0);
        const result = await finishReviewCheck(
          root,
          cid,
          api,
          AbortSignal.timeout(20_000),
          async () => {
            threshold = true;
            expect(app.instance.durable.metadata(cid).pending).toHaveLength(1);
            await running.close();
            await Promise.all(app.detached);
            await killDataDirGroups(join(root, "data"));
          },
        );
        expect(requestsAfterThreshold).toBe(0);
        expect(result.reviews).toBe(reviewed ? 3 : 0);
        expect(result.actingRequests).toBe(
          reviewed
            ? limit === "all_conversations"
              ? 6
              : 3
            : limit === "acting_requests"
              ? 6
              : 1,
        );
        if (limit === "reviews") expect(result.failure).toBeUndefined();
        else
          expect(result.failure).toBe(
            limit === "all_conversations" ? "acting_requests" : limit,
          );
        if (limit === "input_tokens")
          expect(result.uncachedInput).toBeGreaterThan(60_000);
        for (const shell of shells)
          expect(() => process.kill(-shell.pid, 0)).toThrow();
        expect(app.instance.durable.runningCount()).toBe(0);
      } finally {
        await running.close();
        await app.instance.shutdown();
        await Promise.all(app.detached);
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  30_000,
);
