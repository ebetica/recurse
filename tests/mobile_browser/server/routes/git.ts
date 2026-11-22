import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Fixture, type Routes, type Json } from "../fixture";

export function routes(fx: Fixture): Routes {
  const { instance, load, save, rootAgentId, once } = fx;
  const { conversations } = instance;
  const { create, sayDurable } = fx.agents;
  const { user, seedHistory } = fx.history;
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=f@x.invalid",
        ...args,
      ],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    return out.trim();
  }

  return {
    "seed-pr-references": async () => {
      const root = await mkdtemp(
        join(instance.config.paths.DATA_DIR, "pr-references-"),
      );
      const cwd = join(root, "checkout");
      const plain = join(root, "plain");
      const bin = join(root, "bin");
      await Promise.all([cwd, plain, bin].map((dir) => mkdir(dir)));
      await git(cwd, "init");
      await git(
        cwd,
        "remote",
        "add",
        "origin",
        "https://github.com/Owner/Repo",
      );
      for (const cid of ["pr-checkout", "pr-plain"]) {
        await create(cid, cid, rootAgentId());
        const conv = load(cid)!;
        conv.workdir = cid === "pr-checkout" ? cwd : plain;
        await save(conv);
        await seedHistory(
          cid,
          [
            user("Show PR references"),
            fauxAssistantMessage(
              `Review #42 from ${cid}. \`#42\`\n\n\`\`\`\n#42\n\`\`\`\n\n[#42](https://example.com)\n\n\`<span title="</code>">#42</span>\``,
            ),
          ],
          { replace: true },
        );
        await writeFile(
          instance.agentTemp.workdirFile(String(conv.tmp_key)),
          JSON.stringify({ version: 1, cwd: conv.workdir }),
        );
      }
      const started = join(cwd, ".git", "lookup-started");
      const release = join(cwd, ".git", "lookup-release");
      const realGit = Bun.which("git")!;
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh
if [ "$PWD" = ${Bun.$.escape(cwd)} ] && [ "$*" = '--no-replace-objects --no-optional-locks remote get-url origin' ]; then
  touch .git/lookup-started
  while [ ! -f .git/lookup-release ]; do sleep 0.02; done
fi
exec ${Bun.$.escape(realGit)} "$@"
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}:${process.env.PATH}`;
      return { checkout: "pr-checkout", plain: "pr-plain", started, release };
    },
    "seed-changes-base": async () => {
      const cwd = await mkdtemp(join(tmpdir(), "changes-base-"));
      await git(cwd, "init", "-q", "-b", "main");
      await writeFile(join(cwd, "a.txt"), "base\n");
      await git(cwd, "add", "-A");
      await git(cwd, "commit", "-qm", "base");
      await git(cwd, "checkout", "-qb", "feature");
      await writeFile(join(cwd, "a.txt"), "base\nbranch line\n");
      await git(cwd, "commit", "-qam", "branch");
      await git(cwd, "checkout", "-q", "main");
      await writeFile(join(cwd, "later.txt"), "landed on main later\n");
      await git(cwd, "add", "-A");
      await git(cwd, "commit", "-qm", "later");
      await git(cwd, "update-ref", "refs/remotes/origin/main", "main");
      await git(cwd, "checkout", "-q", "feature");
      await writeFile(
        join(cwd, "a.txt"),
        "base\nbranch line\nuncommitted line\n",
      );
      const cid = "changes-base";
      await once({ agent: cid }, () => create(cid, cid, rootAgentId()));
      const conv = load(cid)!;
      conv.workdir = cwd;
      await save(conv);
      await seedHistory(cid, [user("Show the branch's changes")], {
        replace: true,
      });
      await writeFile(
        instance.agentTemp.workdirFile(String(conv.tmp_key)),
        JSON.stringify({ version: 1, cwd }),
      );
      return {
        cid,
        branch: await git(cwd, "rev-parse", "HEAD"),
        start: await git(cwd, "rev-parse", "main~1"),
      };
    },
    "seed-pr-links": async () => {
      const bin = await mkdtemp(join(tmpdir(), "pr-links-bin-"));
      const calls = join(bin, "calls");
      const pr = {
        number: 7,
        title: "Link branch pull requests",
        url: "https://github.com/Owner/Repo/pull/7",
        state: "OPEN",
        baseRefName: "main",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        headRepository: { name: "Repo" },
        headRepositoryOwner: { login: "Owner" },
      };
      const created = {
        number: 8,
        title: "Record created pull requests",
        url: "https://github.com/Owner/Repo/pull/8",
        state: "OPEN",
        createdAt: new Date().toISOString(),
      };
      const older = {
        ...created,
        number: 9,
        url: "https://github.com/Owner/Repo/pull/9",
        createdAt: "2020-01-01T00:00:00Z",
      };
      const view =
        "--repo owner/repo --json number,title,url,state,baseRefName,statusCheckRollup,createdAt";
      await writeFile(
        join(bin, "pr8.diff"),
        "diff --git a/created.ts b/created.ts\n--- a/created.ts\n+++ b/created.ts\n@@ -1 +1 @@\n-old link\n+created link\n",
      );
      await writeFile(
        join(bin, "gh"),
        `#!/bin/sh\necho "$*" >> ${calls}\ncase "$*" in\n"pr list --repo Owner/Repo --head feature --state all --limit 5 --json number,title,url,state,baseRefName,statusCheckRollup,headRepository,headRepositoryOwner") printf '%s\\n' '${JSON.stringify([pr])}' ;;\n"pr create --title Record created pull requests") echo Creating; echo ${created.url} ;;\n"pr view 8 ${view}") printf '%s\\n' '${JSON.stringify(created)}' ;;\n"pr view 9 ${view}") printf '%s\\n' '${JSON.stringify(older)}' ;;\n"pr view 9 --json url -q .url") echo ${older.url} ;;\n"pr diff 8 --repo owner/repo --color never") cat ${bin}/pr8.diff ;;\n"pr view 8 --repo owner/repo --json body") echo '{"body":"Created from a child."}' ;;\n*) exit 1 ;;\nesac\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}:${process.env.PATH}`;
      const links: Record<string, Json> = {};
      let notes = "";
      for (const [cid, checkout] of [
        ["pr-branch", ["checkout", "-qb", "feature"]],
        ["pr-detached", ["checkout", "-q", "--detach"]],
      ] as const) {
        const cwd = await mkdtemp(join(tmpdir(), `${cid}-`));
        for (const args of [
          ["init", "-q", "-b", "main"],
          ["remote", "add", "origin", "https://github.com/Owner/Repo"],
          ["commit", "-q", "--allow-empty", "-m", "base"],
          ["update-ref", "refs/remotes/origin/feature", "HEAD"],
          checkout,
          ["branch", "-q", "--set-upstream-to", "origin/feature"],
        ])
          await git(cwd, ...args);
        await create(cid, cid, rootAgentId(), undefined, cwd);
        for (const turn of ["Push the branch.", "Check it again."])
          await sayDurable(cid, turn, "Done.");
        for (let i = 0; i < 100 && cid === "pr-branch" && !load(cid)!.prs; i++)
          await Bun.sleep(100);
        links[cid] = load(cid)!.prs as Json;
        if (cid === "pr-branch") {
          notes = join(cwd, "notes.txt");
          await writeFile(notes, "uncommitted note\n");
          await git(cwd, "add", "notes.txt");
        }
      }
      const branchCalls = (await readFile(calls, "utf8")).trim().split("\n");
      await create("pr-child", "pr-child", "pr-branch", undefined, bin);
      const commands = [
        "gh pr create --title Older || gh pr view 9 --json url -q .url",
        "gh pr create --title Record created pull requests",
      ];
      await sayDurable("pr-child", "Open the pull request.", "Opened.", [
        fauxAssistantMessage(
          commands.map((command) => fauxToolCall("bash", { command })),
          { stopReason: "toolUse" },
        ),
      ]);
      const saved = () => (load("pr-child")!.prs ?? []) as { title: string }[];
      for (let i = 0; i < 100; i++) {
        if (saved().length === 1 && saved()[0]!.title) break;
        await Bun.sleep(100);
      }
      links["pr-child"] = load("pr-child")!.prs as Json;
      return {
        root: rootAgentId(),
        notes,
        links,
        calls: branchCalls,
        createdCalls: (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .slice(branchCalls.length)
          .sort(),
      };
    },
    "retitle-pr-link": async () => {
      for (const cid of ["pr-branch", "pr-child"])
        await conversations.updatePrs(cid, (prs) =>
          (prs as Json[]).map((pr) => ({
            ...pr,
            title: `Renamed ${pr.number}`,
          })),
        );
      await save({ ...load("pr-child")!, title: "Child renamed" });
      return {};
    },
    "newer-pr-link": async (body) => {
      const cid = body.agent || "pr-child";
      await conversations.updatePrs(cid, (prs) => [
        ...((prs ?? []) as Json[]),
        {
          repo: "owner/repo",
          number: 10,
          url: "https://github.com/owner/repo/pull/10",
          title: "Newer pull request",
          state: "open",
          checks: null,
          source: "created",
          detected_at: Date.now() / 1000 + 60,
        },
      ]);
      return {};
    },
  };
}
