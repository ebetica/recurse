--------------------------- MODULE ShellHandoff ---------------------------
EXTENDS Naturals, Sequences, TLC

CONSTANTS ReadPinBug, FlushBug, CompletionHandoffBug

(***************************************************************************
 One detached shell, its tool/watch/task, one monitor read and up to two nested
 output reads. The launch memo is durable before spawn. Store writes/removals
 are successful atomic FIFO mutations; failures and process identity are not
 modeled. A task's restart notice may replace an uncheckpointed exit payload.
***************************************************************************)
VARIABLE s
vars == <<s>>
Pins == s.readers + (IF s.toolPin THEN 1 ELSE 0)
        + (IF s.finalPin THEN 1 ELSE 0)

Init ==
  s = [live |-> TRUE, tracked |-> TRUE, log |-> TRUE,
       owner |-> "tool", task |-> FALSE, crashed |-> FALSE,
       toolPin |-> TRUE, finalPin |-> FALSE, readers |-> 0,
       monitor |-> FALSE, phase |-> "running", completion |-> FALSE,
       watchExit |-> FALSE, checkpoint |-> "watch", posted |-> FALSE,
       disk |-> "none", queue |-> <<"live">>, flushed |-> FALSE,
       unsettledHandoff |-> FALSE]

(***************************************************************************
 RegistryStore serializes atomic writes and removals. This bounded queue has
 one initial ownership snapshot, one terminal snapshot and one removal; it
 omits redundant heartbeats/coalesced snapshots, not their ordering barrier.
***************************************************************************)
StoreStep ==
  /\ ~s.crashed
  /\ Len(s.queue) > 0
  /\ s' = [s EXCEPT !.disk = Head(s.queue), !.queue = Tail(s.queue)]

FlushHandoff ==
  /\ ~s.crashed /\ s.owner = "tool" /\ Len(s.queue) = 0
  /\ s' = [s EXCEPT !.flushed = TRUE]

Handoff ==
  /\ ~s.crashed /\ s.owner = "tool"
  /\ s.flushed \/ FlushBug
  /\ s' = [s EXCEPT !.owner = "task", !.task = TRUE, !.toolPin = FALSE,
        !.unsettledHandoff = ~s.flushed /\ Len(s.queue) > 0]

BeginRead ==
  /\ ~s.crashed /\ s.tracked /\ s.log /\ s.readers < 2
  /\ s' = [s EXCEPT !.readers = @ + 1]

EndRead ==
  /\ ~s.crashed /\ s.readers > 0
  /\ s' = [s EXCEPT !.readers = @ - 1]

BeginMonitor ==
  /\ ~s.crashed /\ s.live /\ ~s.monitor
  /\ s' = [s EXCEPT !.monitor = TRUE]

EndMonitor ==
  /\ ~s.crashed /\ s.monitor
  /\ s' = [s EXCEPT !.monitor = FALSE]

(***************************************************************************
 finishExit marks completed and retains output synchronously, before awaiting
 the in-flight monitor flush or formatting output. Leader exit alone is not
 Exit: every non-zombie group member must be proven absent first.
***************************************************************************)
Exit ==
  /\ ~s.crashed /\ s.live
  /\ s' = [s EXCEPT !.live = FALSE, !.finalPin = TRUE, !.phase = "format"]

Format ==
  /\ ~s.crashed /\ s.phase = "format" /\ ~s.monitor
  /\ s' = [s EXCEPT !.completion = TRUE, !.phase = "queued",
        !.queue = Append(@, "notice")]

Notify ==
  /\ ~s.crashed /\ s.phase = "queued"
  /\ Len(s.queue) = 0 /\ s.disk = "notice"
  /\ s' = [s EXCEPT !.phase = "notified", !.finalPin = FALSE,
        !.watchExit = ~CompletionHandoffBug]

(***************************************************************************
 The Durable notifier schedules store acknowledgement immediately, not after
 submission. Watch.exit first takes responsibility; the task checkpoints its
 notify payload before idempotent post. This is not a persist-until-post model.
***************************************************************************)
RequestAck ==
  /\ ~s.crashed /\ s.phase = "notified"
  /\ s' = [s EXCEPT !.phase = "acking", !.queue = Append(@, "none")]

FinishAck ==
  /\ ~s.crashed /\ s.phase = "acking" /\ Len(s.queue) = 0
  /\ s' = [s EXCEPT !.phase = "acked", !.completion = FALSE]

Checkpoint ==
  /\ ~s.crashed /\ s.task /\ s.watchExit /\ s.checkpoint = "watch"
  /\ s' = [s EXCEPT !.checkpoint = "notify"]

Post ==
  /\ s.task /\ s.checkpoint = "notify"
  /\ s' = [s EXCEPT !.posted = TRUE]

FinishTask ==
  /\ s.task /\ s.posted /\ s.checkpoint = "notify"
  /\ s' = [s EXCEPT !.task = FALSE, !.owner = "done",
        !.watchExit = FALSE, !.checkpoint = "done"]

Evict ==
  /\ ~s.crashed /\ s.tracked /\ ~s.live /\ ~s.completion
  /\ Pins = 0 \/ ReadPinBug
  /\ s' = [s EXCEPT !.tracked = FALSE, !.log = FALSE,
        !.queue = Append(@, "none")]

(***************************************************************************
 Crash abandons volatile reads, registry/watch state and uncommitted writes.
 The memoized launch (before task creation) or durable task retains ownership.
 Recovery removes records only after group cleanup is proven. A resumed watch
 without its in-memory entry posts a restart/lost notice, not the exact exit.
***************************************************************************)
Crash ==
  /\ ~s.crashed
  /\ s' = [s EXCEPT !.crashed = TRUE, !.tracked = FALSE,
        !.toolPin = FALSE, !.finalPin = FALSE, !.readers = 0,
        !.monitor = FALSE, !.watchExit = FALSE, !.queue = <<>>,
        !.owner = IF s.owner = "done" THEN "done" ELSE "recovery"]

RecoverStop ==
  /\ s.crashed /\ s.owner = "recovery"
  /\ s' = [s EXCEPT !.live = FALSE, !.disk = "none",
        !.completion = FALSE,
        !.checkpoint = IF s.task THEN "notify" ELSE "done",
        !.owner = IF s.task THEN "recovery" ELSE "done"]

Next == StoreStep \/ FlushHandoff \/ Handoff \/ BeginRead \/ EndRead
        \/ BeginMonitor \/ EndMonitor \/ Exit \/ Format \/ Notify
        \/ RequestAck \/ FinishAck \/ Checkpoint \/ Post \/ FinishTask
        \/ Evict \/ Crash \/ RecoverStop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ {s.live, s.tracked, s.log, s.task, s.crashed, s.toolPin, s.finalPin,
       s.monitor, s.completion, s.watchExit, s.posted,
       s.flushed, s.unsettledHandoff} \subseteq BOOLEAN
  /\ s.owner \in {"tool", "task", "recovery", "done"}
  /\ s.phase \in {"running", "format", "queued", "notified", "acking", "acked"}
  /\ s.checkpoint \in {"watch", "notify", "done"}
  /\ s.readers \in 0..2
  /\ s.disk \in {"none", "live", "notice"}
  /\ s.queue \in Seq({"none", "live", "notice"})

OutputRetained == ~s.crashed /\ (Pins > 0 \/ s.monitor) => s.log
LiveTracked == ~s.crashed /\ s.live => s.tracked /\ s.log
HandoffSettled == ~s.unsettledHandoff
CompletionResponsibility ==
  ~s.crashed /\ s.phase \in {"notified", "acking", "acked"} =>
    s.watchExit \/ s.checkpoint \in {"notify", "done"}
TaskOwnsGroup == s.live => s.owner \in {"tool", "task", "recovery"}
=============================================================================
