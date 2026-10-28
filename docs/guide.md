# Recurse

Recurse is a minimal agentic harness built on top of [Pi](https://pi.dev) and a web UI for autonomous work.
Please see the How Recurse Works section below - recurse itself contains two main
changes over Pi. We believe just two tools enable long horizon work, though recurse
provides a few more QoL plugins.

In Pi, a two-hour command in the shell blocks the agent until it
finishes. In Recurse, a command that outlasts a few seconds moves to the
background and the agent carries on; a `wait` tool lets the agent wait for its
results when it has nothing else to do. The same shell runs a monitor: a command
whose output wakes the agent, which is how an agent watches CI, keeps a goal in
mind, or works on a schedule. The `wait` tool was critical for long horizon work
especially with weaker models.

Recurse is natively multiagent. An agent starts, messages and waits for subagents with a
command-line tool, so a workflow of agents is a script any agent can run, and
one you can write yourself. Each subagent usually works in its own Git
worktree of your project, so parallel agents never edit the same files.

The QoL plugins we provide include:
* timestamps
* "auto mode" for destructive commands (you should still use a sandbox)
* worktrees
* side conversations
* remote control

The web UI provides a desktop-like experience without an app - so you can access
it from anywhere you can run a browser.

## Get started

### 1. Install Recurse

Recurse needs [Bun](https://bun.sh) 1.4.0 or newer and `git`. It does not need
Node.js or Python.

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://raw.githubusercontent.com/ebetica/recurse/main/install.sh | bash
```

The installer puts a `recurse` command on your path.

### 2. Start Recurse

Point it at the folder you want to work on, then open http://127.0.0.1:8787:

```bash
recurse /path/to/folder
```

The folder can also be a Git URL, which Recurse clones once. Recurse keeps its
own data for that folder beside it, and never writes into your files unless an
agent edits them.

### 3. Choose a model

A model generates an agent's replies. Open **Settings** and sign in to Claude
or ChatGPT with your subscription, or add an API key.

Each agent runs at an effort level from 1 to 5. A level is a model and how much
it reasons. Settings shows what each level means and lets you change it. New
agents start at level 3.

### 4. Give an agent a task

Choose **New agent** in the sidebar and type a task, for example:

```
Run the test suite and fix anything that fails.
```

```
Review the last three commits and tell me what you would change.
```

```
Split the items in TODO.md between subagents, one worktree each, and open a
pull request for every item.
```

The agent shows each file it reads, each command it runs, and each edit. It
does not ask before every action; a separate reviewer model checks each one
first. See [Safety](#safety).

### Continue later

Close the tab whenever you like. Agents keep working, and the conversation is
where you left it when you return. If Recurse restarts, conversations resume
automatically.

## How Recurse works

Every conversation is an agent: a model, a working folder and a history.
Agents form a tree. You start agents from the sidebar; agents start subagents
for parts of their task; any agent can message or read any other.

### Background shells

The shell is the main tool of any coding agent. Short commands finish at once
and the agent reads the result, as you would expect.

A command still running after ten seconds moves to the background. The agent
does not wait for it. It gets the command's id, the output so far, and the
path of a log that grows as the command prints. When the command finishes,
Recurse wakes the agent with the exit code and the end of the output: at its
next step if it is busy, as a new turn if it is idle.

An agent therefore never guesses a timeout. A five-minute test suite, a build,
a deploy and a two-hour training run all behave the same way: the agent starts
it, does something else or waits, and is told when it is done. A command that
runs long by accident does not stall the conversation.

An agent that has nothing to do until a command finishes calls `wait`. The
wait ends when a command finishes or a message arrives, so you can redirect a
waiting agent at any time.

A monitor is a command whose output wakes the agent. An agent starts one when
it wants to react to something that happens later: a CI run finishing, a
deployment changing state, a file appearing, time passing. Each new line of
meaningful output wakes the agent; repeated lines and heartbeats do not. Goals,
loops, reminders and watchers can all be implemented with monitors. See
[Examples](examples.md).

Stopping an agent while it works ends its current step and leaves its commands
running; stopping it again while idle stops the commands too. Deleting an agent
stops its commands. When Recurse restarts, commands that were still running are
stopped and the agent is told why.

An agent can have four background commands or monitors at once; for another,
it waits for one to finish or stops one. Commands run as the user who started
Recurse, with that user's permissions. Use a container for untrusted or
unattended work. If [RTK](https://github.com/rtk-ai/rtk) is installed, command
output is shortened before the agent reads it.

### Multiagent

When a task has independent parts, an agent starts subagents. A subagent is an
agent of its own: it appears under its parent in the sidebar, and you can open,
read and message it at any time.

A subagent starts from a written task, not from its parent's conversation,
though any agent can read any other's history when it needs to. When a
subagent finishes, its final reply is delivered to its parent. Nothing else is
automatic: the parent decides what to do with the reply, and you can watch
both sides.

Agents start, message, wait for and remove subagents with a command-line tool,
`subagent.ts`. A workflow of agents is therefore a script: a reviewer, a
planner with three implementers, or one agent per item in a list is something
an agent writes and runs, and something you can write as a skill and hand to
it. See [Examples](examples.md).

Each agent runs at an effort level from 1 to 5; subagents inherit their
parent's level unless told otherwise. Messages from other agents arrive the
same way yours do, read at the agent's next step, and each one says who sent
it.

#### Taking over

When you want an agent to yourself, take it over from the sidebar. A
taken-over agent stops reporting to its parent and answers only you. Its
parent is notified. This enables you to organize agents inside of subtrees.

### Worktrees

A worktree is a separate Git checkout of your project. A subagent that changes
code normally gets its own, so parallel agents never edit the same files and
each one's changes stay separate.

This is the normal way work happens in Recurse. The parent plans; subagents
implement in worktrees; each one's result is a branch or a pull request; you
or the parent review and merge. A worktree is a real checkout you can open in
your editor, and the **Changes** pane shows its diff.

Recurse removes a worktree once no agent uses it. Commit or push anything that
should outlive the agent.

### Safety

Before an agent runs a command or writes a file, a second model reads the
action and the conversation and decides whether it fits what you asked for.
A denied action comes back to the agent with the reason, and the agent
chooses another way or asks you. Three denials in one run stop the run.

The goal of the safety reviewer is to prevent accidental catastrophic commands
like `rm -rf ~/$TMP` with an undefined `TMP`, _not_ to prevent malicious
actors. Use a sandbox for additional security.

Denied: exposing a secret, destroying things outside the task, weakening
security or authentication, working around the review itself. Allowed:
ordinary work on the task, including Git operations that can be undone,
cleaning build output, and stopping the agent's own processes.

The reviewer reads your messages, so stating your exception in the prompt
allows the command to run.

### Memory

Memory is a set of Markdown notes an agent keeps between conversations.
Global memories are shared between all agents; local memories are only for
that particular agent; agent-tree memories are shared between all agents in
that tree. Agents use ordinary file reads and writes to save and recall
memories, and see the titles before every reply.

### Environment

An agent can set environment variables for its own commands: an API key a
script needs, a path, an activated Conda environment. They persist across
restarts and are never printed back, which makes them a lightweight way to
keep state around. Ask the agent to load a `.env` file instead of pasting
secrets into the conversation.

## The web app

Every agent in the tree is a conversation you can open. Send a message while
an agent works and it reads it at its next step; **Stop** ends its current
work. The effort level and safety review are in the conversation header. Open
any message to see the exact request that went to the model, including the
system prompt: nothing is sent that you cannot read.

### Side conversations

`/btw <question>` starts a side conversation: a read-only fork of the current
conversation that begins where it is now. It knows everything the agent knows,
can read files but not change anything, and nothing it says enters the main
conversation. When it reaches a conclusion you want the agent to have, ask it
to send that back, and the agent receives it as a message.

Use it to ask "what did you just do?" or "would approach B be simpler?" without
interrupting the agent or spending its context.

### Artifacts and files

Drop a file or an image on the composer to give it to the agent. Anything an
agent publishes comes back the same way: it is attached to the reply and
listed in **Files**, and publishing the same name again adds a version.

An Artifact is a document or a small interactive app, shown in its own pane, 
with a version history. Ask for one ("put the report in an Artifact") and 
the agent creates it. Comments you leave on an Artifact go to the agent as a message.

### Changes

**Changes** shows the diff of the agent's folder, or of its worktree. Comment
on lines, then send the comments to the agent as one message. It is the review
step of the plan-implement-merge loop in [Worktrees](#worktrees).

### Compact, clear, revive

`/compact` summarizes older history so the agent can keep working with less of
it; this also happens on its own as the history fills. `/clear` starts the
conversation over with nothing. **Delete** removes an agent and its subagents.
`/revive` brings a deleted or cleared agent back with its history. Nothing is
lost: the full history stays on disk.

### Remote editting

Remotes enable recurse to access copies of recurse on other machines. You can have
recurse running on your laptop, with tailscale set up on remote devices. Recurse
runs on the remove device, not the local device, so it will continue working when
the connection is down.

Continue with [Examples](examples.md): how watchers, goals, loops and graphs of
agents are built from these parts, and how to customize Recurse.
