import { seedPiModelList } from "./pi_model_list_fixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Config } from "../../src/config";
import { AnthropicAuth } from "../../src/auth/anthropic";
import { CodexAuth } from "../../src/auth/codex";
import { MuseAuth } from "../../src/auth/muse";
import { OAuthStore } from "../../src/auth/oauth";
import { OpenRouterAuth } from "../../src/auth/openrouter";
import { ProviderSnapshot } from "../../src/auth/provider_snapshot";
import { ISOLATED_PATH_ENV } from "../../src/local_roots";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import { RecurseUpdates } from "../../src/recurse_update";
import { Router } from "../../src/web/router";
import { registerSettingsRoutes } from "../../src/web/settings";
import { Refs, runRefCases, type RefCase } from "./http_refs";
import { serveOpen } from "./http_open_app";
import corpus from "./fixtures/http_settings/cases.json";
import seed from "./fixtures/http_settings/seed.json";

type Rec = Record<string, unknown>;
type SettingsCase = RefCase & {
  current: {
    status: number;
    body?: unknown;
    files?: Rec;
    partial?: object;
    login_url?: string;
    error_max?: number;
    requests?: Rec[];
  };
};

const NOW = 1790000000.25;
import { fakePiPackage } from "./fake_pi_auth";

const WORK = mkdtempSync(join(tmpdir(), "http-settings-"));
let PACKAGE = "";

beforeAll(() => {
  PACKAGE = fakePiPackage(join(WORK, "pkg"));
});
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function tokenBytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) % 256);
}

function fakeServer() {
  const responses: [number, string][] = [];
  const requests: Rec[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const bodyText = await request.text();
      const content_type = request.headers.get("content-type");
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        content_type,
        authorization: request.headers.get("authorization"),
        body:
          content_type === "application/json"
            ? JSON.parse(bodyText)
            : Object.fromEntries(new URLSearchParams(bodyText)),
      });
      const [status, text] = responses.shift() ?? [599, "unqueued"];
      return new Response(text, { status });
    },
  });
  return {
    responses,
    requests,
    server,
    url: `http://127.0.0.1:${server.port}`,
  };
}

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

describe("corpus", () => {
  // Regression: #2897 isolated test installs skip update checks and refuse Update now.
  test("http_settings", async () => {
    const root = join(WORK, "root");
    mkdirSync(join(root, "data"), { recursive: true });
    const agent = join(root, "pi-agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify(seed.auth), {
      mode: 0o600,
    });
    const ambient: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      RECURSE_PI_PACKAGE_ROOT: PACKAGE,
    };
    const env = {
      ...Object.fromEntries(
        Object.entries(ISOLATED_PATH_ENV).map(([k, v]) => [k, join(root, v)]),
      ),
      ...ambient,
    };
    // eslint-disable-next-line prefer-const
    let snapshot: ProviderSnapshot;
    const config = new Config({
      env,
      authenticatedProviders: () => snapshot.authenticatedProviders(),
      storedCustomProviders: () => snapshot.storedCustomProviders(),
    });
    seedPiModelList(config.paths.CONFIG_DIR);
    for (const [name, doc] of Object.entries(seed.settings))
      writeFileSync(join(config.paths.CONFIG_DIR, name), JSON.stringify(doc));
    const shellState = join(root, "shell-state");
    mkdirSync(shellState, { recursive: true });
    const store = new OAuthStore({
      piAgentDir: async () => agent,
      ambient,
      customProviderIds: () => Object.keys(config.customModelProviders()),
      lifecycle: new ProcessLifecycle({
        registry: new ShellRegistry({
          enabled: true,
          stateDir: shellState,
          processStartedMs: Date.now(),
        }),
        shellStateDir: shellState,
        termGraceMs: 200,
        killGraceMs: 500,
      }),
    });
    const fake = fakeServer();
    const common = {
      store,
      ambient,
      home: ambient.HOME,
      nowMs: () => NOW * 1000,
      randomBytes: tokenBytes,
    };
    const anthropic = new AnthropicAuth({
      ...common,
      tokenUrl: `${fake.url}/claude/token`,
    });
    const codex = new CodexAuth({
      ...common,
      tokenUrl: `${fake.url}/codex/token`,
    });
    const muse = new MuseAuth({
      store,
      config,
      env: ambient,
      userAgent: "recurse-fixture/1",
      timeoutMs: 30_000,
      now: () => NOW,
      endpoints: {
        device: `${fake.url}/meta/device`,
        token: `${fake.url}/meta/token`,
        key: `${fake.url}/meta/key`,
      },
    });
    const openrouter = new OpenRouterAuth({ store, env: ambient });
    snapshot = new ProviderSnapshot({
      anthropic,
      codex,
      muse,
      openrouter,
      customProviderNames: () => Object.keys(config.customModelProviders()),
      storedApiKey: (name) => store.storedApiKey(name),
    });
    await snapshot.refresh();
    const updates = new RecurseUpdates({
      sourceRoot: root,
      cacheFile: join(root, "update-check.json"),
      release: { version: "0.1.0", commit: null },
      env: { RECURSE_ISOLATED_ROOT: root },
      send: () => {
        throw new Error("isolated installs must not update");
      },
      spawn: async () => {
        throw new Error("isolated installs must not check for updates");
      },
    });
    const router = new Router();
    registerSettingsRoutes(router, {
      config,
      anthropic,
      codex,
      muse,
      openrouter,
      credentials: store,
      providers: snapshot,
      piAgentDir: async () => agent,
      mutateExternalStorage: (work) => work(),
      modelUpdates: {
        status: () => {
          throw new Error("not in the recorded corpus");
        },
        start: () => {
          throw new Error("not in the recorded corpus");
        },
      },
      recurseUpdates: updates,
    });
    const { running } = await serveOpen(router, join(root, "data"));
    const refs = new Refs();
    refs.put("fake", fake.url);
    const expectedFiles: Rec = {
      ...Object.fromEntries(
        Object.entries(seed.settings).map(([name, doc]) => [
          `data/config/${name}`,
          doc,
        ]),
      ),
      ...seed.expected_files,
      "pi-agent/auth.json": seed.auth,
    };
    let checked = 0;
    try {
      const problems = await runRefCases(
        running.port,
        corpus.cases as unknown as SettingsCase[],
        refs,
        {
          setup: (spec) => {
            fake.responses.push(...((spec.reply ?? []) as [number, string][]));
            for (const [rel, text] of Object.entries(
              (spec.files ?? {}) as Record<string, string>,
            )) {
              mkdirSync(dirname(join(root, rel)), { recursive: true });
              writeFileSync(join(root, rel), text);
            }
            for (const rel of (spec.remove ?? []) as string[])
              unlinkSync(join(root, rel));
          },
          expect: (item, got) => {
            const current = (item as SettingsCase).current;
            expect(got.status, item.name).toBe(current.status);
            Object.assign(expectedFiles, current.files);
            for (const [rel, want] of Object.entries(expectedFiles)) {
              const path = join(root, rel);
              expect(existsSync(path), `${item.name}: ${rel}`).toBe(
                want !== null,
              );
              if (want === null) continue;
              const actual = readJson(path);
              if (actual && rel.endsWith("_pending.json"))
                delete actual.created;
              expect(actual, `${item.name}: ${rel}`).toEqual(want);
              if (rel.startsWith("pi-agent/"))
                expect(statSync(path).mode & 0o777).toBe(0o600);
            }
            const body = (got.body as { json: unknown }).json;
            const value = body as Rec;
            const publicText = JSON.stringify(got.body);
            for (const credential of Object.values(
              readJson(join(agent, "auth.json")),
            ) as Rec[])
              for (const key of ["key", "access", "refresh"])
                if (typeof credential[key] === "string")
                  expect(publicText, item.name).not.toContain(
                    credential[key] as string,
                  );
            if (current.body !== undefined)
              expect(body, item.name).toEqual(current.body);
            if (current.partial) {
              expect(body, item.name).toMatchObject(current.partial);
              if (Array.isArray(current.partial))
                expect((body as unknown[]).length, item.name).toBe(
                  current.partial.length,
                );
              for (const [key, want] of Object.entries(current.partial))
                if (Array.isArray(want))
                  expect((value[key] as unknown[]).length, item.name).toBe(
                    want.length,
                  );
            }
            if (current.login_url)
              expect(refs.values.get("settings_login_url"), item.name).toBe(
                current.login_url,
              );
            if (current.error_max !== undefined) {
              expect(typeof value.detail, item.name).toBe("string");
              expect(
                [...(value.detail as string)].length,
                item.name,
              ).toBeLessThanOrEqual(current.error_max);
            }
            expect(fake.requests, item.name).toEqual(current.requests ?? []);
            expect(fake.responses, item.name).toEqual([]);
            fake.requests.length = 0;
            fake.responses.length = 0;
            checked++;
            return null;
          },
        },
      );
      expect(problems).toEqual([]);
      expect(checked).toBe(82);
      const url = `http://127.0.0.1:${running.port}/api/settings/update`;
      const status = await fetch(url);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        skipped:
          "Updates are off for isolated test installs (RECURSE_ISOLATED_ROOT).",
        checking: false,
        checked_at: null,
      });
      const apply = await fetch(url, { method: "POST" });
      expect(apply.status).toBe(409);
      expect(await apply.json()).toMatchObject({
        detail:
          "Updates are off for isolated test installs (RECURSE_ISOLATED_ROOT).",
      });
      expect(existsSync(join(root, "update-check.json"))).toBe(false);
    } finally {
      await running.close();
      fake.server.stop(true);
    }
  }, 120_000);
});
