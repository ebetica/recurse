# Connect another Recurse instance

A remote is another Recurse instance whose agents appear in your sidebar and can
message yours. Use one to work with agents running on another machine, such as a
Modal deployment, without switching between browser tabs. The instance you connect
from is the **home**; agents still run on their own instance.

## Connect in Settings

1. Open **Settings → Remotes → Add a remote** on your home instance.
2. Enter a **Remote name** (the label used in addresses), its Recurse web URL
   in **Remote address**, and its existing sign-in password. Use HTTPS; HTTP is allowed only
   for loopback addresses such as `http://127.0.0.1:8000`. Do not put credentials,
   a query or a fragment in the URL. Labels allow 1–32 letters, digits, dots,
   underscores or hyphens, but cannot be only dots.
3. Choose **Connect remote**. The password is exchanged once, not saved. The
   remote issues a connection key, which the home stores for later requests.
   You do not need to copy a key yourself. Connect only instances you trust:
   the home can access remote conversations, change safety settings and manage
   provider sign-ins, models and MCP servers. MCP servers can run commands.
   Calls made by agents have additional restrictions, including no remote
   administration or safety changes.

An agent can request a connection with
`bun $RECURSE_SRC/tools/subagent.ts backends add modal https://your-recurse.example.com`.
This only records a pending request: it does not contact the address or obtain a
key. Only you can approve it by signing in under **Settings → Remotes**, or
**Dismiss** it. Agents can use `backends list` to see states, reasons and last
contact, never keys. A passwordless remote can connect without a key, but agent
control commands require a key; reconnect with authentication to enable them.

## Sidebar and messages

Connected remotes have their own sidebar sections. Select an agent to read or
message it. **connected** means the tree is reachable; **Offline · last seen …**
means it is unreachable, not deleted. Previously loaded agents remain visible,
and Recurse retries. Offline operations fail rather than queue for later.
The sidebar's **key revoked** (Settings: **Sign-in revoked**) means access was
withdrawn: disconnect and add the remote again in Settings. An incompatible API version is shown separately with a link to open
the remote directly.

Agents address remote agents as `id@label`, for example:

```sh
bun $RECURSE_SRC/tools/subagent.ts send abc123@modal "Check the deployment"
```

Delivered messages identify their sender with `[recurse-from: id@label]`.
Reply using that full address; bare ids always stay local. A sender marker
quoted inside message text becomes `[recurse-from-quoted: …]`, not a trusted
sender header. Sender labels are supplied by the connected home, so they rely
on trusting that instance. See the [message stamping code](../agents/runtime/prompt_stamp.ts).

Connected homes poll remotes for messages addressed to them or their other
remotes. This also works for a home behind a firewall: it connects outward,
so the remote does not need an inbound URL for that home. These **polling homes**
support only `send`, to the home's agents or through it to its other remotes.
Transcript reads (`messages`) and agent lifecycle commands need a direct
connection. Remote creation does not automatically report results back; ask the
agent to send a reply. The [subagent tool](../../tools/subagent.ts) documents commands.

## Settings and access

Nothing syncs automatically. **Sync settings from home** previews a one-way copy
of effort levels (including the default level), default efforts, maximum context
window and theme. Confirm with **Apply settings to …**. Models unavailable on the
remote are refused. The [sync inventory](settings_sync.ts) is the
complete list: passwords, provider sign-ins, connection keys and MCP configuration
are not copied. Sign in to providers separately on each instance.

The home stores connection credentials in `recurse-backends.json` inside Pi's
Recurse-owned credential directory (`PI_CODING_AGENT_DIR`), with owner-only
permissions (0600). The remote stores only key digests and metadata in
`backend-keys.json` under `CHAT_DATA_DIR`, also 0600. Keys are not passed to agent
environments or exposed in connection lists. See [connection storage](connected.ts)
and [inbound keys](../auth/backend_keys.ts).

Choose **Disconnect** on the home to remove a connection and revoke its key.
If the remote cannot be reached, the connection is removed but the key stays
valid: revoke it on the remote under **Settings → Remotes → Homes with access
to this instance → Revoke access**. If the remote explicitly refuses revocation,
Disconnect fails and keeps the connection. You can also revoke access on the
remote at any time.
Signing out of the browser does not remove connections.

## Example: Modal

[Deploy Recurse on Modal](../../playground/modal/deploy.md), then add its deployed web URL on your home
under the label `modal`. Sign in with that deployment's password. Its agents now
appear in the sidebar; agents at home can send to `id@modal`, and remote agents
can reply to the full home address in their received message header.
