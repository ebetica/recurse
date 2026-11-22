// Shared image gestures transform the frame and comment marks together.
// Modifier-wheel zooms about the pointer; plain wheel pans when zoomed,
// zooms vertically at fit, and navigates horizontally at fit.
// Touch gestures are unchanged.
export function imageCommentHint(pointer?: string): string {
  if (pointer ? pointer !== "mouse" : matchMedia("(pointer: coarse)").matches)
    return "Hold to comment";
  return `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}-drag to comment`;
}

function wheelPixels(event: WheelEvent, viewport: HTMLElement) {
  const unit = event.deltaMode === 1 ? 16 : 1;
  return {
    x: event.deltaX * (event.deltaMode === 2 ? viewport.clientWidth : unit),
    y: event.deltaY * (event.deltaMode === 2 ? viewport.clientHeight : unit),
  };
}

let wheelDistance = 0;
let wheelNavigated = false;
let wheelIdle: ReturnType<typeof setTimeout> | undefined;

/** Share the wheel stream's latch across image replacements and file tabs. */
export function installImageWheelNavigation(
  gallery: HTMLElement,
  step: (delta: -1 | 1) => void,
): void {
  gallery.addEventListener(
    "wheel",
    (event) => {
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => {
        wheelDistance = 0;
        wheelNavigated = false;
      }, 250);
      const viewport = (event.target as Element).closest<HTMLElement>(
        ".image-zoom-viewport",
      );
      if (!viewport) return;
      const { x, y } = wheelPixels(event, viewport);
      if (
        wheelNavigated ||
        viewport.dataset.zoomed === "true" ||
        event.ctrlKey ||
        event.metaKey ||
        Math.abs(x) <= Math.abs(y)
      )
        return;
      wheelDistance += x;
      if (Math.abs(wheelDistance) < 60) return;
      wheelNavigated = true;
      step(wheelDistance > 0 ? 1 : -1);
    },
    { passive: true },
  );
}

export function installImageZoom(image: HTMLImageElement): void {
  const frame = image.closest<HTMLElement>(".files-image-frame");
  if (frame) installFrameZoom(frame);
}

export function installFrameZoom(
  frame: HTMLElement,
  controls?: {
    zoomIn: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    fit: HTMLButtonElement;
    maxScale: () => number;
  },
): void {
  const viewport = frame.parentElement;
  if (!viewport || viewport.dataset.imageZoom) return;
  viewport.dataset.imageZoom = "1";
  const updateHint = (event: PointerEvent) => {
    const pane = viewport.closest<HTMLElement>(".image-popout-body");
    if (!pane || !event.pointerType) return;
    pane.dataset.imagePointer = event.pointerType;
    const hint = pane.querySelector<HTMLElement>("[data-image-comment-hint]");
    if (hint) hint.textContent = imageCommentHint(event.pointerType);
  };
  viewport.addEventListener("pointerdown", updateHint);
  viewport.addEventListener("pointermove", updateHint);
  let scale = 1,
    x = 0,
    y = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let tap = { time: 0, x: 0, y: 0 };
  let moved = false;
  let pinched = false;
  let lastPointerTouch = false;
  const reset = controls?.fit ?? document.createElement("button");
  if (!controls) {
    reset.type = "button";
    reset.className = "btn sm image-zoom-reset";
    reset.textContent = "Fit image";
    viewport.append(reset);
  }
  const paint = () => {
    const limitX = (frame.offsetWidth * (scale - 1)) / 2;
    const limitY = (frame.offsetHeight * (scale - 1)) / 2;
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    frame.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    viewport.dataset.zoomed = String(scale > 1);
    if (!controls) reset.hidden = scale === 1;
  };
  const zoom = (next: number, cx: number, cy: number) => {
    next = Math.max(1, Math.min(controls?.maxScale() ?? 8, next));
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
  if (controls) {
    const stepZoom = (factor: number) => {
      const rect = viewport.getBoundingClientRect();
      zoom(
        scale * factor,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
    };
    controls.zoomIn.onclick = () => stepZoom(2);
    controls.zoomOut.onclick = () => stepZoom(0.5);
    viewport.addEventListener("keydown", (event) => {
      if (
        scale === 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const step = 40;
      if (event.key === "ArrowLeft") x += step;
      else if (event.key === "ArrowRight") x -= step;
      else if (event.key === "ArrowUp") y += step;
      else if (event.key === "ArrowDown") y -= step;
      else return;
      event.preventDefault();
      paint();
    });
  }
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = wheelPixels(event, viewport);
      if (event.ctrlKey || event.metaKey || scale === 1) {
        if (
          !event.ctrlKey &&
          !event.metaKey &&
          Math.abs(delta.x) > Math.abs(delta.y)
        )
          return;
        zoom(scale * Math.exp(-delta.y * 0.01), event.clientX, event.clientY);
      } else {
        x -= delta.x;
        y -= delta.y;
        paint();
      }
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
    lastPointerTouch = event.pointerType !== "mouse";
    if (!pointers.size) {
      moved = false;
      pinched = false;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      pinched = true;
      tap.time = 0;
    }
    viewport.setPointerCapture(event.pointerId);
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
    } else if (
      scale > 1 &&
      !frame.hasPointerCapture(event.pointerId) &&
      !(event.pointerType === "mouse" && (event.ctrlKey || event.metaKey))
    ) {
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
      event.pointerType !== "mouse" &&
      !moved &&
      !pinched &&
      !frame.hasPointerCapture(event.pointerId)
    ) {
      // Invariant: Taps are timed by when they happened, so a busy page
      // still sees a quick double tap as one.
      const now = event.timeStamp;
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
