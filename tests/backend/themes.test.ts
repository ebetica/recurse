import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/system-theme-themes.json";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorToOklch, parseColor } from "@earendil-works/pi-tui";
import {
  contrast,
  generatePaletteColors,
  generateTheme,
  themePalettes,
  readTheme,
  readThemeSettings,
  writeTheme,
} from "../../src/themes";

test("selection validates real files, preserves extra keys, and renders system CSS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "themes-")),
    path = join(dir, "themes.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        theme: "unknown",
        dark: 42,
        light: "GitHub Light",
        custom: [],
      }),
    );
    const invalid = await readTheme(path);
    expect(invalid.theme).toBe("Material Dark");
    expect(invalid.dark).toBe("Material Dark");
    expect(invalid.problems).toHaveLength(2);
    const system = await writeTheme(path, {
      theme: "system",
      dark: "Tokyo Night",
      light: "Tokyo Night Day",
    });
    expect(system.css).toContain("@media (prefers-color-scheme: light){:root{");
    expect(system.css).toContain(
      `--bg:${themePalettes.find((p) => p.name === "Tokyo Night Day")!.background}`,
    );
    expect(JSON.parse(await readFile(path, "utf8")).custom).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(writeTheme(path, { theme: "missing" })).rejects.toThrow(
      "Invalid theme",
    );
    await writeFile(path, "{");
    const malformed = await readTheme(path);
    expect(malformed.theme).toBe("Material Dark");
    expect(malformed.problems).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom palettes validate independently, appear in choices, and generate selectable CSS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "themes-custom-")),
    path = join(dir, "themes.json");
  const custom = {
    ...themePalettes.find((p) => p.name === "Solarized Light")!,
    name: " Warm solarized ",
  };
  try {
    const bad = [
      null,
      { ...custom, name: "" },
      { ...custom, name: "x".repeat(81) },
      { ...custom, name: "system" },
      { ...custom, name: "add" },
      { ...custom, name: "remove" },
      { ...custom, name: "Nord" },
      { ...custom, palette: custom.palette.slice(1) },
      { ...custom, background: "red" },
      { ...custom, foreground: "#fff" },
      {
        ...custom,
        palette: custom.palette.map((c, i) => (i === 5 ? "oops" : c)),
      },
    ];
    await writeFile(
      path,
      JSON.stringify({
        theme: "Warm solarized",
        dark: "Warm solarized",
        light: "Warm solarized",
        custom: [...bad, custom, custom],
        unrelated: true,
      }),
    );
    const result = await readTheme(path);
    expect(result.problems).toHaveLength(bad.length + 1);
    expect(result.problems.every((p) => p.startsWith("Custom theme "))).toBe(
      true,
    );
    expect(result.problems.join(" ")).toContain("name must");
    expect(result.problems.join(" ")).toContain("reserved or duplicated");
    expect(result.problems.join(" ")).toContain("exactly 16");
    expect(result.problems.join(" ")).toContain("#rrggbb");
    expect(result.custom.map((p) => p.name)).toEqual(["Warm solarized"]);
    const settings = await readThemeSettings(path);
    expect(
      result.themes.map(({ name, appearance }) => ({ name, appearance })),
    ).toEqual(settings.themes);
    expect(settings.problems).toEqual(result.problems);
    expect(settings).not.toHaveProperty("css");
    expect(
      result.themes.find((p) => p.name === "Warm solarized"),
    ).toMatchObject({
      appearance: "light",
      swatches: expect.arrayContaining([custom.background]),
    });
    expect([result.theme, result.dark, result.light]).toEqual(
      Array(3).fill("Warm solarized"),
    );
    expect(result.css).toContain(`--bg:${custom.background}`);
    const selected = await writeTheme(path, { theme: "system" });
    expect(selected.appearance).toBe("light");
    expect(selected.css).not.toContain("@media");
    expect(selected.css).toContain(`--bg:${custom.background}`);
    expect(JSON.parse(await readFile(path, "utf8")).unrelated).toBe(true);
    await expect(
      writeTheme(path, { custom: [{ ...custom, palette: [] }] }),
    ).rejects.toThrow("exactly 16");
    await writeFile(
      path,
      JSON.stringify({ custom: {}, theme: "Unknown custom" }),
    );
    const invalid = await readTheme(path);
    expect(invalid.problems).toHaveLength(2);
    expect(invalid.problems[0]).toContain("expected an array");
    expect(invalid.problems[1]).toContain("Invalid theme");
    expect(invalid.theme).toBe("Material Dark");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("old selections migrate to one family and preserve its appearance across saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "themes-migration-"));
  const path = join(dir, "themes.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        theme: "system",
        dark: "Tokyo Night",
        light: "Tokyo Night Day",
      }),
    );
    const paired = await readTheme(path);
    expect(paired.theme).toBe("Tokyo Night");
    expect(paired.appearance).toBe("system");
    expect(paired.css).toContain("@media (prefers-color-scheme: light)");
    await writeFile(
      path,
      JSON.stringify({
        theme: "system",
        dark: "Dracula",
        light: "GitHub Light",
      }),
    );
    const single = await readTheme(path);
    expect(single.theme).toBe("Dracula");
    expect(single.appearance).toBe("dark");
    expect(single.css).not.toContain("@media");
    await writeFile(path, JSON.stringify({ theme: "Solarized Light" }));
    const named = await readTheme(path);
    expect(named.theme).toBe("Solarized Dark");
    expect(named.appearance).toBe("light");
    await writeTheme(path, { appearance: "system" });
    expect((await readTheme(path)).appearance).toBe("system");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      theme: "Solarized Dark",
      appearance: "system",
    });
    await expect(writeTheme(path, { appearance: "invalid" })).rejects.toThrow(
      "Invalid appearance",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("terminal palette themes", () => {
  // Feature: #2429 cap loud ANSI-blue bubbles without greying muted Pi tints.
  test("operator bubbles cap chroma while preserving Pi lightness, hue and below-cap bytes", () => {
    const changed: string[] = [];
    for (const palette of themePalettes) {
      const pi = generatePaletteColors(palette).colors.userMessageBg!;
      const original = colorToOklch(parseColor(pi));
      const hex = generateTheme(palette)["user-bubble"]!;
      const bubble = colorToOklch(parseColor(hex));
      expect(bubble.c, palette.name).toBeLessThanOrEqual(0.077);
      expect(Math.abs(bubble.l - original.l), palette.name).toBeLessThanOrEqual(
        0.002,
      );
      const hueDistance = Math.abs(bubble.h - original.h);
      expect(
        Math.min(hueDistance, 360 - hueDistance),
        palette.name,
      ).toBeLessThanOrEqual(1);
      if (original.c <= 0.076) expect(hex, palette.name).toBe(pi);
      else changed.push(palette.name);
    }
    expect(changed).toEqual([
      "Dracula",
      "Catppuccin Frappé",
      "Palenight",
      "Ocean",
    ]);
  });
  test("reproduces the recorded Pi generator output and palette inputs", () => {
    expect(themePalettes).toEqual(
      fixture.themes.map(({ name, background, foreground, palette }) => ({
        name,
        background,
        foreground,
        palette: palette.slice(0, 16),
      })),
    );
    for (const palette of themePalettes) {
      const recorded = fixture.themes.find((p) => p.name === palette.name)!;
      const { colors, appearance } = generatePaletteColors(palette);
      expect(String(appearance)).toBe(recorded.appearance);
      for (const [index, role] of fixture.tokens.entries())
        expect(colors[role]).toBe(
          recorded.palette[fixture.firstTokenIndex + index],
        );
    }
  });
  // Regression: #2323 neutral ANSI colours must not turn cream surfaces cyan or blue surfaces grey.
  test("surface lightness steps retain the palette background hue", () => {
    for (const name of ["Solarized Light", "Ocean"]) {
      const palette = themePalettes.find((p) => p.name === name)!;
      const tokens = generateTheme(palette);
      const bg = colorToOklch(parseColor(palette.background));
      for (const role of [
        "panel",
        "panel-2",
        "code-bg",
        "border",
        "count-bg",
      ]) {
        const surface = colorToOklch(parseColor(tokens[role]!));
        const hueDistance = Math.abs(surface.h - bg.h);
        expect(
          Math.min(hueDistance, 360 - hueDistance),
          `${name}: ${role}`,
        ).toBeLessThan(5);
        expect(Math.abs(surface.c - bg.c), `${name}: ${role}`).toBeLessThan(
          0.01,
        );
      }
    }
  });
  // Regression: #2323 a minimum 0.02 lightness step keeps Ocean's panels distinct without recolouring other palettes.
  test("all built-ins visibly separate panels from the page", () => {
    for (const palette of themePalettes) {
      const tokens = generateTheme(palette);
      const bg = colorToOklch(parseColor(tokens.bg!));
      const steps = ["panel", "panel-2", "code-bg"].map((role) => {
        const delta = Math.abs(
          colorToOklch(parseColor(tokens[role]!)).l - bg.l,
        );
        expect(delta, `${palette.name}: ${role}`).toBeGreaterThanOrEqual(0.02);
        return delta;
      });
      console.log(
        `${palette.name}: minimum panel lightness step ${Math.min(...steps).toFixed(5)}`,
      );
    }
  });
  test("all built-ins provide complete tokens with readable text, status and syntax", () => {
    const keys = Object.keys(generateTheme(themePalettes[0]!)).sort();
    const minima = { text: Infinity, accentText: Infinity, semantic: Infinity };
    for (const palette of themePalettes) {
      const t = generateTheme(palette);
      const paletteMinima = {
        text: Infinity,
        accentText: Infinity,
        semantic: Infinity,
      };
      expect(Object.keys(t).sort()).toEqual(keys);
      expect(t["running-strong"]).toBeDefined();
      expect(
        contrast(t["running-strong"]!, t.panel!),
        `${palette.name}: sidebar running marker`,
      ).toBeGreaterThanOrEqual(4.5);
      const surfaces = ["bg", "panel", "panel-2", "code-bg", "user-bubble"];
      for (const [role, backgrounds] of Object.entries({
        text: surfaces,
        muted: surfaces,
        "count-text": ["count-bg", "count-bg-active"],
        "count-text-active": ["count-bg-active"],
      }))
        for (const surface of backgrounds) {
          const ratio = contrast(t[role]!, t[surface]!);
          minima.text = Math.min(minima.text, ratio);
          paletteMinima.text = Math.min(paletteMinima.text, ratio);
          expect(
            ratio,
            `${palette.name}: ${role} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      const ratio = contrast(t["text-on-accent"]!, t.accent!);
      minima.accentText = Math.min(minima.accentText, ratio);
      paletteMinima.accentText = ratio;
      expect(ratio, palette.name).toBeGreaterThanOrEqual(4.5);
      for (const role of [
        "accent",
        "danger",
        "running",
        "warn",
        "info",
        "usage-prompt",
        "usage-output",
        ...keys.filter((key) => key.startsWith("syntax-")),
      ])
        for (const surface of ["bg", "code-bg"]) {
          const ratio = contrast(t[role]!, t[surface]!);
          minima.semantic = Math.min(minima.semantic, ratio);
          paletteMinima.semantic = Math.min(paletteMinima.semantic, ratio);
          expect(
            ratio,
            `${palette.name}: ${role} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      console.log(palette.name, paletteMinima);
    }
    console.log("Observed WCAG contrast minima:", minima);
  });
  test("the accent takes the blue slot's hue unless that blends into the page", () => {
    const hue = (color: string) => colorToOklch(parseColor(color)).h;
    const gap = (a: string, b: string) => {
      const d = Math.abs(hue(a) - hue(b)) % 360;
      return Math.min(d, 360 - d);
    };
    const nearest = (palette: (typeof themePalettes)[number]) => {
      const accent = generateTheme(palette).accent!;
      return [4, 6, 5].sort(
        (a, b) =>
          gap(accent, palette.palette[a]!) - gap(accent, palette.palette[b]!),
      )[0];
    };
    const blueWherePossible = themePalettes.filter((p) => nearest(p) === 4);
    for (const palette of themePalettes) {
      const accent = generateTheme(palette).accent!;
      expect(
        contrast(accent, palette.background),
        palette.name,
      ).toBeGreaterThanOrEqual(3);
      if (colorToOklch(parseColor(palette.background)).c > 0.05)
        expect(
          gap(accent, palette.background),
          palette.name,
        ).toBeGreaterThanOrEqual(30);
    }
    const byName = (name: string) =>
      themePalettes.find((p) => p.name === name)!;
    for (const name of [
      "Material Dark",
      "Solarized Dark",
      "GitHub Light",
      "Solarized Light",
    ])
      expect(blueWherePossible.map((p) => p.name)).toContain(name);
    expect(nearest(byName("Ocean"))).toBe(6);
    for (const name of ["Dracula", "Monokai Pro Light"])
      expect(nearest(byName(name)), name).toBe(6);
    const custom = {
      ...byName("Tokyo Night"),
      name: "Blue page",
      background: byName("Tokyo Night").palette[4]!,
    };
    const accent = generateTheme(custom).accent!;
    expect(gap(accent, custom.background)).toBeGreaterThanOrEqual(30);
    expect(contrast(accent, custom.background)).toBeGreaterThanOrEqual(3);
  });
});
