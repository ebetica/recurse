/**
 * bun shell_child.ts DATA_DIR: a Durable conversation starts a background
 * `sleep 60`, then waits on a model that never answers; prints the shell's
 * pgid once both are recorded, and waits to be killed.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost } from "./host.ts";

const { faux, host } = fauxHost(process.argv[2]!);
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("bash", { command: "sleep 60", background: true }),
    { stopReason: "toolUse" },
  ),
  () => new Promise(() => {}),
]);
await host.send("c1", "start a shell", "op:operator::k1");
const { harness } = await host.open("c1");
for (;;) {
  const task = (await harness.inspect(context)).tasks.find(
    ({ record }) => record.kind === "recurse.shell",
  );
  const pgid = (task?.record.input as { pgid?: number } | undefined)?.pgid;
  if (pgid !== undefined && faux.state.callCount === 2) {
    console.log(JSON.stringify({ pgid }));
    break;
  }
  await Bun.sleep(10);
}
await new Promise(() => {});
