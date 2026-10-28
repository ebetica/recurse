// Build app Artifacts privately into self-contained sandboxed pages.
// Drop bunfig; never run lifecycle scripts/macros or build in the workspace.
// Children get only PATH/private HOME/temp/cache, never server credentials.
// Detached groups die on timeout; theme/error relay precede page scripts.

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prependToHead } from "./theme";

export const APP_ENTRY = "index.html";
const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 60_000;
const LOG_MAX_CHARS = 4_000;

// First-script pane error/CSP relay; inactive outside an embedding pane.
export const PAGE_ERROR_RELAY =
  '<script id="recurse-errors">(()=>{if(parent===window)return;' +
  'const send=(t)=>{try{parent.postMessage({recurseArtifactError:String(t).slice(0,1000)},"*")}catch{}};' +
  'const text=(r)=>r instanceof Error?r.name+": "+r.message:String(r);' +
  'addEventListener("error",(e)=>send(e.error!==undefined&&e.error!==null?text(e.error):e.message));' +
  'addEventListener("unhandledrejection",(e)=>send("Unhandled promise rejection: "+text(e.reason)));' +
  'document.addEventListener("securitypolicyviolation",(e)=>send("The sandbox blocked "+(e.blockedURI||"a resource")+" ("+e.effectiveDirective+")"))' +
  "})()</script>";

export type AppBuild =
  | { ok: true; html: Buffer; sourceMap: string | null }
  | { ok: false; log: string };

/**
 * Run a child in its own process group; the whole group dies on timeout. Its
 * environment is only PATH plus HOME, temp, and Bun's cache under `home`.
 */
export async function run(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  home: string,
): Promise<{ code: number; log: string }> {
  const child = Bun.spawn([...argv], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      BUN_INSTALL_CACHE_DIR: join(home, "cache"),
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const log = `${out}\n${err}`.trim();
    if (timedOut)
      return { code: 1, log: `timed out after ${timeoutMs / 1000}s\n${log}` };
    return { code, log };
  } finally {
    clearTimeout(timer);
    kill();
  }
}

/** Keep the end of a log, where Bun prints its errors, within a bound. */
function tail(log: string): string {
  return log.length > LOG_MAX_CHARS ? `…${log.slice(-LOG_MAX_CHARS)}` : log;
}

// Build the app made of `paths`, whose bytes `read` returns. Paths must already
// be validated relative paths. With `sourceMap`, also return Bun's external
// source map so a checker can name the source line of an error.
export async function buildPage(
  paths: readonly string[],
  read: (path: string) => Promise<Uint8Array<ArrayBuffer>>,
  options: { sourceMap?: boolean; maxBytes: number },
): Promise<AppBuild> {
  if (!paths.includes(APP_ENTRY))
    return { ok: false, log: `an app needs ${APP_ENTRY} at the top level` };
  const scratch = await mkdtemp(join(tmpdir(), "recurse-artifact-build-"));
  try {
    const src = join(scratch, "src");
    const home = join(scratch, "home");
    await mkdir(home);
    for (const path of paths) {
      if (path === "bunfig.toml") continue;
      await mkdir(dirname(join(src, path)), { recursive: true });
      await writeFile(join(src, path), await read(path));
    }
    if (paths.includes("package.json")) {
      const install = await run(
        [process.execPath, "install", "--ignore-scripts", "--no-progress"],
        src,
        INSTALL_TIMEOUT_MS,
        home,
      );
      if (install.code !== 0)
        return { ok: false, log: tail(`bun install failed\n${install.log}`) };
    }
    const out = join(scratch, "out");
    const build = await run(
      [
        process.execPath,
        "build",
        "--no-macros",

        APP_ENTRY,
        "--compile",
        "--target=browser",
        "--minify",
        `--outdir=${out}`,
        ...(options.sourceMap ? ["--sourcemap=external"] : []),
      ],
      src,
      BUILD_TIMEOUT_MS,
      home,
    );
    if (build.code !== 0)
      return { ok: false, log: tail(`bun build failed\n${build.log}`) };
    const page = join(out, APP_ENTRY);
    if ((await stat(page)).size > options.maxBytes)
      return { ok: false, log: "the built page is too large" };
    let sourceMap: string | null = null;
    if (options.sourceMap) {
      const glob = new Bun.Glob("*.js.map");
      for await (const name of glob.scan(out)) {
        sourceMap = await readFile(join(out, name), "utf8");
        break;
      }
    }
    const html = prependToHead(await readFile(page, "utf8"), PAGE_ERROR_RELAY);
    return { ok: true, html: Buffer.from(html), sourceMap };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
