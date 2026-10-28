// Test-only gate around the production handler, leaving all four Worker slots
// occupied while the main thread checks admitted-but-uncompleted bounds.
import "../../../../src/agents/agent_store_worker";
import { existsSync } from "node:fs";
import type { WorkerRequest } from "../../../../src/agents/agent_store";
declare const self: { onmessage: (event: MessageEvent<WorkerRequest>) => void };
const handle = self.onmessage;
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.kind === "apply") {
    while (existsSync(`${event.data.path}.hold`)) await Bun.sleep(10);
  }
  handle.call(self, event);
};
