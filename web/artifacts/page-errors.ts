// Accepts built-page error relays only from the watched iframe. Errors display
// as text, can be sent to the owning agent, and reload on request.
import { backendFor } from "../backends/backend.js";
import { html, render } from "lit";
import {
  MAX_PAGE_ERRORS,
  pageErrorReport,
  pageErrorText,
  type ArtifactInfo,
} from "./model.js";
import { DRAFT } from "../state.js";
import type { ArtifactEl } from "./artifact-state.js";

interface Watch {
  pane: ArtifactEl;
  info: ArtifactInfo;
  frame: HTMLIFrameElement;
  strip: HTMLElement;
  errors: string[];
  send: "idle" | "sending" | "sent" | "failed";
  // Error revision fences sends so only the submitted errors become Sent.
  errorsSeq: number;
  sendSeq: number;
}

const watches = new Set<Watch>();

function onMessage(event: MessageEvent): void {
  for (const watch of watches) {
    if (!watch.frame.isConnected) {
      watches.delete(watch);
      continue;
    }
    if (event.source !== watch.frame.contentWindow) continue;
    const text = pageErrorText(event.data);
    if (
      text === null ||
      watch.errors.includes(text) ||
      watch.errors.length >= MAX_PAGE_ERRORS
    )
      return;
    watch.errors.push(text);
    watch.errorsSeq++;
    if (watch.send === "sent") watch.send = "idle";
    renderStrip(watch);
    return;
  }
}

async function sendErrors(watch: Watch): Promise<void> {
  const owner = watch.pane._rs.agentId;
  if (!owner || owner === DRAFT || watch.send === "sending") return;
  const errors = [...watch.errors];
  const errorsSeq = watch.errorsSeq,
    sendSeq = ++watch.sendSeq;
  const version = watch.pane._rs.selectedVersion || watch.info.version || "";
  watch.send = "sending";
  renderStrip(watch);
  let ok = false;
  try {
    const response = await backendFor(owner).jpost(
      `/api/conversations/${owner}/deliver`,
      {
        content: pageErrorReport(watch.info, version, errors),
      },
    );
    ok = response.ok;
  } catch {
    ok = false;
  }
  if (watch.sendSeq !== sendSeq) return;
  watch.send = watch.errorsSeq !== errorsSeq ? "idle" : ok ? "sent" : "failed";
  renderStrip(watch);
}

function reload(watch: Watch): void {
  watch.errors = [];
  watch.errorsSeq++;
  watch.send = "idle";
  renderStrip(watch);
  watch.frame.setAttribute("src", watch.frame.getAttribute("src") ?? "");
}

function renderStrip(watch: Watch): void {
  const count = watch.errors.length;
  const label = {
    idle: "Send to agent",
    sending: "Sending…",
    sent: "Sent",
    failed: "Failed — retry",
  }[watch.send];
  render(
    count
      ? html`<div class="artifact-errors-head">
            <strong
              >${count === 1
                ? "The page raised an error"
                : `The page raised ${count} errors`}</strong
            >
            <span class="artifact-errors-spacer"></span>
            <button
              class="btn sm artifact-errors-send"
              @click=${() => void sendErrors(watch)}
              ?disabled=${watch.send === "sending" || watch.send === "sent"}
            >
              ${label}
            </button>
            <button
              class="btn sm artifact-errors-reload"
              @click=${() => reload(watch)}
            >
              Reload
            </button>
          </div>
          <ul class="artifact-errors-list">
            ${watch.errors.map((error) => html`<li>${error}</li>`)}
          </ul>`
      : html``,
    watch.strip,
  );
  watch.strip.hidden = !count;
}

/** Watch `frame` for page errors and show them in `strip`. */
export function watchPageErrors(
  pane: ArtifactEl,
  info: ArtifactInfo,
  frame: HTMLIFrameElement,
  strip: HTMLElement,
): void {
  for (const old of watches) if (!old.frame.isConnected) watches.delete(old);
  window.addEventListener("message", onMessage);
  const watch: Watch = {
    pane,
    info,
    frame,
    strip,
    errors: [],
    send: "idle",
    errorsSeq: 0,
    sendSeq: 0,
  };
  watches.add(watch);
  renderStrip(watch);
}
