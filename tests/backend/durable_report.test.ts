import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ReportDoc } from "../../src/agents/durable/report";
import { DurableHost } from "../../src/agents/durable/host";
import { switchoverWorld, until } from "./fixtures/durable_host/host";

// Regression: #3081 Report-cursor hydration does not replay earlier advances.
test("report cursor retains a bounded latest snapshot after repeated advances", async () => {
  const world = await switchoverWorld();
  const cid = "report-cursor";
  const host = world.instance.durable;
  const deliver = host.deps.report!;
  let hold = false;
  host.deps.report = (cid, report) =>
    hold ? Promise.resolve("hold") : deliver(cid, report);
  try {
    await world.instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "recurse-test/scripted",
      effort: "off",
      workdir: world.root,
      status: "idle",
    });
    await host.send(cid, "Report the public cursor fixture.", "report:first");
    await until(() => host.runningCount() === 0);
    const opened = await host.open(cid);
    await opened.reporter!.kick();
    const first = await opened.harness.snapshot(
      ReportDoc,
      opened.conversation.id,
      context,
    );
    let last = first!.after;
    for (let i = 0; i < 32; i++) {
      const note = await opened.conversation.submit(
        {
          type: "write",
          requestId: `report:note:${i}`,
          entry: {
            kind: "recurse.note",
            model: [
              {
                role: "user",
                content: `Public report note ${i}.`,
                timestamp: Date.now(),
              },
            ],
          },
        },
        context,
      );
      await note.wait(context);
      await opened.reporter!.kick();
      last = Number(note.id);
    }
    const record = await opened.storage.findDocument(
      {
        kind: ReportDoc.definition.kind,
        scope: { kind: "conversation", conversationId: opened.conversation.id },
      },
      "current",
      context,
    );
    const stored = await opened.storage.document(
      record!.id,
      "current",
      context,
    );
    expect(world.requests.length).toBeGreaterThan(0);
    expect(stored!.value).toEqual({
      generation: first!.generation,
      after: last,
    });
    expect(stored!.deltasSinceBase).toBe(0);
    hold = true;
    await host.send(cid, "Retain this report across restart.", "report:held");
    await until(() => host.runningCount() === 0);
    await opened.reporter!.kick();
    expect(opened.reporter!.caughtUp).toBe(false);
    await host.close();
    const delivered: string[] = [];
    const recovered = new DurableHost({
      ...host.deps,
      report: async (_cid, report) => {
        delivered.push(report.requestId!);
        return "done";
      },
    });
    try {
      await recovered.openLive();
      expect([...recovered.opened.keys()]).toEqual([cid]);
      const active = await recovered.open(cid);
      await active.reporter!.kick();
      expect(delivered).toEqual(["report:held"]);
      const note = await active.conversation.submit(
        {
          type: "write",
          entry: { kind: "recurse.note", data: { text: "display only" } },
        },
        context,
      );
      await note.wait(context);
    } finally {
      await recovered.close();
    }
    const idle = new DurableHost(host.deps);
    try {
      await idle.openLive();
      expect([...idle.opened.keys()]).toEqual([]);
    } finally {
      await idle.close();
    }
  } finally {
    await world.close();
  }
}, 30_000);
