import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../../src/web/app";
import { held } from "../../../tests/backend/fixtures/durable_host/host";
import { seedPiModelList } from "../../../tests/backend/pi_model_list_fixture";
import { appWorld } from "../../../tests/backend/web_app_support";

// Feature: #2919 wake reports only when the v1 subtree is idle.
test("wake waits for descendant work to finish", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const active = held(fauxAssistantMessage("done"));
  const faux = fauxProvider();
  faux.setResponses([active.step]);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = (
    app.instance.durable as unknown as {
      deps: { models: typeof models; settings: () => string[] };
    }
  ).deps;
  deps.models = models;
  deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  let wake: { kill(): void; exited: Promise<number> } | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (
      !app.instance.lifecycle.readinessSnapshot().ready ||
      !app.instance.treeView.ready()
    ) {
      if (Date.now() > deadline) throw new Error("readiness timed out");
      await Bun.sleep(20);
    }
    const parent = String(
      (await app.instance.create.create({ title: "Parent" })).id,
    );
    const child = String(
      (
        await app.instance.create.create({
          title: "Child",
          parent,
          muted: true,
        })
      ).id,
    );
    const file = join(env.CHAT_DATA_DIR!, "server.json");
    const { token } = await Bun.file(file).json();
    await Bun.write(
      file,
      JSON.stringify({ port: Number(new URL(running.url).port), token }),
    );
    await app.instance.delivery.deliver(child, "work", { origin: "operator" });
    await active.started;
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "wake.ts"),
        "0.0005",
        "check goal",
      ],
      env: {
        ...process.env,
        CHAT_DATA_DIR: env.CHAT_DATA_DIR,
        RECURSE_AGENT_ID: parent,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    wake = proc;
    const next = proc.stdout.getReader().read();
    expect(
      await Promise.race([
        next.then(() => "output"),
        Bun.sleep(300).then(() => "quiet"),
      ]),
    ).toBe("quiet");
    active.release();
    const message = await next;
    expect(new TextDecoder().decode(message.value)).toMatch(
      /^\d{4}-.* check goal\n/,
    );
  } finally {
    wake?.kill();
    if (wake) await wake.exited;
    active.release();
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
