// Owns generation-scoped, bounded response and tool-series expansion state.
// Startup supplies live reads and actions. Folding never clears
// ToolDetailStore or refetches loaded payloads.

import { state } from "../state.js";
import {
  activityEntryKeys,
  blockSections,
  turnGroupBlocks,
  turnGroups,
  type TurnGroup,
} from "../thread-render/turn-groups.js";
import {
  boundaryDisclosureKey,
  boundaryHasHiddenActivity,
  type ActivityBoundary,
  type ActivitySlice,
} from "../thread-render/activity-boundary.js";
import {
  messageDisclosures,
  messageDisclosureIdentity,
} from "./message-disclosure.js";
import { anchoredPaint, paint } from "../thread-render/index.js";
import { isAgentActivityMessage } from "../thread-render/turn-view.js";
import type { MessageEntry, Turn } from "../types.js";

interface DisclosureReadState {
  readonly loaded: Turn[];
  readonly loadingOlder: boolean;
  readonly renderedConvId: string | null;
  readonly renderedLogGeneration: number;
  readonly topCursor: number;
}
let thread: DisclosureReadState;
let loadOlder: (fill: boolean) => Promise<void>;
// Keep the read view live: async guards must reread it after a page settles.
export function configureDisclosure(
  reads: DisclosureReadState,
  older: typeof loadOlder,
): void {
  thread = reads;
  loadOlder = older;
}

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
  return boundaryDisclosureKey(cid, thread.renderedLogGeneration, boundary);
}
function activityBoundaryOpen(
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
  const cursor = thread.topCursor;
  await backfillOldestBoundary(cid, boundary.key);
  const conv = state.currentConv;
  const covered = expandedAllBlocks.get(identity);
  if (!anchor || !covered || conv?.id !== cid || thread.topCursor === cursor)
    return;
  const next = turnGroupBlocks(thread.loaded, parent).find((block) =>
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
        ? `shell-notice:${thread.renderedLogGeneration}:${entry.offset}`
        : isAgentActivityMessage(entry)
          ? `agent:${thread.renderedLogGeneration}:${messageDisclosureIdentity(entry)}`
          : `notice:${thread.renderedLogGeneration}:${entry.offset}`;
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
export function renderedMessageEntries(): MessageEntry[] {
  return thread.loaded.flatMap((turn) =>
    turn.segments.flatMap((segment) => [
      ...segment.user,
      ...(segment.assistant?.content ? [segment.assistant] : []),
    ]),
  );
}

/** Opens the folds hiding a loaded message; false when it is not loaded. */
export function revealRowMessage(cid: string, wanted: string): boolean {
  const generation = thread.renderedLogGeneration;
  const turn = thread.loaded.find((candidate) =>
    candidate.segments.some(
      (segment) =>
        segment.user.some((entry) => entry.id === wanted) ||
        segment.assistant?.id === wanted,
    ),
  );
  if (!turn) return false;
  const block = turnGroupBlocks(
    thread.loaded,
    state.currentConv?.parent ?? null,
  ).find((candidate) => candidate.slices.some((slice) => slice.turn === turn));
  if (block && boundaryHasHiddenActivity(block)) {
    revealActivityBoundary(cid, block);
    const inner = block.wakeTurns?.find((unit) =>
      unit.slices.some((slice) => slice.turn === turn),
    );
    if (inner) revealActivityBoundary(cid, inner);
  }
  const entry = renderedMessageEntries().find(
    (candidate) => candidate.id === wanted,
  );
  if (entry?.kind === "user" && isAgentActivityMessage(entry)) {
    const identity = `agent:${generation}:${messageDisclosureIdentity(entry)}`;
    if (!messageDisclosures.isOpen(cid, identity))
      messageDisclosures.toggle(cid, identity);
  }
  return true;
}
export async function backfillOldestBoundary(
  cid: string,
  boundaryKey: string,
  group: TurnGroup | null = null,
): Promise<void> {
  // Invariant: Backfill is one guarded page per tap, never a loop/focus move.
  // Reassert expansion only on the boundary holding the original activity; a
  // miss stays closed, and an in-flight close wins.
  if (thread.topCursor <= 0 || thread.loadingOlder) return;
  if (!state.currentConv || state.currentConv.id !== cid) return;
  if (cid !== thread.renderedConvId) return;
  const parent = state.currentConv.parent ?? null;
  const first = turnGroupBlocks(thread.loaded, parent).at(0);
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
  const generation = thread.renderedLogGeneration;
  await loadOlder(false);
  if (
    state.currentConv?.id !== cid ||
    generation !== thread.renderedLogGeneration
  )
    return;
  if (
    group
      ? activityGroupOverrides.get(openIdentity) !== true
      : !expandedActivityBoundaries.has(openIdentity)
  )
    return;
  if (first && outerGroup && !activityGroupOpen(cid, first, outerGroup)) return;
  const blocks = turnGroupBlocks(thread.loaded, parent);
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
