// Pure (DOM-free) derivation of the safety toggle's truthful view, so it is
// unit-testable in isolation. `desired` drives the toggle position, its red
// label, and track; `effective` is what review is doing right now; `pending`
// marks a mid-turn change that is queued but not yet in force ("· next turn").
export interface SafetyView {
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
