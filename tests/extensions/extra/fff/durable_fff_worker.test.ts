import { expect, test } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readdir,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FffWorker } from "../../../../src/extensions/extra/fff/fff_worker.ts";
import { createFffExtension } from "../../../../src/extensions/extra/fff/fff.ts";
import {
  fauxHost,
  lifecycle,
  until,
} from "../../../backend/fixtures/durable_host/host.ts";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const ctx = (cwd: string) => ({ cwd }) as ExtensionToolContext;
const flags = (root: string, key: string) => ({
  "fff-frecency-db": path.join(root, `f-${key}`),
  "fff-history-db": path.join(root, `h-${key}`),
});
const threadOf = (service: FffWorker) =>
  (service as unknown as { child: ReturnType<typeof Bun.spawn> }).child;

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fff-worker-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Feature: #2259 search worker retains supplied pi-fff Settings environment
test("worker reads pi-fff Settings from the supplied tool environment", () =>
  fixture(async (root) => {
    const home = path.join(root, "home");
    const agentDir = path.join(root, "agent");
    await mkdir(home);
    await mkdir(agentDir);
    await writeFile(
      path.join(agentDir, "pi-fff.json"),
      JSON.stringify({ followSymlinks: "invalid" }),
    );
    const service = new FffWorker({
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
    });
    try {
      await expect(service.open(home, flags(root, "env"))).rejects.toThrow(
        '\"followSymlinks\" must be a boolean',
      );
    } finally {
      await service.close();
    }
  }));

test("warm and lazy host search Workers retain the host's pi-fff Settings", () =>
  fixture(async (root) => {
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(
      path.join(root, "pi-fff.json"),
      JSON.stringify({ followSymlinks: "invalid" }),
    );
    try {
      for (const warm of [false, true]) {
        const { host } = fauxHost(path.join(root, warm ? "warm" : "lazy"));
        try {
          if (warm) {
            host.warmSearch();
            await until(
              () =>
                !!(host as unknown as { searchWorker: FffWorker | null })
                  .searchWorker,
            );
          }
          await expect(host.open("c1")).rejects.toThrow(
            '\"followSymlinks\" must be a boolean',
          );
        } finally {
          await host.close();
        }
      }
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
    }
  }));

test(
  "abort/connection close keep the other conversation usable; shutdown joins the child",
  () =>
    fixture(async (root) => {
      const other = path.join(root, "other");
      await mkdir(other);
      await writeFile(path.join(root, "first.txt"), "first needle\n");
      await writeFile(path.join(other, "second.txt"), "second needle\n");
      const service = new FffWorker();
      try {
        const first = await service.open(root, flags(root, "first"));
        const second = await service.open(other, flags(root, "second"));
        const thread = threadOf(service);
        const grep = first.definitions.find((tool) => tool.name === "grep")!;
        const controller = new AbortController();
        const cancelled = grep.execute(
          "abort",
          { pattern: "needle" },
          controller.signal,
          undefined,
          ctx(root),
        );
        controller.abort();
        await expect(cancelled).rejects.toThrow("Operation aborted");
        await first.close();
        await expect(
          grep.execute(
            "closed",
            { pattern: "needle" },
            undefined,
            undefined,
            ctx(root),
          ),
        ).rejects.toThrow("Search connection closed");
        const result = await second.definitions
          .find((tool) => tool.name === "grep")!
          .execute(
            "still-live",
            { pattern: "needle" },
            undefined,
            undefined,
            ctx(other),
          );
        expect(result.content).toEqual([
          { type: "text", text: "second.txt\n 1: second needle" },
        ]);
        expect(threadOf(service)).toBe(thread);
        let settled = false;
        const pending = second.definitions
          .find((tool) => tool.name === "grep")!
          .execute(
            "drain",
            { pattern: "needle" },
            undefined,
            undefined,
            ctx(other),
          )
          .then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
        let exits = 0;
        let settledAtExit = false;
        void thread.exited.then(() => {
          exits++;
          settledAtExit = settled;
        });
        await service.close();
        await pending;
        await second.close();
        expect(settledAtExit).toBe(true);
        expect(exits).toBe(1);
        expect(() => process.kill(-thread.pid, 0)).toThrow();
        await expect(service.open(root, flags(root, "late"))).rejects.toThrow(
          "Search worker closed",
        );
      } finally {
        await service.close();
      }
    }),
  60000,
);

// Regression: #3025 filesystem churn must not wake idle native search indexes.
test.skipIf(process.platform !== "linux")(
  "idle indexes do no background work during file churn",
  () =>
    fixture(async (root) => {
      const service = new FffWorker();
      const snapshot = async () => {
        const tasks = await Promise.all(
          (await readdir(`/proc/${threadOf(service).pid}/task`)).map(
            async (tid) => {
              try {
                const name = (
                  await readFile(
                    `/proc/${threadOf(service).pid}/task/${tid}/comm`,
                    "utf8",
                  )
                ).trim();
                const fields = (
                  await readFile(
                    `/proc/${threadOf(service).pid}/task/${tid}/stat`,
                    "utf8",
                  )
                )
                  .split(") ")[1]!
                  .split(" ");
                return {
                  name,
                  state: fields[0],
                  ticks: Number(fields[11]) + Number(fields[12]),
                };
              } catch {
                return undefined;
              }
            },
          ),
        );
        return tasks.filter((task) => task?.name.startsWith("fff-"));
      };
      try {
        await writeFile(path.join(root, "first.txt"), "first needle\n");
        const bundles = await Promise.all(
          ["one", "two", "three"].map((key) =>
            service.open(root, flags(root, key)),
          ),
        );
        const searches = bundles.map(
          (bundle) => bundle.definitions.find((tool) => tool.name === "find")!,
        );
        const search = (index: number) =>
          searches[index]!.execute(
            "refresh",
            { pattern: "*.txt" },
            undefined,
            undefined,
            ctx(root),
          );
        for (let i = 0; i < searches.length; i++) {
          expect((await search(i)).details).toMatchObject({ totalMatched: 1 });
        }
        let before = await snapshot();
        await until(async () => {
          before = await snapshot();
          return before.every((task) => task?.state === "S");
        });
        expect(before.some((task) => task?.name.startsWith("fff-bg-"))).toBe(
          true,
        );
        expect(before.filter((task) => task?.name.includes("watcher"))).toEqual(
          [],
        );
        for (let i = 0; i < 100; i++) {
          await writeFile(path.join(root, `new-${i}.txt`), "new needle\n");
          await writeFile(path.join(root, ".gitignore"), `absent-${i}\n`);
        }
        await service.warm();
        const after = await snapshot();
        expect(
          after.filter((task) => task?.name.startsWith("fff-bg-")),
        ).toEqual(before.filter((task) => task?.name.startsWith("fff-bg-")));
        for (let i = 0; i < searches.length; i++) {
          expect((await search(i)).details).toMatchObject({ totalMatched: 1 });
        }
      } finally {
        await service.close();
      }
    }),
  60000,
);

// Regression: #3036 repeated searches must reuse indexes instead of rescanning.
test("main and external indexes reuse snapshots until the refresh interval", () =>
  fixture(async (root) => {
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    await mkdir(workspace);
    await mkdir(external);
    await writeFile(path.join(workspace, "first.txt"), "needle\n");
    await writeFile(path.join(external, "first.txt"), "needle\n");
    const service = new FffWorker();
    try {
      const bundle = await service.open(workspace, {
        ...flags(root, "refresh"),
        "fff-refresh-interval-ms": "2000",
      });
      const find = bundle.definitions.find((tool) => tool.name === "find")!;
      const search = (target?: string) =>
        find.execute(
          "refresh",
          { pattern: "*.txt", ...(target ? { path: target } : {}) },
          undefined,
          undefined,
          ctx(workspace),
        );
      expect((await search()).details).toMatchObject({ totalMatched: 1 });
      expect((await search(external)).details).toMatchObject({
        totalMatched: 1,
      });
      await writeFile(path.join(workspace, "new.txt"), "needle\n");
      await writeFile(path.join(external, "new.txt"), "needle\n");
      for (let i = 0; i < 3; i++) {
        expect((await search()).details).toMatchObject({ totalMatched: 1 });
        expect((await search(external)).details).toMatchObject({
          totalMatched: 1,
        });
      }
      await until(
        async () =>
          ((await search()).details as { totalMatched: number })
            .totalMatched === 2 &&
          ((await search(external)).details as { totalMatched: number })
            .totalMatched === 2,
      );
    } finally {
      await service.close();
    }
  }));

// Regression: #2756 external searches must not reuse a broader auxiliary root.
test("external searches keep exact roots and reject missing paths", () =>
  fixture(async (root) => {
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    const child = path.join(external, "child");
    await mkdir(workspace);
    await mkdir(child, { recursive: true });
    await writeFile(path.join(external, "parent.txt"), "parent needle\n");
    await writeFile(path.join(child, "child.txt"), "child needle\n");
    const service = new FffWorker();
    try {
      const bundle = await service.open(workspace, flags(root, "external"));
      const find = bundle.definitions.find((tool) => tool.name === "find")!;
      const search = (target: string) =>
        find.execute(
          "external",
          { pattern: "*.txt", path: target },
          undefined,
          undefined,
          ctx(workspace),
        );
      expect((await search(external)).details).toMatchObject({ totalFiles: 2 });
      expect((await search(child)).details).toMatchObject({ totalFiles: 1 });
      await writeFile(path.join(child, "new.txt"), "new needle\n");
      expect((await search(child)).details).toMatchObject({ totalFiles: 1 });
      let missingError: unknown;
      try {
        await search(path.join(root, "missing"));
      } catch (error) {
        missingError = error;
      }
      expect(String(missingError)).toContain("FFF search path does not exist");
    } finally {
      await service.close();
    }
  }));

// Regression: #2834 a file path in $HOME indexed the whole home tree.
test("external searches refuse files and roots covering $HOME", () =>
  fixture(async (root) => {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(root, "notes.md"), "needle\n");
    const service = new FffWorker();
    try {
      const bundle = await service.open(workspace, flags(root, "refuse"));
      const grep = bundle.definitions.find((tool) => tool.name === "grep")!;
      const refusal = (target: string) =>
        grep
          .execute(
            "refuse",
            { pattern: "needle", path: target },
            undefined,
            undefined,
            ctx(workspace),
          )
          .then(
            () => "",
            (error: Error) => error.message,
          );
      expect(await refusal("~")).toContain("contains $HOME");
      expect(await refusal(path.dirname(os.homedir()))).toContain(
        "contains $HOME",
      );
      expect(await refusal(path.join(root, "notes.md"))).toContain(
        "is a file outside the workspace",
      );
    } finally {
      await service.close();
    }
  }));

// Regression: #3054 grep after an in-place file shrink raised SIGBUS.
test.skipIf(process.platform !== "linux")(
  "grep never maps file contents, so in-place truncation cannot crash the host",
  () =>
    fixture(async (root) => {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const cached = path.join(workspace, "cached.ts");
      await writeFile(cached, "// filler\n".repeat(1200) + "needle\n");
      await writeFile(
        path.join(workspace, "large.ts"),
        "// filler\n".repeat(30_000) + "needle\n",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { readFileSync, writeFileSync } from "node:fs";
           import { FffWorker } from ${JSON.stringify(path.join(repo, "src/extensions/extra/fff/fff_worker.ts"))};
           const workspace = ${JSON.stringify(workspace)};
           const service = new FffWorker();
           try {
             const bundle = await service.open(workspace, ${JSON.stringify(flags(root, "truncate"))});
             const grep = () => bundle.definitions.find(tool => tool.name === "grep").execute(
               "truncate", { pattern: "needle" }, undefined, undefined, { cwd: workspace },
             );
             const first = (await grep()).content;
             const mapped = readFileSync("/proc/" + service.child.pid + "/maps", "utf8").split("\\n").filter(line => line.includes(workspace));
             writeFileSync(${JSON.stringify(cached)}, "needle\\n");
             const second = (await grep()).content;
             console.log(JSON.stringify({ first, mapped, second }));
           } finally {
             await service.close();
           }`,
        ],
        { env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(result.first).toEqual([
        { type: "text", text: "cached.ts\n 1201: needle" },
      ]);
      expect(result.mapped).toEqual([]);
      expect(result.second).toHaveLength(1);
    }),
);

// Regression: #2834 symlink aliases must not bypass external home/root refusal.
test.each([
  ["symlink to home", "home-alias", "home", true],
  ["real target of symlink HOME", "home", "home-alias", true],
  ["symlink to filesystem root", "root-alias", "home", true],
  ["symlink to legitimate home subdirectory", "repo-alias", "home", false],
])("external search handles %s", (_name, target, home, refused) =>
  fixture(async (root) => {
    const workspace = path.join(root, "workspace");
    const directory = path.join(root, "home", "src", "repo");
    await mkdir(workspace);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "notes.txt"), "symlink needle\n");
    await symlink(path.join(root, "home"), path.join(root, "home-alias"));
    await symlink(directory, path.join(root, "repo-alias"));
    await symlink(path.parse(root).root, path.join(root, "root-alias"));
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { FffWorker } from ${JSON.stringify(path.join(repo, "src/extensions/extra/fff/fff_worker.ts"))};
         const service = new FffWorker();
         try {
           const bundle = await service.open(${JSON.stringify(workspace)}, ${JSON.stringify(flags(root, "symlink"))});
           try {
             const result = await bundle.definitions.find(tool => tool.name === "grep").execute(
               "symlink", { pattern: "symlink needle", path: ${JSON.stringify(path.join(root, target))} },
               undefined, undefined, { cwd: ${JSON.stringify(workspace)} },
             );
             console.log(JSON.stringify(result));
           } catch (error) {
             console.log(JSON.stringify({ error: error.message }));
           }
         } finally {
           await service.close();
         }`,
      ],
      {
        env: {
          ...process.env,
          HOME: path.join(root, home),
          PI_CODING_AGENT_DIR: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    if (refused)
      expect(result).toMatchObject({
        error: expect.stringContaining("contains $HOME"),
      });
    else {
      expect(result.details).toMatchObject({ totalMatched: 1 });
      expect(result.content).toEqual([
        { type: "text", text: "notes.txt\n 1: symlink needle" },
      ]);
    }
  }),
);

// Regression: #3058 native crashes must not kill the host or poison later searches.
test(
  "SIGBUS rejects pending search; the host survives and the same connection restarts",
  () =>
    fixture(async (root) => {
      await writeFile(path.join(root, "first.txt"), "first needle\n");
      const { host } = fauxHost(root);
      const service = host.searchService(FffWorker);
      try {
        const bundle = await service.open(root, flags(root, "crash"));
        const child = threadOf(service);
        expect(lifecycle.ownedHandle(child)).not.toBeNull();
        expect(
          lifecycle.rows.get(lifecycle.ownedHandle(child)!.recordId),
        ).toMatchObject({
          kind: "file-search",
          cid: null,
        });
        const grep = bundle.definitions.find((tool) => tool.name === "grep")!;
        process.kill(child.pid, "SIGSTOP");
        const search = () =>
          grep.execute(
            "crash",
            { pattern: "needle" },
            undefined,
            undefined,
            ctx(root),
          );
        const pending = Promise.allSettled([search(), search()]);
        await until(
          () =>
            (service as unknown as { waiting: Map<number, unknown> }).waiting
              .size === 2,
        );
        process.kill(child.pid, "SIGBUS");
        process.kill(child.pid, "SIGCONT");
        for (const result of await pending) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected")
            expect(result.reason.message).toBe("File search crashed; retry");
        }
        expect(child.signalCode).toBe("SIGBUS");
        const startupAbort = new AbortController();
        let startupResult: string | undefined;
        const startup = grep
          .execute(
            "cancel-startup",
            { pattern: "needle" },
            startupAbort.signal,
            undefined,
            ctx(root),
          )
          .then(
            () => {
              startupResult = "unexpected success";
            },
            (error: Error) => {
              startupResult = error.message;
            },
          );
        const replacement = threadOf(service);
        process.kill(replacement.pid, "SIGSTOP");
        try {
          startupAbort.abort();
          await until(() => startupResult !== undefined, 1000);
          expect(startupResult).toBe("Operation aborted");
          await startup;
          const reopenAbort = new AbortController();
          let cancelled: string | undefined;
          const reopening = grep
            .execute(
              "cancel-reopen",
              { pattern: "needle" },
              reopenAbort.signal,
              undefined,
              ctx(root),
            )
            .then(
              () => {
                cancelled = "unexpected success";
              },
              (error: Error) => {
                cancelled = error.message;
              },
            );
          await until(
            () =>
              (service as unknown as { waiting: Map<number, unknown> }).waiting
                .size === 1,
          );
          reopenAbort.abort();
          await until(() => cancelled !== undefined, 1000);
          expect(cancelled).toBe("Operation aborted");
          await reopening;
          expect(
            (service as unknown as { waiting: Map<number, unknown> }).waiting
              .size,
          ).toBe(1);
        } finally {
          process.kill(replacement.pid, "SIGCONT");
        }
        expect((await search()).content).toEqual([
          { type: "text", text: "first.txt\n 1: first needle" },
        ]);
        expect(threadOf(service).pid).not.toBe(child.pid);
        const restarted = threadOf(service);
        restarted.disconnect();
        await restarted.exited;
        expect(() => process.kill(-restarted.pid, 0)).toThrow();
        expect((await search()).content).toEqual([
          { type: "text", text: "first.txt\n 1: first needle" },
        ]);
        const finalChild = threadOf(service);
        await host.close();
        expect(() => process.kill(-finalChild.pid, 0)).toThrow();
        expect(lifecycle.ownedHandle(finalChild)).toBeNull();
      } finally {
        await host.close();
      }
    }),
  60000,
);

test(
  "after warm(), the first open reuses the warmed child; close joins the child",
  () =>
    fixture(async (root) => {
      const service = new FffWorker();
      try {
        await service.warm();
        const warmed = threadOf(service);
        const bundle = await createFffExtension(
          service,
          root,
          flags(root, "w"),
        );
        await bundle.close();
        expect(threadOf(service)).toBe(warmed);
        await service.close();
        await warmed.exited;
        expect(() => process.kill(-warmed.pid, 0)).toThrow();
      } finally {
        await service.close();
      }
    }),
  60000,
);

test(
  "fresh full-tree misses run off the event loop (p99 <20ms, max <50ms)",
  () =>
    fixture(async (temp) => {
      const service = new FffWorker();
      const delays: number[] = [];
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        delays.push(Math.max(0, now - last - 1));
        last = now;
      }, 1);
      const started = performance.now();
      try {
        for (let index = 0; index < 3; index++) {
          const bundle = await createFffExtension(
            service,
            repo,
            flags(temp, String(index)),
          );
          try {
            const result = await bundle.definitions
              .find((tool) => tool.name === "grep")!
              .execute(
                "miss",
                { pattern: "RecurseWorkerAbsent_" + "6a9d3e7f$", limit: 20 },
                undefined,
                undefined,
                ctx(repo),
              );
            expect(result.details).toMatchObject({ totalMatched: 0 });
            expect(
              (result.details as { totalFiles: number }).totalFiles,
            ).toBeGreaterThan(0);
          } finally {
            await bundle.close();
          }
        }
        await service.close();
        const sorted = delays.toSorted((a, b) => a - b);
        const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
        const max = sorted.at(-1) ?? 0;
        console.log(
          `FFF full-tree misses: ${delays.length} timer samples, p99=${p99.toFixed(1)}ms, max=${max.toFixed(1)}ms, wall=${(performance.now() - started).toFixed(1)}ms`,
        );
      } finally {
        clearInterval(timer);
        await service.close();
      }
    }),
  60000,
);
