import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/config";
import { PiModelUpdater } from "../../src/pi_model_list";
import { Router } from "../../src/web/router";
import { registerSettingsRoutes } from "../../src/web/settings";
import { TaskSet } from "../../src/utils/tasks";
import { serveOpen } from "./http_open_app";
import { TEST_PI_MODELS } from "./pi_model_list_fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

type Reply = { models: unknown[]; errors?: unknown[] } | Error;

function world(replies: Reply[]) {
  const root = mkdtempSync(join(tmpdir(), "model-list-update-"));
  roots.push(root);
  const config = new Config({
    env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
    authenticatedProviders: () => ["anthropic"],
  });
  const requests: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const nativeRequest = async (request: Record<string, unknown>) => {
    requests.push(request);
    await gate;
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return { kind: "models", ...reply };
  };
  const tasks = new TaskSet(() => {});
  let written = 0;
  const updater = new PiModelUpdater({
    nativeRequest,
    config,
    spawn: (name, work) => tasks.spawn(name, work),
    afterUpdate: async () => void written++,
    now: () => 1_790_000_000,
  });
  return {
    root,
    config,
    requests,
    updater,
    nativeRequest,
    written: () => written,
    hold: () => (gate = new Promise((resolve) => (release = resolve))),
    release: () => release(),
  };
}

test("POST starts the update with 202 and GET reads its status", async () => {
  const w = world([{ models: TEST_PI_MODELS.slice(0, 1) }]);
  const router = new Router();
  registerSettingsRoutes(router, {
    config: w.config,
    modelUpdates: w.updater,
  } as unknown as Parameters<typeof registerSettingsRoutes>[1]);
  const { running } = await serveOpen(router, join(w.root, "data"));
  try {
    const url = `${running.url}/api/settings/model-list-update`;
    w.hold();
    const started = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.url },
      body: "{}",
    });
    expect(started.status).toBe(202);
    expect(((await started.json()) as { updating: boolean }).updating).toBe(
      true,
    );
    expect(
      ((await (await fetch(url)).json()) as { updating: boolean }).updating,
    ).toBe(true);
    w.release();
    await w.updater.settled();
    expect(await (await fetch(url)).json()).toEqual({
      updating: false,
      updated_at: 1_790_000_000,
      count: 1,
      error: null,
    });
  } finally {
    await running.close();
  }
});
