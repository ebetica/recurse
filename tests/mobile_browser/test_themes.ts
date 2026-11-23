import { expect } from "bun:test";
import type { Locator, Page, Route } from "playwright";
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
  focusComposer,
  gotoRoot,
  postFixture,
  reloadConversation,
  runBrowserTests,
  themeColors,
  type BrowserTest,
  openSettingsPanel,
} from "./common";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function openDetail(page: Page, label: string) {
  await page
    .locator(".settings-row")
    .filter({ hasText: new RegExp(`^${label}`) })
    .click();
  return page.getByRole("dialog", { name: label, exact: true });
}

async function closeDetail(page: Page, label: string) {
  await page
    .getByRole("dialog", { name: label, exact: true })
    .getByRole("button", {
      name:
        page.viewportSize()!.width <= 700
          ? `Close ${label}`
          : "Back to Appearance",
      exact: true,
    })
    .click();
}

async function probeInView(target: Locator) {
  const hit = await themeCornersHit(target);
  return target.evaluate((element, hit) => {
    const box = element.getBoundingClientRect();
    const view = element.ownerDocument.documentElement;
    return {
      top: box.top,
      hit,
      inView:
        box.width > 0 &&
        box.top >= 0 &&
        box.left >= 0 &&
        box.bottom <= view.clientHeight &&
        box.right <= view.clientWidth,
    };
  }, hit);
}

async function themeCornersHit(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [
      [box.left + 8, box.top + 8],
      [box.right - 8, box.top + 8],
      [box.left + 8, box.bottom - 8],
      [box.right - 8, box.bottom - 8],
    ].every(([x, y]) =>
      element.contains(element.ownerDocument.elementFromPoint(x!, y!)),
    );
  });
}

export const tests: BrowserTest[] = [
  // Feature: #3387 custom CSS previews, persists through Settings and native tools, and cannot fetch resources or conceal file destinations.
  async function test_optional_theme_css(browser, base, data) {
    const path = join(data, "data/config/themes.json");
    const shots = join(
      process.env.RECURSE_AGENT_TMPDIR || tmpdir(),
      "theme-css",
    );
    await mkdir(shots, { recursive: true });
    const custom = { ...themePalettes[0]!, name: "Browser custom CSS" };
    const preview =
      '@media screen and (min-width: 1px) { [data-theme="background"] label:has([name="custom-css"]) { visibility: hidden !important; } }';
    const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><path d="M0 120L120 0M-30 90L90-30M30 150L150 30" stroke="#75b9ff" stroke-opacity=".25" stroke-width="12"/></svg>')}`;
    const sample = `[data-theme="background"], [data-theme="thread"] { background-image: url("${svg}"); }
      [data-theme="chat-header"] { border-bottom: 4px solid #75b9ff; }
      [data-theme="composer"] { border: 3px solid #75b9ff; border-radius: 18px; }
      [data-theme="assistant-message"] { border-left: 4px solid #75b9ff; padding-left: 12px; }`;
    try {
      await mkdir(dirname(path), { recursive: true });
      for (const width of [1280, 412]) {
        await writeFile(
          path,
          JSON.stringify({ theme: custom.name, custom: [custom] }),
        );
        const workdir = join(data, "data", `theme-css-${width}`);
        await mkdir(workdir, { recursive: true });
        const destination = join(workdir, "AGENTS.md");
        const openedPath = join(workdir, "notes.txt");
        const cssPath = join(workdir, "theme.css");
        await writeFile(destination, "mode = custom\n");
        await symlink(destination, openedPath);
        const sentinel = `${base}theme-css-resource-${width}`;
        const hostile = `@import url("${sentinel}?import");
          ${sample}
          :root {
            --camouflage: linear-gradient(red,red), /*url("data:*/url(${sentinel}?camouflage-original)/*")*/;
            --camouflage-live: linear-gradient(transparent,transparent), /*url("data:*/url(${sentinel}?camouflage-live)/*")*/, linear-gradient(blue,blue);
            --masked: linear-gradient(transparent,transparent), /*url("data:*/url(${sentinel}?camouflage-chain)/*")*/, linear-gradient(blue,blue);
            --next: var(--masked); --last: var(--next);
          }
          #input { background-image: var(--camouflage); }
          [data-theme="thread"] { background-image: var(--camouflage-live); }
          [data-theme="sidebar"] { background-image: var(--last) !important; }
          @font-face { font-family: hostile; src: url("${sentinel}?font"); }
          @property --remote { syntax: "<image>"; inherits: false; initial-value: url("${sentinel}?property"); }
          @keyframes hostile { from { background-image: url("${sentinel}?keyframes"); } }
          [data-theme="composer"] { background-image: var(--remote); }
          [data-theme="user-message"] { visibility: hidden !important; }
          [data-theme="chat-header"] { --external: src("${sentinel}?src"); background-image: var(--external); }
          [data-theme="assistant-message"] {
            background-image: u\\72l("${sentinel}?escaped");
            border-image-source: image-set("${sentinel}?image-set" 1x);
            cursor: url("${sentinel}?cursor"), auto;
            font-family: hostile;
            animation: hostile 1s infinite;
          }
          [data-theme-protected], iframe.side-frame { visibility: hidden !important; opacity: 0 !important; }
          [data-theme="pane"]:has([data-theme-protected])::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: red; }`;
        await writeFile(cssPath, hostile);
        const fixture = await postFixture(base, "seed-theme-css", {
          agent: `theme-css-${width}`,
          workdir,
          name: custom.name,
          cssPath,
          destination: openedPath,
        });
        const context = await browser.newContext({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        });
        const page = await context.newPage();
        const requests: string[] = [];
        page.on("request", (request) => {
          if (request.url().startsWith(sentinel)) requests.push(request.url());
        });
        await page.route(`${sentinel}**`, (route) =>
          route.fulfill({ body: "blocked fixture resource" }),
        );
        const settled = async (id: string) => {
          const conv = await (
            await page.request.get(`${base}api/conversations/${id}`)
          ).json();
          return conv.status === "idle" && !conv.pending?.length;
        };
        const openCss = async () => {
          await openSettingsPanel(page);
          await page
            .getByRole("button", { name: "Appearance", exact: true })
            .click();
          await openDetail(page, "Custom CSS");
          return page.locator('textarea[name="custom-css"]');
        };
        const closeCss = async () => {
          await closeDetail(page, "Custom CSS");
          await page.locator("#settings-close").click();
        };
        try {
          await page.goto(`${base}#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          const input = await openCss();
          await input.scrollIntoViewIfNeeded();
          await browserExpect.poll(() => themeCornersHit(input)).toBe(true);
          await input.fill(preview);
          await browserExpect.poll(() => themeCornersHit(input)).toBe(false);
          const editor = input.locator("..").locator("..");
          await editor
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await browserExpect(input).toHaveValue("");
          await browserExpect.poll(() => themeCornersHit(input)).toBe(true);
          await input.fill(preview);
          for (const size of width === 412 ? [] : [412, 1280]) {
            await page.setViewportSize({ width: size, height: 915 });
            await browserExpect(
              page.locator(
                size <= 700 ? "dialog:modal" : "dialog.settings-subpage[open]",
              ),
            ).toHaveAccessibleName("Custom CSS");
            if (size > 700)
              await browserExpect(page.locator("dialog:modal")).toHaveCount(0);
            await browserExpect(input).toHaveValue(preview);
            await input.evaluate((element) =>
              element.scrollIntoView({ block: "nearest" }),
            );
            const previewed = await probeInView(input);
            expect(previewed).toMatchObject({ inView: true, hit: false });
            await editor
              .getByRole("button", { name: "Cancel", exact: true })
              .dispatchEvent("click");
            await browserExpect(input).toHaveValue("");
            await browserExpect
              .poll(() => probeInView(input))
              .toEqual({ ...previewed, hit: true });
            await input.fill(preview);
            await browserExpect.poll(() => themeCornersHit(input)).toBe(false);
          }
          await input.focus();
          await page.keyboard.press("Escape");
          await browserExpect(
            page.getByRole("dialog", { name: "Custom CSS", exact: true }),
          ).toBeHidden();
          await browserExpect(page.locator("#settings-modal")).toBeVisible();
          await browserExpect(
            page.locator(".settings-row").filter({ hasText: /^Custom CSS/ }),
          ).toBeFocused();
          await openDetail(page, "Custom CSS");
          await browserExpect(input).toHaveValue("");
          await browserExpect.poll(() => themeCornersHit(input)).toBe(true);
          await input.fill(preview);
          await editor
            .getByRole("button", { name: "Save", exact: true })
            .click();
          await browserExpect
            .poll(
              async () =>
                (
                  await (
                    await page.request.get(`${base}api/settings/theme`)
                  ).json()
                ).customCss,
            )
            .toBe(preview);
          expect(JSON.parse(await readFile(path, "utf8")).custom[0].css).toBe(
            preview,
          );
          await closeCss();
          await page.reload();
          const persisted = await openCss();
          await browserExpect(persisted).toHaveValue(preview);
          await browserExpect
            .poll(() => themeCornersHit(persisted))
            .toBe(false);
          await closeCss();
          await page.goto(`${base}#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          await page
            .locator("#input:enabled")
            .fill("Select the custom CSS from the supplied file.");
          await page.locator("#send").click();
          const link = page.locator(
            `.msg.assistant a[data-file-path="${openedPath}"]`,
          );
          await link.waitFor();
          await browserExpect
            .poll(
              async () =>
                (
                  await (
                    await page.request.get(`${base}api/settings/theme`)
                  ).json()
                ).customCss,
            )
            .toBe(hostile);
          await browserExpect
            .poll(() =>
              themeCornersHit(
                page.locator('[data-theme="user-message"]').last(),
              ),
            )
            .toBe(false);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const browser = globalThis as any;
                browser.requestAnimationFrame(() =>
                  browser.requestAnimationFrame(resolve),
                );
              }),
          );
          expect(requests.filter((url) => url.includes("camouflage"))).toEqual(
            [],
          );
          expect(requests).toEqual([]);
          await page.goto(`${base}?customCss=off#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          const message = page.locator('[data-theme="user-message"]').last();
          await message.scrollIntoViewIfNeeded();
          await browserExpect.poll(() => themeCornersHit(message)).toBe(true);
          await page.goto(`${base}#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          await message.scrollIntoViewIfNeeded();
          await browserExpect.poll(() => themeCornersHit(message)).toBe(false);
          await link.click();
          const view = page.locator(".pane-col.file-tab .explorer").last();
          const destinationBar = view.locator(".explorer-alias");
          await browserExpect(destinationBar).toHaveText(
            `Opens ${openedPath} → saves to ${destination}`,
          );
          const modelWarning = view.locator(
            '[data-theme-protected="model-file-warning"]',
          );
          await browserExpect(modelWarning).toContainText(
            "Don’t save secrets here.",
          );
          await browserExpect
            .poll(() => themeCornersHit(modelWarning))
            .toBe(true);
          await browserExpect
            .poll(() => themeCornersHit(destinationBar))
            .toBe(true);
          await view.getByRole("button", { name: "Edit", exact: true }).click();
          await browserExpect
            .poll(() =>
              themeCornersHit(
                view.getByRole("button", { name: "Save", exact: true }),
              ),
            )
            .toBe(true);
          await view
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Close notes.txt", exact: true })
            .click();
          await browserExpect.poll(() => themeCornersHit(message)).toBe(false);
          await page
            .locator("#input:enabled")
            .fill("/btw Summarize this conversation.");
          await page.locator("#send").click();
          const sidePane = page.locator('.pane-col[data-pane="side"]');
          const frame = sidePane.locator("iframe.side-frame");
          await frame.waitFor({ state: "attached" });
          await browserExpect.poll(() => themeCornersHit(frame)).toBe(true);
          const sideId = (await frame.getAttribute("data-side"))!;
          await browserExpect.poll(() => settled(sideId)).toBe(true);
          await page
            .getByRole("button", {
              name: "Close Side conversations",
              exact: true,
            })
            .click();
          await browserExpect.poll(() => themeCornersHit(message)).toBe(false);
          await openSettingsPanel(page);
          await page
            .locator('#settings-nav button[data-cat="account"]')
            .click();
          await browserExpect(
            page.locator(
              '[data-theme-protected="two-factor-sign-in"] input[name="password"]',
            ),
          ).toHaveCount(1);
          await browserExpect(
            page.locator('#settings-overlay input[name="current"]'),
          ).toHaveCount(1);
          if (width === 412) {
            await page
              .getByRole("button", {
                name: "Back to all settings",
                exact: true,
              })
              .click();
            await browserExpect(
              page.locator(
                '#settings-overlay [data-theme-protected], #settings-overlay input[type="password"]',
              ),
            ).toHaveCount(0);
          }
          await page
            .locator('#settings-nav button[data-cat="appearance"]')
            .click();
          await browserExpect(
            page.locator(
              '#settings-overlay [data-theme-protected], #settings-overlay input[type="password"]',
            ),
          ).toHaveCount(0);
          if (width === 412)
            await page
              .getByRole("button", {
                name: "Back to all settings",
                exact: true,
              })
              .click();
          await page
            .locator('#settings-nav button[data-cat="account"]')
            .click();
          await browserExpect(
            page.locator('#settings-overlay input[name="current"]'),
          ).toHaveCount(1);
          await page.locator("#settings-close").click();
          await browserExpect(
            page.locator("#settings-sections > *"),
          ).toHaveCount(0);
          await writeFile(
            path,
            JSON.stringify({
              theme: custom.name,
              custom: [
                {
                  ...custom,
                  css: `${hostile}\n#settings-overlay:not(.on), .settings-cat[hidden] { display: block !important; }`,
                },
              ],
            }),
          );
          await page.reload();
          await browserExpect
            .poll(() => themeCornersHit(page.locator("#settings-close")))
            .toBe(true);
          await browserExpect(
            page.locator("#settings-overlay"),
          ).not.toHaveClass(/\bon\b/);
          await browserExpect(
            page.locator(
              '#settings-overlay [data-theme-protected], #settings-overlay input[type="password"], #settings-overlay .setup-key, #settings-overlay .recovery-codes',
            ),
          ).toHaveCount(0);
          await browserExpect.poll(() => settled(fixture.agent)).toBe(true);
          const safetyPosts: boolean[] = [];
          page.on("request", (request) => {
            if (
              request.method() === "POST" &&
              new URL(request.url()).pathname ===
                `/api/conversations/${fixture.agent}/safety`
            )
              safetyPosts.push(request.postDataJSON().off);
          });
          const safetyOff = async () =>
            (
              await (
                await page.request.get(
                  `${base}api/conversations/${fixture.agent}`,
                )
              ).json()
            ).safety_off;
          await writeFile(
            path,
            JSON.stringify({
              theme: custom.name,
              custom: [
                {
                  ...custom,
                  css: `${hostile}\n#safety-btn { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; opacity: 0 !important; }`,
                },
              ],
            }),
          );
          await page.goto(`${base}#agent=${fixture.agent}`);
          await reloadConversation(page);
          await focusComposer(page);
          await page.locator("#model-trigger").click();
          const returnFocus = page.locator(
            width === 412 ? "#input" : "#model-trigger",
          );
          const overlayHit = () =>
            page
              .locator("#safety-btn")
              .evaluate(
                (element, x) =>
                  element.contains(
                    element.ownerDocument.elementFromPoint(x, 200),
                  ),
                width - 100,
              );
          await browserExpect.poll(overlayHit).toBe(true);
          expect(await safetyOff()).toBe(false);
          await page.mouse.click(width - 100, 200);
          const confirmation = page.getByRole("dialog", {
            name: "Turn off safety review?",
            exact: true,
          });
          await browserExpect(confirmation).toBeVisible();
          expect(safetyPosts).toEqual([]);
          expect(await safetyOff()).toBe(false);
          const confirmOff = confirmation.getByRole("button", {
            name: "Turn off safety review",
            exact: true,
          });
          await browserExpect
            .poll(() => themeCornersHit(confirmOff))
            .toBe(true);
          await browserExpect
            .poll(() =>
              themeCornersHit(
                confirmation.getByRole("button", {
                  name: "Cancel",
                  exact: true,
                }),
              ),
            )
            .toBe(true);
          const [cancelBox, offBox, textBox] = await Promise.all(
            [
              confirmation.getByRole("button", { name: "Cancel", exact: true }),
              confirmOff,
              confirmation.locator("p"),
            ].map((target) => target.boundingBox()),
          );
          expect({
            dismissFirst: cancelBox!.x + cancelBox!.width < offBox!.x,
            oneRow: cancelBox!.y === offBox!.y,
            confirmTrailing:
              Math.abs(
                offBox!.x + offBox!.width - (textBox!.x + textBox!.width),
              ) < 1,
          }).toEqual({
            dismissFirst: true,
            oneRow: true,
            confirmTrailing: true,
          });
          await page.screenshot({
            path: join(shots, `safety-confirm-${width}.png`),
          });
          await confirmation
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await browserExpect(confirmation).toHaveCount(0);
          await browserExpect(returnFocus).toBeFocused();
          await page.locator("#model-trigger").click();
          await browserExpect.poll(overlayHit).toBe(true);
          expect(safetyPosts).toEqual([]);
          await page.mouse.click(width - 100, 200);
          await browserExpect(confirmation).toBeVisible();
          await page.keyboard.press("Escape");
          await browserExpect(confirmation).toHaveCount(0);
          await browserExpect(returnFocus).toBeFocused();
          expect(safetyPosts).toEqual([]);
          expect(await safetyOff()).toBe(false);
          await writeFile(
            path,
            JSON.stringify({
              theme: custom.name,
              custom: [
                {
                  ...custom,
                  css: `${sample}\n#side-frame-parking { display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }
              #side-frame-parking iframe { display: block !important; visibility: visible !important; opacity: 1 !important; width: 100% !important; height: 100% !important; pointer-events: auto !important; }`,
                },
              ],
            }),
          );
          await page.reload();
          const parked = page.locator("#side-frame-parking iframe.side-frame");
          await browserExpect(parked).toBeVisible();
          const parkedInput = page
            .frameLocator("#side-frame-parking iframe.side-frame")
            .locator("#input:enabled");
          await parkedInput.waitFor();
          await parkedInput.evaluate((element) => {
            const owner = element.ownerDocument.defaultView! as unknown as {
              parkedClicks: number;
            };
            owner.parkedClicks = 0;
            element.ownerDocument.addEventListener(
              "click",
              () => owner.parkedClicks++,
            );
          });
          const parkedBox = (await parkedInput.boundingBox())!;
          await page.mouse.click(
            parkedBox.x + parkedBox.width / 2,
            parkedBox.y + parkedBox.height / 2,
          );
          expect(
            await parkedInput.evaluate(
              (element) =>
                (
                  element.ownerDocument.defaultView! as unknown as {
                    parkedClicks: number;
                  }
                ).parkedClicks,
            ),
          ).toBe(0);
          expect(
            await parked.evaluate(
              (element) => element.ownerDocument.activeElement === element,
            ),
          ).toBe(false);
          await writeFile(
            path,
            JSON.stringify({
              theme: custom.name,
              custom: [
                {
                  ...custom,
                  css: `${sample}\n#input { visibility: hidden !important; }`,
                },
              ],
            }),
          );
          await page.goto(`${base}?customCss=off#agent=${fixture.agent}`);
          await page.locator("#input:enabled").waitFor();
          await browserExpect
            .poll(() => themeCornersHit(page.locator("#input")))
            .toBe(true);
          if (width === 412) {
            await page.locator("#pane-fab").tap();
            await page.locator('.pane-menu-item[data-pane="side"]').tap();
          } else await page.locator('.rail-btn[data-pane="side"]').click();
          await browserExpect(frame).toHaveAttribute(
            "src",
            /[?&]customCss=off(?:&|#)/,
          );
          const sideInput = page
            .frameLocator('.pane-col[data-pane="side"] iframe.side-frame')
            .locator("#input:enabled");
          await sideInput.waitFor();
          await browserExpect.poll(() => themeCornersHit(sideInput)).toBe(true);
          const createdSide = await page.request.post(
            `${base}api/conversations/${fixture.agent}/side`,
            { data: {} },
          );
          expect(createdSide.ok()).toBe(true);
          const secondSide = ((await createdSide.json()) as { id: string }).id;
          await sidePane
            .locator(`.side-picker option[value="${secondSide}"]`)
            .waitFor({ state: "attached" });
          await sidePane.locator(".side-picker").selectOption(secondSide);
          await browserExpect
            .poll(() =>
              sideInput.evaluate((element) => ({
                search: element.ownerDocument.location.search,
                hash: element.ownerDocument.location.hash,
              })),
            )
            .toEqual({
              search: "?embed=1&customCss=off",
              hash: `#agent=${encodeURIComponent(secondSide)}`,
            });
          await browserExpect.poll(() => themeCornersHit(sideInput)).toBe(true);
          await writeFile(
            path,
            JSON.stringify({
              theme: custom.name,
              custom: [{ ...custom, css: sample }],
            }),
          );
          const samplePage = await browser.newPage({
            viewport: { width, height: 915 },
            isMobile: width === 412,
          });
          try {
            await samplePage.goto(`${base}#agent=${fixture.agent}`, {
              waitUntil: "domcontentloaded",
            });
            await samplePage.locator("#input:enabled").waitFor();
            await samplePage
              .getByRole("link", { name: openedPath, exact: true })
              .first()
              .waitFor();
            await samplePage.screenshot({ path: join(shots, `${width}.png`) });
          } finally {
            await samplePage.close();
          }
          expect(requests).toEqual([]);
        } finally {
          await context.close();
        }
      }
    } finally {
      await rm(path, { force: true });
    }
  },
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
        await openSettingsPanel(page);
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await browserExpect(page.locator(".theme-cards")).not.toBeVisible();
        await browserExpect(
          page.locator(".theme-appearance"),
        ).not.toBeVisible();
        await openDetail(page, "Appearance");
      };
      await page.route(`${base}api/settings/theme`, (route) => route.abort());
      await open();
      await browserExpect(appearanceButtons).toHaveCount(3);
      await page
        .getByRole("dialog", { name: "Appearance", exact: true })
        .getByText("Couldn't load themes. Reopen Settings to try again.", {
          exact: true,
        })
        .waitFor();
      for (const button of await appearanceButtons.all())
        await browserExpect(button).toBeDisabled();
      await closeDetail(page, "Appearance");
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
      await browserExpect(
        page.locator('.theme-cards button[data-theme="Tokyo Night"]'),
      ).toHaveCount(1);
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
        await closeDetail(page, "Appearance");
        await openDetail(page, "Theme");
        await page.locator(`.theme-cards button[data-theme="${name}"]`).click();
        await bg(name);
        await closeDetail(page, "Theme");
        await browserExpect(
          page.locator(".settings-row").filter({ hasText: /^Theme/ }),
        ).toContainText(name);
        await openDetail(page, "Appearance");
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
      await closeDetail(page, "Appearance");
      await openDetail(page, "Theme");
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
        await openSettingsPanel(page);
        for (const tab of await page.locator("#settings-nav button").all()) {
          await tab.click();
          expect(await tab.getAttribute("class")).toContain("on");
          await page
            .locator(".settings-cat:not([hidden]) .settings-back")
            .click();
        }
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await openDetail(page, "Sidebar");
        await page
          .getByRole("dialog", { name: "Sidebar", exact: true })
          .getByText("Built-in script", { exact: true })
          .waitFor();
        await browserExpect(
          page.locator(".settings-section:has(.sidebar-script) [role=status]"),
        ).toHaveCount(0);
        await closeDetail(page, "Sidebar");
        await openDetail(page, "Theme");
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
      await page
        .getByRole("dialog", { name: "Theme", exact: true })
        .getByText(state.problems[0], { exact: true })
        .waitFor();
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
      await closeDetail(page, "Theme");
      await openDetail(page, "Appearance");
      await browserExpect(
        page
          .getByRole("group", { name: "Appearance", exact: true })
          .getByRole("button", { name: "Light", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await closeDetail(page, "Appearance");
      await openDetail(page, "Theme");
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
      await closeDetail(page, "Theme");
      await openDetail(page, "Appearance");
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
      await closeDetail(page, "Appearance");
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
      await closeDetail(page, "Theme");
      await page.locator("#settings-close").click();
      await open();
      expect(await pick("Nord").getAttribute("aria-pressed")).toBe("true");
      rejectSave();
      await page
        .getByRole("dialog", { name: "Theme", exact: true })
        .getByText("Theme rejected", { exact: true })
        .waitFor();
      expect(await pick("Material Dark").getAttribute("aria-pressed")).toBe(
        "true",
      );
      await page.unroute(`${base}api/settings/theme`);
      await page.route(`${base}api/settings/theme`, (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue(),
      );
      await pick("Nord").click();
      await page
        .getByRole("dialog", { name: "Theme", exact: true })
        .locator(".msg.err:not([hidden])")
        .waitFor();
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
];
if (import.meta.main) await runBrowserTests([["themes", tests]]);
