/**
 * bun shell_child.ts DATA_DIR: a Durable conversation starts a background
 * `sleep 60`, then holds the next model response; prints the shell's
 * pgid once both are recorded, and waits to be killed. A completed command
 * without a shell task fails setup instead.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost } from "./host.ts";

const waiting = Promise.withResolvers<void>();
const released = Promise.withResolvers<void>();
const { faux, host } = fauxHost(process.argv[2]!);
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("bash", { command: "sleep 60", background: true }),
    { stopReason: "toolUse" },
  ),
  async () => {
    waiting.resolve();
    await released.promise;
    return fauxAssistantMessage("Fixture setup failed.");
  },
]);
await host.send("c1", "start a shell", "op:operator::k1");
const { harness } = await host.open("c1");
await waiting.promise;
const task = (await harness.inspect(context)).tasks.find(
  ({ record }) => record.kind === "recurse.shell",
);
const pgid = (task?.record.input as { pgid?: number } | undefined)?.pgid;
if (typeof pgid !== "number") {
  released.resolve();
  await host.close();
  throw new Error("Background shell setup failed: no recorded shell task");
}
console.log(JSON.stringify({ pgid }));
await new Promise(() => {});
