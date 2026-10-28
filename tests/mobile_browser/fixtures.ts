export const tree = (id = "main") => [
  {
    id,
    parent: null,
    updated: 1,
    title: "Coordinator",
    kind: null,
    status: "idle",
    children: 0,
    queued: 0,
    preview: "",
    muted: false,
    pinned: false,
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
export const threadConv = (text = "Hello from the fixture") =>
  idleConv([row("u1", "user", "go"), row("a1", "assistant", text)]);
