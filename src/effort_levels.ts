// Effort range shared by the server, browser, and bundled CLI.
export const EFFORT_MIN_LEVEL = 1;
export const EFFORT_MAX_LEVEL = 6;
export const DEFAULT_EFFORT_LEVEL = 3;
export const EFFORT_LEVEL_RANGE = `${EFFORT_MIN_LEVEL}-${EFFORT_MAX_LEVEL}`;
export const EFFORT_LEVELS = Array.from(
  { length: EFFORT_MAX_LEVEL - EFFORT_MIN_LEVEL + 1 },
  (_, index) => EFFORT_MIN_LEVEL + index,
);
// Older backends and Settings clients only support levels through 5.
export const LEGACY_EFFORT_MAX_LEVEL = 5;
export const OPTIONAL_EFFORT_LEVELS = EFFORT_LEVELS.filter(
  (level) => level > LEGACY_EFFORT_MAX_LEVEL,
);

export function isEffortLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EFFORT_MIN_LEVEL &&
    value <= EFFORT_MAX_LEVEL
  );
}
