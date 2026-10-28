import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exchange,
  normalise,
  requestBytes,
  type CaseRequest,
} from "./http_corpus";
import { buildAuthApp, type AuthApp } from "./http_auth_app";
import fixture from "./fixtures/http_auth/cases.json";

interface AuthCase {
  readonly name: string;
  readonly setup?: { auth?: "env" | "none"; save_cookie?: boolean };
  readonly request: CaseRequest;
  readonly current: {
    readonly status: number;
    readonly calls: number;
    readonly body?: unknown;
    readonly validation?: string;
    readonly cookie?: "issue" | "clear" | "none";
    readonly password_value?: string;
  };
}
const CASES = fixture.cases as unknown as AuthCase[];
const REFUSED_COOKIES = new Set([
  "page without cookie",
  "api without cookie",
  "tampered cookie",
  "expired cookie",
  "garbage cookie",
  "duplicate cookie last wins",
  "saved cookie voided by rotation",
  "loopback wrong token",
  "loopback token via proxy",
  "loopback token off api",
]);

let app: AuthApp;
let dir: string;
let now: number;

beforeAll(async () => {
  now = Date.now() / 1000;
  dir = await mkdtemp(join(tmpdir(), "http-auth-"));
  app = await buildAuthApp(dir, { sleep: async () => {}, now: () => now });
});
afterAll(async () => {
  await app.running.close();
  await rm(dir, { recursive: true, force: true });
});

async function sign(exp: number): Promise<string> {
  const creds = (await app.operator.currentCreds())!;
  const key = createHash("sha256")
    .update(new Uint8Array(Buffer.from(creds[1], "hex")))
    .update(":cookie-signing")
    .digest();
  return `${exp}.${createHmac("sha256", new Uint8Array(key)).update(String(exp)).digest("hex")}`;
}

describe("http_auth corpus", () => {
  test("requests enforce current authentication and login policy", async () => {
    let last = "";
    let saved = "";
    for (const item of CASES) {
      const callsBefore = app.calls.count;
      if (item.setup?.auth) {
        await unlink(join(dir, "auth.json")).catch(() => {});
        for (const key of Object.keys(app.envCreds)) delete app.env[key];
        if (item.setup.auth === "env") Object.assign(app.env, app.envCreds);
      }
      if (item.setup?.save_cookie) saved = await app.operator.makeToken();
      const headers: [string, string][] = [];
      for (const [name, raw] of item.request.headers ?? []) {
        let value = raw;
        if (value.includes("<cookie:valid>"))
          value = value.replace(
            "<cookie:valid>",
            await app.operator.makeToken(),
          );
        if (value.includes("<cookie:tampered>")) {
          const token = await app.operator.makeToken();
          value = value.replaceAll(
            "<cookie:tampered>",
            token.slice(0, -1) + (token.at(-1) !== "0" ? "0" : "1"),
          );
        }
        if (value.includes("<cookie:expired>"))
          value = value.replaceAll(
            "<cookie:expired>",
            await sign(Math.floor(now) - 10),
          );
        value = value
          .replaceAll("<cookie:last>", last)
          .replaceAll("<cookie:saved>", saved);
        if (value.includes("<loopback>")) {
          const published = JSON.parse(
            await readFile(join(dir, "server.json"), "utf8"),
          );
          value = value.replaceAll("<loopback>", published.token);
        }
        headers.push([name, value]);
      }
      const raw = await exchange(
        app.running.port,
        requestBytes({ ...item.request, headers }),
      );
      const match = /set-cookie: chat_auth=(\d+\.[0-9a-f]{64})/i.exec(
        Buffer.from(raw).toString("latin1"),
      );
      if (match) last = match[1]!;
      const response = normalise(raw, item.request.method);
      if (REFUSED_COOKIES.has(item.name))
        expect(response.status, item.name).toBe(401);
      if (
        (item.name.startsWith("cross-site") &&
          item.name !== "cross-site get passes") ||
        [
          "sec-fetch-site cross-site",
          "duplicate sec-fetch-site cross-site first",
          "open mode csrf still applies",
        ].includes(item.name)
      )
        expect(response.status, item.name).toBe(403);
      if (
        [
          "api with valid cookie",
          "issued cookie authenticates",
          "loopback token",
          "reissued cookie works",
        ].includes(item.name)
      )
        expect(response.status, item.name).toBe(200);
      const current = item.current;
      expect(response.status, item.name).toBe(current.status);
      expect(app.calls.count - callsBefore, item.name).toBe(current.calls);
      if (current.body) expect(response.body, item.name).toEqual(current.body);
      if (current.validation) {
        const detail = (
          response.body as { json: { detail: { type: string }[] } }
        ).json.detail;
        expect(detail[0]?.type, item.name).toBe(current.validation);
      }
      if (
        [
          "service foreign cid",
          "service missing cid",
          "service read foreign",
        ].includes(item.name)
      )
        expect(response.body, item.name).toEqual({
          json: { detail: "conversation not found" },
        });
      if (response.status === 405)
        expect(response.headers.allow, item.name).toBe("POST");
      if (response.status === 429 && item.request.path === "/login")
        expect(response.headers["retry-after"], item.name).toMatch(
          /^[1-9]\d*$/,
        );
      if (response.status === 303)
        expect(response.headers.location, item.name).toBe("/");
      if (current.cookie === "issue" || current.cookie === "clear") {
        const cookie = response.headers["set-cookie"] ?? "";
        for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/"])
          expect(cookie, item.name).toContain("; " + flag);
        if (current.cookie === "issue") {
          expect(cookie, item.name).toMatch(/^chat_auth=\d+\.[0-9a-f]{64};/);
          expect(cookie, item.name).toContain("; Max-Age=2592000;");
          expect(await app.operator.checkToken(match?.[1]), item.name).toBe(
            true,
          );
        } else {
          expect(cookie, item.name).toContain('chat_auth="";');
          expect(cookie, item.name).toContain("; Max-Age=0;");
        }
      }
      if (current.cookie === "none")
        expect(response.headers["set-cookie"], item.name).toBeUndefined();
      if (item.request.path === "/api/password" && current.status === 200) {
        const stored = JSON.parse(
          await readFile(join(dir, "auth.json"), "utf8"),
        );
        expect(Object.keys(stored).sort(), item.name).toEqual(["hash", "salt"]);
        expect(stored.salt, item.name).toMatch(/^[0-9a-f]{32}$/);
        expect(stored.hash, item.name).toMatch(/^[0-9a-f]{64}$/);
      }
      if (current.password_value !== undefined) {
        const value = /name="password"\s+value="([^"]*)"/.exec(
          Buffer.from(raw).toString("utf8"),
        )?.[1];
        expect(value, item.name).toBe(current.password_value);
      }
    }
    expect(CASES).toHaveLength(114);
    expect(CASES.filter((c) => c.current.body)).toHaveLength(82);
    expect(CASES.filter((c) => c.current.cookie)).toHaveLength(8);
    expect(CASES.filter((c) => c.current.calls === 1)).toHaveLength(24);
    expect(CASES.filter((c) => c.current.cookie === "issue")).toHaveLength(6);
    expect(CASES.filter((c) => c.current.validation)).toHaveLength(5);
    expect(
      CASES.filter((c) => c.current.password_value !== undefined),
    ).toHaveLength(4);
  }, 120_000);
});
