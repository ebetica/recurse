import { expect } from "bun:test";
import { createServer } from "node:http";
import type { FrameLocator, Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { captureErrors } from "../common";

export async function watchResourceHints() {
  let connections = 0;
  const requests: string[] = [];
  const browserRequests: string[] = [];
  const listener = createServer((request, response) => {
    const path = request.url!;
    requests.push(path);
    const [type, body] = path.endsWith(".css")
      ? ["text/css", "body { margin: 0 }"]
      : path.endsWith(".js")
        ? ["text/javascript", "export {}"]
        : ["text/html", "<!doctype html><title>Hint fixture</title>"];
    response.writeHead(200, { "content-type": type }).end(body);
  });
  listener.on("connection", () => {
    connections++;
  });
  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("No local hint fixture port"));
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    watch: (page: Page) => {
      page.on("request", (request) => {
        if (new URL(request.url()).port === String(port))
          browserRequests.push(request.url());
      });
    },
    expectQuiet: () => {
      expect(connections).toBe(0);
      expect(requests).toEqual([]);
      expect(browserRequests).toEqual([]);
    },
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        listener.close(() => resolve());
        listener.closeAllConnections();
      }),
  };
}

export function complexHtml(origin: string): string {
  return `<link rel="preconnect" href="${origin}">${"<section>".repeat(130)}<h1>Nested report</h1>${"</section>".repeat(130)}`;
}

export function htmlModes(pane: Locator) {
  const modes = pane.getByRole("group", { name: "HTML view", exact: true });
  return {
    source: modes.getByRole("button", { name: "Source", exact: true }),
    preview: modes.getByRole("button", { name: "Preview", exact: true }),
  };
}

export async function expectHtmlSourceFallback(
  pane: Locator,
  code: Locator,
  source: string,
  open: () => Promise<unknown>,
): Promise<void> {
  const page = pane.page();
  let attachments = 0;
  const onFrame = () => attachments++;
  page.on("frameattached", onFrame);
  try {
    await open();
    const { source: sourceMode, preview } = htmlModes(pane);
    await browserExpect(preview).toBeDisabled();
    await browserExpect(sourceMode).toHaveAttribute("aria-pressed", "true");
    await browserExpect(code).toBeVisible();
    await browserExpect(code).toHaveJSProperty("textContent", source);
    await browserExpect(pane.locator("iframe")).toHaveCount(0);
    expect(attachments).toBe(0);
  } finally {
    page.off("frameattached", onFrame);
  }
}

export async function watchExplorerPreview(page: Page, probe: string) {
  const errors = captureErrors(page);
  const requests: string[] = [];
  await page.route(
    (url) => url.href.startsWith(probe),
    (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Separate preview resource</h1>",
      });
    },
  );
  const formDenied = (error: string) =>
    error.includes(`${probe}form`) &&
    (error.includes("allow-forms") || error.includes(`"form-action 'none'"`));
  const nestedDenied = (error: string) =>
    error.startsWith(`Framing '${new URL(probe).origin}/'`) &&
    error.includes(`"frame-src 'none'"`);
  const imageDenied = (error: string) =>
    error.includes(`${probe}image.png`) && error.includes('"img-src data:"');
  return {
    async submitForm(frame: FrameLocator) {
      await Promise.all([
        page.waitForEvent("console", (message) => formDenied(message.text())),
        frame
          .getByRole("button", { name: "Submit fixture", exact: true })
          .click(),
      ]);
      await browserExpect(
        frame.getByText("Chart data prepared", { exact: true }),
      ).toHaveAttribute("data-form-attempt", "done");
    },
    expectNoRequests: () => expect(requests).toEqual([]),
    expectDenials() {
      expect(errors.some(nestedDenied)).toBeTrue();
      expect(
        errors.filter(
          (error) =>
            !nestedDenied(error) && !formDenied(error) && !imageDenied(error),
        ),
      ).toEqual([]);
    },
  };
}

export async function expectPhoneTapArea(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  expect(
    await control.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [-21, 21].every((dx) =>
        [-21, 21].every((dy) =>
          element.contains(
            element.ownerDocument.elementFromPoint(
              x + width / 2 + dx,
              y + height / 2 + dy,
            ),
          ),
        ),
      );
    }),
  ).toBeTrue();
}

export async function expectInlineSeries(frame: FrameLocator): Promise<void> {
  const revenue = frame.getByText("Revenue", { exact: true });
  const costs = frame.getByText("Costs", { exact: true });
  await browserExpect(revenue).toBeVisible();
  await browserExpect(costs).toBeVisible();
  const first = (await revenue.boundingBox())!;
  const second = (await costs.boundingBox())!;
  expect(second.y).toBe(first.y);
  expect(second.x).toBeGreaterThan(first.x);
}
