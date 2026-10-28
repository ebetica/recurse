import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
} from "@earendil-works/pi-durable";
import { systemBeforeUserHook } from "../../src/agents/durable/system_order.ts";

async function requestRoles(reorder: boolean): Promise<string[][]> {
  const faux = fauxProvider({ models: [{ id: "faux" }] });
  const seen: string[][] = [];
  const reply = (request: Context) => {
    seen.push(request.messages.map((message) => message.role));
    return fauxAssistantMessage(fauxText("ok"));
  };
  faux.setResponses([reply, reply]);
  const models = createModels();
  models.setProvider(faux.provider);
  let tree = "tree one";
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "sections",
      sections: [section("recurse_tree", () => tree, { tag: false })],
      hooks: reorder ? [systemBeforeUserHook] : [],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  );
  try {
    const model = faux.getModel();
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    for (const [turn, content] of ["first", "second"].entries()) {
      if (turn === 1) tree = "tree two";
      const run = await conversation.submit(
        { type: "input", content, requestId: `turn-${turn}` },
        context,
      );
      expect((await run.wait(context)).status).toBe("done");
    }
  } finally {
    await harness.close(context);
  }
  return seen;
}

describe("systemBeforeUserHook", () => {
  // Regression: #2097 changed system sections were sent after the user message
  test("Durable alone sends a later turn's changed sections after its user message", async () => {
    expect(await requestRoles(false)).toEqual([
      ["system", "user"],
      ["system", "user", "assistant", "user", "system"],
    ]);
  });

  // Regression: #2097 changed system sections were sent after the user message
  test("the hook sends the sections before the user message", async () => {
    expect(await requestRoles(true)).toEqual([
      ["system", "user"],
      ["system", "user", "assistant", "system", "user"],
    ]);
  });
});
