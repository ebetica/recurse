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
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
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

function expectNoProviderStatus(text: string, status: number | undefined) {
  expect(text).not.toMatch(
    /http_status|safety_review_failure|operatorFailure|HTTP [45]\d\d/,
  );
  if (status === undefined) return;
  expect(text).not.toMatch(new RegExp(String.raw`(?:\b|\\[nrt])${status}\b`));
  expect(text).not.toMatch(
    new RegExp(
      String.raw`"(?:status|statusCode)\\?"\s*:\s*(?:${status}\b|\\?"${status}\\?")`,
    ),
  );
}

// Regression: #3379 #3390 #3501 reviewer failures stay bounded and fail open
test("no-verdict reviews log once without changing allow or denial outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-review-failure-"));
  const { host, faux, work } = fauxHost(root, "faux/faux-1", true);
  const sink = await RotatingFileSink.open(join(root, "logs", "recurse.log"));
  const log = logger("agents", sink);
  host.deps.log = (event, fields, level = INFO) =>
    logEvent(log, level, event, { fields });
  const credential = "0123456789abcdef";
  const secret = `sk-or-v1-${credential}`;
  const providerMessage = "Mammoth context window exceeded";
  const urlPrefix = " https://";
  const filler = `${providerMessage}\n${"Enough words ".repeat(20)}`;
  const detail = `${filler.slice(0, 196 - urlPrefix.length)}${urlPrefix}ZQcutoffValue:cutoffPass@provider.test/path`;
  const gate = join(work, "review-gate");
  const successfulReview = "**OK**";
  const summaries = {
    auth: "Reviewer authentication failed.",
    failure: "Reviewer provider request failed.",
    timeout: "Reviewer request timed out.",
  };
  const cases: {
    category: string;
    reply: string;
    attempts: number;
    label: string | null;
    failure?: {
      summary: string;
      status?: number;
      privateText: string[];
      masked: string[];
    };
  }[] = [
    { category: "allow", reply: successfulReview, attempts: 1, label: null },
    {
      category: "failure",
      reply: `503: ${detail}`,
      attempts: 1,
      label: "provider error",
      failure: {
        summary: summaries.failure,
        status: 503,
        privateText: [providerMessage, "ZQ"],
        masked: ["https://"],
      },
    },
    {
      category: "failure",
      reply: `429: upstream usage limit reached\nAuthorization:\nRetry when the limit resets.\n${secret}`,
      attempts: 1,
      label: "usage limit",
      failure: {
        summary: summaries.failure,
        status: 429,
        privateText: ["upstream usage limit reached", "sk-or-v1-", credential],
        masked: [
          "upstream usage limit reached Authorization: Retry when the limit resets. REDACTED",
        ],
      },
    },
    {
      category: "timeout",
      reply:
        'Safety review timed out {"x-api-\x1b[31mkey\x1b[0m":"xhFake","secret":"seFake"}',
      attempts: 1,
      label: "review timed out",
      failure: {
        summary: summaries.timeout,
        privateText: ["Safety review timed out", "xhFake", "seFake"],
        masked: ["Safety review timed out {REDACTED"],
      },
    },
    {
      category: "auth",
      reply: "401 Unauthorized //usrFake:pw'dFake@provider.test?mode=brief",
      attempts: 1,
      label: "no reviewer login",
      failure: {
        summary: summaries.auth,
        status: 401,
        privateText: ["Unauthorized //", "usrFake", "pw'dFake"],
        masked: ["Unauthorized //REDACTED"],
      },
    },
    {
      category: "failure",
      reply:
        "422: Rejected request https://provider.test?mode=brief&signature=signFake",
      attempts: 1,
      label: "provider error",
      failure: {
        summary: summaries.failure,
        status: 422,
        privateText: ["Rejected request", "signFake"],
        masked: ["Rejected request https://provider.test?mode=brief&REDACTED"],
      },
    },
    {
      category: "failure",
      reply:
        "503: unexpected opaque value A1Z2X3Y4B5V6N7M8K9J0H1G2F3D4S5A6Q7W8E9R0T1Y2U3I4O5P6+A/B==",
      attempts: 1,
      label: "provider error",
      failure: {
        summary: summaries.failure,
        status: 503,
        privateText: ["unexpected opaque value", "A1Z2X3Y4B5V6N7M8"],
        masked: ["unexpected opaque value REDACTED"],
      },
    },
    {
      category: "auth",
      reply: "401:fauxTestValue",
      attempts: 1,
      label: "no reviewer login",
      failure: {
        summary: summaries.auth,
        privateText: ["401:fauxTestValue", "fauxTestValue"],
        masked: ["REDACTED"],
      },
    },
    {
      category: "failure",
      reply:
        '422: Rejected response document {"url":"https://public.test","email":"example@example.org","key":["listFakeA","listFakeB"]}',
      attempts: 1,
      label: "provider error",
      failure: {
        summary: summaries.failure,
        status: 422,
        privateText: ["Rejected response document", "listFakeA", "listFakeB"],
        masked: [
          '"url":"https://public.test","email":"example@example.org"',
          '"email":"example@example.org",REDACTED',
        ],
      },
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
  ];
  try {
    await Bun.$`mkfifo ${gate}`;
    for (const [index, item] of cases.entries()) {
      const failure = item.failure;
      const name = `${(item.label ?? item.category).replaceAll(" ", "-")}-${index}`;
      const call = fauxToolCall(
        "bash",
        {
          command: `touch ${name}${failure ? "; read -r released < review-gate" : ""}`,
        },
        { id: name },
      );
      const main = fauxAssistantMessage([call], { stopReason: "toolUse" });
      const reviews: Parameters<FauxResponseFactory>[0][] = [];
      let followUp: Parameters<FauxResponseFactory>[0] | undefined;
      const step: FauxResponseStep = (request) => {
        if (JSON.stringify(request).includes("untrusted record of a user's")) {
          reviews.push(request);
          return failure
            ? fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: item.reply,
              })
            : fauxAssistantMessage(item.reply);
        }
        const last = request.messages.at(-1);
        if (last?.role === "toolResult" && last.toolCallId === call.id) {
          followUp = request;
          return fauxAssistantMessage("done");
        }
        return main;
      };
      faux.setResponses(Array(10).fill(step));
      await host.send("c1", `create ${name}`, name);
      if (failure) {
        await until(() => existsSync(join(work, name)));
        try {
          const slot = (await host.live("c1"))!.tools!.find(
            (tool) => tool.callId === call.id,
          );
          const { harness } = await host.open("c1");
          const task = await harness.getTask(slot!.taskId!, context);
          expect(task!.memos![`recurse.safety:${call.id}`]).toEqual({
            decision: "deny",
            reason: failure.summary,
            procedural: true,
            failure: {
              stage: "provider",
              category: item.category,
              summary: failure.summary,
              ...(failure.status === 429 ? { usageLimit: true } : {}),
            },
            attempts: [{ status: "unreported" }],
            safetyWaitMs: expect.any(Number),
          });
        } finally {
          await Bun.$`printf 'go\n' > ${gate}`;
        }
      }
      await until(idle(host));
      if (failure) {
        const currentResult = followUp?.messages.at(-1);
        expect(currentResult).toMatchObject({
          role: "toolResult",
          toolCallId: call.id,
        });
        expect(JSON.stringify(currentResult)).toContain(failure.summary);
        const request = JSON.stringify(followUp);
        const capture = await host.prompt("c1", true);
        const review = JSON.stringify(capture.safety_review);
        expect(review).toContain('"stopReason":"error"');
        expectNoProviderStatus(request, failure.status);
        for (const text of failure.privateText) {
          expect(request).not.toContain(text);
          expect(review).not.toContain(text);
        }
        const blocks = (await host.view("c1")).blocks as {
          id: string;
          artifact_id?: string;
        }[];
        const row = blocks.find((block) => block.id.endsWith(`#${call.id}`));
        const artifact = await host.toolDetails("c1", row!.artifact_id!, true);
        const shown = artifact?.safety_review_failure as {
          status?: number;
          message: string;
        };
        expect(shown.status ?? 0).toBe(failure.status ?? 0);
        for (const masked of failure.masked)
          expect(shown.message).toContain(masked);
        for (const credential of failure.privateText.slice(1))
          expect(shown.message).not.toContain(credential);
        if (failure.privateText.includes("ZQ")) {
          expect(shown.message).toHaveLength(200);
          expect(detail.slice(0, 199)).toEndWith("ZQc");
          expect(detail.indexOf("@provider.test")).toBeGreaterThan(200);
        }
      }
      if (item.category === "deny") {
        const history = reviews[0]!.messages;
        expect(
          history.some(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message.content).includes(successfulReview),
          ),
        ).toBe(true);
        const reviewerRequest = JSON.stringify(reviews[0]);
        for (const prior of cases) {
          if (!prior.failure) continue;
          for (const text of prior.failure.privateText)
            expect(reviewerRequest).not.toContain(text);
          expectNoProviderStatus(reviewerRequest, prior.failure.status);
        }
      }
      expect(reviews).toHaveLength(item.attempts);
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
    const failures = cases.filter((item) => item.label !== null);
    expect(lines).toHaveLength(failures.length);
    for (const [index, line] of lines.entries()) {
      const item = failures[index]!;
      expect(line).toContain("level=WARNING");
      expect(line).toContain("cid=c1");
      expect(line).toContain(`category=${item.category}`);
      expect(line).toContain(`attempts=${item.attempts}`);
      expect(line).toMatch(/elapsed_ms=\d+/);
      expect(line).toContain("provider=faux");
      expect(line).toContain("model=faux-1");
      expect(line).toContain("stage=provider");
      expect(line).not.toContain(work);
      expect(line.match(/\bhttp_status=(\d+)/)?.[1] ?? "").toBe(
        item.failure?.status?.toString() ?? "",
      );
      for (const credential of item.failure?.privateText.slice(1) ?? [])
        expect(line).not.toContain(credential);
    }
    expect(lines[0]?.match(/\berror=(\S+)/)?.[1]).toHaveLength(200);
    expect(lines[0]).toContain(
      "error=Mammoth_context_window_exceeded_Enough_words",
    );
    expect(lines[0]).not.toContain("ZQ");
    expect(lines[1]).toContain(
      "error=upstream_usage_limit_reached_Authorization:_Retry_when_the_limit_resets._REDACTED",
    );
    expect(lines[2]).toMatch(/error=Safety_review_timed_out_.*REDACTED/);
    expect(lines[3]).toContain("error=Unauthorized_//REDACTED");
    expect(lines[4]).toContain("error=Rejected_request");
    expect(lines[5]).toContain("error=unexpected_opaque_value_REDACTED");
    expect(lines[6]).toContain("error=REDACTED");
    expect(lines[7]).toContain("error=Rejected_response_document");
    expect(lines[8]).toContain(
      "error=Safety_reviewer_returned_an_invalid_verdict_twice",
    );
  } finally {
    await host.close();
    await sink.close();
    rmSync(root, { recursive: true, force: true });
  }
});
