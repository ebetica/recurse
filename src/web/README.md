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
Responses advertise the API major/revision in `X-Recurse-API` and request-to-header
server duration in `Server-Timing` (`recurse`). Existing route timing is retained.
Long routes lift idle timeout. HEAD drains the GET body but sends only headers.
`conversation_events.ts` streams focused Durable view deltas after committed changes;
reads are serialized and coalesced under backpressure, and disconnect releases the
conversation subscription. Visible streams send small heartbeats (less often
when idle), so a stalled connection reconnects and catches up. An unavailable
file lookup retries with bounded backoff while the stream is open. Hidden tabs
close their stream and reconnect when shown. A stream with `viewing=true`
registers a visible main conversation until disconnect, cancellation or read
failure; any such viewer suppresses agent-finished pushes to all devices for
that conversation. Other streams do not suppress pushes. Legacy views keep their one-shot
event response.
Unavailable conversation models return an actionable 422 after authentication.
Direct server startup probes loopback and the configured address for an existing
listener before initializing state. This prevents wildcard and 127.0.0.1
listeners from shadowing each other, but cannot detect every overlapping
address and is not an atomic bind. The supervisor stops the old server before
starting its replacement.

## Authentication and provenance

`request_auth.ts` authenticates before body decoding. Service requests are
bounded and audited, never operator-authorized. Loopback checks use the
proxy-resolved peer and constant-time token comparison. Joined duplicate
headers fail closed and every copy of the session cookie must verify. A loopback
token without a bundled-tool marker reaches API v1, `GET /api/status` and
`GET /api/version`, but not internal web routes. The bundled tools mark their
own internal requests; this marker is compatibility guidance, not isolation
from same-user code. A valid operator cookie still admits web requests. In open
mode, requests without a loopback token retain operator access.
Forwarded agent provenance requires a backend key and narrows its routes;
a qualified requester remains available for remote lifecycle authorization.
Settings (including MCP), provider authentication and login/password routes
refuse all agent markers, including empty and joined duplicate values.
Agent settings tools use Config/theme files directly instead of these routes.
The sidebar's `/api/sidebar/*` tag route (`tags.ts`) refuses all agent markers
the same way; agents change their own tags through the bundled-tool
`/api/conversations/{cid}/tags` route.
`sidebar_script.ts` privately revalidates the complete script/default/history
response: unchanged polls return 304, while edits remain visible on the next poll.
Authentication and agent-marker refusal still precede revalidation.
Agent-finished notification devices are saved through
`/api/settings/notifications/*` (`notifications.ts`), so the same refusal
applies; sending lives in [../push_notifications.ts](../push_notifications.ts).

`deliver_message.ts` shares content delivery between conversation and API v1
routes, including sender provenance and interruption. API v1 uses the authenticated
backend-agent marker as a relayed sender and ignores local sender headers on
backend-key requests. `conversations.ts` always
treats relayed text as agent input. A trusted home
may forward another link's label, but its key name is separately recorded as
`forwarded_by` in the audit log; absent a label, the key name is the sender.
Durable tool reads use stored tasks; legacy Pi tool detail remains 404.

`relay.ts` runs one cancellable poll per connected link. Transcript reads are
loopback-only, bounded and direct-connection-only. Pending work is capped per
label and settled outcomes expire after five minutes. A bounded status check
precedes delivery only when readiness or compatibility is unknown; a failed
direct delivery rechecks readiness once and retries with the same id; known-offline sends fail rather than queue (only a sleeping
instance queues sends to its homes, `relay_queue.ts`), and uncertain
POST outcomes remain uncertain. Proxy transport and key scope are described
in [../backends/README.md](../backends/README.md).

Login, password rotation and logout cookies retain `HttpOnly`, `SameSite=lax`
and their existing paths and lifetimes on both HTTP and HTTPS.
[login.ts](login.ts) omits `Secure` only when the existing trusted-proxy scheme
is HTTP, the CSRF-validated browser Origin explicitly uses HTTP, and no forwarding
metadata or scheme hint is present. HTTPS origins, missing origins and the private
Tailscale Serve listener keep `Secure`, including HTTPS proxies not configured in
[../server.ts](../server.ts)'s trusted-proxy list. Any `Forwarded`, `X-Forwarded-*`,
`Front-End-Https` or `X-Url-Scheme` header keeps `Secure`, without parsing its value.
These hints do not change proxy trust or CSRF decisions. The
[authentication corpus](../../tests/backend/http_auth.test.ts) checks HTTP,
trusted/untrusted HTTPS proxies, missing origins and Serve through real listeners,
including cookie rotation and removal.
CSRF matching, password validation, throttling and authorization are unchanged.
Plain HTTP does not encrypt passwords or sessions; use HTTPS on untrusted networks.

## Message search

[message_search.ts](message_search.ts) registers bundled-tool search and bounded
plain-text transcript reads. The read route resolves live/archive selectors,
never arbitrary file paths; responses cap line ranges and bytes.
Live scopes use the owned conversation projection; retained scopes use bounded
archive-index pages, never directory scans or Harness opens. `--all` searches
live agents; `--deleted` adds retained reaped agents. Explicit archive ids also
read retained clear history. Side-conversation-only search is not available.
The existing authenticated backend proxy supports direct remote targets.
After listening, [the backfill](../search/backfill.ts) builds derived files in
bounded pages, yields to focused opens, and records progress once for restart.

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
