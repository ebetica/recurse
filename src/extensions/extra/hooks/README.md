# Hooks

A hook is a TypeScript file in Pi's extension format:

```ts
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      /\bgit\s+push\b.*--force/.test(event.input.command)
    )
      return { block: true, reason: "No force pushes; open a PR." };
    if (event.toolName === "bash" && /^git log\b/.test(event.input.command))
      event.input.command = event.input.command.replace(
        "git log",
        "git --no-pager log",
      );
    // or: return { input: { ...event.input, command: "…" } };
  });
}
export const timeout = 10_000; // optional, in ms; default 30 s, at most 60 s
```

Hooks come in two scopes, and "Run hooks" in Settings turns both off:

- **Local** hooks are the `.ts` files in `hooks/agents/<agent id>/` in the data directory
  and apply to that agent. Like memories, agents own them: Settings doesn't
  show them, and any agent may write one, for itself or another
  agent, with its file tools; the write is safety-reviewed like any other
  write to the data directory. They are keyed by agent id, so clearing,
  moving or reviving an agent keeps them, side conversations use their
  agent's, and a deleted agent's files stay but never run.
- **Global** hooks are the operator's settings in `<pi-agent>/hooks/*.ts`,
  managed in Settings → Agents → Hooks. Safety review protects the directory
  like the other operator settings files
  ([policy.ts](../../core/safety/policy.ts)).

An agent's local hooks run first and its global hooks last, each in file-name
order. A local hook can change a call, and global `tool_call` hooks see the
changed call before every call that runs. A local hook can also block a call,
which ends the `tool_call` chain, so global `tool_call` hooks don't see it; the
call never runs, and global `tool_result` hooks still see its blocked result.
The system prompt of an agent with hooks names the files that ran for it when
the server opened its session; it isn't updated mid-session, which would
change the prompt. Any agent can list hooks with their last failure, so
keep secrets out of hook error messages. Agents use [tools/hooks.ts](../../../../tools/hooks.ts) to
list an agent's hooks with their events and last failure, and to run one
hook once.

## Events

Each event takes Pi's event and return value, except for the fields
[child.ts](child.ts) leaves out:

- `before_agent_start` runs once per run, on its first model request, with
  the input that started it as the model sees it: a message, or a notice
  such as a finished background shell. It never runs while a message is
  being sent, so a slow hook can't hold up anyone's messages. The text of
  each returned message (a string or text parts), labelled with the hook
  file, goes ahead of that input as a separate user message in every model
  request of the run. It is not stored, so the thread and later runs don't
  show it; the request inspector does. Like all hook text that becomes a
  user message it can't claim a Recurse origin. It and the model-request
  and settle events get the run's id, so a hook can keep per-run state in a
  file. There is no system prompt to change. A server restart during a run
  runs it again for that run.
- `tool_call` runs on every tool call, including codemode's nested calls,
  before safety review, and `tool_result` on every result, including blocked
  and failed calls. When a hook changes a call, the tool's row in the thread
  shows what ran; the model sees only the call it made.
- `agent_before_settle` runs when a run answers, with the answer's text.
  Its entries and continue flag chain from file to file; Pi's context
  preview is left out. When the last file leaves continue set, the text of
  each `custom_message` entry, labelled with the file that added it,
  continues the run as a new user message. A run continues at most 8
  times; a new run, or a server restart, starts the count over, and the
  operator log records `hook_continuation_limit` when it stops one.
- `agent_settled` runs after every run ends, and says whether it was
  stopped; when hook files saw the run, it also gets its last answer and
  how long it took, timed from its first model request. Recurse runs it
  when it sees the run end rather than in Pi Durable's after-run step,
  which would keep a run open and turn a message that arrives during its
  last answer into a new run; a restart just as a run ends can skip it.
- The "context" event runs before each model request with its messages, without Pi's
  prompt (the system messages). When the messages change, the prompt goes
  first, followed by them. This changes that one request only: nothing is
  stored, and the request inspector shows what was sent. It doesn't run on
  safety review's requests. Recurse doesn't run Pi's
  `before_provider_request`, whose changed request body the inspector
  couldn't show.
- `session_before_compact` runs before a compaction is summarized, with
  `preparation` holding Durable's entries and their messages rather than
  Pi's session entries. The first file to cancel it or return a summary
  decides; Recurse's own summary runs only when none does. A compaction
  that a too-long request needs can't be cancelled, since every later
  request would be too long again; a summary still replaces Recurse's.

A hook that registers another Pi event still loads; Settings lists the event
as not supported and Recurse never runs it. Pi's calls that register
commands, tools, shortcuts, flags and message renderers do nothing, so a
ported extension loads; they are listed the same way, as is a timeout above
60 s that was lowered.

## How a hook runs

Each event starts a fresh Bun process per hook file that handles it
([run.ts](run.ts), [child.ts](child.ts)), so hooks keep no state between
events; one that needs memory keeps it in a file. Pi Durable already has the
hook points ([extension.ts](extension.ts)), so no Pi Durable patch is needed.
Results chain from one file to the next, and the first block wins.

- Only the parts of Pi's API that make sense without a session work, plus
  the agent's id; [child.ts](child.ts) lists them.
- The process runs in the agent's working directory with the environment
  the agent's tools start from, but without the agent's own environment
  overrides or any `BUN_*` or `NODE_*` setting, so an agent cannot change
  what a hook loads. It runs in its own process group. Recurse records the
  group before the hook gets its input, so a server restart cleans it up; a
  hook whose server goes away stops its own group; and Recurse stops the
  group, with anything the hook left running, when the hook finishes or
  the run it belongs to is stopped. Only that group is stopped: a process
  the hook starts in a new session (`setsid`) outlives it.
- Failures fail open, as in Claude Code: when a hook throws, times out or
  returns something invalid, Recurse goes on without it and the operator log
  records `hook_failed`, with the line and column of a syntax error;
  Settings and `tools/hooks.ts list` show the last failure. For a local hook, the model also gets a line naming it in the
  tool result, the run-start text or the continuation, once per file per
  run; the other events get none. A global hook is the operator's, so its
  failures reach only the operator, not every agent's context. A hook that
  must fail closed catches its own errors and blocks.
- A slow hook delays the request, call or compaction it runs on, up to its
  timeout.
- Recurse remembers which events each file registered, by size and
  modification time, and starts a process only for files that handle the
  event, or are new or changed. A file whose load throws is skipped until
  it changes or the server restarts, so a broken file doesn't start a
  process on every event; a load that times out is tried again. With no
  hook files, a model request or tool call costs one directory read per
  scope. Only events load files, so Settings and
  `tools/hooks.ts list` show a new or changed file's events after its next
  run.
