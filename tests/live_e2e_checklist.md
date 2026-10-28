# E2E verification checklist

## Routine reply-path checks

Run `tests/check.sh provider` with Chromium installed (`tests/check.sh browser` installs it).
This recorded-provider group targets under 60 seconds and sends through real
Recurse → Durable → Pi → loopback Codex SSE/WebSocket and Anthropic SSE transports,
not an assistant-stream mock. It covers browser send/running state, a real native
read tool and its public file output, steer, confirmed Stop, an incoming agent
message, reload persistence, and SIGKILL-mid-request Durable restart recovery.
`tests/dev/affected_tests.ts` can select the group. Recorded pacing stays at 1 for
browser/recovery checks; parser/cache-only checks use 0. No provider credential
or live model call is needed.

## Authorized live checks

Use the checklist below only for a new prompt or kind of model call, provider
login verification, or after upgrading Pi. Existing recordings do not cover all
write/image/publish/Artifact/shell/safety scenarios below; do not claim that the
routine group verifies those. Capture additional fixed-public scenarios under
isolated credentials and inspect metadata plus decoded response bytes before
committing recordings.

Run `bun tests/live_e2e.ts --verify-live`. Inspect the retained `session.jsonl`, every page in `view-pages.json`, screenshots, server log, and synthetic files. For each line report PASS, FAIL, or NOT OBSERVED with a short quote and evidence location. A model's success claim alone is not proof; tie a real tool call to its result and observable effect. Perform destructive API/UI checks on additional private conversations, never the creator conversation. Save manual API responses and pane screenshots in the printed evidence directory; do not bypass a safety denial or read non-test sessions. Touch that directory's `finish` file when done; the launcher captures evidence and shuts down.

- Conversation: one committed prompt runs in four consecutive turns under one conversation/session id, ending with `LIVE_E2E_OK_47`.
- Foreground Bash: the model runs a short command and observes `LIVE_FOREGROUND_OK`.
- Search and read: native find, read, grep, and multi_grep inspect the synthetic seed and both search terms appear.
- Write/edit: native write creates two old lines; one native edit call replaces both; native read sees both new lines.
- Image: native write saves the base64 fixture; Bash decodes a valid PNG; native read opens that PNG.
- Publish and UI: native `publish` with `paths: ["live-pixel.png"]` attaches that PNG and a phase screenshot visibly renders it inline.
- Auto-background Bash: a >10-second foreground-mode command backgrounds, prints ordered transitions, and native wait receives completion.
- Explicit background Bash: background=true starts a shell and native wait receives its completed output.
- Monitored Bash: monitor=true prints READY and a PGID; the model kills that exact process group before DONE, then native wait shows termination.
- Directory and environment: native chdir enters and restores the synthetic workdir; native `env` set/list/unset and Bash checks observe present then absent.
- Artifact: native write creates V1; native `artifact` creates one Artifact, lists all, and renames it. Native read verifies V1 at the returned path; Git log records its SHA. Native write and Git commit publish V2 through the hook; Git restore from the first SHA and another commit publish V1 again. Inspect hook results and read the final V1 bytes.
- Child: CLI creates a sibling in a managed worktree, sends/messages/tails/waits/reaps; that child locates the test Artifact by id through native `artifact` list, uses Git show for its first version, reads V1, computes its SHA-256, and its digest reaches the creator as an agent message.
- Managed worktree and Pi compact: model enters a second named worktree with the CLI and calls native compact.
- View/browser: all bounded /view pages are retained; one nonempty main-screen screenshot exists after each of the four turns.
- Stop: as verifier, start a separate private turn through the API/UI, record its test-owned Pi process-group id, stop with its scoped active run (and use the idle second Stop if needed), then check terminal status and that `killpg(pgid, 0)` reports the group gone before launcher cleanup. Inspect only own-UID private processes, never another agent's session or `/proc/*/environ`.
- Clear: as verifier, clear a separate private conversation through the API/UI and check its new visible history/session state.
- Operator /compact: as verifier, compact a separate private conversation through the API/UI, GET that conversation's `status_reason`, and inspect summary/history; record `Nothing to compact yet.` as a no-op, not evidence of a summary.
- Upload: as verifier, upload a synthetic file through the UI/API and verify it appears in the same private conversation.
- /btw: as verifier, ask a side question through the UI/API and verify it opens a side conversation in the Side conversations pane whose answer does not enter the main turn.
- Restart mid-turn: as verifier, start a separate private turn using native Bash to print `RESTART_BEGIN_47`, sleep long enough for the check, then print `RESTART_DONE_47`. Only after the _tool output_ contains `RESTART_BEGIN_47` and the turn is still running (not merely an admitted message or text in the prompt), save its /view and touch `restart` once. Save post-restart /view and check whether the active turn resumes; record any pending `uncertain` submission or visible failure.
- Effort and Settings: as verifier, change effort through the UI/API between turns and check the next private turn uses it; screenshot the Settings pane.
- Files, Diff, Artifacts panes: as verifier, open each pane and save a screenshot showing its test-owned content.
- Idle reads and latency: as verifier, confirm repeated idle API reads do not start Pi; measure private API latency while a test-owned lock/disk operation is slow.
- Cleanup: after `finish`, auth.json and server.json are absent from retained evidence and no own-UID private Pi/shell process survives.

## How to reach each screen

Select a test-owned agent first. These are JavaScript/TypeScript Playwright locators. On narrow screens, open `page.getByRole("button", { name: /^Panels(?: — Artifacts available)?$/ })`, then use `getByRole("menuitem", { name: ... })` instead of `button` for the three panes below.

- Files: the rail shows **Files**, **Files (N)**, or **Files (N+)**; `page.getByRole("button", { name: /^Files(?: \(\d+\+?\))?$/ })`.
- Diff: the visible pane is named **Changes**; `page.getByRole("button", { name: "Changes", exact: true })`.
- Artifacts: `page.getByRole("button", { name: /^Artifacts(?: available)?$/ })` (the badge adds **available**).
- Settings: `page.getByRole("button", { name: "Settings", exact: true })`, then `page.getByRole("dialog", { name: "Settings" })`.
- Stop: with an empty composer during a turn, `page.getByRole("button", { name: "Stop this agent", exact: true })`, then `page.getByRole("button", { name: "Confirm stop this agent" })`. For an idle owned shell, use `getByRole("button", { name: "Stop processes", exact: true })`, then **Confirm stop processes**. Scope and verify the run/process group as described above.
- Clear: type `/clear` in `page.getByRole("textbox", { name: "Message this agent…" })`; before selecting the option, register `page.once("dialog", d => d.accept())` to accept **Delete this history and start fresh?**. Choose `page.getByRole("option", { name: /^\/clear / })` in **Commands and skills**. Selecting it opens that confirmation; no Send click. Check the new visible history/session state after accepting.
- /compact: type `/compact` in that named textbox; `page.getByRole("option", { name: /^\/compact / })` executes compact immediately; no Send click.
- /btw: type `/btw` and select `page.getByRole("option", { name: /^\/btw / })` first. It inserts `/btw `; add the question in the named textbox, then `page.getByRole("button", { name: "Send message", exact: true })`. The answer shows in the frame `page.frameLocator("iframe.side-frame")`.
- Upload: the visible **Attach file** button is `page.getByRole("button", { name: "Attach file", exact: true })`; register `page.waitForEvent("filechooser")` before clicking it, await the chooser and call `setFiles` with a synthetic file, then use **Send message**. The underlying file input is intentionally hidden.
- Effort picker: **Choose effort level** (keyboard `e` or `Shift+M`) is `page.getByRole("button", { name: "Choose effort level" })`; in `page.getByRole("dialog", { name: "Effort level" })`, use `getByRole("slider", { name: "Effort level" })` between turns.

All visible controls used above have accessible names; none need an unnamed-control UI fix.
