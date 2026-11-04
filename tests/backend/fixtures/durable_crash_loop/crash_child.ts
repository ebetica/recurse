// Child process for durable_store_upgrade.test.ts: it exits as soon as the
// reply's model request arrives, as a crash in the middle of a reply would.
// "send" starts the reply, which first starts a background command; "open"
// reopens the conversation, which resumes the reply and the command's watch.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost } from "../durable_host/host.ts";

const { host, faux } = fauxHost(process.argv[2]!);
const crash = () => {
  process.exit(70);
};
if (process.argv[3] === "send") {
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "sleep 300", background: true })],
      { stopReason: "toolUse" },
    ),
    crash,
  ]);
  await host.send(
    "c1",
    "[recurse-origin: operator]\nCRASHING MESSAGE",
    "op:crash",
  );
} else {
  faux.setResponses([crash]);
  await host.open("c1");
}
await Bun.sleep(30_000);
process.exit(1);
