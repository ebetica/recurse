-------------------------- MODULE IdleCompaction --------------------------
EXTENDS Integers, FiniteSets
CONSTANT Bug

(***************************************************************************
 Bounded policy model for extra/cache-warm/cache-warm.ts: reconcile, schedule,
 timer dispatch and the adapter's allowed() recheck on compaction admission.
 At most one responded, current capture; two cache windows; one environment
 change (settings, context size, own work or background work), or invalidation.
 Own work distinguishes a running turn from queued input; background denotes
 shells OR working descendants. Tokens 0/1/2 mean below/at/above the minimum.
 Both switches vary independently. A successful replay renews the window.

 Relative time: due=2, dispatch/admission deadline=3, cache expiry=4. Ordinary
 ticks assume timer dispatch and admission get CPU by the deadline, not that
 production guarantees wall-clock scheduling. A clock jump may miss it; that
 path owes no before-expiry progress and must admit no late compaction.
 BeforeExpiry/WaitingWarms require unchanged eligibility from due to expiry.
 Retired captures cannot revive; lostCompact/lostWarm record erroneous early
 retirement independently, so cancellation cannot erase a progress obligation.
 Successful warm replay is atomic here; failed/aborted/in-flight provider I/O,
 savings, unsupported TTLs, one-hour horizon, task execution and Pi's immutable
 prefix/ordered summary write are excluded. No eventual summary guarantee.
 NoDoubleExpiry concerns successful replays, not failed replay attempts.

 Bug "waiting" restores the pre-#3292 whole-tree compaction gate with warming
 off. Other controls remove one guard or the successful-replay renewal.
 The tree control removes the shared background-busy guard at reconciliation
 and admission, not just its final call after reconciliation already retired it.
***************************************************************************)
VARIABLE s
vars == <<s>>
Own == {"running", "queued", "quiet"}
Modes == {"none", "warm", "compact"}
Busy(r) == r.own # "quiet" \/ r.background
CompactBusy(r) == r.own # "quiet" \/ (r.warm /\ r.background)
ExpectedCompact(r) == r.live /\ r.compact /\ r.tokens >= 1 /\ ~CompactBusy(r)
ExpectedWarm(r) == r.live /\ r.warm /\ Busy(r)
Allowed(r) ==
  /\ r.live
  /\ (r.compact \/ Bug = "compact-switch")
  /\ (r.tokens >= 1 \/ Bug = "minimum")
  /\ (Bug # "strict-min" \/ r.tokens > 1)
  /\ (r.own # "running" \/ Bug = "turn")
  /\ (r.own # "queued" \/ Bug = "queue")
  /\ (~(r.warm /\ r.background) \/ Bug = "tree")
  /\ (Bug # "waiting" \/ ~r.background)
  /\ (Bug # "coupled" \/ r.warm)
  /\ (r.age <= 3 \/ Bug = "deadline")
Mode(r) ==
  IF ~r.live THEN "none"
  ELSE IF Busy(r) /\ (r.warm \/ Bug = "warm-switch") /\ Bug # "no-warm"
       THEN "warm"
  ELSE IF Allowed(r) THEN "compact" ELSE "none"
Reconcile(r) ==
  LET mode == Mode(r)
      stopCompact == r.mode = "compact" /\ CompactBusy(r)
                     /\ ~(Bug = "tree" /\ r.own = "quiet")
      retire == ~r.live \/ stopCompact
                \/ (mode = "none" /\ (~Busy(r) \/ ~r.compact))
      cancel == ~r.live \/ (retire /\ Bug # "cancel")
  IN [r EXCEPT !.live = IF cancel THEN FALSE ELSE @,
               !.mode = IF cancel THEN "none" ELSE mode,
               !.retired = @ \/ retire,
               !.lostCompact = @ \/ (cancel /\ ExpectedCompact(r) /\ r.age <= 3),
               !.lostWarm = @ \/ (cancel /\ ExpectedWarm(r) /\ ~stopCompact
                                        /\ r.age <= 3)]

Init ==
  \E warm, compact, background \in BOOLEAN, own \in Own, tokens \in 0..2:
    s = [warm |-> warm, compact |-> compact, background |-> background,
         own |-> own, tokens |-> tokens, live |-> warm \/ compact, age |-> 0,
         epoch |-> 0, mode |-> "none", phase |-> "reconcile", changed |-> FALSE,
         owed |-> FALSE, warmOwed |-> FALSE, jumped |-> FALSE,
         retired |-> ~(warm \/ compact), lostCompact |-> FALSE, lostWarm |-> FALSE,
         warmed |-> {}, compacted |-> {},
         badMinimum |-> FALSE, badTurn |-> FALSE, badQueue |-> FALSE,
         badTree |-> FALSE, badSwitch |-> FALSE, badDeadline |-> FALSE,
         badInvalid |-> FALSE]

Plan ==
  /\ s.phase = "reconcile"
  /\ s' = [Reconcile(s) EXCEPT !.phase = "timer"]

Change ==
  /\ ~s.changed /\ s.phase \in {"timer", "admission"}
  /\ \E warm, compact, background \in BOOLEAN, own \in Own, tokens \in 0..2:
       LET r == [s EXCEPT !.warm = warm, !.compact = compact,
                         !.background = background, !.own = own,
                         !.tokens = tokens, !.changed = TRUE,
                         !.owed = FALSE, !.warmOwed = FALSE]
       IN s' = Reconcile(r)

Invalidate ==
  /\ ~s.changed /\ s.phase \in {"timer", "admission"}
  /\ s' = [s EXCEPT !.live = FALSE, !.retired = TRUE, !.changed = TRUE,
                    !.mode = "none", !.owed = FALSE, !.warmOwed = FALSE]

Tick ==
  /\ s.phase \in {"timer", "admission"} /\ s.age < 4
  /\ ~(s.age = 3 /\ (s.phase = "admission" \/ s.mode # "none"))
  /\ s' = [s EXCEPT !.age = @ + 1,
                    !.owed = IF s.age = 1 THEN ExpectedCompact(s) ELSE @,
                    !.warmOwed = IF s.age = 1 THEN ExpectedWarm(s) ELSE @]

Jump ==
  /\ ~s.changed /\ s.phase \in {"timer", "admission"} /\ s.age < 4
  /\ s' = [s EXCEPT !.age = 4, !.changed = TRUE, !.jumped = TRUE,
                    !.owed = FALSE, !.warmOwed = FALSE]

DispatchCompact ==
  /\ s.phase = "timer" /\ s.mode = "compact" /\ s.age >= 2
  /\ s' = IF Allowed(s)
          THEN [s EXCEPT !.phase = "admission"]
          ELSE [s EXCEPT !.phase = "done", !.mode = "none"]

Admit ==
  /\ s.phase = "admission"
  /\ LET allow == Allowed(s) \/ Bug = "recheck"
     IN s' = [s EXCEPT !.phase = "done",
                       !.compacted = IF allow THEN @ \cup {s.epoch} ELSE @,
                       !.badMinimum = allow /\ s.tokens < 1,
                       !.badTurn = allow /\ s.own = "running",
                       !.badQueue = allow /\ s.own = "queued",
                       !.badTree = allow /\ s.warm /\ s.background,
                       !.badSwitch = allow /\ ~s.compact,
                       !.badDeadline = allow /\ s.age > 3,
                       !.badInvalid = allow /\ ~s.live]

Replay ==
  /\ s.phase = "timer" /\ s.mode = "warm" /\ s.age >= 2
  /\ LET allow == s.live /\ (s.warm \/ Bug = "warm-switch")
                    /\ Busy(s) /\ s.age <= 3
         renewed == allow /\ s.epoch = 0 /\ Bug # "renewal"
     IN s' = [s EXCEPT !.warmed = IF allow THEN @ \cup {s.epoch} ELSE @,
                       !.badSwitch = @ \/ (allow /\ ~s.warm),
                       !.epoch = IF renewed THEN 1 ELSE @,
                       !.age = IF renewed THEN 0 ELSE @,
                       !.owed = FALSE, !.warmOwed = FALSE,
                       !.phase = IF allow /\ s.epoch = 0
                                 THEN "reconcile" ELSE "done",
                       !.mode = "none"]

FinishTick ==
  /\ s.phase = "done" /\ s.age < 4
  /\ s' = [s EXCEPT !.age = @ + 1]

Next == Plan \/ Change \/ Invalidate \/ Tick \/ Jump
        \/ DispatchCompact \/ Admit \/ Replay \/ FinishTick
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.own \in Own /\ s.tokens \in 0..2 /\ s.age \in 0..4
  /\ s.epoch \in 0..1 /\ s.mode \in Modes
  /\ s.phase \in {"reconcile", "timer", "admission", "done"}
  /\ s.warmed \subseteq 0..1 /\ s.compacted \subseteq 0..1
BeforeExpiry == ~s.lostCompact /\ (s.age < 4 \/ ~s.owed \/ s.epoch \in s.compacted)
WaitingWarms == ~s.lostWarm /\ (s.age < 4 \/ ~s.warmOwed \/ s.epoch \in s.warmed)
CancellationFinal == ~s.retired \/ ~s.live
MinimumRequired == ~s.badMinimum
OwnTurnFinished == ~s.badTurn
InputQueueEmpty == ~s.badQueue
WarmingWaitsForTree == ~s.badTree
SwitchesIndependent == ~s.badSwitch
DeadlineRespected == ~s.badDeadline
CurrentCapture == ~s.badInvalid
NoDoubleExpiry == s.warmed \cap s.compacted = {}
=============================================================================
