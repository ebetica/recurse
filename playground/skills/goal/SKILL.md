---
name: goal
description: Keep working toward a goal the user sets with /skill:goal <goal>; a monitor re-sends the goal whenever you are idle until it is met.
---

# Goal

The text after `/skill:goal` is your goal. Keep working on it across turns
until it is met; when you end a turn while it is unmet, a monitor wakes you.

1. Start one monitor shell (`bash` with `monitor: true`), quoting the goal for
   the shell. `<skill dir>` is this skill's directory:

   ```bash
   bun <skill dir>/wake.ts 3 'Goal not met yet, keep working on it: <goal>'
   ```

   Every 3 minutes (or the interval the user names) it prints one dated line
   only when you are idle: no running turn, no running subagent, no background
   shell other than monitors. Note the shell id and pgid it reports.

2. Work on the goal. Waiting on a subagent or a background shell is fine; the
   monitor stays silent until those finish.
3. On each monitor line, check progress and continue with the next step.
4. When the goal is met, or the user cancels it, stop the monitor with
   `kill -- -<pgid>` and say so. Never leave it running after that.
5. If the monitor stops on its own (for example the server restarted) while
   the goal is unmet, start it again.
