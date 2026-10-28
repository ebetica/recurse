// Executable attachment tree specs shared by replay and reverse-open scripts.
import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { lstatAtSync, readdirAtSync } from "../../../src/utils/dir_fd";
import { join, relative } from "node:path";
import { AttachmentNotFound } from "../../../src/agents/runtime/attachments/base";
import {
  describe,
  readDownload,
} from "../../../src/agents/runtime/attachments/preview";
import {
  cleanupDebris,
  existingForCall,
  readManifest,
  writeManifestJson,
} from "../../../src/agents/runtime/attachments/store";

const ID = "a".repeat(32);
const OWNER = "owner";
type Leaf = { json?: unknown; hex?: string; link?: string; mode?: number };
export interface Spec {
  op: string;
  tree?: Record<string, Leaf>;
  manifest?: Record<string, string | number | boolean | null>;
  action?: string;
  files?: number;
  size?: number;
}
async function localUsage(fd: Awaited<ReturnType<typeof open>>, owner: string) {
  const usage = { upload: [0, 0], publication: [0, 0] } as {
    upload: [number, number];
    publication: [number, number];
  };
  let physical = 0;
  for (const name of readdirAtSync(fd.fd)) {
    try {
      const info = lstatAtSync(fd.fd, name);
      physical += info.isFile() ? info.size : 0;
    } catch {
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      const manifest = await readManifest(fd, owner, id);
      if (!manifest) continue;
      const bucket =
        manifest.source === "upload" ? usage.upload : usage.publication;
      bucket[0] += 1;
      bucket[1] += Number(manifest.size);
    } catch {
      /* invalid fixture entries are ignored */
    }
  }
  return [usage, physical];
}

export function setup(root: string, spec: Spec): void {
  mkdirSync(join(root, "collection"), { mode: 0o700 });
  for (const [name, entry] of Object.entries(spec.tree ?? {})) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    if (entry.link !== undefined) symlinkSync(entry.link, path);
    else {
      writeFileSync(
        path,
        entry.json !== undefined
          ? JSON.stringify(entry.json)
          : new Uint8Array(Buffer.from(entry.hex!, "hex")),
      );
      chmodSync(path, entry.mode ?? 0o600);
    }
  }
}
export function snapshot(root: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  function visit(parent: string): void {
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name),
        info = lstatSync(path);
      const kind = info.isSymbolicLink()
        ? "link"
        : info.isDirectory()
          ? "directory"
          : "file";
      const row: Record<string, unknown> = {
        path: relative(root, path),
        kind,
        mode: info.mode & 0o777,
        // A directory's st_size depends on the filesystem; record it only
        // for files and links.
        ...(kind === "directory" ? {} : { size: info.size }),
      };
      if (kind === "link") row.target = readlinkSync(path);
      else if (kind === "file") {
        const data = readFileSync(path);
        row.sha256 = createHash("sha256")
          .update(new Uint8Array(data))
          .digest("hex");
        if (path.endsWith(".json")) {
          try {
            row.json = JSON.parse(data.toString());
          } catch {
            /* corrupt */
          }
        }
      }
      rows.push(row);
      if (kind === "directory") visit(path);
    }
  }
  visit(root);
  return rows;
}
export async function observe(
  root: string,
  spec: Spec,
): Promise<{ read: unknown; tree: Array<Record<string, unknown>> }> {
  const coll = join(root, "collection");
  let result: unknown;
  if (spec.op === "preview") {
    let download: unknown;
    try {
      const [manifest, data] = await readDownload(coll, OWNER, ID);
      download = { manifest, hex: Buffer.from(data).toString("hex") };
    } catch (error) {
      if (error instanceof AttachmentNotFound) download = null;
      else throw error;
    }
    result = { describe: await describe(coll, OWNER, ID), download };
  } else {
    const fd = await open(coll, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      result = {
        manifest: await readManifest(fd, OWNER, ID),
        usage: await localUsage(fd, OWNER),
        existing: await existingForCall(fd, OWNER, "b".repeat(32), "call"),
      };
    } finally {
      await fd.close();
    }
  }
  return { read: result, tree: snapshot(root) };
}
export async function applyCase(
  root: string,
  spec: Spec,
): Promise<{
  error: { type: string; message: string } | null;
  read: unknown;
  tree: Array<Record<string, unknown>>;
}> {
  setup(root, spec);
  let error: { type: string; message: string } | null = null;
  try {
    const coll = join(root, "collection");
    if (spec.op === "manifest_write" || spec.op === "cleanup") {
      const fd = await open(coll, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        if (spec.op === "manifest_write")
          await writeManifestJson(
            fd,
            `${ID}.json`,
            spec.manifest!,
            () => "00000000000000000000000000000001",
          );
        else await cleanupDebris(fd, OWNER);
      } finally {
        await fd.close();
      }
    }
  } catch (cause) {
    const err = cause as Error;
    error = { type: err.name, message: err.message };
  }
  return { error, ...(await observe(root, spec)) };
}
