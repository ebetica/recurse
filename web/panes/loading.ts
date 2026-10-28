export interface PaneLoadingSurface {
  classList: Pick<DOMTokenList, "toggle">;
  setAttribute(name: string, value: string): void;
  inert: boolean;
}

export function setPaneLoading(
  element: PaneLoadingSurface,
  loading: boolean,
): void {
  element.classList.toggle("pane-loading", loading);
  element.setAttribute("aria-busy", String(loading));
  const body = element as PaneLoadingSurface & Partial<HTMLElement>;
  const parent = body.parentElement;
  const active =
    typeof document === "undefined" ? null : document.activeElement;
  const controls = parent?.querySelector<HTMLElement>(
    ".pane-powerbar-controls",
  );
  if (
    loading &&
    active &&
    (body.contains?.(active) || controls?.contains(active))
  )
    parent?.querySelector<HTMLElement>(".pane-title")?.focus();
  element.inert = loading;
  if (controls) controls.inert = loading;
  const status = parent?.querySelector<HTMLElement>(".pane-loading-status");
  if (status) status.textContent = loading ? "Loading panel…" : "";
}
