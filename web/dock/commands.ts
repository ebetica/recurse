// Window navigation and layout commands use the live desktop dock. Serialized
// trees are transient inputs for sibling geometry, rotation and equal sizing;
// the host preserves connected content when applying a changed tree.
// Focus, opening hints and merge directions belong to the current visit.
import {
  Orientation,
  type DockviewApi,
  type DockviewGroupPanel,
  type IDockviewPanel,
  type SerializedDockview,
} from "dockview";

export type WindowDirection = "left" | "right" | "up" | "down";
export type WindowCommand =
  | `focus-${WindowDirection}`
  | `move-${WindowDirection}`
  | `resize-${WindowDirection}`
  | "previous"
  | "open-right"
  | "open-below"
  | "merge"
  | "split"
  | "only"
  | "fullscreen"
  | "close"
  | "close-all"
  | "equalize"
  | "resize"
  | "cancel";

type GridNode = SerializedDockview["grid"]["root"];
const sides = {
  left: "left",
  right: "right",
  up: "top",
  down: "bottom",
} as const;

/** Adapt window commands without creating a second persistent layout model. */
export function createWindowCommands(
  api: DockviewApi,
  callbacks: {
    focus(id: string): void;
    close(id: string, restoreFocus?: boolean): void;
    fullscreen(id: string): void;
    leaveFullscreen(): void;
    restore(layout: SerializedDockview): void;
    changed(): void;
    arranged(): void;
  },
) {
  let focused: string | undefined;
  let previous: string | undefined;
  let opening: { id: string; direction: "right" | "below" } | null = null;
  const splitDirections = new WeakMap<DockviewGroupPanel, "right" | "bottom">();
  const current = (): DockviewGroupPanel | undefined =>
    api.groups.find((group) => group.id === focused) || api.activeGroup;
  const focusPanel = (panel: IDockviewPanel | undefined): void => {
    if (!panel) return;
    const changed = api.activePanel !== panel;
    panel.api.setActive();
    callbacks.focus(panel.id);
    if (changed) callbacks.arranged();
  };
  const neighbour = (group: DockviewGroupPanel, direction: WindowDirection) => {
    const box = group.element.getBoundingClientRect();
    let distance = Infinity;
    let found: DockviewGroupPanel | undefined;
    for (const candidate of api.groups) {
      if (candidate === group) continue;
      const other = candidate.element.getBoundingClientRect();
      if (!other.width || !other.height) continue;
      const beyond = {
        left: other.right <= box.left + 1,
        right: other.left >= box.right - 1,
        up: other.bottom <= box.top + 1,
        down: other.top >= box.bottom - 1,
      }[direction];
      const delta =
        Math.abs(other.left + other.width / 2 - box.left - box.width / 2) +
        Math.abs(other.top + other.height / 2 - box.top - box.height / 2);
      if (beyond && delta < distance) {
        found = candidate;
        distance = delta;
      }
    }
    return found;
  };
  const parentOf = (root: GridNode, id: string): GridNode | undefined => {
    if (!Array.isArray(root.data)) return;
    for (const child of root.data) {
      if (!Array.isArray(child.data) && child.data.id === id) return root;
      const parent = parentOf(child, id);
      if (parent) return parent;
    }
    return undefined;
  };
  const normalize = (layout: SerializedDockview): void => {
    const compact = (node: GridNode): GridNode => {
      if (!Array.isArray(node.data)) return node;
      node.data = node.data.map(compact);
      const only = node.data.length === 1 ? node.data[0] : undefined;
      if (only && Array.isArray(only.data) && only.data.length === 1)
        return compact({ ...only.data[0], size: node.size });
      return node;
    };
    const root = layout.grid.root;
    if (Array.isArray(root.data)) root.data = root.data.map(compact);
    while (
      Array.isArray(layout.grid.root.data) &&
      layout.grid.root.data.length === 1
    ) {
      const child = layout.grid.root.data[0];
      if (!Array.isArray(child.data)) break;
      layout.grid.root = child;
      layout.grid.orientation =
        layout.grid.orientation === Orientation.HORIZONTAL
          ? Orientation.VERTICAL
          : Orientation.HORIZONTAL;
    }
  };
  const cancel = (): void => {
    opening = null;
    callbacks.changed();
  };
  const restoreLayout = (layout: SerializedDockview): void => {
    const directions = new Map(
      api.groups.map((group) => [group.id, splitDirections.get(group)]),
    );
    callbacks.restore(layout);
    for (const group of api.groups) {
      const direction = directions.get(group.id);
      if (direction) splitDirections.set(group, direction);
    }
  };
  const restoreWindows = (): void => {
    callbacks.leaveFullscreen();
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  };
  return {
    focus(id: string | null) {
      const group = id ? api.getPanel(id)?.group : undefined;
      if (group && focused !== group.id) {
        previous = focused;
        focused = group.id;
      }
    },
    hint(groupId: string): string {
      return opening?.id === groupId
        ? `Next window opens ${opening.direction === "right" ? "to the right" : "below"}`
        : "";
    },
    takeOpening(): {
      group: DockviewGroupPanel;
      direction: "right" | "below";
    } | null {
      const pending = opening;
      cancel();
      const group =
        pending && api.groups.find((group) => group.id === pending.id);
      return group ? { group, direction: pending!.direction } : null;
    },
    removed() {
      if (opening && !api.getGroup(opening.id)) cancel();
      if (focused && !api.getGroup(focused)) focused = undefined;
      if (previous && !api.getGroup(previous)) previous = undefined;
    },
    run(command: WindowCommand): boolean {
      if (command === "cancel") {
        cancel();
        return true;
      }
      if (command === "close-all") {
        restoreWindows();
        cancel();
        for (const panel of [...api.panels])
          if (panel.id !== "chat") callbacks.close(panel.id, false);
        focusPanel(api.getPanel("chat"));
        callbacks.arranged();
        return true;
      }
      const group = current();
      const panel = group?.activePanel;
      if (!group || !panel) return false;
      if (command === "resize") return true;
      if (command === "fullscreen") {
        callbacks.fullscreen(panel.id);
        return true;
      }
      if (command === "only") {
        callbacks.leaveFullscreen();
        if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
        else group.api.maximize();
        focusPanel(panel);
        callbacks.arranged();
        return true;
      }
      if (command === "open-right" || command === "open-below") {
        opening = {
          id: group.id,
          direction: command === "open-right" ? "right" : "below",
        };
        callbacks.changed();
        return true;
      }
      if (command === "close") {
        callbacks.leaveFullscreen();
        callbacks.close(panel.id);
        return true;
      }
      if (command.startsWith("resize-")) {
        const direction = command.slice(7) as WindowDirection;
        const horizontal = direction === "left" || direction === "right";
        const size = horizontal ? group.api.width : group.api.height;
        group.api.setSize({
          [horizontal ? "width" : "height"]:
            size +
            (direction === "right" || direction === "down" ? 1 : -1) * 32,
        });
        if ((horizontal ? group.api.width : group.api.height) !== size)
          callbacks.arranged();
        return true;
      }
      restoreWindows();
      if (command === "previous") {
        focusPanel(previous ? api.getGroup(previous)?.activePanel : undefined);
        return true;
      }
      if (command.startsWith("focus-")) {
        const direction = command.slice(6) as WindowDirection;
        const delta = direction === "left" ? -1 : direction === "right" ? 1 : 0;
        const tab = group.panels.indexOf(panel) + delta;
        if (delta && tab >= 0 && tab < group.panels.length)
          focusPanel(group.panels[tab]);
        else {
          const next = neighbour(group, direction);
          focusPanel(
            delta
              ? next?.panels[delta < 0 ? next.panels.length - 1 : 0]
              : next?.activePanel,
          );
        }
        return true;
      }
      if (command.startsWith("move-")) {
        const direction = command.slice(5) as WindowDirection;
        const next = neighbour(group, direction);
        const moved = !!next || group.panels.length > 1;
        if (moved)
          panel.api.moveTo({
            group: next || group,
            position: sides[direction],
          });
        focusPanel(panel);
        if (moved) callbacks.arranged();
        return true;
      }
      const layout = api.toJSON();
      const parent = parentOf(layout.grid.root, group.id);
      if (command === "merge") {
        if (!parent || !Array.isArray(parent.data)) return true;
        const siblings = parent.data
          .filter((node) => !Array.isArray(node.data))
          .map((node) => api.getGroup((node.data as { id: string }).id))
          .filter((item): item is DockviewGroupPanel => !!item);
        const other = siblings.find((item) => item !== group);
        if (other) {
          const a = group.element.getBoundingClientRect();
          const b = other.element.getBoundingClientRect();
          splitDirections.set(
            group,
            Math.abs(a.left - b.left) > Math.abs(a.top - b.top)
              ? "right"
              : "bottom",
          );
        }
        const tabs = siblings.flatMap((sibling) => sibling.panels);
        tabs.forEach((tab, index) =>
          tab.api.moveTo({ group, position: "center", index }),
        );
        focusPanel(panel);
        if (siblings.length > 1) callbacks.arranged();
      } else if (command === "split") {
        if (group.panels.length > 1) {
          let reference = group;
          for (const tab of [...group.panels].slice(1)) {
            tab.api.moveTo({
              group: reference,
              position: splitDirections.get(group) || "right",
            });
            reference = tab.group;
          }
          focusPanel(panel);
          callbacks.arranged();
        } else if (parent && Array.isArray(parent.data)) {
          for (let index = 0; index < parent.data.length; index++) {
            const child = parent.data[index];
            if (Array.isArray(child.data))
              parent.data[index] = {
                type: "branch",
                size: child.size,
                data: [child],
              };
          }
          if (parent === layout.grid.root)
            layout.grid.orientation =
              layout.grid.orientation === Orientation.HORIZONTAL
                ? Orientation.VERTICAL
                : Orientation.HORIZONTAL;
          else {
            const replace = (node: GridNode): void => {
              if (!Array.isArray(node.data)) return;
              const index = node.data.indexOf(parent);
              if (index >= 0)
                node.data[index] = {
                  type: "branch",
                  size: parent.size,
                  data: [parent],
                };
              else node.data.forEach(replace);
            };
            replace(layout.grid.root);
          }
          normalize(layout);
          restoreLayout(layout);
          focused = api.getPanel(panel.id)?.group.id;
          focusPanel(api.getPanel(panel.id));
          callbacks.arranged();
        }
      } else if (command === "equalize") {
        const equalize = (node: GridNode): void => {
          if (!Array.isArray(node.data)) return;
          const size =
            node.data.reduce((sum, child) => sum + (child.size || 0), 0) /
            node.data.length;
          for (const child of node.data) {
            child.size = size;
            equalize(child);
          }
        };
        equalize(layout.grid.root);
        restoreLayout(layout);
        focused = api.getPanel(panel.id)?.group.id;
        focusPanel(api.getPanel(panel.id));
        callbacks.arranged();
      }
      return true;
    },
    reset() {
      for (const group of api.groups) splitDirections.delete(group);
      focused = undefined;
      previous = undefined;
      cancel();
    },
    dispose: cancel,
  };
}
