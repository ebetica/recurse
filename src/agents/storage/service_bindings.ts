// Persist principal-scoped external keys and per-conversation service bindings.
// A key resolves only to a live row with matching ownership metadata.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "../../utils";
import { pyCompactJson } from "../../utils/python-json";
import { CID_RE, type ConversationRecord } from "./conversation_store";

const END = "(?![\\s\\S])";
const PRINCIPAL_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${END}`, "u");
const EXTERNAL_KEY_RE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}${END}`,
  "u",
);

export function validateExternalKey(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string")
    throw new TypeError("external_key must be a string");
  if (!value) throw new Error("external_key must not be empty");
  if (value.length > 256)
    throw new Error("external_key must be at most 256 characters");
  if (!EXTERNAL_KEY_RE.test(value))
    throw new Error(
      "external_key must contain only letters, numbers, '.', '_', ':', or '-'",
    );
  return value;
}

export class ExternalKeyConflict extends Error {}
export class ServiceStorageUnavailable extends Error {}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const unreadable = Symbol("unreadable");
const malformed = Symbol("malformed");
type Leaf = ConversationRecord | null | typeof unreadable | typeof malformed;

// The reader requires before/open/after inode identity and O_NOFOLLOW.
async function readExternalLeaf(path: string): Promise<Leaf> {
  let handle: FileHandle | undefined;
  let found = false;
  try {
    const before = await lstat(path);
    found = true;
    if (!before.isFile()) return unreadable;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const after = await lstat(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    )
      return unreadable;
    try {
      const data = await handle.readFile();
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(Uint8Array.from(data));
      const parsed: unknown = JSON.parse(text);
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as ConversationRecord)
        : malformed;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        return malformed;
      return unreadable;
    }
  } catch (error) {
    return missing(error) && !found ? null : unreadable;
  } finally {
    await handle?.close();
  }
}

export class ServiceBindings {
  constructor(
    private readonly paths: {
      externalKeyDir: string;
      serviceBindingsDir: string;
    },
    private readonly hooks: {
      exists(cid: string): boolean;
      load(
        cid: string,
        options: { withPending: false },
      ): ConversationRecord | null;
      log?(event: string, fields: Record<string, unknown>): void;
    },
    private readonly ids: () => string,
  ) {}

  /** Unlink a leaf only while it is still the one this create attempt wrote. */
  private async unbindCreateLeaf(
    path: string,
    expected: ConversationRecord,
  ): Promise<void> {
    const record = await readExternalLeaf(path);
    if (record === unreadable)
      throw new ServiceStorageUnavailable("service binding unavailable");
    if (
      record !== null &&
      record !== malformed &&
      Object.entries(expected).every(
        ([field, value]) => record[field] === value,
      )
    )
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
  }

  private externalPath(principal: string, key: string): string {
    if (validateExternalKey(key) === null)
      throw new Error("external_key is required");
    if (typeof principal !== "string" || !principal)
      throw new Error("service principal is required");
    const digest = createHash("sha256")
      .update(`recurse-external-key-v1\0${principal}\0${key}`)
      .digest("hex");
    return join(this.paths.externalKeyDir, `${digest}.json`);
  }
  private conflict(path: string, reason: string): never {
    this.hooks.log?.("external_key_binding_invalid", {
      binding: path.split("/").at(-1)!.slice(0, -5),
      reason,
    });
    throw new ExternalKeyConflict("external_key binding is unavailable");
  }
  async lookupExternalKey(
    principal: string,
    key: string,
  ): Promise<ConversationRecord | null> {
    const path = this.externalPath(principal, key);
    const record = await readExternalLeaf(path);
    if (record === null) return null;
    if (record === malformed) this.conflict(path, "malformed");
    if (record === unreadable) this.conflict(path, "unreadable");
    const cid = record.conversation_id;
    if (
      record.principal !== principal ||
      record.external_key !== key ||
      typeof cid !== "string" ||
      !CID_RE.test(cid)
    )
      this.conflict(path, "record");
    const conv = this.hooks.load(cid, { withPending: false });
    if (
      !conv ||
      conv.external_key !== key ||
      conv.service_principal !== principal ||
      !this.hooks.exists(cid)
    )
      this.conflict(path, "target");
    return conv;
  }
  async bindExternalKey(
    principal: string,
    key: string,
    cid: string,
    createToken?: string,
  ): Promise<void> {
    const path = this.externalPath(principal, key);
    const record = await readExternalLeaf(path);
    if (record === null) {
      await atomicJson(
        path,
        {
          principal,
          external_key: key,
          conversation_id: cid,
          ...(createToken === undefined ? {} : { create_token: createToken }),
        },
        this.ids,
      );
      return;
    }
    if (record === malformed) this.conflict(path, "malformed");
    if (record === unreadable) this.conflict(path, "unreadable");
    if (
      createToken === undefined &&
      record.principal === principal &&
      record.external_key === key &&
      record.conversation_id === cid
    )
      return;
    this.conflict(path, "occupied");
  }
  async unbindExternalKey(
    principal: string,
    key: string,
    cid: string,
    createToken?: string,
  ): Promise<void> {
    const path = this.externalPath(principal, key);
    if (createToken !== undefined)
      return this.unbindCreateLeaf(path, {
        principal,
        external_key: key,
        conversation_id: cid,
        create_token: createToken,
      });
    const record = await readExternalLeaf(path);
    if (record === unreadable) {
      this.hooks.log?.("external_key_binding_invalid", {
        binding: path.split("/").at(-1)!.slice(0, -5),
        reason: "unreadable",
      });
      throw new ServiceStorageUnavailable(
        "external_key binding is unavailable",
      );
    }
    if (record === null || record === malformed) {
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
      return;
    }
    const valid =
      typeof record.principal === "string" &&
      typeof record.conversation_id === "string" &&
      CID_RE.test(record.conversation_id) &&
      (() => {
        try {
          return validateExternalKey(record.external_key) !== null;
        } catch {
          return false;
        }
      })();
    if (
      !valid ||
      (record.principal === principal &&
        record.external_key === key &&
        record.conversation_id === cid)
    )
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
  }

  private servicePath(cid: string): string | null {
    return typeof cid === "string" && CID_RE.test(cid)
      ? join(this.paths.serviceBindingsDir, `${cid}.json`)
      : null;
  }
  private async readService(
    path: string,
    strict = false,
  ): Promise<string | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY);
      if (!(await handle.stat()).isFile())
        throw new Error("non-regular service binding");
      const buffer = new Uint8Array(513);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 512) throw new Error("oversized service binding");
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead),
        ),
      );
      const principal =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as ConversationRecord).principal
          : null;
      if (typeof principal !== "string")
        throw new Error("invalid service binding");
      return principal;
    } catch (error) {
      if (strict)
        throw new ServiceStorageUnavailable("service binding unavailable", {
          cause: error,
        });
      return null;
    } finally {
      await handle?.close();
    }
  }
  async bindServiceConversation(
    principal: string,
    cid: string,
    createToken?: string,
  ): Promise<void> {
    const path = this.servicePath(cid);
    if (!path || typeof principal !== "string" || !PRINCIPAL_RE.test(principal))
      throw new Error("invalid service conversation binding");
    // Invariant: a create attempt writes a fresh leaf; it never adopts one.
    if (createToken !== undefined && (await readExternalLeaf(path)) !== null)
      throw new ServiceStorageUnavailable(
        "conversation already has a service binding",
      );
    const existing = await this.readService(path);
    if (existing !== null && existing !== principal)
      throw new Error("conversation is owned by another service");
    await mkdir(this.paths.serviceBindingsDir, { recursive: true });
    const temp = join(
      this.paths.serviceBindingsDir,
      `.${cid}.json.${this.ids()}.tmp`,
    );
    try {
      await Bun.write(
        temp,
        pyCompactJson(
          createToken === undefined
            ? { principal }
            : { principal, create_token: createToken },
        ),
      );
      await rename(temp, path);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
  async serviceOwnsConversation(
    principal: string,
    cid: string,
  ): Promise<boolean> {
    const path = this.servicePath(cid);
    return (
      !!path &&
      typeof principal === "string" &&
      PRINCIPAL_RE.test(principal) &&
      this.hooks.exists(cid) &&
      (await this.readService(path)) === principal
    );
  }
  async serviceOwnedConversationCount(principal: string): Promise<number> {
    if (typeof principal !== "string" || !PRINCIPAL_RE.test(principal))
      throw new ServiceStorageUnavailable("invalid service principal");
    let files: string[];
    try {
      files = await readdir(this.paths.serviceBindingsDir);
    } catch (error) {
      if (missing(error)) return 0;
      throw new ServiceStorageUnavailable(
        "service binding directory unavailable",
        { cause: error },
      );
    }
    let count = 0;
    for (const file of files.filter((f) => f.endsWith(".json")))
      if (
        (await this.readService(
          join(this.paths.serviceBindingsDir, file),
          true,
        )) === principal
      )
        count++;
    return count;
  }
  async unbindServiceConversation(
    cid: string,
    createdBy?: { principal: string; createToken: string },
  ): Promise<void> {
    const path = this.servicePath(cid);
    if (!path) return;
    if (createdBy)
      return this.unbindCreateLeaf(path, {
        principal: createdBy.principal,
        create_token: createdBy.createToken,
      });
    await unlink(path).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}
