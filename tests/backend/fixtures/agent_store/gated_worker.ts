// Test-only gate around the production handler. A batch waits while
// `<db>.hold` exists; the first batch to claim a `stall-next` file in the
// store directory turns it into its own hold, so a test can stall one write.
import "../../../../src/agents/storage/agent_store.worker";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerRequest } from "../../../../src/agents/storage/agent_store";
declare const self: { onmessage: (event: MessageEvent<WorkerRequest>) => void };
const handle = self.onmessage;
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.kind === "apply") {
    const { path } = event.data;
    try {
      renameSync(join(dirname(path), "stall-next"), `${path}.hold`);
    } catch {}
    while (existsSync(`${path}.hold`)) await Bun.sleep(10);
  }
  handle.call(self, event);
};
