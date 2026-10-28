import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RegistryStore } from "../../../../src/extensions/core/shells/persist.ts";
import {
  type Notifier,
  ShellRegistry,
  type ShellConfig,
} from "../../../../src/extensions/core/shells/registry.ts";

interface Captured {
  text: string;
  triggerTurn: boolean;
}

class FakeNotifier implements Notifier {
  messages: Captured[] = [];
  errors: string[] = [];
  send(text: string, opts: { triggerTurn: boolean }) {
    this.messages.push({ text, triggerTurn: opts.triggerTurn });
  }
  error(message: string) {
    this.errors.push(message);
  }
  find(re: RegExp) {
    return this.messages.find((m) => re.test(m.text));
  }
}

const dirs: string[] = [];
const isolatedForbiddenEnv = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CHAT_AUTH_HASH",
  "CHAT_AUTH_SALT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_WORKSPACE_CLI_TOKEN",
  "OPENAI_API_KEY",
  "PI_AUTH_JSON",
  "RECURSE_SERVICE_PRINCIPALS_FILE",
  "RECURSE_SERVICE_TOKEN_FILE",
] as const;

function testConfig(
  overrides: Partial<ShellConfig> = {},
): Partial<ShellConfig> {
  const logDir = mkdtempSync(join(tmpdir(), "pi-bg-shell-test-"));
  dirs.push(logDir);
  return {
    logDir,
    foregroundWaitMs: 200,
    scheduleSeconds: [0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 5],
    monitorFlushMs: 30,
    monitorMaxLinesPerFlush: 10,
    monitorMaxChunkBytes: 64 * 1024,
    maxLiveShells: 200,
    killGraceMs: 120,
    ...overrides,
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(15);
  }
}
async function cleanupRegistry(
  registry: ShellRegistry,
  shell: ReturnType<ShellRegistry["run"]>,
): Promise<void> {
  await registry.shutdown();
  if (shell.pid !== undefined) await waitFor(() => !pidAlive(shell.pid!), 4000);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("managed shells scrub runner-only descriptor environments", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-shell-isolated-"));
  dirs.push(root);
  const repo = process.cwd();
  const paths: Record<string, string> = {
    CHAT_DATA_DIR: "data",
    RECURSE_ISOLATED_DATA_DIR: "data",
    RECURSE_TEMP_ROOT: "tmp",
    PI_BG_SHELL_STATE_DIR: "bg",
    RECURSE_HOME: "state",
    PI_CODING_AGENT_DIR: "state/pi-agent",
    CLAUDE_CONFIG_DIR: "claude",
    CHAT_REPO_URL: "target",
    RECURSE_BIN_DIR: "bin",
    HOME: "home",
    XDG_CONFIG_HOME: "xdg",
    TMPDIR: "runtime",
    TMP: "runtime",
    TEMP: "runtime",
    RECURSE_AGENT_TMPDIR: "agent",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, relative] of Object.entries(paths)) {
    const path = join(root, relative);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    previous.set(name, process.env[name]);
    process.env[name] = path;
  }
  for (const name of [
    "RECURSE_ISOLATED_ROOT",
    "RECURSE_TOOL_CAPTURE_FD",
    "RECURSE_TOOL_CAPTURE_KEY_FD",
    "RECURSE_GLOBAL_AGENTS_FD",
    ...isolatedForbiddenEnv,
  ]) {
    previous.set(name, process.env[name]);
  }
  process.env.RECURSE_ISOLATED_ROOT = root;
  process.env.RECURSE_TOOL_CAPTURE_FD = "91";
  process.env.RECURSE_TOOL_CAPTURE_KEY_FD = "92";
  process.env.RECURSE_GLOBAL_AGENTS_FD = "93";
  for (const name of isolatedForbiddenEnv) delete process.env[name];
  const agentTempDir = process.env.RECURSE_AGENT_TMPDIR!;
  const environmentFile = join(agentTempDir, "env.sh");
  writeFileSync(environmentFile, "export RECURSE_TEST_OVERRIDE='applied'\n", {
    mode: 0o600,
  });
  try {
    const reg = new ShellRegistry(
      new FakeNotifier(),
      testConfig({
        agentTempDir,
        environmentFile,
      }),
      undefined,
      { environment: () => process.env as Record<string, string> },
    );
    const command = [
      `bun -e 'console.log(1)'`,
      `bun ${JSON.stringify(join(repo, "tools/worktree.ts"))} --help >/dev/null`,
      `bun ${JSON.stringify(join(repo, "tools/subagent.ts"))} create --title smoke --help >/dev/null`,
      `test -z "${"$"}{RECURSE_TOOL_CAPTURE_FD:-}"`,
      `test "${"$"}{RECURSE_TEST_OVERRIDE:-}" = applied`,
    ].join(" && ");
    const shell = reg.run(command, "foreground", process.cwd());
    assert.equal(await reg.waitForExit(shell, 5000), "exited");
    assert.equal(shell.exitCode, 0, reg.trimmedOutput(shell));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a missing agent environment file is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-shell-env-"));
  dirs.push(root);
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({
      agentTempDir: root,
      environmentFile: join(root, "env.sh"),
    }),
  );
  const shell = reg.run("printf unchanged", "foreground", process.cwd());
  assert.equal(await reg.waitForExit(shell, 5000), "exited");
  assert.equal(shell.exitCode, 0);
  assert.equal(reg.trimmedOutput(shell), "unchanged");
});

test("a shell names the bash call that runs it, and only that call", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ foregroundWaitMs: 60_000 }),
    undefined,
    {
      environment: () => ({ RECURSE_TOOL_CALL_ID: "stale-call" }),
    },
  );
  const previous = process.env.RECURSE_TOOL_CALL_ID;
  process.env.RECURSE_TOOL_CALL_ID = "stale-call";
  try {
    const print = 'printf "%s" "${RECURSE_TOOL_CALL_ID-unset}"';
    const named = reg.run(
      print,
      "foreground",
      process.cwd(),
      undefined,
      undefined,
      "toolu_01Abc",
    );
    const unnamed = reg.run(print, "foreground", process.cwd());
    for (const shell of [named, unnamed])
      assert.equal(
        await reg.waitForExit(shell, reg.cfg.foregroundWaitMs),
        "exited",
      );
    assert.equal(reg.trimmedOutput(named), "toolu_01Abc");
    assert.equal(reg.trimmedOutput(unnamed), "unset");
  } finally {
    if (previous === undefined) delete process.env.RECURSE_TOOL_CALL_ID;
    else process.env.RECURSE_TOOL_CALL_ID = previous;
  }
});

test("foreground execution: trimmed output, merged streams, exit codes, nothing pushed", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ foregroundWaitMs: 60_000 }));
  const ok = reg.run("echo hello world", "foreground", process.cwd());
  assert.equal(await reg.waitForExit(ok, reg.cfg.foregroundWaitMs), "exited");
  assert.equal(ok.exitCode, 0);
  assert.match(reg.trimmedOutput(ok), /hello world/);
  assert.equal(n.messages.length, 0);
  const merged = reg.run(
    "echo out; echo err 1>&2",
    "foreground",
    process.cwd(),
  );
  await waitFor(() => merged.completed);
  const out = readFileSync(merged.logPath, "utf8");
  assert.match(out, /out/);
  assert.match(out, /err/);
  const failed = reg.run("exit 3", "foreground", process.cwd());
  await waitFor(() => failed.completed);
  assert.equal(failed.exitCode, 3);
});

test("commands run as a non-login shell: startup files are not sourced", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-bg-shell-home-"));
  dirs.push(home);
  const marker = join(home, "sourced");
  writeFileSync(join(home, ".bash_profile"), `echo login >> ${marker}\n`);
  writeFileSync(join(home, ".bashrc"), `echo interactive >> ${marker}\n`);

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const n = new FakeNotifier();
    const reg = new ShellRegistry(n, testConfig(), undefined, {
      environment: () => ({ HOME: home }),
    });
    const shell = reg.run("echo hi", "foreground", process.cwd());
    await waitFor(() => shell.completed);
    assert.equal(shell.exitCode, 0);
  } finally {
    process.env.HOME = prevHome;
  }
  assert.throws(() => readFileSync(marker));
});

test("slow command is backgrounded, then reports completion", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ foregroundWaitMs: 150 }));
  const shell = reg.run(
    "sleep 0.5; echo finished",
    "foreground",
    process.cwd(),
  );
  const res = await reg.waitForExit(shell, reg.cfg.foregroundWaitMs);
  assert.equal(res, "timeout");
  reg.backgroundify(shell);
  await waitFor(() => n.messages.some((m) => /exited 0/.test(m.text)));
  const done = n.find(/exited 0/)!;
  assert.equal(done.triggerTurn, true);
  assert.match(done.text, /finished/);
});

// Regression: #1359 launch notice echoed its own shell
test("background reminder excludes the shell its own notice just announced", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ foregroundWaitMs: 80 }),
  );
  const first = reg.run("sleep 0.5", "background", process.cwd());
  assert.equal(
    reg.backgroundShellReminder(first.id),
    undefined,
    "a launch notice never echoes the shell it announces",
  );
  const second = reg.run("sleep 0.5", "background", process.cwd());
  const reminder = reg.backgroundShellReminder(second.id) ?? "";
  assert.match(
    reminder,
    new RegExp(first.id),
    "other live shells are still listed",
  );
  assert.ok(
    !reminder.includes(second.id),
    "the announced shell is not repeated",
  );
  await reg.shutdown();
});

test("background reminder only includes live backgrounded shells", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ foregroundWaitMs: 60_000 }),
  );
  const foreground = reg.run("echo quick", "foreground", process.cwd());
  assert.equal(
    await reg.waitForExit(foreground, reg.cfg.foregroundWaitMs),
    "exited",
  );
  assert.equal(reg.backgroundShellReminder(), undefined);
  const background = reg.run("sleep 0.4", "background", process.cwd());
  assert.match(reg.backgroundShellReminder() ?? "", new RegExp(background.id));
  await cleanupRegistry(reg, background);
  await waitFor(() => reg.backgroundShellReminder() === undefined);
});

test("live shell tracking is capped separately from retained history", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ maxTrackedShells: 1, maxLiveShells: 2 }),
  );
  const first = reg.run("sleep 1", "background", process.cwd());
  const second = reg.run("sleep 1", "background", process.cwd());
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  const third = reg.run("echo no-slot", "background", process.cwd());
  assert.equal(third.status, "error");
  assert.equal(third.launchError, "live-cap");
  assert.match(reg.backgroundShellReminder() ?? "", new RegExp(first.id));
  await reg.shutdown();
});

test("live-cap rejection spawns no process and writes no ownership record", async () => {
  const state = mkdtempSync(join(tmpdir(), "pi-bg-shell-cap-state-"));
  dirs.push(state);
  const store = new RegistryStore(state, "cap-rejection");
  const marker = join(state, "must-not-run");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ maxLiveShells: 1 }),
    store,
  );
  const first = reg.run("sleep 30", "background", process.cwd());
  await waitFor(() => first.pid !== undefined);
  const rejected = reg.run(`touch ${marker}`, "background", process.cwd());
  assert.equal(rejected.status, "error");
  assert.equal(rejected.launchError, "live-cap");
  assert.equal(rejected.child, undefined);
  assert.equal(reg.get(rejected.id), undefined);
  assert.equal(store.readRecord(rejected.id), undefined);
  assert.equal(reg.list().length, 1);
  assert.throws(() => readFileSync(marker));
  await reg.shutdown();
});

test("an exiting background slot admits the next launch", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ maxLiveShells: 1 }),
  );
  const first = reg.run("sleep 0.1", "background", process.cwd());
  await waitFor(() => first.completed);
  const next = reg.run("sleep 1", "background", process.cwd());
  assert.equal(next.status, "running");
  await reg.shutdown();
});

test("foreground overflow is killed and removed without a stale record", async () => {
  const state = mkdtempSync(join(tmpdir(), "pi-bg-shell-cap-state-"));
  dirs.push(state);
  const store = new RegistryStore(state, "foreground-overflow");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({
      foregroundWaitMs: 200,
      maxLiveShells: 1,
    }),
    store,
  );
  const first = reg.run("sleep 30", "background", process.cwd());
  await waitFor(() => first.pid !== undefined);
  const foreground = reg.run(
    "printf overflow; sleep 30",
    "foreground",
    process.cwd(),
  );
  assert.equal(
    await reg.waitForExit(foreground, reg.cfg.foregroundWaitMs),
    "timeout",
  );
  assert.equal(reg.canBackgroundify(foreground), false);
  assert.match(reg.trimmedOutput(foreground), /overflow/);
  assert.equal(await reg.discardUnowned(foreground), true);
  assert.equal(reg.get(foreground.id), undefined);
  assert.equal(store.readRecord(foreground.id), undefined);
  assert.ok(foreground.pid !== undefined && !pidAlive(foreground.pid));
  await reg.shutdown();
});

test("foreground handoff reminder lists prior shells in stable order", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ foregroundWaitMs: 60 }),
  );
  try {
    const first = reg.run(
      "while :; do sleep 30; done",
      "background",
      process.cwd(),
    );
    await waitFor(() => first.pid !== undefined);
    const second = reg.run(
      "while :; do sleep 30; done",
      "foreground",
      process.cwd(),
    );
    await waitFor(() => second.pid !== undefined);
    assert.equal(
      await reg.waitForExit(second, reg.cfg.foregroundWaitMs),
      "timeout",
    );
    reg.backgroundify(second);
    second.startedAt = first.startedAt;
    const reminder = reg.backgroundShellReminder() ?? "";
    assert.ok(reminder.includes(first.id));
    assert.ok(reminder.includes(second.id));
    assert.ok(reminder.indexOf(first.id) < reminder.indexOf(second.id));
  } finally {
    await reg.shutdown();
  }
});

test("background mode returns immediately and later completes", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig());
  const shell = reg.run("sleep 0.2; echo bg-done", "background", process.cwd());
  assert.equal(shell.status, "running");
  await waitFor(() =>
    n.messages.some((m) => /bg-done/.test(m.text) && /exited 0/.test(m.text)),
  );
});

test("huge output is trimmed in the completion message", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(
    n,
    testConfig({ foregroundWaitMs: 50, byteBudget: 512 }),
  );
  reg.run(
    "for i in $(seq 1 20000); do echo line-$i; done",
    "background",
    process.cwd(),
  );
  await waitFor(() => n.messages.some((m) => /exited 0/.test(m.text)));
  const done = n.find(/exited 0/)!;
  assert.match(done.text, /lines \+ \d+ bytes truncated/);
  assert.match(done.text, /Read offset=\d+ limit=\d+ to continue/);
  assert.ok(Buffer.byteLength(done.text, "utf8") < 2000);
});

test("run() stores the per-shell line limit and completions honor it", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig());
  const shell = reg.run(
    "for i in $(seq 1 20); do echo line-$i; done",
    "background",
    process.cwd(),
    undefined,
    5,
  );
  assert.equal(shell.lineLimit, 5);
  assert.equal(
    reg.run("echo hi", "background", process.cwd(), undefined, 5000).lineLimit,
    2000,
    "the stored limit keeps PR2's 1..2000 clamp",
  );
  assert.equal(
    reg.run("echo hi", "background", process.cwd()).lineLimit,
    reg.cfg.lineLimit,
    "an unset limit falls back to the configured default",
  );
  await waitFor(() =>
    n.messages.some((m) => /exited 0/.test(m.text) && /line-1/.test(m.text)),
  );
  const done = n.messages.find(
    (m) => /exited 0/.test(m.text) && /line-1/.test(m.text),
  )!;
  assert.match(done.text, /16 lines \+ \d+ bytes truncated/);
  assert.match(done.text, /Read offset=4 limit=16 to continue/);
  assert.match(reg.trimmedOutput(shell), /16 lines \+/);
  assert.match(reg.trimmedOutput(shell, 20), /line-10/);
});

test("completion message middle-elides a huge command, keeps log and output", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig());
  const filler = "x".repeat(900);
  const command = `echo head-marker; true ${filler}; echo tail-marker`;
  reg.run(command, "background", process.cwd());
  await waitFor(() => n.messages.some((m) => /exited 0/.test(m.text)));
  const done = n.find(/exited 0/)!;
  const embedded = done.text.match(/^Shell `[\s\S]*?` \((.*)\) exited /s);
  assert.ok(embedded, done.text);
  assert.ok(embedded[1].includes("…"), embedded[1]);
  assert.ok(embedded[1].length <= 300, String(embedded[1].length));
  assert.ok(embedded[1].startsWith("echo head-marker; true "), embedded[1]);
  assert.ok(embedded[1].endsWith(" echo tail-marker"), embedded[1]);
  assert.ok(!done.text.includes("x".repeat(400)));
  assert.match(done.text, /\nLog: \S+\n/);
  assert.match(done.text, /\ntail-marker\n?$/);
  await reg.shutdown();
});

function completionsFor(n: FakeNotifier, id: string): Captured[] {
  const re = new RegExp(`\`${id}\`.*(exited|killed by)`, "s");
  return n.messages.filter((m) => re.test(m.text));
}

test("EXTERNAL kill of the whole group: one completion, reports the signal, timers cleared", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ scheduleSeconds: [0.03, 5] }));
  const pidFile = join(dirs[dirs.length - 1], "child.pid");
  const shell = reg.run(
    `sleep 30 & echo $! > ${pidFile}; wait`,
    "background",
    process.cwd(),
  );
  await waitFor(() => {
    try {
      return readFileSync(pidFile, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  });
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pidAlive(childPid), "child alive before kill");

  process.kill(-shell.pgid!, "SIGKILL");

  await waitFor(() => shell.completed);
  const comps = completionsFor(n, shell.id);
  assert.equal(comps.length, 1, "exactly one completion notification");
  assert.match(
    comps[0].text,
    /killed by SIGKILL/,
    "reports the killing signal",
  );
  assert.equal(comps[0].triggerTurn, true);
  assert.equal(shell.status, "killed");
  assert.equal(shell.monitorTimer, undefined, "monitor timer cleared");
  await waitFor(() => !pidAlive(childPid));
  assert.ok(!pidAlive(childPid), "group child dead");
  assert.ok(!pidAlive(shell.pid!), "leader dead");
});

test("EXTERNAL kill of only the LEADER: still exactly one completion", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ scheduleSeconds: [0.03, 5] }));
  const shell = reg.run("sleep 3", "background", process.cwd());
  await waitFor(() => shell.pid !== undefined);
  process.kill(shell.pid!, "SIGKILL");
  await waitFor(() => shell.completed);
  const comps = completionsFor(n, shell.id);
  assert.equal(
    comps.length,
    1,
    "exactly one completion even for leader-only kill",
  );
  assert.match(comps[0].text, /killed by SIGKILL/);
});

// Regression: #2803 Group disappearance resolves shutdown without the TERM deadline.
test("shutdown resolves once TERM-exiting process groups are gone", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ killGraceMs: 60_000 }));
  const a = reg.run("exec sleep 30", "background", process.cwd());
  const b = reg.run("exec sleep 30", "background", process.cwd());
  await waitFor(() => a.pid !== undefined && b.pid !== undefined);
  await reg.shutdown();
  for (const shell of [a, b])
    assert.throws(() => process.kill(-shell.pgid!, 0), { code: "ESRCH" });
});

test("shutdown is idempotent and closes spawning before its first await", async () => {
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ killGraceMs: 30 }),
  );
  const shell = reg.run("trap '' TERM; sleep 30", "background", process.cwd());
  await waitFor(() => shell.pid !== undefined);
  const first = reg.shutdown();
  assert.equal(reg.shutdown(), first);
  assert.equal(
    reg.run("echo too-late", "background", process.cwd()).status,
    "error",
  );
  await first;
});

test("shutdown escalates a SIGTERM-resistant group before resolving", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ killGraceMs: 30 }));
  const shell = reg.run(
    "trap '' TERM; echo trap-ready; while true; do sleep 1; done",
    "background",
    process.cwd(),
  );
  await waitFor(() => shell.pid !== undefined);
  await waitFor(() =>
    readFileSync(shell.logPath, "utf8").includes("trap-ready"),
  );
  await reg.shutdown();
  await waitFor(() => !pidAlive(shell.pid!));
  assert.ok(
    !pidAlive(shell.pid!),
    "shutdown promise includes SIGKILL escalation",
  );
});

test("leader exit remains active until detached group descendants finish", async () => {
  const n = new FakeNotifier();
  const cfg = testConfig({ killGraceMs: 30 });
  const childFile = join(cfg.logDir!, "early-leader-child.pid");
  const reg = new ShellRegistry(n, cfg);
  const shell = reg.run(
    `sleep 30 & echo $! > ${childFile}; exit 0`,
    "background",
    process.cwd(),
  );
  await waitFor(() => {
    try {
      return readFileSync(childFile, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  });
  const childPid = Number(readFileSync(childFile, "utf8").trim());
  try {
    await waitFor(() => !!shell.child && shell.child.exitCode !== null);
    assert.equal(shell.status, "running");
    assert.equal(
      shell.completed,
      false,
      "leader exit alone is not group completion",
    );
  } finally {
    await cleanupRegistry(reg, shell);
  }
  await waitFor(() => !pidAlive(childPid));
  assert.ok(!pidAlive(childPid));
});

test("shutdown escalates to SIGKILL for TERM-resistant descendants", async () => {
  const n = new FakeNotifier();
  const config = testConfig({ killGraceMs: 30 });
  const childFile = join(config.logDir!, "shutdown-resistant-child.pid");
  const reg = new ShellRegistry(n, config);
  const shell = reg.run(
    `(trap '' TERM INT; echo trap-ready; while true; do sleep 1; done) & echo $! > ${childFile}; trap 'exit 0' TERM; wait`,
    "background",
    process.cwd(),
  );
  await waitFor(() => {
    try {
      return readFileSync(childFile, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  });
  const childPid = Number(readFileSync(childFile, "utf8").trim());
  await waitFor(() =>
    readFileSync(shell.logPath, "utf8").includes("trap-ready"),
  );
  await reg.shutdown();
  await waitFor(() => !pidAlive(childPid));
  assert.ok(!pidAlive(shell.pid!), "session end kills the group leader");
  assert.ok(
    !pidAlive(childPid),
    "SIGKILL still reached the TERM-resistant descendant",
  );
});

test("monitor mode streams new lines and stays bounded under a flood", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(
    n,
    testConfig({ monitorFlushMs: 25, monitorMaxLinesPerFlush: 5 }),
  );

  const shell = reg.run(
    "for i in $(seq 1 30000); do echo floodline; done; sleep 30",
    "monitor",
    process.cwd(),
  );
  try {
    await waitFor(() => n.messages.some((m) => /floodline/.test(m.text)));
    for (const m of n.messages) {
      const bodyLines = m.text
        .split("\n")
        .filter((l) => l === "floodline").length;
      assert.ok(bodyLines <= 5, "monitor batch respects the per-flush cap");
    }
    assert.ok(
      n.messages.some((m) => /floodline/.test(m.text)),
      "some output was streamed",
    );
  } finally {
    await cleanupRegistry(reg, shell);
  }
});

test("fallback no-session storage never authorizes detached handoff", async () => {
  const stateBase = mkdtempSync(join(tmpdir(), "pi-bg-shell-state-"));
  dirs.push(stateBase);
  const store = new RegistryStore(stateBase, undefined);
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ killGraceMs: 30 }),
    store,
  );
  const shell = reg.run("sleep 30", "background", process.cwd());
  try {
    await waitFor(() => shell.pid !== undefined && pidAlive(shell.pid));
    assert.equal(reg.hasDurableOwnership(shell), false);
    assert.equal(await reg.discardUnowned(shell), true);
    assert.ok(!pidAlive(shell.pid!));
  } finally {
    await cleanupRegistry(reg, shell);
  }
});

test("a detached launch is stopped when exact ownership cannot be persisted", async () => {
  const stateBase = mkdtempSync(join(tmpdir(), "pi-bg-shell-state-"));
  dirs.push(stateBase);
  writeFileSync(join(stateBase, "blocked-session"), "not a directory");
  const store = new RegistryStore(stateBase, "blocked-session");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    testConfig({ killGraceMs: 30 }),
    store,
  );
  const shell = reg.run("trap '' TERM; sleep 30", "monitor", process.cwd());
  try {
    await waitFor(() => shell.pid !== undefined && pidAlive(shell.pid));
    assert.equal(reg.hasDurableOwnership(shell), false);
    await reg.discardUnowned(shell);
    await waitFor(() => !pidAlive(shell.pid!));
    assert.ok(!pidAlive(shell.pid!));
  } finally {
    await cleanupRegistry(reg, shell);
  }
});

test("monitor bounds the partial-line buffer under a no-newline flood", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(
    n,
    testConfig({ monitorFlushMs: 25, maxLineLen: 200 }),
  );
  const shell = reg.run(
    "head -c 500000 /dev/zero | tr '\\0' x; sleep 30",
    "monitor",
    process.cwd(),
  );
  try {
    await waitFor(() => shell.monitorPos >= 500000);
    assert.ok(
      shell.monitorPending.length <= Math.max(4096, 200 * 4),
      "pending buffer stays bounded",
    );
  } finally {
    await cleanupRegistry(reg, shell);
  }
});

test("monitor delivers a completion message when the process exits", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ monitorFlushMs: 20 }));
  const shell = reg.run(
    "printf 'a\\nb\\nc\\n'; sleep 0.1",
    "monitor",
    process.cwd(),
  );
  await waitFor(() => n.messages.some((m) => /exited 0/.test(m.text)));
  assert.ok(shell.completed);
  assert.ok(n.find(/\[monitor /), "streamed at least one monitor batch");
});

test("registry stays bounded: oldest completed shells are evicted", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig({ maxTrackedShells: 5 }));
  for (let i = 0; i < 20; i++) {
    const s = reg.run(`echo run-${i}`, "background", process.cwd());
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => s.completed);
  }
  assert.ok(reg.list().length <= 5, `map bounded (got ${reg.list().length})`);
});

test("a completed shell holds no active timers (does not keep the loop alive)", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(n, testConfig());
  const shell = reg.run("echo quick", "background", process.cwd());
  await waitFor(() => shell.completed);
  assert.equal(shell.monitorTimer, undefined);
});

test("callback failures are contained (notifier throw never escapes)", async () => {
  const throwing: Notifier = {
    send() {
      throw new Error("boom");
    },
  };
  const reg = new ShellRegistry(throwing, testConfig());
  const shell = reg.run("echo x", "background", process.cwd());
  await waitFor(() => shell.completed);
  assert.ok(shell.completed);
});

test("spawn failure is handled without throwing", async () => {
  const n = new FakeNotifier();
  const reg = new ShellRegistry(
    n,
    testConfig({ shell: "/nonexistent/shell/binary" }),
  );
  const shell = reg.run("echo hi", "foreground", process.cwd());
  const res = await reg.waitForExit(shell, 500);
  await waitFor(() => shell.status === "error");
  assert.equal(shell.status, "error");
  void res;
});
