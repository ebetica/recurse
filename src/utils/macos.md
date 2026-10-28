# Run Recurse on macOS

Recurse is being ported to macOS on Apple Silicon. On Intel Macs,
descriptor-relative file operations refuse to run, so Recurse does not start
there. The C-library calls live in [src/utils/libc.ts](libc.ts)
and [src/utils/dir_fd.ts](dir_fd.ts). Recurse keeps the Linux
security properties on macOS, or refuses the operation. Process identity (group,
session, start token, environment and boot id) comes from libproc and sysctl
through [src/utils/process_table.ts](process_table.ts).

## Status

Mac runs on 2026-10-21 (Bun 1.4.3) pass the file-operation tests. The second
run found the supervisor lock opened close-on-exec and test helpers reading
`/proc`, both fixed since.

Known gap: macOS withholds the environment of SIP-protected programs (such as
`/bin/bash` and `/bin/sleep`) from other processes. After a crash, recovery
finds a shell command whose ownership record was never written only by the
launch marker in its environment, so it cannot find one run by such a program.
That command is left running, never killed by mistake.

CI: [.github/workflows/macos.yml](../../.github/workflows/macos.yml) runs
`tests/check.sh macos` on an Apple Silicon runner after each push to `main`, and
on demand from the Actions tab. Pull requests are still checked on a Mac by
hand, as below.

## Requirements

- `git`, from the Xcode Command Line Tools: `xcode-select --install`.
- Bun 1.4.0 or newer: `curl -fsSL https://bun.sh/install | bash`.

## Check a branch on the Mac

`tests/check.sh macos` runs the backend tests that cover the port. It runs every
step even after a failure, prints each step's exit status, and ends with
`== macos summary` and one `passed:` or `FAILED:` line per step. Run it in
a separate clone, so the installed `recurse` command keeps its own checkout. To
check pull request `N`:

```bash
N=1234; git clone -q https://github.com/ebetica/recurse.git ~/recurse-pr-$N && cd ~/recurse-pr-$N && git fetch -q origin pull/$N/head && git switch -q --detach FETCH_HEAD && tests/check.sh macos
```

Send back every `(fail)` and `FAILED:` line with the error after it, the
summary, and `bun --version` and `sw_vers`. When
you are done, remove the clone with `rm -rf ~/recurse-pr-$N`.

## Use Recurse as the home

Once `tests/check.sh macos` passes:

1. Install: `curl -fsSL https://raw.githubusercontent.com/ebetica/recurse/main/install.sh | bash`.
   If `~/.local/bin` is not on `PATH`, add it.
2. Start: `mkdir -p ~/scratch/recurse-try && recurse ~/scratch/recurse-try`,
   then open http://127.0.0.1:8787.
3. Sign in to Claude or ChatGPT in Settings, start a new agent, and send
   "Run `uname -a` with the bash tool and tell me the output." The reply shows a
   bash tool call and its output, which starts with `Darwin`.
4. Background shell: send "Run `sleep 30; echo done` in the background, then
   stop it." The tool output reports the shell stopped, and
   `pgrep -f 'sleep 30'` in Terminal prints nothing.
5. Restart: stop `recurse` with Ctrl-C and run the step 2 command again. The
   agent and its messages are still there, and you can send another message.
6. Remote: in Settings → Remotes, choose "Add a remote", enter its name,
   address and password, then choose "Connect remote". The remote reads as
   signed in, and its agents appear in the sidebar.

Report each step that fails with the time, the step, what you saw, and the
last lines of `recurse`'s terminal output.
