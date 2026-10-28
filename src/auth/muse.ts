// Muse subscription device flow (RFC 8628), then one-time key mint.
// Muse-code credentials never authenticate meta pay-as-you-go or other routes.
// Errors expose status/machine code only, never response bodies or tokens.
import type { Config } from "../config";
import { parsePythonJson, pyCompactJson } from "../utils/py_compact_json";
import {
  pyError,
  pyStrip,
  type ProviderCredentialStore,
} from "./provider_store";

export const CLIENT_ID = "1031625952748946";
const AUTH_BASE = "https://auth.meta.com";
export const DEVICE_URL = `${AUTH_BASE}/oidc/device/authorization/`;
export const TOKEN_URL = `${AUTH_BASE}/oidc/device/token/`;
export const KEY_URL = "https://api.meta.ai/muse-code/key";
export const API_VERSION = "1.0.0";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const PROVIDER = "muse-code";
export const META_PROVIDER = "meta";
export const ENV_KEY = "MUSE_CODE_API_KEY";
const RESTART_HINT = "“Sign in with Muse”";
export const PENDING_FILE_NAME = "muse_oauth_pending.json";
const DEFAULT_EXPIRES_IN = 600;
const DEFAULT_INTERVAL = 5;

export const MUSE_CODE_MODELS: [string, string][] = [
  ["muse-spark-1.1", "Muse Spark 1.1 (Subscription)"],
  ["muse-spark-1.2", "Muse Spark 1.2 (Subscription)"],
  ["muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor (Subscription)"],
  ["muse-spark-1.3", "Muse Spark 1.3 (Subscription)"],
  ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor (Subscription)"],
];
export const MUSE_CODE_CATALOG_ENTRY = {
  base_url: "https://api.meta.ai/v1",
  env_key: ENV_KEY,
  wire_api: "responses",
  models: MUSE_CODE_MODELS.map(([id, label]) => ({
    id,
    label,
    context_window: 1048576,
    effort: "xhigh",
  })),
};

type Dict = Record<string, unknown>;

/** A Meta endpoint answered with an error status; carries no body or token. */
export class MuseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Meta request failed (${status}): ${code}`);
    this.name = "MuseHttpError";
  }
}

function errorCode(status: number, body: string): string {
  let payload: unknown;
  try {
    payload = parsePythonJson(body);
  } catch {
    return `http_${status}`;
  }
  if (isDict(payload)) {
    const code = payload.error;
    if (typeof code === "string" && code) return code;
  }
  return `http_${status}`;
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** urllib.parse.urlencode: quote_plus with Python's safe set. */
function pyUrlencode(fields: Record<string, string>): string {
  const quote = (value: string) =>
    encodeURIComponent(value)
      .replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      .replace(/%20/g, "+");
  return Object.entries(fields)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join("&");
}

function asSeconds(value: unknown, fallback: number): number {
  if (typeof value === "number" && value > 0)
    return Math.max(1, Math.trunc(value));
  return fallback;
}

export interface MuseOptions {
  store: ProviderCredentialStore;
  config: Pick<Config, "upsertCustomProvider">;
  env: Readonly<Record<string, string | undefined>>;
  userAgent: string;
  /** oauth.HTTP_TIMEOUT, in milliseconds. */
  timeoutMs: number;
  /** Seconds since the epoch, like time.time(). */
  now?: () => number;
  endpoints?: { device: string; token: string; key: string };
}

export class MuseAuth {
  private readonly store: ProviderCredentialStore;
  private readonly config: Pick<Config, "upsertCustomProvider">;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly urls: { device: string; token: string; key: string };

  constructor(options: MuseOptions) {
    this.store = options.store;
    this.config = options.config;
    this.env = options.env;
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.urls = options.endpoints ?? {
      device: DEVICE_URL,
      token: TOKEN_URL,
      key: KEY_URL,
    };
  }

  private async post(
    url: string,
    contentType: string,
    body: string,
    bearer?: string,
  ): Promise<Dict> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-version": API_VERSION,
      "User-Agent": this.userAgent,
      "Content-Type": contentType,
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch {
      throw pyError("OSError", "Meta request could not be completed");
    }
    if (response.status < 200 || response.status > 299)
      throw new MuseHttpError(
        response.status,
        errorCode(response.status, text),
      );
    let payload: unknown;
    try {
      payload = parsePythonJson(text);
    } catch (error) {
      throw pyError("ValueError", (error as Error).message);
    }
    if (!isDict(payload)) throw new MuseHttpError(200, "invalid_response");
    return payload;
  }

  private postForm(url: string, fields: Record<string, string>): Promise<Dict> {
    return this.post(
      url,
      "application/x-www-form-urlencoded",
      pyUrlencode(fields),
    );
  }

  private postJson(url: string, payload: Dict, bearer: string): Promise<Dict> {
    return this.post(
      url,
      "application/json",
      pyCompactJson(payload, { separators: "default" }),
      bearer,
    );
  }

  private async storedKey(): Promise<string | null> {
    const credential = (await this.store.readAuth())[PROVIDER];
    if (
      isDict(credential) &&
      credential.type === "api_key" &&
      typeof credential.key === "string" &&
      credential.key
    )
      return credential.key;
    return null;
  }

  /** Actual Pi providers enabled by the Muse subscription credential. */
  async modelProviders(): Promise<Set<string>> {
    if ((await this.storedKey()) || this.env[ENV_KEY])
      return new Set([PROVIDER]);
    return new Set();
  }

  /** Whether the Muse subscription route is signed in, without its key. */
  async authStatus(): Promise<Dict> {
    if (await this.storedKey())
      return {
        configured: true,
        type: "subscription",
        label: "Muse subscription",
      };
    if (this.env[ENV_KEY])
      return {
        configured: true,
        type: "subscription",
        label: "Muse subscription (environment)",
      };
    return { configured: false };
  }

  /** Drop the stored key and any in-progress login; `meta` is untouched. */
  async logout(): Promise<void> {
    await this.store.removeCredentials([PROVIDER]);
    await this.store.clearPending(PENDING_FILE_NAME);
  }

  /** Request a device code and persist it; returns the URL and user code. */
  async startLogin(): Promise<Dict> {
    let resp: Dict;
    let deviceCode: unknown, userCode: unknown, url: unknown;
    try {
      resp = await this.postForm(this.urls.device, { client_id: CLIENT_ID });
      if (!("device_code" in resp) || !("user_code" in resp))
        throw pyError("KeyError", "device response");
      deviceCode = resp.device_code;
      userCode = resp.user_code;
      url = truthy(resp.verification_uri_complete)
        ? resp.verification_uri_complete
        : resp.verification_uri;
      if (
        typeof deviceCode !== "string" ||
        !deviceCode ||
        typeof userCode !== "string" ||
        !userCode ||
        typeof url !== "string" ||
        !url
      )
        throw pyError("KeyError", "device response");
    } catch (error) {
      if (error instanceof MuseHttpError)
        throw pyError(
          "RuntimeError",
          `Meta device request failed (${error.status})`,
        );
      if ((error as Error).name === "KeyError")
        throw pyError(
          "RuntimeError",
          "Meta device request returned an unexpected response",
        );
      throw error;
    }
    const interval = asSeconds(resp.interval, DEFAULT_INTERVAL);
    const expiresIn = asSeconds(resp.expires_in, DEFAULT_EXPIRES_IN);
    await this.store.writePending(PENDING_FILE_NAME, {
      device_code: deviceCode,
      interval,
      expires_at: this.now() + expiresIn,
    });
    return { url, user_code: userCode, interval, expires_in: expiresIn };
  }

  private pendingResult(pending: Dict, status: string): Dict {
    if (!("interval" in pending)) throw pyError("KeyError", "'interval'");
    const remaining = Math.max(
      1,
      Math.trunc(Number(pending.expires_at) - this.now()),
    );
    return { status, interval: pending.interval, expires_in: remaining };
  }

  private async mintAndStore(accountToken: string): Promise<Dict> {
    const payload = await this.postJson(
      this.urls.key,
      { onboard: true },
      accountToken,
    );
    if (payload.is_subs_active === false)
      throw pyError(
        "ValueError",
        "This Meta account has no active Muse subscription. " +
          `Subscribe, then start over with ${RESTART_HINT}.`,
      );
    const raw = payload.api_key;
    const apiKey = typeof raw === "string" ? pyStrip(raw) : "";
    if (!apiKey) {
      const rawUrl = truthy(payload.action_url)
        ? payload.action_url
        : payload.require_payment_action_url;
      const actionUrl =
        typeof rawUrl === "string" && pyStrip(rawUrl) ? pyStrip(rawUrl) : "";
      if (payload.require_payment === true || actionUrl) {
        const detail = actionUrl ? ` Sign up here: ${actionUrl}` : "";
        throw pyError(
          "ValueError",
          `A Muse subscription is required.${detail}`,
        );
      }
      throw pyError(
        "ValueError",
        `Meta did not return a subscription key. Try again with ${RESTART_HINT}.`,
      );
    }
    await this.store.replaceCredentials(PROVIDER, {
      type: "api_key",
      key: apiKey,
    });
    await this.store.clearPending(PENDING_FILE_NAME);
    this.config.upsertCustomProvider(PROVIDER, MUSE_CODE_CATALOG_ENTRY);
    return this.authStatus();
  }

  private async terminal(message: string): Promise<never> {
    await this.store.clearPending(PENDING_FILE_NAME);
    throw pyError("ValueError", message);
  }

  private async backoff(pending: Dict): Promise<Dict> {
    const interval = pending.interval;
    if (!("interval" in pending)) throw pyError("KeyError", "'interval'");
    if (typeof interval !== "number" && typeof interval !== "boolean")
      throw pyError("TypeError", "interval is not a number");
    pending.interval = Math.min(Number(interval) + 5, 30);
    await this.store.writePending(PENDING_FILE_NAME, pending);
    return this.pendingResult(pending, "slow_down");
  }

  private async mintFromPending(pending: Dict, token: string): Promise<Dict> {
    try {
      return await this.mintAndStore(token);
    } catch (error) {
      if ((error as Error).name === "ValueError") {
        await this.store.clearPending(PENDING_FILE_NAME);
        throw error;
      }
      if (error instanceof MuseHttpError) {
        if (error.status === 429 || error.status >= 500)
          return this.pendingResult(pending, "key_pending");
        return this.terminal(
          `Meta refused the subscription key request. Start over with ${RESTART_HINT}.`,
        );
      }
      throw error;
    }
  }

  /** One poll attempt. */
  async pollLogin(): Promise<Dict> {
    const pending = await this.store.readPending(PENDING_FILE_NAME);
    if (
      !pending ||
      !(
        typeof pending.expires_at === "number" ||
        typeof pending.expires_at === "boolean"
      )
    ) {
      if (await this.storedKey()) return this.authStatus();
      throw pyError(
        "ValueError",
        `No login in progress. Start over with ${RESTART_HINT}.`,
      );
    }
    const accountToken = pending.account_token;
    if (typeof accountToken === "string" && accountToken)
      return this.mintFromPending(pending, accountToken);
    const expired = `The Muse code expired. Start over with ${RESTART_HINT}.`;
    if (this.now() >= Number(pending.expires_at)) await this.terminal(expired);
    if (!("device_code" in pending)) throw pyError("KeyError", "'device_code'");
    let token: Dict;
    try {
      token = await this.postForm(this.urls.token, {
        grant_type: DEVICE_GRANT,
        client_id: CLIENT_ID,
        device_code: String(pending.device_code),
      });
    } catch (error) {
      if (error instanceof MuseHttpError) {
        if (error.code === "authorization_pending")
          return this.pendingResult(pending, "pending");
        if (error.code === "slow_down" || error.status === 429)
          return this.backoff(pending);
        if (error.status >= 500) return this.pendingResult(pending, "pending");
        if (error.code === "access_denied")
          return this.terminal("The Muse sign-in was denied.");
        if (error.code === "expired_token") return this.terminal(expired);
        return this.terminal(
          `The Muse sign-in failed. Start over with ${RESTART_HINT}.`,
        );
      }
      const name = (error as Error).name;
      if (name === "OSError" || name === "RuntimeError")
        return this.pendingResult(pending, "pending");
      throw error;
    }
    const accessToken = token.access_token;
    if (
      truthy(token.error) ||
      typeof accessToken !== "string" ||
      !accessToken
    ) {
      const code = typeof token.error === "string" ? token.error : "";
      if (code === "authorization_pending")
        return this.pendingResult(pending, "pending");
      if (code === "slow_down") return this.backoff(pending);
      if (code === "access_denied")
        return this.terminal("The Muse sign-in was denied.");
      return this.terminal(expired);
    }
    pending.account_token = accessToken;
    await this.store.writePending(PENDING_FILE_NAME, pending);
    return this.mintFromPending(pending, accessToken);
  }
}
