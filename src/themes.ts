// Pi palettes generate web tokens; themes.json selects family/appearance.
// Operator bubbles keep Pi lightness/hue with capped chroma.
// Legacy theme values remain readable; custom palettes are singles.
// Report invalid entries; atomic writes retain unknown keys.
import {
  colorToHex,
  colorToOklch,
  colorToRgb,
  mixColors,
  oklchColor,
  parseColor,
} from "@earendil-works/pi-tui";
import builtins from "./themes/palettes.json";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ThemePalette {
  name: string;
  background: string;
  foreground: string;
  palette: string[];
}
type Generator = (input: {
  background: ReturnType<typeof colorToRgb>;
  foreground: ReturnType<typeof colorToRgb>;
  palette: ReturnType<typeof colorToRgb>[];
}) => { colors: Record<string, string | number>; appearance: "dark" | "light" };
const { generateSystemThemeColors, wcagContrast, terminalAppearance } =
  (await import(
    new URL(
      "./modes/interactive/theme/system-theme.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href
  )) as {
    generateSystemThemeColors: Generator;
    terminalAppearance: (
      background: ReturnType<typeof colorToRgb>,
      foreground: ReturnType<typeof colorToRgb>,
    ) => "dark" | "light";
    wcagContrast: (
      first: ReturnType<typeof colorToRgb>,
      second: ReturnType<typeof colorToRgb>,
    ) => number;
  };
export const themePalettes: ThemePalette[] = builtins.themes;

/** Expose Pi roles; terminal-default text uses the palette foreground. */
export function generatePaletteColors(palette: ThemePalette) {
  const rgb = (value: string) => colorToRgb(parseColor(value));
  const result = generateSystemThemeColors({
    background: rgb(palette.background),
    foreground: rgb(palette.foreground),
    palette: palette.palette.map(rgb),
  });
  return {
    appearance: result.appearance,
    colors: Object.fromEntries(
      Object.entries(result.colors).map(([key, value]) => [
        key,
        value === "" ? palette.foreground : colorToHex(parseColor(value)),
      ]),
    ),
  };
}

/** Cartesian interpolation preserves neutral surfaces without hue swings. */
function mix(first: string, second: string, amount: number): string {
  const a = colorToOklch(parseColor(first)),
    b = colorToOklch(parseColor(second));
  const angle = (h: number) => (h * Math.PI) / 180;
  const x =
    a.c * Math.cos(angle(a.h)) * (1 - amount) +
    b.c * Math.cos(angle(b.h)) * amount;
  const y =
    a.c * Math.sin(angle(a.h)) * (1 - amount) +
    b.c * Math.sin(angle(b.h)) * amount;
  return colorToHex(
    oklchColor(
      a.l * (1 - amount) + b.l * amount,
      Math.hypot(x, y),
      (Math.atan2(y, x) * 180) / Math.PI,
    ),
  );
}

/** Pi's WCAG 2 contrast applied to web hex colours. */
export const contrast = (first: string, second: string): number =>
  wcagContrast(colorToRgb(parseColor(first)), colorToRgb(parseColor(second)));

/** Smallest panel separation gate; measured after CSS hex rounding. */
const MIN_PANEL_LIGHTNESS_STEP = 0.02;

/** Keep muted Pi tints (Tokyo Night/Material Dark); cap louder ones. */
const MAX_USER_BUBBLE_CHROMA = 0.076;

/** Try blue/cyan before Pi magenta; ACCENT_HUES rejects off-hue slots. */
const ACCENT_SLOTS = [4, 6];
const ACCENT_HUES = [180, 275];
/** Minimum page contrast; chromatic pages also require a hue gap. */
const MIN_ACCENT_CONTRAST = 3;
const MIN_ACCENT_HUE_GAP = 30;
const CHROMATIC_PAGE = 0.05;

/** Pi's accent rule fed the first slot that is blue or cyan and stays
 * distinct from the page. */
function accentColors(palette: ThemePalette, pi: Record<string, string>) {
  const page = colorToOklch(parseColor(palette.background));
  for (const slot of ACCENT_SLOTS) {
    const hue = colorToOklch(parseColor(palette.palette[slot]!)).h;
    if (hue < ACCENT_HUES[0]! || hue > ACCENT_HUES[1]!) continue;
    const swapped = [...palette.palette];
    swapped[5] = palette.palette[slot]!;
    const { colors } = generatePaletteColors({ ...palette, palette: swapped });
    const gap =
      Math.abs(colorToOklch(parseColor(colors.accent!)).h - page.h) % 360;
    if (
      contrast(colors.accent!, palette.background) >= MIN_ACCENT_CONTRAST &&
      (page.c <= CHROMATIC_PAGE ||
        Math.min(gap, 360 - gap) >= MIN_ACCENT_HUE_GAP)
    )
      return { accent: colors.accent!, borderAccent: colors.borderAccent! };
  }
  return { accent: pi.accent!, borderAccent: pi.borderAccent! };
}

/** Complete web token set; no configuration or browser dependencies. */
export function generateTheme(palette: ThemePalette): Record<string, string> {
  const { colors, appearance } = generatePaletteColors(palette);
  const c: Record<string, string> = {
    ...colors,
    ...accentColors(palette, colors),
  };
  const bg = palette.background,
    text = c.text!;
  const background = colorToOklch(parseColor(bg));
  const surface = (value: string, minimumStep = 0) => {
    const delta = colorToOklch(parseColor(value)).l - background.l;
    const direction = Math.sign(delta) || (appearance === "dark" ? 1 : -1);
    return colorToHex(
      oklchColor(
        background.l + direction * Math.max(Math.abs(delta), minimumStep),
        background.c,
        background.h,
      ),
    );
  };
  let panel = surface(c.toolPendingBg!);
  for (let step = 2 * MIN_PANEL_LIGHTNESS_STEP; step <= 0.1; step += 0.002) {
    const delta = Math.abs(
      colorToOklch(parseColor(mix(bg, panel, 0.5))).l - background.l,
    );
    if (delta >= MIN_PANEL_LIGHTNESS_STEP) break;
    panel = surface(c.toolPendingBg!, step);
  }
  const border = surface(c.borderMuted!);
  const stateGreen = colorToOklch(parseColor(c.success!));
  let runningStrong = c.success!;
  for (let step = 0; step <= 0.5; step += 0.002) {
    runningStrong = colorToHex(
      oklchColor(
        Math.max(
          0,
          Math.min(1, stateGreen.l + (appearance === "dark" ? step : -step)),
        ),
        stateGreen.c,
        stateGreen.h,
      ),
    );
    if (contrast(runningStrong, mix(bg, panel, 0.5)) >= 7) break;
  }
  const bubble = colorToOklch(parseColor(c.userMessageBg!));
  const tokens: Record<string, string> = {
    "color-scheme": appearance,
    bg,
    text,
    panel: mix(bg, panel, 0.5),
    "panel-2": panel,
    "running-strong": runningStrong,
    "code-bg": mix(bg, panel, 0.75),
    "user-bubble":
      bubble.c <= MAX_USER_BUBBLE_CHROMA
        ? c.userMessageBg!
        : colorToHex(oklchColor(bubble.l, MAX_USER_BUBBLE_CHROMA, bubble.h)),
  };
  const roles = {
    muted: "muted",
    "text-faint": "dim",
    "text-placeholder": "dim",
    accent: "accent",
    danger: "error",
    "error-text": "error",
    running: "success",
    warn: "warning",
    notice: "warning",
    draft: "warning",
    highlight: "warning",
    info: "mdLink",
    "usage-prompt": "mdLink",
    "usage-output": "syntaxType",
    scrollbar: "scrollbarTrack",
    "syntax-comment": "syntaxComment",
    "syntax-keyword": "syntaxKeyword",
    "syntax-string": "syntaxString",
    "syntax-number": "syntaxNumber",
    "syntax-name": "syntaxVariable",
    "syntax-type": "syntaxType",
    "syntax-tag": "syntaxFunction",
  };
  for (const [key, role] of Object.entries(roles)) tokens[key] = c[role]!;
  const borders = {
    border: 0.38,
    "border-strong": 0.65,
    "kbd-edge": 0.55,
    "control-disabled": 0.4,
    "switch-track": 0.75,
    "swatch-border": 1,
    "count-bg": 0.22,
    "count-border": 0.6,
    "count-bg-active": 0.28,
    "count-border-active": 0.85,
  };
  for (const [key, amount] of Object.entries(borders))
    tokens[key] = mix(bg, border, amount);
  const surfaces = [
    bg,
    tokens.panel!,
    tokens["panel-2"]!,
    tokens["code-bg"]!,
    tokens["user-bubble"]!,
    tokens["count-bg"]!,
    tokens["count-bg-active"]!,
  ];
  const readable = (value: string) =>
    surfaces.every((surface) => contrast(value, surface) >= 4.5);
  if (!readable(tokens.muted!)) {
    let low = 0,
      high = 1;
    for (let i = 0; i < 16; i++) {
      const middle = (low + high) / 2;
      if (readable(mix(c.muted!, text, middle))) high = middle;
      else low = middle;
    }
    tokens.muted = mix(c.muted!, text, high);
  }
  Object.assign(tokens, {
    "accent-dim": mix(c.borderAccent!, bg, 0.3),
    "accent-hover": mix(c.accent!, text, 0.12),
    "accent-deep": mix(c.accent!, bg, 0.18),
    "text-disabled": mix(c.dim!, bg, 0.4),
    "text-on-accent": [bg, "#000000", "#ffffff"].sort(
      (a, b) => contrast(b, c.accent!) - contrast(a, c.accent!),
    )[0]!,
    "switch-knob-on": bg,
    "count-text": tokens.muted!,
    "count-text-active": text,
    shadow:
      appearance === "dark"
        ? "#000000"
        : colorToHex(mixColors(parseColor(text), parseColor("#000000"), 0.5)),
    scrim: mix(bg, "#000000", 0.5),
    "scrim-deep": mix(bg, "#000000", 0.75),
  });
  return tokens;
}

/** Render one early, deterministic CSS override. */
export function renderThemeCss(palette: ThemePalette): string {
  return `:root{${Object.entries(generateTheme(palette))
    .map(
      ([key, value]) => `${key === "color-scheme" ? key : `--${key}`}:${value}`,
    )
    .join(";")}}`;
}
/** Built-in families use their dark name as the stable selection key. */
export const themeFamilies = [
  ["Rosé Pine", "Rosé Pine Dawn", "Rosé Pine"],
  ["Tokyo Night", "Tokyo Night Day", "Tokyo Night"],
  ["Solarized Dark", "Solarized Light", "Solarized"],
  ["One Dark", "One Light", "One"],
  ["Gruvbox Dark", "Gruvbox Light", "Gruvbox"],
  ["Nord", "Nord Light", "Nord"],
  ["Catppuccin Frappé", "Catppuccin Latte", "Catppuccin"],
] as const;
const familyFor = (name: string) =>
  themeFamilies.find(([dark, light]) => name === dark || name === light);

/** Defaults for missing/invalid themes.json or removed themes. */
export const themeDefaults = {
  theme: "Material Dark",
  dark: "Material Dark",
  light: "GitHub Light",
};
export const defaultThemeCss = renderThemeCss(
  themePalettes.find((p) => p.name === themeDefaults.theme)!,
);
const choice = (palette: ThemePalette) => {
  const tokens = generateTheme(palette);
  return {
    name: palette.name,
    css: renderThemeCss(palette),
    appearance: tokens["color-scheme"],
    family: familyFor(palette.name)?.[0] ?? palette.name,
    label: familyFor(palette.name)?.[2] ?? palette.name,
    swatches: [
      "bg",
      "text",
      "user-bubble",
      "accent",
      "running",
      "warn",
      "danger",
    ].map((key) => tokens[key]),
  };
};
let choices: ReturnType<typeof choice>[] | undefined;
const renderedSelections = new WeakMap<
  ReturnType<typeof selection>,
  ReturnType<typeof renderSelection>
>();
const defaultSelection = selection({}, []);
let cached:
  | { path: string; key: string; value: ReturnType<typeof selection> }
  | undefined;

/** Fall back per invalid field; preserve unknown keys on writes. */
function selection(raw: Record<string, unknown>, problems: string[]) {
  const custom: ThemePalette[] = [];
  if (raw.custom !== undefined && !Array.isArray(raw.custom))
    problems.push("Invalid custom: expected an array.");
  for (const [index, entry] of (Array.isArray(raw.custom)
    ? raw.custom
    : []
  ).entries()) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const label = `Custom theme ${name || `#${index + 1}`}`;
    const colours = [
      entry?.background,
      entry?.foreground,
      ...(Array.isArray(entry?.palette) ? entry.palette : []),
    ];
    const reason =
      !name || name.length > 80
        ? "name must contain 1-80 characters"
        : ["system", "add", "remove"].includes(name) ||
            [...themePalettes, ...custom].some((p) => p.name === name)
          ? "name is reserved or duplicated"
          : !Array.isArray(entry.palette) || entry.palette.length !== 16
            ? "palette must contain exactly 16 colours"
            : !colours.every(
                  (c) => typeof c === "string" && /^#[\da-f]{6}$/i.test(c),
                )
              ? "colours must be #rrggbb"
              : "";
    if (reason) {
      problems.push(`${label}: ${reason}.`);
      continue;
    }
    const palette = {
      name,
      background: entry.background,
      foreground: entry.foreground,
      palette: entry.palette,
    };
    try {
      generateTheme(palette);
      custom.push(palette);
    } catch {
      problems.push(`${label}: could not generate colours.`);
    }
  }
  const palettes = [...themePalettes, ...custom];
  const fields = { ...themeDefaults };
  for (const field of ["theme", "dark", "light"] as const) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (
      typeof value === "string" &&
      (palettes.some((p) => p.name === value) ||
        (field === "theme" && value === "system"))
    )
      fields[field] = value;
    else
      problems.push(
        `Invalid ${field}: choose an available theme${field === "theme" ? " or system" : ""}.`,
      );
  }
  const legacy = fields.theme === "system";
  const chosen = legacy ? fields.dark : fields.theme;
  const family = familyFor(chosen);
  const ownAppearance = terminalAppearance(
    colorToRgb(parseColor(palettes.find((p) => p.name === chosen)!.background)),
    colorToRgb(parseColor(palettes.find((p) => p.name === chosen)!.foreground)),
  );
  let appearance =
    raw.appearance ??
    (legacy && family?.[1] === fields.light ? "system" : ownAppearance);
  if (!["system", "dark", "light"].includes(String(appearance))) {
    problems.push("Invalid appearance: choose system, dark or light.");
    appearance = ownAppearance;
  }
  return {
    raw,
    ...fields,
    theme: family?.[0] ?? chosen,
    appearance: family ? String(appearance) : ownAppearance,
    problems,
    custom,
    themes: palettes.map((palette) => ({
      name: palette.name,
      appearance: terminalAppearance(
        colorToRgb(parseColor(palette.background)),
        colorToRgb(parseColor(palette.foreground)),
      ),
    })),
  };
}

/** Palette settings and Pi appearance metadata without generating CSS. */
export async function readThemeSettings(path: string) {
  let key: string;
  try {
    const info = await stat(path);
    key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? defaultSelection
      : { ...defaultSelection, problems: ["Could not read themes.json."] };
  }
  if (cached?.path === path && cached.key === key) return cached.value;
  let value: ReturnType<typeof selection>;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Expected an object");
    value = selection(raw, []);
  } catch {
    value = selection({}, [
      "Could not read themes.json: expected a JSON object.",
    ]);
  }
  cached = { path, key, value };
  return value;
}

/** Private atomic palette writes preserve unrelated configuration keys. */
export async function writeThemeSettings(
  path: string,
  fields: Record<string, unknown>,
) {
  const previous = await readThemeSettings(path);
  const checked = selection(
    {
      ...previous,
      ...fields,
      ...(Object.hasOwn(fields, "theme") && !Object.hasOwn(fields, "appearance")
        ? { appearance: undefined }
        : {}),
    },
    [],
  );
  if (checked.problems.length) throw new Error(checked.problems.join(" "));
  const saved = {
    ...previous.raw,
    appearance: checked.appearance,
    ...(Object.hasOwn(fields, "custom") ? { custom: checked.custom } : {}),
    ...Object.fromEntries(
      Object.keys(themeDefaults).map((key) => [
        key,
        checked[key as keyof typeof themeDefaults],
      ]),
    ),
  };
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, JSON.stringify(saved, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, path);
    cached = undefined;
  } finally {
    await rm(tmp, { force: true });
  }
  return readThemeSettings(path);
}

function renderSelection(value: ReturnType<typeof selection>) {
  const palettes = [...themePalettes, ...value.custom];
  const cssFor = (name: string) =>
    renderThemeCss(palettes.find((p) => p.name === name)!);
  const family = familyFor(value.theme);
  const css =
    family && value.appearance === "system"
      ? `${cssFor(family[0])}@media (prefers-color-scheme: light){${cssFor(family[1])}}`
      : cssFor(
          family && value.appearance === "light" ? family[1] : value.theme,
        );
  choices ??= themePalettes.map(choice);
  return {
    ...value,
    css,
    version: createHash("sha256").update(css).digest("hex").slice(0, 12),
    themes: [...choices, ...value.custom.map(choice)],
  };
}

/** On-demand stat-keyed reads generate and cache CSS only for its consumers. */
export async function readTheme(path: string) {
  const settings = await readThemeSettings(path);
  let rendered = renderedSelections.get(settings);
  if (!rendered) {
    rendered = renderSelection(settings);
    renderedSelections.set(settings, rendered);
  }
  return rendered;
}

/** Persist palette settings and return the rendered public selection. */
export async function writeTheme(
  path: string,
  fields: Record<string, unknown>,
) {
  await writeThemeSettings(path, fields);
  return readTheme(path);
}

/** Public Settings response excludes the preserved, unrecognized file keys. */
export function themeResponse({
  raw: _raw,
  ...response
}: Awaited<ReturnType<typeof readTheme>>) {
  return response;
}
