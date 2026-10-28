// Owns per-agent inline comments, gutter/touch targets and range selection.
// Anchors include file, line and side; text stays outside the Git cache.
// Editors embed by reference so shell repaint cannot steal focus.
import { el } from "../dom.js";
import {
  commentKey,
  commentMessage,
  diffContextMarker,
  type CommentSide,
  type DiffTarget,
} from "./model.js";

export interface Comment {
  group: string;
  path: string;
  side: CommentSide;
  line: number;
  // Range end (same-side number); null for a single line.
  endLine: number | null;
  text: string;
  context?: string[];
  target: DiffTarget;
}

// Per-agent notes survive Git summary refreshes.
export const comments = new Map<string, Map<string, Comment>>();

export function commentMap(scope: string): Map<string, Comment> {
  let m = comments.get(scope);
  if (!m) {
    m = new Map();
    comments.set(scope, m);
  }
  return m;
}

export function setComment(
  scope: string,
  group: string,
  path: string,
  side: CommentSide,
  line: number,
  endLine: number | null,
  text: string,
  target: DiffTarget,
  context: string[] = [],
): void {
  const m = commentMap(scope);
  const key = commentKey(group, path, side, line, endLine);
  text = text.trim();
  if (text) {
    const prior = m.get(key);
    m.set(key, {
      group,
      path,
      side,
      line,
      endLine,
      text,
      context: [...context],
      target: prior ? prior.target : { ...target },
    });
  } else m.delete(key);
}

export function getComment(
  scope: string,
  group: string,
  path: string,
  side: CommentSide,
  line: number,
  endLine: number | null = null,
): string {
  const m = comments.get(scope);
  const c = m && m.get(commentKey(group, path, side, line, endLine));
  return c ? c.text : "";
}

export function pendingCount(scope: string): number {
  const m = comments.get(scope);
  return m ? m.size : 0;
}

// Build the message posted to the agent from all pending comments, ordered
// by file, side, line, then range end.
export function composeMessage(scope: string): string {
  return commentMessage(comments.get(scope)?.values() || []);
}

export interface CommentCtx {
  agentId: string;
  group: string;
  path: string;
  target: DiffTarget;
  onChange: () => void;
  selection: LineSelection;
}

export interface LineSelection {
  // The shift-click anchor: reset whenever a single editor opens.
  remember(side: CommentSide, line: number): void;
  // Drop the highlight (and any open range box); saved text is untouched.
  clear(): void;
  // Re-anchor an open range editor after a redraw (expansion, view toggle).
  restore(): void;
  beginDrag(side: CommentSide, line: number): void;
  extend(side: CommentSide, line: number): void;
  // Finishes release; swallows only clicks generated on the starting number.
  endDrag(
    openSingle: () => void,
    release?: { side: CommentSide; line: number } | null,
  ): void;
  shiftSelect(side: CommentSide, line: number, openSingle: () => void): void;
  // End-row plus dismisses its range box without changing saved text.
  dismissEnd(side: CommentSide, line: number): boolean;
  // Swallows the click already handled by the press/release gesture.
  consumeClick(): boolean;
}

interface CommentScope {
  agentId: string;
  group: string;
  path: string;
  target: DiffTarget;
}

// The node an editor box goes after: a split-view host is the cell, so the
// box must clear the whole two-column row; unified hosts are rows already.
function belowAnchor(host: Element): Element {
  return host.closest(".diff-split-row") ?? host;
}

// One inline comment editor: a textarea saving into the pending-comments
// map on every keystroke. endLine is null for a single line; onEmpty runs
// when the text empties (the key is then deleted) so the caller can drop
// any highlight the deleted comment owned.
function commentContext(
  row: HTMLElement,
  side: CommentSide,
  line: number,
  endLine: number | null,
): string[] {
  const root = row.closest(".diff-file-body") ?? row.parentElement;
  if (!root) return [];
  const lo = Math.min(line, endLine ?? line);
  const hi = Math.max(line, endLine ?? line);
  return [...root.querySelectorAll<HTMLElement>("[data-line][data-side]")]
    .filter((candidate) => {
      const candidateSide = candidate.dataset["side"];
      const candidateLine = Number(candidate.dataset["line"]);
      return (
        candidateSide === side &&
        Number.isFinite(candidateLine) &&
        candidateLine >= lo &&
        candidateLine <= hi
      );
    })
    .map((candidate) => {
      const source = candidate.querySelector<HTMLElement>(".diff-src");
      const sign = candidate.querySelector<HTMLElement>(".diff-sign");
      const marker =
        sign?.textContent ??
        diffContextMarker(
          candidate.classList.contains("add")
            ? "add"
            : candidate.classList.contains("del")
              ? "del"
              : "ctx",
        );
      return marker + (source?.textContent ?? "");
    });
}

function editorBox(
  side: CommentSide,
  line: number,
  endLine: number | null,
  scope: CommentScope,
  context: () => string[],
  notify: () => void,
  onEmpty: () => void,
): { box: HTMLElement; focus: () => void } {
  const range = endLine != null && endLine !== line;
  const label = range ? "lines " + line + "–" + endLine : "line " + line;
  const box = el("div", "diff-line-comment");
  const ta = el("textarea", "diff-line-input text-field");
  ta.placeholder = "Leave a comment on " + label + "…";
  ta.value = getComment(
    scope.agentId,
    scope.group,
    scope.path,
    side,
    line,
    endLine,
  );
  ta.setAttribute(
    "aria-label",
    "Comment on " + scope.path + " " + label + " (" + side + " side)",
  );
  ta.rows = 2;
  ta.oninput = () => {
    setComment(
      scope.agentId,
      scope.group,
      scope.path,
      side,
      line,
      endLine,
      ta.value,
      scope.target,
      context(),
    );
    if (!ta.value.trim()) onEmpty();
    notify();
  };
  box.append(ta);
  return { box, focus: () => ta.focus() };
}

export function createLineSelection(opts: {
  // The file body rows render into (rebuilt on redraw; always read fresh).
  body: () => HTMLElement;
  scope: () => CommentScope;
  notify: () => void;
}): LineSelection {
  let anchor: { side: CommentSide; line: number } | null = null;
  let end: { side: CommentSide; line: number } | null = null;
  let press: { side: CommentSide; line: number } | null = null;
  let dragging = false;
  let moved = false;
  let clickArmed = false;
  let rangeBox: HTMLElement | null = null;
  let openKey: {
    side: CommentSide;
    line: number;
    endLine: number | null;
  } | null = null;

  function paint(): void {
    const root = opts.body();
    let side: CommentSide | null = null;
    let lo = -1;
    let hi = -1;
    if (anchor && end && end.side === anchor.side) {
      side = anchor.side;
      lo = Math.min(anchor.line, end.line);
      hi = Math.max(anchor.line, end.line);
    }
    for (const n of root.querySelectorAll("[data-line]")) {
      const line = Number(n.getAttribute("data-line"));
      const on =
        side != null &&
        lo !== hi &&
        n.getAttribute("data-side") === side &&
        line >= lo &&
        line <= hi;
      n.classList.toggle("in-range", on);
    }
  }

  function closeRangeBox(): void {
    rangeBox?.remove();
    rangeBox = null;
    openKey = null;
  }

  function rowFor(side: CommentSide, line: number): HTMLElement | null {
    const row = opts
      .body()
      .querySelector('[data-line="' + line + '"][data-side="' + side + '"]');
    return row instanceof HTMLElement ? row : null;
  }

  function openRange(
    side: CommentSide,
    first: number,
    last: number,
    focus: boolean,
  ): void {
    const lo = Math.min(first, last);
    const hi = Math.max(first, last);
    const endLine = lo === hi ? null : hi;
    const row = rowFor(side, hi) || rowFor(side, lo);
    if (!row) return;
    closeRangeBox();
    const ed = editorBox(
      side,
      lo,
      endLine,
      opts.scope(),
      () => commentContext(row, side, lo, endLine),
      opts.notify,
      () => {
        // Invariant: Emptying the box deletes the key; the highlight must
        // follow even though the box stays open for continued typing.
        anchor = null;
        end = null;
        openKey = null;
        paint();
      },
    );
    rangeBox = ed.box;
    openKey = { side, line: lo, endLine };
    anchor = { side, line: first };
    end = { side, line: last };
    belowAnchor(row).after(rangeBox);
    paint();
    if (focus) ed.focus();
  }

  return {
    remember(side: CommentSide, line: number): void {
      anchor = { side, line };
    },
    clear(): void {
      anchor = null;
      end = null;
      closeRangeBox();
      paint();
    },
    restore(): void {
      if (!openKey) return;
      const s = opts.scope();
      if (
        getComment(
          s.agentId,
          s.group,
          s.path,
          openKey.side,
          openKey.line,
          openKey.endLine,
        )
      )
        openRange(
          openKey.side,
          openKey.line,
          openKey.endLine ?? openKey.line,
          false,
        );
    },
    beginDrag(side: CommentSide, line: number): void {
      dragging = true;
      moved = false;
      press = { side, line };
      anchor = { side, line };
      end = null;
      closeRangeBox();
      paint();
    },
    extend(side: CommentSide, line: number): void {
      if (!dragging || !anchor || side !== anchor.side) return;
      end = { side, line };
      if (line !== anchor.line) moved = true;
      paint();
    },
    endDrag(
      openSingle: () => void,
      release: { side: CommentSide; line: number } | null = null,
    ): void {
      if (!dragging) return;
      dragging = false;
      clickArmed =
        release != null &&
        press != null &&
        release.side === press.side &&
        release.line === press.line;
      press = null;
      // Invariant: Releasing over code is not a comment gesture. Only gutter
      // releases may open an editor or retain a comment-range highlight.
      if (!release) {
        anchor = null;
        end = null;
        paint();
        return;
      }
      if (!moved || !end || !anchor || end.line === anchor.line) openSingle();
      else openRange(anchor.side, anchor.line, end.line, true);
    },
    shiftSelect(side: CommentSide, line: number, openSingle: () => void): void {
      if (anchor && anchor.side === side && anchor.line !== line) {
        end = { side, line };
        paint();
        openRange(side, anchor.line, line, true);
      } else {
        anchor = { side, line };
        openSingle();
      }
    },
    dismissEnd(side: CommentSide, line: number): boolean {
      if (
        !openKey ||
        openKey.side !== side ||
        (openKey.endLine ?? openKey.line) !== line
      )
        return false;
      anchor = null;
      end = null;
      closeRangeBox();
      paint();
      return true;
    },
    consumeClick(): boolean {
      if (!clickArmed) return false;
      clickArmed = false;
      return true;
    },
  };
}

// Wires gutter/number clicks and ranges; touch uses number taps. Expansion
// reopens existing notes unfocused, preserving their saved text.
export function commentable(
  row: HTMLElement,
  line: number,
  side: CommentSide,
  ctx: CommentCtx,
  before: Node | null,
): void {
  row.classList.add("commentable");
  const add = el("button", "diff-add-comment");
  add.type = "button";
  add.title = "Comment on this line";
  add.setAttribute(
    "aria-label",
    "Comment on " + ctx.path + " line " + line + " (" + side + " side)",
  );
  add.textContent = "+";
  row.insertBefore(add, before);
  let editor: { box: HTMLElement; focus: () => void } | null = null;
  function open(focus: boolean) {
    ctx.selection.clear();
    ctx.selection.remember(side, line);
    if (!editor) {
      editor = editorBox(
        side,
        line,
        null,
        ctx,
        () => commentContext(row, side, line, null),
        ctx.onChange,
        () => {},
      );
      belowAnchor(row).after(editor.box);
      row.classList.add("commenting");
    }
    if (focus) editor.focus();
  }
  function close() {
    if (!editor) return;
    editor.box.remove();
    editor = null;
    row.classList.remove("commenting");
  }
  const toggle = () => {
    if (editor) {
      close();
      return;
    }
    // Invariant: The "+" on a range box's end row dismisses that box instead of
    // stacking a single editor under it.
    if (ctx.selection.dismissEnd(side, line)) return;
    open(true);
  };
  add.onclick = toggle;
  const num = row.querySelector(":scope > .diff-num");
  if (!(num instanceof HTMLElement)) {
    if (getComment(ctx.agentId, ctx.group, ctx.path, side, line)) open(false);
    return;
  }
  const desktop =
    typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
  num.title = desktop
    ? "Click to comment · shift-click or drag to select lines"
    : "Comment on this line";
  if (!desktop) {
    // Invariant: Touch screens have no hover to reveal the gutter "+", so the
    // line-number cell doubles as the tap target (desktop keeps the hover
    // button, so context lines never carry a visible sign).
    num.onclick = toggle;
  } else {
    num.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.shiftKey) return;
      ctx.selection.beginDrag(side, line);
      // Invariant: The release can land off any number (code text, padding);
      // finish there too — endDrag is a no-op once a number already handled it.
      // Off-number releases carry no number, so no click gets armed.
      document.addEventListener(
        "mouseup",
        () => ctx.selection.endDrag(toggle, null),
        { once: true },
      );
      e.preventDefault();
    });
    num.addEventListener("mouseenter", (e) => {
      if (e.buttons & 1) ctx.selection.extend(side, line);
    });
    num.addEventListener("mouseup", () => {
      ctx.selection.endDrag(toggle, { side, line });
    });
    num.addEventListener("click", (e) => {
      if (ctx.selection.consumeClick()) return;
      if (e.shiftKey) ctx.selection.shiftSelect(side, line, toggle);
      else toggle();
    });
  }
  if (getComment(ctx.agentId, ctx.group, ctx.path, side, line)) open(false);
}
