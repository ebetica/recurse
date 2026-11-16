// Minting shares login's throttle/delay; only operator sessions manage keys.
// Malformed mint bodies never echo input, which may contain a password.
import type { BackendKeys } from "../auth/backend_keys";
import type { HomeCallbacks } from "../backends/home_callbacks";
import type { LoginDeps } from "./login";
import { jsonDictBody } from "./login";
import { validBackendKeyName } from "../auth/backend_keys";
import { keyedLabel } from "../backends/label";
import {
  authMethod,
  clientIp,
  isOperator,
  LOGIN_PASSWORD_MAX_CHARS,
} from "./request_auth";
import { HttpError, jsonResponse, type Router, type Exchange } from "./router";

/** Refuse anything but an operator session (cookie, Tailscale or local). */
export function requireOperator(ex: Exchange): void {
  if (!isOperator(ex)) throw new HttpError(403, "operator session required");
}

export function registerBackendKeyRoutes(
  router: Router,
  deps: LoginDeps & { backendKeys: BackendKeys; homeCallbacks?: HomeCallbacks },
): void {
  const { operator, throttle, backendKeys, homeCallbacks } = deps;
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
    const checkThrottle = () => {
      const wait = throttle.retryAfter(ip);
      if (wait > 0)
        throw new HttpError(429, "too many attempts", {
          "retry-after": String(Math.trunc(wait) + 1),
        });
    };
    checkThrottle();
    await (deps.sleep ?? ((seconds) => Bun.sleep(seconds * 1000)))(0.5);
    return operator.withPasswordLock(async () => {
      checkThrottle();
      const twoFactor = await operator.twoFactorEnabled();
      if (
        typeof body.password !== "string" ||
        [...body.password].length > LOGIN_PASSWORD_MAX_CHARS ||
        (twoFactor &&
          body.code !== undefined &&
          (typeof body.code !== "string" || body.code.length > 64)) ||
        !(await operator.verifySignIn(
          body.password as string,
          twoFactor && typeof body.code === "string" ? body.code : "",
        ))
      ) {
        throttle.recordFail(ip);
        return jsonResponse(
          {
            detail: twoFactor ? "wrong password or code" : "wrong password",
            ...(twoFactor && !body.code ? { code_required: true } : {}),
          },
          401,
        );
      }
      throttle.recordSuccess(ip);
      if (!validBackendKeyName(body.name))
        throw new HttpError(422, "invalid backend key name");
      return jsonResponse(await backendKeys.mint(body.name));
    });
  });
  router.get("/api/backend-keys", async (ex) => {
    requireOperator(ex);
    const urls = new Map(
      ((await homeCallbacks?.homes()) ?? []).map((h) => [h.id, h.url]),
    );
    return jsonResponse(
      (await backendKeys.list()).map((key) => ({
        ...key,
        url: urls.get(key.id) ?? null,
        label: keyedLabel(key.name, key.id),
      })),
    );
  });
  router.delete("/api/backend-keys/self", async (ex) => {
    if (
      authMethod(ex) !== "backend-key" ||
      typeof ex.state.backend_key_id !== "string"
    )
      throw new HttpError(403, "backend key required");
    await backendKeys.revoke(ex.state.backend_key_id);
    return jsonResponse({ ok: true });
  });
  router.put("/api/backend-keys/self/callback", async (ex) => {
    if (
      authMethod(ex) !== "backend-key" ||
      typeof ex.state.backend_key_id !== "string" ||
      !homeCallbacks
    )
      throw new HttpError(403, "backend key required");
    await homeCallbacks.register(
      ex.state.backend_key_id,
      await jsonDictBody(ex),
    );
    return jsonResponse({ ok: true });
  });
  router.delete("/api/backend-keys/{id}", async (ex) => {
    requireOperator(ex);
    await backendKeys.revoke(ex.params.id);
    return jsonResponse({ ok: true });
  });
}
