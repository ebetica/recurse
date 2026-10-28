import { expect, test } from "bun:test";
import { WorktreeHolders } from "../../src/agents/worktree_holders";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { sweep } from "../../src/utils/trash";
import { join } from "node:path";
import {
  addHolder,
  cleanOnce,
  getLiveAgentIds,
  managedRoot,
  markerRecord,
  reapOne,
  reclaimWorktreeTrash,
  removeHolder,
  rootFromEnv,
  validName,
  withCleanerLock,
  type MembershipConfig,
} from "../../tools/worktree";

const TOKEN = "local-test-token";

function makeRoot() {
  const data = mkdtempSync(join(tmpdir(), "recurse-worktree-safety-"));
  return { data, root: rootFromEnv(data) };
}

function writeMarker(
  root: ReturnType<typeof makeRoot>["root"],
  name: string,
  holders: Record<string, unknown>,
  path = join(root.worktrees, name),
): void {
  mkdirSync(path, { recursive: true });
  mkdirSync(root.markers, { recursive: true });
  writeFileSync(
    join(root.markers, `${name}.json`),
    JSON.stringify({ version: 1, name, path, holders }),
  );
}

test("name and marker checks protect managed-root containment and holder updates", () => {
  const { data, root } = makeRoot();
  try {
    expect(validName("agent_worktree-1.ok")).toBe("agent_worktree-1.ok");
    expect(validName(".managed")).toBeNull();
    expect(validName("a".repeat(129))).toBeNull();

    const checkout = join(root.worktrees, "managed");
    const nested = join(checkout, "nested");
    const outside = join(data, "outside");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    writeMarker(root, "managed", { owner: 10 });
    symlinkSync(outside, join(checkout, "escape"));

    expect(markerRecord(root, "managed")).toMatchObject({
      name: "managed",
      holders: { owner: 10 },
    });
    expect(managedRoot(root, nested)).toBe(checkout);
    expect(managedRoot(root, outside)).toBeNull();
    expect(managedRoot(root, join(checkout, "escape"))).toBeNull();
    expect(removeHolder(root, "managed", "owner")).toBe(true);
    expect(markerRecord(root, "managed")?.holders).toEqual({});
    expect(removeHolder(root, "managed", "owner")).toBe(true);
    expect(removeHolder(root, "missing", "owner")).toBe(false);

    writeMarker(root, "invalid", {}, join(root.worktrees, "other-path"));
    expect(markerRecord(root, "invalid")).toBeNull();
    expect(removeHolder(root, "invalid", "owner")).toBe(false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2401 worktree accumulation retained freshly reaped holders for seven days.
test("reaping immediately retires absent holders and drains trash separately", () => {
  const { data, root } = makeRoot();
  try {
    writeMarker(root, "stale", { "old-agent": Date.now() / 1000 });
    expect(reapOne(root, "stale", new Set())).toBe(true);
    expect(reapOne(root, "stale", new Set())).toBe(false);
    expect(existsSync(join(root.worktrees, "stale"))).toBe(false);
    expect(existsSync(join(root.markers, "stale.json"))).toBe(false);
    expect(readdirSync(root.trash)).toHaveLength(1);
    expect(sweep(root.trash, 1)).toBe(1);
    expect(readdirSync(root.trash)).toEqual([]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2401 explicit reap release must not override a claim made after its observation.
test("reap requests preserve post-observation holder claims", async () => {
  const { data, root } = makeRoot();
  try {
    writeMarker(root, "adopted", { absent: 0 });
    const observed = Date.now() / 1000;
    expect(
      await addHolder(root, join(root.worktrees, "adopted"), "adopter"),
    ).toBe("held");
    expect(
      await cleanOnce(
        root,
        () => [observed, new Set(), true],
        new Set(["adopter"]),
      ),
    ).toBe("cleaned-0");
    expect(existsSync(join(root.worktrees, "adopted"))).toBe(true);
    expect(markerRecord(root, "adopted")?.holders).toHaveProperty("adopter");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2401 legacy name-PID trash was incompatible with the hex-only utility sweep.
test("reclamation migrates and removes legacy trash entries", () => {
  const { data, root } = makeRoot();
  try {
    const legacy = join(root.trash, "old-checkout-123");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "package.txt"), "retired contents\n");
    expect(reclaimWorktreeTrash(root)).toBe(1);
    expect(readdirSync(root.trash)).toEqual([]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2605 live creation reservations must survive before the checkout directory exists. (also #2401 worktree cleanup must retain live, creating, and post-snapshot users.)
test("cleanup protects live users and creation, and retains unknown membership", async () => {
  const { data, root } = makeRoot();
  try {
    const now = Date.now() / 1000;
    writeMarker(root, "live", { live: 0, absent: now - 1 });
    writeMarker(root, "shared", { absent: now - 1 });
    writeMarker(root, "new", { new: now + 1 });
    for (const name of ["creating", "reservation"]) {
      writeMarker(root, name, { child: now - 1 });
      writeFileSync(
        join(root.markers, `${name}.json`),
        JSON.stringify({
          ...markerRecord(root, name),
          creating: { cid: "child", pid: process.pid },
        }),
      );
    }
    rmdirSync(join(root.worktrees, "reservation"));
    writeMarker(root, "unknown", { absent: now - 1 });
    mkdirSync(join(root.worktrees, "unmarked"));
    for (const name of ["orphan", "live-named", "shared-cwd"]) {
      const path = join(root.worktrees, name, "src");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "work.txt"), "untracked work\n");
      writeFileSync(join(root.worktrees, name, ".git"), "gitdir: x\n");
    }
    expect(await cleanOnce(root, () => [now, "UNKNOWN", false])).toBe(
      "unknown",
    );
    expect(existsSync(join(root.worktrees, "unknown"))).toBe(true);
    expect(
      await cleanOnce(root, () => [
        now,
        new Set(["live"]),
        true,
        new Set([
          join(root.worktrees, "shared"),
          join(root.worktrees, "shared-cwd", "src"),
        ]),
      ]),
    ).toBe("cleaned-4");
    for (const name of ["unmarked", "orphan", "live-named"])
      expect(existsSync(join(root.worktrees, name))).toBe(false);
    for (const name of ["live", "shared", "new", "creating", "shared-cwd"])
      expect(existsSync(join(root.worktrees, name))).toBe(true);
    expect(markerRecord(root, "reservation")?.creating).toEqual({
      cid: "child",
      pid: process.pid,
    });
    expect(markerRecord(root, "live")?.holders).toEqual({ live: 0 });
    expect(markerRecord(root, "shared")?.holders).toEqual({});
    expect(
      await cleanOnce(
        root,
        () => [
          now + 2,
          new Set(["live"]),
          true,
          new Set([join(root.worktrees, "shared")]),
        ],
        new Set(["child"]),
      ),
    ).toBe("cleaned-4");
    expect(markerRecord(root, "reservation")).toBeNull();
    expect(existsSync(join(root.worktrees, "creating"))).toBe(false);
    expect(existsSync(join(root.worktrees, "shared-cwd"))).toBe(false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2401 legacy metadata must be claimed before a sweep converts it into a managed marker.
test("claiming a legacy checkout migrates its holders before cleanup", async () => {
  const { data, root } = makeRoot();
  try {
    mkdirSync(join(root.worktrees, "legacy"), { recursive: true });
    const oldHolders = join(root.worktrees, ".managed", "legacy", "HOLDERS");
    mkdirSync(oldHolders, { recursive: true });
    writeFileSync(
      join(oldHolders, "legacy-agent.json"),
      "ignored legacy contents",
    );

    expect(
      await addHolder(root, join(root.worktrees, "legacy"), "adopter"),
    ).toBe("held");
    const result = await cleanOnce(root, () => [
      Date.now() / 1000,
      new Set(["legacy-agent", "adopter"]),
      true,
    ]);
    expect(result).toBe("cleaned-0");
    expect(existsSync(join(root.worktrees, ".managed"))).toBe(false);
    expect(markerRecord(root, "legacy")?.holders).toMatchObject({
      "legacy-agent": expect.any(Number),
      adopter: expect.any(Number),
    });
    expect(existsSync(join(root.worktrees, "legacy"))).toBe(true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("cleaner locks exclude mutations but never span membership reads", async () => {
  const { data, root } = makeRoot();
  try {
    mkdirSync(root.markers, { recursive: true });
    const lock = join(root.markers, ".cleaner.lock");
    writeMarker(root, "locked", { absent: 0 });
    const observe = (): [number, Set<string>, boolean] => [
      Date.now() / 1000,
      new Set<string>(),
      true,
    ];

    await withCleanerLock(root, async () => {
      expect(await cleanOnce(root, observe)).toBe("skipped");
      expect(existsSync(join(root.worktrees, "locked"))).toBe(true);
    });
    expect(await cleanOnce(root, observe)).toBe("cleaned-1");
    expect(existsSync(lock)).toBe(true);

    let started!: () => void;
    let release!: () => void;
    const startedPass = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = cleanOnce(root, async () => {
      started();
      await gate;
      return observe();
    });
    await startedPass;
    expect(await cleanOnce(root, observe)).toBe("cleaned-0");
    release();
    expect(await first).toBe("cleaned-0");
    expect(existsSync(lock)).toBe(true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

function contender(data: string, body: string) {
  return Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { cleanOnce, rootFromEnv, withCleanerLock } = await import(process.argv[2]);
    const root = rootFromEnv(process.argv[1]);
    ${body}
  `,
      data,
      new URL("../../tools/worktree.ts", import.meta.url).pathname,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function contenderReady(
  child: ReturnType<typeof contender>,
): Promise<void> {
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("ready\n");
  reader.releaseLock();
}

async function contenderOutput(
  child: ReturnType<typeof contender>,
): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return output + decoder.decode();
}

// Regression: #2401 PID-file recovery allowed competing cleaners to both claim one marker.
test("two simultaneous contenders retire a marker exactly once", async () => {
  const { data, root } = makeRoot();
  const children: ReturnType<typeof contender>[] = [];
  try {
    writeMarker(root, "contended", { absent: 0 });
    for (let index = 0; index < 2; index++)
      children.push(
        contender(
          data,
          `
      process.stdout.write("ready\\n");
      await Bun.stdin.text();
      const result = await cleanOnce(root, () => [Date.now() / 1000, new Set(), true]);
      process.stdout.write(result);
    `,
        ),
      );
    await Promise.all(children.map(contenderReady));
    for (const child of children) child.stdin.end();
    const results = await Promise.all(
      children.map(async (child) => {
        const output = await contenderOutput(child);
        expect(await child.exited).toBe(0);
        return output;
      }),
    );
    expect(results.filter((result) => result === "cleaned-1")).toHaveLength(1);
    expect(existsSync(join(root.worktrees, "contended"))).toBe(false);
    expect(readdirSync(root.trash)).toHaveLength(1);
  } finally {
    for (const child of children) {
      child.kill();
      await child.exited;
    }
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2401 a dead holder must not strand the cleanup/admission lock.
test("killing a lock holder releases the kernel lock", async () => {
  const { data, root } = makeRoot();
  const child = contender(
    data,
    `await withCleanerLock(root, async () => {
    process.stdout.write("ready\\n");
    await Bun.stdin.text();
  });`,
  );
  try {
    writeMarker(root, "blocked", { absent: 0 });
    await contenderReady(child);
    expect(
      await cleanOnce(root, () => [Date.now() / 1000, new Set(), true]),
    ).toBe("skipped");
    child.kill("SIGKILL");
    await child.exited;
    expect(
      await cleanOnce(root, () => [Date.now() / 1000, new Set(), true]),
    ).toBe("cleaned-1");
    expect(existsSync(join(root.worktrees, "blocked"))).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    rmSync(data, { recursive: true, force: true });
  }
});

test("holder admission rejects a real filesystem marker-write failure", async () => {
  const { data, root } = makeRoot();
  writeMarker(root, "blocked", { absent: 0 });
  const holder = contender(
    data,
    `await withCleanerLock(root, async () => {
    process.stdout.write("ready\\n");
    await Bun.stdin.text();
  });`,
  );
  let claim: Promise<void> | undefined;
  try {
    await contenderReady(holder);
    claim = new WorktreeHolders(data).hold(
      join(root.worktrees, "blocked"),
      "adopter",
    );
    void claim.catch(() => {});
    let pid: number | undefined;
    const deadline = performance.now() + 5000;
    while (!pid) {
      const children = readFileSync(
        `/proc/${process.pid}/task/${process.pid}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      pid = children.find((child) => {
        try {
          return readFileSync(`/proc/${child}/cmdline`, "utf8").includes(
            "worktree_hold.ts",
          );
        } catch {
          return false;
        }
      });
      if (performance.now() > deadline)
        throw new Error("claim subprocess did not start");
      if (!pid) await Bun.sleep(5);
    }
    mkdirSync(join(root.markers, `.blocked.json.${pid}.tmp`));
    holder.stdin.end();
    expect(await holder.exited).toBe(0);
    await expect(claim).rejects.toThrow("worktree claim failed");
    expect(markerRecord(root, "blocked")?.holders).toEqual({ absent: 0 });
    expect(existsSync(join(root.worktrees, "blocked"))).toBe(true);
    await new WorktreeHolders(data).hold(
      join(root.worktrees, "blocked"),
      "adopter",
    );
    expect(markerRecord(root, "blocked")?.holders).toHaveProperty("adopter");
  } finally {
    holder.kill();
    await holder.exited;
    await claim?.catch(() => {});
    rmSync(data, { recursive: true, force: true });
  }
});

test("membership snapshots fail closed and accept only a complete loopback response", async () => {
  let status = 200;
  let payload: unknown = {
    complete: true,
    conversations: [{ id: "live-agent" }],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("x-loopback-token") !== TOKEN) {
        return new Response(null, { status: 403 });
      }
      return Response.json(payload, { status });
    },
  });
  const config: MembershipConfig = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
    endpoint: "/api/subagent-tool/conversations",
    timeout: 2,
  };
  try {
    const complete = await getLiveAgentIds(config);
    expect(complete[1]).toEqual(new Set(["live-agent"]));
    expect(complete[2]).toBe(true);

    payload = { complete: false, conversations: [] };
    expect(
      await getLiveAgentIds(config).then((snapshot) => snapshot.slice(1)),
    ).toEqual(["UNKNOWN", false]);
    payload = { complete: true, conversations: [{}] };
    expect(
      await getLiveAgentIds(config).then((snapshot) => snapshot.slice(1)),
    ).toEqual(["UNKNOWN", false]);
    status = 503;
    expect(
      await getLiveAgentIds(config).then((snapshot) => snapshot.slice(1)),
    ).toEqual(["UNKNOWN", false]);
    expect(
      await getLiveAgentIds({
        ...config,
        baseUrl: "http://192.0.2.1:1234",
      }).then((snapshot) => snapshot.slice(1)),
    ).toEqual(["UNKNOWN", false]);
  } finally {
    server.stop(true);
  }
});

test("membership endpoints cannot override the loopback host", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrls.push(String(input));
    return Response.json({ complete: true, conversations: [] });
  }) as typeof fetch;
  try {
    const base = {
      baseUrl: "http://127.0.0.1:12345",
      token: TOKEN,
      timeout: 1,
    };
    for (const endpoint of [
      "//attacker.example/path",
      "https://attacker.example/path",
    ]) {
      expect(
        await getLiveAgentIds({ ...base, endpoint }).then((snapshot) =>
          snapshot.slice(1),
        ),
      ).toEqual(["UNKNOWN", false]);
    }
    expect(requestedUrls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
