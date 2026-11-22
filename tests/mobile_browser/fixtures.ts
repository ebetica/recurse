import type { Page } from "playwright";
import { gotoRoot, mockConversation } from "./common";

export const tree = (id = "main", status = "idle") => [
  {
    id,
    parent: null,
    updated: 1,
    title: "Coordinator",
    kind: null,
    status,
    children: 0,
    queued: 0,
    preview: "",
    muted: false,
    taken_over: false,
  },
];
export const idleConv = (rows: any[] = []) => ({
  id: "main",
  title: "Coordinator",
  parent: null,
  status: "idle",
  kind: null,
  active_run: null,
  msg_count: rows.length,
  window_cursor: 0,
  turns: [],
  rows,
});
export const runConv = (
  status = "running",
  activeRun: string | null = "run-browser",
) => ({ ...idleConv(), status, active_run: activeRun, pending: [] });

export async function openFixtureConversation(
  page: Page,
  base: string,
  conv: () => unknown,
  status = "idle",
): Promise<void> {
  await page.route(`${base}api/tree*`, (route) =>
    route.fulfill({ json: tree("main", status) }),
  );
  await mockConversation(page, base, "main", conv);
  await gotoRoot(page, base);
}

export const row = (
  id: string,
  role: string,
  text: string,
  extra: any = {},
) => ({
  id,
  kind: "text",
  role,
  origin: role === "user" ? "operator" : role,
  text,
  name: null,
  args: "",
  result: null,
  result_truncated: false,
  live: false,
  ...extra,
});
export const compactConv = () =>
  idleConv([
    row("u1", "user", "go"),
    row("p1", "custom", "Compacting…", {
      kind: "marker",
      origin: "custom",
      meta: { compact_marker: true },
    }),
    row(
      "f1",
      "custom",
      "Compaction failed: instant-auth-unavailable. Retry with /compact",
      { kind: "marker", origin: "custom", meta: { compact_marker: true } },
    ),
  ]);
