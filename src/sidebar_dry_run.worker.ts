// The worker thread for SidebarScript's dry run: runs one script on the rows
// it is sent, with QuickJS from the installed package, and posts the result.
import { runSidebarScript } from "./sidebar_script/engine/index.ts";

declare const self: Worker;

const engine = Bun.file(
  Bun.resolveSync("quickjs-wasi/quickjs.wasm", import.meta.dir),
)
  .arrayBuffer()
  .then((bytes) => WebAssembly.compile(bytes));

self.onmessage = async ({ data }: MessageEvent) => {
  const { script, rows, now } = data;
  self.postMessage(await runSidebarScript(await engine, script, rows, now));
};
