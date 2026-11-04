import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { switchoverWorld, until } from "./durable_host/host";

const trace = process.env.RECURSE_BLOCKING_TRACE!;
const world = await switchoverWorld();
const { instance } = world;
const cid = "retire-storage";
try {
  await instance.create.create({
    cid,
    title: "Retire storage",
    model: "recurse-test/scripted",
  });
  await instance.durable.send(cid, "Reply before storage retirement.", "reply");
  await until(() => instance.durable.runningCount() === 0);
  const answered = JSON.stringify(await instance.durable.view(cid)).includes(
    "CUSTOM-SWITCHED",
  );
  await instance.agentStore.flush(cid);
  const path = instance.agentStore.dbPath(cid);
  const before = await stat(path);
  process.kill(process.pid, "SIGUSR2");
  await until(async () => {
    try {
      return (await readFile(`${trace}.armed`, "utf8")) === "ready";
    } catch {
      return false;
    }
  });
  await instance.reap.requestReap(cid, null);
  await instance.reap.applyReaps();
  await until(() => instance.conversations.load(cid) === null);
  process.kill(process.pid, "SIGUSR2");
  await until(async () => {
    try {
      await readFile(trace, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  const sites = JSON.parse(await readFile(trace, "utf8")) as Array<{
    site: string;
    stack: string;
  }>;
  const trash = join(instance.agentStore.baseDir, ".trash");
  const retired = await Promise.all(
    (await readdir(trash)).map((name) => stat(join(trash, name))),
  );
  console.log(
    JSON.stringify({
      answered,
      requests: world.requests.length,
      blocking: sites
        .filter((site) => site.stack.includes("retireAgentStoreFiles"))
        .map((site) => site.site),
      retirementBlocking: sites
        .filter((site) => site.stack.includes("utils/trash.ts"))
        .map((site) => site.site),
      moved: retired.some(
        (entry) => entry.dev === before.dev && entry.ino === before.ino,
      ),
      absent: await stat(path).then(
        () => false,
        (error) => error.code === "ENOENT",
      ),
    }),
  );
} finally {
  await world.close();
}
