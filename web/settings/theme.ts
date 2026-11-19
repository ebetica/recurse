// Picker sheets preview palettes immediately; custom CSS previews need Save.
// Pending saves survive reopening; closing discards unsaved CSS edits.
import { apiJson, jpost } from "../api.js";
import { CHECK_ICON } from "../icons.js";
import { applyTheme, setThemePreview } from "./themes.js";
import { settingsDetail } from "./layout.js";

let saves = Promise.resolve();
let revision = 0;
let saved: ThemeSettings;
let preview: ThemeSettings | undefined;
let saveProblems: string[] = [];
let updateSection: ((settings: ThemeSettings) => void) | undefined;
let cancelCssPreview: (() => void) | undefined;

/** Discard the editor's unsaved CSS before closing or rebuilding Settings. */
export function cancelThemeCssPreview(): void {
  cancelCssPreview?.();
}

interface ThemeSettings {
  theme: string;
  appearance: string;
  css: string;
  version: string;
  customCss?: string;
  custom: {
    name: string;
    background: string;
    foreground: string;
    palette: string[];
    css?: string;
  }[];
  problems: string[];
  themes: {
    name: string;
    css: string;
    customCss?: string;
    appearance: string;
    family: string;
    label: string;
    swatches: string[];
  }[];
}

export function buildThemeSection(body: HTMLElement): void {
  body.classList.add("settings-row-group");
  const cards = document.createElement("div");
  cards.className = "theme-cards";
  cards.setAttribute("role", "group");
  cards.setAttribute("aria-label", "Theme");
  const appearance = document.createElement("div");
  appearance.className = "theme-appearance";
  appearance.setAttribute("role", "group");
  appearance.setAttribute("aria-label", "Appearance");
  for (const value of ["system", "dark", "light"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sm";
    button.disabled = true;
    button.dataset.appearance = value;
    button.textContent = value[0]!.toUpperCase() + value.slice(1);
    button.addEventListener(
      "click",
      () => current && choose({ ...current, appearance: value }),
    );
    appearance.append(button);
  }
  const appearanceRow = document.createElement("div");
  appearanceRow.className = "group";
  const appearanceItem = document.createElement("div");
  appearanceItem.className = "item";
  appearanceItem.append(appearance);
  appearanceRow.append(appearanceItem);
  const appearanceBody = document.createElement("div");
  const themeBody = document.createElement("div");
  appearanceBody.append(appearanceRow);
  themeBody.append(cards);
  const cssBody = document.createElement("div");
  cssBody.hidden = true;
  cssBody.innerHTML = `
    <label class="field">Custom CSS<textarea name="custom-css" rows="12" maxlength="50000" spellcheck="false"></textarea></label>
    <p class="muted">Custom CSS pauses for protected controls and side conversations.</p>
    <div class="actions"><button type="button" class="primary">Save</button><button type="button" class="secondary">Cancel</button></div>`;
  const cssInput = cssBody.querySelector("textarea")!;
  const [cssSave, cssCancel] = cssBody.querySelectorAll("button");
  let cssTheme: string | undefined;
  let cssDirty = false;
  let cssSaving = false;
  body.append(appearanceBody, themeBody, cssBody);
  const messages = [body, appearanceBody, themeBody, cssBody].map((parent) => {
    const message = document.createElement("p");
    message.className = "msg err";
    message.setAttribute("role", "alert");
    message.hidden = true;
    parent.append(message);
    return message;
  });
  let current: ThemeSettings | undefined;
  const appearanceDetail = settingsDetail(appearanceBody, "Appearance", () =>
    current
      ? current.appearance[0]!.toUpperCase() + current.appearance.slice(1)
      : "Loading…",
  );
  const themeDetail = settingsDetail(
    themeBody,
    "Theme",
    () =>
      current?.themes.find((theme) => theme.name === current?.theme)?.label ??
      current?.theme ??
      "Loading…",
  );
  const cssDetail = settingsDetail(cssBody, "Custom CSS");
  const cssControls = () => {
    cssInput.disabled = cssSaving;
    cssSave!.disabled = cssCancel!.disabled = !cssDirty || cssSaving;
  };
  const previewCss = () => {
    if (!current || !cssDirty) return;
    setThemePreview(true);
    applyTheme({ ...current, customCss: cssInput.value });
  };
  cssInput.addEventListener("input", () => {
    const custom = current?.custom?.find((item) => item.name === cssTheme);
    cssDirty = cssInput.value !== (custom?.css ?? "");
    setThemePreview(cssDirty || !!preview);
    if (current) applyTheme({ ...current, customCss: cssInput.value });
    cssControls();
  });
  cancelCssPreview = () => {
    if (!cssDirty) return;
    cssDirty = false;
    if (cssSaving) return;
    const settings = preview ?? saved;
    setThemePreview(!!preview);
    if (settings) {
      applyTheme(settings);
      paint(settings);
    }
  };
  cssCancel!.onclick = cancelThemeCssPreview;
  cssSave!.onclick = () => {
    if (!current || !cssDirty || cssSaving) return;
    const customCss = cssInput.value;
    const custom = current.custom.map((item) =>
      item.name === cssTheme ? { ...item, css: customCss } : item,
    );
    persist(
      {
        ...current,
        custom,
        customCss,
        themes: current.themes.map((item) =>
          item.name === cssTheme ? { ...item, customCss } : item,
        ),
      },
      { custom },
      true,
    );
  };
  const cssEditor = cssBody.querySelector("dialog")!;
  cssEditor.addEventListener("close", () => {
    if (!cssEditor.open) cancelThemeCssPreview();
  });
  const showProblems = (problems: string[]) => {
    for (const message of messages) {
      message.textContent = problems.join(" ");
      message.hidden = !problems.length;
    }
  };
  const paint = (settings: ThemeSettings) => {
    current = settings;
    appearanceDetail.refresh();
    themeDetail.refresh();
    const custom = settings.custom?.find(
      (item) => item.name === settings.theme,
    );
    cssBody.hidden = !custom;
    if (cssTheme !== custom?.name) {
      cssTheme = custom?.name;
      cssDirty = false;
      cssDetail.close();
    }
    if (!cssDirty) cssInput.value = custom?.css ?? "";
    cssControls();
    showProblems(settings.problems);
    if (!cards.childElementCount) {
      for (const theme of settings.themes) {
        if (theme.name !== theme.family) continue;
        const variants = settings.themes.filter(
          (item) => item.family === theme.family,
        );
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.theme = theme.name;
        button.title = theme.label;
        button.textContent = button.title;
        if (theme.css) button.style.cssText = theme.css.slice(6, -1);
        const check = document.createElement("span");
        check.className = "theme-card-check";
        check.innerHTML = CHECK_ICON;
        button.append(check);
        const preview = document.createElement("span");
        preview.className = "theme-card-preview";
        preview.setAttribute("aria-hidden", "true");
        for (const variant of variants) {
          const half = document.createElement("span");
          half.className = "theme-card-variant";
          half.style.cssText = variant.css.slice(6, -1);
          const bubble = document.createElement("span");
          bubble.className = "theme-card-bubble";
          bubble.textContent = "Aa";
          const row = document.createElement("span");
          row.className = "theme-card-swatches";
          for (const color of variant.swatches) {
            const swatch = document.createElement("span");
            swatch.style.backgroundColor = color;
            row.append(swatch);
          }
          half.append(bubble, row);
          preview.append(half);
        }
        button.append(preview);
        button.addEventListener(
          "click",
          () =>
            current &&
            choose({
              ...current,
              theme: theme.name,
              appearance:
                variants.length === 1 ? theme.appearance : current.appearance,
            }),
        );
        cards.append(button);
      }
    }
    for (const button of cards.querySelectorAll("button")) {
      const name = button.dataset.theme;
      button.setAttribute("aria-pressed", String(name === settings.theme));
    }
    const variants = settings.themes.filter(
      (theme) => theme.family === settings.theme,
    );
    appearance.setAttribute("aria-disabled", String(variants.length === 1));
    for (const button of appearance.querySelectorAll("button")) {
      const selected = button.dataset.appearance === settings.appearance;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = variants.length === 1 || selected;
    }
  };
  updateSection = (settings) => {
    if (!body.isConnected) return;
    paint(settings);
    previewCss();
    if (saveProblems.length) showProblems(saveProblems);
  };
  const choose = (next: ThemeSettings) => {
    cancelThemeCssPreview();
    const variants = next.themes.filter((theme) => theme.family === next.theme);
    const dark =
      variants.find((theme) => theme.appearance === "dark") ?? variants[0]!;
    const light =
      variants.find((theme) => theme.appearance === "light") ?? variants[0]!;
    const css =
      next.appearance === "system"
        ? `${dark.css}@media (prefers-color-scheme: light){${light.css}}`
        : (next.appearance === "light" ? light : dark).css;
    const customCss = next.themes.find(
      (theme) => theme.name === next.theme,
    )?.customCss;
    persist(
      { ...next, css, customCss, version: "" },
      { theme: next.theme, appearance: next.appearance },
    );
  };
  const persist = (next: ThemeSettings, values: object, cssEdit = false) => {
    const ownRevision = ++revision;
    cssSaving = cssEdit;
    preview = next;
    saveProblems = [];
    setThemePreview(true);
    applyTheme(next);
    paint(next);
    saves = saves.then(async () => {
      if (ownRevision !== revision) return;
      let definitive = false;
      try {
        const response = await jpost("/api/settings/theme", values);
        definitive = response.status >= 400 && response.status < 500;
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.detail || "Couldn't save theme.");
        saved = data;
        if (ownRevision !== revision) return;
        preview = undefined;
        if (cssEdit) cssDirty = false;
        cssSaving = false;
        setThemePreview(false);
        applyTheme(data);
        updateSection?.(data);
      } catch (error) {
        if (ownRevision !== revision) return;
        cssSaving = false;
        if (definitive || cssEdit) {
          preview = undefined;
          setThemePreview(false);
          applyTheme(saved);
        }
        saveProblems = [
          error instanceof Error ? error.message : "Couldn't save theme.",
        ];
        updateSection?.(preview ?? saved);
      }
    });
  };
  const loadRevision = revision;
  const loadSaved = saved;
  void apiJson<ThemeSettings>(
    "/api/settings/theme",
    { cache: "no-store" },
    { timeoutMs: 8_000 },
  )
    .then(({ response, data }) => {
      if (!response.ok) throw new Error("Couldn't load themes.");
      if (!preview && loadRevision === revision && loadSaved === saved)
        saved = data;
      paint(preview ?? saved ?? data);
      if (saveProblems.length) showProblems(saveProblems);
    })
    .catch(() =>
      showProblems(["Couldn't load themes. Reopen Settings to try again."]),
    );
}
