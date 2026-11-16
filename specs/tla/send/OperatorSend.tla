---------------------------- MODULE OperatorSend ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

\* Bounded saved-agent composer protocol, not Pi/storage refinement.
\* Delivery means one committed model-context input, not exactly one provider
\* HTTP request: later requests legitimately repeat conversation history.
\* See README.md for correspondence, fairness and explicit-interrupt replay.
CONSTANT Bug
VARIABLE s
Messages == 1..2
Wire(m) == <<m, s.version[m]>>
Count(m) == Cardinality({i \in 1..Len(s.delivered) : s.delivered[i] = m})
First(m) == CHOOSE i \in 1..Len(s.order) : s.order[i] = m
Remove(q, m) == SelectSeq(q, LAMBDA x : x # m)

Init ==
  \E explicit \in [Messages -> BOOLEAN] :
  s = [explicit |-> explicit, client |-> [m \in Messages |-> "new"],
       reply |-> [m \in Messages |-> "none"],
       aimedBusy |-> [m \in Messages |-> FALSE],
       version |-> [m \in Messages |-> 0],
       seen |-> {}, accepted |-> {}, order |-> <<>>, queue |-> <<>>,
       delivered |-> <<>>, turn |-> "stream", reloaded |-> FALSE,
       restarted |-> FALSE, stopped |-> FALSE, retried |-> {},
       badReplayStop |-> FALSE]

\* Persist before clearing the composer. One unchanged recipient/owner.
Save(m) ==
  /\ s.client[m] = "new"
  /\ \A n \in Messages : n < m => s.client[n] # "new"
  /\ s' = [s EXCEPT !.client[m] = "saved"]

\* The browser lock admits only the oldest saved entry. Failed entries remain
\* visible and block later entries until explicitly removed (outside scope).
Attempt(m) ==
  /\ s.client[m] = "saved"
  /\ \A n \in Messages : n < m => s.client[n] = "done"
  /\ s' = [s EXCEPT !.client[m] = "flight", !.reply[m] = "none",
                   !.aimedBusy[m] = s.turn # "idle"]

\* Atomic persistent request lookup + inbox/context insertion. The HTTP
\* response's earlier `steer` snapshot is not an admission decision.
Admit(m) ==
  /\ s.client[m] = "flight" /\ s.reply[m] = "none"
  /\ LET known == Wire(m) \in s.seen
         stale == Bug = "stale-steer" /\ s.aimedBusy[m] /\ s.turn = "idle"
         explicitStop == s.explicit[m] /\ (~known \/ Bug = "interrupt-retry") /\
                         s.turn # "idle"
         replayStop == explicitStop /\ known
     IN s' = [s EXCEPT
       !.reply[m] = "ok", !.seen = @ \cup {Wire(m)},
       !.accepted = @ \cup {m},
       !.order = IF m \in s.accepted THEN @ ELSE Append(@, m),
       !.queue = IF known \/ stale THEN @ ELSE Append(@, m),
       !.turn = IF explicitStop THEN "idle" ELSE @,
       !.badReplayStop = @ \/ replayStop]

\* Permanent refusal occurs before admission, and remains visible on reload.
Reject(m) ==
  /\ s.client[m] = "flight" /\ s.reply[m] = "none"
  /\ m \notin s.accepted
  /\ s' = [s EXCEPT !.reply[m] = "failed"]
Respond(m) ==
  /\ s.client[m] = "flight" /\ s.reply[m] # "none"
  /\ s' = [s EXCEPT !.client[m] = IF s.reply[m] = "ok" THEN "done" ELSE "failed",
                   !.reply[m] = "none"]

\* One ambiguous timeout, before or after commit; retry retains the wire id.
Retry(m) ==
  /\ s.client[m] = "flight" /\ m \notin s.retried
  /\ s' = [s EXCEPT !.client[m] = "saved", !.reply[m] = "none",
                   !.retried = @ \cup {m}]

\* Reload loses memory/response, not the saved outbox or server request ledger.
Reload ==
  /\ ~s.reloaded
  /\ s' = [s EXCEPT !.reloaded = TRUE,
       !.client = [m \in Messages |-> IF s.client[m] = "flight" THEN "saved"
                                    ELSE s.client[m]],
       !.reply = [m \in Messages |-> "none"],
       !.version = [m \in Messages |->
         IF Bug = "reload-id" /\ s.client[m] = "flight" THEN 1 ELSE s.version[m]]]

\* Interrupting the provider stream preserves the durable steer; tool work
\* continues. The next tools/final boundary drains all operator steers in order.
CutStream ==
  /\ s.turn = "stream" /\ Len(s.queue) > 0
  /\ s' = [s EXCEPT !.turn = "tools"]
Boundary ==
  /\ s.turn = "tools" /\ Len(s.queue) > 0
  /\ s' = [s EXCEPT !.delivered = @ \o s.queue, !.queue = <<>>,
                   !.turn = "stream"]
Complete ==
  /\ s.turn # "idle"
  /\ s' = [s EXCEPT !.turn = "idle"]

\* Stop aborts only the run task. A committed input stays in model context;
\* queued input is retained for idle promotion, including across restart.
Stop ==
  /\ ~s.stopped /\ s.turn # "idle"
  /\ s' = [s EXCEPT !.stopped = TRUE, !.turn = "idle",
                   !.queue = IF Bug = "stop-drop" THEN <<>> ELSE @]
Restart ==
  /\ ~s.restarted
  /\ s' = [s EXCEPT !.restarted = TRUE, !.turn = "idle",
                   !.queue = IF Bug = "restart-drop" THEN <<>> ELSE @,
                   !.seen = IF Bug = "restart-ledger" THEN {} ELSE @]

\* Recurse follow.ts promotes the oldest input at idle; a new admission joins
\* behind old queued inputs, rather than bypassing them with an idle fast path.
Promote ==
  /\ s.turn = "idle" /\ Len(s.queue) > 0
  /\ LET m == IF Bug = "reverse" THEN s.queue[Len(s.queue)] ELSE Head(s.queue)
     IN s' = [s EXCEPT !.delivered = Append(@, m),
                      !.queue = Remove(@, m), !.turn = "stream"]

Next ==
  \/ \E m \in Messages : Save(m) \/ Attempt(m) \/ Admit(m) \/ Reject(m) \/
                         Respond(m) \/ Retry(m)
  \/ Reload \/ CutStream \/ Boundary \/ Complete \/ Stop \/ Restart \/ Promote

Spec == Init /\ [][Next]_s /\ WF_s(Promote) /\ WF_s(Complete) /\
  (\A m \in Messages : WF_s(Attempt(m)) /\ WF_s(Admit(m)) /\ WF_s(Respond(m)))

TypeOK ==
  /\ s.explicit \in [Messages -> BOOLEAN]
  /\ s.client \in [Messages -> {"new", "saved", "flight", "done", "failed"}]
  /\ s.reply \in [Messages -> {"none", "ok", "failed"}]
  /\ s.aimedBusy \in [Messages -> BOOLEAN]
  /\ s.version \in [Messages -> 0..1]
  /\ s.seen \subseteq Messages \X (0..1)
  /\ s.accepted \subseteq Messages /\ s.retried \subseteq Messages
  /\ s.order \in Seq(Messages) /\ Len(s.order) <= 2
  /\ s.queue \in Seq(Messages) /\ Len(s.queue) <= 4
  /\ s.delivered \in Seq(Messages) /\ Len(s.delivered) <= 4
  /\ s.turn \in {"idle", "stream", "tools"}
  /\ \A k \in {"reloaded", "restarted", "stopped", "badReplayStop"} : s[k] \in BOOLEAN
SingleDelivery == \A m \in Messages : Count(m) <= 1
MessageAccounted ==
  \A m \in s.accepted : Count(m) > 0 \/ m \in {s.queue[i] : i \in 1..Len(s.queue)}
AdmissionOrder ==
  \A i, j \in 1..Len(s.delivered) :
    i < j => First(s.delivered[i]) <= First(s.delivered[j])
RetryKeepsRun == ~s.badReplayStop
AcceptedEventuallyDelivered ==
  \A m \in Messages : (m \in s.accepted) ~> (Count(m) = 1)
=============================================================================
