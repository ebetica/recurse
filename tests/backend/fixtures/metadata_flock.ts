import { open } from "node:fs/promises";
import { join } from "node:path";
import { flockExclusive } from "../../../src/utils/flock";

/** Probe the real metadata flock from a separate open file description. */
export async function probeMetadataFlock(
  dir: string,
  cid: string,
): Promise<void> {
  const path = join(dir, `${cid}.lock`);
  const handle = await open(path, "r");
  try {
    (await flockExclusive(handle.fd, path, { timeoutMs: 0, log: () => {} }))();
  } finally {
    await handle.close();
  }
}
