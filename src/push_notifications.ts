// Web Push when a top-level or taken-over agent finishes. The VAPID key pair
// (made once) and devices live 0600 in Pi's credential dir; only the public key
// leaves the server. RFC 8291 aes128gcm payloads, RFC 8292 VAPID JWTs. Sends
// are detached, bounded and timed out; failures log; a 404/410 drops a device.

import {
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  createCipheriv,
} from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const PUSH_FILE_NAME = "recurse-push.json";
const MAX_DEVICES = 20;
const SEND_TIMEOUT_MS = 10_000;
const TITLE_CHARS = 80;
const BODY_CHARS = 140;

interface Device {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The page origin that subscribed, used as the VAPID contact. */
  origin: string;
}
interface Stored {
  public_key: string;
  private_key: string;
  devices: Device[];
}

export interface Notice {
  cid: string;
  title: string;
  body: string;
}

export class PushSubscriptionError extends Error {}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (text: string) =>
  new Uint8Array(Buffer.from(text, "base64url"));
const bytes = (text: string) => new TextEncoder().encode(text);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A push service URL: HTTPS, or HTTP on loopback; no credentials. */
function pushEndpoint(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password) throw new Error();
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new Error();
    return url.href;
  } catch {
    throw new PushSubscriptionError(
      "subscription endpoint must be an HTTPS URL",
    );
  }
}

/** A browser PushSubscription's JSON, validated. */
export function parseSubscription(value: unknown, origin: string): Device {
  const sub = value as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  } | null;
  const endpoint = pushEndpoint(sub?.endpoint);
  const { p256dh, auth } = sub?.keys ?? {};
  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    unb64url(p256dh).length !== 65 ||
    unb64url(auth).length !== 16
  )
    throw new PushSubscriptionError("subscription keys are invalid");
  return { endpoint, p256dh, auth, origin };
}

/** First line of the final message, or the failure, shortened. */
export function finishedNotice(
  cid: string,
  title: unknown,
  report: { finalText: string | null; aborted: boolean; error: string | null },
): Notice {
  const clip = (text: string, size: number) =>
    text.length > size ? `${text.slice(0, size - 1).trimEnd()}…` : text;
  const line = (text: string) =>
    text
      .split("\n")
      .map((part) => part.replace(/^[\s#>*-]+|\*\*|__|`/g, "").trim())
      .find(Boolean) ?? "";
  const body =
    report.error !== null
      ? `Failed: ${line(report.error)}`
      : report.aborted
        ? "Stopped."
        : line(report.finalText ?? "") || "Finished.";
  const name = typeof title === "string" && title.trim() ? title.trim() : cid;
  return { cid, title: clip(name, TITLE_CHARS), body: clip(body, BODY_CHARS) };
}

/** RFC 8291: the aes128gcm body for one device. */
function encrypt(device: Device, payload: Uint8Array): Uint8Array {
  const uaPublic = unb64url(device.p256dh);
  const ecdh = createECDH("prime256v1");
  const asPublic = new Uint8Array(ecdh.generateKeys());
  const secret = new Uint8Array(ecdh.computeSecret(uaPublic));
  const info = (text: string, ...parts: Uint8Array[]) =>
    concat(bytes(text), ...parts);
  const ikm = new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      unb64url(device.auth),
      info("WebPush: info\0", uaPublic, asPublic),
      32,
    ),
  );
  const salt = new Uint8Array(randomBytes(16));
  const derive = (label: string, size: number) =>
    new Uint8Array(
      hkdfSync("sha256", ikm, salt, info(`Content-Encoding: ${label}\0`), size),
    );
  const cipher = createCipheriv(
    "aes-128-gcm",
    derive("aes128gcm", 16),
    derive("nonce", 12),
  );
  const sealed = concat(
    new Uint8Array(cipher.update(concat(payload, new Uint8Array([2])))),
    new Uint8Array(cipher.final()),
    new Uint8Array(cipher.getAuthTag()),
  );
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

export class PushNotifications {
  private stored: Promise<Stored> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      /** Pi's credential directory, prepared. */
      directory(): Promise<string>;
      spawn(name: string, work: (signal: AbortSignal) => Promise<void>): void;
      log(event: string, fields: Record<string, unknown>, warn?: boolean): void;
      fetch?: typeof fetch;
    },
  ) {}

  private async path(): Promise<string> {
    return join(await this.deps.directory(), PUSH_FILE_NAME);
  }

  /** The stored keys and devices; makes the key pair on first use. */
  private load(): Promise<Stored> {
    this.stored ??= (async () => {
      const path = await this.path();
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as Stored;
        if (
          typeof value.public_key !== "string" ||
          typeof value.private_key !== "string" ||
          !Array.isArray(value.devices)
        )
          throw new Error("invalid notification settings");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const jwk = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      }).privateKey.export({ format: "jwk" });
      const made: Stored = {
        public_key: b64url(
          new Uint8Array([
            4,
            ...unb64url(String(jwk.x)),
            ...unb64url(String(jwk.y)),
          ]),
        ),
        private_key: String(jwk.d),
        devices: [],
      };
      await this.write(made);
      return made;
    })();
    this.stored.catch(() => (this.stored = null));
    return this.stored;
  }

  private async write(value: Stored): Promise<void> {
    const path = await this.path();
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /** Apply one change to the device list, one change at a time. */
  private change(update: (devices: Device[]) => Device[]): Promise<void> {
    const task = this.queue.then(async () => {
      const stored = await this.load();
      const devices = update(stored.devices);
      if (devices === stored.devices) return;
      await this.write({ ...stored, devices });
      stored.devices = devices;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** The VAPID public key browsers subscribe with. */
  async publicKey(): Promise<string> {
    return (await this.load()).public_key;
  }

  subscribe(device: Device): Promise<void> {
    return this.change((devices) => {
      const others = devices.filter((d) => d.endpoint !== device.endpoint);
      if (others.length >= MAX_DEVICES)
        throw new PushSubscriptionError(
          `at most ${MAX_DEVICES} devices can get notifications`,
        );
      return [...others, device];
    });
  }

  unsubscribe(endpoint: string): Promise<void> {
    return this.change((devices) =>
      devices.some((d) => d.endpoint === endpoint)
        ? devices.filter((d) => d.endpoint !== endpoint)
        : devices,
    );
  }

  /** Send `notice` to every device on a detached task; never throws. */
  notify(notice: Notice): void {
    this.deps.spawn(`agent-notification:${notice.cid}`, async (signal) => {
      let stored: Stored;
      try {
        stored = await this.load();
      } catch (error) {
        this.deps.log(
          "agent_notification_failed",
          { cid: notice.cid, reason: String(error) },
          true,
        );
        return;
      }
      if (!stored.devices.length) return;
      this.deps.log("agent_notification", {
        cid: notice.cid,
        devices: stored.devices.length,
      });
      const payload = bytes(JSON.stringify(notice));
      await Promise.all(
        stored.devices.map((device) =>
          this.send(stored, device, payload, notice.cid, signal),
        ),
      );
    });
  }

  private async send(
    stored: Stored,
    device: Device,
    payload: Uint8Array,
    cid: string,
    signal: AbortSignal,
  ): Promise<void> {
    const host = new URL(device.endpoint).host;
    const timed = new AbortController();
    const timer = setTimeout(() => timed.abort("timed out"), SEND_TIMEOUT_MS);
    const stop = () => timed.abort("shutting down");
    signal.addEventListener("abort", stop, { once: true });
    try {
      const response = await (this.deps.fetch ?? fetch)(device.endpoint, {
        method: "POST",
        headers: {
          authorization: this.vapid(stored, device),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(24 * 3600),
          urgency: "normal",
        },
        body: encrypt(device, payload),
        signal: timed.signal,
        redirect: "error",
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return;
      const gone = response.status === 404 || response.status === 410;
      this.deps.log(
        "agent_notification_failed",
        { cid, host, status: response.status, removed: gone },
        true,
      );
      if (gone) await this.unsubscribe(device.endpoint);
    } catch (error) {
      if (signal.aborted) return;
      this.deps.log(
        "agent_notification_failed",
        { cid, host, reason: String(timed.signal.reason ?? error) },
        true,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  /** RFC 8292 Authorization header for one push service. */
  private vapid(stored: Stored, device: Device): string {
    const point = unb64url(stored.public_key);
    const key = createPrivateKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64url(point.slice(1, 33)),
        y: b64url(point.slice(33)),
        d: stored.private_key,
      },
    });
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const contact = device.origin.startsWith("https:")
      ? device.origin
      : "mailto:recurse@localhost";
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
      aud: new URL(device.endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: contact,
    })}`;
    const signature = sign("sha256", bytes(unsigned), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    return `vapid t=${unsigned}.${b64url(new Uint8Array(signature))}, k=${stored.public_key}`;
  }
}
