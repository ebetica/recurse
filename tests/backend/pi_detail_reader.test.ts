import { afterAll, expect, test } from "bun:test";
import {
  entryAtOffset,
  entryAtOffsetStrict,
} from "../../src/agents/runtime/pi_detail_reader";
import fixture from "./fixtures/session_entries/cases.json";
import {
  jsonlBytes,
  type JsonlFixture,
} from "./fixtures/session_entries/jsonl";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface Step {
  fn: string;
  args: Record<string, unknown>;
}

interface Scenario {
  scenario: string;
  file: string | null;
  jsonl: JsonlFixture | null;
  steps: Step[];
}

const scenarios = fixture.cases as Scenario[];
const temp = mkdtempSync(join(tmpdir(), "pi-detail-reader-ts-"));
const paths = new Map<string, string>();
for (const scenario of scenarios) {
  if (scenario.file === null || scenario.jsonl === null) continue;
  const path = join(temp, scenario.file);
  writeFileSync(path, jsonlBytes(scenario.jsonl));
  paths.set(scenario.scenario, path);
}

afterAll(() => rmSync(temp, { recursive: true, force: true }));

function scenarioPath(scenario: Scenario): string {
  return paths.get(scenario.scenario) ?? join(temp, "does-not-exist.jsonl");
}

test("detail reads reject stale offsets and invalid bounds", async () => {
  const scenario = scenarios.find((item) => item.scenario === "history.jsonl")!;
  const path = scenarioPath(scenario);
  const size = readFileSync(path).length;
  expect(await entryAtOffsetStrict(path, size + 40, 1 << 20)).toBeNull();
  expect(await entryAtOffsetStrict(path, -1, 1 << 20)).toBeNull();
  expect(await entryAtOffset(path, size + 40, 1 << 20)).toBeNull();
  expect(await entryAtOffset(path, -1, 1 << 20)).toBeNull();
  await expect(entryAtOffset(path, 0, Number.NaN)).rejects.toThrow(RangeError);
  await expect(
    entryAtOffset(path, 0, Number.POSITIVE_INFINITY),
  ).rejects.toThrow(RangeError);
  expect(
    await entryAtOffset(join(temp, "does-not-exist.jsonl"), 0, 1024),
  ).toBeNull();
});

test("async detail reads reject symlink and hard-linked session files", async () => {
  const source = paths.get("history.jsonl")!;
  const symlink = join(temp, "session-link.jsonl");
  const hardlink = join(temp, "session-hardlink.jsonl");
  symlinkSync(source, symlink);
  linkSync(source, hardlink);
  expect(await entryAtOffset(symlink, 0, 1024)).toBeNull();
  await expect(entryAtOffsetStrict(symlink, 0, 1024)).rejects.toThrow();
  await expect(entryAtOffsetStrict(hardlink, 0, 1024)).rejects.toThrow();
});
