import { afterAll, expect, test } from "bun:test";
import {
  AsyncJsonlRangeReader,
  JsonlRangeReader,
} from "../../src/agents/view/session_entries";
import fixture from "./fixtures/session_entries/cases.json";
import {
  jsonlBytes,
  type JsonlFixture,
} from "./fixtures/session_entries/jsonl";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
const temp = mkdtempSync(join(tmpdir(), "session-entries-ts-"));
const paths = new Map<string, string>();
for (const scenario of scenarios) {
  if (scenario.file === null || scenario.jsonl === null) continue;
  const path = join(temp, scenario.file);
  writeFileSync(path, jsonlBytes(scenario.jsonl));
  paths.set(scenario.scenario, path);
}

afterAll(() => rmSync(temp, { recursive: true, force: true }));

test("async forward pages charge each line once in both byte modes", async () => {
  const path = join(temp, "async-forward-budget.jsonl");
  const header = { type: "session", id: "async-budget", cwd: "/work" };
  const rows = ["entry-1", "entry-2", "entry-3"].map((id) => ({
    type: "message",
    id,
    parentId: null,
    message: { role: "user", content: "hello" },
  }));
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const data = line(header) + rows.map(line).join("");
  writeFileSync(path, data);
  const start = line(header).length;
  const compactLineBytes = line(rows[0]!).length;
  const pythonJsonBytes = line(rows[0]!)
    .slice(0, -1)
    .replaceAll(",", ", ")
    .replaceAll(":", ": ").length;
  const reader = new AsyncJsonlRangeReader(path);

  for (const [stripImages, maxBytes] of [
    [false, compactLineBytes * 2],
    [true, pythonJsonBytes + Math.floor(compactLineBytes / 2)],
  ] as const) {
    const [page] = await reader.forwardPage(start, {
      maxBytes,
      maxLines: 10,
      stripImages,
    });
    expect(page.map(([, , entry]) => entry.id)).toEqual(["entry-1", "entry-2"]);
  }
});

test("cursors cap old-history scans", () => {
  const scenario = scenarios.find((item) => item.scenario === "history.jsonl")!;
  const path = paths.get(scenario.scenario)!;
  const data = readFileSync(path);
  const headerEnd = data.indexOf(10) + 1;
  const reader = new JsonlRangeReader(path);
  const [backwardRows, capped] = reader.backwardLines(
    data.length,
    headerEnd,
    520,
  );
  expect(capped).toBe(true);
  expect(backwardRows.length).toBeLessThan(8);
});

test("identity-pinned reads reject a replaced session file", () => {
  const scenario = scenarios.find((item) => item.scenario === "history.jsonl")!;
  const path = paths.get(scenario.scenario)!;
  const reader = new JsonlRangeReader(path);
  const opened = reader.header();
  expect(opened).not.toBeNull();
  const identity = opened![2].identity;
  expect(
    reader.backwardLines(opened![2].size, opened![0], 1 << 20, identity)[0]
      .length,
  ).toBeGreaterThan(0);
  const replacement = join(temp, "replacement.jsonl");
  writeFileSync(replacement, readFileSync(path).toString("utf8"));
  const retired = join(temp, "retired.jsonl");
  renameSync(path, retired);
  renameSync(replacement, path);
  expect(() =>
    reader.backwardLines(opened![2].size, opened![0], 1 << 20, identity),
  ).toThrow();
});

test("unsafe symlink and hard-linked session paths fail closed", () => {
  const scenario = scenarios.find((item) => item.scenario === "history.jsonl")!;
  const path = paths.get(scenario.scenario)!;
  const symlink = join(temp, "session-link.jsonl");
  const hardlink = join(temp, "session-hardlink.jsonl");
  symlinkSync(path, symlink);
  linkSync(path, hardlink);
  expect(new JsonlRangeReader(symlink).header()).toBeNull();
  expect(() =>
    new JsonlRangeReader(hardlink).backwardLines(1024, 0, 1024),
  ).toThrow();
});
