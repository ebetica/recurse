import { expect } from "bun:test";
import { chromium, type Page } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  LOGIN,
  openSettingsPanel,
  runBrowserTests,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";

async function seedImage(page: Page): Promise<{ demo: string; png: string }> {
  return page.evaluate(async () => {
    const browser = globalThis as any;
    const canvas = browser.document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    context.fillStyle = "#00ff00";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png").split(",")[1];
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob(resolve));
    const response = await fetch("/__browser-test/seed-posted-quadrants", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
    if (!response.ok) throw new Error(`seed image: ${response.status}`);
    const { demo } = (await response.json()) as { demo: string };
    return { demo, png };
  });
}

async function openConversation(
  page: Page,
  base: string,
  id: string,
): Promise<void> {
  await page.goto(`${base}#agent=${id}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    "document.querySelector('#conv-title')?.textContent === 'Published quadrant image'",
  );
  await page.locator("#messages:not(.stale):not([inert])").waitFor();
}

export const tests: BrowserTest[] = [
  // Regression: #3020 plain HTTP supports login, image uploads, copy and cross-tab crop sends without secure-context APIs.
  async function test_insecure_http_image_send() {
    const server = await startServer({ auth: true });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let page: Page | undefined;
    let errors: string[] = [];
    let releaseUpload = () => {};
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--host-resolver-rules=MAP recurse-http.test 127.0.0.1",
          "--no-proxy-server",
        ],
      });
      const context = await browser.newContext({
        viewport: { width: 1200, height: 844 },
      });
      page = await context.newPage();
      errors = captureErrors(page);
      const base = server.base.replace("127.0.0.1", "recurse-http.test");
      const response = await page.goto(base);
      expect(response?.status()).toBe(401);
      expect(
        await page.evaluate(() => {
          const browser = globalThis as any;
          return {
            secure: browser.isSecureContext,
            uuid: typeof browser.crypto.randomUUID,
            locks: typeof browser.navigator.locks,
            clipboard: typeof browser.navigator.clipboard,
          };
        }),
      ).toEqual({
        secure: false,
        uuid: "undefined",
        locks: "undefined",
        clipboard: "undefined",
      });
      await page.locator('input[name="password"]').fill(LOGIN);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: "Sign in", exact: true }).click(),
      ]);
      expect(
        (await context.cookies(base)).some(
          (cookie) => cookie.name === "chat_auth",
        ),
      ).toBeTrue();
      await page.locator(".agent").first().waitFor();

      const composer = await seedImage(page);
      await openConversation(page, base, composer.demo);
      await page.locator("#input").fill("Describe this HTTP image");
      await page.locator("#file-input").setInputFiles({
        name: "http-composer.png",
        mimeType: "image/png",
        buffer: Buffer.from(composer.png, "base64"),
      });
      await page
        .locator("#attachments .attach-chip:not(.uploading):not(.failed)")
        .waitFor();
      await page.locator("#send").click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      await page.locator('#messages img[alt="http-composer.png"]').waitFor();
      await page.evaluate(() => {
        const browser = globalThis as any;
        browser.document.addEventListener("copy", () => {
          const active = browser.document.activeElement;
          browser.httpCopiedText =
            browser.getSelection()?.toString() ||
            active?.value?.slice(active.selectionStart, active.selectionEnd);
        });
      });
      await page.locator('#conv-title[role="button"]').click();
      await page.locator("#conv-title.copied").waitFor();
      expect(await page.evaluate<string>("globalThis.httpCopiedText")).toBe(
        composer.demo,
      );

      const crop = await seedImage(page);
      await openConversation(page, base, crop.demo);
      const other = await context.newPage();
      const otherErrors = captureErrors(other);
      await other.goto(`${base}#agent=${crop.demo}`);
      await other.locator("#conv-title").waitFor();
      const deliveries: string[] = [];
      const deletions: string[] = [];
      let uploads = 0;
      context.on("request", (request) => {
        if (request.url().endsWith(`/api/conversations/${crop.demo}/deliver`))
          deliveries.push(request.url());
        if (
          request.method() === "DELETE" &&
          request.url().includes("/attachment-crops/")
        )
          deletions.push(request.url());
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/attachments")
        )
          uploads++;
      });
      const started = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url() === `${base}api/attachments`,
      );
      const gate = new Promise<void>((resolve) => (releaseUpload = resolve));
      await page.route(`${base}api/attachments`, async (route) => {
        await gate;
        await route.continue();
      });
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Keep this HTTP crop");
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${crop.demo}/deliver`),
      );
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      await started;
      await pane.waitFor({ state: "detached" });
      const pending = other.locator("[data-comment-send]");
      await pending.getByText("Waiting for another tab…").waitFor();
      expect(await pending.getByRole("button").count()).toBe(0);
      other.once("dialog", (dialog) => void dialog.accept());
      await other.reload();
      await pending.getByText("Waiting for another tab…").waitFor();
      expect(await pending.getByRole("button").count()).toBe(0);
      expect(uploads).toBe(1);
      expect(deliveries).toHaveLength(0);
      expect(deletions).toHaveLength(0);
      releaseUpload();
      const content = (await delivered).postDataJSON().content as string;
      expect(content).toContain("Keep this HTTP crop");
      expect(content).toContain("attached as quadrants-box-1.jpg");
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      await pending.waitFor({ state: "detached" });
      expect(deliveries).toHaveLength(1);
      expect(uploads).toBe(1);
      const sent = page.locator('#messages img[alt="quadrants-box-1.jpg"]');
      await sent.waitFor();
      const pixels = await sent.evaluate(async (image: any) => {
        await image.decode();
        const canvas = image.ownerDocument.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return {
          width: canvas.width,
          height: canvas.height,
          pixel: Array.from(context.getImageData(0, 0, 1, 1).data),
        };
      });
      expect(Math.abs(pixels.width - 200)).toBeLessThanOrEqual(2);
      expect(Math.abs(pixels.height - 160)).toBeLessThanOrEqual(2);
      expect(pixels.pixel[0]).toBeLessThanOrEqual(5);
      expect(pixels.pixel[1]).toBeGreaterThanOrEqual(250);
      expect(pixels.pixel[2]).toBeLessThanOrEqual(5);
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await page
        .locator(".settings-cat:not([hidden])")
        .getByText(/HTTPS/)
        .waitFor();
      expect(
        await page.locator('input[name="notify"]').isDisabled(),
      ).toBeTrue();
      expect(errors).toEqual([]);
      expect(otherErrors).toEqual([]);
      await closeWithRoutes(context);
    } catch (error) {
      console.error(
        "HTTP browser failure",
        JSON.stringify(
          {
            url: page?.url(),
            errors,
            dom: await page
              ?.evaluate(() => {
                const browser = globalThis as any;
                return {
                  title:
                    browser.document.querySelector("#conv-title")?.textContent,
                  messagesClass:
                    browser.document.querySelector("#messages")?.className,
                  selectedRows: Array.from(
                    browser.document.querySelectorAll(".agent.selected"),
                    (row: any) => ({
                      id: row.dataset.id,
                      visible: row.checkVisibility(),
                    }),
                  ),
                };
              })
              .catch(() => undefined),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      releaseUpload();
      await browser?.close();
      await stopServer(server);
    }
  },
];
if (import.meta.main) await runBrowserTests([["http", tests]]);
