import { closeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { openServerLog, ownSession, readDurableEntries } from "../live_e2e.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxHost, idle, until } from "./fixtures/durable_host/host.ts";
import { seedPiModelList, TEST_PI_MODELS } from "./pi_model_list_fixture.ts";
import { Config, PI_MODEL_LIST_VERSION } from "../../src/config.ts";
import {
  assertOAuthCredentialsFresh,
  liveModel,
  liveSecondModel,
  stopServer,
  validateSecondModelReplies,
} from "../live_e2e_helpers.ts";

test("live model selection reads Settings and refuses unlisted routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-model-settings-"));
  try {
    const config = new Config({ env: { CHAT_DATA_DIR: root } });
    await mkdir(config.paths.CONFIG_DIR, { recursive: true });
    const levels = {
      1: { model: "fixture/first", reasoning: "low" },
      2: { model: "fixture/selected", reasoning: "high" },
    };
    await writeFile(
      config.paths.EFFORT_LEVELS_FILE,
      JSON.stringify({ default_level: 2, levels }),
    );
    expect(liveModel("fixture", config).route).toEqual({
      provider: "fixture",
      modelId: "selected",
    });
    await writeFile(
      config.paths.EFFORT_LEVELS_FILE,
      JSON.stringify({ default_level: 1, levels }),
    );
    expect(liveModel("fixture", config).id).toBe(levels[1].model);
    await writeFile(
      config.paths.EFFORT_LEVELS_FILE,
      JSON.stringify({
        default_level: 3,
        levels: { ...levels, 3: { model: "other/default", reasoning: "low" } },
      }),
    );
    expect(liveModel("fixture", config).id).toBe(levels[1].model);
    expect(() => liveModel("absent", config)).toThrow(
      "Settings > Effort ladder",
    );
    await writeFile(
      config.paths.PI_MODEL_LIST_FILE,
      JSON.stringify({ version: PI_MODEL_LIST_VERSION, models: [] }),
    );
    expect(() => liveModel("fixture", config)).toThrow(
      "not in Pi's model list",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #2656 catalog order must not select an unconfigured second model.
test("second live route uses Settings over the recorded authenticated catalog order", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-second-settings-"));
  try {
    const config = new Config({
      env: { CHAT_DATA_DIR: root },
      authenticatedProviders: () => ["anthropic", "openai-codex"],
    });
    seedPiModelList(config.paths.CONFIG_DIR);
    const routes = TEST_PI_MODELS.filter(
      (model) => model.provider === "openai-codex",
    );
    const selected = `${routes[1].provider}/${routes[1].id}`;
    await writeFile(
      config.paths.EFFORT_LEVELS_FILE,
      JSON.stringify({
        default_level: 1,
        levels: { 1: { model: selected, reasoning: "high" } },
      }),
    );
    const catalog = config.authedChatModels();
    expect(
      catalog.find((model) => model.id.split("/", 1)[0] === routes[0].provider)
        ?.id,
    ).not.toBe(selected);
    expect(liveSecondModel(catalog, config)).toBe(selected);
    await writeFile(
      config.paths.PI_MODEL_LIST_FILE,
      JSON.stringify({
        version: PI_MODEL_LIST_VERSION,
        models: TEST_PI_MODELS.filter((model) => model.id !== routes[1].id),
      }),
    );
    expect(() => liveSecondModel(catalog, config)).toThrow(
      "not in Pi's model list",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("live E2E auth guard", () => {
  test("rejects OAuth credentials expiring inside the safe window", () => {
    const now = 2_000_000_000_000;
    const auth = JSON.stringify({
      anthropic: { type: "oauth", expires: now + 59 * 60_000 },
      openrouter: { type: "api_key", key: "fake" },
    });
    expect(() => assertOAuthCredentialsFresh(auth, now)).toThrow(
      /OAuth credential for anthropic expires in 59 minutes/,
    );
    expect(() =>
      assertOAuthCredentialsFresh(
        JSON.stringify({
          anthropic: { type: "oauth", expires: now + 60 * 60_000 },
        }),
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertOAuthCredentialsFresh(
        JSON.stringify({
          anthropic: { type: "oauth", expires: now + 59 * 60_000 },
        }),
        now,
      ),
    ).toThrow(/expires in 59 minutes/);
  });
});

describe("live E2E process evidence", () => {
  test("server log appends across restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "recurse-live-e2e-test-"));
    const log = join(root, "server.log");
    const fd = openServerLog(log);
    try {
      for (const line of ["FIRST", "SECOND"]) {
        const child = Bun.spawn(["sh", "-c", `printf '%s\\n' ${line}`], {
          stdout: fd,
          stderr: fd,
        });
        expect(await child.exited).toBe(0);
      }
      expect(await readFile(log, "utf8")).toBe("FIRST\nSECOND\n");
    } finally {
      closeSync(fd);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stopServer leaves no process of the server's group", async () => {
    const child = Bun.spawn([
      "setsid",
      "sh",
      "-c",
      "sleep 300 & sleep 300 & wait",
    ]);
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5_000;
    while (!groupAlive() && Date.now() < deadline) await Bun.sleep(20);
    expect(groupAlive()).toBe(true);
    try {
      await stopServer(child);
      expect(groupAlive()).toBe(false);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }, 60_000);
});

describe("live E2E session ownership", () => {
  // Regression: #2656 Durable evidence must not depend on legacy Pi bindings.
  test("exports a real Durable reply and validates its provider route", async () => {
    const root = await mkdtemp(join(tmpdir(), "recurse-live-e2e-test-"));
    const { host, faux } = fauxHost(join(root, "data"));
    faux.setResponses([fauxAssistantMessage("SECOND_MODEL_OK")]);
    try {
      await host.send("c1", "Reply with SECOND_MODEL_OK", "r1");
      await until(idle(host));
      const entries = await readDurableEntries(root, "c1");
      const exported = await ownSession(
        root,
        "c1",
        String((await host.view("c1", { limit: 50 })).session),
      );
      expect(
        (await readFile(exported, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(entries);
      const replies = entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "assistant");
      expect(replies.length).toBeGreaterThan(0);
      expect(() =>
        validateSecondModelReplies(replies, "faux/faux-1"),
      ).not.toThrow();
      expect(() => validateSecondModelReplies(replies, "other/route")).toThrow(
        "did not answer on that route",
      );
      expect(() => validateSecondModelReplies([], "faux/faux-1")).toThrow(
        "did not answer on that route",
      );
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a Durable store symlink escaping the private root", async () => {
    const root = await mkdtemp(join(tmpdir(), "recurse-live-e2e-test-"));
    const privateRoot = join(root, "private");
    const directory = join(privateRoot, "data/conversations/c1/durable");
    const { host, faux } = fauxHost(join(root, "data"));
    faux.setResponses([fauxAssistantMessage("SECOND_MODEL_OK")]);
    try {
      await host.send("c1", "Reply with SECOND_MODEL_OK", "r1");
      await until(idle(host));
      await mkdir(directory, { recursive: true });
      await symlink(
        join(root, "data/conversations/c1/durable/session.sqlite"),
        join(directory, "session.sqlite"),
      );
      await expect(readDurableEntries(privateRoot, "c1")).rejects.toThrow(
        "private Durable store escaped private root",
      );
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
