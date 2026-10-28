// Child process for durable_refusals.test.ts: it answers one message, then
// exits right after the refusal's omission commits, before Durable records the
// refused reply, as a crash between the two commits would.
import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { fauxHost, idle, until } from "../durable_host/host.ts";

const { host, faux } = fauxHost(process.argv[2]!);
faux.setResponses([
  fauxAssistantMessage("First answer."),
  {
    ...fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "The model refused to complete the request",
    }),
    rawStopReason: "refusal",
  } as AssistantMessage,
]);
await host.send("c1", "[recurse-origin: operator]\nfirst message", "op:1");
await until(idle(host));
const { conversation } = await host.open("c1");
const commit = conversation.commit.bind(conversation);
conversation.commit = (async (write, context) => {
  let omitted = false;
  const result = await commit(async (tx) => {
    const append = tx.appendEntry.bind(tx) as typeof tx.appendEntry;
    tx.appendEntry = (async (...args: Parameters<typeof append>) => {
      omitted ||= args.some(
        (arg) => (arg as { kind?: string }).kind === "recurse.refusal",
      );
      return append(...args);
    }) as typeof tx.appendEntry;
    return write(tx);
  }, context);
  if (omitted) process.exit(73);
  return result;
}) as typeof conversation.commit;
await host.send("c1", "[recurse-origin: operator]\nREFUSED MESSAGE", "op:2");
await until(idle(host), 30_000);
process.exit(1);
