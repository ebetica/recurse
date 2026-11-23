// Serialize repository directory admission against owner retirement.
// Git and moves to trash run outside the lock.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { flockExclusive, procStat } from "../../utils";
import { retirePath } from "../../utils/trash-sweep";
import {
  ArtifactConflict,
  ArtifactCorrupt,
  ArtifactNotFound,
  DIRECTORY_FLAGS,
  MAX_MARKER_BYTES,
  context,
  isMissing,
  isObject,
  normalizedOwner,
  ownedBytes,
  ownerRoot,
  pathExists,
  readFileBounded,
  writeFileAtomic,
  type ArtifactContext,
  type ResolvedContext,
} from "./layout";

const RETIRING_PREFIX = ".retiring-owner-";

function retiringOwner(ctx: ResolvedContext, owner: string): string {
  return join(
    ctx.artifactsDir,
    RETIRING_PREFIX + createHash("sha256").update(owner).digest("hex"),
  );
}

async function ownerAdmission<T>(
  ctx: ResolvedContext,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(ctx.artifactsDir, { recursive: true });
  const handle = await open(
    ctx.artifactsDir,
    DIRECTORY_FLAGS | fsConstants.O_NOFOLLOW,
  );
  try {
    const unlock = await flockExclusive(
      handle.fd,
      `${ctx.artifactsDir}:artifact-owner-admission`,
    );
    try {
      return await work();
    } finally {
      unlock();
    }
  } finally {
    await handle.close();
  }
}

export function createRepositoryDirectory(
  ctx: ResolvedContext,
  owner: string,
  artifactId: string,
): Promise<string> {
  return ownerAdmission(ctx, async () => {
    if (await pathExists(retiringOwner(ctx, owner)))
      throw new ArtifactConflict(
        "artifact owner cleanup is pending; retry after cleanup",
      );
    const root = await ownerRoot(ctx, owner, true);
    const candidate = join(root, artifactId);
    await mkdir(candidate, { mode: 0o700 });
    return candidate;
  });
}

async function disposableOwner(root: string, files: boolean): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.every(
    (entry) =>
      entry.isFile() &&
      (files
        ? !entry.name.startsWith(".deleted-") && entry.name !== ".git"
        : entry.name === ".revision"),
  );
}

async function retireOwner(
  ctx: ResolvedContext,
  owner: string,
  files: boolean,
): Promise<boolean> {
  const root = join(ctx.artifactsDir, owner);
  const marker = retiringOwner(ctx, owner);
  const admitted = await ownerAdmission(ctx, async () => {
    if (await pathExists(marker)) return false;
    let info: Stats;
    try {
      info = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!info.isDirectory() || !(await disposableOwner(root, files)))
      return false;
    const current = await procStat(process.pid);
    if (current.state !== "ok")
      throw new ArtifactCorrupt(
        "artifact cleanup process identity unavailable",
      );
    await writeFileAtomic(
      ctx,
      marker,
      ownedBytes(
        Buffer.from(
          JSON.stringify({
            owner,
            identity: `${info.dev}:${info.ino}`,
            files,
            pid: current.stat.pid,
            start: current.stat.startTime,
          }),
        ),
      ),
    );
    return true;
  });
  if (!admitted) return false;
  const retired = await retirePath(root, ctx.trashDir);
  await unlink(marker);
  return retired;
}

/** Recover interrupted retirements without stealing a live cleanup's fence. */
export async function recoverArtifactDirectories(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  for (const name of await readdir(ctx.artifactsDir)) {
    if (!name.startsWith(RETIRING_PREFIX)) continue;
    const marker = join(ctx.artifactsDir, name);
    const root = await ownerAdmission(ctx, async () => {
      let saved: unknown;
      try {
        saved = JSON.parse(
          (await readFileBounded(marker, MAX_MARKER_BYTES)).toString("utf8"),
        );
      } catch (error) {
        if (error instanceof ArtifactNotFound) return null;
        throw error;
      }
      if (
        !isObject(saved) ||
        typeof saved.owner !== "string" ||
        !saved.owner ||
        saved.owner !== basename(saved.owner) ||
        saved.owner.startsWith(".") ||
        retiringOwner(ctx, saved.owner) !== marker ||
        typeof saved.pid !== "number"
      )
        throw new ArtifactCorrupt("artifact cleanup marker is invalid");
      const ownerProcess = await procStat(saved.pid);
      if (
        ownerProcess.state === "ok" &&
        ownerProcess.stat.startTime === saved.start
      )
        return null;
      if (ownerProcess.state !== "ok" && ownerProcess.state !== "dead")
        return null;
      const candidate = join(ctx.artifactsDir, saved.owner);
      const info = await lstat(candidate).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (
        !info ||
        !info.isDirectory() ||
        `${info.dev}:${info.ino}` !== saved.identity ||
        !(await disposableOwner(candidate, saved.files === true))
      ) {
        await unlink(marker);
        return null;
      }
      const current = await procStat(process.pid);
      if (current.state !== "ok")
        throw new ArtifactCorrupt(
          "artifact cleanup process identity unavailable",
        );
      await writeFileAtomic(
        ctx,
        marker,
        ownedBytes(
          Buffer.from(
            JSON.stringify({
              ...saved,
              pid: current.stat.pid,
              start: current.stat.startTime,
            }),
          ),
        ),
      );
      return candidate;
    });
    if (root) {
      await retirePath(root, ctx.trashDir);
      await unlink(marker);
    }
  }
}

/** Retire an owner only when it has no repository or deletion receipts. */
export async function pruneEmptyOwner(
  value: ArtifactContext,
  ownerValue: string,
): Promise<boolean> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  return retireOwner(ctx, owner, false);
}

/** Retire legacy empty/non-repository roots once; preserve uncertain trees. */
export async function migrateArtifactDirectories(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  const marker = join(ctx.artifactsDir, ".owner-directories-v1");
  if (await pathExists(marker)) return;
  let retired = 0;
  let skippedReceipts = 0;
  let skippedDirectories = 0;
  for (const entry of await readdir(ctx.artifactsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(ctx.artifactsDir, entry.name);
    const children = await readdir(root, { withFileTypes: true });
    if (children.some((child) => child.name.startsWith(".deleted-"))) {
      skippedReceipts++;
      continue;
    }
    // Invariant: Any nested directory or Git marker may contain a valid repo.
    if (children.some((child) => !child.isFile() || child.name === ".git")) {
      skippedDirectories++;
      continue;
    }
    if (await retireOwner(ctx, entry.name, true)) retired++;
  }
  await writeFileAtomic(
    ctx,
    marker,
    ownedBytes(
      Buffer.from(
        JSON.stringify({ retired, skippedReceipts, skippedDirectories }),
      ),
    ),
  );
}
