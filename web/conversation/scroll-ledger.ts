// The thread scroller's only writer. Every offset the app causes is recorded;
// any other offset (scrollbar, find-in-page, scripts) is the reader's and
// releases the thread's holds. Hidden threads record their reset. Modeled by
// specs/tla/ViewportHolds.tla; dom.ts types the scroller read-only elsewhere.
import { scrollEl as readOnly } from "../dom.js";

const scrollEl = readOnly as unknown as HTMLElement;

let recorded = 0;
let jumpTarget: number | null = null;
let jumpQueued = false;

/** Writes the thread offset and records where the browser landed it. */
export function writeThreadScroll(top: number): number {
  jumpTarget = null;
  scrollEl.scrollTop = top;
  return (recorded = scrollEl.scrollTop);
}

/** Records an offset the app's own layout produced, such as a clamp. */
export function recordThreadScroll(): void {
  // Invariant: Hiding the thread cancels a smooth jump without a scrollend.
  if (!scrollEl.clientHeight) jumpTarget = null;
  recorded = scrollEl.scrollTop;
}

/** Scrolls toward `top`; steps toward it are recorded as the app's. True
 * when the thread has to move. */
export function jumpThreadScroll(
  top: number,
  behavior: ScrollBehavior,
): boolean {
  recorded = scrollEl.scrollTop;
  jumpTarget = Math.max(
    0,
    Math.min(top, scrollEl.scrollHeight - scrollEl.clientHeight),
  );
  scrollEl.scrollTo({ top, behavior });
  // Invariant: A jump that moves nothing gets no scrollend to end it.
  if (Math.abs(jumpTarget - recorded) <= 1) jumpTarget = null;
  return jumpTarget !== null;
}

/** Counts the thread as jumping from a row jump's release until it starts
 * next frame: a hold or bottom write there would cut it short. */
export function queueThreadJump(queued: boolean): void {
  jumpQueued = queued;
}

/** True while a jump is queued or its smooth scroll is still on its way. */
export function threadJumping(): boolean {
  if (jumpQueued) return true;
  return jumpTarget !== null && Math.abs(scrollEl.scrollTop - jumpTarget) > 1;
}

/** True until the jump's scrollend, an app write, the reader or hiding the
 * thread ends it, even once the offset has reached the target. */
export function threadJumpAwaited(): boolean {
  return jumpTarget !== null;
}

/** Moves the thread for reader input that sends no event of its own. */
export function scrollThreadForReader(top: number): void {
  scrollEl.dispatchEvent(new Event("recurse:reader-scroll"));
  scrollEl.scrollTop = top;
}

/** True once the offset moved without the app; records it either way. */
export function threadScrolledByReader(): boolean {
  const top = scrollEl.scrollTop;
  const previous = recorded;
  recorded = top;
  if (!scrollEl.clientHeight || Math.abs(top - previous) <= 1) return false;
  const target = jumpTarget;
  if (
    target !== null &&
    Math.sign(top - previous) === Math.sign(target - previous) &&
    Math.abs(target - top) < Math.abs(target - previous)
  )
    return false;
  jumpTarget = null;
  return true;
}

scrollEl.addEventListener("scrollend", () => (jumpTarget = null), {
  passive: true,
});
