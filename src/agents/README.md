# Agents: the tree and each agent's lifecycle

This directory owns the agent tree: creating agents, delivering messages,
stopping, deleting and reviving them, and starting and stopping the whole
collection. Each conversation's turns run in Pi Durable
([durable/README.md](durable/README.md)); the browser reads conversations through
[view/README.md](view/README.md).

**Source files:** [instance.ts](instance.ts) (wires everything together) ·
[supervisor/](supervisor/) (create, delivery, reads, reap, revive, lifecycle) ·
[agent_tree.ts](agent_tree.ts) (membership, moves, reaping, wakes) ·
[runtime/agent_node.ts](runtime/agent_node.ts) (one agent) ·
[conversation_store.ts](conversation_store.ts) · [agent_store.ts](agent_store.ts) ·
[reconciler.ts](reconciler.ts) (retrying deferred actions) ·
[compaction.ts](compaction.ts) (parked clear and compact) ·
[reap_history.ts](reap_history.ts) (archives of deleted agents) ·
[worktree_holders.ts](worktree_holders.ts) (claiming managed worktrees) ·
[../process_lifecycle.ts](../process_lifecycle.ts) (process-group cleanup)

## Who owns what

The **supervisor** owns the collection of agents and the lifetime of startup,
shutdown, readiness and maintenance tasks. HTTP routes and CLIs ask it to act;
they never drive an agent directly. Each agent has one **node** (`AgentNode`)
that owns its queued messages, control requests and persistence bookkeeping;
`DurableHost` owns its Harness and turns. Once accepted, an agent's work belongs
to its node, so a closed browser never cancels it.

Worker threads handle storage, prompt loading and search, but never change nodes
or Harnesses. Admitting and changing an agent happens on the supervisor's event
loop, and rechecks membership and the deletion fence before anything is queued
for saving. Presentation code reads snapshots and history; it never looks up
live owners. Conversation reads can select fields to avoid cloning unrelated
state; selected objects are still detached from the live projection. Live status
and activity lookups select only their scalar metadata fields. The CLI conversation
index overlays the same live turn status as the tree; persisted idle metadata
alone does not indicate whether a Durable turn is running. Agent metadata
and queued messages live in per-agent SQLite stores
(`agent_store.ts`, `conversation_store.ts`), separate from Durable's transcript.

## Operator Take over

Take over stores `pinned`, `muted` and `pinned_order` together. A spawn request
with `taken_over: true` starts in that state before its first input is delivered,
without a takeover platform note. Muting remains stored for taken-over top-level
agents too. Agent-marked requests cannot take over or release existing agents;
only the operator can change their Take over state.

## Sending a message

Sending is two steps: the message is queued for saving, and at the same time
handed to Pi. Nothing on that path waits for the database, a file lock or a
transcript read. Pi's acknowledgement retires the saved message; finishing the
turn is a separate event.

A durable mark records when a message leaves the queue for Pi. After a restart,
a message without the mark never reached Pi and is sent again. A message with
the mark may have reached Pi, so it waits for the operator to choose **Retry**
or **Dismiss**. Recurse never rereads Pi's history to decide, and does not
promise exactly-once delivery: a retry can repeat a message. A hard crash can
lose a message that was still buffered, or replay one Pi accepted just before
the crash; an orderly shutdown saves the marks first. A slow Harness open for
one agent never stalls another.

## Memory scopes

Prompt memory indexes include Global, Tree and Local scopes. Tree files live at
`$CHAT_DATA_DIR/memories/trees/<top-level-agent-id>/`; the root and all descendants
read and edit the same directory. Each request resolves the current root by
walking parent links in the live conversation projection, without history scans.
Moves and top-level revival therefore change the scope on the next request.
Remote agents use their own instance's tree. Like local memories, tree memories
are retained after reaping, including for revival; no deletion is added.
All three scopes use the same bounded fresh snapshot, with no cache or watchers,
and remain inspectable through the existing captured request.

## Stopping

Stop has two levels. **Interrupt** aborts the running turn; a replacement
message waits for the next run instead of racing the abort, and never enters
the dying run. Stopping an idle agent stops its background shells without a
model request. Stopping a running agent requires its run ID; a stop without one
is rejected while the agent is running, and stops background shells when it is
idle. A stop that finds no
run to end still does the shell and resource cleanup. Sends and stops carry
client-made idempotency keys, so a retried request returns the first result.
Clear and compact keep their own boundaries: input sent before a clear runs
first, and a failed compaction leaves the conversation usable.

## Deleting an agent

Deleting (reaping) is an ordered teardown. It first fences the agent so nothing
new is admitted, then quiets the node and its helpers, retires its files, retires
its database last, and finally removes it from memory. The request only fences
and records; bounded background cleanup does the physical work and proves it
finished. Directory trees are retired by same-filesystem rename, never by
recursive deletion inline, under a lock or in a request. If a step fails, the
agent stays visible with a retry; it is never left half-deleted.

Deleted agents' history is retained for 90 days by default. Settings > Account
controls the number of days, applied during background maintenance. Durable
archives expire in bounded index-driven batches; legacy history expires by day
partition. `subagent messages` can read retained history without revival.

## Startup and shutdown

Startup has two milestones. First the server can answer HTTP: it serves the page
and answers agent requests as "not ready", never as an empty tree. Then, once
metadata, membership and process checks finish, agent actions open. Maintenance
(trash, retained deletions, orphan pruning, warming) runs as separate tasks that
never overlap themselves or block actions. Required migrations run once and
record that they finished. `src/local.ts` launches the server; the supervisor
initializes agents. A failed or partial import keeps normal changes blocked.
Worktree cleanup belongs to `tools/worktree.ts`, never to server maintenance.
Pi import maintenance snapshots only legacy records, not native Durable records.
`startup_readiness_step` logs separate login import, store import, projection,
scratch/process reconciliation and recovery waits. Conversation and Artifact
HTTP response logs identify maintenance jobs active at admission and completion.
Shutdown closes admission, cancels and awaits owned tasks with deadlines, checks
that process groups are gone, and leaves unknown outcomes visible.

## Rules for changes

- One owner per fact: no second node registry, parallel watcher or shared
  runtime map. Lower layers never import owners or HTTP.
- Keep database and file work off the send path; moving it to a thread is not
  enough if the send still waits for it. Report overload and write failures
  instead of dropping messages or retrying without bound.
- Old Stop, compact or delete requests never replay as messages. Each control
  keeps its own ordering; do not build a generic command engine.
- Fence first. Nothing admitted after a fence may recreate what teardown removed.
  A late tool result never revives a deleted agent.
- Prove cleanup by its effect: the process group is gone, the directory retired,
  the row removed. A stopped process is not a deleted agent, and shell exit is
  not deletion.
- Never expose unauthenticated routes while auth loads. A failed import never
  creates a replacement root. No global lock spans scans, subprocesses or a
  second lock; read first, then change state under short local guards.
- Read [reconciler.ts](reconciler.ts) before changing retry behaviour.
