import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { retire, sweep } from "../../src/utils/trash";
import { checkPromptBudget, renderPromptBudget } from "../checks/prompt_budget";
import promptCapture from "./fixtures/extras/prompt.json";

// Regression: #3309 checkout path length must not change the rendered content budget.
test("live CLI help and prompt budget match across checkout paths", async () => {
  const report = await renderPromptBudget();
  checkPromptBudget(report);
  expect(report.sections.cwd).toContain("/fixture/recurse");
  expect(report.sections.project_context).toContain(
    'path="/fixture/recurse/AGENTS.md"',
  );
  expect(report.sections.recurse_tools).toBe(
    `<recurse_tools>\n${promptCapture.section}\n</recurse_tools>`,
  );
  const repo = resolve(import.meta.dir, "../..");
  const relocated = await mkdtemp(
    join(tmpdir(), `recurse-prompt-budget-${"long-directory-".repeat(8)}`),
  );
  const trash = await mkdtemp(join(tmpdir(), "recurse-prompt-budget-trash-"));
  try {
    await mkdir(join(relocated, "tools"));
    await mkdir(join(relocated, ".git"));
    await Promise.all(
      ["AGENTS.md", "tools/subagent.ts", "tools/worktree.ts"].map((path) =>
        copyFile(join(repo, path), join(relocated, path)),
      ),
    );
    const other = await renderPromptBudget(relocated);
    checkPromptBudget(other);
    expect(other.total).toBe(report.total);
    expect(other.sections).toEqual(report.sections);
  } finally {
    retire(relocated, trash);
    sweep(trash, 1);
    await rmdir(trash);
  }
});
