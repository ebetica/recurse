# HTTP boundary

`app.ts` composes Config, instance services, routes and authentication without
listening or starting work. Before listening, startup prepares storage/logging,
cleans owned processes, checks the target and loads the runtime. Until the
projection is ready, mutations/tree/views return 503 with retry guidance.
After listening, startup resolves commit identity for the agents' Git clone in
the background, including legacy `recurse-agent` migration. Neither startup nor
conversation loading waits for identity lookup; failures reach `recurse.log`.
With no configured identity or GitHub account, identity stays unset and a warning
in `recurse.log` asks the operator to set `user.name` and `user.email` or configure
a GitHub token; Git refuses commits until an identity is supplied.
HTTP drain and runtime shutdown run together; maintenance is best-effort.
Long routes lift idle timeout. HEAD drains the GET body but sends only headers.
Unavailable conversation models return an actionable 422 after authentication.

## Authentication and provenance

`request_auth.ts` authenticates before body decoding. Service requests are
bounded and audited, never operator-authorized. Loopback checks use the
proxy-resolved peer and constant-time token comparison. Joined duplicate
headers fail closed and every copy of the session cookie must verify.
Forwarded agent provenance requires a backend key and narrows its routes;
a qualified requester remains available for remote lifecycle authorization.
Settings (including MCP), provider authentication and login/password routes
refuse all agent markers, including empty and joined duplicate values.
Agent settings tools use Config/theme files directly instead of these routes.
Agent-finished notification devices are saved through
`/api/settings/notifications/*` (`notifications.ts`), so the same refusal
applies; sending lives in [../push_notifications.ts](../push_notifications.ts).

`conversations.ts` always treats relayed text as agent input. A trusted home
may forward another link's label, but its key name is separately recorded as
`forwarded_by` in the audit log; absent a label, the key name is the sender.
Durable tool reads use stored tasks; legacy Pi tool detail remains 404.

`relay.ts` runs one cancellable poll per connected link. Transcript reads are
loopback-only, bounded and direct-connection-only. Pending work is capped per
label and settled outcomes expire after five minutes. A bounded status check
precedes delivery; known-offline sends fail rather than queue, and uncertain
POST outcomes remain uncertain. Proxy transport and key scope are described
in [../backends/README.md](../backends/README.md).

## Tailscale Serve login

`RECURSE_TAILSCALE_LOGIN` admits one configured login through the separate
`$CHAT_DATA_DIR/tailscale/serve.sock` listener. Start Serve with:

```sh
tailscale serve --bg unix:$CHAT_DATA_DIR/tailscale/serve.sock
```

The owner-only socket directory admits only the server UID and root
(`tailscaled`). Same-UID tools already have operator credentials and may claim
this login too. Keep the full pathname within the platform's Unix socket limit
(107 bytes on Linux). Only this listener trusts `Tailscale-User-Login`; TCP
authentication/open mode is unchanged. Do not use Tailscale Funnel: the socket
requires Serve's tailnet identity.
