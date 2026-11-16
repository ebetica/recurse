import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { Config } from "../../../../src/config";
import { DurableHost } from "../../../../src/agents/durable/host";
import { testDeps, until } from "../durable_host/host";

const config = new Config({ env: JSON.parse(process.argv[2]!) });
const root = process.argv[3]!;
const faux = fauxProvider({
  tokensPerSecond: 100000,
  models: [{ id: "faux-1", contextWindow: 1000000 }],
});
faux.models[0].promptCache = { short: 300, long: 300 };
faux.setResponses([fauxAssistantMessage("ready")]);
const models = createModels();
models.setProvider(faux.provider);
let now = 0;
const timers = new Map<() => void, number>();
const host = new DurableHost({
  ...testDeps(
    config.paths.DATA_DIR,
    () => ({ id: "c1", backend: "durable", workdir: root }),
    () => ["c1"],
  ),
  config,
  models,
  warmingClock: {
    now: () => now,
    schedule(callback, delay) {
      timers.set(callback, now + delay);
      return () => {
        timers.delete(callback);
      };
    },
  },
});
const opened = await host.open("c1");
await host.send("c1", "Continue the conversation", "crash-r3");
await until(
  () => !host.isRunning("c1") && host.metadata("c1").pending.length === 0,
);
opened.harness.observeCommits({
  advance(publication) {
    if (
      !publication.changes.some(
        (change) =>
          change.type === "task" &&
          change.value.kind === "pi.compaction" &&
          change.value.state.status === "pending",
      )
    )
      return;
    const marked = publication.changes.some(
      (change) =>
        change.type === "document" &&
        change.record.kind === "recurse.idle-compaction",
    );
    console.log(JSON.stringify({ marked }));
    process.exit(0);
  },
  end() {},
});
now = 270000;
for (const [callback, at] of [...timers])
  if (at <= now) {
    timers.delete(callback);
    callback();
  }
await until(async () => (await host.live("c1"))?.compactions?.length === 1);
throw new Error("Idle compaction admission did not stop the process");
