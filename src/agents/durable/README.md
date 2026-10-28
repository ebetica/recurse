# Turns, prompts and compaction (Pi Durable)

Pi Durable runs every agent's turns inside the Recurse server. This directory
connects it to Recurse: it opens one **Harness** (Pi Durable's runner for one
conversation) per conversation, builds
what the model sees, records each request, and reports finished work to the parent.

**Source files:** [host.ts](host.ts) (open handles, live rows, per-conversation
order, stop, compact, clear rotation) · `host/`: [open.ts](host/open.ts) (opening
a Harness or side fork, step by step) · [registry.ts](host/registry.ts)
(extensions, in install order) · [send.ts](host/send.ts) (admit and withdraw
input) · [clear.ts](host/clear.ts) (clear requests, held input, clear.json) ·
[delete.ts](host/delete.ts) (reap) · [close.ts](host/close.ts) (verified close
and shutdown) · [title.ts](host/title.ts) · [import.ts](host/import.ts) ·
[reads.ts](host/reads.ts) (inspector reads) · [runtime.ts](host/runtime.ts)
and [load.ts](host/load.ts) (the lazily loaded runtime) ·
[idle_harnesses.ts](idle_harnesses.ts) (idle retention and eligibility) ·
[prompt_resources.ts](prompt_resources.ts) · [prompt_sections.ts](prompt_sections.ts) ·
[system_order.ts](system_order.ts) · [request_capture.ts](request_capture.ts) ·
[report.ts](report.ts) · [report_holds.ts](report_holds.ts) · [follow.ts](follow.ts) ·
[side_conversations.ts](side_conversations.ts) · [promotion.ts](promotion.ts) · [sqlite_worker.ts](sqlite_worker.ts) ·
[durable_rows.ts](durable_rows.ts) · [models.ts](models.ts) ·
[model_selection.ts](model_selection.ts) (model references and selection errors) ·
[../runtime/prompts.ts](../runtime/prompts.ts) · [../runtime/prompt_stamp.ts](../runtime/prompt_stamp.ts) ·
[compaction extension](../../extensions/core/context/durable-compaction.ts)

## Storage

A Harness opens when a conversation is first used, or at startup when it still has
live work. It keeps the transcript, tool tasks and documents in
`conversations/<cid>/durable/session.sqlite`. All conversations share one Worker
thread for SQL, so no query or fsync runs on the server's event loop. Each
database has its own ordered queue, and a transaction holds it until commit.
The conversation's agent state stores the effective cwd changed by `chdir`;
runtime prompts and the Changes pane read that same state.
Background recovery yields before environment, search and storage phases while
another conversation opens on demand. One overall 60-second foreground wait
budget keeps hung opens from stopping recovery indefinitely; exhausted waits
log the focused holders and actual wait. Joining the same conversation never
waits on itself. HTTP accounting measures the focused open wait separately.
After ten minutes without use or idle commits, an unused Harness closes through
verified process cleanup. Running tasks, queued input, pending clears or reports,
title generation and attached side conversations keep it open. Sends serialize
with idle close; reads and sends arriving during close wait and reopen storage.
The transcript and latest captured request remain on disk.

Closed, reaped and cleared stores live in `agent-archive/<archive_id>` with
metadata in `index.sqlite`. Settings keeps unrevived history for 90 days by
default, configurable from 1 to 36500 days. Maintenance retires at most four
expired stores per pass using the age index, outside requests; legacy `history/`
day partitions use the same setting. Revival holds exclude stores from expiry;
revived metadata remains for provenance. CLI archive reads use the index and
immutable, read-only SQLite opens, never a Harness or a directory scan.

## A turn

Messages enter the Harness queue. Durable sends a request to the model, runs the
tool calls in the reply, and repeats until the model stops. A message that arrives
mid-run is delivered at the next request boundary. When a subagent's run
settles, `report.ts` sends its final reply to the parent once, after a line
saying what started the run; a run with no final reply sends a notice instead.
That line also counts the other messages the run received, from the operator,
the parent ("from you") and other agents, showing only nonzero counts.

## Held reports

A child's report waits while the child works (a run, or queued input that will
start one) or while a local descendant works or has not yet sent its own
report (`ReportHolds.holders`, `SupervisorDelivery.reportWaits`). Open
shells, idle agents, side conversations and remote agents never hold it.
Waiting stores nothing: the report cursor stays put and every pass decides
again. If the child settled more runs meanwhile, one report carries the latest
run's trigger, text and outcome, counts every other message those runs
received, and adds "N earlier turns ended"; it uses the latest run's key, so
the parent sees each text once.

Why every parent still gets its report: holders are only open conversations,
and each way one stops holding rechecks all held reports: a commit after which
it no longer works or queues input, its reporter catching up (a failed pass
retries), its Harness closing outside a deletion, and the end of its deletion
(after the parent's deletion notice). A parked deletion holds until its retry
succeeds. The reporter also holds when it saw the child's next input before
the child's live row did. Queued input whose model cannot apply does not hold,
and a pending clear never waits. After a restart each reporter passes at open;
startup opens the deepest conversations first (a side conversation at its
host's depth), so a resumed descendant holds its ancestors again. An earlier
on-demand open of an ancestor, or moving a working descendant away, can only
send a report early or once that descendant stops, never lose it.

## What the model sees

Each request's system prompt starts with Recurse's fixed foreword, which replaces
Pi's default. It adds the project's context files (`AGENTS.md`, with `@` imports) and skill descriptions
read by `prompt_resources.ts` from Pi's external skill locations, and the Recurse sections rendered by
`runtime/prompts.ts`: agent context, memory index, runtime, agent tree, Recurse
tools, and MCP servers. After asynchronous memory and resource reads, the tree
snapshot copies only the outer conversation rows. Digest rendering reads nested
metadata without changing it, and runs synchronously before another turn can
update the projection. It never deep-clones unrelated conversation metadata.
`prompt_sections.ts` snapshots sections at every request boundary;
a section that changed since the last request is sent as a system
update before the next user input (`system_order.ts`).

Every user message carries its trusted origin (operator, agent, or platform)
separately from its text (`prompt_stamp.ts`). Text that looks like an origin
marker is escaped, so a message cannot pose as the operator.

`prompt_resources.ts` reads fresh resources on a shared Worker, falling back
on-loop with `onFallback` reporting. `@` imports preserve source text and add
Markdown entries depth-first, at most four hops, 64 KiB per import, 256 KiB and
128 attempts per load. Relative, absolute and `~/` paths and escaped spaces
work outside Markdown code. Hidden files, symlinks and the Recurse agent
directory are refused; missing/refused imports are silent.

`request_capture.ts` records the exact request after all hooks run. The prompt
inspector in the UI ([web/prompt.ts](../../../web/prompt.ts)) shows it.

## Codemode

Every conversation offers Pi's `codemode`, even without MCP servers. Scripts
can call ordinary tools; nested calls use the same safety policy as direct calls.
A script's `tools.read()` returns text for a text file or an image block for an
image; `image(await tools.read({ path }))` shows it to the next model request.
The Pi Durable patch preserves read's native result instead of flattening images
to text, and declares the same union in codemode's tool catalog.
Model calls remain disabled (`models: false`). MCP tools are reachable only
through scripts and stay deferred: connecting or removing a server updates
namespaces and the MCP section through appended system updates, not the initial
system prompt or tool list. Existing conversations gain codemode once (one
prompt-cache miss); later MCP configuration changes preserve the cached prefix.
Side conversations inherit codemode in that same prefix, but their read-only
guard refuses the script itself before execution.

## Refused requests and displayed rows

`refusals.ts` omits a refused or filter-blocked run from later model requests,
not from stored history or the view. Walking newest-first crosses tool rounds
until an earlier task's final assistant reply or the retained context's start.
It skips failed attempts, non-model/system entries and compaction markers,
walking the markers' retained ranges; system messages and summaries stay.
The in-flight request's cutoff is unchanged. If a crash lands after omission
commit but before refusal commit, replay restores the task's own omitted
entries with replace edits.

`durable_rows.ts` keeps queued summary writes live until their request boundary
applies them. Tool ages inspect only active task ids and refresh on cached pages.

## Compaction

When the context fills up, Durable summarizes older history. Recurse's
compaction extension supplies the summary instructions, retries a summary that
is too long, keeps a "Historical Context" section, reminds the agent as the
context fills, and adds a `compact` tool. If Recurse's summary fails, Durable's
own summarizer runs instead. One continuation note follows the newest
compaction, before queued input. The stored history is never deleted; agents read
it with `subagent.ts messages`.

## Side conversations

A side conversation is the operator's read-only aside beside a conversation.
It is its own agent record (`side_of` names the parent), so every conversation
route serves it, but it lives in the parent's Harness as a Pi Durable fork of
the parent's root conversation, made at the parent's newest entry with no
unanswered tool call.

The fork's first request reuses the parent's prompt cache. It keeps the
parent's tools, system prompt and history unchanged and only appends: its
agent adds the `recurse-side-conversation` extension, which the Harness default
selection leaves out, so Pi Durable writes one `pi.system` entry after the
history with the extension's `side_conversation` section (the read-only note)
and `toolsAdded: [return_to_main]`. Anthropic and OpenAI send that entry as a
mid-conversation system message and tool addition, leaving the request prefix
byte-identical. OpenAI also keys its cache by session, so the fork's requests go
out under the parent's provider session id (`shareParentSession`). Read-only is
enforced when a tool is called: `recurse-side-guard`, installed first in every
Harness and so selected by parents too, refuses in a side conversation every
tool but `read`, `grep`, `find` and `return_to_main`, directly or nested,
with an error the model sees. Its hook runs before every other extension's, so
a refused call reaches no safety review, MCP start or tool.

`return_to_main` sends the model's distilled instructions to the parent as an
ordinary agent message from the side conversation, named `Side conversation:

<title>`; the parent starts a turn if idle and receives it as a steer
otherwise. The tool and the note say to call it only when the operator asks to
return or send something to main, and safety review checks each call like a
`bash` command, with the message text as the proposed action. Forks made before this change keep their
stored read-only tool list and their own provider session, and have no
`return_to_main`. `follow.ts` keeps each
followed conversation's live row from only its own commits. The parent never
sees the fork's entries and gets no report; requests are captured under the
side conversation by its provider session id, and prompt sections and
safety review use the side conversation, found by Durable conversation id.
Every fork is followed before the parent Harness resumes, so resumed fork
work is shown and recovered. The tree shows no side
conversation as a child or in digests. Deleting a side conversation withdraws its
fork's queued input, stops its run and forgets the fork; a fork whose side
conversation is gone is dropped when the parent opens. Clearing or deleting
the parent drops every fork before its storage is retired and deletes its side
conversations; a side conversation cannot be cleared or moved.

Promoting an idle side conversation makes it its parent's child under the
same id (`promotion.ts`): a job marked `promoting` copies the fork into
staged storage (`copyFork`, refusing unless the next request is
JSON-identical), renames it into place, commits the record without
`side_of`, then drops the fork. The child keeps the side's tools and
`return_to_main`, so the cached prefix is unchanged; `PROMOTED_INSTRUCTIONS`
and the tree are appended as section updates.

## Platform notes

A platform note (for example, a shell finishing) may join an active run or start
an idle one. Joining does not change the report's line saying what started the run.

## Rules for changes

- Everything sent to a model stays inspectable through request capture.
- Prompt rendering takes supplied context and returns exact text; it does no
  I/O and looks up no owners. Provenance is rendered in one place.
- Model and prompt changes apply at request boundaries, never mid-turn; a
  platform note is never a configuration change.
- Platform notes are best effort: they never enter the retry path or block fresh
  input.
- Summary requests never replace the captured turn request. Persisted entry
  kinds (`recurse.usage`, `recurse.compaction`) keep their names across upgrades.
