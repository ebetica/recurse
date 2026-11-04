// Exercise shell records, logs and captured-request encoding through real replies.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  fauxHost,
  until,
} from "../../../../backend/fixtures/durable_host/host.ts";
import { RegistryStore } from "../../../../../src/extensions/core/shells/persist.ts";

const trace = process.env.RECURSE_BLOCKING_TRACE!;
const root = dirname(trace);
const bootText = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
const release = join(root, "release-shell");
const { host, faux } = fauxHost(root);
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("bash", {
      command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; printf 'recorded\\n'`,
      background: true,
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("The tracked shell is running."),
  fauxAssistantMessage("The tracked shell finished."),
]);
async function readJson<T>(path: string): Promise<T> {
  let value: T;
  await until(async () => {
    try {
      value = JSON.parse(await readFile(path, "utf8"));
      return true;
    } catch {
      return false;
    }
  });
  return value!;
}
process.kill(process.pid, "SIGUSR2");
await until(
  async () =>
    (await readFile(`${trace}.armed`, "utf8").catch(() => "")) === "ready",
);
let running = false;
let survivedPrune = false;
let readBack = false;
let settled = false;
try {
  await host.send("c1", "Run a tracked background command.", "record-io");
  await until(() => faux.state.callCount === 2 && host.runningCount() === 0);
  const store = new RegistryStore(host.shellState("c1").stateDir, "c1");
  const records = await store.readAll();
  const record = records[0]!;
  running = records.length === 1 && record.status === "running";
  readBack =
    typeof record.identity === "string" &&
    record.bootId === bootText.trim().toLowerCase() &&
    (await store.readRecord(record.id))?.identity === record.identity;
  await store.prune();
  survivedPrune = (await store.readRecord(record.id))?.status === "running";
  await writeFile(release, "finish");
  await until(
    async () =>
      (await store.readAll()).length === 0 &&
      faux.state.callCount === 3 &&
      host.runningCount() === 0,
  );
  settled = (await store.loadPendingCompletions()).length === 0;
} finally {
  await writeFile(release, "finish");
  await host.close();
}
process.kill(process.pid, "SIGUSR2");
const sites = await readJson<Array<{ site: string; stack: string }>>(trace);
console.log(
  JSON.stringify({
    blocking: sites
      .filter(
        ({ site, stack }) =>
          (/shells\/persist\.ts:/.test(stack) &&
            !/at procStartTime \(/.test(site)) ||
          (/shells\/registry\.ts:/.test(stack) &&
            /^fs\.(?:mkdirSync|openSync|closeSync) \|/.test(site)) ||
          /^JSON\.stringify \|/.test(site),
      )
      .map(({ site }) => site),
    running,
    survivedPrune,
    readBack,
    settled,
    requests: faux.state.callCount,
  }),
);
