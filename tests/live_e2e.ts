import { Database } from "bun:sqlite";
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertAuthUnchanged,
  assertOAuthCredentialsFresh,
  liveModel,
  liveSecondModel,
  prepare,
  ROOT,
  stopServer,
  survivors,
  validateSecondModelReplies,
  type LiveJson,
  type Prepared,
} from "./live_e2e_helpers.ts";

type Json = LiveJson;
type LiveProcess = {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
};
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function openServerLog(path: string): number {
  return openSync(path, "a");
}

export async function request(
  base: string,
  route: string,
  body?: unknown,
): Promise<Json> {
  if (!base.startsWith("http://127.0.0.1:"))
    throw new Error("private loopback only");
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${route}`);
  return (await response.json()) as Json;
}

export async function waitReady(
  base: string,
  process: LiveProcess,
): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null)
      throw new Error("private server exited during startup");
    try {
      if ((await request(base, "api/status")).ready === true) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("private server startup timed out");
}

export async function waitSettled(
  base: string,
  cid: string,
  prior: string | null,
  seconds = 1800,
): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const [conv, view] = await Promise.all([
      request(base, `api/conversations/${cid}`),
      request(base, `api/conversations/${cid}/view`),
    ]);
    const blocks = (view.blocks as Json[] | undefined) ?? [];
    const reply = [...blocks]
      .reverse()
      .find((row) => row.role === "assistant" && !row.live);
    if (conv.status === "idle" && reply && reply.id !== prior)
      return String(reply.id);
    await sleep(2000);
  }
  throw new Error("model turn did not settle");
}

async function viewPages(base: string, cid: string): Promise<Json[]> {
  const pages: Json[] = [];
  const seen = new Set<string>();
  let route = `api/conversations/${cid}/view?limit=100`;
  while (!seen.has(route)) {
    seen.add(route);
    const page = await request(base, route);
    pages.push(page);
    const blocks = (page.blocks as Json[] | undefined) ?? [];
    if (!page.older || !blocks.length) return pages;
    route = `api/conversations/${cid}/view?limit=100&before=${encodeURIComponent(String(blocks[0].id))}`;
  }
  throw new Error("/view cursor repeated");
}

export async function readDurableEntries(
  privateRoot: string,
  cid: string,
): Promise<Json[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(cid))
    throw new Error("invalid private conversation id");
  const directory = join(privateRoot, "data/conversations", cid, "durable");
  const path = await realpath(join(directory, "session.sqlite"));
  if (
    dirname(path) !== (await realpath(directory)) ||
    !path.startsWith((await realpath(privateRoot)) + "/")
  )
    throw new Error("private Durable store escaped private root");
  const db = new Database(path, { readonly: true });
  try {
    const entries: Json[] = [];
    let cursor = 0;
    while (true) {
      const rows = db
        .query<
          { id: number; record: string },
          [number]
        >("SELECT id, record FROM entries WHERE id > ? ORDER BY id LIMIT 100")
        .all(cursor);
      if (!rows.length) return entries;
      entries.push(...rows.map((row) => JSON.parse(row.record) as Json));
      cursor = rows[rows.length - 1].id;
    }
  } finally {
    db.close();
  }
}

export async function ownSession(
  privateRoot: string,
  cid: string,
  _sessionId: string,
): Promise<string> {
  const path = join(privateRoot, "data/conversations", cid, "session.jsonl");
  await retainSession(privateRoot, cid, path);
  return path;
}

async function retainSession(
  privateRoot: string,
  cid: string,
  path: string,
): Promise<Json[]> {
  const entries = await readDurableEntries(privateRoot, cid);
  await writeFile(
    path,
    entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
  );
  return entries;
}

export async function waitModels(
  base: string,
  primary: string,
  secondModel: boolean,
  milliseconds = 60_000,
): Promise<{ catalog: Json; second: string | undefined }> {
  const deadline = Date.now() + milliseconds;
  let second: string | undefined;
  while (Date.now() < deadline) {
    const catalog = await request(base, "api/models");
    const models = catalog.models as Json[];
    const ids = new Set(models.map((model) => model.id));
    if (secondModel && !second) second = liveSecondModel(models);
    if (ids.has(primary) && (!secondModel || (second && ids.has(second))))
      return { catalog, second };
    await sleep(300);
  }
  throw new Error(
    `private model list timed out waiting for ${primary}${secondModel ? ` and ${second ?? "a second authenticated provider route"}` : ""}`,
  );
}

export async function secondModelTurn(
  base: string,
  privateRoot: string,
  output: string,
  model: string,
): Promise<void> {
  const cid = String(
    (await request(base, "api/conversations", { parent: null, model })).id,
  );
  if (
    (
      await request(base, `api/conversations/${cid}/deliver`, {
        content: "Reply with exactly SECOND_MODEL_OK and nothing else.",
      })
    ).ok !== true
  )
    throw new Error("second-model admission failed");
  await waitSettled(base, cid, null, 600);
  const rows = await retainSession(
    privateRoot,
    cid,
    join(output, "second-model-session.jsonl"),
  );
  const replies = rows
    .flatMap((row) => row.model ?? [])
    .filter((message: Json) => message.role === "assistant");
  validateSecondModelReplies(replies, model);
  console.log(`second model ${model}: ${replies.length} replies on that route`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

export async function run(args = process.argv.slice(2)): Promise<void> {
  const verifyLive = args.includes("--verify-live");
  const secondModel = args.includes("--second-model");
  const commandArg = argValue(args, "--server-command");
  const source = process.env.PI_CODING_AGENT_DIR;
  if (!source || !existsSync(join(source, "auth.json")))
    throw new Error("logged-in PI_CODING_AGENT_DIR/auth.json required");
  const privateRoot = await mkdtemp(
    join(process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(), "recurse-live-e2e-"),
  );
  let prepared: Prepared;
  try {
    prepared = await prepare(privateRoot, source, commandArg);
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
  const { env, auth, target, base, output, command } = prepared;

  const log = join(output, "server.log");
  const logFd = openServerLog(log);
  let server: LiveProcess | null = null;
  let cid: string | null = null;
  let evidenceError: unknown = null;
  let cleanupError: unknown = null;
  let authError: unknown = null;
  const spawn = () =>
    Bun.spawn(["setsid", ...command], {
      cwd: ROOT,
      env,
      stdout: logFd,
      stderr: logFd,
    });
  try {
    assertOAuthCredentialsFresh(await readFile(auth, "utf8"));
    console.log(`starting private launcher; log=${log}`);
    server = spawn();
    if (!server) throw new Error("private server failed to spawn");
    await waitReady(base, server);
    console.log("private server ready");
    const primary = liveModel("anthropic");
    const { catalog, second } = await waitModels(base, primary.id, secondModel);
    const providers = catalog.providers as Json[];
    if (
      !providers?.some(
        (provider) => provider.id === "claude" && provider.authed,
      )
    )
      throw new Error("Claude not authenticated in private root");
    cid = String(
      (
        await request(base, "api/conversations", {
          parent: null,
          model: primary.id,
        })
      ).id,
    );
    let prompt = await readFile(join(ROOT, "tests/live_e2e_prompt.md"), "utf8");
    prompt = prompt
      .replaceAll("{{workdir}}", target)
      .replaceAll("{{creator_cid}}", cid)
      .replaceAll("{{final_marker}}", "LIVE_E2E_OK_47");
    const parts = prompt.split(/(?=^\d+\. \*\*)/m);
    const intro = parts.shift() ?? "";
    if (parts.length !== 13)
      throw new Error("committed prompt must have 13 numbered steps");
    let prior: string | null = null;
    const spans: [number, number][] = [
      [0, 4],
      [4, 8],
      [8, 10],
      [10, 13],
    ];
    for (const [index, [from, to]] of spans.entries()) {
      const content =
        (index === 0 ? intro : "Continue the private test.\n") +
        parts.slice(from, to).join("");
      if (
        (await request(base, `api/conversations/${cid}/deliver`, { content }))
          .ok !== true
      )
        throw new Error(`phase ${index + 1} admission failed`);
      prior = await waitSettled(base, cid, prior);
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.locator("#messages").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(500);
      const picture = join(output, "screenshots", `phase-${index + 1}.png`);
      await page.screenshot({ path: picture, fullPage: true });
      if ((await stat(picture)).size <= 100)
        throw new Error(`phase ${index + 1} screenshot empty`);
      await browser.close();
      console.log(`phase ${index + 1} screenshot saved`);
    }
    if (second) await secondModelTurn(base, privateRoot, output, second);
    console.log(`VERIFY base=${base} cid=${cid} evidence=${output}`);
    if (verifyLive) {
      const deadline = Date.now() + 3_600_000;
      while (!existsSync(join(output, "finish")) && Date.now() < deadline) {
        if (existsSync(join(output, "restart"))) {
          unlinkSync(join(output, "restart"));
          if (!server) throw new Error("private server is not running");
          await stopServer(server);
          server = spawn();
          await waitReady(base, server);
          console.log("private server restarted");
        } else if (server.exitCode !== null)
          throw new Error("private server exited during verification");
        await sleep(1000);
      }
    }
  } finally {
    if (cid && server && server.exitCode === null) {
      try {
        const pages = await viewPages(base, cid);
        await writeFile(join(output, "view-pages.json"), JSON.stringify(pages));
        await retainSession(privateRoot, cid, join(output, "session.jsonl"));
      } catch (error) {
        evidenceError = error;
      }
    }
    if (server) {
      try {
        await stopServer(server);
      } catch (error) {
        cleanupError = error;
      }
    }
    closeSync(logFd);
    try {
      assertAuthUnchanged(prepared.authSnapshot, await readFile(auth, "utf8"));
    } catch (error) {
      authError = error;
    }
    await rm(auth, { force: true });
    try {
      await cp(privateRoot, join(output, "private-root"), {
        recursive: true,
        filter: (source) =>
          !source.endsWith("auth.json") && !source.endsWith("server.json"),
      });
    } catch (error) {
      evidenceError ??= error;
    }
    const remaining = survivors(privateRoot);
    console.log(`EVIDENCE ${output}; survivors=${remaining}`);
    await rm(privateRoot, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
    if (authError) throw authError;
    if (remaining.length)
      throw new Error(`private Pi/shell survivors: ${remaining.join(", ")}`);
    if (evidenceError) throw evidenceError;
  }
  if (
    !existsSync(join(output, "view-pages.json")) ||
    !existsSync(join(output, "session.jsonl"))
  )
    throw new Error("creator Pi session or /view evidence missing");
}

if (import.meta.main)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
