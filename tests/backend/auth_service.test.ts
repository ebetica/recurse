import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bearerParts,
  readServiceToken,
  serviceCapability,
  ServiceAuth,
  TOKEN_FILE_MAX_BYTES,
} from "../../src/auth/service";
import {
  clientIp,
  cookieValues,
  csrfOk,
  urlsplitNetloc,
} from "../../src/web/request_auth";
import { captureFixture } from "./fixture_subprocess";
import fixture from "./fixtures/auth_service/cases.json";

type Row = Record<string, any> & { kind: string };
const rows = fixture.cases as unknown as Row[];
const of = (kind: string) => rows.filter((row) => row.kind === kind);
const headersOf = (record: Record<string, string>) => ({
  get: (name: string) => record[name] ?? null,
});
const attempt = (fn: () => unknown) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).name };
  }
};

describe("service authentication", () => {
  test("bearer parse", () => {
    for (const row of of("bearer")) {
      const got = {
        with_file: bearerParts(row.header, true),
        without_file: bearerParts(row.header, false),
      };
      const scoped = [
        "Bearer recurse_alpha_secret",
        "Bearer recurse_alpha_sec_ret",
        `Bearer recurse_${"k".repeat(64)}_s`,
      ].includes(row.header);
      const plain = [
        "bearer plain-token",
        "BEARER plain-token",
        "Bearer tokén",
        "Bearer x,y",
        `Bearer ${"x".repeat(4089)}`,
      ].includes(row.header);
      expect(got.with_file !== null).toBe(scoped || plain);
      expect(got.without_file !== null).toBe(scoped);
    }
  });

  test("principal lookup over registry specs", async () => {
    for (const row of of("principal")) {
      const dir = await mkdtemp(join(tmpdir(), "auth-service-"));
      try {
        await writeFile(join(dir, "alpha"), "alpha-secret\n");
        await writeFile(join(dir, "empty"), "  \n");
        await writeFile(join(dir, "padded"), "\u00a0 alpha-secret \u3000");
        await writeFile(join(dir, "service"), "service-token");
        let principalsFile: string | null = null;
        if (row.registry !== null) {
          principalsFile = join(dir, "principals.json");
          await writeFile(
            principalsFile,
            row.registry.replaceAll("<DIR>", dir),
          );
        }
        const auth = new ServiceAuth({
          principalsFile,
          tokenFile: row.shorthand ? join(dir, row.shorthand) : null,
        });
        const caller = await auth.principal(row.path, row.header);
        expect(caller !== null).toBe(
          [
            "registry match",
            "unwrapped registry",
            "default scopes",
            "models and quota",
            "32 scopes",
            "long model",
            "null models",
            "principals null",
            "padded token file",
            "shorthand plain token",
            "shorthand as recurse id",
          ].includes(row.name),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("capability map", () => {
    for (const row of of("capability")) {
      const allowed =
        (row.method === "POST" &&
          [
            "/api/service/conversations",
            "/api/service/conversations/abc-1_2/messages",
          ].includes(row.path)) ||
        (row.method === "GET" &&
          [
            "/api/service/conversations/abc/replies",
            `/api/service/conversations/${"a".repeat(128)}/replies`,
          ].includes(row.path));
      expect(serviceCapability(row.method, row.path) !== null).toBe(allowed);
    }
  });
});

describe("request_auth tables", () => {
  test("raw request security boundaries", () => {
    for (const row of of("csrf")) {
      const got = attempt(() => csrfOk(row.method, headersOf(row.headers)));
      const safeMethod = ["GET", "HEAD", "OPTIONS", "TRACE"].includes(
        row.method,
      );
      const sameOriginControl = [
        ["https://app.example", "app.example"],
        ["http://app.example:8787", "app.example:8787"],
        ["null", ""],
        ["https://a@app.example", "a@app.example"],
        ["https://[::1]:8787", "[::1]:8787"],
        ["https://[v1.x]", "[v1.x]"],
        ["  https://app.example", "app.example"],
        ["https://app.ex\tample", "app.example"],
        ["app.example", ""],
        ["//app.example/x", "app.example"],
        ["https://app.example?x", "app.example"],
      ].some(
        ([origin, host]) =>
          row.headers.origin === origin && row.headers.host === host,
      );
      const noOriginControl =
        !row.headers.origin && row.headers["sec-fetch-site"] !== "cross-site";
      expect("value" in got && got.value === true).toBe(
        safeMethod || sameOriginControl || noOriginControl,
      );
    }
    expect(
      of("netloc").map((row) => attempt(() => urlsplitNetloc(row.url))),
    ).toEqual([
      { value: "app.example" },
      { value: "App.Example:80" },
      { value: "" },
      { value: "" },
      { value: "x" },
      { value: "" },
      { value: "" },
      { value: "u:p@h:1" },
      { value: "h" },
      { value: "h" },
      { value: "[::1]" },
      { error: "ValueError" },
      { error: "ValueError" },
      { error: "ValueError" },
      { value: "[fe80::1%eth0]" },
      { error: "ValueError" },
      { error: "ValueError" },
      { value: "[v7.abc]" },
      { error: "ValueError" },
      { value: "é.example" },
    ]);
    expect(
      of("client_ip").map((row) =>
        clientIp(
          headersOf(row.headers),
          row.peer === null ? null : { host: row.peer },
        ),
      ),
    ).toEqual([
      "9.9.9.9",
      "9.9.9.9",
      "5.6.7.8",
      "5.6.7.8",
      "10.0.0.1",
      "5.6.7.8",
      "10.0.0.1",
      "unknown",
    ]);
    expect(
      of("cookie").map((row) => Object.fromEntries(cookieValues(row.header))),
    ).toEqual([
      { chat_auth: ["abc"] },
      { a: ["1"], chat_auth: ["abc"], b: ["2"] },
      { chat_auth: ["first", "second"] },
      { chat_auth: ['quoted"value'] },
      { chat_auth: ["AB"] },
      { "": ["chat_auth"] },
      { "": ["chat_auth"] },
      { chat_auth: ["a=b"] },
      {},
      { chat_auth: ["x"] },
    ]);
  });
});

describe("service token targets", () => {
  test("missing, empty, non-regular, oversized, non-UTF-8, unreadable and FIFO targets fail closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auth-token-"));
    try {
      const target = join(dir, "target");
      const link = join(dir, "link");
      await writeFile(target, "service-token");
      await symlink(target, link);
      expect(await readServiceToken(link)).toBe("service-token");
      await writeFile(target, "rotated-token");
      expect(await readServiceToken(link)).toBe("rotated-token");
      await rm(target);
      expect(await readServiceToken(link)).toBeNull();
      await writeFile(target, "");
      expect(await readServiceToken(link)).toBeNull();
      await rm(target);
      await mkdir(target);
      expect(await readServiceToken(link)).toBeNull();
      await rm(target, { recursive: true });
      await writeFile(target, "x".repeat(TOKEN_FILE_MAX_BYTES + 1));
      expect(await readServiceToken(link)).toBeNull();
      await writeFile(target, "x".repeat(TOKEN_FILE_MAX_BYTES));
      expect(await readServiceToken(link)).toBe(
        "x".repeat(TOKEN_FILE_MAX_BYTES),
      );
      await writeFile(target, new Uint8Array([0xff]));
      expect(await readServiceToken(link)).toBeNull();
      if (process.getuid?.() !== 0) {
        await writeFile(target, "service-token");
        await chmod(target, 0);
        expect(await readServiceToken(link)).toBeNull();
        await chmod(target, 0o644);
      }
      const fifo = join(dir, "fifo");
      await captureFixture(["mkfifo", fifo]);
      expect(await readServiceToken(fifo)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unknown key id and wrong secret fail identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auth-idor-"));
    try {
      await writeFile(join(dir, "alpha"), "alpha-secret");
      const registry = join(dir, "principals.json");
      await writeFile(
        registry,
        JSON.stringify({
          principals: {
            alpha: {
              token_file: join(dir, "alpha"),
              scopes: ["conversation.create"],
            },
            broken: {
              token_file: join(dir, "missing"),
              scopes: ["conversation.create"],
            },
          },
        }),
      );
      const auth = new ServiceAuth({
        principalsFile: registry,
        tokenFile: null,
      });
      for (const header of [
        "Bearer recurse_unknown_alpha-secret",
        "Bearer recurse_alphaa_alpha-secret",
        "Bearer recurse_broken_anything",
        "Bearer recurse_alpha_wrong",
      ])
        expect(
          await auth.principal("/api/service/conversations", header),
        ).toBeNull();
      await writeFile(join(dir, "alpha"), "alpha-rotated");
      expect(
        await auth.principal(
          "/api/service/conversations",
          "Bearer recurse_alpha_alpha-secret",
        ),
      ).toBeNull();
      expect(
        (
          await auth.principal(
            "/api/service/conversations",
            "Bearer recurse_alpha_alpha-rotated",
          )
        )?.principal,
      ).toBe("alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
