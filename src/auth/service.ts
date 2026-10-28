// Service principals never grant operator or outbound model authority.
// Per-request key-ID lookup enforces scopes/quotas and sees token rotation.
// Fixed digests equalize unknown IDs/wrong secrets; never scan token secrets.
// Read bounded regular files afresh; transient ENOENT never uses cached auth.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { pyStrip } from "./provider_store";

export const TOKEN_FILE_MAX_BYTES = 4096;
export const AUTHORIZATION_MAX_BYTES = 4096;
export const SERVICE_REGISTRY_MAX_BYTES = 256 * 1024;
export const SERVICE_BODY_MAX_BYTES = 64 * 1024;
export const SERVICE_MESSAGE_MAX_CHARS = 32 * 1024;
export const SERVICE_CREATE_MAX_ACTIVE = 2;
export const CONVERSATION_READ_CAPABILITY = "conversation.read";
export const SERVICE_TOKEN_PREFIX = "recurse";
const SERVICE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVICE_CID = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const SEND_RE = new RegExp(
  `^/api/service/conversations/${SERVICE_CID}/messages$`,
);
const READ_RE = new RegExp(
  `^/api/service/conversations/${SERVICE_CID}/replies$`,
);
export const SERVICE_CAPABILITIES: ReadonlySet<string> = new Set([
  "conversation.create",
  "conversation.send",
  CONVERSATION_READ_CAPABILITY,
]);

export interface ServicePolicy {
  readonly scopes: ReadonlySet<string>;
  readonly allowed_models: readonly string[] | null;
  readonly quotas: Readonly<Record<string, number>>;
}

export const SERVICE_DEFAULT_POLICY: ServicePolicy = Object.freeze({
  scopes: new Set(SERVICE_CAPABILITIES),
  allowed_models: null,
  quotas: Object.freeze({}),
});

const codePoints = (text: string) => [...text].length;

export interface ServiceAuthOptions {
  readonly principalsFile: string | null;
  readonly tokenFile: string | null;
}

/** Split a bearer header into (key id, secret), or null. */
export function bearerParts(
  header: string | null | undefined,
  tokenFileConfigured: boolean,
): readonly [string, string] | null {
  if (!header || codePoints(header) > AUTHORIZATION_MAX_BYTES) return null;
  // Invariant: Exactly one literal separator refuses folded, concatenated
  // (including Bun-joined repeated headers) or multi-token values.
  if (header.split(" ").length !== 2) return null;
  const [scheme, token] = header.split(" ") as [string, string];
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  if (token.toLowerCase().startsWith("recurse-link_")) return null;
  for (const char of token) {
    const code = char.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return null;
  }
  if (codePoints(token) > TOKEN_FILE_MAX_BYTES) return null;

  const first = token.indexOf("_");
  const second = first === -1 ? -1 : token.indexOf("_", first + 1);
  const parts =
    first === -1
      ? [token]
      : second === -1
        ? [token.slice(0, first), token.slice(first + 1)]
        : [
            token.slice(0, first),
            token.slice(first + 1, second),
            token.slice(second + 1),
          ];
  if (
    parts.length === 3 &&
    parts[0] === SERVICE_TOKEN_PREFIX &&
    SERVICE_KEY_RE.test(parts[1]!) &&
    parts[2]
  )
    return [parts[1]!, parts[2]];
  // Invariant: A plain opaque token is only the single-file shorthand
  // principal.
  if (parts.length === 1 && tokenFileConfigured) return ["service", token];
  return null;
}

/**
 * Read bounded regular targets directly; retry ENOENT during secret swaps.
 * Avoid Bun realpath's stale " (deleted)" paths during replacement.
 */
export async function readRegular(
  path: string,
  maximum: number,
): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) return null;
      const buffer = new Uint8Array(maximum + 1);
      const { bytesRead } = await handle.read(buffer, 0, maximum + 1, null);
      return bytesRead <= maximum ? buffer.slice(0, bytesRead) : null;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

export async function readServiceToken(path: string): Promise<string | null> {
  const data = await readRegular(path, TOKEN_FILE_MAX_BYTES);
  if (data === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } catch {
    return null;
  }
  return pyStrip(text) || null;
}

interface Num {
  readonly num: number;
  readonly int: boolean;
}
const isNum = (value: unknown): value is Num =>
  typeof value === "object" && value !== null && numbers.has(value);
const numbers = new WeakSet<object>();

/** json.loads with each number tagged int/float from its source text. */
function parseRegistry(text: string): unknown {
  return JSON.parse(
    text,
    function (_key, value, context?: { source?: string }) {
      if (typeof value !== "number") return value;
      const source = context?.source ?? String(value);
      const tagged = { num: value, int: /^-?\d+$/.test(source) };
      numbers.add(tagged);
      return tagged;
    },
  );
}

const isDict = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isNum(value);

function validQuota(name: string, quota: unknown): quota is Num {
  return (
    name === "max_owned_conversations" &&
    isNum(quota) &&
    quota.int &&
    quota.num >= 0 &&
    quota.num <= 1_000_000
  );
}

const REGISTRY_KEYS = new Set([
  "token_file",
  "scopes",
  "allowed_models",
  "quotas",
]);

export function registryPolicy(
  value: unknown,
): readonly [ServicePolicy, string] | null {
  if (
    !isDict(value) ||
    Object.keys(value).some((key) => !REGISTRY_KEYS.has(key))
  )
    return null;
  const tokenPath = value.token_file;
  if (typeof tokenPath !== "string" || !tokenPath.startsWith("/")) return null;
  const rawScopes = "scopes" in value ? value.scopes : [];
  const rawModels = "allowed_models" in value ? value.allowed_models : null;
  const rawQuotas = "quotas" in value ? value.quotas : {};
  if (
    !Array.isArray(rawScopes) ||
    rawScopes.length > 32 ||
    !rawScopes.every(
      (scope) => typeof scope === "string" && SERVICE_CAPABILITIES.has(scope),
    ) ||
    (rawModels !== null &&
      (!Array.isArray(rawModels) ||
        rawModels.length > 128 ||
        !rawModels.every(
          (model) =>
            typeof model === "string" &&
            codePoints(model) > 0 &&
            codePoints(model) <= 256,
        ))) ||
    !isDict(rawQuotas) ||
    Object.keys(rawQuotas).length > 1
  )
    return null;
  const quotas: Record<string, number> = {};
  for (const [name, quota] of Object.entries(rawQuotas)) {
    if (!validQuota(name, quota)) return null;
    quotas[name] = quota.num;
  }
  return [
    {
      scopes: new Set(rawScopes as string[]),
      allowed_models: rawModels === null ? null : [...(rawModels as string[])],
      quotas,
    },
    tokenPath,
  ];
}

/** A request-state policy exactly as the middleware stores it, else null. */
export function validateServicePolicy(policy: unknown): ServicePolicy | null {
  if (typeof policy !== "object" || policy === null) return null;
  const keys = Object.keys(policy).sort();
  if (keys.join(",") !== "allowed_models,quotas,scopes") return null;
  const { scopes, allowed_models: models, quotas } = policy as ServicePolicy;
  if (
    !(scopes instanceof Set) ||
    [...scopes].some((scope) => !SERVICE_CAPABILITIES.has(scope)) ||
    (models !== null &&
      (!Array.isArray(models) ||
        models.length > 128 ||
        !models.every(
          (model) =>
            typeof model === "string" &&
            codePoints(model) > 0 &&
            codePoints(model) <= 256,
        ))) ||
    typeof quotas !== "object" ||
    quotas === null ||
    Array.isArray(quotas)
  )
    return null;
  for (const [name, quota] of Object.entries(quotas))
    if (
      name !== "max_owned_conversations" ||
      !Number.isInteger(quota) ||
      quota < 0 ||
      quota > 1_000_000
    )
      return null;
  return policy as ServicePolicy;
}

export interface ServiceCaller {
  readonly principal: string;
  readonly policy: ServicePolicy;
}

export class ServiceAuth {
  constructor(readonly options: ServiceAuthOptions) {}

  /** Read one bounded registry and look up one key without token scanning. */
  async registryEntry(
    keyId: string,
  ): Promise<readonly [ServicePolicy, string] | null> {
    if (!SERVICE_KEY_RE.test(keyId)) return null;
    const path = this.options.principalsFile;
    if (path === null) return null;
    const data = await readRegular(path, SERVICE_REGISTRY_MAX_BYTES);
    if (data === null) return null;
    let decoded: unknown;
    try {
      decoded = parseRegistry(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
      );
    } catch {
      return null;
    }
    let principals = isDict(decoded) ? decoded.principals : undefined;
    if (principals === undefined || principals === null) principals = decoded;
    if (!isDict(principals)) return null;
    return registryPolicy(
      Object.hasOwn(principals, keyId) ? principals[keyId] : undefined,
    );
  }

  /** A valid bearer caller's stable key id and policy, never its token. */
  async principal(
    path: string,
    authorization: string | null,
  ): Promise<ServiceCaller | null> {
    if (!path.startsWith("/api/")) return null;
    const parsed = bearerParts(authorization, this.options.tokenFile !== null);
    if (parsed === null) return null;
    const [keyId, secret] = parsed;
    const entry = await this.registryEntry(keyId);
    let expected: string | null = null;
    let policy: ServicePolicy | null = null;
    if (entry !== null) {
      policy = entry[0];
      expected = await readServiceToken(entry[1]);
    } else if (
      keyId === "service" &&
      this.options.principalsFile === null &&
      this.options.tokenFile !== null
    ) {
      policy = {
        scopes: SERVICE_DEFAULT_POLICY.scopes,
        allowed_models: null,
        quotas: {},
      };
      expected = await readServiceToken(this.options.tokenFile);
    }
    // Invariant: Fixed-length digests: unknown ids and wrong secrets fail the
    // same way.
    const candidate = createHash("sha256").update(secret, "utf8").digest();
    const want =
      expected !== null
        ? createHash("sha256").update(expected, "utf8").digest()
        : randomBytes(32);
    const matched = timingSafeEqual(
      new Uint8Array(candidate),
      new Uint8Array(want),
    );
    if (!matched || policy === null || expected === null) return null;
    return { principal: keyId, policy };
  }
}

/** Map a service request to an allowlisted capability and raw cid. */
export function serviceCapability(
  method: string,
  path: string,
): readonly [string, string | null] | null {
  if (method === "POST" && path === "/api/service/conversations")
    return ["conversation.create", null];
  if (method === "POST") {
    const match = SEND_RE.exec(path);
    if (match) return ["conversation.send", match[1]!];
  }
  if (method === "GET") {
    const match = READ_RE.exec(path);
    if (match) return [CONVERSATION_READ_CAPABILITY, match[1]!];
  }
  return null;
}
