/**
 * bun kill_child.ts DATA_DIR: sends "hello" to a Durable conversation whose
 * model never answers, prints "running" once the run is committed, and
 * waits to be killed.
 */
import { fauxHost } from "./host.ts";

const { faux, host } = fauxHost(process.argv[2]!);
faux.setResponses([() => new Promise(() => {})]);
await host.send("c1", "hello", "op:operator::k1");
while (host.runningCount() !== 1) await Bun.sleep(10);
console.log("running");
await new Promise(() => {});
