import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimChecked } from "../../src/agents/claim_checked";
import {
  TreeLifecycle,
  TreeLifecycleBusy,
  fenced,
  type LeaseToken,
} from "../../src/agents/mutation_guard";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { TaskSet } from "../../src/utils/tasks";

function capture(): { logger: RuntimeLogger; lines: RuntimeLogRecord[] } {
  const lines: RuntimeLogRecord[] = [];
  return {
    logger: new RuntimeLogger("recurse.agents.mutation", {
      write: (r) => lines.push(r),
    }),
    lines,
  };
}

function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "recurse-mg-"));
  return body(join(base, "data")).finally(() =>
    rmSync(base, { recursive: true, force: true }),
  );
}

function lifecycle(root: string) {
  const log = capture();
  const guard = new TreeLifecycle({
    dataDir: root,
    muteLockDir: join(root, "mute_locks"),
    logger: log.logger,
  });
  return { guard, ...log };
}

test("claimChecked lets a caller abort win only after the read finishes", async () => {
  const abort = new AbortController();
  let finished = false;
  const run = claimChecked(
    { cid: "c1" },
    async () => {
      abort.abort(new Error("cancelled"));
      await Bun.sleep(20);
      finished = true;
      return [null, 1];
    },
    () => true,
    () => ({}),
    abort.signal,
  );
  await expect(run).rejects.toThrow("cancelled");
  expect(finished).toBe(true);
});

test("fenced drains the work before an abort wins", async () => {
  const abort = new AbortController();
  let finished = false;
  const run = fenced(async () => {
    abort.abort(new Error("stop"));
    await Bun.sleep(20);
    finished = true;
    return 1;
  }, abort.signal);
  await expect(run).rejects.toThrow("stop");
  expect(finished).toBe(true);
  expect(await fenced(async () => 7)).toBe(7);
});

test("work spawned inside a hold queues for its own lease", () =>
  withRoot(async (root) => {
    const { guard } = lifecycle(root);
    const tasks = new TaskSet();
    const order: string[] = [];
    let child: Promise<unknown> | undefined;
    const queued = Promise.withResolvers<void>();
    await guard.guardAsync("outer", null, async () => {
      child = tasks.spawn("child", () => {
        const pending = guard.guardAsync("child", null, async (_t, lease) => {
          order.push(lease === null ? "child-nested" : "child-leased");
        });
        queued.resolve();
        return pending;
      });
      await queued.promise;
      order.push("outer-done");
    });
    await child;
    expect(order).toEqual(["outer-done", "child-leased"]);
    await guard.guardAsync("holder", "c1", async () => {
      await expect(guard.guard("sync", null, async () => 1)).rejects.toThrow(
        TreeLifecycleBusy,
      );
    });
  }));

test("dataRootFlock queues in process, bounded, and nests under its token", () =>
  withRoot(async (root) => {
    const log = capture();
    const guard = new TreeLifecycle({
      dataDir: root,
      muteLockDir: join(root, "mute_locks"),
      logger: log.logger,
      dataRootWaitSeconds: 0.05,
    });
    mkdirSync(root, { recursive: true });
    const fd = await (await import("node:fs/promises")).open(root, "r");
    try {
      await guard.guardAsync("reap", "c1", async () => {
        expect(
          await guard.reserveDataRootForRepo(fd.fd, "sweep", async (ok) => ok),
        ).toBe(false);
      });
      expect(log.lines.at(-1)?.message).toMatch(
        /^event=data_root_reservation_refused reason=<redacted> waited_seconds=0\.0\d\d waiter_site=sweep$/,
      );
      expect(
        await guard.reserveDataRootForRepo(fd.fd, "sweep", async (ok) => ok),
      ).toBe(true);
    } finally {
      await fd.close();
    }
  }));

test("real lifecycle flocks exclude other tokens and release before reuse", () =>
  withRoot(async (root) => {
    const { guard } = lifecycle(root);
    const contender = lifecycle(root);
    const entered: string[] = [];
    let released: LeaseToken | undefined;
    await guard.guardAsync("holder", "main", async (token, lease) => {
      released = token;
      expect(lease).not.toBeNull();
      expect(
        await guard.guardAsync(
          "nested",
          "main",
          async (_t, held) => held,
          token,
        ),
      ).toBeNull();
      await expect(
        contender.guard.guard("blocked", "main", async () => {
          entered.push("blocked");
        }),
      ).rejects.toThrow(TreeLifecycleBusy);
      expect(contender.guard.currentHolder()).toBeNull();
    });
    await expect(
      guard.guardAsync("spent", "main", async () => {}, released),
    ).rejects.toThrow("inactive lifecycle lease token");
    await expect(guard.withLease(released!, async () => {})).rejects.toThrow(
      "does not own",
    );
    await expect(
      guard.mutateExternalStorage(() => 1, [], { token: released }),
    ).rejects.toThrow("inactive");
    await contender.guard.guardAsync(
      "released",
      "main",
      async (_token, lease) => {
        expect(lease).not.toBeNull();
        entered.push("released");
      },
    );
    expect(entered).toEqual(["released"]);
  }));
