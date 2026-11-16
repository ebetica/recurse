/** Live theme overrides shared by the version probe and Settings. */
import { apiJson } from "../api.js";
import { applyCustomThemeCss } from "./theme-css.js";

/** Version polls must not undo an unsaved local preview. */
export let themePreviewActive = false;
let themeRevision = 0;
const initialCustomCss = document.getElementById("theme")?.dataset.customCss;
if (initialCustomCss) applyCustomThemeCss(initialCustomCss);
export function setThemePreview(active: boolean): void {
  themeRevision++;
  themePreviewActive = active;
}

export function applyTheme(theme: {
  css: string;
  customCss?: string;
  version: string;
}): void {
  const style = document.getElementById("theme");
  if (!style) return;
  style.textContent = theme.css;
  style.dataset.version = theme.version;
  applyCustomThemeCss(theme.customCss ?? "");
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
  const { response, data } = await apiJson<{
    css: string;
    customCss?: string;
    version: string;
  }>(
    "/api/settings/theme",
    { cache: "no-store", signal },
    { availability: "optional", timeoutMs: 8_000 },
  );
  if (response.ok && !themePreviewActive && revision === themeRevision)
    applyTheme(data);
}
