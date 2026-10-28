import { expect, test } from "bun:test";
import { scrubRecording, recordProvider } from "../dev/record_provider";
import { type Recording } from "./fixtures/provider_replay/server";

test.each(["openai-codex-sse", "openai-codex-auto"])(
  "scrubbing %s retains wire partitions with escaped UTF8",
  async (name) => {
    const recording: Recording = await Bun.file(
      `${import.meta.dir}/fixtures/provider_replay/${name}.json`,
    ).json();
    const exchange = recording.exchanges[0]!;
    const original = Buffer.concat(
      exchange.chunks.map(
        (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
      ),
    );
    const probe = JSON.stringify('PUBLIC_PRIVACY_PROBE é "\n').slice(1, -1);
    const modified = Buffer.from(
      original
        .toString()
        .replace(
          /("instructions"\s*:\s*")(x+)(")/,
          (_, prefix, value, suffix) =>
            prefix +
            probe +
            "x".repeat(Buffer.byteLength(value) - Buffer.byteLength(probe)) +
            suffix,
        ),
    );
    expect(modified.byteLength).toBe(original.byteLength);
    expect(modified.toString()).toContain("PUBLIC_PRIVACY_PROBE");
    let offset = 0;
    for (const chunk of exchange.chunks) {
      const size = Buffer.from(chunk.data, "base64").byteLength;
      chunk.data = modified.subarray(offset, offset + size).toString("base64");
      offset += size;
    }
    if (exchange.transport === "websocket")
      for (const chunk of exchange.chunks) {
        const frame = Buffer.from(chunk.data, "base64").toString("utf8");
        const event = JSON.parse(frame);
        if (event.type === "codex.response.metadata") {
          for (const [key, probe] of [
            ["x-codex-turn-state", "PUBLIC_STATE"],
            ["x-models-etag", "PUBLIC_ETAG"],
          ]) {
            const value = event.headers[key];
            expect(value).toMatch(/^x+$/);
            event.headers[key] =
              probe + "A".repeat(value.length - probe.length);
          }
        } else if (event.type === "codex.rate_limits") {
          event.plan_type = "PUBLIC_PLAN";
          event.rate_limits = { used_percent: 73, reset_at: 1234567890 };
          event.credits = { balance: "PUBLIC_BALANCE" };
        } else continue;
        const encoded = JSON.stringify(event);
        chunk.data = Buffer.from(
          encoded +
            " ".repeat(Buffer.byteLength(frame) - Buffer.byteLength(encoded)),
        ).toString("base64");
      }
    recording.model.headers = { Authorization: "PUBLIC_METADATA_PROBE" };
    const before = structuredClone(recording);
    const scrubbed = scrubRecording(recording);
    expect(recording).toEqual(before);
    expect(scrubbed.model.headers).toBeUndefined();
    expect(
      scrubbed.exchanges[0]!.chunks.map((chunk) => [
        chunk.ms,
        Buffer.from(chunk.data, "base64").byteLength,
      ]),
    ).toEqual(
      exchange.chunks.map((chunk) => [
        chunk.ms,
        Buffer.from(chunk.data, "base64").byteLength,
      ]),
    );
    const bytes = Buffer.concat(
      scrubbed.exchanges[0]!.chunks.map(
        (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
      ),
    );
    for (const probe of [
      "PUBLIC_PRIVACY_PROBE",
      "PUBLIC_STATE",
      "PUBLIC_ETAG",
      "PUBLIC_PLAN",
      "PUBLIC_BALANCE",
    ])
      expect(bytes.toString()).not.toContain(probe);
    expect(bytes.toString()).toContain("RECORDED_PROVIDER_OK");
    expect(bytes.equals(new Uint8Array(original))).toBe(true);
  },
);

// Feature: #2477 identifier scrubbing must preserve protocol keys and mask summary prose.
test("native read recording keeps protocol keys and masks reasoning summaries", async () => {
  const recording: Recording = await Bun.file(
    `${import.meta.dir}/fixtures/provider_replay/openai-codex-read.json`,
  ).json();
  for (const exchange of recording.exchanges) {
    const bytes = Buffer.concat(
      exchange.chunks.map(
        (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
      ),
    );
    const probe = Buffer.from(
      bytes
        .toString()
        .replace(
          /("type":"(?:response\.reasoning_summary_text\.(?:delta|done)|summary_text)"[^{}]*?"(?:delta|text)":")(x*)(")/g,
          (_, prefix, value, suffix) =>
            prefix + "Q".repeat(value.length) + suffix,
        ),
    );
    expect(probe.length).toBe(bytes.length);
    let offset = 0;
    for (const chunk of exchange.chunks) {
      const size = Buffer.from(chunk.data, "base64").length;
      chunk.data = probe.subarray(offset, offset + size).toString("base64");
      offset += size;
    }
  }
  const scrubbed = scrubRecording(recording);
  expect(
    scrubbed.exchanges.map((e) =>
      e.chunks.map((c) => [c.ms, Buffer.from(c.data, "base64").length]),
    ),
  ).toEqual(
    recording.exchanges.map((e) =>
      e.chunks.map((c) => [c.ms, Buffer.from(c.data, "base64").length]),
    ),
  );
  const events = scrubbed.exchanges.flatMap((e) =>
    Buffer.concat(
      e.chunks.map((c) => new Uint8Array(Buffer.from(c.data, "base64"))),
    )
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6))),
  );
  const calls = events
    .flatMap((e) => [e.item, ...(e.response?.output ?? [])])
    .filter((item) => item?.type === "function_call");
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(Object.keys(call).filter((key) => key.startsWith("call_"))).toEqual([
      "call_id",
    ]);
    expect(call.call_id).toBe(calls[0].call_id);
    expect(call.call_id).toMatch(/^call_[0-9]+$/);
    expect(call.name).toBe("read");
  }
  expect(calls[0].arguments).toBe("");
  expect(calls.slice(1).map((call) => JSON.parse(call.arguments).path)).toEqual(
    ["live-seed.txt", "live-seed.txt"],
  );
  const summaries = events
    .flatMap((e) => [
      e.type?.startsWith("response.reasoning_summary_text.")
        ? (e.delta ?? e.text)
        : null,
      e.part?.type === "summary_text" ? e.part.text : null,
      ...(e.item?.summary ?? []).map((p: { text: string }) => p.text),
      ...(e.response?.output ?? []).flatMap(
        (i: { summary?: { text: string }[] }) =>
          (i.summary ?? []).map((p) => p.text),
      ),
    ])
    .filter((value) => typeof value === "string" && value.length);
  expect(summaries.length).toBeGreaterThan(0);
  for (const text of summaries) expect(text).toMatch(/^x+$/);
});

test.each([
  "http://api.anthropic.com",
  "https://api.anthropic.com.attacker.invalid",
  "https://127.0.0.1",
  "https://chatgpt.com@attacker.invalid",
  "https://user:password@chatgpt.com",
])("recorder rejects credential forwarding to %s", async (upstream) => {
  const recording: Recording = await Bun.file(
    `${import.meta.dir}/fixtures/provider_replay/anthropic-sse.json`,
  ).json();
  expect(() => recordProvider(upstream, recording)).toThrow(
    "unsupported recording upstream",
  );
  expect(recording.exchanges).toHaveLength(1);
});
