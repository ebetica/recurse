import { expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectedBackends } from "../../src/backends/connected";
import { registerBackendRoutes } from "../../src/web/backends";
import { LOGIN_MAX_FREE } from "../../src/web/request_auth";
import { jsonResponse } from "../../src/web/router";
import { buildAuthApp, PASSWORD } from "./http_auth_app";
import { authenticatorCode } from "./totp_support";

export async function exerciseTwoFactorSignIn(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "two-factor-"));
  let now = Math.floor(Date.now() / 30_000) * 30 + 5;
  let passwordQueued = () => {};
  const remote = await buildAuthApp(join(directory, "remote"), {
    now: () => now,
    passwordQueued: () => passwordQueued(),
    sleep: async () => {},
    port: 0,
    backendKeys: true,
    extraRoutes: (router) =>
      router.get("/api/status", async () => jsonResponse({ ready: true })),
  });
  const store = await ConnectedBackends.load(
    join(directory, "home-pi"),
    "Home",
    () => {},
  );
  const home = await buildAuthApp(join(directory, "home"), {
    sleep: async () => {},
    port: 0,
    extraRoutes: (router) => registerBackendRoutes(router, store),
  });
  const base = `http://127.0.0.1:${remote.running.port}`;
  const homeBase = `http://127.0.0.1:${home.running.port}`;
  let cookie = `chat_auth=${await remote.operator.makeToken()}`;
  const previousCookie = cookie;
  const captures: string[] = [];
  const withHeldQueue = async (
    work: (release: () => void) => Promise<void>,
  ) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = remote.operator.withPasswordLock(async () => {
      entered();
      await gate;
    });
    await acquired;
    try {
      await work(release);
    } finally {
      passwordQueued = () => {};
      release();
      await holding;
    }
  };
  const nextQueued = () =>
    new Promise<void>((resolve) => {
      passwordQueued = resolve;
    });
  const call = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin: base,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
    return response;
  };
  const settings = (
    action: string,
    password = PASSWORD,
    code = "",
    headers = {},
  ) => call("/api/settings/two-factor", { action, password, code }, headers);
  const login = (password: string, code = "", ip = "login") =>
    fetch(base + "/login", {
      method: "POST",
      headers: {
        origin: base,
        "x-forwarded-for": ip,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, code }),
      redirect: "manual",
    });
  try {
    const minted = await call("/api/backend-keys", {
      password: PASSWORD,
      name: "existing-home",
    });
    expect(minted.status).toBe(200);
    expect((await login(PASSWORD, "x".repeat(65), "ignored-code")).status).toBe(
      303,
    );
    expect(
      (
        await call("/api/backend-keys", {
          password: PASSWORD,
          code: { ignored: true },
          name: "ignored-code",
        })
      ).status,
    ).toBe(200);
    const machineKey = ((await minted.json()) as { key: string }).key;
    const machineRead = () =>
      fetch(base + "/api/tree", {
        headers: { authorization: `Bearer ${machineKey}` },
      });
    expect(await (await call("/api/settings/two-factor")).json()).toEqual({
      enabled: false,
    });
    for (const marker of ["x-recurse-agent", "x-recurse-agent-caller"]) {
      expect(
        (
          await call("/api/settings/two-factor", undefined, {
            [marker]: "agent",
          })
        ).status,
      ).toBe(403);
      expect(
        (await settings("setup", PASSWORD, "", { [marker]: "agent" })).status,
      ).toBe(403);
    }
    expect((await settings("setup", "wrong")).status).toBe(400);
    const setup = await settings("setup");
    expect(setup.status).toBe(200);
    expect(setup.headers.get("cache-control")).toBe("no-store");
    const { secret, url } = (await setup.json()) as {
      secret: string;
      url: string;
    };
    expect(secret).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    expect(new URL(url).searchParams.get("secret")).toBe(
      secret.replaceAll(" ", ""),
    );
    expect(await (await call("/api/settings/two-factor")).json()).toEqual({
      enabled: false,
    });
    expect((await settings("enable", PASSWORD, "wrong")).status).toBe(400);
    now++;
    const otherCookie = `chat_auth=${await remote.operator.makeToken()}`;
    expect(
      (
        await settings("enable", PASSWORD, authenticatorCode(secret, now), {
          cookie: otherCookie,
        })
      ).status,
    ).toBe(400);
    let enabled!: Response;
    await withHeldQueue(async (release) => {
      const enableQueued = nextQueued();
      const enabling = settings(
        "enable",
        PASSWORD,
        authenticatorCode(secret, now),
      );
      await enableQueued;
      const changeQueued = nextQueued();
      const staleChange = call("/api/password", {
        current: PASSWORD,
        new: PASSWORD + "-stale",
      });
      await changeQueued;
      const staleFactors: Promise<Response>[] = [];
      for (const action of ["setup", "enable", "disable"]) {
        const queued = nextQueued();
        staleFactors.push(
          settings(action, PASSWORD, authenticatorCode(secret, now + 30)),
        );
        await queued;
      }
      release();
      enabled = await enabling;
      for (const refused of await Promise.all([staleChange, ...staleFactors])) {
        expect(refused.status).toBe(401);
        expect(refused.headers.get("set-cookie")).toBeNull();
      }
    });
    expect(enabled.status).toBe(200);
    const enabledText = await enabled.text();
    expect(enabledText).not.toContain(secret.replaceAll(" ", ""));
    const codes: string[] = JSON.parse(enabledText).recovery_codes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    cookie = enabled.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await call("/api/settings/two-factor", {
          action: ["disable"],
          password: PASSWORD,
          code: codes[9],
        })
      ).status,
    ).toBe(422);
    expect(
      (await call("/api/tree", undefined, { cookie: previousCookie })).status,
    ).toBe(401);
    expect((await call("/api/tree")).status).toBe(200);
    expect((await machineRead()).status).toBe(200);
    expect(
      (
        await call("/api/settings/two-factor", undefined, {
          authorization: `Bearer ${machineKey}`,
        })
      ).status,
    ).toBe(403);
    expect((await stat(remote.operator.authFile)).mode & 0o777).toBe(0o600);
    const stored = await readFile(remote.operator.authFile, "utf8");
    expect(JSON.parse(stored).two_factor.recovery_hashes).toHaveLength(10);
    for (const code of codes)
      expect(stored).not.toContain(code.replaceAll("-", ""));
    for (const route of ["login", "mint", "factor"] as const) {
      await withHeldQueue(async (release) => {
        const total = 12;
        let queued = 0;
        const allQueued = new Promise<void>((resolve) => {
          passwordQueued = () => {
            if (++queued === total) resolve();
          };
        });
        const ip = `concurrent-${route}`;
        const attempts = Array.from({ length: total }, () =>
          route === "login"
            ? login(PASSWORD, "wrong", ip)
            : call(
                route === "mint"
                  ? "/api/backend-keys"
                  : "/api/settings/two-factor",
                {
                  password: PASSWORD,
                  code: "wrong",
                  ...(route === "mint"
                    ? { name: "limited" }
                    : { action: "disable" }),
                },
                { "x-forwarded-for": ip },
              ),
        );
        await allQueued;
        release();
        const responses = await Promise.all(attempts);
        const free = LOGIN_MAX_FREE + 1;
        expect(
          responses.filter(
            (r) => r.status === (route === "factor" ? 400 : 401),
          ),
        ).toHaveLength(free);
        expect(responses.filter((r) => r.status === 429)).toHaveLength(
          total - free,
        );
        expect(remote.throttle.fails.get(ip)?.[0]).toBe(free);
        for (const response of responses)
          if (response.status === 429)
            expect(response.headers.get("retry-after")).toBeTruthy();
      });
    }
    const noCode = await login(PASSWORD);
    expect(noCode.status).toBe(401);
    captures.push(await noCode.text());
    expect((await login(PASSWORD, authenticatorCode(secret, now))).status).toBe(
      401,
    );
    now += 60;
    const wrongPassword = await login(
      "wrong",
      authenticatorCode(secret, now),
      "wrong-password",
    );
    const wrongCode = await login(PASSWORD, "wrong", "wrong-code");
    expect(wrongPassword.status).toBe(401);
    expect(wrongCode.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await wrongCode.text());
    for (const [ip, password, code] of [
      ["lock-password", "wrong", "wrong"],
      ["lock-code", PASSWORD, "wrong"],
    ]) {
      for (let i = 0; i < 6; i++)
        expect((await login(password!, code!, ip)).status).toBe(401);
      const locked = await login(PASSWORD, authenticatorCode(secret, now), ip);
      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).toBeTruthy();
    }
    const accepted = await Promise.all([
      login(PASSWORD, authenticatorCode(secret, now - 30), "race-a"),
      login(PASSWORD, authenticatorCode(secret, now - 30), "race-b"),
    ]);
    expect(accepted.map((response) => response.status).sort()).toEqual([
      303, 401,
    ]);
    for (const response of accepted) captures.push(await response.text());
    const recovered = await login(PASSWORD, codes[0], "recovery");
    expect(recovered.status).toBe(303);
    expect((await login(PASSWORD, codes[0], "recovery")).status).toBe(401);
    const homeCookie = `chat_auth=${await home.operator.makeToken()}`;
    const connect = (code?: string) =>
      fetch(homeBase + "/api/backends", {
        method: "POST",
        headers: {
          cookie: homeCookie,
          origin: homeBase,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          label: "remote",
          url: base,
          password: PASSWORD,
          code,
        }),
      });
    const needsCode = await connect();
    expect(needsCode.status).toBe(428);
    expect(await needsCode.text()).toContain("authenticator or recovery code");
    now += 30;
    const connected = await connect(authenticatorCode(secret, now + 30));
    expect(connected.status).toBe(200);
    captures.push(await connected.text());
    const backendFile = await readFile(
      join(directory, "home-pi/recurse-backends.json"),
      "utf8",
    );
    expect(backendFile).not.toContain(secret.replaceAll(" ", ""));
    expect(backendFile).not.toContain(PASSWORD);
    const state = await call("/api/settings/two-factor");
    const stateText = await state.text();
    expect(JSON.parse(stateText)).toEqual({ enabled: true });
    captures.push(stateText);
    const passwordChanged = await call("/api/password", {
      current: PASSWORD,
      new: PASSWORD + "-new",
    });
    expect(passwordChanged.status).toBe(200);
    cookie = passwordChanged.headers.get("set-cookie")!.split(";")[0]!;
    expect((await login(PASSWORD + "-new", "", "changed")).status).toBe(401);
    expect((await settings("disable", PASSWORD + "-new", "wrong")).status).toBe(
      400,
    );
    const newKeyResponse = await call("/api/backend-keys", {
      password: PASSWORD + "-new",
      code: codes[1],
      name: "after-password-change",
    });
    expect(newKeyResponse.status).toBe(200);
    const newKey = ((await newKeyResponse.json()) as { key: string }).key;
    const beforeDisable = cookie;
    now += 60;
    const disabled = await settings(
      "disable",
      PASSWORD + "-new",
      authenticatorCode(secret, now),
    );
    expect(disabled.status).toBe(200);
    captures.push(await disabled.text());
    cookie = disabled.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (await call("/api/tree", undefined, { cookie: beforeDisable })).status,
    ).toBe(401);
    expect((await call("/api/tree")).status).toBe(200);
    expect((await login(PASSWORD + "-new", "", "disabled")).status).toBe(303);
    expect(
      (
        await fetch(base + "/api/tree", {
          headers: { authorization: `Bearer ${newKey}` },
        })
      ).status,
    ).toBe(200);
    expect(await (await call("/api/settings/two-factor")).json()).toEqual({
      enabled: false,
    });
    const cleared = JSON.parse(
      await readFile(remote.operator.authFile, "utf8"),
    );
    expect(cleared.two_factor).toBeUndefined();
    await home.running.close();
    await remote.running.close();
    const logs = JSON.stringify([...home.records, ...remote.records]);
    expect(remote.records.length).toBeGreaterThan(0);
    expect(home.records.length).toBeGreaterThan(0);
    expect(logs).toContain("http_response");
    expect(captures.length).toBeGreaterThan(5);
    for (const text of [logs, ...captures]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.replaceAll(" ", ""));
      expect(text).not.toContain(url);
      for (const code of codes) expect(text).not.toContain(code);
    }
  } finally {
    await home.running.close();
    await remote.running.close();
    await rm(directory, { recursive: true, force: true });
  }
}
