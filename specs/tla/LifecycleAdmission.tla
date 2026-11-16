------------------------ MODULE LifecycleAdmission ------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS ReservationDeadlineBug, PreparationDeadlineBug

(***************************************************************************
 Two fresh top-level tokens in one process share a reservation and kernel
 flock with an independent external process. Expiry can cross awaited queue,
 preparation and polling boundaries; bodies and nested calls have no deadline.
 Refusal snapshots record the blocker at the admission decision. Kernel poll
 expiry retains its last failed native attempt, as flockExclusive does.
***************************************************************************)
VARIABLE s
vars == <<s>>
Callers == {"a", "b"}
None == "none"

Init ==
  s = [owner |-> None, kernel |-> None,
       phase |-> [p \in Callers |-> "reserve"],
       expired |-> [p \in Callers |-> FALSE],
       depth |-> [p \in Callers |-> 0],
       live |-> [p \in Callers |-> FALSE],
       spent |-> [p \in Callers |-> FALSE],
       fds |-> [p \in Callers |-> FALSE],
       busy |-> [p \in Callers |-> FALSE],
       blocker |-> [p \in Callers |-> None],
       kernelBlocker |-> [p \in Callers |-> None]]

Reserve(p) ==
  /\ s.phase[p] = "reserve"
  /\ IF ReservationDeadlineBug /\ s.expired[p]
     THEN s' = [s EXCEPT !.phase[p] = "done", !.busy[p] = TRUE,
                        !.blocker[p] = s.owner]
     ELSE IF s.owner = None
          THEN s' = [s EXCEPT !.owner = p, !.depth[p] = 1,
                             !.live[p] = TRUE, !.phase[p] = "prepare"]
          ELSE IF s.expired[p]
               THEN s' = [s EXCEPT !.phase[p] = "done", !.busy[p] = TRUE,
                                  !.blocker[p] = s.owner]
               ELSE s' = [s EXCEPT !.phase[p] = "queued"]

Wake(p) ==
  /\ s.phase[p] = "queued"
  /\ s.owner = None \/ s.expired[p]
  /\ s' = [s EXCEPT !.phase[p] = "reserve"]

Expire(p) ==
  /\ s.phase[p] \in {"queued", "prepare", "kernelWait"}
  /\ ~s.expired[p]
  /\ s' = [s EXCEPT !.expired[p] = TRUE]

Prepare(p) ==
  /\ s.phase[p] = "prepare"
  /\ s' = [s EXCEPT !.fds[p] = TRUE, !.phase[p] = "flock"]

Flock(p) ==
  /\ s.phase[p] = "flock"
  /\ IF PreparationDeadlineBug /\ s.expired[p]
     THEN s' = [s EXCEPT !.phase[p] = "close", !.busy[p] = TRUE,
                        !.blocker[p] = s.kernel]
     ELSE IF s.kernel = None
          THEN s' = [s EXCEPT !.kernel = p, !.phase[p] = "body"]
          ELSE IF s.expired[p]
               THEN s' = [s EXCEPT !.phase[p] = "close", !.busy[p] = TRUE,
                                  !.blocker[p] = s.kernel]
               ELSE s' = [s EXCEPT !.phase[p] = "kernelWait",
                                  !.kernelBlocker[p] = s.kernel]

Poll(p) ==
  /\ s.phase[p] = "kernelWait"
  /\ IF s.expired[p]
     THEN s' = [s EXCEPT !.phase[p] = "close", !.busy[p] = TRUE,
                        !.blocker[p] = s.kernelBlocker[p]]
     ELSE s' = [s EXCEPT !.phase[p] = "flock"]

NestedEnter(p) ==
  /\ s.phase[p] = "body" /\ s.depth[p] = 1
  /\ s' = [s EXCEPT !.depth[p] = 2]

NestedExit(p) ==
  /\ s.phase[p] = "body" /\ s.depth[p] = 2
  /\ s' = [s EXCEPT !.depth[p] = 1]

Finish(p) ==
  /\ s.phase[p] = "body" /\ s.depth[p] = 1
  /\ s' = [s EXCEPT !.phase[p] = "unlock"]

Unlock(p) ==
  /\ s.phase[p] = "unlock"
  /\ s' = [s EXCEPT !.kernel = None, !.phase[p] = "close"]

Close(p) ==
  /\ s.phase[p] = "close"
  /\ s' = [s EXCEPT !.fds[p] = FALSE, !.phase[p] = "release"]

Release(p) ==
  /\ s.phase[p] = "release" /\ ~s.fds[p]
  /\ s' = [s EXCEPT !.owner = None, !.depth[p] = 0,
                     !.live[p] = FALSE, !.spent[p] = TRUE,
                     !.phase[p] = "done"]

ReuseSpent(p) ==
  /\ s.phase[p] = "done" /\ s.spent[p]
  /\ s' = [s EXCEPT !.phase[p] = "invalid"]

ExternalAcquire ==
  /\ s.kernel = None
  /\ s' = [s EXCEPT !.kernel = "external"]

ExternalRelease ==
  /\ s.kernel = "external"
  /\ s' = [s EXCEPT !.kernel = None]

Next == (\E p \in Callers : Reserve(p) \/ Wake(p) \/ Expire(p) \/ Prepare(p)
        \/ Flock(p) \/ Poll(p) \/ NestedEnter(p) \/ NestedExit(p) \/ Finish(p)
        \/ Unlock(p) \/ Close(p) \/ Release(p) \/ ReuseSpent(p))
        \/ ExternalAcquire \/ ExternalRelease
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.owner \in Callers \cup {None}
  /\ s.kernel \in Callers \cup {None, "external"}
  /\ s.phase \in [Callers -> {"reserve", "queued", "prepare", "flock",
         "kernelWait", "body", "unlock", "close", "release", "done", "invalid"}]
  /\ s.depth \in [Callers -> 0..2]
  /\ \A f \in {s.expired, s.live, s.spent, s.fds, s.busy} :
       f \in [Callers -> BOOLEAN]
  /\ \A f \in {s.blocker, s.kernelBlocker} :
       f \in [Callers -> Callers \cup {None, "external"}]

MutualExclusion ==
  /\ Cardinality({p \in Callers : s.phase[p] \in {"body", "unlock"}}) <= 1
  /\ \A p \in Callers : s.phase[p] \in {"body", "unlock"} =>
       s.owner = p /\ s.kernel = p /\ s.live[p]
BusyOnlyIfHeld ==
  \A p \in Callers : s.busy[p] => s.blocker[p] \notin {None, p}
CloseBeforeRelease ==
  \A p \in Callers : (s.fds[p] \/ s.kernel = p) => s.owner = p
TokenOwnership ==
  \A p \in Callers :
    /\ (s.live[p] <=> s.owner = p /\ s.depth[p] > 0)
    /\ (s.spent[p] => ~s.live[p] /\ s.depth[p] = 0)
=============================================================================
