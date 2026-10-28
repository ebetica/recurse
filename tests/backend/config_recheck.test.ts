import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, SETTINGS_RECHECK_MS } from "../../src/config";

test("Settings files are re-read once per window; own writes apply at once", () => {
  const root = mkdtempSync(join(tmpdir(), "recurse-config-recheck-"));
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
    edit("effort-levels.json", { default_level: 2 });
    edit("model-providers.json", provider("one"));
    let now = 0;
    const config = createConfig({
      env: {
        HOME: join(root, "home"),
        CHAT_DATA_DIR: join(root, "data"),
        RECURSE_HOME: join(root, "recurse-home"),
        CHAT_REPO_URL: "https://fixture.invalid/target.git",
      },
      cwd: root,
      settingsRecheckMs: SETTINGS_RECHECK_MS,
      now: () => now,
    });
    expect(config.defaultEffortLevel()).toBe(2);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("one");

    edit("effort-levels.json", { default_level: 4 });
    edit("model-providers.json", provider("two"));
    now += SETTINGS_RECHECK_MS - 1;
    expect(config.defaultEffortLevel()).toBe(2);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("one");

    expect(config.setMaximumContextWindow(200_000)).toBe(200_000);
    expect(config.maximumContextWindow()).toBe(200_000);
    expect(config.defaultEffortLevel()).toBe(4);
    expect(config.customModelProviders().local?.models[0]?.id).toBe("two");

    edit("maximum-context-window.json", { maximum_context_window: 300_000 });
    expect(config.maximumContextWindow()).toBe(200_000);
    now += SETTINGS_RECHECK_MS;
    expect(config.maximumContextWindow()).toBe(300_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
