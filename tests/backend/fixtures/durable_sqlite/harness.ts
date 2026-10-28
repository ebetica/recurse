/** Durable Harness on Worker SQLite with a faux model: each turn calls one tool that prints 200 lines, then answers. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite";

export async function openFauxHarness(database: SqliteDatabase) {
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  faux.setResponses(
    Array.from(
      { length: 1000 },
      () => (request: { messages: readonly { role: string }[] }) =>
        request.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage(fauxText("done"))
          : fauxAssistantMessage(fauxToolCall("print", { lines: 200 }), {
              stopReason: "toolUse",
            }),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const print = defineTool({
    name: "print",
    description: "Print lines",
    parameters: Type.Object({ lines: Type.Number() }),
    execute: async (input, api) => {
      for (let i = 0; i < input.lines; i++)
        api.output(`line ${i} ${"x".repeat(60)}\n`);
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "crash", tools: [print] }));
  const harness = await Harness.open(
    await SqliteStorage.open(database),
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  );
  const model = faux.getModel();
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, conversation };
}
