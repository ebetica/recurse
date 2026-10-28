// Private home connections in Pi's credential directory; atomic 0600 writes.
// Only operator sign-in contacts pending URLs; agent requests store no key.
// Instance tasks refresh cached health and relay polls, independent of HTTP.
// See README.md for credential, pending-state and recovery boundaries.
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { readRegular } from "../auth/service";
import { validBackendLabel } from "./label";
import { HttpError } from "../web/router";
import { remoteCall, remoteStream, RemoteCallError } from "./remote_client";
import { SYNC_PATHS } from "./settings_sync";

interface RecordRow {
  label: string;
  url: string;
  key: string | null;
  added: number;
  pending?: boolean;
  requested_by?: string;
  reason?: string;
}
interface Health {
  state: "connected" | "unreachable" | "key_revoked";
  last_contact: number | null;
  reason: string | null;
}

export function backendUrl(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
      )
    )
      throw new Error();
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    throw new HttpError(
      422,
      "URL must use HTTPS (or HTTP on loopback), without credentials, query or fragment",
    );
  }
}
const isStatus = (data: unknown): boolean =>
  !!data &&
  typeof data === "object" &&
  typeof (data as { ready?: unknown }).ready === "boolean";
const unknownHealth = (): Health => ({
  state: "unreachable",
  last_contact: null,
  reason: "Health check pending",
});

export class ConnectedBackends {
  private rows: RecordRow[] = [];
  private readonly health = new Map<string, Health>();
  private readonly retries = new Map<string, { delay: number; at: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | undefined;
  private changed = false;
  private readonly homeId = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  connectedLabels(): string[] {
    return this.rows.filter((r) => !r.pending).map((r) => r.label);
  }
  poll(label: string, labels: string[], signal: AbortSignal) {
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row) throw new HttpError(409, "backend disconnected");
    return remoteCall(row, "/api/relay/requests", {
      home: { id: this.homeId, name: this.home },
      query: new URLSearchParams({ labels: labels.join(","), wait: "25" }),
      timeoutMs: 30_000,
      signal,
    });
  }
  private unavailable = false;
  private constructor(
    private readonly path: string,
    private readonly home: string,
    private readonly signInDiagnostic?: (fields: {
      stage: string;
      elapsed_ms: number;
      outcome: string;
    }) => void,
    private readonly connectionDiagnostic?: (fields: {
      label: string;
      state: string;
    }) => void,
  ) {}

  static async load(
    directory: string,
    home: string,
    warn: (path: string, reason: string) => void,
    signInDiagnostic?: ConnectedBackends["signInDiagnostic"],
    connectionDiagnostic?: ConnectedBackends["connectionDiagnostic"],
  ): Promise<ConnectedBackends> {
    const store = new ConnectedBackends(
      join(directory, "recurse-backends.json"),
      home.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32) || "home",
      signInDiagnostic,
      connectionDiagnostic,
    );
    const unavailable = (reason: string) => {
      store.unavailable = true;
      warn(store.path, reason);
      return store;
    };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      return unavailable("credential directory cannot be accessed");
    }
    const bytes = await readRegular(store.path, 256 * 1024);
    if (bytes !== null) {
      try {
        const rows = JSON.parse(new TextDecoder().decode(bytes)) as RecordRow[];
        if (
          !Array.isArray(rows) ||
          rows.some(
            (r) =>
              !validBackendLabel(r.label) ||
              backendUrl(r.url) !== r.url ||
              !(
                r.key === null ||
                (typeof r.key === "string" &&
                  /^recurse-link_[a-f0-9]{16}_[a-f0-9]{64}$/.test(r.key))
              ) ||
              !Number.isFinite(r.added) ||
              !(r.pending === undefined || typeof r.pending === "boolean") ||
              !(
                r.requested_by === undefined ||
                typeof r.requested_by === "string"
              ) ||
              !(r.reason === undefined || typeof r.reason === "string") ||
              (r.pending === true && (r.key !== null || !r.requested_by)),
          ) ||
          new Set(rows.map((r) => r.label)).size !== rows.length
        )
          throw new Error();
        store.rows = rows;
      } catch {
        return unavailable("invalid JSON or connection records");
      }
    } else {
      try {
        await lstat(store.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
      }
      return unavailable("file cannot be read or exceeds the size limit");
    }
    return store;
  }
  private requireAvailable(): void {
    if (this.unavailable)
      throw new HttpError(
        503,
        `connected backends file is unreadable: fix or remove ${this.path}`,
      );
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    this.requireAvailable();
    const task = this.queue.then(work);
    this.queue = task.catch(() => {});
    return task;
  }
  private async save(rows: RecordRow[]): Promise<void> {
    const text = JSON.stringify(rows);
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new HttpError(409, "connected backend store full");
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
      this.rows = rows;
      for (const listener of this.listeners) listener();
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  list() {
    this.requireAvailable();
    return this.rows.map((r) => ({
      label: r.label,
      url: r.url,
      has_key: r.key !== null,
      requested_by: r.requested_by ?? null,
      ...(r.pending
        ? {
            state: "pending",
            reason: r.reason ?? "Needs sign-in",
            last_contact: null,
          }
        : (this.health.get(r.label) ?? unknownHealth())),
    }));
  }
  relayReady(label: string): void {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label);
    if (!row) throw new HttpError(404, `unknown backend ${label}`);
    if (row.pending)
      throw new HttpError(409, `${label} needs sign-in in Settings`);
    const state = this.health.get(label)?.state;
    if (state === "key_revoked")
      throw new HttpError(
        409,
        `${label}'s key was revoked: reconnect in Settings`,
      );
    if (state !== "connected")
      throw new HttpError(409, this.offlineReason(label));
  }
  offlineReason(label: string): string {
    const seen = this.health.get(label)?.last_contact;
    return `${label}: remote offline (last seen ${seen ? new Date(seen * 1000).toISOString() : "never"})`;
  }
  async checkRelay(label: string, signal: AbortSignal): Promise<void> {
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (row) await this.probe(row, signal);
    this.relayReady(label);
  }
  relay(
    label: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row) throw new HttpError(409, `${label} is no longer connected`);
    return remoteCall(row, path, {
      method: "POST",
      home: { id: this.homeId, name: this.home },
      body,
      timeoutMs,
      signal,
    });
  }
  settingsCall(
    label: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    this.requireAvailable();
    if (path !== "/api/models" && !SYNC_PATHS.some((p) => p === path))
      throw new HttpError(403, "not a settings sync route");
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row) throw new HttpError(404, "connected backend not found");
    return remoteCall(row, path, {
      method: body === undefined ? "GET" : "POST",
      body,
      signal,
      timeoutMs: 3000,
    });
  }
  async proxy(
    label: string,
    path: string,
    request: Request,
    longRunning: boolean,
    agent?: string,
  ) {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label);
    if (!row) throw new HttpError(404, "unknown backend");
    if (row.pending)
      throw new HttpError(409, `Backend ${label} needs sign-in in Settings`);
    if (agent && !row.key)
      throw new HttpError(
        403,
        "agent control requires a backend key: reconnect with authentication",
      );
    try {
      const response = await remoteStream(
        row,
        path,
        request,
        longRunning,
        agent,
      );
      if (response.ok)
        this.setHealth(row, {
          state: "connected",
          last_contact: Date.now() / 1000,
          reason: null,
        });
      return response;
    } catch (error) {
      if (!request.signal.aborted) this.setOffline(row);
      throw error;
    }
  }
  transcript(label: string, cid: string, query: URLSearchParams) {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label);
    if (!row)
      throw new HttpError(
        404,
        `messages works only for backends this one connects to; read ${cid} on ${label} directly`,
      );
    if (row.pending)
      throw new HttpError(409, `${label} needs sign-in in Settings`);
    return remoteCall(
      row,
      `/api/subagent-tool/conversations/${cid}/transcript`,
      {
        query,
        maxResponseBytes: 2 * 1024 * 1024,
      },
    );
  }
  get homeLabel(): string {
    return this.home;
  }
  request(label: unknown, value: unknown, requested_by: string): Promise<void> {
    this.requireAvailable();
    if (!validBackendLabel(label))
      throw new HttpError(422, "invalid backend label");
    const url = backendUrl(value);
    return this.serialized(async () => {
      if (this.rows.some((r) => r.label === label))
        throw new HttpError(409, "label taken");
      if (this.rows.filter((r) => r.pending).length >= 20)
        throw new HttpError(409, "too many pending backends");
      await this.save([
        ...this.rows,
        {
          label,
          url,
          key: null,
          added: Date.now() / 1000,
          pending: true,
          requested_by,
        },
      ]);
    });
  }
  connect(label: unknown, value: unknown, password: unknown): Promise<void> {
    return this.establish(label, value, password);
  }
  signIn(label: string, password: unknown): Promise<void> {
    return this.establish(label, undefined, password, true);
  }
  private establish(
    label: unknown,
    value: unknown,
    password: unknown,
    signIn = false,
  ): Promise<void> {
    this.requireAvailable();
    if (!validBackendLabel(label))
      throw new HttpError(422, "invalid backend label");
    const url = signIn ? undefined : backendUrl(value);
    return this.serialized(async () => {
      const pending = this.rows.find((r) => r.label === label);
      if (signIn ? !pending?.pending : pending)
        throw new HttpError(
          signIn ? 404 : 409,
          signIn ? "pending backend not found" : "label taken",
        );
      const row: RecordRow = {
        label,
        url: url ?? pending!.url,
        key: null,
        added: Date.now() / 1000,
      };
      const call = async (
        stage: "status" | "key_creation",
        path: string,
        options: NonNullable<Parameters<typeof remoteCall>[2]> & {
          timeoutMs: number;
        },
      ) => {
        const started = performance.now();
        let outcome = "unavailable";
        try {
          const response = await remoteCall(row, path, options);
          outcome = String(response.status);
          return response;
        } catch (error) {
          const timedOut = error instanceof RemoteCallError && error.timedOut;
          outcome = timedOut ? "timeout" : "unavailable";
          throw new HttpError(
            timedOut ? 504 : 502,
            timedOut
              ? `the remote took too long during ${stage === "status" ? "status check" : "sign-in"} (${options.timeoutMs / 1000} second limit); try again`
              : "backend unreachable",
          );
        } finally {
          this.signInDiagnostic?.({
            stage,
            elapsed_ms: Math.round(performance.now() - started),
            outcome,
          });
        }
      };
      try {
        let response = await call("status", "/api/status", {
          timeoutMs: 10_000,
        });
        if (response.status === 401) {
          if (typeof password !== "string" || password.length > 4096)
            throw new HttpError(422, "remote password required");
          response = await call("key_creation", "/api/backend-keys", {
            method: "POST",
            body: { password, name: this.home },
            timeoutMs: 60_000,
          });
          if (response.status === 401)
            throw new HttpError(422, "wrong password");
          if (response.status === 429)
            throw new HttpError(
              429,
              "too many attempts",
              response.retryAfter ? { "retry-after": response.retryAfter } : {},
            );
          const key = (response.data as { key?: unknown } | null)?.key;
          if (
            response.status !== 200 ||
            typeof key !== "string" ||
            !/^recurse-link_[a-f0-9]{16}_[a-f0-9]{64}$/.test(key)
          )
            throw new HttpError(502, "not a Recurse backend");
          row.key = key;
        } else if (response.status !== 200 || !isStatus(response.data))
          throw new HttpError(502, "not a Recurse backend");
        try {
          await this.save([...this.rows.filter((r) => r !== pending), row]);
        } catch {
          if (row.key)
            await remoteCall(row, "/api/backend-keys/self", {
              method: "DELETE",
            }).catch(() => {});
          throw new HttpError(500, "could not save connected backend");
        }
        this.changed = true;
        this.wake?.();
      } catch (error) {
        if (signIn && pending) {
          await this.save(
            this.rows.map((r) =>
              r === pending
                ? {
                    ...r,
                    reason:
                      error instanceof HttpError
                        ? error.message
                        : "Sign-in failed",
                  }
                : r,
            ),
          );
        }
        throw error;
      }
    });
  }
  disconnect(label: string): Promise<string | null> {
    return this.serialized(async () => {
      const row = this.rows.find((r) => r.label === label);
      if (!row) throw new HttpError(404, "backend not found");
      let warning: string | null = null;
      if (row.key) {
        let response;
        try {
          response = await remoteCall(row, "/api/backend-keys/self", {
            method: "DELETE",
          });
        } catch {
          warning = `${label} could not be reached: its key stays valid until you revoke it in ${label}'s Settings → Remotes.`;
        }
        if (response && response.status !== 200 && response.status !== 401)
          throw new HttpError(
            502,
            "remote refused key revocation; connection kept",
          );
      }
      await this.save(this.rows.filter((r) => r !== row));
      this.health.delete(label);
      this.retries.delete(label);
      return warning;
    });
  }
  private setHealth(row: RecordRow, next: Health): void {
    if (!this.rows.includes(row)) return;
    const previous = this.health.get(row.label);
    this.health.set(row.label, next);
    if (next.state === "connected") this.retries.delete(row.label);
    else {
      const delay = Math.min(
        (this.retries.get(row.label)?.delay ?? 30_000) * 2,
        300_000,
      );
      this.retries.set(row.label, { delay, at: Date.now() + delay });
    }
    if (previous?.state !== next.state)
      this.connectionDiagnostic?.({
        label: row.label,
        state: next.state === "unreachable" ? "offline" : next.state,
      });
  }
  private setOffline(row: RecordRow): void {
    this.setHealth(row, {
      state: "unreachable",
      last_contact: this.health.get(row.label)?.last_contact ?? null,
      reason: "Backend unreachable",
    });
  }
  private async probe(row: RecordRow, signal: AbortSignal): Promise<void> {
    try {
      const response = await remoteCall(row, "/api/status", {
        signal,
        timeoutMs: 3000,
      });
      this.setHealth(
        row,
        response.status === 200 && isStatus(response.data)
          ? {
              state: "connected",
              last_contact: Date.now() / 1000,
              reason: null,
            }
          : {
              state:
                response.status === 401 && row.key
                  ? "key_revoked"
                  : "unreachable",
              last_contact: this.health.get(row.label)?.last_contact ?? null,
              reason:
                response.status === 401 && row.key
                  ? "Key revoked; reconnect in Settings"
                  : response.status === 200
                    ? "Not a Recurse backend"
                    : "Backend unreachable",
            },
      );
    } catch {
      if (!signal.aborted) this.setOffline(row);
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.unavailable) return;
    while (!signal.aborted) {
      this.changed = false;
      for (const row of this.rows) {
        if (signal.aborted) return;
        if (row.pending || (this.retries.get(row.label)?.at ?? 0) > Date.now())
          continue;
        await this.probe(row, signal);
      }
      if (signal.aborted) return;
      if (this.changed) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, 60_000);
        this.wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
