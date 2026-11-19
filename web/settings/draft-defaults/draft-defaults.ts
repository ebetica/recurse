// DOM-free browser preferences. Settings reads and writes these only when its
// controls open/change; draft creation takes one snapshot rather than
// consulting storage again during send retries.
interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MUTE_SUBAGENTS_BY_DEFAULT_KEY = "recurse.muteSubagentsByDefault";

function muteSubagentsByDefault(storage?: PreferenceStorage): boolean {
  try {
    const target = storage ?? localStorage;
    const stored = target.getItem(MUTE_SUBAGENTS_BY_DEFAULT_KEY);
    if (stored === null) return true;
    const value: unknown = JSON.parse(stored);
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}

export function snapshotNewSubagentDefaults(storage?: PreferenceStorage): {
  muted: boolean;
} {
  return { muted: muteSubagentsByDefault(storage) };
}
