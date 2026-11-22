import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_ROOT, PI_PACKAGE_ROOT } from "../../../src/build_dir";
import { Config } from "../../../src/config";
import { durableModels } from "../../../src/agents/durable/models";
import { recordMessage } from "../../../src/observability/runtime_logging";
import { listPiModels } from "../../../src/models";
import { Router } from "../../../src/web/router";
import { registerSettingsRoutes } from "../../../src/web/settings";
import { modelsJsonEnv, modelsJsonWorker } from "../models_json_worker";
import { serveOpen } from "../http_open_app";
import { loadRecording } from "./model_response/replay";
import type { ReviewResult, run as runReview } from "./models_json_review";
import type { SelectionResult } from "./models_json_selection";
import type { TurnResult } from "./models_json_turn";
import { requestBody, type Recording } from "./provider_replay/server";

export function modelsJsonWorld() {
  let worker: Awaited<ReturnType<typeof modelsJsonWorker>>;
  beforeAll(async () => {
    worker = await modelsJsonWorker();
    await worker.ready;
  });
  afterAll(async () => {
    await worker?.close();
  });
  const stopServers = new Map<string, () => void>();

  async function cleanupModelRoot(root: string) {
    const stop = stopServers.get(root);
    stopServers.delete(root);
    try {
      stop?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function modelRoot(prefix: string) {
    return mkdtemp(join(tmpdir(), prefix));
  }

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
      catalog: config.models,
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
        models: ((await response.json()) as { models: { id: string }[] })
          .models,
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

  let anthropicRecording: ReturnType<typeof loadRecording> | undefined;
  let codexWire: Promise<string> | undefined;

  function loadCodexWire() {
    return (codexWire ??= Bun.file(
      join(
        CHECKOUT_ROOT,
        "tests/backend/fixtures/provider_replay/openai-codex-sse.json",
      ),
    )
      .json()
      .then((recording: Recording) =>
        Buffer.concat(
          recording.exchanges[0]!.chunks.map(
            (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
          ),
        ).toString(),
      ));
  }

  async function responding(
    root: string,
    {
      codex = false,
      reviewer = false,
      reviewReply = "OK",
      provider = "anthropic",
      openai = false,
    } = {},
  ) {
    let reviewText = false;
    const responseWire = codex || openai ? await loadCodexWire() : "";
    const content = codex
      ? responseWire
      : (await (anthropicRecording ??= loadRecording())).events
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
                        delta: {
                          role: "assistant",
                          content: "NORMAL_MODEL_OK",
                        },
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
    stopServers.set(root, () => server.stop(true));
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        [provider]: { type: "api_key", key: "stored-test-key" },
      }),
    );
    return { server, requests };
  }

  type ReviewOptions = Pick<Parameters<typeof runReview>[0], "mode" | "cache">;
  type TurnOptions = {
    reviewer?: true;
    codex?: boolean;
    hostile?: unknown;
    mode?: ReviewOptions["mode"] | "selection";
    cache?: ReviewOptions["cache"];
  };
  type FixtureResults = {
    turn: TurnResult;
    review: ReviewResult;
    selection: SelectionResult;
  };
  type FixtureFor<T> = T extends { mode: "selection" }
    ? "selection"
    : T extends { reviewer: true }
      ? "review"
      : "turn";

  async function turns<T extends TurnOptions = {}>(
    root: string,
    endpoint: string,
    model: { id: string; baseUrl: string },
    selected: string[],
    options?: T,
  ) {
    const {
      reviewer = false,
      codex = false,
      hostile,
      mode,
      cache,
    } = options ?? {};
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
    const result = JSON.parse(
      line!.slice("MODELS_JSON_RESULT=".length),
    ) as FixtureResults[FixtureFor<T>];
    if (!mode && !cache)
      for (const view of (result as TurnResult | ReviewResult).views)
        expect(view).toContain(
          reviewer
            ? "allow"
            : codex
              ? "RECORDED_PROVIDER_OK"
              : "NORMAL_MODEL_OK",
        );
    return { ...result, output: run.stdout.toString() + run.stderr.toString() };
  }
  return {
    authRequest,
    builtin,
    cleanupModelRoot,
    listed,
    modelRoot,
    responding,
    turns,
  };
}
