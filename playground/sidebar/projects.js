// Example sidebar: needs-you first, then project groups with nested states.
// Ask an agent to install this file with recurse-settings; no imports needed.
// Change the project names and effort defaults below to suit your work.
// Agents request attention with: subagent.ts tag <id> --add needs-you
// Clear needs-you when the request is handled, using Untag or --remove needs-you.
export const newAgent = {
  ask: "tag",
  defaults: { recurse: { effort: 3 }, research: { effort: 4 } },
};

const TAG = { label: "Tag…", icon: "tag", ask: "tag" };
const ARCHIVE = { label: "Archive", icon: "archive", set: "archived" };
const RESTORE = {
  label: "Restore",
  icon: "restore",
  clear: ["archived", "snoozed"],
};
const archived = (r) =>
  r.tags.snoozed ||
  (r.tags.archived && r.tags.archived.at > (r.replied_at ?? 0));
const byRank = (a, b) => a.rank - b.rank;

export default function sidebar(rows) {
  rows = rows.filter((r) => r.depth === 0 && !r.side_of);
  const needsYou = rows.filter((r) => r.tags["needs-you"]);
  rows = rows.filter((r) => !needsYou.includes(r));
  const projects = ["recurse", "research"].map((tag) => {
    const project = rows.filter((r) => r.tags[tag]);
    rows = rows.filter((r) => !project.includes(r));
    const untag = { label: "Untag", icon: "tag", clear: tag };
    return {
      title: tag,
      hideWhenEmpty: true,
      actions: [{ label: "New agent", icon: "new", start: true, set: tag }],
      sections: [
        {
          title: "Active",
          hideWhenEmpty: true,
          rows: project.filter((r) => r.busy).sort(byRank),
          rowActions: [ARCHIVE, TAG, untag],
        },
        {
          title: "Inbox",
          hideWhenEmpty: true,
          rows: project.filter((r) => !r.busy && !archived(r)).sort(byRank),
          rowActions: [ARCHIVE, TAG, untag],
        },
        {
          title: "Archive",
          hideWhenEmpty: true,
          collapsed: true,
          rows: project.filter((r) => !r.busy && archived(r)).sort(byRank),
          rowActions: [RESTORE, TAG, untag],
        },
      ],
    };
  });
  return [
    {
      title: "Needs you",
      hideWhenEmpty: true,
      rows: needsYou.sort(byRank),
      rowActions: [TAG, { label: "Untag", icon: "tag", clear: "needs-you" }],
    },
    ...projects,
    {
      title: "Other agents",
      hideWhenEmpty: true,
      rows: rows.sort(byRank),
      rowActions: [TAG],
    },
  ];
}
