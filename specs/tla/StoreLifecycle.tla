-------------------------- MODULE StoreLifecycle --------------------------
EXTENDS Naturals, Integers, FiniteSets, TLC

CONSTANTS Stores, ColdViewBug, SearchFenceBug, PrepareCacheBug,
          Exclusive, CatchupLimit

(***************************************************************************
 A bounded protocol model, not a SQLite implementation. File identity is
 (store, generation); rename preserves that identity and all committed data.
 Two commits total (both may target either file generation) and one rotation
 per path bound these races. A lease
 precedes asynchronous native open; admitted opens can finish during rotation.
 Readers span admission, open, per-operation read/sync, and release. Fixed
 readers share the owner; buggy readers retain independent native connections.
 The launcher lock excludes another server; two worker slots exercise local
 owner admission. Search identity publication is atomic, as is file rename.
***************************************************************************)
MaxWrites == 2
Files == [store : Stores, gen : 0..1]
Versions == [file : Files, version : 1..MaxWrites]
Owners == [store : Stores, gen : 0..1, worker : 1..2]
NoFile == [store |-> "none", gen |-> -1]
NoReader == [store |-> "none", gen |-> -1, kind |-> "none"]
Readers == [store : Stores, gen : 0..1, kind : {"page", "search"}]

VARIABLE state
vars == <<state>>

File(s) == [store |-> s, gen |-> state.live[s]]
HasOwner(s) == \E c \in state.owners : c.store = s
Unfenced(kind) == IF kind = "page" THEN ColdViewBug ELSE SearchFenceBug
ReaderOn(s) == state.reader.store = s
NativeReader == state.readerOpen /\ Unfenced(state.reader.kind)
Fingerprint(s) == (MaxWrites + 1) * state.live[s] + state.disk[File(s)]
Synced == {s \in Stores : state.projection[s] = Fingerprint(s)}

Init ==
  state = [live |-> [s \in Stores |-> 0], owners |-> {},
           pending |-> NoFile, reader |-> NoReader, readerOpen |-> FALSE,
           rotating |-> "none", archived |-> {},
           disk |-> [f \in Files |-> 0], committed |-> {},
           projection |-> [s \in Stores |-> 0],
           cache |-> [s \in Stores |-> -1],
           movedRead |-> FALSE, unsafeRotation |-> FALSE,
           nativeCrash |-> FALSE, missedSynced |-> FALSE]

OpenOwner(s, w) ==
  /\ state.rotating # s
  /\ ~HasOwner(s)
  /\ LET gen == IF ColdViewBug /\ ReaderOn(s) /\ state.readerOpen
                   /\ state.reader.kind = "page"
                THEN state.reader.gen ELSE state.live[s]
     IN state' = [state EXCEPT
          !.owners = @ \cup {[store |-> s, gen |-> gen, worker |-> w]}]

CloseOwner(c) ==
  /\ c \in state.owners
  /\ state.pending.store # c.store
  /\ ~(ReaderOn(c.store) /\ state.readerOpen /\ ~Unfenced(state.reader.kind))
  /\ state' = [state EXCEPT !.owners = @ \ {c}]

BeginWrite(s) ==
  /\ state.rotating # s
  /\ state.pending = NoFile
  /\ \E c \in state.owners : c.store = s /\ c.gen = state.live[s]
  /\ Cardinality(state.committed) < MaxWrites
  /\ state' = [state EXCEPT !.pending = File(s)]

Commit ==
  /\ state.pending # NoFile
  /\ LET version == state.disk[state.pending] + 1
     IN state' = [state EXCEPT !.disk[state.pending] = version,
          !.committed = @ \cup {[file |-> state.pending, version |-> version]},
          !.pending = NoFile]

AdmitRead(s, kind) ==
  /\ state.reader = NoReader
  /\ state.rotating # s \/ (kind = "search" /\ SearchFenceBug)
  /\ state' = [state EXCEPT
        !.reader = [store |-> s, gen |-> state.live[s], kind |-> kind]]

OpenRead(w) ==
  /\ state.reader # NoReader /\ ~state.readerOpen
  /\ state.pending.store # state.reader.store
  /\ LET s == state.reader.store
         shared == ~Unfenced(state.reader.kind) /\ HasOwner(s)
         gen == IF shared THEN (CHOOSE c \in state.owners : c.store = s).gen
                ELSE state.live[s]
     IN state' = [state EXCEPT !.readerOpen = TRUE, !.reader.gen = gen,
          !.owners = IF ~Unfenced(state.reader.kind) /\ ~HasOwner(s)
                     THEN @ \cup {[store |-> s, gen |-> gen, worker |-> w]}
                     ELSE @]

Read ==
  /\ state.readerOpen
  /\ state.pending.store # state.reader.store
  /\ LET moved == state.reader.gen # state.live[state.reader.store]
     IN state' = [state EXCEPT !.movedRead = @ \/ moved,
          !.nativeCrash = @ \/ (moved /\ NativeReader /\ Exclusive)]

ReadOwner(c) ==
  /\ c \in state.owners
  /\ state.pending.store # c.store
  /\ state' = [state EXCEPT !.movedRead = @ \/ (c.gen # state.live[c.store])]

ReleaseRead ==
  /\ state.reader # NoReader
  /\ ~state.readerOpen \/ state.pending.store # state.reader.store
  /\ state' = [state EXCEPT !.reader = NoReader, !.readerOpen = FALSE]

Sync(s) ==
  /\ state.pending.store # s
  /\ ((ReaderOn(s) /\ state.readerOpen /\ state.reader.kind = "search"
                   /\ state.reader.gen = state.live[s])
      \/ (state.rotating = s /\ ~HasOwner(s) /\ ~ReaderOn(s)))
  /\ state' = [state EXCEPT !.projection[s] = Fingerprint(s)]

(***************************************************************************
 Prepare's worker has an independent identity cache. The owner publishes both
 the projection and its persisted verification state in Sync. Rotation's final
 Sync opens and closes a temporary owner atomically after draining all handles.
 Fixed prepare reloads persisted state on mismatch. Bounded catch-up can hide
 this bug for small scopes: use two stores and limit one (the five-store/limit-four race
 reduced to its smallest representative). Only already-synced stores count;
 intentional omissions of unsynced stores are outside this property.
***************************************************************************)
Prepare ==
  LET loaded == [s \in Stores |->
        IF state.cache[s] = -1
           \/ (~PrepareCacheBug /\ state.cache[s] # Fingerprint(s))
        THEN state.projection[s] ELSE state.cache[s]]
      stale == {s \in Synced : loaded[s] # Fingerprint(s)}
      count == IF Cardinality(stale) < CatchupLimit
               THEN Cardinality(stale) ELSE CatchupLimit
  IN \E caught \in SUBSET stale :
       /\ Cardinality(caught) = count
       /\ state' = [state EXCEPT
            !.cache = [s \in Stores |-> IF s \in caught
                       THEN state.projection[s] ELSE loaded[s]],
            !.missedSynced = @ \/ (stale \ caught # {})]

BeginRotation(s) ==
  /\ state.rotating = "none"
  /\ state.live[s] = 0
  /\ state' = [state EXCEPT !.rotating = s]

Rename(s) ==
  /\ state.rotating = s
  /\ ~HasOwner(s)
  /\ state.pending.store # s
  /\ ~ReaderOn(s) \/ Unfenced(state.reader.kind)
  /\ s \in Synced
  /\ state' = [state EXCEPT !.archived = @ \cup {File(s)},
                !.live[s] = 1, !.projection[s] = -1,
                !.rotating = "none",
                !.unsafeRotation = @ \/ (ReaderOn(s) /\ state.readerOpen)]

(***************************************************************************
 A process restart closes every native connection, abandons uncommitted work,
 drops caches/fences, and retains committed files and search metadata. A
 multi-file rename interrupted by process death and power loss are not modeled.
***************************************************************************)
Restart ==
  state' = [state EXCEPT !.owners = {}, !.pending = NoFile,
            !.reader = NoReader, !.readerOpen = FALSE, !.rotating = "none",
            !.cache = [s \in Stores |-> -1]]

Next ==
  \/ \E s \in Stores, w \in 1..2 : OpenOwner(s, w)
  \/ \E w \in 1..2 : OpenRead(w)
  \/ \E c \in state.owners : CloseOwner(c) \/ ReadOwner(c)
  \/ \E s \in Stores : BeginWrite(s) \/ Sync(s)
                        \/ BeginRotation(s) \/ Rename(s)
  \/ \E s \in Stores, kind \in {"page", "search"} : AdmitRead(s, kind)
  \/ Commit \/ Read \/ ReleaseRead \/ Prepare \/ Restart

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ state.live \in [Stores -> 0..1]
  /\ state.owners \subseteq Owners
  /\ state.pending \in Files \cup {NoFile}
  /\ state.reader \in Readers \cup {NoReader}
  /\ state.rotating \in Stores \cup {"none"}
  /\ state.archived \subseteq Files
  /\ state.disk \in [Files -> 0..MaxWrites]
  /\ state.committed \subseteq Versions
  /\ state.projection \in [Stores -> -1..(2 * MaxWrites + 1)]
  /\ state.cache \in [Stores -> -1..(2 * MaxWrites + 1)]
  /\ {state.readerOpen, state.movedRead, state.unsafeRotation, state.nativeCrash,
      state.missedSynced} \subseteq BOOLEAN
  /\ state.readerOpen => state.reader # NoReader

NoReadMoved == ~state.movedRead
NoLostCommit == \A v \in state.committed :
  /\ v.version <= state.disk[v.file]
  /\ v.file \in state.archived \/ v.file.gen = state.live[v.file.store]
SingleOwnerPerPath ==
  \A s \in Stores : Cardinality({c \in state.owners : c.store = s}) <= 1
OwnerConnectionCurrent == \A c \in state.owners : c.gen = state.live[c.store]
SearchCacheCoherent == ~state.missedSynced
RotationClosed == ~state.unsafeRotation
NoNativeRenameCrash == ~state.nativeCrash
=============================================================================
