-------------------------- MODULE RotationTrace --------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT Events
VARIABLE i, held, fences, requests, retired, badRename, badAdmission, badProtocol
vars == <<i, held, fences, requests, retired, badRename, badAdmission, badProtocol>>

(***************************************************************************
 Replay a finite recorded execution, not all implementation executions. Leases
 linearize at admission/release; connection admission conservatively includes
 queued native open, and closes follow acknowledged close or worker exit.
 A connection can materialize an admitted lease or rotation's internal sync
 behind a fence: only new external page/search leases are forbidden there.
 Open/module events stutter in the safety abstraction. IPC ids check dispatch,
 receive and reply order independently of timestamp/worker clock alignment.
***************************************************************************)
Init == /\ i = 0 /\ held = {} /\ fences = {} /\ requests = {} /\ retired = {}
        /\ badRename = FALSE /\ badAdmission = FALSE /\ badProtocol = FALSE

Step ==
  /\ i < Len(Events)
  /\ LET e == Events[i + 1]
         h == [id |-> e.id, p |-> e.p, k |-> e.k, s |-> e.s]
         f == [p |-> e.p, k |-> e.k]
         matching == {r \in requests : r.id = e.id}
         connection == {r \in held : r.id = e.id}
         protocol == CASE e.a = "admit" -> connection = {} /\ e.k \in {"page","search","connection"}
                      [] e.a = "open" -> h \in held
                      [] e.a = "close" -> connection # {} \/ e.s \in retired
                      [] e.a = "fence" -> e.k \in {"page","search"}
                      [] e.a = "unfence" -> f \in fences
                      [] e.a = "rename" -> TRUE
                      [] e.a = "dispatch" -> matching = {}
                      [] e.a = "receive" -> matching = {[id |-> e.id, s |-> e.s, stage |-> "sent"]}
                      [] e.a = "reply" -> matching = {[id |-> e.id, s |-> e.s, stage |-> "active"]}
                      [] OTHER -> e.a \in {"module", "close-scope"}
     IN /\ i' = i + 1
        /\ held' = CASE e.a = "admit" -> held \cup {h}
                    [] e.a = "close" -> held \ connection
                    [] e.a = "close-scope" -> {r \in held : r.s # e.s}
                    [] OTHER -> held
        /\ fences' = CASE e.a = "fence" -> fences \cup {f}
                      [] e.a = "unfence" -> fences \ {f}
                      [] OTHER -> fences
        /\ requests' = CASE e.a = "dispatch" -> requests \cup {[id |-> e.id, s |-> e.s, stage |-> "sent"]}
                        [] e.a = "receive" -> (requests \ matching) \cup {[id |-> e.id, s |-> e.s, stage |-> "active"]}
                        [] e.a = "reply" -> requests \ matching
                        [] e.a = "close-scope" -> {r \in requests : r.s # e.s}
                        [] OTHER -> requests
        /\ retired' = IF e.a = "close-scope" THEN retired \cup {e.s} ELSE retired
        /\ badRename' = (badRename \/ (e.a = "rename" /\ \E r \in held : r.p = e.p))
        /\ badAdmission' = (badAdmission \/ (e.a = "admit" /\ e.k # "connection" /\ f \in fences))
        /\ badProtocol' = (badProtocol \/ ~protocol)

Spec == Init /\ [][Step]_vars
RenameClosed == ~badRename
NoAdmissionAfterFence == ~badAdmission
CorrelatedProtocol == ~badProtocol
TraceClosed == i = Len(Events) => held = {} /\ requests = {}
=============================================================================
