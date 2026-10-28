#!/usr/bin/env bun
// Build releases in a private temporary clone; retained refs and a saved plan
// separate review from interactive publication. No caller checkout is changed.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const DEV = "https://github.com/ebetica/recurse-dev.git";
const PUBLIC = "https://github.com/ebetica/recurse.git";
const PREFIX = "refs/recurse-public";
const HELP = `usage: bun scripts/release.ts X.Y.Z [--notes FILE] [--replace]
       bun scripts/release.ts X.Y.Z --push --prepared DIR

Build from a fresh recurse-dev main clone, edit notes in $VISUAL/$EDITOR
(default vi) in a terminal, and show commits, tree diff and notes. Nothing
is pushed. The printed DIR retains the clone, notes and built refs.
--push publishes that saved build only, after typing X.Y.Z in a terminal.
--replace rebuilds against the existing public release's parent (or main's
parent without that tag); publication uses exact force-with-lease checks.
--dev-remote URL / --public-remote URL override the GitHub remotes.
-h, --help show this help.
`;

interface Plan {
  version: string;
  dev: string;
  remote: string;
  devMain: string;
  devTag: string;
  publicMain: string;
  publicTag: string;
  release: string;
  commit: string;
  tag: string;
  publicTagObject: string;
  bumped: boolean;
  replace: boolean;
  notes: string;
}

async function run(
  args: string[],
  cwd?: string,
  input?: string,
  env = process.env,
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${args[0]} ${args[1]} failed: ${err.trim()}`);
  return out.trim();
}

function git(cwd: string, args: string[], input?: string, env = process.env) {
  return run(
    ["git", "-c", "credential.helper=!gh auth git-credential", ...args],
    cwd,
    input,
    env,
  );
}

async function identity(): Promise<NodeJS.ProcessEnv> {
  let name = await run(["git", "config", "--get", "user.name"]).catch(() => "");
  let email = await run(["git", "config", "--get", "user.email"]).catch(
    () => "",
  );
  if (!name || !email || /recurse-agent/i.test(`${name} ${email}`)) {
    const user = JSON.parse(await run(["gh", "api", "user"])) as {
      name: string | null;
      login: string;
      id: number;
    };
    name = user.name || user.login;
    email = `${user.id}+${user.login}@users.noreply.github.com`;
  }
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

async function summary(dir: string, plan: Plan) {
  const repo = join(dir, "repo");
  for (const [label, ref] of [
    ["Development", plan.release],
    ["Public", plan.commit],
  ]) {
    console.log(
      `${label}:\n${await git(repo, ["show", "-s", "--format=%H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>%n%s", ref!])}`,
    );
  }
  const base =
    plan.publicMain ||
    (await git(repo, ["hash-object", "-w", "-t", "tree", "--stdin"], ""));
  const files = await git(repo, ["diff", "--name-only", base, plan.commit]);
  console.log(
    `\nPublic tree diff: ${files ? files.split("\n").length : 0} files\n${await git(repo, ["diff", "--stat", base, plan.commit])}`,
  );
  console.log(`\nRelease notes:\n${plan.notes}\n`);
}

async function publish(dir: string, version: string) {
  const plan = (await Bun.file(join(dir, "release.json")).json()) as Plan;
  if (plan.version !== version) throw new Error("saved version does not match");
  const repo = join(dir, "repo");
  for (const [ref, expected] of [
    [`${PREFIX}/dev`, plan.release],
    [`${PREFIX}/main`, plan.commit],
    [`${PREFIX}/dev-tag`, plan.tag],
    [`${PREFIX}/public-tag`, plan.publicTagObject],
  ]) {
    if ((await git(repo, ["rev-parse", ref!])) !== expected)
      throw new Error(`saved ref changed: ${ref}`);
  }
  await summary(dir, plan);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await terminal.question(
    `Publish to ${plan.remote}? Type ${version}: `,
  );
  terminal.close();
  if (answer !== version)
    throw new Error("confirmation did not match; nothing pushed");
  const tagRef = `refs/tags/v${version}`;
  const leases = (main: string, tag: string) => [
    `--force-with-lease=refs/heads/main:${main}`,
    `--force-with-lease=${tagRef}:${tag}`,
  ];
  await git(repo, [
    "push",
    "--atomic",
    ...leases(plan.devMain, plan.devTag),
    plan.dev,
    ...(plan.bumped ? [`${PREFIX}/dev:refs/heads/main`] : []),
    `${PREFIX}/dev-tag:${tagRef}`,
  ]);
  await git(repo, [
    "push",
    "--atomic",
    ...leases(plan.publicMain, plan.publicTag),
    plan.remote,
    `${PREFIX}/main:refs/heads/main`,
    `${PREFIX}/public-tag:${tagRef}`,
  ]);
  const notes = join(dir, "published-notes.md");
  await Bun.write(notes, plan.notes);
  if (
    plan.replace &&
    (await run([
      "gh",
      "release",
      "view",
      `v${version}`,
      "--repo",
      "ebetica/recurse",
    ]).then(
      () => true,
      () => false,
    ))
  ) {
    await run([
      "gh",
      "release",
      "edit",
      `v${version}`,
      "--repo",
      "ebetica/recurse",
      "--notes-file",
      notes,
    ]);
  } else {
    await run([
      "gh",
      "release",
      "create",
      `v${version}`,
      "--repo",
      "ebetica/recurse",
      "--verify-tag",
      "--title",
      `Recurse v${version}`,
      "--notes-file",
      notes,
    ]);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const version = args.shift() || "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(HELP);
  let dev = DEV,
    remote = PUBLIC,
    notesFile = "",
    prepared = "";
  let push = false,
    replace = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--push") push = true;
    else if (arg === "--replace") replace = true;
    else if (
      ["--dev-remote", "--public-remote", "--notes", "--prepared"].includes(
        arg || "",
      ) &&
      args[0]
    ) {
      const value = args.shift()!;
      if (arg === "--dev-remote") dev = value;
      if (arg === "--public-remote") remote = value;
      if (arg === "--notes") notesFile = resolve(value);
      if (arg === "--prepared") prepared = resolve(value);
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  if (push) {
    if (!process.stdin.isTTY)
      throw new Error(
        "--push requires an interactive terminal; nothing pushed",
      );
    if (!prepared || replace || notesFile || dev !== DEV || remote !== PUBLIC)
      throw new Error("--push requires only --prepared DIR and the version");
    await publish(prepared, version);
    return;
  }
  if (prepared) throw new Error("--prepared requires --push");
  const env = await identity();
  const dir = await mkdtemp(join(tmpdir(), "recurse-release-"));
  console.log(`Prepared directory: ${dir}`);
  const repo = join(dir, "repo");
  await git(dir, ["clone", "--branch", "main", "--no-local", dev, repo]);
  const g = (args: string[], input?: string) => git(repo, args, input, env);
  const devMain = await g(["rev-parse", "origin/main"]);
  const tag = `v${version}`;
  const devTag = await g(["rev-parse", "--verify", `refs/tags/${tag}`]).catch(
    () => "",
  );
  const refs = await g([
    "ls-remote",
    remote,
    "refs/heads/main",
    `refs/tags/${tag}`,
  ]);
  const publicMain = refs.match(/^([0-9a-f]+)\trefs\/heads\/main$/m)?.[1] || "";
  const publicTag =
    refs.match(
      new RegExp(
        `^([0-9a-f]+)\\trefs/tags/${tag.replaceAll(".", "\\.")}$`,
        "m",
      ),
    )?.[1] || "";
  if (!replace && (devTag || publicTag))
    throw new Error(`${tag} already exists; use --replace`);
  if (publicMain)
    await g([
      "fetch",
      "--no-tags",
      remote,
      `refs/heads/main:${PREFIX}/previous`,
    ]);
  if (publicTag)
    await g([
      "fetch",
      "--no-tags",
      remote,
      `refs/tags/${tag}:${PREFIX}/previous-tag`,
    ]);
  let parent = publicMain;
  if (replace && (publicTag || publicMain)) {
    const existing = publicTag
      ? `${PREFIX}/previous-tag^{commit}`
      : `${PREFIX}/previous`;
    const parents = (
      await g(["rev-list", "--parents", "-n", "1", existing])
    ).split(" ");
    parent = parents[1] || "";
  }
  const last = await g([
    "describe",
    "--first-parent",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*",
    ...(replace && devTag ? ["--exclude", tag] : []),
  ]).catch(() => "");
  const subjects = await g([
    "log",
    "--first-parent",
    "--format=%s",
    last ? `${last}..HEAD` : "HEAD",
  ]);
  const notesPath = join(dir, "notes.md");
  await Bun.write(
    notesPath,
    notesFile
      ? await Bun.file(notesFile).text()
      : `${
          subjects
            .split("\n")
            .filter(Boolean)
            .map((s) => `- ${s}`)
            .join("\n") || "- No changes."
        }\n`,
  );
  if (process.stdin.isTTY) {
    const editor = Bun.spawn(
      [
        "sh",
        "-c",
        `${process.env.VISUAL || process.env.EDITOR || "vi"} "$1"`,
        "release-editor",
        notesPath,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    if ((await editor.exited) !== 0) throw new Error("notes editor failed");
  }
  const notes = (await Bun.file(notesPath).text()).trim();
  if (!notes) throw new Error("release notes must not be empty");
  const pkgPath = join(repo, "package.json");
  const pkg = await Bun.file(pkgPath).text();
  const bumped = JSON.parse(pkg).version !== version;
  if (bumped) {
    if (!/^ {2}"version": "[^"]*",$/m.test(pkg))
      throw new Error("package.json has no top-level version field");
    await Bun.write(
      pkgPath,
      pkg.replace(/^ {2}"version": "[^"]*",$/m, `  "version": "${version}",`),
    );
    await g(["add", "package.json"]);
    await g(["-c", "commit.gpgsign=false", "commit", "-m", `Release ${tag}`]);
  }
  const release = await g(["rev-parse", "HEAD"]);
  const tree = await g(["rev-parse", "HEAD^{tree}"]);
  const message = `Recurse ${tag}\n\n${notes}\n`;
  const commit = await g(
    ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"],
    message,
  );
  const tagger = await g(["var", "GIT_COMMITTER_IDENT"]);
  const makeTag = (object: string) =>
    g(
      ["mktag"],
      `object ${object}\ntype commit\ntag ${tag}\ntagger ${tagger}\n\n${message}`,
    );
  const tagObject = await makeTag(release);
  const publicTagObject = await makeTag(commit);
  for (const [ref, object] of [
    ["dev", release],
    ["main", commit],
    ["dev-tag", tagObject],
    ["public-tag", publicTagObject],
  ])
    await g(["update-ref", `${PREFIX}/${ref}`, object!]);
  const plan: Plan = {
    version,
    dev,
    remote,
    devMain,
    devTag,
    publicMain,
    publicTag,
    release,
    commit,
    tag: tagObject,
    publicTagObject,
    bumped,
    replace,
    notes,
  };
  await Bun.write(join(dir, "release.json"), JSON.stringify(plan, null, 2));
  await summary(dir, plan);
  console.log(
    `Nothing pushed. Publish this exact build with:\nbun ${JSON.stringify(resolve(import.meta.path))} ${version} --push --prepared ${JSON.stringify(dir)}`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`release: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
