// Deferred Artifact discovery and creation reuse the Git-backed Artifact store.
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ArtifactContext } from "../../../artifacts";
import { create, listArtifacts, rename } from "../../../artifacts";
import { artifactWorkingPath } from "../../../artifacts/working_path";

export function createArtifact(context: ArtifactContext, owner: string) {
  return defineExtension({
    name: "recurse-artifact",
    tools: [
      defineTool({
        name: "artifact",
        deferred: true,
        description:
          "Create an Artifact only when the operator explicitly asks for one. List or rename existing Artifacts; update an existing requested Artifact instead of making duplicates. " +
          "create requires title and optionally from_file (.md or .html); list defaults to this agent's Artifacts, or all=true for everyone's. Results include id, title and the local working path. " +
          "Edit files at that path with read/edit/write or bash, then git commit: every commit publishes automatically. Use git log or git restore --source=<sha> for older versions, then commit to publish the restored files. " +
          "$CHAT_DATA_DIR in paths expands in read/edit/write and bash. Documents use index.md; apps use index.html and local imports. Apps are bundled by Bun, run without network or browser storage, and inherit Recurse theme CSS variables (var(--bg), var(--text), var(--accent), var(--chart-1)…). " +
          "The commit hook prints publication and app-check results; fix reported problems and commit again. Read its wide/narrow screenshots to inspect the app. Link results with [Title](#artifact=ID).",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("create"),
            Type.Literal("list"),
            Type.Literal("rename"),
          ]),
          title: Type.Optional(
            Type.String({ description: "Title for create or rename." }),
          ),
          from_file: Type.Optional(
            Type.String({
              description:
                "Optional Markdown or HTML source file for create; relative to current cwd.",
            }),
          ),
          id: Type.Optional(
            Type.String({ description: "Artifact id for rename." }),
          ),
          all: Type.Optional(
            Type.Boolean({
              description:
                "List everyone's Artifacts instead of only this agent's.",
            }),
          ),
        }),
        executionMode: "sequential",
        async execute(args, api) {
          if (args.action === "list") {
            const listed = await listArtifacts(
              context,
              args.all ? null : owner,
              { compact: true },
            );
            const rows = listed.artifacts.map((item) => ({
              id: item.id,
              title: item.title,
              path: artifactWorkingPath(String(item.owner), String(item.id)),
            }));
            return {
              output: [
                {
                  type: "text",
                  text: rows.length
                    ? rows.map((row) => JSON.stringify(row)).join("\n")
                    : "No Artifacts.",
                },
              ],
            };
          }
          if (args.title === undefined) throw new Error("title is required");
          let item;
          if (args.action === "create") {
            item = await create(context, {
              owner,
              title: args.title,
              source:
                args.from_file === undefined
                  ? undefined
                  : resolve(api.env!.cwd, args.from_file),
            });
          } else {
            if (!args.id) throw new Error("id is required for rename");
            item = await rename(context, owner, args.id, args.title);
          }
          const id = String(item.id);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  id,
                  title: item.title,
                  path: artifactWorkingPath(owner, id),
                  entry: item.entry,
                  link: `[${String(item.title).replace(/[\[\]<>\\]/g, "\\$&")}](#artifact=${id})`,
                }),
              },
            ],
          };
        },
      }),
    ],
  });
}
