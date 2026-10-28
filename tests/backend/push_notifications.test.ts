import { expect, test } from "bun:test";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
  type ECDH,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import type { RuntimeLogRecord } from "../../src/observability/runtime_logging";
import {
  piAgentDir,
  preparePiAgentDir,
  resolveRoots,
} from "../../src/local_roots";
import { appWorld } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

type Rec = Record<string, unknown>;

const b64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const text = (value: string) => new TextEncoder().encode(value);
const join8 = (...parts: Uint8Array[]) =>
  new Uint8Array(parts.flatMap((part) => [...part]));

function decrypt(body: Uint8Array, ua: ECDH, auth: Uint8Array): string {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]!);
  const sealed = body.subarray(21 + body[20]!);
  const ikm = new Uint8Array(
    hkdfSync(
      "sha256",
      new Uint8Array(ua.computeSecret(asPublic)),
      auth,
      join8(
        text("WebPush: info\0"),
        new Uint8Array(ua.getPublicKey()),
        asPublic,
      ),
      32,
    ),
  );
  const derive = (label: string, size: number) =>
    new Uint8Array(
      hkdfSync("sha256", ikm, salt, text(`Content-Encoding: ${label}\0`), size),
    );
  const cipher = createDecipheriv(
    "aes-128-gcm",
    derive("aes128gcm", 16),
    derive("nonce", 12),
  );
  cipher.setAuthTag(sealed.subarray(-16));
  const plain = join8(
    new Uint8Array(cipher.update(sealed.subarray(0, -16))),
    new Uint8Array(cipher.final()),
  );
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.subarray(0, -1));
}

function verifyVapid(header: string, publicKey: string, audience: string) {
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  expect(key).toBe(publicKey);
  const [head, claims, signature] = token!.split(".");
  const point = b64(publicKey);
  const signer = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(point.slice(1, 33)).toString("base64url"),
      y: Buffer.from(point.slice(33)).toString("base64url"),
    },
  });
  expect(
    verify(
      "sha256",
      text(`${head}.${claims}`),
      { key: signer, dsaEncoding: "ieee-p1363" },
      b64(signature!),
    ),
  ).toBe(true);
  expect(JSON.parse(Buffer.from(b64(head!)).toString())).toEqual({
    typ: "JWT",
    alg: "ES256",
  });
  const claimed = JSON.parse(Buffer.from(b64(claims!)).toString());
  expect(claimed.aud).toBe(audience);
  expect(claimed.exp).toBeGreaterThan(Date.now() / 1000);
  expect(claimed.sub).toBe("mailto:recurse@localhost");
}

// Feature: #2870 a finished top-level or taken-over agent sends one Web Push to each opted-in device
test("finished top-level and taken-over agents push one encrypted, VAPID-signed notice per device, a held report once on release; children, removed and gone devices get none", async () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const rfcUa = createECDH("prime256v1");
  rfcUa.setPrivateKey(b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
  expect(
    decrypt(
      b64(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      ),
      rfcUa,
      b64("BTBZMqHH6r4Tts7J_aSIgg"),
    ),
  ).toBe("When I grow up, I want to be a watermelon");
  const auth = new Uint8Array(randomBytes(16));
  const pushes: { path: string; headers: Rec; body: Uint8Array }[] = [];
  const pushService = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      pushes.push({
        path,
        headers: Object.fromEntries(request.headers),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status: path === "/gone" ? 410 : 201 });
    },
  });
  const device = (path: string) => ({
    endpoint: `http://127.0.0.1:${pushService.port}${path}`,
    keys: {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: Buffer.from(auth).toString("base64url"),
    },
  });

  const { root, env } = appWorld();
  const fixture = fauxHost(join(root, "faux"));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const reply: FauxResponseFactory = async (request) => {
    fixture.faux.appendResponses([reply]);
    const last = JSON.stringify(request.messages.at(-1)?.content);
    if (last.includes("<message>")) return fauxAssistantMessage("Title");
    if (last.includes("Done")) return fauxAssistantMessage("Parent read it");
    const word = /say (\w+)/.exec(last)?.[1];
    if (word === "slowly") await gate;
    return fauxAssistantMessage(`**Done**: ${word}\nsecond line`);
  };
  fixture.faux.setResponses([reply]);
  const logs: string[] = [];
  const sink = new WebLogSink(() => {});
  sink.write = (record: RuntimeLogRecord) => void logs.push(record.message);
  const app = await buildApp({ env, sink });
  const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  Object.assign(
    (app.instance.durable as unknown as { deps: DurableHostDeps }).deps,
    {
      models: fake.models,
      settings: fake.settings,
      agentEnv: fake.agentEnv,
      promptSnapshot: fake.promptSnapshot,
      titleSettings: () => ["faux/faux-1", "off"],
    },
  );
  const running = await app.serve({ port: 0 });
  const api = async (path: string, body?: object, headers: Rec = {}) =>
    fetch(`${running.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const json = async (path: string, body?: object) =>
    (await (await api(path, body)).json()) as Rec;
  const file = join(
    await piAgentDir(resolveRoots(env), preparePiAgentDir),
    "recurse-push.json",
  );
  const reported = (cid: string) =>
    logs.filter(
      (line) =>
        line.includes("event=durable_report_delivered") && line.includes(cid),
    ).length;
  const logged = (event: string, cid: string) =>
    logs.some((line) => line.includes(`event=${event}`) && line.includes(cid));
  const agent = async (title: string, parent?: string) => {
    const cid = String((await json("/api/conversations", { parent }))!.id);
    await json(`/api/conversations/${cid}/rename`, { title });
    return cid;
  };
  const say = async (cid: string, word: string) => {
    const before = reported(cid);
    expect(
      (
        await api(`/api/conversations/${cid}/deliver`, {
          content: `say ${word}`,
        })
      ).status,
    ).toBe(200);
    await until(() => reported(cid) > before);
  };
  try {
    await until(async () => (await json("/api/status")).ready === true);
    const manifest = await json("/manifest.webmanifest");
    expect(manifest.icons).toEqual([
      {
        src: "/static/brand/app-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/static/brand/app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/static/brand/app-icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/static/brand/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/static/brand/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
    const settings = await json("/api/settings/notifications");
    expect(Object.keys(settings)).toEqual(["public_key"]);
    const publicKey = String(settings.public_key);
    expect(
      (
        await api(
          "/api/settings/notifications/devices",
          { subscription: device("/device") },
          { "x-recurse-agent": "intruder" },
        )
      ).status,
    ).toBe(403);
    expect(
      await json("/api/settings/notifications/devices", {
        subscription: device("/device"),
      }),
    ).toEqual({ subscribed: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const top = await agent("Top agent");
    await say(top, "alpha");
    await until(() => pushes.length === 1);
    const [first] = pushes;
    expect(first!.path).toBe("/device");
    expect(first!.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "86400",
    });
    verifyVapid(
      String(first!.headers.authorization),
      publicKey,
      `http://127.0.0.1:${pushService.port}`,
    );
    const notices = () =>
      pushes
        .filter((push) => push.path === "/device")
        .map((push) => JSON.parse(decrypt(push.body, ua, auth)));
    expect(notices()).toEqual([
      { cid: top, title: "Top agent", body: "Done: alpha" },
    ]);

    const child = await agent("Child agent", top);
    await say(child, "beta");
    await until(() => pushes.length === 2);
    await json(`/api/conversations/${child}/pin`, { pinned: true });
    await say(child, "gamma");
    await until(() => pushes.length === 3);
    expect(notices()).toEqual([
      { cid: top, title: "Top agent", body: "Done: alpha" },
      { cid: top, title: "Top agent", body: "Parent read it" },
      { cid: child, title: "Child agent", body: "Done: gamma" },
    ]);

    const grandchild = await agent("Grandchild", child);
    await json(`/api/conversations/${grandchild}/deliver`, {
      content: "say slowly",
    });
    await until(
      () => app.instance.durable.liveStatus(grandchild)[0] === "running",
    );
    await json(`/api/conversations/${child}/deliver`, { content: "say eta" });
    await until(() => logged("durable_report_held", child));
    expect(pushes.length).toBe(3);
    open();
    await until(() => pushes.length === 4);
    expect(notices().at(-1)).toEqual({
      cid: child,
      title: "Child agent",
      body: "Parent read it",
    });

    expect(
      await json("/api/settings/notifications/devices/remove", {
        endpoint: device("/device").endpoint,
      }),
    ).toEqual({ subscribed: false });
    await say(top, "delta");
    expect(pushes.length).toBe(4);

    await json("/api/settings/notifications/devices", {
      subscription: device("/gone"),
    });
    await say(top, "epsilon");
    await until(async () => !(await readFile(file, "utf8")).includes("/gone"));
    expect(pushes.map((push) => push.path)).toEqual([
      "/device",
      "/device",
      "/device",
      "/device",
      "/gone",
    ]);
    expect(logs.join("\n")).toContain("status=410");
    await say(top, "zeta");
    expect(pushes.length).toBe(5);
    expect(JSON.parse(await readFile(file, "utf8")).devices).toEqual([]);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    pushService.stop(true);
    await fixture.host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
