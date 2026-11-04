// The sidebar script in the browser: runs a custom one in sidebar-worker.ts
// when the rows change and keeps its last layout on this device for the first
// paint. A failing script falls back to the built-in one under a banner; an
// agent's change shows a notice until it is acted on.
import { html, nothing, render } from "lit";
import { apiJson, jpost } from "../api.js";
import { embedded, state as app } from "../state.js";
import { SIDEBAR_CHANGE } from "./actions.js";
import { checkSections, type ScriptSection } from "./arrangement.js";
import type { SidebarRow } from "./rows.js";
import type { ScriptResult } from "./sandbox.js";

export interface ScriptVersion {
  at: number;
  by: string;
  script: string | null;
}
export interface ScriptState {
  script: string | null;
  default: string;
  history: ScriptVersion[];
}
type Failure = { error: string; line: number | null };
type Input = { script: string; rows: SidebarRow[]; now: number };

const LAYOUT_KEY = "recurse.sidebarLayout";
const SEEN_KEY = "recurse.sidebarScriptSeen";
/** How long the worker may take to answer before it is replaced. */
const ANSWER_MS = 500;
/** How long the worker may take to load the engine. */
const START_MS = 15_000;
/** The most line pairs the diff compares; larger diffs list both versions. */
const DIFF_CELLS = 1_000_000;
const REFRESH_MS = 3000;

let current: ScriptState | null = null;
let output: unknown = null;
let failure: Failure | null = null;
let problem = "";
try {
  output = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
} catch {}
const changed = () => {
  window.dispatchEvent(new Event(SIDEBAR_CHANGE));
  renderNotice();
};
const store = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

/**
 * The custom script's latest output for these rows, or null for the built-in
 * script; a new run starts when the rows have changed.
 */
export function scriptOutput(rows: SidebarRow[], now: number): unknown {
  if (embedded) return null;
  refreshScript();
  if (current?.script) schedule({ script: current.script, rows, now });
  return failure || (current && !current.script) ? null : output;
}

/** The script state Settings shows, fetched again when it changes. */
export const scriptState = (): ScriptState | null => current;

export function setScriptState(next: ScriptState): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  if (next.script !== current?.script) {
    [lastKey, failure, problem] = ["", null, ""];
    if (!next.script) {
      output = null;
      store(LAYOUT_KEY, null);
    }
  }
  current = next;
  changed();
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Fetch the script soon; at most one fetch per REFRESH_MS. */
export function refreshScript(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(
    async () => {
      try {
        const { response, data } = await apiJson<ScriptState>(
          "/api/sidebar/script",
        );
        if (response.ok) setScriptState(data);
      } catch {}
      refreshTimer = undefined;
    },
    current ? REFRESH_MS : 0,
  );
}

/** Undo or reset the script; the answer is the new state or an error. */
export async function changeScript(action: "undo" | "reset"): Promise<void> {
  const response = await jpost("/api/sidebar/script", { action });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Couldn't change it");
  setScriptState(body as ScriptState);
}

let lastKey = "";
let next: Input | null = null;
let running = false;
/** Queue a run; idle_for alone changes it once a minute. */
function schedule(input: Input): void {
  const rows = input.rows.map((row) => ({ ...row, idle_for: 0 }));
  const key = JSON.stringify([input.script, rows, Math.floor(input.now / 60)]);
  if (key === lastKey) return;
  [lastKey, next] = [key, input];
  if (!running) void drain();
}

async function drain(): Promise<void> {
  running = true;
  while (next) {
    const input: Input = next;
    next = null;
    const result = await runInWorker(input);
    if (next || input.script !== current?.script) continue;
    const before = JSON.stringify([output, failure]);
    try {
      if ("error" in result) throw result;
      [output, failure] = [compact(result.sections, input.rows), null];
      store(LAYOUT_KEY, JSON.stringify(output));
    } catch (error) {
      failure = (error as Failure).error
        ? (error as Failure)
        : { error: String((error as Error).message), line: null };
    }
    if (JSON.stringify([output, failure]) !== before) changed();
  }
  running = false;
}

/** Checked output with row ids in place of rows, as the device keeps it. */
function compact(sections: unknown, rows: SidebarRow[]): ScriptSection[] {
  const named = checkSections(sections, rows).slice(
    0,
    (sections as unknown[]).length,
  );
  return named.map(({ ids, actions, ...section }) => ({
    ...section,
    rows: ids,
    actions: actions.map(({ ids, ...action }) => ({ ...action, rows: ids })),
  }));
}

let worker: Worker | null = null;
let ready: Promise<unknown> = Promise.resolve();
function runInWorker(input: Input): Promise<ScriptResult> {
  if (!worker) {
    const version = encodeURIComponent(document.body.dataset.version ?? "");
    const w = new Worker(`/static/sidebar-worker.js?v=${version}`, {
      type: "module",
    });
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(reject, START_MS);
      w.onmessage = ({ data }) => {
        clearTimeout(timer);
        (data === "ready" ? resolve : reject)(data);
      };
      w.onerror = reject;
    });
    worker = w;
  }
  const w = worker;
  return ready.then(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (worker === w) worker = null;
          w.terminate();
          resolve({ error: `It ran longer than ${ANSWER_MS} ms`, line: null });
        }, ANSWER_MS);
        w.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        w.postMessage(input);
      }),
    () => {
      if (worker === w) worker = null;
      w.terminate();
      return { error: "The script engine didn't load", line: null };
    },
  );
}

const seen = () => Number(localStorage.getItem(SEEN_KEY)) || 0;
let diffRequested = false;
/** Whether Settings should open with the latest change's diff shown. */
export function takeDiffRequest(): boolean {
  const asked = diffRequested;
  diffRequested = false;
  return asked;
}

function act(work: () => Promise<void> | void): void {
  store(SEEN_KEY, String(current?.history[0]?.at ?? 0));
  problem = "";
  renderNotice();
  void Promise.resolve()
    .then(work)
    .catch((error) => {
      problem = String(error?.message ?? error);
      renderNotice();
    });
}

/** The banner for a failing script, or the notice after an agent's change. */
function renderNotice(): void {
  const host = document.getElementById("sidebar-script-notice");
  if (!host) return;
  const latest = current?.history[0];
  const fresh =
    latest && latest.by !== "operator" && latest.at > seen() ? latest : null;
  host.hidden = !failure && !fresh && !problem;
  render(
    problem
      ? html`<div class="sidebar-script-error" role="alert">${problem}</div>`
      : failure
        ? html`<div class="sidebar-script-error" role="alert">
            <span
              >Sidebar script failed:
              ${failure.error}${failure.line
                ? ` (line ${failure.line})`
                : ""}</span
            >
            <button
              type="button"
              @click=${() => act(() => changeScript("reset"))}
            >
              Use default
            </button>
          </div>`
        : fresh
          ? html`<div class="sidebar-script-change" role="status">
              <span>Changed by ${app.nodes[fresh.by]?.title || fresh.by}</span>
              <button
                type="button"
                @click=${() =>
                  act(() => {
                    diffRequested = true;
                    window.dispatchEvent(
                      new CustomEvent("recurse:open-settings", {
                        detail: "appearance",
                      }),
                    );
                  })}
              >
                Diff
              </button>
              <button
                type="button"
                @click=${() => act(() => changeScript("undo"))}
              >
                Undo
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                @click=${() => act(() => {})}
              >
                ×
              </button>
            </div>`
          : nothing,
    host,
  );
}

/** Lines of `after` against `before`, each marked "+", "-" or " ". */
export function lineDiff(before: string, after: string): string[] {
  const [x, y] = [before.split("\n"), after.split("\n")];
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (
    tail < x.length - head &&
    tail < y.length - head &&
    x[x.length - 1 - tail] === y[y.length - 1 - tail]
  )
    tail++;
  const a = x.slice(head, x.length - tail);
  const b = y.slice(head, y.length - tail);
  const same = (lines: string[]) => lines.map((line) => ` ${line}`);
  const around = (middle: string[]) => [
    ...same(x.slice(0, head)),
    ...middle,
    ...same(x.slice(x.length - tail)),
  ];
  if (a.length * b.length > DIFF_CELLS)
    return around([...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)]);
  const common = a.map(() => new Array<number>(b.length + 1).fill(0));
  common.push(new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] =
        a[i] === b[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: string[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j])
      (lines.push(` ${a[i++]}`), j++);
    else if (
      j < b.length &&
      (i >= a.length || common[i]![j + 1]! >= common[i + 1]![j]!)
    )
      lines.push(`+${b[j++]}`);
    else lines.push(`-${a[i++]}`);
  }
  return around(lines);
}
