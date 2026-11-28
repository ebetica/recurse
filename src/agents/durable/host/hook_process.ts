// Own each hook child's process group. A running record goes into the
// conversation's shell records before the child gets its input, so the next
// open after a server crash stops the group (recoverInterruptedCommands in
// shells.ts); it goes once the group is proven gone.
import type { OwnedProcess } from "../../../process_lifecycle";
import { bootId, procStat } from "../../../utils";
import type { DurableHostDeps } from "./host";
import { runtime, type Runtime } from "./load";

export function hookProcesses(
  deps: Pick<DurableHostDeps, "ownProcess" | "releaseProcess">,
  stateDir: (cid: string) => string,
) {
  const records = new Map<
    OwnedProcess,
    [InstanceType<Runtime["RegistryStore"]>, string]
  >();
  return {
    async own(proc: OwnedProcess, cid: string): Promise<void> {
      await deps.ownProcess(proc, cid, "hook");
      const [stat, boot] = await Promise.all([procStat(proc.pid), bootId()]);
      if (stat.state !== "ok" || !boot)
        throw new Error("its process could not be identified");
      const store = new (await runtime()).RegistryStore(stateDir(cid), "hooks");
      const id = `hook-${proc.pid}`;
      const now = Date.now();
      records.set(proc, [store, id]);
      const written = await store.write({
        id,
        pid: proc.pid,
        pgid: proc.pid,
        identity: stat.stat.startTime,
        bootId: boot,
        status: "running",
        mode: "hook",
        command: "",
        logPath: "",
        startedAt: now,
        updatedAt: now,
      });
      if (!written) throw new Error("its process could not be recorded");
    },
    async release(proc: OwnedProcess): Promise<boolean> {
      if (!(await deps.releaseProcess(proc))) return false;
      const record = records.get(proc);
      records.delete(proc);
      if (record) await record[0].remove(record[1]);
      return true;
    },
  };
}
