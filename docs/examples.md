# Examples

Recurse has a few primitives: a background shell, a monitor, a subagent, a
worktree, and a skill. Everything below is built from them, by the agent, out
of a shell command and a page of instructions. This section shows how, so you
can build your own.

## Watch CI or a deployment

A monitor is a shell command whose output wakes the agent. To watch a CI run,
the agent starts a loop that polls the status and prints a line only when it
changes. Nothing wakes the agent until the status changes; then the line
arrives as a message and the agent acts on it.

## Goal

```
/skill:goal all tests in tests/web pass
```

Goal is built with a monitor that checks the agent's own state
programmatically. The skill tells the agent to start a script as a monitor; the
script asks Recurse every few minutes whether the agent is idle (no running
turn, no running subagent, no background command) and, if so, prints the goal.
That line wakes the agent, which carries on. When the goal is met, the agent
kills the monitor.

## Loop

```
/skill:loop every 10 minutes check the deploy and report problems
```

The same script with a cadence: it prints the task every interval, skipping
intervals while the agent is still busy. Goal and loop are in
[`playground/skills/`](../playground/skills/README.md); each is one `SKILL.md` and a sixty-line script, and the
README there says how to link them into a project.

## Graphs of agents

Subagents are created, waited for and read with `subagent.ts`, so a graph of
agents is a shell script. Each `create` prints the new agent's id; `wait`
returns when an agent finishes; `messages` reads what it concluded. A
plan-implement-review pipeline is:

```bash
planner=$(create --title plan "Write a plan for X into PLAN.md")
wait $planner
for part in $(parts PLAN.md); do
  ids+=$(create --title "impl $part" --worktree "$part" "Implement $part from PLAN.md and open a PR")
done
wait ${ids[@]}
reviewer=$(create --title review "Review PRs ${prs[@]}; report, do not edit")
wait $reviewer
```

(`create`, `wait` and `parts` stand for the full `bun $RECURSE_SRC/tools/subagent.ts …`
commands and your own way of listing the plan's parts.) Fan-out is the loop;
fan-in is `wait` on all the ids; a dependency is a `wait` before the next
`create`. Give each agent a complete task because it starts from that text, and
give implementers worktrees so they never edit the same files. Put the script
in a skill and the agent runs the pipeline whenever you ask.

## Make your own

Write the recipe as a skill, the project rules as `AGENTS.md`, and the facts
as memory. Then ask for it. Nothing in Recurse changes.

## Customize

Start with the least powerful mechanism that meets your need.

| Need                                          | Start with                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Instructions agents follow in a folder        | `AGENTS.md` in the folder. It can include other Markdown files with `@path.md`                                             |
| Instructions loaded only for a task           | A skill: a `SKILL.md` in the folder's `.pi/skills/`. Agents see its name and read it when needed; `/skill:name` invokes it |
| Facts an agent keeps between conversations    | [Memory](guide.md#memory)                                                                                                  |
| Something that happens later or on a schedule | A monitor. See above                                                                                                       |
| Parallel work, review or planning             | Subagents, as a script or a skill. See above                                                                               |
| An external service                           | Its MCP server, added in Settings. Agents call it from code                                                                |
| A new tool, or any change to Recurse          | A Pi extension, or ask an agent                                                                                            |

For an MCP server with many or rarely used tools, add `"loadToolsOnDemand": true`
to that server's JSON entry in Settings > MCPs. Its tool schemas then stay out of
the agent's inline tool list; the agent finds and inspects them from code when
needed. Omitting it or setting it to `false` keeps the default inline tool list.

Skills and extensions are Pi's; Pi's documentation on
[skills](https://pi.dev/docs/latest/skills) and
[extensions](https://pi.dev/docs/latest/extensions) applies.

Recurse is open source. Run `recurse` with no argument to work on Recurse
itself, and ask the agent for the change you want. The rules agents follow
when they change Recurse are in [`docs/agents/`](agents/develop.md). Recurse runs on Linux and on
Apple Silicon Macs ([macOS notes](../src/utils/macos.md)); to run it on a server, see
[Deploy on Modal](../playground/modal/deploy.md).
