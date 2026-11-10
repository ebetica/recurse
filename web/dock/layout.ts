// Validates bounded native window layouts before restoring browser-owned state.
// No dockview runtime import: phones and the UI-state store stay library-free.
import type { SerializedDockview } from "dockview";
import { fileTabDescriptor, MAX_OPEN_FILE_TABS } from "../panes/file-tabs.js";
import {
  MAX_WINDOW_LAYOUT_CHARS,
  jsonClone,
  validBoundedString,
} from "../conversation-ui-state/schema.js";

export type WindowLayout = SerializedDockview;
const MAX_DEPTH = 8;
const MAX_GROUPS = 32;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const only = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));
const dimension = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Validate bounded native layouts using only supported fields. */
export function validWindowLayout(
  value: unknown,
  known: (id: string, parameters?: unknown) => boolean,
): WindowLayout | null {
  try {
    value = jsonClone(value, MAX_WINDOW_LAYOUT_CHARS);
    if (!object(value) || !only(value, ["grid", "panels", "activeGroup"]))
      return null;
    const { grid, panels } = value;
    if (
      !object(grid) ||
      !only(grid, [
        "root",
        "width",
        "height",
        "orientation",
        "maximizedNode",
      ]) ||
      !object(grid.root) ||
      grid.root.type !== "branch" ||
      !object(panels) ||
      !dimension(grid.width) ||
      !dimension(grid.height) ||
      (grid.orientation !== "HORIZONTAL" && grid.orientation !== "VERTICAL")
    )
      return null;
    const entries = Object.entries(panels);
    if (entries.length > MAX_GROUPS) return null;
    const files = new Set<string>();
    for (const [id, panel] of entries) {
      if (
        !object(panel) ||
        !only(panel, [
          "id",
          "title",
          "contentComponent",
          "tabComponent",
          "renderer",
          "params",
        ]) ||
        panel.id !== id ||
        panel.contentComponent !== "panel" ||
        panel.tabComponent !== "tab" ||
        (panel.renderer !== undefined && panel.renderer !== "always") ||
        (panel.title !== undefined && !validBoundedString(panel.title))
      )
        return null;
      const descriptor = fileTabDescriptor(id, panel.params);
      if ((id.startsWith("file:") || panel.params !== undefined) && !descriptor)
        return null;
      if (descriptor) {
        const key = JSON.stringify(descriptor);
        if (files.has(key) || files.size >= MAX_OPEN_FILE_TABS) return null;
        files.add(key);
      }
      if (!known(id, panel.params)) return null;
    }
    const seen = new Set<string>();
    const groups = new Set<string>();
    const walk = (node: unknown, depth: number): boolean => {
      if (
        !object(node) ||
        !only(node, ["type", "data", "size"]) ||
        depth > MAX_DEPTH ||
        (node.size !== undefined &&
          !(
            typeof node.size === "number" &&
            Number.isFinite(node.size) &&
            node.size >= 0
          ))
      )
        return false;
      if (node.type === "branch")
        return (
          Array.isArray(node.data) &&
          (node.data.length > 0 || depth === 0) &&
          node.data.every((child) => walk(child, depth + 1))
        );
      if (
        node.type !== "leaf" ||
        !object(node.data) ||
        !only(node.data, ["id", "views", "activeView"])
      )
        return false;
      const { id, views, activeView } = node.data;
      if (
        !validBoundedString(id) ||
        ["__proto__", "prototype", "constructor"].includes(id) ||
        groups.has(id) ||
        groups.size >= MAX_GROUPS ||
        !Array.isArray(views) ||
        !views.length ||
        (activeView !== undefined && !views.includes(activeView))
      )
        return false;
      groups.add(id);
      for (const view of views) {
        if (
          typeof view !== "string" ||
          !Object.hasOwn(panels, view) ||
          seen.has(view)
        )
          return false;
        seen.add(view);
      }
      return true;
    };
    if (
      !walk(grid.root, 0) ||
      seen.size !== entries.length ||
      (value.activeGroup !== undefined &&
        (typeof value.activeGroup !== "string" ||
          !groups.has(value.activeGroup)))
    )
      return null;
    const maximized = grid.maximizedNode;
    if (maximized !== undefined) {
      if (
        !object(maximized) ||
        !only(maximized, ["location"]) ||
        !Array.isArray(maximized.location) ||
        maximized.location.length > MAX_DEPTH
      )
        return null;
      let node: unknown = grid.root;
      for (const index of maximized.location) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          !object(node) ||
          node.type !== "branch" ||
          !Array.isArray(node.data) ||
          index >= node.data.length
        )
          return null;
        node = node.data[index];
      }
      if (!object(node) || node.type !== "leaf") return null;
    }
    return value as unknown as WindowLayout;
  } catch {
    return null;
  }
}

/** Skip unavailable files for this visit without mutating the saved layout. */
export function omitWindowPanels(
  layout: WindowLayout,
  omitted: ReadonlySet<string>,
): WindowLayout | null {
  const next = structuredClone(layout);
  const grid = next.grid as unknown as Record<string, unknown>;
  const maximized = grid.maximizedNode as { location: number[] } | undefined;
  let maximizedNode: unknown = grid.root;
  for (const index of maximized?.location || []) {
    if (!object(maximizedNode) || !Array.isArray(maximizedNode.data)) break;
    maximizedNode = maximizedNode.data[index];
  }
  const maximizedId =
    object(maximizedNode) && object(maximizedNode.data)
      ? maximizedNode.data.id
      : undefined;
  delete grid.maximizedNode;
  const groups: string[] = [];
  const prune = (node: unknown, location: number[]): boolean => {
    if (!object(node)) return false;
    if (node.type === "branch" && Array.isArray(node.data)) {
      const children: unknown[] = [];
      for (const child of node.data)
        if (prune(child, [...location, children.length])) children.push(child);
      node.data = children;
      return children.length > 0 || location.length === 0;
    }
    if (!object(node.data) || !Array.isArray(node.data.views)) return false;
    const views = node.data.views.filter(
      (id) => typeof id === "string" && !omitted.has(id),
    );
    node.data.views = views;
    if (!views.length) return false;
    if (!views.includes(node.data.activeView)) node.data.activeView = views[0];
    groups.push(String(node.data.id));
    if (node.data.id === maximizedId) grid.maximizedNode = { location };
    return true;
  };
  prune(grid.root, []);
  for (const id of omitted) delete next.panels[id];
  if (!Object.keys(next.panels).length) return null;
  if (!groups.includes(next.activeGroup || "")) next.activeGroup = groups[0];
  return next;
}
