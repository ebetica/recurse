import { expect, test } from "bun:test";
import {
  bashCommandDetail,
  bashDetail,
  containsSecret,
  redactSecrets,
  safeTarget,
  safeToolName,
  shellSplit,
} from "../../src/tool_projection/redaction";
import { bashReadTarget } from "../../src/tool_projection/shaping";
import {
  summarizeToolInput,
  toolCallDetails,
} from "../../src/tool_projection/display";
import fixture from "./fixtures/tool_projection/cases.json";

interface Case {
  fn: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  out: unknown;
  call?: {
    version: number;
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
}

const run: Record<string, (c: Case) => unknown> = {
  contains_secret: (c) => containsSecret(c.args[0] as string),
  safe_target: (c) => safeTarget(c.args[0]),
  safe_tool_name: (c) => safeToolName(c.args[0]),
  shell_split: (c) => shellSplit(c.args[0] as string),
  bash_detail: (c) => bashDetail(c.args[0]),
  bash_command_detail: (c) => bashCommandDetail(c.args[0]),
  bash_read_target: (c) => bashReadTarget(c.args[0]),
  summarize_tool_input: (c) =>
    summarizeToolInput(c.args[0], c.args[1] as string | null),
  tool_call_details: (c) =>
    toolCallDetails(c.args[0], c.args[1] as string | null),
};

const cases = fixture.cases as Case[];

test.each(["summarize_tool_input"])(
  "%s redacts credentials and unsafe paths",
  (fn) => {
    for (const c of cases) {
      const value = run[c.fn]!(c);
      if (c.fn === fn) {
        const summary = String(value ?? "");
        expect(summary).not.toMatch(
          /Bearer synthetic|synthetic-token|TOKEN=already-visible|\/private\/|\.\.\//,
        );
      }
      expect(value).toEqual(c.out);
    }
  },
);

// Regression: #2535 compound secret labels must not reach public tool summaries.
test("secret keywords in joined labels redact assigned and space-separated values", () => {
  for (const label of [
    "oauth_token",
    "access_token",
    "api_key",
    "client_secret",
    "refresh_token",
    "token_cache",
    "deploy_oauth_token_name",
  ]) {
    for (const joined of [label, label.replaceAll("_", "-")]) {
      for (const separator of ["=", " "]) {
        const input = `${joined}${separator}synthetic-value`;
        expect(containsSecret(input)).toBe(true);
        expect(redactSecrets(input)).not.toContain("synthetic-value");
      }
    }
  }
});

// Regression: #2535 read-like shell paths must not publish labeled credentials.
// test-check-allow: T9 Security boundary probes require synthetic credential-shaped inputs.
test("public read summaries suppress compound-labeled values but retain owner commands", () => {
  for (const label of ["oauth_token", "oauth-token"]) {
    const command = `cat ${label}:synthetic-value.txt`;
    expect(summarizeToolInput({ command }, "bash")).toBeNull();
    expect(toolCallDetails({ command }, "bash")).toEqual([null, command]);
  }
  expect(summarizeToolInput({ command: "cat oauth_token.txt" }, "bash")).toBe(
    "oauth_token.txt",
  );
});

test("owner-scoped shell details may retain the original command only on the row", () => {
  const captured = cases.find(
    (c) =>
      c.fn === "tool_call_details" && c.call?.toolCallId === "call/parallel:1",
  );
  expect(captured).toBeDefined();
  const [summary, detail] = run.tool_call_details!(captured!) as [
    string | null,
    string | null,
  ];
  expect(summary).toBeNull();
  expect(detail).toContain("TOKEN=already-visible");
  expect(detail).toContain("資料🧬");
});
