// Parses untrusted conversation view-state records with bounded encoding.
// Strict field/index validation and plugin overlays use safe fallbacks; storage
// I/O belongs to persistence.ts.
import {
  MAX_COMPOSER_DRAFT_CHARS,
  MAX_LOCAL_RECORD_CHARS,
  MAX_PANE_STATES,
  MAX_PLUGIN_STATE_CHARS,
  MAX_RETAINED_OWNERS,
  MAX_SESSION_RECORD_CHARS,
  defaultComposer,
  defaultLocalState,
  defaultSessionState,
  ephemeralOwner,
  fieldKeyFor,
  jsonClone,
  validBoundedString,
  validOwnerId,
  validStateKey,
  type ComposerViewState,
  type ConversationUiState,
  type LocalState,
  type PaneVisibility,
  type SessionState,
  type StorageLike,
  type StoredPaneState,
  type UiStateRetention,
} from "./schema.js";

export function parsePane(value: unknown): PaneVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "default" };
  const pane = value as Record<string, unknown>;
  if (pane.kind === "closed") {
    return validBoundedString(pane.lastId)
      ? { kind: "closed", lastId: pane.lastId }
      : { kind: "closed" };
  }
  if (pane.kind === "open" && validBoundedString(pane.id)) {
    return {
      kind: "open",
      id: pane.id,
      lastId: validBoundedString(pane.lastId) ? pane.lastId : pane.id,
    };
  }
  return { kind: "default" };
}

export function parseComposer(value: unknown): ComposerViewState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return defaultComposer();
  const composer = value as Record<string, unknown>;
  if (
    typeof composer.text !== "string" ||
    composer.text.length > MAX_COMPOSER_DRAFT_CHARS
  )
    return defaultComposer();
  const length = composer.text.length;
  const bounded = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isInteger(candidate)
      ? Math.max(0, Math.min(length, candidate))
      : fallback;
  const start = bounded(composer.selectionStart, length);
  const end = bounded(composer.selectionEnd, start);
  return {
    text: composer.text,
    selectionStart: Math.min(start, end),
    selectionEnd: Math.max(start, end),
  };
}

export function parsePaneStates(
  value: unknown,
): Record<string, StoredPaneState> {
  const result: Record<string, StoredPaneState> = Object.create(null) as Record<
    string,
    StoredPaneState
  >;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  let accepted = 0;
  for (const [key, candidate] of Object.entries(value)) {
    if (
      accepted >= MAX_PANE_STATES ||
      !validStateKey(key) ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      continue;
    const item = candidate as Record<string, unknown>;
    if (!Number.isInteger(item.version) || (item.version as number) < 1)
      continue;
    const normalized = jsonClone(item.value);
    if (normalized === undefined) continue;
    result[key] = { version: item.version as number, value: normalized };
    accepted++;
  }
  return result;
}

export function parseRecord(
  raw: string | null,
  retention: UiStateRetention,
): LocalState | SessionState | null {
  if (raw === null) return null;
  const max =
    retention === "local" ? MAX_LOCAL_RECORD_CHARS : MAX_SESSION_RECORD_CHARS;
  if (raw.length > max)
    return retention === "local" ? defaultLocalState() : defaultSessionState();
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).version !== 1
    )
      return retention === "local"
        ? defaultLocalState()
        : defaultSessionState();
    const record = value as Record<string, unknown>;
    if (retention === "local")
      return {
        pane: parsePane(record.pane),
        panes: parsePaneStates(record.panes),
      };
    return {
      composer: parseComposer(record.composer),
      panes: parsePaneStates(record.panes),
    };
  } catch {
    return retention === "local" ? defaultLocalState() : defaultSessionState();
  }
}

export function parseLocalUiState(
  raw: string | null,
): Pick<ConversationUiState, "pane" | "localPanes"> | null {
  const parsed = parseRecord(raw, "local") as LocalState | null;
  return parsed ? { pane: parsed.pane, localPanes: parsed.panes } : null;
}

export function parseSessionUiState(
  raw: string | null,
): Pick<ConversationUiState, "composer" | "sessionPanes"> | null {
  const parsed = parseRecord(raw, "session") as SessionState | null;
  return parsed
    ? { composer: parsed.composer, sessionPanes: parsed.panes }
    : null;
}

export function clonePaneStates(
  value: Record<string, StoredPaneState>,
): Record<string, StoredPaneState> {
  const result: Record<string, StoredPaneState> = Object.create(null) as Record<
    string,
    StoredPaneState
  >;
  for (const [key, item] of Object.entries(value)) {
    const cloned = jsonClone(item.value);
    if (cloned !== undefined)
      result[key] = { version: item.version, value: cloned };
  }
  return result;
}

export function encodeState(
  value: LocalState | SessionState,
  retention: UiStateRetention,
  slotOwner?: { id: string; touched: number; generation?: string },
): string | null {
  const local = retention === "local";
  const record = local
    ? {
        version: 1,
        ...(slotOwner
          ? {
              owner: slotOwner.id,
              touched: slotOwner.touched,
              ...(slotOwner.generation
                ? { generation: slotOwner.generation }
                : {}),
            }
          : {}),
        pane: (value as LocalState).pane,
        ...(Object.keys((value as LocalState).panes).length
          ? { panes: (value as LocalState).panes }
          : {}),
      }
    : {
        version: 1,
        ...(slotOwner
          ? {
              owner: slotOwner.id,
              touched: slotOwner.touched,
              ...(slotOwner.generation
                ? { generation: slotOwner.generation }
                : {}),
            }
          : {}),
        ...((value as SessionState).composer.text
          ? { composer: (value as SessionState).composer }
          : {}),
        ...(Object.keys((value as SessionState).panes).length
          ? { panes: (value as SessionState).panes }
          : {}),
      };
  try {
    const raw = JSON.stringify(record);
    const max = local ? MAX_LOCAL_RECORD_CHARS : MAX_SESSION_RECORD_CHARS;
    return raw.length <= max ? raw : null;
  } catch {
    return null;
  }
}

export interface OwnerSlot {
  id: string;
  slot: number;
  touched: number;
  generation?: string;
}
export interface ParsedOwnerIndex {
  valid: boolean;
  entries: OwnerSlot[];
}
export interface PluginFieldRecord extends StoredPaneState {
  owner: string;
  touched: number;
  key: string;
  generation: string;
}

export function slotGeneration(prior?: { generation?: string } | null): string {
  // Invariant: Same observed incarnation converges across racing tabs. Reuse
  // increments a bounded physical slot epoch, so an old field can never match a
  // later owner.
  const epoch = Number(prior?.generation || 0);
  return String(Number.isSafeInteger(epoch) && epoch >= 0 ? epoch + 1 : 1);
}

export function parsePluginField(
  raw: string | null,
  ownerId: string,
  generation: string,
): PluginFieldRecord | null {
  if (!raw || raw.length > MAX_PLUGIN_STATE_CHARS + 1_024) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const key = value.key;
    if (
      value.schema !== 1 ||
      value.owner !== ownerId ||
      value.generation !== generation ||
      typeof key !== "string" ||
      !validStateKey(key) ||
      typeof value.version !== "number" ||
      !Number.isInteger(value.version) ||
      value.version < 1 ||
      typeof value.touched !== "number" ||
      !Number.isFinite(value.touched)
    )
      return null;
    const cloned = jsonClone(value.value);
    if (
      cloned === undefined ||
      JSON.stringify(cloned).length > MAX_PLUGIN_STATE_CHARS
    )
      return null;
    return {
      owner: ownerId,
      touched: value.touched,
      key,
      generation,
      version: value.version,
      value: cloned,
    };
  } catch {
    return null;
  }
}

export function pluginBucket(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % MAX_PANE_STATES;
}

export function parseOwnerIndex(raw: string | null): ParsedOwnerIndex {
  if (raw === null) return { valid: true, entries: [] };
  if (raw.length > MAX_LOCAL_RECORD_CHARS) return { valid: false, entries: [] };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return { valid: false, entries: [] };
    const result: OwnerSlot[] = [];
    const ids = new Set<string>(),
      slots = new Set<number>();
    let valid = value.length <= MAX_RETAINED_OWNERS * 2;
    // Invariant: Only the newest bounded suffix matters; never walk an
    // attacker-sized list.
    for (const candidate of value.slice(-MAX_RETAINED_OWNERS * 2)) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        valid = false;
        continue;
      }
      const item = candidate as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        !validOwnerId(item.id) ||
        ephemeralOwner(item.id) ||
        typeof item.slot !== "number" ||
        !Number.isInteger(item.slot) ||
        item.slot < 0 ||
        item.slot >= MAX_RETAINED_OWNERS ||
        typeof item.touched !== "number" ||
        !Number.isFinite(item.touched) ||
        ids.has(item.id) ||
        slots.has(item.slot)
      ) {
        valid = false;
        continue;
      }
      ids.add(item.id);
      slots.add(item.slot);
      result.push({ id: item.id, slot: item.slot, touched: item.touched });
    }
    return { valid, entries: result.slice(-MAX_RETAINED_OWNERS) };
  } catch {
    return { valid: false, entries: [] };
  }
}

// Reads the owner marker of one slot record without trusting it.
export function slotOwnerIn(
  raw: string | null,
  retention: UiStateRetention,
): { id: string; touched: number; generation?: string } | null {
  const max =
    retention === "local" ? MAX_LOCAL_RECORD_CHARS : MAX_SESSION_RECORD_CHARS;
  if (!raw || raw.length > max) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value.owner === "string" &&
      validOwnerId(value.owner) &&
      typeof value.touched === "number" &&
      Number.isFinite(value.touched) &&
      (value.generation === undefined ||
        (typeof value.generation === "string" &&
          value.generation.length <= 512))
      ? {
          id: value.owner,
          touched: value.touched,
          ...(typeof value.generation === "string"
            ? { generation: value.generation }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}

// Reads only the physical slot epoch of a record, for generation reuse.
export function recordGenerationIn(
  raw: string | null,
  retention: UiStateRetention,
): string | undefined {
  const max =
    retention === "local" ? MAX_LOCAL_RECORD_CHARS : MAX_SESSION_RECORD_CHARS;
  if (!raw || raw.length > max) return undefined;
  try {
    const generation = (JSON.parse(raw) as Record<string, unknown>).generation;
    return typeof generation === "string" && generation.length <= 512
      ? generation
      : undefined;
  } catch {
    return undefined;
  }
}

// Overlays scalar and plugin field subslots onto a loaded value. The base slot
// remains a valid fallback when any subslot is missing or untrusted.
export function overlaySlotFields(
  storage: StorageLike | null,
  retention: UiStateRetention,
  slot: number,
  ownerId: string,
  generation: string,
  value: LocalState | SessionState,
): void {
  if (!storage) return;
  try {
    const scalarRaw = storage.getItem(fieldKeyFor(slot, retention, 0));
    const scalar = parseRecord(scalarRaw, retention);
    if (scalar) {
      const scalarOwner = slotOwnerIn(scalarRaw, retention);
      if (
        scalarOwner?.id === ownerId &&
        scalarOwner.generation === generation
      ) {
        if (retention === "local")
          (value as LocalState).pane = (scalar as LocalState).pane;
        else
          (value as SessionState).composer = (scalar as SessionState).composer;
      }
    }
    const newest = new Map<string, PluginFieldRecord>();
    for (let field = 1; field <= MAX_PANE_STATES; field++) {
      const item = parsePluginField(
        storage.getItem(fieldKeyFor(slot, retention, field)),
        ownerId,
        generation,
      );
      if (!item) continue;
      const prior = newest.get(item.key);
      if (!prior || item.touched >= prior.touched) newest.set(item.key, item);
    }
    for (const item of newest.values())
      value.panes[item.key] = {
        version: item.version,
        value: jsonClone(item.value),
      };
  } catch {}
}
