import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { expect as browserExpect } from "playwright/test";
import { postFixture, waitForLayout, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Feature: #3021 thread images show filenames without letterboxed frames.
  async function test_image_filename_captions(browser, base) {
    const page = await browser.newPage();
    try {
      const appearance = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "Tokyo Night", appearance: "system" },
      });
      expect(appearance.ok()).toBeTrue();
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200; canvas.height = 300;
        const context = canvas.getContext('2d');
        context.fillStyle = '#e8edf2'; context.fillRect(0, 0, 1200, 300);
        context.strokeStyle = '#3477a0'; context.lineWidth = 6;
        context.beginPath(); context.moveTo(40, 240);
        for (let x = 40; x < 1160; x += 20) context.lineTo(x, 220 - x / 8 + 25 * Math.sin(x / 70));
        context.stroke(); return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const response = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      expect(response.ok()).toBeTrue();
      const { demo } = await response.json();
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').waitFor();
      const longName =
        "training-loss-validation-results-with-a-long-filename.png";
      await page.locator("#file-input").setInputFiles(
        ["image.png", longName].map((name) => ({
          name,
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        })),
      );
      await browserExpect(
        page.locator(
          "#attachments .attach-chip:not(.uploading):not(.failed) img",
        ),
      ).toHaveCount(2);
      await page.locator("#input").fill("Here is the uploaded image.");
      await page.locator("#send").click();
      await page
        .getByText("Acknowledged. Images: 2", { exact: true })
        .waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          for (const name of ["quadrants.png", "image.png", longName]) {
            const image = page.locator(`#messages img[alt="${name}"]`);
            await image.evaluate((image: any) => image.decode());
            if (name === "quadrants.png")
              await page
                .locator(".agent-attachment-item.image.loaded")
                .waitFor();
            const frame = image.locator("..");
            const caption = frame.locator(".image-filename");
            await browserExpect(caption).toHaveText(name);
            await browserExpect(caption).toHaveAttribute("title", name);
            const geometry = await frame.evaluate((frame: any) => {
              const image = frame.querySelector("img").getBoundingClientRect();
              const caption = frame
                .querySelector(".image-filename")
                .getBoundingClientRect();
              return {
                gap: caption.top - image.bottom,
                ratio: image.width / image.height,
                bottomGap:
                  (
                    frame.closest(".agent-attachment-item.image") ?? frame
                  ).getBoundingClientRect().bottom - caption.bottom,
              };
            });
            expect(Math.abs(geometry.gap)).toBeLessThan(1);
            expect(geometry.ratio).toBeCloseTo(4, 1);
            expect(geometry.bottomGap).toBeLessThan(3);
            if (width === 390 && name === longName)
              expect(
                await caption.evaluate(
                  (caption: any) => caption.scrollWidth > caption.clientWidth,
                ),
              ).toBeTrue();
          }
          await waitForLayout(page);
          const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
          if (shots) {
            await mkdir(shots, { recursive: true });
            await page.screenshot({
              path: `${shots}/image-captions-${width}-${colorScheme}.png`,
            });
          }
        }
      }
      const published = page.locator('#messages img[alt="quadrants.png"]');
      const source = (await published.getAttribute("src"))!.replace(
        /\/thumbnail$/,
        "",
      );
      await published.click();
      await page.locator("dialog.image-popout .files-detail img").waitFor();
      await page
        .getByRole("button", { name: "Close image", exact: true })
        .click();
      await page.locator("dialog.image-popout").waitFor({ state: "hidden" });
      await postFixture(base, "seed-model-selection-error", {
        agent: "filename-markdown",
        model: "fauxordinary/faux-1",
      });
      await page.goto(`${base}#agent=filename-markdown`);
      await page
        .locator("#input:enabled")
        .fill(`Reply only ![A descriptive plot label](${source})`);
      await page.locator("#send").click();
      const inline = page.locator(".msg.assistant .thread-image");
      await browserExpect(inline.locator(".image-filename")).toHaveText(
        "quadrants.png",
      );
      await browserExpect(inline.locator("img")).toHaveAttribute(
        "alt",
        "A descriptive plot label",
      );
      await inline.locator("img").evaluate((image: any) => image.decode());
      expect(
        await inline.evaluate((frame: any) =>
          Math.abs(
            frame.querySelector(".image-filename").getBoundingClientRect().top -
              frame.querySelector("img").getBoundingClientRect().bottom,
          ),
        ),
      ).toBeLessThan(1);
    } finally {
      await page.close();
    }
  },
  // Feature: #2951 live publications reach the open thread and Files while the turn continues.
  async function test_live_publication_arrives_on_open_stream(browser, base) {
    const { agent } = await postFixture(base, "seed-live-publication");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.addInitScript((id) => {
      const browser = globalThis as any;
      const fetch = browser.fetch.bind(browser);
      browser.stallLiveEvents = false;
      browser.fetch = async (...args: any[]) => {
        const response = await fetch(...args);
        const url = new URL(
          typeof args[0] === "string" ? args[0] : args[0].url,
          browser.location.href,
        );
        if (
          url.pathname !== `/api/conversations/${id}/events` ||
          !response.body
        )
          return response;
        const body = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (browser.stallLiveEvents) return;
              if (
                new TextDecoder()
                  .decode(chunk)
                  .includes('"turn_status":"running"')
              ) {
                browser.lastRunningChunk = chunk.slice();
                browser.replayRunningChunk = () =>
                  controller.enqueue(browser.lastRunningChunk);
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    }, agent);
    let streams = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === `/api/conversations/${agent}/events`
      )
        streams++;
    });
    try {
      const connected = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/events`,
      );
      await page.goto(`${base}#agent=${agent}`);
      await connected;
      await page.locator('.rail-btn[data-pane="files"]').click();
      const pane = page.locator('.pane-col[data-pane="files"]');
      await pane.locator(".files-card", { hasText: "existing.txt" }).waitFor();
      await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/conversations/${agent}` &&
          response.ok(),
      );
      await page.route(`**/api/conversations/${agent}/view**`, (route) =>
        route.abort(),
      );
      const metadata = (url: URL) =>
        url.pathname === `/api/conversations/${agent}`;
      await page.route(metadata, (route) => route.abort());
      const connectedStreams = streams;
      const sent = await page.request.post(
        `${base}api/conversations/${agent}/deliver`,
        {
          data: { content: "Publish the report." },
        },
      );
      expect(sent.ok()).toBeTrue();
      await page.locator(".working.live-panel").waitFor();
      for (const prefix of ["live", "nested"])
        for (let i = 0; i < 5; i++) {
          const name = `${prefix}-report-${i}.txt`;
          await page
            .getByRole("button", { name: `Open ${name} in Files` })
            .waitFor();
          await pane.locator(".files-card", { hasText: name }).waitFor();
        }
      expect(streams).toBe(connectedStreams);
      expect(await page.getByText("Publication finished.").count()).toBe(0);
      await page.unroute(`**/api/conversations/${agent}/view**`);
      await page.unroute(metadata);
      const reconnected = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname ===
          `/api/conversations/${agent}/events`,
      );
      await page.evaluate(() => ((globalThis as any).stallLiveEvents = true));
      await reconnected;
      await postFixture(base, "advance-live-publication");
      await page
        .getByRole("button", { name: "Open recovered-report.txt in Files" })
        .waitFor();
      await pane
        .locator(".files-card", { hasText: "recovered-report.txt" })
        .waitFor();
      expect(streams).toBeGreaterThan(connectedStreams);
      expect(await page.getByText("Publication finished.").count()).toBe(0);

      const reopened = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/events`,
      );
      await page.evaluate(() => {
        const browser = globalThis as any;
        browser.stallLiveEvents = false;
        browser.lastRunningChunk = null;
        browser.dispatchEvent(new Event("focus"));
      });
      await reopened;
      await page.waitForFunction(() =>
        Boolean((globalThis as any).lastRunningChunk),
      );
      await page.route(`**/api/conversations/${agent}/view**`, (route) =>
        route.abort(),
      );
      await page.evaluate(() => ((globalThis as any).stallLiveEvents = true));
      await postFixture(base, "release-live-publication");
      await page.waitForFunction(
        () => !(globalThis as any).document.querySelector("#send.stop"),
      );
      await page.evaluate(() => {
        (globalThis as any).replayRunningChunk();
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            (globalThis as any).requestAnimationFrame(() =>
              (globalThis as any).requestAnimationFrame(() => resolve()),
            ),
          ),
      );
      expect(await page.locator("#send.stop").count()).toBe(0);
    } finally {
      await postFixture(base, "release-live-publication");
      await page.close();
    }
  },
  // Regression: #2951 a silent idle stream reconnects without a tab wake.
  async function test_idle_stalled_stream_reconnects(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-clear");
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const browser = globalThis as any;
      const fetch = browser.fetch.bind(browser);
      browser.stallIdleEvents = false;
      browser.idleStreamChunks = 0;
      browser.fetch = async (...args: any[]) => {
        const response = await fetch(...args);
        if (
          !new URL(String(args[0]), browser.location.href).pathname.endsWith(
            "/events",
          ) ||
          !response.body
        )
          return response;
        const body = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (!browser.stallIdleEvents) {
                browser.idleStreamChunks++;
                controller.enqueue(chunk);
              }
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    });
    try {
      const connected = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/events`,
      );
      await page.goto(`${base}#agent=${agent}`);
      await connected;
      await page.locator("#input").waitFor();
      await page.waitForFunction(
        () => (globalThis as any).idleStreamChunks > 0,
      );
      const before = await page.evaluate(
        () => (globalThis as any).idleStreamChunks,
      );
      await page.route(
        (url) => url.pathname === `/api/conversations/${agent}/events`,
        async (route) => {
          await page.evaluate(
            () => ((globalThis as any).stallIdleEvents = false),
          );
          await route.continue();
        },
      );
      const reconnected = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname ===
          `/api/conversations/${agent}/events`,
        { timeout: 160_000 },
      );
      await page.evaluate(() => ((globalThis as any).stallIdleEvents = true));
      await reconnected;
      await page.waitForFunction(
        (count) => (globalThis as any).idleStreamChunks > count,
        before,
      );
      await page.route(`**/api/conversations/${agent}/view**`, (route) =>
        route.abort(),
      );
      await page.locator("#input").fill("Reply after recovery.");
      await page.locator("#send").click();
      await page.getByText("Before Durable clear.", { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  },
  async function test_thread_images_load_thumbnails_until_opened(
    browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-large-photo");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/conversations/${demo}/attachments/`))
        requested.push(new URL(request.url()).pathname.split("/").pop()!);
    });
    const ending = (suffix: string) =>
      page.waitForResponse((response) => response.url().endsWith(suffix));
    try {
      const thumbnail = ending("/thumbnail");
      await page.goto(`${base}#agent=${demo}`);
      const thread = page.locator('#messages img[alt="photo.png"]');
      await thread.waitFor();
      await thread.evaluate((image: any) => image.decode());
      const small = await thumbnail;
      expect(small.headers()["content-type"]).toBe("image/webp");
      expect(await thread.evaluate((image: any) => image.naturalWidth)).toBe(
        800,
      );
      expect(requested).toEqual(["thumbnail"]);
      const original = ending("/preview");
      await thread.click();
      const full = page.locator(".image-popout .files-detail img");
      await full.waitFor();
      await full.evaluate((image: any) => image.decode());
      const large = await original;
      expect(large.headers()["content-type"]).toBe("image/png");
      expect((await small.body()).byteLength * 4).toBeLessThan(
        (await large.body()).byteLength,
      );
      expect(requested).toEqual(["thumbnail", "preview"]);
      await page
        .locator("dialog.image-popout")
        .getByRole("button", { name: "Open in Files" })
        .click();
      const detail = page.locator(
        '.pane-col[data-pane="files"] .files-detail img',
      );
      await page.waitForFunction(
        `document.querySelector('.pane-col[data-pane="files"] .files-detail img')?.naturalWidth === 800`,
      );
      expect(await detail.getAttribute("src")).toMatch(/\/preview$/);
      const older = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      try {
        await older.route("**/attachments/*/thumbnail", (route) =>
          route.fulfill({ status: 404, body: "not found" }),
        );
        await older.goto(`${base}#agent=${demo}`);
        const shown = older.locator('#messages img[alt="photo.png"]');
        await older.waitForFunction(
          `(() => { const image = document.querySelector('#messages img[alt="photo.png"]'); return image?.getAttribute('src')?.endsWith('/preview') && image.complete && image.naturalWidth === 800; })()`,
        );
        expect(await shown.count()).toBe(1);
      } finally {
        await older.close();
      }
    } finally {
      await page.close();
    }
  },
  // Regression: #2917 departed image downloads must not hold the next conversation's connections.
  async function test_departed_images_cancel_on_switch(browser, base) {
    const gallery = await postFixture(base, "seed-large-image-gallery");
    const target = await postFixture(base, "seed-image-navigation");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const held: import("playwright").Route[] = [];
    const targetHeld: import("playwright").Route[] = [];
    let onRestored: ((route: import("playwright").Route) => void) | undefined;
    let restoredSrc: string | null = null;
    try {
      await page.route(`**/api/conversations/${target.demo}**`, (route) => {
        targetHeld.push(route);
      });
      await page.route(
        `**/api/conversations/${gallery.demo}/attachments/**`,
        (route) => {
          held.push(route);
          if (restoredSrc && route.request().url().endsWith(restoredSrc))
            onRestored?.(route);
        },
      );
      const imageRequest = page.waitForRequest((request) =>
        request
          .url()
          .includes(`/api/conversations/${gallery.demo}/attachments/`),
      );
      await page.goto(`${base}#agent=${gallery.demo}`, {
        waitUntil: "domcontentloaded",
      });
      await imageRequest;
      await page
        .locator("#messages img")
        .first()
        .waitFor({ state: "attached" });
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelectorAll("#messages img[src]")
            .length > 0,
      );
      const outgoing = await page
        .locator("#messages img")
        .first()
        .elementHandle();
      expect(outgoing).not.toBeNull();
      const originalSrc = await outgoing!.getAttribute("src");
      const cancelled = page.waitForEvent("requestfailed", (request) =>
        request
          .url()
          .includes(`/api/conversations/${gallery.demo}/attachments/`),
      );
      await page.locator(`.agent[data-id="${target.demo}"]`).click();
      await page.waitForFunction(
        (image) => !image.hasAttribute("src"),
        outgoing,
      );
      await cancelled;
      restoredSrc = originalSrc;
      const restoredRequest = new Promise<import("playwright").Route>(
        (resolve, reject) => {
          onRestored = resolve;
          AbortSignal.timeout(15_000).addEventListener("abort", () =>
            reject(new Error("restored image request did not start")),
          );
        },
      );
      await page.locator(`.agent[data-id="${gallery.demo}"]`).click();
      expect(await outgoing!.getAttribute("src")).toBe(originalSrc);
      expect(await outgoing!.evaluate((image) => image.isConnected)).toBeTrue();
      await (await restoredRequest).continue();
      await outgoing!.evaluate((image) => (image as any).decode());
      for (const route of targetHeld) await route.abort().catch(() => {});
      await page.unroute(`**/api/conversations/${target.demo}**`);
      await page.locator(`.agent[data-id="${target.demo}"]`).click();
      await page.locator('#messages img[alt="nav-1.png"]').waitFor();
      await page.locator(`.agent[data-id="${gallery.demo}"]`).click();
      const draftImage = await page
        .locator("#messages img")
        .nth(1)
        .elementHandle();
      expect(draftImage).not.toBeNull();
      await page.locator("#new-top").click();
      await page.waitForFunction(
        (image) => !image.hasAttribute("src"),
        draftImage,
      );
      for (const route of held) await route.abort().catch(() => {});
      await page.unroute(`**/api/conversations/${gallery.demo}/attachments/**`);
      await page.goto(`${base}?image-test=1#agent=${gallery.demo}`, {
        waitUntil: "domcontentloaded",
      });
      const image = page.locator("#messages img").first();
      await image.waitFor({ state: "attached" });
      await page.waitForFunction(() => {
        const image = (globalThis as any).document.querySelector(
          "#messages img",
        );
        return image?.complete && image.naturalWidth > 0;
      });
    } finally {
      for (const route of targetHeld) await route.abort().catch(() => {});
      for (const route of held) await route.abort().catch(() => {});
      await page.close();
    }
  },
  // Regression: #2614 intermediate reply images disappeared inside folded activity.
  async function test_folded_reply_images_stay_visible(browser, base) {
    const { agent } = await postFixture(base, "seed-folded-images");
    for (const width of [1280, 412]) {
      const page = await browser.newPage({ viewport: { width, height: 915 } });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .getByText("platform images finished.", { exact: true })
          .waitFor();
        for (const origin of ["operator", "platform"])
          for (const part of ["first", "middle", "last"]) {
            const images = page.locator(
              `#messages img[alt="${origin}-${part}"]`,
            );
            expect(await images.count()).toBe(1);
            await browserExpect(images).toBeVisible();
            expect(await images.isVisible()).toBeTrue();
            await images.evaluate((el: any) => el.decode());
            await browserExpect(
              images.locator("..").locator(".image-filename"),
            ).toHaveText("folded.png");
            expect(
              await images.evaluate(
                (el: any) => el.complete && el.naturalWidth > 0,
              ),
            ).toBeTrue();
          }
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: `${shots}/after-seed-folded-images-${width}.png`,
          });
        expect(
          await page
            .getByText("Hidden operator middle prose.", { exact: true })
            .isVisible(),
        ).toBeFalse();
        for (const toggle of await page
          .locator(".activity-group-toggle")
          .all()) {
          await toggle.click();
          for (const origin of ["operator", "platform"])
            for (const part of ["first", "middle", "last"])
              expect(
                await page
                  .locator(`#messages img[alt="${origin}-${part}"]`)
                  .count(),
              ).toBe(1);
          await toggle.click();
        }
        await page.reload();
        await page
          .getByText("platform images finished.", { exact: true })
          .waitFor();
        expect(
          await page
            .locator('#messages img[alt="operator-middle"]')
            .isVisible(),
        ).toBeTrue();
      } finally {
        await page.close();
      }
    }
  },

  // Regression: #2588 folded wake turns and message headers hid published files and uploads.
  async function test_published_wake_attachments_stay_visible(browser, base) {
    const { agent } = await postFixture(base, "seed-visible-attachments");
    const counts: number[] = [];
    const imageCounts: number[] = [];
    for (const width of [1280, 412]) {
      const page = await browser.newPage({ viewport: { width, height: 915 } });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .getByText("second-report.txt is ready.", { exact: true })
          .waitFor();
        const files = page.locator("#messages .agent-attachment-item.file");
        const images = page.locator('#messages img[alt$="report.txt image"]');
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({ path: `${shots}/attachments-${width}.png` });
        counts.push(await files.count());
        imageCounts.push(await images.count());
        for (const image of await images.all()) {
          await image.evaluate((el: any) => el.decode());
          expect(await image.isVisible()).toBeTrue();
        }
        for (const name of ["first-report.txt", "second-report.txt"])
          expect(
            await page
              .getByRole("button", {
                name: `Open ${name} in Files`,
                exact: true,
              })
              .isVisible(),
          ).toBeTrue();
        const group = page.locator(".activity-group-toggle").last();
        const message = page
          .locator(".agent-message")
          .filter({ has: page.locator('img[alt="first-report.txt image"]') });
        await message.locator(".agent-message-row").click();
        expect(
          await message
            .getByRole("button", { name: "Show message details" })
            .isVisible(),
        ).toBeTrue();
        expect(await images.count()).toBe(2);
        await message.locator(".agent-message-row").click();
        await group.click();
        expect(await files.count()).toBe(2);
        expect(await images.count()).toBe(2);
        await group.click();
        expect(await files.count()).toBe(2);
        expect(await images.count()).toBe(2);
        await page.reload();
        await page
          .getByText("second-report.txt is ready.", { exact: true })
          .waitFor();
        expect(await files.count()).toBe(2);
      } finally {
        await page.close();
      }
    }
    expect(counts).toEqual([2, 2]);
    expect(imageCounts).toEqual([2, 2]);
  },
];
