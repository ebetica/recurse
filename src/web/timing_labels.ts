// Shared log-label vocabulary: shell ids and element kinds, never user content.
export const TIMING_TARGETS =
  "settings-btn settings-close menu-btn new-top pane-fab up-top input send attach file-input scroll-btn safety-btn context-indicator model-trigger effort-range agent-finder-query trash-btn takeover-btn up-btn prompt-close context-close button textarea select a summary div span document".split(
    " ",
  );
export const STALL_MARKERS = [
  "backends-change",
  "tree-authoritative",
  "stream-batch",
] as const;
export const REMOTE_STATUSES = [
  "loading",
  "connected",
  "unreachable",
  "key revoked",
  "incompatible version",
];
export type UiStall = {
  label: "main_thread_blocked";
  ms: number;
  conversation_id: string;
  trace_id: string;
  held_rows: number;
  rendered_rows: number;
  remote_count: number;
  remote_statuses: string[];
  composer_focused: boolean;
  embedded: boolean;
  markers: { name: string; at: number }[];
  scripts: { sourceURL: string; sourceFunctionName: string }[];
};
export function sanitizeStall(item: UiStall, origin: string) {
  const count = (value: number) =>
    Number.isFinite(value)
      ? Math.max(0, Math.min(1_000_000, Math.round(value)))
      : 0;
  return {
    held_rows: count(item.held_rows),
    rendered_rows: count(item.rendered_rows),
    remote_count: count(item.remote_count),
    composer_focused: item.composer_focused === true,
    embedded: item.embedded === true,
    remote_statuses: Array.isArray(item.remote_statuses)
      ? item.remote_statuses
          .slice(0, 16)
          .filter((s) => REMOTE_STATUSES.includes(s))
      : [],
    markers: Array.isArray(item.markers)
      ? item.markers
          .slice(-8)
          .filter((m) => m && STALL_MARKERS.some((name) => name === m.name))
          .map((m) => ({ name: m.name, at: count(m.at) }))
      : [],
    scripts: Array.isArray(item.scripts)
      ? item.scripts.slice(0, 3).map((s) => {
          let sourceURL = "";
          try {
            const url = new URL(
              typeof s?.sourceURL === "string" ? s.sourceURL : "",
              origin,
            );
            if (s?.sourceURL && url.origin === origin)
              sourceURL = url.pathname.slice(0, 240);
          } catch {}
          return {
            sourceURL,
            sourceFunctionName:
              typeof s?.sourceFunctionName === "string"
                ? s.sourceFunctionName.replace(/[^\w.$<> -]/g, "").slice(0, 80)
                : "",
          };
        })
      : [],
  };
}
export const TIMING_EVENTS = ["click", "keydown", "pointerdown", "change"];
export const TIMING_STAGES = [
  "cold:tree-read",
  "cold:focused-read",
  "cold:first-turn-painted",
  "conversation-switch",
  "wake:painted",
  "drawing-editor-open",
];
