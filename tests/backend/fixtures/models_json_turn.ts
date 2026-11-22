import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "../../../src/config";
import { recordMessage } from "../../../src/observability/runtime_logging";
import { DurableHost } from "../../../src/agents/durable/host";
import { idle, testDeps, until } from "./durable_host/host";

export async function run(input: {
  root: string;
  endpoint: string;
  builtin: { id: string; baseUrl: string };
  selected: string[];
  codex?: boolean;
}) {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct(target, [address, ...args], receiver) {
      const url = new URL(String(address));
      if (url.host !== new URL(input.builtin.baseUrl).host)
        throw new Error("Unexpected WebSocket endpoint");
      const endpoint = new URL(input.endpoint);
      endpoint.protocol = "ws:";
      return Reflect.construct(
        target,
        [new URL(url.pathname + url.search, endpoint).href, ...args],
        receiver,
      );
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const request = new Request(...args);
    const url = new URL(request.url);
    if (
      url.origin !== new URL(input.builtin.baseUrl).origin &&
      url.origin !== new URL(input.endpoint).origin
    )
      throw new Error("Unexpected provider endpoint");
    request.headers.set("x-test-original-url", url.href);
    return originalFetch(
      new URL(url.pathname + url.search, input.endpoint).href,
      {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        signal: request.signal,
      },
    );
  }) as typeof fetch;

  const record = { id: "c1", backend: "durable", workdir: input.root };
  let selected = input.selected[0]!;
  const warnings: string[] = [];
  const logs: string[] = [];
  const config = new Config({
    env: {
      CHAT_DATA_DIR: join(input.root, "data"),
      HOME: join(input.root, "home"),
    },
  });
  const host = new DurableHost({
    ...testDeps(
      input.root,
      () => record,
      () => ["c1"],
    ),
    settings: () => [selected, "off"],
    customProviders: () => config.models.customModelProviders(),
    log: (event, fields) => {
      warnings.push(event);
      logs.push(recordMessage(event, fields));
    },
  });
  try {
    const models = await host.models();
    const views: string[] = [];
    const selectedModels = [];
    const captures = [];
    for (const [index, id] of input.selected.entries()) {
      selected = id;
      const [provider, ...parts] = id.split("/");
      const model = (await host.models()).getModel(provider!, parts.join("/"))!;
      if (input.codex) {
        const response = await models.completeSimple(
          model,
          {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Reply with the public marker" },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          {
            reasoning: "low",
            transport: "websocket",
          },
        );
        views.push(JSON.stringify(response.content));
      } else {
        await host.send("c1", "Reply without tools", `models-json-${index}`);
        await until(idle(host));
        views.push(JSON.stringify((await host.view("c1", {})).blocks));
        captures.push(await host.prompt("c1"));
      }
      selectedModels.push({
        id: model.id,
        baseUrl: model.baseUrl,
        api: model.api,
        contextWindow: model.contextWindow,
        supportsMessageThreads:
          model.compat && "supportsMessageThreads" in model.compat
            ? model.compat.supportsMessageThreads
            : undefined,
      });
    }
    await writeFile(join(input.root, "auth.json"), "{}");
    const signedOut = (await models.getAuth("anthropic")) === undefined;
    const result = {
      views,
      captures,
      logs,
      selectedModels,
      warnings,
      signedOut,
      modelIds: models
        .getProvider("anthropic")!
        .getModels()
        .map((model) => model.id),
      jsonOnlyProviderLoaded:
        models.getProvider("json-only-provider") !== undefined,
    };
    console.log("MODELS_JSON_RESULT=" + JSON.stringify(result));
    return result;
  } finally {
    await host.close();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
}

export type TurnResult = Awaited<ReturnType<typeof run>>;
