import { afterAll, expect, test } from "bun:test";
import {
  skillHelp,
  gitHeadMarker,
  SkillContext,
  type SkillRegistry,
} from "../../src/skill_context";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporary: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recurse-skill-context-test-"));
  temporary.push(root);
  return root;
}

test("leading help is extracted from malformed TypeScript", async () => {
  const root = await tempRoot();
  const path = join(root, "malformed-skill.ts");
  await writeFile(
    path,
    "/**\n * Leading help from malformed source.\n */\nexport const broken = ;\n",
    "utf8",
  );
  // test-check-allow: T2 Real malformed TS file metadata, not product copy.
  expect(await skillHelp(path, "Syntax fallback.")).toBe(
    "Leading help from malformed source.",
  );
});

test("gitHeadMarker follows linked worktrees and keeps refs in the identity", async () => {
  const root = await tempRoot();
  const workdir = join(root, "worktree");
  const gitdir = join(root, "gitdir");
  const common = join(root, "common");
  await mkdir(workdir, { recursive: true });
  await mkdir(join(gitdir, "refs", "heads"), { recursive: true });
  await mkdir(join(common, "refs", "heads"), { recursive: true });
  await writeFile(join(workdir, ".git"), `gitdir: ${gitdir}\n`, "utf8");
  await writeFile(join(gitdir, "commondir"), common, "utf8");
  await writeFile(join(gitdir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(
    join(common, "refs", "heads", "main"),
    "a".repeat(40),
    "utf8",
  );
  const first = await gitHeadMarker(workdir);

  const refInfo = await stat(join(common, "refs", "heads", "main"));
  await writeFile(
    join(common, "refs", "heads", "main"),
    "b".repeat(40),
    "utf8",
  );
  await utimes(
    join(common, "refs", "heads", "main"),
    refInfo.atime,
    refInfo.mtime.getTime() / 1000 + 3,
  );
  const second = await gitHeadMarker(workdir);
  expect(first.some((value, index) => value !== second[index])).toBe(true);
});

test("snapshot reuse, invalidation, and stale publication follow generation", async () => {
  const root = await tempRoot();
  const agentDir = join(root, "agent");
  const entry = join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(entry, "{}", "utf8");
  const registry: SkillRegistry = {
    contextVersion: 2,
    dataDir: join(root, "data"),
    agentDir,
    repoUrl: "https://example.invalid/recurse.git",
    displayName: "Test",
  };
  const context = new SkillContext(() => registry);
  const first = await context.skillSnapshot();
  expect(await context.skillSnapshot()).toBe(first);

  const before = await stat(entry);
  await writeFile(entry, '{"skills": []}', "utf8");
  await utimes(entry, before.atime, before.mtime.getTime() / 1000 + 3);
  const second = await context.skillSnapshot();
  expect(second).not.toBe(first);

  context.dropSkillSnapshot();
  expect(await context.skillSnapshot()).not.toBe(second);
  expect(context.generation).toBe(1);

  const generation = context.generation;
  const detached = await context.build(registry);
  context.dropSkillSnapshot();
  expect(context.installIfCurrent(detached, generation)).toBeNull();
  expect(context.installedSnapshot).toBeNull();
});

test("loop-safe workdir rendering uses only an installed snapshot", async () => {
  const root = await tempRoot();
  const registry: SkillRegistry = {
    contextVersion: 2,
    dataDir: root,
    agentDir: root,
    repoUrl: "https://example.invalid/recurse.git",
    displayName: "Test",
  };
  const context = new SkillContext(() => registry);
  expect(context.contextForWorkdirLoopSafe(join(root, "workdir"))).toBeNull();
  const installed = await context.skillSnapshot();
  expect(context.installedSnapshot).toBe(installed);
  const workdir = join(root, "workdir");
  expect(context.contextForWorkdirLoopSafe(workdir)).toBeNull();
  await context.workdirContextRefreshed();
  expect(context.contextForWorkdirLoopSafe(workdir)).toMatch(/^[0-9a-f]{32}$/u);
});

test("loop-safe gate checks rearm after successful external changes", async () => {
  const root = await tempRoot();
  const agentDir = join(root, "agent");
  const entry = join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(entry, "{}", "utf8");
  const registry: SkillRegistry = {
    contextVersion: 2,
    dataDir: join(root, "data"),
    agentDir,
    repoUrl: "https://example.invalid/recurse.git",
    displayName: "Test",
  };
  const context = new SkillContext(() => registry);
  const beforeSnapshot = await context.skillSnapshot();
  const workdir = join(root, "workdir");
  expect(context.contextForWorkdirLoopSafe(workdir)).toBeNull();
  await context.snapshotCheckRefreshed();
  await context.workdirContextRefreshed();
  const beforeContext = context.contextForWorkdirLoopSafe(workdir);
  expect(beforeContext).toMatch(/^[0-9a-f]{32}$/u);
  await context.snapshotCheckRefreshed();
  expect(context.installedSnapshot).toBe(beforeSnapshot);

  const entryStat = await stat(entry);
  await writeFile(entry, '{"skills": []}', "utf8");
  await utimes(entry, entryStat.atime, entryStat.mtime.getTime() / 1000 + 3);
  expect(context.contextForWorkdirLoopSafe(workdir)).toBe(beforeContext);
  await context.snapshotCheckRefreshed();
  const afterSnapshot = context.installedSnapshot;
  expect(afterSnapshot).not.toBe(beforeSnapshot);
  expect(await context.contextForWorkdir(workdir)).not.toBe(beforeContext);
});

afterAll(async () => {
  await Promise.all(
    temporary.map((path) => rm(path, { recursive: true, force: true })),
  );
});
