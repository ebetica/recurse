# HTTP API v1

API v1 is under development until the operator declares it stable. Its schema
and revision are published at `GET /api/v1/schema` and `GET /api/v1/version`.
The current schema snapshot makes changes visible in review; during development
it may be updated in the same PR as the contract change. Clients must ignore
unknown fields and treat unknown status values as `unknown`.

Discover the local server from `$CHAT_DATA_DIR/server.json`: `port` is the TCP
port and `token` is sent in the `x-loopback-token` header. Extra discovery
fields may be added. A web session or backend key can also call these routes.
Connected backends are available through `/api/backends/<label>/v1/...`; the
proxy requires cached remote API revision 3 or later for backend-key access.
Successful responses are JSON with
`cache-control: no-store`. Errors raised by v1 routes carry `detail` and `code`;
clients must also handle server-level errors, including non-JSON 5xx responses.

`GET /api/v1/agents` lists cached agents; `?root=<id>` restricts the result to
that agent and its descendants. `GET /api/v1/agents/<id>` includes live shells.
Since revision 5, both reads include `context: { tokens, window } | null`.
Tokens measure the last committed prompt usage, using the UI's occupancy
projection; the window is null when the usage model differs from the selected
model or its capacity is unknown. Since revision 7, optional `context.session`
matches the conversation's `/view` history identity; usage from another session
must not be reused after Clear. Usage is cached only from commits followed
by an open conversation, including while idle. Cold, reopened-but-unsampled,
and newly compacted conversations return null. Status never opens a store or
reads history, and reading the UI inspector does not warm this cache.
`GET /api/v1/agents/<id>/idle` reports whether the subtree has no running or
stopping agent, queued messages, or background shells. Monitor shells do not
make a subtree busy. Status is the agent's own state, not a descendant overlay.
`workdir` is the configured initial work directory, not the directory most
recently selected with `chdir`. Optional `tags`, `operator_message_at` and
`replied_at` fields support sidebar sections; absent fields mean an older remote. Idle reads return 503 with retry guidance while
the tree is rebuilding, rather than declaring an incomplete tree idle.

`GET /api/v1/agents/<id>/messages` reads a bounded transcript page with
`limit` (1–50), `before` or `after` entry cursors, and `full=true` for
untruncated text and arguments. `before` excludes its cursor, while `after`
includes it. Use `prev` with `before` for older entries and `next` with `after`
for newer entries; one entry may contain multiple messages. `truncated` also
marks summarized tool arguments and output. Timestamps are epoch seconds or null.
`POST /api/v1/agents/<id>/messages` admits text through the same delivery path
as the web app, with optional `interrupt` and `client_message_id`. The optional
`x-recurse-agent` header identifies a live local sender; otherwise the message
is sent by the operator. A backend key's authenticated agent marker instead
identifies a relayed sender as `id@key-name` without a title. Backend keys cannot
claim a local sender with `x-recurse-agent`. The response acknowledges admission,
not completion.

Since revision 6, `POST /api/v1/agents/<id>/compact` requests compaction through
[the operator lifecycle](../compact.ts), retaining stored history. It returns
`{ id, action: "compact", queued }`; running conversations keep working while
the summary is prepared and applied at a boundary, as in the web app.

`POST /api/v1/agents/tags` changes tags on 1–500 agent ids with `set` (tag name
to expiry seconds or null) and `clear` (tag names). It returns `missing` ids.
Only operators and unmarked operator backend keys may call it; agent-marked
requests are refused. Pin, snooze and archive use the same validation and storage
as local sidebar actions.

## Source files

- `schema.ts` defines the JSON schemas and TypeScript types.
- `agent.ts` is the shared Agent builder for v1 reads and sidebar snapshots.
- `routes.ts` serves cached tree state and live shells using that builder.

## Rules for changes

Keep the served schema, revision and contract snapshot consistent. Test real
HTTP responses against the schema. Do not scan historical records to serve the
live agent tree.
