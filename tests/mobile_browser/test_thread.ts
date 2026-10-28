import { runBrowserTests, type BrowserTest } from "./common";
import { testRecordedActivityLines } from "./test_activity_lines";
import { turnGroupTests } from "./test_turn_groups";
import { disclosuresTests } from "./thread_disclosures";
import { toolsTests } from "./thread_tools";
import { liveTests } from "./thread_live";

export const tests: BrowserTest[] = [
  ...turnGroupTests,
  testRecordedActivityLines,
  ...disclosuresTests,
  ...toolsTests,
  ...liveTests,
];

if (import.meta.main) await runBrowserTests([["thread", tests]]);
