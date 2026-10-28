/** Live theme overrides shared by the version probe and Settings. */
import { apiJson } from "../api.js";

/** Version polls must not undo an unsaved local preview. */
export let themePreviewActive = false;
let themeRevision = 0;
export function setThemePreview(active: boolean): void {
  themeRevision++;
  themePreviewActive = active;
}

export function applyTheme(theme: { css: string; version: string }): void {
  const style = document.getElementById("theme");
  if (!style) return;
  style.textContent = theme.css;
  style.dataset.version = theme.version;
  window.dispatchEvent(new Event("recurse:theme-changed"));
}

export async function refreshTheme(
  version?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (
    themePreviewActive ||
    !version ||
    document.getElementById("theme")?.dataset.version === version
  )
    return;
  const revision = themeRevision;
  const { response, data } = await apiJson<{ css: string; version: string }>(
    "/api/settings/theme",
    { cache: "no-store", signal },
    { availability: "optional", timeoutMs: 8_000 },
  );
  if (response.ok && !themePreviewActive && revision === themeRevision)
    applyTheme(data);
}
