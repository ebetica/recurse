// The sidebar script worker runs the shared QuickJS engine away from the page.
// It posts "ready" or "failed" once loaded, then one result per request.
import { runSidebarScript } from "../src/sidebar_script/engine/index.js";

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
