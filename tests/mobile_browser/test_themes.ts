import { expect } from "bun:test";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  generateTheme,
  renderThemeCss,
  themePalettes,
  themeFamilies,
} from "../../src/themes";
import captured from "../backend/fixtures/pull_request_diff.json";
import {
  closeWithRoutes,
  gotoRoot,
  postFixture,
  runBrowserTests,
  themeColors,
  type BrowserTest,
} from "./common";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const tests: BrowserTest[] = [
  // Feature: #2426 one checked family and a prominent selected appearance, with unavailable controls visibly disabled.
  async function test_one_family_selection_and_appearance(browser, base, data) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      colorScheme: "dark",
    });
    const path = join(data, "data/config/themes.json");
    const custom = {
      ...themePalettes.find((p) => p.name === "Solarized Light")!,
      name: "Custom Solarized",
    };
    try {
      await mkdir(join(data, "data/config"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          theme: "system",
          dark: "Tokyo Night",
          light: "Tokyo Night Day",
          custom: [custom],
        }),
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const appearanceButtons = page.locator(".theme-appearance button");
      const open = async () => {
        await page.locator("#menu-btn").click();
        await page.locator("#settings-btn").click();
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
      };
      await page.route(`${base}api/settings/theme`, (route) => route.abort());
      await open();
      await browserExpect(appearanceButtons).toHaveCount(3);
      await page
        .getByText("Couldn't load themes. Reopen Settings to try again.", {
          exact: true,
        })
        .waitFor();
      for (const button of await appearanceButtons.all())
        await browserExpect(button).toBeDisabled();
      await page.locator("#settings-close").click();
      await page.unroute(`${base}api/settings/theme`);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`${base}api/settings/theme`, async (route) => {
        await held;
        await route.continue();
      });
      await open();
      await browserExpect(appearanceButtons).toHaveCount(3);
      for (const button of await appearanceButtons.all())
        await browserExpect(button).toBeDisabled();
      release();
      await page
        .locator('.theme-cards button[data-theme="Tokyo Night"]')
        .waitFor();
      await page.unroute(`${base}api/settings/theme`);
      const selected = page.locator('.theme-cards button[aria-pressed="true"]');
      await browserExpect(selected).toHaveCount(1);
      const appearance = page.getByRole("group", {
        name: "Appearance",
        exact: true,
      });
      const button = (name: string) =>
        appearance.getByRole("button", { name, exact: true });
      const bg = (name: string) =>
        page.waitForFunction(
          (value) => {
            const browser = globalThis as any;
            return (
              browser
                .getComputedStyle(browser.document.documentElement)
                .getPropertyValue("--bg")
                .trim() === value
            );
          },
          (themePalettes.find((p) => p.name === name) ?? custom).background,
        );
      await browserExpect(button("System")).toBeDisabled();
      await browserExpect(button("System")).toHaveCSS("opacity", "1");
      await browserExpect(page.locator(".theme-appearance")).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      await bg("Tokyo Night");
      for (const name of ["Light", "Dark", "System"]) {
        await button(name).click();
        await browserExpect(button(name)).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await browserExpect(selected).toHaveCount(1);
        await bg(name === "Light" ? "Tokyo Night Day" : "Tokyo Night");
      }
      await page.emulateMedia({ colorScheme: "light" });
      await bg("Tokyo Night Day");
      await page.emulateMedia({ colorScheme: "dark" });
      await bg("Tokyo Night");
      for (const name of ["Dracula", "GitHub Light", custom.name]) {
        await page.locator(`.theme-cards button[data-theme="${name}"]`).click();
        await bg(name);
        await browserExpect(selected).toHaveCount(1);
        await browserExpect(page.locator(".theme-appearance")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await browserExpect(
          button(name === "Dracula" ? "Dark" : "Light"),
        ).toHaveCSS("opacity", "0.5");
        for (const value of ["System", "Dark", "Light"])
          await browserExpect(button(value)).toBeDisabled();
        await browserExpect(
          button(name === "Dracula" ? "Dark" : "Light"),
        ).toHaveAttribute("aria-pressed", "true");
      }
      expect(await page.locator(".theme-cards strong").count()).toBe(0);
      expect(
        await page
          .locator(
            '.theme-cards button[data-theme="Tokyo Night"] .theme-card-variant',
          )
          .count(),
      ).toBe(2);
      for (const name of [
        "Dracula",
        "Catppuccin Frappé",
        "Palenight",
        "Ocean",
        "Tokyo Night",
        "Material Dark",
        "GitHub Light",
      ]) {
        const bubble = page
          .locator(
            `.theme-cards button[data-theme="${name}"] .theme-card-bubble`,
          )
          .first();
        const actual = await bubble.evaluate(
          (node) => (globalThis as any).getComputedStyle(node).backgroundColor,
        );
        expect(actual).toBe(
          (
            await themeColors(
              page,
              generateTheme(themePalettes.find((p) => p.name === name)!)[
                "user-bubble"
              ]!,
            )
          )[0],
        );
      }
      await page.locator('.theme-cards button[data-theme="Dracula"]').click();
      await bg("Dracula");
      expect(
        await page.evaluate(() => {
          const browser = globalThis as any;
          return browser
            .getComputedStyle(browser.document.documentElement)
            .getPropertyValue("--user-bubble")
            .trim();
        }),
      ).toBe(
        generateTheme(themePalettes.find((p) => p.name === "Dracula")!)[
          "user-bubble"
        ]!,
      );
    } finally {
      await page.close();
      await rm(path, { force: true });
    }
  },
  // Regression: #2408 a recorded pre-save response must not end the wait.
  async function test_settings_picker_repaints_without_navigation(
    browser,
    base,
    data,
  ) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const path = join(data, "data/config/themes.json");
    try {
      await mkdir(join(data, "data/config"), { recursive: true });
      await writeFile(path, JSON.stringify({ theme: "missing" }));
      await gotoRoot(page, base);
      const open = async () => {
        await page.locator(".agent").first().waitFor();
        await page.locator("#menu-btn").click();
        await page.locator("#settings-btn").click();
        for (const tab of await page.locator("#settings-nav button").all()) {
          await tab.scrollIntoViewIfNeeded();
          await tab.click();
          expect(await tab.getAttribute("class")).toContain("on");
        }
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await page
          .locator('.theme-cards button[data-theme="Material Dark"]')
          .waitFor();
      };
      await open();
      for (const name of ["Material Dark", "GitHub Light"]) {
        const tokens = generateTheme(
          themePalettes.find((theme) => theme.name === name)!,
        );
        const expected = await themeColors(
          page,
          tokens.bg!,
          tokens.text!,
          tokens.border!,
        );
        const actual = await page
          .locator(`.theme-cards button[data-theme="${name}"]`)
          .evaluate((button) => {
            const style = (globalThis as any).getComputedStyle(button);
            return [style.backgroundColor, style.color, style.borderTopColor];
          });
        expect(actual).toEqual(expected);
      }
      const state = await (
        await page.request.get(`${base}api/settings/theme`)
      ).json();
      expect(state.problems.length).toBeGreaterThan(0);
      await page.getByText(state.problems[0], { exact: true }).waitFor();
      expect(
        await page
          .locator(".settings-section:has(.theme-cards) select")
          .count(),
      ).toBe(0);
      await page.evaluate("window.themePickerMarker = true");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let postStarted!: () => void;
      const started = new Promise<void>((resolve) => (postStarted = resolve));
      await page.route(`${base}api/settings/theme`, async (route) => {
        if (route.request().method() === "POST") {
          postStarted();
          await held;
        }
        await route.continue();
      });
      const pick = (name: string) =>
        page.locator(
          `.theme-cards button[data-theme="${themeFamilies.find((pair) => pair.includes(name as never))?.[0] ?? name}"]`,
        );
      const waitForSavedTheme = async (
        expected: Record<string, string>,
        previous: unknown,
      ) => {
        let reads = 0;
        const url = `${base}api/settings/theme`;
        const stale = (route: Route) => {
          if (
            route.request().headers()["x-browser-state-check"] !== "saved-theme"
          )
            return route.fallback();
          reads++;
          return reads === 1
            ? route.fulfill({ json: previous })
            : route.fallback();
        };
        await page.route(url, stale);
        try {
          await browserExpect
            .poll(
              () =>
                page.evaluate(async () =>
                  (
                    await (globalThis as any).fetch("/api/settings/theme", {
                      headers: { "x-browser-state-check": "saved-theme" },
                    })
                  ).json(),
                ),
              { timeout: 30_000 },
            )
            .toMatchObject(expected);
          expect(reads).toBeGreaterThan(1);
          return (await page.request.get(url)).json();
        } finally {
          await page.unroute(url, stale);
        }
      };
      await pick("GitHub Light").click();
      await started;
      const bg = themePalettes.find(
        (p) => p.name === "GitHub Light",
      )!.background;
      const rgb = `rgb(${bg
        .slice(1)
        .match(/../g)!
        .map((v) => parseInt(v, 16))
        .join(", ")})`;
      const waitBg = () =>
        page.waitForFunction((rgb: string) => {
          const browser = globalThis as any;
          return (
            browser.getComputedStyle(browser.document.body).backgroundColor ===
            rgb
          );
        }, rgb);
      await waitBg();
      expect(Boolean(await page.evaluate("window.themePickerMarker"))).toBe(
        true,
      );
      expect(await pick("GitHub Light").getAttribute("aria-pressed")).toBe(
        "true",
      );
      await pick("Nord").click();
      await pick("Solarized Light").click();
      await browserExpect(
        page
          .getByRole("group", { name: "Appearance", exact: true })
          .getByRole("button", { name: "Light", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      release();
      const lightSaved = await waitForSavedTheme(
        { theme: "Solarized Dark", appearance: "light" },
        state,
      );
      await page.unroute(`${base}api/settings/theme`);
      await pick("GitHub Light").click();
      const githubSaved = await waitForSavedTheme(
        { theme: "GitHub Light" },
        lightSaved,
      );
      await page.reload();
      await waitBg();
      await open();
      expect(await pick("GitHub Light").getAttribute("aria-pressed")).toBe(
        "true",
      );
      await pick("Solarized Dark").click();
      const appearance = page.getByRole("group", {
        name: "Appearance",
        exact: true,
      });
      await appearance
        .getByRole("button", { name: "System", exact: true })
        .click();
      await page.emulateMedia({ colorScheme: "dark" });
      expect(
        await page.evaluate(() =>
          (globalThis as any)
            .getComputedStyle((globalThis as any).document.documentElement)
            .getPropertyValue("--bg")
            .trim(),
        ),
      ).toBe(
        themePalettes.find((theme) => theme.name === "Solarized Dark")!
          .background,
      );
      await page.emulateMedia({ colorScheme: "light" });
      expect(
        await page.evaluate(() =>
          (globalThis as any)
            .getComputedStyle((globalThis as any).document.documentElement)
            .getPropertyValue("--bg")
            .trim(),
        ),
      ).toBe(
        themePalettes.find((theme) => theme.name === "Solarized Light")!
          .background,
      );
      await waitForSavedTheme(
        {
          theme: "Solarized Dark",
          appearance: "system",
        },
        githubSaved,
      );
      expect(await pick("Solarized Dark").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(
        await page.locator('.theme-cards button[aria-pressed="true"]').count(),
      ).toBe(1);
      await page.locator("#settings-close").click();
      await writeFile(
        path,
        JSON.stringify({
          theme: "system",
          dark: "GitHub Light",
          light: "Material Dark",
        }),
      );
      await open();
      expect(await pick("GitHub Light").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(await pick("Material Dark").getAttribute("aria-pressed")).toBe(
        "false",
      );
      const singleSaved = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/settings/theme` &&
          response.request().method() === "POST",
      );
      await pick("Dracula").click();
      expect((await (await singleSaved).json()).theme).toBe("Dracula");
      const saved = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/settings/theme` &&
          response.request().method() === "POST",
      );
      await pick("Material Dark").click();
      const response = await saved;
      expect(response.status()).toBe(200);
      expect((await response.json()).dark).toBe("GitHub Light");
      let releaseRefresh!: () => void;
      const refreshHeld = new Promise<void>(
        (resolve) => (releaseRefresh = resolve),
      );
      let refreshStarted!: () => void;
      const refreshing = new Promise<void>(
        (resolve) => (refreshStarted = resolve),
      );
      await page.route(`${base}api/settings/theme`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const old = await route.fetch();
        refreshStarted();
        await refreshHeld;
        await route.fulfill({ response: old });
      });
      await writeFile(path, JSON.stringify({ theme: "GitHub Light" }));
      await refreshing;
      const newSave = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/settings/theme` &&
          response.request().method() === "POST",
      );
      await pick("Material Dark").click();
      const newState = await (await newSave).json();
      await page.waitForFunction(
        (version) =>
          (globalThis as any).document.querySelector("#theme").dataset
            .version === version,
        newState.version,
      );
      const refreshFinished = page.waitForEvent("requestfinished", {
        predicate: (request) =>
          request.url() === `${base}api/settings/theme` &&
          request.method() === "GET",
      });
      releaseRefresh();
      await refreshFinished;
      expect(await page.locator("#theme").getAttribute("data-version")).toBe(
        newState.version,
      );
      await page.unroute(`${base}api/settings/theme`);
      let rejectSave!: () => void;
      const rejection = new Promise<void>((resolve) => (rejectSave = resolve));
      await page.route(`${base}api/settings/theme`, async (route) => {
        if (route.request().method() === "POST") {
          await rejection;
          await route.fulfill({
            status: 400,
            json: { detail: "Theme rejected" },
          });
        } else await route.continue();
      });
      await pick("Nord").click();
      await page.locator("#settings-close").click();
      await open();
      expect(await pick("Nord").getAttribute("aria-pressed")).toBe("true");
      rejectSave();
      await page.getByText("Theme rejected", { exact: true }).waitFor();
      expect(await pick("Material Dark").getAttribute("aria-pressed")).toBe(
        "true",
      );
      await page.unroute(`${base}api/settings/theme`);
      await page.route(`${base}api/settings/theme`, (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue(),
      );
      await pick("Nord").click();
      await page.locator(".msg.err:not([hidden])").waitFor();
      expect(await pick("Nord").getAttribute("aria-pressed")).toBe("true");
      expect(await pick("GitHub Light").isEnabled()).toBe(true);
    } finally {
      await closeWithRoutes(page);
      await rm(path, { force: true });
    }
  },
  async function test_selection_repaints_and_system_follows_browser(
    browser,
    base,
    data,
  ) {
    const page = await browser.newPage();
    try {
      await gotoRoot(page, base);
      await page.evaluate(
        "window.themeMarker = true; window.addEventListener('recurse:theme-changed', () => window.themeChanged = true)",
      );
      await mkdir(join(data, "data/config"), { recursive: true });
      const path = join(data, "data/config/themes.json");
      await writeFile(path, JSON.stringify({ theme: "GitHub Light" }));
      const light = themePalettes.find(
        (p) => p.name === "GitHub Light",
      )!.background;
      const waitBg = (bg: string) =>
        page.waitForFunction((bg: string) => {
          const browser = globalThis as any;
          return (
            browser.getComputedStyle(browser.document.body).backgroundColor ===
            `rgb(${bg
              .slice(1)
              .match(/../g)!
              .map((v) => parseInt(v, 16))
              .join(", ")})`
          );
        }, bg);
      await waitBg(light);
      expect(
        Boolean(
          await page.evaluate("window.themeMarker && window.themeChanged"),
        ),
      ).toBe(true);
      const custom = {
        ...themePalettes.find((p) => p.name === "Solarized Light")!,
        name: "Custom solarized",
      };
      await writeFile(
        path,
        JSON.stringify({ theme: custom.name, custom: [custom] }),
      );
      await waitBg(custom.background);
      expect(Boolean(await page.evaluate("window.themeMarker"))).toBe(true);
      const listed = await page.request.get(`${base}api/settings/theme`);
      expect(
        (await listed.json()).themes.some(
          (p: { name: string }) => p.name === custom.name,
        ),
      ).toBe(true);
      await page.reload();
      await waitBg(custom.background);
      const response = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "Tokyo Night", appearance: "system" },
      });
      expect(response.status()).toBe(200);
      await page.emulateMedia({ colorScheme: "dark" });
      await waitBg(
        themePalettes.find((p) => p.name === "Tokyo Night")!.background,
      );
      await page.emulateMedia({ colorScheme: "light" });
      await waitBg(
        themePalettes.find((p) => p.name === "Tokyo Night Day")!.background,
      );
      const bad = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "missing" },
      });
      expect(bad.status()).toBe(400);
    } finally {
      await page.close();
      await rm(join(data, "data/config/themes.json"), { force: true });
    }
  },
  // Regression: #2323 Mermaid nodes and arrows must follow the current palette, including live switches.
  async function test_diagrams_and_diff_follow_palette(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      const { demo } = await postFixture(base, "seed-theme-surfaces");
      await page.route(`**/api/conversations/${demo}/diff*`, (route) =>
        route.fulfill({ json: captured.summary }),
      );
      await page.route(`**/api/conversations/${demo}/diff/files*`, (route) =>
        route.fulfill({ json: captured.file }),
      );
      await page.goto(`${base}#agent=${demo}`, {
        waitUntil: "domcontentloaded",
      });
      const diagram = page.locator(".mermaid-done svg");
      await diagram.waitFor();
      await page.locator('.rail-btn[data-pane="diff"]').click();
      await page.locator(".diff-patch .hljs-keyword").first().waitFor();
      for (const name of ["GitHub Light", "Solarized Light", "Nord"]) {
        const css = renderThemeCss(themePalettes.find((p) => p.name === name)!);
        const oldId = await diagram.getAttribute("id");
        await page.evaluate((css) => {
          const { document, window, Event } = globalThis as any;
          document.querySelector("#theme").textContent = css;
          window.dispatchEvent(new Event("recurse:theme-changed"));
        }, css);
        await page.waitForFunction(
          (oldId) =>
            (globalThis as any).document.querySelector(".mermaid-done svg")
              ?.id !== oldId,
          oldId,
        );
        const colors = await page.evaluate(() => {
          const { document, getComputedStyle } = globalThis as any;
          const color = (selector: string, property: string) =>
            getComputedStyle(document.querySelector(selector))[property];
          const token = (name: string) => {
            const probe = document.createElement("span");
            probe.style.color = `var(--${name})`;
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          return {
            fill: color(".mermaid-done .node rect", "fill"),
            panel: token("panel-2"),
            arrow: color(".mermaid-done .flowchart-link", "stroke"),
            muted: token("muted"),
            keyword: color(".diff-patch .hljs-keyword", "color"),
            syntax: token("syntax-keyword"),
          };
        });
        expect(colors.fill, name).toBe(colors.panel);
        expect(colors.arrow, name).toBe(colors.muted);
        expect(colors.keyword, name).toBe(colors.syntax);
      }
    } finally {
      await page.close();
    }
  },
  // Regression: #2727 per-image sizing variables need a local declaration, not a theme token.
  async function test_generated_theme_is_complete(browser, base) {
    const page = await browser.newPage();
    try {
      await gotoRoot(page, base);
      await page.getByRole("button", { name: "Choose effort level" }).click();
      await page.locator("#effort-range[aria-valuetext]").waitFor();
      expect(await page.locator("style#theme").textContent()).toContain(
        ":root{",
      );
      const result = await page.evaluate(() => {
        const { document, getComputedStyle } = globalThis as any;
        const style = getComputedStyle(document.documentElement);
        const declared = new Set<string>(),
          referenced = new Set<string>();
        const declarations = (style: any) => {
          for (let i = 0; i < (style?.length ?? 0); i++)
            if (style[i].startsWith("--")) declared.add(style[i]);
        };
        const visit = (rules: any) => {
          for (const rule of rules) {
            if (rule.cssRules) visit(rule.cssRules);
            declarations(rule.style);
            for (const match of String(rule.cssText).matchAll(
              /var\((--[\w-]+)/g,
            ))
              referenced.add(match[1]);
          }
        };
        for (const sheet of document.styleSheets) visit(sheet.cssRules);
        for (const element of document.querySelectorAll("[style]"))
          declarations(element.style);
        const missing = [...referenced].filter((name) => !declared.has(name));
        return {
          missing,
          background: getComputedStyle(document.body).backgroundColor,
          bg: style.getPropertyValue("--bg").trim(),
        };
      });
      expect(result.missing).toEqual([]);
      const bg = generateTheme(
        themePalettes.find((p) => p.name === "Material Dark")!,
      ).bg!;
      expect(result.bg).toBe(bg);
      const channels = bg
        .slice(1)
        .match(/../g)!
        .map((v) => parseInt(v, 16));
      expect(result.background).toBe(`rgb(${channels.join(", ")})`);
    } finally {
      await page.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["themes", tests]]);
