// Owns per-conversation view state across local and session retention tiers.
// codec.ts interprets untrusted bytes; persistence.ts reserves, repairs and
// commits slots over this store's state.
import {
  FLUSH_DELAY_MS,
  LEGACY_PANE_PREFIX,
  LOCAL_OWNER_INDEX_KEY,
  LOCAL_PANE_VISIBILITY,
  LOCAL_REPAIR_KEY,
  LOCAL_UI_STATE_PREFIX,
  MAX_COMPOSER_DRAFT_CHARS,
  MAX_PANE_STATES,
  MAX_RETAINED_OWNERS,
  SESSION_OWNER_INDEX_KEY,
  SESSION_REPAIR_KEY,
  SESSION_UI_STATE_PREFIX,
  defaultLocalState,
  defaultSessionState,
  ephemeralOwner,
  jsonClone,
  slotKeyFor,
  validBoundedString,
  validOwnerId,
  validStateKey,
  type ComposerViewState,
  type ConversationUiState,
  type LocalState,
  type PaneVisibility,
  type SessionState,
  type StorageLike,
  type UiStateRetention,
} from "./schema.js";
import {
  clonePaneStates,
  encodeState,
  overlaySlotFields,
  parseComposer,
  parsePane,
  parseRecord,
  slotOwnerIn,
} from "./codec.js";
import {
  OwnerResourceStoreImpl,
  type ManagedOwnerResource,
  type OwnerResourceStore,
} from "./owner-resources.js";
import {
  findOwnerSlotFor,
  markDirtyFor,
  removeFromOwnerIndexFor,
  writeOwnerFor,
  type UiStateStoreState,
} from "./persistence.js";

export class ConversationUiStateStore implements UiStateStoreState {
  // Public for persistence.ts only; internal to this directory.
  localRecords = new Map<string, LocalState>();
  sessionRecords = new Map<string, SessionState>();
  dirtyLocal = new Set<string>();
  dirtyLocalPane = new Set<string>();
  dirtyLocalPaneStates = new Map<string, Set<string>>();
  dirtySession = new Set<string>();
  dirtySessionComposer = new Set<string>();
  dirtySessionPaneStates = new Map<string, Set<string>>();
  localPaneFields = new Map<string, Map<string, number>>();
  sessionPaneFields = new Map<string, Map<string, number>>();
  localSlots = new Map<string, number>();
  sessionSlots = new Map<string, number>();
  // Memoized writer-token scans reset on storage events.
  repairedLocalMarker: string | null = null;
  repairedSessionMarker: string | null = null;
  localMisses = new Set<string>();
  sessionMisses = new Set<string>();
  localFlushPins = new Set<string>();
  sessionFlushPins = new Set<string>();
  trustedLocalIndex: string | null = null;
  trustedSessionIndex: string | null = null;
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerResources = new Set<ManagedOwnerResource>();

  constructor(
    public localStorage: StorageLike | null,
    public sessionStorage: StorageLike | null,
    public flushDelayMs = FLUSH_DELAY_MS,
  ) {}

  cacheLocal(ownerId: string, value: LocalState): void {
    this.localRecords.delete(ownerId);
    this.localRecords.set(ownerId, value);
    for (const id of this.localRecords.keys()) {
      if (this.localRecords.size <= MAX_RETAINED_OWNERS) break;
      if (id !== ownerId && !this.dirtyLocal.has(id)) {
        this.localRecords.delete(id);
        this.localPaneFields.delete(id);
      }
    }
  }

  cacheSession(ownerId: string, value: SessionState): void {
    this.sessionRecords.delete(ownerId);
    this.sessionRecords.set(ownerId, value);
    for (const id of this.sessionRecords.keys()) {
      if (this.sessionRecords.size <= MAX_RETAINED_OWNERS) break;
      if (id !== ownerId && !this.dirtySession.has(id)) {
        this.sessionRecords.delete(id);
        this.sessionPaneFields.delete(id);
        this.releaseOwnerResources(id);
      }
    }
  }

  private retainOwner(ownerId: string): boolean {
    if (!validOwnerId(ownerId)) return false;
    this.loadSession(ownerId);
    return this.sessionRecords.has(ownerId);
  }

  releaseOwnerResources(ownerId: string): void {
    for (const resource of this.ownerResources) resource.remove(ownerId);
  }

  ownerResource<T>(dispose: (value: T) => void): OwnerResourceStore<T> {
    const resource = new OwnerResourceStoreImpl<T>(
      (ownerId) => this.retainOwner(ownerId),
      dispose,
    );
    this.ownerResources.add(resource);
    return resource;
  }

  private loadLocal(ownerId: string): LocalState {
    if (!validOwnerId(ownerId)) return defaultLocalState();
    const known = this.localRecords.get(ownerId);
    if (known) return known;
    if (ephemeralOwner(ownerId)) {
      const value = defaultLocalState();
      this.cacheLocal(ownerId, value);
      return value;
    }
    let stored: LocalState | null = null;
    const found = findOwnerSlotFor(this, this.localStorage, "local", ownerId);
    if (found) stored = parseRecord(found.raw, "local") as LocalState | null;
    const value = stored || defaultLocalState();
    const generation = found
      ? slotOwnerIn(found.raw, "local")?.generation
      : undefined;
    if (found && generation)
      overlaySlotFields(
        this.localStorage,
        "local",
        found.slot,
        ownerId,
        generation,
        value,
      );
    if (!stored) {
      let legacy: string | null = null;
      try {
        legacy =
          this.localStorage?.getItem(
            LEGACY_PANE_PREFIX + encodeURIComponent(ownerId),
          ) ?? null;
      } catch {
        legacy = null;
      }
      if (legacy === "closed") value.pane = { kind: "closed" };
      else if (
        legacy?.startsWith("open:") &&
        validBoundedString(legacy.slice(5))
      ) {
        const id = legacy.slice(5);
        value.pane = { kind: "open", id, lastId: id };
      }
      if (legacy !== null)
        markDirtyFor(this, ownerId, "local", LOCAL_PANE_VISIBILITY);
    }
    this.cacheLocal(ownerId, value);
    return value;
  }

  private loadSession(ownerId: string): SessionState {
    if (!validOwnerId(ownerId)) return defaultSessionState();
    const known = this.sessionRecords.get(ownerId);
    if (known) return known;
    if (ephemeralOwner(ownerId)) {
      const value = defaultSessionState();
      this.cacheSession(ownerId, value);
      return value;
    }
    let stored: SessionState | null = null;
    const found = findOwnerSlotFor(
      this,
      this.sessionStorage,
      "session",
      ownerId,
    );
    if (found)
      stored = parseRecord(found.raw, "session") as SessionState | null;
    const value = stored || defaultSessionState();
    const generation = found
      ? slotOwnerIn(found.raw, "session")?.generation
      : undefined;
    if (found && generation)
      overlaySlotFields(
        this.sessionStorage,
        "session",
        found.slot,
        ownerId,
        generation,
        value,
      );
    this.cacheSession(ownerId, value);
    return value;
  }

  snapshot(ownerId: string): ConversationUiState {
    const local = this.loadLocal(ownerId),
      session = this.loadSession(ownerId);
    return {
      pane: { ...local.pane },
      composer: { ...session.composer },
      localPanes: clonePaneStates(local.panes),
      sessionPanes: clonePaneStates(session.panes),
    };
  }

  pane(ownerId: string): PaneVisibility {
    return { ...this.loadLocal(ownerId).pane };
  }

  setPane(ownerId: string, pane: PaneVisibility): void {
    if (!validOwnerId(ownerId)) return;
    const current = this.loadLocal(ownerId);
    const next = { pane: parsePane(pane), panes: current.panes };
    if (encodeState(next, "local") === null) return;
    current.pane = next.pane;
    markDirtyFor(this, ownerId, "local", LOCAL_PANE_VISIBILITY);
  }

  composer(ownerId: string): ComposerViewState {
    return { ...this.loadSession(ownerId).composer };
  }

  setComposer(ownerId: string, composer: ComposerViewState): boolean {
    if (
      !validOwnerId(ownerId) ||
      composer.text.length > MAX_COMPOSER_DRAFT_CHARS
    )
      return false;
    const current = this.loadSession(ownerId);
    const next = { composer: parseComposer(composer), panes: current.panes };
    if (encodeState(next, "session") === null) return false;
    current.composer = next.composer;
    markDirtyFor(this, ownerId, "session", "composer");
    return true;
  }

  paneState(
    ownerId: string,
    key: string,
    version: number,
    retention: UiStateRetention,
  ): unknown | undefined {
    if (!validStateKey(key) || !Number.isInteger(version) || version < 1)
      return undefined;
    const panes =
      retention === "local"
        ? this.loadLocal(ownerId).panes
        : this.loadSession(ownerId).panes;
    const item = panes[key];
    return item?.version === version ? jsonClone(item.value) : undefined;
  }

  setPaneState(
    ownerId: string,
    key: string,
    version: number,
    retention: UiStateRetention,
    value: unknown,
    storageSlot?: number,
  ): boolean {
    if (
      !validOwnerId(ownerId) ||
      !validStateKey(key) ||
      !Number.isInteger(version) ||
      version < 1 ||
      !(
        storageSlot === undefined ||
        (Number.isInteger(storageSlot) &&
          storageSlot >= 0 &&
          storageSlot < MAX_PANE_STATES)
      )
    )
      return false;
    const normalized = jsonClone(value);
    if (normalized === undefined) return false;
    const record =
      retention === "local"
        ? this.loadLocal(ownerId)
        : this.loadSession(ownerId);
    const panes = record.panes;
    if (!(key in panes) && Object.keys(panes).length >= MAX_PANE_STATES)
      return false;
    const nextPanes = clonePaneStates(panes);
    nextPanes[key] = { version, value: normalized };
    const next =
      retention === "local"
        ? { pane: (record as LocalState).pane, panes: nextPanes }
        : { composer: (record as SessionState).composer, panes: nextPanes };
    if (encodeState(next, retention) === null) return false;
    record.panes = nextPanes;
    if (storageSlot !== undefined) {
      const fields =
        retention === "local" ? this.localPaneFields : this.sessionPaneFields;
      let ownerFields = fields.get(ownerId);
      if (!ownerFields) {
        ownerFields = new Map();
        fields.set(ownerId, ownerFields);
      }
      ownerFields.set(key, storageSlot);
    }
    markDirtyFor(this, ownerId, retention, key);
    return true;
  }

  transfer(fromOwnerId: string, toOwnerId: string): void {
    if (
      fromOwnerId === toOwnerId ||
      !validOwnerId(fromOwnerId) ||
      !validOwnerId(toOwnerId)
    )
      return;
    const local = this.loadLocal(fromOwnerId),
      session = this.loadSession(fromOwnerId);
    for (const resource of this.ownerResources)
      resource.transfer(fromOwnerId, toOwnerId);
    this.cacheLocal(toOwnerId, {
      pane: { ...local.pane },
      panes: clonePaneStates(local.panes),
    });
    this.cacheSession(toOwnerId, {
      composer: { ...session.composer },
      panes: clonePaneStates(session.panes),
    });
    this.remove(fromOwnerId);
    markDirtyFor(this, toOwnerId, "local", LOCAL_PANE_VISIBILITY);
    for (const key of Object.keys(local.panes))
      markDirtyFor(this, toOwnerId, "local", key);
    markDirtyFor(this, toOwnerId, "session", "composer");
    for (const key of Object.keys(session.panes))
      markDirtyFor(this, toOwnerId, "session", key);
  }

  remove(ownerId: string): void {
    if (!validOwnerId(ownerId)) return;
    this.releaseOwnerResources(ownerId);
    this.localRecords.delete(ownerId);
    this.sessionRecords.delete(ownerId);
    this.dirtyLocal.delete(ownerId);
    this.dirtyLocalPane.delete(ownerId);
    this.dirtyLocalPaneStates.delete(ownerId);
    this.dirtySession.delete(ownerId);
    this.dirtySessionComposer.delete(ownerId);
    this.dirtySessionPaneStates.delete(ownerId);
    this.localPaneFields.delete(ownerId);
    this.sessionPaneFields.delete(ownerId);
    if (ephemeralOwner(ownerId)) return;
    for (const [storage, retention] of [
      [this.localStorage, "local"],
      [this.sessionStorage, "session"],
    ] as const) {
      const found = findOwnerSlotFor(this, storage, retention, ownerId);
      try {
        if (found) {
          // Invariant: Keep only the physical slot epoch. Field subslots are
          // fixed and may still contain this owner; the next reuse must not
          // reset to generation 1.
          const generation =
            slotOwnerIn(found.raw, retention)?.generation || "0";
          storage?.setItem(
            slotKeyFor(found.slot, retention),
            JSON.stringify({
              version: 1,
              tombstone: true,
              touched: Date.now(),
              generation,
            }),
          );
        }
      } catch {}
      (retention === "local" ? this.localSlots : this.sessionSlots).delete(
        ownerId,
      );
      removeFromOwnerIndexFor(this, storage, retention, ownerId);
    }
    try {
      this.localStorage?.removeItem?.(
        LEGACY_PANE_PREFIX + encodeURIComponent(ownerId),
      );
    } catch {}
  }

  hasUnpersistedComposerWork(): boolean {
    this.flush();
    for (const id of this.dirtySession)
      if (this.sessionRecords.get(id)?.composer.text) return true;
    return false;
  }

  handleStorageEvent(
    key: string | null,
    storageArea: StorageLike | null,
  ): void {
    const invalidate = (
      records: Map<string, LocalState> | Map<string, SessionState>,
      dirty: Set<string>,
      slots: Map<string, number>,
    ) => {
      for (const id of records.keys()) if (!dirty.has(id)) records.delete(id);
      slots.clear();
    };
    const localKey =
      key === null ||
      key === LOCAL_OWNER_INDEX_KEY ||
      key === LOCAL_REPAIR_KEY ||
      key.startsWith(`${LOCAL_UI_STATE_PREFIX}slot.`) ||
      key.startsWith(LEGACY_PANE_PREFIX);
    const sessionKey =
      key === null ||
      key === SESSION_OWNER_INDEX_KEY ||
      key === SESSION_REPAIR_KEY ||
      key.startsWith(`${SESSION_UI_STATE_PREFIX}slot.`);
    if (localKey && (!storageArea || storageArea === this.localStorage)) {
      this.repairedLocalMarker = null;
      this.trustedLocalIndex = null;
      this.localMisses.clear();
      invalidate(this.localRecords, this.dirtyLocal, this.localSlots);
    }
    if (sessionKey && (!storageArea || storageArea === this.sessionStorage)) {
      this.repairedSessionMarker = null;
      this.trustedSessionIndex = null;
      this.sessionMisses.clear();
      invalidate(this.sessionRecords, this.dirtySession, this.sessionSlots);
    }
  }

  flush(ownerId?: string): void {
    const owners = ownerId
      ? [ownerId]
      : [...new Set([...this.dirtyLocal, ...this.dirtySession])];
    for (const id of owners) {
      if (this.dirtyLocal.has(id)) this.localFlushPins.add(id);
      if (this.dirtySession.has(id)) this.sessionFlushPins.add(id);
    }
    try {
      for (const id of owners) {
        writeOwnerFor(this, id, "local");
        writeOwnerFor(this, id, "session");
      }
    } finally {
      for (const id of owners) {
        this.localFlushPins.delete(id);
        this.sessionFlushPins.delete(id);
      }
    }
    if (
      !this.dirtyLocal.size &&
      !this.dirtySession.size &&
      this.flushTimer !== null
    ) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function browserStorage(
  name: "sessionStorage" | "localStorage",
): StorageLike | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

export const conversationUiState = new ConversationUiStateStore(
  browserStorage("localStorage"),
  browserStorage("sessionStorage"),
);
try {
  window.addEventListener("storage", (event) =>
    conversationUiState.handleStorageEvent(event.key, event.storageArea),
  );
} catch {}

export function newDraftUiOwnerId(): string {
  try {
    return `draft:${crypto.randomUUID()}`;
  } catch {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return `draft:${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      // Invariant: This id only separates in-tab UI namespaces; it is never an
      // auth token.
      return `draft:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
  }
}
