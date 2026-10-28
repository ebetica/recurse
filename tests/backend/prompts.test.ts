import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureMemorySnapshot,
  renderMemoryPrompt,
} from "../../src/agents/runtime/memory_snapshot";
import {
  Prompts,
  type Conv,
  type PromptsDeps,
} from "../../src/agents/runtime/prompts";

const NOW = 1_790_000_000.0;
const TOOLS = "## Recurse tools available\nsubagent --help text";
const SESSION = "sess-1";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const freshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "prompts-ts-"));
  roots.push(root);
  return root;
};
const attempt = async (fn: () => unknown) => {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: `ValueError: ${(error as Error).message}` };
  }
};

function harness(
  root: string,
  options: {
    tools?: string;
    toolsDir?: boolean;
    statuses?: any;
    session?: string;
  } = {},
) {
  const dataDir = join(root, "data");
  const deps: PromptsDeps = {
    displayName: "Recurse",
    dataDir,
    turnPromptDir: join(dataDir, "turn_prompts"),
    toolsDir: options.toolsDir === false ? null : join(root, "tools"),
    toolsSection: () => options.tools ?? TOOLS,
    conversationEffortLine: (conv) =>
      conv.level
        ? `This conversation runs at effort level ${conv.level}.`
        : null,
    projectStatuses: (convs) => {
      const recorded = options.statuses;
      if (recorded?.error)
        throw new Error(recorded.error.replace(/^ValueError: /u, ""));
      return Object.fromEntries(
        convs.map((c) => [
          c.id as string,
          recorded?.ok?.[c.id as string] ?? "idle",
        ]),
      );
    },
    effectiveWorkdir: (conv) => (conv.workdir as string) || "/default/workdir",
    chatSettings: (model) => [model || "anthropic/claude-opus-5-5", "high"],
    memoryPrompt: async (cid) =>
      renderMemoryPrompt(await captureMemorySnapshot(cid, dataDir), dataDir),
    boundSessionFile: async (sid) =>
      sid === SESSION ? options.session! : null,
    now: () => NOW,
  };
  return { prompts: new Prompts(deps) };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
test("legacy capture reads and cleanup retain current prompt inspection", async () => {
  const root = freshRoot();
  const { prompts } = harness(root);
  const conv: Conv = { id: "f1", model: "m", active_turn: { run_id: "run-1" } };
  expect(await prompts.readPromptValues(conv)).toMatchObject({
    system: "",
    capture_status: "pending",
  });
  conv.system_prompt_capture = {
    version: 1,
    run_id: "run-1",
    status: "unavailable",
  };
  expect(await prompts.readPromptValues(conv)).toMatchObject({
    capture_status: "unavailable",
  });
  const text = "EFFECTIVE ✓";
  const path = prompts.capturedSystemPromptPath(conv);
  mkdirSync(join(root, "data", "turn_prompts"), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  conv.system_prompt_capture = {
    version: 1,
    run_id: "run-1",
    status: "captured",
    hash: sha(text),
  };
  expect(await prompts.readPromptValues(conv)).toMatchObject({
    system: text,
    capture_status: "captured",
  });
  conv.active_turn = { run_id: "run-2" };
  expect(await prompts.readPromptValues(conv)).toMatchObject({
    system: "",
    capture_status: "pending",
  });
  expect(await prompts.inspectableSystemPrompt(conv)).toBe("");
  conv.active_turn = null;
  expect(await prompts.inspectableSystemPrompt(conv)).toBe(text);
  conv.active_turn = { run_id: "run-2" };
  await prompts.dropTurnSystemPrompt(conv);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(await prompts.clearCapturedSystemPrompt(conv)).toBe(true);
  expect(await prompts.clearCapturedSystemPrompt(conv)).toBe(false);
  writeFileSync(path, text);
  await prompts.dropTurnSystemPrompt(conv, true);
  expect(await prompts.readCapturedSystemPrompt(conv)).toBeNull();
  const errors: Record<string, unknown> = {};
  for (const [key, conv] of [
    ["active_list", { id: "e", active_turn: [1] }],
    ["capture_list", { id: "e", system_prompt_capture: [1] }],
    ["model_int", { id: "e", model: 3 }],
  ] as const)
    errors[key] = await attempt(() => prompts.readPromptValues(conv as Conv));
});

test("capture reads refuse symlinks, non-files, oversize and mismatched bytes", async () => {
  const root = freshRoot();
  const { prompts } = harness(root);
  const conv: Conv = {
    id: "cap",
    active_turn: { run_id: "r" },
    system_prompt_capture: {
      version: 1,
      run_id: "r",
      status: "captured",
      hash: sha("REAL"),
    },
  };
  const path = prompts.capturedSystemPromptPath(conv);
  mkdirSync(join(root, "data", "turn_prompts"), { recursive: true });
  writeFileSync(path, "REAL", { mode: 0o600 });
  expect(await prompts.readCapturedSystemPrompt(conv, true)).toBe("REAL");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "REAL");
  rmSync(path);
  symlinkSync(outside, path);
  expect(await prompts.readCapturedSystemPrompt(conv, true)).toBeNull();
  rmSync(path);
  mkdirSync(path);
  expect(await prompts.readCapturedSystemPrompt(conv, true)).toBeNull();
  rmSync(path, { recursive: true });
  writeFileSync(path, "x".repeat(8 * 1024 * 1024 + 1));
  expect(await prompts.readCapturedSystemPrompt(conv, true)).toBeNull();
  writeFileSync(path, "TAMPERED");
  expect(await prompts.readCapturedSystemPrompt(conv, true)).toBeNull();
  rmSync(path);
  symlinkSync(outside, path);
  expect(await prompts.clearCapturedSystemPrompt(conv)).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("REAL");
});
