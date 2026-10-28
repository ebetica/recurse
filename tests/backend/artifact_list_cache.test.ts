import { expect, test } from "bun:test";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { measure } from "../../src/observability/startup_metrics";

async function listAfterRestart(
  ctx: artifacts.ArtifactContext,
  owner: string | null,
  options: { compact?: boolean } = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import * as artifacts from ${JSON.stringify(join(import.meta.dir, "../../src/artifacts.ts"))};
       import { measure } from ${JSON.stringify(join(import.meta.dir, "../../src/observability/startup_metrics.ts"))};
       await measure("restart", async (measurement) => {
         const start = performance.now();
         const result = await artifacts.listArtifacts(JSON.parse(process.argv[1]), process.argv[2] || null, JSON.parse(process.argv[3]));
         console.log(JSON.stringify({ result, ms: performance.now() - start, git: measurement.counters.get("artifact_git_subprocesses") ?? 0, history: measurement.counters.get("artifact_history_lookups") ?? 0 }));
       }, { write() {} });`,
      JSON.stringify(ctx),
      owner ?? "",
      JSON.stringify(options),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return { ...JSON.parse(output), stderr: error };
}

async function git(repo: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
}

// Regression: #2853 reads and cleanup must preserve live Artifact storage.
test("Artifact listings and directory migrations preserve only live storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-owner-cleanup-"));
  const ctx = {
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
  };
  try {
    expect((await artifacts.listArtifacts(ctx, "missing")).artifacts).toEqual(
      [],
    );
    expect(await artifacts.revision(ctx, "missing")).toBeNull();
    await expect(
      artifacts.get(ctx, "missing", "absent"),
    ).rejects.toBeInstanceOf(artifacts.ArtifactNotFound);
    await expect(stat(ctx.artifactsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const created = await artifacts.create(ctx, {
      owner: "reaped-owner",
      title: "Kept",
    });
    const repo = String(created.repo_path);
    const hook = join(repo, ".git", "hooks", "post-commit");
    const currentHook = await readFile(hook, "utf8");
    expect(currentHook).toContain("src/artifacts/publish_commit.ts' .");
    await writeFile(
      hook,
      "#!/bin/sh\n# A custom hook must not affect listings.\n",
    );
    const listed = await listAfterRestart(ctx, null);
    expect(listed.result.artifacts).toEqual([created]);
    expect(listed.git).toBe(0);
    expect(await readFile(hook, "utf8")).toContain("custom hook");
    await writeFile(
      hook,
      currentHook.replace(
        "src/artifacts/publish_commit.ts' .",
        "tools/artifact.ts' publish-commit .",
      ),
    );
    await writeFile(
      join(ctx.artifactsDir, ".commit-hooks-tools-artifact-v1"),
      "1\n",
    );
    await artifacts.migrateCommitHooks(ctx);
    expect(await readFile(hook, "utf8")).toBe(currentHook);
    await mkdir(join(ctx.artifactsDir, "empty"));
    await mkdir(join(ctx.artifactsDir, "revision-only"));
    await writeFile(
      join(ctx.artifactsDir, "revision-only", ".revision"),
      "old",
    );
    await mkdir(join(ctx.artifactsDir, "stray"));
    await writeFile(join(ctx.artifactsDir, "stray", "debug.txt"), "unused");
    await mkdir(join(ctx.artifactsDir, "pending"));
    await writeFile(
      join(ctx.artifactsDir, "pending", ".deleted-artifact.json"),
      "{}",
    );
    await mkdir(join(ctx.artifactsDir, "uncertain", "nested"), {
      recursive: true,
    });
    await artifacts.migrateArtifactDirectories(ctx);
    expect(
      (await readdir(ctx.artifactsDir))
        .filter((name) => !name.startsWith("."))
        .sort(),
    ).toEqual(["pending", "reaped-owner", "uncertain"]);
    expect(
      JSON.parse(
        await readFile(join(ctx.artifactsDir, ".owner-directories-v1"), "utf8"),
      ),
    ).toEqual({ retired: 3, skippedReceipts: 1, skippedDirectories: 2 });
    expect(await artifacts.pruneEmptyOwner(ctx, "reaped-owner")).toBe(false);
    expect(await stat(join(repo, ".git"))).toBeDefined();
    await mkdir(join(ctx.artifactsDir, "later"));
    await artifacts.migrateArtifactDirectories(ctx);
    expect(await stat(join(ctx.artifactsDir, "later"))).toBeDefined();
    expect(await artifacts.pruneEmptyOwner(ctx, "later")).toBe(true);
    expect(await artifacts.pruneEmptyOwner(ctx, "pending")).toBe(false);
    expect(await artifacts.pruneEmptyOwner(ctx, "later")).toBe(false);
    await mkdir(
      join(ctx.artifactsDir, "revision-directory", ".revision", ".git"),
      { recursive: true },
    );
    expect(await artifacts.pruneEmptyOwner(ctx, "revision-directory")).toBe(
      false,
    );
    await mkdir(join(ctx.artifactsDir, "revision-link"));
    await symlink(repo, join(ctx.artifactsDir, "revision-link", ".revision"));
    expect(await artifacts.pruneEmptyOwner(ctx, "revision-link")).toBe(false);
    expect(await stat(join(repo, ".git"))).toBeDefined();
    for (let index = 0; index < 12; index++) {
      const owner = `racing-${index}`;
      await mkdir(join(ctx.artifactsDir, owner));
      const [pruned, made] = await Promise.allSettled([
        artifacts.pruneEmptyOwner(ctx, owner),
        artifacts.create(ctx, { owner, title: "Concurrent document" }),
      ]);
      expect(pruned.status).toBe("fulfilled");
      if (made.status === "fulfilled") {
        expect(
          await stat(join(String(made.value.repo_path), ".git")),
        ).toBeDefined();
      } else {
        expect(made.reason).toBeInstanceOf(artifacts.ArtifactConflict);
      }
    }
    const broken = { ...ctx, trashDir: join(root, "not-a-directory") };
    await writeFile(broken.trashDir, "fail retirement after admission");
    for (const owner of ["interrupted", "interrupted-populated"])
      await mkdir(join(ctx.artifactsDir, owner));
    const cleanup = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import * as artifacts from ${JSON.stringify(join(import.meta.dir, "../../src/artifacts.ts"))};
      for (const owner of ["interrupted", "interrupted-populated"]) {
        try { await artifacts.pruneEmptyOwner(JSON.parse(process.argv[1]), owner); } catch {}
      }`,
        JSON.stringify(broken),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await cleanup.exited).toBe(0);
    expect(
      (await readdir(ctx.artifactsDir)).filter((name) =>
        name.startsWith(".retiring-owner-"),
      ).length,
    ).toBe(2);
    await expect(
      artifacts.create(ctx, { owner: "interrupted", title: "Blocked" }),
    ).rejects.toBeInstanceOf(artifacts.ArtifactConflict);
    await mkdir(
      join(ctx.artifactsDir, "interrupted-populated", "repo", ".git"),
      { recursive: true },
    );
    await artifacts.recoverArtifactDirectories(ctx);
    await expect(
      stat(join(ctx.artifactsDir, "interrupted")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await stat(
        join(ctx.artifactsDir, "interrupted-populated", "repo", ".git"),
      ),
    ).toBeDefined();
    expect(
      (await readdir(ctx.artifactsDir)).filter((name) =>
        name.startsWith(".retiring-owner-"),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #2853 compact cold listings must not read publication history.
test("compact Artifact lists cache titles independently of publication metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-compact-list-"));
  const ctx = {
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
  };
  try {
    const source = join(root, "index.md");
    await writeFile(source, "# Compact listing\n");
    const created = await artifacts.create(ctx, {
      owner: "agent-A",
      title: "Original title",
      source,
    });
    const repo = String(created.repo_path);
    const id = String(created.id);
    const compact = {
      id,
      owner: "agent-A",
      title: "Original title",
      repo_path: repo,
    };
    const snapshot = join(repo, ".git", "recurse-info.json");
    const warm = await listAfterRestart(ctx, null, { compact: true });
    expect(warm.result.artifacts).toEqual([compact]);
    expect(warm.git).toBe(0);
    await rm(snapshot);
    const cold = await listAfterRestart(ctx, null, { compact: true });
    expect(cold.result.artifacts).toEqual([compact]);
    expect(cold.git).toBe(1);
    expect(cold.history).toBe(0);
    const restarted = await listAfterRestart(ctx, null, { compact: true });
    expect(restarted.result.artifacts).toEqual([compact]);
    expect(restarted.git).toBe(0);
    const full = await listAfterRestart(ctx, "agent-A");
    expect(full.result.artifacts).toEqual([created]);
    await git(repo, "config", artifacts.TITLE_CONFIG_KEY, "External title");
    const changed = await listAfterRestart(ctx, null, { compact: true });
    expect(changed.result.artifacts).toEqual([
      { ...compact, title: "External title" },
    ]);
    expect(changed.git).toBe(1);
    expect(changed.history).toBe(0);
    expect((await listAfterRestart(ctx, null, { compact: true })).git).toBe(0);
    await git(repo, "update-ref", "-d", artifacts.GIT_REF);
    const refChanged = await listAfterRestart(ctx, null, { compact: true });
    expect(refChanged.result.artifacts).toEqual(changed.result.artifacts);
    expect(refChanged.git).toBe(0);
    const filtered = await artifacts.listArtifacts(ctx, "agent-A", {
      compact: true,
      status: "draft",
    });
    expect(filtered.artifacts).toEqual(changed.result.artifacts);
    await artifacts.rename(ctx, "agent-A", id, "Renamed title");
    const renamed = await listAfterRestart(ctx, null, { compact: true });
    expect(renamed.result.artifacts).toEqual([
      { ...compact, title: "Renamed title" },
    ]);
    expect(renamed.git).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #2584 remounted Artifact repositories must reuse snapshots despite new inodes.
test("nine copied Artifact repositories reuse snapshots in a new process", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-remount-"));
  const ctx = {
    artifactsDir: join(root, "original"),
    trashDir: join(root, "trash"),
  };
  const copied = { ...ctx, artifactsDir: join(root, "remounted") };
  const source = join(root, "source.md");
  try {
    await writeFile(source, "# Remounted document\n");
    for (let index = 0; index < 9; index++) {
      await artifacts.create(ctx, {
        owner: "agent-A",
        title: `Document ${index}`,
        source,
      });
    }
    const original = await artifacts.listArtifacts(ctx, "agent-A");
    await cp(ctx.artifactsDir, copied.artifactsDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    for (const item of original.artifacts) {
      const oldRepo = String(item.repo_path);
      const newRepo = join(copied.artifactsDir, "agent-A", String(item.id));
      expect((await stat(join(oldRepo, ".git"))).ino).not.toBe(
        (await stat(join(newRepo, ".git"))).ino,
      );
    }
    const restarted = await listAfterRestart(copied, "agent-A");
    expect(restarted.result.artifacts).toEqual(
      original.artifacts.map((item) => ({
        ...item,
        repo_path: join(copied.artifactsDir, "agent-A", String(item.id)),
      })),
    );
    console.log(
      `Nine copied Artifact list: ${restarted.ms.toFixed(1)} ms, ${restarted.git} Git processes`,
    );
    expect(restarted.git).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #2584 restart must reuse owner-scoped metadata without Git. (also #2302 unchanged Artifact lists must not spawn Git or revisit version history.)
test("Artifact lists reuse metadata and refresh real ref/config changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-list-cache-"));
  let now = new Date("2020-01-01T00:00:00Z");
  const ctx = {
    now: () => now,
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
  };
  const source = join(root, "source.md");
  try {
    await writeFile(source, "# First\n");
    const first = await artifacts.create(ctx, {
      owner: "agent-A",
      title: "First title",
      source,
    });
    const repo = String(first.repo_path);
    const id = String(first.id);
    const createdRevision = await artifacts.revision(ctx, "agent-A");
    expect(createdRevision).not.toBeNull();
    expect(await artifacts.revision(ctx, "agent-B")).toBeNull();
    const listed = await artifacts.listArtifacts(ctx, "agent-A");
    const restarted = await listAfterRestart(ctx, "agent-A");
    expect(restarted.result).toEqual(listed);
    expect(restarted.git).toBe(0);
    expect((await listAfterRestart(ctx, "agent-B")).result.artifacts).toEqual(
      [],
    );
    const snapshot = join(repo, ".git", "recurse-info.json");
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    saved.value.owner = "agent-B";
    await writeFile(snapshot, JSON.stringify(saved));
    const wrongOwner = await listAfterRestart(ctx, "agent-A");
    expect(wrongOwner.result).toEqual(listed);
    expect(wrongOwner.git).toBeGreaterThan(0);
    await rm(snapshot);
    const missingSnapshot = await listAfterRestart(ctx, "agent-A");
    expect(missingSnapshot.result).toEqual(listed);
    expect(missingSnapshot.git).toBeGreaterThan(0);
    expect(missingSnapshot.stderr).toBe("");
    await measure(
      "unchanged-list",
      async (measurement) => {
        const next = await artifacts.listArtifacts(ctx, "agent-A");
        expect(next).toEqual(listed);
        expect(measurement.counters.get("artifact_git_subprocesses") ?? 0).toBe(
          0,
        );
      },
      { write() {} },
    );
    await git(repo, "branch", "-m", `feature/${"x".repeat(230)}`);
    expect(await artifacts.listArtifacts(ctx, "agent-A")).toEqual(listed);
    await git(repo, "pack-refs", "--all", "--prune");
    expect(await artifacts.listArtifacts(ctx, "agent-A")).toEqual(listed);
    await git(repo, "config", artifacts.TITLE_CONFIG_KEY, "Changed title");
    const changedAfterRestart = await listAfterRestart(ctx, "agent-A");
    expect(changedAfterRestart.result.artifacts[0].title).toBe("Changed title");
    expect(changedAfterRestart.git).toBeGreaterThan(0);
    expect(changedAfterRestart.history).toBe(0);
    expect(changedAfterRestart.result.artifacts[0].created_at).toBe(
      first.created_at,
    );
    await writeFile(join(repo, ".git", "recurse-info.json"), "invalid cache");
    await measure(
      "changed-title",
      async (measurement) => {
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            artifacts.listArtifacts(ctx, "agent-A"),
          ),
        );
        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);
        const renamed = results[0]!.artifacts[0]!;
        expect(measurement.counters.get("artifact_git_subprocesses")).toBe(4);
        expect(renamed.title).toBe("Changed title");
        expect(renamed.created_at).toBe(first.created_at);
        expect(measurement.counters.get("artifact_history_lookups") ?? 0).toBe(
          0,
        );
      },
      { write() {} },
    );
    now = new Date("2021-01-01T00:00:00Z");
    await writeFile(join(repo, "index.md"), "# Second\n");
    const second = await artifacts.publish(ctx, "agent-A", id, {
      expected: String(first.version),
    });
    const publishedRef = join(repo, ".git", artifacts.GIT_REF);
    const refTime = (await stat(publishedRef)).mtime;
    for (const version of [first.version, second.version]) {
      await git(repo, "update-ref", artifacts.GIT_REF, String(version));
      await utimes(publishedRef, refTime, refTime);
      const refreshed = await listAfterRestart(ctx, "agent-A");
      expect(refreshed.result.artifacts[0].version).toBe(version);
      expect(refreshed.result.artifacts[0].created_at).toBe(first.created_at);
      expect(refreshed.git).toBeGreaterThan(0);
    }
    await git(repo, "update-ref", "-d", artifacts.GIT_REF);
    const headRef = (await readFile(join(repo, ".git", "HEAD"), "utf8"))
      .trim()
      .slice("ref: ".length);
    const branchRef = join(repo, ".git", headRef);
    for (const version of [first, second]) {
      await git(repo, "update-ref", headRef, String(version.version));
      await utimes(branchRef, refTime, refTime);
      const draft = await listAfterRestart(ctx, "agent-A");
      expect(draft.result.artifacts[0].status).toBe("draft");
      expect(draft.result.artifacts[0].updated_at).toBe(version.updated_at);
      expect(draft.git).toBeGreaterThan(0);
    }
    await git(repo, "update-ref", artifacts.GIT_REF, String(second.version));
    const publishedRevision = await artifacts.revision(ctx, "agent-A");
    expect(publishedRevision).not.toBe(createdRevision);
    await artifacts.publish(ctx, "agent-A", id);
    expect(await artifacts.revision(ctx, "agent-A")).toBe(publishedRevision);
    await expect(
      artifacts.publish(ctx, "agent-A", id, {
        expected: String(first.version),
      }),
    ).rejects.toBeInstanceOf(artifacts.ArtifactConflict);
    expect(await artifacts.revision(ctx, "agent-A")).toBe(publishedRevision);
    expect(second.version).not.toBe(first.version);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).not.toBe(first.updated_at);
    expect(
      (await artifacts.listArtifacts(ctx, "agent-A")).artifacts[0],
    ).toEqual(second);
    await artifacts.restore(
      ctx,
      "agent-A",
      id,
      String(first.version),
      String(second.version),
    );
    const restored = (await artifacts.listArtifacts(ctx, "agent-A"))
      .artifacts[0]!;
    const restoredRevision = await artifacts.revision(ctx, "agent-A");
    expect(restoredRevision).not.toBe(publishedRevision);
    expect(restored.version).toBe(first.version);
    expect(restored.created_at).toBe(first.created_at);
    const config = join(repo, ".git", "config");
    const savedConfig = await readFile(config, "utf8");
    await writeFile(config, `${savedConfig}\n#${"x".repeat(70 * 1024)}\n`);
    const oversized = await listAfterRestart(ctx, "agent-A");
    expect(oversized.result.artifacts[0].title).toBe("Changed title");
    expect(oversized.result.artifacts[0].version).toBe(first.version);
    await writeFile(config, savedConfig);
    await artifacts.deleteArtifact(ctx, "agent-A", id, String(first.version));
    expect(await artifacts.revision(ctx, "agent-A")).not.toBe(restoredRevision);
    expect((await artifacts.listArtifacts(ctx, "agent-A")).artifacts).toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
