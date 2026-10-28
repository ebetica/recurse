// Instance name and icon live beside the other Settings JSON files.
// Atomic serialized writes retain the other field; SVG responses stay inert.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_ICON_BYTES = 1024 * 1024;
type Icon = { type: "image/png" | "image/svg+xml"; data: string };
type Brand = { name: string | null; icon: Icon | null };
const writes = new Map<string, Promise<unknown>>();

/** Branding shares the existing instance config directory. */
export const brandingFile = (configDir: string) =>
  join(configDir, "branding.json");

/** Bound settings reads, including base64-encoded image bytes. */
export async function readBrand(path: string): Promise<Brand> {
  let file;
  try {
    file = await open(path, "r");
    if ((await file.stat()).size > MAX_ICON_BYTES * 1.5)
      return { name: null, icon: null };
    const value = JSON.parse(await file.readFile("utf8"));
    return {
      name: typeof value.name === "string" ? value.name : null,
      icon:
        value.icon &&
        ["image/png", "image/svg+xml"].includes(value.icon.type) &&
        typeof value.icon.data === "string"
          ? value.icon
          : null,
    };
  } catch {
    return { name: null, icon: null };
  } finally {
    await file?.close();
  }
}

/** Accept PNG signatures or an SVG root; serve scripts inertly. */
export function brandIcon(bytes: Uint8Array): Icon {
  if (!bytes.length || bytes.length > MAX_ICON_BYTES)
    throw new Error("Choose a PNG or SVG icon up to 1 MiB.");
  const png = Buffer.from(bytes.subarray(0, 8)).equals(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const svg = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (
    !png &&
    !/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/u.test(svg)
  )
    throw new Error("Choose a PNG or SVG icon.");
  return {
    type: png ? "image/png" : "image/svg+xml",
    data: Buffer.from(bytes).toString("base64"),
  };
}

/** Stop reading uploads and local files as soon as they exceed the limit. */
export async function readIcon(
  stream: ReadableStream<Uint8Array>,
): Promise<Icon> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ICON_BYTES)
        throw new Error("Choose a PNG or SVG icon up to 1 MiB.");
      chunks.push(value);
    }
    return brandIcon(new Uint8Array(Buffer.concat(chunks)));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Serialize writes so independent name and icon saves cannot collide. */
export async function writeBrand(
  path: string,
  fields: Partial<Brand>,
): Promise<Brand> {
  if (fields.name !== undefined && fields.name !== null) {
    fields = { ...fields, name: fields.name.trim() };
    if (
      !fields.name ||
      fields.name.length > 80 ||
      /[\x00-\x1f\x7f]/u.test(fields.name)
    )
      throw new Error(
        "Name must contain 1–80 characters without control characters.",
      );
  }
  const pending = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const value = { ...(await readBrand(path)), ...fields };
      const tmp = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
      return value;
    });
  writes.set(path, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(path) === pending) writes.delete(path);
  }
}

/** Expose a content-versioned icon URL without returning image data. */
export function brandResponse(brand: Brand, defaultName: string) {
  return {
    name: brand.name ?? defaultName,
    custom_name: brand.name !== null,
    icon: brand.icon
      ? `/app-icon?v=${createHash("sha256").update(brand.icon.data).digest("hex").slice(0, 12)}`
      : null,
    icon_type: brand.icon?.type ?? null,
  };
}
