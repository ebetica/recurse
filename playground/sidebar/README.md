# Project sidebar example

## Source files

- [projects.js](projects.js) is a standalone, commented sidebar script. It shows
  `recurse` and `research` project groups with Active, Inbox and Archive children,
  and a **Needs you** section above them. Empty sections hide.

## Install

Ask an agent to install this file using the `recurse-settings` skill's
`set_sidebar_script` action. The script applies to local and connected backends;
reload the page to see it. Review it in **Settings → Appearance → Sidebar**.
To return to the built-in script, use **Reset to default** there, or ask an
agent to use `reset_sidebar_script`.

Use **Tag…** on a row to assign a project, and **Untag** to remove it. New agent
asks for a tag; a group's New agent action picks its project directly. The
script sets editable effort defaults of 3 for `recurse` and 4 for `research`.
Change these names and defaults in the script to suit your projects. Agents with
both project tags appear in the first group; unclaimed agents stay in Other agents.

Agents request attention with
`bun $RECURSE_SRC/tools/subagent.ts tag <id> --add needs-you`. These agents move
to **Needs you**, even if archived. Remove the tag when handled with **Untag** or
`bun $RECURSE_SRC/tools/subagent.ts tag <id> --remove needs-you`.

## Rules for changes

Keep the example self-contained and below the sidebar script size limit. Core
code never imports this directory; the backend sidebar test dry-runs the example
loaded from disk.
