// Pure read-time status overlays, with no Pi contact or cold node creation.
// Node desires override record flags; caller snapshots supply live run status.

type JsonObject = Record<string, unknown>;

interface NodeDesires {
  readonly muteDesired: boolean | null;
}

/** config_actions._muted_locked without creating a node on a cold read. */
export function readMuted(conv: JsonObject, node: NodeDesires | null): boolean {
  if (node !== null && node.muteDesired !== null) return node.muteDesired;
  return truthy(conv.muted);
}

/** Whether review is skipped now: the launched turn's value while running. */
export function readSafetyEffectiveOff(conv: JsonObject): boolean {
  if (conv.status === "running") {
    const active = conv.active_turn;
    if (isObject(active) && "safety_off" in active) {
      return truthy(active.safety_off);
    }
  }
  return truthy(conv.safety_off);
}

/** Pre-accept working-row fields: warming vs resuming the first send. */
export function providerStartingOverlay(
  conv: JsonObject,
  active: JsonObject,
): void {
  if (active.provider_phase !== "starting") return;
  const started = active.started_at;
  // Invariant: Python's isinstance(started, (int, float)) admits bool (True ->
  // 1.0).
  conv.provider_starting =
    typeof started === "number" || typeof started === "boolean"
      ? Number(started)
      : 0;
  // Invariant: Warm reuse vs cold spawn for this turn's first send, so the
  // working row can say resuming instead of starting. Absent on turns that
  // began before the stamp existed; the row then keeps the generic text.
  const reused = active.core_reused;
  if (typeof reused === "boolean") conv.core_reused = reused;
}

/** Python's bool(): empty strings, arrays, and objects are false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
