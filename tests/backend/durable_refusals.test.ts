import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type AssistantMessage,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { fauxHost, idle, until } from "./fixtures/durable_host/host.ts";

const root = mkdtempSync(join(tmpdir(), "durable-refusals-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const refused = (rawStopReason: string, errorMessage: string) =>
  ({
    ...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
    rawStopReason,
  }) as AssistantMessage;
const said = (request: ModelContext) => JSON.stringify(request.messages);
const operator = (text: string) => `[recurse-origin: operator]\n${text}`;

for (const [rawStopReason, errorMessage, shown] of [
  [
    "refusal",
    "The model refused to complete the request",
    "The model refused to complete the request",
  ],
  [
    "content_filter",
    "Provider finish_reason: content_filter",
    "The provider's content filter blocked this reply.",
  ],
])
  test(`a ${rawStopReason} stop leaves the refused message out after a restart`, async () => {
    const dir = mkdtempSync(join(root, "c-"));
    const requests: ModelContext[] = [];
    const seen = (reply: AssistantMessage) => (request: ModelContext) => {
      requests.push(structuredClone(request));
      return reply;
    };
    const first = fauxHost(dir);
    first.faux.setResponses([
      seen(fauxAssistantMessage("First answer.")),
      seen(refused(rawStopReason, errorMessage)),
    ]);
    await first.host.send("c1", operator("first message"), "op:1");
    await until(idle(first.host));
    await first.host.send("c1", operator("REFUSED MESSAGE"), "op:2");
    await until(idle(first.host));
    expect(said(requests[1]!)).toContain("REFUSED MESSAGE");
    const view = await first.host.view("c1", { limit: 50 });
    const rows = view.blocks as {
      text: string;
      error: unknown;
      stop_reason: unknown;
    }[];
    expect(rows.some((row) => row.text.includes("REFUSED MESSAGE"))).toBe(true);
    expect(rows.at(-1)!.stop_reason).toBe("refused");
    expect(rows.at(-1)!.error).toBe(shown);
    await first.host.close();

    const second = fauxHost(dir);
    second.faux.setResponses([seen(fauxAssistantMessage("Next answer."))]);
    await second.host.send("c1", operator("next message"), "op:3");
    await until(idle(second.host));
    const next = said(requests[2]!);
    expect(next).toContain("first message");
    expect(next).toContain("First answer.");
    expect(next).toContain("next message");
    expect(next).not.toContain("REFUSED MESSAGE");
    const capture = JSON.stringify(await second.host.prompt("c1"));
    expect(capture).toContain("next message");
    expect(capture).not.toContain("REFUSED MESSAGE");
    await second.host.close();
  }, 60_000);

test("a refusal after a retried overload leaves the message out", async () => {
  const dir = mkdtempSync(join(root, "c-"));
  const requests: ModelContext[] = [];
  const { host, faux } = fauxHost(dir);
  faux.setResponses([
    fauxAssistantMessage("First answer."),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    }),
    refused("refusal", "The model refused to complete the request"),
    (request: ModelContext) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage("Next answer.");
    },
  ]);
  await host.send("c1", operator("first message"), "op:1");
  await until(idle(host));
  await host.send("c1", operator("REFUSED MESSAGE"), "op:2");
  await until(idle(host), 30_000);
  await host.send("c1", operator("next message"), "op:3");
  await until(idle(host));
  expect(said(requests[0]!)).toContain("First answer.");
  expect(said(requests[0]!)).not.toContain("REFUSED MESSAGE");
  await host.close();
}, 60_000);

test("a refusal after an overflow compaction leaves the retained message out", async () => {
  const dir = mkdtempSync(join(root, "c-"));
  const requests: ModelContext[] = [];
  const { host, faux } = fauxHost(dir);
  const answers: (
    | AssistantMessage
    | ((r: ModelContext) => AssistantMessage)
  )[] = [
    fauxAssistantMessage("First answer."),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    }),
    refused("refusal", "The model refused to complete the request"),
    (request) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage("Next answer.");
    },
  ];
  faux.setResponses(
    Array.from({ length: 8 }, () => (request: ModelContext) => {
      if (said(request).includes("<conversation>"))
        return fauxAssistantMessage("SUMMARY");
      const answer = answers.shift()!;
      return typeof answer === "function" ? answer(request) : answer;
    }),
  );
  await host.send("c1", operator("first message"), "op:1");
  await until(idle(host));
  await host.send(
    "c1",
    operator(`REFUSED MESSAGE ${"word ".repeat(20_000)}`),
    "op:2",
  );
  await until(idle(host), 30_000);
  await host.send("c1", operator("next message"), "op:3");
  await until(idle(host));
  expect(said(requests[0]!)).toContain("SUMMARY");
  expect(said(requests[0]!)).not.toContain("REFUSED MESSAGE");
  await host.close();
}, 60_000);

test("a crash between the omission and the refusal restores the message", async () => {
  const dir = mkdtempSync(join(root, "c-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/durable_refusals/crash_child.ts"),
      dir,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  expect(await child.exited).toBe(73);
  const requests: ModelContext[] = [];
  const { host, faux } = fauxHost(dir);
  faux.setResponses(
    ["Answer after restart.", "Next answer."].map(
      (text) => (request: ModelContext) => {
        requests.push(structuredClone(request));
        return fauxAssistantMessage(text);
      },
    ),
  );
  await host.open("c1");
  await until(idle(host), 30_000);
  await host.send("c1", operator("next message"), "op:3");
  await until(idle(host));
  expect(said(requests[0]!)).toContain("REFUSED MESSAGE");
  expect(said(requests[1]!)).toContain("Answer after restart.");
  expect(said(requests[1]!)).toContain("REFUSED MESSAGE");
  await host.close();
}, 60_000);

test("a failure that is not a refusal keeps the message for the next request", async () => {
  const dir = mkdtempSync(join(root, "c-"));
  const requests: ModelContext[] = [];
  const { host, faux } = fauxHost(dir);
  faux.setResponses([
    fauxAssistantMessage("First answer."),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "400 invalid_request_error",
    }),
    (request: ModelContext) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage("Next answer.");
    },
  ]);
  await host.send("c1", operator("first message"), "op:1");
  await until(idle(host));
  await host.send("c1", operator("FAILED MESSAGE"), "op:2");
  await until(idle(host));
  await host.send("c1", operator("next message"), "op:3");
  await until(idle(host));
  expect(said(requests[0]!)).toContain("FAILED MESSAGE");
  await host.close();
}, 60_000);
