// Buffers and reveals the streaming tail for the current row-thread paint.
import { state } from "../state.js";
import {
  isNoticeOnlyAssistant,
  paint,
  visibleAssistant,
} from "../thread-render/index.js";
import type { Conversation, MessageEntry, Turn } from "../types.js";
import { pruneCaches, threadHasLive, type RowThread } from "./row-thread.js";
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

interface RevealSlot {
  state: StreamRevealState;
  generation: number;
  instance: string | null;
  // Retains settled fast-forward chunks across repaints to avoid replay.
  settledChunks: string[] | null;
}
const revealSlots = new Map<string, RevealSlot>();
const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_REVEAL_SLOTS = 100;
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

function revealSlot(
  cid: string,
  generation: number,
  instance: string | null,
): RevealSlot {
  let slot = revealSlots.get(cid);
  if (!slot) {
    slot = {
      state: createStreamReveal(),
      generation,
      instance,
      settledChunks: null,
    };
    revealSlots.set(cid, slot);
    pruneCaches([revealSlots], MAX_REVEAL_SLOTS, cid);
  }
  return slot;
}

// Decide what this paint shows for the live tail. Runs before every render;
// ingesting is idempotent, so toggle repaints advance nothing.
export function prepareLiveReveal(
  conv: Conversation,
  loaded: readonly Turn[],
  generation: number,
  held: RowThread | undefined,
): void {
  liveRevealEntry = null;
  liveRevealChunks = [];
  liveRevealFast = false;
  if (conv.id !== lastRevealConv) {
    if (lastRevealConv !== null) cancelRevealTimer(lastRevealConv);
    lastRevealConv = conv.id;
    revealSwitchInstant = true;
  }
  const instance = held?.instanceId ?? null;
  const slot = revealSlot(conv.id, generation, instance);
  const instant =
    revealSwitchInstant ||
    slot.generation !== generation ||
    slot.instance !== instance;
  revealSwitchInstant = false;
  slot.generation = generation;
  slot.instance = instance;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const last = loaded[loaded.length - 1];
  const tail =
    conv.status === "running" && last?.open && !last.system
      ? (last.segments[last.segments.length - 1]?.assistant ?? null)
      : null;
  // Invariant: Only genuinely streaming rows use reveal buffers. Settled text
  // behind running work renders instantly, never replays.
  const heldRows = held?.rows;
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
