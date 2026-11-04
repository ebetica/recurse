import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { archive, archiveLiveRecord } from "../../../src/agents/reap_history";

const trace = process.env.RECURSE_BLOCKING_TRACE!;
const root = dirname(trace);
const paths = {
  historyDir: join(root, "history"),
  trashDir: join(root, "trash"),
};
const date = "20260821";
const partition = join(paths.historyDir, date);
const staging = join(partition, ".child.key-child.tmp");
const temporary = join(partition, ".child.record.tmp");
const unrelated = join(partition, ".other.record.tmp");
const sentinel = join(root, "sentinel.record.tmp");
const message = join(root, "child.jsonl");
await mkdir(staging, { recursive: true });
await writeFile(join(staging, "unfinished"), "crash residue");
await symlink(sentinel, temporary);
await writeFile(unrelated, "another publication");
await writeFile(message, "retained message\n");

async function waitFor<T>(read: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await Bun.sleep(5);
    }
  }
}
process.kill(process.pid, "SIGUSR2");
await waitFor(async () => {
  if ((await readFile(`${trace}.armed`, "utf8")) !== "ready")
    throw new Error("blocking trace is not armed");
});
const publications = await Promise.all(
  ["child", "child", "sibling"].map((cid) =>
    archiveLiveRecord(
      cid,
      { id: cid, tmp_key: `key-${cid}` },
      [message],
      date,
      `key-${cid}`,
      paths,
    ),
  ),
);
const repeated = await archive(
  "child",
  join(root, "absent-source"),
  [],
  date,
  "key-child",
  paths,
);
process.kill(process.pid, "SIGUSR2");
const sites = await waitFor(
  async () =>
    JSON.parse(await readFile(trace, "utf8")) as Array<{
      site: string;
      stack: string;
    }>,
);
const destinations = [publications[0]!, publications[2]!];
const lifetimes = await Promise.all(
  destinations.map(
    async (path) =>
      JSON.parse(await readFile(join(path, "conversation.json"), "utf8"))
        .tmp_key,
  ),
);
const linked = await stat(join(destinations[0]!, "messages", "child.jsonl"));
const entries = await readdir(paths.trashDir);
const residue = await Promise.all(
  entries.map((name) =>
    readFile(join(paths.trashDir, name, "unfinished"), "utf8").catch(() => ""),
  ),
);
console.log(
  JSON.stringify({
    blocking: sites
      .filter((site) =>
        /(?:agents\/reap_history\.ts:|utils\/trash(?:\.ts:|_sweep\.ts:))/.test(
          site.stack,
        ),
      )
      .map((site) => site.site),
    sameLifetime:
      publications[0] === publications[1] && repeated === publications[0],
    lifetimes,
    linkedMessages: linked.ino === (await stat(message)).ino,
    stagingRetired: residue.includes("crash residue"),
    temporaryRemoved: await stat(temporary).then(
      () => false,
      (error) => error.code === "ENOENT",
    ),
    unrelated: await readFile(unrelated, "utf8").catch(() => "missing"),
    sentinel: await readFile(sentinel, "utf8"),
  }),
);
