// Built-in Pinned, Inbox, Active and Archive sections hide when empty.
// Archived or snoozed rows return when they reply or their snooze expires.
// Custom tag controls and sections are opt-in through a custom sidebar script.

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
const PIN = {
  label: "Pin",
  icon: "pin",
  set: "pinned",
  unless: "pinned",
};
const UNPIN = {
  label: "Unpin",
  icon: "unpin",
  clear: "pinned",
  if: "pinned",
};
const RESTORE = {
  label: "Restore",
  icon: "restore",
  clear: ["archived", "snoozed"],
};
const swipe = (action, direction) => ({ ...action, swipe: direction });
const DELETE = { label: "Delete", do: "delete", swipe: "left" };
const MORE = { label: "More", do: "more", swipe: "left" };
const READ = { label: "Read or unread", do: "toggleUnread", swipe: "right" };

const archived = (r) =>
  r.tags.snoozed ||
  (r.tags.archived && r.tags.archived.at > (r.replied_at ?? 0));
const byRank = (a, b) => a.rank - b.rank;
const DAY = 86400;

export default function sidebar(rows) {
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
    {
      title: "Pinned",
      hideWhenEmpty: true,
      rows: pinned.sort(byRank),
      rowActions: [
        { ...swipe(ARCHIVE, "left"), clear: [], swipeOnly: true },
        DELETE,
        MORE,
        READ,
        swipe(UNPIN, "right"),
      ],
    },
    {
      title: "Inbox",
      hideWhenEmpty: true,
      rows: inbox.sort(byRank),
      rowActions: [
        swipe(ARCHIVE, "left"),
        SNOOZE,
        DELETE,
        MORE,
        READ,
        swipe(PIN, "right"),
      ],
      actions: stale.length ? [archiveStale] : [],
    },
    {
      title: "Active",
      hideWhenEmpty: true,
      rows: active.sort(byRank),
      rowActions: [DELETE, MORE, READ, swipe(PIN, "right")],
    },
    {
      title: "Archive",
      hideWhenEmpty: true,
      collapsed: true,
      rows: archive.sort((a, b) => b.updated - a.updated),
      rowActions: [swipe(RESTORE, "left"), DELETE, MORE, READ],
    },
  ];
}
