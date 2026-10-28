# Browser app

The web UI is strict TypeScript. `bun run build` bundles [app.ts](app.ts) into
`web/dist/app.js` and its chunks; [index.html](./index.html) is the page shell
that loads it from `/static/app.js`. The server owns durable conversation state;
the browser keeps only local view state and unsent drafts. [conversation/poll.ts](conversation/poll.ts) reads the agent
tree (`/api/tree`) and the open conversation, and subscribes to live updates
for the conversation on screen.

**Where things are:**

- Threads and rows: `conversation/`, `thread-render.ts`, `thread-render/`,
  `row-thread-state/`, `pending-queue/`; message Markdown: `util/message-markdown.ts`.
  Folded activity summaries count server-classified calls inside scripts instead
  of their wrapper. Empty scripts still count once; calls past the expanded
  row limit retain their classified counts without their arguments.
  Inter-agent message cards identify remote senders by their delivered backend
  label; only absent local senders are shown as removed agents.
  Reply HTML is cached by conversation/session, block identity and content revision,
  with backend and repository link context included. DOMPurify's unchanged policy
  returns an inert fragment; image restrictions, math and footer reservation use
  that same tree before serialization. The cache is bounded across visits.
  Scroll following and edge controls share a frame's layout reads before writes.
  The pane layout marks the topbar when a phone pane overlays the thread; its
  edge fade never uses a body-wide `:has()` selector, which makes unrelated
  composer and sidebar changes restyle historical message footers.
  Compaction jumps page back to the retained boundary and reveal its first
  visible message, skipping tool-only rows that have no message element.
  Older-page compensation captures the reader's scroll offset before painting.
  Leaving a thread saves where the reader was: at the bottom, or the topmost
  visible message and its offset. Returning follows the latest bottom, or pages
  older history until that message is loaded, reopens a fold hiding it, and
  holds it at the same offset while late content settles, until the reader
  scrolls or jumps. A message folded into a compacted range holds the nearest
  shown message instead; one that no longer exists returns to the bottom.
  Scroll events and bottom follows queued by the outgoing thread never move
  the incoming one.
  The context mini-meter uses delivered ResizeObserver border-box widths (the
  controls have padding but no border), never layout reads after bar updates.
- Sending and uploads: `composer.ts`, `composer/`, `attachments.ts`.
  Drawing on an image preview attaches the export on **Done** and closes the
  preview through its existing close path. Cancel leaves the preview open.
  Successful image-comment sends also close the preview and return to the
  conversation. Box comments include rounded original-image pixel coordinates
  and natural dimensions even when the crop upload fails. Sources without
  natural image dimensions use labeled width/height fractions; document boxes
  keep their page number. [Image preview gestures](image-preview/README.md) separate box
  drawing from two-finger or Shift-drag panning.
- The agent tree: `sidebar.ts`, `deep-link.ts`, `agent-finder.ts`, `reparent.ts`.
  Share link copies `#trees=<root>[,<root>...]`, a signed-in view filter kept
  across navigation and reloads. `shared-trees.ts` limits every committed tree
  snapshot to the named top-level conversations and their descendants; it grants
  no access and offers no control to widen the shared view. Unknown roots are
  ignored, with a notice when none remain. Shared views can create subagents
  under visible conversations, but do not offer new top-level conversations
  or archive discovery outside the shared trees.
- Keys and commands: `keymap.ts`, `skills.ts`, `composer/commands.ts`.
- Models and Settings: `models.ts`, `models/`, `settings.ts`, `settings/`.
  Deleted agents' history retention is an instance setting (90 days by default),
  applied by background cleanup on its next pass.
  Agent-finished notifications are per browser (`settings/notifications.ts`):
  turning them on asks for permission, registers [push-worker.ts](push-worker.ts)
  (served as `/push-worker.js`, root scope, no fetch handler) and saves this
  device's push subscription. A tapped notification focuses an open tab, which
  opens the agent through its `#agent=` link.
  Account > Updates (`settings/updates.ts`) shows the installed and newest
  version on the install's channel and offers "Update now", which the
  launcher applies with a restart; the page then reloads into the new version.
- Side panels: `panes.ts`, `artifacts/`, `diff.ts`, `files.ts`, `comments.ts`.
  Action menus close before running a choice, including opening a confirmation;
  cancelling the confirmation does not reopen the menu. The conversation menu
  keeps Delete's first tap open for its inline second-tap confirmation. Pane
  overflow buttons, links and version selections share dismissal in
  `panes/powerbar.ts`; live slider forms remain open while adjusting.
- Side conversations: `side-pane.ts` lists the open conversation's read-only
  forks (tree rows with `side_of`, kept out of the sidebar) and shows one at a
  time in a frame of `/?embed=1#agent=<id>`. The server marks that page
  `html[data-embed]`; `state.embedded` then hides the tree, panes and controls,
  runs only composer keys, and never writes history entries or the last agent.
  Promote to subagent asks the server to turn the shown idle side conversation
  into a child (`promoting` and `promotion_error` on its row drive the pane's
  notice); once its row loses `side_of` it leaves the pane for the sidebar.
  A parked frame keeps its initially loaded conversation but does not page
  older history, poll versions or refresh the conversation. Parking closes its
  live subscription; opening shows the cached document and reconnects from
  its held cursor. Zero-size threads never auto-page; resizing resumes filling.
- Stall diagnostics: `main-thread-timing.ts` observes tasks over 200 ms, preferring
  long-animation-frame script attribution where supported. Visible pages send at
  most one report per ten seconds through the bounded `/api/ui-timing` queue;
  the existing server one-second telemetry bucket also applies.
  Reports contain row counts, remote statuses, composer focus and eight fixed
  event markers, never DOM text or input values. Up to three scripts include
  only same-origin paths and bounded function names, without credentials, query
  or hash.
- Request inspection: `prompt.ts` (exact model requests), `context-viewer.ts`.
- API requests: `api.ts` shares fetch/auth handling; `backends/backend.ts`
  binds it to a backend's API base and health. Existing `api.ts` exports stay
  home-only. Conversation requests select `backendFor(id)`; home ids are bare,
  remote ids are `label/cid`. `backends/discovery.ts` discovers approved connections
  at boot and every minute without joining the focused/home read, and registers
  them in one list, `backends()` (home first), from which the sidebar sections,
  the Settings backend picker and the agent finder are built. The home and
  each remote read their trees through one loader per backend
  (`backends/tree.ts`) on the home cadence, with at most one read in flight
  each, so a slow remote delays only its own rows. Every snapshot then commits
  through one path (`commitTree` in `conversation/poll.ts`), so pending renames,
  take-overs, stops and deletes, pane refreshes and agent search treat remote
  rows exactly like home rows. Unchanged remote snapshots do not redraw. Remote
  trees render below dividers in the same sidebar.
  The agent finder uses those cached trees without fetching while typing;
  remote results show the backend name and neutral offline state, and mentions
  insert `<id>@<label>` targets. Equal matches prefer home agents, and the shared
  bounded index retains home entries first.
  Version mismatches have no tree; remote health never reloads the home page.
  Offline remotes keep their last tree and show neutral relative last-seen times,
  with exact timestamps in tooltips. Tree
  retries back off from five seconds to one minute; recovery needs no new sign-in.
  Each connected remote section offers **New agent**: its draft stays in that
  section and creates a top-level agent on that remote on first send. Offline
  sections disable creation. Draft uploads and queued first messages retain the
  selected backend through creation and retries. A new remote agent stays
  selected until its own tree refreshes past creation; home tree reads cannot
  mistake an older remote snapshot for a deletion.
  Remote agents use the same controls as home agents through the same
  backend-bound paths: send (including queued/steered input), uploads, stop,
  rename, effort choice, safety review, delete, take-over, /compact and
  /clear. Remote drafts and agents use that remote's effort ladder, read
  through the proxy. The remote's key policy is the
  only authority; the browser keeps no second allowlist, and a remote that
  refuses an action reports it like a home refusal. Agents never
  move between backends; side conversations and revive stay on the home.
  Settings → Remotes also lists homes allowed to connect to this instance, with
  last-used times and access revocation, instead of a separate Settings card.
  It lists agent-requested addresses with a password-only sign-in;
  the manual name/address/password form is collapsed under **Add a remote**.
  Both sign-in forms ask for an existing remote password, mark it as
  `current-password` and request password-manager exclusion; the password is
  used once, not stored.
  Incoming access and the direction and scope of settings copies are explained inline.
  Signed-in remotes offer an explicit **Sync settings from home** preview and
  confirmation, outside the proxy. It copies only effort levels,
  default efforts, maximum context window and theme.
  Ladder levels with unavailable models are not written. Default efforts include
  stored overrides for logged-out providers, so replacement and stale checks cover
  the complete map. Older backends without that projection must be updated before
  syncing. Signed, ten-minute previews bind the
  confirmed values; items changed remotely since preview are refused. Results
  are per item. Provider credentials, passwords, names and backend keys are
  never copied, and MCP servers are not synced: each remote keeps its own.
  With a remote connected, the Settings header picks which Recurse the page
  configures (`settings/target.ts`). A remote shows only Authentication,
  Models and MCPs, read and saved through the proxy as the operator; Account
  and Appearance always describe this Recurse. MCP OAuth sign-in returns to
  the address that began it, so a remote's MCP sign-in runs on its own page;
  status, checks, edits and sign-out work from here. Agents never reach these
  routes (`remoteSettingsRoute` in `src/auth/backend_keys.ts`).
  Composer input carries no relay provenance: it is operator input. Remote
  request failures stay in that backend's health and conversation outbox.
  Server-provided `/api/` URLs pass through `resolveUrl` before rendering or
  fetching; remote URLs must stay within that API path and use the home proxy.
  Files, PDF, drawing and download consumers receive these resolved URLs.
- Reconnecting after outages: `connection.ts`, `connection/`. Only home health
  drives session-expiry reload and generation recovery. Remote key revocation
  (424) and unreachability (502) settle only that backend's health.
- Stop: `stop-control.ts`, `stop-control/`.

## Styles and icons

[theme.css](theme.css) holds the design tokens: colours, spacing, radii,
shadows, motion and layers, as CSS custom properties. Checks in `tests/check.sh web`
(`tests/checks/*_check.ts`) reject literal values elsewhere, so a theme can change them
in one place. [icons.ts](icons.ts) holds every inline SVG icon; the server fills
`index.html`'s `<svg data-icon="NAME">` slots from it. Oxlint does not cover Lit
templates; do not add another lint stack just for that gap.

## Brand assets

[brand/](brand/) contains the Two Levels logo: deep mint outer window and light
mint inner window, with plain top bars. The colour mark, favicon and wordmark use
`#2F855A` outer and `#A7E8C5` inner in both light and dark mode. App tiles are
`#2F855A` with white outer and `#A7E8C5` inner windows. [mark.svg](brand/mark.svg)
is the small UI mark; the sidebar uses it at 24 px. [wordmark.svg](brand/wordmark.svg)
pairs it with the name in a fixed mid-grey `#6E7781` that stays readable on light
and dark pages. The `-mono.svg` variants use `currentColor` when embedded inline.

The frontend asset build copies this directory to `/static/brand/`.
[index.html](index.html) links the SVG favicon, its 32 px PNG fallback and the
180 px Apple touch icon. The web manifest advertises 192 and 512 px app icons
and full-bleed maskable variants; push notifications use the 192 px app icon.
PNG exports are rendered from the corresponding SVG at their named dimensions.
The Apple touch icon uses [app-icon.svg](brand/app-icon.svg).

Settings → Appearance → Name and icon saves instance overrides in
`config/branding.json` beside the other instance settings. Reload applies the
name to the shell, login page and manifest, and a PNG or SVG (up to 1 MiB)
to all shell and manifest icon slots without resizing. Reset restores each
default independently. [src/branding.ts](../src/branding.ts) owns validation
and atomic writes; custom SVG responses use a scriptless sandbox CSP.

## Rules for changes

- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Loading the open conversation is the critical path; background work and
  caching must never delay it.
