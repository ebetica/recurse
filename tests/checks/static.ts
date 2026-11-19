#!/usr/bin/env bun
/**
 * The quick check before every tests/check.sh stage: sizes and web style in one
 * pass, then script and type checks. bun tests/checks/static.ts
 */
import { readFileSync } from "node:fs";
import type ts from "typescript";
import { generateTheme, themePalettes } from "../../src/themes.ts";
import { checkFiles as colors } from "./color_check.ts";
import { checkFiles as customProperties } from "./css_var_check.ts";
import { checkDeadExports } from "./dead_export_check.ts";
import { checkFiles as fonts } from "./font_check.ts";
import { checkImportGraph } from "./import_graph.ts";
import { checkFiles as motion } from "./motion_check.ts";
import { checkFiles as radii } from "./radius_check.ts";
import { checkFiles as resizeBoxes } from "./resize_box_check.ts";
import { checkFiles as routeHandlers } from "./route_check.ts";
import { checkFiles as shadows } from "./shadow_check.ts";
import { sourceSizes } from "./size_check.ts";
import { checkFiles as spacing } from "./space_check.ts";
import { StyleFile } from "./style_file.ts";
import { checkFiles as svg } from "./svg_check.ts";
import { checkFiles as layers } from "./z_check.ts";

/** Served with web/dock/style.css as /static/dockview.css. */
const DOCKVIEW_CSS = "node_modules/dockview/dist/styles/dockview.css";
/** TypeScript's native compiler, which ships newer lib types than tsc. */
const TSGO = "./node_modules/.bin/tsgo";
const SCRIPTS: Array<[string, string[]]> = [
  ["core boundary", ["bun", "tests/checks/core_boundary_check.ts"]],
  [
    "server-thread Oxlint",
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
  ["correctness Oxlint", ["bun", "run", "lint"]],
  ["docs", ["bun", "tests/checks/docs_check.ts"]],
  ["browser imports", ["bun", "tests/checks/browser_import_check.ts"]],
  ["standalone imports", ["bun", "tests/checks/standalone_import_check.ts"]],
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
  [
    "browser test types",
    ["bun", TSGO, "--project", "tsconfig.browser-tests.json"],
  ],
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
    owners: ["src/web/request_auth.ts", "src/web/request/auth-method.ts"],
    reason:
      "read how a request authenticated with authMethod() from src/web/request or isOperator() from src/web/request_auth.ts",
  },
  {
    specs: ["web"],
    pattern:
      /\bscrollEl\s+as\b|["'`]#scroll["'`]|getElementById\(["']scroll["']\)/,
    owners: [
      "web/thread-scroll/scroll-ledger.ts",
      "web/dom.ts",
      "web/dock/desktop.ts",
      "web/side-pane.ts",
    ],
    reason:
      "use the read-only scrollEl from web/dom.ts; only web/thread-scroll/scroll-ledger.ts moves the thread, so its holds can tell app scrolls from the reader's",
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
    specs: [
      "web/conversation",
      "web/thread-render",
      "web/row-thread-state",
      "web/thread-scroll",
      "web/polling",
    ],
    pattern: /\.scrollIntoView\(/,
    owners: [],
    reason:
      "scroll thread rows with jumpThreadScroll from web/thread-scroll/index.ts",
  },
  {
    specs: ["src", "web"],
    pattern: /\brunSidebarScript\(/,
    owners: [
      "src/sidebar_script/engine/sandbox.ts",
      "web/sidebar-worker.ts",
      "src/sidebar_dry_run.worker.ts",
    ],
    reason:
      "run sidebar scripts through a worker whose caller uses runRetryingTimeout from src/sidebar_script/index.ts, so a timeout on a busy host runs once more",
  },
];

function gitFiles(...specs: string[]): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...specs]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout.toString().split("\0").filter(Boolean);
}

/**
 * Web style policy over tracked web UI files; four checks also read src/.
 * Custom properties also see the vendored dock stylesheet and theme tokens.
 */
function styles(): string[] {
  const files = gitFiles("web/index.html", "web", "src")
    .filter((file) => /\.(?:css|html|ts)$/.test(file))
    .filter((file) => !/^web\/(?:dist|vendor)\//.test(file))
    .filter((file) => file !== "src/themes.ts")
    .map((file) => new StyleFile(file, readFileSync(file, "utf8")));
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
const banned = bans().concat(
  routeHandlers(
    gitFiles("src")
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({ file, text: readFileSync(file, "utf8") })),
  ),
);
for (const error of banned) console.error(`ERROR: ${error}`);
timed("source bans", started, !banned.length);

const graphSources = new Map<string, ts.SourceFile>();
started = performance.now();
timed("import graph", started, await checkImportGraph([], graphSources));
started = performance.now();
timed("dead exports", started, await checkDeadExports(graphSources));

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
