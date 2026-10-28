# pi-bg-shell

Vendored from https://github.com/ebetica/pi-bg-shell at commit
`2d2fa08795b5d47d6c164e0b808dbd854810ce6b`; this copy is the source of truth for
Recurse. `src/agents/durable/host.ts` imports `shells.ts` to provide the
Durable `bash` and `wait` tools. This package no longer loads as a Pi extension;
its former extension entry and terminal UI are removed.

## Shell tools

### `bash(command, monitor?, background?, inactivityReminderSeconds?, limit?)`

- `command` (required string): shell command to run.
- `background` (default `false`): return immediately with the shell id rather
  than waiting for foreground completion.
- `monitor` (default `false`): deliver meaningful output in batches. Each batch
  costs a model turn: print state changes, not per-poll heartbeats.
- `inactivityReminderSeconds` (default `1800`, range `0`–`86400`): no-output
  reminder delay; `0` disables it for this shell.
- `limit` (default `2000`, range `1`–`2000`): maximum output lines shown.

A foreground command waits up to 10 seconds. If it finishes, the result includes
its exit code and trimmed output; otherwise it becomes a background shell and
returns its id, process information, log path, and output so far. Background
and monitor calls skip that foreground wait.

Each command runs in its own detached process group. Stdout and stderr share a
log file, so output remains available after a trimmed tool result. Results and
notifications report the process-group id and a stop hint:

```bash
kill -- -<pgid>
```

Kill the group, not just its leader, to reach descendants. Completion is reported
only after the group has no non-zombie members; a leader exiting alone does not
finish a shell whose descendants still run.

The registry allows four live background/monitor groups by default. At the cap,
wait for a completion, inspect an existing log, or stop a group instead of
starting another polling shell. Foreground commands remain available for recovery.

### `wait()`

Wait for background shells using escalating deadlines: 5m, 10m, 30m, 1h, 3h,
6h, then 6h repeatedly. Still-running notifications share that schedule;
a wait timeout advances the shell's next notice rather than causing a duplicate
immediate reminder. Monitor shells do not have still-running timers, but a wait
timeout still lists them.

A queued shell notice or other conversation input ends the wait. The notice is
delivered after the tool result through the conversation's input queue. New user
input ends the wait without stopping the live shells or losing their completion
notifications.

## Output and monitoring

Tool output is middle-trimmed to at most 2000 lines and 50 KiB by default,
retaining head and tail with an omission marker and a Read offset/limit hint.
Lines longer than 500 characters are shortened. Trimming reads bounded windows
from the log rather than loading the whole file; the full log is unchanged.

Monitor output is coalesced across shells. Complete meaningful lines wake the
conversation after a short debounce; output arriving during a turn accumulates
for a later batch. Consecutive repeats and heartbeat matches do not wake the
model. By default, monitor wakes have a one-minute cooldown, and a batch with
at least three meaningful lines adds a reminder to print only state changes.
Injected monitor output is length-capped and common credential-shaped values are
redacted; the on-disk log is not redacted. Completion is still reported when the
process exits or is killed.

After safety approval, a conservative shell parser may remove redundant leading
`timeout`, trailing `head`/`tail` pipes, and stderr merge redirects. The runner
already backgrounds long commands, trims output, and merges streams. Quoting,
substitutions, or unsupported syntax leave the command untouched. Occasional
system reminders explain rewrites instead of repeating guidance on every call.

## Durable ownership and cleanup

Each conversation has a separate `ShellRegistry`. Commands start through
`env -i` with the environment supplied by the host, not the server's environment.
Only the host-selected override file inside the agent's private temp directory
is sourced.

When a command leaves the foreground, a conversation-owned `recurse.shell` task
records its shell id, process identity, group id, command, and log path. The task
watches for completion, monitor output, and reminder deadlines. Notices use fixed
request ids, and completion is checkpointed before submission so task resume does
not lose or duplicate it. The registry's own still-running and inactivity notices
are suppressed in favor of the Durable task's deadlines.

The host's shell state directory contains one store per conversation scope key,
with atomic JSON records for live shells. Completed records are acknowledged and
removed promptly. This store supports recovery; it is not a second conversation
transcript or the former Pi-extension completion-batch protocol.

- Ordinary model-turn settlement leaves background shells alive. A run abort
  stops only the active foreground command.
- “Stop processes” and reap-style background abort stop the conversation's shell
  tasks and groups without posting new shell notices.
- Shutdown stops every tracked group. Verified cleanup uses TERM, then KILL if
  needed, and confirms the group is gone. The TERM grace ends early only when
  every tracked group is proven absent; leader exit alone is insufficient.
  Unknown liveness keeps the full grace. A reused PID is never signalled.
- A task retains ownership until cleanup is proven. Failed stops retry with
  backoff; an abort that cannot prove cleanup hands ownership to a successor task.
- After a host restart, a resumed task stops its recorded surviving group and
  reports that the command stopped because the server restarted. Interrupted bash
  calls are recovered from the registry store and a launch id memoized before
  spawn and inherited in the shell environment.

An uncatchable host SIGKILL cannot run shutdown handlers; restart recovery handles
remaining recorded groups. Launch-id recovery also finds descendants that started
new sessions but kept their environment. A descendant that both leaves its
session and clears that environment can escape this recovery mechanism; see
`src/process_lifecycle.ts` for the documented limit.

## Configuration and development

The Durable host calls `createShells(options)` in `shells.ts`, supplying the
conversation scope (key, cwd and tool environment), state directory and verified
group cleanup. It supplies registry configuration through `DurableShellScope.config`
and monitor settings through `ShellsOptions.monitor`. Defaults and supported
fields live in `registry.ts` (`ShellConfig`, `DEFAULT_CONFIG`) and
`monitor-notifications.ts`; the host selects the persistent state directory
through `ShellsOptions.stateDir`. The deleted extension's environment-variable
configuration and session-manager hooks are not the Durable integration API.

From the repository root:

```bash
bun install --frozen-lockfile
tests/check.sh ts
```

Tests cover output trimming, schedules, bounded monitoring, atomic state writes,
real background subprocesses, descendant cleanup, and Durable task recovery.
The integration contract and cleanup invariants are documented in the
`shells.ts` module header; read it before changing ownership or notification
behavior.

## License

MIT
