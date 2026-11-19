/**
 * Print the test commands a change can affect (see --help).
 * Usage: bun tests/dev/affected_tests.ts [BASE] [--map FILE] (or record/blame).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  fileChanges,
  frontendPlan,
  scriptGroups,
  type CoverageMap,
  type FileChange,
} from "./affected_browser";

const ROOT = posix.join(import.meta.dir, "../..");
const EVERYTHING = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^tsconfig[^/]*\.json$/,
  /^tests\/check\.sh$/,
  /^scripts\/patches\//,
];
/** Paths no test observes, and the checks that cover them instead. */
const NO_TESTS: Array<{ path: RegExp; checks: string[] }> = [
  { path: /^docs\/|^tests\/live|^\.github\/|\.md$/, checks: [] },
  { path: /^specs\/tla\//, checks: ["specs/tla/check.sh"] },
];
const ALL_BROWSER = [/^web\//];
const SCANNED = /\.(?:[cm]?[jt]sx?|sh)$/;
const TEST = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const BACKEND_TESTS = /^tests\/(?:backend\/[^/]+|extensions\/.+)$/;
const WEB_TESTS = /^tests\/web\/[^/]+$/;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts"];
const QUOTED = /["'`]([\w@.-]*(?:\/[\w@.-]+)*\.[\w-]+|\.\.?\/[^"'`\s$]+)["'`]/g;
const TOKEN = /[\w@.-]*(?:\/[\w@.-]+)+|[\w@-]+(?:\.[\w-]+)+/g;
const IMPORT_LINE =
  /\bfrom\s*["'`]|\bimport\s*\(|\brequire\s*\(|^\s*import\s*["'`]/;
const LAUNCH_LINE = /Worker|new URL\(|spawn|execPath/;
const BROWSER_INDEX = "tests/mobile_browser/index.ts";

type Plan = {
  /** Changed build inputs, or files no test names: every suite runs. */
  everything: string[];
  backend: string[];
  web: string[];
  /** Browser groups by label; null means the whole browser suite. */
  browser: string[] | null;
  /** Why the whole browser suite runs, when it does. */
  browserReason: string;
  /** How the coverage map placed browser changes. */
  notes: string[];
  /** Groups the change reaches, even when every group does. */
  groups: string[];
  /** Why the map cannot place the change; empty when it can. */
  uncertain: string[];
  /** Commands that check changed paths no test observes. */
  checks: string[];
};

/** Reverse dependency edges: path -> files whose text names that path. */
function dependents(
  files: string[],
  read: (path: string) => string,
  deleted: string[] = [],
  launched?: Set<string>,
): Map<string, Set<string>> {
  const known = new Set([...files, ...deleted]);
  const byBase = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const base = posix.basename(file);
    byBase.set(base, [...(byBase.get(base) ?? []), file]);
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir))
      byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  const reverse = new Map<string, Set<string>>();
  for (const file of files) {
    if (!SCANNED.test(file) && !read(file).startsWith("#!")) continue;
    const dir = posix.dirname(file);
    const text = read(file);
    const test =
      file.startsWith("tests/") && !/^tests\/(?:checks|dev)\//.test(file);
    const tokens = test
      ? [...text.matchAll(TOKEN)].map(
          (match) => [match[0], false, true] as const,
        )
      : [...text.matchAll(QUOTED)].map((match) => {
          const start = text.lastIndexOf("\n", match.index) + 1;
          const line = text.slice(start, text.indexOf("\n", match.index) >>> 0);
          const imported = IMPORT_LINE.test(line);
          const launch = !imported && LAUNCH_LINE.test(line);
          return [match[1]!, launch, imported || launch] as const;
        });
    const targets = new Set<string>();
    for (const [token, launch, module] of tokens) {
      const before = targets.size;
      const candidates = [posix.join(dir, token), token.replace(/^\/+/, "")];
      if (!token.startsWith("."))
        for (let up = dir; up !== "."; up = posix.dirname(up))
          candidates.push(posix.join(posix.dirname(up), token));
      for (const candidate of candidates) {
        if (/^(?:\.\.?)?$|^\.\.\//.test(candidate)) continue;
        if (`${dir}/`.startsWith(`${candidate}/`)) continue;
        const stem = candidate.replace(/\.js$/, "");
        const suffixes = module ? SUFFIXES : [""];
        for (const path of [candidate, ...suffixes.map((s) => stem + s)])
          if (known.has(path)) targets.add(path);
        if (test)
          for (const path of byDir.get(candidate) ?? []) targets.add(path);
      }
      const named =
        test && !token.includes("/") ? (byBase.get(token) ?? []) : [];
      for (const path of named) {
        const parent = posix.basename(posix.dirname(path));
        if (named.length === 1 || text.includes(`"${parent}"`))
          targets.add(path);
      }
      for (const path of [...targets].slice(before))
        if (
          !test &&
          !/^(?:web\/|tests\/|index\.html$)/.test(path) &&
          (launch || /worker|thread/i.test(posix.basename(path)))
        )
          launched?.add(path);
    }
    targets.delete(file);
    for (const target of targets) if (TEST.test(target)) targets.delete(target);
    for (const target of targets) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target)!.add(file);
    }
  }
  return reverse;
}

/** Browser group labels and their test files, read from the runner's list. */
function browserGroups(index: string): Map<string, string[]> {
  const files = new Map<string, string>();
  for (const match of index.matchAll(
    /import \{ tests as (\w+) \} from "\.\/(\w+)";/g,
  ))
    files.set(match[1]!, `tests/mobile_browser/${match[2]}.ts`);
  const groups = new Map<string, string[]>();
  for (const match of index.matchAll(/\["([\w-]+)",\s*([^\]]*\]?)\]/g))
    groups.set(
      match[1]!,
      [...match[2]!.matchAll(/\w+/g)].map(([name]) => files.get(name)!),
    );
  return groups;
}

/** Build code that lists web files as bundle inputs, not as imports. */
const BUNDLE = new Set([
  "src/build_stamp.cli.ts",
  "src/launcher/build.cli.ts",
  "src/local.ts",
]);
/** Plans over this many backend tests name the route most of them share. */
const WIDE = 50;
const SERVER_ENTRIES = [
  "tests/mobile_browser/common.ts",
  "tests/mobile_browser/browser_test_app.ts",
];

/** Decide which tests can observe `changes`, with an optional coverage map. */
function plan(
  changes: FileChange[],
  files: string[],
  read: (path: string) => string,
  map: CoverageMap | null = null,
  presentPaths: string[] = files,
): Plan {
  const changed = [...new Set(changes.map((change) => change.path))];
  const present = new Set(presentPaths);
  const launched = new Set<string>();
  const reverse = dependents(
    files,
    read,
    changed.filter((path) => !files.includes(path)),
    launched,
  );
  const imports = new Map<string, string[]>();
  for (const [target, users] of reverse)
    for (const user of users)
      imports.set(user, [...(imports.get(user) ?? []), target]);
  const workers = new Set<string>();
  for (const queue = [...launched]; queue.length; ) {
    const next = queue.pop()!;
    if (!workers.has(next))
      (workers.add(next), queue.push(...(imports.get(next) ?? [])));
  }
  const groups = browserGroups(read(BROWSER_INDEX));
  const browserFiles = new Set([...groups.values()].flat());
  const via = new Map<string, string>();
  const reach = (path: string, stop = new Set<string>()) => {
    const seen = new Set([path]);
    const queue = [path];
    for (let next = queue.pop(); next !== undefined; next = queue.pop())
      if (!stop.has(next))
        for (const user of reverse.get(next) ?? [])
          if (!seen.has(user)) {
            seen.add(user);
            queue.push(user);
            if (!via.has(user)) via.set(user, next);
          }
    return seen;
  };
  const members = (users: Set<string>) =>
    [...groups]
      .filter(([, list]) => list.some((file) => users.has(file)))
      .map(([label]) => label);
  const reached = new Set<string>();
  const everything: string[] = [];
  const whole: string[] = [];
  const labels = new Set<string>();
  const notes: string[] = [];
  const frontend: FileChange[] = [];
  const testsReach = (users: Set<string>) =>
    [...users].some((user) => TEST.test(user) || browserFiles.has(user));
  const fixtureUsers = (path: string, users: Set<string>) => {
    const dirs = path.match(/^tests\/(?:.+\/)?fixtures\/(.+)\/[^/]+$/)?.[1];
    if (!dirs || testsReach(users)) return users;
    const owners = files.filter(
      (file) =>
        file.startsWith("tests/") &&
        SCANNED.test(file) &&
        dirs.split("/").some((dir) => read(file).includes(dir)),
    );
    const found = new Set(owners.flatMap((owner) => [...reach(owner)]));
    return testsReach(found) ? found : users;
  };
  for (const path of changed) {
    const users = fixtureUsers(
      path,
      reach(path, path.startsWith("web/") ? BUNDLE : undefined),
    );
    for (const user of users) reached.add(user);
    if (path === BROWSER_INDEX) whole.push(`${path} changed`);
    else if (
      ALL_BROWSER.some((rule) => rule.test(path)) &&
      !NO_TESTS.some((rule) => rule.path.test(path))
    ) {
      if (map)
        frontend.push(...changes.filter((change) => change.path === path));
      else whole.push(`${path} changed and there is no browser coverage map`);
    } else if (
      EVERYTHING.some((rule) => rule.test(path)) ||
      (present.has(path) &&
        !NO_TESTS.some((rule) => rule.path.test(path)) &&
        !testsReach(users))
    )
      everything.push(path);
    else if (!map || path.startsWith("tests/mobile_browser/"))
      members(users).forEach((label) => labels.add(label));
    else if (SERVER_ENTRIES.some((entry) => users.has(entry))) {
      const direct = members(reach(path, new Set(SERVER_ENTRIES)));
      direct.forEach((label) => labels.add(label));
      const change = changes.find((entry) => entry.path === path)!;
      const ids = map.js[path] ? scriptGroups(change, map) : null;
      if (ids !== null) {
        ids.forEach((id) => labels.add(map.groups[id]!));
        const found = [
          ...new Set([...direct, ...ids.map((id) => map.groups[id]!)]),
        ];
        notes.push(
          `${path}: groups whose server ran the changed functions -> ${found.join(" ") || "no group"}`,
        );
      }
      if (workers.has(path))
        whole.push(
          `${path} may run in a worker or child process, which server coverage does not see`,
        );
      else if (!map.js[path])
        whole.push(`${path}: the recorded test server never loaded it`);
      else if (ids === null) whole.push(`${path}: diff lacks full context`);
    } else members(users).forEach((label) => labels.add(label));
  }
  if (map && frontend.length) {
    const result = frontendPlan(frontend, map, (path) =>
      [...reach(path)].filter(
        (file) => file.startsWith("web/") && file !== path,
      ),
    );
    result.labels.forEach((label) => labels.add(label));
    whole.push(...result.whole);
    notes.push(...result.notes);
  }
  if (map && (frontend.length || notes.length)) {
    const missing = [...groups.keys()].filter(
      (label) => !map.groups.includes(label),
    );
    missing.forEach((label) => labels.add(label));
    if (missing.length)
      notes.push(
        `groups not in the coverage map, included: ${missing.join(" ")}`,
      );
  }
  const tests = [...reached]
    .filter((path) => TEST.test(path) && present.has(path))
    .sort();
  const backend = tests.filter((path) => BACKEND_TESTS.test(path));
  if (!everything.length && backend.length > WIDE) {
    const routes = new Map<string, number>();
    for (const test of backend) {
      const chain = [test];
      for (let next = via.get(test); next && !chain.includes(next); )
        (chain.unshift(next), (next = via.get(next)));
      const route = chain.slice(0, 3).join(" <- ");
      routes.set(route, (routes.get(route) ?? 0) + 1);
    }
    const [route, count] = [...routes].sort((a, b) => b[1] - a[1])[0]!;
    notes.push(
      `${count} of ${backend.length} backend tests start with: ${route}`,
    );
  }
  const ordered = [...groups.keys()].filter((label) => labels.has(label));
  const reason = everything.length
    ? `${everything.join(", ")}: a build input, or no test reaches it`
    : whole.length
      ? whole.join("; ")
      : ordered.length === groups.size
        ? "every group reaches a changed file"
        : "";
  return {
    everything,
    backend,
    web: tests.filter((path) => WEB_TESTS.test(path)),
    browser: reason ? null : ordered,
    browserReason: reason,
    notes,
    groups: ordered,
    uncertain: everything.length
      ? [`${everything.join(", ")}: a build input, or no test reaches it`]
      : whole,
    checks: NO_TESTS.filter((rule) =>
      changed.some((path) => rule.path.test(path)),
    ).flatMap((rule) => rule.checks),
  };
}

/** The shell commands for a plan, one per line. */
function commands(result: Plan): string[] {
  if (result.everything.length)
    return [
      `# everything: ${result.browserReason}`,
      "bun run test:backend",
      "bun run test",
      "bun run test:browser",
      ...result.checks,
    ];
  const lines: string[] = [];
  if (
    result.backend.includes("tests/backend/provider_e2e.test.ts") ||
    result.browser?.includes("provider-replay")
  )
    lines.push("tests/check.sh provider");
  const paths = (list: string[]) => list.map((p) => `./${p}`).join(" ");
  if (result.backend.length)
    lines.push(`bun test --timeout 30000 ${paths(result.backend)}`);
  if (result.web.length) lines.push(`bun test ${paths(result.web)}`);
  if (result.browser === null)
    lines.push(`# browser: ${result.browserReason}`, "bun run test:browser");
  else if (result.browser.length)
    lines.push(`bun ${BROWSER_INDEX} ${result.browser.join(" ")}`);
  lines.push(...result.checks);
  if (!lines.length) lines.push("# no tests reach this change");
  return lines;
}

/**
 * Commits whose changes may reach a browser group, fewest groups first.
 * Ties keep the given order; commits the map cannot place come last.
 */
function blame(
  group: string,
  commits: Array<{ name: string; changes: FileChange[] }>,
  files: string[],
  read: (path: string) => string,
  map: CoverageMap,
): string[] {
  const ran: Array<[number, number, string]> = [];
  const unsure: string[] = [];
  let clear = 0;
  commits.forEach(({ name, changes }, order) => {
    const result = plan(changes, files, read, map);
    if (!map.groups.includes(group))
      unsure.push(`${name}  # cannot rule out: ${group} is not in the map`);
    else if (result.uncertain.length)
      unsure.push(`${name}  # cannot rule out: ${result.uncertain.join("; ")}`);
    else if (result.groups.includes(group))
      ran.push([
        result.groups.length,
        order,
        `${name}  # ${group} is among the ${result.groups.length} groups its changes reach`,
      ]);
    else clear++;
  });
  ran.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return [
    ...ran.map(([, , line]) => line),
    ...unsure,
    `# ruled out ${clear} of ${commits.length}: ${group} ran none of their changes`,
  ];
}

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (run.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

/** Map path: --map, RECURSE_COVERAGE_MAP, or the instance data directory. */
function mapPath(args: string[]): string | null {
  const at = args.indexOf("--map");
  if (at >= 0) return args[at + 1]!;
  if (process.env.RECURSE_COVERAGE_MAP) return process.env.RECURSE_COVERAGE_MAP;
  const data = process.env.CHAT_DATA_DIR;
  return data ? posix.join(data, "test-maps/coverage_map.json") : null;
}

/** Run the browser suite with coverage on; map the groups that passed. */
function record(target: string): number {
  const scripts = JSON.parse(
    readFileSync(posix.join(ROOT, "package.json"), "utf8"),
  ).scripts;
  const build = Bun.spawnSync(
    [
      "sh",
      "-c",
      scripts.build.replace(" --minify ", " --minify --sourcemap=linked "),
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) return build.exitCode ?? 1;
  const out = mkdtempSync(posix.join(tmpdir(), "coverage-record-"));
  // Invariant: Eight recording workers starve each other's pages past the
  // suite's 5 s waits; four run at about the normal suite's group speed.
  const run = Bun.spawnSync(["bun", BROWSER_INDEX, "--workers", "4"], {
    cwd: ROOT,
    env: { ...process.env, RECURSE_BROWSER_COVERAGE: out },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!readdirSync(out).some((name) => name.endsWith(".json"))) {
    console.error(`record: no browser group passed; no map written`);
    return run.exitCode || 1;
  }
  merge(out, target);
  rmSync(out, { recursive: true, force: true });
  return run.exitCode ?? 1;
}

/** Merge per-group records from a recording run into one map. */
function merge(out: string, target: string): void {
  const files = git("ls-files").split("\n").filter(Boolean);
  let groups = [
    ...browserGroups(
      readFileSync(posix.join(ROOT, BROWSER_INDEX), "utf8"),
    ).keys(),
  ];
  const failed = groups.filter(
    (label) => !existsSync(posix.join(out, `${label}.json`)),
  );
  groups = groups.filter((label) => !failed.includes(label));
  const map: CoverageMap = {
    commit: git("describe", "--always", "--dirty", "--abbrev=12").trim(),
    date: new Date().toISOString(),
    groups,
    files,
    js: {},
    css: {},
    tokens: {},
  };
  const add = (table: Record<string, number[]>, key: string, id: number) =>
    (table[key] ??= []).push(id);
  groups.forEach((label, id) => {
    const group = JSON.parse(
      readFileSync(posix.join(out, `${label}.json`), "utf8"),
    );
    for (const kind of ["known", "cssKnown"] as const)
      for (const [file, keys] of Object.entries(
        group[kind] as Record<string, string[]>,
      ))
        for (const key of keys)
          (map[kind === "known" ? "js" : "css"][file] ??= {})[key] ??= [];
    for (const kind of ["js", "css"] as const)
      for (const [file, keys] of Object.entries(
        group[kind] as Record<string, string[]>,
      ))
        for (const key of keys) add((map[kind][file] ??= {}), key, id);
    for (const token of group.tokens as string[]) add(map.tokens, token, id);
  });
  mkdirSync(posix.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(map));
  console.log(
    `record: wrote ${target} (${map.commit}, ${groups.length} groups)`,
  );
  if (failed.length)
    console.error(
      `record: left out failed groups; plans that use the map run them: ${failed.join(" ")}`,
    );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = mapPath(args);
  if (args[0] === "record") {
    if (!target)
      throw new Error("record: pass --map PATH or set CHAT_DATA_DIR");
    const at = args.indexOf("--records");
    if (at >= 0) merge(args[at + 1]!, target);
    else process.exitCode = record(target);
    process.exit();
  }
  const files = git("ls-files", "-z", "--cached")
    .split("\0")
    .filter((path) => path && existsSync(posix.join(ROOT, path)));
  const diffs = args
    .flatMap((arg, k) => (args[k - 1] === "--diff" ? [arg] : []))
    .map((path) => {
      const bytes = new Uint8Array(readFileSync(path));
      return {
        name: posix.basename(path).replace(/\.diff(\.gz)?$/, ""),
        diff: new TextDecoder().decode(
          path.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
        ),
      };
    });
  const positional = args.filter(
    (arg, k) => !arg.startsWith("--") && !args[k - 1]?.startsWith("--"),
  );
  let map: CoverageMap | null = null;
  const lines: string[] = [];
  if (target && existsSync(target)) {
    map = JSON.parse(readFileSync(target, "utf8")) as CoverageMap;
    const commit = map.commit.replace(/-dirty$/, "");
    const behind = Bun.spawnSync(
      ["git", "rev-list", "--count", `${commit}..HEAD`],
      { cwd: ROOT },
    );
    const age =
      behind.exitCode === 0
        ? `, ${behind.stdout.toString().trim()} commits behind HEAD`
        : "";
    lines.push(`# coverage map ${target}: ${map.commit}, ${map.date}${age}`);
  } else lines.push(`# no coverage map${target ? ` at ${target}` : ""}`);
  const cache = new Map<string, string>();
  const read = (path: string) => {
    if (!cache.has(path))
      cache.set(path, readFileSync(posix.join(ROOT, path), "utf8"));
    return cache.get(path)!;
  };
  if (args[0] === "blame") {
    const [, group, range] = positional;
    if (!map) throw new Error("blame: needs a coverage map");
    if (!group || !browserGroups(read(BROWSER_INDEX)).has(group))
      throw new Error(`blame: unknown browser group ${group}`);
    const commits = range
      ? git("rev-list", "--first-parent", range)
          .split("\n")
          .filter(Boolean)
          .map((sha) => ({
            name: git("log", "-1", "--format=%h %s", sha).trim(),
            diff: git("diff", "--no-renames", "-U100000000", `${sha}^`, sha),
          }))
      : diffs;
    lines.push(
      ...blame(
        group,
        commits.map(({ name, diff }) => ({ name, changes: fileChanges(diff) })),
        files,
        read,
        map,
      ),
    );
    console.log(lines.join("\n"));
    process.exit();
  }
  let diff = diffs[0]?.diff;
  if (diff === undefined) {
    const base =
      positional[0] ?? git("merge-base", "HEAD", "origin/dev").trim();
    diff = git("diff", "--no-renames", "-U100000000", base);
    for (const path of git("ls-files", "-z", "--others", "--exclude-standard")
      .split("\0")
      .filter(Boolean))
      diff += `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  }
  const changes = fileChanges(diff);
  const present = [
    ...files,
    ...changes
      .map((change) => change.path)
      .filter((path) => existsSync(posix.join(ROOT, path))),
  ];
  const result = plan(changes, files, read, map, present);
  lines.push(...result.notes.map((note) => `# ${note}`), ...commands(result));
  console.log(lines.join("\n"));
}
