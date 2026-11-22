import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import * as artifacts from "../../../../src/artifacts";
import { type Fixture, type Routes, hex } from "../fixture";

export function routes(fx: Fixture): Routes {
  const { load, rootAgentId, once, dirs, instance } = fx;
  const { create, appendNative, publishFiles, script, submitDurable } =
    fx.agents;
  const { seedHistory } = fx.history;
  const { PNG_1X1 } = fx.media;
  return {
    "seed-named-artifacts": async (body) => {
      const { agent, titles } = body as {
        agent: string;
        titles: string[];
      };
      const ids: string[] = [];
      for (const title of titles) {
        const item = await artifacts.create(dirs, {
          owner: agent,
          title,
        });
        await Bun.write(
          join(String(item.repo_path), "index.md"),
          `# ${title}\n\n${title} body.\n`,
        );
        await artifacts.publish(dirs, agent, String(item.id));
        ids.push(String(item.id));
      }
      return { ids };
    },
    "seed-pane-reading": async (body) => {
      const item = await artifacts.create(dirs, {
        owner: rootAgentId(),
        title: "Reading document",
      });
      const content =
        typeof body?.markdown === "string"
          ? body.markdown
          : "# First document line\n\n" +
            Array.from(
              { length: 100 },
              (_, i) =>
                `## Section ${i + 1}\n\nDocument paragraph ${i + 1}.\n\n`,
            ).join("");
      await Bun.write(join(String(item.repo_path), "index.md"), content);
      await artifacts.publish(dirs, rootAgentId(), String(item.id));
      const conv = load(rootAgentId())!;
      await appendNative(
        conv,
        "Show the reading document.",
        `[Reading document](#artifact=${item.id})`,
      );
      const demo = "pane-reading-files";
      await once({ agent: demo }, () =>
        create(demo, "Reading files", rootAgentId()),
      );
      for (const draft of [1, 2, 3])
        await publishFiles(demo, {
          "reading.md": `${content}\nDraft ${draft}.\n`,
        });
      return { id: item.id, cwd: item.repo_path, demo };
    },
    "seed-artifact-sections": async (body) => {
      const agent = `section-links-${hex(4)}`;
      await create(agent, "Artifact sections");
      const item = await artifacts.create(dirs, {
        owner: agent,
        title: "Section links",
      });
      await Bun.write(
        join(String(item.repo_path), "index.md"),
        body.markdown.replaceAll("$ARTIFACT", String(item.id)),
      );
      await artifacts.publish(dirs, agent, String(item.id));
      script(agent).setResponses([
        fauxAssistantMessage(
          `[Section](#artifact=${item.id}&section=browser-control-first-1) · [Missing section](#artifact=${item.id}&section=unknown)`,
        ),
      ]);
      await submitDurable(agent, "Show the second browser control section.");
      return { agent, id: item.id };
    },
    "seed-native-artifact-settings": async () => {
      const agent = `native-tools-${hex(4)}`;
      await create(agent, "Native tools");
      let id = "";
      script(agent).setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("artifact", {
              action: "create",
              title: "Native report",
            }),
            fauxToolCall("recurse_settings", { action: "themes" }),
          ],
          { stopReason: "toolUse" },
        ),
        async (request) => {
          const result = request.messages.findLast(
            (message) =>
              message.role === "toolResult" && message.toolName === "artifact",
          );
          const created = JSON.parse((result as any).content[0].text);
          id = created.id;
          const item = await artifacts.get(dirs, agent, id);
          await Bun.write(
            join(String(item.repo_path), "index.md"),
            "# Native report\n\nCreated by a direct tool call.\n",
          );
          await artifacts.publish(dirs, agent, id);
          return fauxAssistantMessage(`[Native report](#artifact=${id})`);
        },
      ]);
      await instance.durable.setSafetyReviewOff(agent, true);
      await submitDurable(
        agent,
        "Create a report Artifact and show the current themes.",
      );
      return { agent, id };
    },
    "seed-artifact-app": async (body) => {
      const reader = body.reader;
      const owner = body.agent || rootAgentId();
      const item = await artifacts.create(dirs, {
        owner,
        title: "Browser app",
      });
      const repo = String(item.repo_path);
      await Bun.write(
        join(repo, "index.html"),
        '<!doctype html><link rel="stylesheet" href="./style.css"><img src="./dot.png" alt="dot"><button id="count">0</button><button id="boom">Break</button><script type="module" src="./app.ts"></script>' +
          (reader === "long"
            ? Array.from(
                { length: 100 },
                (_, i) =>
                  `<section style="padding:16px;border-bottom:1px solid var(--border)"><h2>Artifact section ${i + 1}</h2><p>A full-width reading surface with one continuous scroll.</p></section>`,
              ).join("")
            : reader === "viewport"
              ? '<main style="height:100vh">Viewport-sized app</main><p>App footer</p>'
              : ""),
      );
      await Bun.write(
        join(repo, "style.css"),
        "#count { color: rgb(0, 128, 0); border: 2px solid var(--accent) }",
      );
      await Bun.write(join(repo, "dot.png"), PNG_1X1);
      await Bun.write(
        join(repo, "app.ts"),
        'const button = document.getElementById("count")!;\nbutton.onclick = () => (button.textContent = String(Number(button.textContent) + 1));\ndocument.getElementById("boom")!.onclick = () => {\n  throw new TypeError("the chart data is null");\n};\ndocument.body.dataset.ready = "1";\n',
      );
      const published = await artifacts.publish(dirs, owner, String(item.id));
      await seedHistory(
        owner,
        [fauxAssistantMessage(`[Browser app](#artifact=${item.id})`)],
        { replace: true },
      );
      const sourceId = "artifact-link-source";
      await once({ agent: sourceId }, () =>
        create(sourceId, "Artifact links", owner),
      );
      const shared = `[Shared](#agent=${owner}&artifact=${item.id})`;
      await seedHistory(sourceId, [fauxAssistantMessage(shared)], {
        replace: true,
      });
      return { ...published, cwd: repo };
    },
    "publish-review-artifact": async (body) => {
      const { agent, id, markdown } = body as {
        agent: string;
        id?: string;
        markdown: string;
      };
      await once({ agent }, () =>
        create(agent, "Artifact review", rootAgentId()),
      );
      const item = id
        ? await artifacts.get(dirs, agent, id)
        : await artifacts.create(dirs, { owner: agent, title: "Review plan" });
      await Bun.write(join(String(item.repo_path), "index.md"), markdown);
      const published = await artifacts.publish(dirs, agent, String(item.id));
      return { id: String(item.id), version: String(published.version) };
    },
    "seed-saved-app-state": async () => {
      const owner = rootAgentId();
      const app = await artifacts.create(dirs, {
        owner,
        title: "Saved counter",
      });
      await Bun.write(
        join(String(app.repo_path), "index.html"),
        Bun.file(
          new URL("../../fixtures/saved_app_state.html", import.meta.url),
        ),
      );
      return artifacts.publish(dirs, owner, String(app.id));
    },
    "run-artifact-state-tool": async ({ id, replacement }) => {
      const actor = `state-tool-${hex(8)}`;
      const scratch = await mkdtemp(join(tmpdir(), "browser-saved-app-"));
      try {
        await create(actor, "Saved app state tool");
        const args: { action: string; id: string; set_file?: string } = {
          action: "state",
          id,
        };
        if (replacement !== undefined) {
          args.set_file = join(scratch, "state.json");
          await Bun.write(args.set_file, JSON.stringify(replacement));
        }
        let result: unknown;
        script(actor).setResponses([
          fauxAssistantMessage([fauxToolCall("artifact", args)], {
            stopReason: "toolUse",
          }),
          (request) => {
            result = request.messages.findLast(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "artifact",
            );
            return fauxAssistantMessage(
              "Finished using the saved app state tool.",
            );
          },
        ]);
        await submitDurable(
          actor,
          replacement === undefined
            ? "Read the saved app state."
            : "Replace the saved app state with the supplied JSON.",
        );
        return { result };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    "revise-artifact-app": async (body) => {
      const id = body.id;
      const item = await artifacts.get(dirs, rootAgentId(), id);
      await Bun.write(
        join(String(item.repo_path), "revision.txt"),
        "New version",
      );
      return artifacts.publish(dirs, rootAgentId(), id);
    },
  };
}
