# Goal and loop skills

Two optional Pi skills that keep an agent working without you nudging it.

- **goal**: type `/skill:goal <goal>` in a conversation, for example
  `/skill:goal all tests in tests/web pass`. The agent works on the goal. Each
  time it stops while the goal is still open, it is reminded of the goal within
  about three minutes and carries on. It is not reminded while it is busy,
  waiting on one of its subagents, or waiting on a background command. When the
  goal is met, the agent stops the reminders itself.
- **loop**: type `/skill:loop <every N minutes> <task>`, for example
  `/skill:loop every 10 minutes check the deploy and report problems`. The agent
  runs the task now and again every N minutes until you tell it to stop. An
  interval is skipped while the agent is still busy.

Both skills use a background command in the conversation, visible in its shell
list, that checks every few minutes whether the agent is idle. Stopping the
conversation's processes also stops the reminders. A server restart stops them
too; the agent is told and restarts them if the goal or loop is still open.

## Install

A skill is a directory with a `SKILL.md`. Link or copy each directory into one
of the places Pi loads skills from:

- one project: `<project>/.pi/skills/`
- every conversation on this instance: the `skills/` directory in the Pi agent
  directory, `$PI_CODING_AGENT_DIR` (by default `$RECURSE_HOME/pi-agent`).

From a Recurse checkout, for one project:

```bash
mkdir -p <project>/.pi/skills
ln -s "$PWD/playground/skills/goal" "$PWD/playground/skills/loop" <project>/.pi/skills/
```

The loop skill uses the goal skill's `wake.ts` through a symlink, so copy with
`cp -RL` (which follows it) rather than plain `cp -R`. New turns pick up the
skills; type `/skill:` in the composer to see them.
