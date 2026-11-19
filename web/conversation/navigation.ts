// Owns row/latest jumps and the viewport bindings that request older pages.
// Thread paint follows expansion of hidden jump targets.

import { state } from "../state.js";
import { msgsEl, scrollBtn, scrollEl } from "../dom.js";
import {
  fillViewport,
  loadOlder,
  loadOlderRows,
  loaded,
  loadingOlder,
  renderedConvId,
  renderedLogGeneration,
  rowThreadOlder,
} from "../row-thread-state.js";
import { rowThreads } from "../row-thread-state/index.js";
import { rowIdFromMessageId } from "../row-thread-state/row-thread.js";
import { renderedMessageEntries, revealRowMessage } from "./disclosure.js";
import { followLatestReply, paint, releaseBottomFollow } from "./thread.js";
import {
  jumpThreadScroll,
  queueThreadJump,
  threadJumpAwaited,
} from "./scroll-ledger.js";

// Completion and retained context are different places: resolve the summary's
// boundary, then reuse the row jump to load/reveal/focus the kept message.
export async function jumpToCompactionPoint(
  cid: string,
  noticeId: string,
): Promise<boolean> {
  const generation = renderedLogGeneration;
  let held = rowThreads.get(cid)?.rows.length ?? 0;
  while (
    cid === state.selectedId &&
    cid === renderedConvId &&
    generation === renderedLogGeneration
  ) {
    const rows = rowThreads.get(cid)?.rows ?? [];
    const noticeIndex = rows.findIndex((row) => `row:${row.id}` === noticeId);
    if (noticeIndex < 0) return false;
    const targetId = (
      rows[noticeIndex]?.meta as { summaryEntryId?: unknown } | null
    )?.summaryEntryId;
    const marker =
      typeof targetId === "string"
        ? rows.find((row) => row.id === targetId)
        : rows
            .slice(0, noticeIndex + 1)
            .reverse()
            .find((row) => row.role === "compaction");
    const meta = marker?.meta as {
      firstKeptEntryId?: unknown;
      jumpEntryId?: unknown;
      compact_provisional?: { pointId?: unknown };
    } | null;
    const cut =
      meta?.jumpEntryId ??
      meta?.firstKeptEntryId ??
      meta?.compact_provisional?.pointId;
    if (marker)
      return typeof cut === "string" ? jumpToRowMessage(cid, cut, true) : false;
    if (rowThreadOlder.get(cid) === false) return false;
    const conv = state.currentConv;
    if (!conv || conv.id !== cid) return false;
    await loadOlderRows(conv, false);
    const now = rowThreads.get(cid)?.rows.length ?? 0;
    if (now <= held) return false;
    held = now;
  }
  return false;
}

// Files holds durable byte offsets, not DOM references. Pull bounded older
// pages until that source row is loaded, expand its turn if needed, then focus
// the actual message. Selection/generation changes abort the walk before stale
// data can move focus in another conversation.
export async function jumpToMessage(
  cid: string,
  _offset: number,
  messageId?: string | null,
): Promise<boolean> {
  return jumpToRowMessage(cid, messageId);
}

export async function jumpToFile(
  cid: string,
  fileId: string,
): Promise<boolean> {
  const generation = renderedLogGeneration;
  while (
    cid === state.selectedId &&
    cid === renderedConvId &&
    generation === renderedLogGeneration
  ) {
    const message = loaded
      .flatMap((turn) =>
        turn.segments.flatMap((segment) => [
          ...segment.user,
          ...(segment.assistant ? [segment.assistant] : []),
        ]),
      )
      .find(
        (entry) =>
          entry.attachments?.some((file) => file.id === fileId) ||
          (entry.kind === "user" && entry.content?.includes(fileId)),
      );
    if (message?.id)
      return jumpToRowMessage(cid, message.id.replace(/^row:/, ""));
    const conv = state.currentConv;
    if (!conv || rowThreadOlder.get(cid) === false || loadingOlder)
      return false;
    const before = rowThreads.get(cid)?.rows.length ?? 0;
    await loadOlderRows(conv, false);
    if ((rowThreads.get(cid)?.rows.length ?? 0) <= before) return false;
  }
  return false;
}

// Files-pane jump while the thread renders from rows: page by row cursor
// until the named row is held, then reveal and focus its element exactly
// like the offset walk. Every page advances (or exhausts), so the walk
// cannot loop; selection/generation changes abort it like the offset one.
async function jumpToRowMessage(
  cid: string,
  messageId: string | null | undefined,
  nextVisibleMessage = false,
): Promise<boolean> {
  const rowId = rowIdFromMessageId(messageId);
  if (!rowId) return false;
  let wanted = `row:${rowId}`;
  const generation = renderedLogGeneration;
  let held = rowThreads.get(cid)?.rows.length ?? 0;
  while (!rowThreads.get(cid)?.rows.some((row) => row.id === rowId)) {
    if (
      cid !== state.selectedId ||
      cid !== renderedConvId ||
      generation !== renderedLogGeneration
    )
      return false;
    if (rowThreadOlder.get(cid) === false) return false;
    const conv = state.currentConv;
    if (!conv || conv.id !== cid) return false;
    await loadOlderRows(conv, false);
    const now = rowThreads.get(cid)?.rows.length ?? 0;
    if (now <= held) return false;
    held = now;
  }
  if (
    nextVisibleMessage &&
    !renderedMessageEntries().some((e) => e.id === wanted)
  ) {
    const rows = rowThreads.get(cid)!.rows;
    const cut = rows.findIndex((row) => row.id === rowId);
    const visible = new Set(renderedMessageEntries().map((entry) => entry.id));
    const target = rows.slice(cut).find((row) => visible.has(`row:${row.id}`));
    if (target) wanted = `row:${target.id}`;
  }
  if (!revealRowMessage(cid, wanted)) return false;
  const conv = state.currentConv;
  if (!conv || conv.id !== cid) return false;
  paint(conv);
  // Invariant: Explicit jumps override bottom-follow queued by paint.
  releaseBottomFollow();
  queueThreadJump(true);
  try {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (cid !== state.selectedId || generation !== renderedLogGeneration)
      return false;
    return settleJumpTarget(
      msgsEl.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(wanted)}"]`,
      ),
    );
  } finally {
    queueThreadJump(false);
  }
}

let endJumpHighlight = (): void => {};

// The highlight lasts 1.8 s from when the smooth scroll settles (scrollend),
// or from the jump when nothing scrolls or scrollend is unsupported.
function settleJumpTarget(target: HTMLElement | null, focus = true): boolean {
  if (!target) return false;
  // Invariant: A new or repeat jump ends the earlier highlight, its timer and
  // listener first, so an earlier removal never wins.
  endJumpHighlight();
  target.tabIndex = -1;
  target.classList.add("file-jump-target");
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  const head = target.querySelector<HTMLElement>(".compacted-head") ?? target;
  const aim = () => {
    const box = head.getBoundingClientRect();
    const view = scrollEl.getBoundingClientRect();
    const centred = view.top + (scrollEl.clientHeight - box.height) / 2;
    return scrollEl.scrollTop + box.top - centred;
  };
  let aimed = aim();
  // Invariant: A hold set before the jump starts (a send queued in its frame)
  // would be reapplied mid-jump; the jump overrides it.
  releaseBottomFollow();
  const moves = jumpThreadScroll(aimed, behavior);
  // Invariant: Content above the row can resize mid-jump (images loading);
  // the jump re-aims at the row until it ends.
  const reaim = new ResizeObserver(() => {
    if (!threadJumpAwaited()) return reaim.disconnect();
    if (Math.abs(aim() - aimed) > 1)
      jumpThreadScroll((aimed = aim()), behavior);
  });
  if (moves) reaim.observe(msgsEl, { box: "content-box" });
  if (focus) target.focus({ preventScroll: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = () => {
    scrollEl.removeEventListener("scrollend", settled);
    timer = setTimeout(end, 1800);
  };
  const end = () => {
    reaim.disconnect();
    scrollEl.removeEventListener("scrollend", settled);
    clearTimeout(timer);
    target.classList.remove("file-jump-target");
    target.removeAttribute("tabindex");
    if (endJumpHighlight === end) endJumpHighlight = () => {};
  };
  endJumpHighlight = end;
  if (moves && behavior === "smooth" && "onscrollend" in scrollEl)
    scrollEl.addEventListener("scrollend", settled);
  else settled();
  return true;
}

new ResizeObserver(fillViewport).observe(scrollEl, { box: "content-box" });
scrollEl.addEventListener(
  "scroll",
  () => {
    if (scrollEl.scrollTop < 300) loadOlder();
  },
  { passive: true },
);
export function scrollToLatest(): void {
  followLatestReply();
  jumpThreadScroll(scrollEl.scrollHeight, "smooth");
}
scrollBtn.addEventListener("click", scrollToLatest);
