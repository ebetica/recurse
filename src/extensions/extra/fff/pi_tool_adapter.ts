// Bridge Pi search definitions, not its session/event bus. Pi updates replace
// text; Durable appends only new suffixes and serializes details commits before
// return. Host closes each owned finder after Harness tools join. Model-facing
// search help is shortened here without changing the source validators.
import type { JsonValue } from "@earendil-works/chord/json";
import type { TObject } from "typebox";
import type {
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

const descriptions: Record<string, string> = {
  grep: "Search file contents; literal/regex auto-detected, git-aware. Smart-case ignores case for lowercase patterns. Files are ranked; matches stay in source order. Skips files >=256 KiB; use rg in bash.",
  find: "Search whole repo-relative paths by fuzzy terms or glob; multi-word terms are unordered AND. Explore concepts/features/symbols with this first, before ls/find/bash; use ls/read only for directory layout or no matches.",
};

export function adaptPiTool(
  tool: ToolDefinition<ToolDefinition["parameters"], JsonValue>,
) {
  const help: Record<string, string> = {
    pattern:
      tool.name === "grep" ? "Literal text or regex." : "Fuzzy terms or glob.",
    path: "Filter full repo-relative paths: directory prefix (src/), filename (main.ts), or glob (**/*.ts). Absolute, ~/ and ../ paths may search outside cwd.",
    exclude:
      "Exclude using path syntax; comma/space-separated or array. Leading ! is ignored.",
    caseSensitive: "Override smart-case.",
    context: "Lines before/after each match (0-20).",
    limit:
      tool.name === "grep"
        ? "Max matches (default 20)."
        : "Results/page (default 30).",
    cursor: "Previous result's cursor.",
  };
  return defineTool({
    name: tool.name,
    description: descriptions[tool.name] ?? tool.description,
    parameters: descriptions[tool.name]
      ? {
          ...tool.parameters,
          properties: Object.fromEntries(
            Object.entries((tool.parameters as TObject).properties).map(
              ([name, schema]) => [
                name,
                help[name] ? { ...schema, description: help[name] } : schema,
              ],
            ),
          ),
        }
      : tool.parameters,
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
