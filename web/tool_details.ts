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

export type JsonLoader = (url: string, cid: string) => Promise<unknown>;
export type Scheduler = (
  fn: () => void,
  ms: number,
) => ReturnType<typeof setTimeout>;

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
export class ToolDetailStore {
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
    for (const key of [...this.inlineOpen]) {
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
export function payloadText(payload: CapturedPayload): string {
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

export interface ToolRowRef {
  artifact_id?: string;
  artifact_unavailable?: ToolCall["artifact_unavailable"];
}

export function unavailableText(call: ToolRowRef): string {
  if (call.artifact_unavailable === "quota")
    return "Full details storage is full for this conversation.";
  if (call.artifact_unavailable === "capture_failed")
    return "Full details couldn't be stored for this call.";
  if (call.artifact_unavailable === "copied")
    return "Full details stay with the source conversation.";
  return "Full details aren't available for this message.";
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

// What a collapsed row says the call did: the whole command when this
// conversation's own record carries it, else the safe summary. The backend has
// already made it a single bounded line, so the row clips it with CSS rather
// than slicing text — hover and screen readers still get all of it.
export function toolRowDetail(call: ToolCall): string {
  return call.input_full || call.input || "";
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

export function commandText(
  event: ToolArtifactEvent | null | undefined,
): string {
  if (event?.payload.format !== "json") return "";
  const value = event.payload.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const command = (value as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function eventText(event: ToolArtifactEvent | null | undefined): string {
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

export function plainDisplayText(text: string): string {
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

export function inputText(artifact: ToolArtifact): string {
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

export function outputLabel(artifact: ToolArtifact): string {
  if (artifact.result) return "Output";
  if (artifact.status === "stale") return "Last captured output";
  return "Live output";
}

export interface DetailSection {
  label: string;
  text: string;
  omitted: number;
}

// An open row says exactly two things: what went in, and what came out. A
// running or background call's newest captured output stands in for a result it
// does not have yet. An update that applied cleanly has no output worth
// reading, so only a failure adds a section back.
export function detailSections(artifact: ToolArtifact): DetailSection[] {
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
  if (isUpdate && !failed && artifact.status !== "stale") return sections;
  const text = eventDisplayText(output);
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

function sectionBlock(section: DetailSection): TemplateResult {
  return html`<section
    class="tool-payload"
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

const TRUNCATED_NOTE =
  "[\u2026 live payload truncated by the poll limit \u2026]";

// A live poll's inline full payloads as the artifact shape the detail sections
// already render. Delta polls carry bounded input/result text directly, so an
// open live row reads them with no second fetch; the cold artifact route stays
// the backing store for settled history.
export function inlineToolArtifact(call: ToolCall): ToolArtifact | null {
  const args = typeof call.args === "string" && call.args ? call.args : null;
  const result =
    typeof call.result === "string" && call.result ? call.result : null;
  const output =
    call.active && typeof call.output === "string" && call.output
      ? call.output
      : null;
  if (!args && !result && !output) return null;
  const withNote = (text: string, truncated?: boolean): string =>
    truncated ? `${text}\n\n${TRUNCATED_NOTE}` : text;
  const inputEvent: ToolArtifactEvent | null = args
    ? {
        version: 1,
        kind: "input",
        timestamp: 0,
        payload: {
          format: "json",
          bytes: args.length,
          omitted_bytes: 0,
          value: (() => {
            if (call.args_truncated) return withNote(args, true);
            try {
              return JSON.parse(args);
            } catch {
              return args;
            }
          })(),
        },
      }
    : null;
  const textEvent = (
    kind: string,
    text: string,
    truncated?: boolean,
  ): ToolArtifactEvent => ({
    version: 1,
    kind,
    timestamp: 0,
    payload: {
      format: "json",
      bytes: text.length,
      omitted_bytes: 0,
      value: { content: withNote(text, truncated) },
    },
  });
  return {
    version: 1,
    artifact_id:
      call.artifact_id ?? `live:${call.call_id ?? `seq:${call.seq ?? "anon"}`}`,
    message_id: "",
    tool_name: call.name,
    status: call.active ? "running" : "finished",
    input_source: "rpc_start",
    created_at: 0,
    updated_at: 0,
    input: inputEvent,
    latest_update:
      !result && output ? textEvent("update", output, false) : null,
    result: result ? textEvent("result", result, call.result_truncated) : null,
    background_latest: null,
    update_count: 0,
    background_count: 0,
    background_active: false,
    ...(call.timing ? { timing: call.timing } : {}),
    capture: {},
    raw_url: "",
  };
}

// The key for one inline-only live row's disclosure, shared with the store.
export function inlineRowKey(
  cid: string,
  call: ToolCall,
  index: number,
): string {
  return `${cid}:live:${call.call_id ?? `seq:${call.seq ?? index}`}`;
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

export function toolCallsList(
  cid: string,
  calls: ToolCall[],
  changed: () => void,
): TemplateResult {
  return html`<ol class="tool-calls">
    ${calls.map((call, index) => {
      const artifactId = call.artifact_id;
      const entry = artifactId
        ? toolDetailStore.get(cid, artifactId)
        : undefined;
      const open = Boolean(entry?.open);
      // Invariant: Delta polls carry bounded full payloads inline: an open live
      // row reads them with no fetch. The cold artifact route stays the settled
      // history.
      const inline = !artifactId ? inlineToolArtifact(call) : null;
      const inlineOpen = inline
        ? toolDetailStore.isInlineOpen(inlineRowKey(cid, call, index))
        : false;
      const openable = Boolean(artifactId || inline);
      const detailsId = artifactId
        ? `tool-detail-${artifactId}`
        : inline
          ? `tool-detail-inline-${index}`
          : `tool-detail-unavailable-${index}`;
      const toggle = () => {
        if (artifactId) toolDetailStore.toggle(cid, artifactId, changed);
        else if (inline)
          toolDetailStore.toggleInline(inlineRowKey(cid, call, index), changed);
      };
      const click = (event: MouseEvent) => {
        const selection = window.getSelection()?.toString() || "";
        const target = event.target as Element | null;
        if (
          shouldToggleToolRow(selection, Boolean(target?.closest("a,button")))
        )
          toggle();
      };
      const key = (event: KeyboardEvent) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          toggle();
        }
        // Invariant: In particular, Cmd/Ctrl-C is neither prevented nor handled
        // here. The inspector's capture listener only stops global shortcuts,
        // preserving the browser's native copy action for selected text.
      };
      const detail = toolRowDetail(call);
      const detailText = detail
        ? html`<span class="tc-input" title=${detail} aria-label=${detail}
            >${detail}</span
          >`
        : nothing;
      return html`<li class="tool-call">
        ${openable
          ? html`<div
              class="tc-call-head"
              role="button"
              tabindex="0"
              aria-expanded=${open || inlineOpen ? "true" : "false"}
              aria-controls=${detailsId}
              @click=${click}
              @keydown=${key}
            >
              <span class="tc-name">${call.name}</span>
              ${detailText}
            </div>`
          : html`<div class="tc-call-head">
              <span class="tc-name">${call.name}</span>
              ${detailText}
            </div>`}
        ${call.active && call.output
          ? html`<div class="tool-detail-body live-tool-output">
              ${sectionBlock({
                label: "Live output",
                text: call.output,
                omitted: 0,
              })}
            </div>`
          : nothing}
        ${artifactId
          ? html`<div id=${detailsId} ?hidden=${!open}>
              ${open ? detailBody(cid, artifactId, entry!, changed) : nothing}
            </div>`
          : nothing}
        ${inline
          ? html`<div id=${detailsId} ?hidden=${!inlineOpen}>
              ${inlineOpen ? detailSections(inline).map(sectionBlock) : nothing}
            </div>`
          : nothing}
        ${!openable && !call.active
          ? html`<p id=${detailsId} class="tool-unavailable">
              ${unavailableText(call)}
            </p>`
          : nothing}
      </li>`;
    })}
  </ol>`;
}
