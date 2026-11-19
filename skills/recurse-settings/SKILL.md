---
name: recurse-settings
description: Manage Recurse effort levels, remotes, themes, app name/icon and sidebar settings.
---

# Recurse settings

Call `recurse_settings` directly, or `tools.recurse_settings({action: ..., ...})` from codemode with the same arguments. Change settings only when the operator asks. File paths resolve against the tool's current cwd; no stdin.

## Models

- `levels` lists effort levels and reachability. `set_level` uses `level`, an exact Pi `model` id and `reasoning`. Copy ids from Pi's model list; never invent them. Unreachable levels fail until their provider/model is available.
- `set_level` applies to new agents and agents whose level is chosen again. Existing agents keep their recorded model and reasoning. The level-1 safety reviewer and automatic naming still follow the current ladder.

## Remotes

- `add_remote` uses `label` and `url` to request a connection. Ask the operator to sign in to that backend in Settings → Remotes. Never ask for or handle passwords, tokens or keys. Requesting a connection does not sign in or contact the remote.
- `list_remotes` lists labels, URLs, connection states, API compatibility and last-contact information, never keys. Cached status refreshes in the background.
- These actions share server-side connection operations with Settings. They do not grant Settings HTTP or credential access.

## Appearance

- `set_name` uses `name`; `reset_name` restores the default.
- `set_icon` imports a PNG or SVG from `path`, at most 1 MiB; `reset_icon` restores the default. Name/icon changes appear after reload.
- `themes` lists themes; `select_theme` uses `name` (`system` follows the device) and optional `appearance` (`system`, `dark` or `light`). Legacy `dark`/`light` names must be supplied together; mismatched pairs keep dark.
- `add_theme` imports a Ghostty palette file from `path`, using `name`. It requires `background`, `foreground` and all 16 palette slots; other keys are ignored. Optional `css_path` attaches a CSS file (at most 50,000 characters). `remove_theme` uses `name`.
- `select_theme` with `name` and `css_path` replaces the CSS of an existing custom theme and selects it live. An empty CSS file clears its styling. Built-in themes cannot have custom CSS.
- Theme changes reach open pages without a restart. Exported/imported custom palettes keep their CSS.

### Custom styling

Prefer palette colours before adding CSS. Use stable `[data-theme="…"]` hooks: `sidebar`, `sidebar-row`, `chat-header`, `thread`, `user-message`, `assistant-message`, `composer`, `button`, `input`, `dialog`, `pane`, `background`. Reuse theme variables such as `var(--bg)`, `var(--text)` and `var(--accent)`; avoid fragile internal classes. Respect `prefers-reduced-motion`. Images must be embedded data URLs, not remote resources.

You cannot see the result unless you inspect it in a browser or the operator shares it. Make small changes and ask for feedback. If styling makes the app unusable, open its URL with `?customCss=off`; select a built-in theme to undo custom styling.

## Tree links

`share_link` uses local `conversations` ids and returns a sign-in-required link to their complete root trees. Children resolve to roots. It does not grant access or change authentication.

## Tags

Tags label agents, for example by project. Names use 1–24 lowercase letters, digits or hyphens; each conversation holds at most 16 tags. `archived`, `snoozed` and `pinned` are reserved.

Tagging UI is turned on by a custom sidebar script; the built-in layout has no tag controls. Operators use its **Tag…** box to type or pick a tag, and **Untag** to remove its project tag. Agents use `bun $RECURSE_SRC/tools/subagent.ts tag <id> --add project-name` or `--remove project-name`; they cannot change reserved tags.

Sidebar scripts read `r.tags[name]`, use actions with `ask: "tag"` to ask for a name (`clear: "ask"` removes one), and return tagged rows in sections with `hideWhenEmpty: true`. Export `newAgent = { ask: "tag" }` to show an optional tag control on the New agent draft. A section's `{ label: "New agent", start: true, set: "project" }` preselects its tag; the control can change or clear it. The example script does both. Optional `newAgent.defaults = { project: { effort: 3 } }` applies an editable effort level when that tag is chosen.

Sections may group one level of child sections; the example's tag groups contain Active, Inbox and Archive.

## Sidebar

The sidebar script API is experimental and may change without migration; Recurse updates may require editing the script.

Rows expose `unread`, true after a notification-eligible finish not yet viewed on any device. The shared renderer shows its dot automatically for built-in and custom layouts, including remotes that supply the state. Opening the conversation clears it server-side, even with notifications off.

- `sidebar_script` shows the instance's current script (built-in unless customised) and its last 10 versions.
- `set_sidebar_script` replaces it with `script`: an ES module, at most 16 KB, whose default export `sidebar(rows, now)` returns sections. It must run on current rows before saving. The result lists each section's row count.
- `undo_sidebar_script` restores the previous version; `reset_sidebar_script` restores the built-in script.
