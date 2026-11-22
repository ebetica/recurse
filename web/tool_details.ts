// Owns lazy owner-scoped tool disclosure; backend owns storage and validation.
// Owner/artifact keys and generation fences prevent stale cross-agent paint.
// Payloads render as escaped selectable text, never executable markup.
// Focus may inline bounded full commands; cross-agent summaries cannot.

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor, resolveUrl } from "./backends/backend.js";
import { CHECK_ICON, COPY_ERROR_ICON, COPY_ICON } from "./icons.js";
import type {
  CapturedPayload,
  ToolArtifact,
  ToolArtifactEvent,
  ToolCall,
} from "./types.js";

type JsonLoader = (url: string, cid: string) => Promise<unknown>;
type Scheduler = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

interface DetailEntry {
  open: boolean;
  loading: boolean;
  error: string | null;
  artifact: ToolArtifact | null;
  generation: number;
  detailRequest: number;
  timer?: ReturnType<typeof setTimeout>;
}

const defaultLoader: JsonLoader = async (url, cid) => {
  const response = await backendFor(cid).api(url);
  if (!response.ok)
    throw new Error(
      response.status === 404 ? "Details unavailable" : "Couldn't load details",
    );
  return response.json();
};

function artifactLive(artifact: ToolArtifact | null | undefined): boolean {
  return artifact?.status === "running" || artifact?.background_active === true;
}

// Per-artifact disclosure state. Stable owner+artifact keys prevent a late
// fetch from one conversation painting into another after navigation or a modal
// race.
class ToolDetailStore {
  private readonly entries = new Map<string, DetailEntry>();
  constructor(
    private readonly loadJson: JsonLoader = defaultLoader,
    private readonly schedule: Scheduler = (fn, ms) => setTimeout(fn, ms),
  ) {}

  key(cid: string, artifactId: string): string {
    return `${cid}:${artifactId}`;
  }
  get(cid: string, artifactId: string): DetailEntry | undefined {
    return this.entries.get(this.key(cid, artifactId));
  }

  closeConversation(cid: string): void {
    const prefix = `${cid}:`;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.close(entry);
    }
    for (const key of this.inlineOpen) {
      if (key.startsWith(prefix)) this.inlineOpen.delete(key);
    }
  }

  private close(entry: DetailEntry): void {
    entry.open = false;
    entry.generation++;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  toggle(cid: string, artifactId: string, changed: () => void): void {
    const key = this.key(cid, artifactId);
    const current = this.entries.get(key);
    if (current?.open) {
      this.close(current);
      changed();
      return;
    }
    const entry = current || {
      open: true,
      loading: false,
      error: null,
      artifact: null,
      generation: 0,
      detailRequest: 0,
    };
    entry.open = true;
    this.entries.set(key, entry);
    changed();
    void this.refresh(cid, artifactId, changed);
  }

  async refresh(
    cid: string,
    artifactId: string,
    changed: () => void,
  ): Promise<void> {
    const entry = this.entries.get(this.key(cid, artifactId));
    if (!entry?.open) return;
    const generation = entry.generation;
    const request = ++entry.detailRequest;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.loading = !entry.artifact;
    entry.error = null;
    changed();
    const url = `/api/conversations/${encodeURIComponent(cid)}/tool-details/${artifactId}`;
    try {
      const artifactValue = await this.loadJson(url, cid);
      if (
        !entry.open ||
        entry.generation !== generation ||
        entry.detailRequest !== request
      )
        return;
      const artifact = artifactValue as ToolArtifact;
      entry.artifact = backendFor(cid).label
        ? {
            ...artifact,
            raw_url: resolveUrl(backendFor(cid), artifact.raw_url),
          }
        : artifact;
      entry.loading = false;
      changed();
      if (artifactLive(entry.artifact)) {
        entry.timer = this.schedule(() => {
          entry.timer = undefined;
          void this.refresh(cid, artifactId, changed);
        }, 1500);
      }
    } catch (error) {
      if (
        !entry.open ||
        entry.generation !== generation ||
        entry.detailRequest !== request
      )
        return;
      entry.loading = false;
      entry.error =
        error instanceof Error ? error.message : "Couldn't load details";
      changed();
      if (artifactLive(entry.artifact)) {
        entry.timer = this.schedule(() => {
          entry.timer = undefined;
          void this.refresh(cid, artifactId, changed);
        }, 3000);
      }
    }
  }

  retry(cid: string, artifactId: string, changed: () => void): void {
    if (!this.entries.get(this.key(cid, artifactId))?.open) return;
    void this.refresh(cid, artifactId, changed);
  }

  // Inline live payload disclosure uses owner-scoped keys and needs no fetch.
  private readonly inlineOpen = new Set<string>();
  isInlineOpen(key: string): boolean {
    return this.inlineOpen.has(key);
  }
  toggleInline(key: string, changed: () => void): void {
    if (this.inlineOpen.has(key)) this.inlineOpen.delete(key);
    else this.inlineOpen.add(key);
    changed();
  }
}

export const toolDetailStore = new ToolDetailStore();

function decodeBase64(value = ""): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "[Stored fragment could not be decoded]";
  }
}

// JSON.stringify escapes terminal controls/ANSI as text. lit then inserts the
// result through a text node, so neither terminal escapes nor HTML execute.
function payloadText(payload: CapturedPayload): string {
  if (payload.format === "json") {
    try {
      return JSON.stringify(payload.value, null, 2);
    } catch {
      return "[Structured payload could not be rendered]";
    }
  }
  const head = decodeBase64(payload.head_base64);
  const tail = decodeBase64(payload.tail_base64);
  if (!payload.omitted_bytes) return head + tail;
  return `${head}\n\n[… ${payload.omitted_bytes.toLocaleString()} bytes omitted by the storage limit …]\n\n${tail}`;
}

interface ToolRowRef {
  artifact_id?: string;
  artifact_unavailable?: ToolCall["artifact_unavailable"];
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export async function copyText(
  text: string,
  clipboard:
    | { writeText(value: string): Promise<void> }
    | undefined = navigator.clipboard,
  fallback: (value: string) => boolean = legacyCopy,
): Promise<boolean> {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {}
  }
  return fallback(text);
}

const copyLinkTimers = new WeakMap<HTMLElement, number>();

/** Copy a link and briefly announce the result beside the control. */
export async function copyLink(
  href: string,
  notice: HTMLElement,
): Promise<void> {
  const copied = await copyText(href);
  notice.textContent = copied ? "Link copied" : "Could not copy link";
  notice.hidden = false;
  clearTimeout(copyLinkTimers.get(notice));
  copyLinkTimers.set(
    notice,
    window.setTimeout(() => {
      notice.hidden = true;
    }, 1800),
  );
}

function copyControl(text: string, label: string): TemplateResult {
  const copy = async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const copied = await copyText(text);
    button.innerHTML = copied ? CHECK_ICON : COPY_ERROR_ICON;
    button.classList.toggle("copied", copied);
    button.classList.toggle("copy-error", !copied);
    button.setAttribute(
      "aria-label",
      copied ? `${label} copied` : `Couldn't copy ${label.toLowerCase()}`,
    );
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("copied", "copy-error");
      button.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    }, 1200);
  };
  return html`<button
    class="tool-copy"
    type="button"
    aria-live="polite"
    aria-label=${`Copy ${label.toLowerCase()}`}
    @click=${copy}
  >
    ${unsafeHTML(COPY_ICON)}
  </button>`;
}

export function shouldToggleToolRow(
  selectionText: string,
  fromControl: boolean,
): boolean {
  return !selectionText && !fromControl;
}

function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = (ms / 1000).toFixed(1).replace(/\.0$/, "");
  return `${seconds} s`;
}

/** Timing shown at the top of an opened activity row. */
export function toolOpenTimingText(
  timing:
    | {
        total_ms?: number;
        safety_ms?: number;
        command_ms?: number;
      }
    | null
    | undefined,
  modelTimeMs?: unknown,
): string | null {
  const valid = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) > 0;
  const total = valid(timing?.total_ms) ? timing.total_ms : null;
  const component = (value: unknown): number | null =>
    valid(value) && (total === null || value <= total) ? value : null;
  const command = component(timing?.command_ms);
  const review = component(timing?.safety_ms);
  const model = valid(modelTimeMs) ? modelTimeMs : null;
  const parts = [
    ...(command === null ? [] : [`Ran ${durationText(command)}`]),
    ...(review === null ? [] : [`review ${durationText(review)}`]),
    ...(model === null ? [] : [`model ${durationText(model)}`]),
  ];
  return parts.length ? parts.join(" · ") : null;
}

function commandText(event: ToolArtifactEvent | null | undefined): string {
  if (event?.payload.format !== "json") return "";
  const value = event.payload.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const command = (value as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function eventText(event: ToolArtifactEvent | null | undefined): string {
  if (event?.payload.format !== "json") return "";
  const value = event.payload.value as { content?: unknown } | undefined;
  const content = value?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join("\n");
}

function plainDisplayText(text: string): string {
  // Invariant: Browser text nodes do not execute terminal controls, but
  // stripping SGR/OSC makes output readable. Other C0 bytes become visible
  // escapes. Copy still uses the exact raw text, and the structured pane
  // preserves JSON escapes.
  return text
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(
      /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g,
      (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}

// Everything a stored payload has to say, as text: a shell command, the content
// a file tool wrote, or — for anything else — the recorded payload itself.
function eventDisplayText(event: ToolArtifactEvent | null | undefined): string {
  if (!event?.payload) return "";
  return eventText(event) || payloadText(event.payload);
}

// The file tools, whose input IS the content they wrote.
const CONTENT_TOOLS = new Set(["edit", "multiedit", "write"]);
const UPDATE_TOOLS = new Set(["edit", "multiedit"]);

function writtenText(event: ToolArtifactEvent): string {
  if (event.payload.format !== "json") return "";
  const value = event.payload.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const field of ["content", "new_string"] as const) {
    const written = (value as Record<string, unknown>)[field];
    if (typeof written === "string" && written) return written;
  }
  return "";
}

function inputText(artifact: ToolArtifact): string {
  const event = artifact.input;
  if (!event?.payload) return "";
  const command = commandText(event);
  if (command) return command;
  if (CONTENT_TOOLS.has(artifact.tool_name.toLowerCase())) {
    const written = writtenText(event);
    if (written) return written;
  }
  return payloadText(event.payload);
}

function outputLabel(artifact: ToolArtifact): string {
  if (artifact.result) return "Output";
  if (artifact.status === "stale") return "Last captured output";
  return "Live output";
}

interface DetailSection {
  label: string;
  text: string;
  omitted: number;
}

// An open row says exactly two things: what went in, and what came out. A
// running or background call's newest captured output stands in for a result it
// does not have yet. An update that applied cleanly has no output worth
// reading, so only a failure adds a section back.
function detailSections(artifact: ToolArtifact): DetailSection[] {
  const sections: DetailSection[] = [];
  const input = inputText(artifact);
  if (input) {
    sections.push({
      label: "Input",
      text: input,
      omitted: artifact.input?.payload.omitted_bytes || 0,
    });
  }
  const output =
    artifact.background_latest || artifact.result || artifact.latest_update;
  const failed = artifact.status === "error" || output?.is_error === true;
  const isUpdate = UPDATE_TOOLS.has(artifact.tool_name.toLowerCase());
  const review = artifact.safety_review_failure;
  if (isUpdate && !failed && artifact.status !== "stale" && !review)
    return sections;
  const outputText = eventDisplayText(output);
  const text = [outputText, toolReviewFailureText(artifact)]
    .filter(Boolean)
    .join("\n");
  if (failed && !text) {
    sections.push({
      label: "Error",
      text: "This call failed. No output was captured.",
      omitted: 0,
    });
  } else if (text) {
    sections.push({
      label: failed ? "Error" : outputLabel(artifact),
      text,
      omitted: output?.payload.omitted_bytes || 0,
    });
  }
  return sections;
}

export function toolReviewFailureText(artifact?: ToolArtifact | null): string {
  const review = artifact?.safety_review_failure;
  return review
    ? [
        review.status === undefined ? undefined : `HTTP ${review.status}`,
        review.message,
      ]
        .filter(Boolean)
        .join(": ")
    : "";
}

function sectionBlock(section: DetailSection): TemplateResult {
  return html`<section
    class="tool-payload"
    data-theme-protected=${section.label === "Error" ? "tool-error" : nothing}
    aria-label=${`${section.label} payload`}
  >
    ${copyControl(section.text, section.label)}
    <pre>${plainDisplayText(section.text)}</pre>
    ${section.omitted
      ? html`<p class="tool-limit" role="note">
          Stored head and tail; exactly ${section.omitted.toLocaleString()}
          bytes were omitted.
        </p>`
      : nothing}
  </section>`;
}

function detailBody(
  cid: string,
  artifactId: string,
  entry: DetailEntry,
  changed: () => void,
  modelTimeMs?: unknown,
): TemplateResult {
  if (entry.loading && !entry.artifact) {
    return html`<div class="tool-detail-body" role="status">
      Loading full details…
    </div>`;
  }
  if (entry.error && !entry.artifact) {
    return html`<div class="tool-detail-body tool-detail-error" role="alert">
      ${entry.error}
      <button
        type="button"
        @click=${() => void toolDetailStore.refresh(cid, artifactId, changed)}
      >
        Retry
      </button>
    </div>`;
  }
  const artifact = entry.artifact;
  if (!artifact)
    return html`<div class="tool-detail-body">Details unavailable.</div>`;
  const sections = detailSections(artifact);
  const timing = toolOpenTimingText(artifact.timing, modelTimeMs);
  const timingRow = timing
    ? html`<div class="tool-detail-timing" title=${timing} aria-label=${timing}>
        ${timing}
      </div>`
    : nothing;
  return html`<div
    class="tool-detail-body"
    role="region"
    aria-label="Tool input and output details"
  >
    ${timingRow} ${sections.map((section) => sectionBlock(section))}
    <a class="tool-download" href=${artifact.raw_url} download
      >Download captured JSONL</a
    >
    ${entry.error
      ? html`<p class="tool-detail-error" role="alert">
          ${entry.error}
          <button
            type="button"
            @click=${() => toolDetailStore.retry(cid, artifactId, changed)}
          >
            Retry now
          </button>
        </p>`
      : nothing}
  </div>`;
}

// Whether one row's lazy detail is currently open, so a caller that renders its
// own row header (the turn views) can show the matching state.
export function toolRowOpen(cid: string, call: ToolRowRef): boolean {
  return Boolean(
    call.artifact_id && toolDetailStore.get(cid, call.artifact_id)?.open,
  );
}

// The fetched input/output for one row. Rendering the header stays with the
// caller; ownership of the payload stays here. A row with no stored payload has
// no panel at all — the caller renders it as a plain, unopenable row.
export function toolDetailPanel(
  cid: string,
  call: ToolRowRef,
  changed: () => void,
  modelTimeMs?: unknown,
): TemplateResult | typeof nothing {
  const artifactId = call.artifact_id;
  if (!artifactId) return nothing;
  const entry = toolDetailStore.get(cid, artifactId);
  if (!entry?.open) return nothing;
  return detailBody(cid, artifactId, entry, changed, modelTimeMs);
}
