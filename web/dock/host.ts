// Desktop dockview adapter: content moves preserve focus, editing selection and scroll.
// Focus skips synthetic tabs and wrappers. Pointer drags stay in their source until release or interruption.
// Active tab close selects and focuses the right neighbour, then the left, then a surviving window or the usual fallback.
// Inactive tab close keeps selection and keyboard focus. Bulk and phone closes keep their existing rules.
import {
  createDockview,
  themeAbyssSpaced,
  type IDockviewPanel,
  type SerializedDockview,
} from "dockview";
import { createWindowCommands } from "./commands.js";
import { captureSelectionDraftRange } from "../comments/selection-draft/index.js";
import type { FileTabDescriptor } from "../panes/file-tabs.js";

export interface DockPanelSpec {
  id: string;
  title: string;
  icon: string;
  file?: FileTabDescriptor;
}

export interface DockPlace {
  before: SerializedDockview;
  after: string;
}

/** Which tabs share which windows in which splits, ignoring sizes. */
const arrangement = (layout: SerializedDockview): string =>
  JSON.stringify([layout.grid.orientation, layout.grid.root], (key, value) =>
    key === "size" || key === "activeView" ? undefined : value,
  );

type GridNode =
  | { type: "branch"; data: GridNode[] }
  | {
      type: "leaf";
      data: { id: string; views: string[]; activeView?: string };
    };

export interface DockCallbacks {
  element(id: string): HTMLElement | null;
  action(id: string): HTMLElement | null;
  closed(id: string, restoreFocus?: boolean): boolean;
  focus(id: string): void;
  keyboardFocus(id: string): void;
  moved(): void;
  changed(): void;
  arranged(): void;
  fullscreen(id: string): void;
  leaveFullscreen(): void;
  shown(id: string): void;
}

function captureFocus(root: HTMLElement): () => void {
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && root.contains(active) ? active : null;
  const field =
    focused instanceof HTMLTextAreaElement ||
    focused instanceof HTMLInputElement
      ? focused
      : null;
  const caret = field
    ? ([
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection,
      ] as const)
    : null;
  return () => {
    if (focused && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    if (field && caret && caret[0] !== null)
      field.setSelectionRange(caret[0], caret[1], caret[2] ?? undefined);
  };
}

/** Move connected content without resetting its editor or frame. */
export function adopt(
  parent: HTMLElement,
  child: HTMLElement,
  next: Node | null = null,
): void {
  if (child.parentElement === parent) return;
  const scrollers = [child, ...child.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.scrollTop || element.scrollLeft)
    .map(
      (element) => [element, element.scrollTop, element.scrollLeft] as const,
    );
  const restoreFocus = captureFocus(child);
  const restoreDraftRange = captureSelectionDraftRange(child);
  try {
    const move = (
      parent as { moveBefore?: (node: Node, next: Node | null) => void }
    ).moveBefore;
    if (!move || !child.isConnected || !parent.isConnected) throw Error();
    move.call(parent, child, next);
  } catch {
    parent.insertBefore(child, next);
  }
  restoreDraftRange?.();
  for (const [element, top, left] of scrollers) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
  restoreFocus();
}

/** Apply the separately published styles before laying out the chat. */
export function loadDockStyles(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(
      "dockview-css",
    ) as HTMLLinkElement | null;
    if (existing?.sheet) return resolve();
    const link = existing || document.createElement("link");
    link.id = "dockview-css";
    link.rel = "stylesheet";
    link.href = "/static/dockview.css";
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error("Window styles could not load"));
    };
    if (!existing) document.head.append(link);
  });
}

export function createDockHost(
  container: HTMLElement,
  callbacks: DockCallbacks,
) {
  let quiet = false;
  let recent: string[] = [];
  let held: HTMLElement | null = null;
  const specs = new Map<string, DockPanelSpec>();
  let commands: ReturnType<typeof createWindowCommands>;
  let restoring = false;
  let parking: HTMLElement | null = null;
  const refocus = (): void => {
    const element = held;
    held = null;
    if (element?.isConnected) element.focus({ preventScroll: true });
  };
  const actionViews = new Map<HTMLElement, () => void>();
  const actionOrigins = new Map<
    HTMLElement,
    { parent: HTMLElement; next: Node | null }
  >();
  const restoreAction = (action: HTMLElement): void => {
    const origin = actionOrigins.get(action);
    if (!origin) return;
    actionOrigins.delete(action);
    adopt(
      origin.parent,
      action,
      origin.next?.parentNode === origin.parent ? origin.next : null,
    );
  };
  const tabLayouts = new WeakMap<
    HTMLElement,
    { width: number; extent: number; active: HTMLElement }
  >();
  const resizeTabs = (): void => {
    for (const group of api.groups) {
      const strip =
        group.element.querySelector<HTMLElement>(".dv-tabs-container");
      if (!strip) continue;
      strip.classList.remove("dock-compact");
      const width = strip.clientWidth;
      const extent = strip.scrollWidth;
      strip.classList.toggle("dock-compact", extent > width);
      const active = strip.querySelector<HTMLElement>(".dv-active-tab");
      if (!active) continue;
      const prior = tabLayouts.get(strip);
      if (
        prior?.width === width &&
        prior.extent === extent &&
        prior.active === active
      )
        continue;
      tabLayouts.set(strip, { width, extent, active });
      const bounds = strip.getBoundingClientRect();
      const title = active.querySelector<HTMLElement>(
        ".dv-default-tab-content",
      )!;
      const tab = (
        active.offsetWidth > strip.clientWidth ? title : active
      ).getBoundingClientRect();
      if (tab.width > bounds.width || tab.left < bounds.left)
        strip.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right)
        strip.scrollLeft += tab.right - bounds.right;
    }
  };
  const refreshActions = (): void => {
    for (const refresh of actionViews.values()) refresh();
    resizeTabs();
  };
  const pending = new Map<HTMLElement, string>();
  let placing = 0;
  let waited = 0;
  const place = (): void => {
    if (restoring) return;
    let waitingForBounds = false;
    for (const [element, id] of pending) {
      if (!element.isConnected) continue;
      const content = callbacks.element(id);
      if (!content) continue;
      const visible =
        element.getBoundingClientRect().width > 0 &&
        getComputedStyle(element).visibility !== "hidden";
      if (
        (id === "chat" || api.getPanel(id)?.api.isVisible) &&
        !visible &&
        waited < 30
      ) {
        waitingForBounds = true;
        continue;
      }
      element.querySelector(":scope > .dock-loading")?.remove();
      adopt(element, content);
      pending.delete(element);
      if (visible) callbacks.shown(id);
    }
    refreshActions();
    if (!pending.size) {
      waited = 0;
      if (!parking?.childElementCount) {
        parking?.remove();
        parking = null;
      }
    } else if (waitingForBounds && !placing)
      placing = requestAnimationFrame(() => {
        placing = 0;
        waited++;
        place();
      });
  };
  const api = createDockview(container, {
    theme: { ...themeAbyssSpaced, gap: 0 },
    disableFloatingGroups: true,
    defaultRenderer: "always",
    scrollbars: "native",
    createRightHeaderActionComponent: (group) => {
      const element = document.createElement("div");
      element.className = "dock-window-actions";
      const hint = document.createElement("span");
      hint.className = "dock-opening-hint";
      element.append(hint);
      let current: HTMLElement | null = null;
      const refresh = (): void => {
        hint.textContent = commands?.hint(group.id) || "";
        hint.hidden = !hint.textContent;
        const id = group.activePanel?.id;
        const next = id ? callbacks.action(id) : null;
        element.dataset.dockPanel = id || "";
        if (current === next) return;
        if (current?.parentElement === element) restoreAction(current);
        current = next;
        if (next) {
          if (!actionOrigins.has(next) && next.parentElement)
            actionOrigins.set(next, {
              parent: next.parentElement,
              next: next.nextSibling,
            });
          adopt(element, next);
        }
      };
      const changed = group.api.onDidActivePanelChange(refreshActions);
      return {
        element,
        init: () => {
          actionViews.set(element, refresh);
          refresh();
        },
        dispose: () => {
          changed.dispose();
          actionViews.delete(element);
          if (current?.parentElement === element) restoreAction(current);
        },
      };
    },
    createComponent: () => {
      const element = document.createElement("div");
      element.className = "dock-panel";
      return {
        element,
        init: (parameters) => {
          const id = parameters.api.id;
          element.dataset.dockPanel = id;
          if (id !== "chat" && !callbacks.element(id)) {
            const loading = document.createElement("div");
            loading.className = "dock-loading";
            loading.setAttribute("role", "status");
            loading.textContent = id.startsWith("file:")
              ? "Loading file…"
              : "Loading pane…";
            element.append(loading);
          }
          pending.set(element, id);
          place();
        },
      };
    },
    createTabComponent: () => {
      const element = document.createElement("div");
      element.className = "dv-default-tab";
      return {
        element,
        init: ({ api: panel }) => {
          element.dataset.dockPanel = panel.id;
          const title = document.createElement("span");
          title.className = "dv-default-tab-content";
          const close = document.createElement("button");
          close.className = "dv-default-tab-action";
          close.type = "button";
          close.addEventListener("pointerdown", (event) =>
            event.stopPropagation(),
          );
          close.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            closeTab(panel.id);
          });
          element.append(title, close);
        },
      };
    },
  });
  const layout = (): void => {
    api.layout(container.clientWidth, container.clientHeight, true);
    place();
  };
  const sizer = new ResizeObserver(layout);
  sizer.observe(container, { box: "content-box" });
  const tabElement = (panel: IDockviewPanel): HTMLElement =>
    panel.view.tab.element.closest<HTMLElement>(".dv-tab") ||
    panel.view.tab.element;
  const closeTab = (
    id: string,
    close: (restoreFocus: boolean) => boolean = (restoreFocus) =>
      callbacks.closed(id, restoreFocus),
  ): boolean | undefined => {
    const panel = api.getPanel(id);
    if (!panel) return;
    const group = panel.group;
    if (group.activePanel !== panel) {
      const hadFocus = tabElement(panel).contains(document.activeElement);
      const closed = close(false);
      if (closed && hadFocus && api.activePanel)
        callbacks.keyboardFocus(api.activePanel.id);
      return closed;
    }
    const index = group.panels.indexOf(panel);
    const neighbour = group.panels[index + 1] ?? group.panels[index - 1];
    const lastTab = api.panels.length === 1;
    if (!close(lastTab)) return false;
    const next =
      (neighbour && api.getPanel(neighbour.id)) ??
      api.activePanel ??
      api.panels[0];
    if (next) {
      const changed = api.activePanel !== next;
      next.api.setActive();
      callbacks.keyboardFocus(next.id);
      if (changed) callbacks.arranged();
    }
    return true;
  };
  const label = (panel: IDockviewPanel): void => {
    const tab = tabElement(panel);
    tab.dataset.dockPanel = panel.id;
    const title = panel.title || panel.id;
    tab.setAttribute("aria-label", title);
    tab.removeAttribute("tabindex");
    const renderer = panel.view.tab.element;
    const content = renderer.matches(".dv-default-tab")
      ? renderer
      : renderer.querySelector(".dv-default-tab");
    if (content) {
      content.setAttribute("title", title);
      content.querySelector(".dv-default-tab-content")!.textContent = title;
      content
        .querySelector(".dv-default-tab-action")!
        .setAttribute("aria-label", `Close ${title}`);
      if (!content.querySelector(".dock-tab-icon")) {
        const icon = document.createElement("span");
        icon.className = "dock-tab-icon";
        icon.innerHTML = specs.get(panel.id)?.icon || "";
        content.prepend(icon);
      }
    }
    place();
  };
  api.onDidAddPanel(label);
  api.onDidLayoutChange(() => {
    refreshActions();
    if (!quiet && !restoring) callbacks.changed();
  });
  api.onDidMutateLayout(({ origin }) => {
    if (origin === "user" && !quiet && !restoring) callbacks.arranged();
  });
  api.onDidMovePanel(({ panel }) => {
    if (panel) label(panel);
    place();
    refocus();
    callbacks.moved();
  });
  api.onDidRemovePanel((panel) => {
    recent = recent.filter((id) => id !== panel.id);
    for (const [element, id] of pending)
      if (id === panel.id) pending.delete(element);
    if (!quiet) {
      specs.delete(panel.id);
      commands.removed();
      callbacks.closed(panel.id);
    }
  });
  // Invariant: Dockview may recreate wrappers during dragging. None become a
  // keyboard stop or take focus from the content they wrap.
  const stripFocus = (): void => {
    for (const element of container.querySelectorAll<HTMLElement>("[tabindex]"))
      if (
        !element.closest(".dock-panel") &&
        !parking?.contains(element) &&
        !element.matches("button")
      )
        element.removeAttribute("tabindex");
  };
  const observer = new MutationObserver(stripFocus);
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["tabindex"],
  });
  const panelAt = (target: Element): IDockviewPanel | undefined => {
    const tab =
      target.closest<HTMLElement>("[data-dock-panel]") ||
      target
        .closest(".dv-render-overlay")
        ?.querySelector<HTMLElement>("[data-dock-panel]");
    if (tab) return api.getPanel(tab.dataset.dockPanel!);
    const group = api.groups.find((group) => group.element.contains(target));
    return group?.activePanel;
  };
  const gestures = new AbortController();
  let selectionScope: Element | null = null;
  let selectionEvents: AbortController | null = null;
  const finishSelection = (): void => {
    selectionEvents?.abort();
    selectionEvents = null;
    const scope = selectionScope;
    const selection = document.getSelection();
    if (
      scope?.isConnected &&
      selection?.rangeCount === 1 &&
      !selection.isCollapsed &&
      selection.getRangeAt(0).intersectsNode(scope)
    ) {
      const range = selection.getRangeAt(0).cloneRange();
      const backward =
        selection.anchorNode === range.endContainer &&
        selection.anchorOffset === range.endOffset;
      const bounds = document.createRange();
      bounds.selectNodeContents(scope);
      let clipped = false;
      if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
        range.setStart(bounds.startContainer, bounds.startOffset);
        clipped = true;
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
        range.setEnd(bounds.endContainer, bounds.endOffset);
        clipped = true;
      }
      if (clipped)
        selection.setBaseAndExtent(
          backward ? range.endContainer : range.startContainer,
          backward ? range.endOffset : range.startOffset,
          backward ? range.startContainer : range.endContainer,
          backward ? range.startOffset : range.endOffset,
        );
    }
    scope?.classList.remove("dock-selection-scope");
    selectionScope = null;
    document.body.classList.remove("dock-selection-scoped");
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      finishSelection();
      const target = event.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) return;
      selectionScope = target.closest(".dock-panel, #sidebar");
      if (!selectionScope) return;
      selectionScope.classList.add("dock-selection-scope");
      document.body.classList.add("dock-selection-scoped");
      selectionEvents = new AbortController();
      const options = { capture: true, signal: selectionEvents.signal };
      for (const type of ["pointerup", "pointercancel"])
        window.addEventListener(
          type,
          (release) => {
            if ((release as PointerEvent).pointerId === event.pointerId)
              finishSelection();
          },
          options,
        );
      for (const type of [
        "pointermove",
        "pointerover",
        "pointerout",
        "mousemove",
        "mouseover",
        "mouseout",
        "mouseenter",
        "mouseleave",
        "mouseup",
      ])
        window.addEventListener(
          type,
          (move) => {
            if ((move as MouseEvent).buttons === 0) finishSelection();
          },
          options,
        );
      for (const type of ["contextmenu", "dragstart", "dragend", "keydown"])
        window.addEventListener(type, finishSelection, options);
      document.addEventListener("visibilitychange", finishSelection, options);
      window.addEventListener("blur", finishSelection, {
        signal: selectionEvents.signal,
      });
    },
    { capture: true, signal: gestures.signal },
  );
  let resizeFrom: { x: number; y: number; layout: string } | null = null;
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Element;
      if (container.contains(target) && target.closest(".dv-sash"))
        resizeFrom = {
          x: event.clientX,
          y: event.clientY,
          layout: JSON.stringify(api.toJSON()),
        };
    },
    { capture: true, signal: gestures.signal },
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      const start = resizeFrom;
      resizeFrom = null;
      if (!start || (start.x === event.clientX && start.y === event.clientY))
        return;
      queueMicrotask(() => {
        if (
          container.isConnected &&
          start.layout !== JSON.stringify(api.toJSON())
        )
          callbacks.arranged();
      });
    },
    { capture: true, signal: gestures.signal },
  );
  window.addEventListener(
    "pointercancel",
    () => {
      resizeFrom = null;
    },
    {
      signal: gestures.signal,
    },
  );
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element;
      if (target.closest("button") || quiet || restoring) return;
      const tab = target.closest<HTMLElement>(".dv-tab");
      const id =
        tab?.dataset.dockPanel ||
        tab?.querySelector<HTMLElement>("[data-dock-panel]")?.dataset.dockPanel;
      if (id && api.getPanel(id)) callbacks.arranged();
    },
    { signal: gestures.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Enter" ||
        !(event.target as Element).closest(
          ".dv-tabs-overflow-dropdown-root, .dv-tabs-overflow-container",
        )
      )
        return;
      const prior = api.activePanel;
      queueMicrotask(() => {
        if (container.isConnected && api.activePanel !== prior)
          callbacks.arranged();
      });
    },
    { capture: true, signal: gestures.signal },
  );
  container.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Element;
      if (!target.closest(".dv-tab")) return;
      if (event.button === 1) event.preventDefault();
      if (event.button !== 0 || target.closest("button")) return;
      held =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    },
    true,
  );
  container.addEventListener("dragend", refocus);
  container.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const id = (event.target as Element).closest<HTMLElement>(".dv-tab")
      ?.dataset.dockPanel;
    if (!id) return;
    event.preventDefault();
    closeTab(id);
  });
  container.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (
      target.closest(
        "button, input, textarea, select, summary, a, [contenteditable], [role=button], [role=menuitem], [role=menuitemradio]",
      )
    )
      return;
    const panel = panelAt(target);
    if (panel) {
      panel.api.setActive();
      callbacks.focus(panel.id);
    }
  });
  api.onDidActivePanelChange(({ panel }) => {
    if (panel && !quiet)
      recent = [...recent.filter((id) => id !== panel.id), panel.id];
  });
  const eligible = (panel: IDockviewPanel): boolean =>
    !panel.group.panels.some(
      (tab) => tab.id === "chat" || tab.id === "explorer",
    );
  const targetGroup = (): IDockviewPanel | undefined => {
    const last = recent
      .map((id) => api.getPanel(id))
      .filter((panel): panel is IDockviewPanel => !!panel && eligible(panel))
      .at(-1);
    return (
      last ||
      api.groups
        .filter((group) => group.activePanel && eligible(group.activePanel))
        .sort(
          (a, b) =>
            b.element.getBoundingClientRect().right -
              a.element.getBoundingClientRect().right ||
            a.element.getBoundingClientRect().top -
              b.element.getBoundingClientRect().top,
        )[0]?.activePanel
    );
  };
  const restoreLayout = (layout: SerializedDockview | null): void => {
    const restoreFocus = captureFocus(document.documentElement);
    restoring = true;
    quiet = true;
    parking ||= document.createElement("div");
    parking.className = "dock-parking";
    parking.hidden = true;
    container.append(parking);
    try {
      for (const panel of api.panels) {
        const content = callbacks.element(panel.id);
        if (content) adopt(parking, content);
      }
      pending.clear();
      if (layout) api.fromJSON(layout);
      else api.clear();
    } finally {
      quiet = false;
      restoring = false;
    }
    stripFocus();
    place();
    restoreFocus();
  };
  commands = createWindowCommands(api, {
    focus: callbacks.keyboardFocus,
    close: (id, restoreFocus = true) =>
      restoreFocus ? closeTab(id) : callbacks.closed(id, false),
    fullscreen: callbacks.fullscreen,
    leaveFullscreen: callbacks.leaveFullscreen,
    restore: restoreLayout,
    changed: refreshActions,
    arranged: callbacks.arranged,
  });
  const reopen = (
    id: string,
    layout: SerializedDockview,
    background: boolean,
  ): void => {
    const next = structuredClone(layout);
    Object.assign(next.panels, api.toJSON().panels);
    const shown = new Map(
      api.groups.map((group) => [group.id, group.activePanel?.id]),
    );
    if (background) next.activeGroup = api.activeGroup?.id;
    const visit = (node: GridNode): void => {
      if (node.type === "branch") return node.data.forEach(visit);
      const leaf = node.data;
      const current = shown.get(leaf.id);
      if (!background && leaf.views.includes(id)) {
        leaf.activeView = id;
        next.activeGroup = leaf.id;
      } else if (current && leaf.views.includes(current))
        leaf.activeView = current;
    };
    visit(next.grid.root as GridNode);
    const history = recent;
    commands.restore(next);
    recent = history.filter((entry) => entry !== id && api.getPanel(entry));
    if (!background) recent.push(id);
  };
  const reset = (): void => {
    resizeFrom = null;
    recent = [];
    commands.reset();
  };
  return {
    command: commands.run,
    save: () => api.toJSON(),
    reset,
    restore(value: SerializedDockview | null, fallback?: DockPanelSpec): void {
      const restoreFocus = captureFocus(document.documentElement);
      reset();
      try {
        const defaultChat =
          value === null &&
          fallback?.id === "chat" &&
          api.panels.length === 1 &&
          api.groups.length === 1 &&
          api.getPanel("chat")?.api.isVisible &&
          !api.hasMaximizedGroup();
        if (!defaultChat) restoreLayout(value);
        if (fallback) {
          this.show(fallback, true);
          layout();
        }
      } finally {
        restoreFocus();
      }
    },
    show(spec: DockPanelSpec, background = false, closed?: DockPlace) {
      const existing = api.getPanel(spec.id);
      if (existing) {
        if (!background) {
          const changed = api.activePanel !== existing;
          existing.api.setActive();
          if (changed) callbacks.arranged();
        }
        return;
      }
      specs.set(spec.id, spec);
      const opening = commands.takeOpening();
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
      const chat = api.getPanel("chat");
      const near =
        opening?.group.activePanel ||
        (spec.id === "chat" ? undefined : (spec.file && chat) || targetGroup());
      const reference = near || chat || api.activePanel;
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      quiet = background;
      try {
        if (!opening && closed?.after === arrangement(api.toJSON()))
          reopen(spec.id, closed.before, background);
        else
          api.addPanel({
            id: spec.id,
            title: spec.title,
            component: "panel",
            tabComponent: "tab",
            ...(spec.file ? { params: { file: spec.file } } : {}),
            inactive: background && !!near,
            ...(reference
              ? {
                  position: {
                    referenceGroup: reference.group,
                    ...(opening
                      ? {
                          direction:
                            opening.direction === "right"
                              ? ("right" as const)
                              : ("below" as const),
                        }
                      : near
                        ? {}
                        : {
                            direction:
                              spec.id === "chat"
                                ? ("left" as const)
                                : ("right" as const),
                          }),
                  },
                }
              : {}),
          });
        const added = api.getPanel(spec.id)!;
        const tab = tabElement(added);
        if (!added.api.isVisible) {
          tab.classList.add("dock-new");
          const seen = added.api.onDidVisibilityChange(({ isVisible }) => {
            if (!isVisible) return;
            tab.classList.remove("dock-new");
            seen.dispose();
          });
        }
      } finally {
        quiet = false;
      }
      stripFocus();
      place();
      if (
        background &&
        active?.isConnected &&
        document.activeElement !== active
      )
        active.focus({ preventScroll: true });
    },
    updateFile(id: string, title: string, file: FileTabDescriptor): void {
      const panel = api.getPanel(id);
      if (!panel) return;
      panel.api.updateParameters({ file });
      panel.api.setTitle(title);
      label(panel);
    },
    layout,
    refreshActions: place,
    closeTab,
    remove(id: string): DockPlace | undefined {
      for (const action of actionOrigins.keys())
        if (action.dataset.pane === id) restoreAction(action);
      const panel = api.getPanel(id);
      if (!panel) return;
      const before = api.toJSON();
      delete (before.grid as { maximizedNode?: unknown }).maximizedNode;
      quiet = true;
      try {
        api.removePanel(panel);
        specs.delete(id);
        commands.removed();
      } finally {
        quiet = false;
      }
      return { before, after: arrangement(api.toJSON()) };
    },
    restoreWindows() {
      callbacks.leaveFullscreen();
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
    },
    has: (id: string) => !!api.getPanel(id),
    focus(id: string | null) {
      commands.focus(id);
      for (const group of api.groups) {
        const focused = !!id && group.panels.some((panel) => panel.id === id);
        if (!focused) group.element.classList.remove("dock-flash");
        if (focused && !group.element.classList.contains("dock-focused")) {
          group.element.classList.remove("dock-flash");
          void group.element.offsetWidth;
          group.element.classList.add("dock-flash");
        }
        group.element.classList.toggle("dock-focused", focused);
      }
    },
    dispose() {
      finishSelection();
      gestures.abort();
      cancelAnimationFrame(placing);
      observer.disconnect();
      sizer.disconnect();
      commands.dispose();
      quiet = true;
      for (const action of actionOrigins.keys()) restoreAction(action);
      api.dispose();
    },
  };
}

export type DockHost = ReturnType<typeof createDockHost>;
