// Deferred Artifact discovery and creation reuse the Git-backed Artifact store.
import { Type } from "typebox";
import { resolve } from "node:path";
import {} from "@earendil-works/pi-ai";
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
          "Create only on explicit operator request; update requested Artifacts instead of duplicating them. List or rename existing Artifacts. " +
          "Edit the returned working path; git commit publishes automatically. Restore with git restore --source=<sha>, then commit. " +
          "File tools/bash expand $CHAT_DATA_DIR. Documents use index.md; apps use index.html with local imports, bundled by Bun. " +
          "Apps have no network/browser storage; use theme CSS vars (var(--bg), var(--text), var(--accent), var(--chart-1)). " +
          "Commit output reports publication/app checks; fix problems and recommit. Read wide/narrow screenshots. Link [Title](#artifact=ID).",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("create"),
            Type.Literal("list"),
            Type.Literal("rename"),
          ]),
          title: Type.Optional(
            Type.String({ description: "For create/rename." }),
          ),
          from_file: Type.Optional(
            Type.String({
              description: "Source .md/.html for create; relative to cwd.",
            }),
          ),
          id: Type.Optional(Type.String({ description: "For rename." })),
          all: Type.Optional(
            Type.Boolean({
              description: "List all Artifacts (default: this agent only).",
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
