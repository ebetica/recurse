import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { type ToolResultMessage } from "@earendil-works/pi-ai";
import {
  postFixture,
  rootAgentId,
  runBrowserTests,
  type BrowserTest,
} from "./common";

async function useStateTool(base: string, id: string, replacement?: unknown) {
  const { result } = (await postFixture(base, "run-artifact-state-tool", {
    id,
    replacement,
  })) as { result: ToolResultMessage };
  return { isError: result.isError, output: result.content[0] };
}

export const tests: BrowserTest[] = [
  // Feature: #3560 App Artifacts save and restore JSON only while selected.
  async function test_saved_app_state(browser, base) {
    const app = await postFixture(base, "seed-saved-app-state");
    const other = await postFixture(base, "seed-saved-app-state");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 844 },
    });
    const putRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes("/app-state?"))
        putRequests.push(request.postData()!);
    });
    await page.addInitScript(() => {
      window.addEventListener("message", ({ source }) => {
        const rogue = document.querySelector<HTMLIFrameElement>("#other-frame");
        if (rogue && source === rogue.contentWindow)
          document.body.dataset.otherFrameMessage = "seen";
      });
      const hold = (event: Event) => {
        const root = document.documentElement;
        if (root.dataset.holdHistory !== "on") return;
        event.stopImmediatePropagation();
        root.dataset.heldHistory = event.type;
      };
      window.addEventListener("popstate", hold, true);
      window.addEventListener("hashchange", hold, true);
    });
    const appPageGate = Promise.withResolvers<void>();
    const appPageRequested = Promise.withResolvers<void>();
    await page.route(`**/api/artifacts/${app.id}/page**`, async (route) => {
      appPageRequested.resolve();
      await appPageGate.promise;
      await route.continue();
    });
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${app.id}`);
    const locator = page.locator("iframe.artifact-embed-page");
    const frame = locator.contentFrame();
    const count = frame.locator("#count");
    const feedback = frame.locator("#status");
    const move = frame.getByRole("button", { name: "Move attendee" });
    await appPageRequested.promise;
    const connect = {
      type: "recurse-app-state:connect",
      token: (await locator.getAttribute("src"))!.split(
        "#recurse-app-state=",
      )[1],
    };
    try {
      await page.evaluate(() => {
        const rogue = document.createElement("iframe");
        rogue.id = "other-frame";
        rogue.sandbox.add("allow-scripts");
        rogue.srcdoc = "<p>Other frame</p>";
        document.body.appendChild(rogue);
      });
      await page
        .frameLocator("#other-frame")
        .getByText("Other frame")
        .evaluate((_, data) => {
          const channel = new MessageChannel();
          window.parent.postMessage(data, "*", [channel.port2]);
          channel.port1.postMessage({
            type: "save",
            json: '{"attendees":99}',
          });
        }, connect);
      await browserExpect(page.locator("body")).toHaveAttribute(
        "data-other-frame-message",
        "seen",
      );
    } finally {
      appPageGate.resolve();
    }
    await browserExpect(count).toHaveText("0");
    await move.click();
    await browserExpect(feedback).toHaveText("Saved");
    expect(await useStateTool(base, app.id)).toEqual({
      isError: false,
      output: { type: "text", text: '{"attendees":1}' },
    });
    await frame.getByRole("button", { name: "Save too much" }).click();
    await browserExpect(feedback).toHaveText("Saved app state exceeds 256 KiB");
    await frame.getByRole("button", { name: "Save invalid value" }).click();
    await browserExpect(feedback).toHaveText("Saved app state must be JSON");
    await move.click();
    await browserExpect(count).toHaveText("2");
    const refusal = await count.evaluate(async (_, connect) => {
      const replay = new MessageChannel();
      const refused = new Promise<unknown>((resolve) => {
        replay.port1.onmessage = ({ data }) => resolve(data);
      });
      window.parent.postMessage(connect, "*", [replay.port2]);
      replay.port1.postMessage({ type: "save", json: '{"attendees":98}' });
      return refused;
    }, connect);
    expect(refusal).toEqual({
      type: "refused",
      error: "Refresh the Artifact to reconnect saved app state",
    });
    await count.evaluate(async (_, id) => {
      const send = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (
        this: MessagePort,
        message: unknown,
      ) {
        MessagePort.prototype.postMessage = send;
        send.call(this, { type: "save", id, json: '{"attendees":99}' });
        send.call(this, message);
      } as typeof send;
      const { recurse } = window as Window & {
        recurse?: { setState(value: unknown): Promise<void> };
      };
      if (!recurse) throw new Error("Missing saved app state API");
      await recurse.setState({ attendees: 3 });
    }, other.id);
    expect(putRequests).toEqual([
      '{"attendees":1}',
      '{"attendees":2}',
      '{"attendees":3}',
    ]);
    expect(await useStateTool(base, other.id)).toEqual({
      isError: false,
      output: { type: "text", text: "null" },
    });
    await page.reload();
    await browserExpect(count).toHaveText("3");
    const { promise: resumeReads, resolve: resume } =
      Promise.withResolvers<void>();
    await page.route(
      `**/api/artifacts/${app.id}/app-state?*`,
      async (route) => {
        if (route.request().method() === "GET") await resumeReads;
        await route.continue();
      },
    );
    try {
      await move.click();
      await browserExpect(count).toHaveText("4");
      expect(await useStateTool(base, app.id, { attendees: 3 })).toEqual({
        isError: false,
        output: { type: "text", text: '{"attendees":3}' },
      });
    } finally {
      resume();
    }
    await browserExpect(count).toHaveText("3");
    await count.evaluate(() => void setTimeout(() => location.reload()));
    await browserExpect(feedback).toHaveText(
      "Refresh the Artifact to reconnect saved app state",
    );
    await page.getByRole("button", { name: "Refresh artifact" }).click();
    await browserExpect(count).toHaveText("3");
    const linked = await postFixture(base, "publish-review-artifact", {
      agent: rootAgentId(),
      markdown: `# Linked document\n\n[Open the app](#artifact=${app.id})`,
    });
    const destination = await postFixture(base, "publish-review-artifact", {
      agent: rootAgentId(),
      markdown: "# Destination document",
    });
    const content = Promise.withResolvers<void>();
    const contentRequested = Promise.withResolvers<void>();
    await page.route(`**/api/artifacts/${linked.id}/file?**`, async (route) => {
      contentRequested.resolve();
      await content.promise;
      await route.continue();
    });
    const oldFrame = page.frame({
      url: (url) => url.pathname === `/api/artifacts/${app.id}/page`,
    })!;
    try {
      await page.goto(`${base}#agent=${rootAgentId()}&artifact=${linked.id}`);
      await contentRequested.promise;
      await browserExpect(page.getByLabel("Select artifact")).toHaveValue(
        linked.id,
      );
      const priorPuts = putRequests.length;
      await oldFrame
        .evaluate(async () => {
          const { recurse } = window as Window & {
            recurse?: { setState(value: unknown): Promise<void> };
          };
          if (!recurse) throw new Error("Missing saved app state API");
          await recurse.setState({ attendees: 99 });
        })
        .catch((error) => {
          if (!oldFrame.isDetached()) throw error;
        });
      expect(putRequests.slice(priorPuts)).toEqual([]);
      expect(oldFrame.isDetached()).toBe(true);
    } finally {
      content.resolve();
    }
    await browserExpect(
      page.getByRole("heading", { name: "Linked document" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Open the app" }).click();
    await browserExpect(count).toHaveText("3");
    const picker = page.getByLabel("Select artifact");
    await page.evaluate(() => {
      document.documentElement.dataset.holdHistory = "on";
    });
    await picker.selectOption(destination.id);
    await browserExpect(page.locator("html")).toHaveAttribute(
      "data-held-history",
    );
    const late = await postFixture(base, "publish-review-artifact", {
      agent: rootAgentId(),
      markdown: "# Late document",
    });
    await page.evaluate((agentId) => {
      dispatchEvent(
        new CustomEvent("recurse:artifacts-refresh", { detail: { agentId } }),
      );
    }, rootAgentId());
    await browserExpect(
      picker.locator(`option[value="${late.id}"]`),
    ).toHaveCount(1);
    expect(await locator.count()).toBe(0);
    await page.evaluate(() => {
      delete document.documentElement.dataset.holdHistory;
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await browserExpect(
      page.getByRole("heading", { name: "Destination document" }),
    ).toBeVisible();
    await browserExpect(picker).toHaveValue(destination.id);
    await picker.selectOption(app.id);
    await browserExpect(count).toHaveText("3");
    page.once("dialog", (dialog) => void dialog.accept());
    const deletion = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/api/artifacts/${app.id}`),
    );
    await page.locator(".artifact-delete-btn").click();
    expect((await deletion).status()).toBe(200);
    const deleted = await useStateTool(base, app.id);
    expect(deleted.isError).toBe(true);
    expect(deleted.output).toMatchObject({
      type: "text",
      text: expect.stringContaining("artifact not found"),
    });
    expect(
      await Bun.file(`${app.repo_path}/.git/recurse-app-state.json`).exists(),
    ).toBe(false);
    await page.close();
  },
];

if (import.meta.main) await runBrowserTests([["artifact-app-state", tests]]);
