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
import { redactSecrets } from "../../src/tool_projection/index";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker";
import { DurableHost } from "../../src/agents/durable/host";
import {
  recordMessage,
  WARNING,
} from "../../src/observability/runtime_logging";
import {
  fauxHost,
  idle,
  testDeps,
  until,
} from "./fixtures/durable_host/host.ts";

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

// Regression: #3711 upstream credentials reached stored failure state and browser rows.
test("a provider error hides the sent credential without changing failure handling", async () => {
  const key = "q7Pz";
  const quota =
    "subscription_sharing_workplace_individual_usage_limit_exceeded";
  const restored = "Recovered after a transient failure.";
  const requests: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.json();
      const auth = request.headers.get("authorization");
      const sent = auth?.slice("Bearer ".length);
      const attempt = requests.push(auth);
      if (attempt === 1 || attempt === 2) {
        const message =
          attempt === 1
            ? `The request was rejected. Authorization: ${auth}, invalid API key.`
            : `${sent}: ${quota}, network error.`;
        return Response.json(
          { error: { message } },
          { status: attempt === 1 ? 400 : 429 },
        );
      }
      const completion = {
        id: attempt === 3 ? `reply-${sent}` : "reply",
        object: "chat.completion.chunk",
        model: "small",
        choices: [
          {
            index: 0,
            delta: attempt === 3 ? {} : { content: restored },
            finish_reason: attempt === 3 ? `${sent}: network error` : "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  });
  const dataDir = mkdtempSync(join(root, "provider-error-"));
  const record = { id: "c1", backend: "durable", workdir: dataDir };
  const failures: string[] = [];
  const host = new DurableHost({
    ...testDeps(
      dataDir,
      () => record,
      () => [record.id],
      "local-llm/small",
    ),
    customProviders: () => ({
      "local-llm": {
        base_url: `http://127.0.0.1:${server.port}/v1`,
        env_key: "LOCAL_LLM_KEY",
        wire_api: "completions",
        models: [{ id: "small", context_window: 100000, effort: null }],
      },
    }),
    customProviderEnvValue: () => key,
    log: (event, fields, level) => {
      if (event === "durable_task_failed" && level === WARNING)
        failures.push(recordMessage(event, fields));
    },
  });
  try {
    await host.send("c1", "Use the invalid key", "r1");
    await until(() => failures.length === 1);
    await until(idle(host));
    expect(requests).toHaveLength(1);
    await host.send("c1", "Hit the quota", "r2");
    await until(() => failures.length === 2);
    await until(idle(host));
    expect(requests).toHaveLength(2);
    await host.send("c1", "Hit the transient error", "r3");
    await until(async () =>
      (await rows(host)).some((row) => row.text === restored),
    );
    await until(idle(host));
    expect(requests).toEqual(Array(4).fill(`Bearer ${key}`));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("The_request_was_rejected");

    const view = await rows(host);
    const { harness, conversation } = await host.open("c1");
    const entries = await conversation.entries({}, 10, undefined, context);
    const persisted = JSON.stringify({
      entries: entries.items,
      live: await harness.snapshot(LiveDoc, conversation.id, context),
    });
    await host.messageSearch.drain();
    const transcript = await Bun.file(
      join(host.storagePath("c1"), "..", "transcript.txt"),
    ).text();
    expect(transcript).toContain(restored);
    const surfaces = { persisted, view: JSON.stringify(view), transcript };
    expect(
      Object.entries(surfaces)
        .filter(([, text]) => text.includes(key))
        .map(([name]) => name),
    ).toEqual([]);
    expect(surfaces.view).toContain("invalid API key");
    expect(surfaces.view).toContain(
      "Pick an effort level again for this conversation.",
    );
    expect(surfaces.view).toContain(quota);
    expect(persisted).toContain('"rawStopReason":"[redacted]: network error"');
    expect(persisted).toContain('"responseId":"reply-[redacted]"');
  } finally {
    await host.close();
    server.stop(true);
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
test("error text keeps diagnostics before the first credential", () => {
  expect(logText("upstream 401: authorization: Bearer abc.def.ghi")).toBe(
    "upstream_401:_REDACTED",
  );
  expect(logText('bad config api_key="alpha bravo charlie" rejected')).toBe(
    "bad_config_REDACTED",
  );
  expect(logText("Key SK-ANT-abc123def456 is invalid")).toBe("Key_REDACTED");
  expect(logText("Rejected: -Bearer abc123")).toBe("Rejected:_-REDACTED");
  expect(logText("invalid primary key: account_id is missing")).toBe(
    "invalid_primary_key:_account_id_is_missing",
  );
  const packageError =
    "Provider rejected https://unpkg.com//lodash@4.17.21/lodash.js";
  expect(redactSecrets(packageError)).toBe(packageError);
  for (const start of ["//", "Rejected [//", 'Rejected "//', "(git+ssh://"]) {
    expect(redactSecrets(`${start}name:short@provider.test/path`)).toBe(
      `${start}REDACTED`,
    );
  }
  expect(
    logText(
      "Headers:\nAuthorization:\nBad response\nAuthorization: Basic value",
    ),
  ).toBe("Headers:_Authorization:_Bad_response_REDACTED");
  for (const field of [
    "subscription-key",
    "X-Subscription-Key",
    "Ocp-Apim-Subscription-Key",
    "Proxy-Authorization",
    "X-API-KEY",
    "X-Auth-Token",
    "X-Access-Token",
    "access_token",
    "auth_token",
    "refresh_token",
    "id_token",
    "session_token",
    "client_secret",
    "private_key",
    "password",
  ]) {
    expect(logText(`request rejected ${field}=short afterward`)).toBe(
      "request_rejected_REDACTED",
    );
  }
  expect(logText("Rejected\nX-API-Key:\r\n abc123\ninternal diagnostic")).toBe(
    "Rejected_REDACTED",
  );
  expect(logText("Rejected \u001b[31mapi_key\u001b[0m=abc123")).toBe(
    "Rejected_REDACTED",
  );
  for (const field of ["key", "SIG", "Signature"]) {
    expect(
      redactSecrets(
        `invalid request https://public.test?${field}=short&mode=brief`,
      ),
    ).toBe("invalid request https://public.test?REDACTED");
  }
  for (const field of ["key", "x_api_key"]) {
    expect(
      redactSecrets(`invalid request {"${field}":"short","reason":"unknown"}`),
    ).toBe("invalid request {REDACTED");
  }
  const hyphenText = "authorization-ø-".repeat(6_400);
  const jsonBody = `{"details":[${'"//public.test",'.repeat(7_000)}null],`;
  expect(redactSecrets(`${hyphenText} password=short afterward`)).toBe(
    `${hyphenText} REDACTED`,
  );
  expect(redactSecrets(`${jsonBody}"key":"short","reason":"unknown"}`)).toBe(
    `${jsonBody}REDACTED`,
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

// Regression: #3013 restart-limited tasks end upstream instead of parking for Recurse to abort.
test("a restart-limited reply ends with a visible error and a later input can run", async () => {
  const dataDir = mkdtempSync(join(root, "restarted-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/durable_host/restart_child.ts"),
      dataDir,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const worker = new SqliteWorker();
  const { host, faux } = fauxHost(dataDir);
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("request started");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const storage = await openWorkerSqliteStorage(
      worker,
      join(dataDir, "conversations/c1/durable/session.sqlite"),
    );
    try {
      const tasks = await storage.scanTasks({}, 100, undefined, context);
      const generation = tasks.items.find(
        (task) => task.kind === "pi.generation",
      )!;
      expect(generation.state.status).toBe("running");
      await commitWrites(
        storage,
        [{ type: "task", value: { ...generation, restarts: 5 } }],
        context,
      );
    } finally {
      await storage.close(context);
    }
    const { harness, conversation } = await host.open("c1");
    await until(idle(host));
    await until(async () =>
      (await rows(host)).some((row) =>
        String(row.error).includes("repeated server restarts"),
      ),
    );
    expect(
      (await harness.snapshot(LiveDoc, conversation.id, context))?.runFailure
        ?.reason,
    ).toBe("restart_limit");
    expect((await harness.inspect(context)).tasks).toHaveLength(0);
    faux.setResponses([fauxAssistantMessage("recovered answer")]);
    await host.send("c1", "Try again", "again");
    await until(async () =>
      (await rows(host)).some((row) => row.text === "recovered answer"),
    );
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await host.close();
    await worker.close();
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
