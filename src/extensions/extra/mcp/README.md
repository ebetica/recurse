# MCP sign-in

Settings → MCPs → MCP servers takes Pi's `mcp.json` format and Pi's validation,
except that every server uses code mode: `exposure` other than `"codemode"`,
`toolExposure` and `autoEnableCodemode: false` are refused, because the safety
review blocks MCP calls that do not come from a code-mode script.

HTTP servers authenticate in one of three ways:

- OAuth (the default, or `"auth": "oauth"` as Slack and Codex write it): sign
  in under Settings → MCPs. Servers may register a client automatically.
- `"auth": { "provider": "<provider>" }`: send the token of that provider's
  Settings login, as Pi does. The URL must be https, except on loopback.
- An `Authorization` header.

If the server requires your own OAuth app, add its settings under `oauth`:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "oauth": {
        "clientId": "YOUR_CLIENT_ID",
        "clientSecret": "YOUR_CLIENT_SECRET"
      }
    }
  }
}
```

The `oauth` fields are Pi's:

- `clientId`: a pre-registered client; without it the server registers one.
- `clientSecret`: the client's secret, a `${NAME}` reference or a `!command`.
- `callbackPort`: the redirect URI is `http://127.0.0.1:<port>/callback`.
- `callbackUrl`: the exact loopback redirect URI registered for the client.
- `scope`: scopes to request, separated by spaces.
- `clientName`: the `client_name` sent when registering a client.
- `clientRegistration`: `"dcr"` (default) registers a client; `"cimd"` uses
  Pi's client metadata document on pi.dev, if the server accepts it.
- `authServerMetadataUrl`: the authorization server metadata to use instead of
  discovery; https, or http on loopback.

Without `callbackPort`, `callbackUrl` or `"cimd"`, copy **Callback URL** from
the MCP Settings section and register that exact URL with the OAuth app; over
HTTPS or on localhost it is on the Recurse origin you sign in from. The secret
is masked in Settings unless it is a reference or command, and preserved on
save; changing the server URL, client ID or `authServerMetadataUrl` requires
entering it again. Changing the OAuth app forgets the previous sign-in. Client
secrets are used at the token endpoint, never sent to the MCP server; commands
run like header commands, as owned processes. Pi selects token authentication
from the authorization server metadata and owns token storage and refresh.
Configured clients refresh after a 401 through a fetch that refuses redirects.

## Configured callbacks

Recurse never listens on `callbackPort` or `callbackUrl`, because it may run on
another machine. Choose **Sign in**, open the sign-in link, approve, then paste
the full address of the page your browser lands on (it usually fails to load)
into the field under the server and choose **Finish sign-in**.

## Slack

Slack's MCP server has no client registration. Use the public client of
Slack's Claude Code plugin, whose redirect URI is Claude Code's
`http://localhost:3118/callback`:

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "1601185624273.8899143856786",
        "callbackUrl": "http://localhost:3118/callback"
      }
    }
  }
}
```

Your workspace administrator must allow that app. With your own Slack app, use
its client ID and a redirect URI registered on it.

## Saved configuration and sign-in state

Settings accepts `mcpServers` JSON. Keep literal tokens in env/header values,
not args or URLs: Settings hides them after saving and preserves masks only for
the same server transport/key. Pi-resolved `${NAME}` references and leading
`!command` values remain visible, including surrounding text; `$$` escapes `$`.
Saved servers apply on the next turn using file-stamp checks and Pi's resolver.

Recurse uses Pi's discovery, client registration/configuration, PKCE, state and
issuer checks and `mcp-auth.json` storage, but supplies its own callback route
instead of Pi's loopback listener so the browser can be remote. Pending state
survives restarts for two hours; expired or older untimed sign-ins must be
restarted. Expiry is checked on finish or restart, without background cleanup.
Exchanges use only the redirect URI registered with the pending client.
Messages never contain tokens or response bodies.

## Signing in from plain HTTP

Providers accept plain-HTTP redirect URIs only on loopback, so a Recurse page on
plain HTTP elsewhere (for example a Tailscale address) signs in through
`http://127.0.0.1/mcp-oauth-callback`, which Settings shows as the callback URL.
Nothing listens there: choose **Sign in**, open the sign-in link, approve, then
paste the full address of the unreachable page your browser lands on into the
field under the server and choose **Finish sign-in**. Recurse checks the
sign-in's state and exchanges the code itself; each address works once.

## GitHub

In [GitHub developer settings](https://github.com/settings/developers), create an
**OAuth App**. Set its homepage to your Recurse origin and its **Authorization
callback URL** to the copied callback URL. Copy the client ID, generate a client
secret, and add both under `oauth` as above. Save, then choose **Sign in**.
Your account and organization must permit access to GitHub's remote MCP server.

## Google Gmail

In [Google Cloud Console](https://console.cloud.google.com/), select your project,
enable the Gmail MCP service as required by Google's Gmail MCP setup, and configure
Google Auth Platform's consent screen, audience, and Gmail data access. Under
**Clients**, create a **Web application** OAuth client. Add the copied callback URL
as an **Authorized redirect URI**. For a testing app, add your account as a test
user. Put its client ID and secret under `oauth` on an entry whose `url` is
`https://gmailmcp.googleapis.com/mcp/v1`, save, then choose **Sign in**. Google
Workspace administrators may need to approve the app and requested Gmail scopes.
