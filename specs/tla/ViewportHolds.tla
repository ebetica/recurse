---------------------------- MODULE ViewportHolds ----------------------------
EXTENDS Integers, FiniteSets

CONSTANT Bug

(***************************************************************************
 Target design for the thread scroller's holds in web/conversation/thread.ts:
 disclosure anchor (disc), viewport hold (vh), send pin (pin) and
 bottom-follow (follow). Every scrollTop the app causes goes through one
 ledger: app writes record where they landed, paint and the ResizeObserver
 record clamps they observe, and a smooth jump records each step toward its
 target. Any other offset is the reader's and releases every hold. Reader
 input events release first. The ledger keeps a jump's target (jt) apart
 from the browser's animation (smooth): reader and scripted scrolls cancel
 the animation and clear the target at their scrollend (ending); hiding the
 thread cancels it with no scrollend.

 Positions are abstract units: `above` is content above the tracked row
 (pressed control, held row or sent message), `below` the rest beyond one
 viewport, negative while the row cannot reach the top; the deepest
 scrollTop is max(0, above + below). Tasks run between frames; a frame
 dispatches scroll events, runs rAF callbacks, applies layout, then runs
 ResizeObserver callbacks. `claim` records the reading-position obligation,
 including natural following; `stale` names holds and deferred writes older
 than the reader's latest scroll.

 Assumed: one pending layout per frame; scrolls without input events
 (scrollbar, find-in-page, scripts) neither land exactly on the recorded
 offset nor run toward a smooth jump's target, and they end that animation;
 a jump starts with no scrollend pending; content above a running row
 jump's row changes only by delayed layout (images, styles), never by a
 paint, which could land the jump before the ResizeObserver re-aims it.

 Bug "none" checks the design. Each control restores today's inference at
 one point, an older behaviour or (layout-clamp) a design step removed, and
 must fail the named invariant:
 ReaderWins: pin-blind (unexplained scrolls keep the pin), paint-blind
 (paint reapplies the viewport hold unjudged), follow-offset (following
 ends only above its last bottom write), pane-keys (#3198),
 scripted-scroll (#3274).
 HoldKept: queued-smooth (a queued send leaves a jump running), paint-clamp
 (paint's clamp unrecorded), layout-clamp (the ResizeObserver records
 nothing), jump-follow (#3120), hidden-layout (#3218), unsettled (#3229
 measured mid-scroll), delayed-layout (#3254).
 OneHold: queued-anchor (a queued send keeps the disclosure anchor),
 disclosure-follow (#3376: Press keeps its internal paint's follow latch).
 PendingBottom/NaturalFollow: natural-follow (#3376: paint queues the bottom
 without latching follow; another paint captures a conflicting viewport hold).
 JumpLands: paint-jump (paint captures a hold or follows the bottom
 mid-jump, before #3313), jump-gap (before #3317 a paint between a row
 jump's release and its start did the same, and the start kept holds),
 jump-shift (before #3318 the target was fixed when the jump started, so
 delayed layout above the row landed it off its aim).
 JumpEnds: hide-jump (hiding leaves the target),
 noop-jump (before #3316 a jump that moved nothing kept its target, so a
 later clamp left it awaited with nothing scrolling).
***************************************************************************)
VARIABLE s
vars == <<s>>

Size == 0..2
Rest == -1..2
None == -9
Bot == 9
Holds == {"disc", "vh", "pin", "follow", "raf", "batch"}
Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b
Bottom(r) == Max(0, r.above + r.below)
Clamp(t, r) == Max(0, Min(t, Bottom(r)))
Between(a, x, b) == Min(a, b) <= x /\ x <= Max(a, b)
Reach(r, t) == 0 <= t /\ t <= Bottom(r)
Near(r) == ~r.hidden /\ r.top = Bottom(r)
\* A started row jump the ledger still awaits (threadJumping).
RowJumping(r) ==
  r.claim = "jump" /\ r.jumpDue = None /\ r.jt # None /\ r.top # r.jt
PinHeld(r) == r.pin = "held"
Active(r) ==
  {k \in Holds : CASE k = "disc" -> r.disc [] k = "vh" -> r.vh
                   [] k = "pin" -> PinHeld(r) [] k = "follow" -> r.follow
                   [] k = "raf" -> r.raf [] k = "batch" -> r.batch}

\* An app write lands clamped (nowhere while hidden), is recorded and cancels
\* a smooth scroll. Landing a stale source somewhere new steals the view; a
\* hold or bottom write while the ledger still awaits a row jump's target
\* (threadJumping) cuts the jump short (cut).
Write(r, src, t) ==
  LET land == IF r.hidden THEN r.top ELSE Clamp(t, r)
  IN [r EXCEPT !.top = land, !.ledger = land, !.smooth = None, !.jt = None,
               !.cut = r.cut \/ (src \in {"vh", "batch"} /\ RowJumping(r)),
               !.scrollDue = r.scrollDue \/ land # r.top,
               !.stolen = r.stolen \/ (src \in r.stale /\ land # r.top)]
Record(r) == [r EXCEPT !.ledger = r.top]
\* recordThreadScroll: hiding ended any smooth jump with no scrollend, so a
\* hidden thread drops the jump's target (#3313).
DropHidden(r) ==
  IF r.hidden /\ Bug # "hide-jump" THEN [r EXCEPT !.jt = None] ELSE r

\* releaseBottomFollow: drops every hold and pending correction.
Release(r) ==
  [r EXCEPT !.disc = FALSE, !.vh = FALSE, !.follow = FALSE, !.batch = FALSE,
            !.raf = FALSE, !.pin = IF PinHeld(r) THEN "released" ELSE r.pin]

\* Controls: today's code released the pin only on input events, the anchor
\* (before #3274) only on input, and following only above its last bottom.
Unexplained(r) ==
  /\ ~(r.hidden /\ Bug # "hidden-layout")
  /\ r.top # r.ledger
  /\ ~(r.jt # None /\ Between(r.ledger, r.top, r.jt))
Judge(r) ==
  LET kept == [Release(r) EXCEPT !.pin = IF Bug = "pin-blind" THEN r.pin
                                         ELSE "released",
                                 !.disc = Bug = "scripted-scroll" /\ r.disc,
                                 !.follow = Bug = "follow-offset" /\ r.follow,
                                 !.batch = Bug = "follow-offset" /\ r.follow
                                            /\ r.batch]
      away == r.follow /\ r.top < r.followedTop /\ ~Near(r)
      today == IF Bug = "follow-offset" /\ away
               THEN [kept EXCEPT !.follow = FALSE, !.batch = FALSE] ELSE kept
  IN Record(IF Unexplained(r) THEN [today EXCEPT !.jt = None]
            ELSE IF Bug = "follow-offset" /\ away
                 THEN [r EXCEPT !.follow = FALSE, !.batch = FALSE] ELSE r)

\* applySendPin: follow the natural bottom until the sent row reaches the top.
ApplyPin(r) ==
  IF ~PinHeld(r) THEN r
  ELSE Write(r, "pin", IF r.frozen # None THEN r.frozen ELSE r.above)
ApplyHold(r) == IF r.vh THEN Write(r, "vh", r.above - r.vhOff) ELSE r

\* scrollToBottom: controls.ts writes the bottom in its next rAF batch.
ToBottom(r) ==
  [r EXCEPT !.batch = TRUE,
            !.stale = IF r.follow /\ "follow" \in r.stale
                      THEN r.stale \cup {"batch"}
                      ELSE r.stale \ {"batch"}]

\* paint() after the shown thread's content changed by (da, db): judge, keep
\* the reader's row unless something holds, follows or jumps, render, record
\* the clamp, then reapply the hold. A row jump due next frame counts as
\* jumping (queueThreadJump).
Repaint(r, da, db) ==
  LET j == IF Bug = "paint-blind" /\ r.vh THEN r ELSE Judge(r)
      jumping == (j.jt # None /\ j.top # j.jt)
                 \/ (j.jumpDue # None /\ Bug # "jump-gap")
      guard == jumping /\ Bug # "paint-jump"
      near == Near(j) /\ ~guard
      capture == ~j.disc /\ ~j.vh /\ ~PinHeld(j) /\ ~near /\ ~j.follow
                 /\ ~guard
      r1 == IF capture
            THEN [j EXCEPT !.vh = TRUE, !.vhOff = j.above - j.top,
                           !.stale = j.stale \ {"vh"}]
            ELSE j
      followBottom == ~r1.disc /\ ~r1.vh /\ ~PinHeld(r1) /\ (near \/ r1.follow)
      naturalClaim == r1.claim \in {"reader", "landed"}
                      \/ (r1.claim = "jump" /\ r1.jt = None
                          /\ r1.jumpDue = None)
      latch == followBottom /\ Bug # "natural-follow"
      r2 == [r1 EXCEPT !.above = j.above + da, !.below = j.below + db,
                       !.follow = r1.follow \/ latch,
                       !.claim = IF followBottom /\ ~r1.follow /\ naturalClaim
                                 THEN "bottom" ELSE r1.claim,
                       !.stale = IF latch /\ ~r1.follow
                                 THEN r1.stale \ {"follow"} ELSE r1.stale,
                       !.roDue = TRUE]
      t == IF j.hidden THEN j.top ELSE Clamp(j.top, r2)
      r3 == [r2 EXCEPT !.top = t, !.scrollDue = j.scrollDue \/ t # j.top]
      r4 == ApplyPin(IF Bug = "paint-clamp" THEN DropHidden(r3)
                     ELSE Record(DropHidden(r3)))
  IN IF r4.vh THEN ApplyHold(r4) ELSE IF followBottom THEN ToBottom(r4) ELSE r4

\* The scroll listener reads the offset when dispatched; a smooth jump's step
\* toward its target is the app's.
OnScroll(r) == Judge(r)

\* settleJumpTarget: smooth-scroll so the row (above) sits `off` below the
\* viewport top, replacing any earlier scroll and target. The target is
\* clamped once, so the claim is the row's offset at that target. A jump to
\* the current offset moves nothing and gets no scrollend, so it keeps no
\* target (before #3316 jumpThreadScroll kept it: noop-jump). It first drops
\* holds set since the release (before #3317 it kept them: jump-gap).
StartJump(r0, off) ==
  LET r == IF Bug = "jump-gap" THEN r0 ELSE Release(r0)
      t == Clamp(r.above - off, r)
      keep == t # r.top \/ Bug = "noop-jump"
  IN [r EXCEPT !.jumpDue = None, !.smooth = IF t = r.top THEN None ELSE t,
               !.jt = IF keep THEN t ELSE None, !.ledger = r.top,
               !.claim = IF t = r.top THEN "landed" ELSE "jump",
               !.claimVal = r.above - t, !.aimOff = off]

\* Pending rAF callbacks: withScrollAnchor's residual pass, the bottom batch.
OnFrame(r) ==
  LET r1 == IF r.raf
            THEN Write(r, "raf", Max(0, r.above - r.rafOff))
            ELSE r
      r2 == [r1 EXCEPT !.raf = FALSE]
      r3 == IF ~r2.batch THEN r2
            ELSE LET w == Write(r2, "batch", Bottom(r2))
                 IN [w EXCEPT !.followedTop = w.top, !.batch = FALSE,
                              !.claim = IF w.claim \in {"reader", "landed", "jump"}
                                        THEN "bottom" ELSE w.claim]
  IN IF r3.jumpDue = None THEN r3 ELSE StartJump(r3, r3.jumpDue)

\* The ResizeObserver records the layout's clamp, re-aims a row jump the ledger
\* still awaits (before #3318 it did not: jump-shift), then reapplies one hold.
OnResize(r0) ==
  LET blind == Bug = "layout-clamp" \/ (Bug = "hidden-layout" /\ r0.hidden)
      r1 == IF blind THEN DropHidden(r0) ELSE Record(DropHidden(r0))
      awaited == r1.claim = "jump" /\ r1.jumpDue = None /\ r1.jt # None
      r == IF awaited /\ ~r1.hidden /\ Bug # "jump-shift"
           THEN StartJump(r1, r1.aimOff) ELSE r1
  IN IF PinHeld(r) THEN ApplyPin(r)
     ELSE IF r.disc
       THEN IF r.hidden THEN r
            ELSE Write(r, "disc", Max(0, r.above - r.discOff))
     ELSE IF r.vh THEN ApplyHold(r)
     ELSE IF r.follow THEN ToBottom(r)
     ELSE r

\* Every step drops stale names whose hold or deferred write is gone and
\* forgets fields of inactive holds.
Next1(r) ==
  s' = [r EXCEPT !.stale = r.stale \cap Active(r),
                 !.saved = IF r.away THEN r.saved ELSE Bot,
                 !.rafOff = IF r.raf THEN r.rafOff ELSE 0,
                 !.discOff = IF r.disc THEN r.discOff ELSE 0,
                 !.vhOff = IF r.vh THEN r.vhOff ELSE 0,
                 !.followedTop = IF r.follow THEN r.followedTop ELSE 0,
                 !.pin = IF PinHeld(r) THEN "held" ELSE "none",
                 !.frozen = IF PinHeld(r) THEN r.frozen ELSE None,
                 !.claimVal = IF r.claim \in {"row", "pressed", "frozen",
                                              "jump"}
                              THEN r.claimVal ELSE 0,
                 !.aimOff = IF r.claim = "jump" THEN r.aimOff ELSE 0]

Init ==
  \E a \in Size, b \in Rest, t \in 0..4 :
    /\ t <= Max(0, a + b)
    /\ s = [above |-> a, below |-> b, top |-> t, ledger |-> t,
            hidden |-> FALSE, away |-> FALSE, saved |-> Bot,
            disc |-> FALSE, discOff |-> 0, raf |-> FALSE, rafOff |-> 0,
            vh |-> FALSE, vhOff |-> 0, pin |-> "none", frozen |-> None,
            follow |-> FALSE, followedTop |-> 0, batch |-> FALSE,
            phase |-> "task", scrollDue |-> FALSE, roDue |-> FALSE,
            layoutDue |-> "none", smooth |-> None, jt |-> None,
            claim |-> "reader", claimVal |-> 0, stale |-> {},
            stolen |-> FALSE, cut |-> FALSE, missed |-> FALSE,
            ending |-> FALSE, jumpDue |-> None, aimOff |-> 0]

Task == s.phase = "task" /\ ~s.away /\ ~s.hidden
Moves == {t \in 0..Bottom(s) : t # s.top}

\* Wheel, touch, pointer or key input releases holds before the view moves.
ReaderMove(t) ==
  LET r == [Release(s) EXCEPT !.top = t, !.scrollDue = TRUE, !.smooth = None,
                              !.ending = TRUE, !.claim = "reader"]
  IN Next1([r EXCEPT !.stale = Active(r)])
ReaderScroll == Task /\ \E t \in Moves : ReaderMove(t)

\* Scrollbar, find-in-page or scripted scrolling sends no input event. Assumed
\* not to land exactly on the recorded offset (pixels rarely repeat) nor to
\* move toward a smooth jump's target while it runs; it ends the animation.
ForeignMove(t, recorded) ==
  LET r == [s EXCEPT !.top = t, !.scrollDue = TRUE, !.claim = "reader",
                     !.smooth = None,
                     !.ledger = IF recorded THEN t ELSE s.ledger,
                     !.ending = TRUE]
  IN Next1([r EXCEPT !.stale = Active(r)])
ForeignScroll ==
  Task /\ \E t \in Moves :
    /\ t # s.ledger
    /\ s.smooth # None => ~Between(s.top, t, Min(s.smooth, Bottom(s)))
    /\ s.jt # None => ~Between(s.ledger, t, s.jt)
    /\ ForeignMove(t, FALSE)

\* Side pane keys (panes/navigation.ts) announce recurse:reader-scroll before
\* moving the thread; #3198 moved it like an app write.
PaneKeys ==
  Task /\ \E t \in Moves :
    IF Bug = "pane-keys" THEN ForeignMove(t, TRUE) ELSE ReaderMove(t)

\* anchoredPaint: release, paint (which may latch natural following), then
\* release again before the explicit disclosure anchor takes ownership.
\* disclosure-follow restores the old partial clear after paint (#3376).
\* Before #3254 nothing outlived the residual rAF pass.
Press ==
  Task /\ \E a \in Size, da \in -1..1, db \in -1..1 :
    LET b == s.above + s.below - a
        off == a - s.top
        r0 == [Release(s) EXCEPT !.above = a, !.below = b,
                                 !.smooth = None, !.stale = {},
                                 !.claim = "pressed", !.claimVal = off]
        painted == Repaint(r0, da, db)
        released == IF Bug = "disclosure-follow"
                    THEN [painted EXCEPT !.vh = FALSE, !.batch = FALSE]
                    ELSE Release(painted)
        w == Write(released, "disc", Max(0, released.above - off))
    IN /\ b \in Rest /\ a + da \in Size /\ b + db \in Rest
       /\ da # 0 \/ db # 0
       /\ Next1([w EXCEPT !.disc = (Bug # "delayed-layout"), !.discOff = off,
                          !.raf = TRUE, !.rafOff = off])

\* scrollToLatest: followLatestReply then a smooth scroll to the bottom.
\* Before #3120 it dropped the viewport hold without following.
Jump ==
  /\ Task /\ ~s.ending /\ s.top # Bottom(s)
  /\ LET r == [Release(s) EXCEPT !.smooth = Bottom(s), !.jt = Bottom(s),
                                 !.ledger = s.top, !.claim = "bottom"]
     IN IF Bug = "jump-follow" THEN Next1(r)
        ELSE Next1([r EXCEPT !.follow = TRUE, !.followedTop = s.top,
                             !.stale = r.stale \ {"follow"}])

\* jumpToRowMessage: drop every hold, then start the jump in the next frame.
RowJump ==
  Task /\ ~s.ending /\ \E off \in 0..1 :
    LET r == [Release(s) EXCEPT !.claim = "jump"]
    IN Next1([r EXCEPT !.jumpDue = off])

\* pinOperatorSend: the appended sent message becomes the tracked row.
Send ==
  Task /\ \E a \in Size, b \in Rest :
    LET r == [Release(s) EXCEPT !.pin = "held", !.frozen = None,
                                !.above = a, !.below = b, !.roDue = TRUE,
                                !.claim = "sent", !.stale = {}]
    IN /\ Max(0, a + b) >= Bottom(s)
       /\ Next1(ApplyPin([r EXCEPT !.top = Min(s.top, Bottom(r))]))

\* holdQueuedSend: freeze a held pin, else hold the reader's row. Either way
\* the view stays put, cancelling a running smooth jump.
QueuedSend ==
  /\ Task
  /\ LET j == Judge(s)
         stay(r) == IF Bug = "queued-smooth" THEN r ELSE Write(r, "app", r.top)
     IN IF PinHeld(j)
        THEN Next1(stay([j EXCEPT !.disc = FALSE, !.frozen = j.top,
                                  !.claim = "frozen", !.claimVal = j.top]))
        ELSE Next1(stay([j EXCEPT !.disc = (j.disc /\ Bug = "queued-anchor"),
                                  !.vh = TRUE, !.vhOff = j.above - j.top,
                                  !.follow = FALSE, !.batch = FALSE,
                                  !.claim = "row", !.claimVal = j.above - j.top,
                                  !.stale = j.stale \ {"vh"}]))

\* Live rows, replies or older pages repaint the shown thread.
AboveStill == (s.claim = "jump" /\ s.jt # None) \/ s.jumpDue # None
Paint ==
  /\ s.phase = "task" /\ ~s.away
  /\ \E da \in -1..1, db \in -1..1 :
       /\ s.above + da \in Size /\ s.below + db \in Rest
       /\ AboveStill => da = 0
       /\ Next1(Repaint(s, da, db))

\* Delayed layout (images, styles, window layout) or the thread being hidden
\* and shown again (its offset resets); the browser applies it next frame.
Layout ==
  /\ s.phase = "task" /\ s.layoutDue = "none" /\ ~s.away
  /\ \E k \in {"a+", "a-", "b+", "b-", "hide", "show"} :
       /\ k = "hide" => ~s.hidden
       /\ k = "show" => s.hidden
       /\ s' = [s EXCEPT !.layoutDue = k]

\* Switching away saves where the reader was (saveViewport); returning restores
\* it as a viewport hold or bottom-follow, from wherever the scroller was.
\* The next thread's paint writes its own hold or bottom, ending any jump.
Leave ==
  /\ Task
  /\ LET j == Judge(s)
         saved == IF j.vh THEN j.vhOff
                  ELSE IF j.follow \/ Near(j) THEN Bot ELSE j.above - j.top
     IN Next1([Release(j) EXCEPT !.pin = "none", !.smooth = None, !.jt = None,
                                 !.jumpDue = None,
                                 !.away = TRUE, !.saved = saved,
                                 !.claim = "away", !.stale = {}])
Return ==
  /\ s.phase = "task" /\ s.away
  /\ \E t \in IF s.hidden THEN {0} ELSE 0..Bottom(s) :
       LET r == [s EXCEPT !.away = FALSE, !.top = t, !.ledger = t,
                          !.scrollDue = TRUE, !.roDue = TRUE,
                          !.vh = (s.saved # Bot), !.vhOff = s.saved,
                          !.follow = (s.saved = Bot), !.followedTop = 0,
                          !.claim = IF s.saved = Bot THEN "bottom" ELSE "row",
                          !.claimVal = s.saved]
       IN Next1(IF r.vh THEN ApplyHold(r) ELSE ToBottom(r))

\* One frame: scroll steps and events, rAF callbacks, layout, observers.
FrameScroll ==
  /\ s.phase = "task" /\ s' = [s EXCEPT !.phase = "scroll"]
\* A smooth scroll moves one unit toward its goal; on reaching it, or after a
\* reader or scripted scroll, scrollend clears the ledger's target. A row
\* jump that reached its target checks where its row landed.
ScrollStep ==
  /\ s.phase = "scroll"
  /\ LET goal == Min(s.smooth, Bottom(s))
         on == s.smooth # None /\ ~s.hidden
         t == IF ~on \/ s.top = goal THEN s.top
              ELSE IF s.top < goal THEN s.top + 1 ELSE s.top - 1
         ends == on /\ t = goal
         r == [s EXCEPT !.top = t, !.phase = "raf", !.scrollDue = FALSE]
         j == IF (s.scrollDue \/ t # s.top) /\ ~s.away THEN OnScroll(r) ELSE r
         landed == ends /\ j.jt # None /\ j.claim = "jump" /\ j.jumpDue = None
     IN Next1([j EXCEPT !.smooth = IF ends THEN None ELSE j.smooth,
                        !.jt = IF ends \/ s.ending THEN None ELSE j.jt,
                        !.ending = FALSE,
                        !.claim = IF landed THEN "landed" ELSE j.claim,
                        !.missed = j.missed \/ (landed /\ t = j.jt
                                     /\ j.above - t # j.claimVal)])
RafStep ==
  /\ s.phase = "raf"
  /\ Next1([OnFrame(s) EXCEPT !.phase = "layout"])
LayoutStep ==
  /\ s.phase = "layout"
  /\ LET k == s.layoutDue
         step(up, down) == IF k = up THEN 1 ELSE IF k = down THEN -1 ELSE 0
         r == [s EXCEPT !.layoutDue = "none", !.phase = "resize",
                        !.roDue = s.roDue \/ k # "none",
                        !.above = s.above + step("a+", "a-"),
                        !.below = s.below + step("b+", "b-"),
                        !.hidden = (k = "hide") \/ (s.hidden /\ k # "show")]
         t == IF k \in {"hide", "show"} THEN 0 ELSE Min(s.top, Bottom(r))
     IN /\ r.above \in Size /\ r.below \in Rest
        /\ Next1([r EXCEPT !.top = t, !.scrollDue = s.scrollDue \/ t # s.top,
                           !.smooth = IF k = "hide" THEN None ELSE r.smooth])
ResizeStep ==
  /\ s.phase = "resize"
  /\ LET r == [s EXCEPT !.phase = "task", !.roDue = FALSE]
     IN Next1(IF s.roDue /\ ~s.away THEN OnResize(r) ELSE r)

Next == ReaderScroll \/ ForeignScroll \/ PaneKeys \/ Press \/ Jump \/ RowJump
        \/ Send
        \/ QueuedSend \/ Paint \/ Layout \/ Leave \/ Return \/ FrameScroll
        \/ ScrollStep \/ RafStep \/ LayoutStep \/ ResizeStep
Spec == Init /\ [][Next]_vars

\* Measurements wait for the view to settle (#3229 measured mid-scroll).
Settled ==
  /\ ~s.away /\ ~s.hidden
  /\ \/ Bug = "unsettled"
     \/ /\ s.phase = "task" /\ s.layoutDue = "none" /\ s.smooth = None
        /\ ~s.scrollDue /\ ~s.roDue /\ ~s.raf /\ ~s.batch
Achievable(t) == Reach(s, t)

\* A press, send, jump, queued send or return keeps the view where it put it
\* until the reader moves: the row keeps its offset, the bottom stays bottom.
HoldKept ==
  Settled =>
    CASE s.claim \in {"row", "pressed"} ->
           s.above - s.top = s.claimVal \/ ~Achievable(s.above - s.claimVal)
      [] s.claim = "bottom" -> s.top = Bottom(s)
      [] s.claim = "sent" -> s.top = Min(s.above, Bottom(s))
      [] s.claim = "frozen" -> s.top = Min(s.claimVal, Bottom(s))
      [] OTHER -> TRUE

\* Reader input or a scroll the app did not make wins: no hold or deferred
\* write older than it moves the view afterwards.
ReaderWins == ~s.stolen

OneHold == Cardinality(Active(s) \ {"raf", "batch"}) <= 1

\* A natural follow decision establishes the same bottom obligation as Jump.
NaturalFollow == Settled /\ s.claim = "bottom" => s.top = Bottom(s)
\* Deferred bottom writes cannot compete with a newly captured viewport hold.
PendingBottom == s.batch => ~s.vh

\* A jump in flight always ends: while the ledger awaits a target it has not
\* reached (threadJumping), the browser is still animating toward it, one
\* unit a frame, until scrollend clears it.
JumpEnds ==
  s.phase = "task" /\ ~s.scrollDue
  => (s.jt # None /\ s.top # s.jt => s.smooth # None)

\* No hold or bottom write cuts a row jump's animation short, and a row
\* jump that reaches its target leaves its row where it aimed.
JumpLands == ~s.cut /\ ~s.missed
=============================================================================
