// The complete non-secret settings-sync inventory. Each kind owns its public
// projection and existing POST body; credentials and MCP are never included.
type Data = Record<string, any>;
interface Kind {
  path: string;
  values(data: any): Data;
  body(key: string, after: unknown, current: any): unknown;
  title(key: string): string;
  model?(key: string, value: any): string | undefined;
}
export const SYNC_KINDS: readonly Kind[] = [
  {
    path: "/api/settings/effort-levels",
    values: (data) => ({ ...data.levels, default_level: data.default_level }),
    body: (key, after, current) => ({
      levels:
        key === "default_level"
          ? current.levels
          : { ...current.levels, [key]: after },
      default_level: key === "default_level" ? after : current.default_level,
    }),
    title: (key) =>
      key === "default_level" ? "Default effort level" : `Effort ${key}`,
    model: (key, value) => (key === "default_level" ? undefined : value.model),
  },
  {
    path: "/api/settings/default-efforts",
    values: (data) => {
      if (
        !data.efforts ||
        typeof data.efforts !== "object" ||
        Array.isArray(data.efforts)
      )
        throw new Error("Complete default efforts unavailable");
      return { value: { efforts: data.efforts } };
    },
    body: (_key, after) => after,
    title: () => "Default efforts",
  },
  {
    path: "/api/settings/maximum-context-window",
    values: (data) => ({
      value: { maximum_context_window: data.maximum_context_window },
    }),
    body: (_key, after) => after,
    title: () => "Maximum context window",
  },
  {
    path: "/api/settings/theme",
    values: (data) => ({
      value: Object.fromEntries(
        ["theme", "dark", "light", "appearance", "custom"].map((key) => [
          key,
          data[key],
        ]),
      ),
    }),
    body: (_key, after) => after,
    title: () => "Theme",
  },
];
export const SYNC_PATHS = SYNC_KINDS.map((kind) => kind.path);
export interface SyncItem {
  item: string;
  path: string;
  key?: string;
  before: unknown;
  after: unknown;
  status: "same" | "change" | "unusable" | "not synced";
  reason: string;
}
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}
