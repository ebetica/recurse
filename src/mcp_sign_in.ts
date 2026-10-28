// Settings HTTP MCP OAuth uses Pi's flow/store with Recurse's callback route.
// Pending sign-in survives restarts for two hours; use its registered URI.
// Off-loopback HTTP and configured callbacks paste back; nothing listens.
// Messages never carry tokens or bodies; see extensions/extra/mcp/README.md.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  authorizeMcp,
  McpOAuthProvider,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
  type AuthorizationServerMetadata,
  type McpOAuthState,
  type OAuthFlowOptions,
} from "@earendil-works/pi-mcp/oauth";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { mcpCredentials, signsIn } from "./extensions/extra/mcp/mcp";

export const MCP_CALLBACK_PATH = "/api/settings/mcp-servers/oauth-callback";
/** Keep in sync with web/settings/mcp.ts. */
export const MCP_PASTE_REDIRECT = "http://127.0.0.1/mcp-oauth-callback";
const REQUEST_TIMEOUT_MS = 15_000;
const SIGN_IN_LIFETIME_MS = 2 * 60 * 60 * 1000;
type PendingSignIn = McpOAuthState & { signInStartedAt?: number };
const CLIENT_NAME = "Recurse";
/** Pi's loopback callback and its Client ID Metadata Documents. */
const PI_CALLBACK = "http://127.0.0.1/callback";
const PI_CLIENT_DOCUMENTS = "https://pi.dev/oauth";
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
const secure = (url: InstanceType<typeof URL>) =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && LOOPBACK.test(url.hostname));

/** A refused or failed sign-in; the message is safe to show. */
export class McpSignInError extends Error {
  override name = "McpSignInError";
}

type HttpEntry = McpServerEntry & {
  config: Extract<McpServerEntry["config"], { url: string }>;
};
// Invariant: OAuth uses https or loopback, never redirects.
const timedFetch: McpFetch = async (input, init) => {
  if (!secure(new URL(input)))
    throw new OAuthInsecureEndpointError(String(input));
  return fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
};
const registered = (state: McpOAuthState | undefined) => {
  const client = state?.clientInformation;
  return client && "redirect_uris" in client ? client.redirect_uris : [];
};
const sameText = (a: string, b: string) =>
  a.length === b.length &&
  timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));

/** `entry` when it signs in with OAuth; otherwise a safe refusal. */
export function signInEntry(
  entries: McpServerEntry[],
  name: string,
): HttpEntry {
  const entry = entries.find((each) => each.name === name);
  if (!entry) throw new McpSignInError("Unknown MCP server");
  if (entry.config.enabled === false)
    throw new McpSignInError("MCP server is disabled");
  if (!signsIn(entry.config))
    throw new McpSignInError(
      "Only HTTP servers without an Authorization header sign in",
    );
  return entry as HttpEntry;
}

/** The callback URL on the origin this request came from, or
 * MCP_PASTE_REDIRECT for plain http off loopback; refuses an Origin that is
 * not this request's Host. */
export function callbackUrl(headers: {
  get(name: string): string | null;
}): string {
  const origin = headers.get("origin") ?? "";
  const host = headers.get("host") ?? "";
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  if (
    !url ||
    url.origin !== origin ||
    !host ||
    url.host !== host.toLowerCase() ||
    !/^https?:$/.test(url.protocol)
  )
    throw new McpSignInError("Sign in from the Recurse page");
  return secure(url) ? `${origin}${MCP_CALLBACK_PATH}` : MCP_PASTE_REDIRECT;
}

type OAuthConfig = HttpEntry["config"]["oauth"];

/** The redirect URI Pi's sign-in would use for a configured callback or
 * "cimd", or undefined; Recurse only receives it pasted back. */
function configuredRedirect(oauth: OAuthConfig): string | undefined {
  if (
    !oauth?.callbackUrl &&
    oauth?.callbackPort === undefined &&
    oauth?.clientRegistration !== "cimd"
  )
    return undefined;
  const url = new URL(oauth.callbackUrl ?? PI_CALLBACK);
  if (url.port || oauth.callbackPort === undefined)
    return oauth.callbackUrl ?? url.href;
  url.port = String(oauth.callbackPort);
  return url.href;
}

/** Pi's Client ID Metadata Document for `serverUrl`: one per server unless the
 * authorization server sends `iss` (RFC 9700 section 4.4.2.2). */
function piClientDocument(
  serverUrl: string,
  redirectUrl: string,
  metadata: AuthorizationServerMetadata | undefined,
) {
  if (
    !metadata?.client_id_metadata_document_supported ||
    !metadata.token_endpoint_auth_methods_supported?.includes("none")
  )
    throw new McpSignInError(
      'The authorization server does not accept client metadata documents; remove oauth.clientRegistration "cimd"',
    );
  if (metadata.authorization_response_iss_parameter_supported)
    return { url: `${PI_CLIENT_DOCUMENTS}/client.json`, redirectUrl };
  const server = new URL(serverUrl);
  server.hash = "";
  const id = createHash("sha256")
    .update(server.href)
    .digest()
    .subarray(0, 9)
    .toString("base64url");
  const redirect = new URL(redirectUrl);
  redirect.pathname = `/callback/${id}`;
  return {
    url: `${PI_CLIENT_DOCUMENTS}/${id}/client.json`,
    redirectUrl: redirect.href,
  };
}

/** Pi's flow options for `entry`'s configured scope and metadata URL. */
const flowOptions = ({ config }: HttpEntry): OAuthFlowOptions => ({
  serverUrl: config.url,
  scope: config.oauth?.scope,
  authorizationServerMetadataUrl: (config.oauth?.authServerMetadataUrl
    ? new URL(config.oauth.authServerMetadataUrl)
    : undefined) as OAuthFlowOptions["authorizationServerMetadataUrl"],
  fetch: timedFetch,
});

/** Pi's message for a failed OAuth step, without bodies or tokens. */
function safeFailure(error: unknown): McpSignInError {
  if (error instanceof McpSignInError) return error;
  if (
    error instanceof Error &&
    error.message ===
      "Authorization server does not support dynamic client registration"
  )
    return new McpSignInError(
      "This server needs your own OAuth app: add its client ID (and secret) to this entry",
    );
  if (error instanceof OAuthRegistrationError)
    return new McpSignInError(
      `The server refused client registration (HTTP ${error.status})`,
    );
  if (error instanceof OAuthIssuerMismatchError)
    return new McpSignInError(
      "The sign-in answer came from a different authorization server",
    );
  if (error instanceof OAuthInsecureEndpointError)
    return new McpSignInError("The server's sign-in endpoints are not https");
  if (error instanceof OAuthError)
    return new McpSignInError(
      `The authorization server refused: ${/^[\w.-]{1,64}$/.test(error.code) ? error.code : "error"}`,
    );
  if (error instanceof Error && /timeout|abort/i.test(error.name))
    return new McpSignInError(
      "The authorization server did not answer in time",
    );
  return new McpSignInError(
    "The server does not offer OAuth sign-in or answered unexpectedly",
  );
}

export type ResolveValue = (value: string) => Promise<string>;

async function provider(
  entry: HttpEntry,
  store: ReturnType<ReturnType<typeof mcpCredentials>["forServer"]>,
  redirectUrl: string,
  resolve: ResolveValue,
  onRedirect: (url: URL) => void = () => {},
) {
  const { oauth, url } = entry.config;
  let clientSecret: string | undefined;
  if (oauth?.clientSecret !== undefined)
    try {
      clientSecret = await resolve(oauth.clientSecret);
    } catch {
      throw new McpSignInError("The OAuth client secret could not be resolved");
    }
  return new McpOAuthProvider({
    serverUrl: url,
    redirectUrl,
    clientMetadata: { client_name: oauth?.clientName ?? CLIENT_NAME },
    clientMetadataDocument:
      oauth?.clientRegistration === "cimd"
        ? (metadata) => piClientDocument(url, redirectUrl, metadata)
        : undefined,
    clientId: oauth?.clientId,
    clientSecret,
    store,
    onRedirect,
  });
}

/** Start a sign-in: the authorization URL to open and the redirect URI the
 * answer arrives at, or null when the stored refresh token already signed the
 * server in. A configured callback replaces `originRedirect`. */
export async function startMcpSignIn(
  configPath: string,
  entry: HttpEntry,
  originRedirect: string,
  resolve: ResolveValue,
): Promise<{ url: string; redirectUrl: string } | null> {
  const store = mcpCredentials(configPath).forServer(
    entry.name,
    entry.config.url,
  );
  const { oauth } = entry.config;
  const redirectUrl = configuredRedirect(oauth) ?? originRedirect;
  try {
    const stored = (await store.load()) as PendingSignIn | undefined;
    if (stored) {
      const next = { ...stored };
      delete next.oauthState;
      delete next.codeVerifier;
      delete next.signInStartedAt;
      // Invariant: Replace clients and tokens registered for another origin,
      // and clients from a metadata document, which is fetched again.
      if (
        oauth?.clientRegistration === "cimd" ||
        !registered(stored).includes(redirectUrl)
      ) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }
    if (oauth?.clientId) {
      const current = await store.load();
      await store.save({
        ...current,
        serverUrl: entry.config.url,
        clientInformation: {
          client_id: oauth.clientId,
          redirect_uris: [redirectUrl],
        },
      });
    }
    let authorization: URL | undefined;
    const flow = await provider(entry, store, redirectUrl, resolve, (url) => {
      authorization = url;
    });
    const result = await authorizeMcp(flow, flowOptions(entry));
    if (result === "AUTHORIZED") return null;
    if (!authorization)
      throw new McpSignInError("The server gave no authorization URL");
    if (!secure(authorization))
      throw new McpSignInError("The server's sign-in endpoints are not https");
    const query = authorization.searchParams;
    const pending = { ...(await store.load())!, signInStartedAt: Date.now() };
    // Invariant: Store a metadata document's client, so the exchange and
    // refreshes use its client ID and redirect URI.
    pending.clientInformation ??= {
      client_id: query.get("client_id")!,
      redirect_uris: [query.get("redirect_uri")!],
    };
    await store.save(pending);
    return {
      url: authorization.href,
      redirectUrl: registered(pending)[0] ?? redirectUrl,
    };
  } catch (error) {
    const failure = safeFailure(error);
    if (failure.message.startsWith("This server needs your own OAuth app"))
      throw new McpSignInError(
        `${failure.message}. Callback URL: ${redirectUrl}`,
      );
    throw failure;
  }
}

/** Finish the pending sign-in `query.state` names, if `accepts` its redirect
 * URI; returns the server name. */
export async function finishMcpSignIn(
  configPath: string,
  entries: McpServerEntry[],
  query: URLSearchParams,
  accepts: (redirectUrl: string) => boolean,
  resolve: ResolveValue,
): Promise<string> {
  const state = query.get("state") ?? "";
  const credentials = mcpCredentials(configPath);
  let match: { entry: HttpEntry; stored: PendingSignIn } | undefined;
  for (const entry of entries) {
    if (entry.config.enabled === false || !signsIn(entry.config)) continue;
    const stored = await credentials
      .forServer(entry.name, entry.config.url)
      .load();
    if (stored?.oauthState && state && sameText(stored.oauthState, state))
      match = { entry: entry as HttpEntry, stored };
  }
  if (
    match &&
    (!match.stored.signInStartedAt ||
      Date.now() - match.stored.signInStartedAt > SIGN_IN_LIFETIME_MS)
  ) {
    const { entry, stored } = match;
    delete stored.oauthState;
    delete stored.codeVerifier;
    delete stored.signInStartedAt;
    await credentials.forServer(entry.name, entry.config.url).save(stored);
    match = undefined;
  }
  const redirectUrl = registered(match?.stored)[0];
  if (!match || !redirectUrl || !accepts(redirectUrl))
    throw new McpSignInError(
      "This sign-in is no longer pending; start sign-in again from Settings",
    );
  const { entry, stored } = match;
  const store = credentials.forServer(entry.name, entry.config.url);
  const pending = { ...stored };
  delete pending.oauthState;
  delete pending.signInStartedAt;
  await store.save(pending);
  const error = query.get("error");
  const code = query.get("code");
  try {
    if (error)
      throw new McpSignInError(
        `The authorization server refused: ${/^[\w.-]{1,64}$/.test(error) ? error : "error"}`,
      );
    if (!code) throw new McpSignInError("The sign-in answer has no code");
    await authorizeMcp(await provider(entry, store, redirectUrl, resolve), {
      ...flowOptions(entry),
      authorizationCode: code,
      iss: query.get("iss") ?? undefined,
    });
    return entry.name;
  } catch (failure) {
    throw safeFailure(failure);
  } finally {
    const done = await store.load();
    if (done) {
      delete done.codeVerifier;
      await store.save(done);
    }
  }
}

/** The answer query in an address pasted after a sign-in, and a check that
 * the address is the pending sign-in's redirect URI. */
export function pastedAnswer(text: string) {
  const url = URL.canParse(text.trim()) ? new URL(text.trim()) : undefined;
  if (!url)
    throw new McpSignInError(
      "Paste the full address that your browser showed after approving",
    );
  const landed = `${url.origin}${url.pathname}`;
  return {
    query: url.searchParams,
    accepts: (redirectUrl: string) => {
      const expected = new URL(redirectUrl);
      if (landed !== `${expected.origin}${expected.pathname}`)
        throw new McpSignInError(
          `Paste the full address starting with ${redirectUrl} that your browser showed after approving`,
        );
      return true;
    },
  };
}

/** Forget a server's credentials, then best-effort revoke its grant at the
 * advertised RFC 7009 endpoint. Returns whether credentials were stored. */
export async function signOutMcp(
  configPath: string,
  name: string,
  serverUrl: string,
): Promise<boolean> {
  const credentials = mcpCredentials(configPath);
  const store = credentials.forServer(name, serverUrl);
  // Invariant: Pi's refresh lock prevents stale token writes.
  const [stored, removed] = await store.withRefreshLock(async () => [
    await store.load(),
    credentials.remove(name, serverUrl),
  ]);
  const token = stored?.tokens?.refresh_token ?? stored?.tokens?.access_token;
  const endpoint =
    stored?.discovery?.authorizationServerMetadata?.revocation_endpoint;
  const client = stored?.clientInformation;
  if (
    token &&
    client &&
    typeof endpoint === "string" &&
    URL.canParse(endpoint) &&
    secure(new URL(endpoint))
  ) {
    const body = new URLSearchParams({
      token,
      token_type_hint: stored?.tokens?.refresh_token
        ? "refresh_token"
        : "access_token",
      client_id: client.client_id,
    });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    await timedFetch(endpoint, { method: "POST", body }).then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
  }
  return removed;
}

/** Whether each signing-in server has stored tokens. */
export function mcpSignedIn(
  configPath: string,
  entries: McpServerEntry[],
): Map<string, boolean> {
  const credentials = mcpCredentials(configPath);
  return new Map(
    entries.flatMap((entry) =>
      signsIn(entry.config)
        ? [
            [
              entry.name,
              !!credentials.tokens(entry.name, entry.config.url)?.access_token,
            ],
          ]
        : [],
    ),
  );
}
