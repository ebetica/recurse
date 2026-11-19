import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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

// Regression: #3379 #3390 #3501 reviewer failures stay bounded and fail open
test("no-verdict reviews log once without changing allow or denial outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-review-failure-"));
  const { host, faux, work } = fauxHost(root, "faux/faux-1", true);
  const sink = await RotatingFileSink.open(join(root, "logs", "recurse.log"));
  const log = logger("agents", sink);
  host.deps.log = (event, fields, level = INFO) =>
    logEvent(log, level, event, { fields });
  const secret = "sensitive-provider-detail sk-or-v1-0123456789abcdef";
  const cases = [
    {
      category: "failure",
      reply: "503 provider unavailable",
      attempts: 1,
      label: "provider error",
    },
    {
      category: "failure",
      reply: "429 usage limit reached",
      attempts: 1,
      label: "usage limit",
    },
    {
      category: "timeout",
      reply: "Safety review timed out",
      attempts: 1,
      label: "review timed out",
    },
    {
      category: "auth",
      reply: "401 unauthorized",
      attempts: 1,
      label: "no reviewer login",
    },
    {
      category: "invalid",
      reply: "not a verdict",
      attempts: 2,
      label: "invalid reviewer response",
    },
    {
      category: "deny",
      reply: "DENY: action not authorized",
      attempts: 1,
      label: null,
    },
    { category: "allow", reply: "OK", attempts: 1, label: null },
  ];
  try {
    for (const item of cases) {
      const name = (item.label ?? item.category).replaceAll(" ", "-");
      const main = [
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command: `touch ${name}`,
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
      await host.send("c1", `create ${name}`, name);
      await until(idle(host));
      expect(reviews).toBe(item.attempts);
      expect(existsSync(join(work, name))).toBe(item.category !== "deny");
      await until(() => host.metadata("c1").safety_unavailable === item.label);
    }
    const stores = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /session\.sqlite(-wal)?$/.test(path))
      .map((path) => readFileSync(join(root, path), "latin1"));
    expect(stores.some((bytes) => bytes.includes("recurse.safety:"))).toBe(
      true,
    );
    expect(stores.filter((bytes) => bytes.includes("sk-or-v1-")).length).toBe(
      0,
    );
    expect(stores.filter((bytes) => /"status":\d/.test(bytes)).length).toBe(0);
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
    expect(lines).toHaveLength(5);
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
