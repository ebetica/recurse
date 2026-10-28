import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpChecks } from "../../src/mcp_checks";
import { TaskSet } from "../../src/utils/tasks";
import { groupSnapshot } from "../../src/utils/proc_stat";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { registerMcpServerRoutes } from "../../src/web/settings";
import { buildAuthApp } from "./http_auth_app";
import { until } from "./fixtures/durable_host/host";

test("Check runs once without a conversation and retains admission until its group is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-check-routes-"));
  const probe = join(import.meta.dir, "fixtures/mcp_probe_server.mjs");
  const started = join(root, "started");
  const gate = join(root, "gate");
  const recovery = join(root, "recovery");
  const attempts = join(root, "attempts");
  const unused = join(root, "unused");
  const note = join(root, "note");
  const listGate = join(root, "list-gate");
  const procRoot = join(root, "proc");
  await symlink("/proc", procRoot);
  await writeFile(listGate, "list");
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        recover: {
          command: "/bin/sh",
          args: [
            "-c",
            'if test -e "$1"; then exec "$2" "$3" "$4" "$5" "$6" --stubborn --spawn-child; else exec "$2" "$3" "$4" --exit-17; fi',
            "check",
            recovery,
            process.execPath,
            probe,
            `--attempts=${attempts}`,
            `--startup-note=${note}`,
            `--list-gate=${listGate}`,
          ],
          env: {
            OPTED_IN: `!printf ready >> '${started}'; while ! test -e '${gate}'; do sleep 0.02; done; printf resolved`,
          },
        },
        unused: {
          command: process.execPath,
          args: [probe, `--attempts=${unused}`],
        },
        disabled: { command: "unused", enabled: false },
      },
    }),
  );
  const processes = new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: root,
      processStartedMs: Date.now(),
    }),
    shellStateDir: root,
    procRoot,
    termGraceMs: 100,
    killGraceMs: 100,
  });
  const tasks = new TaskSet();
  const shutdown = new AbortController();
  const checks = new McpChecks({
    configPath: join(root, "mcp.json"),
    temporaryRoot: root,
    trashDir: join(root, "trash"),
    env: {
      PATH: process.env.PATH!,
      HOME: root,
      SERVER_ONLY_SECRET: "never-export-this",
    },
    processes,
    tasks,
    signal: shutdown.signal,
  });
  const app = await buildAuthApp(join(root, "http"), {
    extraRoutes: (router) =>
      registerMcpServerRoutes(router, {
        piAgentDir: async () => root,
        mutateExternalStorage: (work) => work(),
        mcpChecks: checks,
      }),
  });
  const headers = {
    cookie: `chat_auth=${await app.operator.makeToken()}`,
    "content-type": "application/json",
  };
  const statusUrl = new URL("/api/settings/mcp-servers/status", app.running.url)
    .href;
  const checkUrl = new URL("/api/settings/mcp-servers/check", app.running.url)
    .href;
  const check = (name: string) =>
    fetch(checkUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
  const statuses = async () =>
    (
      (await (await fetch(statusUrl, { headers })).json()) as {
        servers: {
          name: string;
          state: string;
          reason?: string;
          checkedAt: number | null;
          toolCount?: number;
          checking?: boolean;
        }[];
      }
    ).servers;
  try {
    expect(
      (
        await fetch(checkUrl, {
          method: "POST",
          body: JSON.stringify({ name: "recover" }),
        })
      ).status,
    ).toBe(401);
    expect((await check("absent")).status).toBe(400);
    expect((await check("disabled")).status).toBe(400);
    expect((await check("recover")).status).toBe(202);
    await until(
      async () =>
        await readFile(started, "utf8").then(
          () => true,
          () => false,
        ),
    );
    expect((await statuses()).find((s) => s.name === "recover")?.checking).toBe(
      true,
    );
    expect((await check("recover")).status).toBe(409);
    expect((await check("unused")).status).toBe(409);
    expect(await readFile(started, "utf8")).toBe("ready");
    await writeFile(gate, "continue");
    await until(async () => !(await statuses()).some((s) => s.checking));
    expect((await statuses()).find((s) => s.name === "recover")).toMatchObject({
      state: "failed",
      reason: "exited with code 17",
      checkedAt: expect.any(Number),
    });
    await writeFile(recovery, "healthy");
    expect((await check("recover")).status).toBe(202);
    await until(async () => !(await statuses()).some((s) => s.checking));
    expect((await statuses()).find((s) => s.name === "recover")).toMatchObject({
      state: "connected",
      toolCount: 5,
      checkedAt: expect.any(Number),
    });
    expect(await readFile(attempts, "utf8")).toBe("start\nstart\n");
    expect(await readFile(unused, "utf8").catch(() => "absent")).toBe("absent");
    const startup = JSON.parse(await readFile(note, "utf8")) as {
      pid: number;
      cwd: string;
      envNames: string[];
    };
    expect(startup.envNames).toContain("OPTED_IN");
    expect(startup.envNames).not.toContain("SERVER_ONLY_SECRET");
    const group = (await groupSnapshot(new Set([startup.pid]))).get(
      startup.pid,
    );
    expect(group?.count ?? 0).toBe(0);
    expect(group?.uncertain ?? false).toBe(false);
    expect(
      await lstat(startup.cwd).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const visible = JSON.stringify(await statuses());
    expect(visible).not.toContain("never-export-this");
    expect(visible).not.toContain("secret-looking-stderr");
    expect(visible).not.toContain("resolved");
    await unlink(note);
    await unlink(listGate);
    expect((await check("recover")).status).toBe(202);
    await until(() => Bun.file(note).exists());
    const held = JSON.parse(await readFile(note, "utf8")) as {
      pid: number;
      cwd: string;
    };
    expect(
      (await groupSnapshot(new Set([held.pid]))).get(held.pid)?.count,
    ).toBeGreaterThan(0);
    await unlink(procRoot);
    await writeFile(listGate, "list");
    await until(async () =>
      (await statuses()).some((s) => s.reason === "process cleanup incomplete"),
    );
    expect((await statuses()).find((s) => s.name === "recover")?.checking).toBe(
      true,
    );
    expect((await check("recover")).status).toBe(409);
    expect(await readFile(attempts, "utf8")).toBe("start\nstart\nstart\n");
    await symlink("/proc", procRoot);
    await until(async () => !(await statuses()).some((s) => s.checking));
    expect((await statuses()).find((s) => s.name === "recover")).toMatchObject({
      state: "connected",
      toolCount: 5,
    });
    const released = (await groupSnapshot(new Set([held.pid]))).get(held.pid);
    expect(released?.count ?? 0).toBe(0);
    expect(released?.uncertain ?? false).toBe(false);
    expect(
      await lstat(held.cwd).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    shutdown.abort();
    await symlink("/proc", procRoot).catch(() => {});
    await writeFile(listGate, "list");
    await writeFile(gate, "continue");
    await tasks.drain();
    await processes.shutdownCleanup();
    await app.running.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Regression: #2645 The configured Check deadline must also stop owned configuration commands.
test("an aborted HTTP request leaves a bounded hanging check owned until verified cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-check-abort-"));
  const note = join(root, "note");
  const secret = "private-hanging-check-token";
  const config = {
    mcpServers: {
      hanging: {
        command: process.execPath,
        args: [
          join(import.meta.dir, "fixtures/mcp_probe_server.mjs"),
          "--stubborn",
          "--spawn-child",
          `--startup-note=${note}`,
          `--list-gate=${join(root, "never-opened")}`,
        ],
        timeout: 0.5,
        env: { TOKEN: secret },
      },
      unused: { command: "unused", enabled: false },
    },
  };
  await writeFile(join(root, "mcp.json"), JSON.stringify(config));
  const processes = new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: root,
      processStartedMs: Date.now(),
    }),
    shellStateDir: root,
    termGraceMs: 100,
    killGraceMs: 100,
  });
  const tasks = new TaskSet();
  const shutdown = new AbortController();
  const checks = new McpChecks({
    configPath: join(root, "mcp.json"),
    temporaryRoot: root,
    trashDir: join(root, "trash"),
    env: { PATH: process.env.PATH! },
    processes,
    tasks,
    signal: shutdown.signal,
  });
  const app = await buildAuthApp(join(root, "http"), {
    extraRoutes: (router) =>
      registerMcpServerRoutes(router, {
        piAgentDir: async () => root,
        mutateExternalStorage: (work) => work(),
        mcpChecks: checks,
      }),
  });
  const headers = {
    cookie: `chat_auth=${await app.operator.makeToken()}`,
    "content-type": "application/json",
  };
  const statusUrl = new URL("/api/settings/mcp-servers/status", app.running.url)
    .href;
  const statuses = async () =>
    (await (await fetch(statusUrl, { headers })).json()) as {
      servers: {
        name: string;
        state: string;
        reason?: string;
        checking?: boolean;
        checkedAt: number | null;
      }[];
    };
  try {
    const controller = new AbortController();
    const response = await fetch(
      new URL("/api/settings/mcp-servers/check", app.running.url).href,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "hanging" }),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(202);
    await until(() => Bun.file(note).exists());
    const started = JSON.parse(await readFile(note, "utf8")) as {
      pid: number;
      cwd: string;
    };
    expect(
      (await groupSnapshot(new Set([started.pid]))).get(started.pid)?.count,
    ).toBeGreaterThan(0);
    controller.abort();
    await expect(response.text()).rejects.toThrow();
    await until(
      async () => !(await statuses()).servers.some((server) => server.checking),
    );
    expect((await statuses()).servers[0]).toMatchObject({
      state: "failed",
      reason: "timed out after 0.5 s",
      checkedAt: expect.any(Number),
    });
    const group = (await groupSnapshot(new Set([started.pid]))).get(
      started.pid,
    );
    expect(group?.count ?? 0).toBe(0);
    expect(group?.uncertain ?? false).toBe(false);
    expect(await Bun.file(started.cwd).exists()).toBe(false);
    const visible = JSON.stringify(await statuses());
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain("secret-looking-stderr");
    expect(visible).not.toContain(process.execPath);
    const commandPid = join(root, "command-pid");
    Object.assign(config.mcpServers.hanging.env, {
      COMMAND_VALUE: `!printf '%s' "$$" > '${commandPid}'; sleep 60; printf private-command-value`,
    });
    await unlink(note);
    await writeFile(join(root, "mcp.json"), JSON.stringify(config));
    expect(
      (
        await fetch(
          new URL("/api/settings/mcp-servers/check", app.running.url).href,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "hanging" }),
          },
        )
      ).status,
    ).toBe(202);
    await until(() => Bun.file(commandPid).exists());
    const pid = Number(await readFile(commandPid, "utf8"));
    expect(
      (await groupSnapshot(new Set([pid]))).get(pid)?.count,
    ).toBeGreaterThan(0);
    await until(
      async () => !(await statuses()).servers.some((server) => server.checking),
    );
    expect((await statuses()).servers[0]).toMatchObject({
      state: "failed",
      reason: "timed out after 0.5 s",
    });
    const commandGroup = (await groupSnapshot(new Set([pid]))).get(pid);
    expect(commandGroup?.count ?? 0).toBe(0);
    expect(commandGroup?.uncertain ?? false).toBe(false);
    expect(await Bun.file(note).exists()).toBe(false);
    expect(JSON.stringify(await statuses())).not.toContain(
      "private-command-value",
    );
    config.mcpServers.hanging.timeout = 1;
    await writeFile(join(root, "mcp.json"), JSON.stringify(config));
    expect((await statuses()).servers).toEqual([
      { name: "hanging", state: "not-used", checkedAt: null },
      { name: "unused", state: "disabled", checkedAt: null },
    ]);
  } finally {
    shutdown.abort();
    await tasks.drain();
    await processes.shutdownCleanup();
    await app.running.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
