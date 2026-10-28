import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { decoderStats } from "../../src/http_transport";
import { ConnectedBackends } from "../../src/backends/connected";
import { registerSettingsSyncRoutes } from "../../src/web/settings_sync";
import {
  LOGIN_FORGET,
  LOGIN_LOCK_CAP,
  LOGIN_MAX_FREE,
  LoginThrottle,
  publishLoopbackToken,
} from "../../src/web/request_auth";
import { resolvePeer } from "../../src/server";
import {
  exchange,
  normalise,
  requestBytes,
  type CaseRequest,
} from "./http_corpus";
import {
  buildAuthApp,
  PASSWORD,
  stubResponse,
  type AuthApp,
} from "./http_auth_app";

let app: AuthApp;
let dir: string;
let clock = 1_790_000_000;
const slept: number[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "request-auth-"));
  app = await buildAuthApp(dir, {
    now: () => clock,
    sleep: async (seconds) => void slept.push(seconds),
  });
});
afterAll(async () => {
  await app.running.close();
  await rm(dir, { recursive: true, force: true });
});

// Feature: #2673 Backend keys are password-minted, scoped, and immediately revocable over HTTP.
test("backend key lifecycle preserves operator and service boundaries", async () => {
  const keyDir = await mkdtemp(join(tmpdir(), "backend-keys-"));
  const connections = await ConnectedBackends.load(keyDir, "home", () => {});
  const syncPaths = [
    "/api/settings/effort-levels",
    "/api/settings/default-efforts",
    "/api/settings/maximum-context-window",
    "/api/settings/theme",
  ];
  const keyApp = await buildAuthApp(keyDir, {
    extraRoutes: (router) => {
      registerSettingsSyncRoutes(router, connections);
      for (const path of syncPaths)
        router.add(["GET", "POST"], path, (ex) => stubResponse(ex, path));
    },
    backendKeys: true,
    sleep: async () => {},
  });
  const url = `http://127.0.0.1:${keyApp.running.port}`;
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const mint = async (name: string) => {
    const response = await call(
      "POST",
      "/api/backend-keys",
      {},
      { name, password: PASSWORD },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string; name: string; key: string };
  };
  try {
    expect(
      (
        await call(
          "POST",
          "/api/backend-keys",
          { origin: "https://evil.example" },
          { name: "home", password: PASSWORD },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/api/backend-keys",
          {},
          { name: "home", password: "wrong" },
        )
      ).status,
    ).toBe(401);
    expect(keyApp.throttle.fails.has("127.0.0.1")).toBe(true);
    expect(
      (
        await call(
          "POST",
          "/api/backend-keys",
          {},
          { name: "invalid name", password: PASSWORD },
        )
      ).status,
    ).toBe(422);
    const plain = await fetch(url + "/api/backend-keys", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "home", password: PASSWORD }),
    });
    expect(plain.status).toBe(422);
    expect(await plain.text()).not.toContain(PASSWORD);
    const home = await mint("home");
    const bearer = { authorization: `Bearer ${home.key}` };
    expect(
      (
        await call("GET", "/api/tree", {
          authorization: `Bearer ${home.key.slice(0, -1)}${home.key.endsWith("0") ? "1" : "0"}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("GET", "/api/tree", {
          authorization: `Bearer recurse-link_0000000000000000_${home.key.split("_").at(-1)}`,
        })
      ).status,
    ).toBe(401);
    const tree = await call("GET", "/api/tree", bearer);
    expect(tree.status).toBe(200);
    expect(await tree.json()).toMatchObject({
      auth_method: "backend-key",
      principal: "backend-key:home",
    });
    for (const path of syncPaths)
      for (const method of ["GET", "POST"])
        expect((await call(method, path, bearer)).status).toBe(200);
    const loopback = {
      "x-loopback-token": JSON.parse(
        await readFile(join(keyDir, "server.json"), "utf8"),
      ).token,
    };
    for (const method of ["GET", "POST"])
      for (const headers of [bearer, loopback])
        expect(
          (await call(method, "/api/backends/remote/settings-sync", headers))
            .status,
        ).toBe(403);
    for (const [method, path] of [
      ["GET", "/api/settings/mcp-servers"],
      ["PUT", "/api/settings/mcp-servers"],
      ["POST", "/api/settings/mcp-servers/check"],
      ["GET", "/api/pi/auth"],
      ["POST", "/api/pi/auth/api-key"],
      ["POST", "/api/pi/custom-provider-auth/custom/api-key"],
    ])
      expect((await call(method!, path!, bearer)).status).not.toBe(403);
    for (const [method, path] of [
      ["POST", "/api/settings/mcp-servers/sign-in"],
      ["GET", "/api/settings/mcp-servers/oauth-callback"],
      ["POST", "/api/password"],
      ["POST", "/api/pi/login"],
      ["GET", "/api/backend-keys"],
      ["POST", "/api/backend-keys"],
      ["DELETE", `/api/backend-keys/${home.id}`],
      ["POST", "/api/service/conversations"],
      ["GET", "/api/settings/models"],
      ["POST", "/logout"],
      ["POST", "/login"],
    ]) {
      const response = await call(method!, path!, bearer);
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await response.json()).toEqual({
        detail: "backend key not allowed here",
      });
    }
    const service = {
      authorization: `Bearer recurse_alpha_${(await readFile(join(keyDir, "alpha-token"), "utf8")).trim()}`,
    };
    expect((await call("GET", "/api/tree", service)).status).toBe(403);
    expect(
      (await call("DELETE", "/api/backend-keys/self", service)).status,
    ).toBe(403);
    expect(
      (
        await call("GET", "/api/backend-keys", {
          "x-loopback-token": JSON.parse(
            await readFile(join(keyDir, "server.json"), "utf8"),
          ).token,
        })
      ).status,
    ).toBe(403);
    const operator = {
      cookie: `chat_auth=${await keyApp.operator.makeToken()}`,
    };
    const listed = (await (
      await call("GET", "/api/backend-keys", operator)
    ).json()) as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual([
      "created",
      "id",
      "last_used",
      "name",
    ]);
    const stored = await readFile(join(keyDir, "backend-keys.json"), "utf8");
    expect(stored).not.toContain(home.key);
    expect(stored).not.toContain(home.key.split("_").at(-1)!);
    expect((await stat(join(keyDir, "backend-keys.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect(JSON.stringify(keyApp.records)).not.toContain(home.key);
    expect(
      (await call("DELETE", "/api/backend-keys/self", bearer)).status,
    ).toBe(200);
    expect((await call("GET", "/api/tree", bearer)).status).toBe(401);
    const second = await mint("second");
    const third = await mint("third");
    expect(
      (await call("DELETE", `/api/backend-keys/${second.id}`, operator)).status,
    ).toBe(200);
    expect(
      (
        await call("GET", "/api/tree", {
          authorization: `Bearer ${second.key}`,
        })
      ).status,
    ).toBe(401);
    const [racingMint, rotation] = await Promise.all([
      call(
        "POST",
        "/api/backend-keys",
        {},
        { name: "racing", password: PASSWORD },
      ),
      call("POST", "/api/password", operator, {
        current: PASSWORD,
        new: `${PASSWORD}-changed`,
      }),
    ]);
    expect(rotation.status).toBe(200);
    expect([200, 401]).toContain(racingMint.status);
    if (racingMint.status === 200) {
      const racing = (await racingMint.json()) as { key: string };
      expect(
        (
          await call("GET", "/api/tree", {
            authorization: `Bearer ${racing.key}`,
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await call("GET", "/api/tree", { authorization: `Bearer ${third.key}` }))
        .status,
    ).toBe(401);
  } finally {
    await keyApp.running.close();
    await rm(keyDir, { recursive: true, force: true });
  }
});

type H = [string, string][];
async function send(
  method: string,
  path: string,
  headers: H = [],
  body?: string | Uint8Array,
) {
  const request: CaseRequest = {
    method,
    path,
    headers,
    ...(body === undefined
      ? {}
      : typeof body === "string"
        ? { body: { text: body } }
        : { body: { hex: Buffer.from(body).toString("hex") } }),
  };
  const raw = await exchange(app.running.port, requestBytes(request));
  return normalise(raw, method);
}
const json = (r: { body: unknown }) => (r.body as { json?: any }).json;
const cookie = async () =>
  ["Cookie", `chat_auth=${await app.operator.makeToken()}`] as [string, string];
const EVIL: H = [
  ["Origin", "https://evil.example"],
  ["Host", "127.0.0.1"],
];

const concrete = (template: string) =>
  template.replace(/\{(\w+):path\}/g, "a/b").replace(/\{(\w+)\}/g, "owned-cid");

async function stateDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const name of (await readdir(dir)).sort()) {
    const info = await stat(join(dir, name));
    hash.update(`${name}:${info.size}:`);
    if (info.isFile())
      hash.update(new Uint8Array(await readFile(join(dir, name))));
  }
  return `${hash.digest("hex")}:${app.calls.count}`;
}

describe("invariant 1: no credential -> refusal (every route)", () => {
  test("every route and method without a cookie", async () => {
    const routes = app.router.routes();
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes)
      for (const method of route.methods) {
        const path = concrete(route.path);
        const before = app.calls.count;
        const got = await send(
          method,
          path,
          [],
          method === "GET" || method === "HEAD" ? undefined : "{}",
        );
        if (route.path === "/login") {
          expect(got.status).toBe(401);
          expect(app.throttle.fails.has("127.0.0.1")).toBe(true);
          app.throttle.recordSuccess("127.0.0.1");
          continue;
        }
        expect([method, route.path, got.status]).toEqual([
          method,
          route.path,
          401,
        ]);
        if (method !== "HEAD") {
          if (path.startsWith("/api/"))
            expect(json(got)).toEqual({ detail: "unauthorized" });
          else
            expect(got.headers["content-type"]).toBe(
              "text/html; charset=utf-8",
            );
        }
        expect(app.calls.count).toBe(before);
      }
  });

  test("open mode only when neither auth.json nor env has a credential", async () => {
    expect(await app.operator.enabled()).toBe(true);
    const saved = { ...app.env };
    for (const key of Object.keys(app.envCreds)) delete app.env[key];
    try {
      expect(json(await send("GET", "/api/tree")).auth_method).toBe("local");
      app.env.CHAT_AUTH_SALT = app.envCreds.CHAT_AUTH_SALT;
      expect(json(await send("GET", "/api/tree")).auth_method).toBe("local");
    } finally {
      Object.assign(app.env, saved);
    }
  });
});

describe("invariant 5: CSRF before auth (every mutating route)", () => {
  test("cross-site Origin gets 403 and leaves state unchanged", async () => {
    for (const route of app.router.routes())
      for (const method of route.methods) {
        if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) continue;
        const path = concrete(route.path);
        const before = await stateDigest();
        for (const headers of [
          [...EVIL, await cookie()],
          [["Sec-Fetch-Site", "cross-site"], await cookie()],
          EVIL,
        ] as H[]) {
          const got = await send(method, path, headers, "{}");
          expect([method, route.path, got.status]).toEqual([
            method,
            route.path,
            403,
          ]);
        }
        expect(await stateDigest()).toBe(before);
      }
  });

  test("same-origin, first-party and headerless mutations pass", async () => {
    for (const headers of [
      [
        ["Origin", "http://127.0.0.1"],
        ["Host", "127.0.0.1"],
      ],
      [["Sec-Fetch-Site", "same-origin"]],
      [["Sec-Fetch-Site", "same-site"]],
      [["Sec-Fetch-Site", "none"]],
      [],
    ] as H[])
      expect(
        (
          await send(
            "POST",
            "/api/conversations",
            [...headers, await cookie()],
            "{}",
          )
        ).status,
      ).toBe(200);
  });
});

describe("invariant 10: decompression inside auth", () => {
  test("an unauthenticated or cross-site gzip bomb never reaches a decoder", async () => {
    const bomb = new Uint8Array(
      zlib.gzipSync(new Uint8Array(64 * 1024 * 1024)),
    );
    const before = decoderStats.started;
    const unauth = await send(
      "POST",
      "/api/conversations",
      [
        ["Content-Encoding", "gzip"],
        ["Content-Type", "application/json"],
      ],
      bomb,
    );
    expect(unauth.status).toBe(401);
    const cross = await send(
      "POST",
      "/api/conversations",
      [...EVIL, ["Content-Encoding", "gzip"]],
      bomb,
    );
    expect(cross.status).toBe(403);
    const service = await send(
      "POST",
      "/api/tree",
      [
        ["Authorization", "Bearer recurse_alpha_alpha-secret"],
        ["Content-Encoding", "gzip"],
      ],
      bomb,
    );
    expect(service.status).toBe(403);
    expect(decoderStats.started).toBe(before);
    await send(
      "POST",
      "/api/conversations",
      [await cookie(), ["Content-Encoding", "gzip"]],
      new Uint8Array(zlib.gzipSync("{}")),
    );
    expect(decoderStats.started).toBe(before + 1);
  });
});

describe("invariant 6: service principals (every route)", () => {
  const ALPHA: [string, string] = [
    "Authorization",
    "Bearer recurse_alpha_alpha-secret",
  ];
  const ALLOWED = new Set([
    "POST /api/service/conversations",
    "POST /api/service/conversations/{cid}/messages",
    "GET /api/service/conversations/{cid}/replies",
  ]);
  test("only the allowlisted capabilities pass; other /api routes are 403, pages 401", async () => {
    for (const route of app.router.routes())
      for (const method of route.methods) {
        const got = await send(
          method,
          concrete(route.path),
          [ALPHA],
          method === "GET" ? undefined : "{}",
        );
        const key = `${method} ${route.path}`;
        const want = ALLOWED.has(key)
          ? 200
          : route.path === "/login"
            ? got.status
            : route.path.startsWith("/api/")
              ? 403
              : 401;
        expect([key, got.status]).toEqual([key, want]);
      }
  });

  test("every service request is audited by key id, never token", async () => {
    const before = app.records.length;
    await send(
      "POST",
      "/api/service/conversations/beta-cid/messages",
      [ALPHA],
      "{}",
    );
    await send("GET", "/api/tree", [ALPHA]);
    const audit = app.records
      .slice(before)
      .filter((r) => r.message.startsWith("event=service_request"));
    expect(audit.map((r) => r.message)).toEqual([
      "event=service_request action=conversation.send.denied principal=alpha",
      "event=service_request action=denied principal=alpha",
    ]);
    expect(audit.map((r) => r.conversation_id)).toEqual(["beta-cid", "-"]);
    expect(JSON.stringify(app.records)).not.toContain("alpha-secret");
  });

  test("the 64 KiB body bound applies to service callers", async () => {
    expect(
      (
        await send(
          "POST",
          "/api/service/conversations",
          [ALPHA],
          "x".repeat(65537),
        )
      ).status,
    ).toBe(413);
  });
});

describe("invariant 4: login throttle (fake clock, real HTTP)", () => {
  const login = (password: string, ip: string) =>
    send(
      "POST",
      "/login",
      [
        ["Content-Type", "application/x-www-form-urlencoded"],
        ["X-Forwarded-For", ip],
      ],
      `password=${encodeURIComponent(password)}`,
    );

  test("five free failures, then exponential 429 with Retry-After, capped", async () => {
    const ip = "10.7.0.1";
    for (let n = 0; n < LOGIN_MAX_FREE; n++)
      expect((await login("wrong", ip)).status).toBe(401);
    expect(app.throttle.retryAfter(ip)).toBe(0);
    expect((await login("wrong", ip)).status).toBe(401);
    const locked = await login(PASSWORD, ip);
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBe("2");
    clock += 1.5;
    expect((await login("wrong", ip)).status).toBe(401);
    expect(app.throttle.retryAfter(ip)).toBe(2);
    expect((await login(PASSWORD, ip)).headers["retry-after"]).toBe("3");
    for (let n = 0; n < 40; n++) app.throttle.recordFail(ip, clock);
    expect(app.throttle.retryAfter(ip)).toBe(LOGIN_LOCK_CAP);
    clock += LOGIN_LOCK_CAP + 1;
    const ok = await login(PASSWORD, ip);
    expect(ok.status).toBe(303);
    expect(app.throttle.fails.has(ip)).toBe(false);
  });

  test("an IP is forgotten 3,600 s after its lockout", () => {
    const throttle = new LoginThrottle(() => 0);
    throttle.recordFail("a", 100);
    throttle.recordFail("b", 100 + LOGIN_FORGET);
    expect(throttle.fails.has("a")).toBe(true);
    throttle.recordFail("b", 100 + LOGIN_FORGET + 0.001);
    expect(throttle.fails.has("a")).toBe(false);
  });

  test("/api/password shares the throttle and has a 12-character floor", async () => {
    const ip = "10.7.0.3";
    const change = async (current: string, next: string) =>
      send(
        "POST",
        "/api/password",
        [
          ["Content-Type", "application/json"],
          ["X-Forwarded-For", ip],
          await cookie(),
        ],
        JSON.stringify({ current, new: next }),
      );
    const short = await change(PASSWORD, "short");
    expect([short.status, json(short).detail]).toEqual([
      400,
      "New password must be at least 12 characters",
    ]);
    for (let n = 0; n <= LOGIN_MAX_FREE; n++)
      await change("wrong", "a-long-enough-pw");
    expect((await change(PASSWORD, "a-long-enough-pw")).status).toBe(429);
    expect((await login(PASSWORD, ip)).status).toBe(429);
    clock += LOGIN_LOCK_CAP + 1;
  });
});

describe("invariant 7: loopback tool token", () => {
  test("server.json is 0600 with a stable token and the port", async () => {
    const path = join(dir, "server.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const first = JSON.parse(await readFile(path, "utf8"));
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.port).toBe(8787);
    expect(await publishLoopbackToken(dir, 9999)).toBe(first.token);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      port: 9999,
      token: first.token,
    });
    await publishLoopbackToken(dir, 8787);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("honoured only from a loopback peer after proxy-header resolution, only on /api/", async () => {
    const token = JSON.parse(
      await readFile(join(dir, "server.json"), "utf8"),
    ).token;
    const T: [string, string] = ["X-Loopback-Token", token];
    expect(json(await send("GET", "/api/tree", [T])).auth_method).toBe(
      "loopback",
    );
    expect(
      (await send("GET", "/api/tree", [["X-Loopback-Token", "0".repeat(64)]]))
        .status,
    ).toBe(401);
    expect(
      (await send("GET", "/api/tree", [T, ["X-Forwarded-For", "10.0.0.5"]]))
        .status,
    ).toBe(401);
    expect(
      (
        await send("GET", "/api/tree", [
          T,
          ["X-Forwarded-For", "127.0.0.1, 10.0.0.5"],
        ])
      ).status,
    ).toBe(401);
    expect((await send("GET", "/", [T])).status).toBe(401);
    expect(
      resolvePeer({ host: "10.0.0.9", port: 1 }, { get: () => "127.0.0.1" })
        .client?.host,
    ).toBe("10.0.0.9");
  });
});

describe("repeated request headers are never looser than Python", () => {
  const post = async (headers: H) =>
    (await send("POST", "/api/conversations", headers, "{}")).status;

  test("Sec-Fetch-Site", async () => {
    const c = await cookie();
    expect(
      await post([
        ["Sec-Fetch-Site", "cross-site"],
        ["Sec-Fetch-Site", "same-origin"],
        c,
      ]),
    ).toBe(403);
    expect(
      await post([
        ["Sec-Fetch-Site", "same-origin"],
        ["Sec-Fetch-Site", "cross-site"],
        c,
      ]),
    ).toBe(403);
  });

  test("Origin", async () => {
    const c = await cookie();
    const same: [string, string] = ["Origin", "http://127.0.0.1"];
    const evil: [string, string] = ["Origin", "https://evil.example"];
    expect(await post([evil, same, ["Host", "127.0.0.1"], c])).toBe(403);
    expect(await post([same, evil, ["Host", "127.0.0.1"], c])).toBe(403);
  });

  test("Host", async () => {
    const c = await cookie();
    const origin: [string, string] = ["Origin", "http://127.0.0.1"];
    for (const hosts of [
      ["evil.example", "127.0.0.1"],
      ["127.0.0.1", "evil.example"],
    ]) {
      const raw = await exchange(
        app.running.port,
        requestBytes({
          method: "POST",
          path: "/api/conversations",
          headers: [["Host", hosts[0]!], ["Host", hosts[1]!], origin, c],
          body: { text: "{}" },
        }),
      );
      expect([400, 403]).toContain(normalise(raw, "POST").status);
    }
  });

  test("Authorization", async () => {
    const alpha: [string, string] = [
      "Authorization",
      "Bearer recurse_alpha_alpha-secret",
    ];
    const wrong: [string, string] = [
      "Authorization",
      "Bearer recurse_alpha_wrong",
    ];
    for (const pair of [
      [alpha, alpha],
      [alpha, wrong],
      [wrong, alpha],
    ] as H[]) {
      const got = await send("POST", "/api/service/conversations", pair, "{}");
      expect(got.status).toBe(401);
    }
  });

  test("Cookie", async () => {
    const valid = (await cookie())[1];
    const tampered = valid.slice(0, -1) + (valid.at(-1) === "0" ? "1" : "0");
    const get = async (headers: H) =>
      (await send("GET", "/api/tree", headers)).status;
    expect(
      await get([
        ["Cookie", tampered],
        ["Cookie", valid],
      ]),
    ).toBe(401);
    expect(
      await get([
        ["Cookie", valid],
        ["Cookie", tampered],
      ]),
    ).toBe(401);
    expect(
      await get([
        ["Cookie", valid],
        ["Cookie", valid],
      ]),
    ).toBe(200);
    expect(
      await get([
        ["Cookie", "a=1"],
        ["Cookie", valid],
      ]),
    ).toBe(200);
  });

  test("X-Forwarded-For (throttle key and loopback peer)", async () => {
    const token = JSON.parse(
      await readFile(join(dir, "server.json"), "utf8"),
    ).token;
    const T: [string, string] = ["X-Loopback-Token", token];
    for (const pair of [
      ["127.0.0.1", "10.0.0.5"],
      ["10.0.0.5", "127.0.0.1"],
      ["10.0.0.5, 127.0.0.1", "127.0.0.1"],
    ])
      expect(
        (
          await send("GET", "/api/tree", [
            T,
            ["X-Forwarded-For", pair[0]!],
            ["X-Forwarded-For", pair[1]!],
          ])
        ).status,
      ).toBe(401);
    const ip = "10.8.0.9";
    for (let n = 0; n <= LOGIN_MAX_FREE; n++)
      await send(
        "POST",
        "/login",
        [
          ["Content-Type", "application/x-www-form-urlencoded"],
          ["X-Forwarded-For", `10.8.0.${n}`],
          ["X-Forwarded-For", ip],
        ],
        "password=wrong",
      );
    expect(app.throttle.retryAfter(ip)).toBeGreaterThan(0);
    clock += LOGIN_LOCK_CAP + 1;
  });

  test("X-Forwarded-Proto over HTTP: a joined value is never https", async () => {
    const c = await cookie();
    for (const pair of [
      ["https", "http"],
      ["http", "https"],
      ["https", "https"],
    ]) {
      const got = await send("GET", "/api/tree/", [
        c,
        ["X-Forwarded-Proto", pair[0]!],
        ["X-Forwarded-Proto", pair[1]!],
      ]);
      expect([pair, got.status, got.headers.location]).toEqual([
        pair,
        307,
        "http://127.0.0.1/api/tree",
      ]);
    }
    const single = await send("GET", "/api/tree/", [
      c,
      ["X-Forwarded-Proto", "https"],
    ]);
    expect(single.headers.location).toBe("https://127.0.0.1/api/tree");
  });
});
