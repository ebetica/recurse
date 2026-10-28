import { expect, test } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { setEnvironmentData, type Worker } from "node:worker_threads";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FffWorker } from "../../../../src/extensions/extra/fff/fff_worker.ts";
import { createFffExtension } from "../../../../src/extensions/extra/fff/fff.ts";
import { FFF_IMPORT_COUNT } from "../../../../src/extensions/extra/fff/fff_tools.ts";
import {
  fauxHost,
  until,
} from "../../../backend/fixtures/durable_host/host.ts";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const ctx = (cwd: string) => ({ cwd }) as ExtensionToolContext;
const flags = (root: string, key: string) => ({
  "fff-frecency-db": path.join(root, `f-${key}`),
  "fff-history-db": path.join(root, `h-${key}`),
});
const unshareImportCount = () =>
  setEnvironmentData(FFF_IMPORT_COUNT, undefined as never);
const threadOf = (service: FffWorker) =>
  (service as unknown as { thread: Worker }).thread;

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
  "abort/connection close keep the other conversation usable; shutdown joins the one thread",
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
        thread.once("exit", () => {
          exits++;
          settledAtExit = settled;
        });
        await service.close();
        await pending;
        await second.close();
        expect(settledAtExit).toBe(true);
        expect(exits).toBe(1);
        await expect(service.open(root, flags(root, "late"))).rejects.toThrow(
          "Search worker closed",
        );
      } finally {
        await service.close();
      }
    }),
  60000,
);

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
      expect((await search(child)).details).toMatchObject({ totalFiles: 2 });
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

test(
  "unexpected thread exit rejects all pending admissions without a hidden restart",
  () =>
    fixture(async (root) => {
      const service = new FffWorker();
      try {
        const settled = Promise.allSettled([
          service.open(root, flags(root, "one")),
          service.open(root, flags(root, "two")),
        ]);
        const thread = threadOf(service);
        await thread.terminate();
        expect((await settled).map((result) => result.status)).toEqual([
          "rejected",
          "rejected",
        ]);
        await expect(service.open(root, flags(root, "later"))).rejects.toThrow(
          "Search worker exited",
        );
        expect(threadOf(service)).toBe(thread);
      } finally {
        await service.close();
      }
    }),
  60000,
);

test(
  "after warm(), the first open reuses the warmed thread's pi-fff import; close joins the thread",
  () =>
    fixture(async (root) => {
      const imports = new Int32Array(new SharedArrayBuffer(4));
      setEnvironmentData(FFF_IMPORT_COUNT, imports);
      const service = new FffWorker();
      try {
        await service.warm();
        unshareImportCount();
        const warmed = threadOf(service);
        expect(Atomics.load(imports, 0)).toBe(1);
        const bundle = await createFffExtension(
          service,
          root,
          flags(root, "w"),
        );
        await bundle.close();
        expect(threadOf(service)).toBe(warmed);
        expect(Atomics.load(imports, 0)).toBe(1);
        const exited = new Promise((resolve) =>
          threadOf(service).once("exit", resolve),
        );
        await service.close();
        await exited;
      } finally {
        unshareImportCount();
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
