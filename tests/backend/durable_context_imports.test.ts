import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { loadPromptResources } from "../../src/agents/durable/prompt_resources";
import { testDeps, idle, until } from "./fixtures/durable_host/host";

test("project imports preserve text, recurse once, and refuse unsafe or oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-imports-"));
  const repo = join(root, "repo"),
    agent = join(root, "agent");
  await mkdir(repo);
  await mkdir(agent);
  const source =
    "@sub/rules.md @sub/rules.md @missing.md @large.md @../agent/private.md @linked.md @.hidden.md @auth.json @.hidden/rules.md @linked-dir/rules.md\n`@inline.md`\n``@double.md``\n```md\n@fenced.md\n```\n~~~\n@tilde.md\n~~~\n    @indented.md\n\t@indented.md\n" +
    `@~/${relative(homedir(), join(repo, "home.md"))}\n@cap0.md @cap1.md @cap2.md @cap3.md\n`;
  await mkdir(join(repo, "sub"));
  await mkdir(join(repo, ".hidden"));
  await writeFile(join(repo, ".hidden", "rules.md"), "Private");
  await symlink(join(repo, "sub"), join(repo, "linked-dir"));
  await writeFile(join(repo, "home.md"), "Home rules");
  for (let i = 0; i < 4; i++)
    await writeFile(join(repo, `cap${i}.md`), "x".repeat(65536));
  await writeFile(join(repo, "AGENTS.md"), source);
  await writeFile(join(repo, "sub", "rules.md"), "Rules\n@../nested.md\n");
  await writeFile(
    join(repo, "nested.md"),
    "Nested\n@sub/rules.md\n@AGENTS.md\n@depth3.md\n",
  );
  await writeFile(join(repo, "depth3.md"), "@depth4.md");
  await writeFile(join(repo, "depth4.md"), "@depth5.md");
  await writeFile(join(repo, "depth5.md"), "Too deep");
  await writeFile(join(repo, "large.md"), "x".repeat(65537));
  await writeFile(join(agent, "private.md"), "Private");
  for (const name of [
    "indented.md",
    "inline.md",
    "double.md",
    "fenced.md",
    "tilde.md",
    ".hidden.md",
    "auth.json",
  ])
    await writeFile(join(repo, name), "Do not load");
  await symlink(join(agent, "private.md"), join(repo, "linked.md"));
  const { contextFiles } = await loadPromptResources(repo, agent, []);
  expect(contextFiles.filter((file) => file.path.startsWith(repo))).toEqual([
    { path: join(repo, "AGENTS.md"), content: source },
    { path: join(repo, "sub", "rules.md"), content: "Rules\n@../nested.md\n" },
    {
      path: join(repo, "nested.md"),
      content: "Nested\n@sub/rules.md\n@AGENTS.md\n@depth3.md\n",
    },
    { path: join(repo, "depth3.md"), content: "@depth4.md" },
    { path: join(repo, "depth4.md"), content: "@depth5.md" },
    { path: join(repo, "home.md"), content: "Home rules" },
    ...[0, 1, 2].map((i) => ({
      path: join(repo, `cap${i}.md`),
      content: "x".repeat(65536),
    })),
  ]);
  expect(contextFiles.some((file) => file.content === "Private")).toBe(false);
});

test("Durable inspector captures imported instructions in the actual provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-import-turn-"));
  const repo = join(root, "repo"),
    agent = join(root, "agent");
  await mkdir(repo);
  await mkdir(agent);
  const imported = join(repo, "Rules with spaces.md");
  await writeFile(
    join(repo, "AGENTS.md"),
    `@${imported.replaceAll(" ", "\\ ")}\n`,
  );
  await writeFile(imported, "IMPORTED_REQUEST_INSTRUCTIONS");
  const faux = fauxProvider({ tokensPerSecond: 20000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const base = testDeps(
    root,
    () => ({ id: "c1", backend: "durable", workdir: repo }),
    () => ["c1"],
  );
  const host: DurableHost = new DurableHost({
    ...base,
    models,
    promptSnapshot: async () => ({
      ...(await base.promptSnapshot()),
      ...(await host.promptResources(repo, agent, [])),
    }),
  });
  try {
    let received = "";
    faux.setResponses([
      (request) => {
        received = JSON.stringify(request);
        return fauxAssistantMessage("Imported instructions received.");
      },
    ]);
    await host.send("c1", "Read the project instructions.", "imports");
    await until(idle(host));
    expect(received).toContain("IMPORTED_REQUEST_INSTRUCTIONS");
    const inspected = JSON.stringify(await host.prompt("c1"));
    expect(inspected).toContain("IMPORTED_REQUEST_INSTRUCTIONS");
    expect(inspected).toContain(imported);
    expect(inspected).toContain("project_instructions");
  } finally {
    await host.close();
  }
});
