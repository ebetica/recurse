// Login throttle: per-IP lockout plus 0.5s delay; no oversized password echo.
// Password change requires current credential and 12-char floor, rotates hash
// then reissues caller cookie. Audit cookie fingerprint only, never plaintext.
// Strict JSON content type prevents cross-site simple-request password changes.

import {
  COOKIE_DAYS,
  COOKIE_NAME,
  sessionFingerprint,
  type OperatorAuth,
} from "../auth/session";
import { pyStrip } from "../auth/provider_store";
import {
  INFO,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { parsePythonJson } from "../utils/py_compact_json";
import {
  clientIp,
  htmlResponse,
  LOGIN_PASSWORD_MAX_CHARS,
  sessionCookie,
  type LoginThrottle,
} from "./request_auth";
import {
  HttpError,
  jsonResponse,
  unquote,
  type Exchange,
  type Router,
} from "./router";

export const FORM_MAX_FIELDS = 1000;
export const PASSWORD_MIN_CHARS = 12;

export interface LoginDeps {
  readonly operator: OperatorAuth;
  readonly backendKeys?: import("../auth/backend_keys").BackendKeys;
  readonly throttle: LoginThrottle;
  readonly logger: RuntimeLogger;
  /** asyncio.sleep; tests pass a fake. */
  readonly sleep?: (seconds: number) => Promise<void>;
}

const codePoints = (text: string) => [...text].length;

/** Starlette FormParser over an urlencoded body: last value per name. */
export function parseUrlencoded(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const text = Buffer.from(body).toString("latin1");
  let fields = 0;
  const plus = (part: string) => unquote(part.replaceAll("+", " "));
  for (const segment of text.split("&")) {
    if (!segment) continue;
    fields += 1;
    if (fields > FORM_MAX_FIELDS)
      throw new HttpError(
        400,
        `Too many fields. Maximum number of fields is ${FORM_MAX_FIELDS}.`,
      );
    const at = segment.indexOf("=");
    const name = at === -1 ? segment : segment.slice(0, at);
    const value = at === -1 ? "" : segment.slice(at + 1);
    out.set(plus(name), plus(value));
  }
  return out;
}

/** FastAPI `password: str = Form("")`. */
async function formPassword(ex: Exchange): Promise<string> {
  const type = (ex.request.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    const body = new Uint8Array(await ex.request.arrayBuffer());
    return parseUrlencoded(body).get("password") ?? "";
  }
  if (type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await ex.request.formData();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "There was an error parsing the body");
    }
    const values = form.getAll("password");
    const value = values.at(-1);
    if (value !== undefined && typeof value !== "string")
      throw new HttpError(422, [
        {
          type: "string_type",
          loc: ["body", "password"],
          msg: "Input should be a valid string",
        },
      ]);
    return value ?? "";
  }

  await ex.request.arrayBuffer();
  return "";
}

/** FastAPI `body: dict`: the parsed JSON object, or its 422/400 answer. */
export async function jsonDictBody(
  ex: Exchange,
): Promise<Record<string, unknown>>;
/** FastAPI `body: dict | None = None`: an absent or null body is null. */
export async function jsonDictBody(
  ex: Exchange,
  required: false,
): Promise<Record<string, unknown> | null>;
export async function jsonDictBody(
  ex: Exchange,
  required = true,
): Promise<Record<string, unknown> | null> {
  const bytes = new Uint8Array(await ex.request.arrayBuffer());
  let body: unknown = null;
  if (bytes.length) {
    // Invariant: FastAPI 0.139 strict_content_type: only application/json or
    // +json is parsed; a missing or other type is raw text (dict_type 422).
    // This also refuses cross-site text/plain simple requests.
    const header = ex.request.headers.get("content-type");
    const parts = (
      header ? pyStrip(header.split(";")[0]!).toLowerCase() : ""
    ).split("/");
    const [main, sub] = parts;
    const isJson =
      parts.length === 2 &&
      main === "application" &&
      !!sub &&
      (sub === "json" || sub.endsWith("+json"));
    if (isJson) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, "There was an error parsing the body");
      }
      try {
        body = parsePythonJson(text);
      } catch {
        throw new HttpError(422, [
          {
            type: "json_invalid",
            loc: ["body", 0],
            msg: "JSON decode error",
            input: {},
            ctx: { error: "Expecting value" },
          },
        ]);
      }
    } else body = Buffer.from(bytes).toString("utf8");
  }
  if (body === null) {
    if (!required) return null;
    throw new HttpError(422, [
      { type: "missing", loc: ["body"], msg: "Field required", input: null },
    ]);
  }
  if (typeof body !== "object" || Array.isArray(body))
    throw new HttpError(422, [
      {
        type: "dict_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary",
        input: body,
      },
    ]);
  return body as Record<string, unknown>;
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** len() in Python; numbers and booleans raise TypeError. */
function pyLen(value: unknown): number {
  if (typeof value === "string") return codePoints(value);
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null)
    return Object.keys(value).length;
  throw new TypeError(`object of type '${typeof value}' has no len()`);
}

function requireStr(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("'encode' is not a method of a non-str value");
  return value;
}

export function sessionCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Max-Age=${COOKIE_DAYS * 86400}; Path=/; SameSite=lax; Secure`;
}

/** Starlette's delete_cookie: `expires=0` renders as the current time. */
export function clearCookieHeader(now: Date = new Date()): string {
  return `${COOKIE_NAME}=""; expires=${now.toUTCString()}; HttpOnly; Max-Age=0; Path=/; SameSite=lax; Secure`;
}

function redirectHome(extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/", "content-length": "0", ...extra },
  });
}

export function registerLoginRoutes(router: Router, deps: LoginDeps): void {
  const sleep = deps.sleep ?? ((seconds: number) => Bun.sleep(seconds * 1000));
  const { operator, throttle } = deps;

  router.post("/login", async (ex) => {
    const password = await formPassword(ex);
    if (!(await operator.enabled())) return redirectHome();
    const ip = clientIp(ex.request.headers, ex.client);
    const wait = throttle.retryAfter(ip);
    if (wait > 0) {
      const secs = Math.trunc(wait) + 1;
      return htmlResponse(
        await operator.loginPage(`Too many attempts — try again in ${secs}s`),
        429,
        { "retry-after": String(secs) },
      );
    }
    await sleep(0.5);
    const tooLong = codePoints(password) > LOGIN_PASSWORD_MAX_CHARS;
    if (tooLong || !(await operator.verifyPassword(password))) {
      throttle.recordFail(ip);
      return htmlResponse(
        await operator.loginPage("Wrong password", tooLong ? "" : password),
        401,
      );
    }
    throttle.recordSuccess(ip);
    return redirectHome({
      "set-cookie": sessionCookieHeader(await operator.makeToken()),
    });
  });

  router.post("/logout", async () => {
    // Invariant: The middleware already required a valid cookie; tell the
    // browser to drop it.
    const response = jsonResponse({ ok: true });
    response.headers.append("set-cookie", clearCookieHeader());
    return response;
  });

  router.post("/api/password", async (ex) => {
    const body = await jsonDictBody(ex);
    const change = async () => {
      if (!(await operator.enabled()))
        throw new HttpError(503, "authentication not configured");
      const current = truthy(body.current) ? body.current : "";
      const next = truthy(body.new) ? body.new : "";
      const ip = clientIp(ex.request.headers, ex.client);
      const wait = throttle.retryAfter(ip);
      if (wait > 0)
        throw new HttpError(
          429,
          `Too many attempts — try again in ${Math.trunc(wait) + 1}s`,
        );
      if (!(await operator.verifyPassword(requireStr(current)))) {
        throttle.recordFail(ip);
        throw new HttpError(400, "Current password is incorrect");
      }
      throttle.recordSuccess(ip);
      if (pyLen(next) < PASSWORD_MIN_CHARS)
        throw new HttpError(400, "New password must be at least 12 characters");
      if (next === current)
        throw new HttpError(
          400,
          "New password must differ from the current one",
        );
      const fingerprint = sessionFingerprint(sessionCookie(ex));
      await operator.setPassword(requireStr(next));
      await deps.backendKeys?.revoke();
      // Invariant: Rotation is durable before this best-effort diagnostic.
      try {
        logEvent(deps.logger, INFO, "password_changed", {
          fields: { session_cookie_fingerprint: fingerprint ?? "none" },
        });
      } catch {
        // Invariant: Log failures never fail a completed HTTP change.
      }
      // Invariant: The signing key just rotated: re-issue the caller's cookie.
      const response = jsonResponse({ ok: true });
      response.headers.append(
        "set-cookie",
        sessionCookieHeader(await operator.makeToken()),
      );
      return response;
    };
    return deps.backendKeys
      ? deps.backendKeys.withPasswordLock(change)
      : change();
  });
}
