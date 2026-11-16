import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  INFO,
  logEvent,
  logger,
  RotatingFileSink,
} from "../../src/observability/runtime_logging";
import { fauxHost, idle, until } from "./fixtures/durable_host/host";

// Regression: #3379 #3390 capture failures never suppress reviewer denials.
test("no-verdict reviews log once without changing allow or denial outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-review-failure-"));
  const { host, faux, work } = fauxHost(root, "faux/faux-1", true);
  const sink = await RotatingFileSink.open(join(root, "logs", "recurse.log"));
  const log = logger("agents", sink);
  host.deps.log = (event, fields, level = INFO) =>
    logEvent(log, level, event, { fields });
  const secret = "sensitive-provider-detail";
  const cases = [
    { category: "failure", reply: "503 provider unavailable", attempts: 1 },
    { category: "timeout", reply: "Safety review timed out", attempts: 1 },
    { category: "auth", reply: "401 unauthorized", attempts: 1 },
    { category: "invalid", reply: "not a verdict", attempts: 2 },
    { category: "deny", reply: "DENY: action not authorized", attempts: 1 },
    { category: "allow", reply: "OK", attempts: 1 },
  ];
  try {
    for (const item of cases) {
      const main = [
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command: `touch ${item.category}`,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ];
      let reviews = 0;
      const step: FauxResponseStep = (request) => {
        if (JSON.stringify(request).includes("untrusted record of a user's")) {
          reviews += 1;
          return ["failure", "timeout", "auth"].includes(item.category)
            ? fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: `${item.reply}\n${secret}`,
              })
            : fauxAssistantMessage(item.reply);
        }
        return main.shift() ?? fauxAssistantMessage("done");
      };
      faux.setResponses(Array(10).fill(step));
      await host.send("c1", `create ${item.category}`, item.category);
      await until(idle(host));
      expect(reviews).toBe(item.attempts);
      expect(existsSync(join(work, item.category))).toBe(
        item.category !== "deny",
      );
    }
    for (const phase of ["request", "reply"]) {
      const fault = fauxHost(join(root, phase), "faux/faux-1", true);
      fault.host.deps.log = host.deps.log;
      let denials = 0;
      const step: FauxResponseStep = async (request) => {
        if (JSON.stringify(request).includes("untrusted record of a user's")) {
          denials += 1;
          if (phase === "reply") await fault.host.captureWorker.close();
          return fauxAssistantMessage(
            "DENY: capture must not authorize this action",
          );
        }
        if (phase === "request") await fault.host.captureWorker.close();
        return fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command: "touch capture-denied",
            }),
          ],
          { stopReason: "toolUse" },
        );
      };
      fault.faux.setResponses(Array(4).fill(step));
      try {
        await fault.host.send(
          "c1",
          "Create capture-denied.",
          `capture-${phase}`,
        );
        await until(idle(fault.host));
        expect(denials).toBe(1);
        expect(existsSync(join(fault.work, "capture-denied"))).toBe(false);
      } finally {
        await fault.host.close();
      }
    }
    await sink.flush();
    const captureFailures = readFileSync(sink.path, "utf8")
      .split("\n")
      .filter((line) => line.includes("event=safety_review_capture_failed"));
    expect(captureFailures).toHaveLength(2);
    for (const line of captureFailures) {
      expect(line).toContain("cid=c1");
      expect(line).not.toContain("error=");
      expect(line).not.toContain("Request capture");
      expect(line).not.toContain(secret);
    }
    const lines = readFileSync(sink.path, "utf8")
      .split("\n")
      .filter((line) => line.includes("event=safety_review_failed"));
    expect(lines).toHaveLength(4);
    for (const [index, line] of lines.entries()) {
      expect(line).toContain("level=WARNING");
      expect(line).toContain("cid=c1");
      expect(line).toContain(`category=${cases[index]!.category}`);
      expect(line).toContain(`attempts=${cases[index]!.attempts}`);
      expect(line).toMatch(/elapsed_ms=\d+/);
      expect(line).toContain("provider=faux");
      expect(line).toContain("model=faux-1");
      expect(line).toContain("stage=provider");
      expect(line).not.toContain(secret);
      expect(line).not.toContain(work);
    }
  } finally {
    await host.close();
    await sink.close();
    rmSync(root, { recursive: true, force: true });
  }
});
