import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { fauxHost, idle, until } from "./fixtures/durable_host/host";

type Review = { contents: unknown[]; key?: string };

// Regression: #2982 reviewer evidence in one growing message missed the ChatGPT Codex prompt cache.
test("consecutive Durable reviews resend earlier evidence messages byte-identically under one cache key", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-review-cache-"));
  const { host, faux, work } = fauxHost(root, "faux/faux-1", true);
  const reviews: Review[] = [];
  const bash = (name: string, command: string) =>
    fauxAssistantMessage([fauxToolCall("bash", { command }, { id: name })], {
      stopReason: "toolUse",
    });
  const main = [
    bash("one", `touch one && echo ${"first ".repeat(1000)}`),
    bash("two", `touch two && echo ${"second ".repeat(1000)}`),
    bash("three", `touch three`),
    fauxAssistantMessage("done"),
  ];
  let next = 0;
  const step: FauxResponseStep = async (request, options) => {
    if (JSON.stringify(request).includes("untrusted record of a user's")) {
      reviews.push({
        contents: request.messages.map((message) => message.content),
        key: options?.sessionId,
      });
      return fauxAssistantMessage("OK");
    }
    return main[next++] ?? fauxAssistantMessage("done");
  };
  faux.setResponses(Array(20).fill(step));
  try {
    await host.send("c1", "create three files", "review-cache");
    await until(idle(host));
    expect(
      ["one", "two", "three"].map((f) => existsSync(join(work, f))),
    ).toEqual([true, true, true]);
    expect(reviews).toHaveLength(3);
    const [, second, third] = reviews as [Review, Review, Review];
    const stable = second.contents.slice(0, -1);
    expect(JSON.stringify(stable)).toContain("touch one");
    expect(JSON.stringify(third.contents.slice(0, stable.length))).toBe(
      JSON.stringify(stable),
    );
    expect(second.key).toMatch(/^pi-safety-[0-9a-f]{52}$/);
    expect(new Set(reviews.map((review) => review.key))).toEqual(
      new Set([second.key]),
    );
    expect(JSON.stringify(third.contents.at(-1))).toContain("touch three");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
