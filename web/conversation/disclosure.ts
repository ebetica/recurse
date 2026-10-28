// Owns generation-scoped, bounded response and tool-series expansion state and
// live-tail reveal buffers; thread.ts paints, navigation.ts backfills. Folding
// never clears ToolDetailStore or refetches loaded payloads.

import { state } from "../state.js";
import {
  activityEntryKeys,
  blockSections,
  turnGroupBlocks,
  turnGroups,
  type TurnGroup,
} from "../thread-render/turn-groups.js";
import { anchoredPaint, paint } from "./thread.js";
import {
  boundaryDisclosureKey,
  type ActivityBoundary,
  type ActivitySlice,
} from "../thread-render/activity-boundary.js";
import {
  loaded,
  loadingOlder,
  renderedConvId,
  renderedLogGeneration,
  rowThreads,
  topCursor,
} from "../row-thread-state.js";
import { pruneCaches, threadHasLive } from "../row-thread-state/row-thread.js";
import { loadOlder } from "./navigation.js";
import { enrich, messageDisclosures } from "../thread-render.js";
import { messageDisclosureIdentity } from "./message-disclosure.js";
import type { ScrollAnchorRow } from "./scroll-anchor.js";
import {
  advanceStreamReveal,
  createStreamReveal,
  flushStreamReveal,
  ingestStreamReveal,
  pendingRevealChars,
  planLiveReveal,
  planSettledReveal,
  splitRevealChunks,
  STREAM_REVEAL_MS,
  type StreamRevealState,
} from "../stream-reveal.js";
import {
  isAgentActivityMessage,
  isNoticeOnlyAssistant,
  visibleAssistant,
} from "../thread-render/turn-view.js";
import type { Conversation, MessageEntry } from "../types.js";

const MAX_EXPANDED_TURNS = 256;
const MAX_TOOL_SERIES_STATES = 512;
export const expandedActivityBoundaries = new Set<string>();
export const expandedToolSeries = new Set<string>();
const activityGroupOverrides = new Map<string, boolean>();

function groupIdentity(
  cid: string,
  boundary: ActivityBoundary,
  group: TurnGroup,
): string {
  return `${activityBoundaryKey(cid, boundary)}:group:${group.key}`;
}

export function activityGroupOpen(
  cid: string,
  boundary: ActivityBoundary,
  group: TurnGroup,
): boolean {
  return (
    activityGroupOverrides.get(groupIdentity(cid, boundary, group)) ??
    activityBoundaryOpen(cid, boundary)
  );
}

function clearGroupOverrides(identity: string): void {
  for (const key of activityGroupOverrides.keys())
    if (key.startsWith(`${identity}:group:`))
      activityGroupOverrides.delete(key);
}

function setActivityGroupOpen(
  cid: string,
  boundary: ActivityBoundary,
  group: TurnGroup,
  opening: boolean,
): void {
  const identity = groupIdentity(cid, boundary, group);
  activityGroupOverrides.delete(identity);
  if (activityGroupOverrides.size >= MAX_TOOL_SERIES_STATES)
    activityGroupOverrides.delete(activityGroupOverrides.keys().next().value!);
  activityGroupOverrides.set(identity, opening);
}
export function toggleActivityGroup(
  cid: string,
  boundary: ActivityBoundary,
  group: TurnGroup,
  anchor: HTMLElement,
): void {
  const opening = !activityGroupOpen(cid, boundary, group);
  setActivityGroupOpen(cid, boundary, group, opening);
  if (state.currentConv) anchoredPaint(state.currentConv, anchor);
  if (opening) void backfillOldestBoundary(cid, boundary.key, group);
}
// Range eyes open activity, not the compaction marker's own summary.
export const compactionSummarySuppressed = new Set<string>();
function boundedAdd(values: Set<string>, value: string, limit: number): void {
  if (values.has(value)) values.delete(value);
  while (values.size >= limit) {
    const oldest = values.values().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  values.add(value);
}
export function activityBoundaryKey(
  cid: string,
  boundary: ActivityBoundary,
): string {
  return boundaryDisclosureKey(cid, renderedLogGeneration, boundary);
}

function structuralDisclosureKey(cid: string, key: string): string {
  return `${cid}:${renderedLogGeneration}:${key}`;
}

export function compactionRangeOpen(
  cid: string,
  keys: readonly string[],
): boolean {
  return (
    keys.length > 0 &&
    keys.every((key) =>
      expandedActivityBoundaries.has(structuralDisclosureKey(cid, key)),
    )
  );
}
export function activityBoundaryOpen(
  cid: string,
  boundary: ActivityBoundary,
): boolean {
  return expandedActivityBoundaries.has(activityBoundaryKey(cid, boundary));
}
export function toolSeriesKey(
  cid: string,
  boundary: ActivityBoundary,
  turnId: string,
  seriesId: string | number,
): string {
  return `${activityBoundaryKey(cid, boundary)}:${turnId}:${seriesId}`;
}
export function toggleToolSeries(
  cid: string,
  boundary: ActivityBoundary,
  slice: ActivitySlice,
  seriesId: string | number = slice.segmentIndex,
  anchor: HTMLElement | null = null,
): void {
  const key = toolSeriesKey(cid, boundary, slice.turn.turn_id, seriesId);
  if (expandedToolSeries.has(key)) expandedToolSeries.delete(key);
  else boundedAdd(expandedToolSeries, key, MAX_TOOL_SERIES_STATES);
  // Invariant: The clicked control keeps its screen position: expanding or
  // collapsing a series above the viewport would otherwise slide the reader's
  // content.
  if (state.currentConv) anchoredPaint(state.currentConv, anchor);
}
// A hidden-chunk press is the eye plus the chunk's own series: the response
// disclosure opens and every series the chunk summarizes expands, in one
// paint. Slices without a rendered toggle take a harmless unused key. The
// oldest-boundary backfill rides along exactly as on an eye press.
export function revealHiddenChunk(
  cid: string,
  boundary: ActivityBoundary,
  slices: ActivitySlice[],
): void {
  const opening = !activityBoundaryOpen(cid, boundary);
  if (opening) revealActivityBoundary(cid, boundary);
  for (const slice of slices)
    boundedAdd(
      expandedToolSeries,
      toolSeriesKey(cid, boundary, slice.turn.turn_id, slice.segmentIndex),
      MAX_TOOL_SERIES_STATES,
    );
  if (state.currentConv) paint(state.currentConv);
  if (opening) void backfillOldestBoundary(cid, boundary.key);
}
const expandedAllBlocks = new Map<string, Set<string>>();
export function syncBlockExpanded(
  cid: string,
  boundary: ActivityBoundary,
): boolean {
  // Invariant: Coverage records sections already opened by Expand all.
  // Later paints open only new arrivals, never manually closed sections.
  const covered = expandedAllBlocks.get(activityBoundaryKey(cid, boundary));
  if (covered) applyBlockSections(cid, boundary, true, covered);
  return Boolean(covered);
}
export function toggleBlockExpandAll(
  cid: string,
  boundary: ActivityBoundary,
  anchor: HTMLElement,
): void {
  const identity = activityBoundaryKey(cid, boundary);
  const opening = !expandedAllBlocks.has(identity);
  expandedAllBlocks.delete(identity);
  if (opening) {
    if (expandedAllBlocks.size >= MAX_EXPANDED_TURNS)
      expandedAllBlocks.delete(expandedAllBlocks.keys().next().value!);
    expandedAllBlocks.set(identity, new Set());
  }
  applyBlockSections(cid, boundary, opening, expandedAllBlocks.get(identity));
  if (state.currentConv) anchoredPaint(state.currentConv, anchor);
  if (opening) void expandOlderPage(cid, boundary);
}
// Opening the oldest loaded block pulls one older page, which can re-key the
// block; its open state moves to the block now holding its first slice.
async function expandOlderPage(
  cid: string,
  boundary: ActivityBoundary,
): Promise<void> {
  const parent = state.currentConv?.parent ?? null;
  const anchor = activityEntryKeys(turnGroups(boundary, parent, true))[0];
  const identity = activityBoundaryKey(cid, boundary);
  const cursor = topCursor;
  await backfillOldestBoundary(cid, boundary.key);
  const conv = state.currentConv;
  const covered = expandedAllBlocks.get(identity);
  if (!anchor || !covered || conv?.id !== cid || topCursor === cursor) return;
  const next = turnGroupBlocks(loaded, parent).find((block) =>
    activityEntryKeys(turnGroups(block, parent, true)).includes(anchor),
  );
  if (!next) return;
  expandedAllBlocks.delete(identity);
  expandedAllBlocks.set(activityBoundaryKey(cid, next), covered);
  paint(conv);
}
function applyBlockSections(
  cid: string,
  boundary: ActivityBoundary,
  opening: boolean,
  covered?: Set<string>,
): void {
  const visit = (key: string, apply: () => void) => {
    if (covered?.has(key)) return;
    covered?.add(key);
    apply();
  };
  const { units, series, messages } = blockSections(
    boundary,
    state.currentConv?.parent ?? null,
  );
  for (const unit of units) {
    const key = activityBoundaryKey(cid, unit);
    visit(`turn:${key}`, () => {
      clearGroupOverrides(key);
      if (opening) revealActivityBoundary(cid, unit);
      else expandedActivityBoundaries.delete(key);
    });
  }
  // Invariant: A chunk renders each series under its own turn or under the
  // chunk.
  for (const slice of series)
    for (const unit of units) {
      const key = toolSeriesKey(
        cid,
        unit,
        slice.turn.turn_id,
        slice.segmentIndex,
      );
      visit(key, () => {
        if (opening)
          boundedAdd(expandedToolSeries, key, MAX_TOOL_SERIES_STATES);
        else expandedToolSeries.delete(key);
      });
    }
  for (const entry of messages) {
    const identity =
      entry.marker === "shell-notice"
        ? `shell-notice:${renderedLogGeneration}:${entry.offset}`
        : isAgentActivityMessage(entry)
          ? `agent:${renderedLogGeneration}:${messageDisclosureIdentity(entry)}`
          : `notice:${renderedLogGeneration}:${entry.offset}`;
    visit(identity, () => {
      if (messageDisclosures.isOpen(cid, identity) !== opening)
        messageDisclosures.toggle(cid, identity);
    });
  }
}
export function revealActivityBoundary(
  cid: string,
  boundary: ActivityBoundary,
): void {
  // Invariant: The keyboard's open-all action must also open runs previously
  // closed by hand. Keep true overrides so its later untoggle preserves manual
  // opens.
  const prefix = `${activityBoundaryKey(cid, boundary)}:group:`;
  for (const [key, open] of activityGroupOverrides)
    if (!open && key.startsWith(prefix)) activityGroupOverrides.delete(key);
  boundedAdd(
    expandedActivityBoundaries,
    activityBoundaryKey(cid, boundary),
    MAX_EXPANDED_TURNS,
  );
}
export function toggleCompactionRange(
  cid: string,
  boundary: ActivityBoundary,
  keys: readonly string[],
  anchor: ScrollAnchorRow | null = null,
): void {
  const identities = keys.map((key) => structuralDisclosureKey(cid, key));
  const opening = !compactionRangeOpen(cid, keys);
  const summaryIdentity = activityBoundaryKey(cid, boundary);
  if (opening)
    boundedAdd(
      compactionSummarySuppressed,
      summaryIdentity,
      MAX_EXPANDED_TURNS,
    );
  else compactionSummarySuppressed.delete(summaryIdentity);
  for (const identity of identities) {
    clearGroupOverrides(identity);
    if (opening)
      boundedAdd(expandedActivityBoundaries, identity, MAX_EXPANDED_TURNS);
    else expandedActivityBoundaries.delete(identity);
  }
  if (state.currentConv) anchoredPaint(state.currentConv, anchor);
  if (opening && keys[0] !== undefined)
    void backfillOldestBoundary(cid, keys[0]);
}

export function toggleActivityBoundary(
  cid: string,
  boundary: ActivityBoundary,
  anchor: HTMLElement | null = null,
): void {
  const identity = activityBoundaryKey(cid, boundary);
  clearGroupOverrides(identity);
  compactionSummarySuppressed.delete(identity);
  const opening = !expandedActivityBoundaries.has(identity);
  if (!opening) expandedActivityBoundaries.delete(identity);
  else revealActivityBoundary(cid, boundary);
  // Invariant: The clicked eye or compacted head keeps its screen position: the
  // repaint inserts or removes content above the viewport while scrollTop
  // stands still, which reads as the viewport jumping away from the click.
  if (state.currentConv) anchoredPaint(state.currentConv, anchor);
  if (opening) void backfillOldestBoundary(cid, boundary.key);
}
export async function backfillOldestBoundary(
  cid: string,
  boundaryKey: string,
  group: TurnGroup | null = null,
): Promise<void> {
  // Invariant: Backfill is one guarded page per tap, never a loop/focus move.
  // Reassert expansion only on the boundary holding the original activity; a
  // miss stays closed, and an in-flight close wins.
  if (topCursor <= 0 || loadingOlder) return;
  if (!state.currentConv || state.currentConv.id !== cid) return;
  if (cid !== renderedConvId) return;
  const parent = state.currentConv.parent ?? null;
  const first = turnGroupBlocks(loaded, parent).at(0);
  const oldest =
    first?.wakeTurns?.find((unit) => unit.key === boundaryKey) ?? first;
  if (!oldest || oldest.key !== boundaryKey) return;
  const outerGroup = first?.wakeTurns
    ? (turnGroups(first, parent)[0] as TurnGroup)
    : null;
  const slice = oldest.slices.at(0);
  if (!slice) return;
  const anchor = group ? activityEntryKeys(group.items)[0] : null;
  if (group && !anchor) return;
  const anchorTurn = slice.turn.turn_id;
  const anchorSegment = slice.segmentIndex;
  // Invariant: A close while the page is in flight cancels the expansion: the
  // latest toggle wins over deferred re-assertion, for a group or the whole
  // boundary.
  const openIdentity = group
    ? groupIdentity(cid, oldest, group)
    : activityBoundaryKey(cid, oldest);
  const generation = renderedLogGeneration;
  await loadOlder(false);
  if (state.currentConv?.id !== cid || generation !== renderedLogGeneration)
    return;
  if (
    group
      ? activityGroupOverrides.get(openIdentity) !== true
      : !expandedActivityBoundaries.has(openIdentity)
  )
    return;
  if (first && outerGroup && !activityGroupOpen(cid, first, outerGroup)) return;
  const blocks = turnGroupBlocks(loaded, parent);
  const candidates = blocks.flatMap((block) =>
    oldest.wakeTurns ? [block] : (block.wakeTurns ?? [block]),
  );
  const next = candidates.find((block) =>
    group
      ? activityEntryKeys(turnGroups(block, parent)).includes(anchor!)
      : block.slices.some(
          (candidate) =>
            candidate.turn.turn_id === anchorTurn &&
            candidate.segmentIndex === anchorSegment,
        ),
  );
  if (next && group) {
    const nextGroup = turnGroups(next, parent).find(
      (item): item is TurnGroup =>
        item.kind === "group" &&
        activityEntryKeys(item.items).includes(anchor!),
    );
    if (nextGroup) {
      activityGroupOverrides.delete(openIdentity);
      setActivityGroupOpen(cid, next, nextGroup, true);
      const container = blocks.find((block) => block.wakeTurns?.includes(next));
      if (container) revealActivityBoundary(cid, container);
    }
  } else if (next) revealActivityBoundary(cid, next);
  if (state.currentConv) paint(state.currentConv);
}
interface RevealSlot {
  state: StreamRevealState;
  generation: number;
  instance: string | null;
  // Retains settled fast-forward chunks across repaints to avoid replay.
  settledChunks: string[] | null;
}
const revealSlots = new Map<string, RevealSlot>();
const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();
const chunkHtmlCache = new Map<string, string>();
const MAX_REVEAL_SLOTS = 100;
const MAX_CHUNK_HTML = 128;
export let liveRevealEntry: MessageEntry | null = null;
export let liveRevealChunks: string[] = [];
export let liveRevealFast = false;
let lastRevealConv: string | null = null;
let revealSwitchInstant = false;

export function cancelRevealTimer(cid: string): void {
  const timer = revealTimers.get(cid);
  if (timer === undefined) return;
  clearTimeout(timer);
  revealTimers.delete(cid);
}

function ensureRevealTimer(cid: string): void {
  if (revealTimers.has(cid)) return;
  revealTimers.set(
    cid,
    setTimeout(() => {
      revealTimers.delete(cid);
      const slot = revealSlots.get(cid);
      const conv = state.currentConv;
      if (!slot || !conv || conv.id !== cid || cid !== state.selectedId) return;
      // Invariant: A tick always releases something while text is buffered (one
      // chunk, else the whole tail), so a quiet stream still paints within a
      // tick; the next server text re-arms through ingest.
      if (advanceStreamReveal(slot.state)) {
        paint(conv);
        if (pendingRevealChars(slot.state) > 0) ensureRevealTimer(cid);
      }
    }, STREAM_REVEAL_MS),
  );
}

function revealSlot(cid: string): RevealSlot {
  let slot = revealSlots.get(cid);
  if (!slot) {
    slot = {
      state: createStreamReveal(),
      generation: renderedLogGeneration,
      instance: rowThreads.get(cid)?.instanceId ?? null,
      settledChunks: null,
    };
    revealSlots.set(cid, slot);
    pruneCaches([revealSlots], MAX_REVEAL_SLOTS, cid);
  }
  return slot;
}

export function enrichChunk(chunk: string): string {
  const key = `${state.currentConv?.id}\0${state.currentConv?.github_repo_url ?? ""}\0${chunk}`;
  let html = chunkHtmlCache.get(key);
  if (html === undefined) {
    html = enrich(chunk, state.currentConv?.github_repo_url ?? null, true);
    if (chunkHtmlCache.size >= MAX_CHUNK_HTML) {
      const oldest = chunkHtmlCache.keys().next().value;
      if (oldest !== undefined) chunkHtmlCache.delete(oldest);
    }
    chunkHtmlCache.set(key, html);
  }
  return html;
}

// Decide what this paint shows for the live tail. Runs before every render;
// ingesting is idempotent, so toggle repaints advance nothing.
export function prepareLiveReveal(conv: Conversation): void {
  liveRevealEntry = null;
  liveRevealChunks = [];
  liveRevealFast = false;
  if (conv.id !== lastRevealConv) {
    if (lastRevealConv !== null) cancelRevealTimer(lastRevealConv);
    lastRevealConv = conv.id;
    revealSwitchInstant = true;
  }
  const slot = revealSlot(conv.id);
  const instance = rowThreads.get(conv.id)?.instanceId ?? null;
  const instant =
    revealSwitchInstant ||
    slot.generation !== renderedLogGeneration ||
    slot.instance !== instance;
  revealSwitchInstant = false;
  slot.generation = renderedLogGeneration;
  slot.instance = instance;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const last = loaded[loaded.length - 1];
  const tail =
    conv.status === "running" && last?.open && !last.system
      ? (last.segments[last.segments.length - 1]?.assistant ?? null)
      : null;
  // Invariant: Only genuinely streaming rows use reveal buffers. Settled text
  // behind running work renders instantly, never replays.
  const heldRows = rowThreads.get(conv.id)?.rows;
  const streaming = heldRows === undefined || threadHasLive(heldRows);
  const live = !reduced && streaming && tail ? visibleAssistant(tail) : null;
  if (live && !isNoticeOnlyAssistant(live) && (live.content || "").trim()) {
    const plan = planLiveReveal(slot.state, live.content, instant);
    if (plan.pending > 0) ensureRevealTimer(conv.id);
    else cancelRevealTimer(conv.id);
    slot.settledChunks = null;
    // Invariant: A completed message re-ingested while the agent keeps running
    // (a status flip, a pending row, the next poll) already revealed: render it
    // instantly instead of replaying the stream animation.
    if (plan.instant) return;
    liveRevealEntry = live;
    liveRevealChunks = splitRevealChunks(plan.display);
    return;
  }
  cancelRevealTimer(conv.id);
  if (reduced || instant) {
    if (live) ingestStreamReveal(slot.state, live.content, { instant: true });
    else flushStreamReveal(slot.state);
    slot.settledChunks = null;
    return;
  }
  if (
    !live &&
    slot.state.received !== "" &&
    (pendingRevealChars(slot.state) > 0 || slot.settledChunks)
  ) {
    const settled =
      last && !last.system
        ? visibleAssistant(
            last.segments[last.segments.length - 1]?.assistant ?? null,
          )
        : null;
    if (settled) {
      // Invariant: A settle paint can extend buffered text and fast-forward it.
      // Only transitions or genuine extensions animate; idle repaints never
      // replay.
      const full = settled.content || "";
      const plan = planSettledReveal(slot, full);
      if (!plan) {
        flushStreamReveal(slot.state);
        slot.settledChunks = null;
      } else if (!plan.instant) {
        liveRevealEntry = settled;
        liveRevealChunks = plan.chunks;
        liveRevealFast = true;
      }
    } else {
      flushStreamReveal(slot.state);
      slot.settledChunks = null;
    }
  }
}
