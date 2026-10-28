import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";

import { rtkExtension } from "../../src/extensions/extra/rtk/rtk.ts";

test("RTK advisory rewriting follows safety; denial never reaches rewriting and missing/disabled RTK passes through", async () => {
  const command = "git status --short";
  const observed = "rtk git status --short";
  const root = await mkdtemp(join(tmpdir(), "durable-rtk-"));
  await writeFile(
    join(root, "rtk"),
    `#!/bin/sh\n[ "$1" = rewrite ] && [ "$2" = '${command}' ] || exit 1\nprintf '%s' '${observed}'\nexit 3\n`,
    { mode: 0o700 },
  );
  try {
    for (const mode of [
      "rewrite",
      "denied",
      "missing",
      "disabled",
      "unmanaged",
    ]) {
      const denied = mode === "denied";
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const executed: string[] = [],
        reviewed: string[] = [];
      let rewrites = 0;
      registry.install(
        defineExtension({
          name: "fixture",
          tools: [
            defineTool({
              name: "bash",
              description: "capture",
              parameters: Type.Object({ command: Type.String() }),
              execute: async (args) => {
                executed.push(args.command);
                return { output: [{ type: "text", text: "ok" }] };
              },
            }),
          ],
          hooks: [
            hook(ToolTask, {
              beforeTool: (call) => {
                reviewed.push(String(call.arguments.command));
                return denied ? { block: "denied fixture" } : undefined;
              },
            }),
          ],
        }),
      );
      registry.install(
        rtkExtension(async () => {
          rewrites++;
          return {
            cwd: root,
            env: {
              PATH: mode === "missing" ? join(root, "missing") : root,
              RTK_DISABLED: mode === "disabled" ? "1" : "0",
            },
          };
        }, mode !== "unmanaged"),
      );
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxText("done")),
      ]);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry },
        context,
      );
      try {
        const conversation = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        });
        await conversation.submit({ type: "input", content: "run" }, context);
        await conversation.waitForIdle(context);
        expect(reviewed).toEqual([command]);
        expect(rewrites).toBe(denied || mode === "unmanaged" ? 0 : 1);
        expect(executed).toEqual(
          denied ? [] : [mode === "rewrite" ? observed : command],
        );
      } finally {
        await harness.close(context);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
