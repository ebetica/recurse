// Authenticate before decode: CSRF, scoped bearer, local/loopback/session.
// Service calls never grant operator rights; agent markers narrow key routes.
// Joined duplicate headers fail closed; every session-cookie copy must verify.
// Settings/auth routes refuse all agent markers, even empty or duplicates.

import { constants } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  BACKEND_KEY_PREFIX,
  backendKeyAllowed,
  backendAgentAllowed,
  type BackendKeys,
} from "../auth/backend_keys";
import { COOKIE_NAME, type OperatorAuth } from "../auth/session";
import {
  SERVICE_BODY_MAX_BYTES,
  serviceCapability,
  validateServicePolicy,
  type ServiceAuth,
  type ServicePolicy,
} from "../auth/service";
import { pyStrip } from "../auth/provider_store";
import {
  DEBUG,
  INFO,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { parsePythonJson } from "../utils/py_compact_json";
import type { Middleware } from "../server";
import { jsonResponse, type Exchange } from "./router";

export const LOGIN_MAX_FREE = 5;
export const LOGIN_LOCK_BASE = 1.0;
export const LOGIN_LOCK_CAP = 300.0;
export const LOGIN_FORGET = 3600.0;
export const LOGIN_PASSWORD_MAX_CHARS = 1024;
export const LOGIN_BODY_MAX_BYTES = 16 * 1024;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
]);

const valueError = (message: string) =>
  Object.assign(new Error(message), { name: "ValueError" });

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

// `urllib.parse.urlsplit(url).netloc` (Python 3.12), raising as Python does.
export function urlsplitNetloc(input: string): string {
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const colon = url.indexOf(":");
  if (
    colon > 0 &&
    /^[A-Za-z]/.test(url) &&
    SCHEME_CHARS.test(url.slice(0, colon))
  )
    url = url.slice(colon + 1);
  if (!url.startsWith("//")) return "";
  let end = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const at = url.indexOf(delimiter, 2);
    if (at >= 0) end = Math.min(end, at);
  }
  const netloc = url.slice(2, end);
  const open = netloc.includes("[");
  const close = netloc.includes("]");
  if (open !== close) throw valueError("Invalid IPv6 URL");
  if (open) checkBracketedNetloc(netloc);
  checkNetloc(netloc);
  return netloc;
}

function checkBracketedNetloc(netloc: string): void {
  const hostPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const bracket = hostPort.indexOf("[");
  let hostname: string;
  if (bracket >= 0) {
    if (bracket > 0) throw valueError("Invalid IPv6 URL");
    const bracketed = hostPort.slice(bracket + 1);
    const closeAt = bracketed.indexOf("]");
    hostname = closeAt === -1 ? bracketed : bracketed.slice(0, closeAt);
    const port = closeAt === -1 ? "" : bracketed.slice(closeAt + 1);
    if (port && !port.startsWith(":")) throw valueError("Invalid IPv6 URL");
  } else {
    const at = hostPort.indexOf(":");
    hostname = at === -1 ? hostPort : hostPort.slice(0, at);
  }
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(hostname))
      throw valueError("IPvFuture address is invalid");
    return;
  }
  const scope = hostname.indexOf("%");
  const address = scope === -1 ? hostname : hostname.slice(0, scope);
  const zone = scope === -1 ? null : hostname.slice(scope + 1);
  if (!isIPv6(address) || zone === "" || (zone !== null && zone.includes("%")))
    throw valueError("does not appear to be an IPv4 or IPv6 address");
}

function checkNetloc(netloc: string): void {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalised = n.normalize("NFKC");
  if (n === normalised) return;
  for (const char of "/?#@:")
    if (normalised.includes(char))
      throw valueError(
        `netloc '${netloc}' contains invalid characters under NFKC normalization`,
      );
}

type Headers = { get(name: string): string | null };

// Mutations require matching Origin/Host; absent Origin refuses cross-site.
// Missing both browser headers permits non-browser callers without ambient
// cookies. Joined Origin/Host/Sec-Fetch-Site fields fail closed.
export function csrfOk(method: string, headers: Headers): boolean {
  if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) return true;
  const origin = headers.get("origin");
  if (origin) {
    const host = headers.get("host") ?? "";
    // Invariant: A comma means Bun joined repeated headers: refuse (see
    // header).
    if (origin.includes(",") || host.includes(",")) return false;
    return urlsplitNetloc(origin) === host;
  }
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site !== "cross-site" && !site.includes(",");
  return true;
}

/** The throttle key: the rightmost X-Forwarded-For hop, else the peer. */
export function clientIp(
  headers: Headers,
  client: { readonly host: string } | null,
): string {
  const xff = headers.get("x-forwarded-for") ?? "";
  if (xff)
    for (const hop of xff.split(",").reverse()) {
      const trimmed = pyStrip(hop);
      if (trimmed) return trimmed;
    }
  return client ? client.host : "unknown";
}

/** Per-IP failed-login lockout; in memory, reset by a restart. */
export class LoginThrottle {
  /** ip -> [consecutive fails, locked-until epoch seconds]. */
  readonly fails = new Map<string, [number, number]>();
  constructor(readonly now: () => number = () => Date.now() / 1000) {}

  /** Seconds this IP must wait before another attempt (0 = clear). */
  retryAfter(ip: string, now = this.now()): number {
    const record = this.fails.get(ip);
    if (!record) return 0;
    return Math.max(0, record[1] - now);
  }

  // Count a failure and (re)arm the lockout; attempts while locked escalate.
  recordFail(ip: string, now = this.now()): void {
    const fails = (this.fails.get(ip)?.[0] ?? 0) + 1;
    const delay =
      fails > LOGIN_MAX_FREE
        ? Math.min(
            LOGIN_LOCK_CAP,
            LOGIN_LOCK_BASE * 2 ** (fails - LOGIN_MAX_FREE - 1),
          )
        : 0;
    this.fails.set(ip, [fails, now + delay]);
    this.prune(now);
  }

  recordSuccess(ip: string): void {
    this.fails.delete(ip);
  }

  /** Drop IPs whose lockout elapsed more than LOGIN_FORGET ago. */
  prune(now: number): void {
    for (const [ip, [, until]] of [...this.fails])
      if (now - until > LOGIN_FORGET) this.fails.delete(ip);
  }
}

/** http.cookies._unquote. */
function cookieUnquote(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"')
    return value;
  return value
    .slice(1, -1)
    .replace(/\\(?:([0-3][0-7][0-7])|(.))/g, (_all, octal, char) =>
      octal ? String.fromCharCode(parseInt(octal, 8)) : char,
    );
}

/** Starlette `cookie_parser`, keeping every value of each name in order. */
export function cookieValues(header: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!header) return out;
  for (const chunk of header.split(";")) {
    const at = chunk.indexOf("=");
    const key = pyStrip(at === -1 ? "" : chunk.slice(0, at));
    const value = pyStrip(at === -1 ? chunk : chunk.slice(at + 1));
    if (key || value) {
      const list = out.get(key) ?? [];
      list.push(cookieUnquote(value));
      out.set(key, list);
    }
  }
  return out;
}

/** The request's session cookie as Starlette's `request.cookies` gives it. */
export function sessionCookie(ex: Exchange): string | null {
  return (
    cookieValues(ex.request.headers.get("cookie")).get(COOKIE_NAME)?.at(-1) ??
    null
  );
}

/** Every joined chat_auth cookie copy must verify, not only the last. */
async function cookieAuthed(
  ex: Exchange,
  operator: OperatorAuth,
): Promise<boolean> {
  const copies = cookieValues(ex.request.headers.get("cookie")).get(
    COOKIE_NAME,
  );
  if (!copies) return operator.checkToken(null);
  for (const copy of copies)
    if (!(await operator.checkToken(copy))) return false;
  return true;
}

/**
 * Publish `DATA_DIR/server.json` (0600, atomic rename) with the port and a
 * stable loopback token, keeping an existing token. Returns the token.
 */
export async function publishLoopbackToken(
  dataDir: string,
  port: number,
): Promise<string> {
  const path = join(dataDir, "server.json");
  let token = "";
  let existing: unknown = undefined;
  try {
    existing = parsePythonJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(await readFile(path)),
      ),
    );
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    // Invariant: Python: json.loads(...).get("token") raises on a non-object
    // payload.
    if (
      existing === null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    )
      throw new TypeError("server.json is not a JSON object");
    const value = (existing as Record<string, unknown>).token;
    token = value ? pyStr(value) : "";
  }
  if (!token) token = randomBytes(32).toString("hex");
  const tmp = join(dataDir, `.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.write(`{"port": ${port}, "token": ${asciiJson(token)}}`);
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return token;
}

/** str() of a truthy JSON value; only a string token is ever written. */
function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === true) return "True";
  return JSON.stringify(value);
}

/** json.dumps(str) with ensure_ascii. */
function asciiJson(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The local CLI credential: token over loopback, only on `/api/`. */
export function loopbackAuthenticated(ex: Exchange, token: string): boolean {
  const supplied = ex.request.headers.get("x-loopback-token");
  if (!supplied || !token) return false;
  const left = new Uint8Array(Buffer.from(supplied, "utf8"));
  const right = new Uint8Array(Buffer.from(token, "utf8"));
  const equal =
    left.length === right.length ? timingSafeEqual(left, right) : false;
  return (
    equal &&
    ex.client !== null &&
    LOOPBACK_HOSTS.has(ex.client.host) &&
    ex.path.startsWith("/api/")
  );
}

/** The authenticated service principal on this request, if any. */
export function servicePrincipalOf(ex: Exchange): string | null {
  const principal = ex.state.principal;
  return typeof principal === "string" ? principal : null;
}

/** The request-scoped ownership verdict must match (principal, cid) exactly. */
export function serviceOwnsRequest(ex: Exchange, cid: string): boolean {
  const verdict = ex.state.service_conversation_ownership;
  return (
    Array.isArray(verdict) &&
    verdict.length === 2 &&
    verdict[0] === servicePrincipalOf(ex) &&
    verdict[1] === cid
  );
}

export function serviceRequestPolicy(ex: Exchange): ServicePolicy | null {
  return validateServicePolicy(ex.state.service_policy);
}

export function auditService(
  logger: RuntimeLogger,
  ex: Exchange,
  action: string,
  cid: string | null = null,
): void {
  logEvent(logger, INFO, "service_request", {
    conversation_id: cid,
    fields: { principal: servicePrincipalOf(ex), action },
  });
}

const HTML = "text/html; charset=utf-8";

export function htmlResponse(
  body: string,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "content-length": String(Buffer.byteLength(body)),
      "content-type": HTML,
    },
  });
}

export interface RequestAuthDeps {
  readonly operator: OperatorAuth;
  readonly service: ServiceAuth;
  readonly backendKeys?: BackendKeys;
  /** The token published by `publishLoopbackToken`. */
  readonly loopbackToken: string;
  readonly tailscaleLogin?: string | null;
  /** conversation_store.service_owns_conversation. */
  readonly serviceOwns: (principal: string, cid: string) => Promise<boolean>;
  /** The `web` logger for service audit events. */
  readonly logger: RuntimeLogger;
}

/** Fail closed on raw marker presence, even with an invalid agent id. */
export function agentMarked(ex: Exchange): boolean {
  return (
    ex.request.headers.has("x-recurse-agent") || ex.state.backend_agent != null
  );
}

function operatorSettingsPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return (
    normalized === "/api/settings" ||
    normalized.startsWith("/api/settings/") ||
    normalized === "/api/pi" ||
    normalized.startsWith("/api/pi/") ||
    ["/login", "/logout", "/api/password"].includes(normalized)
  );
}

/** The auth slot middleware for `composeApp`. */
export function requestAuth(deps: RequestAuthDeps): Middleware {
  const tailscaleLogin = deps.tailscaleLogin?.trim().toLowerCase();
  return (next) => async (ex) => {
    const headers = ex.request.headers;
    if (operatorSettingsPath(ex.path) && agentMarked(ex))
      return jsonResponse(
        { detail: "only the operator can change settings or sign in" },
        403,
      );
    const mintKey =
      ex.path === "/api/backend-keys" && ex.request.method === "POST";
    if (ex.path === "/login" || mintKey) ex.bodyLimit = LOGIN_BODY_MAX_BYTES;
    if (ex.path === "/api/ui-timing") ex.bodyLimit = 24 * 1024;
    // Invariant: CSRF before auth: a forged cross-site mutation is refused
    // regardless of session state.
    if (!csrfOk(ex.request.method, headers)) {
      if (ex.path.startsWith("/api/"))
        return jsonResponse({ detail: "cross-site request blocked" }, 403);
      return htmlResponse("cross-site request blocked", 403);
    }
    // Invariant: A valid bearer is a distinct machine principal, not another
    // way to satisfy the operator cookie. Cookie polls carry no Authorization.
    const authorization = headers.get("authorization");
    if (
      authorization?.toLowerCase().startsWith(`bearer ${BACKEND_KEY_PREFIX}`)
    ) {
      const key = await deps.backendKeys?.verify(authorization);
      if (!key) return jsonResponse({ detail: "unauthorized" }, 401);
      ex.state.auth_method = "backend-key";
      ex.state.principal = `backend-key:${key.name}`;
      ex.state.backend_key_id = key.id;
      const agent = headers.get("x-recurse-agent-caller");
      if (agent !== null) {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agent) ||
          !backendAgentAllowed(ex.request.method, ex.path)
        )
          return jsonResponse({ detail: "remote agent not allowed here" }, 403);
        ex.state.backend_agent = `${agent}@${key.name}`;
      }
      logEvent(deps.logger, DEBUG, "backend_key_request", {
        fields: { name: key.name, method: ex.request.method, route: ex.path },
      });
      if (!backendKeyAllowed(ex.request.method, ex.path))
        return jsonResponse({ detail: "backend key not allowed here" }, 403);
      return next(ex);
    }
    if (headers.has("x-recurse-agent-caller"))
      return jsonResponse(
        { detail: "agent provenance requires a backend key" },
        403,
      );
    let caller = null;
    if (ex.path.startsWith("/api/") && headers.get("authorization"))
      caller = await deps.service.principal(
        ex.path,
        headers.get("authorization"),
      );
    if (caller !== null) {
      ex.state.service_policy = caller.policy;
      ex.state.principal = caller.principal;
      ex.state.auth_method = "service";
      const capability = serviceCapability(ex.request.method, ex.path);
      if (capability === null) {
        auditService(deps.logger, ex, "denied");
        return jsonResponse({ detail: "service capability denied" }, 403);
      }
      const [action, cid] = capability;
      const policy = serviceRequestPolicy(ex);
      if (policy === null) {
        auditService(deps.logger, ex, "policy.denied", cid);
        return jsonResponse({ detail: "service policy unavailable" }, 403);
      }
      if (!policy.scopes.has(action)) {
        auditService(deps.logger, ex, `${action}.denied`, cid);
        return jsonResponse({ detail: "service capability denied" }, 403);
      }
      if (cid !== null && !(await deps.serviceOwns(caller.principal, cid))) {
        auditService(deps.logger, ex, `${action}.denied`, cid);
        return jsonResponse({ detail: "conversation not found" }, 404);
      }
      if (cid !== null)
        ex.state.service_conversation_ownership = [caller.principal, cid];
      ex.bodyLimit = SERVICE_BODY_MAX_BYTES;
      auditService(deps.logger, ex, action, cid);
      return next(ex);
    }
    if (ex.tailscaleSocket) {
      const login = headers.get("tailscale-user-login");
      if (
        !tailscaleLogin ||
        !login ||
        login.includes(",") ||
        login.trim().toLowerCase() !== tailscaleLogin
      )
        return jsonResponse({ detail: "unauthorized" }, 401);
      ex.state.auth_method = "tailscale";
      return next(ex);
    }
    if (loopbackAuthenticated(ex, deps.loopbackToken)) {
      ex.state.principal = "loopback";
      ex.state.auth_method = "loopback";
      return next(ex);
    }
    if (!(await deps.operator.enabled())) {
      ex.state.auth_method = "local";
      return next(ex);
    }
    const authed = await cookieAuthed(ex, deps.operator);
    if (ex.path !== "/login" && !mintKey && !authed) {
      if (ex.path.startsWith("/api/"))
        return jsonResponse({ detail: "unauthorized" }, 401);
      return htmlResponse(await deps.operator.loginPage(), 401);
    }
    if (authed) ex.state.auth_method = "cookie";
    return next(ex);
  };
}
