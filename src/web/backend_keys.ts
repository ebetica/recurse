// Minting shares login's throttle/delay; only operator sessions manage keys.
// Malformed mint bodies never echo input, which may contain a password.
import type { BackendKeys } from "../auth/backend_keys";
import type { LoginDeps } from "./login";
import { jsonDictBody } from "./login";
import { validBackendKeyName } from "../auth/backend_keys";
import { clientIp, LOGIN_PASSWORD_MAX_CHARS } from "./request_auth";
import { HttpError, jsonResponse, type Router, type Exchange } from "./router";

/** Refuse anything but an operator session (cookie, Tailscale or local). */
export function requireOperator(ex: Exchange): void {
  if (!["cookie", "tailscale", "local"].includes(String(ex.state.auth_method)))
    throw new HttpError(403, "operator session required");
}

export function registerBackendKeyRoutes(
  router: Router,
  deps: LoginDeps & { backendKeys: BackendKeys },
): void {
  const { operator, throttle, backendKeys } = deps;
  router.post("/api/backend-keys", async (ex) => {
    let body: Record<string, unknown>;
    try {
      body = await jsonDictBody(ex);
    } catch (error) {
      throw new HttpError(
        error instanceof HttpError ? error.status : 400,
        "invalid JSON body",
      );
    }
    if (!(await operator.enabled()))
      throw new HttpError(
        422,
        "this backend has no password; connect without a key",
      );
    const ip = clientIp(ex.request.headers, ex.client);
    const wait = throttle.retryAfter(ip);
    if (wait > 0)
      throw new HttpError(429, "too many attempts", {
        "retry-after": String(Math.trunc(wait) + 1),
      });
    await (deps.sleep ?? ((seconds) => Bun.sleep(seconds * 1000)))(0.5);
    return backendKeys.withPasswordLock(async () => {
      if (
        typeof body.password !== "string" ||
        [...body.password].length > LOGIN_PASSWORD_MAX_CHARS ||
        !(await operator.verifyPassword(body.password))
      ) {
        throttle.recordFail(ip);
        throw new HttpError(401, "wrong password");
      }
      throttle.recordSuccess(ip);
      if (!validBackendKeyName(body.name))
        throw new HttpError(422, "invalid backend key name");
      return jsonResponse(await backendKeys.mint(body.name));
    });
  });
  router.get("/api/backend-keys", async (ex) => {
    requireOperator(ex);
    return jsonResponse(await backendKeys.list());
  });
  router.delete("/api/backend-keys/self", async (ex) => {
    if (
      ex.state.auth_method !== "backend-key" ||
      typeof ex.state.backend_key_id !== "string"
    )
      throw new HttpError(403, "backend key required");
    await backendKeys.revoke(ex.state.backend_key_id);
    return jsonResponse({ ok: true });
  });
  router.delete("/api/backend-keys/{id}", async (ex) => {
    requireOperator(ex);
    await backendKeys.revoke(ex.params.id);
    return jsonResponse({ ok: true });
  });
}
