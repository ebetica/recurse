/**
 * bun kill_child.ts DATA_DIR: sends "hello" to a Durable conversation whose
 * model never answers, prints "running" once the run is committed, and
 * waits to be killed.
 */
import { fauxHost, until } from "./host.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const { faux, host, records, work } = fauxHost(process.argv[2]!);
for (const cid of ["idle1", "idle2", "idle3"]) {
  records[cid] = { id: cid, backend: "durable", workdir: work };
  faux.setResponses([fauxAssistantMessage(`settled ${cid}`)]);
  await host.send(cid, `hello ${cid}`, `op:operator::${cid}`);
  await until(() => host.runningCount() === 0);
}
faux.setResponses([() => new Promise(() => {})]);
await host.send("c1", "hello", "op:operator::k1");
while (host.runningCount() !== 1) await Bun.sleep(10);
console.log("running");
await new Promise(() => {});
