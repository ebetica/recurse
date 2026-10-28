import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { testDeps, until, held, idle } from "./fixtures/durable_host/host";
import recorded from "./fixtures/conversation_title/recording.json";

const root = mkdtempSync(join(tmpdir(), "conversation-title-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("names only first operator inputs, preserves renames, and never retries failures or restarts", async () => {
  for (const scenario of [
    "default",
    "rename",
    "child",
    "explicit",
    "agent",
    "error",
  ] as const) {
    const data = mkdtempSync(join(root, "data-"));
    const record: Record<string, unknown> = {
      id: "c1",
      backend: "durable",
      workdir: data,
      title: scenario === "explicit" ? "Chosen title" : null,
      parent: scenario === "child" ? "parent" : null,
    };
    const faux = fauxProvider({ tokensPerSecond: 20000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const gate = held(fauxAssistantMessage(recorded.rawReply));
    const requests: unknown[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    faux.setResponses(
      Array.from(
        { length: 8 },
        () => async (request, options, state, model) => {
          if (options?.sessionId === "title:c1") {
            requests.push(request);
            if (scenario === "error") throw new Error("naming provider failed");
            return gate.step(request, options, state, model);
          }
          return fauxAssistantMessage(recorded.turnReply);
        },
      ),
    );
    const naming = {
      titleSettings: (): [string, string] => ["faux/faux-1", "off"],
      applyTitle: (_cid: string, title: string) => {
        if (!record.title && !record.title_order) record.title = title;
      },
    };
    const host = new DurableHost({
      ...testDeps(
        data,
        () => record,
        () => ["c1"],
      ),
      ...naming,
      models,
      operatorMessageAdmitted: (_cid, at) => {
        record.operator_message_at = at;
      },
      log: (event, fields) => {
        logs.push([event, fields]);
      },
    });
    try {
      await host.send(
        "c1",
        recorded.message,
        scenario === "agent" ? "op:agent:first" : "op:operator:first",
      );
      await until(async () =>
        JSON.stringify((await host.view("c1")).blocks).includes(
          recorded.turnReply,
        ),
      );
      await until(idle(host));
      expect(JSON.stringify((await host.view("c1")).blocks)).toContain(
        recorded.turnReply,
      );
      if (["child", "explicit", "agent"].includes(scenario)) {
        expect(requests).toHaveLength(0);
        expect(record.title).toBe(
          scenario === "explicit" ? "Chosen title" : null,
        );
        continue;
      }
      await until(() => requests.length === 1);
      if (scenario === "rename") {
        record.title = "Operator title";
        record.title_order = "operator";
      }
      gate.release();
      await until(() =>
        logs.some(
          ([event]) =>
            event ===
            (scenario === "error"
              ? "conversation_title_failed"
              : "conversation_title_reply"),
        ),
      );
      expect(record.title).toBe(
        scenario === "error"
          ? null
          : scenario === "rename"
            ? "Operator title"
            : recorded.appliedTitle,
      );
      const capture = logs.find(
        ([event]) => event === "conversation_title_request",
      )![1];
      const inspector = await host.prompt("c1");
      expect((inspector.naming as any).request).toEqual(capture.request);
      expect((inspector.naming as any).title).toBe(
        scenario === "error" ? null : recorded.appliedTitle,
      );
      if (scenario !== "error")
        expect(
          (inspector.naming as any).reply.content
            .map((part: any) => part.text)
            .join(""),
        ).toBe(recorded.rawReply);
      const input = JSON.stringify(capture.request);
      expect(input).toContain(recorded.message);
      expect((capture.request as any).context.systemPrompt).toBe(
        recorded.instruction,
      );
      expect((capture.request as any).context.messages[0].content[0].text).toBe(
        `<message>\n${recorded.message}\n</message>`,
      );
      expect(input).not.toContain("test agent");
      expect((capture.request as any).context.messages).toHaveLength(1);
      await host.send("c1", "Second message excluded", "op:operator:second");
      await until(
        async () =>
          ((await host.view("c1")).blocks as any[]).filter(
            (b) => b.role === "assistant",
          ).length === 2,
      );
      await until(idle(host));
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(capture.request)).not.toContain(
        "Second message excluded",
      );
      if (scenario === "error")
        expect(
          logs.filter(([event]) => event === "conversation_title_failed"),
        ).toHaveLength(1);
      if (scenario === "default" || scenario === "error") {
        await host.close();
        record.title = null;
        delete record.operator_message_at;
        const restarted = new DurableHost({
          ...testDeps(
            data,
            () => record,
            () => ["c1"],
          ),
          ...naming,
          models,
          log: (event, fields) => {
            logs.push([event, fields]);
          },
        });
        try {
          const restored = await restarted.prompt("c1");
          expect(restored.capture_status).toBe("unavailable");
          expect(restored.naming).toEqual(inspector.naming);
          await restarted.send("c1", "After restart", "op:operator:restart");
          await until(
            async () =>
              ((await restarted.view("c1")).blocks as any[]).filter(
                (b) => b.role === "assistant",
              ).length === 3,
          );
          await until(idle(restarted));
          expect(requests).toHaveLength(1);
        } finally {
          await restarted.close();
        }
      }
    } finally {
      gate.release();
      await host.close();
    }
  }
});
