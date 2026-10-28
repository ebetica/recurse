import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { isReadOnlyBashCommand } from "../../../../src/extensions/core/safety/read-only-bash.ts";

const allowed = (...commands: string[]) => {
  for (const command of commands)
    expect(isReadOnlyBashCommand(command), command).toBe(true);
};
const reviewed = (...commands: string[]) => {
  for (const command of commands)
    expect(isReadOnlyBashCommand(command), command).toBe(false);
};

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("allows plain commands and composed read-only command lists", () => {
  allowed(
    "rg needle src",
    "rg needle src | head -20",
    "git status && (git diff; git log -1)",
    "grep x a || fd file &\nwc -l a",
    "FOO=1 rg needle .",
  );
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("one unknown or mutating command makes the entire list reviewed", () => {
  reviewed(
    "rg needle | rm result",
    "git status && curl example.com",
    "(ls; touch result)",
    "rg needle & chmod 600 result",
  );
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("redirections, expansions, globs, and unknown syntax fail closed", () => {
  reviewed(
    "rg needle > result",
    "cat < input",
    "rg $(touch result)",
    "rg `touch result`",
    "diff <(cat a) <(cat b)",
    "rg $PATTERN",
    "rg *.ts",
    "rg x |",
    "if true; then ls; fi",
  );
  allowed("rg '$(literal)'", "rg '*.ts'", "echo '$HOME'");
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("rejects interpreters and command-launching wrappers", () => {
  reviewed(
    "bash -c 'rg x'",
    "sh script.sh",
    "python -c 'print(1)'",
    "node script.js",
    "sudo rg x",
    "env -i rg x",
    "exec rg x",
    "eval 'rg x'",
    "xargs rg",
  );
});

// prettier-ignore
// Regression: #1966 Git output flags must not bypass review
test("allows only explicitly read-only git forms", () => { // test-check-allow: T9 Git flags cannot skip review.
  allowed(
    "git status",
    "git log -1",
    "git diff --stat",
    "git show HEAD",
    "git rev-parse HEAD",
    "git merge-base HEAD main",
    "git ls-files",
    "git ls-tree HEAD",
    "git cat-file -p HEAD",
    "git blame file",
    "git describe --tags",
    "git shortlog",
    "git remote -v",
    "git config --get user.name",
    "git stash list",
    "git tag",
    "git tag --list 'v*'",
    "git branch",
    "git branch --list",
    "git diff --name-only",
  );
  reviewed(
    "git push",
    "git branch new-name",
    "git branch -D old",
    "git branch --del old",
    "git tag v1",
    "git tag -d v1",
    "git diff --ext-diff",
    "git diff --output /tmp/x",
    "git diff --output=/tmp/x",
    "git diff -o /tmp/x",
    "git diff -po /tmp/x",
    "git show --output=/tmp/x HEAD",
    "git log --output=/tmp/x",
    "git cat-file --filters HEAD:file",
    "GIT_EXTERNAL_DIFF=touch git diff",
    "PATH=/tmp rg needle",
    "HOME=/tmp git diff",
    "printf -v PATH /tmp; rg needle",
  );
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("rejects write and execution flags hidden inside read-oriented tools", () => {
  reviewed(
    "sed -i s/a/b/ file",
    "sed s/a/b/ -i file",
    "sed 'w result' file",
    "sed 's/a/b/e' file",
    "sed p --expression='w result' file",
    "find . -delete",
    "find . -execdir touch result ';'",
    "find . -exec rm {} ';'",
    "fd -x rm",
    "rg --pre cat needle",
    "sort --output=result input",
    "sort --out=result input",
    "sort --temporary-directory=result input",
    "uniq input output",
    "awk '{ system(\"touch result\") }' file",
    "awk '{ print > \"result\" }' file",
    "awk -W exec=unsafe.awk input",
    "file --compile",
    "tree -o result",
    "diff --output=result a b",
    "less -o result input",
    "xxd input output",
    "date --set tomorrow",
  );
  allowed(
    "sed -n '1,20p' file",
    "find . -name '*.ts'",
    "fd needle .",
    "sort input",
    "uniq input",
    "awk '{print $1}' file",
    "xxd input",
    "top -b -n1",
  );
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("allows additional shell, system, and scheduler inspection", () => {
  allowed(
    "pwd; sleep 0.01",
    "cd src && rg needle; cd ..",
    "test -f file && sha512sum file",
    "tac file | base64",
    "pgrep bash | wc -l",
    "lscpu; lsblk; vmstat",
    "ss -ltn; dmesg --level=err",
    "systemctl --user status recurse",
    "scontrol show job 123; squeue -j 123",
    "git worktree list; git grep needle",
    "umask -S; ulimit -a; mount",
  );
  reviewed(
    "ss -K dst 127.0.0.1",
    "dmesg --clear",
    "systemctl restart recurse status",
    "jobs -x touch result",
    "sleep 0 & wait -p PATH; rg needle",
    "scontrol update JobId=123 TimeLimit=10",
    "git grep --open-files-in-pager='sh -c touch' needle",
    "objdump --plugin=unsafe.so file",
    "umask 000",
    "ulimit -n 1",
  );
});

// test-check-allow: T9 Shell syntax must not bypass required tool review.
test("allows read-only RTK fronts but not RTK escape hatches", () => {
  allowed(
    "rtk rg needle src",
    "rtk grep needle file",
    "rtk read file",
    "rtk ls",
    "rtk git diff",
    "rtk find . -name '*.ts'",
  );
  reviewed(
    "rtk run 'touch result'",
    "rtk proxy touch result",
    "rtk curl example.com",
    "rtk wget example.com",
    "rtk git push",
    "rtk find . -delete",
    "rtk smart --force-download file",
  );
});

// Regression: #2150 Bun workspace hooks must never skip review
test("every Bun command goes to the reviewer, including Recurse's own CLIs", () => {
  const subagent = fileURLToPath(
    new URL("../../../../tools/subagent.ts", import.meta.url),
  );
  const worktree = fileURLToPath(
    new URL("../../../../tools/worktree.ts", import.meta.url),
  );
  const previous = process.env.RECURSE_SRC;
  process.env.RECURSE_SRC = fileURLToPath(
    new URL("../../../../", import.meta.url),
  );
  try {
    reviewed(
      `bun ${subagent} --help`,
      `bun ${worktree} --help`,
      `bun ${subagent} messages agent-1`,
      `bun ${subagent} tail agent-1`,
      `bun ${subagent} wait agent-1 --timeout 1`,
      "bun $RECURSE_SRC/tools/subagent.ts messages agent-1",
      'bun "${RECURSE_SRC}/tools/worktree.ts" --help',
      `bun --config=/dev/null --no-env-file ${subagent} messages agent-1`,
      `rg x && bun ${subagent} tail agent-1`,
    );
  } finally {
    if (previous === undefined) delete process.env.RECURSE_SRC;
    else process.env.RECURSE_SRC = previous;
  }
});
