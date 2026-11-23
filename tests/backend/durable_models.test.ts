import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableHost } from "../../src/agents/durable/host.ts";
import {
  customProviderSync,
  durableModels,
  trustedModelCatalog,
} from "../../src/agents/durable/models.ts";
import { idle, testDeps, until } from "./fixtures/durable_host/host.ts";

const root = mkdtempSync(join(tmpdir(), "durable-host-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAR = Date.now() + 365 * 24 * 3600 * 1000;

describe("durableModels", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });

  test("ignores stray provider keys in the server environment", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(join(dir, "auth.json"), "{}");
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir, undefined, undefined, { HOME: dir });
    expect(await models.getAuth("anthropic")).toBeUndefined();
    expect(await models.getAuth("openai")).toBeUndefined();
    expect(await models.getAuth("openai-codex")).toBeUndefined();
  });

  test("each provider resolves only its own stored credential", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-stored" },
        openai: { type: "api_key", key: "sk-openai-stored" },
        "openai-codex": {
          type: "oauth",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: FAR,
          accountId: "acct",
        },
      }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir);
    expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe(
      "sk-ant-stored",
    );
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe(
      "sk-openai-stored",
    );
    expect((await models.getAuth("openai-codex"))?.auth.apiKey).toBe(
      "codex-access",
    );
    const authPath = join(dir, "auth.json");
    const stored = JSON.parse(await Bun.file(authPath).text());
    stored.openai.key = "sk-openai-updated";
    await Bun.write(authPath, JSON.stringify(stored));
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe(
      "sk-openai-updated",
    );
    await Promise.all([models.logout("anthropic"), models.logout("openai")]);
    expect(await models.getAuth("anthropic")).toBeUndefined();
    expect(await models.getAuth("openai")).toBeUndefined();
    expect(JSON.parse(await Bun.file(authPath).text())).toEqual({
      "openai-codex": stored["openai-codex"],
    });
  });

  test("an Anthropic subscription resolves as OAuth, not an env key", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "ant-access",
          refresh: "ant-refresh",
          expires: FAR,
        },
      }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    const auth = await durableModels(dir).getAuth("anthropic");
    expect(auth?.source).toBe("OAuth");
    expect(JSON.stringify(auth)).not.toContain("sk-ant-stray");
  });

  test("a custom provider uses its stored key, else its env_key; removing it restores a built-in it replaced", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ stored: { type: "api_key", key: "stored-key" } }),
    );
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir);
    const trusted = trustedModelCatalog(models);
    const [builtIn] = trusted.getModels("openai");
    expect(builtIn).toBeDefined();
    const spec = (models: string[]) => ({
      base_url: "http://127.0.0.1:9/v1",
      env_key: "CUSTOM_KEY",
      wire_api: "responses" as const,
      models: models.map((id) => ({ id, effort: null })),
    });
    const sync = customProviderSync(models, (provider) =>
      provider === "stored" ? "env-stored" : `env-${provider}`,
    );
    sync({ stored: spec(["a"]), fromenv: spec(["b"]), openai: spec(["c"]) });
    expect((await models.getAuth("stored"))?.auth.apiKey).toBe("stored-key");
    expect((await models.getAuth("fromenv"))?.auth.apiKey).toBe("env-fromenv");
    expect(models.getModel("fromenv", "b")?.api).toBe("openai-responses");
    expect(models.getModel("openai", builtIn!.id)).toBeUndefined();
    expect(trusted.getModel("openai", builtIn!.id)).toBe(builtIn!);
    expect(trusted.getModel("openai", "c")).toBeUndefined();
    sync({ stored: spec(["a"]) });
    expect(models.getModel("fromenv", "b")).toBeUndefined();
    expect(models.getModel("openai", "c")).toBeUndefined();
    expect(models.getModel("openai", builtIn!.id)).toBeDefined();
    expect(await models.getAuth("openai")).toBeUndefined();
  });
});

type Rec = Record<string, unknown>;

const rows = async (host: DurableHost, cid: string) =>
  ((await host.view(cid, { limit: 50 })).blocks as Rec[]).map((b) => [
    b.role,
    b.kind === "tool_call" ? `${String(b.name)}:${String(b.result)}` : b.text,
  ]);

const record = (cid: string, workdir: string): Rec => ({
  id: cid,
  backend: "durable",
  workdir,
});

describe("DurableHost", () => {
  test("a Settings custom provider runs turns against its endpoint with its env_key; an edit applies to the next send", async () => {
    const seen: { path: string; auth: string | null; model: unknown }[] = [];
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { model?: unknown };
        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          model: body.model,
        });
        return new Response(
          chunk({ role: "assistant", content: "custom reply" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const settings = (path: string) => ({
      "local-llm": {
        base_url: `http://127.0.0.1:${server.port}${path}`,
        env_key: "LOCAL_LLM_KEY",
        wire_api: "completions" as const,
        models: [{ id: "small", context_window: 100000, effort: null }],
      },
    });
    let providers = settings("/v1");
    const dataDir = mkdtempSync(join(root, "data-"));
    const records = { c1: record("c1", root) };
    const asked: string[] = [];
    const host = new DurableHost({
      ...testDeps(
        dataDir,
        (cid) => records[cid as "c1"] ?? null,
        () => Object.keys(records),
        "local-llm/small",
      ),
      customProviders: () => providers,
      customProviderEnvValue: (provider) => {
        asked.push(provider);
        return provider === "local-llm" ? "env-key-1" : undefined;
      },
    });
    try {
      await host.send("c1", "hello", "r1");
      await until(async () => (await rows(host, "c1")).length === 2);
      expect(await rows(host, "c1")).toEqual([
        ["user", "hello"],
        ["assistant", "custom reply"],
      ]);
      providers = settings("/v2");
      await until(idle(host));
      await host.send("c1", "again", "r2");
      await until(async () => (await rows(host, "c1")).length === 4);
      expect(seen).toEqual([
        {
          path: "/v1/chat/completions",
          auth: "Bearer env-key-1",
          model: "small",
        },
        {
          path: "/v2/chat/completions",
          auth: "Bearer env-key-1",
          model: "small",
        },
      ]);
      expect(new Set(asked)).toEqual(new Set(["local-llm"]));
    } finally {
      await host.close();
      server.stop(true);
    }
  });
});
