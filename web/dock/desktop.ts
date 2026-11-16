// The shell preloads desktop windows; phones load them lazily when widened.
// Phone overlays remain; focus waits for visible, enabled targets until input.
// Only operator arrangements save; unsaved fresh grids are not rebuilt.
// Chat stays usable during discovery; unavailable panes retain saved layouts.
import type { DockHost, DockPanelSpec, DockPlace } from "./host.js";
import type { WindowCommand } from "./commands.js";
import { MESSAGE_ICON } from "../icons.js";
import {
  createFullscreenControl,
  updateFullscreenControl,
} from "../panes/powerbar.js";
import { placeFinder } from "../finder-placement.js";
import { conversationUiState } from "../conversation-ui-state/store.js";
import { WINDOW_LAYOUT_STATE_KEY } from "../conversation-ui-state/schema.js";
import {
  omitWindowPanels,
  validWindowLayout,
  type WindowLayout,
} from "./layout.js";

type HostModule = typeof import("./host.js");
const CHAT_PANEL = { id: "chat", title: "Chat", icon: MESSAGE_ICON };
/** Most closed windows whose place is remembered, newest kept. */
const MAX_PLACES = 64;

const loadHost = (): Promise<HostModule> =>
  import("./host.js").then(async (module) => {
    await module.loadDockStyles();
    return module;
  });

export class DesktopDock {
  private host: DockHost | null = null;
  private module: HostModule | null = null;
  private loading: Promise<void> | null = null;
  private container: HTMLElement | null = null;
  private parking: HTMLElement | null = null;
  private enabled = false;
  private failed = false;
  private ownerId: string | null = null;
  private hostOwnerId: string | null = null;
  private pendingLayout: {
    value: unknown;
    stored: boolean;
    preferredPane?: string;
    layout?: WindowLayout | null;
  } | null = null;
  private ownLayout = false;
  private saveRequested = false;
  private applyingLayout = false;
  private background = new Set<string>();
  private places = new Map<string, DockPlace>();
  private chat: HTMLElement;
  private chatFullscreen: HTMLButtonElement | null = null;
  private chatFocus: (() => void) | null = null;
  private controlFocus: {
    id: string;
    target: HTMLElement;
    origin: Element | null;
  } | null = null;
  private controlObserver: MutationObserver | null = null;

  constructor(
    private panes: HTMLElement,
    private callbacks: {
      refresh(): void;
      known(id: string, parameters?: unknown): boolean;
      prepare(ids: string[]): void;
      restore(ids: string[]): boolean;
      closed(id: string, restoreFocus?: boolean): boolean;
      element(id: string): HTMLElement | null;
      action(id: string): HTMLElement | null;
      focus(id: string): void;
      fullscreen(id: string): void;
      leaveFullscreen(): void;
      error(): void;
    },
  ) {
    this.chat = document.getElementById("main")!;
    document.addEventListener("focusin", () => this.syncFocus());
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") this.host?.command("cancel");
      },
      true,
    );
    for (const type of ["keydown", "pointerdown", "input"])
      window.addEventListener(type, () => this.clearControlFocus(), true);
    addEventListener("recurse:show-chat", (event) => {
      if (!this.host) return;
      event.preventDefault();
      const requested = (event as CustomEvent<() => void>).detail;
      const prior = document.activeElement;
      this.chatFocus =
        typeof requested === "function"
          ? () => {
              if (
                document.activeElement === prior ||
                document.activeElement === document.body
              )
                requested();
            }
          : null;
      this.showChat(true);
      requestAnimationFrame(() => {
        const focus = this.chatFocus;
        this.chatFocus = null;
        focus?.();
      });
    });
  }

  beginVisit(ownerId: string): void {
    if (ownerId === this.ownerId) return;
    this.saveLayout();
    this.host?.reset();
    this.callbacks.leaveFullscreen();
    this.clearControlFocus();
    this.chatFocus = null;
    this.background.clear();
    this.ownerId = ownerId;
    this.readLayout();
    this.host?.show(CHAT_PANEL, true);
  }

  private readLayout(): void {
    const state = this.ownerId
      ? conversationUiState.snapshot(this.ownerId)
      : undefined;
    const entry = state?.localPanes[WINDOW_LAYOUT_STATE_KEY];
    this.ownLayout = false;
    this.saveRequested = false;
    this.callbacks.prepare([]);
    this.pendingLayout = {
      value: entry?.version === 1 ? entry.value : undefined,
      stored: !!entry,
      preferredPane: state?.pane.kind === "open" ? state.pane.id : undefined,
    };
  }

  prepareLayout(): void {
    const pending = this.pendingLayout;
    if (!pending || pending.layout !== undefined) return;
    pending.layout = validWindowLayout(pending.value, (id, parameters) =>
      id === "chat"
        ? parameters === undefined
        : this.callbacks.known(id, parameters),
    );
    this.ownLayout = pending.layout !== null;
    this.callbacks.prepare(Object.keys(pending.layout?.panels || {}));
  }

  userAction(): void {
    if (!this.enabled) return;
    this.pendingLayout = null;
    this.callbacks.prepare([]);
    this.ownLayout = true;
    this.saveRequested = true;
    this.hostOwnerId = this.ownerId;
  }

  saveLayout(): void {
    if (
      !this.ownLayout ||
      !this.saveRequested ||
      !this.enabled ||
      !this.host ||
      !this.ownerId ||
      this.pendingLayout ||
      this.applyingLayout
    )
      return;
    this.saveRequested = !this.writeLayout();
  }

  private writeLayout(): boolean {
    if (!this.host || !this.ownerId) return false;
    const layout = validWindowLayout(this.host.save(), (id, parameters) =>
      id === "chat"
        ? parameters === undefined
        : this.callbacks.known(id, parameters),
    );
    if (!layout) return false;
    conversationUiState.setPaneState(
      this.ownerId,
      WINDOW_LAYOUT_STATE_KEY,
      1,
      "local",
      layout,
    );
    return true;
  }

  restoreLayout(
    available: ReadonlySet<string>,
    discovering: ReadonlySet<string>,
  ): boolean {
    const pending = this.pendingLayout;
    if (!pending) return this.ownLayout;
    this.prepareLayout();
    let layout = pending.layout ?? null;
    const unavailableFiles = new Set(
      Object.keys(layout?.panels || {}).filter(
        (id) =>
          id.startsWith("file:") && !available.has(id) && !discovering.has(id),
      ),
    );
    if (layout && unavailableFiles.size)
      layout = omitWindowPanels(layout, unavailableFiles);
    const ids = Object.keys(layout?.panels || {}).filter((id) => id !== "chat");
    const host = this.host;
    if (!host || !this.enabled) return this.ownLayout;
    const missing = ids.filter((id) => !available.has(id));
    const waiting =
      missing.length > 0 && missing.every((id) => discovering.has(id));
    if (missing.length && !waiting) {
      layout = null;
      this.ownLayout = false;
    }
    const replaceInvalid = pending.stored && pending.layout === null;
    const rememberDefault = (): void => {
      if (pending.preferredPane && available.has(pending.preferredPane))
        this.callbacks.restore([pending.preferredPane]);
      host.layout();
      this.writeLayout();
    };
    this.applyingLayout = true;
    try {
      if (waiting) {
        if (this.hostOwnerId !== this.ownerId) host.restore(null, CHAT_PANEL);
        this.hostOwnerId = this.ownerId;
        host.show(CHAT_PANEL, true);
        return this.ownLayout;
      }
      if (layout && !this.callbacks.restore(ids)) return this.ownLayout;
      if (layout) host.show(CHAT_PANEL, true);
      if (layout || this.hostOwnerId !== this.ownerId || replaceInvalid)
        host.restore(layout, layout ? undefined : CHAT_PANEL);
      this.hostOwnerId = this.ownerId;
      host.show(CHAT_PANEL, true, this.takePlace("chat"));
      this.pendingLayout = null;
      if (replaceInvalid) rememberDefault();
      this.callbacks.refresh();
      this.syncFocus();
    } catch (error) {
      const unusable = this.pendingLayout !== null;
      this.pendingLayout = null;
      this.ownLayout = false;
      host.restore(null, CHAT_PANEL);
      this.hostOwnerId = this.ownerId;
      if (unusable) rememberDefault();
      this.callbacks.refresh();
      console.warn("Saved windows could not be restored", error);
    } finally {
      this.applyingLayout = false;
    }
    return this.ownLayout;
  }

  opening(id: string, background: boolean): void {
    if (background) this.background.add(id);
    else this.background.delete(id);
  }

  sync(enabled: boolean, specs: DockPanelSpec[]): boolean {
    if (!enabled && this.enabled) {
      this.saveLayout();
      this.readLayout();
    }
    this.enabled = enabled;
    if (!enabled) {
      if (this.host) {
        this.module!.adopt(this.panes.parentElement!, this.chat, this.panes);
        for (const finder of document.querySelectorAll<HTMLElement>(
          ".dock-finder",
        ))
          placeFinder(finder, false);
        for (const column of this.panes.querySelectorAll<HTMLElement>(
          ".pane-col",
        ))
          this.module!.adopt(this.panes, column);
        this.host.dispose();
        this.host = null;
        this.hostOwnerId = null;
        this.container?.remove();
        this.parking?.remove();
        this.panes.classList.remove("docked");
      }
      this.chatFullscreen?.remove();
      this.finishControlFocus();
      return false;
    }
    if (!this.host) {
      if (this.failed) return false;
      if (!this.module) {
        this.loading ??= loadHost()
          .then((module) => {
            this.module = module;
            if (!this.enabled || this.host) return;
            this.mount(module);
            this.callbacks.refresh();
            (this.host as DockHost | null)?.layout();
            this.syncFocus();
          })
          .catch((error: unknown) => {
            this.failed = true;
            console.warn("Windows could not load", error);
            this.callbacks.error();
          })
          .finally(() => {
            this.loading = null;
          });
        return false;
      }
      this.mount(this.module);
    }
    const host = this.host!;
    const ids = new Set(specs.map((spec) => spec.id));
    for (const column of this.panes.querySelectorAll<HTMLElement>(
      ".pane-col",
    )) {
      const id = column.dataset.pane!;
      if (!ids.has(id)) this.closeWindow(id);
    }
    for (const spec of specs) {
      const background = this.background.has(spec.id);
      if (!host.has(spec.id))
        host.show(spec, background, this.takePlace(spec.id));
      this.background.delete(spec.id);
    }
    this.finishControlFocus();
    this.saveLayout();
    return true;
  }

  private mount(module: HostModule): void {
    this.chatFullscreen ??= createFullscreenControl("chat", () =>
      this.callbacks.fullscreen("chat"),
    );
    document.getElementById("top-actions")!.append(this.chatFullscreen);
    this.container = document.createElement("div");
    this.container.id = "dock";
    this.parking = document.createElement("div");
    this.parking.className = "dock-parking";
    this.parking.inert = true;
    this.panes.append(this.container, this.parking);
    this.observeControlFocus(this.container);
    this.panes.classList.add("docked", "on");
    this.host = module.createDockHost(this.container, {
      element: (id) => (id === "chat" ? this.chat : this.callbacks.element(id)),
      action: (id) =>
        id === "chat"
          ? this.chat.classList.contains("fullscreen")
            ? null
            : this.chatFullscreen
          : this.callbacks.action(id),
      fullscreen: (id) => this.callbacks.fullscreen(id),
      leaveFullscreen: () => this.callbacks.leaveFullscreen(),
      moved: () => this.syncFocus(),
      changed: () => this.saveLayout(),
      arranged: () => {
        this.userAction();
        this.saveLayout();
      },
      keyboardFocus: (id) => {
        if (id === "chat") {
          const thread = document.getElementById("scroll");
          if (thread) {
            thread.tabIndex = -1;
            this.focusControl(id, thread);
          }
        } else this.callbacks.focus(id);
      },
      closed: (id, restoreFocus) => {
        if (id === "chat") {
          this.userAction();
          module.adopt(this.parking!, this.chat);
          this.closeWindow(id);
          this.saveLayout();
          this.callbacks.refresh();
        } else this.callbacks.closed(id, restoreFocus);
      },
      shown: (id) => {
        this.finishControlFocus(id);
        if (id === "chat") {
          const focus = this.chatFocus;
          this.chatFocus = null;
          focus?.();
        }
      },
      focus: (id) => {
        if (this.controlFocus?.id === id) {
          this.finishControlFocus(id);
          return;
        }
        if (id === "chat") {
          if (document.activeElement instanceof HTMLElement)
            document.activeElement.blur();
        } else this.callbacks.focus(id);
        this.host?.focus(id);
      },
    });
    this.hostOwnerId = this.ownerId;
    // Invariant: Size the grid without Chat in the row, so its first frame is
    // final. Focused Chat moves directly, keeping its focus and selection.
    if (!this.chat.contains(document.activeElement))
      module.adopt(this.parking, this.chat);
    this.panes.style.flex = "1";
    this.host.layout();
    this.host.show(CHAT_PANEL);
    this.refreshActions();
  }

  remove(id: string): void {
    if (this.controlFocus?.id === id) this.clearControlFocus();
    this.closeWindow(id);
    this.background.delete(id);
    this.saveLayout();
  }

  private closeWindow(id: string): void {
    const place = this.host?.remove(id);
    // Invariant: Only closes in the conversation's own shown layout are noted,
    // never the previous conversation's teardown or a restore.
    if (!place || this.pendingLayout || this.applyingLayout) return;
    const key = `${this.ownerId}\n${id}`;
    this.places.delete(key);
    this.places.set(key, place);
    for (const old of this.places.keys())
      if (this.places.size > MAX_PLACES) this.places.delete(old);
  }

  private takePlace(id: string): DockPlace | undefined {
    const key = `${this.ownerId}\n${id}`;
    const place = this.places.get(key);
    this.places.delete(key);
    return place;
  }

  show(id: string): void {
    if (!this.host?.has(id)) return;
    this.host.show({ id, title: id, icon: "" });
  }

  chatOpen(): boolean {
    return this.host?.has("chat") ?? true;
  }

  showChat(reveal = false): void {
    if (!this.host) return;
    const closed = !this.host.has("chat");
    if (reveal || closed) this.userAction();
    if (reveal) this.host.restoreWindows();
    this.host.show(CHAT_PANEL, false, this.takePlace("chat"));
    this.saveLayout();
    if (closed) this.callbacks.refresh();
  }

  focusControl(id: string, target: HTMLElement): void {
    this.clearControlFocus();
    this.controlFocus = { id, target, origin: document.activeElement };
    this.controlObserver = new MutationObserver(() =>
      this.finishControlFocus(),
    );
    this.observeControlFocus(target.closest(".pane-col"));
    this.observeControlFocus(this.container);
    this.background.delete(id);
    this.show(id);
    this.finishControlFocus(id);
  }

  private observeControlFocus(root: Element | null): void {
    if (root)
      this.controlObserver?.observe(root, {
        attributes: true,
        subtree: true,
        attributeFilter: ["inert", "style"],
      });
  }

  private clearControlFocus(): void {
    this.controlFocus = null;
    this.controlObserver?.disconnect();
    this.controlObserver = null;
  }

  private finishControlFocus(id?: string): void {
    const request = this.controlFocus;
    if (!request || (id && request.id !== id)) return;
    const { target, origin } = request;
    const active = document.activeElement;
    if (
      !target.isConnected ||
      (active !== origin && active !== document.body && active !== target)
    ) {
      this.clearControlFocus();
      return;
    }
    if (
      target.closest("[inert]") ||
      !target.checkVisibility({ checkVisibilityCSS: true })
    )
      return;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) this.clearControlFocus();
  }

  command(command: WindowCommand): boolean {
    this.syncFocus();
    if (command === "close-all") this.showChat();
    return this.host?.command(command) ?? false;
  }

  refreshActions(): void {
    if (this.chatFullscreen)
      updateFullscreenControl(
        this.chatFullscreen,
        this.chat.classList.contains("fullscreen"),
      );
    this.host?.refreshActions();
  }

  private syncFocus(): void {
    const active = document.activeElement;
    const column =
      active instanceof Element
        ? active.closest<HTMLElement>(".pane-col")
        : null;
    const windowId =
      active instanceof Element
        ? active.closest<HTMLElement>("[data-dock-panel]")?.dataset.dockPanel
        : null;
    this.host?.focus(
      column?.dataset.pane ||
        (this.chat.contains(active) ? "chat" : windowId || null),
    );
  }
}
