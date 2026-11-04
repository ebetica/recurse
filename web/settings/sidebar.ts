// Sidebar editor sheet: read-only script, diff, undo, reset and saved versions.
// Agents write scripts; the operator reviews and reverts them here.
import { html, nothing, render } from "lit";
import { apiJson } from "../api.js";
import { state as app } from "../state.js";
import { settingsDetail } from "./layout.js";
import {
  changeScript,
  lineDiff,
  scriptState,
  setScriptState,
  takeDiffRequest,
  type ScriptState,
} from "../sidebar/script.js";

const who = (by: string) =>
  by === "operator" ? "You" : app.nodes[by]?.title || by;
const when = (at: number) =>
  new Date(at * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function buildSidebarSection(body: HTMLElement): void {
  const label = document.createElement("p");
  label.className = "hint";
  label.textContent = "Experimental";
  let diff = takeDiffRequest();
  const editor = document.createElement("div");
  body.append(label, editor);
  const detail = settingsDetail(body, "Sidebar", () => {
    const settings = scriptState();
    return settings
      ? settings.script
        ? "Custom script"
        : "Built-in script"
      : "Loading…";
  });
  let message = "";
  let busy = false;
  const act = async (action: "undo" | "reset") => {
    [busy, message] = [true, ""];
    draw();
    try {
      await changeScript(action);
      diff = false;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    busy = false;
    draw();
  };
  const draw = () => {
    const s: ScriptState | null = scriptState();
    detail.refresh();
    if (!s) {
      render(html`<p class="hint">${message || "Loading…"}</p>`, editor);
      return;
    }
    const script = s.script ?? s.default;
    const [latest, prior] = s.history;
    const previous = latest
      ? ((prior ? prior.script : null) ?? s.default)
      : null;
    const lines = diff && previous !== null ? lineDiff(previous, script) : null;
    render(
      html`<div class="group sidebar-script">
          <p class="item">${s.script ? "Custom script" : "Built-in script"}</p>
          <pre
            class="sidebar-script-text"
            tabindex="0"
            aria-label="Sidebar script"
          >
${lines
              ? lines.map(
                  (line) =>
                    html`<span
                      class=${line[0] === "+"
                        ? "add"
                        : line[0] === "-"
                          ? "del"
                          : ""}
                      >${line}
                    </span>`,
                )
              : script}</pre
          >
          <div class="item actions">
            <button
              type="button"
              class="secondary"
              aria-pressed=${String(!!lines)}
              ?disabled=${previous === null}
              @click=${() => {
                diff = !diff;
                draw();
              }}
            >
              Diff
            </button>
            <button
              type="button"
              class="secondary"
              ?disabled=${busy || !s.history.length}
              @click=${() => act("undo")}
            >
              Undo
            </button>
            <button
              type="button"
              class="secondary"
              ?disabled=${busy || !s.script}
              @click=${() => act("reset")}
            >
              Reset to default
            </button>
          </div>
        </div>
        <p class="hint">Recurse updates may require editing the script.</p>
        ${message
          ? html`<p class="msg err" role="status">${message}</p>`
          : nothing}
        ${s.history.length
          ? html`<ol class="group sidebar-script-history" aria-label="Versions">
              ${s.history.map(
                (v) =>
                  html`<li class="item">
                    ${when(v.at)} · ${who(v.by)} ·
                    ${v.script ? "Custom" : "Built-in"}
                  </li>`,
              )}
            </ol>`
          : ""}`,
      editor,
    );
  };
  draw();
  if (diff) queueMicrotask(() => detail.open());
  void apiJson<ScriptState>("/api/sidebar/script")
    .then(({ response, data }) => {
      if (!response.ok) throw new Error();
      setScriptState(data);
    })
    .catch(() => (message = "Couldn't load the sidebar script."))
    .finally(draw);
}
