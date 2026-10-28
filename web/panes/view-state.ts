// Error-isolated lifecycle adapter between generic PaneDef declarations and the
// bounded conversation UI-state store. Pane implementations own the meaning of
// their payload; the framework only validates declaration metadata, invokes the
// hooks, and persists the serialized value in the declared retention tier.
import type { ConversationUiStateStore } from "../conversation-ui-state/store.js";
import type { PaneContext, PaneViewStateDef } from "../types.js";

const STATE_KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;
const RESERVED_STATE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validPaneViewStateDef(
  value: PaneViewStateDef | undefined,
): value is PaneViewStateDef {
  return (
    !!value &&
    STATE_KEY_RE.test(value.key) &&
    !RESERVED_STATE_KEYS.has(value.key) &&
    Number.isInteger(value.storageSlot) &&
    value.storageSlot >= 0 &&
    value.storageSlot < 16 &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    (value.retention === undefined ||
      value.retention === "local" ||
      value.retention === "session") &&
    typeof value.defaultValue === "function" &&
    typeof value.parse === "function" &&
    typeof value.serialize === "function" &&
    typeof value.capture === "function" &&
    typeof value.restore === "function"
  );
}

export function capturePaneViewState(
  store: ConversationUiStateStore,
  ownerId: string,
  definition: PaneViewStateDef | undefined,
  element: HTMLElement,
  context: PaneContext,
): boolean {
  if (!validPaneViewStateDef(definition)) return false;
  try {
    const value = definition.serialize(definition.capture(element, context));
    return store.setPaneState(
      ownerId,
      definition.key,
      definition.version,
      definition.retention || "session",
      value,
      definition.storageSlot,
    );
  } catch {
    return false;
  }
}

export class PaneViewStateLifecycle {
  private restored = new WeakSet<HTMLElement>();

  restoreOnce(
    store: ConversationUiStateStore,
    ownerId: string,
    definition: PaneViewStateDef | undefined,
    element: HTMLElement,
    context: PaneContext,
  ): boolean {
    if (this.restored.has(element) || !validPaneViewStateDef(definition))
      return false;
    // Invariant: Mark before invoking plugin code: a throwing hook must not
    // become a retry loop on every refresh or retarget the next conversation
    // later.
    this.restored.add(element);
    let value: unknown;
    const raw = store.paneState(
      ownerId,
      definition.key,
      definition.version,
      definition.retention || "session",
    );
    try {
      value =
        raw === undefined ? definition.defaultValue() : definition.parse(raw);
    } catch {
      try {
        value = definition.defaultValue();
      } catch {
        return false;
      }
    }
    try {
      definition.restore(element, context, value);
      return true;
    } catch {
      return false;
    }
  }
}
