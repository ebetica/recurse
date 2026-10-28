// A loopback OAuth 2.1 authorization server and streamable-HTTP MCP server
// following the MCP authorization spec: protected-resource and authorization
// server metadata, dynamic client registration, S256 PKCE, the RFC 9207 `iss`
// response parameter, rotating refresh tokens and RFC 7009 revocation.
// /authorize approves at once, standing in for the user's consent.
import { createHash, randomBytes } from "node:crypto";

type Client = { redirect_uris: string[] };
type Grant = { client_id: string; expiresAt: number };

export interface OAuthMcpServer {
  origin: string;
  url: string;
  /** Every grant_type the token endpoint accepted, in order. */
  grants: string[];
  /** How many requests reached the token endpoint. */
  tokenRequests(): number;
  /** Every token the revocation endpoint received. */
  revoked: string[];
  clients: Map<string, Client>;
  /** The scope of every authorization request, in order. */
  scopes: (string | null)[];
  /** Make every issued access token expired, so the next use must refresh. */
  expireAccessTokens(): void;
  /** Hold refresh_token grants until the returned release is called. */
  holdRefreshes(): () => void;
  /** How many refresh_token grants are being held. */
  heldRefreshes(): number;
  stop(): Promise<void>;
}

const id = () => randomBytes(18).toString("base64url");
const json = (body: unknown, status = 200, headers = {}) =>
  Response.json(body, { status, headers });

/** `registrationEndpoint` replaces the advertised one; `tokenRedirect` makes
 * the token endpoint answer 307 to that URL; `metadataPath` serves the
 * authorization server metadata only there, so discovery cannot find it;
 * `clientDocuments` accepts any https client ID as a metadata document
 * listing the requested redirect URI, and omits `iss`. */
export function startOAuthMcpServer(
  options: {
    registrationEndpoint?: string | null;
    tokenRedirect?: string;
    clientSecret?: string;
    metadataPath?: string;
    clientDocuments?: boolean;
  } = {},
): OAuthMcpServer {
  const clients = new Map<string, Client>();
  const codes = new Map<
    string,
    { client_id: string; redirect_uri: string; challenge: string }
  >();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, string>();
  const grants: string[] = [];
  const scopes: (string | null)[] = [];
  let hold: Promise<void> | undefined;
  let held = 0;
  let tokenRequests = 0;
  const revoked: string[] = [];
  const issue = (client_id: string) => {
    const token = id();
    const refreshToken = id();
    access.set(token, { client_id, expiresAt: Date.now() + 3600_000 });
    refresh.set(refreshToken, client_id);
    return json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: "read",
    });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      const path = url.pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["read"],
        });
      if (
        path ===
        (options.metadataPath ?? "/.well-known/oauth-authorization-server")
      )
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint:
            options.registrationEndpoint === null
              ? undefined
              : (options.registrationEndpoint ?? `${origin}/register`),
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            options.clientSecret ? "client_secret_post" : "none",
          ],
          authorization_response_iss_parameter_supported:
            !options.clientDocuments,
          client_id_metadata_document_supported: !!options.clientDocuments,
        });
      if (
        path === "/register" &&
        request.method === "POST" &&
        options.registrationEndpoint !== null
      ) {
        const body = (await request.json()) as { redirect_uris?: unknown };
        const uris = body.redirect_uris;
        if (
          !Array.isArray(uris) ||
          !uris.length ||
          !uris.every((uri) => typeof uri === "string")
        )
          return json({ error: "invalid_redirect_uri" }, 400);
        const client_id = id();
        clients.set(client_id, { redirect_uris: uris });
        return json({ ...body, client_id }, 201);
      }
      if (path === "/authorize") {
        const q = url.searchParams;
        const clientId = q.get("client_id") ?? "";
        const client =
          clients.get(clientId) ??
          (options.clientDocuments && clientId.startsWith("https://")
            ? { redirect_uris: [q.get("redirect_uri") ?? ""] }
            : undefined);
        const redirect = q.get("redirect_uri") ?? "";
        if (!client || !client.redirect_uris.includes(redirect))
          return new Response("unknown client or redirect_uri", {
            status: 400,
          });
        if (
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("code_challenge") ||
          q.get("resource") !== `${origin}/mcp`
        )
          return new Response("invalid request", { status: 400 });
        scopes.push(q.get("scope"));
        const code = id();
        codes.set(code, {
          client_id: q.get("client_id")!,
          redirect_uri: redirect,
          challenge: q.get("code_challenge")!,
        });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        if (!options.clientDocuments) back.searchParams.set("iss", origin);
        return new Response(null, {
          status: 302,
          headers: { location: back.href },
        });
      }
      if (path === "/token") tokenRequests++;
      if (path === "/token" && options.tokenRedirect)
        return new Response(null, {
          status: 307,
          headers: { location: options.tokenRedirect },
        });
      if (path === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const client_id = form.get("client_id") ?? "";
        const grant = form.get("grant_type") ?? "";
        if (
          options.clientSecret &&
          form.get("client_secret") !== options.clientSecret
        )
          return json({ error: "invalid_client" }, 401);
        if (grant === "authorization_code") {
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (
            !pending ||
            pending.client_id !== client_id ||
            pending.redirect_uri !== form.get("redirect_uri") ||
            createHash("sha256").update(verifier).digest("base64url") !==
              pending.challenge
          )
            return json({ error: "invalid_grant" }, 400);
          grants.push(grant);
          return issue(client_id);
        }
        if (grant === "refresh_token") {
          if (hold) {
            held++;
            await hold;
            held--;
          }
          const token = form.get("refresh_token") ?? "";
          if (refresh.get(token) !== client_id)
            return json({ error: "invalid_grant" }, 400);
          refresh.delete(token);
          grants.push(grant);
          return issue(client_id);
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      if (path === "/revoke" && request.method === "POST") {
        const token = new URLSearchParams(await request.text()).get("token");
        if (token) {
          revoked.push(token);
          refresh.delete(token);
          access.delete(token);
        }
        return new Response(null, { status: 200 });
      }
      if (path === "/mcp") {
        const bearer = /^Bearer (.+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        const grant = bearer ? access.get(bearer) : undefined;
        if (!grant || grant.expiresAt <= Date.now())
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        const message = (await request.json()) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "oauth-fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "whoami",
                      description: "Name the signed-in OAuth client",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : message.method === "tools/call"
                ? {
                    content: [
                      { type: "text", text: `client ${grant.client_id}` },
                    ],
                  }
                : undefined;
        return result
          ? json({ jsonrpc: "2.0", id: message.id, result })
          : json({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not found" },
            });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    grants,
    scopes,
    revoked,
    clients,
    expireAccessTokens: () => {
      for (const grant of access.values()) grant.expiresAt = 0;
    },
    holdRefreshes: () => {
      let release!: () => void;
      hold = new Promise((done) => (release = done));
      return () => {
        hold = undefined;
        release();
      };
    },
    heldRefreshes: () => held,
    tokenRequests: () => tokenRequests,
    stop: () => server.stop(true),
  };
}
