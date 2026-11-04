// Private home connections in Pi's credential directory; atomic 0600 writes.
// Only operator sign-in contacts pending URLs; agent requests store no key.
// Health is probed on demand; rejected keys persistently stop automatic calls.
// See README.md for credential, pending-state and recovery boundaries.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { readRegular } from "../auth/service";
import { validBackendLabel } from "./label";
import { HttpError } from "../web/router";
import {
  remoteCall,
  remoteStream,
  RemoteCallError,
  type RemoteTiming,
} from "./remote_client";
import { SYNC_PATHS } from "./settings_sync";
import { API_MAJOR, API_REVISION } from "../web/api_v1/schema";

interface RecordRow {
  label: string;
  url: string;
  key: string | null;
  added: number;
  pending?: boolean;
  key_revoked?: boolean;
  requested_by?: string;
  reason?: string;
  callback_sha256?: string;
}
interface Health {
  state: "connected" | "unreachable" | "key_revoked";
  last_contact: number | null;
  reason: string | null;
}
interface Compatibility {
  compatibility: "compatible" | "older" | "incompatible" | "unknown";
  remote_api: number | null;
  remote_revision: number | null;
  remote_release: string | null;
  etag: string | null;
}
interface Sleep {
  until: number;
  check: string | null;
  key: string | null;
}
interface VersionCheck {
  controller: AbortController;
  waiters: number;
  done: Promise<boolean>;
}
const unknownCompatibility = (): Compatibility => ({
  compatibility: "unknown",
  remote_api: null,
  remote_revision: null,
  remote_release: null,
  etag: null,
});

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
/** When a 200 answer with `sleep_seconds` lets this home poll again. */
const sleepUntil = (response: { status: number; data: unknown }) => {
  const sleep = (response.data as { sleep_seconds?: unknown } | null)
    ?.sleep_seconds;
  return response.status === 200 && typeof sleep === "number" && sleep > 0
    ? Date.now() + Math.min(sleep, 86_400) * 1000
    : null;
};
/** A sleeping remote's check-in URL, if on the remote's own scheme. */
const checkUrl = (remote: string, response: { data: unknown }) => {
  try {
    const url = backendUrl(
      (response.data as { check_url?: unknown } | null)?.check_url,
    );
    return new URL(url).protocol === new URL(remote).protocol ? url : null;
  } catch {
    return null;
  }
};
const digest = (token: string): Buffer =>
  createHash("sha256").update(token).digest();
export const CALLBACK_TOKEN_PREFIX = "recurse-callback_";

export class ConnectedBackends {
  private rows: RecordRow[] = [];
  private readonly health = new Map<string, Health>();
  private readonly versions = new Map<string, Compatibility>();
  private callSequence = 0;
  private readonly apiResponses = new WeakMap<RecordRow, number>();
  private readonly versionChecks = new WeakMap<RecordRow, VersionCheck>();
  private readonly probed = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastOperator = 0;
  private lastHome = 0;
  private origin: string | null = null;
  private readonly events = new Map<
    string,
    { waiting: boolean; wake?: () => void }
  >();
  private readonly pendingCallbacks = new Map<string, Buffer>();
  private readonly registered = new Map<string, string>();
  private readonly registering = new Set<string>();
  private readonly registerRetry = new Map<string, number>();
  /** Operator use lasts this long after the last browser request. */
  idleAfterMs = 180_000;
  /** True while agents run on this instance; set by the app. */
  busy: () => boolean = () => false;
  /** Paused remotes: when to re-poll; check-in URL and the key it gets. */
  private readonly asleep = new Map<string, Sleep>();
  private readonly homeId = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  connectedLabels(): string[] {
    return this.rows.filter((r) => !r.pending).map((r) => r.label);
  }
  /** Approved, reachable remotes that have not asked this home to pause. */
  awakeLabels(): string[] {
    return this.pollingLabels().filter(
      (label) =>
        !this.asleep.has(label) &&
        this.health.get(label)?.state === "connected",
    );
  }
  pollingLabels(): string[] {
    return this.rows
      .filter((r) => !r.pending && !r.key_revoked)
      .map((r) => r.label);
  }
  async poll(
    label: string,
    labels: string[],
    signal: AbortSignal,
    wait: number,
  ) {
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row || row.key_revoked)
      throw new HttpError(409, "backend disconnected or needs sign-in");
    const response = await this.call(row, "/api/relay/requests", {
      home: { id: this.homeId, name: this.home },
      query: new URLSearchParams({
        labels: labels.join(","),
        wait: String(wait),
      }),
      timeoutMs: 30_000,
      signal,
    });
    if (response.status === 401) await this.revoke(row);
    const wasSleeping = this.asleep.has(label);
    const until = sleepUntil(response);
    if (until && this.rows.includes(row))
      this.asleep.set(label, {
        until,
        check: checkUrl(row.url, response),
        key: row.key,
      });
    else if (response.status === 200) this.asleep.delete(label);
    if (response.status === 200) this.contact(row);
    if (wasSleeping !== this.asleep.has(label)) this.changed();
    return response;
  }
  /** Ask the check-in URL whether a paused home keeps sleeping; else poll. */
  private async checkIn(
    label: string,
    asleep: Sleep,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.call(
      { label, url: asleep.check!, key: asleep.key },
      "/api/relay/requests",
      { timeoutMs: 10_000, signal },
    ).catch(() => null);
    if (signal.aborted || this.asleep.get(label) !== asleep) return;
    if (response?.status === 401) {
      const row = this.rows.find((r) => r.label === label);
      if (row) await this.revoke(row);
      return;
    }
    const until = response && sleepUntil(response);
    if (until) asleep.until = until;
    else asleep.check = null;
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
    private readonly callDiagnostic?: (
      fields: RemoteTiming & { label: string },
    ) => void,
  ) {}

  static async load(
    directory: string,
    home: string,
    warn: (path: string, reason: string) => void,
    signInDiagnostic?: ConnectedBackends["signInDiagnostic"],
    connectionDiagnostic?: ConnectedBackends["connectionDiagnostic"],
    callDiagnostic?: ConnectedBackends["callDiagnostic"],
  ): Promise<ConnectedBackends> {
    const store = new ConnectedBackends(
      join(directory, "recurse-backends.json"),
      home.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32) || "home",
      signInDiagnostic,
      connectionDiagnostic,
      callDiagnostic,
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
                r.key_revoked === undefined ||
                typeof r.key_revoked === "boolean"
              ) ||
              !(
                r.requested_by === undefined ||
                typeof r.requested_by === "string"
              ) ||
              !(r.reason === undefined || typeof r.reason === "string") ||
              !(
                r.callback_sha256 === undefined ||
                (typeof r.callback_sha256 === "string" &&
                  /^[a-f0-9]{64}$/.test(r.callback_sha256))
              ) ||
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
  private async call(
    row: { label: string; url: string; key: string | null },
    path: string,
    options: Parameters<typeof remoteCall>[2] = {},
  ) {
    const sequence = ++this.callSequence;
    const response = await remoteCall(row, path, {
      ...options,
      report: (fields) =>
        this.callDiagnostic?.({ label: row.label, ...fields }),
    });
    const api = response.api?.match(/^(\d{1,4})\.(\d{1,4})$/);
    const stored = this.rows.find((entry) => entry === row);
    if (
      api &&
      stored &&
      response.status !== 401 &&
      sequence > (this.apiResponses.get(stored) ?? 0)
    ) {
      this.apiResponses.set(stored, sequence);
      const previous = this.versions.get(row.label);
      const major = Number(api[1]);
      const revision = Number(api[2]);
      if (
        previous &&
        (previous.remote_api !== major || previous.remote_revision !== revision)
      )
        this.setVersion(stored, {
          ...unknownCompatibility(),
          compatibility:
            major !== API_MAJOR
              ? "incompatible"
              : revision < API_REVISION
                ? "older"
                : "compatible",
          remote_api: major,
          remote_revision: revision,
        });
    }
    return response;
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
  private async save(rows: RecordRow[], onSaved?: () => void): Promise<void> {
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
      onSaved?.();
      this.changed();
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  /** Safe status shared by Settings routes and the native settings tool. */
  listForAgents(title: (cid: string) => string | undefined) {
    void this.refreshStale().catch(() => {});
    return this.list().map((row) => ({
      ...row,
      requested_by_title: row.requested_by
        ? (title(row.requested_by) ?? null)
        : null,
    }));
  }

  list() {
    this.requireAvailable();
    return this.rows.map((r) => {
      const { compatibility, remote_api, remote_revision, remote_release } =
        this.versions.get(r.label) ?? unknownCompatibility();
      return {
        label: r.label,
        url: r.url,
        has_key: r.key !== null,
        requested_by: r.requested_by ?? null,
        compatibility,
        remote_api,
        remote_revision,
        remote_release,
        ...(r.pending
          ? {
              state: "pending",
              reason: r.reason ?? "Needs sign-in",
              last_contact: null,
            }
          : r.key_revoked
            ? {
                state: "key_revoked",
                reason: "Sign-in required; reconnect in Settings",
                last_contact: this.health.get(r.label)?.last_contact ?? null,
              }
            : (this.health.get(r.label) ?? unknownHealth())),
      };
    });
  }
  /** Probe connections not heard from in the last minute, in parallel. */
  async refreshStale(): Promise<void> {
    this.requireAvailable();
    const stale = Date.now() - 60_000;
    await Promise.all(
      this.rows
        .filter(
          (r) =>
            !r.pending &&
            !r.key_revoked &&
            !this.asleep.has(r.label) &&
            (this.health.get(r.label)?.last_contact ?? 0) * 1000 < stale &&
            (this.probed.get(r.label) ?? 0) < stale,
        )
        .map((r) => this.probe(r, AbortSignal.timeout(5000))),
    );
  }
  /** Admission checks that need no network; sends and gateway calls probe. */
  relayAdmit(label: string): RecordRow {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label);
    if (!row) throw new HttpError(404, `unknown backend ${label}`);
    if (row.pending)
      throw new HttpError(409, `${label} needs sign-in in Settings`);
    if (row.key_revoked)
      throw new HttpError(
        409,
        `${label}'s key was revoked: reconnect in Settings`,
      );
    this.requireCompatible(label);
    return row;
  }
  async relayReady(label: string): Promise<void> {
    const row = this.relayAdmit(label);
    if (
      (this.health.get(label)?.state !== "connected" ||
        !this.versions.has(label)) &&
      Date.now() - (this.probed.get(label) ?? 0) > 10_000
    )
      await this.probe(row, AbortSignal.timeout(65_000), 60_000);
    const state = this.health.get(label)?.state;
    if (state === "key_revoked")
      throw new HttpError(
        409,
        `${label}'s key was revoked: reconnect in Settings`,
      );
    if (state !== "connected")
      throw new HttpError(409, this.offlineReason(label));
    this.requireCompatible(label);
  }
  offlineReason(label: string): string {
    const seen = this.health.get(label)?.last_contact;
    return `${label}: remote offline (last seen ${seen ? new Date(seen * 1000).toISOString() : "never"})`;
  }
  async checkRelay(
    label: string,
    signal: AbortSignal,
    force = true,
  ): Promise<void> {
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (
      row &&
      (force ||
        this.health.get(label)?.state !== "connected" ||
        (this.versions.get(label)?.compatibility ?? "unknown") === "unknown")
    )
      await this.probe(row, signal, 60_000);
    this.wake(label);
    signal.throwIfAborted();
    await this.relayReady(label);
  }
  async relay(
    label: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row) throw new HttpError(409, `${label} is no longer connected`);
    const response = await this.call(row, path, {
      method: "POST",
      home: { id: this.homeId, name: this.home },
      body,
      timeoutMs,
      signal,
    });
    if (response.status === 401) await this.revoke(row);
    return response;
  }
  async settingsCall(
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
    const response = await this.call(row, path, {
      method: body === undefined ? "GET" : "POST",
      body,
      signal,
      timeoutMs: 3000,
    });
    if (response.status === 401) await this.revoke(row);
    return response;
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
    if (row.key_revoked)
      throw new HttpError(
        424,
        `${label}'s key was revoked: reconnect in Settings`,
      );
    this.requireCompatible(label);
    const pathname = path.split("?", 1)[0]!;
    if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
      if (!this.versions.has(label))
        await this.refreshVersion(row, request.signal).catch(() => {});
      const required = 3;
      const version = this.versions.get(label);
      if (
        version?.remote_api !== API_MAJOR ||
        (version.remote_revision ?? 0) < required
      )
        throw new HttpError(
          409,
          `remote ${label} requires API v${API_MAJOR} revision ${required} for this route; update the remote or check its version in Settings`,
        );
    }
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
        (fields) => this.callDiagnostic?.({ label, ...fields }),
      );
      if (response.status === 401) await this.revoke(row);
      if (response.ok) this.contact(row);
      this.wake(label);
      return response;
    } catch (error) {
      if (!request.signal.aborted) this.setOffline(row);
      throw error;
    }
  }
  /** A passive tag stream never wakes a paused remote or counts as use. */
  async treeEvents(label: string, request: Request): Promise<Response | null> {
    this.requireAvailable();
    if (!this.awakeLabels().includes(label)) return null;
    const row = this.rows.find((row) => row.label === label)!;
    this.requireCompatible(label);
    const response = await remoteStream(
      row,
      "/api/tree/events",
      request,
      true,
      undefined,
      (fields) => this.callDiagnostic?.({ label, ...fields }),
    );
    if (response.status === 401) await this.revoke(row);
    return response;
  }
  async transcript(label: string, cid: string, query: URLSearchParams) {
    this.requireAvailable();
    const row = this.rows.find((r) => r.label === label);
    if (!row)
      throw new HttpError(
        404,
        `transcript reads work only for backends this one connects to; read ${cid} on ${label} directly`,
      );
    if (row.pending)
      throw new HttpError(409, `${label} needs sign-in in Settings`);
    this.requireCompatible(label);
    const response = await this.call(
      row,
      `/api/subagent-tool/conversations/${cid}/transcript`,
      {
        query,
        maxResponseBytes: 2 * 1024 * 1024,
      },
    );
    if (response.status === 401) await this.revoke(row);
    if (response.status === 200) await this.resume(row);
    this.wake(label);
    return response;
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
      if (
        signIn
          ? !pending || (!pending.pending && !pending.key_revoked)
          : pending
      )
        throw new HttpError(
          signIn ? 404 : 409,
          signIn ? "backend needing sign-in not found" : "label taken",
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
          const response = await this.call(row, path, options);
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
        const foundVersion = await this.readVersion(row);
        const version =
          typeof foundVersion === "object" && foundVersion
            ? foundVersion
            : unknownCompatibility();
        try {
          await this.save(
            [...this.rows.filter((r) => r !== pending), row],
            () => this.setVersion(row, version),
          );
        } catch {
          if (row.key)
            await this.call(row, "/api/backend-keys/self", {
              method: "DELETE",
            }).catch(() => {});
          throw new HttpError(500, "could not save connected backend");
        }
        this.asleep.delete(label);
        this.events.get(label)?.wake?.();
        this.setHealth(row, {
          state: "connected",
          last_contact: Date.now() / 1000,
          reason: null,
        });
        this.ensureCallbacks();
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
          response = await this.call(row, "/api/backend-keys/self", {
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
      this.versions.delete(label);
      this.probed.delete(label);
      this.registered.delete(label);
      this.events.get(label)?.wake?.();
      this.events.delete(label);
      this.asleep.delete(label);
      this.ensureCallbacks();
      return warning;
    });
  }
  private setHealth(row: RecordRow, next: Health): void {
    if (!this.rows.includes(row)) return;
    const previous = this.health.get(row.label);
    this.health.set(row.label, next);
    if (previous?.state !== next.state) {
      this.connectionDiagnostic?.({
        label: row.label,
        state: next.state === "unreachable" ? "offline" : next.state,
      });
      this.changed();
    }
  }
  private async revoke(row: RecordRow): Promise<void> {
    if (!this.rows.includes(row)) return;
    row.key_revoked = true;
    this.asleep.delete(row.label);
    this.setHealth(row, {
      state: "key_revoked",
      last_contact: this.health.get(row.label)?.last_contact ?? null,
      reason: "Sign-in required; reconnect in Settings",
    });
    await this.serialized(async () => {
      if (this.rows.includes(row)) await this.save(this.rows);
    });
  }
  private async resume(row: RecordRow): Promise<void> {
    if (row.key_revoked)
      await this.serialized(async () => {
        if (!this.rows.includes(row)) return;
        delete row.key_revoked;
        await this.save(this.rows);
      });
    this.contact(row);
  }
  private setOffline(row: RecordRow): void {
    if (row.key_revoked) return;
    this.setHealth(row, {
      state: "unreachable",
      last_contact: this.health.get(row.label)?.last_contact ?? null,
      reason: "Backend unreachable",
    });
  }
  private requireCompatible(label: string): void {
    const version = this.versions.get(label);
    if (version?.compatibility !== "incompatible") return;
    throw new HttpError(
      409,
      version.remote_api === null
        ? `remote ${label} returned an invalid API version; update the remote`
        : `remote ${label} speaks API v${version.remote_api}; this home speaks v${API_MAJOR}: update the incompatible instance`,
    );
  }
  private async readVersion(
    row: RecordRow,
    signal?: AbortSignal,
  ): Promise<Compatibility | "unchanged" | "key_revoked" | null> {
    const previous = this.versions.get(row.label);
    try {
      const response = await this.call(row, "/api/version", {
        signal,
        timeoutMs: 3000,
        ifNoneMatch: previous?.etag ?? undefined,
      });
      if (response.status === 401) {
        await this.revoke(row);
        return "key_revoked";
      }
      if (response.status === 304 && previous?.etag) return "unchanged";
      if (response.status !== 200) return null;
      const data = response.data as {
        api?: unknown;
        api_revision?: unknown;
        release?: unknown;
      } | null;
      const api = data?.api;
      const revision = data?.api_revision === undefined ? 0 : data.api_revision;
      const current = this.versions.get(row.label);
      if (
        current !== previous &&
        current &&
        (current.remote_api !== api || current.remote_revision !== revision)
      )
        return null;
      if (
        !Number.isSafeInteger(api) ||
        (api as number) < 0 ||
        !Number.isSafeInteger(revision) ||
        (revision as number) < 0
      )
        return { ...unknownCompatibility(), compatibility: "incompatible" };
      const release = data?.release;
      let remote_release: string | null = null;
      if (typeof release === "string") remote_release = release;
      else if (release && typeof release === "object") {
        const { version, commit } = release as {
          version?: unknown;
          commit?: unknown;
        };
        if (typeof version === "string")
          remote_release =
            typeof commit === "string" ? `${version} (${commit})` : version;
      }
      remote_release = remote_release?.slice(0, 160) ?? null;
      return {
        compatibility:
          api !== API_MAJOR
            ? "incompatible"
            : (revision as number) < API_REVISION
              ? "older"
              : "compatible",
        remote_api: api as number,
        remote_revision: revision as number,
        remote_release,
        etag: response.etag,
      };
    } catch {
      return null;
    }
  }
  private setVersion(row: RecordRow, version: Compatibility): void {
    if (!this.rows.includes(row)) return;
    const previous = this.versions.get(row.label);
    this.versions.set(row.label, version);
    if (previous?.compatibility !== version.compatibility)
      this.connectionDiagnostic?.({
        label: row.label,
        state: `api_${version.compatibility}`,
      });
  }
  private async refreshVersion(
    row: RecordRow,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    let check = this.versionChecks.get(row);
    if (!check) {
      const controller = new AbortController();
      const current: VersionCheck = {
        controller,
        waiters: 0,
        done: Promise.resolve(true),
      };
      current.done = this.readVersion(row, controller.signal)
        .then((version) => {
          if (
            !controller.signal.aborted &&
            version &&
            typeof version === "object"
          )
            this.setVersion(row, version);
          return version !== "key_revoked";
        })
        .finally(() => {
          if (this.versionChecks.get(row) === current)
            this.versionChecks.delete(row);
        });
      this.versionChecks.set(row, current);
      check = current;
    }
    check.waiters++;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        check.done,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (--check.waiters === 0 && this.versionChecks.get(row) === check) {
        this.versionChecks.delete(row);
        check.controller.abort();
      }
    }
  }
  /** Probe status; explicit actions allow `timeoutMs` for a remote to wake. */
  private async probe(
    row: RecordRow,
    signal: AbortSignal,
    timeoutMs = 3000,
  ): Promise<void> {
    this.probed.set(row.label, Date.now());
    try {
      const response = await this.call(row, "/api/status", {
        signal,
        timeoutMs,
      });
      if (response.status === 401) {
        await this.revoke(row);
        return;
      }
      if (response.status === 200 && isStatus(response.data)) {
        if (!(await this.refreshVersion(row, signal)) || signal.aborted) return;
        if (timeoutMs === 60_000) await this.resume(row);
      }
      if (row.key_revoked) return;
      this.setHealth(
        row,
        response.status === 200 && isStatus(response.data)
          ? {
              state: "connected",
              last_contact: Date.now() / 1000,
              reason: null,
            }
          : {
              state: "unreachable",
              last_contact: this.health.get(row.label)?.last_contact ?? null,
              reason:
                response.status === 200
                  ? "Not a Recurse backend"
                  : "Backend unreachable",
            },
      );
    } catch {
      if (!signal.aborted) this.setOffline(row);
    }
  }
  /** Note operator use; a same-origin Origin is this home's address. */
  noteOperator(origin: string | null): void {
    const resumed = Date.now() - this.lastOperator >= this.idleAfterMs;
    this.lastOperator = Date.now();
    if (resumed) {
      this.registered.clear();
      this.registerRetry.clear();
    }
    try {
      if (origin && backendUrl(origin) === origin) this.origin = origin;
    } catch {}
    this.ensureCallbacks();
  }
  /** A successful exchange: mark contact and read an unknown API version. */
  private contact(row: RecordRow): void {
    if (row.key_revoked) return;
    this.setHealth(row, {
      state: "connected",
      last_contact: Date.now() / 1000,
      reason: null,
    });
    if (!this.versions.has(row.label))
      void this.refreshVersion(row, AbortSignal.timeout(30_000)).catch(
        () => {},
      );
  }
  private event(label: string) {
    const event = this.events.get(label) ?? { waiting: false };
    this.events.set(label, event);
    return event;
  }
  /** Note a home's request other than a relay poll: it counts as use. */
  noteHome(): void {
    this.lastHome = Date.now();
  }
  /** Nothing is busy and no operator or home request came for idleAfterMs. */
  idle(): boolean {
    return (
      !this.busy() &&
      Date.now() - Math.max(this.lastOperator, this.lastHome) >=
        this.idleAfterMs
    );
  }
  /** Resume polling a sleeping remote after this home's request reached it. */
  private wake(label: string): void {
    if (this.asleep.delete(label)) {
      this.event(label).wake?.();
      this.changed();
    }
  }
  /**
   * Seconds the next relay poll may wait: back-to-back long polls, paused
   * while the remote sleeps except for one-off polls on callback notices.
   */
  async pollWait(label: string, signal: AbortSignal): Promise<number> {
    while (true) {
      signal.throwIfAborted();
      const event = this.event(label);
      if (event.waiting) {
        event.waiting = false;
        return 0;
      }
      const asleep = this.asleep.get(label);
      const sleep = (asleep?.until ?? 0) - Date.now();
      if (sleep <= 0 && asleep?.check) {
        await this.checkIn(label, asleep, signal);
        continue;
      }
      if (sleep <= 0) return 25;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (event.wake === done) event.wake = undefined;
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(sleep, 60_000));
        event.wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  /** A remote reached this home's callback: note contact; poll on relay. */
  remoteEvent(label: string, type: "relay" | "test"): void {
    const row = this.rows.find((r) => r.label === label && !r.pending);
    if (!row || row.key_revoked) return;
    this.contact(row);
    if (type !== "relay") return;
    const event = this.event(label);
    event.waiting = true;
    event.wake?.();
  }
  /** The connection label a callback credential belongs to, if any. */
  callbackLabel(authorization: string): string | null {
    const match = /^Bearer (recurse-callback_[a-f0-9]{64})$/.exec(
      authorization,
    );
    if (!match) return null;
    const candidate = new Uint8Array(digest(match[1]!));
    let found: string | null = null;
    for (const row of this.rows)
      for (const expected of [
        this.pendingCallbacks.get(row.label),
        row.callback_sha256 && Buffer.from(row.callback_sha256, "hex"),
      ])
        if (expected && timingSafeEqual(candidate, new Uint8Array(expected)))
          found = row.label;
    return found;
  }
  private ensureCallbacks(): void {
    for (const row of this.rows) void this.ensureCallback(row.label);
  }
  /** Register this home's address and a fresh callback token on a remote. */
  private async ensureCallback(label: string): Promise<void> {
    const origin = this.origin;
    const row = this.rows.find((r) => r.label === label);
    if (
      !origin ||
      !row?.key ||
      row.pending ||
      row.key_revoked ||
      this.registering.has(label)
    )
      return;
    if (
      new URL(origin).protocol === "http:" &&
      new URL(row.url).protocol !== "http:"
    )
      return;
    const labels = [
      this.home,
      ...this.connectedLabels().filter((l) => l !== label),
    ];
    const signature = `${origin} ${labels.join(",")}`;
    if (
      this.registered.get(label) === signature ||
      (this.registerRetry.get(label) ?? 0) > Date.now()
    )
      return;
    this.registering.add(label);
    const token = CALLBACK_TOKEN_PREFIX + randomBytes(32).toString("hex");
    this.pendingCallbacks.set(label, digest(token));
    try {
      const response = await this.call(row, "/api/backend-keys/self/callback", {
        method: "PUT",
        body: { url: origin, token, labels },
        timeoutMs: 60_000,
      });
      if (response.status === 401) {
        await this.revoke(row);
        return;
      }
      await this.serialized(async () => {
        const current = this.rows.find((r) => r.label === label);
        if (!current || current.key !== row.key) return;
        const sha256 =
          response.status === 200 ? digest(token).toString("hex") : undefined;
        const next: RecordRow = { ...current, callback_sha256: sha256 };
        if (!sha256) delete next.callback_sha256;
        // Invariant: keep the live row; health and version updates match it.
        await this.save(
          this.rows.map((r) => (r === current ? next : r)),
          () => {
            this.rows = this.rows.map((r) => (r === next ? current : r));
            if (sha256) current.callback_sha256 = sha256;
            else delete current.callback_sha256;
          },
        );
      });
      this.registered.set(label, signature);
      this.connectionDiagnostic?.({
        label,
        state: response.status === 200 ? "push_notifications" : "polling",
      });
    } catch {
      this.registerRetry.set(label, Date.now() + 60_000);
    } finally {
      this.pendingCallbacks.delete(label);
      this.registering.delete(label);
    }
    void this.ensureCallback(label);
  }
}
