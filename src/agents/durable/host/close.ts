// Close Harnesses with verified process cleanup. A Harness closes only after
// its shell groups are proven gone; without an open Harness, the groups its
// stored records name are stopped instead. Shutdown closes every Harness.
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { DurableHost } from "../host.ts";
import type { Opened } from "./open.ts";
import { runtime } from "./load.ts";

/**
 * Abort, stop groups and close; reject unless close succeeds and groups
 * vanish. A failed abort is logged but never skips the remaining cleanup.
 */
export async function closeHarness(
  host: DurableHost,
  cid: string,
  opened: Promise<Opened> | undefined,
  failed = false,
): Promise<void> {
  const naming = host.titleTasks.get(cid);
  naming?.scope.abort();
  // Invariant: Without an open Harness (never opened, or a failed open), stop
  // the groups its records name.
  const handle = await opened?.catch(() => null);
  if (handle == null) {
    const pending = await stopRecordedShells(host, cid);
    if (pending.length)
      throw new Error(`shell processes survived: ${pending.join(", ")}`);
    return;
  }
  const { harness, conversation } = handle;
  handle.reporter?.close();
  const { LiveDoc, stopConversationShells, dropFork, sideForks } =
    await runtime();
  try {
    // Invariant: The storage leaves with no fork that could run again.
    if (!failed)
      for (const side of Object.keys(await sideForks(harness, conversation)))
        await dropFork(harness, conversation, side);
  } catch (error) {
    host.deps.log("durable_side_drop_failed", { cid, error: String(error) });
  }
  try {
    if (!failed) {
      const run = (await harness.snapshot(LiveDoc, conversation.id, context))
        ?.run;
      if (run !== undefined) await harness.abortTask(run.taskId, context);
    }
  } catch (error) {
    host.deps.log("durable_abort_failed", { cid, error: String(error) });
  }
  // Invariant: A closed Harness no longer owns its groups: they must be gone
  // first.
  const pending = failed
    ? await stopRecordedShells(host, cid)
    : (await stopConversationShells(harness, conversation.id, context)).pending;
  if (pending.length)
    throw new Error(`shell process groups survived: ${pending.join(", ")}`);
  await naming?.done;
  await handle.close();
}

/** Open the conversation's storage without resuming it and stop every group
 * its records name: the shell stores, interrupted bash calls, and live shell
 * tasks. Returns the pids not proven gone. */
async function stopRecordedShells(
  host: DurableHost,
  cid: string,
  liveHarness?: Harness,
): Promise<number[]> {
  const path = host.storagePath(cid);
  if ((await stat(path).catch(() => null)) === null) return [];
  const rt = await runtime();
  const state = host.shellState(cid);
  const registry = rt.createRegistry();
  registry.install(
    rt.createShells({
      ...state,
      scope: () => Promise.reject(new Error("no tools run here")),
    }).extension,
  );
  const harness =
    liveHarness ??
    (await rt.Harness.open(
      await rt.openWorkerSqliteStorage(host.sqlite(rt), path),
      { models: await host.models(), registry },
      context,
    ));
  try {
    const pending = await rt.recoverInterruptedCommands(
      harness,
      state,
      context,
    );
    for (const { record } of (await harness.inspect(context)).tasks) {
      if (record.kind !== rt.SHELL_TASK) continue;
      const input = record.input as {
        pid: number;
        identity: string;
        bootId: string | null;
      };
      if (!(await state.stopGroup(rt.groupOf(input)))) pending.push(input.pid);
    }
    return pending;
  } finally {
    if (!liveHarness) await harness.close(context);
  }
}

/** Shutdown: stop recorded groups before each Harness closes, even for
 * abort-ignoring tools; returns a failure per conversation whose pids survived
 * or whose close failed. Shell tasks survive for restart notices. */
export async function closeAll(host: DurableHost): Promise<string[]> {
  host.idle.close();
  host.closing = true;
  for (const task of host.titleTasks.values()) task.scope.abort();
  const naming = Promise.allSettled(
    [...host.titleTasks.values()].map((task) => task.done),
  );
  const failures: string[] = [];
  await Promise.allSettled(host.recovering.values());
  await host.promotions.close();
  await Promise.all(
    [...host.opened].map(async ([cid, opened]) => {
      const handle = await opened.catch(() => null);
      if (handle?.parent !== undefined) return void (await handle.close());
      handle?.reporter?.close();
      // Invariant: Freeze shell admission and start verified cleanup before
      // any snapshot.
      const shellStop = handle?.shells.shutdown().catch((error) => {
        host.deps.log("durable_close_failed", { cid, error: String(error) });
        failures.push(`${cid}: shell shutdown failed`);
      });
      // Invariant: Cleanup never waits for an abort-ignoring tool.
      // Read the owner before close seals its inspection API.
      await stopRecordedShells(host, cid, handle?.harness).then(
        (pending) => {
          if (pending.length) {
            host.deps.log("durable_shutdown_shells_survived", {
              cid,
              pending,
            });
            failures.push(`${cid}: ${pending.join(", ")}`);
          }
        },
        (error) => {
          host.deps.log("durable_close_failed", {
            cid,
            error: String(error),
          });
          failures.push(`${cid}: shell records unreadable`);
        },
      );
      await shellStop;
      await host.titleTasks.get(cid)?.done;
      try {
        await handle?.close({ shellStop });
      } catch (error) {
        host.deps.log("durable_close_failed", { cid, error: String(error) });
        failures.push(`${cid}: close failed (${String(error)})`);
      }
    }),
  );
  await naming;
  host.opened.clear();
  host.liveRows.clear();
  return failures;
}
