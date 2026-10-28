# Tools

Command-line tools for agents, with shared help extraction in [\_help.ts](_help.ts). Each tool's help lives in its
leading JSDoc, which is also its `--help` output and the text injected into
agent prompts; agents run them as `bun $RECURSE_SRC/tools/<tool>.ts`.

**Agent tools:** [subagent.ts](subagent.ts) (create, message, wait, remove and
revive agents, and read live or archived transcripts) · [worktree.ts](worktree.ts) (managed worktrees).

Native Pi tools replace the publishing, environment, settings and Artifact CLIs:
[publish](../src/extensions/core/environment/publish.ts) attaches files to the
calling conversation; [env](../src/extensions/core/environment/managed_tools.ts)
changes its environment overrides. Both reuse the existing admission and
validation modules in-process.
[artifact](../src/extensions/core/environment/artifact.ts) creates, lists and
renames Artifacts; its working paths are edited directly and Git commits publish.
All four native tools are callable directly or from codemode scripts and are excluded from
read-only side conversations, whose prompt prefix stays identical to the parent.
Mutations go through safety review; settings views do not.
The native [recurse_settings tool](../src/extensions/core/settings/settings.ts)
reads and writes Config and theme files directly; it does not call Settings HTTP routes.
Settings (including MCP), provider sign-in and operator login/password HTTP
routes are operator-only and reject even empty or malformed agent markers.

## Operator-controlled agents

`subagent.ts create --taken-over` creates an agent already taken over by the
operator, shown in the sidebar with replies to its parent muted from creation.
The operator controls it; its replies are not reported to the creator. It can
use `--sibling` and `--worktree`, but not `--remote`. This option only applies to
creation; agents cannot take over or release existing agents. Creation sends no
"User has taken control" platform note: the creator requested this state.

`messages TARGET` falls back to the archive index only when no live target
matches. Archived reads never revive an agent or open its Harness. Pages share
live entry-ID cursors; `--full --after CURSOR --limit 1` prints one entry with
untruncated text and JSON tool arguments.

## Remote agents

`subagent.ts create --remote LABEL` returns `cid@label` for a new top-level
agent using the connected remote's defaults. `interrupt`, `tail`, `wait` and
`rm` accept that target through the home gateway; bare ids stay local. Remote
creation cannot use local worktree or sibling options and has no automatic
parent report. Offline calls fail without queuing. `send` and `messages` keep
their relay behaviour, including send-only access through polling homes.
Remote messages, including the first task after creation, name the full
`id@label` reply address and show the send command. A missing local-id send
checks only the last 50 transcript rows for a matching remote sender and suggests
the qualified command; it never automatically routes the message.
See [connected backends](../src/backends/README.md) for gateway restrictions.

## Managed worktrees

A **managed worktree** is a Git checkout under the instance's `worktrees/`,
made by `worktree.ts enter` or `subagent.ts create --worktree`. Each has a marker,
`.markers/<name>.json`, listing the agents that hold it. Make baseline checkouts
with these tools or under your `$RECURSE_AGENT_TMPDIR`, which is removed with you.

Creation never waits for cleanup. Creating a worktree and `subagent rm` each
launch `worktree.ts sweep` as a detached process; a kernel lock allows one
sweeper per data directory, so duplicate launches exit at once. No server timer
runs this work. `.markers/.sweeper.pid` names the live sweeper and a bounded
`.sweep.log` records outcomes and failures.

The sweeper asks the server for a complete list of live agents. It retires
checkouts that no live agent holds or works in, including checkouts with no
marker (a manual `git worktree add`, an interrupted creation). Uncommitted
changes, age and names do not protect a checkout: commit work that must outlive
its holders. A failed, malformed or incomplete list retires nothing. Claims newer
than the list stay protected, and a creating CLI's process ID protects its
checkout while that process lives.

Creating an agent in, or `chdir` into, an existing managed checkout claims it
first, under a short kernel lock shared with retirement: if retirement wins, the
admission is refused. The server makes claims through a subprocess
([src/agents/worktree_hold.ts](../src/agents/worktree_hold.ts)) and never imports `worktree.ts`.

`subagent rm` returns before the agent is fully reaped, so it records the agent
ID under `.markers/.pending-reap/` first. A running sweeper also sees requests
added later. It polls while requests remain and removes each once a complete
list shows the agent gone and its marker holds are released; that release never
overrides a newer claim. Requests older than 30 minutes are logged and dropped.
A killed sweeper's requests are retried by the next launch, and a request that
arrives during shutdown starts a new sweep after the lock is released.

Retirement renames the checkout into trash with `retire` from
[src/utils/trash.ts](../src/utils/trash.ts) and drops its marker. Only the
detached sweep deletes trash, one tree at a time and outside the lock; a killed
pass continues next time. Trash entries in the old name-and-PID format are
renamed to the current format before they are deleted. The sweep never unlocks or prunes Git's own worktree
records; Git prunes stale ones before adding a checkout.

## Rules for changes

- `worktree.ts` stays standalone and import-safe: no Recurse configuration,
  agent or policy imports beyond the dependency-free trash and flock helpers.
- Unknown membership retains everything; no global lock spans HTTP, Git, scans
  or slow cleanup.
- Credentials never enter markers or logs.
