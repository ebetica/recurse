import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cases from "./fixtures/memory_snapshot/cases.json";
import {
  captureMemorySnapshot,
  ensureMemoryDirs,
  renderMemoryPrompt,
  scanMemoryDir,
  DEFAULT_LIMITS,
} from "../../src/agents/runtime/memory_snapshot";
import type {
  ScanLimits,
  MemoryEntry,
  MemoryIndex,
} from "../../src/agents/runtime/memory_snapshot";

const tempRoot = process.env.RECURSE_AGENT_TMPDIR ?? tmpdir();
async function privateRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tempRoot, "memory-ts-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function limits(input: Record<string, number | undefined>): ScanLimits {
  const mapped: Record<string, number> = {};
  for (const [key, value] of Object.entries(input))
    if (value !== undefined)
      mapped[
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
      ] = value;
  return { ...DEFAULT_LIMITS, ...mapped };
}

describe("native memory indexes follow current metadata policy", () => {
  for (const raw of cases.cases.filter((caseRow) => "spec" in caseRow))
    test(raw.name, async () =>
      privateRoot(async (base) => {
        const row = raw as {
          name: string;
          spec: {
            path: string;
            kind?: string;
            target?: string;
            hex?: string;
            text?: string;
            title?: string;
            date?: string;
            mode?: number;
          }[];
          limits: Record<string, number>;
          scan: boolean;
          expected: {
            local: MemoryIndex;
            global: MemoryIndex;
            prompt: string;
          };
        };
        const root = join(base, `memory-fixture-${row.name}`);
        const paths = await ensureMemoryDirs("agent", root);
        for (const item of row.spec) {
          const path = join(root, item.path);
          await mkdir(join(path, ".."), { recursive: true });
          if (item.kind === "dir") await mkdir(path, { recursive: true });
          else if (item.kind === "symlink")
            await symlink(join(root, item.target!), path);
          else if (item.kind === "hardlink")
            await link(join(root, item.target!), path);
          else if (item.kind === "bytes")
            await writeFile(
              path,
              Uint8Array.from(Buffer.from(item.hex!, "hex")),
            );
          else
            await writeFile(
              path,
              item.text ??
                `---\ntitle: ${item.title ?? "Useful"}\ndate: ${item.date ?? "2026-08-18"}\n---\nBODY_SECRET\n`,
            );
          if (item.mode !== undefined) await chmod(path, item.mode);
        }
        const scanLimits = limits(row.limits);
        if (row.scan)
          expect(await scanMemoryDir(paths.local, scanLimits)).toEqual(
            row.expected.local,
          );
        const snapshot = await captureMemorySnapshot("agent", root, scanLimits);
        expect(snapshot.local).toEqual(row.expected.local);
        expect(snapshot.global).toEqual(row.expected.global);
        const prompt = renderMemoryPrompt(snapshot, root);
        expect(prompt).toBe(row.expected.prompt);
        expect(prompt).not.toContain("BODY_SECRET");
      }),
    );
});

test("memory prompts escape line separators", () => {
  const row = cases.cases.find((item) => item.name === "render-budget")! as {
    render_spec: {
      count: number;
      path: string;
      title: string;
      local: string;
      global: string;
    };
    expected: {
      sha256: string;
      bytes: number;
      truncated: boolean;
      escaped: boolean;
    };
  };
  const spec = row.render_spec;
  const noisy: MemoryEntry[] = Array.from(
    { length: spec.count },
    (_, index) => ({
      path: `${String(index).padStart(3, "0")}-${spec.path}.md`,
      title: spec.title,
      date: "2026-08-18",
    }),
  );
  const prompt = renderMemoryPrompt(
    {
      paths: {
        local: spec.local,
        tree: "/private/data/memories/trees/agent",
        global: spec.global,
      },
      tree: { entries: [], truncated: false },
      local: { entries: noisy, truncated: false },
      global: { entries: noisy, truncated: false },
    },
    "/private/data",
  );
  expect(prompt).toContain("&#x2028;");
  expect(prompt).toContain("&#x85;");
  expect({
    sha256: createHash("sha256").update(prompt).digest("hex"),
    bytes: Buffer.byteLength(prompt, "utf8"),
    truncated: prompt.includes("- [index truncated]"),
    escaped: !/[\u2028\u0085]/u.test(prompt),
  }).toEqual(row.expected);
});

test("hardlink created and removed during a read stays out of index", async () =>
  privateRoot(async (root) => {
    const paths = await ensureMemoryDirs("agent", root);
    const target = join(paths.local, "racy.md"),
      transient = join(root, "transient.md");
    await writeFile(
      target,
      "---\ntitle: Private\ndate: 2026-08-18\n---\nSECRET\n",
    );
    const index = await scanMemoryDir(paths.local, DEFAULT_LIMITS, {
      beforeRead: async (name) => {
        if (name === "racy.md") await link(target, transient);
      },
      beforeVisibleStat: async (name) => {
        if (name === "racy.md") await unlink(transient);
      },
    });
    expect(index.entries).toEqual([]);
  }));

test("symlinked and permissive directory components fail closed", async () =>
  privateRoot(async (root) => {
    const paths = await ensureMemoryDirs("agent", root);
    await chmod(paths.local, 0o755);
    await expect(ensureMemoryDirs("agent", root)).rejects.toThrow();
    expect((await scanMemoryDir(paths.local)).entries).toEqual([]);
    await chmod(paths.local, 0o700);
    const linked = join(root, "linked-root");
    await mkdir(linked);
    await symlink(linked, join(root, "memories", "agents", "evil"));
    await expect(ensureMemoryDirs("evil", root)).rejects.toThrow();
    for (const cid of ["../escape", "", "/absolute", "bad/name"])
      await expect(ensureMemoryDirs(cid, root)).rejects.toThrow();
  }));

test("TS reads a written Markdown memory", async () =>
  privateRoot(async (root) => {
    const { local } = await ensureMemoryDirs("agent", root);
    await writeFile(
      join(local, "reverse.md"),
      "---\ntitle: TS wrote this\ndate: 2026-09-25\n---\nprivate body\n",
    );
    expect((await scanMemoryDir(local)).entries).toEqual([
      { path: "reverse.md", title: "TS wrote this", date: "2026-09-25" },
    ]);
    expect(await readFile(join(local, "reverse.md"), "utf8")).toContain(
      "private body",
    );
  }));
