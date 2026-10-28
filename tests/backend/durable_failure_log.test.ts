import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { logText, lostTasks } from "../../src/agents/durable/failure_log.ts";
import { DurableHost } from "../../src/agents/durable/host.ts";
import {
  recordMessage,
  WARNING,
} from "../../src/observability/runtime_logging";
import { testDeps, until } from "./fixtures/durable_host/host.ts";

setDefaultTimeout(30_000);
type Rec = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), "durable-failure-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function hostOn(responses: FauxResponseStep[]) {
  const dataDir = mkdtempSync(join(root, "data-"));
  const work = join(dataDir, "work");
  mkdirSync(work, { recursive: true });
  const records: Record<string, Rec> = {
    c1: { id: "c1", backend: "durable", workdir: work },
  };
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const queue = [...responses];
  const step: FauxResponseStep = async (request, options, state, model) => {
    if (JSON.stringify(request).includes("<conversation>"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "summary boom",
      });
    const next = queue.shift();
    if (next === undefined) throw new Error("no scripted answer left");
    return typeof next === "function"
      ? next(request, options, state, model)
      : next;
  };
  faux.setResponses(Array.from({ length: 16 }, () => step));
  const logs: [string, Rec, number | undefined][] = [];
  const host = new DurableHost({
    ...testDeps(
      dataDir,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
    ),
    models,
    log: (event, fields, level) => logs.push([event, fields, level]),
  });
  const failures = () =>
    logs.filter(([event]) => event === "durable_task_failed");
  return { host, logs, failures };
}

const rows = async (host: DurableHost) =>
  (await host.view("c1", { limit: 50 })).blocks as Rec[];

test("a provider error logs one warning and still shows the error row", async () => {
  const message =
    "invalid_request_error: unsupported parameter (api_key=sk-ant-abc123def456)";
  const { host, failures } = hostOn([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: message }),
  ]);
  try {
    await host.send("c1", "hello", "r1");
    await until(() => failures().length > 0);
    await until(async () => host.runningCount() === 0);
    expect(failures()).toEqual([
      [
        "durable_task_failed",
        {
          cid: "c1",
          task: expect.any(Number),
          kind: "pi.generation",
          status: "failed",
          reason: "model_error",
          provider: "faux",
          model: "faux-1",
          error: "invalid_request_error:_unsupported_parameter__REDACTED",
        },
        WARNING,
      ],
    ]);
    expect(recordMessage("durable_task_failed", failures()[0]![1])).toBe(
      `event=durable_task_failed cid=c1 error=invalid_request_error:_unsupported_parameter__REDACTED kind=pi.generation model=faux-1 provider=faux reason=model_error status=failed task=${failures()[0]![1].task}`,
    );
    const answer = (await rows(host)).at(-1)!;
    expect(answer.role).toBe("assistant");
    expect(String(answer.error)).toContain("unsupported parameter");
  } finally {
    await host.close();
  }
});

test("a failed compaction logs one warning", async () => {
  const { host, failures } = hostOn([
    fauxAssistantMessage("hi"),
    fauxAssistantMessage("ok"),
  ]);
  try {
    await host.send("c1", "hello", "r1");
    await until(async () => (await rows(host)).some((b) => b.text === "hi"));
    await host.send("c1", `go ${"word ".repeat(20_000)}`, "r2");
    await until(async () => (await rows(host)).some((b) => b.text === "ok"));
    await until(async () => host.runningCount() === 0);
    await host.compact("c1");
    await until(() => failures().length > 0);
    await until(async () => host.runningCount() === 0);
    expect(failures().map(([, fields, level]) => [fields, level])).toEqual([
      [
        {
          cid: "c1",
          task: expect.any(Number),
          kind: "pi.compaction",
          status: "failed",
          reason: "model_error",
          provider: "faux",
          model: "faux-1",
          error: expect.stringContaining("summary_boom"),
        },
        WARNING,
      ],
    ]);
  } finally {
    await host.close();
  }
});

test("a tool that throws is a tool error, not a failure warning", async () => {
  const { host, failures } = hostOn([
    fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("no such file"),
  ]);
  try {
    await host.send("c1", "read it", "r1");
    await until(async () =>
      (await rows(host)).some((b) => b.text === "no such file"),
    );
    await until(async () => host.runningCount() === 0);
    expect(failures()).toEqual([]);
  } finally {
    await host.close();
  }
});

// test-check-allow: T9 Security: credential-bearing errors redact
test("error text ends at its first credential, so no part of the value survives", () => {
  expect(logText("upstream 401: authorization: Bearer abc.def.ghi")).toBe(
    "upstream_401:_REDACTED",
  );
  expect(logText('bad config api_key="alpha bravo charlie" rejected')).toBe(
    "bad_config_REDACTED",
  );
  expect(logText("Key SK-ANT-abc123def456 is invalid")).toBe("Key_REDACTED");
  expect(logText("plain error: 502 bad gateway")).toBe(
    "plain_error:_502_bad_gateway",
  );
});

function unsaveable(text: string) {
  const message = fauxAssistantMessage(text);
  (message.content[0] as unknown as Rec).bad = 1n;
  return message;
}

// Regression: #2139 faulted reply disappeared without an error row
test("a reply the scheduler could not save shows one error row, which never reaches the model", async () => {
  const requests: string[] = [];
  const { host, failures } = hostOn([
    unsaveable("lost answer"),
    (request) => {
      requests.push(JSON.stringify(request));
      return fauxAssistantMessage("second answer");
    },
  ]);
  try {
    await host.send("c1", "hello", "r1");
    await until(() => failures().length > 0);
    await until(async () => (await rows(host)).length === 2);
    await until(async () => host.runningCount() === 0);
    expect(failures()[0]![1].status).toBe("faulted");
    const error = (await rows(host))[1]!;
    expect([error.role, error.text, error.error]).toEqual([
      "assistant",
      "",
      "The reply could not be saved, so it was lost; send again to retry.",
    ]);
    expect(String(error.error_detail)).toContain("non-JSON bigint");

    await host.send("c1", "again", "r2");
    await until(async () =>
      (await rows(host)).some((b) => b.text === "second answer"),
    );
    expect(
      (await rows(host)).map((b) => [b.role, b.text, b.error ?? null]),
    ).toEqual([
      ["user", "hello", null],
      [
        "assistant",
        "",
        "The reply could not be saved, so it was lost; send again to retry.",
      ],
      ["user", "again", null],
      ["assistant", "second answer", null],
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("again");
    expect(requests[0]).not.toContain("could not be saved");
    expect(requests[0]).not.toContain("non-JSON");
  } finally {
    await host.close();
  }
});

// Regression: #2139 lost task lacked visible redacted cause
test(// test-check-allow: T9 Security: lost-task causes redact credentials
"lost compactions and orphaned replies get error-row text with the cause redacted", () => {
  const task = (id: number, kind: string, outcome: Rec) => ({
    type: "task",
    value: { id: String(id), kind, state: { status: "terminal", outcome } },
  });
  const publication = {
    changes: [
      task(1, "pi.compaction", {
        status: "faulted",
        error: { message: "write failed: api_key=sk-ant-abc123def456" },
      }),
      task(2, "pi.generation", { status: "orphaned", reason: "missing_task" }),
      task(3, "pi.generation", {
        status: "failed",
        error: { message: "model error" },
      }),
      task(4, "pi.tool", { status: "faulted", error: { message: "crash" } }),
      task(5, "pi.generation", { status: "completed", result: {} }),
    ],
  };
  expect(lostTasks(publication as never)).toEqual([
    {
      task: "1",
      text: "The compaction could not finish; retry with /compact.\n\nwrite failed: REDACTED",
    },
    {
      task: "2",
      text: "The reply could not be saved, so it was lost; send again to retry.\n\nmissing_task",
    },
  ]);
});
