// Bridge Pi search definitions, not its session/event bus. Pi updates replace
// text; Durable appends only new suffixes and serializes details commits before
// return. Host closes each owned finder after Harness tools join.
import type { JsonValue } from "@earendil-works/chord";
import type {
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

export function adaptPiTool(
  tool: ToolDefinition<ToolDefinition["parameters"], JsonValue>,
) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: "safe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      if (!api.env)
        throw new Error(`${tool.name} requires an execution environment`);
      let output = "";
      let updates = Promise.resolve();
      let updateError: unknown;
      let result;
      try {
        result = await tool.execute(
          api.callId,
          args,
          context.abortSignal,
          (partial) => {
            const text = partial.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            if (text.startsWith(output)) api.output(text.slice(output.length));
            else api.output(`\n${text}`);
            output = text;
            if (partial.details !== undefined) {
              updates = updates
                .then(() => api.details(partial.details, context))
                .catch((error: unknown) => {
                  updateError ??= error;
                });
            }
          },
          { cwd: api.env.cwd } as ExtensionToolContext,
        );
      } finally {
        await updates;
      }
      if (updateError !== undefined) throw updateError;
      return { output: result.content, details: result.details };
    },
  });
}
