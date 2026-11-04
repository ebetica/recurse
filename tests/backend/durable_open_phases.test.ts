import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { LoopLag } from "../../src/observability/loop_lag";
import {
  logger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { retire } from "../../src/utils/trash";
import { testDeps, until } from "./fixtures/durable_host/host";

function block() {
  const end = performance.now() + 300;
  while (performance.now() < end) {}
}

// Feature: #3114 Stall logs show overlapping phases, not CPU causes.
test("stall logs identify overlapping open phases and forget successful and failed opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-phases-"));
  const trash = await mkdtemp(join(tmpdir(), "open-phases-trash-"));
  const work = join(root, "work");
  await mkdir(work);
  const records = Object.fromEntries(
    ["c1", "c2"].map((id) => [id, { id, backend: "durable", workdir: work }]),
  );
  const deps = testDeps(
    root,
    (cid) => records[cid] ?? null,
    () => Object.keys(records),
  );
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("first phase reply"),
    () => {
      block();
      return fauxAssistantMessage("second phase reply");
    },
  ]);
  const log: RuntimeLogRecord[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let beforeEnv = 0;
  const host = new DurableHost({
    ...deps,
    models,
    agentEnv: async (conv) => {
      if (conv.id === "c2") throw new Error("failed open for phase cleanup");
      beforeEnv = log.length;
      block();
      return deps.agentEnv();
    },
    admitFiles: async () => {
      entered.resolve();
      block();
      await release.promise;
    },
  });
  const loopLag = new LoopLag({
    logger: logger("loop_lag", { write: (record) => log.push(record) }),
    runningCount: () => host.runningCount(),
    runningConversations: () => ["c1"],
  });
  const stalls = (from: number) =>
    log
      .slice(from)
      .filter((r) => r.message.startsWith("event=event_loop_stall "));
  loopLag.start();
  try {
    const sending = host.send("c1", "first", "first");
    await entered.promise;
    await until(() => stalls(beforeEnv).length > 0);
    const opening = stalls(beforeEnv)[0]!.message;
    release.resolve();
    await sending;
    await until(
      async () =>
        host.runningCount() === 0 &&
        JSON.stringify(await host.view("c1", { limit: 50 })).includes(
          "first phase reply",
        ),
    );
    await expect(host.open("c2")).rejects.toThrow(
      "failed open for phase cleanup",
    );
    const samples = loopLag as unknown as { samples: number[] };
    const previous = samples.samples.length;
    await until(() => samples.samples.length > previous);
    const beforeReply = log.length;
    await host.send("c1", "second", "second");
    await until(
      async () =>
        host.runningCount() === 0 &&
        JSON.stringify(await host.view("c1", { limit: 50 })).includes(
          "second phase reply",
        ),
    );
    await until(() => stalls(beforeReply).length > 0);
    expect(faux.state.callCount).toBe(2);
    const phases = / phases=(\S+)/.exec(opening)?.[1];
    expect(phases).toMatch(/(?:^|,)c1:env_build:\d+ms(?:,|$)/);
    expect(phases).toMatch(/(?:^|,)c1:env_files:\d+ms(?:,|$)/);
    expect(phases?.split(",").length).toBeLessThanOrEqual(3);
    expect(/ phases=(\S+)/.exec(stalls(beforeReply)[0]!.message)?.[1]).toBe(
      "-",
    );
  } finally {
    release.resolve();
    loopLag.stop();
    await host.close();
    retire(root, trash);
  }
}, 20_000);
