// The native Artifact tool reads and replaces saved app state as ordinary tool output.
import { Type } from "typebox";
import { resolve } from "node:path";
import {} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ArtifactContext } from "../../../artifacts";
import {
  create,
  listArtifacts,
  rename,
  resolveOwner,
} from "../../../artifacts";
import {
  readAppState,
  readAppStateFile,
  writeAppState,
} from "../../../artifact_app_state";
import { artifactWorkingPath } from "../../../artifacts/working_path";

/** Markdown documents may link to other files in the Artifact with relative links. */
export function createArtifact(context: ArtifactContext, owner: string) {
  return defineExtension({
    name: "recurse-artifact",
    tools: [
      defineTool({
        name: "artifact",
        description:
          "Create only on explicit operator request; update requested Artifacts instead of duplicating them. Create/list/rename return ids, titles and working paths. " +
          "Edit the returned working path; git commit publishes automatically. Restore with git restore --source=<sha>, then commit. " +
          "File tools/bash expand $CHAT_DATA_DIR. Documents use index.md; apps use index.html with local imports, bundled by Bun. " +
          "Markdown documents may link to other files in the Artifact with relative links. " +
          "Apps have no network/browser storage. Saved app state uses window.recurse.getState(), window.recurse.setState(value) and the recurse:statechange event. " +
          "Use state with id to read the saved JSON; provide set_file to replace it. Use theme CSS vars (var(--bg), var(--text), var(--accent), var(--chart-1)). " +
          "Commit output reports publication/app checks; fix problems and recommit. Read wide/narrow screenshots. Link [Title](#artifact=ID); add &section=heading-slug to open a section.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("create"),
            Type.Literal("list"),
            Type.Literal("rename"),
            Type.Literal("state"),
          ]),
          title: Type.Optional(
            Type.String({ description: "For create/rename." }),
          ),
          from_file: Type.Optional(
            Type.String({
              description: "Source .md/.html for create; relative to cwd.",
            }),
          ),
          id: Type.Optional(Type.String({ description: "For rename/state." })),
          set_file: Type.Optional(
            Type.String({
              description:
                "JSON file to replace saved app state; relative to cwd.",
            }),
          ),
          all: Type.Optional(
            Type.Boolean({
              description: "List all Artifacts (default: this agent only).",
            }),
          ),
        }),
        executionMode: "sequential",
        async execute(args, api) {
          if (args.action === "state") {
            if (!args.id) throw new Error("id is required for state");
            const artifactOwner = await resolveOwner(context, args.id);
            const text =
              args.set_file === undefined
                ? await readAppState(context, artifactOwner, args.id)
                : await writeAppState(
                    context,
                    artifactOwner,
                    args.id,
                    await readAppStateFile(
                      resolve(api.env!.cwd, args.set_file),
                    ),
                  );
            return { output: [{ type: "text", text }] };
          }
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
                  link: `[${String(item.title).replace(/[[\]<>\\]/g, "\\$&")}](#artifact=${id})`,
                }),
              },
            ],
          };
        },
      }),
    ],
  });
}
