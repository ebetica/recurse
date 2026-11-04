// The sidebar script worker: a separate bundle that runs the operator's
// sidebar script in QuickJS (sidebar/sandbox.ts), away from the page. It posts
// "ready" or "failed" once the engine has loaded, then one result per request.
import { runSidebarScript } from "./sidebar/sandbox.js";

const version = new URL(import.meta.url).searchParams.get("v") ?? "";
const engine = WebAssembly.compileStreaming(
  fetch(`/static/quickjs.wasm?v=${encodeURIComponent(version)}`),
);
void engine.then(
  () => postMessage("ready"),
  () => postMessage("failed"),
);

onmessage = async ({ data }: MessageEvent) => {
  const { script, rows, now } = data;
  postMessage(await runSidebarScript(await engine, script, rows, now));
};
