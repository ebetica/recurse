import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { abortable } from "../../src/utils/tasks";
import { retire } from "../../src/utils/trash";
import { createConfig, SETTINGS_RECHECK_MS } from "../../src/config";
import { seedPiModelList } from "./pi_model_list_fixture";

test("Settings files are re-read once per window; own writes apply at once", async () => {
  const root = mkdtempSync(join(tmpdir(), "recurse-config-recheck-"));
  let config: ReturnType<typeof createConfig> | undefined;
  try {
    const dir = join(root, "data", "config");
    mkdirSync(dir, { recursive: true });
    const edit = (name: string, value: unknown) =>
      writeFileSync(join(dir, name), JSON.stringify(value));
    const provider = (model: string) => ({
      providers: {
        local: {
          base_url: "http://127.0.0.1:1/v1",
          env_key: "LOCAL_KEY",
          wire_api: "completions",
          models: [{ id: model }],
        },
      },
    });
    seedPiModelList(dir);
    edit("deleted-agent-history.json", { days: 7 });
    edit("effort-levels.json", { default_level: 2 });
    edit("model-providers.json", provider("one"));
    let now = 0;
    config = createConfig({
      env: {
        HOME: join(root, "home"),
        CHAT_DATA_DIR: join(root, "data"),
        RECURSE_HOME: join(root, "recurse-home"),
        CHAT_REPO_URL: "https://fixture.invalid/target.git",
      },
      cwd: root,
      settingsRecheckMs: SETTINGS_RECHECK_MS,
      authenticatedProviders: () => ["anthropic", "openai-codex"],
      now: () => now,
    });
    await config.refreshSettings();
    expect(config.defaultEffortLevel()).toBe(2);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("one");
    edit("deleted-agent-history.json", { days: 90 });
    expect(config.deletedAgentHistoryDays()).toBe(7);
    expect(await config.refreshDeletedAgentHistoryDays()).toBe(90);

    edit("effort-levels.json", { default_level: 4 });
    edit("model-providers.json", provider("two"));
    now += SETTINGS_RECHECK_MS - 1;
    expect(config.defaultEffortLevel()).toBe(2);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("one");

    expect(await config.setMaximumContextWindow(200_000)).toBe(200_000);
    expect(config.maximumContextWindow()).toBe(200_000);
    await config.refreshSettings();
    expect(config.defaultEffortLevel()).toBe(4);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("two");

    edit("maximum-context-window.json", { maximum_context_window: 300_000 });
    expect(config.maximumContextWindow()).toBe(200_000);
    now += SETTINGS_RECHECK_MS;
    expect(config.maximumContextWindow()).toBe(200_000);
    await config.refreshSettings();
    expect(config.maximumContextWindow()).toBe(300_000);

    const model = config.effortLevels()[3]!.model;
    edit("available-models.json", {
      turn_marks: { "3": { model, reason: "provider unavailable" } },
    });
    await config.refreshSettings();
    expect(config.effortLevelReachability()[3]!.reason).toContain(
      "provider unavailable",
    );
    edit("available-models.json", {});
    expect(config.effortLevelReachability()[3]!.reachable).toBe(false);
    await config.refreshSettings();
    expect(config.effortLevelReachability()[3]!.reachable).toBe(true);
    await config.noteLevelTurnFailure(3, "request failed");
    expect(config.effortLevelReachability()[3]!.reason).toContain(
      "request failed",
    );
    await config.noteLevelTurnSuccess(3);
    expect(config.effortLevelReachability()[3]!.reachable).toBe(true);
    const spec = { ...config.customModelProviders().local! };
    expect(
      await Promise.all(
        ["first", "second"].map((name) =>
          config!.upsertCustomProvider(name, spec),
        ),
      ),
    ).toEqual([true, true]);
    expect(
      Object.keys(
        JSON.parse(readFileSync(config.paths.MODEL_PROVIDERS_FILE, "utf8"))
          .providers,
      ).sort(),
    ).toEqual(["first", "local", "second"]);
    await Promise.all([
      config.noteLevelTurnFailure(2, "first failure"),
      config.noteLevelTurnFailure(3, "second failure"),
    ]);
    const marks = JSON.parse(
      readFileSync(config.paths.AVAILABLE_MODELS_FILE, "utf8"),
    ).turn_marks;
    expect(marks["2"].reason).toBe("first failure");
    expect(marks["3"].reason).toBe("second failure");
    const contextPath = config.paths.MAXIMUM_CONTEXT_WINDOW_FILE;
    rmSync(contextPath);
    mkdirSync(contextPath);
    await expect(config.setMaximumContextWindow(400_000)).rejects.toThrow();
    expect(config.maximumContextWindow()).toBe(300_000);
    retire(contextPath, join(root, "trash"));
    expect(await config.setMaximumContextWindow(400_000)).toBe(400_000);
    expect(config.maximumContextWindow()).toBe(400_000);
    expect(statSync(contextPath).mode & 0o777).toBe(0o600);
  } finally {
    await config?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: #3023 cached Settings reads do not wait for disk or undo a newer own write.
test("cached Settings reads do not wait for disk or undo a newer own write", async () => {
  const root = mkdtempSync(join(tmpdir(), "recurse-config-fifo-"));
  const dir = join(root, "data", "config");
  const path = join(dir, "maximum-context-window.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ maximum_context_window: 200_000 }));
  const worker = new Worker(
    new URL("./fixtures/config_recheck_worker.ts", import.meta.url).href,
  );
  const waiting = new Map<string, (value: number) => void>();
  const next = (name: string) =>
    new Promise<number>((resolve) => waiting.set(name, resolve));
  worker.onmessage = (event: MessageEvent<{ type: string; value: number }>) => {
    waiting.get(event.data.type)?.(event.data.value);
    waiting.delete(event.data.type);
  };
  let writer: Awaited<ReturnType<typeof open>> | undefined;
  let requested = false;
  let ownWritten = false;
  let refreshed: Promise<number> | undefined;
  try {
    const ready = next("ready");
    worker.postMessage({ type: "init", root });
    expect(await abortable(ready, AbortSignal.timeout(5_000))).toBe(200_000);
    rmSync(path);
    expect(
      await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "inherit" })
        .exited,
    ).toBe(0);
    const read = next("read");
    refreshed = next("refreshed");
    requested = true;
    worker.postMessage({ type: "read" });
    expect(await abortable(read, AbortSignal.timeout(5_000))).toBe(200_000);
    writer = await open(path, "w");
    const written = next("written");
    worker.postMessage({ type: "write" });
    expect(await abortable(written, AbortSignal.timeout(5_000))).toBe(400_000);
    ownWritten = true;
  } finally {
    try {
      if (requested) {
        writer ??= await open(path, "r+");
        await writer.writeFile(
          JSON.stringify({ maximum_context_window: 300_000 }),
        );
        await writer.close();
        const value = await abortable(refreshed!, AbortSignal.timeout(5_000));
        if (ownWritten) expect(value).toBe(400_000);
      }
    } finally {
      worker.terminate();
      retire(root, join(tmpdir(), "config-fixture-trash"));
    }
  }
});

// Regression: #3050 Settings read-modify-write disk waits must not block cached reads.
test("Settings provider writes keep cached reads responsive during a disk wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "recurse-config-write-fifo-"));
  const dir = join(root, "data", "config");
  const path = join(dir, "model-providers.json");
  const document = JSON.stringify({ providers: {} });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, document);
  writeFileSync(
    join(dir, "maximum-context-window.json"),
    JSON.stringify({ maximum_context_window: 200_000 }),
  );
  const worker = new Worker(
    new URL("./fixtures/config_recheck_worker.ts", import.meta.url).href,
  );
  const waiting = new Map<string, (value: number) => void>();
  const next = (name: string) =>
    new Promise<number>((resolve) => waiting.set(name, resolve));
  worker.onmessage = (event: MessageEvent<{ type: string; value: number }>) => {
    waiting.get(event.data.type)?.(event.data.value);
    waiting.delete(event.data.type);
  };
  let writer: Awaited<ReturnType<typeof open>> | undefined;
  let seeded: Promise<number> | undefined;
  try {
    const ready = next("ready");
    worker.postMessage({ type: "init", root });
    expect(await abortable(ready, AbortSignal.timeout(5_000))).toBe(200_000);
    rmSync(path);
    expect(
      await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "inherit" })
        .exited,
    ).toBe(0);
    chmodSync(path, 0o640);
    seeded = next("seeded");
    worker.postMessage({ type: "seed" });
    writer = await open(path, "w");
    const cached = next("cached");
    worker.postMessage({ type: "cached" });
    expect(await abortable(cached, AbortSignal.timeout(5_000))).toBe(200_000);
    await writer.writeFile(document);
    await writer.close();
    writer = undefined;
    expect(await abortable(seeded, AbortSignal.timeout(5_000))).toBe(1);
    seeded = undefined;
    expect(
      JSON.parse(readFileSync(path, "utf8")).providers.local.models,
    ).toEqual([{ id: "one" }]);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  } finally {
    try {
      if (seeded) {
        writer ??= await open(path, "r+");
        await writer.writeFile(document);
        await writer.close();
        await abortable(seeded, AbortSignal.timeout(5_000));
      }
    } finally {
      worker.terminate();
      retire(root, join(tmpdir(), "config-fixture-trash"));
    }
  }
});
