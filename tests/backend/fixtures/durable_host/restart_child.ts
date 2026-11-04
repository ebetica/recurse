/** Leave a real model request in flight until the restart regression kills this host. */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxHost, held } from "./host";

const { host, faux } = fauxHost(process.argv[2]!);
const answer = held(fauxAssistantMessage("not completed"));
faux.setResponses([answer.step]);
await host.send("c1", "Interrupted input", "interrupted");
await answer.started;
console.log("request started");
await new Promise(() => {});
