// Preview server palettes immediately; ordered saves survive reopening.
import { apiJson, jpost } from "../api.js";
import { CHECK_ICON } from "../icons.js";
import { applyTheme, setThemePreview } from "./themes.js";

let saves = Promise.resolve();
let revision = 0;
let saved: ThemeSettings;
let preview: ThemeSettings | undefined;
let saveProblems: string[] = [];
let updateSection: ((settings: ThemeSettings) => void) | undefined;

interface ThemeSettings {
  theme: string;
  appearance: string;
  css: string;
  version: string;
  problems: string[];
  themes: {
    name: string;
    css: string;
    appearance: string;
    family: string;
    label: string;
    swatches: string[];
  }[];
}

export function buildThemeSection(body: HTMLElement): void {
  const cards = document.createElement("div");
  cards.className = "theme-cards";
  cards.setAttribute("role", "group");
  cards.setAttribute("aria-label", "Theme");
  const message = document.createElement("p");
  message.className = "msg err";
  message.setAttribute("role", "alert");
  message.hidden = true;
  const appearance = document.createElement("div");
  appearance.className = "theme-appearance";
  appearance.setAttribute("role", "group");
  appearance.setAttribute("aria-label", "Appearance");
  appearance.append("Appearance:");
  for (const value of ["system", "dark", "light"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sm";
    button.disabled = true;
    button.dataset.appearance = value;
    button.textContent = value[0]!.toUpperCase() + value.slice(1);
    button.addEventListener("click", () =>
      choose({ ...current, appearance: value }),
    );
    appearance.append(button);
  }
  body.append(appearance, cards, message);
  let current: ThemeSettings;
  const showProblems = (problems: string[]) => {
    message.textContent = problems.join(" ");
    message.hidden = !problems.length;
  };
  const paint = (settings: ThemeSettings) => {
    current = settings;
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
        button.addEventListener("click", () =>
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
    if (saveProblems.length) showProblems(saveProblems);
  };
  const choose = (next: ThemeSettings) => {
    const variants = next.themes.filter((theme) => theme.family === next.theme);
    const dark =
      variants.find((theme) => theme.appearance === "dark") ?? variants[0]!;
    const light =
      variants.find((theme) => theme.appearance === "light") ?? variants[0]!;
    const css =
      next.appearance === "system"
        ? `${dark.css}@media (prefers-color-scheme: light){${light.css}}`
        : (next.appearance === "light" ? light : dark).css;
    const ownRevision = ++revision;
    preview = next;
    saveProblems = [];
    setThemePreview(true);
    applyTheme({ css, version: "" });
    paint(next);
    const values = { theme: next.theme, appearance: next.appearance };
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
        setThemePreview(false);
        applyTheme(data);
        updateSection?.(data);
      } catch (error) {
        if (ownRevision !== revision) return;
        if (definitive) {
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
