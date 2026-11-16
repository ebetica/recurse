---------------------------- MODULE RemoteRelay ----------------------------
EXTENDS Naturals, FiniteSets

\* Bounded protocol, not implementation refinement. See README.md for the
\* retained-write, availability, deadline and receiver-ledger assumptions.
CONSTANT Bug
VARIABLE s

Peers == {"home", "remote"}
Messages == {"outbound", "return"}
Producer(m) == IF m = "outbound" THEN "home" ELSE "remote"
Receiver(m) == IF m = "outbound" THEN "remote" ELSE "home"
Idle == s.idle
Available == (\A p \in Peers : s.phase[p] = "awake") /\ ~s.revoked
WireId(m) == <<m, IF Bug = "unstable-id" /\ m \in s.retried THEN 1 ELSE 0>>

Init ==
  s = [phase |-> [p \in Peers |-> "awake"], stopped |-> {},
       work |-> [m \in Messages |-> "new"], seen |-> {},
       delivered |-> [m \in Messages |-> 0], retried |-> {}, expired |-> {},
       idle |-> TRUE, paused |-> FALSE, revoked |-> FALSE, dirty |-> FALSE,
       revocations |-> 0, readded |-> FALSE, explicit |-> "none", issued |-> 0,
       badAuto |-> FALSE, badPause |-> FALSE, badWake |-> FALSE,
       badResume |-> FALSE]

Submit(m) ==
  /\ s.work[m] = "new" /\ s.phase[Producer(m)] = "awake"
  /\ (m = "return" \/ ~s.revoked)
  /\ s' = [s EXCEPT !.work[m] = "queued"]

\* A stopped producer retains acknowledged durable return-queue entries.
\* Home cannot restart across an unfinished in-memory outbound submission.
Stop(p) ==
  /\ s.phase[p] = "awake" /\ p \notin s.stopped
  /\ (IF p = "remote" THEN Idle
      ELSE ~s.dirty /\ s.work["outbound"] \in {"new", "done", "failed"})
  /\ s' = [s EXCEPT !.phase[p] = "sleeping", !.stopped = @ \cup {p},
                   !.paused = IF p = "home" THEN FALSE ELSE @,
                   !.explicit = IF p = "home" THEN "none" ELSE @]
Wake(p) ==
  /\ s.phase[p] = "sleeping"
  /\ s' = [s EXCEPT !.phase[p] = "starting"]
Ready(p) ==
  /\ s.phase[p] = "starting"
  /\ s' = [s EXCEPT !.phase[p] = "awake"]
Activity ==
  /\ s.phase["remote"] = "awake"
  /\ s' = [s EXCEPT !.idle = ~@]
Flush == /\ s.dirty /\ s' = [s EXCEPT !.dirty = FALSE]

\* The startup control collapses recheck plus a second terminal refusal.
Direct ==
  /\ s.work["outbound"] = "queued"
  /\ s.phase["home"] = "awake" /\ ~s.revoked
  /\ LET base == [s EXCEPT !.badAuto = @ \/ s.revoked] IN
       s' = CASE s.phase["remote"] = "sleeping" ->
                   [base EXCEPT !.phase["remote"] = "starting", !.paused = FALSE]
             [] s.phase["remote"] = "starting" /\ Bug = "startup-drop" ->
                   [base EXCEPT !.work["outbound"] = "failed"]
             [] s.phase["remote"] = "awake" ->
                   [base EXCEPT !.work["outbound"] = "inflight", !.paused = FALSE]
             [] OTHER -> base

\* Ordinary polls use the persisted check-in before touching a sleeping web
\* server. An authenticated callback deliberately permits one immediate poll.
Poll(push) ==
  /\ s.phase["home"] = "awake" /\ (push \/ ~s.paused)
  /\ (~s.revoked \/ Bug = "revoked-poll")
  /\ LET base == [s EXCEPT !.badAuto = @ \/ s.revoked] IN
       s' = CASE s.phase["remote"] = "sleeping" ->
                   IF push \/ Bug = "poll-wake"
                   THEN [base EXCEPT !.phase["remote"] = "starting",
                                     !.badWake = @ \/ ~push]
                   ELSE [base EXCEPT !.paused = TRUE]
             [] s.phase["remote"] = "awake" /\ s.work["return"] = "queued" ->
                   [base EXCEPT !.work["return"] = "inflight", !.paused = FALSE]
             [] s.phase["remote"] = "awake" /\ (Idle \/ Bug = "idle-pause") ->
                   [base EXCEPT !.paused = TRUE, !.badPause = @ \/ ~Idle]
             [] OTHER -> base

\* Background health probes share the revocation gate. Unlike ordinary
\* check-in polls they may wake a web server whose sleep has not been observed.
AutoProbe ==
  /\ s.phase["home"] = "awake" /\ ~s.paused
  /\ (~s.revoked \/ Bug = "revoked-poll")
  /\ s' = [s EXCEPT !.badAuto = @ \/ s.revoked,
                   !.phase["remote"] = IF @ = "sleeping" THEN "starting" ELSE @]

\* Timer/check-in or an explicit wake observes that the peer is available.
CheckWake ==
  /\ s.paused /\ Available
  /\ s' = [s EXCEPT !.paused = FALSE]

\* Atomic persistent receiver deduplication is an explicit abstraction boundary.
Accept(m) ==
  /\ s.work[m] = "inflight" /\ s.phase[Receiver(m)] = "awake"
  /\ s' = [s EXCEPT !.seen = @ \cup {WireId(m)},
                   !.delivered[m] = IF WireId(m) \in s.seen THEN @ ELSE @ + 1]
Ack(m) ==
  /\ s.work[m] = "inflight" /\ s.delivered[m] > 0 /\ Available
  /\ s' = [s EXCEPT !.work[m] = "done"]
\* One lost response/expired claim, before or after acceptance, per message.
Retry(m) ==
  /\ s.work[m] = "inflight" /\ m \notin s.retried
  /\ s' = [s EXCEPT !.work[m] = "queued", !.retried = @ \cup {m}]
Expire ==
  /\ s.work["outbound"] = "queued"
  /\ s' = [s EXCEPT !.work["outbound"] = "failed",
                   !.expired = @ \cup {"outbound"}]

\* A 401 may complete after another request has already recorded revocation.
Revoke ==
  /\ s.phase["home"] = "awake" /\ s.revocations < 2
  /\ s' = [s EXCEPT !.revoked = TRUE, !.revocations = @ + 1, !.dirty = TRUE]
ExplicitStart ==
  /\ s.phase["home"] = "awake" /\ s.explicit = "none"
  /\ s' = [s EXCEPT !.explicit = "sent", !.issued = s.revocations,
                   !.phase["remote"] = IF @ = "sleeping" THEN "starting" ELSE @]
ExplicitSuccess ==
  /\ s.explicit = "sent" /\ s.phase["remote"] = "awake"
  /\ s' = [s EXCEPT !.explicit = "success"]
\* Queue admission and credential-save commit are separate from response.
Resume ==
  /\ s.explicit = "success"
  /\ LET allowed == s.issued = s.revocations \/ Bug = "stale-success" IN
       s' = [s EXCEPT !.explicit = "none",
                        !.revoked = IF allowed THEN FALSE ELSE @,
                        !.dirty = @ \/ (s.revoked /\ allowed),
                        !.badResume = @ \/ (s.revoked /\ allowed /\
                                              s.issued # s.revocations)]
\* Re-add retires the old record and may invalidate its queued return route.
\* An outbound send crossing a credential replacement is outside this model.
SignIn ==
  /\ s.revoked /\ ~s.readded /\ s.phase["home"] = "awake"
  /\ s.work["outbound"] \in {"new", "done", "failed"}
  /\ s' = [s EXCEPT !.revoked = FALSE, !.readded = TRUE,
                   !.explicit = "none", !.dirty = TRUE,
                   !.expired = IF s.work["return"] \in {"queued", "inflight"}
                               THEN @ \cup {"return"} ELSE @,
                   !.work["return"] = IF @ \in {"queued", "inflight"}
                                      THEN "failed" ELSE @]

Next ==
  \/ \E m \in Messages : Submit(m) \/ Accept(m) \/ Ack(m) \/ Retry(m)
  \/ \E p \in Peers : Stop(p) \/ Wake(p) \/ Ready(p)
  \/ Activity \/ Flush \/ Direct \/ Poll(FALSE) \/ Poll(TRUE) \/ AutoProbe \/ CheckWake
  \/ Expire \/ Revoke \/ ExplicitStart \/ ExplicitSuccess \/ Resume \/ SignIn

Spec == Init /\ [][Next]_s /\ WF_s(Direct) /\ WF_s(Poll(FALSE)) /\
        WF_s(CheckWake) /\ (\A m \in Messages : WF_s(Accept(m)) /\ WF_s(Ack(m)))

TypeOK ==
  /\ s.phase \in [Peers -> {"awake", "sleeping", "starting"}]
  /\ s.stopped \subseteq Peers
  /\ s.work \in [Messages -> {"new", "queued", "inflight", "done", "failed"}]
  /\ s.seen \subseteq Messages \X (0..1)
  /\ s.delivered \in [Messages -> 0..2]
  /\ s.retried \subseteq Messages /\ s.expired \subseteq Messages
  /\ s.revocations \in 0..2 /\ s.issued \in 0..2
  /\ s.explicit \in {"none", "sent", "success"}
  /\ \A name \in {"idle", "paused", "revoked", "dirty", "readded",
                  "badAuto", "badPause", "badWake", "badResume"} : s[name] \in BOOLEAN
SingleDelivery == \A m \in Messages : s.delivered[m] <= 1
NoPrematureLoss == \A m \in Messages : s.work[m] = "failed" => m \in s.expired
PauseOnlyIdle == ~s.badPause
NoPollingWake == ~s.badWake
NoAutomaticWhileRevoked == ~s.badAuto
RevocationOwnership == ~s.badResume

\* No unconditional eventual-delivery claim: authentication/availability must
\* stabilize without a send deadline expiring or a queued route being retired.
DeliveryAfterWake ==
  \A m \in Messages :
    ((<>[]Available) /\ [](m \notin s.expired)) =>
      ((s.work[m] # "new") ~> (s.delivered[m] > 0))
=============================================================================
