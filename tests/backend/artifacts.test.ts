import { expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../../src/artifacts/app";
import * as artifacts from "../../src/artifacts";
import { makeContext } from "./fixtures/artifacts/operations";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function installPreCommitHook(
  repo: string,
  scratch: string,
  overflow: boolean,
): Promise<{ groupPath: string; descendantPath: string }> {
  const groupPath = join(scratch, "git-group");
  const descendantPath = join(scratch, "git-descendant");
  const output = overflow
    ? `head -c ${artifacts.GIT_OUTPUT_MAX + 1} /dev/zero\n`
    : "";
  const hook = [
    "#!/bin/sh",
    "set -eu",
    "sleep 60 &",
    "child=$!",
    `printf '%s\\n' "$PPID" > ${shellQuote(groupPath)}`,
    `printf '%s\\n' "$child" > ${shellQuote(descendantPath)}`,
    output.trimEnd(),
    'wait "$child"',
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  await writeFile(join(repo, ".git", "hooks", "pre-commit"), hook, {
    mode: 0o700,
  });
  return { groupPath, descendantPath };
}

async function expectProcessGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`${label} is still running`);
    await Bun.sleep(25);
  }
}

async function expectKilledProcesses(
  groupPath: string,
  descendantPath: string,
): Promise<void> {
  const groupId = Number((await readFile(groupPath, "utf8")).trim());
  const descendantId = Number((await readFile(descendantPath, "utf8")).trim());
  expect(Number.isSafeInteger(groupId)).toBe(true);
  expect(Number.isSafeInteger(descendantId)).toBe(true);
  await expectProcessGone(-groupId, `Git process group ${groupId}`);
  await expectProcessGone(descendantId, `Git descendant ${descendantId}`);
}

for (const mode of ["timeout", "overflow"] as const) {
  test(`Git ${mode} cancellation kills its process group and descendant`, async () => {
    const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-cancel-"));
    const root = join(temp, "instance");
    const context = makeContext(root);
    try {
      const source = join(temp, "initial.md");
      await writeFile(source, "initial\n");
      const item = await artifacts.create(context, {
        owner: "agent-A",
        title: `Git ${mode}`,
        source,
      });
      const repo = String(item.repo_path);
      await writeFile(join(repo, "updated.md"), "updated\n");
      const hook = await installPreCommitHook(repo, temp, mode === "overflow");
      const shortDeadline = { ...context, gitTimeoutMs: 3_000 };
      const publish = artifacts.publish(
        shortDeadline,
        "agent-A",
        String(item.id),
        {
          expected: String(item.version),
        },
      );
      if (mode === "timeout") {
        await expect(publish).rejects.toMatchObject({
          name: "ArtifactCorrupt",
          message: "artifact Git operation timed out",
        });
      } else {
        await expect(publish).rejects.toMatchObject({
          name: "ArtifactLimit",
          message: "artifact Git output exceeds the limit",
        });
      }
      await expectKilledProcesses(hook.groupPath, hook.descendantPath);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}

test("Git ref CAS, owner lookup, no-follow source reads, and tombstones work on real repositories", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-live-"));
  const root = join(temp, "instance");
  const context = makeContext(root);
  const source = join(temp, "source.md");
  const symlinkSource = join(temp, "source-link.md");
  try {
    await writeFile(source, "# First\n");
    const item = await artifacts.create(context, {
      owner: "agent-A",
      title: "CAS test",
      source,
    });
    const id = String(item.id);
    const repo = String(item.repo_path);
    expect(await artifacts.resolveOwner(context, id)).toBe("agent-A");
    await writeFile(join(repo, "index.md"), "# Second\n");
    await writeFile(join(repo, ".git", "index.lock"), "");
    await expect(
      artifacts.publish(context, "agent-A", id, {
        expected: String(item.version),
      }),
    ).rejects.toBeInstanceOf(artifacts.ArtifactConflict);
    await rm(join(repo, ".git", "index.lock"));
    const next = await artifacts.publish(context, "agent-A", id, {
      expected: String(item.version),
    });
    expect(next.version).not.toBe(item.version);
    await expect(
      artifacts.publish(context, "agent-A", id, {
        expected: String(item.version),
      }),
    ).rejects.toBeInstanceOf(artifacts.ArtifactConflict);
    const [metadata, bytes] = await artifacts.fileBytes(
      context,
      "agent-A",
      id,
      "index.md",
    );
    expect(metadata.owner).toBe("agent-A");
    expect(bytes.toString("utf8")).toBe("# Second\n");
    expect(
      (await artifacts.listArtifacts(context, "agent-B")).artifacts,
    ).toEqual([]);

    await symlink(source, symlinkSource);
    await expect(
      artifacts.create(context, {
        owner: "agent-A",
        title: "Linked source",
        source: symlinkSource,
      }),
    ).rejects.toBeInstanceOf(artifacts.ArtifactInvalid);

    const removed = await artifacts.deleteArtifact(
      context,
      "agent-A",
      id,
      String(next.version),
    );
    expect(removed.already_deleted).toBe(false);
    await expect(artifacts.get(context, "agent-A", id)).rejects.toBeInstanceOf(
      artifacts.ArtifactNotFound,
    );
    expect(
      await artifacts.finalizeDelete(
        context,
        "agent-A",
        id,
        String(removed.deletion_id),
      ),
    ).toBe(true);
    expect(await artifacts.recoverableDeletions(context)).toEqual([]);
    expect(basename(repo)).toBe(id);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("new content is a document or an app; older kinds stay readable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-kinds-"));
  const legacy = makeContext(join(temp, "instance"));
  const context = { ...legacy, anyKind: false };
  const refusal = (call: Promise<unknown>) =>
    call.then(
      () => "published",
      (error: Error) => `${error.name}: ${error.message}`,
    );
  try {
    const svg = join(temp, "chart.svg");
    await writeFile(svg, "<svg></svg>");
    const old = await artifacts.create(legacy, {
      owner: "agent-A",
      title: "Old chart",
      source: svg,
    });
    const id = String(old.id);
    const repo = String(old.repo_path);
    expect((await artifacts.get(context, "agent-A", id)).entry).toBe(
      "chart.svg",
    );
    const [meta, bytes] = await artifacts.fileBytes(
      context,
      "agent-A",
      id,
      "chart.svg",
    );
    expect([meta.media_type, bytes.toString()]).toEqual([
      "image/svg+xml",
      "<svg></svg>",
    ]);
    await writeFile(join(repo, "notes.txt"), "two");
    expect(await refusal(artifacts.publish(context, "agent-A", id))).toBe(
      "ArtifactInvalid: an Artifact needs index.md (a document) or index.html (an app) at the top level",
    );
    expect((await artifacts.get(context, "agent-A", id)).version).toBe(
      old.version,
    );
    await writeFile(join(repo, "index.md"), "# Chart\n");
    await rm(join(repo, ".git", "hooks", "post-commit"));
    await artifacts.get(context, "agent-A", id);
    await Bun.$`git -C ${repo} add --all`.quiet();
    const globalConfig = join(temp, "gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n hooksPath = ${join(temp, "shared-hooks")}\n`,
    );
    const committed =
      await Bun.$`git -C ${repo} commit -m ${"Add document entry"}`
        .env({ ...process.env, GIT_CONFIG_GLOBAL: globalConfig })
        .quiet();
    expect(committed.stderr.toString()).toMatch(/"command":\s*"publish"/);
    const document = await artifacts.get(context, "agent-A", id);
    expect([document.format, document.entry]).toEqual(["markdown", "index.md"]);
    const restored = await artifacts.restore(
      context,
      "agent-A",
      id,
      String(old.version),
      String(document.version),
    );
    expect(restored.entry).toBe("chart.svg");
    const [, restoredBytes] = await artifacts.fileBytes(
      context,
      "agent-A",
      id,
      "chart.svg",
    );
    expect(restoredBytes.toString()).toBe("<svg></svg>");
    expect(
      await refusal(
        artifacts.create(context, {
          owner: "agent-A",
          title: "Chart",
          source: svg,
        }),
      ),
    ).toBe(
      'ArtifactInvalid: a new Artifact starts from a Markdown (.md) or HTML (.html) file, not "chart.svg"',
    );
    const page = join(temp, "page.html");
    await writeFile(page, "<p>hello</p>");
    const app = await artifacts.create(context, {
      owner: "agent-A",
      title: "Page",
      source: page,
    });
    expect([app.format, app.entry]).toEqual(["html", "index.html"]);
    expect(
      (
        await artifacts.pageBytes(context, "agent-A", String(app.id))
      ).toString(),
    ).not.toContain('id="recurse-theme"');
    expect(
      (await artifacts.listArtifacts(context, "agent-A")).artifacts,
    ).toHaveLength(2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("publishing an app builds one self-contained page per version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-app-"));
  const context = makeContext(join(temp, "instance"));
  try {
    const item = await artifacts.create(context, {
      owner: "agent-A",
      title: "App",
    });
    const id = String(item.id);
    const repo = String(item.repo_path);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(
      join(repo, "index.html"),
      '<!doctype html><link rel="stylesheet" href="./style.css"><img src="./dot.png" alt="dot"><script type="module" src="./app.tsx"></script>',
    );
    await writeFile(join(repo, "style.css"), "h1 { color: green }");
    await writeFile(join(repo, "dot.png"), new Uint8Array(png));
    await writeFile(
      join(repo, "app.tsx"),
      'const label: string = "first build";\ndocument.body.append(label);\n',
    );
    await Bun.$`mkdir -p ${join(repo, "node_modules", "x")} && echo 1 > ${join(repo, "node_modules", "x", "i.js")}`;
    const first = await artifacts.publish(context, "agent-A", id);
    const html = (await artifacts.pageBytes(context, "agent-A", id)).toString();
    expect(html).toContain("first build");
    expect(html).toContain("color:green");
    expect(html).not.toContain('id="recurse-theme"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("app.tsx");
    const tracked = await Bun.$`git -C ${repo} ls-files`.text();
    expect(tracked).not.toContain("node_modules");

    await writeFile(join(repo, "app.tsx"), "const broken = ;\n");
    const failure = artifacts.publish(context, "agent-A", id);
    await expect(failure).rejects.toBeInstanceOf(artifacts.ArtifactBuild);
    await expect(failure).rejects.toThrow("app.tsx:1");
    expect((await artifacts.get(context, "agent-A", id)).version).toBe(
      first.version,
    );

    await writeFile(
      join(repo, "app.tsx"),
      'document.body.append("second build");\n',
    );
    await artifacts.publish(context, "agent-A", id);
    expect(
      (await artifacts.pageBytes(context, "agent-A", id)).toString(),
    ).toContain("second build");
    await artifacts.restore(context, "agent-A", id, String(first.version));
    expect(
      (await artifacts.pageBytes(context, "agent-A", id)).toString(),
    ).toContain("first build");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

test("an app build reads the committed version, and racing publishes never corrupt it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-app-"));
  const context = makeContext(join(temp, "instance"));
  try {
    const item = await artifacts.create(context, {
      owner: "agent-A",
      title: "App",
    });
    const id = String(item.id);
    const repo = String(item.repo_path);
    await writeFile(join(repo, "index.html"), "<p>committed page</p>");
    const git = `git -C ${shellQuote(repo)} -c user.name=t -c user.email=t@t`;
    await Bun.$`sh -c ${`${git} add index.html && ${git} commit -qm v1 && ${git} update-index --skip-worktree index.html`}`;
    const outside = join(temp, "outside.html");
    await writeFile(outside, "<p>outside secret</p>");
    await rm(join(repo, "index.html"));
    await symlink(outside, join(repo, "index.html"));
    const results = await Promise.allSettled([
      artifacts.publish(context, "agent-A", id),
      artifacts.publish(context, "agent-A", id),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results)
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(artifacts.ArtifactConflict);
    const html = (await artifacts.pageBytes(context, "agent-A", id)).toString();
    expect(html).toContain("committed page");
    expect(html).not.toContain("outside secret");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

test("a build that runs too long is killed with its whole process group", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-run-"));
  try {
    const groupPath = join(temp, "group");
    const descendantPath = join(temp, "descendant");
    const script = `sleep 60 & printf '%s\\n' "$$" > ${shellQuote(groupPath)}; printf '%s\\n' "$!" > ${shellQuote(descendantPath)}; wait`;
    const result = await run(["sh", "-c", script], temp, 500, temp);
    expect(result.code).toBe(1);
    expect(result.log).toContain("timed out");
    await expectKilledProcesses(groupPath, descendantPath);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("build children see no parent secrets, and macros never run", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recurse-artifacts-env-"));
  const context = makeContext(join(temp, "instance"));
  process.env.RECURSE_TEST_SECRET = "sentinel-secret";
  try {
    const env = await run(["sh", "-c", "env"], temp, 5_000, temp);
    expect(env.code).toBe(0);
    expect(env.log).not.toContain("sentinel-secret");
    expect(env.log).toContain(`HOME=${temp}`);

    const item = await artifacts.create(context, {
      owner: "agent-A",
      title: "App",
    });
    const id = String(item.id);
    const repo = String(item.repo_path);
    const marker = join(temp, "macro-ran");
    await writeFile(
      join(repo, "index.html"),
      '<!doctype html><script type="module" src="./app.ts"></script>',
    );
    await writeFile(
      join(repo, "m.ts"),
      `import { writeFileSync } from "node:fs";\nexport function m() { writeFileSync(${JSON.stringify(marker)}, "x"); return 1; }\n`,
    );
    await writeFile(
      join(repo, "app.ts"),
      'import { m } from "./m.ts" with { type: "macro" };\ndocument.body.append(String(m()));\n',
    );
    const failure = artifacts.publish(context, "agent-A", id);
    await expect(failure).rejects.toBeInstanceOf(artifacts.ArtifactBuild);
    await expect(failure).rejects.toThrow("Macros are disabled");
    expect(await lstat(marker).catch(() => null)).toBeNull();
  } finally {
    delete process.env.RECURSE_TEST_SECRET;
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
