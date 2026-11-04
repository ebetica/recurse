import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ReportDoc } from "../../src/agents/durable/report";
import { switchoverWorld, until } from "./fixtures/durable_host/host";

// Regression: #3081 Report-cursor hydration does not replay earlier advances.
test("report cursor retains a bounded latest snapshot after repeated advances", async () => {
  const world = await switchoverWorld();
  const cid = "report-cursor";
  const host = world.instance.durable;
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
  } finally {
    await world.close();
  }
}, 30_000);
