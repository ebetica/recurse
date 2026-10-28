// Opaque per-workdir skill identities backed by shared registry metadata.
// Async fs marks skill dirs by stat; read tool help without import/execution.
// Rearm detached checks after success so external edits become visible.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { resolveRoots } from "./local_roots";

export const SKILL_CONTEXT_VERSION = 3;
export const WORKDIR_CONTEXT_TTL_SECONDS = 5;

type MarkerValue = null | boolean | number | string | bigint | MarkerValue[];
export type StatId = readonly [mtimeNs: bigint, size: bigint] | null;
export type SkillGate = readonly [StatId, StatId, StatId];
export type GlobalsPair = readonly [
  beforeWorkdir: MarkerValue[],
  afterWorkdir: MarkerValue[],
];

export interface SkillRegistry {
  readonly contextVersion: number;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly repoUrl: string;
  readonly displayName: string;
}

/** Compose the already-ported instance paths and Pi settings root. A
 * long-lived caller passes the Pi agent dir it resolved once: resolving it
 * takes synchronous realpath calls. */
export function makeSkillRegistry(
  config: Config,
  agentDir = resolveRoots(config.env).piAgent,
  contextVersion = SKILL_CONTEXT_VERSION,
): SkillRegistry {
  return {
    contextVersion,
    dataDir: config.paths.DATA_DIR,
    agentDir,
    repoUrl: config.repoUrl,
    displayName: config.displayName,
  };
}

const PYTHON_WHITESPACE =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_EDGE_SPACE = new RegExp(
  `^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`,
  "gu",
);

export function pythonStrip(value: string): string {
  return value.replace(PYTHON_EDGE_SPACE, "");
}

function pythonJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value)!.replace(/[^\x20-\x7e]/gu, (char) => {
      const point = char.codePointAt(0)!;
      if (point <= 0xffff) return `\\u${point.toString(16).padStart(4, "0")}`;
      const adjusted = point - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    });
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(",")}]`;
  if (typeof value === "object" && value !== undefined) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${pythonJson(key)}:${pythonJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("value is not JSON serializable");
}

function expandUser(
  path: string,
  home = process.env.HOME || homedir(),
): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Metadata-only marker for one registry location; stat follows symlinks. */
export async function pathMarker(
  path: string,
  changes = true,
  home?: string,
): Promise<MarkerValue[]> {
  const expanded = expandUser(path, home);
  const marker: MarkerValue[] = [expanded];
  let info: BigIntStats;
  try {
    info = await stat(expanded, { bigint: true });
  } catch {
    marker.push(null);
    return marker;
  }
  marker.push(info.dev, info.ino);
  if (changes) marker.push(info.size, info.mtimeNs);
  return marker;
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes as unknown as Uint8Array<ArrayBuffer>,
  );
}

/** Identify a worktree and its current HEAD without spawning git. */
export async function gitHeadMarker(workdir: string): Promise<MarkerValue[]> {
  const dotgit = join(workdir, ".git");
  let gitdir = dotgit;
  try {
    if (await pathIsFile(dotgit)) {
      const value = pythonStrip((await readText(dotgit)).slice(0, 4096));
      if (value.startsWith("gitdir:")) {
        const candidate = pythonStrip(value.slice("gitdir:".length));
        gitdir = candidate.startsWith("/")
          ? candidate
          : join(dirname(dotgit), candidate);
      }
    }
    const value = pythonStrip(
      (await readText(join(gitdir, "HEAD"))).slice(0, 4096),
    );
    const marker: MarkerValue[] = [...(await pathMarker(gitdir)), value];
    if (value.startsWith("ref:")) {
      const ref = pythonStrip(value.slice("ref:".length));
      let common = gitdir;
      const commondir = join(gitdir, "commondir");
      if (await pathIsFile(commondir)) {
        const commonValue = pythonStrip(
          (await readText(commondir)).slice(0, 4096),
        );
        common = commonValue.startsWith("/")
          ? commonValue
          : join(gitdir, commonValue);
      }
      marker.push(...(await pathMarker(join(common, ref))));
    }
    return marker;
  } catch {
    return pathMarker(dotgit);
  }
}

function isIoError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}

/** Read the leading TypeScript module JSDoc without importing the tool. */
export function leadingModuleHelp(source: string): string | null {
  let index = 0;
  if (source.startsWith("#!")) {
    const newline = source.indexOf("\n");
    index = newline < 0 ? source.length : newline + 1;
  }
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (!source.startsWith("//", index)) break;
    const newline = source.indexOf("\n", index + 2);
    index = newline < 0 ? source.length : newline + 1;
  }
  if (!source.startsWith("/**", index)) return null;
  const end = source.indexOf("*/", index + 3);
  if (end < 0) return null;
  return pythonStrip(
    source
      .slice(index + 3, end)
      .split(/\r?\n/gu)
      .map((line) => line.replace(/^\s*\* ?/u, "").trimEnd())
      .join("\n"),
  );
}

/** Read a leading TypeScript module JSDoc, or use the fallback. */
export async function skillHelp(
  entry: string,
  fallback: string,
): Promise<string> {
  try {
    return leadingModuleHelp(await readText(entry)) ?? fallback;
  } catch (error) {
    if (isIoError(error)) return fallback;
    throw error;
  }
}

/** Split Pi's exact leading `/skill:name [args]` command syntax. */
export function splitSkillInvocation(text: string): [string, string] | null {
  if (!text.startsWith("/skill:")) return null;
  const space = text.indexOf(" ");
  return space < 0 ? [text, ""] : [text.slice(0, space), text.slice(space + 1)];
}

function ensureAsciiJson(values: readonly MarkerValue[]): string {
  return pythonJson(values);
}

function digest(values: readonly MarkerValue[]): string {
  return createHash("sha256")
    .update(ensureAsciiJson(values), "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Context from already-computed registry globals and fresh workdir markers. */
export async function contextWithGlobals(
  beforeWorkdir: readonly MarkerValue[],
  afterWorkdir: readonly MarkerValue[],
  workdir: string,
): Promise<string> {
  const values: MarkerValue[] = [
    ...beforeWorkdir,
    await pathMarker(workdir, false),
    await gitHeadMarker(workdir),
    ...afterWorkdir,
    await pathMarker(join(workdir, ".agents", "skills")),
    await pathMarker(join(workdir, ".pi", "skills")),
    await pathMarker(join(workdir, ".claude", "skills")),
  ];
  return digest(values);
}

function sameRegistry(left: SkillRegistry, right: SkillRegistry): boolean {
  return (
    left.contextVersion === right.contextVersion &&
    left.dataDir === right.dataDir &&
    left.agentDir === right.agentDir &&
    left.repoUrl === right.repoUrl &&
    left.displayName === right.displayName
  );
}

/** One tree render's skill-registry markers, deduplicated by workdir. */
export class SkillRenderCache {
  private globalsValue: Promise<GlobalsPair> | null = null;
  private readonly byWorkdir = new Map<string, Promise<string>>();

  constructor(readonly registry: SkillRegistry) {}

  private globals(): Promise<GlobalsPair> {
    if (this.globalsValue !== null) return this.globalsValue;
    this.globalsValue = this.buildGlobals();
    return this.globalsValue;
  }

  private async buildGlobals(): Promise<GlobalsPair> {
    const registry = this.registry;
    const before: MarkerValue[] = [
      registry.contextVersion,
      registry.displayName,
      registry.repoUrl,
      await pathMarker(registry.dataDir, false),
    ];
    const after: MarkerValue[] = [
      await pathMarker(join(registry.agentDir, "settings.json")),
      await pathMarker(join(registry.agentDir, "skills")),
    ];
    return [before, after];
  }

  globalsForSnapshot(): Promise<GlobalsPair> {
    return this.globals();
  }

  forWorkdir(workdir: string): Promise<string> {
    const cached = this.byWorkdir.get(workdir);
    if (cached !== undefined) return cached;
    const value = this.globals().then(([before, after]) =>
      contextWithGlobals(before, after, workdir),
    );
    this.byWorkdir.set(workdir, value);
    return value;
  }
}

export interface SkillSnapshot {
  readonly registry: SkillRegistry;
  readonly gate: SkillGate;
  readonly globalsPair: GlobalsPair;
}

async function skillStat(path: string | null): Promise<StatId> {
  if (path === null) return null;
  try {
    const info = await stat(path, { bigint: true });
    return [info.mtimeNs, info.size];
  } catch {
    return null;
  }
}

/** Stat-only identity rechecked before reusing the shared snapshot. */
export async function skillGate(registry: SkillRegistry): Promise<SkillGate> {
  return Promise.all([
    skillStat(registry.dataDir),
    skillStat(join(registry.agentDir, "settings.json")),
    skillStat(join(registry.agentDir, "skills")),
  ]);
}

/** Detached filesystem build; it mutates no SkillContext state. */
export async function buildSkillSnapshot(
  registry: SkillRegistry,
): Promise<SkillSnapshot> {
  const gate = await skillGate(registry);
  const globalsPair = await new SkillRenderCache(registry).globalsForSnapshot();
  return { registry, gate, globalsPair };
}

export type SnapshotBuilder = (
  registry: SkillRegistry,
) => Promise<SkillSnapshot>;

export class SkillContext {
  private snapshotValue: SkillSnapshot | null = null;
  private generationValue = 0;
  private scheduledBuildGeneration: number | null = null;
  private scheduledSnapshotCheck: Promise<void> | null = null;
  private readonly workdirValues = new Map<
    string,
    { at: number; value: string }
  >();
  private readonly workdirRefreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly registrySource: () => SkillRegistry,
    private readonly snapshotBuilder: SnapshotBuilder = buildSkillSnapshot,
  ) {}

  get generation(): number {
    return this.generationValue;
  }

  get installedSnapshot(): SkillSnapshot | null {
    return this.snapshotValue;
  }

  /** Retire the snapshot and ensure in-flight builds cannot publish over it. */
  dropSkillSnapshot(): void {
    this.snapshotValue = null;
    this.generationValue += 1;
  }

  /** The shared snapshot, rebuilt when its cheap metadata gate misses. */
  async skillSnapshot(): Promise<SkillSnapshot> {
    let built: SkillSnapshot | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = this.snapshotValue;
      const generation = this.generationValue;
      const registry = this.registrySource();
      if (
        previous !== null &&
        sameRegistry(previous.registry, registry) &&
        sameGate(await skillGate(registry), previous.gate)
      ) {
        return previous;
      }
      built = await this.snapshotBuilder(registry);
      if (generation === this.generationValue) {
        this.snapshotValue = built;
        return built;
      }
    }
    // Invariant: Concurrent drops won every installation race; return fresh
    // data without installing so the next access heals the still-empty cache.
    if (built === null) throw new Error("skill snapshot build did not run");
    return built;
  }

  async contextForWorkdir(
    workdir: string | null,
    renderCache?: SkillRenderCache,
  ): Promise<string | null> {
    if (workdir === null) return null;
    if (renderCache !== undefined) return renderCache.forWorkdir(workdir);
    const snapshot = await this.skillSnapshot();
    return contextWithGlobals(
      snapshot.globalsPair[0],
      snapshot.globalsPair[1],
      workdir,
    );
  }

  // Loop-safe installed-snapshot path; filesystem work is scheduled detached.
  contextForWorkdirLoopSafe(workdir: string | null): string | null {
    if (workdir === null) return null;
    const registry = this.registrySource();
    const snapshot = this.snapshotValue;
    if (snapshot === null || !sameRegistry(snapshot.registry, registry)) {
      this.scheduleSnapshotCheck();
      return null;
    }
    this.scheduleSnapshotCheck();
    const cached = this.workdirValues.get(workdir);
    const stale =
      cached === undefined ||
      performance.now() / 1000 - cached.at > WORKDIR_CONTEXT_TTL_SECONDS;
    const running = this.workdirRefreshes.get(workdir);
    if (stale && running === undefined) {
      const refresh = contextWithGlobals(
        snapshot.globalsPair[0],
        snapshot.globalsPair[1],
        workdir,
      )
        .then((value) => {
          this.workdirValues.set(workdir, {
            at: performance.now() / 1000,
            value,
          });
        })
        .catch(() => undefined)
        .finally(() => {
          this.workdirRefreshes.delete(workdir);
        });
      this.workdirRefreshes.set(workdir, refresh);
    }
    return cached?.value ?? null;
  }

  async workdirContextRefreshed(): Promise<void> {
    await Promise.allSettled([...this.workdirRefreshes.values()]);
  }

  async snapshotCheckRefreshed(): Promise<void> {
    await this.scheduledSnapshotCheck;
  }

  private scheduleSnapshotCheck(): void {
    const generation = this.generationValue;
    if (this.scheduledBuildGeneration === generation) return;
    this.scheduledBuildGeneration = generation;
    let scheduled!: Promise<void>;
    scheduled = this.skillSnapshot()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.scheduledBuildGeneration === generation) {
          this.scheduledBuildGeneration = null;
        }
        if (this.scheduledSnapshotCheck === scheduled) {
          this.scheduledSnapshotCheck = null;
        }
      });
    this.scheduledSnapshotCheck = scheduled;
  }

  /** Build a detached value for deterministic invalidation-race checks. */
  build(registry = this.registrySource()): Promise<SkillSnapshot> {
    return this.snapshotBuilder(registry);
  }

  /** Install only if no invalidation occurred after the build began. */
  installIfCurrent(
    built: SkillSnapshot,
    generation: number,
  ): SkillSnapshot | null {
    if (generation !== this.generationValue) return null;
    this.snapshotValue = built;
    return built;
  }
}

function sameGate(left: SkillGate, right: SkillGate): boolean {
  return (
    JSON.stringify(encodeBigInts(left)) === JSON.stringify(encodeBigInts(right))
  );
}

function encodeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(encodeBigInts);
  return value;
}

/** Reuse the render-global calculation for a shared skill snapshot. */
export function globalsForRegistry(
  registry: SkillRegistry,
): Promise<GlobalsPair> {
  return new SkillRenderCache(registry).globalsForSnapshot();
}
