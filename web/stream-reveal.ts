// Buffers live text into paragraph chunks with a size cap. Short tails reveal
// whole words on ingest and make progress every tick; completion flushes fast.
// Caller owns timers/DOM; chunking is plain text.

export const STREAM_REVEAL_MAX_CHARS = 400;
export const STREAM_REVEAL_MS = 500;

export interface StreamRevealState {
  received: string;
  shown: string;
  settled: boolean;
}

export function createStreamReveal(): StreamRevealState {
  return { received: "", shown: "", settled: false };
}

export interface StreamRevealOptions {
  completed?: boolean;
  reducedMotion?: boolean;
  instant?: boolean;
}

export interface StreamRevealResult {
  display: string;
  changed: boolean;
  pending: number;
  settled: boolean;
}

const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
const LEADING_BLANKS = /^[ \t]*(?:\r?\n)+/;

// Past blank-ish leading lines (a separator's leftover whitespace), but never
// a content line's indentation: the match must end in a newline.
function skipBlankLines(text: string, from: number): number {
  const leading = LEADING_BLANKS.exec(
    text.slice(from, from + STREAM_REVEAL_MAX_CHARS + 8),
  );
  return leading ? from + leading[0].length : from;
}

// End (exclusive) of the progressive word reveal starting at `from`: just
// past the last whitespace, so complete words show while the tail streams.
// Returns -1 when nothing new completes a word (e.g. a single partial word).
function findProgressEnd(text: string, from: number): number {
  if (from >= text.length) return -1;
  let end = -1;
  for (let i = text.length - 1; i > from; i--) {
    const ch = text[i - 1];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      end = i;
      break;
    }
  }
  if (end <= from) return -1;
  // Invariant: Never flash whitespace alone: a leading indent waits for its
  // word.
  if (!/\S/.test(text.slice(from, end))) return -1;
  return end;
}

// End (exclusive) of one chunk starting at `from`, or -1 when the tail should
// stay buffered: nothing complete yet (short of a blank line and the cap).
function findChunkEnd(text: string, from: number): number {
  const start = skipBlankLines(text, from);
  if (start >= text.length) return -1;
  const window = text.slice(start, start + STREAM_REVEAL_MAX_CHARS + 1);
  const blank = BLANK_LINE.exec(window);
  if (blank && blank.index <= STREAM_REVEAL_MAX_CHARS) {
    const firstBreak = blank[0].startsWith("\r\n") ? 2 : 1;
    return start + blank.index + firstBreak;
  }
  if (text.length - start <= STREAM_REVEAL_MAX_CHARS) return -1;
  const cap = text.slice(start, start + STREAM_REVEAL_MAX_CHARS);
  const newline = cap.lastIndexOf("\n");
  if (newline > 0) return start + newline + 1;
  const space = Math.max(cap.lastIndexOf(" "), cap.lastIndexOf("\t"));
  if (space > 0) return start + space + 1;
  return start + STREAM_REVEAL_MAX_CHARS;
}

export function ingestStreamReveal(
  state: StreamRevealState,
  fullText: string,
  opts: StreamRevealOptions = {},
): StreamRevealResult {
  const { completed = false, reducedMotion = false, instant = false } = opts;
  const prevReceived = state.received;
  state.received = fullText;
  if (completed) state.settled = true;
  else if (state.settled && fullText !== prevReceived) {
    // Invariant: A new live message after the previous one completed: reveal
    // from head.
    state.settled = false;
    state.shown = "";
  }
  if (!fullText.startsWith(state.shown)) {
    // Invariant: Shrunk text clamps; rewritten text (a new message, a
    // correction) restarts the reveal from its head.
    state.shown = state.shown.startsWith(fullText) ? fullText : "";
  }
  if (instant || reducedMotion || state.settled) {
    const changed = state.shown !== fullText;
    state.shown = fullText;
    return {
      display: state.shown,
      changed,
      pending: 0,
      settled: state.settled,
    };
  }
  const prevShown = state.shown;
  const end = findChunkEnd(fullText, state.shown.length);
  if (end > state.shown.length) state.shown = fullText.slice(0, end);
  else {
    // Invariant: No paragraph/chunk boundary yet: show complete words anyway so
    // a short single-paragraph reply paints while it streams.
    const progress = findProgressEnd(fullText, state.shown.length);
    if (progress > state.shown.length)
      state.shown = fullText.slice(0, progress);
  }
  return {
    display: state.shown,
    changed: state.shown !== prevShown,
    pending: Math.max(0, fullText.length - state.shown.length),
    settled: state.settled,
  };
}

// Releases one chunk per tick, or the whole remaining boundary-less tail.
// Always makes progress so short or partial-word replies cannot stay blank.
export function advanceStreamReveal(state: StreamRevealState): boolean {
  if (state.settled) return false;
  if (state.shown.length >= state.received.length) return false;
  const end = findChunkEnd(state.received, state.shown.length);
  state.shown = state.received.slice(
    0,
    end > state.shown.length ? end : state.received.length,
  );
  return true;
}

export interface LiveRevealPlan {
  instant: boolean;
  // Chunked text when animating; the full text when instant.
  display: string;
  // Unrevealed characters; arms the paragraph timer while positive.
  pending: number;
}

export function planLiveReveal(
  reveal: StreamRevealState,
  content: string,
  instant: boolean,
): LiveRevealPlan {
  const res = ingestStreamReveal(
    reveal,
    content,
    instant ? { instant: true } : {},
  );
  if (instant || res.settled)
    return { instant: true, display: content, pending: res.pending };
  return { instant: false, display: res.display, pending: res.pending };
}

export interface SettledRevealSlot {
  state: StreamRevealState;
  settledChunks: string[] | null;
}

export interface SettledRevealPlan {
  instant: boolean;
  full: string;
  chunks: string[];
}

// Plans settle animation only for the first completion or genuine extension.
// Unrelated text flushes normally; repeated idle paints never replay chunks.
export function planSettledReveal(
  slot: SettledRevealSlot,
  full: string,
): SettledRevealPlan | null {
  const received = slot.state.received;
  if (full !== received && !full.startsWith(received)) return null;
  const extended = full !== received;
  const hadPending = pendingRevealChars(slot.state) > 0;
  ingestStreamReveal(slot.state, full, { completed: true });
  if (!slot.settledChunks || extended)
    slot.settledChunks = splitRevealChunks(full);
  if (!extended && !hadPending)
    return { instant: true, full, chunks: slot.settledChunks };
  return { instant: false, full, chunks: slot.settledChunks };
}

// Show everything at once: completion fast-forward, reduced motion, or a
// thread rebuild / conversation switch that must not replay the queue.
export function flushStreamReveal(
  state: StreamRevealState,
  fullText?: string,
): string {
  if (fullText !== undefined) state.received = fullText;
  state.shown = state.received;
  state.settled = true;
  return state.shown;
}

export function pendingRevealChars(state: StreamRevealState): number {
  return Math.max(0, state.received.length - state.shown.length);
}

// Split shown text into its chunk pieces for one animated element each. The
// final partial tail always forms its own chunk so completion can mark it.
export function splitRevealChunks(display: string): string[] {
  const chunks: string[] = [];
  let from = skipBlankLines(display, 0);
  while (from < display.length) {
    let end = findChunkEnd(display, from);
    if (end < 0) end = display.length;
    if (end <= from) break;
    const chunk = display.slice(from, end);
    if (chunk.trim()) chunks.push(chunk);
    from = skipBlankLines(display, end);
  }
  return chunks;
}
