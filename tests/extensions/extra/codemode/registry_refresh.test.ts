import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import {
  createCodemodeExtension,
  createCodemodeTool,
} from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "@sinclair/typebox";

for (const wrapped of [false, true]) {
  test(`hook-installed tools ${wrapped ? "are visible with" : "stay invisible without"} the codemode agent wrapper`, async () => {
    const faux = fauxProvider({ tokensPerSecond: 50_000 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: "text(await tools.mcp__late__echo({ text: 'registry refreshed' }));",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const workers: Promise<void>[] = [];
    const sandbox = new CodemodeSandbox({
      memoryLimitBytes: 256 * 1024 * 1024,
      onWorkerStarted: (exited) => workers.push(exited),
    });
    registry.install(createCodemodeExtension({ sandbox, models: false }));
    let executed = false;
    let installed = false;
    registry.install(
      defineExtension({
        name: "late-mcp",
        hooks: [
          hook(ToolTask, {
            beforeTool(call) {
              if (call.name === "codemode" && !call.parent) {
                installed = true;
                registry.install(
                  defineExtension({
                    name: "late-tools",
                    tools: [
                      defineTool({
                        name: "mcp__late__echo",
                        description: "Echo",
                        callers: ["tools"],
                        parameters: Type.Object({ text: Type.String() }),
                        execute: async (args) => {
                          executed = true;
                          return {
                            output: [{ type: "text", text: args.text }],
                          };
                        },
                      }),
                    ],
                  }),
                );
              }
              return undefined;
            },
          }),
        ],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      context,
    );
    if (wrapped)
      registry.install(
        defineExtension({
          name: "fresh-codemode",
          wraps: [
            wrapTool(
              createCodemodeTool({ sandbox, models: false }),
              (inner) => ({
                ...inner,
                execute: async (args, api, ctx) =>
                  inner.execute(
                    args,
                    {
                      ...api,
                      agent: async (readContext) =>
                        (await harness.conversation(
                          api.conversationId,
                          readContext,
                        ))!.agent(readContext),
                    },
                    ctx,
                  ),
              }),
            ),
          ],
        }),
      );
    try {
      const model = faux.getModel();
      const conversation = await harness.root(context, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const run = await conversation.submit(
        { type: "input", content: "Run the script", requestId: "refresh" },
        context,
      );
      expect((await run.wait(context)).status).toBe("done");
      const messages = (await conversation.context(context)).messages;
      const result = JSON.stringify(
        messages.findLast((message) => message.role === "toolResult"),
      );
      expect(installed).toBe(true);
      if (wrapped) {
        expect(result).toContain("registry refreshed");
        expect(executed).toBe(true);
      } else {
        expect(
          executed,
          "Pi now refreshes the agent within the call handler: delete the codemode agent() wrapper in src/agents/durable/host.ts and this test",
        ).toBe(false);
        expect(result).toContain("tools.mcp__late__echo does not exist");
      }
    } finally {
      await harness.close(context);
      await sandbox.close();
      expect(workers).toHaveLength(1);
      await Promise.all(workers);
    }
  });
}
