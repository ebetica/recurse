import { expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createShells } from "../../src/extensions/core/shells/shells";
import { rtkExtension } from "../../src/extensions/extra/rtk/rtk";
import { stopGroup } from "../extensions/core/shells/fixtures/durable_harness";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { ArtifactCheck, checkPage } from "../../src/artifacts/check";
import { runBrowserTests, type BrowserTest } from "./common";

const BROKEN_APP: Record<string, string> = {
  "index.html":
    '<!doctype html><html><head><script src="https://cdn.example/chart.js"></script></head>' +
    '<body><div id="total"></div><button id="reset">Reset</button>' +
    '<script type="module" src="./app.ts"></script></body></html>',
  "util.ts":
    "export function total(rows: number[] | null): number {\n" +
    "  return rows!.reduce((a, b) => a + b, 0);\n}\n",
  "app.ts":
    'import { total } from "./util";\n' +
    "let rows: number[] | null = [1, 2, 3];\n" +
    'const out = document.getElementById("total")!;\n' +
    "out.textContent = String(total(rows));\n" +
    'document.getElementById("reset")!.onclick = () => {\n' +
    "  rows = null;\n" +
    "  out.textContent = String(total(rows));\n};\n" +
    'console.debug("<script type=foo>");\n',
};

async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "recurse-artifact-check-"));
  const context = {
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
  };
  const item = await artifacts.create(context, {
    owner: "agent-A",
    title: "App",
  });
  const repo = String(item.repo_path);
  for (const [name, text] of Object.entries(files))
    await writeFile(join(repo, name), text);
  return { root, context, repo, id: String(item.id) };
}

async function publishApp(
  context: artifacts.ArtifactContext,
  id: string,
): Promise<artifacts.AppPage> {
  const pages: artifacts.AppPage[] = [];
  await artifacts.publish(context, "agent-A", id, {
    onBuild: (page) => pages.push(page),
  });
  expect(pages).toHaveLength(1);
  return pages[0]!;
}

async function processesWith(needle: string): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    const env = await readFile(`/proc/${name}/environ`, "latin1").catch(
      () => "",
    );
    if (env.includes(needle)) found.set(Number(name), env);
  }
  return found;
}

async function expectBrowserGone(out: string): Promise<void> {
  const needle = `HOME=${out}/.browser-`;
  const deadline = Date.now() + 5_000;
  while ((await processesWith(needle)).size && Date.now() < deadline)
    // test-check-allow: T6 Polls owned /proc browsers until the deadline.
    await Bun.sleep(50);
  expect([...(await processesWith(needle)).keys()]).toEqual([]);
  const left = await readdir(out).catch(() => []);
  expect(left.filter((name) => name.startsWith(".browser-"))).toEqual([]);
}

export const tests: BrowserTest[] = [
  // Regression: #2853 commit output must expose app checks through RTK and codemode.
  async function test_agent_sees_commit_checks_with_rtk_and_codemode() {
    const { root, context: artifactContext, repo, id } = await app(BROKEN_APP);
    const env = {
      ...process.env,
      CHAT_DATA_DIR: join(root, "data"),
      TMPDIR: root,
      RTK_DISABLED: "0",
    } as Record<string, string>;
    const scope = async () => ({ key: "artifact-agent", cwd: repo, env });
    const faux = fauxProvider({ tokensPerSecond: 20_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const shells = createShells({
      scope,
      stateDir: join(root, "shells"),
      stopGroup,
    });
    registry.install(shells.extension);
    registry.install(rtkExtension(scope, true));
    const sandbox = new CodemodeSandbox({
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    registry.install(createCodemodeExtension({ sandbox, models: false }));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      context,
    );
    try {
      const conversation = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const seen: string[] = [];
      const versions: string[] = [];
      for (const [mode, flags] of [
        ["direct", ""],
        ["codemode", ""],
        ["direct", `-C ${JSON.stringify(repo)}`],
        ["codemode", `-c color.ui=false -C ${JSON.stringify(repo)}`],
      ]) {
        const label = `${mode} ${flags || "default"}`;
        await writeFile(
          join(repo, "app.ts"),
          BROKEN_APP["app.ts"] + `\nconsole.debug(${JSON.stringify(label)});\n`,
        );
        const git = flags ? `git ${flags}` : "git";
        const command = `cd ${JSON.stringify(repo)} && ${git} add -A && ${git} commit -m ${JSON.stringify(label)}`;
        const rewrite = await Bun.$`rtk rewrite ${command}`.nothrow().quiet();
        expect([0, 3]).toContain(rewrite.exitCode);
        expect(rewrite.stdout.toString()).toMatch(/\brtk\s+git\b.*\bcommit\b/s);
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              mode === "direct" ? "bash" : "codemode",
              mode === "direct"
                ? { command }
                : {
                    code: `text(await tools.bash(${JSON.stringify({ command })}));`,
                  },
            ),
            { stopReason: "toolUse" },
          ),
          (request) => {
            const message = request.messages.at(-1);
            seen.push(
              message?.role === "toolResult"
                ? message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
                : "",
            );
            return fauxAssistantMessage("Commit inspected.");
          },
        ]);
        const run = await conversation.submit(
          { type: "input", content: `Commit the app through ${mode}.` },
          context,
        );
        expect((await run.wait(context)).status).toBe("done");
        const published = await artifacts.get(artifactContext, "agent-A", id);
        versions.push(String(published.version));
      }
      for (const [index, output] of seen.entries()) {
        expect(output).toContain(versions[index]!);
        expect(output).toMatch(/"command":\s*"publish"/);
        expect(output).toMatch(/"command":\s*"check"/);
        expect(output).toMatch(/"ok":\s*false/);
        const shots = [
          ...output.matchAll(/"(?:wide|narrow)":\s*"([^"\n]+\.png)"/g),
        ];
        expect(shots).toHaveLength(2);
        for (const [, path] of shots)
          expect([
            ...new Uint8Array(await Bun.file(path!).slice(0, 4).arrayBuffer()),
          ]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    } finally {
      await harness.close(context);
      await sandbox.close();
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_maps_errors_to_source_and_takes_screenshots() {
    const { root, context, repo, id } = await app(BROKEN_APP);
    try {
      const built = await publishApp(context, id);
      const out = join(root, "check");
      const report = await checkPage(built.html, built.sourceMap, out);
      expect(await Bun.$`git -C ${repo} status --porcelain`.text()).toBe("");
      expect(report.ok).toBe(false);
      const cdn = report.issues.find((i) => i.message.includes("cdn.example"));
      expect(cdn?.fix).toContain("npm");
      const crash = report.issues.find((i) =>
        i.message.startsWith("TypeError"),
      );
      expect(crash).toMatchObject({
        level: "error",
        source: "util.ts:2:16",
        after: 'clicking button "Reset"',
      });
      expect(report.clicked).toEqual(['button "Reset"']);
      expect(report.layout.wide.blank).toBe(false);
      for (const shot of Object.values(report.screenshots)) {
        const head = new Uint8Array(
          await Bun.file(shot).slice(0, 4).arrayBuffer(),
        );
        expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_flags_a_blank_page_and_refuses_symlinks() {
    const { root, context, repo, id } = await app({
      "index.html":
        '<!doctype html><script type="module">document.body.textContent = "";</script>',
    });
    try {
      const built = await publishApp(context, id);
      const report = await checkPage(
        built.html,
        built.sourceMap,
        join(root, "c"),
      );
      expect(report.ok).toBe(false);
      expect(report.issues[0]?.message).toBe("the page shows nothing");
      await writeFile(join(root, "outside.ts"), "export {};\n");
      await symlink(join(root, "outside.ts"), join(repo, "linked.ts"));
      await expect(
        artifacts.publish(context, "agent-A", id),
      ).rejects.toBeInstanceOf(artifacts.ArtifactInvalid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_browser_sees_no_parent_secrets_and_exits() {
    const { root, context, id } = await app(BROKEN_APP);
    process.env.RECURSE_TEST_SECRET = "sentinel-secret";
    try {
      const built = await publishApp(context, id);
      const out = join(root, "check");
      const needle = `HOME=${out}/.browser-`;
      const seen = new Map<number, string>();
      let running = true;
      const watch = (async () => {
        while (running) {
          for (const [pid, env] of await processesWith(needle))
            seen.set(pid, env);
          await Bun.sleep(20);
        }
      })();
      await checkPage(built.html, built.sourceMap, out);
      running = false;
      await watch;
      expect(seen.size).toBeGreaterThan(0);
      const leaked = [...seen.values()].some((env) =>
        env.includes("sentinel-secret"),
      );
      expect(leaked).toBe(false);
      await expectBrowserGone(out);
    } finally {
      delete process.env.RECURSE_TEST_SECRET;
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_builds_tracked_files_that_now_match_an_ignore_rule() {
    const { root, context, repo, id } = await app(BROKEN_APP);
    try {
      await publishApp(context, id);
      await writeFile(
        join(repo, ".git", "info", "exclude"),
        "node_modules/\napp.ts\n",
      );
      await writeFile(
        join(repo, "app.ts"),
        BROKEN_APP["app.ts"] + '\nconsole.log("updated");\n',
      );
      const built = await publishApp(context, id);
      expect(built.html.toString()).toContain("updated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_deadline_kills_a_hung_page_and_cleans_up() {
    const { root, context, id } = await app({
      "index.html":
        '<!doctype html><p>busy</p><script type="module">while (true) {}</script>',
    });
    try {
      const built = await publishApp(context, id);
      const out = join(root, "check");
      const failure = checkPage(built.html, built.sourceMap, out, {
        deadlineMs: 3_000,
      });
      await expect(failure).rejects.toBeInstanceOf(ArtifactCheck);
      await expectBrowserGone(out);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_check_without_chromium_names_the_install_and_cleans_up() {
    const root = await mkdtemp(join(tmpdir(), "recurse-artifact-check-"));
    try {
      const script = join(root, "run.ts");
      await writeFile(
        script,
        `import { checkPage } from ${JSON.stringify(join(import.meta.dir, "../../src/artifacts/check"))};\n` +
          `await checkPage(Buffer.from("<p>x</p>"), null, ${JSON.stringify(join(root, "check"))})` +
          ".then(() => console.log('ran'), (e) => console.log(e.name, e.message));\n",
      );
      const child = Bun.spawn([process.execPath, script], {
        env: {
          PATH: process.env.PATH ?? "",
          PLAYWRIGHT_BROWSERS_PATH: join(root, "none"),
        },
        stdout: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain("ArtifactCheck");
      expect(output).toContain("playwright install chromium");
      await expectBrowserGone(join(root, "check"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async function test_publish_goes_live_then_reports_the_check() {
    const root = await mkdtemp(join(tmpdir(), "recurse-artifact-check-"));
    const env = {
      ...process.env,
      CHAT_DATA_DIR: join(root, "data"),
      RECURSE_AGENT_ID: "agent-A",
      TMPDIR: root,
    };
    const publish = async (repo: string, extra = {}) => {
      await Bun.$`git -C ${repo} add -A`.quiet();
      const child = Bun.spawn(
        ["git", "-C", repo, "commit", "-qm", "Update app"],
        {
          env: { ...env, ...extra },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let atFirstLine: { running: boolean; live: string } | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (!atFirstLine && text.includes("\n"))
          atFirstLine = {
            running: child.exitCode === null,
            live: (
              await Bun.$`git -C ${repo} rev-parse refs/recurse/published`.text()
            ).trim(),
          };
      }
      return {
        code: await child.exited,
        atFirstLine,
        lines: text
          .trim()
          .split(/\n(?=\{)/)
          .map((record) => JSON.parse(record)),
      };
    };
    try {
      const item = await artifacts.create(
        {
          artifactsDir: join(root, "data", "artifact_repos"),
          trashDir: join(root, "trash"),
        },
        { owner: "agent-A", title: "App" },
      );
      const repo = String(item.repo_path);
      for (const [name, text] of Object.entries(BROKEN_APP))
        await writeFile(join(repo, name), text);
      const run = await publish(repo);
      expect(run.code).toBe(0);
      const [published, check] = run.lines;
      expect([published.command, published.checking]).toEqual([
        "publish",
        true,
      ]);
      expect(run.atFirstLine).toEqual({
        running: true,
        live: published.version,
      });
      expect([check.command, check.version, check.ok]).toEqual([
        "check",
        published.version,
        false,
      ]);
      expect(
        check.issues.find((i: any) => i.message.startsWith("TypeError")),
      ).toMatchObject({
        source: "util.ts:2:16",
        after: 'clicking button "Reset"',
      });
      await expectBrowserGone(join(root, `artifact-check-${item.id}`));
      await writeFile(join(repo, "app.ts"), 'document.body.append("ok");\n');
      const noBrowser = await publish(repo, {
        PLAYWRIGHT_BROWSERS_PATH: join(root, "none"),
      });
      expect(noBrowser.code).toBe(0);
      expect(noBrowser.lines[1].error.code).toBe("check");
      expect(noBrowser.atFirstLine?.live).toBe(noBrowser.lines[0].version);
      expect(noBrowser.lines[0].version).not.toBe(published.version);
      const blocked = join(root, "blocked");
      await Bun.write(join(blocked, `artifact-check-${item.id}`), "a file");
      await writeFile(join(repo, "app.ts"), 'document.body.append("two");\n');
      const unusable = await publish(repo, { TMPDIR: blocked });
      expect(unusable.code).toBe(0);
      expect(unusable.lines[1].error).toEqual({
        code: "check",
        message: "the page could not be checked",
      });
      expect(unusable.atFirstLine?.live).toBe(unusable.lines[0].version);
      await rm(join(repo, "index.html"));
      await writeFile(join(repo, "index.md"), "# Notes\n");
      const document = await publish(repo);
      expect(document.lines.map((line) => line.command)).toEqual(["publish"]);
      expect(document.lines[0].checking).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
];

if (import.meta.main) await runBrowserTests([["artifact-check", tests]]);
