import { expect, test } from "bun:test";
import { checkPromptBudget, renderPromptBudget } from "../checks/prompt_budget";
import promptCapture from "./fixtures/extras/prompt.json";

test("live CLI help matches a recorded fresh Durable request", async () => {
  const report = await renderPromptBudget();
  checkPromptBudget(report);
  expect(report.sections.recurse_tools).toBe(
    `<recurse_tools>\n${promptCapture.section}\n</recurse_tools>`,
  );
});
