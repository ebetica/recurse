# recurse

Recurse is yet another coding harness built off of [Pi](https://pi.dev). We
are opinionated and provide a few standard suggested plugins for agents to do
autonomous work. These core plugins are minimized in the spirit of Pi.

Many of the popular workflows in modern harnesses can be implemented at run
time with these recurse primitives. The harness is also entirely open source,
so you can make it your own.

We only provide a web frontend. This is because TUIs are of a previous era, and
a web frontend enables anybody to access it with ssh tunnel access.

## Quickstart

Recurse needs [Bun](https://bun.sh) 1.4.0 or newer and `git`. Install Bun if
you do not have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

To install Recurse:

```bash
curl -fsSL https://raw.githubusercontent.com/ebetica/recurse/main/install.sh | bash
```

To run recurse on a working directory, then open http://127.0.0.1:8787:

```bash
recurse /path/to/dir
```

Sign in to Claude or ChatGPT from Settings on first use.

## Documentation

[The guide](docs/guide.md) explains how Recurse works: background shells,
multiagent, worktrees, safety and the web app. [Examples](docs/examples.md)
shows how goals, loops and graphs of agents are built from those parts, and how
to customize Recurse.

Recurse does not accept PRs. Please submit a reproducible issue if you want things
fixed.

Agents should read the rules in [AGENTS.md](AGENTS.md) and
[docs/agents/](docs/agents/).

## Principles

- **The simplicity of Pi.** We use Pi Durable for agents, enabling fast
  multiagent queries sharing the same process, and durability around
  interruptions and restarts. We share Pi's attitude towards simplicity in tools provided 
- **Background shells.** A simplified background shell enables uninterrupted
  long-running code. Long commands background on their own and wake the agent
  when they finish. Monitors are background shells that wake the agent
  whenever they print. `wait` enables models to work autonomously.
- **Multiagent.** Every chat is an agent.
  Agents spawn subagents in their own worktrees, and results report up the tree.
- **Quality of life.** - Recurse works out of the box with a minimal set of QoL additions, like safety review,
  async compaction, fffgrep, artifacts, and more. 

Recurse was vibe tested by using it to do long horizon autonomous work.

## Infinitely extensible

Background shells, monitors and multiagent are primitives that enable implementation of many workflows:

- [FirstMate](https://github.com/kunchenguid/firstmate) is just a skill.
- A goal is a monitor that checks the agent state; a loop is a monitor that
  wakes the agent on a cadence. Both are examples in
  [playground/skills/](playground/skills/).
- Reminders, CI watchers, and scheduled jobs are monitors too.
- Reviewers, planners, and graphs of agents are scripts over `subagent.ts`
  that you can wrap in a skill.
