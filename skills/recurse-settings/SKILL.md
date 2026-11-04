---
name: recurse-settings
description: Manage Recurse effort levels, remotes, themes, app name/icon and sidebar settings.
---

# Recurse settings

Discover the deferred tool with `searchTools("recurse_settings")`, inspect its schema with `describeTool("recurse_settings")`, then call `tools.recurse_settings({action: ..., ...})` from codemode. Change settings only when the operator asks. File paths resolve against the tool's current cwd; no stdin.

## Models

- `levels` lists effort levels and reachability. `set_level` uses `level`, an exact Pi `model` id and `reasoning`. Copy ids from Pi's model list; never invent them. Unreachable levels fail until their provider/model is available.
- `set_level` retunes every conversation on that level from its next turn, including the level-1 safety reviewer.

## Remotes

- `add_remote` uses `label` and `url` to request a connection. Ask the operator to sign in to that backend in Settings → Remotes. Never ask for or handle passwords, tokens or keys. Requesting a connection does not sign in or contact the remote.
- `list_remotes` lists labels, URLs, connection states, API compatibility and last-contact information, never keys. Cached status refreshes in the background.
- These actions share server-side connection operations with Settings. They do not grant Settings HTTP or credential access.

## Appearance

- `set_name` uses `name`; `reset_name` restores the default.
- `set_icon` imports a PNG or SVG from `path`, at most 1 MiB; `reset_icon` restores the default. Name/icon changes appear after reload.
- `themes` lists themes; `select_theme` uses `name` (`system` follows the device) and optional `appearance` (`system`, `dark` or `light`). Legacy `dark`/`light` names must be supplied together; mismatched pairs keep dark.
- `add_theme` imports a Ghostty palette file from `path`, using `name`. It requires `background`, `foreground` and all 16 palette slots; other keys are ignored. `remove_theme` uses `name`.
- Theme changes reach open pages without a restart.

## Tree links

`share_link` uses local `conversations` ids and returns a sign-in-required link to their complete root trees. Children resolve to roots. It does not grant access or change authentication.

## Sidebar

The sidebar script API is experimental and may change without migration; Recurse updates may require editing the script.

- `sidebar_script` shows the instance's current script (built-in unless customised) and its last 10 versions.
- `set_sidebar_script` replaces it with `script`: an ES module, at most 16 KB, whose default export `sidebar(rows, now)` returns sections. It must run on current rows before saving. The result lists each section's row count.
- `undo_sidebar_script` restores the previous version; `reset_sidebar_script` restores the built-in script.
