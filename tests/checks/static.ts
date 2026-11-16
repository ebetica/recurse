#!/usr/bin/env bun
/**
 * The quick check before every tests/check.sh stage: sizes and web style in one
 * pass, each script check, then both type checks. bun tests/checks/static.ts
 */
import { lstatSync, readFileSync } from "node:fs";
import { generateTheme, themePalettes } from "../../src/themes.ts";
import { checkFiles as colors } from "./color_check.ts";
import { checkFiles as customProperties } from "./css_var_check.ts";
import { checkFiles as fonts } from "./font_check.ts";
import { checkFiles as motion } from "./motion_check.ts";
import { checkFiles as radii } from "./radius_check.ts";
import { checkFiles as resizeBoxes } from "./resize_box_check.ts";
import { checkFiles as shadows } from "./shadow_check.ts";
import { checkFiles as spacing } from "./space_check.ts";
import { checkFiles as svg } from "./svg_check.ts";
import { checkFiles as layers } from "./z_check.ts";

type Text = { file: string; text: string };

const OPTIONAL = ":(glob,exclude)" + ["play", "ground"].join("") + "/**";
const MAX_LINES = 2500;
const WARN_LINES = 1000;
/** Served with web/dock/style.css as /static/dockview.css. */
const DOCKVIEW_CSS = "node_modules/dockview/dist/styles/dockview.css";
const SOURCE =
  /\.(?:[cm]?[jt]sx?|py|sh|bash|html?|css|scss|sass|less|vue|svelte|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;
/** TypeScript's native compiler, which ships newer lib types than tsc. */
const TSGO = "./node_modules/.bin/tsgo";
const SCRIPTS: Array<[string, string[]]> = [
  ["core boundary", ["bun", "tests/checks/core_boundary_check.ts"]],
  [
    "blocking Oxlint",
    [
      "bun",
      "--bun",
      "./node_modules/.bin/oxlint",
      "-c",
      ".oxlintrc.blocking.jsonc",
      "--disable-nested-config",
      "--report-unused-disable-directives-severity",
      "error",
      "src",
    ],
  ],
  ["docs", ["bun", "tests/checks/docs_check.ts"]],
  ["browser imports", ["bun", "tests/checks/browser_import_check.ts"]],
  ["theme hooks", ["bun", "tests/checks/theme_hooks_check.ts"]],
  ["operator sends", ["bun", "tests/checks/operator_send_check.ts"]],
  ["prompt budget", ["bun", "tests/checks/prompt_budget.ts"]],
  ["reminders", ["bun", "tests/checks/reminder_check.ts"]],
  [
    "comments",
    ["bun", "tests/checks/comment_check.ts", "--summary", "--strict"],
  ],
  [
    "test policy",
    ["bun", "tests/checks/test_check.ts", "--strict", "--summary"],
  ],
  ["web types", ["bun", TSGO, "--project", "tsconfig.json"]],
  ["server types", ["bun", TSGO, "--project", "tsconfig.backend.json"]],
];

/** Patterns banned in tracked TypeScript outside the files that own them. */
const BANS: Array<{
  specs: string[];
  pattern: RegExp;
  owners: string[];
  reason: string;
}> = [
  {
    specs: ["tests/mobile_browser"],
    pattern: /\bmarkRunning\b/,
    owners: [],
    reason:
      "use real held turns for running conversations, not partial running-state route rewrites",
  },
  {
    specs: ["web", "src/artifacts/key_relay.ts"],
    pattern:
      /\bisContentEditable\b|\bclosest\(\s*["'][^"']*(?:\binput\b|\btextarea\b|\[contenteditable)/,
    owners: ["web/conversation/thread.ts", "web/dock/host.ts"],
    reason:
      "use isTextEditorTarget from src/keyboard_target.ts for keyboard ownership; thread touch dismissal and dock click focus are not hotkey filters",
  },
  {
    specs: ["src"],
    pattern: /\bauth_method\b/,
    owners: ["src/web/request_auth.ts"],
    reason:
      "read how a request authenticated with authMethod() or isOperator() from src/web/request_auth.ts",
  },
  {
    specs: ["web"],
    pattern:
      /\bscrollEl\s+as\b|["'`]#scroll["'`]|getElementById\(["']scroll["']\)/,
    owners: [
      "web/conversation/scroll-ledger.ts",
      "web/dom.ts",
      "web/dock/desktop.ts",
      "web/side-pane.ts",
    ],
    reason:
      "use the read-only scrollEl from web/dom.ts; only web/conversation/scroll-ledger.ts moves the thread, so its holds can tell app scrolls from the reader's",
  },
  {
    specs: ["src"],
    pattern: /text\/event-stream/,
    owners: [
      "src/web/conversation_events.ts",
      "src/backends/remote_client.ts",
      "src/http_transport.ts",
    ],
    reason:
      "stream events through src/web/conversation_events.ts, whose responses close their connection so a viewer who left stops counting at once",
  },
  {
    specs: ["web/conversation", "web/thread-render", "web/row-thread-state"],
    pattern: /\.scrollIntoView\(/,
    owners: [],
    reason:
      "scroll thread rows with jumpThreadScroll from web/conversation/scroll-ledger.ts",
  },
  {
    specs: ["src", "web"],
    pattern: /\brunSidebarScript\(/,
    owners: [
      "web/sidebar/sandbox.ts",
      "web/sidebar-worker.ts",
      "src/sidebar_dry_run.worker.ts",
    ],
    reason:
      "run sidebar scripts through a worker whose caller uses runRetryingTimeout from web/sidebar/retry.ts, so a timeout on a busy host runs once more",
  },
];

function gitFiles(...specs: string[]): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...specs]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout.toString().split("\0").filter(Boolean);
}

/**
 * Tracked source files over 2,500 lines are errors; 1,000 or more warn.
 * Vendored, built, patch, fixture and lock files are not source.
 */
function sourceSizes(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = gitFiles(
    ".",
    OPTIONAL,
    ":(glob,exclude)web/vendor/**",
    ":(glob,exclude)web/dist/**",
    ":(glob,exclude)scripts/patches/**",
    ":(glob,exclude)**/fixtures/**",
    ":(glob,exclude)**/*.lock",
  );
  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) continue;
    const text = readFileSync(file, "utf8");
    if (!SOURCE.test(file) && !text.startsWith("#!")) continue;
    const lines =
      text.split("\n").length - Number(text.endsWith("\n") || !text);
    if (lines > MAX_LINES)
      errors.push(
        `${file}: ${lines} lines (maximum ${MAX_LINES}). A file this large usually means bloated code or a concern that should be its own module: simplify from first principles (delete dead, duplicated or parallel code, one job per module); do not mechanically split it.`,
      );
    else if (lines >= WARN_LINES)
      warnings.push(
        `${file}: ${lines} lines (maximum ${MAX_LINES}). A file this large often means bloated code or a concern that should be its own module: before adding more, look for dead, duplicated or parallel code to delete.`,
      );
  }
  return { errors, warnings };
}

/**
 * Web style policy over tracked web UI files; four checks also read src/.
 * Custom properties also see the vendored dock stylesheet and theme tokens.
 */
function styles(): string[] {
  const files: Text[] = gitFiles("web/index.html", "web", "src")
    .filter((file) => /\.(?:css|html|ts)$/.test(file))
    .filter((file) => !/^web\/(?:dist|vendor)\//.test(file))
    .filter((file) => file !== "src/themes.ts")
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const web = files.filter(({ file }) => !file.startsWith("src/"));
  return [
    ...colors(files),
    ...radii(files),
    ...shadows(files),
    ...fonts(files),
    ...svg(web),
    ...layers(web),
    ...motion(web),
    ...spacing(web),
    ...resizeBoxes(web),
    ...customProperties(
      [
        ...web,
        { file: DOCKVIEW_CSS, text: readFileSync(DOCKVIEW_CSS, "utf8") },
      ],
      themePalettes.flatMap((palette) =>
        Object.keys(generateTheme(palette))
          .filter((key) => key !== "color-scheme")
          .map((key) => `--${key}`),
      ),
    ),
  ];
}

/** One error per banned line, naming the file and line. */
function bans(): string[] {
  return BANS.flatMap(({ specs, pattern, owners, reason }) =>
    gitFiles(...specs)
      .filter((file) => /\.[cm]?tsx?$/.test(file) && !owners.includes(file))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            pattern.test(line) ? [`${file}:${index + 1}: ${reason}`] : [],
          ),
      ),
  );
}

const failed: string[] = [];
const timed = (name: string, started: number, ok: boolean) => {
  console.log(
    `static check: ${name} ${ok ? "passed" : "FAILED"} (${Math.round(performance.now() - started)} ms)`,
  );
  if (!ok) failed.push(name);
};

let started = performance.now();
const sizes = sourceSizes();
for (const error of sizes.errors) console.error(`ERROR: ${error}`);
timed("source sizes", started, !sizes.errors.length);

started = performance.now();
const styleErrors = styles();
for (const error of styleErrors) console.error(`ERROR: ${error}`);
timed("web style", started, !styleErrors.length);

started = performance.now();
const banned = bans();
for (const error of banned) console.error(`ERROR: ${error}`);
timed("source bans", started, !banned.length);

for (const [name, command] of SCRIPTS) {
  started = performance.now();
  const run = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  timed(name, started, (await run.exited) === 0);
}

if (failed.length) {
  for (const warning of sizes.warnings) console.warn(`WARNING: ${warning}`);
  console.error(`static check: FAILED ${failed.join(", ")}`);
  process.exitCode = 1;
}
