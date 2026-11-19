// Per-conversation system-prompt disclosure: refetch on every reveal and
// refresh during running turns, including refreshes scheduled during render.
// The thread supplies repainting; read and refresh state stay here.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/backend.js";
import { copyButtonT } from "../conversation/copy-button/index.js";
import { DISCLOSURE_ICON } from "../icons.js";
import { state } from "../state.js";
import type { Conversation, PromptView } from "../types.js";

type Repaint = (conv: Conversation) => void;

const disclosureCaret = html`<span class="disclosure-caret" aria-hidden="true"
  >${unsafeHTML(DISCLOSURE_ICON)}</span
>`;
const bannerOpen = new Set<string>();
const bannerData = new Map<string, PromptView | null>();
const bannerLoading = new Set<string>();
const bannerRefresh = new Map<string, ReturnType<typeof setTimeout>>();
const bannerLastStatus = new Map<string, string>();

function fetchPrompt(cid: string): Promise<PromptView | null> {
  return backendFor(cid)
    .api(`/api/conversations/${cid}/prompt`)
    .then((r) => (r.ok ? (r.json() as Promise<PromptView>) : null))
    .catch(() => null);
}

function scheduleBannerRefresh(
  cid: string,
  repaint: Repaint,
  delay = 500,
): void {
  if (bannerRefresh.has(cid)) return;
  bannerRefresh.set(
    cid,
    setTimeout(() => {
      bannerRefresh.delete(cid);
      if (bannerOpen.has(cid)) loadBanner(cid, repaint);
    }, delay),
  );
}
function loadBanner(cid: string, repaint: Repaint): void {
  if (bannerLoading.has(cid)) return;
  bannerLoading.add(cid);
  fetchPrompt(cid).then((v) => {
    bannerData.set(cid, v);
    bannerLoading.delete(cid);
    const current = state.currentConv?.id === cid ? state.currentConv : null;
    if (bannerOpen.has(cid) && current?.status === "running") {
      // Invariant: Pending capture is normally a very short window. Once
      // captured, a slow check still notices an infrastructure relaunch that
      // clears/replaces it while the logical turn remains "running" in the
      // tree.
      scheduleBannerRefresh(
        cid,
        repaint,
        v?.system_messages?.length ? 5000 : 500,
      );
    }
    if (current) repaint(current);
  });
}
function toggleBanner(cid: string, repaint: Repaint): void {
  if (bannerOpen.has(cid)) {
    bannerOpen.delete(cid);
    const timer = bannerRefresh.get(cid);
    if (timer !== undefined) clearTimeout(timer);
    bannerRefresh.delete(cid);
  } else {
    bannerOpen.add(cid);
    loadBanner(cid, repaint);
  }
  if (state.currentConv) repaint(state.currentConv);
}

function capturedSystemMessages(messages: unknown[]): TemplateResult[] {
  return messages.map((value, index) => {
    const message = value as {
      replace?: boolean;
      content?: string;
      sections?: Record<string, string | null>;
      toolsAdded?: { name: string }[];
      toolsRemoved?: string[];
    };
    const sections = Object.entries(message.sections || {});
    if (message.content) sections.unshift(["content", message.content]);
    const kind = message.replace
      ? "replace"
      : index === 0
        ? "baseline"
        : "delta";
    const set = sections
      .filter(([, text]) => text !== null)
      .map(([name]) => name);
    const removed = sections
      .filter(([, text]) => text === null)
      .map(([name]) => name);
    const changes = [
      ["Sets", set],
      ["Removes", removed],
      ["Tools added", message.toolsAdded?.map((tool) => tool.name) || []],
      ["Tools removed", message.toolsRemoved || []],
    ] as const;
    return html`<div class="prompt-block system-message">
      <div class="prompt-block-head">Message ${index + 1} · ${kind}</div>
      <div class="prompt-msg">
        ${changes
          .filter(([, names]) => names.length)
          .map(
            ([label, names]) => html`<div>${label}: ${names.join(", ")}</div>`,
          )}
      </div>
      ${sections.map(([name, text]) =>
        text === null
          ? html`<p class="prompt-msg">${name} · removed</p>`
          : html`<details class="prompt-details prompt-section">
              <summary>
                ${disclosureCaret}${name} ·
                ${new TextEncoder().encode(text).byteLength.toLocaleString()}
                bytes
              </summary>
              <div class="prompt-block"><pre>${text}</pre></div>
            </details>`,
      )}
    </div>`;
  });
}

// The top-of-thread "System prompt" banner: the standing instructions the model
// runs under for this agent, collapsed by default and revealed inline.
export function promptBanner(
  conv: Conversation,
  repaint: Repaint,
): TemplateResult {
  const cid = conv.id;
  const open = bannerOpen.has(cid);
  const data = bannerData.get(cid);
  const previousStatus = bannerLastStatus.get(cid);
  bannerLastStatus.set(cid, conv.status);
  if (
    open &&
    conv.status === "running" &&
    (previousStatus !== "running" || data?.capture_status !== "captured")
  ) {
    scheduleBannerRefresh(cid, repaint);
  }
  const transcript = Boolean(data?.system_messages?.length);
  const text = transcript
    ? JSON.stringify(data!.system_messages, null, 2)
    : data?.system || "";
  const copyLabel = transcript ? "system messages" : "system prompt";
  const captured =
    transcript ||
    (data &&
      (data.capture_status === undefined ||
        data.capture_status === "captured"));
  return html`<div class="prompt-banner">
    <button
      class="prompt-banner-row"
      type="button"
      aria-expanded=${open ? "true" : "false"}
      @click=${() => toggleBanner(cid, repaint)}
    >
      ${disclosureCaret}
      <span class="lead">System prompt</span>
      <span class="sub">${open ? "" : "model instructions and changes"}</span>
    </button>
    ${open
      ? html`<div class="prompt-banner-body">
          ${bannerLoading.has(cid) && data === undefined
            ? html`<p class="prompt-msg">Loading…</p>`
            : captured
              ? html`<div class="prompt-block-head">
                    <span
                      >${transcript
                        ? "System messages · latest captured request"
                        : "Turn-start prompt · system messages unavailable"}</span
                    >
                    ${copyButtonT(text, copyLabel, copyLabel)}
                  </div>
                  ${transcript
                    ? capturedSystemMessages(data!.system_messages!)
                    : html`<pre>${text}</pre>`}`
              : data?.capture_status === "pending"
                ? html`<p class="prompt-msg">
                    The system prompt is being assembled for this turn.
                  </p>`
                : data?.capture_status === "unavailable"
                  ? html`<p class="prompt-msg">
                      No system prompt has been captured yet.
                    </p>`
                  : html`<p class="prompt-msg">
                      Couldn't load the system prompt.
                    </p>`}
          ${data?.safety_review
            ? html`<details
                class="prompt-details prompt-section safety-review-capture"
              >
                <summary>${disclosureCaret}Safety review</summary>
                <div class="prompt-block">
                  <pre>${JSON.stringify(data.safety_review, null, 2)}</pre>
                </div>
              </details>`
            : nothing}
          ${data?.naming
            ? html`<details
                class="prompt-details prompt-section conversation-name-capture"
              >
                <summary>
                  ${disclosureCaret}Conversation
                  name${data.naming.title ? ` · ${data.naming.title}` : ""}
                </summary>
                <div class="prompt-block">
                  <pre>${JSON.stringify(data.naming, null, 2)}</pre>
                </div>
              </details>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}
