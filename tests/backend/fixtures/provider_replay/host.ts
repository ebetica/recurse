/** Durable's real Harness with a built-in Pi parser and recorded provider. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DurableHost } from "../../../../src/agents/durable/host.ts";
import { testDeps } from "../durable_host/host.ts";
import { recordedModels } from "./models.ts";

export async function recordedHost(dataDir: string) {
  const replay = await recordedModels("openai-codex-sse");
  const workdir = join(dataDir, "work");
  await mkdir(workdir, { recursive: true });
  const records = { c1: { id: "c1", backend: "durable", workdir } };
  const host = new DurableHost({
    ...testDeps(
      dataDir,
      (cid) => (cid === "c1" ? records.c1 : null),
      () => ["c1"],
      replay.modelId,
    ),
    settings: () => [replay.modelId, "low"],
    models: replay.models,
  });
  return {
    host,
    ...replay,
    close: async () => {
      await host.close();
      replay.close();
    },
  };
}
