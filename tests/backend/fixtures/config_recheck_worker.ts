import { createConfig, SETTINGS_RECHECK_MS } from "../../../src/config";
import { join } from "node:path";

declare const self: Worker;
let now = 0;
let config: ReturnType<typeof createConfig>;

self.onmessage = async (
  event: MessageEvent<{ type: string; root: string }>,
) => {
  const { type, root } = event.data;
  if (type === "init") {
    config = createConfig({
      env: { HOME: join(root, "home"), CHAT_DATA_DIR: join(root, "data") },
      cwd: root,
      settingsRecheckMs: SETTINGS_RECHECK_MS,
      now: () => now,
    });
    config.maximumContextWindow();
    await config.refreshSettings?.();
    self.postMessage({ type: "ready", value: config.maximumContextWindow() });
  } else if (type === "read") {
    now = SETTINGS_RECHECK_MS;
    self.postMessage({ type: "read", value: config.maximumContextWindow() });
    await config.refreshSettings?.();
    self.postMessage({
      type: "refreshed",
      value: config.maximumContextWindow(),
    });
  } else if (type === "write") {
    self.postMessage({
      type: "written",
      value: await config.setMaximumContextWindow(400_000),
    });
  } else if (type === "seed") {
    await config.upsertCustomProvider("local", {
      base_url: "http://127.0.0.1:1/v1",
      env_key: "LOCAL_KEY",
      wire_api: "completions",
      models: [{ id: "one" }],
    });
    self.postMessage({
      type: "seeded",
      value: Object.keys(config.customModelProviders()).length,
    });
  } else if (type === "cached") {
    self.postMessage({ type: "cached", value: config.maximumContextWindow() });
  }
};
