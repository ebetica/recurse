/** A prompt resources thread for tests: blocks 300 ms before each real read;
 * a cwd ending in "/die" throws, which ends the thread. */
import { parentPort } from "node:worker_threads";
import type { PromptResourcesRequest } from "../../../../src/agents/durable/prompt_resources.ts";

const port = parentPort!;
port.on(
  "message",
  async ({ cwd, agentDir, skillPaths }: PromptResourcesRequest) => {
    if (cwd.endsWith("/die")) throw new Error("thread crashed");
    const { loadPromptResources } =
      await import("../../../../src/agents/durable/prompt_resources.ts");
    // A synchronous 300 ms block, like a slow network filesystem.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    port.postMessage(await loadPromptResources(cwd, agentDir, skillPaths));
  },
);
