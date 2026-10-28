// Projects stable-keyed turn disclosure without nested eyes. First/last replies
// stay visible; tools/intermediate prose group together. Opened groups keep
// message/tool summaries independently collapsible.
import {
  compactionActivityBlocks,
  type ActivityBoundary,
  type ActivitySlice,
  type ActivityMarker,
} from "./activity-boundary.js";
import {
  isAgentActivityMessage,
  isNoticeOnlyAssistant,
  isPlatformInterruption,
  visibleAssistant,
  toolSeriesSummary,
} from "./turn-view.js";
import { hasUserAttachments } from "./user-bubble.js";
import type {
  AgentAttachment,
  MessageEntry,
  ToolEntry,
  Turn,
} from "../types.js";

export type TurnGroupItem =
  | { kind: "users"; entries: MessageEntry[] }
  | { kind: "tools"; slice: ActivitySlice }
  | { kind: "thought"; entry: MessageEntry }
  | { kind: "assistant"; entry: MessageEntry }
  | { kind: "attachments"; items: AgentAttachment[] }
  | ActivityMarker
  | TurnGroup
  | {
      kind: "turn";
      boundary: ActivityBoundary;
      visibleReply?: MessageEntry;
      previewOf?: TurnGroup;
    };

export interface TurnGroup {
  kind: "group";
  key: string;
  items: TurnGroupItem[];
  line: string;
  // Visible items between hidden endpoints render once, in entry order.
  shown?: TurnGroupItem[];
  body?: TurnGroupItem[];
}

// Source identities, independent of a partial turn's provisional boundary key.
export function activityEntryKeys(items: readonly TurnGroupItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === "group") return activityEntryKeys(item.items);
    if (item.kind === "turn")
      return activityEntryKeys(turnGroups(item.boundary, null, true));
    if (isShellNotice(item)) return [item.key];
    if (item.kind === "tools")
      return item.slice.segment.tools.map(
        (tool) => `tool:${tool.call_id ?? tool.offset}`,
      );
    const entries =
      item.kind === "users"
        ? item.entries
        : item.kind === "assistant" || item.kind === "thought"
          ? [item.entry]
          : [];
    return entries.map((entry) => `message:${entry.id ?? entry.offset}`);
  });
}

// A background shell's completion notice folds like a tool run.
const isShellNotice = (item: TurnGroupItem): item is ActivityMarker =>
  item.kind === "marker" && item.turn.system?.marker === "shell-notice";

export function groupSummary(items: readonly TurnGroupItem[]): string {
  const counts = { agents: 0, platform: 0, replies: 0 };
  let words = 0;
  let shells = 0;
  const tools: ToolEntry[] = [];
  const visit = (item: TurnGroupItem): void => {
    switch (item.kind) {
      case "group":
        item.items.forEach(visit);
        break;
      case "turn":
        turnGroups(item.boundary, null, true).forEach((part) => {
          if (part.kind === "thought" && part.entry.live_thinking) return;
          if (part.kind !== "assistant" || part.entry !== item.visibleReply)
            visit(part);
        });
        break;
      case "users":
        for (const entry of item.entries) {
          if (isPlatformInterruption(entry)) counts.platform += 1;
          else counts.agents += 1;
        }
        break;
      case "assistant": {
        const text = item.entry.content.trim();
        if (text) {
          counts.replies += 1;
          words += text.split(/\s+/u).length;
        }
        break;
      }
      case "tools":
        tools.push(...item.slice.segment.tools);
        break;
      case "thought":
        break;
      case "marker":
        if (isShellNotice(item)) shells += 1;
        break;
    }
  };
  items.forEach(visit);
  const finished = shells
    ? `${shells} background shell${shells === 1 ? "" : "s"} finished`
    : "";
  const toolSummary = [
    toolSeriesSummary({ tools, user: [], assistant: null, summary: null }),
    finished,
  ]
    .filter(Boolean)
    .join(", ");
  const messageSummary = [
    [counts.agents, "agent message"],
    [counts.platform, "platform note"],
  ]
    .filter(([count]) => count)
    .map(
      ([count, noun, plural]) =>
        `${count} ${count === 1 ? noun : (plural ?? `${noun}s`)}`,
    )
    .join(" · ");
  const replySummary = counts.replies
    ? `${counts.replies} ${counts.replies === 1 ? "reply" : "replies"}, ${words < 10 ? words : Math.round(words / 10) * 10} words hidden`
    : "";
  const messages = [messageSummary, replySummary].filter(Boolean).join(" · ");
  return [
    messages,
    messages
      ? toolSummary.replace(/^./, (letter) => letter.toLowerCase())
      : toolSummary,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Only completed reply content decides whether a question remains visible.
export function finalLineQuestion(content: string): boolean {
  let fence: string | null = null;
  let last = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
    } else if (!fence && trimmed) last = trimmed;
  }
  return last.endsWith("?");
}

// Arrival-order chunks never acquire a sixth wake-up. Only completed turns
// enter chunks, so a running reply cannot seal a chunk before its final
// question.
export function turnGroupBlocks(
  turns: readonly Turn[],
  parent: string | null,
): ActivityBoundary[] {
  const result: ActivityBoundary[] = [];
  let pending: ActivityBoundary[] = [];
  const flush = () => {
    if (!pending.length) return;
    const first = pending[0];
    result.push({
      ...first,
      key: `chunk:${first.key}`,
      items: pending.flatMap((unit) => unit.items),
      slices: pending.flatMap((unit) => unit.slices),
      usageTurns: pending.flatMap((unit) => unit.usageTurns),
      wakeTurns: pending,
    });
    pending = [];
  };
  const blocks = compactionActivityBlocks(turns).flatMap((boundary) => {
    const marker = boundary.items.find(
      (item): item is ActivityMarker =>
        item.kind === "marker" && item.turn.system?.marker === "compact",
    );
    if (
      !marker ||
      boundary.operatorAnchored ||
      boundary.failOpen ||
      !boundary.leadingAgentMessage ||
      boundary.leadingAgentMessage.from === parent
    )
      return [boundary];
    const { compactionRangeKeys: _range, ...response } = boundary;
    return [
      { ...response, items: boundary.items.filter((item) => item !== marker) },
      {
        ...boundary,
        key: marker.key,
        items: [marker],
        slices: [],
        usageTurns: [],
        leadingAgentMessage: null,
        operatorAnchored: false,
        failOpen: false,
      },
    ];
  });
  for (const boundary of blocks) {
    const ownTurns = [...new Set(boundary.slices.map((slice) => slice.turn))];
    const turn = ownTurns[0];
    const reply = turn?.segments
      .map((part) => visibleAssistant(part.assistant))
      .findLast((entry) => entry && !isNoticeOnlyAssistant(entry));
    const eligible =
      ownTurns.length === 1 &&
      !boundary.operatorAnchored &&
      !boundary.failOpen &&
      boundary.leadingAgentMessage &&
      boundary.leadingAgentMessage.from !== parent &&
      !boundary.items.some((item) => item.kind === "marker") &&
      !turn.partial &&
      turn.status !== "error" &&
      !turn.segments.some((part) =>
        [...part.user, part.assistant].some((entry) => entry?.error),
      ) &&
      !turn.open &&
      !finalLineQuestion(reply?.content ?? "");
    if (!eligible) {
      flush();
      result.push(boundary);
    } else {
      pending.push(boundary);
      if (pending.length === 5) flush();
    }
  }
  flush();
  return result;
}

// Expand-all reaches turns, series, folded inputs and shell notices. Thinking
// stays at its step; assignment/error messages never fold. Inputs retain
// delivery order.
export function blockSections(
  boundary: ActivityBoundary,
  parent: string | null,
): {
  units: ActivityBoundary[];
  series: ActivitySlice[];
  messages: MessageEntry[];
  inputs: number[];
} {
  const slices = boundary.slices;
  return {
    units: [boundary, ...(boundary.wakeTurns ?? [])],
    series: slices.filter((slice) => slice.segment.tools.length),
    messages: [
      ...boundary.items.flatMap((item) =>
        item.kind === "marker" && item.turn.system?.marker === "shell-notice"
          ? [item.turn.system]
          : [],
      ),
      ...slices.flatMap((slice) => {
        const reply = visibleAssistant(slice.segment.assistant);
        return [
          ...slice.segment.user.filter(
            (entry) =>
              isAgentActivityMessage(entry) &&
              entry.from !== parent &&
              !entry.error,
          ),
          ...(reply?.notices?.length ? [reply] : []),
        ];
      }),
    ],
    inputs: slices.flatMap((slice) =>
      slice.segment.user
        .map((entry) => entry.offset)
        .filter((offset) => offset >= 0),
    ),
  };
}

// Inside an opened eye, including wake turns, hidden runs render flat.
export function expandedTurnGroups(
  boundary: ActivityBoundary,
  parent: string | null,
): TurnGroupItem[] {
  const flatten = (items: TurnGroupItem[]): TurnGroupItem[] =>
    items.flatMap((item) =>
      item.kind === "group" ? flatten(item.items) : [item],
    );
  return flatten(turnGroups(boundary, parent, true));
}

export function turnGroups(
  boundary: ActivityBoundary,
  parent: string | null,
  transcriptOrder = false,
): TurnGroupItem[] {
  if (boundary.wakeTurns) {
    const units = boundary.wakeTurns.map((unit) => ({
      boundary: unit,
      items: turnGroups(unit, parent),
    }));
    const preview = units.findLast((unit) =>
      unit.items.some((item) => item.kind === "assistant"),
    );
    const reply = preview?.items.findLast((item) => item.kind === "assistant");
    const items: TurnGroupItem[] = units.map((unit) => ({
      kind: "turn",
      boundary: unit.boundary,
      visibleReply:
        unit === preview && reply?.kind === "assistant"
          ? reply.entry
          : undefined,
    }));
    const group: TurnGroup = {
      kind: "group",
      key: boundary.key,
      items,
      line: groupSummary(items) || "Tool details",
      shown: units.flatMap((unit) =>
        unit.boundary.slices.flatMap((slice): TurnGroupItem[] => {
          const shown: TurnGroupItem[] = [];
          const users = slice.segment.user.filter(hasUserAttachments);
          if (users.length) shown.push({ kind: "users", entries: users });
          const entry = visibleAssistant(slice.segment.assistant);
          if (
            entry?.attachments?.length &&
            !(
              unit === preview &&
              reply?.kind === "assistant" &&
              entry === reply.entry
            )
          )
            shown.push({ kind: "attachments", items: entry.attachments });
          return shown;
        }),
      ),
    };
    return [
      group,
      ...units.flatMap((unit) =>
        unit.items.filter(
          (item) => item.kind === "thought" && item.entry.live_thinking,
        ),
      ),
      ...(preview
        ? [
            {
              kind: "turn" as const,
              boundary: preview.boundary,
              previewOf: group,
            },
          ]
        : []),
    ];
  }
  const result: TurnGroupItem[] = [];
  const replyBounds = new Map<
    Turn,
    {
      first: MessageEntry | null;
      last: MessageEntry | null;
      firstIndex: number;
    }
  >();
  let hidden: TurnGroupItem[] = [];
  let hiddenKey = "";
  const flush = () => {
    if (!hidden.length) return;
    result.push({
      kind: "group",
      key: hiddenKey,
      items: hidden,
      line: groupSummary(hidden) || "Tool details",
    });
    hidden = [];
  };
  const hide = (item: TurnGroupItem, key: string) => {
    if (!hidden.length) hiddenKey = key;
    hidden.push(item);
  };
  const show = (item: TurnGroupItem) => {
    flush();
    result.push(item);
  };
  for (const item of boundary.items) {
    if (item.kind === "marker") {
      if (isShellNotice(item)) hide(item, item.key);
      else show(item);
      continue;
    }
    const { turn, segment } = item;
    // Invariant: Decide against the complete turn, not only the slices on one
    // side of a compaction marker. Otherwise compaction would reveal a middle
    // reply.
    let bounds = replyBounds.get(turn);
    if (!bounds) {
      const replies = turn.segments
        .map((part) => visibleAssistant(part.assistant))
        .filter((entry): entry is MessageEntry =>
          Boolean(entry && !isNoticeOnlyAssistant(entry)),
        );
      const first = replies[0] ?? null;
      bounds = {
        first,
        last: replies.at(-1) ?? null,
        firstIndex: turn.segments.findIndex(
          (part) => visibleAssistant(part.assistant) === first,
        ),
      };
      replyBounds.set(turn, bounds);
    }
    const assistant = visibleAssistant(segment.assistant);
    const { first, last, firstIndex } = bounds;
    const phase =
      assistant === first || !first || item.segmentIndex < firstIndex
        ? "pre"
        : "middle";
    const key = `${turn.turn_id}:${phase}:${item.segmentIndex}`;
    const failed = turn.status === "error";
    const failOpen = boundary.failOpen || failed;
    const visibleUsers = segment.user.filter(
      (entry) =>
        failOpen ||
        !isAgentActivityMessage(entry) ||
        hasUserAttachments(entry) ||
        (parent !== null && entry.from === parent) ||
        Boolean(entry.error),
    );
    const hiddenUsers = segment.user.filter(
      (entry) => !visibleUsers.includes(entry),
    );
    if (visibleUsers.length) show({ kind: "users", entries: visibleUsers });
    if (hiddenUsers.length) hide({ kind: "users", entries: hiddenUsers }, key);
    if (segment.tools.length) {
      const row: TurnGroupItem = { kind: "tools", slice: item };
      if (failed) show(row);
      else hide(row, key);
    }
    const thinking = segment.assistant;
    if (
      thinking &&
      !segment.tools.some(
        (tool) =>
          tool.has_thinking || tool.thinking?.trim() || tool.live_thinking,
      ) &&
      (thinking.has_thinking ||
        thinking.thinking?.trim() ||
        thinking.live_thinking)
    ) {
      const row: TurnGroupItem = { kind: "thought", entry: thinking };
      if (failed || thinking.live_thinking) show(row);
      else hide(row, key);
    }
    if (!assistant) continue;
    const visible =
      failOpen ||
      (item.assistantVisible && (assistant === first || assistant === last)) ||
      Boolean(assistant.error || assistant.notices?.length);
    if (visible) show({ kind: "assistant", entry: assistant });
    else {
      hide({ kind: "assistant", entry: assistant }, key);
      if (assistant.attachments?.length)
        show({ kind: "attachments", items: assistant.attachments });
    }
  }
  flush();
  if (transcriptOrder) return result;
  // Invariant: One row per turn sits where its last hidden activity ends, so
  // the thread reads in entry order: a single-reply turn shows the row above
  // its reply.
  const first = result.findIndex((item) => item.kind === "group");
  if (first < 0) return result;
  const last = result.findLastIndex((item) => item.kind === "group");
  const span = result.slice(first, last + 1);
  const items = span.flatMap((item) =>
    item.kind === "group" ? item.items : [],
  );
  return [
    ...result.slice(0, first),
    {
      kind: "group",
      key: (span[0] as TurnGroup).key,
      items,
      line: groupSummary(items) || "Tool details",
      shown: span.filter((item) => item.kind !== "group"),
      body: span.flatMap((item) =>
        item.kind === "group"
          ? item.items
          : item.kind === "attachments"
            ? []
            : [item],
      ),
    },
    ...result.slice(last + 1),
  ];
}
