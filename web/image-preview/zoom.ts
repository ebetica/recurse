// Image-local zoom for the Files gallery. The frame, including box marks,
// transforms as one unit, so normalized comment coordinates remain unchanged.
// At fit, drag/hold belongs to gallery navigation and box comments. Zoomed
// one-finger drags draw boxes; two fingers pan/pinch. Shift-drag pans by mouse.
export function installImageZoom(image: HTMLImageElement): void {
  const frame = image.closest<HTMLElement>(".files-image-frame");
  const viewport = frame?.parentElement;
  if (!frame || !viewport || viewport.dataset.imageZoom) return;
  viewport.dataset.imageZoom = "1";
  let scale = 1,
    x = 0,
    y = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let tap = { time: 0, x: 0, y: 0 };
  let moved = false;
  let pinched = false;
  let lastPointerTouch = false;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn sm image-zoom-reset";
  reset.textContent = "Fit image";
  reset.hidden = true;
  viewport.append(reset);
  const paint = () => {
    const limitX = (frame.offsetWidth * (scale - 1)) / 2;
    const limitY = (frame.offsetHeight * (scale - 1)) / 2;
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    frame.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    viewport.dataset.zoomed = String(scale > 1);
    viewport.title =
      scale > 1 ? "Drag to comment; Shift+drag or two fingers to move" : "";
    reset.hidden = scale === 1;
  };
  const zoom = (next: number, cx: number, cy: number) => {
    next = Math.max(1, Math.min(8, next));
    const rect = viewport.getBoundingClientRect();
    const px = cx - rect.left - rect.width / 2;
    const bottom = parseFloat(getComputedStyle(viewport).paddingBottom) || 0;
    const py = cy - rect.top - (rect.height - bottom) / 2;
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    paint();
  };
  reset.onclick = () => {
    scale = 1;
    x = y = 0;
    paint();
  };
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom(
        scale * Math.exp(-event.deltaY * 0.01),
        event.clientX,
        event.clientY,
      );
    },
    { passive: false },
  );
  viewport.addEventListener("dblclick", (event) => {
    if (lastPointerTouch || (event.target as Element).closest("button")) return;
    event.preventDefault();
    zoom(scale === 1 ? 2 : 1, event.clientX, event.clientY);
  });
  viewport.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button") || event.button !== 0)
      return;
    lastPointerTouch = event.pointerType === "touch";
    if (!pointers.size) {
      moved = false;
      pinched = false;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      pinched = true;
      tap.time = 0;
    }
    if (event.pointerType === "touch")
      viewport.setPointerCapture(event.pointerId);
    if (scale > 1 && event.pointerType !== "touch" && event.shiftKey) {
      event.stopPropagation();
      viewport.setPointerCapture(event.pointerId);
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const next = { x: event.clientX, y: event.clientY };
    const dx = next.x - old.x,
      dy = next.y - old.y;
    if (Math.hypot(dx, dy) > 1) moved = true;
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(
        ([id]) => id !== event.pointerId,
      )![1];
      const before = Math.hypot(old.x - other.x, old.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      if (before)
        zoom(
          (scale * after) / before,
          (old.x + other.x) / 2,
          (old.y + other.y) / 2,
        );
      x += dx / 2;
      y += dy / 2;
      paint();
    } else if (scale > 1 && event.pointerType !== "touch" && event.shiftKey) {
      x += dx;
      y += dy;
      paint();
    }
    pointers.set(event.pointerId, next);
  });
  const end = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (
      event.type === "pointerup" &&
      event.pointerType === "touch" &&
      !moved &&
      !pinched &&
      !frame.hasPointerCapture(event.pointerId)
    ) {
      const now = performance.now();
      if (
        now - tap.time < 300 &&
        Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 24
      ) {
        zoom(scale === 1 ? 2 : 1, event.clientX, event.clientY);
        tap.time = 0;
      } else tap = { time: now, x: event.clientX, y: event.clientY };
    }
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
  paint();
}
