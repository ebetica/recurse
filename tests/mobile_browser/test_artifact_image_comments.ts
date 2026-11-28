import type { Context } from "@earendil-works/pi-ai";
import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import type { Locator, Page } from "playwright";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import {
  openPage,
  PNG_1X1,
  runBrowserTests,
  screenshot,
  type BrowserTest,
} from "./common";

async function imageGesture(
  page: Page,
  image: Locator,
  gesture: "mouse" | "touch" | "hold-with-jitter",
) {
  await image.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await image.boundingBox())!;
  const from = { x: x + width / 8, y: y + height / 4 };
  const to = { x: x + (3 * width) / 8, y: y + (3 * height) / 4 };
  if (gesture !== "mouse") {
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    await image.locator("..").locator("mark.files-box-start").waitFor();
    const moved = gesture === "touch" ? to : { x: from.x + 5, y: from.y + 5 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [moved],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await dragImageBox(page, from, to);
  }
}

async function dragImageBox(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  beforeRelease?: () => Promise<void>,
) {
  await page.mouse.move(from.x, from.y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await beforeRelease?.();
  await page.mouse.up();
  await page.keyboard.up("Control");
}

async function selectParagraph(page: Page, text: Locator) {
  await text.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await text.boundingBox())!;
  const line = y + height / 2;
  await page.mouse.move(x + 1, line);
  await page.mouse.down();
  await page.mouse.move(x + width + 1, line, { steps: 8 });
  await page.mouse.up();
}

async function readCrop(page: Page, src: string) {
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const colors = [
      [12, 16],
      [46, 25],
      [36, 63],
    ].map(([x, y]) => {
      const [red, green, blue] = context.getImageData(x!, y!, 1, 1).data;
      return red! < 12 && green! > 240 && blue! < 12
        ? "green"
        : red! < 12 && green! < 12 && blue! > 240
          ? "blue"
          : "other";
    });
    return { width, height, colors };
  }, src);
}

const selectedCrop: Awaited<ReturnType<typeof readCrop>> = {
  width: 60,
  height: 80,
  colors: ["green", "green", "blue"],
};

export const tests: BrowserTest[] = [
  // Regression: #3686 keep a small visible drag on a tall image; #3554 comment directly on an Artifact Markdown image.
  async function test_comments_on_embedded_artifact_images(
    browser,
    base,
    data,
  ) {
    const store = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    for (const phone of [false, true]) {
      const { page, errors } = await openPage(browser, {
        viewport: { width: phone ? 412 : 1280, height: 844 },
        touch: phone,
      });
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 160;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "red";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "lime";
        context.fillRect(30, 40, 60, 40);
        context.fillStyle = "blue";
        context.fillRect(30, 80, 60, 40);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const imageBytes = Buffer.from(png, "base64");
      const seed = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        { data: imageBytes, headers: { "Content-Type": "image/png" } },
      );
      expect(seed.ok()).toBeTrue();
      const { demo: owner } = (await seed.json()) as { demo: string };
      const item = await artifacts.create(store, {
        owner,
        title: "Image review",
      });
      const repo = String(item.repo_path);
      const mutablePath = join(repo, "live-diagram.png");
      await Bun.write(join(repo, "marker.png"), PNG_1X1);
      const raster = Uint8Array.from(imageBytes);
      await Bun.write(join(repo, "diagram.png"), raster);
      if (!phone) {
        await Bun.write(mutablePath, raster);
        const tall = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 900;
          canvas.height = 6000;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "steelblue";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "wheat";
          for (let y = 120; y < canvas.height; y += 360)
            context.fillRect(180, y, 540, 120);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        await Bun.write(
          join(repo, "tall.png"),
          Uint8Array.from(Buffer.from(tall, "base64")),
        );
      }
      const entry = join(repo, "index.md");
      await Bun.write(
        entry,
        "# Image review\n\n![External](https://example.com/map.png)\n\n![Marker](marker.png)\n\n![Diagram](diagram.png)\n\n**Check the explanation.**\n" +
          (phone
            ? ""
            : "\n![Live diagram](live-diagram.png)\n\n**Check the explanation.**\n\n![Tall diagram](tall.png)\n"),
      );
      const published = await artifacts.publish(store, owner, String(item.id));
      if (!phone) {
        await Bun.write(entry, "# Newer revision\n");
        await artifacts.publish(store, owner, String(item.id));
      }
      await page.goto(`${base}#agent=${owner}&artifact=${item.id}`);
      const pane = page.locator('.pane-body[data-pane="report"]');
      const doc = pane.locator(".report-doc");
      if (!phone) {
        await pane.getByRole("heading", { name: "Newer revision" }).waitFor();
        await page
          .getByRole("button", { name: "Version history", exact: true })
          .click();
        await page
          .getByRole("menuitemradio")
          .filter({ hasText: String(published.version).slice(0, 8) })
          .click();
      }
      const image = doc.locator('img[alt="Diagram"]:not([hidden])');
      const mutable = doc.locator('img[alt="Live diagram"]:not([hidden])');
      const popover = page.locator(".report-comment-popover:not([hidden])");
      const input = popover.locator("textarea");
      const stage = popover.getByRole("button", {
        name: "Comment",
        exact: true,
      });
      await imageGesture(page, image, phone ? "touch" : "mouse");
      await popover.waitFor();
      await browserExpect(image.locator("..")).toHaveAttribute(
        "title",
        phone ? "Hold to comment" : "Ctrl-drag to comment",
      );
      await input.fill("Change the green area");
      await stage.click();
      const imageCard = pane
        .locator(".report-comment")
        .filter({ hasText: "Box on image: Diagram" });
      const crop = imageCard.locator("img");
      await crop.waitFor();
      expect(await readCrop(page, (await crop.getAttribute("src"))!)).toEqual(
        selectedCrop,
      );
      if (!phone) {
        const tall = doc.locator('img[alt="Tall diagram"]:not([hidden])');
        await tall.scrollIntoViewIfNeeded();
        const { x, y, width, height } = (await tall.boundingBox())!;
        const bounds = (await pane.boundingBox())!;
        const top = Math.max(y, bounds.y);
        const bottom = Math.min(y + height, bounds.y + bounds.height);
        const from = { x: x + width / 4, y: (top + bottom) / 2 };
        const to = { x: x + width / 2, y: from.y + 20 };
        await dragImageBox(page, from, to, async () => {
          await browserExpect(
            tall.locator("..").locator("mark.report-cbox"),
          ).toBeVisible();
          await screenshot(page, "artifact-tall-image-dragging-1280");
        });
        await browserExpect(popover).toBeVisible();
        await browserExpect(input).toBeFocused();
        await screenshot(page, "artifact-tall-image-editor-1280");
        await popover
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      }
      const paragraph = doc.locator("strong").first();
      await selectParagraph(page, paragraph);
      await input.fill("Clarify this paragraph");
      if (!phone) {
        let confirmation = "";
        page.once("dialog", (dialog) => {
          confirmation = dialog.message();
          void dialog.dismiss();
        });
        await imageGesture(page, mutable, "mouse");
        expect(confirmation).toContain("Discard what you typed");
        await browserExpect(input).toHaveValue("Clarify this paragraph");
        await imageGesture(page, image, "hold-with-jitter");
        await doc.locator(".files-box-hint").waitFor();
      }
      await stage.click();
      if (!phone) expect(await doc.locator(".files-box-hint").count()).toBe(1);
      await browserExpect(paragraph.locator("mark.report-cmark")).toContainText(
        "Check the explanation.",
      );
      if (!phone) {
        await imageGesture(page, mutable, "mouse");
        await input.fill("Change the live diagram");
        await stage.click();
        const oldImage = (await image.elementHandle())!;
        await page.locator('.rail-btn[data-pane="tips"]').click();
        await page.setViewportSize({ width: 412, height: 844 });
        await pane.waitFor({ state: "hidden" });
        await page.evaluate(() =>
          window.dispatchEvent(new Event("recurse:theme-changed")),
        );
        expect(
          await oldImage.evaluate((element) => element.isConnected),
        ).toBeFalse();
        await oldImage.dispose();
        await Bun.write(mutablePath, PNG_1X1);
        await page.route(
          (url) =>
            url.pathname === `/api/artifacts/${item.id}/file` &&
            url.searchParams.get("path") === "live-diagram.png",
          (route) => route.abort(),
        );
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.locator('.rail-btn[data-pane="report"]').click();
        const restoredHighlight = paragraph.getByRole("button", {
          name: "Edit comment: Check the explanation.",
        });
        await browserExpect(restoredHighlight).toContainText(
          "Check the explanation.",
        );
        await restoredHighlight.press("Enter");
        await browserExpect(input).toHaveValue("Clarify this paragraph");
        await input.press("Escape");
        await browserExpect(popover).toBeHidden();
        await browserExpect(
          doc.getByText("Image not found: live-diagram.png", { exact: true }),
        ).toBeVisible();
        await browserExpect(doc.locator("mark.report-cbox")).toHaveCount(1);
      }
      await image.locator("..").locator("mark.report-cbox").waitFor();
      await browserExpect(crop).toBeVisible();
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
        await crop.scrollIntoViewIfNeeded();
        await screenshot(
          page,
          `artifact-image-comment-${phone ? "phone" : "desktop"}`,
        );
      }
      await pane.getByRole("button", { name: "Submit comments" }).click();
      if (phone) await page.goBack();
      else await page.locator('.dv-tab[data-dock-panel="chat"]').click();
      const cropCount = phone ? 1 : 2;
      await browserExpect(
        page
          .locator(".msg.assistant")
          .filter({ hasText: `Acknowledged. Images: ${cropCount}` }),
      ).toBeVisible();
      const captured = await page.request.get(
        `${base}api/conversations/${owner}/prompt`,
      );
      expect(captured.ok()).toBeTrue();
      const { request } = (await captured.json()) as {
        request: { context: Context };
      };
      const user = request.context.messages.findLast(
        (message) => message.role === "user",
      );
      const parts = Array.isArray(user?.content) ? user.content : [];
      const content = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(content).toContain('Comments on artifact "Image review"');
      expect(content).toContain(`version: ${published.version},`);
      if (!phone)
        expect(content).toMatch(
          /box 2 \(image 4\), x=30 y=40 w=60 h=80 px in the 240×160 original.*attached as Image-review-box-2\.jpg:\nChange the live diagram/,
        );
      expect(content).toMatch(
        /box 1 \(image 3\), x=30 y=40 w=60 h=80 px in the 240×160 original.*attached as Image-review-box-1\.jpg/,
      );
      expect(content).toContain(
        "Change the green area\n![Image-review-box-1.jpg](",
      );
      expect(content).toContain(
        "> Check the explanation.\nClarify this paragraph",
      );
      const sentCrops = parts.filter((part) => part.type === "image");
      expect(sentCrops).toHaveLength(cropCount);
      for (const { mimeType, data } of sentCrops) {
        const decoded = await readCrop(page, `data:${mimeType};base64,${data}`);
        expect(decoded).toEqual(selectedCrop);
      }
      expect(errors).toEqual([]);
    }
  },
];
if (import.meta.main) await runBrowserTests([["artifact-comments", tests]]);
