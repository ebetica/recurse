import { expect } from "bun:test";
import {
  captureErrors,
  gotoRoot,
  PNG_1X1,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const measure = `(source) => {
  const c = document.createElement('canvas');
  c.width = source.naturalWidth || source.width; c.height = source.naturalHeight || source.height;
  const ctx = c.getContext('2d'); ctx.drawImage(source, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const box = (test) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) {
      const x = i / 4 % c.width, y = Math.floor(i / 4 / c.width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  };
  const near = (v) => Math.abs(v - 128) < 8;
  return { width: c.width, height: c.height,
    photo: box((r, g, b) => near(r) && near(g) && near(b)),
    ink: box((r, g, b) => r > 150 && g < 110 && b < 110),
    corner: [...d.slice(d.length - 4)] };
}`;

type Box = { x: number; y: number; width: number; height: number };
type Pixels = {
  width: number;
  height: number;
  photo: Box;
  ink: Box | null;
  corner: number[];
};

// Regression: #2697 drawing survives Files preview reloads during mount and export. (also #2827 Done attaches the drawing and closes the preview without leaving a history entry.; #2608 exports retain strokes and text outside the photo.)
const drawing: BrowserTest = async (browser, base) => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile
        ? { width: 412, height: 844 }
        : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const offOrigin: string[] = [];
    await context.route(
      (url) => !url.href.startsWith(base),
      (route) => {
        offOrigin.push(route.request().url());
        return route.abort();
      },
    );
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { demo } = (await postFixture(base, "seed-files-pane")) as {
      demo: string;
    };
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    const original = await page.evaluate<string>(`(() => {
      const c = document.createElement('canvas'); c.width = 4000; c.height = 2400;
      const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(128, 128, 128)'; ctx.fillRect(0, 0, 4000, 2400);
      return c.toDataURL().split(',')[1];
    })()`);
    await page.locator("#attach:enabled").waitFor();
    await page.locator("#file-input").setInputFiles({
      name: "original.png",
      mimeType: "image/png",
      buffer: Buffer.from(original, "base64"),
    });
    const detail = page.locator(
      '.image-popout .files-detail[aria-label="original.png"]',
    );
    const editor = page.locator(".drawing-editor");
    const draw = page.getByRole("button", { name: "Draw", exact: true });
    const screen = () =>
      page.evaluate<Pixels>(
        `(${measure})(document.querySelector('.drawing-editor canvas.static'))`,
      );
    const startEditor = async () => {
      await draw.click();
      await page
        .locator('.drawing-editor [data-action="done"]:enabled')
        .waitFor();
      await page.waitForFunction(
        `(${measure})(document.querySelector('.drawing-editor canvas.static')).photo !== null`,
      );
    };
    const stroke = async () => {
      const canvas = (await page
        .locator(".drawing-editor canvas.static")
        .boundingBox())!;
      const pixels = await screen();
      const scale = canvas.width / pixels.width;
      const x = canvas.x + pixels.photo.x * scale;
      const y = canvas.y + (pixels.photo.y + pixels.photo.height / 2) * scale;
      const width = pixels.photo.width * scale;
      await page.mouse.move(x + width * 0.3, y);
      await page.mouse.down();
      await page.mouse.move(x + width * 0.7, y, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(
        `(${measure})(document.querySelector('.drawing-editor canvas.static')).ink !== null`,
      );
    };
    const loaded = () =>
      page.evaluate<string[]>(
        `performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('excalidraw'))`,
      );
    await page.locator("#attachments .preview").last().click();
    await detail.waitFor();
    await draw.waitFor();
    expect(await loaded()).toEqual([]);
    await detail.locator("img").dblclick();
    expect(
      await detail.locator(".files-image-frame").evaluate((node) => {
        const browser = globalThis as any;
        return new browser.DOMMatrix(browser.getComputedStyle(node).transform)
          .a as number;
      }),
    ).toBe(2);
    await startEditor();
    expect((await loaded()).length).toBeGreaterThan(0);
    expect(await page.locator(".drawing-editor .excalidraw").count()).toBe(1);
    expect(
      await page.locator(".drawing-editor .excalidraw.theme--dark").count(),
    ).toBe(0);
    await stroke();
    await page.goBack();
    const keep = page.getByRole("button", {
      name: "Keep editing",
      exact: true,
    });
    await keep.waitFor();
    expect(
      await page
        .getByRole("button", { name: "Discard", exact: true })
        .isVisible(),
    ).toBeTrue();
    expect(await editor.count()).toBe(1);
    await keep.click();
    expect(await keep.isVisible()).toBeFalse();
    expect((await screen()).ink).not.toBeNull();
    const photo = (await page
      .locator(".drawing-editor canvas.static")
      .boundingBox())!;
    await page.keyboard.press("t");
    await page.mouse.click(
      photo.x + photo.width / 2,
      photo.y + photo.height / 2 - 60,
    );
    const text = page.locator(".drawing-editor .excalidraw-wysiwyg");
    await text.waitFor();
    await page.keyboard.type("Hi");
    await page.keyboard.press("Escape");
    await text.waitFor({ state: "detached" });
    expect(await keep.isVisible()).toBeFalse();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    expect(await page.locator("#attachments .attach-chip").count()).toBe(1);
    await startEditor();
    await stroke();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await editor.count()).toBe(0);
    expect(await detail.count()).toBe(1);
    expect(
      await draw.evaluate(
        (element) => element === (globalThis as any).document.activeElement,
      ),
    ).toBeTrue();
    await startEditor();
    expect((await screen()).ink).toBeNull();
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    await page.route("**/attachments/*/preview", async (route) => {
      if (route.request().resourceType() === "fetch")
        await detail
          .locator("img")
          .evaluate((image) => image.removeAttribute("src"));
      await route.continue();
    });
    await startEditor();
    await page.unroute("**/attachments/*/preview");
    await stroke();
    const shown = await screen();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    expect(await page.locator(".image-popout").count()).toBe(0);
    await page.waitForFunction(`!history.state?.imagePopout`);
    expect(await page.locator("#attachments .attach-chip").count()).toBe(2);
    await page.waitForFunction(
      `(() => { const images = document.querySelectorAll('#attachments .preview img'); const image = images[images.length - 1]; return images.length === 2 && image.complete && image.naturalWidth > 0; })()`,
    );
    const sent = await page.evaluate<Pixels>(
      `(${measure})([...document.querySelectorAll('#attachments .preview img')].at(-1))`,
    );
    expect(sent.width).toBe(4000);
    expect(sent.height).toBe(2400);
    const fraction = (pixels: Pixels) => {
      const ink = pixels.ink!;
      const { photo } = pixels;
      return {
        left: (ink.x - photo.x) / photo.width,
        right: (ink.x + ink.width - photo.x) / photo.width,
        middle: (ink.y + ink.height / 2 - photo.y) / photo.height,
        thickness: ink.height / photo.height,
      };
    };
    const onScreen = fraction(shown);
    const inFile = fraction(sent);
    expect(Math.abs(inFile.left - onScreen.left)).toBeLessThan(0.02);
    expect(Math.abs(inFile.right - onScreen.right)).toBeLessThan(0.02);
    expect(Math.abs(inFile.middle - onScreen.middle)).toBeLessThan(0.02);
    expect(inFile.thickness / onScreen.thickness).toBeGreaterThan(0.7);
    expect(inFile.thickness / onScreen.thickness).toBeLessThan(1.3);
    if (!mobile) {
      await page.locator("#attachments .preview").first().click();
      await detail.waitFor();
      await startEditor();
      await page.keyboard.press("-");
      await page.keyboard.press("-");
      await page.keyboard.press("-");
      const canvas = (await page
        .locator(".drawing-editor canvas.static")
        .boundingBox())!;
      const pixels = await screen();
      const scale = canvas.width / pixels.width;
      const right = canvas.x + (pixels.photo.x + pixels.photo.width) * scale;
      const middle =
        canvas.y + (pixels.photo.y + pixels.photo.height / 2) * scale;
      await page.mouse.move(right - 40, middle);
      await page.mouse.down();
      await page.mouse.move(right + 40, middle, { steps: 12 });
      await page.mouse.up();
      const below =
        canvas.y + (pixels.photo.y + pixels.photo.height) * scale + 40;
      await page.mouse.move(right - 200, below);
      await page.mouse.down();
      await page.mouse.move(right - 120, below, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.press("t");
      await page.mouse.click(right + 50, middle + 40);
      await page.keyboard.type("Outside");
      await page.keyboard.press("Escape");
      const outsideShown = fraction(await screen());
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      expect(await page.locator(".image-popout").count()).toBe(0);
      await page.waitForFunction(
        `(() => { const image = [...document.querySelectorAll('#attachments .preview img')].at(-1); return image.complete && image.naturalWidth > 0 && document.querySelectorAll('#attachments .preview img').length === 3; })()`,
      );
      const expanded = await page.evaluate<Pixels>(
        `(${measure})([...document.querySelectorAll('#attachments .preview img')].at(-1))`,
      );
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
        const data = await page.evaluate<string>(
          `(() => { const image = [...document.querySelectorAll('#attachments .preview img')].at(-1); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL().split(',')[1]; })()`,
        );
        await Bun.write(
          `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/drawing-export.png`,
          new Uint8Array(Buffer.from(data, "base64")),
        );
      }
      expect(expanded.width).toBeGreaterThan(4000);
      expect(expanded.height).toBeGreaterThan(2400);
      expect(expanded.ink!.y + expanded.ink!.height).toBeLessThan(
        expanded.height - 2,
      );
      expect(expanded.corner).toEqual([255, 255, 255, 255]);
      expect(expanded.photo).toEqual({ x: 0, y: 0, width: 4000, height: 2400 });
      expect(expanded.ink!.x + expanded.ink!.width).toBeGreaterThan(4000);
      expect(
        Math.abs(fraction(expanded).right - outsideShown.right),
      ).toBeLessThan(0.02);
      expect(fraction(expanded).thickness).toBeGreaterThan(0.05);
    }
    expect(errors).toEqual([]);
    expect(offOrigin).toEqual([]);
    expect(
      await page.evaluate<string>(
        `new Promise((resolve) => { document.addEventListener('securitypolicyviolation', (event) => resolve(event.blockedURI), { once: true }); fetch('https://esm.sh/font.woff2').catch(() => {}); })`,
      ),
    ).toContain("esm.sh");
    await context.close();
  }
};
// Regression: #2400 early file, paste and drop attempts cannot vanish before owner readiness.
const attachmentStartup: BrowserTest = async (browser, base) => {
  for (const mode of ["file", "paste", "drop"] as const) {
    const context = await browser.newContext();
    let releaseTree!: () => void;
    const treeGate = new Promise<void>((resolve) => (releaseTree = resolve));
    await context.route(`${base}api/tree**`, async (route) => {
      await treeGate;
      await route.continue();
    });
    const page = await context.newPage();
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url() === `${base}api/attachments`
      )
        uploads.push(request.url());
    });
    try {
      await gotoRoot(page, base);
      const attach = async () => {
        const name = `${mode}.png`;
        if (mode === "file") {
          await page.locator("#file-input").setInputFiles({
            name,
            mimeType: "image/png",
            buffer: Buffer.from(PNG_1X1),
          });
        } else {
          await page.evaluate(
            ({ mode, name, bytes }) => {
              const {
                document,
                DataTransfer,
                File,
                ClipboardEvent,
                DragEvent,
              } = globalThis as any;
              const transfer = new DataTransfer();
              transfer.items.add(
                new File([new Uint8Array(bytes)], name, { type: "image/png" }),
              );
              document.querySelector("#composer").dispatchEvent(
                mode === "paste"
                  ? new ClipboardEvent("paste", {
                      clipboardData: transfer,
                      bubbles: true,
                      cancelable: true,
                    })
                  : new DragEvent("drop", {
                      dataTransfer: transfer,
                      bubbles: true,
                      cancelable: true,
                    }),
              );
            },
            { mode, name, bytes: Array.from(PNG_1X1) },
          );
        }
      };
      await attach();
      expect(await page.locator("#attachments").textContent()).toBe(
        "File not attached: the conversation was not ready. Please attach it again.",
      );
      expect(
        await page.locator("#attachments [role=alert]").isVisible(),
      ).toBeTrue();
      expect(await page.locator("#attach").isDisabled()).toBeTrue();
      expect(await page.locator("#file-input").isDisabled()).toBeTrue();
      expect(uploads).toEqual([]);
      releaseTree();
      await page.locator("#attach:enabled").waitFor();
      expect(await page.locator("#file-input").isEnabled()).toBeTrue();
      expect(await page.locator("#attachments").textContent()).toBe(
        "File not attached: the conversation was not ready. Please attach it again.",
      );
      await attach();
      await page
        .locator("#attachments .attach-chip:not(.uploading) img")
        .waitFor();
      expect(await page.locator("#attachments [role=alert]").count()).toBe(0);
      expect(await page.locator("#attachments .attach-chip").count()).toBe(1);
      expect(uploads).toHaveLength(1);
    } finally {
      releaseTree();
      await context.close();
    }
  }
};
export const tests = [drawing, attachmentStartup];
if (import.meta.main) await runBrowserTests([["image-drawing", tests]]);
