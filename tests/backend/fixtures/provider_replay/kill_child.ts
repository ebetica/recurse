/** Start a real recorded-provider turn, then wait for the parent's SIGKILL. */
import { recordedHost } from "./host.ts";
import { until } from "../durable_host/host.ts";
const { host, replay } = await recordedHost(process.argv[2]!);
await host.send("c1", "Public restart message.", "public-restart-request");
await until(() => replay.requests.length === 1);
console.log("PROVIDER_REQUEST_ACCEPTED");
await new Promise(() => {});
