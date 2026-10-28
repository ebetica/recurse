// Shell/entry weak ETags revalidate; equal generation pins are immutable.
// Mismatched scripts reload current shell, never run newer bundles in old HTML.
// Hashed chunks are immutable; other disk assets support conditional/ranges.
// Async refresh serves last-good snapshots while another request warms them.

import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import { concatBytes } from "../http_transport";
import { htmlEscape } from "../auth/session";
import { brandingFile, brandResponse, readBrand } from "../branding";
import type { Release } from "../release";
import { readTheme } from "../themes";
import {
  IMMUTABLE_YEAR,
  PRIVATE_REVALIDATE,
  conditionalBytes,
  conditionalJson,
} from "./caching";
import { HttpError, jsonResponse, type Router } from "./router";

/** Remote-control API version; bump for incompatible changes. */
export const REMOTE_CONTROL_API = 1;

/** Content types for the static frontend assets served at /static. */
export const STATIC_TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
export const FRONTEND_ASSET_NAMES = ["app.js", "app.css"] as const;
export const FRONTEND_REFRESH_MS = 1000;
/** Split chunks carry a content hash (bun: name-<hash>.js). */
const SPLIT_CHUNK_RE = /-[A-Za-z0-9]{6,}\.js$/;
const CID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type FrontendSnapshot = readonly [
  shell: string,
  assets: ReadonlyMap<string, Uint8Array>,
  version: string,
];
type Signature = string;

/** Python Path.suffix, lower-cased: the last dot of the final component. */
function suffix(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return ext === name ? "" : ext.toLowerCase();
}

/** Content identity shared by the HTML shell and its required bundle. */
export async function frontendGeneration(
  htmlTemplate: string,
  staticDir: string,
): Promise<string> {
  const digest = createHash("sha256").update(htmlTemplate);
  for (const name of FRONTEND_ASSET_NAMES) {
    digest.update(name);
    try {
      digest.update(await readBytes(join(staticDir, name)));
    } catch {
      digest.update("missing");
    }
  }
  return digest.digest("hex").slice(0, 20);
}

/** Content identity for one complete, already-read frontend snapshot. */
export function frontendGenerationBytes(
  shell: string,
  assets: ReadonlyMap<string, Uint8Array>,
): string {
  const digest = createHash("sha256").update(shell);
  for (const name of FRONTEND_ASSET_NAMES)
    digest.update(name).update(assets.get(name) ?? "missing");
  return digest.digest("hex").slice(0, 20);
}

const readBytes = async (path: string) => new Uint8Array(await readFile(path));

class GenerationChanged extends Error {}

/** The shell with each <svg data-icon="NAME"></svg> slot replaced by export
 * NAME of the icons module (web/icons.ts), re-imported whenever that file
 * changes; an unknown NAME throws so a missing icon fails loudly. */
export async function fillIconSlots(
  shell: string,
  iconsPath: string,
): Promise<string> {
  if (!shell.includes('<svg data-icon="')) return shell;
  const info = await stat(iconsPath);
  const url = `${iconsPath}?v=${info.mtimeMs}-${info.size}`;
  const icons: Record<string, unknown> = await import(url);
  return shell.replace(/<svg data-icon="(\w+)"><\/svg>/g, (_, name: string) => {
    const icon = icons[name];
    if (typeof icon !== "string") throw new Error(`unknown icon slot ${name}`);
    return icon;
  });
}

/** Last-good browser generation with a non-blocking live refresh. */
export class FrontendCache {
  private current: FrontendSnapshot;
  private signature: Signature;
  private nextCheck = 0;
  private refreshing = false;

  private constructor(
    private readonly htmlPath: string,
    private readonly iconsPath: string,
    private readonly staticDir: string,
    private readonly live: boolean,
    private readonly nowMs: () => number,
    snapshot: FrontendSnapshot,
    signature: Signature,
  ) {
    this.current = snapshot;
    this.signature = signature;
  }

  static async create(options: {
    htmlPath: string;
    /** Defaults to web/icons.ts beside htmlPath. */
    iconsPath?: string;
    staticDir: string;
    fallbackShell: string;
    fixedVersion: string;
    live: boolean;
    nowMs?: () => number;
  }): Promise<FrontendCache> {
    const nowMs = options.nowMs ?? (() => performance.now());
    const probe = new FrontendCache(
      options.htmlPath,
      options.iconsPath ?? join(dirname(options.htmlPath), "web", "icons.ts"),
      options.staticDir,
      options.live,
      nowMs,
      [options.fallbackShell, new Map(), options.fixedVersion],
      "",
    );
    let shell = options.fallbackShell;
    let assets: Map<string, Uint8Array> = new Map();
    let signature: Signature = "";
    try {
      [shell, assets, signature] = await probe.read(options.fallbackShell);
    } catch {
      // Invariant: A missing or transiently unreadable bundle does not take
      // down the API: live mode retries, fixed mode keeps the generic disk
      // route.
    }
    const version = options.live
      ? frontendGenerationBytes(shell, assets)
      : options.fixedVersion;
    probe.current = [shell, assets, version];
    probe.signature = signature;
    return probe;
  }

  private paths(): string[] {
    return [
      this.htmlPath,
      this.iconsPath,
      ...FRONTEND_ASSET_NAMES.map((name) => join(this.staticDir, name)),
    ];
  }

  private async signatureNow(): Promise<Signature> {
    const parts: unknown[] = [];
    for (const path of this.paths()) {
      try {
        const info = await stat(path, { bigint: true });
        parts.push([String(info.ino), String(info.size), String(info.mtimeNs)]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        parts.push(null);
      }
    }
    return JSON.stringify(parts);
  }

  private async read(
    fallbackShell: string,
  ): Promise<[string, Map<string, Uint8Array>, Signature]> {
    const before = await this.signatureNow();
    let shell: string;
    try {
      shell = await readFile(this.htmlPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      shell = fallbackShell;
    }
    shell = await fillIconSlots(shell, this.iconsPath);
    const assets = new Map<string, Uint8Array>();
    for (const name of FRONTEND_ASSET_NAMES) {
      // Invariant: A staged dist publish briefly renames files away: an
      // ordinary gap.
      try {
        assets.set(name, await readBytes(join(this.staticDir, name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const after = await this.signatureNow();
    if (before !== after)
      throw new GenerationChanged(
        "frontend generation changed while being read",
      );
    return [shell, assets, after];
  }

  async snapshot(): Promise<FrontendSnapshot> {
    // Invariant: Never wait behind another refresh: others keep the last-good
    // snapshot.
    if (!this.live || this.nowMs() < this.nextCheck || this.refreshing)
      return this.current;
    this.refreshing = true;
    try {
      this.nextCheck = this.nowMs() + FRONTEND_REFRESH_MS;
      let shell: string;
      let assets: Map<string, Uint8Array>;
      let signature: Signature;
      try {
        signature = await this.signatureNow();
        if (signature === this.signature) return this.current;
        [shell, assets, signature] = await this.read(this.current[0]);
      } catch {
        return this.current;
      }
      // Invariant: Never advertise a partial publish as the generation.
      if (FRONTEND_ASSET_NAMES.some((name) => !assets.has(name)))
        return this.current;
      this.signature = signature;
      this.current = [shell, assets, frontendGenerationBytes(shell, assets)];
      return this.current;
    } finally {
      this.refreshing = false;
    }
  }
}

/** Tiny JS response for a stale shell requesting another bundle version. */
export function generationReloadScript(generation: string): string {
  const target = JSON.stringify(generation);
  return `(() => {
  const target = ${target};
  const url = new URL(window.location.href);
  if (url.searchParams.get("_recurse_generation") !== target) {
    url.searchParams.set("_recurse_generation", target);
    window.location.replace(url.href);
    return;
  }
  // The cache-busted shell was still stale. Stop rather than reload forever and
  // leave a visible, explicit recovery action above the intact page contents.
  window.addEventListener("DOMContentLoaded", () => {
    const notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.style.cssText = "position:fixed;z-index:2147483647;inset:12px 12px auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px;background:var(--panel);color:var(--text);border:1px solid var(--warn);border-radius:10px;font-size:0.84375rem";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sm";
    button.textContent = "Retry update";
    button.onclick = () => { url.searchParams.set("_recurse_retry", Date.now().toString()); window.location.replace(url.href); };
    notice.append("The app update did not finish.", button);
    document.body.prepend(notice);
  });
})();`;
}

function reloadResponse(version: string): Response {
  const body = new TextEncoder().encode(generationReloadScript(version));
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-length": String(body.byteLength),
      "content-type": "application/javascript",
    },
  });
}

/** Python str(float) for a stat mtime in seconds. */
function pyFloatRepr(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  const text = String(value);
  return text.replace(/e([+-])(\d)$/, "e$10$2");
}

class MalformedRange extends Error {}
class RangeNotSatisfiable extends Error {
  constructor(readonly size: number) {
    super("range not satisfiable");
  }
}

/** Starlette FileResponse._parse_ranges: unparsable parts are skipped. */
function parseRanges(text: string, size: number): [number, number][] {
  const ranges: [number, number][] = [];
  const pyInt = (value: string) => {
    if (!/^[+-]?\d+(?:_\d+)*$/.test(value)) throw new Error("not an int");
    return Number(value.replaceAll("_", ""));
  };
  for (let part of text.split(",")) {
    part = part.trim();
    if (!part || part === "-" || !part.includes("-")) continue;
    const at = part.indexOf("-");
    const startText = part.slice(0, at).trim();
    const endText = part.slice(at + 1).trim();
    try {
      const start = startText
        ? pyInt(startText)
        : Math.max(size - pyInt(endText), 0);
      const end =
        startText && endText && pyInt(endText) < size
          ? pyInt(endText) + 1
          : size;
      ranges.push([start, end]);
    } catch {
      continue;
    }
  }
  return ranges;
}

function parseRangeHeader(header: string, size: number): [number, number][] {
  const at = header.indexOf("=");
  if (at === -1) throw new MalformedRange("Malformed range header.");
  if (header.slice(0, at).trim().toLowerCase() !== "bytes")
    throw new MalformedRange("Only support bytes range");
  const ranges = parseRanges(header.slice(at + 1), size);
  if (!ranges.length)
    throw new MalformedRange("Range header: range must be requested");
  if (ranges.some(([start]) => !(start >= 0 && start < size)))
    throw new RangeNotSatisfiable(size);
  if (ranges.some(([start, end]) => start > end))
    throw new MalformedRange("Range header: start must be less than end");
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [ranges[0]!];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function plainText(
  status: number,
  text: string,
  headers: Record<string, string> = {},
) {
  const body = new TextEncoder().encode(text);
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "content-length": String(body.byteLength),
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

/** Starlette FileResponse (GET) with its stat headers and Range handling. */
export async function fileResponse(
  request: Request,
  path: string,
  mediaType: string,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const info = await stat(path);
  const data = await readBytes(path);
  const size = data.byteLength;
  const contentType = mediaType.startsWith("text/")
    ? `${mediaType}; charset=utf-8`
    : mediaType;
  const mtime = info.mtimeMs / 1000;
  const base: Record<string, string> = {
    ...headers,
    "content-type": contentType,
    "accept-ranges": "bytes",
    "content-length": String(size),
    "last-modified": new Date(Math.floor(mtime) * 1000).toUTCString(),
    etag: `"${createHash("md5")
      .update(`${pyFloatRepr(mtime)}-${size}`)
      .digest("hex")}"`,
  };
  return rangedResponse(request, data, base);
}

export interface OpenedFile {
  /** Response owns/closes this descriptor, served in 64 KiB reads. */
  readonly handle: FileHandle;
  readonly size: number;
}

/**
 * Stream `parts` (literal bytes or [start, end) spans of the file) and close
 * the file when the body ends, fails, or the client goes away.
 */
function fileBody(
  file: OpenedFile,
  parts: readonly (Uint8Array | readonly [number, number])[],
): ReadableStream<Uint8Array> {
  async function* chunks() {
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        yield part;
        continue;
      }
      for (let at = part[0]; at < part[1]; ) {
        const chunk = new Uint8Array(Math.min(64 * 1024, part[1] - at));
        const { bytesRead } = await file.handle.read(
          chunk,
          0,
          chunk.length,
          at,
        );
        if (!bytesRead) throw new Error("file ended early");
        at += bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    }
  }
  const next = chunks();
  const close = () => file.handle.close().catch(() => {});
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await next.next();
        if (!step.done) return controller.enqueue(step.value);
        await close();
        controller.close();
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  });
}

// Answer GET/HEAD ranges over bytes or an open file; base supplies validators.
// If-Range must match; the response closes owned files when finished.
export function rangedResponse(
  request: Request,
  data: Uint8Array | OpenedFile,
  base: Readonly<Record<string, string>>,
): Response {
  const used = { streaming: false };
  try {
    return respondRanged(request, data, base, used);
  } finally {
    // Invariant: Only a streamed body still needs the file; it closes it
    // itself.
    if (!(data instanceof Uint8Array) && !used.streaming)
      void data.handle.close().catch(() => {});
  }
}

function respondRanged(
  request: Request,
  data: Uint8Array | OpenedFile,
  base: Readonly<Record<string, string>>,
  used: { streaming: boolean },
): Response {
  const bytes = data instanceof Uint8Array ? data : null;
  const size = bytes?.byteLength ?? (data as OpenedFile).size;
  const respond = (
    parts: (Uint8Array | readonly [number, number])[],
    status: number,
    headers: Record<string, string>,
  ): Response => {
    if (bytes === null && request.method === "HEAD") {
      const length = parts.reduce(
        (n, part) =>
          n + (part instanceof Uint8Array ? part.length : part[1] - part[0]),
        0,
      );
      return new Response(null, {
        status,
        headers: { ...headers, "content-length": String(length) },
      });
    }
    if (bytes === null) {
      // Invariant: Bun sends a stream chunked; a Content-Length would be
      // dropped.
      const { "content-length": _, ...unsized } = headers;
      used.streaming = true;
      return new Response(fileBody(data as OpenedFile, parts), {
        status,
        headers: unsized,
      });
    }
    const body = concatBytes(
      parts.map((part) =>
        part instanceof Uint8Array ? part : bytes.subarray(part[0], part[1]),
      ),
    );
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status,
      headers: { ...headers, "content-length": String(body.byteLength) },
    });
  };
  const contentType = base["content-type"]!;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const useRange =
    range !== null &&
    (ifRange === null ||
      ifRange === base["last-modified"] ||
      ifRange === base.etag);
  if (!useRange) {
    if (bytes !== null)
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: base });
    return respond([[0, size]], 200, { ...base });
  }
  let ranges: [number, number][];
  try {
    ranges = parseRangeHeader(range, size);
  } catch (error) {
    if (error instanceof RangeNotSatisfiable)
      return plainText(416, "", { "content-range": `bytes */${error.size}` });
    return plainText(400, (error as Error).message);
  }
  if (ranges.length === 1) {
    const [start, end] = ranges[0]!;
    return respond([[start, end]], 206, {
      ...base,
      "content-range": `bytes ${start}-${end - 1}/${size}`,
    });
  }
  const text = new TextEncoder();
  const boundary = randomBytes(13).toString("hex");
  const parts: (Uint8Array | readonly [number, number])[] = [];
  for (const [start, end] of ranges) {
    parts.push(
      text.encode(
        `--${boundary}\r\nContent-Type: ${contentType}\r\n` +
          `Content-Range: bytes ${start}-${end - 1}/${size}\r\n\r\n`,
      ),
      [start, end],
      text.encode("\r\n"),
    );
  }
  parts.push(text.encode(`--${boundary}--`));
  return respond(parts, 206, {
    ...base,
    "content-type": `multipart/byteranges; boundary=${boundary}`,
  });
}

export interface StaticRoutesDeps {
  readonly frontend: Pick<FrontendCache, "snapshot">;
  /** The checkout's web/dist, for uncommon auxiliary assets. */
  readonly staticDir: string;
  /** config.DISPLAY_NAME, substituted into the shell. */
  readonly displayName: string;
  /** This checkout's release, read once at startup (src/release.ts). */
  readonly release: Release;
  readonly themesFile: string;
  /** supervisor.readiness_snapshot: the one readiness authority. */
  readinessSnapshot(): unknown;
}

export function registerStaticRoutes(
  router: Router,
  deps: StaticRoutesDeps,
): void {
  router.get("/", async (ex) => {
    // Invariant: Derive the version from the same shell bytes that are served.
    const [shell, , version] = await deps.frontend.snapshot();
    const theme = await readTheme(deps.themesFile);
    const brand = brandResponse(
      await readBrand(brandingFile(dirname(deps.themesFile))),
      deps.displayName,
    );
    // Invariant: `?embed=1` (the Side pane's frame) is marked before first
    // paint, so the app chrome never flashes inside the frame.
    const embed = ex.url.searchParams.get("embed") === "1";
    const tokens: Record<string, string> = {
      __APP__: htmlEscape(brand.name),
      __VERSION__: version,
      __THEME__: theme.css,
    };
    const page = shell
      .replace("<html ", embed ? "<html data-embed " : "<html ")
      .replace(
        /(href|src)="\/static\/brand\/(?:favicon-32\.png|favicon\.svg|apple-touch-icon\.png|mark\.svg)"/gu,
        (original, attr: string) =>
          brand.icon ? `${attr}="${brand.icon}"` : original,
      )
      .replace(
        /(<link rel="icon"[^>]*type=")[^"]*"/gu,
        (original, prefix: string) =>
          brand.icon ? `${prefix}${brand.icon_type}"` : original,
      )
      .replace(/__APP__|__VERSION__|__THEME__/gu, (token) => tokens[token]!)
      .replace('id="theme"', `id="theme" data-version="${theme.version}"`);
    return conditionalBytes(ex.request, page, "text/html", PRIVATE_REVALIDATE);
  });

  router.get("/app-icon", async () => {
    const { icon } = await readBrand(brandingFile(dirname(deps.themesFile)));
    if (!icon) throw new HttpError(404);
    return new Response(new Uint8Array(Buffer.from(icon.data, "base64")), {
      headers: {
        "content-type": icon.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  router.get("/c/{cid}", async (ex) => {
    const cid = ex.params.cid!;
    if (!CID_RE.test(cid)) throw new HttpError(404);
    return new Response(null, {
      status: 307,
      headers: { location: `/#agent=${cid}`, "content-length": "0" },
    });
  });

  router.get("/api/version", async (ex) => {
    const [, , version] = await deps.frontend.snapshot();
    return conditionalJson(ex.request, {
      version,
      api: REMOTE_CONTROL_API,
      display_name:
        (await readBrand(brandingFile(dirname(deps.themesFile)))).name ??
        deps.displayName,
      release: deps.release,
      theme: (await readTheme(deps.themesFile)).version,
    });
  });

  router.get("/api/status", async () => {
    let snapshot: unknown = null;
    try {
      snapshot = deps.readinessSnapshot();
    } catch {
      snapshot = null;
    }
    const noStore = { "cache-control": "no-store" };
    if (
      snapshot !== null &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot) &&
      typeof (snapshot as Record<string, unknown>).ready === "boolean"
    ) {
      const { ready, active_agents: active = null } = snapshot as Record<
        string,
        unknown
      >;
      if (
        active === null ||
        (Number.isInteger(active) && (active as number) >= 0)
      )
        return jsonResponse({ ready, active_agents: active }, 200, noStore);
    }
    return jsonResponse({ ready: false, active_agents: null }, 200, noStore);
  });

  router.get(
    "/static/{path:path}",
    async (ex) => {
      // Invariant: Behind auth like the page itself; resolved inside staticDir
      // only.
      const path = ex.params.path!;
      const requested = ex.query.v ?? null;
      const [, cachedAssets, current] = await deps.frontend.snapshot();
      const cached = cachedAssets.get(path);
      const ext = suffix(path);
      if (cached !== undefined) {
        const media = STATIC_TYPES[ext] ?? "application/octet-stream";
        if (ext === ".js" && requested !== current)
          return reloadResponse(current);
        return conditionalBytes(
          ex.request,
          cached,
          media,
          requested === current ? IMMUTABLE_YEAR : PRIVATE_REVALIDATE,
        );
      }
      const base = await realpath(resolve(deps.staticDir)).catch(() =>
        resolve(deps.staticDir),
      );
      let full: string;
      try {
        full = await realpath(resolve(base, path));
      } catch {
        throw new HttpError(404);
      }
      if (full !== base && !full.startsWith(base + sep))
        throw new HttpError(404);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404);
      const name = basename(full);
      const fullExt = suffix(full);
      const media = STATIC_TYPES[fullExt] ?? "application/octet-stream";
      const isEntry = (FRONTEND_ASSET_NAMES as readonly string[]).includes(
        name,
      );
      const isChunk =
        fullExt === ".js" && !isEntry && SPLIT_CHUNK_RE.test(name);
      // Invariant: Never execute a new bundle inside an older HTML shell.
      if (fullExt === ".js" && isEntry && requested !== current)
        return reloadResponse(current);
      return fileResponse(ex.request, full, media, {
        "cache-control":
          requested === current || isChunk ? IMMUTABLE_YEAR : "no-cache",
      });
    },
    { query: { v: { type: "str" } } },
  );
}
