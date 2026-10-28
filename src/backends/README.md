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
contact; health probes back off to five minutes and log transitions only.
Browser reads may observe recovery sooner. Relay subscribers own poll tasks
per connection; open-mode pollers identify the home without a credential.

Inbound keys store only secret digests and reread disk on every check.
Serialized writes prevent last-used updates from resurrecting revoked keys;
password verification and key issuance/rotation share a credential queue.
Keys grant operator conversation authority, including safety changes, but
agent-marked calls are narrowed on both sides. Subagent-tool key access is
limited to GET transcript reads, never lists. Remote Settings excludes theme,
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
rechecks agent route restrictions and preserves caller provenance for deletion,
including operator-taken-over subtrees; agents cannot change pin state.
Known-offline calls fail immediately with last-seen information; no operations
are queued for later delivery.

Transport timeouts cover headers and bounded bodies, including decompression;
transcript reads may request a larger bounded body and report overflow.
Proxy request bodies are bounded and buffered for Content-Length framing.
Responses stream with explicit header allowlists, opaque-origin sandboxing,
disconnect cancellation through EOF and deadlines except on long routes.
Exact echoed key bytes are redacted across chunk boundaries without buffering
the full response. Redirects return 502 without Location or redirect bodies.
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
