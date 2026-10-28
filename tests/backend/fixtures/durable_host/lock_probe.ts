/** A replacement generation acquires the existing directory lock before storage. */
import { acquireSupervisorLock } from "../../../../src/launcher/lock.ts";
import { fauxHost } from "./host.ts";
const root = process.argv[2]!;
const lock = await acquireSupervisorLock(root).catch((error) => {
  console.error(error.message);
  process.exit(23);
});
const { host } = fauxHost(root);
try {
  await host.open("c1");
  console.log("storage opened");
} finally {
  await host.close();
  lock.close();
}
process.exit(0);
