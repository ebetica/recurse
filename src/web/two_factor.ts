// Operator-only setup is session-bound and expires in ten minutes.
// Only setup returns a secret; confirmation returns recovery codes once.
// Factor changes share the password/key lock and reissue the caller cookie.
import { sessionFingerprint } from "../auth/session";
import { requireBackendOperator } from "./backends";
import { secureCookie, sessionCookieHeader, type LoginDeps } from "./login";
import { jsonDictBody } from "./request";
import {
  clientIp,
  requireCurrentSession,
  sessionCookie,
  LOGIN_PASSWORD_MAX_CHARS,
} from "./request_auth";
import { HttpError, jsonResponse, type Router } from "./router";

export function registerTwoFactorRoutes(router: Router, deps: LoginDeps): void {
  const { operator, throttle } = deps;
  const path = "/api/settings/two-factor";
  router.get(path, async (ex) => {
    requireBackendOperator(ex);
    return jsonResponse({ enabled: await operator.twoFactorEnabled() }, 200, {
      "cache-control": "no-store",
    });
  });
  router.post(path, async (ex) => {
    requireBackendOperator(ex);
    const body = await jsonDictBody(ex);
    if (
      typeof body.action !== "string" ||
      !["setup", "enable", "disable"].includes(body.action)
    )
      throw new HttpError(422, "invalid action");
    const ip = clientIp(ex.request.headers, ex.client);
    const change = async () => {
      await requireCurrentSession(ex, operator);
      const wait = throttle.retryAfter(ip);
      if (wait > 0)
        throw new HttpError(429, "Too many attempts. Try again later.", {
          "retry-after": String(Math.trunc(wait) + 1),
        });
      const password = typeof body.password === "string" ? body.password : "";
      const code = typeof body.code === "string" ? body.code : "";
      if (password.length > LOGIN_PASSWORD_MAX_CHARS || code.length > 64)
        throw new HttpError(422, "Password or code is too long");
      const binding = sessionFingerprint(sessionCookie(ex) ?? "operator")!;
      let result: object | null = null;
      if (body.action === "setup")
        result = await operator.beginTwoFactor(password, binding);
      else if (body.action === "enable") {
        const codes = await operator.enableTwoFactor(password, code, binding);
        if (codes) result = { enabled: true, recovery_codes: codes };
      } else if (await operator.disableTwoFactor(password, code))
        result = { enabled: false };
      if (!result) {
        throttle.recordFail(ip);
        throw new HttpError(
          400,
          "Password or code is incorrect, or setup has expired",
        );
      }
      throttle.recordSuccess(ip);
      const response = jsonResponse(result, 200, {
        "cache-control": "no-store",
      });
      if (body.action !== "setup")
        response.headers.set(
          "set-cookie",
          sessionCookieHeader(await operator.makeToken(), secureCookie(ex)),
        );
      return response;
    };
    return operator.withPasswordLock(change);
  });
}
