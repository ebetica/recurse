// Crash fixture: a running script replays read metadata captured from patched Pi 1.4's module-3 CodemodeRunDoc.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { CodemodeRunDoc } from "../../../../node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js";
import legacyRead from "./pi14_codemode_read.json";
import { fauxHost, until } from "./host.ts";

const { host, faux } = fauxHost(process.argv[2]!);
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall(
        "codemode",
        {
          code: `
text(await tools.mcp__probe__echo({text:'before restart'}));
try { await tools.mcp__probe__sleep({ms:60000}); } catch (error) { text(error.message); }
text(await tools.mcp__probe__echo({text:'new call after restart'}));
image(await tools.read({path:'pixel.png'}));
`,
        },
        { id: "cm" },
      ),
    ],
    { stopReason: "toolUse" },
  ),
]);
await host.setSafetyReviewOff("c1", true);
await host.send("c1", "survive restart", "restart");
const { harness, conversation } = await host.open("c1");
await until(
  async () =>
    (
      await harness.snapshot(LiveDoc, conversation.id, context)
    )?.nestedTools?.some(
      (call) => call.name === "mcp__probe__sleep" && call.status === "running",
    ) ?? false,
);
await harness.commit(async (tx) => {
  const live = await tx.doc(LiveDoc, conversation.id);
  const taskId = live.tools!.find((tool) => tool.name === "codemode")!.taskId!;
  const run = await tx.doc(CodemodeRunDoc, taskId);
  if (run.start!.version !== legacyRead.version)
    throw new Error("Legacy code-mode module version changed");
  const index = run.start!.tools.findIndex((tool) => tool.name === "read");
  run.start!.tools[index] = legacyRead.read;
}, context);
console.log("running");
await new Promise(() => {});
