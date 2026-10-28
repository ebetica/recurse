// Owns whole-turn older pages, row jumps and viewport filling, not rendering.
// Pages never split turns; thread.ts paints after hidden targets expand.

import { state } from "../state.js";
import { msgsEl, scrollEl } from "../dom.js";
import {
  isDeletingConversation,
  loadOlderRows,
  loaded,
  loadingOlder,
  renderedConvId,
  renderedLogGeneration,
  rowThreadOlder,
  rowThreads,
  topCursor,
} from "../row-thread-state.js";
import { rowIdFromMessageId } from "../row-thread-state/row-thread.js";
import { boundaryHasHiddenActivity } from "../thread-render/activity-boundary.js";
import { turnGroupBlocks } from "../thread-render/turn-groups.js";
import { revealActivityBoundary } from "./disclosure.js";
import { paint, releaseBottomFollow } from "./thread.js";
import { messageDisclosures } from "../thread-render.js";
import { messageDisclosureIdentity } from "./message-disclosure.js";
import { isAgentActivityMessage } from "../thread-render/turn-view.js";

export async function loadOlder(fill = true): Promise<void> {
  if (loadingOlder || !scrollEl.clientHeight || !scrollEl.clientWidth) return;
  const conv = state.currentConv;
  if (!conv || conv.id !== renderedConvId) return;
  if (isDeletingConversation(conv.id)) return;
  if (rowThreadOlder.get(conv.id) === false) return;
  await loadOlderRows(conv, fill);
}

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
  if (nextVisibleMessage && !renderedEntries().some((e) => e.id === wanted)) {
    const rows = rowThreads.get(cid)!.rows;
    const cut = rows.findIndex((row) => row.id === rowId);
    const visible = new Set(renderedEntries().map((entry) => entry.id));
    const target = rows.slice(cut).find((row) => visible.has(`row:${row.id}`));
    if (target) wanted = `row:${target.id}`;
  }
  if (!revealRowMessage(cid, wanted)) return false;
  const conv = state.currentConv;
  if (!conv || conv.id !== cid) return false;
  paint(conv);
  // Invariant: Explicit jumps override bottom-follow queued by paint.
  releaseBottomFollow();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (cid !== state.selectedId || generation !== renderedLogGeneration)
    return false;
  return settleJumpTarget(
    msgsEl.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(wanted)}"]`),
  );
}

function renderedEntries() {
  return loaded.flatMap((turn) =>
    turn.segments.flatMap((segment) => [
      ...segment.user,
      ...(segment.assistant?.content ? [segment.assistant] : []),
    ]),
  );
}

/** Opens the folds hiding a loaded message; false when it is not loaded. */
export function revealRowMessage(cid: string, wanted: string): boolean {
  const generation = renderedLogGeneration;
  const turn = loaded.find((candidate) =>
    candidate.segments.some(
      (segment) =>
        segment.user.some((entry) => entry.id === wanted) ||
        segment.assistant?.id === wanted,
    ),
  );
  if (!turn) return false;
  const block = turnGroupBlocks(loaded, state.currentConv?.parent ?? null).find(
    (candidate) => candidate.slices.some((slice) => slice.turn === turn),
  );
  if (block && boundaryHasHiddenActivity(block)) {
    revealActivityBoundary(cid, block);
    const inner = block.wakeTurns?.find((unit) =>
      unit.slices.some((slice) => slice.turn === turn),
    );
    if (inner) revealActivityBoundary(cid, inner);
  }
  const entry = renderedEntries().find((candidate) => candidate.id === wanted);
  if (entry?.kind === "user" && isAgentActivityMessage(entry)) {
    const identity = `agent:${generation}:${messageDisclosureIdentity(entry)}`;
    if (!messageDisclosures.isOpen(cid, identity))
      messageDisclosures.toggle(cid, identity);
  }
  return true;
}

const jumpHighlightTimers = new WeakMap<
  HTMLElement,
  ReturnType<typeof setTimeout>
>();

function settleJumpTarget(target: HTMLElement | null, focus = true): boolean {
  if (!target) return false;
  // Invariant: A repeat jump starts a fresh highlight; the earlier removal must
  // not win.
  clearTimeout(jumpHighlightTimers.get(target));
  target.tabIndex = -1;
  target.classList.add("file-jump-target");
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  (
    target.querySelector<HTMLElement>(".compacted-head") ?? target
  ).scrollIntoView({
    block: "center",
    behavior,
  });
  if (focus) target.focus({ preventScroll: true });
  jumpHighlightTimers.set(
    target,
    setTimeout(() => {
      jumpHighlightTimers.delete(target);
      target.classList.remove("file-jump-target");
      target.removeAttribute("tabindex");
    }, 1800),
  );
  return true;
}

// Fill until scrollable or at log start; one turn may leave no scroll-up path.
let fillFrame = 0;
export function fillViewport(): void {
  if (fillFrame) return;
  fillFrame = requestAnimationFrame(() => {
    fillFrame = 0;
    const height = scrollEl.clientHeight;
    if (
      topCursor > 0 &&
      height > 0 &&
      scrollEl.clientWidth > 0 &&
      scrollEl.scrollHeight <= height + 1
    )
      void loadOlder();
  });
}
