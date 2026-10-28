// Native file publication reuses conversation-owned attachment admission.
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { registerFile } from "../../../agents/runtime/attachments/publish";
import { AttachmentError } from "../../../agents/runtime/attachments/base";

export function createPublish(collection: string, owner: string) {
  return defineExtension({
    name: "recurse-publish",
    tools: [
      defineTool({
        name: "publish",
        description:
          "Show files to the operator in the UI: attaches them to your reply and the Files pane; images display inline. Other agents never see published files; to share a file with an agent, send its path. Publishing the same filename adds a version (100 MB/file, 120 files/minute). name renames a single file; path text and links do not publish files.",
        parameters: Type.Object({
          paths: Type.Array(Type.String(), { minItems: 1 }),
          name: Type.Optional(Type.String()),
        }),
        executionMode: "sequential",
        async execute(args, api, context) {
          if (args.name !== undefined && args.paths.length > 1)
            throw new Error(
              "name renames one file; publish the others separately",
            );
          const run = await api.memo<string>(
            "recurse.publish",
            randomUUID().replaceAll("-", ""),
            context,
          );
          const lines: string[] = [];
          let failed = false;
          for (const path of args.paths) {
            try {
              const item = await registerFile(
                collection,
                owner,
                run,
                api.callId,
                path,
                api.env!.cwd,
                { name: args.name, manyPerCall: true },
              );
              lines.push(
                `Published ${item.name} (${item.size} bytes)${item.inline_media_type ? "; it displays inline" : ""}.`,
              );
            } catch (error) {
              if (!(error instanceof AttachmentError)) throw error;
              lines.push(`publish: ${path}: ${error.message}`);
              failed = true;
              if (error.message.startsWith("publish limit reached")) break;
            }
          }
          return {
            output: [{ type: "text", text: lines.join("\n") }],
            isError: failed,
          };
        },
      }),
    ],
  });
}
