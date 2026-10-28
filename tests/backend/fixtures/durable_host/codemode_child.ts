// Crash fixture: native codemode has journaled one call and owns a running unsafe MCP call.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
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
console.log("running");
await new Promise(() => {});
