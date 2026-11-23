// Artifact versions are immutable refs; publication updates its ref by compare-and-set.
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as startupMetrics from "../../observability";
import {
  GIT_EMAIL,
  GIT_NAME,
  GIT_OUTPUT_MAX,
  decode,
  decodeStrict,
  git,
  spawnGit,
  type GitResult,
} from "./git";
import {
  ArtifactConflict,
  ArtifactCorrupt,
  ArtifactInvalid,
  ArtifactLimit,
  FULL_SHA_RE,
  normalizedTitle,
  safeRel,
  type ResolvedContext,
} from "./layout";

export const GIT_REF = "refs/recurse/published";
const GIT_VERSIONS = "refs/recurse/versions/";
/** refs/recurse/builds/<version> names the built app page blob of a version. */
export const GIT_BUILDS = "refs/recurse/builds/";
const CREATE_REF_ATTEMPTS = 20;
const GIT_TREE_MAX = 4 * 1024 * 1024;
export const HISTORY_MAX = 100;
const MAX_ENTRIES = 10_000;
const NULL_SHA = "0".repeat(40);
export const TITLE_CONFIG_KEY = "recurse.title";
export type TreeRow = readonly [name: string, sha: string];

export async function initRepo(
  ctx: ResolvedContext,
  repo: string,
): Promise<void> {
  try {
    await mkdir(repo, { mode: 0o700, recursive: true });
  } catch {
    throw new ArtifactCorrupt("artifact repository could not be created");
  }
  let result: GitResult;
  try {
    result = await spawnGit(ctx, ["init", "--quiet", repo]);
  } catch {
    throw new ArtifactCorrupt("artifact repository could not be created");
  }
  if (result.returncode !== 0) {
    throw new ArtifactCorrupt("artifact repository could not be created");
  }
  for (const [key, value] of [
    ["user.name", GIT_NAME],
    ["user.email", GIT_EMAIL],
    ["core.logAllRefUpdates", "true"],
  ] as const) {
    await git(ctx, repo, ["config", key, value]);
  }
  await chmod(repo, 0o700);
}

export async function head(
  ctx: ResolvedContext,
  repo: string,
): Promise<string | null> {
  const result = await git(ctx, repo, ["rev-parse", "--verify", "HEAD"], {
    check: false,
  });
  const value = decode(result.stdout).trim();
  if (result.returncode !== 0 || !FULL_SHA_RE.test(value)) return null;
  return value;
}

export async function published(
  ctx: ResolvedContext,
  repo: string,
  required = true,
): Promise<string | null> {
  try {
    const gitInfo = await stat(join(repo, ".git"));
    if (!gitInfo.isDirectory()) throw new Error("not a Git directory");
  } catch {
    if (required)
      throw new ArtifactCorrupt("artifact repository has no Git metadata");
    return null;
  }
  const result = await git(
    ctx,
    repo,
    ["rev-parse", "--verify", `${GIT_REF}^{commit}`],
    { check: false },
  );
  const value = decode(result.stdout).trim();
  if (result.returncode !== 0) {
    if (required)
      throw new ArtifactCorrupt("artifact has no published version");
    return null;
  }
  if (!FULL_SHA_RE.test(value))
    throw new ArtifactCorrupt("artifact published ref is invalid");
  return value;
}

export async function commit(
  ctx: ResolvedContext,
  repo: string,
  message: string,
): Promise<string | null> {
  const status = await git(
    ctx,
    repo,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { limit: GIT_TREE_MAX },
  );
  if (!status.stdout.byteLength) return head(ctx, repo);
  try {
    await git(ctx, repo, ["add", "--all"]);
    const result = await git(ctx, repo, ["commit", "--quiet", "-m", message], {
      check: false,
      env: { RECURSE_ARTIFACT_COMMIT: "1" },
    });
    if (result.returncode !== 0) {
      if (decode(result.stderr).includes("index.lock")) {
        throw new ArtifactConflict(
          "artifact is being modified; refresh and retry",
        );
      }
      throw new ArtifactCorrupt("artifact workspace commit failed");
    }
  } catch (error) {
    if (error instanceof ArtifactCorrupt) {
      try {
        await lstat(join(repo, ".git", "index.lock"));
        throw new ArtifactConflict(
          "artifact is being modified; refresh and retry",
        );
      } catch (inner) {
        if (inner instanceof ArtifactConflict) throw inner;
      }
    }
    throw error;
  }
  return head(ctx, repo);
}

export async function tree(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
): Promise<TreeRow[]> {
  const result = await git(
    ctx,
    repo,
    ["ls-tree", "-r", "-z", "--full-tree", sha],
    { limit: GIT_TREE_MAX },
  );
  const rows: TreeRow[] = [];
  let output: string;
  try {
    output = decodeStrict(result.stdout);
  } catch {
    throw new ArtifactCorrupt("artifact Git tree is invalid");
  }
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0)
      throw new ArtifactCorrupt("artifact Git tree is invalid");
    const headText = record.slice(0, separator);
    const name = record.slice(separator + 1);
    const [mode, kind, shaValue] = headText.split(" ");
    if (
      !mode ||
      !kind ||
      !shaValue ||
      !["100644", "100755"].includes(mode) ||
      kind !== "blob" ||
      !FULL_SHA_RE.test(shaValue)
    ) {
      throw new ArtifactInvalid(
        "artifact tree contains a symlink or submodule",
      );
    }
    if (name !== ".artifact.json") safeRel(name);
    rows.push([name, shaValue]);
    if (rows.length > MAX_ENTRIES)
      throw new ArtifactLimit("artifact contains too many files");
  }
  return rows;
}

export async function blob(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
  limit: number,
): Promise<Buffer> {
  const result = await git(ctx, repo, ["cat-file", "blob", sha], {
    limit: limit + 1,
  });
  if (result.stdout.byteLength > limit)
    throw new ArtifactLimit("artifact file is too large");
  return Buffer.from(result.stdout);
}

export async function resolveVersion(
  ctx: ResolvedContext,
  repo: string,
  version: string,
): Promise<string> {
  if (typeof version !== "string" || !FULL_SHA_RE.test(version)) {
    throw new ArtifactInvalid("version must be a full immutable SHA");
  }
  const result = await git(
    ctx,
    repo,
    ["rev-parse", "--verify", `${GIT_VERSIONS}${version}^{commit}`],
    { check: false },
  );
  if (result.returncode !== 0 || decode(result.stdout).trim() !== version) {
    throw new ArtifactInvalid("unknown artifact version");
  }
  return version;
}

export function expectVersion(
  actual: string | null,
  expected: string | null | undefined,
): void {
  if (expected === null || expected === undefined) return;
  if (typeof expected !== "string" || !FULL_SHA_RE.test(expected)) {
    throw new ArtifactInvalid("expected version must be a full immutable SHA");
  }
  if (actual !== expected) {
    throw new ArtifactConflict(
      "artifact changed; refresh and retry with the current version",
    );
  }
}

// Create an immutable ref; a race refusal succeeds if the ref appears
// after a brief bounded retry while the other publisher finishes.
export async function createRef(
  ctx: ResolvedContext,
  repo: string,
  ref: string,
  sha: string,
  recorded: () => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < CREATE_REF_ATTEMPTS; attempt += 1) {
    if (attempt) await Bun.sleep(50);
    const created = await git(
      ctx,
      repo,
      ["update-ref", "--no-deref", ref, sha, NULL_SHA],
      { check: false },
    );
    if (created.returncode === 0 || (await recorded())) return true;
  }
  return false;
}

export async function publishRef(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
  expected?: string | null,
): Promise<void> {
  const old = await published(ctx, repo, false);
  if (expected !== undefined) expectVersion(old, expected);
  if (old === sha) return;
  const versionRef = `${GIT_VERSIONS}${sha}`;
  const recorded = () =>
    git(ctx, repo, ["rev-parse", "--verify", `${versionRef}^{commit}`], {
      check: false,
    }).then((result) => result.returncode === 0);
  if (
    !(await recorded()) &&
    !(await createRef(ctx, repo, versionRef, sha, recorded))
  )
    throw new ArtifactCorrupt("artifact version ref could not be recorded");
  const result = await git(
    ctx,
    repo,
    ["update-ref", "--no-deref", GIT_REF, sha, old ?? NULL_SHA],
    { check: false },
  );
  if (result.returncode !== 0) {
    throw new ArtifactConflict(
      "artifact changed; refresh and retry with the current version",
    );
  }
}

// Git runs with TZ=UTC. Git 2.55 prints that zero offset as "Z" in strict ISO
// dates and Git 2.39 as "+00:00"; always report "+00:00".
function isoStrictDate(date: string): string {
  return date.endsWith("Z") ? `${date.slice(0, -1)}+00:00` : date;
}

export async function commitDate(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
): Promise<string> {
  const result = await git(ctx, repo, ["show", "-s", "--format=%cI", sha], {
    check: false,
  });
  return result.returncode === 0
    ? isoStrictDate(decode(result.stdout).trim())
    : "";
}

export async function oldestVersionDate(
  ctx: ResolvedContext,
  repo: string,
): Promise<string> {
  startupMetrics.count("artifact_history_lookups");
  const result = await git(
    ctx,
    repo,
    [
      "for-each-ref",
      "--sort=creatordate",
      "--count=1",
      "--format=%(creatordate:iso-strict)",
      GIT_VERSIONS,
    ],
    { check: false },
  );
  return result.returncode === 0
    ? isoStrictDate(decode(result.stdout).trim())
    : "";
}

export async function repoTitle(
  ctx: ResolvedContext,
  repo: string,
  artifactId: string,
): Promise<string> {
  const result = await git(ctx, repo, ["config", "--get", TITLE_CONFIG_KEY], {
    check: false,
  });
  const value = decode(result.stdout);
  try {
    return normalizedTitle(value);
  } catch {
    return artifactId;
  }
}

export async function versionMetadata(
  ctx: ResolvedContext,
  repo: string,
): Promise<Record<string, readonly [string, string]>> {
  const result = await git(
    ctx,
    repo,
    [
      "for-each-ref",
      "--format=%(refname)%00%(committerdate:iso-strict)%00%(subject)%00",
      "--sort=-creatordate",
      `--count=${HISTORY_MAX}`,
      GIT_VERSIONS,
    ],
    { limit: GIT_OUTPUT_MAX },
  );
  const fields = decode(result.stdout).split("\0");
  const metadata: Record<string, readonly [string, string]> = {};
  for (let index = 0; index < fields.length - 2; index += 3) {
    const version = fields[index]!.trim().split("/").at(-1) ?? "";
    if (FULL_SHA_RE.test(version)) {
      metadata[version] = [
        isoStrictDate(fields[index + 1]!),
        fields[index + 2]!,
      ];
    }
  }
  return metadata;
}
