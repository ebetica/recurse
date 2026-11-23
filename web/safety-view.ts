// Pure (DOM-free) derivation of the safety toggle's truthful view, so it is
// unit-testable in isolation. `desired` drives the toggle position, its red
// label, and track; `effective` is what review is doing right now; `pending`
// marks a mid-turn change that is queued but not yet in force ("· next turn").
interface SafetyView {
  desired: boolean;
  effective: boolean;
  pending: boolean;
  label: string;
}

export function deriveSafetyView(
  desired: boolean,
  active: boolean | undefined,
): SafetyView {
  // Invariant: Effective never flips optimistically: the in-flight turn keeps
  // its launched state until the boundary, so fall back to `desired` only when
  // the server hasn't reported an effective state (idle: the two are equal).
  const effective = active ?? desired;
  const pending = desired !== effective;
  const label =
    (desired ? "Yolo mode" : "Safety review") +
    (pending ? " \u00b7 next turn" : "");
  return { desired, effective, pending, label };
}

interface SafetyFields {
  safety_off?: boolean;
  safety_off_active?: boolean;
  safety_rev?: number | null;
}

const repliedAt = new Map<string, number>();

/** Note that a safety reply for conversation `id` arrived now. */
export function noteSafetyReply(id: string): void {
  repliedAt.set(id, performance.now());
}

// Invariant: A read sent before a safety reply arrived may predate that reply's
// commit, so `next` keeps the shown safety fields. A read sent later carries
// every change since, including a clear that keeps the revision.
export function keepRepliedSafety(
  id: string,
  sentAt: number,
  shown: SafetyFields | undefined,
  next: SafetyFields,
): void {
  if (!shown || sentAt >= (repliedAt.get(id) ?? -Infinity)) return;
  next.safety_off = shown.safety_off;
  next.safety_off_active = shown.safety_off_active;
  next.safety_rev = shown.safety_rev;
}
