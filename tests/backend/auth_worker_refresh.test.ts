import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_ROOT, PI_PACKAGE_ROOT } from "../../src/build_dir";

const WORKER = join(CHECKOUT_ROOT, "src/pi_auth_worker.mjs");
const BODY_MARKER = "FAKE_TOKEN_BODY_MARKER_7f3a";
let work = "";
let server: ReturnType<typeof Bun.serve>;
let fail = false;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "recurse-auth-worker-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      if (fail || body.grant_type !== "refresh_token")
        return new Response(`{"error":"${BODY_MARKER}"}`, { status: 400 });
      return Response.json({
        access_token: "sk-ant-oat01-refreshed",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    },
  });
  writeFileSync(
    join(work, "preload.ts"),
    `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  appendFileSync(process.env.FAKE_RECORD!, url + "\\n");
  return real(process.env.FAKE_TOKEN_URL!, init);
}) as typeof fetch;
`,
  );
});

afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

async function refresh(name: string) {
  const dir = join(work, name);
  const authPath = join(dir, "auth.json");
  const record = join(dir, "urls.txt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(record, "");
  writeFileSync(
    authPath,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "sk-ant-oat01-expired",
        refresh: "refresh-1",
        expires: Date.now() - 60_000,
      },
    }),
    { mode: 0o600 },
  );
  const child = Bun.spawn(
    [process.execPath, "--preload", join(work, "preload.ts"), WORKER],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
        RECURSE_PI_AUTH_PATH: authPath,
        PI_OFFLINE: "1",
        FAKE_TOKEN_URL: `http://127.0.0.1:${server.port}/token`,
        FAKE_RECORD: record,
      },
      stdin: Buffer.from(
        `${JSON.stringify({ action: "resolve_anthropic" })}\n`,
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const urls = readFileSync(record, "utf8").split("\n").filter(Boolean);
  return { stdout, stderr, code, urls, stored: readFileSync(authPath, "utf8") };
}

test("a worker refresh posts to api.anthropic.com and stores the new token", async () => {
  fail = false;
  const result = await refresh("ok");
  expect(result.urls).toEqual(["https://api.anthropic.com/v1/oauth/token"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "credential",
    selected: true,
    credential_type: "oauth",
    value: "sk-ant-oat01-refreshed",
    changed: true,
  });
  expect(JSON.parse(result.stored).anthropic.refresh).toBe("refresh-2");
}, 60_000);

test("a failed worker refresh leaks no response body", async () => {
  fail = true;
  const result = await refresh("fail");
  expect(result.urls).toEqual(["https://api.anthropic.com/v1/oauth/token"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    kind: "error",
    reason: "operation_failed",
  });
  expect(result.stdout + result.stderr).not.toContain(BODY_MARKER);
  expect(JSON.parse(result.stored).anthropic.refresh).toBe("refresh-1");
}, 60_000);

// Regression: #2187 Settings login rewrites existing auth.json with mode 0600
test("a Settings login leaves an existing 0644 auth.json at 0600", async () => {
  const dir = mkdtempSync(join(work, "mode-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o644 });
  const credential = { type: "oauth", access: "a", refresh: "r", expires: 1 };
  const request = { action: "replace", provider: "openai-codex", credential };
  const child = Bun.spawn([process.execPath, WORKER], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
      RECURSE_PI_AUTH_PATH: authPath,
    },
    stdin: Buffer.from(`${JSON.stringify(request)}\n`),
    stdout: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  expect(JSON.parse(stdout)).toEqual({ kind: "complete", changed: true });
  expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
    "openai-codex": credential,
  });
  expect((await stat(authPath)).mode & 0o777).toBe(0o600);
}, 60_000);
