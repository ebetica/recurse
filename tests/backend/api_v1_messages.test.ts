import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { buildApp, WebLogSink } from "../../src/web/app";
import { apiSchema } from "../../src/web/api_v1/schema";
import { held, until } from "./fixtures/durable_host/host";
import { seedPiModelList } from "./pi_model_list_fixture";
import { appWorld } from "./web_app_support";

// Feature: #2921 v1 messages enter the normal Durable delivery path.
test("send v1 message through the fake provider", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const faux = fauxProvider();
  const reply = `v1 reply ${"x".repeat(1100)}`;
  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "text", text: "tool preface" },
        fauxToolCall("bash", {
          command: `printf 'v1-tool\\nsecond-line\\n'; printf '%0600d' 0 # ${"x".repeat(250)}`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(reply),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = (
    app.instance.durable as unknown as {
      deps: { models: typeof models; settings: () => string[] };
    }
  ).deps;
  deps.models = models;
  deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  const deadline = Date.now() + 30_000;
  try {
    while (!app.instance.lifecycle.readinessSnapshot().ready) {
      if (Date.now() > deadline) throw new Error("startup timed out");
      await Bun.sleep(20);
    }
    const sender = String(
      (await app.instance.create.create({ title: "Sender" })).id,
    );
    const target = String(
      (await app.instance.create.create({ title: "Receiver", muted: true })).id,
    );
    const opened = await app.instance.durable.open(target);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    const token = (
      await Bun.file(join(env.CHAT_DATA_DIR!, "server.json")).json()
    ).token as string;
    const headers = {
      "x-loopback-token": token,
      "x-recurse-agent": sender,
      "content-type": "application/json",
    };
    const post = (body: unknown, from = sender) =>
      fetch(`${running.url}/api/v1/agents/${target}/messages`, {
        method: "POST",
        headers: { ...headers, "x-recurse-agent": from },
        body: JSON.stringify(body),
      });
    for (const from of ["missing-agent", ""]) {
      const denied = await post(
        { text: "Message with unresolved sender" },
        from,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        detail: "sender agent is unavailable",
      });
    }
    expect(faux.state.callCount).toBe(0);
    const sent = await post({ text: "hello v1", client_message_id: "v1-test" });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("cache-control")).toBe("no-store");
    const result = (await sent.json()) as { message_id: string };
    expect(
      Value.Check(
        apiSchema.routes["POST /api/v1/agents/{id}/messages"].response,
        result,
      ),
    ).toBe(true);
    const retry = await post({
      text: "ignored retry",
      client_message_id: "v1-test",
    });
    expect(((await retry.json()) as { message_id: string }).message_id).toBe(
      result.message_id,
    );
    const get = (query = "") =>
      fetch(`${running.url}/api/v1/agents/${target}/messages${query}`, {
        headers,
      });
    let page: Static<
      (typeof apiSchema.routes)["GET /api/v1/agents/{id}/messages"]["response"]
    >;
    do {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      page = (await response.json()) as typeof page;
      expect(
        Value.Check(
          apiSchema.routes["GET /api/v1/agents/{id}/messages"].response,
          page,
        ),
      ).toBe(true);
      if (page.messages.some((message) => message.text?.startsWith("v1 reply")))
        break;
      if (Date.now() > deadline) throw new Error("reply timed out");
      await Bun.sleep(20);
    } while (true);
    const user = page.messages.find((message) => message.kind === "user")!;
    const assistant = page.messages.find((message) =>
      message.text?.startsWith("v1 reply"),
    )!;
    const toolCall = page.messages.find(
      (message) => message.kind === "tool_call",
    )!;
    const toolResult = page.messages.find(
      (message) => message.kind === "tool_result",
    )!;
    expect(user.text).toContain("hello v1");
    expect(user.text).toContain(sender);
    expect(assistant.truncated).toBe(true);
    expect(toolCall.truncated).toBe(true);
    expect(toolCall.args?.length).toBe(200);
    expect(toolResult.text).toContain("v1-tool");
    expect(toolResult.truncated).toBe(true);
    const full = (await (await get("?full=true")).json()) as typeof page;
    expect(full.messages.find((message) => message.text === reply)?.text).toBe(
      reply,
    );
    expect(
      full.messages.find((message) => message.kind === "tool_call")?.args,
    ).toContain("x".repeat(250));
    expect(
      full.messages.find((message) => message.kind === "tool_result")?.text,
    ).toContain("second-line");
    const splitResult = (await (
      await get(`?limit=1&after=${toolResult.cursor}`)
    ).json()) as typeof page;
    expect(splitResult.messages).toHaveLength(1);
    expect(splitResult.messages[0]).toMatchObject({
      kind: "tool_result",
      tool: "bash",
      truncated: true,
    });
    const multi = (await (
      await get(`?limit=1&after=${toolCall.cursor}`)
    ).json()) as typeof page;
    expect(multi.messages.map((message) => message.kind)).toEqual([
      "assistant",
      "tool_call",
    ]);
    expect(
      multi.messages.every((message) => message.cursor === toolCall.cursor),
    ).toBe(true);
    const previous = (await (
      await get(`?limit=1&before=${assistant.cursor}`)
    ).json()) as typeof page;
    expect(previous.messages).toHaveLength(1);
    expect(previous.messages[0]!.cursor).toBeLessThan(assistant.cursor);
    const following = (await (
      await get(`?limit=1&after=${previous.next}`)
    ).json()) as typeof page;
    expect(following.messages).toHaveLength(1);
    expect(following.messages[0]!.cursor).toBe(assistant.cursor);
    expect(faux.state.callCount).toBe(2);
    while (app.instance.durable.metadata(target).status !== "idle") {
      if (Date.now() > deadline) throw new Error("first turn did not finish");
      await Bun.sleep(20);
    }
    const active = held(fauxAssistantMessage("interrupted"));
    faux.setResponses([active.step, fauxAssistantMessage("replacement reply")]);
    await post({ text: "hold this turn" });
    await active.started;
    const interrupted = await post({
      text: "replace this turn",
      interrupt: true,
    });
    expect(interrupted.status).toBe(200);
    const interruptedBody = (await interrupted.json()) as {
      interrupted?: boolean;
      steer?: boolean;
    };
    expect(
      Value.Check(
        apiSchema.routes["POST /api/v1/agents/{id}/messages"].response,
        interruptedBody,
      ),
    ).toBe(true);
    expect(interruptedBody).toMatchObject({ interrupted: true, steer: false });
    active.release();
    do {
      const next = (await (await get()).json()) as typeof page;
      if (next.messages.some((message) => message.text === "replacement reply"))
        break;
      if (Date.now() > deadline) throw new Error("replacement reply timed out");
      await Bun.sleep(20);
    } while (true);
    const badQuery = await get("?limit=51");
    expect(badQuery.status).toBe(422);
    expect(await badQuery.json()).toEqual({
      detail: "invalid transcript query",
      code: "invalid_request",
    });
    const invalid = await post({ text: " ", interrupt: false });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      detail: "text must be nonempty",
      code: "invalid_request",
    });
    const badId = await post({ text: "hello", client_message_id: null });
    expect(badId.status).toBe(422);
    expect(await badId.json()).toEqual({
      detail: "invalid client_message_id",
      code: "invalid_request",
    });
  } finally {
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

// Regression: #3324 interrupt retries keep the replacement run alive.
test.each([false, true])(
  "a lost interrupt acknowledgement keeps its replacement (clear=%s)",
  async (clearing) => {
    const { root, env } = appWorld({ password: true });
    seedPiModelList(join(root, "data", "config"));
    const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
    const initial = held(fauxAssistantMessage("old reply"));
    const replacement = held(fauxAssistantMessage("replacement completed"));
    const faux = fauxProvider();
    faux.setResponses([initial.step, replacement.step]);
    const models = createModels();
    models.setProvider(faux.provider);
    const deps = (
      app.instance.durable as unknown as {
        deps: { models: typeof models; settings: () => string[] };
      }
    ).deps;
    deps.models = models;
    deps.settings = () => ["faux/faux-1", "off"];
    const running = await app.serve({ port: 0 });
    try {
      await until(() => app.instance.lifecycle.readinessSnapshot().ready);
      const target = String(
        (await app.instance.create.create({ title: "Receiver", muted: true }))
          .id,
      );
      const token = (
        await Bun.file(join(env.CHAT_DATA_DIR!, "server.json")).json()
      ).token as string;
      const headers = {
        "x-loopback-token": token,
        "content-type": "application/json",
      };
      const url = `${running.url}/api/v1/agents/${target}/messages`;
      const post = (body: unknown) =>
        fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      await post({ text: "initial prompt", client_message_id: "initial" });
      await initial.started;
      const original = clearing
        ? await app.instance.durable.open(target)
        : undefined;
      if (clearing) await app.instance.durable.clear(target);
      const send = {
        text: "replacement prompt",
        interrupt: true,
        client_message_id: "replacement",
      };
      const lost = await post(send);
      await lost.body?.cancel();
      await replacement.started;
      const run = await app.instance.durable.stopStatus(target);
      expect(run[0]).toBe("running");
      const retry = await post(send);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        message_id: "op:operator::replacement",
        interrupted: false,
      });
      if (original)
        expect(await app.instance.durable.stop(target, run[1]!, original)).toBe(
          false,
        );
      expect(await app.instance.durable.stopStatus(target)).toEqual(run);
      replacement.release();
      await until(
        () => app.instance.durable.metadata(target).status === "idle",
      );
      const page = (await (
        await fetch(`${url}?full=true`, { headers })
      ).json()) as { messages: { kind: string; text?: string }[] };
      expect(
        page.messages.filter(
          (message) =>
            message.kind === "user" &&
            message.text?.includes("replacement prompt"),
        ),
      ).toHaveLength(1);
      expect(
        page.messages
          .filter((message) => message.kind === "assistant")
          .map((m) => m.text),
      ).toEqual(["replacement completed"]);
      expect(faux.state.callCount).toBe(2);
    } finally {
      initial.release();
      replacement.release();
      await running.close();
      await app.instance.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
