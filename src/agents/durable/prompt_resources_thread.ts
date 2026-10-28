/** The prompt resources thread (prompt_resources.ts). A read that throws is
 * answered with its error, and the thread keeps serving. */
import { parentPort } from "node:worker_threads";
import {
  loadPromptResources,
  type PromptResourcesRequest,
} from "./prompt_resources.ts";

const port = parentPort!;
let pending = Promise.resolve();
port.on("message", ({ cwd, agentDir, skillPaths }: PromptResourcesRequest) => {
  pending = pending.then(async () => {
    try {
      port.postMessage(await loadPromptResources(cwd, agentDir, skillPaths));
    } catch (error) {
      port.postMessage({ error: String(error) });
    }
  });
});
