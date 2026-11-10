// Bounded device-local pane history, ranked by decaying opening frequency.

const STORAGE_KEY = "recurse.pane-history";
const LIMIT = 32;
const WEEK = 7 * 24 * 60 * 60 * 1000;
interface Visit {
  id: string;
  count: number;
  time: number;
}

function visits(): Visit[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .slice(0, LIMIT)
      .filter(
        (entry): entry is Visit =>
          entry &&
          typeof entry.id === "string" &&
          entry.id.length <= 80 &&
          Number.isFinite(entry.count) &&
          entry.count > 0 &&
          entry.count <= 1000 &&
          Number.isFinite(entry.time) &&
          entry.time > 0 &&
          entry.time <= Date.now(),
      );
  } catch {
    return [];
  }
}

export function paneFrecency(): Map<string, number> {
  const now = Date.now();
  return new Map(
    visits().map((entry) => [
      entry.id,
      entry.count * 0.5 ** ((now - entry.time) / WEEK),
    ]),
  );
}

export function recordPaneOpen(id: string): void {
  const now = Date.now();
  const entries = visits().filter((entry) => entry.id !== id);
  entries.unshift({
    id,
    count: Math.min(1000, (paneFrecency().get(id) || 0) + 1),
    time: now,
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, LIMIT)));
  } catch {
    return;
  }
}
