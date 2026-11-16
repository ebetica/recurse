import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config } from "../../../src/config";
import { buildApp, WebLogSink } from "../../../src/web/app";
import { publishLoopbackToken } from "../../../src/web/request_auth";
import { until } from "./durable_host/host";

export async function run(input: { root: string; endpoint: string }) {
  const root = join(input.root, "selection");
  const agent = join(root, "settings", "pi-agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "file-provider": {
          name: "File provider",
          api: "anthropic-messages",
          baseUrl: new URL("/file-provider/", input.endpoint).href,
          apiKey: "file-literal-private-key",
          models: [{ id: "file-model" }],
        },
      },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    CHAT_DATA_DIR: join(root, "data"),
    CHAT_REPO_URL: input.root,
    CHAT_MODEL: "file-provider/file-model",
    RECURSE_HOME: join(root, "settings"),
    PI_CODING_AGENT_DIR: agent,
    PI_BG_SHELL: "0",
    PI_OFFLINE: "1",
    PORT: "8787",
  };
  const pending = new Config({ env });
  const beforeListing = {
    listed: pending.piModelListState().count !== null,
    fileModel: pending.isFileProviderModel("file-provider/file-model"),
    defaultModel: pending.defaultChatModel(),
    defaultOption: pending.chatModel().id,
    defaultLevels: pending.effortLevels(),
  };
  const logs: string[] = [];
  const app = await buildApp({
    env,
    sink: new WebLogSink((line) => logs.push(line)),
  });
  const server = await app.serve({ port: 0 });
  const request = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    await until(() => app.instance.config.piModelListState().count !== null);
    const defaultModel = app.instance.config.defaultChatModel();
    const defaultLevels = app.instance.config.effortLevels();
    const caller = await request("/api/conversations", {});
    const callerId = String(caller.body.id);
    const token = await publishLoopbackToken(join(root, "data"), server.port);
    const headers = {
      "x-loopback-token": token,
      "x-recurse-agent": callerId,
      "x-recurse-bundled-tool": "subagent",
    };
    const rawSpawn = await request(
      "/api/conversations/spawn",
      {
        id: "file-raw",
        parent: callerId,
        title: "Raw selection",
        model: "file-provider/file-model",
        operator_selected_model: true,
      },
      headers,
    );
    const rawCreate = await request(
      "/api/conversations",
      { model: "file-provider/file-model", operatorSelectedModel: true },
      headers,
    );
    const explicit = await request("/api/conversations", {
      model: "file-provider/file-model",
    });
    const cid = String(explicit.body.id);
    const pin = await request("/api/settings/effort-levels", {
      default_level: 2,
      levels: {
        ...defaultLevels,
        "3": { model: "file-provider/file-model", reasoning: "off" },
      },
    });
    const levelSpawn = await request(
      "/api/conversations/spawn",
      {
        id: "file-level",
        parent: callerId,
        title: "Saved effort",
        effort: 3,
      },
      headers,
    );
    await until(() => app.instance.conversations.load("file-level") !== null);
    const levelRecord = app.instance.conversations.load("file-level");
    const inheritedSpawn = await request(
      "/api/conversations/spawn",
      {
        id: "file-inherited",
        parent: cid,
        title: "Inherited default",
        taken_over: true,
      },
      headers,
    );
    const siblingSpawn = await request(
      "/api/conversations/spawn",
      {
        id: "file-sibling",
        creator: cid,
        parent: null,
        sibling: true,
        title: "Sibling default",
        taken_over: true,
      },
      headers,
    );
    await until(
      () =>
        app.instance.conversations.load("file-inherited") !== null &&
        app.instance.conversations.load("file-sibling") !== null,
    );
    const inherited = [
      app.instance.conversations.load("file-inherited")!.model,
      app.instance.conversations.load("file-sibling")!.model,
    ];
    const rawChange = await request(
      `/api/conversations/${callerId}/model`,
      { model: "file-provider/file-model" },
      headers,
    );
    const sent = await request(`/api/conversations/${cid}/deliver`, {
      content: "Reply without tools",
    });
    await until(async () =>
      JSON.stringify((await app.instance.durable.view(cid)).blocks).includes(
        "NORMAL_MODEL_OK",
      ),
    );
    await until(async () =>
      JSON.stringify(
        (await app.instance.durable.view("file-level")).blocks,
      ).includes("NORMAL_MODEL_OK"),
    );
    await until(() =>
      logs.some((line) => line.includes("conversation_title_failed")),
    );
    const prompt = await app.instance.durable.prompt(cid);
    console.log(
      "MODELS_JSON_RESULT=" +
        JSON.stringify({
          selection: {
            beforeListing,
            defaultModel,
            defaultLevels,
            responses: {
              rawSpawn,
              rawCreate,
              rawChange,
              pin,
              levelSpawn,
              inheritedSpawn,
              siblingSpawn,
              explicit,
              sent,
            },
            levelRecord,
            inherited,
            naming: prompt.naming,
            namingFailed: logs.some((line) =>
              line.includes("conversation_title_failed"),
            ),
            authenticated: [...app.instance.config.authedModelProviders()],
          },
        }),
    );
  } finally {
    await server.close();
  }
}
