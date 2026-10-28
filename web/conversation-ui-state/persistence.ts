// Owns fixed-slot reservations, cross-tab repair, dirty tracking and commit.
// store.ts owns state and calls these functions; this module touches no DOM.
import {
  LEGACY_PANE_PREFIX,
  LOCAL_OWNER_INDEX_KEY,
  LOCAL_PANE_VISIBILITY,
  MAX_PANE_STATES,
  MAX_PLUGIN_STATE_CHARS,
  MAX_RETAINED_OWNERS,
  SESSION_OWNER_INDEX_KEY,
  ephemeralOwner,
  fieldKeyFor,
  jsonClone,
  repairKeyFor,
  slotKeyFor,
  validOwnerId,
  type LocalState,
  type SessionState,
  type StorageLike,
  type StoredPaneState,
  type UiStateRetention,
} from "./schema.js";
import {
  clonePaneStates,
  encodeState,
  overlaySlotFields,
  parseOwnerIndex,
  parsePluginField,
  parseRecord,
  pluginBucket,
  recordGenerationIn,
  slotGeneration,
  slotOwnerIn,
  type OwnerSlot,
  type ParsedOwnerIndex,
} from "./codec.js";

export interface UiStateStoreState {
  localStorage: StorageLike | null;
  sessionStorage: StorageLike | null;
  flushDelayMs: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  localRecords: Map<string, LocalState>;
  sessionRecords: Map<string, SessionState>;
  dirtyLocal: Set<string>;
  dirtyLocalPane: Set<string>;
  dirtyLocalPaneStates: Map<string, Set<string>>;
  dirtySession: Set<string>;
  dirtySessionComposer: Set<string>;
  dirtySessionPaneStates: Map<string, Set<string>>;
  localPaneFields: Map<string, Map<string, number>>;
  sessionPaneFields: Map<string, Map<string, number>>;
  localSlots: Map<string, number>;
  sessionSlots: Map<string, number>;
  repairedLocalMarker: string | null;
  repairedSessionMarker: string | null;
  localMisses: Set<string>;
  sessionMisses: Set<string>;
  localFlushPins: Set<string>;
  sessionFlushPins: Set<string>;
  trustedLocalIndex: string | null;
  trustedSessionIndex: string | null;
  cacheLocal(ownerId: string, value: LocalState): void;
  cacheSession(ownerId: string, value: SessionState): void;
  releaseOwnerResources(ownerId: string): void;
  flush(ownerId?: string): void;
}

export function writePluginFieldFor(
  storage: StorageLike,
  retention: UiStateRetention,
  slot: number,
  ownerId: string,
  generation: string,
  key: string,
  item: StoredPaneState,
  touched: number,
  preferredSlot?: number,
): void {
  const start = preferredSlot ?? pluginBucket(key);
  let available: number | null =
    preferredSlot === undefined ? null : 1 + preferredSlot;
  if (preferredSlot === undefined) {
    for (let offset = 0; offset < MAX_PANE_STATES; offset++) {
      const field = 1 + ((start + offset) % MAX_PANE_STATES);
      const raw = storage.getItem(fieldKeyFor(slot, retention, field));
      const existing = parsePluginField(raw, ownerId, generation);
      if (existing?.key === key) {
        available = field;
        break;
      }
      if (!existing && available === null) available = field;
    }
  }
  if (available === null) return;
  const raw = JSON.stringify({
    schema: 1,
    owner: ownerId,
    generation,
    touched,
    key,
    version: item.version,
    value: item.value,
  });
  if (raw.length <= MAX_PLUGIN_STATE_CHARS + 1_024)
    storage.setItem(fieldKeyFor(slot, retention, available), raw);
}

export function repairSlotsFor(
  s: UiStateStoreState,
  storage: StorageLike,
  retention: UiStateRetention,
  wantedOwner: string,
): { slot: number; raw: string } | null {
  const markerKey = repairKeyFor(retention);
  const markerBefore = storage.getItem(markerKey);
  const newest = new Map<string, { entry: OwnerSlot; raw: string }>();
  for (let slot = 0; slot < MAX_RETAINED_OWNERS; slot++) {
    const raw = storage.getItem(slotKeyFor(slot, retention));
    const owner = slotOwnerIn(raw, retention);
    if (!owner || !raw) continue;
    const prior = newest.get(owner.id);
    if (!prior || owner.touched >= prior.entry.touched) {
      // Invariant: Slots may change immediately after getItem; repair must
      // never delete a location another tab can replace. Duplicate residue
      // remains within the fixed 200-slot bound and is naturally reclaimed by
      // later reservations.
      newest.set(owner.id, {
        entry: {
          id: owner.id,
          slot,
          touched: owner.touched,
          generation: owner.generation,
        },
        raw,
      });
    }
  }
  const entries = [...newest.values()]
    .map((item) => item.entry)
    .sort((a, b) => a.touched - b.touched);
  const indexKey =
    retention === "local" ? LOCAL_OWNER_INDEX_KEY : SESSION_OWNER_INDEX_KEY;
  const encodedIndex = JSON.stringify(entries);
  try {
    storage.setItem(indexKey, encodedIndex);
    if (retention === "local") s.trustedLocalIndex = encodedIndex;
    else s.trustedSessionIndex = encodedIndex;
  } catch {}
  if (markerBefore && storage.getItem(markerKey) === markerBefore) {
    if (retention === "local") s.repairedLocalMarker = markerBefore;
    else s.repairedSessionMarker = markerBefore;
  }
  const found = newest.get(wantedOwner);
  if (!found) return null;
  (retention === "local" ? s.localSlots : s.sessionSlots).set(
    wantedOwner,
    found.entry.slot,
  );
  return { slot: found.entry.slot, raw: found.raw };
}

export function repairPendingFor(
  s: UiStateStoreState,
  storage: StorageLike,
  retention: UiStateRetention,
  parsed: ParsedOwnerIndex,
): boolean {
  const raw = storage.getItem(repairKeyFor(retention));
  if (!raw) return false;
  const repaired =
    retention === "local" ? s.repairedLocalMarker : s.repairedSessionMarker;
  if (raw === repaired) return false;
  try {
    const marker = JSON.parse(raw) as Record<string, unknown>;
    if (typeof marker.owner !== "string" || !validOwnerId(marker.owner))
      return true;
    const indexed = parsed.valid
      ? parsed.entries.find((item) => item.id === marker.owner)
      : undefined;
    if (!indexed) return true;
    return (
      slotOwnerIn(
        storage.getItem(slotKeyFor(indexed.slot, retention)),
        retention,
      )?.id !== marker.owner
    );
  } catch {
    return true;
  }
}

export function findOwnerSlotFor(
  s: UiStateStoreState,
  storage: StorageLike | null,
  retention: UiStateRetention,
  ownerId: string,
): { slot: number; raw: string } | null {
  if (!storage) return null;
  const cache = retention === "local" ? s.localSlots : s.sessionSlots;
  const remembered = cache.get(ownerId);
  if (remembered !== undefined) {
    try {
      const raw = storage.getItem(slotKeyFor(remembered, retention));
      if (slotOwnerIn(raw, retention)?.id === ownerId)
        return { slot: remembered, raw: raw! };
    } catch {
      return null;
    }
    cache.delete(ownerId);
  }
  const indexKey =
    retention === "local" ? LOCAL_OWNER_INDEX_KEY : SESSION_OWNER_INDEX_KEY;
  try {
    const parsed = parseOwnerIndex(storage.getItem(indexKey));
    const indexed = parsed.entries.find((item) => item.id === ownerId);
    if (!indexed) {
      // Invariant: The shared index is only a positive hint, not atomic state.
      // Scan once per owner/document; invalidate misses on scoped events or
      // writes.
      const misses = retention === "local" ? s.localMisses : s.sessionMisses;
      const trusted =
        retention === "local" ? s.trustedLocalIndex : s.trustedSessionIndex;
      if (
        (misses.has(ownerId) ||
          (trusted !== null && storage.getItem(indexKey) === trusted)) &&
        parsed.valid &&
        !repairPendingFor(s, storage, retention, parsed)
      )
        return null;
      const found = repairSlotsFor(s, storage, retention, ownerId);
      if (found) {
        misses.delete(ownerId);
        return found;
      }
      misses.add(ownerId);
      while (misses.size > MAX_RETAINED_OWNERS)
        misses.delete(misses.values().next().value!);
      return null;
    }
    const indexedRaw = storage.getItem(slotKeyFor(indexed.slot, retention));
    if (slotOwnerIn(indexedRaw, retention)?.id === ownerId) {
      cache.set(ownerId, indexed.slot);
      return { slot: indexed.slot, raw: indexedRaw! };
    }
    // Invariant: A mapped slot overwritten by a concurrent tab gets one bounded
    // repair scan, never on the normal unseen-owner/poll/keystroke path.
    return repairSlotsFor(s, storage, retention, ownerId);
  } catch {
    return null;
  }
  return null;
}

export function markDirtyFor(
  s: UiStateStoreState,
  ownerId: string,
  retention: UiStateRetention,
  localPart?: string,
): void {
  if (!validOwnerId(ownerId) || ephemeralOwner(ownerId)) return;
  if (retention === "local") {
    s.dirtyLocal.add(ownerId);
    if (localPart === LOCAL_PANE_VISIBILITY) s.dirtyLocalPane.add(ownerId);
    else if (localPart) {
      let keys = s.dirtyLocalPaneStates.get(ownerId);
      if (!keys) {
        keys = new Set();
        s.dirtyLocalPaneStates.set(ownerId, keys);
      }
      keys.add(localPart);
    }
  } else {
    s.dirtySession.add(ownerId);
    if (localPart === "composer") s.dirtySessionComposer.add(ownerId);
    else if (localPart) {
      let keys = s.dirtySessionPaneStates.get(ownerId);
      if (!keys) {
        keys = new Set();
        s.dirtySessionPaneStates.set(ownerId, keys);
      }
      keys.add(localPart);
    }
  }
  if (s.flushTimer !== null) return;
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null;
    s.flush();
  }, s.flushDelayMs);
}

export function mergedLocalFor(
  s: UiStateStoreState,
  ownerId: string,
  pending: LocalState,
): LocalState {
  let current = pending;
  try {
    const found = findOwnerSlotFor(s, s.localStorage, "local", ownerId);
    current =
      ((found ? parseRecord(found.raw, "local") : null) as LocalState | null) ||
      pending;
    const generation = found
      ? slotOwnerIn(found.raw, "local")?.generation
      : undefined;
    if (found && generation && current !== pending)
      overlaySlotFields(
        s.localStorage,
        "local",
        found.slot,
        ownerId,
        generation,
        current,
      );
  } catch {
    current = pending;
  }
  const panes = clonePaneStates(current.panes);
  const dirtyKeys = s.dirtyLocalPaneStates.get(ownerId) || new Set<string>();
  for (const key of dirtyKeys) {
    const item = pending.panes[key];
    if (!item) continue;
    if (!(key in panes) && Object.keys(panes).length >= MAX_PANE_STATES) {
      const replace = Object.keys(panes).find(
        (candidate) => !dirtyKeys.has(candidate),
      );
      if (replace) delete panes[replace];
    }
    const value = jsonClone(item.value);
    if (value !== undefined) panes[key] = { version: item.version, value };
  }
  return {
    pane: s.dirtyLocalPane.has(ownerId)
      ? { ...pending.pane }
      : { ...current.pane },
    panes,
  };
}

export function reserveOwnerSlotFor(
  s: UiStateStoreState,
  storage: StorageLike | null,
  retention: UiStateRetention,
  ownerId: string,
): OwnerSlot | null {
  if (!storage || ephemeralOwner(ownerId)) return null;
  const indexKey =
    retention === "local" ? LOCAL_OWNER_INDEX_KEY : SESSION_OWNER_INDEX_KEY;
  const touched = Date.now();
  try {
    const parsed = parseOwnerIndex(storage.getItem(indexKey));
    const indexed = parsed.entries;
    const known = parsed.valid
      ? indexed.find((item) => item.id === ownerId)
      : undefined;
    if (known) {
      const raw = storage.getItem(slotKeyFor(known.slot, retention));
      const owner = slotOwnerIn(raw, retention);
      if (owner?.id === ownerId) {
        const entry = {
          id: ownerId,
          slot: known.slot,
          touched,
          generation: owner.generation || slotGeneration(owner),
        };
        try {
          storage.setItem(
            indexKey,
            JSON.stringify([
              ...indexed.filter((item) => item.id !== ownerId),
              entry,
            ]),
          );
        } catch {}
        return entry;
      }
    }

    // Invariant: A new/divergent owner scans the fixed slot set once. The
    // records live in these slots—not owner-named keys—so even simultaneous
    // tabs choosing the same free/oldest slot can overwrite state but can never
    // create residue beyond MAX_RETAINED_OWNERS.
    const actualByOwner = new Map<string, OwnerSlot>();
    let empty: number | null = null;
    let emptyGeneration: string | undefined;
    let oldestPhysical: OwnerSlot | null = null;
    const dirtyPinned = retention === "local" ? s.dirtyLocal : s.dirtySession;
    const flushPinned =
      retention === "local" ? s.localFlushPins : s.sessionFlushPins;
    for (let slot = 0; slot < MAX_RETAINED_OWNERS; slot++) {
      const raw = storage.getItem(slotKeyFor(slot, retention));
      const occupant = slotOwnerIn(raw, retention);
      if (!occupant) {
        if (empty === null) {
          empty = slot;
          emptyGeneration = recordGenerationIn(raw, retention);
        }
        continue;
      }
      const entry = {
        id: occupant.id,
        slot,
        touched: occupant.touched,
        generation: occupant.generation,
      };
      const prior = actualByOwner.get(occupant.id);
      if (!prior || entry.touched >= prior.touched)
        actualByOwner.set(occupant.id, entry);
      if (
        !dirtyPinned.has(entry.id) &&
        !flushPinned.has(entry.id) &&
        (!oldestPhysical || entry.touched < oldestPhysical.touched)
      )
        oldestPhysical = entry;
    }
    const actual = [...actualByOwner.values()];
    const existing = actualByOwner.get(ownerId);
    if (existing) {
      const entry = {
        id: ownerId,
        slot: existing.slot,
        touched,
        generation: existing.generation || slotGeneration(existing),
      };
      try {
        storage.setItem(
          indexKey,
          JSON.stringify([
            ...actual.filter((item) => item.id !== ownerId),
            entry,
          ]),
        );
      } catch {}
      return entry;
    }
    const oldest = oldestPhysical;
    const slot = empty ?? oldest?.slot;
    if (slot === undefined) return null;
    if (oldest && slot === oldest.slot) {
      (retention === "local" ? s.localRecords : s.sessionRecords).delete(
        oldest.id,
      );
      (retention === "local" ? s.localSlots : s.sessionSlots).delete(oldest.id);
      if (retention === "session") s.releaseOwnerResources(oldest.id);
      if (retention === "local")
        try {
          storage.removeItem?.(
            LEGACY_PANE_PREFIX + encodeURIComponent(oldest.id),
          );
        } catch {}
    }
    const entry = {
      id: ownerId,
      slot,
      touched,
      generation: slotGeneration(
        oldest && oldest.slot === slot
          ? oldest
          : { generation: emptyGeneration },
      ),
    };
    const next = actual.filter(
      (item) => item.slot !== slot && item.id !== ownerId,
    );
    next.push(entry);
    try {
      storage.setItem(indexKey, JSON.stringify(next));
    } catch {}
    return entry;
  } catch {
    return null;
  }
}

export function removeFromOwnerIndexFor(
  s: UiStateStoreState,
  storage: StorageLike | null,
  retention: UiStateRetention,
  ownerId: string,
): void {
  if (!storage || ephemeralOwner(ownerId)) return;
  const indexKey =
    retention === "local" ? LOCAL_OWNER_INDEX_KEY : SESSION_OWNER_INDEX_KEY;
  try {
    let parsed = parseOwnerIndex(storage.getItem(indexKey));
    if (!parsed.valid) {
      repairSlotsFor(s, storage, retention, "");
      parsed = parseOwnerIndex(storage.getItem(indexKey));
    }
    const owners = parsed.entries.filter((item) => item.id !== ownerId);
    storage.setItem(indexKey, JSON.stringify(owners));
  } catch {}
}

export function writeOwnerFor(
  s: UiStateStoreState,
  ownerId: string,
  retention: UiStateRetention,
): void {
  const local = retention === "local";
  const dirty = local ? s.dirtyLocal : s.dirtySession;
  if (!dirty.has(ownerId)) return;
  const pending = local
    ? s.localRecords.get(ownerId)
    : s.sessionRecords.get(ownerId);
  if (!pending) return;
  if (encodeState(pending, retention) === null) return;
  const storage = local ? s.localStorage : s.sessionStorage;
  if (!storage) return;
  const markerKey = repairKeyFor(retention);
  const marker = JSON.stringify({
    owner: ownerId,
    token: `${Date.now()}:${Math.random()}`,
  });
  if (local) {
    s.repairedLocalMarker = null;
    s.trustedLocalIndex = null;
    s.localMisses.delete(ownerId);
  } else {
    s.repairedSessionMarker = null;
    s.trustedSessionIndex = null;
    s.sessionMisses.delete(ownerId);
  }
  try {
    storage.setItem(markerKey, marker);
  } catch {
    return;
  }
  const slot = reserveOwnerSlotFor(s, storage, retention, ownerId);
  if (!slot) return;
  // Invariant: Reservation may synchronously yield to another tab. Merge only
  // after it, minimizing the final unavoidable localStorage read/write window.
  const value = local
    ? mergedLocalFor(s, ownerId, pending as LocalState)
    : pending;
  const generation = slot.generation || slotGeneration();
  const raw = encodeState(value, retention, {
    id: ownerId,
    touched: slot.touched,
    generation,
  });
  if (raw === null) return;
  let alreadyOwned = false;
  try {
    alreadyOwned =
      slotOwnerIn(storage.getItem(slotKeyFor(slot.slot, retention)), retention)
        ?.id === ownerId;
  } catch {
    return;
  }
  try {
    // Invariant: Reserve may yield to another tab. Reassert this writer's token
    // directly before the authoritative slot commit so another writer can clear
    // only its own completed publication, never this remaining window.
    storage.setItem(markerKey, marker);
    storage.setItem(slotKeyFor(slot.slot, retention), raw);
    const scalarDirty = local
      ? s.dirtyLocalPane.has(ownerId)
      : s.dirtySessionComposer.has(ownerId);
    if (!alreadyOwned || scalarDirty) {
      const scalar = local
        ? { pane: { ...(value as LocalState).pane }, panes: {} }
        : { composer: { ...(value as SessionState).composer }, panes: {} };
      const scalarRaw = encodeState(scalar, retention, {
        id: ownerId,
        touched: slot.touched,
        generation,
      });
      if (scalarRaw === null)
        throw new Error("scalar state exceeds tier bound");
      storage.setItem(fieldKeyFor(slot.slot, retention, 0), scalarRaw);
    }
    const paneKeys = local
      ? s.dirtyLocalPaneStates.get(ownerId)
      : s.dirtySessionPaneStates.get(ownerId);
    const keys = !alreadyOwned
      ? Object.keys(value.panes)
      : [...(paneKeys || [])];
    const fieldMap = local ? s.localPaneFields : s.sessionPaneFields;
    for (const key of keys) {
      const item = value.panes[key];
      if (item)
        writePluginFieldFor(
          storage,
          retention,
          slot.slot,
          ownerId,
          generation,
          key,
          item,
          slot.touched,
          fieldMap.get(ownerId)?.get(key),
        );
    }
    (local ? s.localSlots : s.sessionSlots).set(ownerId, slot.slot);
    const indexKey = local ? LOCAL_OWNER_INDEX_KEY : SESSION_OWNER_INDEX_KEY;
    const agrees = () => {
      const parsed = parseOwnerIndex(storage.getItem(indexKey));
      return (
        parsed.valid &&
        parsed.entries.some(
          (item) => item.id === ownerId && item.slot === slot.slot,
        ) &&
        slotOwnerIn(
          storage.getItem(slotKeyFor(slot.slot, retention)),
          retention,
        )?.id === ownerId
      );
    };
    if (!agrees()) repairSlotsFor(s, storage, retention, ownerId);
    // Invariant: localStorage has no atomic compare-and-delete. Keep the single
    // bounded marker: readers cheaply recognize it as complete once index+slot
    // agree, while a newer writer's active token can never be deleted by this
    // one.
    if (local) {
      s.cacheLocal(ownerId, value as LocalState);
      s.dirtyLocalPane.delete(ownerId);
      s.dirtyLocalPaneStates.delete(ownerId);
    } else {
      s.cacheSession(ownerId, value as SessionState);
      s.dirtySessionComposer.delete(ownerId);
      s.dirtySessionPaneStates.delete(ownerId);
    }
    dirty.delete(ownerId);
  } catch {}
}
