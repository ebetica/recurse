// Latest persisted assistant response owns the provider mismatch notice.
import { html, render } from "lit";
import { until } from "lit/directives/until.js";
import { api } from "./api.js";
import { $ } from "./dom.js";
import type { ModelResponse } from "./types.js";
import { responseRow } from "./response-row.js";
import type { ViewBlock } from "./row-thread-state/view-blocks.js";

const chip = $<HTMLButtonElement>("#downgrade-chip");
const popover = $("#downgrade-popover");
const COOKIE = "recurse_downgrade_seen";
/** Display names by model id; null until the /api/models fetch finishes. */
let names: Map<string, string> | null = null;
let loading: Promise<void> | null = null;
let current: { id: string; response: ModelResponse } | undefined;

/** Fetch the catalog once; settle on success or failure. */
function loadNames(): Promise<void> {
  loading ??= api("/api/models")
    .then(async (result) =>
      result.ok
        ? ((await result.json()) as { models: { id: string; label: string }[] })
            .models
        : [],
    )
    .catch(() => [])
    .then((models) => {
      names = new Map(models.map((model) => [model.id, model.label]));
    });
  return loading;
}

/** "…" while the catalog loads, then the display name, else the raw id.
 * Spec: a label equal to the id is the server's fallback, not a name. */
export function responseModelName(
  id: string | undefined,
  provider?: string,
): string {
  if (!id) return "unknown";
  if (!names) return "…";
  const scoped = `${provider}/${id}`;
  const label = names.get(scoped) ?? names.get(id);
  return label && label !== id && label !== scoped ? label : id;
}

function requestRow(response: ModelResponse) {
  const row = responseRow(response, responseModelName);
  return html`<div class="model-response-row">
    ${row.time
      ? html`<time title=${new Date(response.timestamp!).toLocaleString()}
          >${row.time}</time
        >`
      : ""}
    <span class=${row.modelChanged ? "model-response-warning" : ""}
      >${row.modelChanged ? "Model changed: " : ""}${row.model}</span
    >
    ${row.effort
      ? html`<span class=${row.effortChanged ? "model-response-warning" : ""}
          >${row.effortChanged ? "Effort changed: " : ""}${row.effort}</span
        >`
      : ""}
    ${row.tokens
      ? html`<span class="model-response-tokens">${row.tokens}</span>`
      : ""}
  </div>`;
}

export function responseDetails(response: ModelResponse) {
  return names
    ? requestRow(response)
    : until(
        loadNames().then(() => requestRow(response)),
        requestRow(response),
      );
}

function paint(): void {
  if (!chip || !popover) return;
  chip.hidden = !current;
  if (!current) {
    popover.hidePopover();
    return;
  }
  const seen = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  chip.classList.toggle("seen", seen === encodeURIComponent(current.id));
  render(responseDetails(current.response), popover);
}

export function showModelResponse(
  cid: string | null,
  rows: readonly ViewBlock[],
  sessionKey?: string,
): void {
  if (!chip || !popover) return;
  const latest = rows.findLast(
    (row) => row.kind === "text" && row.role === "assistant" && !row.live,
  );
  const response = latest?.model_response;
  const id = `${cid}:${sessionKey ?? ""}:${latest?.id}`;
  if (current?.id !== id) popover.hidePopover();
  current =
    cid && response?.responseModel && response.responseModel !== response.model
      ? { id, response }
      : undefined;
  paint();
}

chip?.addEventListener("click", () => {
  if (!current || !chip || !popover) return;
  document.cookie = `${COOKIE}=${encodeURIComponent(current.id)}; Path=/; SameSite=Lax`;
  paint();
  const bounds = chip.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 308))}px`;
  popover.style.bottom = `${innerHeight - bounds.top + 6}px`;
});
