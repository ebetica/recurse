// The built-in sidebar script. Pinned: pinned conversations, shown only when
// there are any. Inbox: idle conversations. Active: working ones. Archive:
// archived or snoozed; an archived one returns when it replies.

const ARCHIVE = {
  label: "Archive",
  icon: "archive",
  set: "archived",
  clear: "pinned",
};
const SNOOZE = {
  label: "Snooze",
  icon: "snooze",
  set: "snoozed",
  until: "ask",
};
const PIN = { label: "Pin", icon: "pin", set: "pinned", unless: "pinned" };
const UNPIN = { label: "Unpin", icon: "unpin", clear: "pinned", if: "pinned" };
const RESTORE = {
  label: "Restore",
  icon: "restore",
  clear: ["archived", "snoozed"],
};

const archived = (r) =>
  r.tags.snoozed ||
  (r.tags.archived && r.tags.archived.at > (r.replied_at ?? 0));
const byRank = (a, b) => a.rank - b.rank;
const DAY = 86400;

export default function sidebar(rows, now) {
  rows = rows.filter((r) => r.depth === 0 && !r.side_of);
  const pinned = rows.filter((r) => r.tags.pinned && !archived(r));
  rows = rows.filter((r) => !pinned.includes(r));
  const active = rows.filter((r) => r.busy);
  const inbox = rows.filter((r) => !r.busy && !archived(r));
  const archive = rows.filter((r) => !r.busy && archived(r));
  const stale = inbox.filter((r) => r.idle_for > DAY);
  const archiveStale = {
    label: "Archive idle > 1 day",
    icon: "archive",
    set: "archived",
    rows: stale,
  };
  return [
    ...(pinned.length
      ? [{ title: "Pinned", rows: pinned.sort(byRank), rowActions: [UNPIN] }]
      : []),
    {
      title: "Inbox",
      rows: inbox.sort(byRank),
      rowActions: [ARCHIVE, SNOOZE, PIN],
      actions: stale.length ? [archiveStale] : [],
    },
    {
      title: "Active",
      rows: active.sort(byRank),
      rowActions: [PIN],
    },
    {
      title: "Archive",
      collapsed: true,
      rows: archive.sort((a, b) => b.updated - a.updated),
      rowActions: [RESTORE],
    },
  ];
}
