// Install Recurse's Artifact post-commit hook without replacing custom hooks.
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHECKOUT_ROOT } from "../../build_dir";
import { timed } from "../../observability";
import { git } from "./git";
import {
  ArtifactConflict,
  ArtifactCorrupt,
  ArtifactError,
  ArtifactNotFound,
  ID_RE,
  OWNER_RE,
  context,
  isMissing,
  openRepository,
  ownedBytes,
  ownerRoot,
  writeFileAtomic,
  type ArtifactContext,
  type ResolvedContext,
} from "./layout";

export function openRepositoryWithHook(
  ctx: ResolvedContext,
  ownerValue: string,
  idValue: string,
): Promise<string> {
  return timed("artifact_ensure", async () => {
    const repo = await openRepository(ctx, ownerValue, idValue);
    try {
      await timed("artifact_hook", () => installCommitHook(ctx, repo));
      return repo;
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
      throw new ArtifactCorrupt("artifact repository is invalid");
    }
  });
}

/** Refresh existing repositories once after the commit publisher moved. */
export async function migrateCommitHooks(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  const marker = join(ctx.artifactsDir, ".commit-hooks-publish-commit-v1");
  try {
    await lstat(marker);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const owner of await readdir(ctx.artifactsDir, {
    withFileTypes: true,
  })) {
    if (!owner.isDirectory() || !OWNER_RE.test(owner.name)) continue;
    const root = await ownerRoot(ctx, owner.name);
    for (const repo of await readdir(root, { withFileTypes: true })) {
      if (!repo.isDirectory() || !ID_RE.test(repo.name)) continue;
      try {
        await openRepositoryWithHook(ctx, owner.name, repo.name);
      } catch (error) {
        if (!(error instanceof ArtifactNotFound)) throw error;
      }
    }
  }
  await writeFileAtomic(ctx, marker, ownedBytes(Buffer.from("1\n")));
}

async function installCommitHook(
  ctx: ResolvedContext,
  repo: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const path = join(repo, ".git", "hooks", "post-commit");
  const marker = "#!/bin/sh\n# Recurse Artifact: commit = publish.\n";
  const hook = `${marker}if [ "$RECURSE_ARTIFACT_COMMIT" != 1 ]; then\n  exec ${quote(process.execPath)} ${quote(join(CHECKOUT_ROOT, "src/artifacts/publish_commit.ts"))} .\nfi\n`;
  const current = await readFile(path, "utf8").catch((error) => {
    if (isMissing(error)) return "";
    throw error;
  });
  if (current === hook) return;
  if (current && !current.startsWith(marker))
    throw new ArtifactConflict(
      "Artifact post-commit hook already exists; preserve it before enabling automatic publication",
    );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hook, { mode: 0o700 });
  await chmod(path, 0o700);
  await git(ctx, repo, ["config", "core.hooksPath", ".git/hooks"]);
  await excludeInstalls(repo);
}

/** Installed packages are build input, never Artifact history. */
export async function excludeInstalls(repo: string): Promise<void> {
  const path = join(repo, ".git", "info", "exclude");
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split("\n").includes("node_modules/")) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${text.replace(/\n?$/u, "\n")}node_modules/\n`);
}
