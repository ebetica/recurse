---
name: loop
description: Repeat a task on a cadence the user sets with /skill:loop <every N minutes> <task>; a monitor asks you to run it again each interval while you are idle.
---

# Loop

The text after `/skill:loop` gives an interval and a task, for example
`every 10 minutes check the deploy`. Run the task now, then again on each
wake until the user tells you to stop.

1. Start one monitor shell (`bash` with `monitor: true`), with the interval
   in minutes and the task quoted for the shell. `<skill dir>` is this skill's directory:

   ```bash
   bun <skill dir>/wake.ts <N> 'Loop: run the task again: <task>'
   ```

   Every N minutes it prints one dated line only when you are idle: no running
   turn, no running subagent, no background shell other than monitors. Busy
   intervals are skipped. Note the shell id and pgid it reports.

2. Run the task once now and end your turn.
3. On each monitor line, run the task once more and end your turn.
4. When the user tells you to stop, or the task says when to stop and that
   point is reached, stop the monitor with `kill -- -<pgid>` and say so.
5. If the monitor stops on its own (for example the server restarted) before
   that, start it again.
