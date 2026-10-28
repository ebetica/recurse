// Anthropic OAuth login/refresh uses api.anthropic.com, keeping stored auth.
// Settings' auth worker and Durable Models load this override directly.
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

export const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type Fetcher = typeof fetch;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function requestSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  const timer = setTimeout(
    () => controller.abort(new Error("request timed out")),
    timeoutMs,
  );
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

/** POST JSON without ever placing the response body in an exception. */
export async function postAnthropicJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const request = requestSignal(signal, 30_000);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const responseBody = await response.text();
    if (!response.ok)
      throw new Error(
        `HTTP request failed. status=${response.status}; url=${url}`,
      );
    return responseBody;
  } finally {
    request.dispose();
  }
}

function parseTokenResponse(
  responseBody: string,
  operation: string,
): OAuthCredentials {
  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(
      `${operation} returned invalid JSON. url=${ANTHROPIC_TOKEN_URL}; details=${errorName(error)}`,
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new Error(
      `${operation} returned an invalid token response. url=${ANTHROPIC_TOKEN_URL}`,
    );
  }
  const record = data as Record<string, unknown>;
  const refresh = record.refresh_token;
  const access = record.access_token;
  const expires = record.expires_in;
  if (
    typeof refresh !== "string" ||
    refresh.length === 0 ||
    typeof access !== "string" ||
    access.length === 0 ||
    typeof expires !== "number" ||
    !Number.isFinite(expires)
  ) {
    throw new Error(
      `${operation} returned an invalid token response. url=${ANTHROPIC_TOKEN_URL}`,
    );
  }
  return {
    refresh,
    access,
    expires: Date.now() + expires * 1000 - 5 * 60 * 1000,
  };
}

export async function refreshAnthropicToken(
  refreshTokenValue: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<OAuthCredentials> {
  let responseBody: string;
  try {
    responseBody = await postAnthropicJson(
      ANTHROPIC_TOKEN_URL,
      {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshTokenValue,
      },
      signal,
      fetcher,
    );
  } catch (error) {
    throw new Error(
      `Anthropic token refresh request failed. url=${ANTHROPIC_TOKEN_URL}; details=${errorName(error)}`,
    );
  }
  return parseTokenResponse(responseBody, "Anthropic token refresh");
}

function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Invariant: Continue with the code and fragment formats accepted by Pi.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const verifier = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  const challenge = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { verifier, challenge };
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  let responseBody: string;
  try {
    responseBody = await postAnthropicJson(
      ANTHROPIC_TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      signal,
    );
  } catch (error) {
    throw new Error(
      `Token exchange request failed. url=${ANTHROPIC_TOKEN_URL}; details=${errorName(error)}`,
    );
  }
  return parseTokenResponse(responseBody, "Token exchange");
}

async function loginAnthropic(
  interaction: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePkce();
  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  let server: import("node:http").Server | undefined;
  let resolveCode!: (value: { code: string; state: string } | null) => void;
  const codePromise = new Promise<{ code: string; state: string } | null>(
    (resolve) => {
      resolveCode = resolve;
    },
  );
  try {
    const { createServer } = await import("node:http");
    server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "", "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end("Callback route not found.");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || state !== verifier) {
          response.writeHead(400).end("Invalid OAuth callback.");
          return;
        }
        response
          .writeHead(200)
          .end(
            "Anthropic authentication completed. You can close this window.",
          );
        resolveCode({ code, state });
      } catch {
        response.writeHead(500).end("Internal error");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(CALLBACK_PORT, CALLBACK_HOST, resolve);
    });
    const onAbort = () => resolveCode(null);
    const signal = interaction.signal ?? new AbortController().signal;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    interaction.onAuth({
      url: `${AUTHORIZE_URL}?${authParams}`,
      instructions:
        "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
    });
    const manual = interaction.onManualCodeInput
      ? interaction.onManualCodeInput()
      : interaction.onPrompt({
          message:
            "Complete login in your browser, or paste the authorization code / redirect URL here:",
          placeholder: REDIRECT_URI,
        });
    let manualInput: string | undefined;
    const manualDone = manual
      .then((value) => {
        manualInput = value;
        resolveCode(null);
      })
      .catch(() => {
        resolveCode(null);
      });
    const result = await codePromise;
    if (result) {
      return exchangeCode(result.code, result.state, verifier, signal);
    }
    await manualDone;
    const parsed = parseAuthorizationInput(manualInput ?? "");
    if (parsed.state && parsed.state !== verifier)
      throw new Error("OAuth state mismatch");
    if (!parsed.code) throw new Error("Missing authorization code");
    return exchangeCode(
      parsed.code,
      parsed.state ?? verifier,
      verifier,
      signal,
    );
  } finally {
    server?.close();
  }
}

export const anthropicOAuth = {
  name: "Anthropic (Claude Pro/Max)",
  isSubscription: true,
  login: loginAnthropic,
  refreshToken: (credentials: OAuthCredentials, signal: AbortSignal) =>
    refreshAnthropicToken(credentials.refresh, signal),
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};
