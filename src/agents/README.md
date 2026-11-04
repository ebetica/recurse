# Agents: the tree and each agent's lifecycle

This directory owns the agent tree and its lifecycle: creation, message
delivery, stopping, deletion and revival. Pi Durable runs each conversation's
turns ([durable/README.md](durable/README.md)); the browser reads bounded
conversation views through [view/README.md](view/README.md).

**Source files:** [instance.ts](instance.ts) wires the parts together;
[supervisor/](supervisor/) owns collection lifecycle and delivery;
[agent_tree.ts](agent_tree.ts) owns tree operations;
[runtime/agent_node.ts](runtime/agent_node.ts) owns one agent's admission and
controls; [agent_store.ts](agent_store.ts) and
[conversation_store.ts](conversation_store.ts) store agent state;
[reconciler.ts](reconciler.ts) retries deferred work;
[reap_history.ts](reap_history.ts) retains deleted history; and
[worktree_holders.ts](worktree_holders.ts) tracks worktree holders.

## Ownership and delivery

HTTP routes and CLIs ask the supervisor to act; they do not run agents.
Each node owns its queued input and controls, while Durable owns the Harness
and turns. Work survives a browser disconnect. Worker threads handle storage
and other I/O, not mutations of nodes or Harnesses. Closed agent databases and
optional journals retire in the trash Worker, which pins their parent before
file discovery and closes its descriptors before returning. The caller fences
recreation until retirement completes. Generated tool
instructions check repository paths asynchronously at request boundaries.
Presentation reads
detached snapshots rather than live owners. Sidebar rows reuse the API v1
Agent projection and cached PR, model and effort metadata without record reads.
The tree projection notifies visible browsers when admitted tags change. Tag
mutations publish that in-memory change before awaiting their durable flush;
HTTP success still means the flush completed.

A send is queued for persistence and handed to Pi without waiting for storage.
After a restart, uncertain dispatch requires an operator decision to retry or
dismiss; Recurse does not infer delivery from Pi history or promise exactly-once
delivery. See [runtime/agent_node.ts](runtime/agent_node.ts) and
[reconciler.ts](reconciler.ts).

## Lifecycle

Stop, clear and compact have distinct ordering boundaries. Deletion fences
admission first, then background teardown quiets the agent, retires its files
and removes its state. A failure stays visible for retry. Startup gates actions
until the collection is ready; maintenance is separate from request handling.
Shutdown closes admission and waits for owned tasks and process cleanup.
Reaped-history publication uses asynchronous hard links and renames, never copying
live stores. Publications serialize per conversation and day, recovering only that
conversation's temporary record; unrelated residue expires with its partition.
Scratch, sidecar, startup residue and staging retirement use the existing
descriptor-pinned trash Worker. Orphan batches share one Worker per pass,
isolate filesystem errors and settle before their caller releases ownership.
Date-partition expiry runs through the trash Worker client: descriptor-relative
scans and retirement stay off the main thread, and maintenance ownership lasts
until the result returns. Completed synchronous maintenance work is attributed
by bounded wall-time spans, without native CPU-accounting reads. Environment
setup also attributes concrete filesystem invocation prefixes and native lock
attempts/releases; promise completion and guard/retry waits remain excluded. See
[supervisor/lifecycle.ts](supervisor/lifecycle.ts),
[supervisor/reap.ts](supervisor/reap.ts) and
[../process_lifecycle.ts](../process_lifecycle.ts).

Taking or returning operator control stores a platform note for the agent and
its parent without waking idle recipients. Setting the same control state again
does not add a note.

Revival moves closed storage before publishing its conversation record. A
failed creation rolls storage back only before publication; a published
destination stays intact for readers and a later retry.

Tree memory scope follows the current root; moving or reviving an agent can
change it. Agent state, Durable transcripts and retained history have separate
owners and lifetimes.

## Rules for changes

- Keep one owner per fact; lower layers never import coordination owners or HTTP.
- Keep database and file waits off the send path. Report overload and write
  failures rather than silently dropping input.
- Fence before teardown; late results must not recreate a deleted agent.
- Verify cleanup by its effect, including process groups and retired files.
- Do not expose unauthenticated routes during startup or replace state after
  a failed import. Read [reconciler.ts](reconciler.ts) before changing retries.
