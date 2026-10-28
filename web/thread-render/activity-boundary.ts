// Projects trusted input boundaries; agent/platform turns stay separate. Only
// the live segment defers its reply; all other replies remain visible.
// Expansion restores tools and agent-message bodies in transcript order.
import {
  isAgentActivityMessage,
  isAgentMessage,
  isInternalNoticeOnly,
  isNoticeOnlyAssistant,
  isPlatformInterruption,
  type ListedToolSummary,
  summarizeListedTools,
  toolSeriesSummary,
  turnOutcomeLabel,
  visibleAssistant,
} from "./turn-view.js";
import { summaryLine } from "./turn-summary.js";
import type {
  AgentAttachment,
  MessageEntry,
  Turn,
  TurnSegment,
  TurnSummary,
} from "../types.js";

export interface ActivitySlice {
  kind: "slice";
  turn: Turn;
  segment: TurnSegment;
  segmentIndex: number;
  assistantVisible: boolean;
}

export interface ActivityBoundary {
  kind: "boundary";
  key: string;
  items: (ActivitySlice | ActivityMarker)[];
  slices: ActivitySlice[];
  // Completed totals belong only to the last boundary slicing a steered turn.
  usageTurns: Turn[];
  usagePartial: boolean;
  operatorAnchored: boolean;
  leadingAgentMessage: MessageEntry | null;
  failOpen: boolean;
  // Compaction-range disclosure keys; resolved by the disclosure module.
  compactionRangeKeys?: readonly string[];
  // Original per-turn boundaries inside a fixed wake-up chunk.
  wakeTurns?: ActivityBoundary[];
}

export interface ActivityMarker {
  kind: "marker";
  key: string;
  turn: Turn;
}

export type ActivityBlock = ActivityBoundary;

function entryIdentity(entry: MessageEntry): string {
  return entry.id ? `id:${entry.id}` : `offset:${entry.offset}`;
}

function isBoundaryHeaderMessage(entry: MessageEntry): boolean {
  return isAgentMessage(entry) || isPlatformInterruption(entry);
}

function boundaryKey(
  turn: Turn,
  segmentIndex: number,
  operator: MessageEntry | undefined,
): string {
  return operator
    ? `operator:${entryIdentity(operator)}`
    : `activity:${turn.turn_id}:${segmentIndex}`;
}

// Generation-scoped boundary identity survives streaming and settle. Only a new
// operator input or activity turn starts folded.
export function boundaryDisclosureKey(
  conversationId: string,
  generation: number,
  boundary: ActivityBoundary,
): string {
  return `${conversationId}:${generation}:${boundary.key}`;
}

export function activityBlocks(
  turns: readonly Turn[],
  liveReplyTurnId: string | null = null,
  liveReplySegmentIndex: number | null = null,
): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let boundary: ActivityBoundary | null = null;

  const closeBoundary = () => {
    if (!boundary) return;
    blocks.push(boundary);
    boundary = null;
  };

  for (const turn of turns) {
    // Invariant: Agent/platform wakes are separate responses even when they
    // arrive after an operator response. Keep mixed turns (which contain an
    // operator segment) on the existing operator path; Pi treats those as one
    // turn.
    const turnHasOperatorInput = turn.segments.some((segment) =>
      segment.user.some((entry) => !isAgentActivityMessage(entry)),
    );
    const turnHasWakeInput = turn.segments.some((segment) =>
      segment.user.some(isBoundaryHeaderMessage),
    );
    if (turnHasWakeInput && !turnHasOperatorInput) closeBoundary();
    if (turn.system) {
      if (!boundary) {
        boundary = {
          kind: "boundary",
          key: `activity:${turn.turn_id}:marker`,
          items: [],
          slices: [],
          usageTurns: [],
          usagePartial: false,
          operatorAnchored: false,
          leadingAgentMessage: null,
          failOpen: false,
        };
      }
      boundary.items.push({
        kind: "marker",
        key: `marker:${turn.turn_id}`,
        turn,
      });
      continue;
    }
    for (
      let segmentIndex = 0;
      segmentIndex < turn.segments.length;
      segmentIndex += 1
    ) {
      const segment = turn.segments[segmentIndex];
      const operator = segment.user.find(
        (entry) => !isAgentActivityMessage(entry),
      );
      const activityInput = segment.user.some(isAgentActivityMessage);
      if (operator) {
        closeBoundary();
        boundary = {
          kind: "boundary",
          key: boundaryKey(turn, segmentIndex, operator),
          items: [],
          slices: [],
          usageTurns: [],
          usagePartial: false,
          operatorAnchored: true,
          leadingAgentMessage: null,
          failOpen: turn.partial,
        };
      } else if (!boundary) {
        boundary = {
          kind: "boundary",
          key: boundaryKey(turn, segmentIndex, undefined),
          items: [],
          slices: [],
          usageTurns: [],
          usagePartial: false,
          operatorAnchored: false,
          leadingAgentMessage: null,
          // Invariant: With neither a trusted trigger nor preceding loaded
          // context, retain prose because pagination may have cut off its
          // operator input.
          failOpen: turn.partial || !activityInput,
        };
      }

      boundary.leadingAgentMessage ||=
        segment.user.find(isBoundaryHeaderMessage) || null;
      const assistant = visibleAssistant(segment.assistant);
      const noticeOnly = isNoticeOnlyAssistant(assistant);
      // Invariant: Only the segment drawn live defers its reply. Every other
      // reply stays visible across settle and follow-up input.
      const liveDeferred =
        turn.turn_id === liveReplyTurnId &&
        (liveReplySegmentIndex === null ||
          segmentIndex === liveReplySegmentIndex);
      const slice: ActivitySlice = {
        kind: "slice",
        turn,
        segment,
        segmentIndex,
        assistantVisible: noticeOnly || !liveDeferred,
      };
      boundary.items.push(slice);
      boundary.slices.push(slice);
      boundary.failOpen ||= turn.partial;
    }
  }
  closeBoundary();

  // Invariant: Resolve ownership only after presentation boundaries are
  // complete. The last slice wins for a steered backend turn, and the map
  // guarantees that a turn total can never be attached twice after
  // prepend/rerender.
  const owners = new Map<string, { boundary: ActivityBoundary; turn: Turn }>();
  for (const block of blocks) {
    for (const slice of block.slices) {
      owners.set(slice.turn.turn_id, { boundary: block, turn: slice.turn });
    }
  }
  for (const { boundary: owner, turn } of owners.values()) {
    if (!turn.open) owner.usageTurns.push(turn);
  }
  for (const block of blocks) {
    block.usagePartial =
      !block.operatorAnchored ||
      block.failOpen ||
      block.slices.some((slice) => slice.turn.open);
  }
  return blocks;
}

// Splits disclosure at durable compaction points without changing the default
// response projection or pending/failure markers.
export function compactionActivityBlocks(
  turns: readonly Turn[],
  liveReplyTurnId: string | null = null,
  liveReplySegmentIndex: number | null = null,
): ActivityBlock[] {
  const blocks = activityBlocks(turns, liveReplyTurnId, liveReplySegmentIndex);
  const projected = blocks.flatMap((block) => splitCompactionBoundary(block));
  let rangeStart = 0;
  return projected.map((block, index) => {
    const point = block.items.some(
      (item) =>
        item.kind === "marker" && item.turn.system?.marker === "compact",
    );
    if (!point) return block;
    const compactionRangeKeys = projected
      .slice(rangeStart, index + 1)
      .map((candidate) => candidate.key);
    rangeStart = index + 1;
    return { ...block, compactionRangeKeys };
  });
}

function splitCompactionBoundary(boundary: ActivityBoundary): ActivityBlock[] {
  if (
    !boundary.items.some(
      (item) =>
        item.kind === "marker" && item.turn.system?.marker === "compact",
    )
  )
    return [boundary];

  const pieces: ActivityBoundary[] = [];
  let items: (ActivitySlice | ActivityMarker)[] = [];
  let slices: ActivitySlice[] = [];
  let point = 0;
  let afterPoint = false;

  const finish = (key: string): void => {
    if (!items.length) return;
    const turnIds = new Set(slices.map((slice) => slice.turn.turn_id));
    const operatorAnchored = !afterPoint && boundary.operatorAnchored;
    const failOpen = !afterPoint && boundary.failOpen;
    pieces.push({
      ...boundary,
      key,
      items,
      slices,
      usageTurns: boundary.usageTurns.filter((turn) =>
        turnIds.has(turn.turn_id),
      ),
      usagePartial:
        !operatorAnchored ||
        failOpen ||
        slices.some((slice) => slice.turn.open),
      operatorAnchored,
      leadingAgentMessage:
        slices
          .flatMap((slice) => slice.segment.user)
          .find(isBoundaryHeaderMessage) ?? null,
      failOpen,
    });
    items = [];
    slices = [];
  };

  for (const item of boundary.items) {
    items.push(item);
    if (item.kind === "slice") {
      slices.push(item);
      continue;
    }
    if (item.turn.system?.marker !== "compact") continue;
    finish(point === 0 ? boundary.key : `${boundary.key}:compaction:${point}`);
    point += 1;
    afterPoint = true;
  }
  finish(
    point === 0 ? boundary.key : `${boundary.key}:after-compaction:${point}`,
  );
  return pieces;
}

export function boundaryUserEntries(
  boundary: ActivityBoundary,
  slice: ActivitySlice,
  open: boolean,
): MessageEntry[] {
  if (open || boundary.failOpen) return slice.segment.user;
  return slice.segment.user.filter(
    (entry) => isPlatformInterruption(entry) || !isAgentActivityMessage(entry),
  );
}

// A response with any still-open turn is live: the panel speaks instead of
// the summary slot, which stays empty until the turn settles.
export function boundaryIsLive(boundary: ActivityBoundary): boolean {
  return boundary.slices.some((slice) => slice.turn.open);
}

export function boundaryHasHiddenActivity(boundary: ActivityBoundary): boolean {
  // Invariant: A marker-only boundary has its own disclosure (for example, the
  // compacted summary); only count marker activity when it shares a real
  // response slice.
  if (
    boundary.slices.length > 0 &&
    boundary.items.some((item) => item.kind === "marker")
  )
    return true;
  return boundary.slices.some(
    (slice) =>
      (!boundary.failOpen &&
        slice.segment.user.some(
          (entry) =>
            isAgentActivityMessage(entry) && !isPlatformInterruption(entry),
        )) ||
      slice.segment.tools.length > 0 ||
      (slice.segment.summary?.tools || 0) > 0 ||
      Boolean(
        visibleAssistant(slice.segment.assistant) &&
        !slice.assistantVisible &&
        !boundary.failOpen,
      ),
  );
}

const FIELDS = [
  "tools",
  "shell",
  "read_files",
  "edit_files",
  "added",
  "removed",
  "write_files",
  "agents",
  "agent_messages",
  "agent_reaps",
  "searches",
  "web",
  "background_shells",
] as const;

function emptySummary(): TurnSummary {
  return {
    tools: 0,
    shell: 0,
    read_files: 0,
    edit_files: 0,
    added: 0,
    removed: 0,
    write_files: 0,
    agents: 0,
    agent_messages: 0,
    agent_reaps: 0,
    searches: 0,
    web: 0,
    background_shells: 0,
    prs: [],
    pr_links: [],
    truncated: false,
  };
}

export interface BoundarySummary {
  summary: TurnSummary | null;
  incomingAgentMessages: number;
  partial: boolean;
}

function codePointCount(value: unknown): number {
  return typeof value === "string" ? Array.from(value).length : 0;
}

// Count only text controlled by the outer response disclosure. Agent-message,
// platform, and raw tool bodies have their own disclosures; operator input and
// the final reply are always visible.
export function activityCharactersLabel(
  boundary: ActivityBoundary,
  open: boolean,
): string {
  const seen = new Set<string>();
  let characters = 0;
  const add = (key: string, value: unknown) => {
    if (seen.has(key)) return;
    seen.add(key);
    characters += codePointCount(value);
  };
  for (const slice of boundary.slices) {
    for (const entry of slice.segment.user) {
      // Invariant: Notice-only rows fold with their own disclosure; their
      // backend wording is not response prose.
      if (
        isAgentActivityMessage(entry) &&
        !isAgentMessage(entry) &&
        !isPlatformInterruption(entry) &&
        !isInternalNoticeOnly(entry)
      ) {
        add(`message:${entry.offset}`, entry.content);
      }
    }
    const assistant = slice.segment.assistant;
    if (assistant && !slice.assistantVisible && !boundary.failOpen) {
      add(`message:${assistant.offset}`, assistant.content);
    }
  }
  if (!characters) return "";
  const partial = boundary.slices.some((slice) => slice.turn.partial);
  const formatted = new Intl.NumberFormat().format(characters);
  return `${partial ? "At least " : ""}${formatted} character${characters === 1 ? "" : "s"} ${open ? "shown" : "hidden"}`;
}

// Whole-turn summaries are cumulative and authoritative. When steering splits a
// backend turn across boundaries, use its per-segment summaries instead so the
// same activity is never counted twice.
export function boundarySummary(boundary: ActivityBoundary): BoundarySummary {
  const total = emptySummary();
  let found = false;
  let partial = false;
  const incomingAgentMessages = boundary.slices.reduce(
    (count, slice) => count + slice.segment.user.filter(isAgentMessage).length,
    0,
  );
  const byTurn = new Map<Turn, ActivitySlice[]>();
  for (const slice of boundary.slices) {
    const slices = byTurn.get(slice.turn) || [];
    slices.push(slice);
    byTurn.set(slice.turn, slices);
  }
  const summaries: TurnSummary[] = [];
  // Invariant: Settled turns projected without a recorded summary still list
  // their calls: classify those listed rows with the shared row classifier, so
  // the response keeps its per-tool breakdown ("read 2 files") instead of a
  // bare tool count.
  const listed: TurnSummary = emptySummary();
  let listedCalls = 0;
  const mergeListed = (classified: ListedToolSummary): void => {
    if (classified.partial) partial = true;
    listedCalls += classified.calls;
    for (const field of FIELDS) {
      const value = classified.summary[field] || 0;
      if (!value) continue;
      const next = (listed[field] || 0) + value;
      if (!Number.isSafeInteger(next)) {
        partial = true;
        continue;
      }
      (listed as unknown as Record<string, number>)[field] = next;
    }
  };
  for (const [turn, slices] of byTurn) {
    // Invariant: A usage-only summary (reviewer rows with no recorded tool
    // counts) must not replace listed-row classification: it carries no counts.
    if (
      slices.length === turn.segments.length &&
      turn.summary &&
      typeof turn.summary.tools === "number"
    )
      summaries.push(turn.summary);
    else {
      for (const slice of slices) {
        if (slice.segment.summary) summaries.push(slice.segment.summary);
        else {
          partial = true;
          mergeListed(summarizeListedTools(slice.segment.tools));
        }
      }
    }
  }
  if (listedCalls > 0) {
    found = true;
    for (const field of FIELDS) {
      const value = listed[field] || 0;
      if (!value) continue;
      const next = (total[field] || 0) + value;
      if (!Number.isSafeInteger(next)) {
        partial = true;
        continue;
      }
      (total as unknown as Record<string, number>)[field] = next;
    }
  }
  for (const summary of summaries) {
    found = true;
    for (const field of FIELDS) {
      const value = summary[field] || 0;
      const next = (total[field] || 0) + value;
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !Number.isSafeInteger(next)
      ) {
        partial = true;
        continue;
      }
      (total as unknown as Record<string, number>)[field] = next;
    }
    for (const number of summary.prs || []) {
      if (!total.prs.includes(number)) total.prs.push(number);
    }
    for (const link of summary.pr_links || []) {
      if (
        !total.pr_links!.some((existing) => existing.number === link.number)
      ) {
        total.pr_links!.push(link);
      }
    }
    total.truncated ||= summary.truncated;
    total.approx ||= summary.approx;
  }
  // Invariant: Shell-notice markers carry no summary of their own; count them
  // here so the folded footer names them exactly like tool calls.
  const notices = boundary.items.filter(
    (item) =>
      item.kind === "marker" && item.turn.system?.marker === "shell-notice",
  ).length;
  if (notices > 0) {
    found = true;
    total.background_shells = (total.background_shells || 0) + notices;
  }
  return { summary: found ? total : null, incomingAgentMessages, partial };
}

export function seriesRepeatsBoundarySummary(
  boundary: ActivityBoundary,
  totals: BoundarySummary,
): boolean {
  const series = boundary.slices
    .filter((slice) => slice.segment.tools.length > 0)
    .map((slice) => toolSeriesSummary(slice.segment));
  return series.length === 1 && series[0] === summaryLine(totals.summary, 0);
}

export function boundaryDisplayedReply(
  boundary: ActivityBoundary,
): MessageEntry | null {
  // Invariant: Copy prefers the latest settled, fully recorded reply. Ambiguous
  // or live prose cannot outrank it; absent one, use latest visible.
  let runningFallback: MessageEntry | null = null;
  let failOpenFallback: MessageEntry | null = null;
  for (let index = boundary.slices.length - 1; index >= 0; index -= 1) {
    const slice = boundary.slices[index];
    const assistant = visibleAssistant(slice.segment.assistant);
    if (!assistant || isNoticeOnlyAssistant(assistant)) continue;
    if (!slice.assistantVisible) {
      if (boundary.failOpen && !failOpenFallback) failOpenFallback = assistant;
      continue;
    }
    if (!slice.turn.open && !slice.turn.partial) return assistant;
    if (!runningFallback) runningFallback = assistant;
  }
  return runningFallback ?? failOpenFallback;
}

export function boundaryOutcomeLabel(boundary: ActivityBoundary): string {
  const tail = boundary.slices.at(-1)?.turn;
  // Invariant: A turn split by an operator steer belongs to its final boundary.
  // An open automatic continuation is a recovery attempt, not a settled
  // failure.
  return tail && boundary.usageTurns.includes(tail)
    ? turnOutcomeLabel(tail.status)
    : "";
}

export function boundaryContainsOffset(
  boundary: ActivityBoundary,
  offset: number,
): boolean {
  return boundary.items.some((item) =>
    item.kind === "marker"
      ? item.turn.system?.offset === offset
      : item.segment.user.some((entry) => entry.offset === offset) ||
        item.segment.tools.some((entry) => entry.offset === offset) ||
        item.segment.assistant?.offset === offset,
  );
}

export interface VEyePress {
  key: string;
  open: boolean;
}

// Which eyes one v press moves, pure so the toggle/untoggle rule is testable
// without a DOM. Closed eyes open on a fresh press; an active press closes
// only what v opened that is still open — eyes the reader closed by hand
// stay closed instead of reopening.
export function planVEyePress(
  eyes: readonly VEyePress[],
  active: boolean,
  opened: readonly string[],
): string[] {
  if (!active) return eyes.filter((eye) => !eye.open).map((eye) => eye.key);
  const open = new Set(eyes.filter((eye) => eye.open).map((eye) => eye.key));
  return opened.filter((key) => open.has(key));
}

// The compacted block's head toggles the same response disclosure as the
// turn eye, so its accessible name is the one shared decision behind both
// controls. Pure so the copy contract is testable without a DOM.
export function compactedHeadLabel(open: boolean): string {
  return `${open ? "Hide" : "Show"} compacted summary`;
}

// Closed-eye visibility: the one shared decision behind the hidden-chunk
// projection and the renderer's collapsed slices. Platform pills and the
// leading agent message stay visible; they delimit chunks, never counted.
export function closedSliceUsers(
  boundary: ActivityBoundary,
  slice: ActivitySlice,
): MessageEntry[] {
  return boundaryUserEntries(boundary, slice, false);
}

export function isClosedAssistantVisible(
  boundary: ActivityBoundary,
  slice: ActivitySlice,
): boolean {
  return slice.assistantVisible || boundary.failOpen;
}

export function closedSliceAssistant(
  boundary: ActivityBoundary,
  slice: ActivitySlice,
): MessageEntry | null {
  const assistant = visibleAssistant(slice.segment.assistant);
  return assistant && isClosedAssistantVisible(boundary, slice)
    ? assistant
    : null;
}

export type ClosedBoundaryItem =
  | { kind: "users"; slice: ActivitySlice; entries: MessageEntry[] }
  | { kind: "assistant"; slice: ActivitySlice; entry: MessageEntry }
  | { kind: "attachments"; slice: ActivitySlice; items: AgentAttachment[] }
  | { kind: "hidden"; key: string; line: string; slices: ActivitySlice[] }
  | { kind: "marker"; turn: Turn }
  | { kind: "working" };

// Summarizes contiguous hidden runs; trailing runs count only in the footer.
// Uses shared counts and retains slices; only the latest boundary owns live UI.
export function closedBoundaryView(
  boundary: ActivityBoundary,
  isLast = true,
): ClosedBoundaryItem[] {
  const items: ClosedBoundaryItem[] = [];
  let pending: { slice: ActivitySlice; hidden: MessageEntry[] }[] = [];
  let hiddenSeq = 0;
  const flush = (): void => {
    if (!pending.length) return;
    const scoped = pending.map(({ slice, hidden }) => ({
      ...slice,
      segment: { ...slice.segment, user: hidden },
    }));
    const chunk = boundarySummary({ ...boundary, slices: scoped });
    // Invariant: Notices fold into the footer count, never a mid-body chunk
    // line.
    if (chunk.summary) chunk.summary.background_shells = 0;
    const line = summaryLine(chunk.summary, 0);
    if (line)
      items.push({
        kind: "hidden",
        key: `hidden:${hiddenSeq++}`,
        line,
        slices: pending.map(({ slice }) => slice),
      });
    pending = [];
  };
  const emit = (entry: ClosedBoundaryItem): void => {
    flush();
    items.push(entry);
  };
  for (const item of boundary.items) {
    if (item.kind === "marker") {
      // Invariant: A completion notice stays hidden until the eye opens: its
      // count rides the footer, its line renders only in the opened disclosure.
      if (item.turn.system?.marker === "shell-notice") continue;
      emit({ kind: "marker", turn: item.turn });
      continue;
    }
    const slice = item;
    const users = closedSliceUsers(boundary, slice);
    if (users.length) emit({ kind: "users", slice, entries: users });
    if (sliceHasHidden(slice, users)) {
      const shown = new Set(users);
      pending.push({
        slice,
        hidden: slice.segment.user.filter((entry) => !shown.has(entry)),
      });
    }
    const assistant = closedSliceAssistant(boundary, slice);
    if (assistant) emit({ kind: "assistant", slice, entry: assistant });
    else {
      const attachments =
        visibleAssistant(slice.segment.assistant)?.attachments ?? [];
      if (attachments.length)
        emit({ kind: "attachments", slice, items: attachments });
    }
    if (
      isLast &&
      slice.turn.open &&
      slice.segmentIndex === slice.turn.segments.length - 1
    )
      emit({ kind: "working" });
  }
  return items;
}

function sliceHasHidden(
  slice: ActivitySlice,
  visibleUsers: readonly MessageEntry[],
): boolean {
  const shown = new Set(visibleUsers);
  if (slice.segment.user.some((entry) => !shown.has(entry))) return true;
  // Invariant: A hidden live reply carries no counts of its own; settled tools
  // and recorded summaries are the countable activity.
  return (
    slice.segment.tools.length > 0 || (slice.segment.summary?.tools || 0) > 0
  );
}
