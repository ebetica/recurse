// Remote side of push notifications: a keyed home registers its address and
// a callback token that only reaches its /api/remote-events route. Tokens are
// 0600 in Pi's credential directory and follow their backend key's lifetime.
// See README.md for when homes register and how relay notices are retried.
import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readRegular } from "../auth/service";
import { validBackendKeyName } from "../auth/backend_keys";
import { backendUrl, CALLBACK_TOKEN_PREFIX } from "./connected";
import { remoteCall } from "./remote_client";
import { HttpError } from "../web/router";

interface Registration {
  key_id: string;
  url: string;
  token: string;
  labels: string[];
}
export interface KeyInfo {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
  last_client: string | null;
}
const TOKEN = new RegExp(`^${CALLBACK_TOKEN_PREFIX}[a-f0-9]{64}$`);

export class HomeCallbacks {
  private rows: Registration[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Delays between relay notices; tests shorten them. */
  retryMs = [5000, 10_000, 20_000, 30_000];
  private constructor(
    private readonly path: string,
    private readonly keys: { list(): Promise<KeyInfo[]> },
  ) {}

  static async load(
    directory: string,
    keys: HomeCallbacks["keys"],
  ): Promise<HomeCallbacks> {
    const store = new HomeCallbacks(
      join(directory, "recurse-home-callbacks.json"),
      keys,
    );
    try {
      const bytes = await readRegular(store.path, 256 * 1024);
      const rows = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : [];
      if (Array.isArray(rows))
        store.rows = rows.filter(
          (r: Registration) =>
            typeof r?.key_id === "string" &&
            typeof r.url === "string" &&
            TOKEN.test(r.token) &&
            Array.isArray(r.labels) &&
            r.labels.every(validBackendKeyName),
        );
    } catch {}
    return store;
  }

  private change(work: (rows: Registration[]) => Registration[]) {
    const task = this.queue.then(async () => {
      const rows = work(this.rows);
      const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const handle = await open(tmp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(rows));
        } finally {
          await handle.close();
        }
        await rename(tmp, this.path);
        this.rows = rows;
      } finally {
        await unlink(tmp).catch(() => {});
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  // Store a home's callback once a test notice reaches it, replacing that
  // key's earlier one; names need not be unique. A failed test unregisters.
  async register(keyId: string, body: Record<string, unknown>): Promise<void> {
    const url = backendUrl(body.url);
    const { token, labels } = body;
    if (typeof token !== "string" || !TOKEN.test(token))
      throw new HttpError(422, "invalid callback token");
    if (
      !Array.isArray(labels) ||
      !labels.length ||
      labels.length > 100 ||
      !labels.every(validBackendKeyName)
    )
      throw new HttpError(422, "invalid labels");
    let status = 0;
    try {
      status = (
        await remoteCall({ url, key: token }, "/api/remote-events", {
          method: "POST",
          body: { type: "test" },
          timeoutMs: 30_000,
        })
      ).status;
    } catch {}
    if (status !== 200) {
      await this.change((rows) => rows.filter((r) => r.key_id !== keyId));
      throw new HttpError(422, `home unreachable at ${url}; it will poll`);
    }
    await this.change((rows) => [
      ...rows.filter((r) => r.key_id !== keyId),
      { key_id: keyId, url, token, labels: [...new Set(labels)] },
    ]);
  }

  /** Backend keys that still exist, by id. */
  async liveKeys(): Promise<Map<string, KeyInfo>> {
    return new Map((await this.keys.list()).map((k) => [k.id, k]));
  }

  /**
   * Registered homes whose backend key still exists; keys with the same
   * callback address belong to one home.
   */
  async homes(): Promise<
    { id: string; name: string; url: string; labels: string[] }[]
  > {
    const keys = await this.liveKeys();
    if (this.rows.some((r) => !keys.has(r.key_id)))
      await this.change((rows) => rows.filter((r) => keys.has(r.key_id)));
    return this.rows
      .filter((r) => keys.has(r.key_id))
      .map((r) => ({
        id: r.key_id,
        name: keys.get(r.key_id)!.name,
        url: r.url,
        labels: r.labels,
      }));
  }

  /**
   * Tell a home that a relay message waits, repeating while `waiting()`;
   * a 401 means the home dropped this token, so forget the registration.
   */
  async notify(keyId: string, waiting: () => boolean): Promise<void> {
    for (let attempt = 0; waiting(); attempt++) {
      const row = this.rows.find((r) => r.key_id === keyId);
      if (!row) return;
      let status = 0;
      try {
        status = (
          await remoteCall(
            { url: row.url, key: row.token },
            "/api/remote-events",
            {
              method: "POST",
              body: { type: "relay" },
              timeoutMs: 60_000,
            },
          )
        ).status;
      } catch {}
      if (status === 401) {
        await this.change((rows) => rows.filter((r) => r !== row));
        return;
      }
      await Bun.sleep(
        this.retryMs[Math.min(attempt, this.retryMs.length - 1)]!,
      );
    }
  }
}
