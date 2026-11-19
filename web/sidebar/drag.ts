/** Desktop tree dragging chooses a parent, never a stored sibling position. */
import { listEl } from "../dom.js";
import { state, DRAFT } from "../state.js";
import { parseConversationId } from "../backends/conversation-id/index.js";
import { canDrop, reparentValidity } from "../reparent.js";

let sourceId: string | null = null;
export const isDraggingAgent = (): boolean => sourceId !== null;

/** Keep gesture highlights outside keyed rendering until the drag ends. */
export function initAgentDrag(
  blocked: () => boolean,
  repaint: () => void,
  move: (source: string, parent: string | null) => void,
): void {
  const rowOf = (event: DragEvent) =>
    (event.target as Element | null)?.closest<HTMLElement>(".agent[data-id]");
  const clear = () => {
    for (const row of listEl.querySelectorAll(
      ".drop-ok, .drop-bad, .drop-between",
    ))
      row.classList.remove("drop-ok", "drop-bad", "drop-between");
    listEl.querySelector(".agent-drop-line")?.remove();
  };
  const end = () => {
    clear();
    listEl.querySelector(".drag-source")?.classList.remove("drag-source");
    const active = sourceId !== null;
    sourceId = null;
    if (active) repaint();
  };
  const destination = (event: DragEvent) => {
    const row =
      rowOf(event) ??
      (event.target === listEl
        ? Array.from(
            listEl.querySelectorAll<HTMLElement>(".agent[data-id]"),
          ).find((candidate) => {
            const box = candidate.getBoundingClientRect();
            return (
              Math.min(
                Math.abs(event.clientY - box.top),
                Math.abs(event.clientY - box.bottom),
              ) <= 2
            );
          })
        : undefined);
    const node = row?.dataset.id ? state.nodes[row.dataset.id] : undefined;
    if (!row || !node || parseConversationId(node.id).label) return null;
    const box = row.getBoundingClientRect();
    const edge =
      event.clientY <= box.top + 6
        ? "top"
        : event.clientY >= box.bottom - 6
          ? "bottom"
          : null;
    return { row, parent: edge ? node.parent : node.id, edge };
  };
  listEl.addEventListener("dragstart", (event: DragEvent) => {
    const row = rowOf(event);
    const id = row?.dataset.id;
    if (
      !id ||
      id === DRAFT ||
      !state.nodes[id] ||
      parseConversationId(id).label ||
      blocked()
    ) {
      event.preventDefault();
      return;
    }
    sourceId = id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
    row!.classList.add("drag-source");
  });
  listEl.addEventListener("dragover", (event: DragEvent) => {
    if (!sourceId) return;
    clear();
    const target = destination(event);
    if (!target) return;
    const { row, parent, edge } = target;
    const reason = reparentValidity(state.nodes, sourceId, parent);
    if (canDrop(state.nodes, sourceId, parent)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    } else if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    if (reason === "noop") return;
    if (edge) {
      row.classList.add("drop-between");
      const line = document.createElement("div");
      line.className = "agent-drop-line";
      line.classList.toggle("invalid", reason !== "ok");
      line.style.setProperty(edge, "-2px");
      line.style.left = `${row.querySelector<HTMLElement>(".row1")!.offsetLeft}px`;
      row.append(line);
    } else row.classList.add(reason === "ok" ? "drop-ok" : "drop-bad");
  });
  listEl.addEventListener("dragleave", (event: DragEvent) => {
    if (!listEl.contains(event.relatedTarget as Node | null)) clear();
  });
  listEl.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    const source = sourceId;
    const target = destination(event);
    end();
    if (source && target) move(source, target.parent);
  });
  listEl.addEventListener("dragend", end);
}
