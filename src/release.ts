// The one source of Recurse's release identity: package.json's version plus,
// when this file runs from a Git checkout, the short commit. `recurse
// --version`, /api/version's `release` and Settings all read it from here.
import { join } from "node:path";
import { stat } from "node:fs/promises";

const ROOT = join(import.meta.dir, "..");

export interface Release {
  /** package.json's version, for example "0.1.0". */
  readonly version: string;
  /** The checkout's short commit, or null outside a Git checkout. */
  readonly commit: string | null;
}

async function shortCommit(root: string): Promise<string | null> {
  if (!(await stat(join(root, ".git")).catch(() => null))) return null;
  const git = Bun.spawn(["git", "-C", root, "rev-parse", "--short", "HEAD"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([
    new Response(git.stdout).text(),
    git.exited,
  ]);
  return code === 0 && out.trim() ? out.trim() : null;
}

/** Read the release of the checkout at `root` (default: this one). A missing
 * or unreadable package.json gives the version "unknown", never an error. */
export async function readRelease(root: string = ROOT): Promise<Release> {
  const pkg = (await Bun.file(join(root, "package.json"))
    .json()
    .catch(() => null)) as { version?: unknown } | null;
  const version = typeof pkg?.version === "string" ? pkg.version : "unknown";
  return { version, commit: await shortCommit(root) };
}

/** "0.1.0 (abc1234)", or "0.1.0" without a commit. */
export function releaseLabel(release: Release): string {
  return release.commit
    ? `${release.version} (${release.commit})`
    : release.version;
}

/** The `recurse --version` line, for example "recurse 0.1.0 (abc1234)". */
export async function versionLine(root: string = ROOT): Promise<string> {
  return `recurse ${releaseLabel(await readRelease(root))}\n`;
}

if (import.meta.main) process.stdout.write(await versionLine());
