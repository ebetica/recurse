/**
 * usage: worktree.ts [--root <data-dir>] [--agent <id>] enter <name>
 *        worktree.ts [--root <data-dir>] sweep
 *
 * Create an agent-held checkout without waiting for cleanup. Managed Recurse
 * checkouts get private local dependency directories automatically. Re-enter
 * your own checkout to restore dependencies after restart. Retire checkouts
 * without live holders or live agent workdirs, including those with no holder
 * record, in a detached, single-instance sweep launched by enter, subagent
 * create --worktree, and subagent rm. Failed or incomplete live-agent lookup
 * retains all checkouts. Uncommitted changes do not protect unheld checkouts.
 * The sweep does not unlock or prune Git admin metadata. Make baseline checkouts
 * through enter or in $RECURSE_AGENT_TMPDIR, never manually in worktrees/.
 */
// Managed entry writes holders; cleanup requires complete membership.
// Dependency preparation and lifecycle utilities remain dependency-free.
// The server subprocess only claims holders; CLI sweeps own cleanup.
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { toolHelp } from "./_help.ts";
import { retire, sweep } from "../src/utils/trash.ts";
import {
  dependencyPaths,
  managedDependencyRoot,
  prepareManagedDependencies,
} from "../src/local_dependencies.ts";

const MODULE_HELP = toolHelp(import.meta.url);

const VERSION = 1;
const UNKNOWN = "UNKNOWN";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED = new Set([
  "CUTOVER",
  "TO_REAP",
  ".trash",
  ".managed",
  ".markers",
]);

export interface Root {
  dataDir: string;
  worktrees: string;
  markers: string;
  trash: string;
  repoDir: string;
}

export interface MembershipConfig {
  baseUrl: string;
  token: string;
  endpoint: string;
  timeout: number;
}

export type MembershipSnapshot = [
  number,
  Set<string> | typeof UNKNOWN,
  boolean,
  Set<string>?,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function unlinkMissingOk(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isOperationalError(error) || error.code !== "ENOENT") throw error;
  }
}

function exceptionText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOperationalError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function pythonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "boolean" && typeof right === "number") {
    return Number(left) === right;
  }
  if (typeof right === "boolean" && typeof left === "number") {
    return left === Number(right);
  }
  return false;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJsonKeys(record[key])]),
  );
}

function pythonJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value)).replace(
    /[\u007f-\uffff]/g,
    (char) => {
      const code = char.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, "0")}`;
    },
  );
}

// Resolve data paths from --root, WORKTREE_ROOT or CHAT_DATA_DIR.
export function rootFromEnv(explicit?: string | null): Root {
  const configured = process.env.WORKTREE_ROOT || process.env.CHAT_DATA_DIR;
  const dataDir =
    explicit ?? (configured || join(process.cwd(), ".recurse-data"));
  const worktrees = join(dataDir, "worktrees");
  return {
    dataDir,
    worktrees,
    markers: join(worktrees, ".markers"),
    trash: join(worktrees, ".trash"),
    repoDir: join(dataDir, "repo"),
  };
}

/** Return the current agent identifier, if supplied. */
export function selfId(): string | null {
  return process.env.RECURSE_AGENT_ID ?? null;
}

/** Return a valid managed worktree directory name, or null. */
export function validName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    RESERVED.has(value) ||
    !NAME_RE.test(value) ||
    value.match(NAME_RE)?.[0] !== value
  ) {
    return null;
  }
  return value;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1)}.${process.pid}.tmp`,
  );
  writeFileSync(tmp, pythonJson(value), "utf8");
  renameSync(tmp, path);
}

/** Return a valid marker record for a managed worktree. */
export function markerRecord(
  root: Root,
  name: string,
): Record<string, unknown> | null {
  if (validName(name) === null) return null;
  const value = readJson(join(root.markers, `${name}.json`));
  if (
    value === null ||
    !pythonEqual(value.version, VERSION) ||
    value.name !== name ||
    value.path !== join(root.worktrees, name) ||
    asRecord(value.holders) === null
  ) {
    return null;
  }
  return value;
}

function writeRecord(
  root: Root,
  name: string,
  holders: Record<string, unknown>,
  creating?: unknown,
): void {
  writeJson(join(root.markers, `${name}.json`), {
    version: VERSION,
    name,
    path: join(root.worktrees, name),
    holders,
    ...(creating ? { creating } : {}),
  });
}

/** Remove one agent's worktree holder; an absent holder is already removed. */
export function removeHolder(root: Root, name: string, cid: string): boolean {
  const record = markerRecord(root, name);
  if (record === null) return false;
  const holders = Object.assign(
    Object.create(null) as Record<string, unknown>,
    asRecord(record.holders) ?? {},
  );
  if (!Object.hasOwn(holders, cid)) return true;
  delete holders[cid];
  try {
    const creating = asRecord(record.creating);
    writeRecord(
      root,
      name,
      holders,
      creating?.cid === cid ? undefined : creating,
    );
  } catch (error) {
    if (isOperationalError(error)) return false;
    throw error;
  }
  return true;
}

function strictRealpath(path: string): string {
  return realpathSync(path);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}

/** Return the managed checkout containing path, or null. */
export function managedRoot(root: Root, path: string): string | null {
  let relativeToWorktrees: string;
  let resolvedPath: string;
  let resolvedWorktrees: string;
  try {
    resolvedPath = strictRealpath(path);
    resolvedWorktrees = strictRealpath(root.worktrees);
    if (!isWithin(resolvedWorktrees, resolvedPath)) return null;
    relativeToWorktrees = relative(resolvedWorktrees, resolvedPath);
  } catch {
    return null;
  }
  const first = relativeToWorktrees.split(/[\\/]/)[0];
  if (first === undefined || validName(first) === null) return null;
  const checkout = join(root.worktrees, first);
  if (markerRecord(root, first) === null || !isDirectory(checkout)) return null;
  try {
    if (
      !isWithin(strictRealpath(checkout), resolvedPath) &&
      strictRealpath(checkout) !== resolvedPath
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return checkout;
}

interface GitResult {
  stdout: string;
  returncode: number;
}

function git(
  args: readonly string[],
  cwd: string,
  timeout: number | null = 120_000,
): GitResult | null {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    const options = {
      cwd,
      encoding: "utf8" as const,
      env,
      windowsHide: true,
      ...(timeout === null ? {} : { timeout }),
    };
    const result = spawnSync("git", ["--no-replace-objects", ...args], options);
    if (result.error !== undefined || result.status === null) return null;
    return { stdout: result.stdout ?? "", returncode: result.status };
  } catch {
    return null;
  }
}

/** Accept only an exact, real, non-bare Git checkout root. */
export function resolveWorktreeSource(source: string): string {
  if (!isAbsolute(source) || !isDirectory(source) || isSymlink(source)) {
    throw new Error("Worktree source must be an exact real directory.");
  }
  let resolved: string;
  try {
    resolved = strictRealpath(source);
  } catch {
    throw new Error("Worktree source must be an exact real directory.");
  }
  if (resolve(source) !== resolved) {
    throw new Error("Worktree source must be an exact real directory.");
  }
  const top = git(["rev-parse", "--show-toplevel"], source, 10_000);
  if (
    top === null ||
    top.returncode !== 0 ||
    resolve(top.stdout.trim()) !== resolved
  ) {
    throw new Error("Worktree source must be the exact checkout root.");
  }
  const bare = git(["rev-parse", "--is-bare-repository"], source, 10_000);
  if (bare === null || bare.returncode !== 0 || bare.stdout.trim() === "true") {
    throw new Error("Worktree source must be a non-bare Git checkout root.");
  }
  return resolved;
}

// Refresh remote-tracking refs before resolving explicit start points.
function worktreeCommit(source: string, ref: string): string {
  const symbolic = git(
    ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref],
    source,
    10_000,
  );
  const fullRef = symbolic?.returncode === 0 ? symbolic.stdout.trim() : ref;
  const remoteBranch = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(fullRef);
  if (remoteBranch) {
    const [, remote, branch] = remoteBranch;
    // Invariant: Refresh the exact ref even if the remote fetch mapping
    // excludes it.
    const fetched = git(
      [
        "fetch",
        "--",
        remote!,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ],
      source,
      30_000,
    );
    if (fetched === null || fetched.returncode !== 0)
      throw new Error(
        `Could not fetch --commit '${ref}'; check remote '${remote}' and branch '${branch}', then retry.`,
      );
  }
  const commit = git(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    source,
    10_000,
  );
  if (commit === null || commit.returncode !== 0 || !commit.stdout.trim())
    throw new Error(
      `--commit '${ref}' does not resolve to a commit; choose an existing commit or branch in the source repository.`,
    );
  return commit.stdout.trim();
}

// Reserve before Git starts; create with the requesting agent as holder.
export async function ensureNamedWorktree(
  root: Root,
  cid: string,
  name: string,
  current?: string,
  options: { source?: string; commit?: string; creating?: boolean } = {},
): Promise<string | null> {
  void (current ?? process.env.RECURSE_WORKDIR ?? process.cwd());
  if (validName(name) === null || typeof cid !== "string" || !cid) return null;
  let origin: string;
  try {
    origin = resolveWorktreeSource(options.source ?? root.repoDir);
  } catch {
    return null;
  }
  const checkout = join(root.worktrees, name);
  if (
    exists(checkout) ||
    isSymlink(checkout) ||
    exists(join(root.markers, `${name}.json`))
  ) {
    return null;
  }
  const commit =
    options.commit === undefined
      ? "HEAD"
      : worktreeCommit(origin, options.commit);
  try {
    const reserved = await withCleanerLock(
      root,
      () => {
        if (
          exists(checkout) ||
          isSymlink(checkout) ||
          exists(join(root.markers, `${name}.json`))
        )
          return false;
        writeRecord(
          root,
          name,
          { [cid]: Date.now() / 1000 },
          { cid, pid: process.pid },
        );
        return true;
      },
      5_000,
    );
    if (!reserved) return null;
  } catch (error) {
    process.stderr.write(
      `worktree ${name}: creation reservation failed: ${exceptionText(error)}\n`,
    );
    return null;
  }
  git(["worktree", "prune"], origin);
  const created = git(
    ["worktree", "add", "--detach", checkout, commit],
    origin,
    null,
  );
  if (created === null || created.returncode !== 0 || !isDirectory(checkout)) {
    git(["worktree", "unlock", checkout], origin);
    try {
      retire(checkout, root.trash);
    } catch (error) {
      process.stderr.write(
        `worktree ${name}: failed checkout retirement failed: ${exceptionText(error)}\n`,
      );
    }
    try {
      unlinkMissingOk(join(root.markers, `${name}.json`));
    } catch {}
    return null;
  }
  try {
    const dependencyRoot = await managedDependencyRoot(checkout);
    if (dependencyRoot !== null)
      await prepareManagedDependencies(checkout, dependencyRoot);
    if (!options.creating) {
      const held = await addHolder(root, checkout, cid);
      if (held !== "held") throw new Error("checkout retired during creation");
    }
    return checkout;
  } finally {
    startSweep(root);
  }
}

// Fold the pre-single-file .managed layout into marker JSON files.
function migrateLegacyEntry(root: Root, name: string): void {
  const legacy = join(root.worktrees, ".managed");
  if (isSymlink(legacy)) return;
  const entry = join(legacy, name);
  if (validName(name) === null || !isDirectory(entry) || isSymlink(entry))
    return;
  if (!exists(join(root.markers, `${name}.json`))) {
    const holders = Object.create(null) as Record<string, number>;
    const box = join(entry, "HOLDERS");
    if (isSymlink(box))
      throw new Error("cannot migrate symlinked legacy holders");
    if (isDirectory(box)) {
      for (const leaf of readdirSync(box)) {
        if (extname(leaf) !== ".json") continue;
        holders[leaf.slice(0, -5)] = statSync(join(box, leaf)).mtimeMs / 1000;
      }
    }
    writeRecord(root, name, holders);
  }
  retire(entry, root.trash);
}

async function migrateLegacy(root: Root): Promise<void> {
  const legacy = join(root.worktrees, ".managed");
  if (!isDirectory(legacy) || isSymlink(legacy)) return;
  for (const name of readdirSync(legacy)) {
    await withCleanerLock(root, () => migrateLegacyEntry(root, name));
  }
  try {
    rmdirSync(legacy);
  } catch {}
}

// Read membership from env or the published server file.
export function membershipFromEnv(root: Root): MembershipConfig | null {
  const baseUrl = process.env.WORKTREE_MEMBERSHIP_URL;
  const token = process.env.WORKTREE_MEMBERSHIP_TOKEN;
  if (baseUrl && token) {
    return {
      baseUrl,
      token,
      endpoint: "/api/subagent-tool/conversations",
      timeout: 10,
    };
  }
  try {
    const published = JSON.parse(
      readFileSync(join(root.dataDir, "server.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      !Object.hasOwn(published, "port") ||
      !Object.hasOwn(published, "token")
    ) {
      return null;
    }
    const port = pythonInt(published.port);
    const publishedToken = pythonString(published.token);
    if (!publishedToken || !(port > 0 && port < 65536)) return null;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      token: publishedToken,
      endpoint: "/api/subagent-tool/conversations",
      timeout: 10,
    };
  } catch {
    return null;
  }
}

function pythonInt(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?[0-9]+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("invalid integer");
}

function pythonString(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "object")
    return Array.isArray(value) ? "[object Object]" : "[object Object]";
  return String(value);
}

// Fetch live ids; unsafe/incomplete membership retains all holders.
export async function getLiveAgentIds(
  config: MembershipConfig,
): Promise<MembershipSnapshot> {
  const observedAt = Date.now() / 1000;
  let base: NodeURL;
  try {
    base = new NodeURL(config.baseUrl);
  } catch {
    return [observedAt, UNKNOWN, false];
  }
  const hostname = base.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    return [observedAt, UNKNOWN, false];
  }
  if (
    typeof config.timeout !== "number" ||
    !(config.timeout > 0 && config.timeout <= 120)
  ) {
    return [observedAt, UNKNOWN, false];
  }
  let payload: unknown;
  try {
    const url = new NodeURL(config.endpoint, `${base.protocol}//${base.host}`);
    const endpointHostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(endpointHostname)) {
      return [observedAt, UNKNOWN, false];
    }
    const response = await fetch(url.toString(), {
      headers: { "x-loopback-token": config.token },
      signal: AbortSignal.timeout(config.timeout * 1000),
    });
    if (response.status !== 200) return [observedAt, UNKNOWN, false];
    payload = await response.json();
  } catch {
    return [observedAt, UNKNOWN, false];
  }
  const snapshot = asRecord(payload);
  if (
    snapshot === null ||
    snapshot.complete !== true ||
    !Array.isArray(snapshot.conversations)
  ) {
    return [observedAt, UNKNOWN, false];
  }
  const ids = new Set<string>();
  const workdirs = new Set<string>();
  for (const entry of snapshot.conversations) {
    const conversation = asRecord(entry);
    if (conversation === null || typeof conversation.id !== "string") {
      return [observedAt, UNKNOWN, false];
    }
    ids.add(conversation.id);
    if (typeof conversation.workdir === "string")
      workdirs.add(conversation.workdir);
  }
  return [observedAt, ids, true, workdirs];
}

function deleteCheckout(root: Root, name: string): boolean {
  const checkout = join(root.worktrees, name);
  try {
    if (isDirectory(checkout) && !isSymlink(checkout))
      retire(checkout, root.trash);
    const local = dependencyPaths(root.dataDir, checkout);
    retire(local.install, local.trash);
    retire(local.staging, local.trash);
  } catch (error) {
    process.stderr.write(
      `worktree ${name}: cannot move to trash: ${exceptionText(error)}\n`,
    );
    sweepLog(root, `cannot retire ${name}: ${exceptionText(error)}`);
    return false;
  }
  unlinkMissingOk(join(root.markers, `${name}.json`));
  return true;
}

/** Retire absent holders; protect live users and in-progress creation. */
export function reapOne(
  root: Root,
  name: string,
  liveIds: Set<string>,
  observedAt = Infinity,
  protectedNames = new Set<string>(),
  releasedIds = new Set<string>(),
): boolean {
  if (validName(name) === null) return false;
  const checkout = join(root.worktrees, name);
  const record = markerRecord(root, name);
  const holders = Object.assign(
    Object.create(null) as Record<string, unknown>,
    asRecord(record?.holders) ?? {},
  );
  const creating = asRecord(record?.creating);
  if (!exists(checkout)) {
    if (
      typeof creating?.pid === "number" &&
      pidAlive(creating.pid) &&
      (!releasedIds.has(String(creating.cid)) ||
        (typeof holders[String(creating.cid)] === "number" &&
          Number(holders[String(creating.cid)]) >= observedAt))
    )
      return false;
    return (
      exists(join(root.markers, `${name}.json`)) && deleteCheckout(root, name)
    );
  }
  const kept = Object.create(null) as Record<string, unknown>;
  for (const [cid, updated] of Object.entries(holders)) {
    if (
      releasedIds.has(cid) &&
      !(typeof updated === "number" && updated >= observedAt)
    )
      continue;
    if (
      liveIds.has(cid) ||
      (typeof updated === "number" && updated >= observedAt) ||
      (creating?.cid === cid &&
        typeof creating.pid === "number" &&
        pidAlive(creating.pid))
    )
      kept[cid] = updated;
  }
  if (Object.keys(kept).length > 0 || protectedNames.has(name)) {
    if (JSON.stringify(kept) !== JSON.stringify(holders)) {
      try {
        writeRecord(
          root,
          name,
          kept,
          creating &&
            Object.hasOwn(kept, String(creating.cid)) &&
            !liveIds.has(String(creating.cid))
            ? creating
            : undefined,
        );
      } catch (error) {
        if (isOperationalError(error)) return false;
        throw error;
      }
    }
    return false;
  }
  return deleteCheckout(root, name);
}

/** Claim an existing checkout before admission; lock against retirement. */
export async function addHolder(
  root: Root,
  path: string,
  cid: string,
): Promise<string> {
  return withCleanerLock(
    root,
    () => {
      if (isDirectory(path) && isDirectory(root.worktrees)) {
        const parent = strictRealpath(root.worktrees);
        const resolved = strictRealpath(path);
        if (isWithin(parent, resolved)) {
          const name = relative(parent, resolved).split(/[\\/]/)[0]!;
          migrateLegacyEntry(root, name);
        }
      }
      const checkout = managedRoot(root, path);
      if (!checkout) {
        return !isDirectory(path) &&
          isWithin(resolve(root.worktrees), resolve(path))
          ? "missing"
          : "unmanaged";
      }
      const name = checkout.split(/[\\/]/).at(-1)!;
      const record = markerRecord(root, name);
      if (!record) return "unmanaged";
      writeRecord(
        root,
        name,
        { ...asRecord(record.holders), [cid]: Date.now() / 1000 },
        asRecord(record.creating)?.cid === cid ? undefined : record.creating,
      );
      return "held";
    },
    5_000,
  );
}

/** Reclaim one entry, first migrating one pre-utility name-PID trash entry. */
export function reclaimWorktreeTrash(root: Root): number {
  if (!isDirectory(root.trash) || isSymlink(root.trash)) return 0;
  for (const name of readdirSync(root.trash)) {
    if (/^[0-9a-f]{32}$/.test(name)) continue;
    retire(join(root.trash, name), root.trash);
    break;
  }
  return sweep(root.trash, 1);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!isOperationalError(error)) return false;
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return false;
  }
  return true;
}

/** Exclude holder claims and retirement; killed processes release the lock. */
export async function withCleanerLock<T>(
  root: Root,
  fn: () => T | Promise<T>,
  timeoutMs = 0,
  lockName = ".cleaner.lock",
): Promise<T> {
  const { flockExclusive } = await import("../src/utils/flock");
  mkdirSync(root.markers, { recursive: true, mode: 0o700 });
  const path = join(root.markers, lockName);
  const fd = openSync(path, "a", 0o600);
  try {
    const unlock = await flockExclusive(fd, path, {
      timeoutMs,
      log: ({ waitMs, outcome }) => {
        if (waitMs >= 5 || outcome === "busy")
          process.stderr.write(
            `worktree lock ${path}: ${outcome} after ${Math.round(waitMs)}ms\n`,
          );
      },
    });
    try {
      return await fn();
    } finally {
      unlock();
    }
  } finally {
    closeSync(fd);
  }
}

// Run locked cleanup; return skipped if another cleaner holds the lock.
export async function cleanOnce(
  root: Root,
  observe?: () => Promise<MembershipSnapshot> | MembershipSnapshot,
  releasedIds = new Set<string>(),
): Promise<string> {
  let snapshot: MembershipSnapshot;
  try {
    if (observe) snapshot = await observe();
    else {
      const membership = membershipFromEnv(root);
      if (!membership) return "no-membership";
      snapshot = await getLiveAgentIds(membership);
    }
  } catch (error) {
    process.stderr.write(
      `worktree clean: membership fetch failed: ${exceptionText(error)}\n`,
    );
    return "unknown";
  }
  if (!(snapshot[1] instanceof Set) || !snapshot[2]) return "unknown";
  try {
    return await cleanPass(root, snapshot, releasedIds);
  } catch (error) {
    if (error instanceof Error && error.name === "TreeLifecycleBusy")
      return "skipped";
    throw error;
  }
}

async function cleanPass(
  root: Root,
  snapshot: MembershipSnapshot,
  releasedIds: Set<string>,
): Promise<string> {
  await migrateLegacy(root);
  const [observedAt, ids, complete, workdirs] = snapshot;
  if (!(ids instanceof Set) || !complete) return "unknown";
  const protectedNames = new Set<string>();
  for (const workdir of workdirs ?? []) {
    try {
      const parent = strictRealpath(root.worktrees);
      const path = strictRealpath(workdir);
      if (isWithin(parent, path)) {
        const name = relative(parent, path).split(/[\\/]/)[0]!;
        if (validName(name) !== null) protectedNames.add(name);
      }
    } catch {}
  }
  const names = new Set<string>();
  if (isDirectory(root.worktrees))
    for (const entry of readdirSync(root.worktrees, { withFileTypes: true }))
      if (entry.isDirectory() && validName(entry.name) !== null)
        names.add(entry.name);
  if (isDirectory(root.markers)) {
    const markerNames = readdirSync(root.markers)
      .filter((entry) => {
        const marker = join(root.markers, entry);
        return (
          isFile(marker) &&
          entry.endsWith(".json") &&
          validName(entry.slice(0, -5)) !== null
        );
      })
      .map((entry) => entry.slice(0, -5))
      .sort();
    for (const name of markerNames) names.add(name);
  }
  let count = 0;
  for (const name of [...names].sort()) {
    if (
      await withCleanerLock(root, () =>
        reapOne(root, name, ids, observedAt, protectedNames, releasedIds),
      )
    )
      count += 1;
  }
  return `cleaned-${count}`;
}

/** Launch an independent sweeper group; the caller never joins cleanup. */
export function startSweep(root: Root): number | null {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--root", root.dataDir, "sweep"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.on("error", (error) =>
    process.stderr.write(
      `worktree sweep could not start: ${exceptionText(error)}\n`,
    ),
  );
  child.unref();
  return child.pid ?? null;
}

/** Persist reap requests before triggering the shared sweeper. */
export function requestReapSweep(root: Root, ids: Iterable<string>): void {
  const pending = join(root.markers, ".pending-reap");
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  for (const cid of ids) {
    if (validName(cid) === null) continue;
    try {
      closeSync(openSync(join(pending, cid), "wx", 0o600));
    } catch (error) {
      if (!isOperationalError(error) || error.code !== "EEXIST") throw error;
    }
  }
  startSweep(root);
}

function pendingReaps(root: Root): string[] {
  try {
    return readdirSync(join(root.markers, ".pending-reap")).filter(
      (name) => validName(name) !== null,
    );
  } catch (error) {
    if (isOperationalError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function remainingHolders(root: Root): Set<string> {
  const holders = new Set<string>();
  for (const entry of readdirSync(root.markers)) {
    if (!entry.endsWith(".json")) continue;
    const record = markerRecord(root, entry.slice(0, -5));
    for (const cid of Object.keys(asRecord(record?.holders) ?? {}))
      holders.add(cid);
  }
  return holders;
}

function sweepLog(root: Root, message: string): void {
  const path = join(root.markers, ".sweep.log");
  try {
    if (exists(path) && statSync(path).size > 64 * 1024)
      writeFileSync(path, "");
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    process.stderr.write(
      `worktree sweep log failed: ${exceptionText(error)}\n`,
    );
  }
}

/** Retire, then reclaim incrementally; ignore duplicate sweep commands. */
export async function sweepOnce(
  root: Root,
  retired?: (result: string) => void,
): Promise<string> {
  if (!isDirectory(root.dataDir)) return "root-gone";
  try {
    const outcome = await withCleanerLock(
      root,
      async () => {
        const pidPath = join(root.markers, ".sweeper.pid");
        writeFileSync(pidPath, String(process.pid));
        sweepLog(root, `started ${process.pid}`);
        let previous = "";
        try {
          for (;;) {
            if (!isDirectory(root.dataDir)) return "root-gone";
            const membership = membershipFromEnv(root);
            const snapshot: MembershipSnapshot = membership
              ? await getLiveAgentIds(membership)
              : [Date.now() / 1000, UNKNOWN, false];
            const requests = pendingReaps(root);
            const released = new Set(
              requests.filter(
                (cid) =>
                  snapshot[2] &&
                  snapshot[1] instanceof Set &&
                  !snapshot[1].has(cid),
              ),
            );
            const result = await cleanOnce(root, () => snapshot, released);
            const remaining = requests.length
              ? remainingHolders(root)
              : new Set<string>();
            retired?.(result);
            if (result !== previous || /^cleaned-[1-9]/.test(result))
              sweepLog(root, result);
            previous = result;
            for (const cid of requests) {
              const path = join(root.markers, ".pending-reap", cid);
              const gone =
                snapshot[2] &&
                snapshot[1] instanceof Set &&
                !snapshot[1].has(cid);
              if (gone && result !== "skipped" && !remaining.has(cid))
                unlinkMissingOk(path);
              else if (Date.now() - statSync(path).mtimeMs >= 30 * 60 * 1000) {
                sweepLog(
                  root,
                  `reap ${cid} still pending after 30 minutes; retry rm`,
                );
                unlinkMissingOk(path);
              }
            }
            const local = dependencyPaths(root.dataDir, root.worktrees);
            const reclaimed = reclaimWorktreeTrash(root);
            const localReclaimed = sweep(local.trash, 1);
            if (reclaimed + localReclaimed > 0) continue;
            if (exists(root.trash) && readdirSync(root.trash).length)
              sweepLog(
                root,
                "trash remains; the next sweep retries reclamation",
              );
            if (exists(local.trash) && readdirSync(local.trash).length)
              sweepLog(
                root,
                "local dependency trash remains; next sweep retries",
              );
            if (pendingReaps(root).length === 0) return result;
            await Bun.sleep(1000);
          }
        } finally {
          unlinkMissingOk(pidPath);
          sweepLog(root, `finished ${process.pid}`);
        }
      },
      0,
      ".sweeper.lock",
    );
    if (isDirectory(root.dataDir) && pendingReaps(root).length)
      startSweep(root);
    return outcome;
  } catch (error) {
    if (error instanceof Error && error.name === "TreeLifecycleBusy")
      return "skipped";
    sweepLog(root, `failed: ${exceptionText(error)}`);
    throw error;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface EnterArgs {
  root: string | null;
  agent: string | null;
  source: string | null;
  name: string;
}

function printHelp(): void {
  process.stdout.write(`${MODULE_HELP}\n`);
}

function printEnterHelp(): void {
  process.stdout.write(
    `usage: worktree.py enter [-h] [--source dir] name\n\npositional arguments:\n  name          unique directory label\n\noptions:\n  -h, --help    show this help message and exit\n  --source dir  create from this checkout\n`,
  );
}

function parserError(message: string, enterCommand = false): never {
  const usage = enterCommand
    ? "usage: worktree.py enter [-h] [--source dir] name\n"
    : "usage: worktree.py [-h] [--root dir] [--agent id] {enter,sweep} ...\n";
  const parser = enterCommand ? "worktree.py enter" : "worktree.py";
  process.stderr.write(`${usage}${parser}: error: ${message}\n`);
  process.exitCode = 2;
  throw new ParserExit();
}

class ParserExit extends Error {}

function optionAbbreviation(arg: string, option: string): boolean {
  const name = arg.split("=", 1)[0]!;
  return name.length > 2 && name !== option && option.startsWith(name);
}

function optionValue(
  args: string[],
  index: number,
  option: string,
  enterCommand: boolean,
): [string, number] {
  const current = args[index]!;
  const equals = current.indexOf("=");
  if (equals >= 0) return [current.slice(equals + 1), index];
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    parserError(`argument ${option}: expected one argument`, enterCommand);
  }
  return [value, index + 1];
}

function parseArgs(
  args: string[],
): EnterArgs | { sweepRoot: string | null } | "help" | "enter-help" {
  let root: string | null = null;
  let agent: string | null = null;
  const unrecognizedArguments: string[] = [];
  let index = 0;
  let optionsEnded = false;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && (arg === "--help" || arg === "-h")) return "help";
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg === "enter") break;
    if (arg === "sweep") {
      if (index !== args.length - 1 || unrecognizedArguments.length)
        parserError("sweep takes no arguments");
      return { sweepRoot: root };
    }
    if (!optionsEnded && (arg === "--root" || arg.startsWith("--root="))) {
      [root, index] = optionValue(args, index, "--root", false);
      continue;
    }
    if (!optionsEnded && (arg === "--agent" || arg.startsWith("--agent="))) {
      [agent, index] = optionValue(args, index, "--agent", false);
      continue;
    }
    if (!optionsEnded && optionAbbreviation(arg, "--root")) {
      [root, index] = optionValue(args, index, "--root", false);
      continue;
    }
    if (!optionsEnded && optionAbbreviation(arg, "--agent")) {
      [agent, index] = optionValue(args, index, "--agent", false);
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      unrecognizedArguments.push(arg);
      continue;
    }
    parserError(
      `argument cmd: invalid choice: '${arg}' (choose from enter, sweep)`,
    );
  }
  if (index >= args.length) {
    parserError("the following arguments are required: cmd");
  }

  let source: string | null = null;
  let name: string | null = null;
  let endEnterOptions = false;
  const remaining = args.slice(index + 1);
  for (let cursor = 0; cursor < remaining.length; cursor += 1) {
    const arg = remaining[cursor]!;
    if (!endEnterOptions && (arg === "--help" || arg === "-h")) {
      return "enter-help";
    }
    if (!endEnterOptions && arg === "--") {
      endEnterOptions = true;
      continue;
    }
    if (
      !endEnterOptions &&
      (arg === "--source" || arg.startsWith("--source="))
    ) {
      [source, cursor] = optionValue(remaining, cursor, "--source", true);
      continue;
    }
    if (!endEnterOptions && optionAbbreviation(arg, "--source")) {
      [source, cursor] = optionValue(remaining, cursor, "--source", true);
      continue;
    }
    if (!endEnterOptions && arg.startsWith("-")) {
      unrecognizedArguments.push(arg);
      continue;
    }
    if (name !== null) {
      unrecognizedArguments.push(arg);
      continue;
    }
    name = arg;
  }
  if (name === null) {
    parserError("the following arguments are required: name", true);
  }
  if (unrecognizedArguments.length > 0) {
    parserError(`unrecognized arguments: ${unrecognizedArguments.join(" ")}`);
  }
  return { root, agent, source, name };
}

async function runEnter(args: EnterArgs): Promise<number> {
  const cid = args.agent || selfId();
  if (cid === null) {
    process.stderr.write("RECURSE_AGENT_ID is not set (or pass --agent).\n");
    return 1;
  }
  const root = rootFromEnv(args.root);
  let source: string;
  try {
    source = resolveWorktreeSource(args.source || process.cwd());
  } catch (error) {
    process.stderr.write(`${exceptionText(error)}\n`);
    return 1;
  }
  let path: string | null = null;
  const record = markerRecord(root, args.name);
  if (Object.hasOwn(asRecord(record?.holders) ?? {}, cid)) {
    const checkout = join(root.worktrees, args.name);
    if ((await addHolder(root, checkout, cid)) === "held") {
      const dependencyRoot = await managedDependencyRoot(checkout);
      if (dependencyRoot !== null)
        await prepareManagedDependencies(checkout, dependencyRoot);
      path = checkout;
      startSweep(root);
    }
  } else {
    path = await ensureNamedWorktree(root, cid, args.name, process.cwd(), {
      source,
    });
  }
  if (path === null) {
    process.stderr.write("Could not create that worktree; try another name.\n");
    return 1;
  }
  process.stdout.write(
    `Worktree ready at ${path}. Call the chdir tool with \`${path}\` now.\n`,
  );
  return 0;
}

/** Run the CLI, allowing module imports to be used without side effects. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  let parsed: EnterArgs | { sweepRoot: string | null } | "help" | "enter-help";
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof ParserExit) {
      return typeof process.exitCode === "number" ? process.exitCode : 2;
    }
    throw error;
  }
  if (parsed === "help") {
    printHelp();
    return 0;
  }
  if (parsed === "enter-help") {
    printEnterHelp();
    return 0;
  }
  if ("sweepRoot" in parsed) {
    const result = await sweepOnce(rootFromEnv(parsed.sweepRoot), (result) =>
      process.stdout.write(`retired ${result}\n`),
    );
    process.stdout.write(`${result}\n`);
    return 0;
  }
  return runEnter(parsed);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
