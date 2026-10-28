import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  allowedByPathScope,
  loadTrustedPathScope,
  WORKSPACE_ROOT_ENV,
  WORKTREES_ROOT_ENV,
} from "../../../../src/extensions/core/safety/path-scope.ts";

const base = mkdtempSync("/var/tmp/pi-safety-scope-");
const workspace = join(base, "workspace");
const worktrees = join(base, "managed-worktrees");
const outside = join(base, "outside");

beforeAll(() => {
  mkdirSync(workspace);
  mkdirSync(worktrees);
  mkdirSync(outside);
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "existing.ts"), "old\n");
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const env = { [WORKSPACE_ROOT_ENV]: workspace } as NodeJS.ProcessEnv;
const scoped = (
  tool: string,
  path: unknown,
  cwd = workspace,
  customEnv = env,
) => allowedByPathScope(tool, { path }, cwd, loadTrustedPathScope(customEnv));

describe("file action path scope", () => {
  test("allows existing and nonexistent workspace files for file-scoped tools", () => {
    expect(scoped("write", "src/existing.ts")).toBe(true);
    expect(scoped("edit", "src/new/deep/file.ts")).toBe(true);
  });

  test("allows /tmp and the runner-owned per-agent scratch directory", () => {
    const scratch = mkdtempSync(join(base, "agent-scratch-"));
    try {
      const withScratch = {
        ...env,
        RECURSE_AGENT_TMPDIR: scratch,
      } as NodeJS.ProcessEnv;
      expect(scoped("write", "/tmp/new-file", workspace, withScratch)).toBe(
        true,
      );
      expect(
        scoped("edit", join(scratch, "new-file"), workspace, withScratch),
      ).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("uses fixed source roots rather than widening scope with cwd", () => {
    const fixed = {
      [WORKSPACE_ROOT_ENV]: workspace,
      [WORKTREES_ROOT_ENV]: worktrees,
    } as NodeJS.ProcessEnv;
    expect(scoped("write", "checkout/new.ts", worktrees, fixed)).toBe(true);
    expect(scoped("write", ".markers/checkout.json", worktrees, fixed)).toBe(
      false,
    );
    expect(
      scoped("write", ".managed/checkout/HOLDERS/agent.json", worktrees, fixed),
    ).toBe(false);
    expect(
      scoped("write", "TO_REAP/staged/checkout/file.ts", worktrees, fixed),
    ).toBe(false);
    expect(scoped("write", "new.ts", outside, fixed)).toBe(false);
  });

  test("protects worktree metadata when the roots are nested", () => {
    const state = join(workspace, "nested-state");
    const nestedWorktrees = join(state, "worktrees");
    mkdirSync(join(nestedWorktrees, ".markers"), { recursive: true });
    mkdirSync(join(nestedWorktrees, "checkout"));
    const fixed = {
      [WORKSPACE_ROOT_ENV]: workspace,
      [WORKTREES_ROOT_ENV]: nestedWorktrees,
      CHAT_DATA_DIR: state,
    } as NodeJS.ProcessEnv;
    expect(
      scoped(
        "write",
        "nested-state/worktrees/checkout/new.ts",
        workspace,
        fixed,
      ),
    ).toBe(true);
    expect(
      scoped(
        "write",
        "nested-state/worktrees/.markers/checkout.json",
        workspace,
        fixed,
      ),
    ).toBe(false);
  });

  test("reviews outside and sibling-prefix paths", () => {
    expect(scoped("write", join(outside, "file"))).toBe(false);
    expect(scoped("write", `${workspace}-evil/file`)).toBe(false);
    expect(scoped("write", "/tmpfoo/file")).toBe(false);
  });

  test("reviews traversal and symlink escapes", () => {
    const escape = join(workspace, "escape");
    symlinkSync(outside, escape);
    expect(scoped("write", "src/../../outside/file")).toBe(false);
    expect(scoped("write", "escape/file")).toBe(false);

    mkdirSync(join(outside, "bridge"));
    symlinkSync(join(workspace, "src"), join(outside, "bridge", "return"));
    symlinkSync(join(outside, "bridge"), join(workspace, "out-and-back"));
    expect(scoped("edit", "out-and-back/return/existing.ts")).toBe(false);
    symlinkSync(join(workspace, "src"), join(outside, "back-inside"));
    symlinkSync(join(outside, "back-inside"), join(workspace, "double-link"));
    expect(scoped("edit", "double-link/existing.ts")).toBe(false);

    mkdirSync(join(workspace, "a"));
    mkdirSync(join(workspace, "x", "y"), { recursive: true });
    symlinkSync(
      "../../outside/back-inside",
      join(workspace, "a", "relative-link"),
    );
    symlinkSync(
      join(workspace, "a"),
      join(workspace, "x", "y", "parent-alias"),
    );
    expect(scoped("edit", "x/y/parent-alias/relative-link/existing.ts")).toBe(
      false,
    );

    mkdirSync(join(outside, "deep"));
    symlinkSync(join(outside, "deep"), join(workspace, "a", "hop"));
    symlinkSync(join(workspace, "src"), join(outside, "back-dotdot"));
    symlinkSync("hop/../back-dotdot", join(workspace, "a", "dotdot-link"));
    expect(scoped("edit", "a/dotdot-link/existing.ts")).toBe(false);

    const data = join(workspace, ".recurse-data-1", "conversations");
    mkdirSync(data, { recursive: true });
    const stateEscape = join(
      workspace,
      ".recurse-data-1",
      "worktrees",
      "agent",
      "state-link",
    );
    mkdirSync(join(workspace, ".recurse-data-1", "worktrees", "agent"), {
      recursive: true,
    });
    symlinkSync(data, stateEscape);
    expect(scoped("edit", join(stateEscape, "conversation.json"))).toBe(false);
  });

  test("reviews a dangling symlink rather than treating it as a new file", () => {
    symlinkSync(join(outside, "missing"), join(workspace, "dangling"));
    expect(scoped("write", "dangling")).toBe(false);
    expect(scoped("write", "dangling/child")).toBe(false);
  });

  test("allows exact managed checkout subtrees but reviews other Recurse state", () => {
    expect(scoped("edit", ".recurse-data-1/worktrees/agent/src/file.ts")).toBe(
      true,
    );
    expect(scoped("write", ".recurse-data-1/repo/src/file.ts")).toBe(true);
    expect(scoped("edit", ".recurse-data-1/conversations/agent.json")).toBe(
      false,
    );
    expect(scoped("write", ".recurse-data-1/agent_attachments/blob")).toBe(
      false,
    );
    expect(scoped("write", ".recurse-data-1/repo-evil/file")).toBe(false);
  });

  test("protects an exact custom Recurse data root, including under /tmp", () => {
    const customState = join(workspace, "state");
    mkdirSync(join(customState, "conversations"), { recursive: true });
    mkdirSync(join(customState, "repo", "src"), { recursive: true });
    mkdirSync(join(customState, "worktrees", "agent", "src"), {
      recursive: true,
    });
    const customEnv = {
      ...env,
      CHAT_DATA_DIR: customState,
    } as NodeJS.ProcessEnv;
    expect(
      scoped("edit", "state/conversations/agent.json", workspace, customEnv),
    ).toBe(false);
    expect(
      scoped("write", "state/attachments/blob", workspace, customEnv),
    ).toBe(false);
    expect(
      scoped("write", "state/repo/src/file.ts", workspace, customEnv),
    ).toBe(true);
    expect(
      scoped("edit", "state/worktrees/agent/src/file.ts", workspace, customEnv),
    ).toBe(true);
    expect(scoped("write", "state-evil/file", workspace, customEnv)).toBe(true);

    const tmpState = mkdtempSync("/tmp/pi-safety-state-");
    try {
      mkdirSync(join(tmpState, "conversations"));
      mkdirSync(join(tmpState, "worktrees", "agent"), { recursive: true });
      const tmpEnv = { ...env, CHAT_DATA_DIR: tmpState } as NodeJS.ProcessEnv;
      expect(
        scoped(
          "edit",
          join(tmpState, "conversations", "agent.json"),
          workspace,
          tmpEnv,
        ),
      ).toBe(false);
      expect(
        scoped(
          "edit",
          join(tmpState, "worktrees", "agent", "file.ts"),
          workspace,
          tmpEnv,
        ),
      ).toBe(true);
    } finally {
      rmSync(tmpState, { recursive: true, force: true });
    }
  });

  test("reviews git internals and credential dotfiles everywhere", () => {
    for (const path of [
      ".git/config",
      "src/.env",
      "src/.env.local",
      "src/.envrc",
      "src/.netrc",
      ".recurse-data-1/worktrees/agent/.git/config",
      ".recurse-data-1/worktrees/agent/src/.env.production",
    ])
      expect(scoped("edit", path)).toBe(false);
  });

  test("fails closed without a valid runner-provided workspace root", () => {
    expect(scoped("write", "src/existing.ts", workspace, {})).toBe(false);
    expect(scoped("write", "/tmp/file", workspace, {})).toBe(false);
    expect(
      scoped("write", "/tmp/file", workspace, {
        [WORKSPACE_ROOT_ENV]: join(base, "missing"),
      }),
    ).toBe(false);
    expect(
      scoped("write", "src/existing.ts", workspace, {
        ...env,
        CHAT_DATA_DIR: join(base, "missing-state"),
      }),
    ).toBe(false);
  });

  test("never bypasses bash or unknown/non-static tool inputs", () => {
    expect(scoped("bash", "src/existing.ts")).toBe(false);
    const scope = loadTrustedPathScope(env);
    expect(allowedByPathScope("write", { path: 123 }, workspace, scope)).toBe(
      false,
    );
    expect(allowedByPathScope("write", {}, workspace, scope)).toBe(false);
  });
});
