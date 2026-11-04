# Connected backends

`connected.ts` owns approved connections, private keys and cached health;
`remote_client.ts` owns bounded calls and streaming transport. Keys never enter
agent environments or proxy responses. The receiving backend enforces its key
policy in `src/auth/backend_keys.ts`.

Connections use atomic 0600 writes in Pi's credential directory and one mutation
queue to keep labels unique. Passwords are exchanged once. Logout leaves
connections intact. Agent-requested addresses persist pending without keys;
only operator sign-in contacts them. Pending entries are not health-checked,
including after restart; failed sign-in stays pending. Older records without
request fields remain connected. Unreadable stores require repair and restart.
Sign-in budgets are 10s for status and 60s for password verification/key creation;
diagnostics never include credentials. Offline peers retain keys and last
contact. Nothing probes remotes on a timer, so idle instances (for example
on a host that stops idle containers) can stop: a remote's last contact comes
from the last successful sign-in, probe, proxied call, relay poll or callback.
Listing connections (Settings, the sidebar, `recurse_settings`' `list_remotes`) returns cached state and
probes those not heard from for a minute in the background (3s). Relay sends
and agent gateway calls probe a remote whose state or API version is unknown,
or that is offline, allowing 60s for a sleeping remote to start; a failed
probe is retried after 10s. Transitions are logged.
A bounded version read at sign-in, after successful health probes and on the
first contact after a restart caches the remote API major, revision and
release, using ETags on subsequent reads. Overlapping reads cannot replace a
newer verdict with an older response. Missing revisions mean revision zero;
a different major or malformed response is incompatible. Incompatible peers
are refused for relay admission, proxy and transcript reads; older revisions
retain existing relay and link functionality. Proxied v1 routes require revision
3, when backend-key access was added; an unknown or insufficient version returns
an actionable 409 without contacting the v1 route. A failed version request retains
the last known compatibility rather than hiding an incompatible verdict.
Settings and the agent settings tool share `request` and `listForAgents` in
`connected.ts`; native calls do not read server credentials or use loopback HTTP.
Relay subscribers own poll tasks
per connection; open-mode pollers identify the home without a credential.

Homes learn their own address from the Origin of the operator's browser
mutations (same-origin, CSRF-checked; GET requests carry no Origin). With a
key, the home registers that address and a fresh `recurse-callback_` token on
each remote (`PUT /api/backend-keys/self/callback`); an `http` home does not register
with an `https` remote. The remote stores it in
`recurse-home-callbacks.json` (0600, Pi's credential directory,
`home_callbacks.ts`) after one test notice reaches the home. A failed test
removes that key's registration, and the home relies on polling; so
using the home at an address the remote cannot reach (for example a tailnet
URL) turns push off until the reachable address is used again. A registration
replaces only its own key's earlier one (home names need not be unique) and is
dropped when its key is revoked or the home answers 401. The home keeps only the token digest in its connection record. The token
authenticates nothing but `POST /api/remote-events`, whose only events are
`test` and `relay` ("a message waits"); message content still travels over
the home's authenticated relay poll. The home re-registers when its address
or other connections change, when operator use resumes after three idle
minutes, and a minute after a failed attempt.

When a relay message waits for a registered home without an open poll, the
remote notifies it and repeats every 5–30s until the home claims it; the home
then polls once. Homes long-poll every remote back to back while connected. Each response carries
`X-Recurse-API` (major.revision); existing relay traffic updates cached compatibility
when the remote changes version, without another request. Sends to a connected
remote with known compatibility go straight to delivery. A transient failure or
unknown delivery route triggers one status/version wake probe and retries with
the same message id; receiving admission remains deduplicated.
Local `GET /api/relay/messages/{id}` reads only the sender's outcome. Its optional
`wait` is 0–25 integer seconds (default 0; invalid values return 422); completion
wakes readers, and timeout or disconnect removes only that reader, not delivery.

An instance started with `RECURSE_SLEEP_WHEN_IDLE=1` (set by deployments that
stop idle instances) can sleep. While no agent runs, has queued messages or a
background shell, no relay send is in flight, and neither an operator browser
request nor a home request other than a relay poll arrived for three minutes,
it answers home polls at once with `sleep_seconds` (an hour, `relay_inbox.ts`),
so it gets no requests and its host can stop it. Homes then pause polling that
remote until the hour passes or they contact it themselves (a send, a proxied
call or an agent CLI command); that request counts as use, and polling resumes
once it has reached the remote. One-off polls on callback notices continue.
Listing connections does not probe a paused remote or a connection needing
sign-in. Status, version and tag-event streams do not count as home activity.
A visible browser's tag subscription follows only reachable, awake remotes.
A relay sleep answer closes that remote's stream; no stream request or retry
runs while it is paused. Existing explicit use or an awake relay answer resumes
the subscription. The passive stream transport never resumes polling itself. A rejected
key marks the connection as needing sign-in and stops all automatic requests,
including relay polls, health probes and callback registration. This state is
saved with the connection and survives restart. Signing in with a new key or
removing and re-adding the connection resumes polling. Proxied browser reads
fail immediately with the sign-in error, so browser refreshes cannot keep
contacting a revoked remote. Explicit relay checks and transcript reads may
still try once; only a successful request resumes automatic polling. Callback
notices cannot resume a revoked connection.

`RECURSE_SLEEP_CHECK_URL` names a check-in service that answers a paused
home's timed re-poll without starting the instance. The sleep answer carries
it as `check_url`; when the pause ends, the home sends
`GET <check_url>/api/relay/requests` with its backend key instead of polling.
A 200 answer with `sleep_seconds` keeps it paused that long; any other answer
or error makes it poll the instance as before. Homes ignore a check-in URL
that is not on the remote's own scheme (HTTPS, or HTTP on loopback). The
service must authenticate the key and answer only for that home, for example
from whether `relay-queue.json` holds messages for it; Recurse does not provide
one.

Messages a sleeping-capable instance produces for a home that is not polling
and does not take a callback within 90 seconds are kept in `relay-queue.json`
in the data directory (`relay_queue.ts`) and offered on that home's next poll;
the sender sees "Queued: queued for <home>". The queue holds at most 20
messages per home address and 200 in all; the sender whose message forces the
oldest out is told how many were dropped. Only labels a home polled with,
under a backend key that still exists (or keyless), are queued, and only that
home is offered them; others fail with "no connected home routes". Without the
setting, nothing is queued and unclaimed sends fail after 90 seconds, enough
for a sleeping home to start.

Inbound keys store only secret digests and reread disk on every check.
Serialized writes prevent last-used updates from resurrecting revoked keys;
password verification and key issuance/rotation share a credential queue.
Keys grant operator conversation authority, including safety changes, but
agent-marked calls are narrowed on both sides. Subagent-tool key access is
limited to GET transcript reads and search, never conversation lists. Remote Settings excludes theme,
passwords, keys, connections and MCP OAuth sign-in, whose callback stays local.

`src/web/backend_proxy.ts` serves operators and live local agents through
`/api/backends/{label}/...`. Agents authenticate with loopback credentials and a
live agent id, using the same check as the relay. Every connected remote is
available to agents without a toggle. The gateway refuses administrative routes
(settings, provider logins, MCP, credentials) and safety changes regardless of
what the remote key permits; only operators reach a remote's provider
logins, Models and MCP Settings (`remoteSettingsRoute`). Spawn rejects safety fields; remote agents use the
remote's defaults. Agent calls are capped at 16 active requests per label through
response completion or cancellation and log caller, label, route and duration.
Agent proxy calls carry a caller marker only alongside a backend key. The remote
rechecks agent route restrictions and preserves caller provenance for v1 messages and deletion,
including operator-taken-over subtrees; agents cannot change safety, pin state,
or promote side conversations. Local loopback credentials likewise cannot grant
these operator-only conversation actions or Settings and provider-auth routes;
operator sessions, trusted Tailscale identities, local open mode, and unmarked
backend operator keys where allowed can.
Calls to an offline remote fail with last-seen information after a probe of up
to 60s that lets a sleeping remote start; no operations are queued for later
delivery.

## Source files

- `connected.ts`: outbound connections, cached health, on-demand probes,
  activity and callback registration on the home.
- `home_callbacks.ts`: callback registrations and relay notices on the remote.
- `remote_client.ts`: bounded calls and streaming transport.
- `settings_sync.ts`: the settings sync inventory.
- `label.ts`: connection label validation and the keyed labels a remote
  stamps on senders relayed by each home's key.

Bun fetch keeps its default process-wide connection pool: separate CLI invocations
reuse the home server's outbound connections. Each outbound call emits one
`remote_call` event with backend label, route class, status, total and header wait
milliseconds, and the serving instance's `Server-Timing: recurse;dur=...` duration
when available. This server duration ends at response headers (including any
long-poll wait), while total time includes response consumption. DNS/connect/TLS
phase timing is unavailable from Bun fetch and is logged as unknown, not zero.
No URLs, target ids, keys or request content enter these events.

Transport timeouts cover headers and bounded bodies, including decompression;
transcript reads may request a larger bounded body and report overflow.
Proxy request bodies are bounded and buffered for Content-Length framing.
Responses stream with explicit header allowlists, opaque-origin sandboxing,
disconnect cancellation through EOF and deadlines except on long routes.
Exact echoed key bytes are redacted across chunk boundaries without buffering
the full response. API v1 and bundled-tool transcript/search JSON responses are
bounded and parsed before redaction, so JSON-escaped keys cannot reach the caller.
Responses over 2 MiB are refused: use smaller transcript line ranges or a narrower
subtree, or read an oversized line or required agent list on the remote directly.
Redirects return 502 without Location or redirect bodies.
Transcript/browser proxies contact only approved direct connections, not pending
entries or pollers; settings sync has its own inventory and cannot widen them.

`tools/subagent.ts create --remote LABEL` creates a top-level remote agent and
returns `cid@label`. Interrupt, wait, tail and rm resolve that form through the
gateway; bare ids remain local. Remote agents do not automatically report back
to their creators. Their first task carries the authenticated creator's full
`id@label` reply address, just like subsequent relayed messages. Local worktree paths and sibling creation cannot be combined
with remote creation. Keyless, open-mode connections refuse agent gateway calls;
reconnect with authentication to obtain a backend key. Send and messages retain their existing relay paths;
polling-only homes support send, not lifecycle commands.
