// Pure ownership rule shared by capture-phase composer dispatch and the
// target-level skill menu listener.
export function skillMenuOwnsKey(
  open: boolean,
  hasMatches: boolean,
  key: string,
  shiftKey: boolean,
): boolean {
  return (
    open &&
    (key === "Escape" ||
      (hasMatches &&
        (key === "ArrowDown" ||
          key === "ArrowUp" ||
          key === "Tab" ||
          (key === "Enter" && !shiftKey))))
  );
}

// After an accepted command runs, drop the typed "/partial" token unless the
// runner rewrote the composer itself (for example /btw sets "/btw "); a
// rewritten value is kept. Returns the range to clear, or null.
export function commandTokenToClear(
  valueBefore: string,
  valueAfter: string,
  token: { start: number; end: number },
): { start: number; end: number } | null {
  return valueAfter === valueBefore ? token : null;
}
