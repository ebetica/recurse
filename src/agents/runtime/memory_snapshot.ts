// Bounded metadata-only memory snapshots from pinned no-follow descriptors.
// Check owner/mode/inode before/open/after; files need one link and unchanged
// metadata including ctime, detecting even a link created then removed.
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { entriesAt, lstatAt, mkdirAt, openAt } from "../../utils/dir_fd";

export type MemoryPaths = { local: string; tree: string; global: string };
export type MemoryEntry = { path: string; title: string; date: string };
export type MemoryIndex = { entries: MemoryEntry[]; truncated: boolean };
export type MemorySnapshot = {
  paths: MemoryPaths;
  local: MemoryIndex;
  tree: MemoryIndex;
  global: MemoryIndex;
};
export type ScanLimits = {
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFrontMatterBytes: number;
  maxPathBytes: number;
  maxTitleChars: number;
  maxDateChars: number;
};
export const DEFAULT_LIMITS: ScanLimits = {
  maxDepth: 4,
  maxEntries: 512,
  maxFiles: 64,
  maxTotalBytes: 256 * 1024,
  maxFileBytes: 64 * 1024,
  maxFrontMatterBytes: 8 * 1024,
  maxPathBytes: 256,
  maxTitleChars: 160,
  maxDateChars: 64,
};
const DIR_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const LINE_BREAKS = /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const PYTHON_SPACE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const splitLines = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const strip = (text: string) => text.replace(PYTHON_SPACE, "");
const ownerUid = (): bigint => {
  if (!process.geteuid) throw new Error("UID check unavailable");
  return BigInt(process.geteuid());
};
const identity = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const ownedDir = (s: BigIntStats, privateDir: boolean) =>
  s.isDirectory() &&
  s.uid === ownerUid() &&
  (!privateDir || (s.mode & 0o077n) === 0n);
const stableFile = (a: BigIntStats, b: BigIntStats) =>
  identity(a, b) &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

async function ownedDirectory(
  path: string,
  privateDir: boolean,
): Promise<FileHandle> {
  const before = await lstat(path, { bigint: true });
  if (!ownedDir(before, privateDir))
    throw new Error(`unsafe memory directory: ${path}`);
  const handle = await open(path, DIR_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      !ownedDir(opened, privateDir) ||
      !ownedDir(after, privateDir) ||
      !identity(before, opened) ||
      !identity(before, after)
    )
      throw new Error(`replaced memory directory: ${path}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function ownedChild(
  parent: FileHandle,
  name: string,
  create: boolean,
): Promise<FileHandle> {
  if (create) {
    try {
      await mkdirAt(parent.fd, name, 0o700);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
  }
  const before = await lstatAt(parent.fd, name, { bigint: true });
  if (!ownedDir(before, create))
    throw new Error(`unsafe memory directory component: ${name}`);
  const handle = await openAt(parent.fd, name, DIR_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstatAt(parent.fd, name, { bigint: true });
    if (
      !ownedDir(opened, create) ||
      !ownedDir(after, create) ||
      !identity(before, opened) ||
      !identity(before, after)
    )
      throw new Error(`replaced memory directory component: ${name}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function memoryScope<T>(
  cid: string,
  dataDir: string,
  treeId: string,
  fn: (
    paths: MemoryPaths,
    local: FileHandle,
    global: FileHandle,
    tree: FileHandle,
  ) => Promise<T>,
): Promise<T> {
  if (
    ![cid, treeId].every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$(?![\s\S])/.test(id),
    )
  )
    throw new Error("invalid agent id");
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  const opened: FileHandle[] = [];
  try {
    const first = await ownedDirectory(root, false);
    opened.push(first);
    const memories = await ownedChild(first, "memories", true);
    opened.push(memories);
    const agents = await ownedChild(memories, "agents", true);
    opened.push(agents);
    const local = await ownedChild(agents, cid, true);
    opened.push(local);
    const global = await ownedChild(memories, "global", true);
    opened.push(global);
    const trees = await ownedChild(memories, "trees", true);
    opened.push(trees);
    const tree = await ownedChild(trees, treeId, true);
    opened.push(tree);
    return await fn(
      {
        local: join(root, "memories", "agents", cid),
        global: join(root, "memories", "global"),
        tree: join(root, "memories", "trees", treeId),
      },
      local,
      global,
      tree,
    );
  } finally {
    for (const handle of opened.reverse()) await handle.close();
  }
}
export async function ensureMemoryDirs(
  cid: string,
  dataDir: string,
  treeId = cid,
): Promise<MemoryPaths> {
  return memoryScope(cid, dataDir, treeId, async (paths) => paths);
}
function safeLine(text: string): boolean {
  return !LINE_BREAKS.test(text) && !/[\x00-\x1f\x7f]/u.test(text);
}
function safeText(raw: string, limit: number): string | null {
  const value = strip(raw);
  if (
    !value ||
    Array.from(value).length > limit ||
    !safeLine(value) ||
    /^[\x27"|>]/u.test(value) ||
    /[\x27"]$/u.test(value)
  )
    return null;
  return value;
}
function frontMatter(
  data: Uint8Array,
  limits: ScanLimits,
): [string, string] | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } catch {
    return null;
  }
  const lines = text.split(splitLines);
  if (lines[0] !== "---") return null;
  const fields = new Map<string, string>();
  let closed = false;
  for (const line of lines.slice(1)) {
    if (line === "---") {
      closed = true;
      break;
    }
    if (!strip(line)) continue;
    const separator = line.indexOf(":");
    const key = strip(separator < 0 ? line : line.slice(0, separator));
    if (separator < 0 || !key || fields.has(key)) return null;
    fields.set(key, line.slice(separator + 1));
  }
  if (!closed) return null;
  const title = safeText(fields.get("title") ?? "", limits.maxTitleChars);
  const date = safeText(fields.get("date") ?? "", limits.maxDateChars);
  return title !== null &&
    date !== null &&
    /^[0-9][0-9A-Za-z .:+_/-]*$/u.test(date)
    ? [title, date]
    : null;
}
export type ScanHooks = {
  beforeRead?: (name: string) => Promise<void>;
  beforeVisibleStat?: (name: string) => Promise<void>;
};
async function readFrontMatter(
  parent: FileHandle,
  name: string,
  before: BigIntStats,
  limits: ScanLimits,
  remainingBudget: number,
  hooks?: ScanHooks,
): Promise<[string, string] | null> {
  if (
    before.nlink !== 1n ||
    before.size > BigInt(limits.maxFileBytes) ||
    remainingBudget <= 0
  )
    return null;
  let handle: FileHandle | undefined;
  try {
    handle = await openAt(parent.fd, name, FILE_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.uid !== ownerUid() ||
      !identity(before, opened) ||
      opened.size !== before.size
    )
      return null;
    const limit = Math.min(
      limits.maxFrontMatterBytes,
      Number(before.size),
      remainingBudget,
    );
    const data = new Uint8Array(limit);
    await hooks?.beforeRead?.(name);
    let count = 0;
    while (count < limit) {
      const { bytesRead } = await handle.read(data, count, limit - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await hooks?.beforeVisibleStat?.(name);
    const visible = await lstatAt(parent.fd, name, { bigint: true });
    if (
      !stableFile(before, after) ||
      !stableFile(before, visible) ||
      after.nlink !== 1n ||
      !visible.isFile() ||
      visible.nlink !== 1n ||
      visible.uid !== ownerUid()
    )
      return null;
    return frontMatter(data.subarray(0, count), limits);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
async function scanOpenMemoryDir(
  root: FileHandle,
  limits: ScanLimits,
  hooks?: ScanHooks,
): Promise<MemoryIndex> {
  let entriesSeen = 0,
    filesSeen = 0,
    bytesRead = 0,
    truncated = false;
  const found: MemoryEntry[] = [];
  async function walk(
    dir: FileHandle,
    parts: string[],
    depth: number,
  ): Promise<void> {
    if (truncated) return;
    let iterator: AsyncIterable<string>;
    try {
      iterator = await entriesAt(dir.fd);
    } catch {
      return;
    }
    try {
      for await (const name of iterator) {
        if (entriesSeen >= limits.maxEntries) {
          truncated = true;
          return;
        }
        entriesSeen++;
        if (name === "." || name === ".." || !safeLine(name)) continue;
        const relativePath = [...parts, name].join("/");
        if (Buffer.byteLength(relativePath, "utf8") > limits.maxPathBytes)
          continue;
        let info: BigIntStats;
        try {
          info = await lstatAt(dir.fd, name, { bigint: true });
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          if (depth >= limits.maxDepth) {
            truncated = true;
            continue;
          }
          let child: FileHandle;
          try {
            child = await ownedChild(dir, name, false);
          } catch {
            continue;
          }
          try {
            await walk(child, [...parts, name], depth + 1);
          } finally {
            await child.close();
          }
          continue;
        }
        if (!info.isFile() || info.nlink !== 1n || !name.endsWith(".md"))
          continue;
        if (filesSeen >= limits.maxFiles) {
          truncated = true;
          return;
        }
        filesSeen++;
        if (info.size > BigInt(limits.maxFileBytes)) continue;
        const readSize = Math.min(
          limits.maxFrontMatterBytes,
          Number(info.size),
        );
        const remaining = limits.maxTotalBytes - bytesRead;
        if (readSize > remaining) {
          truncated = true;
          return;
        }
        const parsed = await readFrontMatter(
          dir,
          name,
          info,
          limits,
          remaining,
          hooks,
        );
        bytesRead += readSize;
        if (parsed)
          found.push({ path: relativePath, title: parsed[0], date: parsed[1] });
      }
    } finally {
      // Invariant: for-await closes the directory, including on an early
      // return.
    }
  }
  await walk(root, [], 0);
  // Invariant: Python orders Unicode code points, not JavaScript UTF-16 code
  // units.
  found.sort((a, b) => {
    const left = Array.from(a.path),
      right = Array.from(b.path);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const difference =
        left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
      if (difference) return difference;
    }
    return left.length - right.length;
  });
  return { entries: found, truncated };
}
export async function scanMemoryDir(
  path: string,
  limits: ScanLimits = DEFAULT_LIMITS,
  hooks?: ScanHooks,
): Promise<MemoryIndex> {
  let root: FileHandle;
  try {
    root = await ownedDirectory(path, true);
  } catch {
    return { entries: [], truncated: false };
  }
  try {
    return await scanOpenMemoryDir(root, limits, hooks);
  } finally {
    await root.close();
  }
}
export async function captureMemorySnapshot(
  cid: string,
  dataDir: string,
  limits: ScanLimits = DEFAULT_LIMITS,
  treeId = cid,
): Promise<MemorySnapshot> {
  return memoryScope(
    cid,
    dataDir,
    treeId,
    async (paths, local, global, tree) => ({
      paths,
      local: await scanOpenMemoryDir(local, limits),
      tree: await scanOpenMemoryDir(tree, limits),
      global: await scanOpenMemoryDir(global, limits),
    }),
  );
}
function promptText(value: string): string {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (LINE_BREAKS.test(char)) text += `&#x${code.toString(16)};`;
    else if (char === "\t") text += "&#9;";
    else if (code < 0x20 || code === 0x7f)
      text += `\\x${code.toString(16).padStart(2, "0")}`;
    else
      text +=
        char === "&"
          ? "&amp;"
          : char === "<"
            ? "&lt;"
            : char === ">"
              ? "&gt;"
              : char;
  }
  return text;
}
function promptPath(path: string, dataDir: string): string {
  const rel = relative(dataDir, path);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    return promptText(`$CHAT_DATA_DIR/${rel.split(sep).join("/")}`);
  return promptText(path);
}
export function renderMemoryPrompt(
  snapshot: MemorySnapshot,
  dataDir: string,
): string {
  const prefix = [
    `Memory directories — local: ${promptPath(snapshot.paths.local, dataDir)}; shared tree: ${promptPath(snapshot.paths.tree, dataDir)}; shared global: ${promptPath(snapshot.paths.global, dataDir)}.`,
    "Read relevant memories; update existing files, keep titles short and prune stale local notes. Suggest global cleanup; add global memories only when asked.",
    "Global memories are shared by all agents; tree memories by agents in the current tree; local memories belong to this agent. Read/edit files directly; only Markdown with title/date front matter is indexed.",
    "<memory>",
  ];
  const entryLines = (index: MemoryIndex) =>
    index.entries.map(
      (entry) =>
        `- ${promptText(entry.path)}: ${promptText(entry.title)}, ${promptText(entry.date)}`,
    );
  const scopes = (["global", "tree", "local"] as const).map((key) => ({
    label: key[0]!.toUpperCase() + key.slice(1),
    lines: entryLines(snapshot[key]),
    truncated: snapshot[key].truncated,
  }));
  const scope = (
    label: string,
    lines: string[],
    truncated: boolean,
  ): string[] => [
    `${label}:${!lines.length && !truncated ? " <none/>" : ""}`,
    ...lines,
    ...(truncated ? ["- [index truncated]"] : []),
  ];
  const assemble = () =>
    [
      ...prefix,
      ...scopes.flatMap(({ label, lines, truncated }) =>
        scope(label, lines, truncated),
      ),
      "</memory>",
    ].join("\n");
  let prompt = assemble();
  while (Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
    const largest = scopes.reduce((a, b) =>
      Buffer.byteLength(a.lines.at(-1) ?? "", "utf8") >=
      Buffer.byteLength(b.lines.at(-1) ?? "", "utf8")
        ? a
        : b,
    );
    if (!largest.lines.length)
      throw new Error("memory paths exceed the prompt snapshot limit");
    largest.lines.pop();
    largest.truncated = true;
    prompt = assemble();
  }
  return prompt;
}
