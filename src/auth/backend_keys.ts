// Inbound per-home keys grant operator authority, not provider/service auth.
// Agent provenance narrows that authority on both proxy and receiving sides.
// Recheck disk digests per request; serialize atomic 0600 credential writes.
// See ../backends/README.md for route scope and credential lifecycle.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { open, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { readRegular } from "./service";
import { SYNC_PATHS } from "../backends/settings_sync";

const MAX_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9._-]{1,32}$/;
export const BACKEND_KEY_PREFIX = "recurse-link_";
export const validBackendKeyName = (name: unknown): name is string =>
  typeof name === "string" && NAME.test(name);

interface KeyRecord {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
  sha256: string;
}

export class BackendKeys {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<string>();
  private passwords: Promise<unknown> = Promise.resolve();

  /** Keep old-password minting from completing after password revocation. */
  withPasswordLock<T>(work: () => Promise<T>): Promise<T> {
    const task = this.passwords.then(work);
    this.passwords = task.catch(() => {});
    return task;
  }

  constructor(dataDir: string) {
    this.path = join(dataDir, "backend-keys.json");
  }

  private async read(): Promise<KeyRecord[]> {
    const bytes = await readRegular(this.path, MAX_BYTES);
    if (bytes === null) {
      try {
        await stat(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      }
      throw new Error("backend key store unavailable");
    }
    const rows: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(rows) ||
      rows.some(
        (r) =>
          !r ||
          !/^[a-f0-9]{16}$/.test(r.id) ||
          !validBackendKeyName(r.name) ||
          !Number.isFinite(r.created) ||
          !(r.last_used === null || Number.isFinite(r.last_used)) ||
          typeof r.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(r.sha256),
      ) ||
      new Set(rows.map((r) => r.id)).size !== rows.length
    )
      throw new Error("backend key store unavailable");
    return rows;
  }

  private mutate<T>(work: (rows: KeyRecord[]) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const rows = await this.read();
      const result = work(rows);
      const text = JSON.stringify(rows);
      if (Buffer.byteLength(text) > MAX_BYTES)
        throw new Error("backend key store full");
      const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const handle = await open(tmp, "wx", 0o600);
        try {
          await handle.writeFile(text);
        } finally {
          await handle.close();
        }
        await rename(tmp, this.path);
      } finally {
        await unlink(tmp).catch(() => {});
      }
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async mint(name: string) {
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("hex");
    await this.mutate((rows) =>
      rows.push({
        id,
        name,
        created: Date.now() / 1000,
        last_used: null,
        sha256: createHash("sha256").update(secret).digest("hex"),
      }),
    );
    return { id, name, key: `${BACKEND_KEY_PREFIX}${id}_${secret}` };
  }

  async list() {
    return (await this.read()).map(({ id, name, created, last_used }) => ({
      id,
      name,
      created,
      last_used,
    }));
  }

  revoke(id?: string): Promise<void> {
    return this.mutate((rows) => {
      if (id === undefined) rows.length = 0;
      else {
        const at = rows.findIndex((r) => r.id === id);
        if (at >= 0) rows.splice(at, 1);
      }
    });
  }

  async verify(
    authorization: string,
  ): Promise<{ id: string; name: string } | null> {
    const match = /^Bearer recurse-link_([a-f0-9]{16})_([a-f0-9]{64})$/i.exec(
      authorization,
    );
    if (!match) return null;
    let rows: KeyRecord[];
    try {
      rows = await this.read();
    } catch {
      return null;
    }
    const record = new Map(rows.map((r) => [r.id, r])).get(match[1]!);
    const candidate = createHash("sha256").update(match[2]!).digest();
    const expected = record
      ? Buffer.from(record.sha256, "hex")
      : randomBytes(32);
    if (
      !timingSafeEqual(new Uint8Array(candidate), new Uint8Array(expected)) ||
      !record
    )
      return null;
    if (
      (record.last_used === null ||
        Date.now() / 1000 - record.last_used >= 60) &&
      !this.pending.has(record.id)
    ) {
      this.pending.add(record.id);
      void this.mutate((current) => {
        const row = current.find((r) => r.id === record.id);
        if (
          row &&
          (row.last_used === null || Date.now() / 1000 - row.last_used >= 60)
        )
          row.last_used = Date.now() / 1000;
      })
        .catch(() => {})
        .finally(() => this.pending.delete(record.id));
    }
    return { id: record.id, name: record.name };
  }
}

/** Narrow operator keys to agent routes when provenance is present. */
export function backendAgentAllowed(method: string, path: string): boolean {
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/(safety|pin)\/?$/.test(path)
  )
    return false;
  return (
    /^\/api\/(conversations|attachments|attachment-drafts|artifacts)(\/|$)/.test(
      path,
    ) ||
    (["GET", "HEAD"].includes(method) &&
      /^\/api\/(tree|version|status|models)$/.test(path)) ||
    (method === "GET" &&
      /^\/api\/subagent-tool\/conversations\/[^/]+\/transcript$/.test(path))
  );
}

/**
 * Remote operator Settings routes; MCP OAuth starts at its callback origin.
 */
export function remoteSettingsRoute(path: string): boolean {
  return (
    /^\/api\/pi\/(auth|codex-auth|muse-auth|openrouter-auth|custom-provider-auth)(\/|$)/.test(
      path,
    ) ||
    /^\/api\/settings\/(model-list|model-list-update|maximum-context-window|default-efforts|effort-levels|mcp-servers(\/(status|check|sign-out))?)$/.test(
      path,
    )
  );
}

/** Receiving key permissions; narrow agent-marked requests first. */
export function backendKeyAllowed(method: string, path: string): boolean {
  if (remoteSettingsRoute(path)) return true;
  if (["GET", "POST"].includes(method) && SYNC_PATHS.some((p) => p === path))
    return true;
  if (method === "DELETE" && path === "/api/backend-keys/self") return true;
  if (method === "GET" && path === "/api/relay/requests") return true;
  if (
    method === "GET" &&
    /^\/api\/subagent-tool\/conversations\/[^/]+\/transcript$/.test(path)
  )
    return true;
  if (
    method === "POST" &&
    /^\/api\/relay\/requests\/[A-Za-z0-9._-]{1,64}\/result$/.test(path)
  )
    return true;
  if (
    method === "GET" &&
    ["tree", "version", "status", "models"].some((p) => path === `/api/${p}`)
  )
    return true;
  return /^\/api\/(conversations|attachments|attachment-drafts|artifacts)(\/|$)/.test(
    path,
  );
}
