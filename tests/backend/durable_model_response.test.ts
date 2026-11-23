import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { Config } from "../../src/config";
import { CodexAuth } from "../../src/auth/codex";
import { OAuthStore } from "../../src/auth/oauth";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import {
  replayProvider,
  type Recording,
} from "./fixtures/provider_replay/server";
import {
  fauxHost,
  held,
  idle,
  testDeps,
  until,
} from "./fixtures/durable_host/host";
import {
  loadRecording,
  replayResponse,
} from "./fixtures/model_response/replay";

// Regression: #2657 Durable requests retain their own effort after settings change.
test("generated responses retain requested effort and provider token counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-response-generation-"));
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const record = { id: "c1", backend: "durable", workdir: root };
  let effort = "high";
  const deps = {
    ...testDeps(
      root,
      () => record,
      () => ["c1"],
    ),
    models,
    settings: (): [string, string] => ["faux/faux-1", effort],
  };
  let host = new DurableHost(deps);
  try {
    const answer = await replayResponse(false);
    delete answer.thinkingLevel;
    for (const requested of ["high", "off"] as const) {
      effort = requested;
      const gate = held(structuredClone(answer));
      faux.setResponses([gate.step]);
      await host.send("c1", "Reply without tools", requested);
      await gate.started;
      effort = requested === "off" ? "high" : "off";
      gate.release();
      await until(idle(host));
      const view = await host.view("c1", {});
      const row = (view.blocks as Record<string, any>[]).findLast(
        (item) => item.role === "assistant",
      )!;
      expect(row.model_response.thinkingLevel).toBe(requested);
      const { conversation } = await host.open("c1");
      const entries = await conversation.entries({}, 100, undefined, context);
      const stored = entries.items.find(
        (entry) => entry.kind === "pi.assistant",
      )!;
      const message = stored.model![0] as typeof answer;
      expect(message.thinkingLevel).toBe(requested);
      expect(row.model_response.inputTokens).toBe(
        message.usage.input +
          message.usage.cacheRead +
          message.usage.cacheWrite,
      );
      expect(row.model_response.outputTokens).toBe(message.usage.output);
      expect((await host.turnPrompt("c1", stored.id))!.model_response).toEqual(
        row.model_response,
      );
    }
    await host.close();
    host = new DurableHost(deps);
    const reopened = await host.view("c1", {});
    expect(
      (reopened.blocks as Record<string, any>[])
        .filter((row) => row.role === "assistant")
        .map((row) => row.model_response.thinkingLevel),
    ).toEqual(["high", "off"]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #2902 Settings catalog updates reach a running Durable host without network refresh.
test("a stored Pi catalog update runs through the built-in provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-catalog-"));
  const stored = await Bun.file(
    new URL("./fixtures/model_response/models-store.json", import.meta.url)
      .pathname,
  ).json();
  const catalogModel = stored["openai-codex"].models[0];
  const recording = (await Bun.file(
    new URL(
      "./fixtures/provider_replay/openai-codex-auto.json",
      import.meta.url,
    ).pathname,
  ).json()) as Recording;
  recording.exchanges[0]!.request.model = catalogModel.id;
  recording.exchanges.push(recording.exchanges[0]!);
  let expectedBearer: string;
  const replay = replayProvider(recording, {
    timeScale: 0,
    verifyHeaders(headers) {
      if (headers.get("authorization") !== expectedBearer)
        throw new Error("wrong replay bearer token");
    },
  });
  const cliAccess = (account: string, lifetime: number) => {
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + lifetime,
        "https://api.openai.com/auth": { chatgpt_account_id: account },
      }),
    ).toString("base64url");
    return `test.${payload}.test`;
  };
  const record = { id: "c1", backend: "durable", workdir: root };
  const codexHome = join(root, "codex");
  const ambient = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: codexHome,
    CHAT_DATA_DIR: root,
    RECURSE_HOME: join(root, "settings"),
  };
  const config = new Config({ env: ambient });
  const shellStateDir = join(root, "shell-state");
  const tokenRequests: string[] = [];
  const oauth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      tokenRequests.push(new URL(request.url).pathname);
      return new Response(null, { status: 400 });
    },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = input instanceof Request ? input.url : String(input);
    return url === "https://auth.openai.com/oauth/token"
      ? fetch(`${oauth.url.origin}/oauth/token`, init)
      : fetch(...args);
  }) as typeof globalThis.fetch;
  const store = new OAuthStore({
    ambient,
    piAgentDir: async () => root,
    lifecycle: new ProcessLifecycle({
      registry: new ShellRegistry({
        enabled: true,
        stateDir: shellStateDir,
        processStartedMs: Date.now(),
      }),
      shellStateDir,
      termGraceMs: 200,
      killGraceMs: 500,
    }),
  });
  const codex = new CodexAuth({ store, ambient });
  const deps = {
    ...testDeps(
      root,
      () => record,
      () => ["c1"],
    ),
    config,
    settings: (): [string, string] => [
      `openai-codex/${catalogModel.id}`,
      "low",
    ],
  };
  let host = new DurableHost(deps);
  try {
    await mkdir(codexHome);
    await mkdir(shellStateDir);
    const path = join(codexHome, "auth.json");
    const settingsAuth = join(root, "auth.json");
    await writeFile(settingsAuth, "{}");
    const models = await host.models();
    expect(models.getModel("openai-codex", catalogModel.id)?.baseUrl).not.toBe(
      replay.baseUrl + "/backend-api",
    );
    catalogModel.baseUrl = replay.baseUrl + "/backend-api";
    stored["openai-codex"].lastModified = Date.now();
    await writeFile(join(root, "models-store.json"), JSON.stringify(stored));
    const send = async (id: string) => {
      await host.send("c1", "Reply without tools", id);
      await until(idle(host));
    };
    let expectedConnections = 0;
    const assertRequests = (number: number) => {
      expect(replay.requests).toHaveLength(number);
      expect(replay.websocketConnections).toBe(expectedConnections);
      expect(replay.failures).toEqual([]);
      expect(tokenRequests).toEqual([]);
    };
    await writeFile(
      path,
      JSON.stringify({ tokens: { access_token: cliAccess("first", 3600) } }),
    );
    await writeFile(settingsAuth, '{"anthropic":null}');
    await send("invalid-settings-credential");
    assertRequests(0);
    await unlink(settingsAuth);
    await mkdir(settingsAuth);
    await send("unreadable-settings-auth");
    assertRequests(0);
    await rmdir(settingsAuth);
    await writeFile(settingsAuth, "{}");
    await unlink(path);
    await mkdir(path);
    await send("non-regular-cli-auth");
    assertRequests(0);
    await rmdir(path);
    for (const account of ["first", "rotated"]) {
      const access = cliAccess(account, 3600);
      expectedBearer = `Bearer ${access}`;
      const cliAuth = JSON.stringify({
        tokens: {
          access_token: access,
          refresh_token: `test-refresh-${account}`,
        },
      });
      await writeFile(path, cliAuth);
      expect(
        (await models.getAuth("openai-codex"))?.auth.apiKey === access,
      ).toBe(true);
      expect(await host.providerToken("openai-codex")).toBeUndefined();
      await send(account);
      expect((await readFile(path, "utf8")) === cliAuth).toBe(true);
      expect((await readFile(settingsAuth, "utf8")) === "{}").toBe(true);
    }
    replay.assertComplete();
    expect(await host.models()).toBe(models);
    expect(models.getModel("openai-codex", catalogModel.id)).toMatchObject({
      api: catalogModel.api,
      baseUrl: catalogModel.baseUrl,
      contextWindow: catalogModel.contextWindow,
    });
    expect(replay.requests[0]!.model).toBe(catalogModel.id);
    const view = await host.view("c1", {});
    expect(
      (view.blocks as Record<string, any>[]).findLast(
        (row) => row.role === "assistant",
      )?.text,
    ).toContain("RECORDED_PROVIDER_OK");

    const signedInCli = await readFile(path, "utf8");
    const recorded = replay.requests.length;
    expectedConnections = replay.websocketConnections;
    const corruptUnrelatedCredential = async () => {
      const auth = await Bun.file(settingsAuth).json();
      await writeFile(
        settingsAuth,
        JSON.stringify({ ...auth, anthropic: null }),
      );
    };
    const signedInSettings = cliAccess("settings", 3600);
    await codex.startLogin();
    await codex.completeLoginWithToken(
      JSON.stringify({
        access_token: signedInSettings,
        refresh_token: "test-settings-refresh",
        expires_in: 3600,
      }),
    );
    await corruptUnrelatedCredential();
    expect(
      (await models.getAuth("openai-codex"))?.auth.apiKey === signedInSettings,
    ).toBe(true);
    expect(
      (await host.providerToken("openai-codex")) === signedInSettings,
    ).toBe(true);
    await writeFile(settingsAuth, "{}");
    await codex.setApiKey("test-platform-key");
    expect(await codex.authStatus()).toEqual({
      subscription: null,
      api_key: "saved",
    });
    await send("saved-settings-api-key");
    assertRequests(recorded);
    expect((await readFile(path, "utf8")) === signedInCli).toBe(true);
    await corruptUnrelatedCredential();
    expect(await codex.authStatus()).toEqual({
      subscription: null,
      api_key: "saved",
    });

    await writeFile(settingsAuth, "{}");
    expect(await codex.authStatus()).toEqual({
      subscription: "codex_cli",
      api_key: null,
    });
    await codex.logout();
    expect(await codex.authStatus()).toEqual({
      subscription: null,
      api_key: null,
    });
    await send("disconnected-by-settings");
    assertRequests(recorded);
    await host.close();
    host = new DurableHost(deps);
    await send("still-disconnected-after-reopen");
    assertRequests(recorded);
    expect((await readFile(path, "utf8")) === signedInCli).toBe(true);

    await writeFile(settingsAuth, "{}");
    const nearExpiry = JSON.stringify({
      tokens: {
        access_token: cliAccess("rotated", 240),
        refresh_token: "test-refresh-near-expiry",
      },
    });
    await writeFile(path, nearExpiry);
    await send("expired-cli-login");
    assertRequests(recorded);
    expect((await readFile(path, "utf8")) === nearExpiry).toBe(true);
    expect((await readFile(settingsAuth, "utf8")) === "{}").toBe(true);
    const failed = (await host.view("c1", {})).blocks as Record<
      string,
      unknown
    >[];
    expect(failed.findLast((row) => row.role === "assistant")?.error).toContain(
      "Sign in again in Codex CLI or sign in with ChatGPT in Settings.",
    );
  } finally {
    globalThis.fetch = fetch;
    oauth.stop(true);
    await host.close();
    await config.close();
    replay.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("real Anthropic recording with served model id changed survives Durable storage", async () => {
  const recording = await loadRecording();
  const root = await mkdtemp(join(tmpdir(), "model-response-"));
  const { host } = fauxHost(root);
  try {
    const { conversation } = await host.open("c1");
    for (const changed of [true, false]) {
      const message = await replayResponse(changed);
      expect(message.stopReason).toBe("stop");
      expect(message.model).toBe(recording.requestedModel);
      expect(message.thinkingLevel).toBe(recording.requestedEffort);
      expect(message.providerThinkingLevel).toBeDefined();
      if (changed) expect(message.responseModel).toBe(recording.servedModel);
      else expect(message.responseModel).toBeUndefined();
      const { id } = await conversation.commit(
        (tx) =>
          tx.appendEntry(conversation.id, {
            kind: "pi.assistant",
            model: [message],
          }),
        context,
      );
      const stored = await conversation.entries(
        { minEntryId: id, maxEntryId: id },
        1,
        undefined,
        context,
      );
      expect(stored.items[0]!.model![0]).toMatchObject(message);
      const view = await host.view("c1", {});
      const response = (view.blocks as Record<string, any>[]).findLast(
        (row) => row.role === "assistant",
      )!.model_response;
      expect(response?.model).toBe(recording.requestedModel);
      expect(response?.responseModel).toBe(
        changed ? recording.servedModel : undefined,
      );
      expect(response?.thinkingLevel).toBe(message.thinkingLevel);
      expect(response?.inputTokens).toBe(
        message.usage.input +
          message.usage.cacheRead +
          message.usage.cacheWrite,
      );
      expect(response?.outputTokens).toBe(message.usage.output);
      expect(response?.timestamp).toBe(message.timestamp);
      expect(response?.providerThinkingLevel).toBe(
        message.providerThinkingLevel,
      );
      expect((await host.turnPrompt("c1", id))!.model_response).toEqual(
        response,
      );
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
