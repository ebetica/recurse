# Recurse documentation

- [README](../README.md): install and run Recurse.
- [Guide](guide.md): how Recurse works, for people using it: background
  shells, multiagent, worktrees, safety and the web app.
- [Examples](examples.md): how goals, loops, watchers and graphs of agents are
  built from those parts, and how to customize Recurse.
- [Develop Recurse](develop.md), including testing install changes.
- [Deploy on Modal](../playground/modal/deploy.md) ([how it works](../playground/modal/README.md)).

## For agents

These pages are written for agents running inside Recurse, not people running
commands in a terminal.

- [Agent development workflow](agents/develop.md): evidence, review, test and docs procedures
- [Test review](agents/test-review.md): the rules an agent applies to a PR's tests
- [Code map](agents/repository-map.md): required reading before changing code
- [AGENTS.md](../AGENTS.md): the standing agent rules

## Subsystems

Each part's design lives in a `README.md` beside its code; the
[code map](agents/repository-map.md) lists every part.

- [Agents: the tree and each agent's lifecycle](../src/agents/README.md)
- [Turns, prompts and compaction](../src/agents/durable/README.md)
- [Conversation views](../src/agents/view/README.md)
- [Agent files](../src/agents/runtime/attachments/README.md)
- [Artifacts](../src/artifacts/README.md)
- [Extensions](../src/extensions/README.md): [background shells](../src/extensions/core/shells/README.md),
  [safety review](../src/extensions/core/safety/README.md)
- [Remotes](../src/backends/remotes.md): connecting another Recurse instance,
  cross-instance messages and connection access ([design](../src/backends/README.md))
- [macOS port](../src/utils/macos.md): status and limits of running Recurse on macOS
- [Tools and managed worktrees](../tools/README.md)
- [Running Recurse locally and where files live](../src/launcher/README.md)
- [Browser app](../web/README.md)
- [Tests](../tests/README.md)
