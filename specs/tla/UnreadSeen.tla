----------------------------- MODULE UnreadSeen -----------------------------
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Devices, MaxOpens, MaxRuns, Bug

(***************************************************************************
 One top-level conversation's finished-but-unviewed dot. A device views it
 while it is selected, visible and not behind the phone list; each view
 opens an events stream with viewing=true (web/conversation/poll.ts). The
 server registers the stream as a viewer and acknowledges the latest finish
 on every stream read (src/web/conversation_events.ts, markViewed). A
 qualifying finish records unread = no viewer (src/agents/instance.ts).
 Unread changes push a tree notice; the notice discards any tree read in
 flight and starts a new one (web/backends/tree.ts).

 `owed` is the intended answer: the latest finish had no accepted, still
 open view, and no view was accepted since. Assumed: a closed stream's
 teardown reaches the server before the next finish is judged (milliseconds
 against a run), and every request is served after it is sent.

 Bug "none" checks the design; each control must fail its invariant:
 DotMatches: drain (teardown may lag the next finish: Chromium keeps an
 aborted HTTP/1.1 stream open up to 5 s to drain it unless the response
 says Connection: close), aborted-ack (a request aborted before it is served
 still acknowledges).
 ShownCurrent: unfenced (a notice reuses a tree read already in flight).
***************************************************************************)

VARIABLES ui, streams, run, runs, finished, unread, owed, rev, notice, read,
  shown

vars == <<ui, streams, run, runs, finished, unread, owed, rev, notice, read,
  shown>>

Ids == 1..Len(streams)
Live(i) == streams[i].c = "open" /\ streams[i].s = "reg"
Stale(i) == streams[i].c = "closed" /\ streams[i].s = "reg"

Init ==
  /\ ui = [d \in Devices |-> "away"]
  /\ streams = <<>>
  /\ run = "idle" /\ runs = 0
  /\ finished = FALSE /\ unread = FALSE /\ owed = FALSE
  /\ rev = 0
  /\ notice = [d \in Devices |-> FALSE]
  /\ read = [d \in Devices |-> "none"]
  /\ shown = [d \in Devices |-> FALSE]

\* Every unread change pushes a notice to each device's tree stream.
SetUnread(v) ==
  IF v = unread
  THEN UNCHANGED <<unread, rev, notice>>
  ELSE /\ unread' = v /\ rev' = rev + 1
       /\ notice' = [d \in Devices |-> TRUE]

Acknowledge == IF finished THEN SetUnread(FALSE)
               ELSE UNCHANGED <<unread, rev, notice>>

Open(d) ==
  /\ ui[d] = "away" /\ Len(streams) < MaxOpens
  /\ ui' = [ui EXCEPT ![d] = "viewing"]
  /\ streams' = Append(streams, [d |-> d, c |-> "open", s |-> "sent"])
  /\ UNCHANGED <<run, runs, finished, unread, owed, rev, notice, read, shown>>

\* Switching away, hiding the tab or showing the phone list closes streams.
Leave(d) ==
  /\ ui[d] = "viewing"
  /\ ui' = [ui EXCEPT ![d] = "away"]
  /\ streams' = [i \in Ids |->
       IF streams[i].d = d THEN [streams[i] EXCEPT !.c = "closed"]
       ELSE streams[i]]
  /\ UNCHANGED <<run, runs, finished, unread, owed, rev, notice, read, shown>>

\* addViewer, then the initial read; an aborted request stops before it.
Serve(i) ==
  /\ streams[i].s = "sent"
  /\ IF streams[i].c = "open"
     THEN /\ streams' = [streams EXCEPT ![i].s = "reg"]
          /\ owed' = FALSE
          /\ Acknowledge
     ELSE /\ streams' = [streams EXCEPT ![i].s = "done"]
          /\ UNCHANGED owed
          /\ IF Bug = "aborted-ack" THEN Acknowledge
             ELSE UNCHANGED <<unread, rev, notice>>
  /\ UNCHANGED <<ui, run, runs, finished, read, shown>>

\* A later read on a registered stream, woken by the finish or its rows.
StreamRead(i) ==
  /\ streams[i].s = "reg"
  /\ Acknowledge
  /\ UNCHANGED <<ui, streams, run, runs, finished, owed, read, shown>>

Teardown(i) ==
  /\ Stale(i)
  /\ streams' = [streams EXCEPT ![i].s = "done"]
  /\ UNCHANGED <<ui, run, runs, finished, unread, owed, rev, notice, read,
                 shown>>

Start ==
  /\ run = "idle" /\ runs < MaxRuns
  /\ run' = "running"
  /\ UNCHANGED <<ui, streams, runs, finished, unread, owed, rev, notice,
                 read, shown>>

Finish ==
  /\ run = "running"
  /\ Bug = "drain" \/ \A i \in Ids : ~Stale(i)
  /\ run' = "idle" /\ runs' = runs + 1 /\ finished' = TRUE
  /\ owed' = ~\E i \in Ids : Live(i)
  /\ SetUnread(~\E i \in Ids : streams[i].s = "reg")
  /\ UNCHANGED <<ui, streams, read, shown>>

\* A notice starts a fresh tree read; the read in flight is discarded.
Notice(d) ==
  /\ notice[d]
  /\ notice' = [notice EXCEPT ![d] = FALSE]
  /\ read' = IF Bug = "unfenced" /\ read[d] /= "none" THEN read
             ELSE [read EXCEPT ![d] = "sent"]
  /\ UNCHANGED <<ui, streams, run, runs, finished, unread, owed, rev, shown>>

Poll(d) ==
  /\ read[d] = "none"
  /\ read' = [read EXCEPT ![d] = "sent"]
  /\ UNCHANGED <<ui, streams, run, runs, finished, unread, owed, rev, notice,
                 shown>>

TreeServe(d) ==
  /\ read[d] = "sent"
  /\ read' = [read EXCEPT ![d] = IF unread THEN "dot" ELSE "clear"]
  /\ UNCHANGED <<ui, streams, run, runs, finished, unread, owed, rev, notice,
                 shown>>

TreeApply(d) ==
  /\ read[d] \in {"dot", "clear"}
  /\ shown' = [shown EXCEPT ![d] = (read[d] = "dot")]
  /\ read' = [read EXCEPT ![d] = "none"]
  /\ UNCHANGED <<ui, streams, run, runs, finished, unread, owed, rev, notice>>

Next ==
  \/ Start \/ Finish
  \/ \E d \in Devices :
       Open(d) \/ Leave(d) \/ Notice(d) \/ Poll(d) \/ TreeServe(d)
       \/ TreeApply(d)
  \/ \E i \in Ids : Serve(i) \/ StreamRead(i) \/ Teardown(i)

Spec == Init /\ [][Next]_vars

\* Nothing in flight: streams served and torn down, notices and reads done.
Settled ==
  /\ \A i \in Ids : streams[i].s /= "sent" /\ ~Stale(i)
  /\ \A d \in Devices : ~notice[d] /\ read[d] = "none"

DotMatches == Settled => unread = owed
ShownCurrent == Settled => \A d \in Devices : shown[d] = unread
=============================================================================
